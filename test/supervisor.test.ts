// Supervisor が保証すること:
// - 窓口・worker のセッションもウィンドウも無ければ tmux に起動する
// - 繋がっている・ウィンドウがある間は二重に起動しない
// - 起動直後の開発用 channel の確認にだけ自動で答える（フォルダの信頼などには答えない）
// - 起動したのに繋がってこなければ一度だけ知らせる
// - 短時間に落ち続けたら自動起動を止めて知らせ、reset で再開する
// - 繋がったら最初のプロンプトを一度だけ入れる
// - 許可確認で止まり続けていたら一度だけ知らせる
import assert from "node:assert/strict";
import { test } from "node:test";
import { type SessionTarget, Supervisor, shq } from "../src/supervisor.ts";

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
