// harness-phase の遷移直後の強制整理（#61）を、本物の engine・Supervisor・Unix ソケットで通して保証すること:
// - 実際の遷移（from_phase と transition_id が揃い、前回の記録と繋がる）だけが ticket になり、再送・同 phase・不明は見送る
// - 超過は「超えて」（250000 ちょうどは強制しない）。人待ち・Codex・CI 待ち・不明は clear しない
// - checkpoint は handoff の hash と Task.next の expected の一致を確かめ、窓口が書いた指示を上書きしない
// - 停止点が確認できないとき（次の作業・入力・別 session）は clear せず、既存の wake で worker を起こす
// - 強制が無効なら何も読まず何も書かない。窓口は強制しない
// tmux・Claude の内部ファイル・gh は差し替える。実 engine・Discord・実 tmux には触らない。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { classifyCiNodes } from "../src/phase-wait.ts";
import type { Run } from "../src/projects.ts";
import { lineReader, PROTOCOL_VERSION } from "../src/protocol.ts";
import type { RefreshDecision } from "../src/refresh.ts";
import { classifyCodexPanes, Supervisor, WAKE_PROMPT } from "../src/supervisor.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CH = "900";
const ME = "111";
const WORKER = { role: "worker" as const, name: "p1" };
const CLI = { role: "cli" as const, name: "cli" };
const CONCIERGE = { role: "concierge" as const, name: "concierge" };
const HANDOFF = "## loop_meta\n- heartbeat_interval: 15min\n## subscribed_prs\n## ci_retry_count\n## stall\n";

const until = async (cond: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const ciPage = (head: string, nodes: unknown[], hasNext = false) => ({
	data: {
		repository: {
			pullRequest: {
				reviewDecision: null,
				mergeStateStatus: "CLEAN",
				commits: {
					nodes: [
						{ commit: { oid: head, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: hasNext } } } } },
					],
				},
			},
		},
	},
});
const HEAD = "a".repeat(40);
const DONE = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }];

interface Sim {
	status: string;
	sessionId: string;
	tokens: number | null;
	pane: string;
	codex: string;
	boundary: "waiting" | "settled" | "active" | "unknown";
	/** 強制整理の判定のたびに増える（OFF で増えないことの確認用） */
	reads: number;
	sends: string[];
	prs: { number: number; head: string }[];
	ci: Record<number, unknown[]>;
	execCalls: string[];
	/** 1回目の安全確認が走る直前に呼ばれる（競合の再現用） */
	onPoll?: () => void;
	/** subagent の transcript の最終更新（ms）。Agent 内で harness-phase を実行した後の書込みの再現用 */
	subagentMtimeMs: number;
	/** 立てている間、安全確認の待機（wait）が止まる。待機中の cancel・stop の再現用 */
	hold?: Promise<void>;
	/** capture-pane が signal の abort まで返らない（I/O のハング）の再現用 */
	hangCapture: boolean;
}

function setup(
	options: { force?: number; refreshEnabled?: boolean; tokens?: number | null; deadlineMs?: number } = {},
) {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-ph-"));
	const repo = mkdtempSync(path.join(os.tmpdir(), "dle-phr-"));
	mkdirSync(path.join(repo, ".claude"), { recursive: true });
	mkdirSync(path.join(repo, ".harness"), { recursive: true });
	writeFileSync(path.join(repo, ".claude", "harness.json"), "{}");
	writeFileSync(path.join(repo, ".harness", "handoff.md"), HANDOFF);
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: [CH], allowedUserIds: [ME] }));
	const config: Config = {
		home,
		socketPath: path.join(home, "engine.sock"),
		channelIds: [CH],
		defaultChannelId: CH,
		allowedUserIds: [ME],
		permissionRelay: false,
		tmuxSession: "dle-test",
		workspaceDir: path.join(home, "ws"),
		claudeBin: "claude",
		concierge: {
			model: "sonnet",
			extraArgs: [],
			allowedTools: [],
			refresh: { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 },
		},
		worker: {
			model: null,
			extraArgs: [],
			initialPrompt: "/discord-loop-engine:issue-loop",
			refresh: {
				enabled: options.refreshEnabled ?? true,
				maxTokens: 150000,
				...(options.force === undefined ? {} : { forceMaxTokens: options.force }),
				contextPercent: 15,
				idleSeconds: 180,
				cooldownMinutes: 30,
				codexIgnoreAfterMinutes: 120,
			},
		},
		retro: { everyDoneTasks: 5, everyDays: 7, promoteAfter: 3 },
		board: { enabled: true },
	};
	const sim: Sim = {
		status: "busy",
		sessionId: "old",
		tokens: options.tokens === undefined ? 300000 : options.tokens,
		pane: "history\n❯ ",
		codex: "",
		boundary: "settled",
		reads: 0,
		sends: [],
		prs: [],
		ci: {},
		execCalls: [],
		subagentMtimeMs: 0,
		hangCapture: false,
	};
	const decisions: RefreshDecision[] = [];
	const logs: string[] = [];
	const exec: Run = async (cmd, args) => {
		sim.execCalls.push(`${cmd} ${args.join(" ")}`);
		if (args.includes("--slurp") && args.some((a) => a.includes("/pulls?")))
			return {
				ok: true,
				stdout: JSON.stringify([sim.prs.map((p) => ({ number: p.number, head: { sha: p.head } }))]),
				stderr: "",
			};
		if (args.includes("graphql")) {
			const n = Number(args.find((a) => a.startsWith("number="))?.replace("number=", ""));
			const nodes = sim.ci[n];
			const head = sim.prs.find((p) => p.number === n)?.head ?? HEAD;
			return nodes === undefined
				? { ok: false, stdout: "", stderr: "x" }
				: { ok: true, stdout: JSON.stringify([ciPage(head, nodes)]), stderr: "" };
		}
		return { ok: true, stdout: "", stderr: "" };
	};
	let engine: Engine | null = null;
	const supervisor = new Supervisor({
		tmuxSession: "dle-test",
		targets: () => engine?.targets() ?? [],
		isLive: (n) => engine?.sessions.has(n) ?? false,
		notify: () => {},
		activity: (n) => engine?.activity(n) ?? { events: 0, lastAt: 0 },
		onRefresh: (n, phase, result) => engine?.onRefresh(n, phase, result),
		onRefreshDecision: (d) => decisions.push(d),
		tmux: async (args, opts) => {
			sim.reads++;
			if (sim.hangCapture && args[0] === "capture-pane" && opts?.signal) {
				const signal = opts.signal;
				return new Promise((resolve) => {
					const done = () => resolve({ ok: false, stdout: "" });
					if (signal.aborted) done();
					else signal.addEventListener("abort", done, { once: true });
				});
			}
			if (args[0] === "list-windows") return { ok: true, stdout: "dle-p1" };
			if (args[0] === "display-message") return { ok: true, stdout: "4242" };
			if (args[0] === "capture-pane") return { ok: true, stdout: sim.pane };
			if (args[0] === "list-panes") return { ok: true, stdout: sim.codex };
			if (args[0] === "send-keys") {
				sim.sends.push(
					args
						.slice(3)
						.filter((a) => a !== "-l")
						.join(" "),
				);
				if (args.includes("/clear")) sim.sessionId = "new";
			}
			return { ok: true, stdout: "" };
		},
		readSession: async () => ({ sessionId: sim.sessionId, cwd: repo, status: sim.status, updatedAt: 0 }),
		readTranscript: async () => ({ tokens: sim.tokens, mtimeMs: 0, subagentMtimeMs: sim.subagentMtimeMs }),
		readBoundaryActivity: async () => {
			sim.onPoll?.();
			sim.onPoll = undefined;
			return sim.boundary;
		},
		wait: async () => {
			await sim.hold;
		},
		...(options.deadlineMs === undefined ? {} : { phaseDeadlineMs: options.deadlineMs }),
		promptDelayMs: 0,
		clearConfirmMs: 0,
		phasePollMs: 0,
		phaseQuietMs: 0,
		log: (m) => logs.push(m),
	});
	engine = new Engine({
		config,
		rest: {
			channel: async (id: string) => ({ id, guild_id: "800", type: 0 }),
			sendMessage: async () => ({ id: "1", channel_id: CH, attachments: [] }),
			editMessage: async () => ({}),
			pin: async () => ({}),
			react: async () => ({}),
		} as never,
		log: (m) => logs.push(m),
		boardDebounceMs: 10,
		supervisor,
		exec,
		gatewayFactory: () => ({ start() {}, stop() {}, connected: true, user: { id: "999", username: "bot" } }),
	});
	engine.ledger.upsertProject({
		name: "p1",
		repo: "o/r",
		path: repo,
		active: true,
		addedAt: "2026-01-01T00:00:00Z",
		mode: "harness",
	});
	return { engine, supervisor, sim, decisions, logs, home, repo, config };
}

/** open な PR とその CI を差し替える */
function withCi(c: { sim: Sim }, prs: { number: number; head: string }[], ci: Record<number, unknown[]>) {
	c.sim.prs = prs;
	c.sim.ci = ci;
}

/** engine へ繋ぐ worker 役のソケット（channel の代わり）。welcome を待つ */
async function connect(home: string, role: "worker" | "cli" = "worker", protocol = PROTOCOL_VERSION) {
	const socket = net.connect(path.join(home, "engine.sock"));
	const messages: Record<string, unknown>[] = [];
	socket.on(
		"data",
		lineReader<Record<string, unknown>>((m) => messages.push(m)),
	);
	await new Promise<void>((r) => socket.once("connect", () => r()));
	socket.write(
		`${JSON.stringify({ type: "hello", protocol, role, ...(role === "worker" ? { project: "p1" } : {}), pid: process.pid, cwd: home })}\n`,
	);
	await until(() => messages.length > 0);
	return { socket, messages, close: () => socket.destroy() };
}

async function start(options: Parameters<typeof setup>[0] = {}) {
	const ctx = setup(options);
	await ctx.engine.start();
	const worker = await connect(ctx.home);
	await until(() => ctx.engine.sessions.has("p1"));
	// 窓口が積んだ指示（worker が把握していない Task）と、遷移した Issue の Task
	const own = ctx.engine.ledger.createTask({
		project: "p1",
		title: "対象",
		issue: "7",
		status: "ai-working",
		next: "実装の続き",
	});
	const queued = ctx.engine.ledger.createTask({
		project: "p1",
		title: "別件",
		issue: "8",
		status: "queued",
		next: "窓口の指示を実施",
	});
	const inbox = ctx.engine.ledger.createTask({ project: "p1", title: "メモ" });
	const close = async () => {
		worker.close();
		await ctx.engine.stop();
		rmSync(ctx.home, { recursive: true, force: true });
		rmSync(ctx.repo, { recursive: true, force: true });
	};
	return { ...ctx, worker, own, queued, inbox, close };
}
type Started = Awaited<ReturnType<typeof start>>;

let seq = 0;
const uuid = () => randomUUID();
interface Boundary {
	boundary_id: string;
	expires_at: number;
	project: string;
	issue: string;
	phase: string;
}
async function phase(c: Started, to: string, from: string | undefined, over: Record<string, unknown> = {}) {
	seq++;
	const r = (await c.engine.call(CLI, "notify", {
		event: "phase",
		project: "p1",
		issue: "7",
		title: `T${seq}`,
		phase: to,
		...(from === undefined ? {} : { from_phase: from }),
		transition_id: uuid(),
		...over,
	})) as { refreshBoundary?: Boundary };
	return r.refreshBoundary;
}
const phaseRows = (c: Started) => c.decisions.filter((d) => d.trigger === "phase");
const lastReason = (c: Started) => phaseRows(c).at(-1)?.primaryReason;
const seen = (c: Started) => c.engine.ledger.strictPhaseSeen().p1?.["7"];

function checkpointArgs(
	c: Started,
	b: Boundary,
	over: { next?: { task_id: string; expected: string; text: string }[]; bytes?: number; sha?: string } = {},
) {
	return {
		boundary_id: b.boundary_id,
		handoff_sha256: over.sha ?? sha(HANDOFF),
		handoff_bytes: over.bytes ?? Buffer.byteLength(HANDOFF),
		next: over.next ?? [
			{ task_id: c.own.id, expected: "実装の続き", text: "レビュー指摘への対応から再開" },
			{ task_id: c.queued.id, expected: "窓口の指示を実施", text: "窓口の指示を実施" },
			{ task_id: c.inbox.id, expected: "", text: "" },
		],
	};
}
const nexts = (c: Started) => Object.fromEntries(c.engine.ledger.tasks().map((t) => [t.id, t.next]));

// --- T2: 契機と seen ---------------------------------------------------------------------------

test("T2: 実遷移だけが ticket になり、再送・同 phase・from 不明・from 不一致は見送る", async () => {
	const c = await start();
	try {
		// 初回（前回の記録なし）。from と transition_id が揃っていれば候補
		const first = await phase(c, "designing", "queued");
		assert.ok(first, "超過していて実遷移なので ticket");
		assert.match(first.boundary_id, /^[0-9a-f-]{36}$/);
		assert.deepEqual(seen(c)?.phase, "designing");
		assert.equal(seen(c)?.sequence, 1);
		// 同じ transition_id の再送 → ticket も seen も変えない
		const tid = seen(c)?.transitionId;
		assert.equal(await phase(c, "implementing", "designing", { transition_id: tid }), undefined);
		assert.equal(lastReason(c), "phase-duplicate");
		assert.equal(seen(c)?.phase, "designing");
		// 同 phase の再通知（別 transition_id）→ seen 不変
		assert.equal(await phase(c, "designing", "designing"), undefined);
		assert.equal(lastReason(c), "phase-duplicate");
		assert.equal(seen(c)?.sequence, 1);
		// from が前回 to と合わない・from 無し → 同期だけして見送り（次の実遷移から有効）
		assert.equal(await phase(c, "spec-review", "implementing"), undefined);
		assert.equal(lastReason(c), "phase-unverified");
		assert.equal(seen(c)?.phase, "spec-review");
		assert.equal(await phase(c, "implementing", undefined), undefined);
		assert.equal(lastReason(c), "phase-unverified");
		assert.equal(seen(c)?.phase, "implementing");
		// transition_id が無い通知は seen の to だけ更新（transitionId は持たない）
		assert.equal(await phase(c, "impl-review", "implementing", { transition_id: undefined }), undefined);
		assert.equal(seen(c)?.phase, "impl-review");
		assert.equal("transitionId" in (seen(c) ?? {}), false);
		// 不正な UUID 形式・不正な from は無いものとして扱う
		assert.equal(await phase(c, "implementing", "impl-review", { transition_id: "NOT-A-UUID" }), undefined);
		assert.equal(lastReason(c), "phase-unverified");
		assert.equal(await phase(c, "impl-review", "bogus"), undefined);
		assert.equal(lastReason(c), "phase-unverified");
		// 実遷移（from が前回 to と一致）は再び ticket
		assert.ok(await phase(c, "implementing", "impl-review"));
	} finally {
		await c.close();
	}
});

test("T2: impl-review → awaiting-merge → done の順で、done は from=awaiting-merge が前回 to と一致して候補になる", async () => {
	const c = await start();
	try {
		assert.ok(await phase(c, "impl-review", "implementing"));
		// 人待ち phase は ticket を作らず seen だけ更新する（interview・blocked も同じ）
		assert.equal(await phase(c, "awaiting-merge", "impl-review"), undefined);
		assert.equal(lastReason(c), "human-wait");
		assert.equal(seen(c)?.phase, "awaiting-merge");
		// adopt の同 phase 再通知は seen を変えない
		assert.equal(await phase(c, "awaiting-merge", "awaiting-merge"), undefined);
		assert.equal(lastReason(c), "phase-duplicate");
		assert.equal(seen(c)?.sequence, 2);
		// 人待ちの記録（Task.status）が解けた後の done。from が一致するので候補（量は十分なので ticket）
		c.engine.ledger.updateTask(c.own.id, { status: "ai-working", phase: "", waiting: "" });
		assert.ok(await phase(c, "done", "awaiting-merge"));
		for (const waiting of ["interview", "blocked"]) {
			const d = await start();
			try {
				assert.ok(await phase(d, "implementing", "designing"));
				assert.equal(await phase(d, waiting, "implementing"), undefined);
				assert.equal(lastReason(d), "human-wait");
				assert.equal(seen(d)?.phase, waiting);
			} finally {
				await d.close();
			}
		}
	} finally {
		await c.close();
	}
});

test("T2: Issue の無い phase 通知（Issue 無し PR）は seen も ticket も扱わず、強制無効の project は何も書かない", async () => {
	const c = await start();
	try {
		const r = (await c.engine.call(CLI, "notify", {
			event: "phase",
			project: "p1",
			phase: "done",
			pr: "12",
			title: "x",
		})) as {
			refreshBoundary?: unknown;
		};
		assert.equal(r.refreshBoundary, undefined);
		assert.deepEqual(c.engine.ledger.strictPhaseSeen(), {});
		assert.equal(c.decisions.length, 0);
	} finally {
		await c.close();
	}
	for (const options of [{ force: 0 }, { refreshEnabled: false }]) {
		const off = await start(options);
		try {
			assert.equal(await phase(off, "designing", "queued"), undefined);
			assert.deepEqual(off.engine.ledger.strictPhaseSeen(), {}, "seen を書かない");
			assert.equal(off.decisions.length, 0, "診断も増やさない");
			assert.equal(off.sim.execCalls.length, 0, "CI を照会しない");
			assert.equal(off.sim.reads, 0, "tmux を読まない");
			assert.equal(
				existsSync(path.join(off.home, "state.json")) &&
					"phaseRefreshSeen" in JSON.parse(readFileSync(path.join(off.home, "state.json"), "utf8")),
				false,
			);
		} finally {
			await off.close();
		}
	}
});

test("T2: state.json が壊れていれば初回とみなして上書きせず、強制を見送る", async () => {
	const c = await start();
	try {
		writeFileSync(path.join(c.home, "state.json"), "{broken");
		assert.equal(await phase(c, "designing", "queued"), undefined);
		assert.equal(lastReason(c), "phase-unverified");
		assert.equal(readFileSync(path.join(c.home, "state.json"), "utf8"), "{broken");
	} finally {
		await c.close();
	}
});

test("T2: bin/harness-phase の PHASES と done は engine の PHASE_STATUS のキー集合と一致する", () => {
	const script = readFileSync(path.join(ROOT, "bin", "harness-phase"), "utf8");
	const phases = /^PHASES=\(([^)]*)\)/m.exec(script)?.[1]?.trim().split(/\s+/) ?? [];
	const source = readFileSync(path.join(ROOT, "src", "engine.ts"), "utf8");
	const body = /const PHASE_STATUS[^{]*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
	const keys = [...body.matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((m) => m[1]);
	assert.deepEqual([...phases, "done"].sort(), [...keys].sort());
	assert.equal(phases.length, 8);
});

// --- T4: 閾値 ---------------------------------------------------------------------------------

test("T4: 249999/250000 は強制せず、250001 は ticket。transcript が優先で、画面は fallback、量不明は見送る", async () => {
	for (const [tokens, expected] of [
		[249999, false],
		[250000, false],
		[250001, true],
	] as const) {
		const c = await start({ tokens });
		try {
			assert.equal(Boolean(await phase(c, "designing", "queued")), expected, String(tokens));
			if (!expected) assert.equal(lastReason(c), "below-threshold");
			if (!expected) {
				assert.equal(phaseRows(c).at(-1)?.thresholdTokens, 250000);
				assert.equal(phaseRows(c).at(-1)?.tokens, tokens);
			}
		} finally {
			await c.close();
		}
	}
	// 上書き 300000 でも同じ式
	for (const [tokens, expected] of [
		[300000, false],
		[300001, true],
	] as const) {
		const c = await start({ tokens, force: 300000 });
		try {
			assert.equal(Boolean(await phase(c, "designing", "queued")), expected, String(tokens));
		} finally {
			await c.close();
		}
	}
	// transcript の量が読めなければ画面の ~Nk を 1000 倍して比べる（丸めた表示値では比べない）
	for (const [pane, expected] of [
		["x\n~250k uncached\n❯ ", false],
		["x\n~250.001k uncached\n❯ ", true],
	] as const) {
		const c = await start({ tokens: null });
		try {
			c.sim.pane = pane;
			assert.equal(Boolean(await phase(c, "designing", "queued")), expected, pane);
		} finally {
			await c.close();
		}
	}
	const unknown = await start({ tokens: null });
	try {
		assert.equal(await phase(unknown, "designing", "queued"), undefined);
		assert.equal(lastReason(unknown), "context-unknown");
	} finally {
		await unknown.close();
	}
	// idle の閾値（150000）を超えていても、強制の閾値以下なら強制しない
	const idleOnly = await start({ tokens: 200000 });
	try {
		assert.equal(await phase(idleOnly, "designing", "queued"), undefined);
		assert.equal(lastReason(idleOnly), "below-threshold");
	} finally {
		await idleOnly.close();
	}
});

// --- T5: 待ちの全経路 --------------------------------------------------------------------------

test("T5: 人の回答待ち（status・phase・waiting・open な Attention）は project 全体で見て強制しない", async () => {
	const patches: [string, (c: Started) => void][] = [
		["waiting-human", (c) => c.engine.ledger.updateTask(c.queued.id, { status: "waiting-human" })],
		["blocked", (c) => c.engine.ledger.updateTask(c.queued.id, { status: "blocked" })],
		["phase=interview", (c) => c.engine.ledger.updateTask(c.queued.id, { phase: "interview" })],
		["waiting 非空", (c) => c.engine.ledger.updateTask(c.inbox.id, { waiting: "A-3 確認待ち" })],
		[
			"open な Attention（Issue 無し PR の merge 依頼を含む）",
			(c) =>
				void c.engine.ledger.addAttention({
					taskId: "",
					project: "p1",
					issue: "",
					pr: "12",
					kind: "merge",
					title: "t",
					url: "u",
					summary: "",
				}),
		],
	];
	for (const [label, patch] of patches) {
		const c = await start();
		try {
			patch(c);
			assert.equal(await phase(c, "designing", "queued"), undefined, label);
			assert.equal(lastReason(c), "human-wait", label);
		} finally {
			await c.close();
		}
	}
	// 別 project の待ちは区別する
	const c = await start();
	try {
		c.engine.ledger.createTask({ project: "other", title: "x", issue: "1", status: "waiting-human" });
		assert.ok(await phase(c, "designing", "queued"));
	} finally {
		await c.close();
	}
});

test("T5: Codex は live な pane があれば120分を超えても除外し、dead だけなら実行中ではなく、不明は見送る", () => {
	const roots = ["/repo", "/wt"];
	const row = (name: string, dead: string, cwd: string, wt = "") => ["@1", name, "%1", dead, cwd, wt].join("\t");
	assert.equal(classifyCodexPanes(row("codex-impl-7", "0", "/repo"), roots), "busy");
	assert.equal(classifyCodexPanes(row("codex-spec-7", "0", "/wt/issue-7"), roots), "busy");
	// cwd が移動していても wrapper が付ける @dle_wt で拾う
	assert.equal(classifyCodexPanes(row("codex-impl-7", "0", "/tmp/elsewhere", "/wt/issue-7"), roots), "busy");
	assert.equal(classifyCodexPanes(row("codex-impl-7", "1", "/repo"), roots), "clear");
	assert.equal(
		classifyCodexPanes(`${row("codex-impl-7", "1", "/repo")}\n${row("codex-impl-7", "0", "/repo")}`, roots),
		"busy",
	);
	// 別 project の窓・登録 root 外の窓・supervisor 自身の窓（dle-*）は関係しない
	assert.equal(classifyCodexPanes(row("codex-impl-7", "0", "/other"), roots), "clear");
	assert.equal(classifyCodexPanes(row("shell", "0", "/other"), roots), "clear");
	assert.equal(classifyCodexPanes(row("dle-proj", "0", "/repo"), roots), "clear");
	// 手動で改名された Codex かもしれない root 配下の live 窓は所属不明（見送り）。dead なら実行中ではない
	assert.equal(
		classifyCodexPanes("@1\tbash\t%1\t0\t/r/wt/issue-61\t/r/wt/issue-61\n", ["/r/main", "/r/wt"]),
		"unknown",
	);
	// cwd が root 配下なだけ（@dle_wt 無し）の窓は無関係。repo ルートの shell・engine 窓・worktree のエディタで見送らない
	assert.equal(classifyCodexPanes(row("shell", "0", "/repo"), roots), "clear");
	assert.equal(
		classifyCodexPanes(
			"@9\tbash\t%9\t0\t/r/main\t\n@8\tengine\t%8\t0\t/r/main\t\n@7\tnvim\t%7\t0\t/r/main/.worktrees/issue-61\t\n",
			["/r/main", "/r/main/.worktrees"],
		),
		"clear",
	);
	assert.equal(classifyCodexPanes(row("renamed", "0", "/tmp/x", "/wt/issue-7"), roots), "unknown");
	assert.equal(classifyCodexPanes(row("shell", "1", "/repo"), roots), "clear");
	assert.equal(
		classifyCodexPanes(`${row("shell", "0", "/repo")}\n${row("codex-impl-7", "0", "/repo")}`, roots),
		"busy",
	);
	assert.equal(classifyCodexPanes("", roots), "clear");
	// 壊れた行・pane_dead が 0/1 でない行は unknown
	assert.equal(classifyCodexPanes("@1\tcodex-impl-7\t%1\t0\t/repo", roots), "unknown");
	assert.equal(classifyCodexPanes(row("codex-impl-7", "x", "/repo"), roots), "unknown");
});

test("T5: Codex 実行中は ticket を作らず、列挙の失敗も見送る", async () => {
	const c = await start();
	try {
		c.sim.codex = ["@1", "codex-impl-7", "%1", "0", c.repo, ""].join("\t");
		assert.equal(await phase(c, "designing", "queued"), undefined);
		assert.equal(lastReason(c), "codex-busy");
		c.sim.codex = "broken";
		assert.equal(await phase(c, "implementing", "designing"), undefined);
		assert.equal(lastReason(c), "codex-unknown");
		c.sim.codex = ["@1", "codex-impl-7", "%1", "1", c.repo, ""].join("\t");
		assert.ok(await phase(c, "impl-review", "implementing"), "dead だけなら実行中ではない");
	} finally {
		await c.close();
	}
});

test("T5: CI は進行中・未登録（0件）・取得失敗・head 移動を待ち/不明として除外し、完了した失敗は待ちにしない", async () => {
	assert.equal(classifyCiNodes([]), "busy");
	assert.equal(classifyCiNodes(DONE), "clear");
	assert.equal(classifyCiNodes([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]), "clear");
	assert.equal(classifyCiNodes([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED" }]), "clear");
	for (const status of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"])
		assert.equal(classifyCiNodes([...DONE, { __typename: "CheckRun", status }]), "busy", status);
	assert.equal(classifyCiNodes([{ __typename: "StatusContext", state: "PENDING" }]), "busy");
	assert.equal(classifyCiNodes([{ __typename: "StatusContext", state: "FAILURE" }]), "clear");
	assert.equal(classifyCiNodes([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEW_VALUE" }]), "unknown");
	assert.equal(classifyCiNodes([{ __typename: "Other" }]), "unknown");

	const pr5 = [{ number: 5, head: HEAD }];
	const cases: [string, (c: Started) => void, string][] = [
		["進行中", (c) => withCi(c, pr5, { 5: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] }), "ci-wait"],
		["0件", (c) => withCi(c, pr5, { 5: [] }), "ci-wait"],
		[
			"別の PR（複数）の片方だけ進行中",
			(c) =>
				withCi(
					c,
					[
						{ number: 5, head: HEAD },
						{ number: 6, head: HEAD },
					],
					{ 5: DONE, 6: [{ __typename: "StatusContext", state: "PENDING" }] },
				),
			"ci-wait",
		],
		["取得失敗", (c) => withCi(c, pr5, {}), "ci-unknown"],
		[
			"未知の状態",
			(c) => withCi(c, pr5, { 5: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "???" }] }),
			"ci-unknown",
		],
	];
	for (const [label, arrange, reason] of cases) {
		const c = await start();
		try {
			arrange(c);
			assert.equal(await phase(c, "designing", "queued"), undefined, label);
			assert.equal(lastReason(c), reason, label);
		} finally {
			await c.close();
		}
	}
	// 完了した CI（失敗を含む）と open な PR 無しは待ちではない
	for (const arrange of [
		(c: Started) =>
			withCi(c, pr5, { 5: [...DONE, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] }),
		(c: Started) => withCi(c, [], {}),
	]) {
		const c = await start();
		try {
			arrange(c);
			assert.ok(await phase(c, "designing", "queued"));
		} finally {
			await c.close();
		}
	}
	// 読取の間に head が動いたら不明
	const moved = await start();
	try {
		withCi(moved, pr5, { 5: DONE });
		let calls = 0;
		Object.defineProperty(moved.sim, "prs", {
			get: () => {
				calls++;
				return calls > 2 ? [{ number: 5, head: "b".repeat(40) }] : pr5;
			},
		});
		assert.equal(await phase(moved, "designing", "queued"), undefined);
		assert.equal(lastReason(moved), "ci-unknown");
	} finally {
		await moved.close();
	}
});

// --- T3: checkpoint ---------------------------------------------------------------------------

async function ticketed(c: Started) {
	const b = await phase(c, "designing", "queued");
	assert.ok(b);
	return b;
}
const checkpoint = (c: Started, args: unknown) =>
	c.engine.call(WORKER, "refresh_checkpoint", args) as Promise<Record<string, unknown>>;

test("T3/T4: checkpoint 受理後に停止点が確認できたら clear→再開し、変えていない Task.next は clear の前後で完全に一致する", async () => {
	const c = await start();
	try {
		const b = await ticketed(c);
		const before = c.engine.ledger.tasks();
		c.sim.status = "idle";
		const r = await checkpoint(c, checkpointArgs(c, b));
		assert.equal(r.accepted, true);
		assert.equal(r.action, "end-turn");
		await until(() => c.decisions.some((d) => d.trigger === "phase" && d.result !== undefined));
		assert.deepEqual(
			c.sim.sends,
			["/clear", "Enter", "/discord-loop-engine:issue-loop", "Enter"],
			"送るのは定数と設定だけ",
		);
		const after = c.engine.ledger.tasks();
		assert.equal(after.find((t) => t.id === c.own.id)?.next, "レビュー指摘への対応から再開");
		// 窓口が書いた next（queued）と、next が空の inbox は clear の前後で変わらず、updated・経緯も増えない
		for (const id of [c.queued.id, c.inbox.id]) {
			assert.deepEqual(
				after.find((t) => t.id === id),
				before.find((t) => t.id === id),
				id,
			);
		}
		// status・phase・waiting と Attention は checkpoint で書き換えない
		const was = before.find((t) => t.id === c.own.id);
		const now = after.find((t) => t.id === c.own.id);
		assert.deepEqual([now?.status, now?.phase, now?.waiting], [was?.status, was?.phase, was?.waiting]);
		const row = phaseRows(c).at(-1);
		assert.equal(row?.primaryReason, "refresh-success");
		assert.equal(row?.result, true);
		assert.equal(row?.thresholdTokens, 250000);
		// 同じ ticket でもう一度は受理されない（失敗・成功した機会は再試行しない）
		assert.equal((await checkpoint(c, checkpointArgs(c, b))).accepted, false);
		// 成功後は新しい真の遷移だけが次の機会（直後の再遷移は cooldown でなく、from が前回 to と合えば再び ticket）
		assert.ok(await phase(c, "implementing", "designing"));
	} finally {
		await c.close();
	}
});

test("T3: handoff（hash・bytes・loop_meta・差替え）が合わなければ受理せず、Task.next は何も変わらない", async () => {
	const handoff = path.join("", ".harness", "handoff.md");
	const cases: [string, (c: Started, b: Boundary) => unknown][] = [
		["hash 不一致", (c, b) => checkpointArgs(c, b, { sha: "0".repeat(64) })],
		["bytes 不一致", (c, b) => checkpointArgs(c, b, { bytes: 3 })],
		[
			"loop_meta 欠落",
			(c, b) => {
				const text = "## stall\n";
				writeFileSync(path.join(c.repo, handoff), text);
				return checkpointArgs(c, b, { sha: sha(text), bytes: Buffer.byteLength(text) });
			},
		],
		[
			"loop_meta の重複",
			(c, b) => {
				const text = `${HANDOFF}## loop_meta\n`;
				writeFileSync(path.join(c.repo, handoff), text);
				return checkpointArgs(c, b, { sha: sha(text), bytes: Buffer.byteLength(text) });
			},
		],
		[
			"空ファイル",
			(c, b) => {
				writeFileSync(path.join(c.repo, handoff), "");
				return checkpointArgs(c, b, { sha: sha(""), bytes: 0 });
			},
		],
		[
			"過大",
			(c, b) => {
				const text = `${HANDOFF}${"x".repeat(70000)}`;
				writeFileSync(path.join(c.repo, handoff), text);
				return checkpointArgs(c, b, { sha: sha(text), bytes: Buffer.byteLength(text) });
			},
		],
		[
			"不正な UTF-8",
			(c, b) => {
				const bytes = Buffer.concat([Buffer.from(HANDOFF), Buffer.from([0xff, 0xfe])]);
				writeFileSync(path.join(c.repo, handoff), bytes);
				return checkpointArgs(c, b, { sha: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
			},
		],
		[
			"symlink に差替え",
			(c, b) => {
				const real = path.join(c.repo, "real.md");
				writeFileSync(real, HANDOFF);
				rmSync(path.join(c.repo, handoff));
				symlinkSync(real, path.join(c.repo, handoff));
				return checkpointArgs(c, b);
			},
		],
	];
	for (const [label, arrange] of cases) {
		const c = await start();
		try {
			const b = await ticketed(c);
			const before = nexts(c);
			const args = arrange(c, b);
			const r = await checkpoint(c, args);
			assert.deepEqual(r, { accepted: false, reason: "checkpoint-invalid" }, label);
			assert.deepEqual(nexts(c), before, label);
			assert.equal(lastReason(c), "checkpoint-invalid", label);
			assert.equal(c.sim.sends.length, 0, `${label}: clear しない`);
		} finally {
			await c.close();
		}
	}
});

test("T3: Task の過不足・重複・他 project、ticket 違い・窓口/CLI からの呼出し・旧 ticket は clear 0回", async () => {
	const c = await start();
	try {
		const b = await ticketed(c);
		const base = checkpointArgs(c, b);
		const before = nexts(c);
		// 重複
		assert.deepEqual(await checkpoint(c, { ...base, next: [...base.next, base.next[0]] }), {
			accepted: false,
			reason: "checkpoint-invalid",
		});
		assert.equal(c.engine.ledger.tasks().length, 3);
		// ticket が無い・別 id
		assert.deepEqual(await checkpoint(c, { ...base, boundary_id: uuid() }), {
			accepted: false,
			reason: "phase-expired",
		});
		assert.deepEqual(nexts(c), before);
		// ticket は失敗で破棄されているので、正しい引数でも通らない（失敗した機会は再試行しない）
		assert.deepEqual(await checkpoint(c, base), { accepted: false, reason: "phase-expired" });
		// 窓口・CLI は使えない
		for (const who of [CONCIERGE, CLI])
			await assert.rejects(c.engine.call(who, "refresh_checkpoint", base), /worker だけ/);
		// 未知の引数・schema 違反は入口で拒否
		await assert.rejects(c.engine.call(WORKER, "refresh_checkpoint", { ...base, extra: 1 }), /extra/);
		await assert.rejects(
			c.engine.call(WORKER, "refresh_checkpoint", { ...base, next: [{ task_id: "T-1" }] }),
			/next\[0\]\.expected/,
		);
		assert.equal(c.sim.sends.length, 0);
	} finally {
		await c.close();
	}
	// Task の不足（open な Task を返していない）
	const d = await start();
	try {
		const b = await ticketed(d);
		const base = checkpointArgs(d, b);
		assert.deepEqual(await checkpoint(d, { ...base, next: base.next.slice(0, 2) }), {
			accepted: false,
			reason: "checkpoint-race",
		});
	} finally {
		await d.close();
	}
	// 他 project・存在しない Task
	const e = await start();
	try {
		const other = e.engine.ledger.createTask({ project: "other", title: "x", issue: "1" });
		const b = await ticketed(e);
		const base = checkpointArgs(e, b);
		const r = await checkpoint(e, {
			...base,
			next: [...base.next.slice(0, 2), { task_id: other.id, expected: "", text: "" }],
		});
		assert.equal(r.accepted, false);
	} finally {
		await e.close();
	}
});

test("T3: checkpoint の前に窓口が next を変えていたら checkpoint-race で、全 Task の next は不変（窓口の指示を上書きしない）", async () => {
	const c = await start();
	try {
		const b = await ticketed(c);
		await c.engine.call(CONCIERGE, "task_update", { id: c.queued.id, next: "窓口が後から書いた指示" });
		const before = nexts(c);
		const r = await checkpoint(c, checkpointArgs(c, b));
		assert.deepEqual(r, { accepted: false, reason: "checkpoint-race" });
		assert.deepEqual(nexts(c), before);
		assert.equal(before[c.queued.id], "窓口が後から書いた指示");
		assert.equal(lastReason(c), "checkpoint-race");
		assert.equal(c.sim.sends.length, 0);
	} finally {
		await c.close();
	}
});

test("T3/T12: next の text が違反なら何も書かず next-text-invalid（本文は応答にも診断にも出ない）。空の next は変更しない要素なら通す", async () => {
	const secret = "SECRET-NEXT-SENTINEL";
	const invalid: [string, string][] = [
		[` ${secret}`, "untrimmed"],
		["", "empty"],
		["-", "dash"],
		[`${secret}\n\n## 経緯\n- x`, "section-heading"],
		[`abc ## 経緯\n- ${secret}`, "section-heading"],
		[secret.repeat(400), "too-long"],
		[`${secret}\ud800`, "ill-formed"],
	];
	for (const [text, rule] of invalid) {
		const c = await start();
		try {
			const b = await ticketed(c);
			const before = c.engine.ledger.tasks();
			const next = checkpointArgs(c, b).next;
			next[0] = { task_id: c.own.id, expected: "実装の続き", text };
			const r = await checkpoint(c, { ...checkpointArgs(c, b), next });
			assert.deepEqual(r, { accepted: false, reason: "next-text-invalid", task_id: c.own.id, rule }, rule);
			assert.equal(JSON.stringify(r).includes(secret), false);
			assert.deepEqual(c.engine.ledger.tasks(), before, "next・updated・経緯が不変");
			assert.equal(lastReason(c), "checkpoint-invalid", "診断は固定理由にまとめ、rule 名は残さない");
			assert.equal(JSON.stringify(c.decisions).includes(secret), false);
		} finally {
			await c.close();
		}
	}
	// 遷移した Issue の Task は、保存後に非空であること（text===expected でも expected が空なら不正）
	const c = await start();
	try {
		c.engine.ledger.updateTask(c.own.id, { next: "" });
		const b = await ticketed(c);
		const next = checkpointArgs(c, b).next;
		next[0] = { task_id: c.own.id, expected: "", text: "" };
		assert.deepEqual(await checkpoint(c, { ...checkpointArgs(c, b), next }), {
			accepted: false,
			reason: "next-text-invalid",
			task_id: c.own.id,
			rule: "empty",
		});
	} finally {
		await c.close();
	}
});

test("T3: 保存の途中で失敗したら clear 0回で、既に保存した next は残り、他者の指示は消えない", async () => {
	const c = await start();
	try {
		const b = await ticketed(c);
		const original = c.engine.ledger.updateTask.bind(c.engine.ledger);
		let n = 0;
		c.engine.ledger.updateTask = (...args: Parameters<typeof original>) => {
			if (++n === 2) throw new Error("disk full");
			return original(...args);
		};
		const next = checkpointArgs(c, b).next;
		next[0] = { task_id: c.own.id, expected: "実装の続き", text: "新しい next" };
		next[1] = { task_id: c.queued.id, expected: "窓口の指示を実施", text: "worker が書いた next" };
		const r = await checkpoint(c, { ...checkpointArgs(c, b), next });
		assert.equal(r.accepted, false);
		assert.equal(nexts(c)[c.own.id], "新しい next");
		assert.equal(nexts(c)[c.queued.id], "窓口の指示を実施");
		assert.equal(c.sim.sends.length, 0);
	} finally {
		await c.close();
	}
});

// --- T6: 競合・失効 ---------------------------------------------------------------------------

async function armed(c: Started) {
	const b = await ticketed(c);
	return { b, args: checkpointArgs(c, b) };
}
test("T6: 停止点を確認できないとき（次の作業・入力中・別 session・確認画面・subagent・競合）は clear せず、既存の wake で worker を起こす", async () => {
	type Arrange = (c: Started) => void;
	const blocked = {
		taskId: "",
		project: "p1",
		issue: "7",
		pr: "",
		kind: "blocked" as const,
		title: "t",
		url: "u",
		summary: "",
	};
	const cases: [string, string, Arrange][] = [
		[
			"checkpoint 後に次の作業（Bash/Agent の tool_use）",
			"worker-active",
			(c) => {
				c.sim.boundary = "active";
			},
		],
		[
			"ログから checkpoint を特定できない",
			"transcript-unknown",
			(c) => {
				c.sim.boundary = "unknown";
			},
		],
		[
			"入力欄に人の入力",
			"input-not-empty",
			(c) => {
				c.sim.pane = "x\n❯ typed";
			},
		],
		[
			"確認画面",
			"permission-prompt",
			(c) => {
				c.sim.pane = "Do you want to proceed?\n❯ 1. Yes";
			},
		],
		[
			"別 session へ移行",
			"session-unknown",
			(c) => {
				c.sim.onPoll = () => {
					c.sim.sessionId = "other";
				};
			},
		],
		[
			"Codex の起動",
			"codex-busy",
			(c) => {
				c.sim.codex = ["@1", "codex-impl-9", "%2", "0", c.repo, ""].join("\t");
			},
		],
		[
			"量が閾値以下に",
			"below-threshold",
			(c) => {
				c.sim.tokens = 100000;
			},
		],
		[
			"CI が始まった",
			"ci-wait",
			(c) => withCi(c, [{ number: 5, head: HEAD }], { 5: [{ __typename: "CheckRun", status: "QUEUED" }] }),
		],
		[
			"人の待ちが発生",
			"human-wait",
			(c) => {
				c.sim.onPoll = () => {
					c.engine.ledger.addAttention(blocked);
				};
			},
		],
		[
			"Task が追加された",
			"checkpoint-race",
			(c) => {
				c.sim.onPoll = () => {
					c.engine.ledger.createTask({ project: "p1", title: "新規" });
				};
			},
		],
		[
			"別の配送が入った（世代が進む）",
			"phase-superseded",
			(c) => {
				c.sim.onPoll = () => {
					c.engine.deliver("p1", "x", {});
				};
			},
		],
	];
	for (const [label, reason, arrange] of cases) {
		const c = await start();
		try {
			const { args } = await armed(c);
			c.sim.status = "idle";
			arrange(c);
			assert.equal((await checkpoint(c, args)).accepted, true, label);
			await until(() => lastReason(c) === reason && phaseRows(c).length >= 1, 5000).catch(() => {
				throw new Error(`${label}: 期待 ${reason} / 実際 ${lastReason(c)}`);
			});
			assert.equal(c.sim.sends.includes("/clear"), false, `${label}: clear しない`);
			// 待っている worker を放置しない（既存の wake の定数の1行だけを送る）
			await until(() => c.sim.sends.includes(WAKE_PROMPT)).catch(() => {});
			assert.ok(
				c.sim.sends.every((s) => s === WAKE_PROMPT || s === "Enter"),
				`${label}: ${c.sim.sends.join("|")}`,
			);
		} finally {
			await c.close();
		}
	}
});

test("T6: session が idle にならないまま期限が来たら clear せず、ticket は破棄される（再試行しない）", async () => {
	const c = await start();
	try {
		const { args } = await armed(c);
		c.sim.status = "busy";
		assert.equal((await checkpoint(c, args)).accepted, true);
		await until(() => lastReason(c) === "phase-expired", 8000);
		assert.equal(c.sim.sends.includes("/clear"), false);
		assert.equal((await checkpoint(c, args)).accepted, false);
	} finally {
		await c.close();
	}
});

test("T6: checkpoint を待たずに別の phase 通知が来たら古い ticket は無効（phase-superseded）で、新しい ticket だけが有効", async () => {
	const c = await start();
	try {
		const first = await ticketed(c);
		const second = await phase(c, "implementing", "designing");
		assert.ok(second);
		assert.equal(
			phaseRows(c).some((d) => d.primaryReason === "phase-superseded"),
			true,
		);
		assert.deepEqual(await checkpoint(c, checkpointArgs(c, first)), { accepted: false, reason: "phase-expired" });
	} finally {
		await c.close();
	}
});

test("T6: 窓口は強制しない（concierge の refresh に強制の閾値は無い）。worker が接続していなければ ticket を作らない", async () => {
	const c = await start();
	try {
		const concierge = c.engine.targets().find((t) => t.name === "concierge");
		assert.equal(concierge?.refresh && "forceMaxTokens" in concierge.refresh, false);
		c.worker.close();
		await until(() => !c.engine.sessions.has("p1"));
		assert.equal(await phase(c, "designing", "queued"), undefined);
		assert.equal(lastReason(c), "channel-offline");
	} finally {
		await c.close();
	}
});

// --- T9: 実の channel・CLI・socket で通す ---------------------------------------------------------

test("T9: 実 socket で protocol 3 だけが繋がり、refresh_checkpoint は worker のツール一覧にだけ出る", async () => {
	const c = await start();
	try {
		assert.equal(PROTOCOL_VERSION, 3);
		const old = net.connect(path.join(c.home, "engine.sock"));
		const got: Record<string, unknown>[] = [];
		old.on(
			"data",
			lineReader<Record<string, unknown>>((m) => got.push(m)),
		);
		await new Promise<void>((r) => old.once("connect", () => r()));
		old.write(`${JSON.stringify({ type: "hello", protocol: 2, role: "cli", pid: 1, cwd: "/" })}\n`);
		await until(() => got.length > 0);
		assert.equal(got[0]?.type, "error");
		assert.match(String(got[0]?.message), /バージョンが合いません/);
		old.destroy();
	} finally {
		await c.close();
	}
});

test("T9: dle CLI → engine → 本物の channel（MCP）→ Supervisor → clear → 再開 を通す", { timeout: 60000 }, async () => {
	const c = setup();
	await c.engine.start();
	const own = c.engine.ledger.createTask({
		project: "p1",
		title: "対象",
		issue: "7",
		status: "ai-working",
		next: "実装の続き",
	});
	const queued = c.engine.ledger.createTask({
		project: "p1",
		title: "別件",
		issue: "8",
		status: "queued",
		next: "窓口の指示を実施",
	});
	const child = spawn(
		process.execPath,
		["--disable-warning=ExperimentalWarning", path.join(ROOT, "channel", "server.ts")],
		{
			env: {
				...process.env,
				DLE_HOME: c.home,
				DLE_SOCKET: path.join(c.home, "engine.sock"),
				DLE_ROLE: "worker",
				DLE_PROJECT: "p1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const out: Record<string, unknown>[] = [];
	child.stdout.on(
		"data",
		lineReader<Record<string, unknown>>((m) => out.push(m)),
	);
	let id = 0;
	const rpc = async (method: string, params: Record<string, unknown>) => {
		const mine = ++id;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
		await until(() => out.some((m) => m.id === mine), 10000);
		return out.find((m) => m.id === mine) as { result?: Record<string, unknown> };
	};
	try {
		const tools =
			((await rpc("tools/list", {})).result?.tools as {
				name: string;
				inputSchema: { properties: Record<string, unknown> };
			}[]) ?? [];
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("refresh_checkpoint"));
		assert.equal(names.includes("notify"), false, "notify は cli 専用");
		const next = tools.find((t) => t.name === "refresh_checkpoint")?.inputSchema.properties.next as {
			items: { properties: Record<string, unknown> };
		};
		assert.deepEqual(Object.keys(next.items.properties).sort(), ["expected", "task_id", "text"]);
		await until(() => c.engine.sessions.has("p1"));
		// dle notify（harness-phase が呼ぶ口）。--json で境界が出る
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				path.join(ROOT, "bin", "dle"),
				[
					"notify",
					"--json",
					"--event",
					"phase",
					"--phase",
					"designing",
					"--issue",
					"7",
					"--title",
					"t",
					"--project",
					"p1",
					"--from_phase",
					"queued",
					"--transition_id",
					uuid(),
				],
				{ env: { ...process.env, DLE_HOME: c.home, DLE_SOCKET: path.join(c.home, "engine.sock") } },
				(err, o) => (err ? reject(err) : resolve(String(o))),
			);
		});
		const boundary = (JSON.parse(stdout.trim().split("\n").at(-1) as string) as { refreshBoundary?: Boundary })
			.refreshBoundary;
		assert.ok(boundary, stdout);
		// worker が保存した handoff と next を渡す。応答は即座に end-turn
		c.sim.status = "idle";
		const call = await rpc("tools/call", {
			name: "refresh_checkpoint",
			arguments: {
				boundary_id: boundary.boundary_id,
				handoff_sha256: sha(HANDOFF),
				handoff_bytes: Buffer.byteLength(HANDOFF),
				next: [
					{ task_id: own.id, expected: "実装の続き", text: "レビュー対応から再開" },
					{ task_id: queued.id, expected: "窓口の指示を実施", text: "窓口の指示を実施" },
				],
			},
		});
		const text = ((call.result?.content as { text: string }[])[0] as { text: string }).text;
		assert.equal(JSON.parse(text).accepted, true, text);
		await until(() => c.decisions.some((d) => d.trigger === "phase" && d.result === true), 10000);
		assert.deepEqual(c.sim.sends, ["/clear", "Enter", "/discord-loop-engine:issue-loop", "Enter"]);
		assert.equal(c.engine.ledger.task(own.id)?.next, "レビュー対応から再開");
		assert.equal(c.engine.ledger.task(queued.id)?.next, "窓口の指示を実施");
		// handoff は clear の後も実ファイルのまま読める（loop_meta 必須の同一規則）
		assert.equal(readFileSync(path.join(c.repo, ".harness", "handoff.md"), "utf8"), HANDOFF);
	} finally {
		child.kill();
		await c.engine.stop();
		rmSync(c.home, { recursive: true, force: true });
		rmSync(c.repo, { recursive: true, force: true });
	}
});

// --- T7: OFF の回帰 ---------------------------------------------------------------------------

test("T7: forceMaxTokens=0 の worker と窓口は強制の読取を一切せず、idle の整理は従来どおり動く", async () => {
	for (const [name, force] of [
		["worker", 0],
		["concierge", undefined],
	] as const) {
		const calls: string[][] = [];
		let cleared = false;
		let now = 0;
		const refresh = {
			cwd: "/fixture",
			prompt: "/loop",
			maxTokens: 100000,
			...(force === undefined ? {} : { forceMaxTokens: force }),
			maxEvents: 0,
			contextPercent: 15,
			idleSeconds: 180,
			cooldownMinutes: 30,
			waitForCodex: true,
			codexIgnoreAfterMinutes: 120,
		};
		const sup = new Supervisor({
			tmuxSession: "fixture",
			targets: () => [{ name, cwd: "/fixture", command: "claude", initialPrompt: "/loop", refresh }],
			isLive: () => true,
			notify: () => {},
			tmux: async (args) => {
				calls.push(args);
				if (args[0] === "list-windows") return { ok: true, stdout: `dle-${name}` };
				if (args[0] === "capture-pane") return { ok: true, stdout: "history\n❯ " };
				if (args[0] === "display-message") return { ok: true, stdout: "123" };
				if (args.includes("/clear")) cleared = true;
				return { ok: true, stdout: "" };
			},
			readSession: async () => ({ sessionId: cleared ? "new" : "old", cwd: "/fixture", status: "idle", updatedAt: 0 }),
			readTranscript: async () => ({ tokens: 150000, mtimeMs: 0, subagentMtimeMs: 0 }),
			now: () => now,
			wait: async () => {},
			promptDelayMs: 0,
			clearConfirmMs: 0,
		});
		now = 1_000_000;
		const probe = await sup.phaseProbe(name);
		assert.deepEqual(probe, { ok: false, reason: "refresh-disabled" }, name);
		assert.equal(calls.length, 0, `${name}: 強制のための tmux 読取は0`);
		// 強制0でも idle の整理（>= 100000）は従来どおり clear する
		await sup.tick();
		assert.equal(cleared, true, `${name}: idle は動く`);
	}
});

test("T7: 強制整理を待機している間は、通常 tick の idle 整理と wake が同じ slot を奪わない", async () => {
	const c = await start();
	try {
		const b = await ticketed(c);
		c.sim.status = "busy";
		assert.equal((await checkpoint(c, checkpointArgs(c, b))).accepted, true);
		// 待機中の tick は clear しない（refreshing 扱いで見送る）
		await c.supervisor.tick();
		assert.equal(c.sim.sends.includes("-l /clear") || c.sim.sends.includes("/clear"), false);
		await until(() => lastReason(c) === "phase-expired", 8000);
	} finally {
		await c.close();
	}
});

// --- 実装レビュー指摘: Agent 経由の遷移・停止・I/O 込みの期限・送信直前の handoff --------------------------

test("T6: Agent 内で harness-phase を実行した後の subagent の書込み（checkpoint の前）は妨げにならず、受理の後の更新だけが見送り", async () => {
	const ok = await start();
	try {
		const { args } = await armed(ok);
		// ticket の後・checkpoint の前に、Agent の transcript が更新された（tool_result・最終応答）
		ok.sim.subagentMtimeMs = Date.now();
		await new Promise((r) => setTimeout(r, 30));
		ok.sim.status = "idle";
		assert.equal((await checkpoint(ok, args)).accepted, true);
		await until(() => ok.sim.sends.includes("/clear"));
	} finally {
		await ok.close();
	}
	const late = await start();
	try {
		const { args } = await armed(late);
		late.sim.status = "idle";
		// 受理の後に subagent が動いた（worker が Agent を走らせ続けている）
		late.sim.onPoll = () => {
			late.sim.subagentMtimeMs = Date.now() + 60_000;
		};
		assert.equal((await checkpoint(late, args)).accepted, true);
		await until(() => lastReason(late) === "subagent-recent");
		assert.equal(late.sim.sends.includes("/clear"), false);
	} finally {
		await late.close();
	}
});

test("T6/§7.1: 待機中の cancelPhaseRefreshes は clear も wake も0回（停止中は worker を起こさない）", async () => {
	const c = await start();
	try {
		const { args } = await armed(c);
		let release: () => void = () => {};
		c.sim.hold = new Promise<void>((r) => {
			release = r;
		});
		c.sim.status = "busy";
		assert.equal((await checkpoint(c, args)).accepted, true);
		c.supervisor.cancelPhaseRefreshes();
		release();
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(c.sim.sends, []);
		assert.equal(lastReason(c), "phase-superseded");
	} finally {
		await c.close();
	}
});

test("T6/§7.1: 待機中の Engine.stop は clear も wake も0回で、ticket も残らない", async () => {
	const c = await start();
	try {
		const { b, args } = await armed(c);
		let release: () => void = () => {};
		c.sim.hold = new Promise<void>((r) => {
			release = r;
		});
		c.sim.status = "busy";
		assert.equal((await checkpoint(c, args)).accepted, true);
		await c.engine.stop();
		release();
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(c.sim.sends, []);
		assert.deepEqual(await checkpoint(c, checkpointArgs(c, b)), { accepted: false, reason: "phase-expired" });
	} finally {
		c.worker.close();
		rmSync(c.home, { recursive: true, force: true });
		rmSync(c.repo, { recursive: true, force: true });
	}
});

test("T6/§4.3: tmux の読取がハングしても、絶対期限（I/O 込み）で打ち切り clear しない", async () => {
	const c = await start({ deadlineMs: 300 });
	try {
		const { args } = await armed(c);
		c.sim.status = "idle";
		c.sim.hangCapture = true;
		const t0 = Date.now();
		assert.equal((await checkpoint(c, args)).accepted, true);
		await until(() => lastReason(c) === "phase-expired", 4000);
		assert.ok(Date.now() - t0 < 2000, "ハングした I/O が期限を超えて待たせない");
		assert.equal(c.sim.sends.includes("/clear"), false);
	} finally {
		await c.close();
	}
});

test("T3/§4.3.5: 送信直前に handoff を取り直し、arm 後に書き換えられていたら checkpoint-invalid で clear しない", async () => {
	const c = await start();
	try {
		const { args } = await armed(c);
		c.sim.status = "idle";
		c.sim.onPoll = () => {
			writeFileSync(path.join(c.repo, ".harness", "handoff.md"), `${HANDOFF}- 差し替え\n`);
		};
		assert.equal((await checkpoint(c, args)).accepted, true);
		await until(() => lastReason(c) === "checkpoint-invalid");
		assert.equal(c.sim.sends.includes("/clear"), false);
	} finally {
		await c.close();
	}
});
