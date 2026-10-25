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
				initialPrompt: "/loop",
				refresh: {
					prompt: o.worker ? "/loop" : "/discord-loop-engine:concierge refresh",
					maxEvents: o.maxEvents ?? (o.worker ? 0 : 40),
					maxTokens: o.maxTokens ?? 100000,
					contextPercent: 15,
					idleSeconds: 180,
					cooldownMinutes: 30,
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
