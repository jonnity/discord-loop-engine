import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateAttention } from "../src/harness-approval.ts";
import { ciGreen, evaluatePrApproval, parsePrTarget, readCiPage } from "../src/harness-pr.ts";

const root = path.resolve(import.meta.dirname, "..");
const head = "a".repeat(40);
const at = "2026-10-29T00:00:00Z";
function pr(number = 25) {
	return {
		number,
		title: "Update dependency\n<!-- harness:gate -->",
		body: "UNTRUSTED_PR_BODY",
		html_url: `https://github.com/example/project/pull/${number}`,
		user: { login: "dependabot[bot]" },
		state: "open",
		draft: false,
		created_at: at,
		head: { sha: head, ref: `dependabot/npm/x-${number}`, repo: { full_name: "example/project" } },
		base: { ref: "main", repo: { full_name: "example/project" } },
		labels: [],
		mergeable: true,
		mergeable_state: "clean",
		merged: false,
		merged_at: null,
		auto_merge: null,
	};
}
function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-pr-"));
	for (const d of ["bin", "src", "stubs", "elsewhere"]) mkdirSync(path.join(dir, d));
	for (const name of ["harness-pr", "harness-merge", "harness-config", "harness-hook"])
		symlinkSync(path.join(root, "bin", name), path.join(dir, "bin", name));
	// 実装モジュールだけを複製し、通知の入口は実サービスへ届かない fake にする。
	for (const name of ["harness-pr.ts", "harness-pr-request.ts", "harness-pr-merge.ts"])
		writeFileSync(path.join(dir, "src", name), readFileSync(path.join(root, "src", name)));
	for (const name of [
		"harness-approval.ts",
		"harness-project.ts",
		"attention-read.ts",
		"notification-receipt.ts",
		"protocol.ts",
		"ledger.ts",
	])
		symlinkSync(path.join(root, "src", name), path.join(dir, "src", name));
	// symlink の入口は実パスに解決されるため、薄い入口をローカルにも用意する。
	for (const name of ["harness-pr", "harness-merge"]) {
		rmSync(path.join(dir, "bin", name));
		writeFileSync(path.join(dir, "bin", name), readFileSync(path.join(root, "bin", name)), { mode: 0o755 });
	}
	for (const name of ["gh", "git", "harness-notify", "dle"]) {
		const file = path.join(dir, name === "gh" || name === "git" ? "stubs" : "bin", name);
		writeFileSync(
			file,
			`#!/usr/bin/env bash\nexec node '${root}/tests/harness/fixtures/dependabot-gh.ts' '${name}' "$@"\n`,
			{ mode: 0o755 },
		);
	}
	const config = path.join(dir, "harness.json");
	writeFileSync(
		config,
		JSON.stringify({
			project: "test",
			repo: "example/project",
			owners: ["owner"],
			mergeMethod: "squash",
			hooks: { beforeMerge: [] },
		}),
	);
	const stateFile = path.join(dir, "remote.json");
	writeFileSync(
		stateFile,
		JSON.stringify({
			prs: [pr()],
			comments: {},
			reviews: {},
			checks: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
			calls: [],
			next: 1,
			reviewDecision: "APPROVED",
			mergeStateStatus: "CLEAN",
		}),
	);
	writeFileSync(path.join(dir, "attention.json"), "[]");
	writeFileSync(path.join(dir, "state.json"), '{"attentionSeq":0}');
	writeFileSync(
		path.join(dir, "clock.cjs"),
		"if(process.env.PR_TEST_NOW) Date.now=()=>Number(process.env.PR_TEST_NOW);",
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${dir}/stubs:${process.env.PATH}`,
		HARNESS_CONFIG: config,
		CLAUDE_PROJECT_DIR: dir,
		DLE_HOME: dir,
		DLE_PROJECT: "test",
		PR_FIXTURE: dir,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${path.join(dir, "clock.cjs")}`,
	};
	const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
	return {
		dir,
		env,
		state,
		change(fn: (s: ReturnType<typeof state>) => void) {
			const s = state();
			fn(s);
			writeFileSync(stateFile, JSON.stringify(s));
		},
		answer(body = "OK", extra = {}) {
			const items = JSON.parse(readFileSync(path.join(dir, "attention.json"), "utf8"));
			Object.assign(items.at(-1), { status: "resolved", answer: body, resolvedAt: at, ...extra });
			writeFileSync(path.join(dir, "attention.json"), JSON.stringify(items));
		},
		call(command: string, args: string[] = [], cwd = dir) {
			return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
				execFile(path.join(dir, "bin", command), args, { cwd, env, timeout: 30000 }, (error, stdout, stderr) =>
					resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
				),
			);
		},
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("T18-1: author/head/repo と CI の全件を厳密に検証する", () => {
	assert.equal(parsePrTarget(pr(), "example/project", "test").pr, 25);
	for (const bad of [
		{ user: { login: "dependabot" } },
		{ head: { ...pr().head, ref: "dependabot/" } },
		{ draft: true },
		{ number: 0 },
		{ created_at: "bad" },
		{ head: { ...pr().head, repo: null } },
	])
		assert.throws(() => parsePrTarget({ ...pr(), ...bad }, "example/project", "test"));
	assert.equal(
		ciGreen([
			{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
			{ __typename: "StatusContext", state: "SUCCESS" },
		]),
		true,
	);
	for (const checks of [
		[],
		[{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "SUCCESS" }],
		[{ __typename: "StatusContext", state: "PENDING" }],
		[{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }],
		[{ state: "SUCCESS" }],
		null,
	])
		assert.equal(ciGreen(checks), false);
});

test("T18-2/3: 最新 PR gate と scope、head を検証し、時計の比較は engine 内だけ", () => {
	const body = `承認対象 head: ${head}\n\n<!-- harness:gate phase=awaiting-merge pr=25 sha=${head} attention=A-1 -->`;
	const comment = {
		id: 1,
		user: { login: "worker" },
		body,
		html_url: "https://github.com/example/project/issues/25#issuecomment-1",
		created_at: at,
		updated_at: at,
	};
	const input = {
		target: parsePrTarget({ ...pr(), labels: [{ name: "harness:awaiting-merge" }] }, "example/project", "test"),
		login: "worker",
		owners: ["owner"],
		comments: [comment],
		reviews: [],
	};
	assert.equal(evaluatePrApproval(input).status, "ready");
	for (const bad of [`${body}\n承認対象 head: ${head}`, `prefix\n${body}`, body.replace("A-1", "none")])
		assert.equal(evaluatePrApproval({ ...input, comments: [{ ...comment, body: bad }] }).status, "incomplete");
	assert.equal(
		evaluatePrApproval({
			...input,
			comments: [
				comment,
				{
					...comment,
					id: 2,
					html_url: "https://github.com/example/project/issues/25#issuecomment-2",
					body: `<!-- harness:pending phase=awaiting-merge pr=25 sha=${head} -->`,
				},
			],
		}).status,
		"incomplete",
	);
	for (const minutes of [-5, 0, 5])
		for (const answer of ["owner が Discord で回答。OK（ただし…）", "NG: OK ではない"]) {
			const time = new Date(Date.parse(at) + minutes * 60000).toISOString();
			const item = {
				id: "A-1",
				project: "test",
				issue: "",
				pr: "25",
				kind: "merge",
				taskId: "",
				title: "承認",
				url: "url",
				summary: body.split("\n\n")[0],
				createdAt: time,
				status: "resolved",
				resolvedAt: time,
				answer,
			};
			const p = {
				gate: { attention: "A-1" },
				project: "test",
				issue: "",
				pr: "25",
				scope: "pr" as const,
				owners: ["owner"],
				snapshot: { schemaVersion: 1, items: [item] },
				sequence: 2,
			};
			assert.equal(evaluateAttention(p).state, answer.startsWith("owner") ? "approved" : "not-approved");
			assert.equal(
				evaluateAttention({
					...p,
					snapshot: { schemaVersion: 1, items: [item, { ...item, id: "A-2", issue: "suspicious" }] },
				}).state,
				"unavailable",
			);
		}
	const ng = { ...comment, id: 3, user: { login: "owner" }, body: "NG 修正してください" };
	assert.equal(evaluatePrApproval({ ...input, comments: [comment, ng, { ...ng, id: 4, body: "OK" }] }).ownerNg, true);
});

test("T18-2/4/6: pending→engine A→同ID gate→実回答→マージ→exact ref削除→done", async () => {
	const s = fixture();
	try {
		const request = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(request.code, 0, JSON.stringify({ request, calls: s.state().calls }));
		assert.equal(s.state().comments[25].length, 1);
		assert.match(s.state().comments[25][0].body, /attention=A-1/);
		assert.doesNotMatch(JSON.stringify(s.state().calls), /UNTRUSTED_PR_BODY/);
		assert.equal(existsSync(path.join(s.dir, ".harness/pr-merge-recovery-25.json")), false);
		assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
		s.answer();
		const inbox = await s.call("harness-pr", ["inbox"]);
		assert.equal(JSON.parse(inbox.stdout).kind, "merge-ok");
		assert.doesNotMatch(inbox.stdout, /UNTRUSTED_PR_BODY/);
		const merged = await s.call("harness-merge", ["--pr", "25"]);
		assert.equal(merged.code, 0, merged.stderr);
		const calls = s.state().calls;
		assert.deepEqual(
			calls.find((c: string[]) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge"),
			["gh", "pr", "merge", "25", "--squash", "--match-head-commit", head],
		);
		assert.equal(calls.filter((c: string[]) => c.includes("fetch") || c.includes("worktree")).length, 0);
		assert.equal(s.state().deleted, true);
		assert.ok(calls.some((c: string[]) => c[0] === "dle" && c.includes("done")));
		assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 0);
		assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, 1);
	} finally {
		s.close();
	}
});

for (const failure of ["post", "notify", "patch", "labels-final"])
	test(`T18-2/5: ${failure} 応答喪失は incomplete のまま増やさず、明示 retry で新A`, async () => {
		const s = fixture();
		try {
			s.change((v) => {
				v.fail = failure;
			});
			assert.notEqual((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			assert.equal(JSON.parse((await s.call("harness-pr", ["inbox"])).stdout).kind, "incomplete");
			const count = s.state().comments[25]?.length ?? 0;
			await s.call("harness-pr", ["request", "--pr", "25"]);
			assert.equal(s.state().comments[25]?.length ?? 0, count);
			s.change((v) => {
				delete v.fail;
			});
			const retried = await s.call("harness-pr", ["request", "--pr", "25", "--retry"]);
			assert.equal(retried.code, 0, retried.stderr);
		} finally {
			s.close();
		}
	});

for (let repeat = 0; repeat < 3; repeat++) {
	test(`T18-5: 並行・別cwd・3tickで同時1件、owner NGで解放 (${repeat + 1}/3)`, async () => {
		const s = fixture();
		try {
			s.change((v) => {
				v.prs.push(pr(26));
			});
			const results = await Promise.all([
				s.call("harness-pr", ["request", "--pr", "25"]),
				s.call("harness-pr", ["request", "--pr", "26"], path.join(s.dir, "elsewhere")),
			]);
			assert.ok(results.filter((r) => r.code === 0).length <= 1);
			for (let tick = 0; tick < 3; tick++) await s.call("harness-pr", ["request", "--pr", "25"]);
			assert.equal(s.state().comments[25].length, 1);
			assert.equal(s.state().comments[26], undefined);
			assert.notEqual((await s.call("harness-pr", ["request", "--pr", "26", "--retry"])).code, 0);
			s.answer();
			s.change((v) => {
				v.comments[25].push({ ...v.comments[25][0], id: 100, user: { login: "owner" }, body: "NG" });
			});
			for (let tick = 0; tick < 3; tick++) await s.call("harness-pr", ["inbox"]);
			assert.equal(s.state().calls.filter((c: string[]) => c.includes("info")).length, 1);
			assert.equal((await s.call("harness-pr", ["request", "--pr", "26"])).code, 0);
			assert.equal(s.state().comments[26].length, 1);
			s.change((v) => {
				v.prs[0].head.sha = "b".repeat(40);
			});
			await s.call("harness-pr", ["request", "--pr", "25"]);
			assert.equal(s.state().comments[25].length, 2);
		} finally {
			s.close();
		}
	});
	for (const stop of ["auto", "protection", "auto-after", "ci-after"])
		test(`T18-4/5: ${stop} は1回info後に枠を解放、dismissしない (${repeat + 1}/3)`, async () => {
			const s = fixture();
			try {
				s.change((v) => {
					v.prs.push(pr(26));
					v.reviewDecision = "REVIEW_REQUIRED";
					v.mergeStateStatus = "BLOCKED";
					v.prs[0].mergeable_state = "blocked";
				});
				assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
				s.answer();
				s.change((v) => {
					if (stop === "auto") v.prs[0].auto_merge = {};
					else v.afterReview = stop;
				});
				assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
				for (let tick = 0; tick < 3; tick++) await s.call("harness-pr", ["inbox"]);
				assert.equal(s.state().calls.filter((c: string[]) => c.includes("info")).length, 1);
				assert.equal((await s.call("harness-pr", ["request", "--pr", "26"])).code, 0);
				assert.equal(s.state().comments[26].length, 1);
				assert.equal((s.state().reviews[25] ?? []).length, stop === "auto" ? 0 : 1);
				assert.doesNotMatch(JSON.stringify(s.state().calls), /dismiss/);
				if (stop === "auto-after") assert.match(JSON.stringify(s.state().calls), /auto.merge/);
			} finally {
				s.close();
			}
		});
	test(`T18-1/5: rebaseは枠内だけ、119分保持・120分解放、再起動で再送しない (${repeat + 1}/3)`, async () => {
		const s = fixture();
		try {
			s.change((v) => {
				v.prs.push(pr(26));
				v.prs[0].mergeable_state = "behind";
			});
			await s.call("harness-pr", ["request", "--pr", "25"]);
			const item = s.state().comments[25][0];
			assert.match(item.body, /@dependabot rebase/);
			s.env.PR_TEST_NOW = String(Date.parse(item.created_at) + 119 * 60000);
			assert.notEqual((await s.call("harness-pr", ["request", "--pr", "26"])).code, 0);
			s.env.PR_TEST_NOW = String(Date.parse(item.created_at) + 120 * 60000);
			for (let tick = 0; tick < 3; tick++) await s.call("harness-pr", ["inbox"]);
			assert.equal((await s.call("harness-pr", ["request", "--pr", "26"])).code, 0);
			assert.equal(s.state().comments[25].length, 1);
			assert.equal(s.state().calls.filter((c: string[]) => c.includes("info")).length, 1);
		} finally {
			s.close();
		}
	});
}

for (const args of [
	["--pr", "0"],
	["--pr", "9007199254740992"],
	["--pr", "25", "3"],
	["--pr", "25", "--pr", "26"],
	["--pr", "25", "--attention", "A-1"],
	["--pr", "25", "--unknown"],
])
	test(`T18-7: 不正引数 ${args.join(" ")} は終了2`, async () => {
		const s = fixture();
		try {
			assert.equal((await s.call("harness-merge", args)).code, 2);
			assert.equal(s.state().calls.length, 0);
		} finally {
			s.close();
		}
	});

for (const scenario of [
	"pending-page",
	"empty",
	"neutral",
	"head-moved",
	"unavailable",
	"summary-duplicate",
	"third-party",
	"wrong-login",
	"labels",
])
	test(`T18-1/2/3: ${scenario} は承認・マージの証拠にしない`, async () => {
		const s = fixture();
		try {
			if (["pending-page", "empty", "neutral"].includes(scenario)) {
				s.change((v) => {
					if (scenario === "pending-page")
						v.checkPages = [v.checks, [{ __typename: "StatusContext", state: "PENDING" }]];
					else
						v.checks =
							scenario === "empty" ? [] : [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" }];
				});
				assert.notEqual((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
				assert.equal(s.state().comments[25], undefined);
				return;
			}
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			s.answer();
			if (scenario === "head-moved")
				s.change((v) => {
					v.prs[0].head.sha = "b".repeat(40);
				});
			if (scenario === "unavailable") writeFileSync(path.join(s.dir, "attention.json"), "{");
			if (scenario === "summary-duplicate") {
				const af = path.join(s.dir, "attention.json"),
					items = JSON.parse(readFileSync(af, "utf8"));
				items[0].summary += `\n承認対象 head: ${head}`;
				writeFileSync(af, JSON.stringify(items));
			}
			if (scenario === "third-party")
				s.change((v) => {
					v.comments[25].push({ ...v.comments[25][0], id: 100, user: { login: "owner" }, body: "OK" });
				});
			if (scenario === "wrong-login")
				s.change((v) => {
					v.comments[25][0].user.login = "previous-worker";
				});
			if (scenario === "labels")
				s.change((v) => {
					v.prs[0].labels = [{ name: "harness:merge-ok" }];
				});
			const expected = scenario === "third-party" ? 0 : 1;
			const result = await s.call("harness-merge", ["--pr", "25"]);
			assert.equal(result.code, expected, result.stderr);
			assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, expected ? 0 : 1);
		} finally {
			s.close();
		}
	});

for (const fail of [false, true])
	test(`T18-4: hookは承認headの私有worktree・空Issueで実行し、成功=${!fail}でも回収`, async () => {
		const s = fixture();
		try {
			const config = JSON.parse(readFileSync(s.env.HARNESS_CONFIG ?? "", "utf8"));
			config.hooks.beforeMerge = [
				'printf "%s\\n" "$HARNESS_ISSUE|$HARNESS_PR|$HARNESS_MAIN|$HARNESS_WORKTREE|$PWD" > "$HARNESS_MAIN/hook-result"',
				...(fail ? ["false", 'touch "$HARNESS_MAIN/never"'] : []),
			];
			writeFileSync(s.env.HARNESS_CONFIG ?? "", JSON.stringify(config));
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			s.answer();
			const result = await s.call("harness-merge", ["--pr", "25"]);
			assert.equal(result.code, fail ? 1 : 0, result.stderr);
			const fields = readFileSync(path.join(s.dir, "hook-result"), "utf8").trim().split("|");
			assert.deepEqual(fields.slice(0, 3), ["", "25", s.dir]);
			assert.equal(fields[3], fields[4]);
			assert.equal(existsSync(fields[3] ?? ""), false);
			assert.equal(s.state().worktree, undefined);
			assert.equal(s.state().tempRef, undefined);
			assert.equal(existsSync(path.join(s.dir, "never")), false);
			assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, fail ? 0 : 1);
		} finally {
			s.close();
		}
	});

test("T18-3/4: Aの引用は原文完全一致、GitHubだけのOKではApproveしない", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.reviewDecision = "REVIEW_REQUIRED";
			v.mergeStateStatus = "BLOCKED";
		});
		assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
		s.change((v) => {
			v.comments[25].push({ ...v.comments[25][0], id: 100, body: "OK", user: { login: "owner" } });
		});
		assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
		assert.equal(s.state().reviews[25], undefined);
		s.answer('owner が Discord で回答。OK\n"引用"');
		assert.equal(
			(await s.call("harness-merge", ["--pr", "25", "--chat-approval", "OK", "--attention", "A-1"])).code,
			1,
		);
		assert.equal(s.state().reviews[25], undefined);
		const result = await s.call("harness-merge", [
			"--pr",
			"25",
			"--chat-approval",
			'owner が Discord で回答。OK\n"引用"',
			"--attention",
			"A-1",
		]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(s.state().reviews[25][0].commit_id, head);
		assert.match(s.state().reviews[25][0].body, /A-1/);
	} finally {
		s.close();
	}
});

for (const failure of ["queue", "merge", "delete", "done", "ref-moved", "review"])
	test(`T18-4/6: ${failure} の再起動はマージ/Approveを再送しない`, async () => {
		const s = fixture();
		try {
			if (failure === "review")
				s.change((v) => {
					v.reviewDecision = "REVIEW_REQUIRED";
					v.mergeStateStatus = "BLOCKED";
				});
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			s.answer();
			s.change((v) => {
				if (failure === "queue") v.queue = true;
				else if (failure === "ref-moved") v.refSha = "b".repeat(40);
				else v.fail = failure;
			});
			const first = await s.call("harness-merge", ["--pr", "25"]);
			assert.equal(first.code, ["queue", "review"].includes(failure) ? 0 : 1, first.stderr);
			for (let tick = 0; tick < 3; tick++) await s.call("harness-merge", ["--pr", "25"]);
			assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, 1);
			if (failure === "queue" || failure === "merge") assert.equal(s.state().deleted, undefined);
			if (failure === "queue") {
				s.change((v) => {
					v.prs[0].merged = true;
					v.prs[0].merged_at = at;
					v.prs[0].state = "closed";
				});
				assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 0);
				assert.equal(s.state().deleted, true);
			}
			if (failure === "delete") {
				s.change((v) => {
					delete v.fail;
				});
				assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 0);
				assert.equal(s.state().deleted, true);
			}
			if (failure === "review") assert.equal(s.state().reviews[25].length, 1);
		} finally {
			s.close();
		}
	});

test("T18-5: 非OKとowner NGの明示retryは指定PRの新Aだけ、旧OKを転用しない", async () => {
	for (const githubNg of [false, true]) {
		const s = fixture();
		try {
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			if (githubNg)
				s.change((v) => {
					v.comments[25].push({ ...v.comments[25][0], id: 100, user: { login: "owner" }, body: "NG" });
				});
			else s.answer("NG");
			await s.call("harness-pr", ["inbox"]);
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25", "--retry"])).code, 0);
			assert.match(s.state().comments[25].at(-1).body, /attention=A-2/);
			assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
			s.answer();
			const result = await s.call("harness-merge", ["--pr", "25"]);
			assert.equal(result.code, 0, result.stderr);
		} finally {
			s.close();
		}
	}
});

test("T18-4: Approve直後のhead変更はstale reviewを残し、新Aの前にマージしない", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.reviewDecision = "REVIEW_REQUIRED";
			v.mergeStateStatus = "BLOCKED";
		});
		assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
		s.answer();
		s.change((v) => {
			v.afterReview = "head-after";
		});
		assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
		assert.equal(s.state().reviews[25][0].commit_id, head);
		assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, 0);
		const request = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(request.code, 0, request.stderr);
		assert.match(s.state().comments[25].at(-1).body, /attention=A-2/);
		assert.equal((await s.call("harness-merge", ["--pr", "25"])).code, 1);
		assert.doesNotMatch(JSON.stringify(s.state().calls), /dismiss/);
	} finally {
		s.close();
	}
});

test("T18-1/6: scanは台帳を変更せずPR本文を出さず、外部closedとmergedを区別して一度整理する", async () => {
	for (const merged of [false, true]) {
		const s = fixture();
		try {
			assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
			const af = path.join(s.dir, "attention.json"),
				before = readFileSync(af, "utf8");
			const scan = await s.call("harness-pr", ["scan"]);
			assert.equal(scan.code, 0, scan.stderr);
			assert.doesNotMatch(scan.stdout, /UNTRUSTED_PR_BODY/);
			assert.equal(readFileSync(af, "utf8"), before);
			s.change((v) => {
				v.prs[0].state = "closed";
				v.prs[0].merged = merged;
				v.prs[0].merged_at = merged ? at : null;
			});
			for (let tick = 0; tick < 3; tick++) await s.call("harness-pr", ["inbox"]);
			const phases = s.state().calls.filter((c: string[]) => c[0] === "dle" && c.includes("phase"));
			assert.equal(phases.length, 1);
			assert.ok(phases[0].includes(merged ? "done" : "blocked"));
			assert.equal(JSON.parse(readFileSync(af, "utf8"))[0].status, "resolved");
		} finally {
			s.close();
		}
	}
});

// T77 用: GraphQL の1ページ分（--slurp 後の配列の要素）を組み立てる。既定はスタブの通常出力と同じ。
function graphqlPage(o: Record<string, unknown> = {}) {
	const v = {
		oid: head,
		rollup: "default",
		nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
		hasNextPage: false,
		mergeStateStatus: "CLEAN",
		reviewDecision: null,
		...o,
	} as Record<string, unknown>;
	const statusCheckRollup =
		v.rollup === "default"
			? { contexts: { nodes: v.nodes, pageInfo: { hasNextPage: v.hasNextPage, endCursor: null } } }
			: v.rollup;
	const commit: Record<string, unknown> = { oid: v.oid };
	if (v.rollup !== "absent") commit.statusCheckRollup = statusCheckRollup;
	const page: Record<string, unknown> = {
		data: {
			repository: {
				pullRequest: {
					reviewDecision: v.reviewDecision,
					mergeStateStatus: v.mergeStateStatus,
					mergeQueueEntry: null,
					commits: v.commitNodes ?? { nodes: [{ commit }] },
				},
			},
		},
	};
	if (v.errors) page.errors = v.errors;
	return page;
}

const t77Cases: {
	name: string;
	page: Record<string, unknown>;
	total?: number;
	lead: string;
	problem: string;
	final: string;
}[] = [
	{
		name: "errors",
		page: graphqlPage({ errors: [{ message: "secret https://x token" }] }),
		lead: "CI 応答が不正です",
		problem: "GraphQL errors あり",
		final: "harness-pr: CI 応答が不正です（PR #25 1/1 ページ: GraphQL errors あり）",
	},
	{
		name: "commits",
		page: graphqlPage({ commitNodes: { nodes: [] } }),
		lead: "CI 応答が不正です",
		problem: "commits.nodes が1件でない",
		final: "harness-pr: CI 応答が不正です（PR #25 1/1 ページ: commits.nodes が1件でない）",
	},
	{
		name: "head",
		page: graphqlPage({ oid: "b".repeat(40) }),
		lead: "CI 全件/head が未確認です",
		problem: "head 不一致",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: head 不一致）",
	},
	{
		name: "rollup-absent",
		page: graphqlPage({ rollup: "absent" }),
		lead: "CI 全件/head が未確認です",
		problem: "statusCheckRollup が不正",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: statusCheckRollup が不正）",
	},
	{
		name: "rollup-mid-null",
		page: graphqlPage({ rollup: null }),
		total: 2,
		lead: "CI 全件/head が未確認です",
		problem: "statusCheckRollup が途中で null",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/2 ページ: statusCheckRollup が途中で null）",
	},
	{
		name: "nodes",
		page: graphqlPage({ nodes: "x" }),
		lead: "CI 全件/head が未確認です",
		problem: "contexts.nodes が配列でない",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: contexts.nodes が配列でない）",
	},
	{
		name: "paging",
		page: graphqlPage({ hasNextPage: true }),
		lead: "CI 全件/head が未確認です",
		problem: "ページ分割の不一致 hasNextPage=true 期待=false",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: ページ分割の不一致 hasNextPage=true 期待=false）",
	},
	{
		name: "merge-state",
		page: graphqlPage({ mergeStateStatus: 1 }),
		lead: "CI 全件/head が未確認です",
		problem: "mergeStateStatus の型 number",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: mergeStateStatus の型 number）",
	},
	{
		name: "review",
		page: graphqlPage({ reviewDecision: 1 }),
		lead: "CI 全件/head が未確認です",
		problem: "reviewDecision の型 number",
		final: "harness-pr: CI 全件/head が未確認です（PR #25 1/1 ページ: reviewDecision の型 number）",
	},
];

test("T77-1: readCiPage は条件ごとに別の理由を返し、null の rollup は CI 0 件として読む", () => {
	for (const c of t77Cases)
		assert.deepEqual(readCiPage(c.page, 0, c.total ?? 1, head), { lead: c.lead, problem: c.problem }, c.name);
	assert.equal(new Set(t77Cases.map((c) => c.problem)).size, t77Cases.length);
	assert.deepEqual(readCiPage(graphqlPage(), 0, 1, head), {
		nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
	});
	assert.deepEqual(readCiPage(graphqlPage({ rollup: null }), 0, 1, head), { nodes: [] });
});

for (const c of t77Cases)
	test(`T77-2: request の失敗は条件を1行で出す: ${c.name}`, async () => {
		const s = fixture();
		try {
			s.change((v) => {
				v.graphqlByPr = { 25: c.total === 2 ? [c.page, graphqlPage()] : [c.page] };
			});
			const r = await s.call("harness-pr", ["request", "--pr", "25"]);
			assert.equal(r.code, 1);
			assert.equal(r.stderr.trim().split("\n").length, 1);
			assert.equal(r.stderr.replace(/\n$/, ""), c.final);
			for (const bad of ["UNTRUSTED_PR_BODY", "https://", "token"]) assert.ok(!r.stderr.includes(bad));
			assert.equal(s.state().comments[25], undefined);
		} finally {
			s.close();
		}
	});

test("T77-2: 2ページ目の hasNextPage 不一致は 1/2 ページとして出す", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.graphqlByPr = { 25: [graphqlPage({ hasNextPage: false }), graphqlPage()] };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(
			r.stderr.trim(),
			"harness-pr: CI 全件/head が未確認です（PR #25 1/2 ページ: ページ分割の不一致 hasNextPage=false 期待=true）",
		);
	} finally {
		s.close();
	}
});

test("T77-2: 追跡中の別 PR で落ちたときは、その PR 番号を指す", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.prs.unshift(pr(24));
			v.graphqlByPr = { 24: [graphqlPage({ oid: "b".repeat(40) })] };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(r.code, 1);
		assert.equal(r.stderr.trim(), "harness-pr: CI 全件/head が未確認です（PR #24 1/1 ページ: head 不一致）");
	} finally {
		s.close();
	}
});

function dirty(v: { prs: ReturnType<typeof pr>[] }, n: number) {
	const p = v.prs.find((x) => x.number === n);
	if (p) Object.assign(p, { mergeable: false, mergeable_state: "dirty" });
}
const nullRollup = (extra: Record<string, unknown> = {}) => [graphqlPage({ rollup: null, ...extra })];

test("T77-3a: 古い PR 24 が CI 未登録でも、green の PR 25 の依頼は出る", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.prs.unshift(pr(24));
			v.graphqlByPr = { 24: nullRollup() };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(s.state().comments[25].length, 1);
	} finally {
		s.close();
	}
});

test("T77-3b: 古い PR 24 が CI 未登録で dirty なら、PR 25 は先行候補で止まり、どちらにも書かない", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.prs.unshift(pr(24));
			dirty(v, 24);
			v.graphqlByPr = { 24: nullRollup({ mergeStateStatus: "DIRTY" }) };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(r.code, 1);
		assert.equal(r.stderr.trim(), "harness-pr: より古い適格候補があります。指定 PR には発行していません");
		assert.equal(s.state().comments[24], undefined);
		assert.equal(s.state().comments[25], undefined);
	} finally {
		s.close();
	}
});

test("T77-3c: 指定 PR 自身が CI 未登録で clean なら依頼しない", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.graphqlByPr = { 25: nullRollup() };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(r.code, 1);
		assert.equal(r.stderr.trim(), "harness-pr: CI/追従/保護状態が依頼条件を満たしません");
		assert.equal(s.state().comments[25], undefined);
	} finally {
		s.close();
	}
});

test("T77-3d: scan は CI 未登録の PR を incomplete にせず ci=waiting で出す", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.graphqlByPr = { 25: nullRollup() };
		});
		const r = await s.call("harness-pr", ["scan"]);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!r.stdout.includes("incomplete"), r.stdout);
		assert.ok(r.stdout.includes('"ci":"waiting"'), r.stdout);
	} finally {
		s.close();
	}
});

test("T77-3e: statusCheckRollup のキーが無いページは失敗のまま", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			v.graphqlByPr = { 25: [graphqlPage({ rollup: "absent" })] };
		});
		const r = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("statusCheckRollup が不正"));
	} finally {
		s.close();
	}
});

test("T77-3f: 指定 PR が CI 未登録で dirty なら rebase 依頼を1件だけ書き、A は出さない", async () => {
	const s = fixture();
	try {
		s.change((v) => {
			dirty(v, 25);
			v.graphqlByPr = { 25: nullRollup({ mergeStateStatus: "DIRTY" }) };
		});
		const first = await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(first.code, 0, first.stderr);
		assert.equal(s.state().comments[25].length, 1);
		assert.equal(s.state().comments[25][0].body, `@dependabot rebase\n\n<!-- harness:rebase sha=${head} -->`);
		for (let i = 0; i < 3; i++) await s.call("harness-pr", ["request", "--pr", "25"]);
		assert.equal(s.state().comments[25].length, 1);
		assert.ok(!s.state().comments[25].some((c: { body: string }) => c.body.includes("attention=")));
		assert.equal(readFileSync(path.join(s.dir, "attention.json"), "utf8"), "[]");
		const retry = await s.call("harness-pr", ["request", "--pr", "25", "--retry"]);
		assert.equal(retry.code, 1);
		assert.equal(
			retry.stderr.trim(),
			"harness-pr: rebase 待ちのため新 A を発行していません。head/CI の更新後に再依頼してください",
		);
		assert.equal(s.state().comments[25].length, 1);
	} finally {
		s.close();
	}
});

test("T77-4: OK の後に CI 未登録の応答になったらマージしない", async () => {
	const s = fixture();
	try {
		assert.equal((await s.call("harness-pr", ["request", "--pr", "25"])).code, 0);
		s.answer();
		s.change((v) => {
			v.graphqlByPr = { 25: nullRollup() };
		});
		const r = await s.call("harness-merge", ["--pr", "25"]);
		assert.equal(r.code, 1);
		assert.equal(r.stderr.trim(), "harness-pr: CI/保護状態がマージ条件を満たしません");
		assert.equal(s.state().calls.filter((c: string[]) => c[2] === "merge").length, 0);
	} finally {
		s.close();
	}
});
