import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { loadConfig } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { type Attention, Ledger } from "../src/ledger.ts";
import type { Run } from "../src/projects.ts";
import { Rest } from "../src/rest.ts";
import { Supervisor } from "../src/supervisor.ts";
import { classifyWork, readWork, type WakeLocal, type WakePr, WorkClock } from "../src/work-wake.ts";

const minute = 60_000;
const start = Date.parse("2026-11-24T00:00:00Z");
const head = "a".repeat(40);
const updatedAt = new Date(start - 31 * minute).toISOString();

function page(key: string, nodes: unknown[], totalCount = nodes.length, cursor: string | null = null) {
	return {
		data: {
			viewer: { login: "Owner" },
			repository: {
				nameWithOwner: "example/repo",
				[key]: {
					totalCount,
					pageInfo: { hasNextPage: cursor !== null, endCursor: cursor ?? (nodes.length ? "last" : null) },
					nodes,
				},
			},
		},
	};
}

function issue(number: number, ...labels: string[]) {
	return { number, updatedAt, labels: { nodes: labels.map((name) => ({ name })), pageInfo: { hasNextPage: false } } };
}

const empty: WakeLocal = { tasks: [], attention: [], outbox: [], failures: [] };
const bot: WakePr = {
	number: 4,
	ownership: "dependabot",
	draft: true,
	head,
	mergeable: "MERGEABLE",
	reviewDecision: null,
	createdAt: updatedAt,
	updatedAt,
	ci: { kind: "empty" },
};

function botGate(): Attention {
	return {
		id: "A-1",
		project: "repo",
		kind: "merge",
		pr: "4",
		issue: "",
		taskId: "",
		status: "open",
		summary: `承認対象 head: ${head}`,
		createdAt: updatedAt,
		url: "",
		title: "",
	};
}

function rawPr(options: { number?: number; author?: string; type?: string; ref?: string; draft?: boolean } = {}) {
	return {
		number: options.number ?? 4,
		createdAt: updatedAt,
		updatedAt,
		isDraft: options.draft ?? true,
		mergeable: "MERGEABLE",
		author: { __typename: options.type ?? "Bot", login: options.author ?? "dependabot" },
		headRefName: options.ref ?? "dependabot/npm/dependency",
		headRefOid: head,
		reviewDecision: null,
		commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: "SUCCESS" } } }] },
	};
}

function ciPage(nodes: unknown[] | null) {
	const contexts = {
		totalCount: nodes?.length ?? 0,
		nodes: nodes?.map((node, i) => ({ ...(node as object), id: `check-${i}` })),
		pageInfo: { hasNextPage: false, endCursor: nodes?.length ? "last" : null },
	};
	return {
		data: {
			repository: {
				nameWithOwner: "example/repo",
				pullRequest: {
					headRefOid: head,
					updatedAt,
					reviewDecision: null,
					mergeStateStatus: "CLEAN",
					commits: { nodes: [{ commit: { oid: head, statusCheckRollup: nodes === null ? null : { contexts } } }] },
				},
			},
		},
	};
}

function json(value: unknown) {
	return { ok: true, stdout: JSON.stringify(value), stderr: "" };
}

test("仕事判定は読み取り専用 gh で全ページを取得し任意の harness prefix を拾う", async () => {
	const exec: Run = async (cmd, args, options) => {
		assert.equal(cmd, "gh");
		assert.deepEqual(args.slice(0, 4), ["api", "graphql", "--paginate", "--slurp"]);
		assert.equal(options?.maxBuffer, 2 * 1024 * 1024);
		assert.equal(options?.timeoutMs, 10_000);
		const first = Array.from({ length: 50 }, (_, i) => issue(i + 1, "x-harness:queued"));
		const output = args.some((arg) => arg.includes("issues("))
			? [page("issues", first, 51, "next"), page("issues", [issue(51, "harness:future")], 51)]
			: [page("pullRequests", [])];
		return { ok: true, stdout: JSON.stringify(output), stderr: "" };
	};
	const remote = await readWork("example/repo", exec, new AbortController().signal, () => start);
	assert.equal(remote.issues?.length, 51);
	assert.deepEqual(classifyWork("repo", remote, empty, start).reasons, ["issue"]);
});

test("片系の取得破損は独立した queued の取得を保持して fail-open にする", async () => {
	const exec: Run = async (_cmd, args) => ({
		ok: true,
		stdout: JSON.stringify(
			args.some((arg) => arg.includes("issues("))
				? [page("issues", [issue(1, "harness:queued")])]
				: [{ ...page("pullRequests", []), errors: [{ message: "fixture private data" }] }],
		),
		stderr: "",
	});
	const remote = await readWork("example/repo", exec, new AbortController().signal, () => start);
	assert.equal(remote.issues?.[0]?.number, 1);
	const result = classifyWork("repo", remote, empty, start);
	assert.deepEqual(result.reasons, ["issue", "fetch-failed"]);
	assert.deepEqual(result.failures, [{ source: "prs", code: "invalid" }]);
});

test("Dependabot の空 CI は 30 分の直後かつ現 head の回答待ちを確認して初めて監視になる", () => {
	const local: WakeLocal = { ...empty, attention: [botGate()] };
	for (const draft of [true, false]) {
		for (const delta of [-1, 0, 1]) {
			const at = new Date(start - 30 * minute - delta).toISOString();
			const remote = { issues: [], prs: [{ ...bot, draft, updatedAt: at }], failures: [] };
			const result = classifyWork("repo", remote, local, start);
			assert.equal(result.human, delta > 0);
			assert.deepEqual(result.reasons, ["pr-dependabot"]);
			assert.equal(classifyWork("repo", remote, empty, start).human, false);
		}
	}
	const unknown = { ...bot, number: 5, ci: { kind: "complete", green: true } } satisfies WakePr;
	assert.equal(classifyWork("repo", { issues: [], prs: [bot, unknown], failures: [] }, local, start).human, false);
});

test("監視のみは 60 分で送信し、無変化 2 時間後は最後の成功から 120 分で送信する", () => {
	for (let trial = 0; trial < 3; trial++) {
		const clock = new WorkClock();
		clock.sent(0);
		for (let elapsed = 0; elapsed <= 180 * minute; elapsed += minute) {
			const cadence = clock.observe(elapsed, "same");
			if (elapsed === 60 * minute || elapsed === 180 * minute) {
				assert.equal(clock.due(elapsed, cadence), true);
				clock.sent(elapsed);
			} else assert.equal(clock.due(elapsed, cadence), false);
			assert.equal(cadence, elapsed < 120 * minute ? "human-60m" : "human-120m");
		}
		assert.equal(clock.observe(181 * minute, null), "active-15m");
		assert.equal(clock.observe(182 * minute, "same"), "human-60m");
	}
});

test("open PR の所有者・draft・同名ブランチと現 head の CI を照合する", async () => {
	const all = [
		rawPr({ number: 1, type: "User", author: "OWNER", ref: "topic" }),
		rawPr({ number: 2, type: "User", author: "OWNER", ref: "topic", draft: false }),
		rawPr({ number: 3, type: "User", author: "someone" }),
		rawPr({ number: 4, draft: false }),
		rawPr({ number: 5, ref: "dependabot/" }),
		rawPr({ number: 6 }),
	];
	const options: Run = async (_cmd, args) => {
		if (args.some((a) => a.includes("issues("))) return json([page("issues", [])]);
		if (args.some((a) => a.includes("pullRequests("))) return json([page("pullRequests", all)]);
		assert.ok(args.includes("number=4") || args.includes("number=6"));
		return json([
			ciPage([
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
				{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
			]),
		]);
	};
	const remote = await readWork("example/repo", options, new AbortController().signal, () => start);
	assert.deepEqual(
		remote.prs?.map((p) => p.ownership),
		["own", "own", "other", "dependabot", "other", "dependabot"],
	);
	assert.deepEqual(remote.prs?.[3]?.ci, { kind: "running" });
	assert.deepEqual(classifyWork("repo", remote, empty, start).reasons, ["pr-own", "pr-dependabot"]);
});

test("latest A と回答後 UTC の同一作者の Issue marker を照合し、outbox は残す", async () => {
	const home = mkdtempSync(path.join(process.env.DLE_HOME ?? "/tmp", "answers-"));
	try {
		const ledger = new Ledger(home, () => new Date(start));
		const fields = {
			project: "repo",
			kind: "interview" as const,
			pr: "",
			issue: "1",
			taskId: "",
			summary: "",
			url: "",
			title: "",
		};
		const { attention: older } = ledger.addAttention(fields);
		ledger.resolveAttention(older.id, "古い回答");
		const { attention: latest } = ledger.addAttention(fields);
		ledger.resolveAttention(latest.id, "今回の回答");
		let author = "Someone";
		let commentAt = new Date(start + 1).toISOString();
		let reads = 0;
		const exec: Run = async (cmd, args) => {
			assert.equal(cmd, "gh");
			if (args.some((a) => a.includes("issues("))) return json([page("issues", [issue(1, "harness:interview")])]);
			if (args.some((a) => a.includes("pullRequests("))) return json([page("pullRequests", [])]);
			assert.deepEqual(args, [
				"api",
				"--method",
				"GET",
				"--paginate",
				"--slurp",
				"repos/example/repo/issues/1/comments?per_page=100",
			]);
			reads++;
			return json([
				[
					{
						id: 123,
						user: { login: author },
						body: "要件\n<!-- harness:note source=discord -->",
						created_at: commentAt,
					},
				],
			]);
		};
		const local = () => ledger.wakeLocal("repo");
		const reasons = async () =>
			classifyWork(
				"repo",
				await readWork("example/repo", exec, new AbortController().signal, () => start + minute, {
					project: "repo",
					read: local,
				}),
				local(),
				start + minute,
			).reasons;
		assert.deepEqual(await reasons(), ["issue", "answer"]);
		author = "owner";
		commentAt = new Date(start).toISOString();
		assert.deepEqual(await reasons(), ["issue", "answer"]);
		commentAt = new Date(start + 1).toISOString();
		assert.deepEqual(await reasons(), ["issue"]);
		ledger.enqueue("repo", {
			content: "古い",
			meta: { attention: older.id, kind: "interview", issue: "1", pr: "", task: "" },
		});
		assert.deepEqual(await reasons(), ["issue"]);
		ledger.enqueue("repo", {
			content: "私有本文",
			meta: { attention: latest.id, kind: "interview", issue: "1", pr: "", task: "" },
		});
		const file = path.join(home, "outbox/repo.jsonl");
		const original = readFileSync(file, "utf8");
		assert.deepEqual(await reasons(), ["issue", "answer"]);
		assert.equal(reads, 4);
		assert.equal(readFileSync(file, "utf8"), original);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("判定用台帳は壊れた Task・queuedSeen・outbox を空にせず、別 project の旧 Task を許容する", () => {
	const home = mkdtempSync(path.join(process.env.DLE_HOME ?? "/tmp", "wake-ledger-"));
	try {
		const ledger = new Ledger(home);
		assert.deepEqual(ledger.wakeLocal("repo"), empty);
		const task = path.join(home, "tasks/T-0001.md");
		writeFileSync(task, "---\nid: T-0001\nproject: repo\nstatus: ai-working\n---\n");
		assert.deepEqual(
			ledger.wakeLocal("repo").tasks.map((t) => t.status),
			["ai-working"],
		);
		writeFileSync(task, "---\nid: T-0001\nproject: repo\nstatus: corrupt\n---\n");
		assert.deepEqual(ledger.wakeLocal("repo").failures, [{ source: "tasks", code: "invalid" }]);
		assert.deepEqual(ledger.wakeLocal("another").failures, []);
		const state = path.join(home, "state.json");
		const corrupt = '{"queuedSeen":{"repo":[1]}}';
		writeFileSync(state, corrupt);
		assert.throws(() => ledger.wakeQueued("repo", ["2"]));
		assert.equal(readFileSync(state, "utf8"), corrupt);
		writeFileSync(path.join(home, "outbox/repo.jsonl"), "{broken");
		assert.deepEqual(
			ledger.wakeLocal("repo").failures.map((f) => f.source),
			["tasks", "outbox"],
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("旧登録・state の省略と空の値を従来の初期値として読む", () => {
	const home = mkdtempSync(path.join(process.env.DLE_HOME ?? "/tmp", "wake-ledger-"));
	try {
		const ledger = new Ledger(home);
		const projects = path.join(home, "projects.json");
		const project = { name: "repo", path: home, repo: "example/repo", active: true };
		writeFileSync(projects, JSON.stringify([project, { ...project, name: "old", mode: null }]));
		assert.deepEqual(ledger.wakeProjects(), ledger.projects());
		const state = path.join(home, "state.json");
		for (const queuedSeen of [undefined, null, { repo: null, other: ["3"] }]) {
			writeFileSync(state, JSON.stringify({ taskSeq: 0, boardMessageId: null, queuedSeen }));
			assert.deepEqual(ledger.wakeQueued("repo", ["1"]), []);
			assert.deepEqual(ledger.wakeQueued("repo", ["1", "2"]), ["2"]);
			assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {
				taskSeq: 0,
				boardMessageId: null,
				queuedSeen: { ...queuedSeen, repo: ["1", "2"] },
			});
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("旧 Attention と outbox の空の参照を照合し、実在する参照の欠落は一致させない", () => {
	const home = mkdtempSync(path.join(process.env.DLE_HOME ?? "/tmp", "wake-ledger-"));
	try {
		const ledger = new Ledger(home);
		const attention = path.join(home, "attention.json");
		const outbox = path.join(home, "outbox/repo.jsonl");
		const gate = {
			...botGate(),
			kind: "setup",
			issue: "0",
			pr: undefined,
			taskId: undefined,
			status: "resolved",
			answer: "回答",
			resolvedAt: updatedAt,
			messageId: "old-message",
		};
		const original = `${JSON.stringify({ content: "A-1 の回答", meta: { attention: "A-1", kind: "setup", pr: "0" } })}\n`;
		writeFileSync(outbox, original);
		const read = () => {
			const local = ledger.wakeLocal("repo");
			return classifyWork("repo", { issues: [], prs: [], failures: [] }, local, start);
		};
		writeFileSync(attention, JSON.stringify([gate]));
		assert.deepEqual(read().reasons, ["answer"]);
		writeFileSync(attention, JSON.stringify([{ ...gate, issue: "1" }]));
		assert.deepEqual(read().reasons, []);
		assert.equal(readFileSync(outbox, "utf8"), original);
		writeFileSync(attention, JSON.stringify([{ ...gate, issue: "-1" }]));
		assert.deepEqual(read().failures, [{ source: "attention", code: "invalid" }]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

function taskMarkdown(status: string, issue: string, pr: string) {
	return `---
id: T-0001
project: repo
issue: ${issue}
pr: ${pr}
title: 旧タスク
status: ${status}
phase:
waiting:
created: ${updatedAt}
updated: ${updatedAt}
---
## 次にやること
-

## 経緯
- 完了を記録
`;
}

function engineFixture(exec: Run, spawnInitial = false) {
	const home = mkdtempSync(path.join(process.env.DLE_HOME ?? "/tmp", "wake-engine-"));
	const messages: string[] = [];
	const keys: string[] = [];
	let now = 0;
	let pane = "会話の履歴\n❯ ";
	let workerWindow = !spawnInitial;
	let engine: Engine;
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
	mkdirSync(path.join(home, ".claude"));
	writeFileSync(path.join(home, ".claude", "harness.json"), "{}");
	const supervisor = new Supervisor({
		tmuxSession: "dle",
		isLive: (name) => workerWindow && name === "repo",
		targets: () => engine.targets(),
		tmux: async (args) => {
			if (args[0] === "list-windows") return { ok: true, stdout: workerWindow ? "dle-repo" : "" };
			if (args[0] === "new-window" && args.includes("dle-repo")) workerWindow = true;
			if (args[0] === "display-message") return { ok: true, stdout: "1" };
			if (args[0] === "capture-pane") return { ok: true, stdout: pane };
			if (args[0] === "send-keys") keys.push(args.slice(3).join(" "));
			return { ok: true, stdout: "" };
		},
		now: () => start + now,
		wait: () => Promise.resolve(),
		readSession: () => Promise.resolve({ sessionId: "fixture", cwd: home, status: "idle", updatedAt: 0 }),
		readTranscript: () => Promise.resolve({ tokens: 10, mtimeMs: 0, subagentMtimeMs: 0 }),
		notify: () => {},
		promptDelayMs: 0,
	});
	engine = new Engine({
		config: loadConfig(home),
		supervisor,
		exec,
		wakeNow: () => now,
		wakeWall: () => start + now,
		log: (m) => messages.push(m),
		rest: new Rest({ token: "fixture" }),
		gatewayFactory: () => ({ start() {}, stop() {}, connected: false, user: null }),
	});
	engine.ledger.upsertProject({ name: "repo", repo: "example/repo", mode: "harness", active: true, path: home });
	const poll = async (elapsed: number) => {
		now = elapsed;
		await engine.queueTick();
		await settle();
	};
	const parseRows = (prefix: string) =>
		messages.filter((m) => m.startsWith(prefix)).map((m) => JSON.parse(m.slice(prefix.length)));
	return {
		engine,
		supervisor,
		home,
		keys,
		messages,
		poll,
		setPane: (value: string) => {
			pane = value;
		},
		decisions: () => parseRows("engine: work-wake "),
		sends: () => parseRows("engine: wake-sent "),
		stop: async () => {
			await engine.stop();
			rmSync(home, { recursive: true, force: true });
		},
	};
}

test("issue: 0 の旧 Task は完了なら起こさず、進行中なら GitHub 番号なしの仕事にする", async () => {
	const h = engineFixture((cmd, args) => {
		assert.equal(cmd, "gh");
		const collection = args.some((a) => a.includes("issues(")) ? "issues" : "pullRequests";
		assert.ok(args.some((a) => a.includes(`${collection}(`)));
		assert.ok(!args.includes("number=0"));
		return Promise.resolve(json([page(collection, [])]));
	});
	try {
		const task = path.join(h.home, "tasks/T-0001.md");
		for (const [i, pr] of ["", "0"].entries()) {
			const markdown = taskMarkdown("done", "0", pr);
			writeFileSync(task, markdown);
			await h.poll(i * minute);
			const row = h.decisions().at(-1);
			assert.equal(row?.result, "empty");
			assert.equal(row?.cadence, "none");
			assert.equal(row?.fetchFailed, false);
			assert.deepEqual(row?.reasons, []);
			assert.deepEqual(h.keys, []);
			assert.equal(h.engine.ledger.task("T-0001")?.issue, "0");
			assert.equal(readFileSync(task, "utf8"), markdown);
		}
		writeFileSync(task, taskMarkdown("ai-working", "0", "4"));
		await h.poll(2 * minute);
		assert.equal(h.decisions().at(-1)?.result, "empty");
		assert.deepEqual(h.keys, []);
		writeFileSync(task, taskMarkdown("ai-working", "0", "0"));
		await h.poll(3 * minute);
		const row = h.decisions().at(-1);
		assert.equal(row?.result, "sent");
		assert.equal(row?.cadence, "active-15m");
		assert.equal(row?.fetchFailed, false);
		assert.deepEqual(row?.reasons, ["task"]);
		assert.deepEqual(h.keys, ["-l /discord-loop-engine:issue-loop", "Enter"]);
	} finally {
		await h.stop();
	}
});

test("番号が不正または必須項目が欠落した Task は取得失敗の15分にする", async () => {
	const h = engineFixture((_cmd, args) =>
		Promise.resolve(json([page(args.some((a) => a.includes("issues(")) ? "issues" : "pullRequests", [])])),
	);
	try {
		const task = path.join(h.home, "tasks/T-0001.md");
		const corrupt = [
			taskMarkdown("done", "-1", ""),
			taskMarkdown("done", "wrong", ""),
			taskMarkdown("done", "0", "-1"),
			"---\nid: T-0001\nproject: repo\n---\n",
		];
		for (const [i, markdown] of corrupt.entries()) {
			writeFileSync(task, markdown);
			await h.poll(i * 15 * minute);
			const row = h.decisions().at(-1);
			assert.deepEqual(row?.failures, [{ source: "tasks", code: "invalid" }]);
			assert.deepEqual(row?.reasons, ["fetch-failed"]);
			assert.equal(row?.cadence, "active-15m");
			assert.equal(row?.result, "sent");
			assert.equal(readFileSync(task, "utf8"), markdown);
		}
	} finally {
		await h.stop();
	}
});

test("Issue のない Dependabot 監視から t=60・180 だけ実送信し判定 ID を対応付ける", async () => {
	for (const nodes of [[{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], [], null]) {
		for (let trial = 0; trial < 3; trial++) {
			const exec: Run = (_cmd, args) => {
				if (args.some((a) => a.includes("issues("))) return Promise.resolve(json([page("issues", [])]));
				if (args.some((a) => a.includes("pullRequests(")))
					return Promise.resolve(json([page("pullRequests", [rawPr()])]));
				assert.ok(args.includes("number=4"));
				return Promise.resolve(json([ciPage(nodes)]));
			};
			const h = engineFixture(exec, true);
			try {
				writeFileSync(path.join(h.home, "tasks/T-0001.md"), taskMarkdown("done", "0", ""));
				const { id: _id, status: _status, createdAt: _createdAt, ...gate } = botGate();
				h.engine.ledger.addAttention(gate);
				await h.supervisor.tick();
				await h.supervisor.onRegistered("repo");
				assert.equal(h.sends()[0]?.causes[0], "initial");
				for (let elapsed = 0; elapsed <= 180; elapsed++) {
					await h.poll(elapsed * minute);
					assert.equal(h.keys.length, 2 * (1 + Number(elapsed >= 60) + Number(elapsed >= 180)));
					const row = h.decisions().at(-1);
					assert.equal(row?.cadence, elapsed < 120 ? "human-60m" : "human-120m");
					assert.deepEqual(row?.reasons, ["pr-dependabot"]);
					assert.equal(row?.result, [60, 180].includes(elapsed) ? "sent" : "not-due");
					if (row?.result === "sent") {
						const sent = h.sends().at(-1);
						assert.deepEqual(sent?.decisions, [row.id]);
						assert.equal(sent?.sendId, row.sendId);
					}
				}
				assert.equal(h.decisions().length, 181);
				assert.equal(new Set(h.sends().map((row) => row.sendId)).size, 3);
			} finally {
				await h.stop();
			}
		}
	}
});

test("busy で見送った判定は次の票で再試行し、空になった場合だけ周期を失効させる", async () => {
	for (let trial = 0; trial < 3; trial++) {
		let exists = true;
		const h = engineFixture((_cmd, args) =>
			Promise.resolve(
				args.some((a) => a.includes("issues("))
					? json([page("issues", exists ? [issue(1, "harness:priority")] : [])])
					: json([page("pullRequests", [])]),
			),
		);
		try {
			h.setPane("esc to interrupt\n❯ ");
			await h.poll(0);
			assert.deepEqual(h.keys, []);
			assert.equal(h.decisions()[0]?.detail, "busy");
			h.setPane("履歴\n❯ ");
			await h.poll(minute);
			assert.deepEqual(h.keys, ["-l /discord-loop-engine:issue-loop", "Enter"]);
			assert.equal(h.decisions()[1]?.result, "sent");
			await h.poll(16 * minute - 1);
			assert.equal(h.decisions()[2]?.result, "not-due");
			h.setPane("❯ 入力途中");
			await h.poll(16 * minute);
			assert.equal(h.keys.length, 2);
			exists = false;
			h.setPane("履歴\n❯ ");
			await h.poll(17 * minute);
			await h.supervisor.wakeTick();
			assert.equal(h.decisions()[4]?.result, "empty");
			assert.equal(h.keys.length, 2);
			h.supervisor.requestWake("repo", "outbox");
			await h.supervisor.wakeTick();
			assert.equal(h.keys.length, 4);
			assert.deepEqual(h.sends().at(-1)?.causes, ["outbox"]);
			assert.deepEqual(h.sends().at(-1)?.decisions, []);
		} finally {
			await h.stop();
		}
	}
});

test("全ソース空の7日分の周期では send-keys が発生しない", async () => {
	const h = engineFixture((_cmd, args) =>
		Promise.resolve(json([page(args.some((a) => a.includes("issues(")) ? "issues" : "pullRequests", [])])),
	);
	try {
		const observations = 7 * 24 * 60;
		for (let i = 0; i < observations; i++) await h.poll(i * minute);
		const rows = h.decisions();
		assert.equal(rows.length, observations);
		assert.equal(new Set(rows.map((row) => row.id)).size, observations);
		assert.ok(rows.every((row) => row.result === "empty" && row.work === false && row.fetchFailed === false));
		assert.deepEqual(h.keys, []);
		assert.deepEqual(h.sends(), []);
	} finally {
		await h.stop();
	}
});

test("取得失敗の見送りと遅れて成立した送信を判定 ID で照合し入力の原文を出さない", async () => {
	const h = engineFixture((_cmd, args) =>
		Promise.resolve(
			args.some((a) => a.includes("issues("))
				? { ok: false, stdout: "", stderr: "SECRET-PRIVATE-STDERR" }
				: json([page("pullRequests", [])]),
		),
	);
	try {
		h.setPane("❯ SECRET-PRIVATE-INPUT");
		await h.poll(0);
		const row = h.decisions()[0];
		assert.equal(row?.result, "deferred");
		assert.equal(row?.detail, "input");
		assert.equal(row?.work, true);
		assert.equal(row?.fetchFailed, true);
		assert.deepEqual(row?.failures, [{ source: "issues", code: "unavailable" }]);
		assert.deepEqual(h.keys, []);
		h.setPane("会話の履歴\n❯ ");
		await h.supervisor.wakeTick();
		assert.deepEqual(h.sends()[0]?.decisions, [row.id]);
		assert.equal(h.decisions().length, 1);
		assert.ok(h.messages.every((message) => !message.includes("SECRET-PRIVATE")));
	} finally {
		await h.stop();
	}
});

test("台帳回答の PR スコープは open の現 head に一致する間だけ陽性", () => {
	const gate = { ...botGate(), status: "resolved" as const, resolvedAt: new Date(start).toISOString(), answer: "OK" };
	const local = { ...empty, attention: [gate] };
	assert.deepEqual(classifyWork("repo", { issues: [], prs: [bot], failures: [] }, local, start).reasons, [
		"pr-dependabot",
		"answer",
	]);
	assert.deepEqual(
		classifyWork("repo", { issues: [], prs: [{ ...bot, head: "b".repeat(40) }], failures: [] }, local, start).reasons,
		["pr-dependabot"],
	);
	assert.deepEqual(classifyWork("repo", { issues: [], prs: [], failures: [] }, local, start).reasons, []);
	assert.deepEqual(
		classifyWork(
			"repo",
			{ issues: [], prs: [bot], failures: [] },
			{
				...local,
				attention: [gate, { ...botGate(), id: "A-2" }],
			},
			start,
		).reasons,
		["pr-dependabot"],
	);
});
