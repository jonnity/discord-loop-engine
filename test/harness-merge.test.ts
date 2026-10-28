import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
function setup() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-merge-"));
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
		INJECT_MERGE_OK: "1",
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
	return { dir, env, call, state: () => JSON.parse(readFileSync(path.join(dir, "gh-state.json"), "utf8")) };
}
function savedAnswer(dir: string, id = "A-12", answer = "OK", extra = {}) {
	writeFileSync(
		path.join(dir, "attention.json"),
		JSON.stringify([
			{
				id,
				taskId: "test#3",
				kind: "merge",
				project: "test",
				issue: "3",
				pr: "5",
				title: "承認",
				url: "url",
				summary: "概要",
				status: "resolved",
				createdAt: "2026-10-27T00:00:00Z",
				resolvedAt: "2026-10-27T00:00:05Z",
				answer,
				...extra,
			},
		]),
	);
	writeFileSync(path.join(dir, "state.json"), JSON.stringify({ attentionSeq: 12 }));
}
const args = ["3", "awaiting-merge", "--pr", "5", "--comment", "理由: 操作のない変更です"];
for (const projectSource of ["env", "config", "root"]) {
	test(`M2: engineへ渡すproject名はDLE_PROJECT→.project→root名（${projectSource}）`, async () => {
		const s = setup();
		try {
			const bin = path.join(s.dir, "bin"),
				src = path.join(s.dir, "src");
			mkdirSync(bin);
			mkdirSync(src);
			copyFileSync(path.join(root, "bin/harness-phase"), path.join(bin, "harness-phase"));
			copyFileSync(path.join(root, "src/harness-request.ts"), path.join(src, "harness-request.ts"));
			for (const file of ["harness-approval.ts", "harness-project.ts", "notification-receipt.ts"])
				symlinkSync(path.join(root, "src", file), path.join(src, file));
			symlinkSync(path.join(root, "bin/harness-config"), path.join(bin, "harness-config"));
			writeFileSync(
				path.join(bin, "harness-notify"),
				'#!/bin/sh\nif [ "$1" != --check-target ]; then printf "%s\\n" "$@" > "$CLAUDE_PROJECT_DIR/notify-args"; fi\necho \'{"status":"posted","source":"engine","attention":"A-12"}\'\n',
				{ mode: 0o755 },
			);
			writeFileSync(
				s.env.HARNESS_CONFIG,
				JSON.stringify({
					...(projectSource === "root" ? {} : { project: "configured-project" }),
					worktreeRoot: path.join(s.dir, "worktrees"),
				}),
			);
			const result = await new Promise<{ code: number; stderr: string }>((resolve) =>
				execFile(
					path.join(bin, "harness-phase"),
					args,
					{
						cwd: s.dir,
						env: { ...s.env, DLE_PROJECT: projectSource === "env" ? "environment-project" : "" },
						timeout: 15000,
					},
					(err, _stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stderr }),
				),
			);
			assert.equal(result.code, 0, result.stderr);
			const sent = readFileSync(path.join(s.dir, "notify-args"), "utf8").trim().split("\n");
			assert.equal(
				sent[sent.indexOf("--project") + 1],
				projectSource === "env"
					? "environment-project"
					: projectSource === "config"
						? "configured-project"
						: path.basename(s.dir),
			);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
for (const fromOtherCwd of [false, true]) {
	test(`M4: 復旧失敗後は別cwdのmergeも拒否する（phase別cwd=${fromOtherCwd}）`, async () => {
		const s = setup();
		try {
			const caller = path.join(s.dir, "caller"),
				other = path.join(s.dir, "other");
			mkdirSync(caller);
			mkdirSync(other);
			const cwd = fromOtherCwd ? caller : s.dir;
			const localState = path.join(cwd, ".harness/merge-recovery-3.json");
			const worktreeState = path.join(s.dir, "worktrees/issue-3/.harness/merge-recovery-3.json");
			const result = await s.call("harness-phase", args, { GH_FAILURE: "recovery" }, cwd);
			assert.equal(result.code, 5, result.stderr);
			assert.ok(existsSync(localState));
			const rejected = await s.call("harness-merge", ["3"], {}, other);
			assert.notEqual(rejected.code, 0, rejected.stderr);
			assert.match(rejected.stderr, /復旧未確認/);
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
			assert.ok(existsSync(worktreeState));
			const retry = await s.call("harness-phase", args, {}, cwd);
			assert.equal(retry.code, 0, retry.stderr);
			assert.ok(!existsSync(localState));
			assert.ok(!existsSync(worktreeState));
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
for (const input of ["comment", "comment-file", "summary"]) {
	test(`M2: ${input}内のharness markerは終了2で全副作用ゼロ`, async () => {
		const s = setup();
		try {
			const marker = "説明\n<!-- harness:gate phase=awaiting-merge -->";
			const file = path.join(s.dir, "comment.md");
			writeFileSync(file, marker);
			const result = await s.call("harness-phase", [...args, `--${input}`, input === "comment-file" ? file : marker]);
			assert.equal(result.code, 2, result.stderr);
			assert.ok(!existsSync(s.env.MEDIA_LOG));
			assert.ok(!existsSync(path.join(s.dir, "gh-state.json")));
			assert.ok(!existsSync(path.join(s.dir, ".harness")));
			assert.ok(!existsSync(path.join(s.dir, "worktrees")));
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
test("M1/M4/M6d: 動画なしも同IDのpending→必須通知→完成、二度のmerge-ok取消し", async () => {
	const s = setup();
	try {
		const r = await s.call("harness-phase", args, { INJECT_MERGE_OK: "1" });
		assert.equal(r.code, 0, r.stderr);
		const state = s.state();
		assert.deepEqual(state.labels, ["harness:awaiting-merge"]);
		assert.equal(state.comments.length, 1);
		assert.match(state.comments[0].body, /attention=none/);
		assert.match(state.comments[0].body, /理由:/);
		assert.match(readFileSync(s.env.MEDIA_LOG, "utf8"), /label\ncomment\nnotify\npatch\nlabel/);
		assert.equal((await s.call("harness-merge", ["3"])).code, 1);
		const snapshot = await s.call("harness-inbox");
		assert.equal(snapshot.code, 0, snapshot.stderr);
		state.comments.push({
			id: 20,
			user: { login: "owner" },
			body: "OK",
			created_at: "2026-10-27T00:00:11Z",
			updated_at: "2026-10-27T00:00:11Z",
			html_url: "approved",
		});
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		assert.equal((await s.call("harness-merge", ["3"])).code, 0);
		assert.match(readFileSync(s.env.MEDIA_LOG, "utf8"), /merge --merge --match-head-commit a{40}/);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
for (const [failure, expected] of [
	["notify", 4],
	["patch", 7],
	["label-final", 5],
	["recovery", 5],
] as const) {
	test(`M4: ${failure} 後に追跡pendingとマージ拒否、復旧未確認を永続化`, async () => {
		const s = setup();
		try {
			const result = await s.call("harness-phase", args, {
				GH_FAILURE: failure,
				...(failure === "notify" ? { CURL_FAIL: "1" } : {}),
			});
			assert.equal(result.code, expected, result.stderr);
			assert.deepEqual(
				s.state().labels.filter((l: string) => l.startsWith("harness:") && l !== "harness:merge-ok"),
				["harness:awaiting-merge"],
			);
			if (failure !== "recovery") assert.match(s.state().comments.at(-1).body, /harness:pending/);
			else {
				assert.ok(existsSync(path.join(s.dir, ".harness/merge-recovery-3.json")));
				assert.match(s.state().comments.at(-1).body, /harness:gate/);
				assert.ok(s.state().labels.includes("harness:merge-ok"));
				assert.equal((await s.call("harness-merge", ["3"])).code, 1);
			}
			assert.notEqual((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-1"])).code, 0);
			if (failure !== "recovery") {
				const inbox = await s.call("harness-inbox");
				assert.match(inbox.stdout, /missing-notify/);
			}
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
			if (failure === "recovery") {
				const retry = await s.call("harness-phase", args);
				assert.equal(retry.code, 0, retry.stderr);
				assert.ok(!existsSync(path.join(s.dir, ".harness/merge-recovery-3.json")));
			}
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
test("M2: 静的未設定は4で全副作用ゼロ、プレースホルダーは2", async () => {
	const s = setup();
	try {
		const result = await s.call("harness-phase", args, { DISCORD_WEBHOOK_URL: "" });
		assert.equal(result.code, 4, result.stderr);
		assert.ok(!existsSync(s.env.MEDIA_LOG));
		assert.equal(
			(await s.call("harness-phase", [...args, "--comment", "【動きのない動画の場合だけ後半は変更"])).code,
			2,
		);
		for (const extra of [["--json"], ["--dry-run"], ["--file", "x"]])
			assert.equal((await s.call("harness-notify", ["--check-target", "--event", "merge-request", ...extra])).code, 2);
		const target = await s.call("harness-notify", ["--check-target", "--event", "merge-request"]);
		assert.deepEqual(JSON.parse(target.stdout), { available: true, engine: false, webhook: true });
		assert.doesNotMatch(target.stdout, /token|https/);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
test("M6: chat引数を厳密検査し、旧A/none/CI不良/直前変更を拒否", async () => {
	const s = setup();
	try {
		for (const a of [
			["--chat-approval", "OK"],
			["--attention", "A-1"],
			["--chat-approval", ""],
			["--wat"],
			["--chat-approval", "OK", "--attention", "bad"],
			["--chat-approval", "OK", "--attention", "A-1", "--attention", "A-2"],
		])
			assert.equal((await s.call("harness-merge", ["3", ...a])).code, 2);
		assert.equal((await s.call("harness-phase", args)).code, 0);
		const state = s.state();
		state.comments[0].body = state.comments[0].body.replace("attention=none", "attention=A-12");
		state.labels.push("harness:merge-ok");
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		savedAnswer(s.dir);
		const rejected = await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-11"]);
		assert.equal(rejected.code, 1);
		assert.match(rejected.stderr, /現在の依頼:/);
		assert.doesNotMatch(rejected.stderr, /A-12/);
		assert.equal(
			(await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-12"], { CI_BAD: "1" })).code,
			1,
		);
		assert.equal((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-12"])).code, 0);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

test("M1/M5/M6d: 小さなMP4を固定・再取得し同じコメントを完成、CDN URLは残さない", async () => {
	const s = setup();
	try {
		const file = path.join(s.dir, "input.mp4");
		const original = readFileSync(path.join(root, "tests/harness/fixtures/media/tiny.mp4"));
		writeFileSync(file, original);
		const extra = {
			NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${root}/tests/harness/fixtures/media/receipt-fetch.ts`,
		};
		const result = await s.call("harness-phase", [...args, "--file", file], extra);
		assert.equal(result.code, 0, result.stderr);
		const state = s.state(),
			body = state.comments[0].body;
		assert.deepEqual(readFileSync(s.env.SENT_COPY), original);
		assert.deepEqual(readFileSync(file), original);
		assert.match(body, /https:\/\/discord.com\/channels\/900\/456\/789/);
		assert.match(body, /demo-3-h264.mp4/);
		assert.match(body, new RegExp(`${original.length} bytes / SHA-256: [a-f0-9]{64} / 再取得照合済み`));
		assert.doesNotMatch(body, /cdn.discordapp.com|signature=|harness:pending/);
		assert.deepEqual(state.labels, ["harness:awaiting-merge"]);
		assert.equal(body.match(/sha=/g)?.length, 1);
		assert.equal(state.comments.length, 1);
		assert.equal((await s.call("harness-merge", ["3"])).code, 1);
		assert.equal(existsSync(readFileSync(s.env.SENT_FILE, "utf8")), false);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
for (const [failure, expected] of [
	["label-start", 5],
	["label-left", 5],
	["post", 1],
	["head-before", 7],
	["head-final", 7],
	["patch-loss", 7],
	["bad-time", 7],
	["bad-created", 7],
	["bad-id", 7],
	["label-final-read", 5],
] as const) {
	test(`M4: ${failure} は停止し後続のmergeを拒否する`, async () => {
		const s = setup();
		try {
			const result = await s.call("harness-phase", args, { GH_FAILURE: failure });
			assert.equal(result.code, expected, result.stderr);
			const state = s.state();
			assert.notEqual((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-1"])).code, 0);
			if (["label-start", "label-left", "post"].includes(failure)) {
				assert.equal(state.comments.length, 0);
				assert.doesNotMatch(
					existsSync(s.env.MEDIA_LOG) ? readFileSync(s.env.MEDIA_LOG, "utf8") : "",
					/comment|notify|patch/,
				);
			} else {
				assert.match(state.comments.at(-1).body, /harness:pending/);
				assert.deepEqual(state.labels, ["harness:awaiting-merge"]);
			}
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
test("M6a/b/c: 旧完成依頼から新head失敗・成功、旧Aと第三者gateと旧gateを拒否する", async () => {
	const s = setup();
	try {
		assert.equal((await s.call("harness-phase", args)).code, 0);
		const state = s.state();
		state.comments[0].body = state.comments[0].body.replace("attention=none", "attention=A-10");
		state.labels.push("harness:merge-ok");
		state.head = "b".repeat(40);
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		const fail = await s.call("harness-phase", args, { CURL_FAIL: "1" });
		assert.equal(fail.code, 4);
		assert.deepEqual(s.state().labels, ["harness:awaiting-merge"]);
		assert.match(s.state().comments.at(-1).body, /harness:pending/);
		for (const attention of ["A-10", "A-11"])
			assert.equal((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", attention])).code, 1);
		assert.equal((await s.call("harness-phase", args)).code, 0);
		const ready = s.state();
		ready.comments.at(-1).body = ready.comments.at(-1).body.replace("attention=none", "attention=A-11");
		ready.comments.push({
			...ready.comments[0],
			id: 99,
			user: { login: "stranger" },
			body: `<!-- harness:gate phase=awaiting-merge issue=3 sha=${ready.head} attention=A-10 -->`,
		});
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(ready));
		assert.equal((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-10"])).code, 1);
		savedAnswer(s.dir, "A-11");
		assert.equal((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-11"])).code, 0);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
test("M6e: pending/旧gateでもNGを先に返し、完成コメント編集後のOKだけ数える", async () => {
	const s = setup();
	try {
		assert.equal((await s.call("harness-phase", args)).code, 0);
		const original = s.state();
		for (const marker of ["pending", "old-gate", "edited-gate"]) {
			const state = structuredClone(original);
			state.labels = ["harness:awaiting-merge"];
			if (marker === "pending")
				state.comments[0].body = `<!-- harness:pending phase=awaiting-merge issue=3 sha=${state.head} -->`;
			if (marker === "old-gate") state.comments[0].body = state.comments[0].body.replace(" attention=none", "");
			state.comments.push({
				id: 20,
				user: { login: "owner" },
				body: marker === "edited-gate" ? "OK" : "NG: fix",
				created_at: "2026-10-27T00:00:05Z",
				updated_at: "2026-10-27T00:00:05Z",
				html_url: "owner-comment",
			});
			writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
			const inbox = await s.call("harness-inbox");
			assert.equal(inbox.code, 0, inbox.stderr);
			if (marker !== "edited-gate") assert.equal(JSON.parse(inbox.stdout).kind, "merge-ng");
			else assert.equal(inbox.stdout, "");
			assert.equal((await s.call("harness-merge", ["3"])).code, 1);
		}
		const edited = structuredClone(original);
		edited.comments[0].updated_at = "2026-10-27T00:00:20Z";
		for (const at of ["2026-10-27T00:00:11Z", "2026-10-27T00:00:21Z"]) {
			edited.comments = edited.comments.slice(0, 1);
			edited.comments.push({
				id: 20,
				user: { login: "owner" },
				body: "OK",
				created_at: at,
				updated_at: at,
				html_url: "owner-comment",
			});
			writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(edited));
			assert.equal((await s.call("harness-merge", ["3"])).code, at.endsWith("21Z") ? 0 : 1);
		}
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

for (const [mode, expected] of [
	["empty", 4],
	["invalid-json", 4],
	["204", 4],
	["guild-missing", 7],
	["parent-missing", 7],
	["wrong-channel", 7],
	["no-attachments", 7],
] as const) {
	test(`M2/M4: webhook ${mode} は未完了を保持する`, async () => {
		const s = setup();
		try {
			const file = path.join(s.dir, "tiny.mp4");
			writeFileSync(file, readFileSync(path.join(root, "tests/harness/fixtures/media/tiny.mp4")));
			const result = await s.call("harness-phase", [...args, "--file", file], {
				CURL_MODE: mode,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${root}/tests/harness/fixtures/media/receipt-fetch.ts`,
			});
			assert.equal(result.code, expected, result.stderr);
			assert.match(s.state().comments.at(-1).body, /harness:pending/);
			assert.deepEqual(s.state().labels, ["harness:awaiting-merge"]);
			assert.doesNotMatch(result.stderr, /token|signature=secret/);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
}
test("T0/M2: 一時envFilesを共通解決し、不正設定・HTTP URLでは副作用前に停止する", async () => {
	const s = setup();
	try {
		const config = s.env.HARNESS_CONFIG;
		writeFileSync(
			config,
			JSON.stringify({ project: "test", repo: "example/project", hooks: {}, notify: { envFiles: ["notify.env"] } }),
		);
		writeFileSync(
			path.join(s.dir, "notify.env"),
			"DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/123/private-token'\n",
		);
		const probe = await s.call("harness-notify", ["--check-target", "--event", "merge-request"], {
			DISCORD_WEBHOOK_URL: "",
		});
		assert.equal(probe.code, 0, probe.stderr);
		assert.equal(JSON.parse(probe.stdout).webhook, true);
		assert.doesNotMatch(probe.stdout, /private-token|https/);
		assert.ok(!existsSync(s.env.MEDIA_LOG));
		assert.equal(
			(await s.call("harness-phase", args, { DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/123/token" })).code,
			2,
		);
		writeFileSync(config, "{");
		assert.equal((await s.call("harness-phase", args)).code, 2);
		assert.ok(!existsSync(s.env.MEDIA_LOG));
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
test("M6: beforeMerge後のhead/A/完成時刻/ラベル変更・NG追加を直前検査で止める", async () => {
	for (const change of ["head", "attention", "completedAt", "labels", "ng"]) {
		const s = setup();
		try {
			assert.equal((await s.call("harness-phase", args)).code, 0);
			const state = s.state();
			state.comments[0].body = state.comments[0].body.replace("attention=none", "attention=A-12");
			writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
			savedAnswer(s.dir);
			const mutation =
				change === "head"
					? 's.head="b".repeat(40)'
					: change === "attention"
						? 's.comments[0].body=s.comments[0].body.replace("A-12","A-13")'
						: change === "completedAt"
							? 's.comments[0].updated_at="2026-10-27T00:00:20Z"'
							: change === "labels"
								? "s.labels=[]"
								: 's.comments.push({id:21,user:{login:"owner"},body:"NG",created_at:"2026-10-27T00:00:05Z",html_url:"ng"})';
			writeFileSync(
				path.join(s.dir, "mutate.cjs"),
				`const f=require("node:fs"),p=__dirname+"/gh-state.json",s=JSON.parse(f.readFileSync(p));${mutation};f.writeFileSync(p,JSON.stringify(s));`,
			);
			writeFileSync(
				s.env.HARNESS_CONFIG,
				JSON.stringify({
					project: "test",
					repo: "example/project",
					owners: ["owner"],
					hooks: { beforeMerge: ['node "$CLAUDE_PROJECT_DIR/mutate.cjs"'] },
					notify: { envFiles: [] },
				}),
			);
			assert.equal((await s.call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-12"])).code, 1);
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	}
});

test("M2: 差し替えengine結果のA欠落/不正/source誤りを7で拒否し、webhookと区別する", async () => {
	for (const receipt of [
		{ status: "posted", source: "engine", attention: null },
		{ status: "posted", source: "engine", attention: "bad" },
		{ status: "posted", source: "unknown", attention: "A-12" },
		{ status: "posted", source: "engine", attention: "A-12" },
	]) {
		const s = setup();
		try {
			const bin = path.join(s.dir, "bin"),
				src = path.join(s.dir, "src");
			mkdirSync(bin);
			mkdirSync(src);
			copyFileSync(path.join(root, "src/harness-request.ts"), path.join(src, "harness-request.ts"));
			for (const file of ["harness-approval.ts", "harness-project.ts", "notification-receipt.ts"])
				symlinkSync(path.join(root, "src", file), path.join(src, file));
			symlinkSync(path.join(root, "bin/harness-config"), path.join(bin, "harness-config"));
			writeFileSync(
				path.join(bin, "harness-notify"),
				'#!/bin/sh\nif [ "$1" = --check-target ]; then echo \'{"available":true,"engine":true,"webhook":false}\'; else cat "$CLAUDE_PROJECT_DIR/fake-receipt.json"; fi\n',
				{ mode: 0o755 },
			);
			writeFileSync(path.join(s.dir, "fake-receipt.json"), JSON.stringify(receipt));
			const comment = path.join(s.dir, "comment.md"),
				summary = path.join(s.dir, "summary.md");
			writeFileSync(comment, "理由: 操作なし");
			writeFileSync(summary, "理由: 操作なし");
			const result = await new Promise<{ code: number; stderr: string }>((resolve) =>
				execFile(
					process.execPath,
					[path.join(src, "harness-request.ts"), "3", "5", comment, summary, "", path.join(s.dir, "tmp")],
					{ cwd: s.dir, env: s.env, timeout: 15000 },
					(error, _stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stderr }),
				),
			);
			const success = receipt.source === "engine" && receipt.attention === "A-12";
			assert.equal(result.code, success ? 0 : 7, result.stderr);
			assert.match(s.state().comments.at(-1).body, success ? /attention=A-12/ : /harness:pending/);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	}
});

function diagnostics(stderr: string) {
	return stderr
		.split("\n")
		.filter((line) => line.startsWith('{"kind":"chat-rejection"'))
		.map((line) => JSON.parse(line));
}
async function chatFixture() {
	const s = setup();
	assert.equal((await s.call("harness-phase", args)).code, 0);
	const state = s.state();
	state.comments[0].body = state.comments[0].body.replace("attention=none", "attention=A-12");
	writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
	savedAnswer(s.dir);
	return s;
}
const chatArgs = ["3", "--chat-approval", "偽の引用", "--attention", "A-12"];
test("T3/T4: 完成前のOKを終了0の後に回収し、台帳原文で1回マージする", async () => {
	const s = await chatFixture();
	try {
		const body = "OK（Discord: jonnity）。ただし、…崩れているように見える。…かもしれない。";
		savedAnswer(s.dir, "A-12", body);
		const inbox = await s.call("harness-inbox");
		assert.equal(inbox.code, 0, inbox.stderr);
		assert.deepEqual(JSON.parse(inbox.stdout), {
			issue: 3,
			pr: 5,
			kind: "chat-merge-ok",
			attention: "A-12",
			body,
			resolvedAt: "2026-10-27T00:00:05Z",
			url: s.state().comments[0].html_url,
		});
		const result = await s.call("harness-merge", chatArgs);
		assert.equal(result.code, 0, result.stderr);
		const log = readFileSync(s.env.MEDIA_LOG, "utf8");
		assert.equal(log.split("\n").filter((line) => line.startsWith("merge ")).length, 1);
		assert.match(readFileSync(s.env.POST_BODY, "utf8"), /OK（Discord: jonnity）/);
		assert.doesNotMatch(readFileSync(s.env.POST_BODY, "utf8"), /偽の引用/);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});
for (const [change, reason, kind] of [
	["NG", "answer-not-ok", "chat-not-approved"],
	["open", "attention-open", ""],
	["missing", "attention-not-found", "missing-attention"],
	["broken", "attention-unavailable", "attention-unavailable"],
	["seq", "attention-seq-behind", "attention-unavailable"],
	["scope", "attention-scope-mismatch", "attention-mismatch"],
	["time", "answer-before-created", "chat-not-approved"],
] as const)
	test(`T3/T4: ${change}は偽の引用でも拒否し、inboxと即時経路の理由が一致する`, async () => {
		const s = await chatFixture();
		try {
			if (change === "NG") savedAnswer(s.dir, "A-12", "NG");
			if (change === "open") savedAnswer(s.dir, "A-12", "OK", { status: "open" });
			if (change === "missing") writeFileSync(path.join(s.dir, "attention.json"), "[]");
			if (change === "broken") writeFileSync(path.join(s.dir, "attention.json"), "broken");
			if (change === "seq") writeFileSync(path.join(s.dir, "state.json"), '{"attentionSeq":11}');
			if (change === "scope") savedAnswer(s.dir, "A-12", "OK", { pr: "6" });
			if (change === "time") savedAnswer(s.dir, "A-12", "OK", { resolvedAt: "2026-10-26T00:00:00Z" });
			const inbox = await s.call("harness-inbox");
			assert.equal(inbox.code, 0, inbox.stderr);
			if (kind) assert.equal(JSON.parse(inbox.stdout).kind, kind);
			else assert.equal(inbox.stdout, "");
			const result = await s.call("harness-merge", chatArgs);
			assert.equal(result.code, 1);
			assert.deepEqual(diagnostics(result.stderr), [
				{ kind: "chat-rejection", attention: "A-12", reason, url: s.state().comments[0].html_url },
			]);
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
			assert.equal(s.state().comments.length, 1);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});

for (const change of ["delete", "answer", "resolvedAt", "corrupt"])
	test(`T4: hook同期後の台帳${change}を再読取りし、副作用前に止める`, async () => {
		const s = await chatFixture();
		try {
			const config = JSON.parse(readFileSync(s.env.HARNESS_CONFIG, "utf8"));
			config.hooks.beforeMerge = ['node "$CLAUDE_PROJECT_DIR/wait.cjs"'];
			writeFileSync(s.env.HARNESS_CONFIG, JSON.stringify(config));
			writeFileSync(
				path.join(s.dir, "wait.cjs"),
				`const f=require('node:fs'),p=__dirname;f.writeFileSync(p+'/ready','');const deadline=Date.now()+5000;while(!f.existsSync(p+'/release')){if(Date.now()>deadline)process.exit(9);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`,
			);
			const running = s.call("harness-merge", chatArgs);
			const deadline = Date.now() + 8000;
			while (!existsSync(path.join(s.dir, "ready"))) {
				assert.ok(Date.now() < deadline, "hookの同期開始が届くこと");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (change === "delete") rmSync(path.join(s.dir, "attention.json"));
			else {
				const items = JSON.parse(readFileSync(path.join(s.dir, "attention.json"), "utf8"));
				if (change === "answer") items[0].answer = "OK、変更済み";
				if (change === "resolvedAt") items[0].resolvedAt = "2026-10-27T00:00:06Z";
				writeFileSync(path.join(s.dir, "attention.next"), change === "corrupt" ? "{" : JSON.stringify(items));
				const { renameSync } = await import("node:fs");
				renameSync(path.join(s.dir, "attention.next"), path.join(s.dir, "attention.json"));
			}
			writeFileSync(path.join(s.dir, "release"), "");
			const result = await running;
			assert.equal(result.code, 1, result.stderr);
			assert.equal(
				diagnostics(result.stderr)[0]?.reason,
				change === "delete" || change === "corrupt" ? "attention-unavailable" : "approval-changed",
			);
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
			assert.equal(s.state().comments.length, 1);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
test("T3/T4: GitHubのOKは台帳の不通・不在・不一致・古い非OKより優先し、NGはchat OKを止める", async () => {
	for (const problem of ["unavailable", "missing", "mismatch", "approved", "not-approved"]) {
		const s = await chatFixture();
		try {
			if (problem === "unavailable") rmSync(path.join(s.dir, "attention.json"));
			if (problem === "missing") writeFileSync(path.join(s.dir, "attention.json"), "[]");
			if (problem === "mismatch") savedAnswer(s.dir, "A-12", "OK", { project: "other" });
			if (problem === "not-approved") savedAnswer(s.dir, "A-12", "NG");
			const state = s.state();
			state.labels.push("harness:merge-ok");
			if (problem === "not-approved")
				state.labelEvents = [
					{ event: "labeled", label: { name: "harness:merge-ok" }, created_at: "2026-10-27T00:10:11Z" },
				];
			writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
			assert.equal(JSON.parse((await s.call("harness-inbox")).stdout).kind, "merge-ok");
			assert.equal((await s.call("harness-merge", ["3"])).code, 0);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	}
	const s = await chatFixture();
	try {
		const state = s.state();
		state.comments.push({
			id: 20,
			user: { login: "owner" },
			body: "NG",
			created_at: "2026-10-27T00:00:05Z",
			html_url: "ng",
		});
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		assert.equal(JSON.parse((await s.call("harness-inbox")).stdout).kind, "merge-ng");
		assert.equal(diagnostics((await s.call("harness-merge", chatArgs)).stderr)[0]?.reason, "github-ng");
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

for (const source of ["comment", "approve", "label"]) {
	for (const [scenario, resolvedAt, expected] of [
		["GitHub OK の後に Discord NG", "2026-10-27T00:10:11.001Z", "chat-not-approved"],
		["GitHub OK の2分前に Discord NG", "2026-10-27T00:08:11Z", "chat-not-approved"],
		["GitHub OK の10分前に Discord NG", "2026-10-27T00:00:11Z", "merge-ok"],
		["GitHub OK の5分前に Discord NG", "2026-10-27T00:05:11Z", "chat-not-approved"],
		["GitHub OK の5分と1ミリ秒前に Discord NG", "2026-10-27T00:05:10.999Z", "merge-ok"],
		["台帳に回答なし", undefined, "merge-ok"],
		["同時刻", "2026-10-27T00:10:11.000Z", "chat-not-approved"],
	] as const)
		test(`T4/R1: ${scenario}（${source}）`, async () => {
			const s = await chatFixture();
			try {
				savedAnswer(s.dir, "A-12", "NG", { resolvedAt, ...(resolvedAt ? {} : { status: "open", answer: undefined }) });
				const state = s.state();
				const at = "2026-10-27T00:10:11Z";
				if (source === "comment")
					state.comments.push({ ...state.comments[0], id: 20, user: { login: "owner" }, body: "OK", created_at: at });
				if (source === "approve")
					state.reviews.push({ user: { login: "owner" }, state: "APPROVED", submitted_at: at, commit_id: state.head });
				if (source === "label") {
					state.labels.push("harness:merge-ok");
					state.labelEvents = [
						{ event: "labeled", label: { name: "harness:merge-ok" }, created_at: at },
						{ event: "labeled", label: { name: "other" }, created_at: "2026-10-27T00:10:20Z" },
						{ event: "labeled", label: { name: "harness:merge-ok" }, created_at: "2026-10-26T00:00:00Z" },
					];
				}
				writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
				const inbox = await s.call("harness-inbox");
				assert.equal(inbox.code, 0, inbox.stderr);
				const event = JSON.parse(inbox.stdout);
				assert.equal(event.kind, expected);
				if (expected === "chat-not-approved") {
					assert.equal(event.attention, "A-12");
					assert.equal(event.reason, "answer-not-ok");
				}
				const result = await s.call("harness-merge", ["3"]);
				assert.equal(result.code, expected === "merge-ok" ? 0 : 1, result.stderr);
				if (expected === "chat-not-approved") assert.match(result.stderr, /answer-not-ok/);
				assert.equal(
					readFileSync(s.env.MEDIA_LOG, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("merge ")).length,
					expected === "merge-ok" ? 1 : 0,
				);
			} finally {
				rmSync(s.dir, { recursive: true, force: true });
			}
		});
}

test("T4/R1: mergeable 拒否は base の取り込みを案内する", async () => {
	const s = await chatFixture();
	try {
		const result = await s.call("harness-merge", chatArgs, { MERGEABLE: "CONFLICTING" });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /base を取り込んで/);
		assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

test("T4/R1: owners 読取り失敗は A がなくても unavailable を返す", async () => {
	const s = setup();
	try {
		assert.equal((await s.call("harness-phase", args)).code, 0);
		const state = s.state();
		state.comments.push({
			...state.comments[0],
			id: 20,
			user: { login: "owner" },
			body: "OK",
			created_at: "2026-10-27T00:00:11Z",
		});
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		const config = JSON.parse(readFileSync(s.env.HARNESS_CONFIG, "utf8"));
		config.owners = 1;
		writeFileSync(s.env.HARNESS_CONFIG, JSON.stringify(config));
		const inbox = await s.call("harness-inbox");
		assert.equal(inbox.code, 0, inbox.stderr);
		assert.equal(JSON.parse(inbox.stdout).kind, "attention-unavailable");
		assert.equal(JSON.parse(inbox.stdout).reason, "attention-unavailable");
		assert.equal((await s.call("harness-merge", ["3"])).code, 1);
		assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

test("T4/R2: owners 読取り失敗は merge-ok ラベルがあっても GitHub 経路を拒否する", async () => {
	const s = await chatFixture();
	try {
		const state = s.state();
		state.labels.push("harness:merge-ok");
		state.comments.push({
			...state.comments[0],
			id: 20,
			user: { login: "owner" },
			body: "NG 直して",
			created_at: "2026-10-27T00:00:12Z",
		});
		writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
		savedAnswer(s.dir, "A-12", "NG", { resolvedAt: "2026-10-27T00:00:13Z" });
		const config = JSON.parse(readFileSync(s.env.HARNESS_CONFIG, "utf8"));
		config.owners = 1;
		writeFileSync(s.env.HARNESS_CONFIG, JSON.stringify(config));
		const inbox = await s.call("harness-inbox");
		assert.equal(inbox.code, 0, inbox.stderr);
		assert.equal(JSON.parse(inbox.stdout).kind, "attention-unavailable");
		assert.equal(JSON.parse(inbox.stdout).reason, "attention-unavailable");
		const result = await s.call("harness-merge", ["3"]);
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.stderr, /attention-unavailable/);
		assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
		assert.equal(s.state().comments.length, 2);
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

test("T4: フォアグラウンドphaseの終了前に届いたOKを終了0の後に処理する", async () => {
	const s = setup();
	try {
		mkdirSync(path.join(s.dir, "bin"));
		mkdirSync(path.join(s.dir, "src"));
		copyFileSync(path.join(root, "bin/harness-phase"), path.join(s.dir, "bin/harness-phase"));
		copyFileSync(path.join(root, "src/harness-request.ts"), path.join(s.dir, "src/harness-request.ts"));
		for (const file of ["harness-approval.ts", "harness-project.ts", "notification-receipt.ts"])
			symlinkSync(path.join(root, "src", file), path.join(s.dir, "src", file));
		symlinkSync(path.join(root, "bin/harness-config"), path.join(s.dir, "bin/harness-config"));
		writeFileSync(
			path.join(s.dir, "early-answer.cjs"),
			`const f=require('node:fs'),p=__dirname,s=JSON.parse(f.readFileSync(p+'/gh-state.json'));if(!s.comments.at(-1).body.includes('harness:pending')||!f.existsSync(p+'/.harness/merge-recovery-3.json'))throw Error('完成前であること');f.writeFileSync(p+'/early-ok','');f.writeFileSync(p+'/attention.json',JSON.stringify([{id:'A-12',kind:'merge',taskId:'test#3',project:'test',issue:'3',pr:'5',title:'承認',url:'url',summary:'概要',status:'resolved',createdAt:'2026-10-27T00:00:00Z',resolvedAt:'2026-10-27T00:00:05Z',answer:'OK'}]));f.writeFileSync(p+'/state.json','{"attentionSeq":12}');`,
		);
		writeFileSync(
			path.join(s.dir, "bin/harness-notify"),
			'#!/usr/bin/env bash\nif [ "$1" != --check-target ]; then\nnode "$CLAUDE_PROJECT_DIR/early-answer.cjs" || exit 1\nprintf "%s\\n" "$*" >> "$CLAUDE_PROJECT_DIR/notifications"\nfi\nprintf \'%s\\n\' \'{"status":"posted","source":"engine","attention":"A-12"}\'\n',
			{ mode: 0o755 },
		);
		const result = await new Promise<{ code: number; stderr: string }>((resolve) =>
			execFile(
				path.join(s.dir, "bin/harness-phase"),
				args,
				{ cwd: s.dir, env: s.env, timeout: 15000 },
				(err, _out, stderr) => resolve({ code: err ? Number(err.code) : 0, stderr }),
			),
		);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(existsSync(path.join(s.dir, "early-ok")));
		assert.ok(!existsSync(path.join(s.dir, ".harness/merge-recovery-3.json")));
		assert.match(s.state().comments[0].body, /attention=A-12/);
		const inbox = await s.call("harness-inbox");
		const event = JSON.parse(inbox.stdout);
		assert.equal(event.kind, "chat-merge-ok");
		assert.equal(event.attention, "A-12");
		assert.equal(
			(await s.call("harness-merge", ["3", "--chat-approval", event.body, "--attention", event.attention])).code,
			0,
		);
		assert.equal(
			readFileSync(s.env.MEDIA_LOG, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("merge ")).length,
			1,
		);
		assert.doesNotMatch(readFileSync(path.join(s.dir, "notifications"), "utf8"), /--event info/);
		assert.equal((await s.call("harness-inbox")).stdout, "");
	} finally {
		rmSync(s.dir, { recursive: true, force: true });
	}
});

for (const change of [
	"pending",
	"recovery",
	"stale",
	"inactive",
	"none",
	"superseded",
	"answer-missing",
	"resolved-at-missing",
	"invalid-time",
	"ci",
	"hook",
])
	test(`T4: ${change}の構造化reasonと拒否したAを返す`, async () => {
		const s = await chatFixture();
		try {
			const state = s.state();
			let reason = change;
			if (change === "pending") {
				state.comments[0].body = `<!-- harness:pending phase=awaiting-merge issue=3 sha=${state.head} -->`;
				reason = "request-failed";
			}
			if (change === "recovery") {
				mkdirSync(path.join(s.dir, ".harness"), { recursive: true });
				symlinkSync(path.join(s.dir, "not-found"), path.join(s.dir, ".harness/merge-recovery-3.json"));
				reason = "recovery-unconfirmed";
			}
			if (change === "stale") {
				state.head = "b".repeat(40);
				reason = "request-stale";
			}
			if (change === "inactive") {
				state.labels = [];
				reason = "request-inactive";
			}
			if (change === "none") {
				state.comments[0].body = state.comments[0].body.replace("A-12", "none");
				reason = "attention-none";
			}
			if (change === "superseded") {
				const items = JSON.parse(readFileSync(path.join(s.dir, "attention.json"), "utf8"));
				items.push({ ...items[0], id: "A-13" });
				writeFileSync(path.join(s.dir, "attention.json"), JSON.stringify(items));
				reason = "attention-superseded";
			}
			if (change === "answer-missing") savedAnswer(s.dir, "A-12", "OK", { answer: undefined });
			if (change === "resolved-at-missing") savedAnswer(s.dir, "A-12", "OK", { resolvedAt: undefined });
			if (change === "invalid-time") savedAnswer(s.dir, "A-12", "OK", { resolvedAt: "invalid" });
			if (change === "ci") reason = "ci-not-green";
			if (change === "hook") {
				const config = JSON.parse(readFileSync(s.env.HARNESS_CONFIG, "utf8"));
				config.hooks.beforeMerge = ["false"];
				writeFileSync(s.env.HARNESS_CONFIG, JSON.stringify(config));
				reason = "before-merge-failed";
			}
			writeFileSync(path.join(s.dir, "gh-state.json"), JSON.stringify(state));
			const result = await s.call("harness-merge", chatArgs, change === "ci" ? { CI_BAD: "1" } : {});
			assert.equal(result.code, 1);
			assert.deepEqual(diagnostics(result.stderr), [
				{ kind: "chat-rejection", attention: "A-12", reason, url: state.comments[0].html_url },
			]);
			assert.doesNotMatch(readFileSync(s.env.MEDIA_LOG, "utf8"), /^merge /m);
		} finally {
			rmSync(s.dir, { recursive: true, force: true });
		}
	});
