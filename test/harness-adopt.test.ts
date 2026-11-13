import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateAdoption, VIDEO_PENDING_SENTENCE } from "../src/harness-approval.ts";

const root = path.resolve(import.meta.dirname, "..");
const head = "a".repeat(40);
const PENDING_URL = "https://github.com/example/project/pull/5#issuecomment-10";

// ---- T1: 判定の純関数 ----
const marker = (kind: "pending" | "gate", sha = head) =>
	kind === "pending"
		? `<!-- harness:pending phase=awaiting-merge issue=3 sha=${sha} -->`
		: `<!-- harness:gate phase=awaiting-merge issue=3 sha=${sha} attention=A-12 -->`;
const pendingBody = (sha = head) => `理由: 変更なし\n\n${VIDEO_PENDING_SENTENCE}\n\n${marker("pending", sha)}`;
const comment = (body: string, extra: Record<string, unknown> = {}) => ({
	id: 10,
	user: { login: "bot" },
	body,
	html_url: PENDING_URL,
	created_at: "2026-10-27T00:00:00Z",
	updated_at: "2026-10-27T00:00:00Z",
	...extra,
});
const item = (extra: Record<string, unknown> = {}) => ({
	id: "A-12",
	taskId: "test#3",
	kind: "merge",
	project: "test",
	issue: "3",
	pr: "5",
	title: "承認",
	url: PENDING_URL,
	summary: "概要",
	status: "resolved",
	createdAt: "2026-10-27T00:00:01Z",
	resolvedAt: "2026-10-27T00:00:05Z",
	answer: "OK",
	messageId: "m1",
	...extra,
});
function input(over: Record<string, unknown> = {}, items: Record<string, unknown>[] = [item()]) {
	return {
		issue: "3",
		pr: "5",
		head,
		login: "bot",
		project: "test",
		owners: ["owner"],
		comments: [comment(pendingBody())],
		snapshot: { schemaVersion: 1, items },
		sequence: 12,
		attention: "A-12",
		...over,
	};
}
const reason = (v: ReturnType<typeof evaluateAdoption>) => (v.state === "none" ? v.reason : "adoptable");

test("#75 T1: 本人 OK 済みで結び付く動画ありの pending だけが採用できる", () => {
	const v = evaluateAdoption(input());
	assert.equal(v.state, "adoptable");
	if (v.state === "adoptable") {
		assert.equal(v.attention, "A-12");
		assert.equal(v.comment.id, 10);
		assert.equal(v.comment.sha, head);
	}
});
test("#75 T1: A を省くと仮コメントの URL に結び付く最新の merge A を探す", () => {
	const items = [item({ id: "A-11", url: "other" }), item()];
	assert.equal(evaluateAdoption(input({ attention: undefined }, items)).state, "adoptable");
	assert.equal(
		reason(evaluateAdoption(input({ attention: undefined }, [item({ url: "other" })]))),
		"attention-not-bound",
	);
});
for (const [name, over, items, expected] of [
	["head が進んだ", { head: "b".repeat(40) }, undefined, "head-changed"],
	["最新が完成 marker", { comments: [comment(`本文\n\n${marker("gate")}`)] }, undefined, "no-pending"],
	["marker が2行", { comments: [comment(`${pendingBody()}\n${marker("pending")}`)] }, undefined, "no-pending"],
	["他の login の投稿", { comments: [comment(pendingBody(), { user: { login: "other" } })] }, undefined, "no-pending"],
	["依頼コメントなし", { comments: [] }, undefined, "no-pending"],
	[
		"動画なしの pending",
		{ comments: [comment(`本文\n\n通知確認中。承認依頼は未完了です。\n\n${marker("pending")}`)] },
		undefined,
		"no-video-pending",
	],
	["A が open", {}, [item({ status: "open", answer: undefined, resolvedAt: undefined })], "attention-not-approved"],
	["OK ではない回答", {}, [item({ answer: "まだ待って" })], "attention-not-approved"],
	[
		"A の url が違う",
		{},
		[item({ url: "https://github.com/example/project/pull/5#issuecomment-99" })],
		"attention-not-bound",
	],
	["messageId が無い", {}, [item({ messageId: undefined })], "attention-not-bound"],
	["PR が違う", {}, [item({ pr: "9" })], "attention-not-bound"],
	["A が台帳に無い", { attention: "A-3" }, undefined, "attention-not-bound"],
	[
		"より新しい A がある",
		{ sequence: 13 },
		[item(), item({ id: "A-13", status: "open", answer: undefined, resolvedAt: undefined })],
		"attention-superseded",
	],
	["owners を読めない", { ownersUnavailable: true }, undefined, "owners-unavailable"],
	["発行番号が台帳より遅れている", { sequence: 3 }, undefined, "unavailable"],
	["台帳が不正", { snapshot: "broken" }, undefined, "unavailable"],
] as const) {
	test(`#75 T1: 採用しない（${name}）`, () => {
		const v = evaluateAdoption((items ? input(over, [...items] as Record<string, unknown>[]) : input(over)) as never);
		assert.equal(reason(v), expected);
	});
}

// ---- T2〜T8, T11: harness-phase / harness-merge / harness-inbox の結合（gh・curl はスタブ） ----
function setup() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-adopt-"));
	mkdirSync(path.join(dir, "tmp"));
	const config = path.join(dir, "harness.json");
	writeFileSync(
		config,
		JSON.stringify({
			project: "test",
			worktreeRoot: path.join(dir, "worktrees"),
			repo: "example/project",
			owners: ["owner"],
			hooks: {},
			notify: { envFiles: [], required: false },
		}),
	);
	const env = {
		...process.env,
		HARNESS_CONFIG: config,
		CLAUDE_PROJECT_DIR: dir,
		DLE_HOME: dir,
		DLE_SOCKET: path.join(dir, "none.sock"),
		PATH: `${root}/tests/harness/fixtures/media:${root}/tests/harness/fixtures:${process.env.PATH}`,
		PHASE_STUB: "1",
		INJECT_MERGE_OK: "0",
		MEDIA_LOG: path.join(dir, "log"),
		POST_BODY: path.join(dir, "body"),
		CURL_ARGS: path.join(dir, "curl"),
		SENT_COPY: path.join(dir, "copy"),
		SENT_FILE: path.join(dir, "sent"),
		TMPDIR: path.join(dir, "tmp"),
		DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token?thread_id=456&wait=false",
	};
	const call = (bin: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}, cwd = dir) =>
		new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
			execFile(
				path.join(root, "bin", bin),
				args,
				{ cwd, env: { ...env, ...extra }, timeout: 15000 },
				(err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
			),
		);
	const state = () => JSON.parse(readFileSync(path.join(dir, "gh-state.json"), "utf8"));
	const saveState = (s: unknown) => writeFileSync(path.join(dir, "gh-state.json"), JSON.stringify(s));
	const ledger = (items: Record<string, unknown>[], seq = 12) => {
		writeFileSync(path.join(dir, "attention.json"), JSON.stringify(items));
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ attentionSeq: seq }));
	};
	return { dir, call, state, saveState, ledger };
}
type S = ReturnType<typeof setup>;
const phaseArgs = ["3", "awaiting-merge", "--pr", "5", "--comment", "理由: 操作のない変更です"];
const adoptArgs = ["3", "awaiting-merge", "--pr", "5", "--adopt-pending", "A-12"];
const chatArgs = ["3", "--chat-approval", "OK", "--attention", "A-12"];
const localRecovery = (s: S) => path.join(s.dir, ".harness/merge-recovery-3.json");
const worktreeRecovery = (s: S) => path.join(s.dir, "worktrees/issue-3/.harness/merge-recovery-3.json");
const withTree = async (fn: (s: S) => Promise<void>) => {
	const s = setup();
	try {
		await fn(s);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
};
// 動画の再取得照合が落ちた（exit 7）後と同じ、動画あり pending・復旧ファイル・本人 OK 済みの A を作る。
async function failedRequest(s: S, ledgerExtra: Record<string, unknown> = {}) {
	const file = path.join(s.dir, "tiny.mp4");
	writeFileSync(file, readFileSync(path.join(root, "tests/harness/fixtures/media/tiny.mp4")));
	const r = await s.call("harness-phase", [...phaseArgs, "--file", file], { CURL_MODE: "no-attachments" });
	assert.equal(r.code, 7, r.stderr);
	const comments = s.state().comments;
	assert.equal(comments.length, 1);
	assert.match(comments[0].body, /harness:pending/);
	assert.ok(existsSync(localRecovery(s)) && existsSync(worktreeRecovery(s)));
	s.ledger([{ ...item(), url: comments[0].html_url, ...ledgerExtra }]);
}
const expectedBody = (attention = "A-12") =>
	`理由: 操作のない変更です\n\n動画: この承認依頼の Discord メッセージ（${attention}）に添付した（再取得照合は未了のため、添付の存在・内容は未確認）。照合済みではありません。本人の Discord での OK を根拠に完了扱いにしました。\n\n<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} attention=${attention} -->`;
const mergeCommits = (s: S) => readFileSync(path.join(s.dir, "log"), "utf8");

test("#75 T2/T3: 採用で同じコメントが完成し、Discord の OK だけで harness-merge が通る", () =>
	withTree(async (s) => {
		await failedRequest(s);
		const before = await s.call("harness-merge", chatArgs);
		assert.equal(before.code, 1);
		// T8: 未完了の拒否は GitHub の OK を案内せず、採用を案内する。chat-rejection の形は不変。
		assert.doesNotMatch(before.stderr, /GitHub で『OK』/);
		assert.match(before.stderr, /--adopt-pending/);
		const json = JSON.parse(before.stderr.split("\n").find((l) => l.startsWith("{")) ?? "{}");
		assert.deepEqual(Object.keys(json).sort(), ["attention", "kind", "reason", "url"]);
		assert.equal(json.reason, "recovery-unconfirmed");

		const adopted = await s.call("harness-phase", adoptArgs);
		assert.equal(adopted.code, 0, adopted.stderr);
		assert.match(adopted.stderr, /#3 → awaiting-merge（採用）/);
		const state = s.state();
		assert.equal(state.comments.length, 1);
		assert.equal(state.comments[0].id, 10);
		assert.equal(state.comments[0].body, expectedBody());
		assert.doesNotMatch(state.comments[0].body, /添付済み/);
		assert.deepEqual(state.labels, ["harness:awaiting-merge"]);
		assert.ok(!existsSync(localRecovery(s)) && !existsSync(worktreeRecovery(s)));

		const merged = await s.call("harness-merge", chatArgs);
		assert.equal(merged.code, 0, merged.stderr);
		assert.match(mergeCommits(s), /merge --merge --match-head-commit a{40}/);
		// GitHub への OK（コメント・レビュー）は足していない。
		assert.equal(s.state().comments.length, 1);
		assert.deepEqual(s.state().reviews, []);
	}));

for (const [name, mutate, extra, expected] of [
	["CI が赤", () => {}, { CI_BAD: "1" }, "ci-not-green"],
	["mergeable でない", () => {}, { MERGEABLE: "CONFLICTING" }, "mergeable-unconfirmed"],
	["採用後に head が進んだ", (s: S) => s.saveState({ ...s.state(), head: "b".repeat(40) }), {}, "request-stale"],
	[
		"GitHub に NG がある",
		(s: S) =>
			s.saveState({
				...s.state(),
				comments: [
					...s.state().comments,
					{
						id: 30,
						user: { login: "owner" },
						body: "NG やり直し",
						created_at: "2026-10-27T00:00:20Z",
						updated_at: "2026-10-27T00:00:20Z",
						html_url: "ng",
					},
				],
			}),
		{},
		"github-ng",
	],
	[
		"より新しい A が出た",
		(s: S) => {
			const items = JSON.parse(readFileSync(path.join(s.dir, "attention.json"), "utf8"));
			s.ledger(
				[...items, { ...item(), id: "A-13", status: "open", answer: undefined, resolvedAt: undefined, url: "x" }],
				13,
			);
		},
		{},
		"attention-superseded",
	],
] as const) {
	test(`#75 T4: 採用後も安全柵は従来どおり拒否する（${name}）`, () =>
		withTree(async (s) => {
			await failedRequest(s);
			assert.equal((await s.call("harness-phase", adoptArgs)).code, 0);
			mutate(s);
			const r = await s.call("harness-merge", chatArgs, extra);
			assert.equal(r.code, 1, r.stderr);
			assert.match(r.stderr, new RegExp(`"reason":"${expected}"`));
			assert.doesNotMatch(mergeCommits(s), /^merge /m);
		}));
}

test("#75 T5: 完成 PATCH の応答が不正なら exit 7・pending へ戻し・復旧ファイルを残す", () =>
	withTree(async (s) => {
		await failedRequest(s);
		const r = await s.call("harness-phase", adoptArgs, { GH_FAILURE: "bad-time" });
		assert.equal(r.code, 7, r.stderr);
		assert.match(s.state().comments[0].body, /harness:pending/);
		assert.ok(existsSync(localRecovery(s)) && existsSync(worktreeRecovery(s)));
		const merge = await s.call("harness-merge", chatArgs);
		assert.equal(merge.code, 1);
		assert.match(merge.stderr, /"reason":"recovery-unconfirmed"/);
		assert.doesNotMatch(mergeCommits(s), /^merge /m);
	}));
test("#75 T5: ラベルを確認できなければ exit 5 で、コメントは pending のまま", () =>
	withTree(async (s) => {
		await failedRequest(s);
		s.saveState({ ...s.state(), labels: ["harness:awaiting-merge", "harness:impl-review"] });
		const r = await s.call("harness-phase", adoptArgs, { GH_FAILURE: "label-left" });
		assert.equal(r.code, 5, r.stderr);
		assert.match(s.state().comments[0].body, /harness:pending/);
		assert.ok(existsSync(localRecovery(s)));
	}));

for (const [name, prepare, expected] of [
	["head が進んだ", (s: S) => s.saveState({ ...s.state(), head: "b".repeat(40) }), "head-changed"],
	[
		"回答が OK ではない",
		(s: S) => {
			const items = JSON.parse(readFileSync(path.join(s.dir, "attention.json"), "utf8"));
			s.ledger([{ ...items[0], answer: "待って" }]);
		},
		"attention-not-approved",
	],
	["台帳を読めない", (s: S) => writeFileSync(path.join(s.dir, "attention.json"), "broken"), "unavailable"],
] as const) {
	test(`#75 T5: 採用不可は exit 1 で何も変えない（${name}）`, () =>
		withTree(async (s) => {
			await failedRequest(s);
			prepare(s);
			const bodyBefore = s.state().comments[0].body;
			const logBefore = readFileSync(path.join(s.dir, "log"), "utf8");
			const r = await s.call("harness-phase", adoptArgs);
			assert.equal(r.code, 1, r.stderr);
			assert.match(r.stderr, new RegExp(`採用不可 reason=${expected}`));
			assert.equal(s.state().comments[0].body, bodyBefore);
			assert.ok(existsSync(localRecovery(s)));
			assert.equal(readFileSync(path.join(s.dir, "log"), "utf8"), logBefore);
		}));
}
test("#75 T5: --adopt-pending は他の引数と併用できず exit 2", () =>
	withTree(async (s) => {
		for (const a of [
			[...adoptArgs, "--comment", "x"],
			[...adoptArgs, "--notify"],
			["3", "implementing", "--pr", "5", "--adopt-pending", "A-12"],
			["3", "awaiting-merge", "--adopt-pending", "A-12"],
			["3", "awaiting-merge", "--pr", "5", "--adopt-pending", "12"],
		])
			assert.equal((await s.call("harness-phase", a)).code, 2, a.join(" "));
		assert.ok(!existsSync(path.join(s.dir, "gh-state.json")));
	}));
test("#75 T6: 失敗した依頼は自動では採用されない（pending・復旧ファイル・診断が残る）", () =>
	withTree(async (s) => {
		const file = path.join(s.dir, "tiny.mp4");
		writeFileSync(file, readFileSync(path.join(root, "tests/harness/fixtures/media/tiny.mp4")));
		const r = await s.call("harness-phase", [...phaseArgs, "--file", file], { CURL_MODE: "no-attachments" });
		assert.equal(r.code, 7);
		assert.match(r.stderr, /stage=.*reason=/);
		assert.match(s.state().comments[0].body, /harness:pending/);
		assert.doesNotMatch(s.state().comments[0].body, /harness:gate/);
		assert.ok(existsSync(localRecovery(s)));
	}));

test("#75 T7: inbox は OK 済みで結び付く pending を adoptable-pending と報告する（採用はしない）", () =>
	withTree(async (s) => {
		await failedRequest(s);
		const inbox = await s.call("harness-inbox");
		assert.equal(inbox.code, 0, inbox.stderr);
		assert.deepEqual(JSON.parse(inbox.stdout.trim()), {
			issue: 3,
			pr: 5,
			kind: "adoptable-pending",
			attention: "A-12",
			url: PENDING_URL,
		});
		assert.match(s.state().comments[0].body, /harness:pending/);
	}));
for (const [name, prepare] of [
	[
		"A が open",
		(s: S) => s.ledger([{ ...item(), url: PENDING_URL, status: "open", answer: undefined, resolvedAt: undefined }]),
	],
	["head が違う", (s: S) => s.saveState({ ...s.state(), head: "b".repeat(40) })],
	["台帳の JSON が不正", (s: S) => writeFileSync(path.join(s.dir, "attention.json"), "broken")],
	["発行番号を読めない", (s: S) => rmSync(path.join(s.dir, "state.json"))],
] as const) {
	test(`#75 T7: adoptable-pending を出さず従来の pending の出力のまま（${name}）`, () =>
		withTree(async (s) => {
			await failedRequest(s);
			prepare(s);
			const inbox = await s.call("harness-inbox");
			assert.equal(inbox.code, 0, inbox.stderr);
			assert.doesNotMatch(inbox.stdout, /adoptable-pending/);
			const line = JSON.parse(inbox.stdout.trim().split("\n").at(-1) ?? "{}");
			assert.equal(line.requestState, "pending");
			assert.equal(line.kind, line.kind === "stale-notify" ? "stale-notify" : "missing-notify");
		}));
}

test("#75 T11: ルートから実行しても worktree 側の復旧ファイルで merge を拒否する", () =>
	withTree(async (s) => {
		assert.equal((await s.call("harness-phase", phaseArgs)).code, 0);
		mkdirSync(path.dirname(worktreeRecovery(s)), { recursive: true });
		writeFileSync(worktreeRecovery(s), "{}");
		const other = path.join(s.dir, "other");
		mkdirSync(other);
		const r = await s.call("harness-merge", ["3"], {}, other);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /復旧未確認/);
	}));
