// Supervisor が保証すること:
// - 窓口・worker のセッションもウィンドウも無ければ tmux に起動する
// - 繋がっている・ウィンドウがある間は二重に起動しない
// - 起動直後の開発用 channel の確認にだけ自動で答える（フォルダの信頼などには答えない）
// - 起動したのに繋がってこなければ一度だけ知らせる
// - 短時間に落ち続けたら自動起動を止めて知らせ、reset で再開する
// - 繋がったら最初のプロンプトを一度だけ入れる
// - 許可確認で止まり続けていたら一度だけ知らせる
import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RefreshResult, type SessionTarget, Supervisor, shq } from "../src/supervisor.ts";

function setup(opts: { windows?: string[] | null; live?: Set<string>; pane?: string } = {}) {
	let now = 0;
	const calls: string[][] = [];
	const notes: [string, string][] = [];
	const state = { windows: opts.windows ?? null, pane: opts.pane ?? "" };
	const live = opts.live ?? new Set<string>();
	const targets: SessionTarget[] = [
		{ name: "kishimen-tool", cwd: "/w/k", command: "claude --x", initialPrompt: "/discord-loop-engine:issue-loop" },
	];
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => targets,
		tmux: async (args) => {
			calls.push(args);
			if (args[0] === "capture-pane") return { ok: true, stdout: state.pane };
			if (args[0] === "list-windows")
				return state.windows === null ? { ok: false, stdout: "" } : { ok: true, stdout: state.windows.join("\n") };
			return { ok: true, stdout: "" };
		},
		isLive: (n) => live.has(n),
		notify: (n, t) => notes.push([n, t]),
		now: () => now,
		promptDelayMs: 0,
	});
	return {
		sup,
		calls,
		notes,
		state,
		live,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const spawns = (calls: string[][]) => calls.filter((c) => c[0] === "new-window" || c[0] === "new-session");

test("セッションが無ければ新しい tmux セッションに起動する", async () => {
	const { sup, calls } = setup();
	await sup.tick();
	assert.deepEqual(spawns(calls), [
		["new-session", "-d", "-s", "dle", "-n", "dle-kishimen-tool", "-c", "/w/k", "claude --x"],
	]);
});

test("セッションが既にあれば「セッション名:」を指定して新しいウィンドウを足す", async () => {
	// 「-t dle」だと tmux が窓名 dle-concierge の前方一致と解釈し、その番号に作ろうとして失敗する
	const { sup, calls } = setup({ windows: ["dle-concierge"] });
	await sup.tick();
	assert.deepEqual(spawns(calls), [
		["new-window", "-d", "-t", "dle:", "-n", "dle-kishimen-tool", "-c", "/w/k", "claude --x"],
	]);
});

test("繋がっている・ウィンドウがある間は二重に起動しない", async () => {
	const a = setup({ windows: [], live: new Set(["kishimen-tool"]) });
	await a.sup.tick();
	assert.equal(spawns(a.calls).length, 0);
	const b = setup({ windows: ["dle-kishimen-tool"] });
	await b.sup.tick();
	assert.equal(spawns(b.calls).length, 0);
});

test("開発用 channel の確認にだけ Enter で答える", async () => {
	const { sup, calls, state } = setup({ windows: [] });
	await sup.tick();
	state.windows = ["dle-kishimen-tool"];
	state.pane = "WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit";
	await sup.tick();
	await sup.tick();
	assert.deepEqual(
		calls.filter((c) => c[0] === "send-keys"),
		[["send-keys", "-t", "dle:dle-kishimen-tool", "Enter"]],
	);
	const other = setup({ windows: [] });
	await other.sup.tick();
	other.state.windows = ["dle-kishimen-tool"];
	other.state.pane = "Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder";
	await other.sup.tick();
	assert.ok(!other.calls.some((c) => c[0] === "send-keys"));
});

test("起動したのに繋がってこなければ一度だけ知らせる", async () => {
	const { sup, notes, state, advance } = setup({ windows: [] });
	await sup.tick();
	state.windows = ["dle-kishimen-tool"];
	advance(4 * 60_000);
	await sup.tick();
	await sup.tick();
	assert.equal(notes.length, 1);
	assert.match(notes[0]?.[1] ?? "", /tmux attach -t dle/);
});

test("10 分に 3 回落ちたら自動起動を止めて知らせ、reset で再開する", async () => {
	const { sup, calls, notes, advance } = setup({ windows: [] });
	for (let i = 0; i < 5; i++) {
		await sup.tick();
		advance(60_000);
	}
	assert.equal(spawns(calls).length, 3);
	assert.equal(notes.length, 1);
	sup.reset("kishimen-tool");
	await sup.tick();
	assert.equal(spawns(calls).length, 4);
});

test("繋がったら最初のプロンプトを一度だけ入れる", async () => {
	const { sup, calls } = setup();
	await sup.tick();
	await sup.onRegistered("kishimen-tool");
	await sup.onRegistered("kishimen-tool");
	assert.deepEqual(
		calls.filter((c) => c[0] === "send-keys"),
		[
			["send-keys", "-t", "dle:dle-kishimen-tool", "-l", "/discord-loop-engine:issue-loop"],
			["send-keys", "-t", "dle:dle-kishimen-tool", "Enter"],
		],
	);
});

test("許可確認で止まり続けていたら一度だけ知らせる", async () => {
	const { sup, notes } = setup({
		windows: ["dle-kishimen-tool"],
		live: new Set(["kishimen-tool"]),
		pane: " Do you want to proceed?\n ❯ 1. Yes",
	});
	await sup.tick();
	assert.equal(notes.length, 0, "一瞬の確認では知らせない");
	await sup.tick();
	await sup.tick();
	assert.equal(notes.length, 1);
	assert.match(notes[0]?.[1] ?? "", /許可の確認で止まっています/);
});

test("シェルに渡す引数を安全に囲む", () => {
	assert.equal(shq("plain-arg_1.2"), "plain-arg_1.2");
	assert.equal(shq("Bash(gh issue:*)"), "'Bash(gh issue:*)'");
	assert.equal(shq("it's"), `'it'\\''s'`);
});

test("tmuxSession を指定したセッションは、その tmux セッションで起動する（native のリポジトリが前提にしている名前）", async () => {
	const calls: string[][] = [];
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => [
			{ name: "concierge", cwd: "/h/c", command: "claude --c", initialPrompt: "" },
			{
				name: "oogiri-doc",
				cwd: "/w/o",
				command: "claude --o",
				initialPrompt: "/parallel-cycle-loop",
				tmuxSession: "dev",
			},
		],
		tmux: async (args) => {
			calls.push(args);
			return args[0] === "list-windows" ? { ok: false, stdout: "" } : { ok: true, stdout: "" };
		},
		isLive: () => false,
		notify: () => {},
		promptDelayMs: 0,
	});
	await sup.tick();
	assert.deepEqual(
		calls.filter((c) => c[0] === "new-session").map((c) => [c[3], c[5]]),
		[
			["dle", "dle-concierge"],
			["dev", "dle-oogiri-doc"],
		],
	);
	await sup.onRegistered("oogiri-doc");
	assert.deepEqual(
		calls.find((c) => c[0] === "send-keys"),
		["send-keys", "-t", "dev:dle-oogiri-doc", "-l", "/parallel-cycle-loop"],
	);
});

function refreshSetup(o: {
	events?: number;
	idleMs?: number;
	pane?: string;
	worker?: boolean;
	tokens?: number | null;
	status?: string;
	sessionMissing?: boolean;
	transcriptMissing?: boolean;
	readFailure?: boolean;
	cwd?: string;
	codexFail?: boolean;
	failCommand?: string;
	paneAfterClear?: string;
	sessionMissingAfterClear?: boolean;
	newTokens?: number | null;
	confirmAfter?: number;
	clearConfirmMs?: number;
	onReadTranscript?: () => void;
	logAge?: number;
	subagentAge?: number;
	confirm?: boolean;
	codex?: string;
	worktreeRoot?: string;
	startupError?: string;
	maxTokens?: number;
	maxEvents?: number;
}) {
	const calls: string[][] = [];
	const phases: [string, RefreshResult | undefined][] = [];
	const notes: string[] = [];
	let now = 10 * 60_000;
	let cleared = false;
	let resumed = false;
	let confirmationReads = 0;
	const waits: number[] = [];
	const name = o.worker ? "worker" : "concierge";
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => [
			{
				name,
				cwd: "/c",
				command: "claude",
				startupError: o.startupError,
				initialPrompt: "/loop",
				refresh: {
					prompt: o.worker ? "/loop" : "/discord-loop-engine:concierge refresh",
					maxEvents: o.maxEvents ?? (o.worker ? 0 : 40),
					maxTokens: o.maxTokens ?? 100000,
					contextPercent: 15,
					idleSeconds: 180,
					cooldownMinutes: 30,
					worktreeRoot: o.worktreeRoot,
					waitForCodex: o.worker ?? false,
					codexIgnoreAfterMinutes: 120,
					cwd: "/c",
				},
			},
		],
		tmux: async (args) => {
			calls.push(args);
			if (o.failCommand && args.includes(o.failCommand)) return { ok: false, stdout: "" };
			if (args[0] === "list-windows") return { ok: true, stdout: `dle-${name}` };
			if (args[0] === "list-panes") return { ok: !o.codexFail, stdout: o.codex ?? "" };
			if (args[0] === "capture-pane")
				return {
					ok: true,
					stdout: cleared && o.paneAfterClear !== undefined ? o.paneAfterClear : (o.pane ?? "会話の履歴\n❯ "),
				};
			if (args[0] === "display-message") return { ok: true, stdout: "123" };
			if (args.includes("/clear")) cleared = true;
			if (args.includes("/loop") || args.includes("/discord-loop-engine:concierge refresh")) resumed = true;
			return { ok: true, stdout: "" };
		},
		readSession: async () => {
			if (o.sessionMissing || (cleared && o.sessionMissingAfterClear)) return null;
			if (cleared) confirmationReads++;
			return {
				sessionId: cleared && o.confirm !== false && confirmationReads >= (o.confirmAfter ?? 1) ? "new" : "old",
				cwd: o.cwd ?? "/c",
				status: o.status ?? "idle",
				updatedAt: now - (o.logAge ?? 300000),
			};
		},
		readTranscript: async () => {
			o.onReadTranscript?.();
			return o.readFailure
				? null
				: {
						tokens: resumed
							? (o.newTokens ?? null)
							: o.transcriptMissing
								? null
								: o.tokens === undefined
									? 100000
									: o.tokens,
						mtimeMs: now - (o.logAge ?? 300000),
						subagentMtimeMs: o.subagentAge === undefined ? 0 : now - o.subagentAge,
					};
		},
		isLive: () => true,
		notify: () => {},
		activity: () => ({ events: o.events ?? 0, lastAt: now - (o.idleMs ?? 300000) }),
		onRefresh: (_n, phase, result) => phases.push([phase, result]),
		onRefreshSkipped: (_n, reason) => notes.push(reason),
		now: () => now,
		promptDelayMs: 0,
		clearConfirmMs: o.clearConfirmMs ?? 0,
		wait: async (ms) => {
			waits.push(ms);
		},
	});
	const typed = () => calls.filter((c) => c[0] === "send-keys" && c.includes("-l")).map((c) => c.at(-1));
	return {
		sup,
		waits,
		typed,
		phases,
		notes,
		advance: (ms = 180000) => {
			now += ms;
		},
	};
}

test("起動直後の猶予の後、worker は入力件数がゼロでも閾値ちょうどで clear して起動プロンプトで再開する", async () => {
	const h = refreshSetup({ worker: true });
	await h.sup.tick();
	assert.deepEqual(h.typed(), []);
	h.advance();
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear", "/loop"]);
	assert.equal(h.phases[0]?.[0], "start");
	assert.equal(h.phases[1]?.[1]?.success, true);
	assert.match(h.phases[1]?.[1]?.reason ?? "", /100k/);
});

test("窓口の件数条件はトークン量と独立して残り、refresh 引数で挨拶を抑止する", async () => {
	const h = refreshSetup({ events: 40, tokens: 99999 });
	h.advance();
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear", "/discord-loop-engine:concierge refresh"]);
});

test("待機条件が一つでも欠けると clear しない", async () => {
	for (const o of [
		{ idleMs: 30000 },
		{ status: "busy" },
		{ status: "unknown" },
		{ cwd: "/other" },
		{ readFailure: true, pane: "~100k uncached\n❯ " },
		{ codexFail: true },
		{ sessionMissing: true },
		{ logAge: 30000 },
		{ subagentAge: 30000 },
		{ pane: "❯ 入力途中" },
		{ pane: "❯ \n入力の続き" },
		{ pane: "不明な画面" },
		{ pane: "esc to interrupt\n❯ " },
		{ pane: "Do you want to proceed?\n❯ " },
		{ tokens: 99999 },
		{ maxTokens: 0 },
	]) {
		const h = refreshSetup({ worker: true, ...o });
		h.advance();
		await h.sup.tick();
		assert.deepEqual(h.typed(), [], JSON.stringify(o));
	}
});

test("会話ログを優先し、読めないときは uncached・新旧の残り割合にフォールバックする", async () => {
	for (const pane of [
		"~100k uncached",
		"15% until auto-compact",
		"85% context used",
		"Context left until auto-compact: 15%",
		"15% context left",
	]) {
		const h = refreshSetup({ worker: true, tokens: null, pane: `${pane}\n❯ ` });
		h.advance();
		await h.sup.tick();
		assert.equal(h.typed()[0], "/clear", pane);
	}
	const h = refreshSetup({ worker: true, tokens: 99999, pane: "~200k uncached\n❯ " });
	h.advance();
	await h.sup.tick();
	assert.deepEqual(h.typed(), []);
	const missing = refreshSetup({ worker: true, transcriptMissing: true, pane: "~100k uncached\n❯ " });
	missing.advance();
	await missing.sup.tick();
	assert.equal(missing.typed()[0], "/clear");
});

test("同じプロジェクト配下の Codex だけを待ち、2時間残り続けた窓は無視する", async () => {
	for (const cwd of ["/c", "/c/.worktrees/issue-2", "/other", "/c-other"]) {
		const h = refreshSetup({ worker: true, codex: `codex-impl-2\t${cwd}\t@9` });
		h.advance();
		await h.sup.tick();
		const same = cwd === "/c" || cwd.startsWith("/c/");
		assert.equal(h.typed().length, same ? 0 : 2, cwd);
		if (same) {
			h.advance(120 * 60000);
			await h.sup.tick();
			assert.equal(h.typed()[0], "/clear");
		}
	}
});

test("clear の成功確認ができなければ再開せず、失敗結果を返して冷却する", async () => {
	const h = refreshSetup({ worker: true, confirm: false });
	h.advance();
	await h.sup.tick();
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear"]);
	assert.equal(h.phases[1]?.[1]?.success, false);
	h.advance(30 * 60000);
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear", "/clear"]);
});

test("文脈量不明の通知は状態ごとに一度だけで、冷却中と clear 後の usage 待ちには出さない", async () => {
	const h = refreshSetup({ worker: true, tokens: null });
	h.advance();
	await h.sup.tick();
	await h.sup.tick();
	assert.equal(h.notes.length, 1);
	const ok = refreshSetup({ worker: true });
	ok.advance();
	await ok.sup.tick();
	await ok.sup.tick();
	ok.advance(30 * 60000);
	await ok.sup.tick();
	assert.equal(ok.notes.length, 0);
	assert.deepEqual(ok.typed(), ["/clear", "/loop"]);
});

test("clear の成功確認は1秒間隔・最大15秒で、成功するまで再開を送らない", async () => {
	const delayed = refreshSetup({ worker: true, confirmAfter: 4, clearConfirmMs: 15000 });
	delayed.advance();
	await delayed.sup.tick();
	assert.deepEqual(delayed.waits, [1000, 1000, 1000, 0]);
	assert.deepEqual(delayed.typed(), ["/clear", "/loop"]);
	const failed = refreshSetup({ worker: true, confirm: false, clearConfirmMs: 15000 });
	failed.advance();
	await failed.sup.tick();
	assert.equal(
		failed.waits.reduce((a, b) => a + b, 0),
		15000,
	);
	assert.deepEqual(failed.typed(), ["/clear"]);
});

test("clear 後にセッションが読めないときは、会話が消えた空プロンプトだけを成功の代替にする", async () => {
	const ok = refreshSetup({ worker: true, sessionMissingAfterClear: true, paneAfterClear: "❯ \n" });
	ok.advance();
	await ok.sup.tick();
	assert.deepEqual(ok.typed(), ["/clear", "/loop"]);
	const unknown = refreshSetup({ worker: true, sessionMissingAfterClear: true });
	unknown.advance();
	await unknown.sup.tick();
	assert.deepEqual(unknown.typed(), ["/clear"]);
});

test("tmux への送信失敗も done を呼んで冷却し、再開を送らない", async () => {
	const h = refreshSetup({ worker: true, failCommand: "/clear" });
	h.advance();
	await h.sup.tick();
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear"]);
	assert.equal(h.phases[1]?.[1]?.success, false);
	assert.match(h.phases[1]?.[1]?.reason ?? "", /入力できません/);
});

test("usage が現れたら遷移状態を解除し、次の閾値超過を判定できる", async () => {
	const options = { worker: true, newTokens: null as number | null };
	const h = refreshSetup(options);
	h.advance();
	await h.sup.tick();
	h.advance(30 * 60000);
	await h.sup.tick();
	assert.deepEqual(h.typed(), ["/clear", "/loop"]);
	options.newTokens = 99999;
	await h.sup.tick();
	options.newTokens = 100000;
	await h.sup.tick();
	assert.equal(h.typed().filter((text) => text === "/clear").length, 2);
});

test("並行した tick から二重に clear しない", async () => {
	const h = refreshSetup({ worker: true });
	h.advance();
	await Promise.all([h.sup.tick(), h.sup.tick()]);
	assert.deepEqual(h.typed(), ["/clear", "/loop"]);
});

test("文脈量不明から復旧した後に再び不明になれば見送りを再通知する", async () => {
	const options = { worker: true, tokens: null as number | null };
	const h = refreshSetup(options);
	h.advance();
	await h.sup.tick();
	await h.sup.tick();
	assert.equal(h.notes.length, 1);
	options.tokens = 99999;
	await h.sup.tick();
	options.tokens = null;
	await h.sup.tick();
	assert.equal(h.notes.length, 2);
});

test("待機判定中に新しい入力が届いた場合は clear を見送る", async () => {
	const options = {
		worker: true,
		idleMs: 300000,
		onReadTranscript: () => {
			options.idleMs = 0;
		},
	};
	const h = refreshSetup(options);
	h.advance();
	await h.sup.tick();
	assert.deepEqual(h.typed(), []);
});

test("W6: 外部Codexの境界、壊れた列挙、id/cwdごとの120分観測", async () => {
	for (const cwd of ["/c", "/c/.worktrees/issue-2", "/external/p/issue-2", "/external/p-other/issue-2", "/other"]) {
		const same = cwd === "/c" || cwd.startsWith("/c/") || cwd.startsWith("/external/p/");
		const o = { worker: true, worktreeRoot: "/external/p", codex: `codex-impl-2\t${cwd}\t@9` };
		const h = refreshSetup(o);
		h.advance();
		await h.sup.tick();
		assert.equal(h.typed().length, same ? 0 : 2, cwd);
		if (same) {
			h.advance(120 * 60000);
			o.codex = `codex-impl-2\t${cwd}\t@10`;
			await h.sup.tick();
			assert.equal(h.typed().length, 0);
			h.advance(120 * 60000);
			await h.sup.tick();
			assert.equal(h.typed()[0], "/clear");
		}
	}
	for (const o of [{ codex: "broken" }, { codexFail: true }, { startupError: "p worktreeRoot: invalid" }]) {
		const h = refreshSetup({ worker: true, worktreeRoot: "/external/p", ...o });
		h.advance();
		await h.sup.tick();
		assert.equal(h.typed().length, 0);
	}
	const o = { worker: true, worktreeRoot: "/external/p", codex: "codex-impl-2\t/external/p/issue-2\t@9" };
	const h = refreshSetup(o);
	h.advance();
	await h.sup.tick();
	h.advance(120 * 60000);
	o.codex = "codex-impl-2\t/external/p/issue-3\t@9";
	await h.sup.tick();
	assert.equal(h.typed().length, 0);
});

test("W6: startupErrorは初回からlogと通知、連投せず別projectを起動", async () => {
	const logs: string[] = [],
		notes: string[] = [],
		calls: string[][] = [];
	const reason = "bad worktreeRoot: 文字列/null/未指定で指定してください";
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => [
			{ name: "bad", cwd: "/bad", command: "", initialPrompt: "", startupError: reason },
			{ name: "good", cwd: "/good", command: "claude", initialPrompt: "" },
		],
		tmux: async (args) => {
			calls.push(args);
			return { ok: true, stdout: "" };
		},
		isLive: () => false,
		log: (s) => logs.push(s),
		notify: (n, s) => notes.push(`${n}: ${s}`),
	});
	await sup.tick();
	await sup.tick();
	assert.equal(notes.length, 1);
	assert.ok(logs.some((s) => s.includes(reason)));
	assert.ok(notes[0]?.includes(reason));
	assert.ok(calls.some((c) => c[0] === "new-window" && c.includes("dle-good")));
	assert.ok(!calls.some((c) => c.includes("dle-bad")));
});

// --- idle の worker を起こす（#32） ---------------------------------------------------------
const IDLE = "会話の履歴\n❯ ";

function wakeSetup(
	o: {
		panes?: (string | null)[]; // capture のたびに順に返す（尽きたら最後を繰り返す）
		wake?: boolean;
		live?: boolean;
		status?: string;
		sessionMissing?: boolean;
		logAge?: number;
		failFlags?: Set<string>; // "-l" / "Enter" を失敗させる
		onWait?: () => void;
	} = {},
) {
	const calls: string[][] = [];
	const skipped: string[] = [];
	const state = {
		panes: o.panes ?? [IDLE],
		i: 0,
		live: o.live ?? true,
		fail: o.failFlags ?? new Set<string>(),
		now: 10 * 60_000,
		status: o.status ?? "idle",
	};
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => [
			{
				name: "w",
				cwd: "/c",
				command: "claude",
				initialPrompt: "/other-prompt",
				...(o.wake === false ? {} : { wake: { enabled: true } }),
			},
		],
		tmux: async (args) => {
			calls.push(args);
			if (args[0] === "list-windows") return { ok: true, stdout: "dle-w" };
			if (args[0] === "display-message") return { ok: true, stdout: "123" };
			if (args[0] === "capture-pane") {
				const p = state.panes[Math.min(state.i++, state.panes.length - 1)];
				return p === null || p === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: p };
			}
			if (args[0] === "send-keys") {
				const key = args.includes("-l") ? "-l" : "Enter";
				if (state.fail.has(key)) return { ok: false, stdout: "" };
			}
			return { ok: true, stdout: "" };
		},
		readSession: async () =>
			o.sessionMissing ? null : { sessionId: "s", cwd: "/c", status: state.status, updatedAt: 0 },
		readTranscript: async () => ({
			tokens: 1,
			mtimeMs: state.now - (o.logAge ?? 60_000),
			subagentMtimeMs: 0,
		}),
		isLive: () => state.live,
		notify: () => {},
		onWakeSkipped: (_n, r) => skipped.push(r),
		now: () => state.now,
		promptDelayMs: 0,
		wait: async () => o.onWait?.(),
	});
	const keys = () => calls.filter((c) => c[0] === "send-keys").map((c) => c.slice(3).join(" "));
	return {
		sup,
		calls,
		skipped,
		state,
		keys,
		advance: (ms: number) => {
			state.now += ms;
		},
	};
}

const WAKE = "/discord-loop-engine:issue-loop";

test("起こし: 空の入力欄・idle・静止した画面なら WAKE_PROMPT と Enter を 1 回ずつ送る", async () => {
	const h = wakeSetup();
	h.sup.requestWake("w", "回答 A-1");
	h.sup.requestWake("w", "queued #3");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, "Enter"]);
	await h.sup.wakeTick();
	assert.equal(h.keys().length, 2, "複数の理由は 1 回にまとまり、送信後は pending が残らない");
});

test("起こし: 作業中・確認画面・入力途中・❯ なし・画面が動いている・取得失敗は送らず、直ったら次で送る", async () => {
	for (const bad of ["esc to interrupt\n❯ ", "Do you want to proceed?\n❯ ", "❯ 入力途中", "何もない画面", null]) {
		const h = wakeSetup({ panes: [bad, bad, bad] });
		h.sup.requestWake("w", "dispatch");
		await h.sup.wakeTick();
		assert.deepEqual(h.keys(), [], String(bad));
		h.state.panes = [IDLE];
		h.state.i = 0;
		await h.sup.wakeTick();
		assert.equal(h.keys().length, 2, `直ったら送る: ${bad}`);
	}
	const moving = wakeSetup({ panes: [IDLE, `${IDLE}\n続き`, IDLE] });
	moving.sup.requestWake("w", "dispatch");
	await moving.sup.wakeTick();
	assert.deepEqual(moving.keys(), []);
});

test("起こし: セッションを読めない・idle でない・直前まで動いていた worker には送らない（読めないときの journal は 1 回）", async () => {
	const unreadable = wakeSetup({ sessionMissing: true });
	unreadable.sup.requestWake("w", "dispatch");
	await unreadable.sup.wakeTick();
	await unreadable.sup.wakeTick();
	assert.deepEqual(unreadable.keys(), []);
	assert.equal(unreadable.skipped.length, 1);
	assert.match(unreadable.skipped[0] ?? "", /判定できない/);
	for (const o of [{ status: "busy" }, { logAge: 5_000 }]) {
		const h = wakeSetup(o);
		h.sup.requestWake("w", "dispatch");
		await h.sup.wakeTick();
		assert.deepEqual(h.keys(), [], JSON.stringify(o));
	}
});

test("起こし: 非 live・wake 未設定の target は送らない", async () => {
	const dead = wakeSetup({ live: false });
	dead.sup.requestWake("w", "dispatch");
	await dead.sup.wakeTick();
	assert.deepEqual(dead.keys(), []);
	const native = wakeSetup({ wake: false });
	native.sup.requestWake("w", "dispatch");
	await native.sup.wakeTick();
	assert.deepEqual(native.keys(), []);
});

test("起こし: 判定中に二重に maybeWake が走っても送信は 1 回で、通常 tick と wakeTick が重なっても同じ", async () => {
	let h: ReturnType<typeof wakeSetup>;
	let nested: Promise<void> | null = null;
	h = wakeSetup({
		onWait: () => {
			// probe の待ち中に通常 tick が来る
			nested ??= h.sup.tick();
		},
	});
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	await nested;
	assert.equal(h.keys().filter((k) => k.startsWith("-l")).length, 1);
	assert.equal(h.keys().filter((k) => k === "Enter").length, 1);
});

test("起こし: 成功した送信どうしは 60 秒あける", async () => {
	const h = wakeSetup();
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	h.sup.requestWake("w", "queued #4");
	h.advance(30_000);
	await h.sup.wakeTick();
	assert.equal(h.keys().length, 2);
	h.advance(31_000);
	await h.sup.wakeTick();
	assert.equal(h.keys().length, 4);
});

test("起こし: 送信後に入力欄へコマンドが残っていれば Enter を 1 回だけ足す", async () => {
	// 判定 2 回 + 直前 1 回は空、確認で残っている
	const h = wakeSetup({ panes: [IDLE, IDLE, IDLE, `x\n❯ ${WAKE}`, `x\n❯ ${WAKE}`] });
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, "Enter", "Enter"]);
	assert.equal(h.skipped.length, 1, "それでも残れば journal に残す");
});

test("起こし: -l が失敗したら pending を残し、60 秒以内でも次の tick で最初から再試行する", async () => {
	const h = wakeSetup({ failFlags: new Set(["-l"]) });
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`]);
	h.state.fail.clear();
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, `-l ${WAKE}`, "Enter"]);
});

test("起こし: -l 成功・Enter 失敗なら次は Enter だけ再送し、入力欄が別の文字なら諦める", async () => {
	const h = wakeSetup({ failFlags: new Set(["Enter"]) });
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, "Enter"]);
	h.state.fail.clear();
	h.state.panes = [`x\n❯ ${WAKE}`, `x\n❯ ${WAKE}`, `x\n❯ ${WAKE}`, IDLE];
	h.state.i = 0;
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, "Enter", "Enter"], "-l は再送しない");
	await h.sup.wakeTick();
	assert.equal(h.keys().length, 3, "pending はクリア済み");

	const human = wakeSetup({ failFlags: new Set(["Enter"]) });
	human.sup.requestWake("w", "dispatch");
	await human.sup.wakeTick();
	human.state.fail.clear();
	human.state.panes = ["x\n❯ 人の入力"];
	human.state.i = 0;
	await human.sup.wakeTick();
	assert.equal(human.keys().length, 2, "人の入力には送らない");
	human.state.panes = [IDLE];
	human.state.i = 0;
	await human.sup.wakeTick();
	assert.deepEqual(human.keys().slice(2), [`-l ${WAKE}`, "Enter"], "enterOnly 解除後は通常判定");
});

test("起こし: 判定のあと送信直前に画面が変わったら送らず pending を残す", async () => {
	for (const last of ["esc to interrupt\n❯ ", "❯ 入力", "Do you want to proceed?\n❯ ", null]) {
		const h = wakeSetup({ panes: [IDLE, IDLE, last, IDLE] });
		h.sup.requestWake("w", "dispatch");
		await h.sup.wakeTick();
		assert.deepEqual(h.keys(), [], String(last));
		h.state.panes = [IDLE];
		h.state.i = 0;
		await h.sup.wakeTick();
		assert.equal(h.keys().length, 2);
	}
});

test("起こし: wakeTick は spawn・checkStuck を通さず、tick 中・実行中は何もしない", async () => {
	const calls: string[][] = [];
	const sup = new Supervisor({
		tmuxSession: "dle",
		targets: () => [{ name: "w", cwd: "/c", command: "claude", initialPrompt: "", wake: { enabled: true } }],
		tmux: async (args) => {
			calls.push(args);
			return { ok: true, stdout: args[0] === "list-windows" ? "" : "Do you want to proceed?" };
		},
		isLive: () => true,
		notify: () => {},
	});
	sup.requestWake("w", "dispatch");
	await sup.wakeTick();
	assert.ok(!calls.some((c) => c[0] === "new-window" || c[0] === "new-session"));
	assert.ok(!calls.some((c) => c[0] === "capture-pane"), "ウィンドウが無ければ画面も見ない");
	const h = wakeSetup();
	h.sup.requestWake("w", "dispatch");
	const running = h.sup.wakeTick();
	await h.sup.wakeTick(); // 自身が実行中なら戻る
	await running;
	assert.equal(h.keys().filter((k) => k.startsWith("-l")).length, 1);
});

test("起こし: refreshing 中・needsPrompt 中は送らない", async () => {
	const h = wakeSetup();
	h.sup.requestWake("w", "dispatch");
	(h.sup as unknown as { st(n: string): { refreshing: boolean } }).st("w").refreshing = true;
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), []);
	const p = wakeSetup();
	p.sup.requestWake("w", "dispatch");
	(p.sup as unknown as { st(n: string): { needsPrompt: boolean } }).st("w").needsPrompt = true;
	await p.sup.wakeTick();
	assert.deepEqual(p.keys(), []);
});

test("起こし: 判定中に refreshing が立ったら（再確認で）送らない", async () => {
	let sup: { st(n: string): { refreshing: boolean } } | undefined;
	const h = wakeSetup({
		onWait: () => {
			if (sup) sup.st("w").refreshing = true;
		},
	});
	sup = h.sup as unknown as { st(n: string): { refreshing: boolean } };
	h.sup.requestWake("w", "dispatch");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), []);
});

test("整理: 判定の await 中に起こしが送信を始めたら /clear を送らず見送る", async () => {
	let sup: { st(n: string): { wake: { sending: boolean } } } | undefined;
	const h = refreshSetup({
		worker: true,
		onReadTranscript: () => {
			if (sup) sup.st("worker").wake.sending = true;
		},
	});
	sup = h.sup as unknown as { st(n: string): { wake: { sending: boolean } } };
	h.advance();
	await h.sup.tick();
	assert.deepEqual(h.typed(), []);
	assert.deepEqual(h.phases, []);
});

test("起こし: onRegistered は起動した worker では pending を消し、既存の worker では reconnect を積む（即送らない）", async () => {
	const started = wakeSetup();
	const internal = started.sup as unknown as { st(n: string): { needsPrompt: boolean } };
	started.sup.requestWake("w", "outbox");
	internal.st("w").needsPrompt = true;
	await started.sup.onRegistered("w");
	assert.deepEqual(started.keys(), ["-l /other-prompt", "Enter"]);
	await started.sup.wakeTick();
	assert.equal(started.keys().length, 2, "pending はクリア済みで二重に送らない");

	const existing = wakeSetup();
	await existing.sup.onRegistered("w");
	assert.deepEqual(existing.keys(), [], "即送らない");
	await existing.sup.tick();
	assert.deepEqual(existing.keys(), [`-l ${WAKE}`, "Enter"], "次の tick が拾う");

	const refreshing = wakeSetup();
	(refreshing.sup as unknown as { st(n: string): { refreshing: boolean } }).st("w").refreshing = true;
	await refreshing.sup.onRegistered("w");
	(refreshing.sup as unknown as { st(n: string): { refreshing: boolean } }).st("w").refreshing = false;
	await refreshing.sup.tick();
	assert.deepEqual(refreshing.keys(), [], "refresh 中の再接続は積まない");
});

test("起こし: 判定中に onRegistered が初期プロンプトを入れ始めても WAKE_PROMPT は送らない", async () => {
	const h = wakeSetup();
	const internal = h.sup as unknown as { st(n: string): { needsPrompt: boolean }; o: { wait: () => Promise<void> } };
	let registering: Promise<void> | null = null;
	internal.o.wait = async () => {
		if (registering) return;
		// probe の待ち中に engine が再接続を受けて初期プロンプトの投入を始める
		internal.st("w").needsPrompt = true;
		registering = h.sup.onRegistered("w");
	};
	h.sup.requestWake("w", "outbox");
	await h.sup.wakeTick();
	await registering;
	assert.deepEqual(h.keys(), ["-l /other-prompt", "Enter"], "初期プロンプト 1 回分だけ");
});

test("起こし: 送る文字列は定数のみで、reason や initialPrompt は入らない", async () => {
	const h = wakeSetup();
	h.sup.requestWake("w", "回答 A-1\nrm -rf /; $(evil)");
	await h.sup.wakeTick();
	assert.deepEqual(h.keys(), [`-l ${WAKE}`, "Enter"]);
	assert.ok(!h.calls.flat().some((a) => a.includes("evil") || a.includes("other-prompt")));
});
