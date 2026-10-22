// engine と channel（実際の子プロセス）と dle CLI を、本物の Unix ソケットで繋いで保証すること:
// - 窓口の channel は claude/channel を宣言し、窓口用のツールだけを出す。worker は reply を持たない
// - Discord の発言はすべて窓口へ届き、受け取ったしるしに 👀 が付く
// - 窓口の reply は「[窓口]」付きで元のチャンネルへ返信として送られる
// - harness-notify 相当（dle notify）の承認依頼は A-番号付きで Bot から投稿され、台帳と窓口に残る
// - 「A-1 OK」→ 窓口が attention_answer → worker に回答が届く
// - worker がいない間の指示は、worker が繋がった時に届く
// - フェーズ done で台帳が完了になり、閾値に達すると窓口へ振り返りの依頼が届く
// - ボードは1通を投稿・ピン留めし、以後は書き換える
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import type { Run } from "../src/projects.ts";
import { lineReader } from "../src/protocol.ts";
import type { DiscordMessage } from "../src/route.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "channel", "server.ts");
const DLE = path.join(ROOT, "bin", "dle");
const ME = "111";
const CH = "900";

interface Call {
	kind: string;
	channelId: string;
	content?: string;
	replyTo?: string;
	messageId?: string;
	emoji?: string;
}

function fakeRest() {
	const calls: Call[] = [];
	let n = 0;
	return {
		calls,
		sendMessage: async (channelId: string, m: { content: string; replyTo?: string }) => {
			calls.push({ kind: "send", channelId, content: m.content, replyTo: m.replyTo });
			return { id: `sent${++n}` };
		},
		editMessage: async (channelId: string, messageId: string, content: string) => {
			calls.push({ kind: "edit", channelId, messageId, content });
			return {};
		},
		pin: async (channelId: string, messageId: string) => {
			calls.push({ kind: "pin", channelId, messageId });
			return {};
		},
		react: async (channelId: string, messageId: string, emoji: string) => {
			calls.push({ kind: "react", channelId, messageId, emoji });
			return {};
		},
	};
}

function setupEngine(retroEvery = 5, exec?: Run) {
	// Unix ソケットのパス長制限（約 104 文字）に収まるよう短い場所に作る
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-"));
	const raw = { channelIds: [CH], allowedUserIds: [ME], retro: { everyDoneTasks: retroEvery } };
	writeFileSync(path.join(home, "config.json"), JSON.stringify(raw));
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
		concierge: { model: "sonnet", extraArgs: [], allowedTools: [] },
		worker: { model: null, extraArgs: [], initialPrompt: "/discord-loop-engine:issue-loop" },
		retro: { everyDoneTasks: retroEvery, everyDays: 7, promoteAfter: 3 },
		board: { enabled: true },
	};
	const rest = fakeRest();
	let onMessage: (d: unknown) => void = () => {};
	const engine = new Engine({
		config,
		rest,
		log: () => {},
		boardDebounceMs: 10,
		...(exec ? { exec } : {}),
		gatewayFactory: (h) => {
			onMessage = h.onMessage;
			return { start() {}, stop() {}, connected: true, user: { id: "999", username: "bot" } };
		},
	});
	return { engine, rest, home, discord: (d: DiscordMessage) => onMessage(d) };
}

type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

function startChannel(home: string, env: Record<string, string>) {
	const child: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], {
		env: { ...process.env, DLE_HOME: home, DLE_SOCKET: path.join(home, "engine.sock"), ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const inbox: Rpc[] = [];
	const waiters: { pred: (m: Rpc) => boolean; resolve: (m: Rpc) => void }[] = [];
	child.stdout?.on(
		"data",
		lineReader<Rpc>((m) => {
			inbox.push(m);
			for (const w of [...waiters]) {
				if (w.pred(m)) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(m);
				}
			}
		}),
	);
	let id = 0;
	const next = (pred: (m: Rpc) => boolean, ms = 8000) =>
		new Promise<Rpc>((resolve, reject) => {
			const hit = inbox.find(pred);
			if (hit) {
				inbox.splice(inbox.indexOf(hit), 1);
				resolve(hit);
				return;
			}
			const timer = setTimeout(() => reject(new Error("timeout waiting for channel output")), ms);
			waiters.push({
				pred,
				resolve: (m) => {
					clearTimeout(timer);
					inbox.splice(inbox.indexOf(m), 1);
					resolve(m);
				},
			});
		});
	const rpc = (method: string, params: Record<string, unknown>) => {
		const myId = ++id;
		child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
		return next((m) => m.id === myId);
	};
	const tool = async (name: string, args: Record<string, unknown>) => {
		const r = await rpc("tools/call", { name, arguments: args });
		const content = (r.result?.content as { text: string }[])[0]?.text ?? "";
		return { text: content, isError: r.result?.isError === true };
	};
	const event = (pred: (p: Record<string, unknown>) => boolean = () => true) =>
		next((m) => m.method === "notifications/claude/channel" && pred(m.params ?? {})).then(
			(m) => m.params as { content: string; meta: Record<string, string> },
		);
	return { child, rpc, tool, event, stop: () => child.kill() };
}

const until = async (cond: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 20));
	}
};

function dle(home: string, args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			DLE,
			args,
			{ env: { ...process.env, DLE_HOME: home, DLE_SOCKET: path.join(home, "engine.sock") } },
			(err, stdout, stderr) =>
				resolve({
					code: err ? ((err as { code?: number }).code ?? 1) : 0,
					stdout: String(stdout),
					stderr: String(stderr),
				}),
		);
	});
}

const msg = (content: string, over: Partial<DiscordMessage> = {}): DiscordMessage => ({
	id: `m${Math.random()}`,
	channel_id: CH,
	guild_id: "g",
	author: { id: ME, username: "jonnity" },
	content,
	...over,
});

test("窓口と worker で渡されるツールが違い、Discord の発言は窓口へ届いて reply で返せる", async () => {
	const { engine, rest, home, discord } = setupEngine();
	await engine.start();
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "kishimen-tool" });
	try {
		const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
		assert.deepEqual((init.result?.capabilities as { experimental: object }).experimental, { "claude/channel": {} });
		const ctools = ((await c.rpc("tools/list", {})).result?.tools as { name: string }[]).map((t) => t.name);
		const wtools = ((await w.rpc("tools/list", {})).result?.tools as { name: string }[]).map((t) => t.name);
		assert.ok(ctools.includes("reply") && ctools.includes("attention_answer") && ctools.includes("dispatch"));
		assert.ok(!wtools.includes("reply"), "worker は Discord に直接書けない");
		assert.ok(wtools.includes("report") && wtools.includes("learning_add"));

		await until(() => engine.sessions.has("concierge") && engine.sessions.has("kishimen-tool"));
		discord(msg("kishimen の採点バグ直して", { id: "m1" }));
		const ev = await c.event();
		assert.match(ev.content, /kishimen の採点バグ直して/);
		assert.equal(ev.meta.message_id, "m1");
		await until(() => rest.calls.some((x) => x.kind === "react" && x.emoji === "👀"));

		const r = await c.tool("reply", { text: "承知しました。#12 として起票します", chat_id: CH, reply_to: "m1" });
		assert.equal(r.isError, false);
		const sent = rest.calls.find((x) => x.kind === "send" && x.replyTo === "m1");
		assert.equal(sent?.content, "**[窓口]** 承知しました。#12 として起票します");
		const denied = await w.tool("reply", { text: "x" });
		assert.equal(denied.isError, true);
	} finally {
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("承認依頼は A-番号付きで投稿され、「A-1 OK」が窓口経由で worker に届き、done で振り返りが頼まれる", async () => {
	const { engine, rest, home, discord } = setupEngine(1);
	await engine.start();
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "kishimen-tool" });
	try {
		await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("kishimen-tool"));

		// harness-notify が engine に渡すのと同じ呼び出し
		const n = await dle(home, [
			"notify",
			"--project",
			"kishimen-tool",
			"--event",
			"merge-request",
			"--title",
			"票を破棄",
			"--url",
			"https://github.com/x/pull/34#c1",
			"--issue",
			"12",
			"--pr",
			"34",
			"--body",
			"判定 ✅",
		]);
		assert.equal(n.code, 0, n.stderr);
		assert.equal(n.stdout.trim(), "A-1");
		const post = rest.calls.find((x) => x.kind === "send" && x.content?.includes("A-1"));
		assert.match(
			post?.content ?? "",
			/^\*\*\[kishimen-tool\]\*\* 🟢 A-1 マージ承認｜#12 票を破棄\n判定 ✅\n👉 よければ「A-1 OK」/,
		);
		const notice = await c.event((p) => (p.meta as Record<string, string>).kind === "notice");
		assert.match(notice.content, /A-1 マージ承認/);
		const t = engine.ledger.findTaskByIssue("kishimen-tool", "12");
		assert.equal(t?.status, "waiting-human");

		// Discord で「A-1 OK」→ 窓口に A-1 の中身付きで届く
		discord(msg("A-1 OK", { id: "m2" }));
		const ev = await c.event((p) => (p.meta as Record<string, string>).attention === "A-1");
		assert.equal(ev.meta.kind, "merge");
		assert.equal(ev.meta.pr, "34");
		assert.match(ev.content, /未対応/);

		// 窓口が回答を渡す → worker に届く
		const ans = await c.tool("attention_answer", { id: "A-1", answer: "OK（Discord: jonnity）" });
		assert.equal(ans.isError, false, ans.text);
		const got = await w.event((p) => (p.meta as Record<string, string>).attention === "A-1");
		assert.equal(got.meta.kind, "merge");
		assert.equal(got.meta.issue, "12");
		assert.match(got.content, /OK（Discord: jonnity）/);
		assert.equal(engine.ledger.openAttention().length, 0);

		// マージ後に harness-phase done が報告 → 完了・振り返りの依頼
		const d = await dle(home, [
			"notify",
			"--project",
			"kishimen-tool",
			"--event",
			"phase",
			"--phase",
			"done",
			"--issue",
			"12",
			"--title",
			"票を破棄",
			"--url",
			"u",
		]);
		assert.equal(d.code, 0, d.stderr);
		assert.equal(engine.ledger.task(t?.id ?? "")?.status, "done");
		const retro = await c.event((p) => (p.meta as Record<string, string>).kind === "retro");
		assert.match(retro.content, /retrospective/);

		// ボードは1通を投稿してピン留めし、以後は書き換える
		await until(() => rest.calls.some((x) => x.kind === "pin"));
		await engine.updateBoard();
		assert.ok(rest.calls.some((x) => x.kind === "edit" && x.content?.includes("📋 ボード")));
	} finally {
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("worker がいない間の指示は、繋がった時に届く", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({
		name: "kishimen-tool",
		repo: "jonnity/kishimen-tool",
		path: home,
		active: true,
		mode: "harness",
	});
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	let w: ReturnType<typeof startChannel> | null = null;
	try {
		await until(() => engine.sessions.has("concierge"));
		const r = await c.tool("dispatch", { project: "kishimen-tool", text: "#15 を先に" });
		assert.match(r.text, /queued/);
		w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "kishimen-tool" });
		const ev = await w.event((p) => (p.meta as Record<string, string>).from === "concierge");
		assert.match(ev.content, /#15 を先に/);
	} finally {
		c.stop();
		w?.stop();
		await engine.stop();
	}
});

test("engine 経由でない（DLE_ROLE の無い）セッションは登録せず、ツールも出さない", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	const x = startChannel(home, {});
	try {
		const tools = (await x.rpc("tools/list", {})).result?.tools as unknown[];
		assert.equal(tools.length, 0);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(engine.sessions.size, 0);
	} finally {
		x.stop();
		await engine.stop();
	}
});

test("窓口が起動していない間の Discord の発言は残しておき、起動したら渡す", async () => {
	const { engine, rest, home, discord } = setupEngine();
	await engine.start();
	try {
		discord(msg("おはよう", { id: "m9" }));
		await until(() => rest.calls.some((x) => x.kind === "send" && x.replyTo === "m9"));
		const c = startChannel(home, { DLE_ROLE: "concierge" });
		const ev = await c.event();
		assert.match(ev.content, /おはよう/);
		c.stop();
	} finally {
		await engine.stop();
	}
});

test("harness-notify は engine が動いていれば webhook ではなく engine に渡す（A-番号が付く）", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	const proj = mkdtempSync(path.join(os.tmpdir(), "dle-proj-"));
	await new Promise((r) => execFile("git", ["-C", proj, "init", "-q"], r));
	writeFileSync(path.join(proj, "x"), "");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(path.join(proj, ".claude"));
	writeFileSync(
		path.join(proj, ".claude", "harness.json"),
		JSON.stringify({ project: "kishimen-tool", repo: "jonnity/kishimen-tool" }),
	);
	try {
		const r = await new Promise<{ code: number; stderr: string }>((resolve) =>
			execFile(
				path.join(ROOT, "bin", "harness-notify"),
				[
					"--event",
					"interview",
					"--title",
					"お題の並び替え",
					"--url",
					"https://github.com/x/issues/15#c",
					"--issue",
					"15",
					"--body",
					"Q1. 並び順は？",
				],
				{
					cwd: proj,
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: proj,
						DLE_HOME: home,
						DLE_SOCKET: path.join(home, "engine.sock"),
						DISCORD_WEBHOOK_URL: "",
					},
				},
				(err, _o, stderr) =>
					resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr: String(stderr) }),
			),
		);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /engine 経由/);
		const post = rest.calls.find((x) => x.kind === "send" && x.content?.includes("A-1"));
		assert.match(post?.content ?? "", /^\*\*\[kishimen-tool\]\*\* 🟡 A-1 要件確認｜#15 お題の並び替え/);
	} finally {
		await engine.stop();
	}
});

test("調査した設定の案は A-番号で確認され、OK の回答を受けた worker が確定するとリポジトリの外に保存される", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	const repo = mkdtempSync(path.join(os.tmpdir(), "dle-r-"));
	engine.ledger.upsertProject({
		name: "kishimen-tool",
		repo: "jonnity/kishimen-tool",
		path: repo,
		active: true,
		mode: "harness",
	});
	engine.ledger.createTask({ project: "kishimen-tool", title: "プロジェクトの調査と設定", status: "ai-working" });
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "kishimen-tool", DLE_LOOP: "harness" });
	try {
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("kishimen-tool"));
		const tpl = JSON.parse((await w.tool("profile_template", {})).text);
		assert.ok(Array.isArray(tpl.template.gate) && tpl.examples["kishimen-tool"], "雛形と例を engine から受け取れる");
		const bad = await w.tool("profile_propose", { mode: "harness", profile: { gate: [] }, summary: "x" });
		assert.equal(bad.isError, true, "gate の無い案は受け付けない");
		const r = await w.tool("profile_propose", {
			mode: "harness",
			profile: { gate: [{ name: "test", run: "npm test" }], permissions: ["Bash(npm:*)"] },
			summary: "npm のプロジェクトです",
		});
		assert.equal(r.isError, false, r.text);
		const post = rest.calls.find((x) => x.kind === "send" && x.content?.includes("A-1"));
		assert.match(
			post?.content ?? "",
			/⚙️ A-1 設定の確認｜kishimen-tool の設定\nnpm のプロジェクトです\n検査（PR 前に CI と同じ順で）:\n- test: `npm test`/,
		);
		assert.equal(engine.ledger.tasks()[0]?.status, "waiting-human");

		await c.tool("attention_answer", { id: "A-1", answer: "OK（Discord: jonnity）" });
		const got = await w.event((p) => (p.meta as Record<string, string>).attention === "A-1");
		assert.equal(got.meta.kind, "setup");
		const act = await w.tool("profile_activate", {});
		assert.equal(act.isError, false, act.text);
		const saved = JSON.parse(readFileSync(path.join(home, "projects", "kishimen-tool", "harness.json"), "utf8"));
		assert.deepEqual(saved.gate, [{ name: "test", run: "npm test" }]);
		assert.equal(saved.repo, "jonnity/kishimen-tool");
		assert.ok(!existsSync(path.join(repo, ".claude")), "リポジトリには何も置かない");
		assert.equal(engine.ledger.tasks()[0]?.status, "done");
		assert.equal(
			engine.targets().find((t) => t.name === "kishimen-tool")?.initialPrompt,
			"/discord-loop-engine:issue-loop",
		);
	} finally {
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("native の worker には独自のループで進める案内を出し、ハーネス用の案内は出さない", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "oogiri-doc", DLE_LOOP: "native" });
	try {
		const init = await w.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
		const text = String(init.result?.instructions);
		assert.match(text, /このリポジトリ独自のループ/);
		assert.doesNotMatch(text, /issue-loop スキル/);
	} finally {
		w.stop();
		await engine.stop();
	}
});

test("既定ブランチの CI の新しい失敗だけを知らせる（初回は既存の run を覚えるだけ）", async () => {
	let runs = [
		{ databaseId: 1, status: "completed", conclusion: "failure", workflowName: "CI", displayTitle: "old", url: "u1" },
	];
	const exec: Run = async (cmd, args) => {
		if (cmd === "gh" && args[0] === "repo") return { ok: true, stdout: "main\n", stderr: "" };
		if (cmd === "gh" && args[0] === "run") return { ok: true, stdout: JSON.stringify(runs), stderr: "" };
		return { ok: false, stdout: "", stderr: "" };
	};
	const { engine, rest } = setupEngine(5, exec);
	engine.ledger.upsertProject({
		name: "kishimen-tool",
		repo: "jonnity/kishimen-tool",
		path: "/w",
		active: true,
		mode: "harness",
	});
	await engine.ciTick();
	assert.equal(rest.calls.filter((x) => x.kind === "send").length, 0, "初回は過去の失敗を流さない");
	runs = [
		{ databaseId: 2, status: "completed", conclusion: "success", workflowName: "CI", displayTitle: "ok", url: "u2" },
		{
			databaseId: 3,
			status: "completed",
			conclusion: "failure",
			workflowName: "CI",
			displayTitle: "fix: 票",
			url: "https://run/3",
		},
		{ databaseId: 4, status: "in_progress", conclusion: "", workflowName: "CI", displayTitle: "wip", url: "u4" },
		...runs,
	];
	await engine.ciTick();
	await engine.ciTick();
	const sent = rest.calls.filter((x) => x.kind === "send");
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.content ?? "", /^\*\*\[kishimen-tool\]\*\* 🟠 CI失敗｜CI @ main\nfix: 票\n<https:\/\/run\/3>/);
});

test("マージ後のフェーズ done で、engine がマージ完了を知らせる", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({
		name: "kishimen-tool",
		repo: "jonnity/kishimen-tool",
		path: "/w",
		active: true,
		mode: "harness",
	});
	try {
		const d = await dle(home, [
			"notify",
			"--project",
			"kishimen-tool",
			"--event",
			"phase",
			"--phase",
			"done",
			"--issue",
			"12",
			"--title",
			"票を破棄",
			"--url",
			"u",
			"--pr",
			"34",
		]);
		assert.equal(d.code, 0, d.stderr);
		const sent = rest.calls.find((x) => x.kind === "send" && x.content?.includes("マージ完了"));
		assert.equal(
			sent?.content,
			"**[kishimen-tool]** 🔵 マージ完了｜#12 票を破棄（PR #34）\n<https://github.com/jonnity/kishimen-tool/pull/34>",
		);
	} finally {
		await engine.stop();
	}
});
