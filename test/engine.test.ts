// engine と channel（実際の子プロセス）と dle CLI を、本物の Unix ソケットで繋いで保証すること:
// - 窓口の channel は claude/channel を宣言し、窓口用のツールだけを出す。worker は reply を持たない
// - Discord の発言はすべて窓口へ届き、受け取ったしるしに 👀 が付く
// - 窓口の reply は「[窓口]」付きで元のチャンネルへ返信として送られる
// - harness-notify 相当（dle notify）の承認依頼は A-番号付きで Bot から投稿され、台帳と窓口に残る
// - 「A-1 OK」→ 窓口が attention_answer → worker に回答が届く
// - worker がいない間の指示は、worker が繋がった時に届く
// - フェーズ done で台帳が完了になり、閾値に達すると窓口へ振り返りの依頼が届く
// - ボードは1通を投稿・ピン留めし、以後は書き換える
import "./isolate.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.ts";
import { Engine, limitGaveUpText, limitNoticeText, restartMode } from "../src/engine.ts";
import type { Run } from "../src/projects.ts";
import { type EngineMessage, lineReader, PROTOCOL_VERSION } from "../src/protocol.ts";
import type { DiscordMessage } from "../src/route.ts";
import { Supervisor } from "../src/supervisor.ts";

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
	files?: string[];
	fileContents?: string[];
}

function fakeRest() {
	const calls: Call[] = [];
	const hooks = {
		react: null as null | ((messageId: string, emoji: string) => Promise<void>),
		send: null as null | ((content: string) => Promise<void>),
	};
	let n = 0;
	return {
		calls,
		// テストが印の付与を失敗させたり、完了を手動で止めたりするための差し込み口
		hooks,
		channel: async (id: string) => ({ id, guild_id: "800", type: 0 }),
		sendMessage: async (channelId: string, m: { content: string; replyTo?: string; files?: string[] }) => {
			await hooks.send?.(m.content);
			calls.push({
				kind: "send",
				channelId,
				content: m.content,
				replyTo: m.replyTo,
				files: m.files,
				fileContents: m.files?.map((f) => readFileSync(f, "utf8")),
			});
			return {
				id: String(++n),
				channel_id: channelId,
				attachments: (m.files ?? []).map((file) => ({
					id: "111",
					filename: path.basename(file),
					size: readFileSync(file).length,
					url: "https://cdn.discordapp.com/attachments/456/111/demo.mp4?signature=secret",
				})),
			};
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
			await hooks.react?.(messageId, emoji);
			calls.push({ kind: "react", channelId, messageId, emoji });
			return {};
		},
	};
}

function setupEngine(retroEvery = 5, exec?: Run, existingHome?: string, log: (m: string) => void = () => {}) {
	// Unix ソケットのパス長制限（約 104 文字）に収まるよう短い場所に作る
	const home = existingHome ?? mkdtempSync(path.join(os.tmpdir(), "dle-"));
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
				enabled: true,
				maxTokens: 100000,
				contextPercent: 15,
				idleSeconds: 180,
				cooldownMinutes: 30,
				codexIgnoreAfterMinutes: 120,
			},
		},
		retro: { everyDoneTasks: retroEvery, everyDays: 7, promoteAfter: 3 },
		board: { enabled: true },
	};
	const rest = fakeRest();
	let onMessage: (d: unknown) => void = () => {};
	const engine = new Engine({
		config,
		rest,
		log,
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
	const events: Rpc[] = [];
	const waiters: { pred: (m: Rpc) => boolean; resolve: (m: Rpc) => void }[] = [];
	child.stdout?.on(
		"data",
		lineReader<Rpc>((m) => {
			inbox.push(m);
			if (m.method === "notifications/claude/channel") events.push(m);
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
	const tool = async (name: string, args: unknown) => {
		const r = await rpc("tools/call", { name, arguments: args });
		const content = (r.result?.content as { text: string }[])[0]?.text ?? "";
		return { text: content, isError: r.result?.isError === true };
	};
	const event = (pred: (p: Record<string, unknown>) => boolean = () => true) =>
		next((m) => m.method === "notifications/claude/channel" && pred(m.params ?? {})).then(
			(m) => m.params as { content: string; meta: Record<string, string> },
		);
	return { child, rpc, tool, event, events, stop: () => child.kill() };
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
		assert.equal(sent?.content, "💬 **[窓口]** 返信\n承知しました。#12 として起票します\n───");
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
			/^🟢 \*\*\[kishimen-tool\]\*\* マージ承認 A-1｜#12\n票を破棄\n判定 ✅\n👉 よければ「A-1 OK」[\s\S]*\n───$/,
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
	writeFileSync(path.join(proj, "x"), "");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(path.join(proj, ".claude"));
	writeFileSync(
		path.join(proj, ".claude", "harness.json"),
		JSON.stringify({ project: "kishimen-tool", repo: "jonnity/kishimen-tool", hooks: {}, notify: { envFiles: [] } }),
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
						HARNESS_CONFIG: path.join(proj, ".claude/harness.json"),
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
		assert.match(post?.content ?? "", /^🟡 \*\*\[kishimen-tool\]\*\* 要件確認 A-1｜#15\nお題の並び替え/);
	} finally {
		await engine.stop();
	}
});

test("調査した設定の案は A-番号で確認され、OK の回答を受けた worker が確定するとリポジトリの外に保存される", async () => {
	const commands: string[] = [];
	const { engine, rest, home } = setupEngine(5, async (cmd) => {
		commands.push(path.basename(cmd));
		return { ok: true, stdout: "", stderr: "" };
	});
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
			/⚙️ \*\*\[kishimen-tool\]\*\* 設定の確認 A-1\nkishimen-tool の設定\nnpm のプロジェクトです\nworktreeRoot（既定）: `[^\n]+`\n検査（PR 前に CI と同じ順で）:\n- test: `npm test`/,
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
		assert.ok(commands.includes("harness-labels"), "harness に確定したらラベルを作る");
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

test("モードを切り替えると、native の設定を消して harness の調査から始め直し、native へは command 付きで戻せる", async () => {
	const commands: string[] = [];
	const { engine, home } = setupEngine(5, async (cmd) => {
		commands.push(path.basename(cmd));
		return { ok: true, stdout: "", stderr: "" };
	});
	await engine.start();
	engine.ledger.upsertProject({
		name: "oogiri-doc",
		repo: "jonnity/oogiri-doc",
		path: "/w/oogiri-doc",
		active: true,
		mode: "native",
		initialPrompt: "/parallel-cycle-loop",
		tmuxSession: "dev",
	});
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	try {
		await until(() => engine.sessions.has("concierge"));
		const r = await c.tool("project_mode", { name: "oogiri-doc", mode: "harness" });
		assert.equal(r.isError, false, r.text);
		const p = engine.ledger.projects()[0];
		assert.equal(p?.mode, "harness");
		assert.equal(p?.initialPrompt, undefined);
		assert.equal(p?.tmuxSession, undefined, "native 用のセッション指定は引き継がない");
		assert.deepEqual(
			engine.ledger.tasks().map((t) => t.title),
			["プロジェクトの調査と設定"],
			"設定が無いので調査から始める",
		);
		assert.equal(
			engine.targets().find((t) => t.name === "oogiri-doc")?.initialPrompt,
			"/discord-loop-engine:onboard harness",
			"人が harness に決めたので、調査で native を提案させない",
		);
		assert.ok(!commands.includes("harness-labels"), "設定が確定するまでラベルは作らない");

		const bad = await c.tool("project_mode", { name: "oogiri-doc", mode: "native" });
		assert.equal(bad.isError, true, "native に戻すにはループのコマンドが要る");
		const back = await c.tool("project_mode", { name: "oogiri-doc", mode: "native", command: "/parallel-cycle-loop" });
		assert.equal(back.isError, false, back.text);
		assert.equal(engine.targets().find((t) => t.name === "oogiri-doc")?.initialPrompt, "/parallel-cycle-loop");
	} finally {
		c.stop();
		await engine.stop();
	}
});

test("設定の案の hooks は、使えるフェーズとコマンドの配列だけを受け付け、確認の依頼に載せる", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({
		name: "oogiri-doc",
		repo: "jonnity/oogiri-doc",
		path: "/w/o",
		active: true,
		mode: "harness",
	});
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "oogiri-doc", DLE_LOOP: "harness" });
	try {
		await until(() => engine.sessions.has("oogiri-doc"));
		const gate = [{ name: "lint", run: "pnpm check:ci" }];
		const typo = await w.tool("profile_propose", {
			mode: "harness",
			profile: { gate, hooks: { afterWorkTree: ["x"] } },
			summary: "s",
		});
		assert.equal(typo.isError, true, "フェーズ名の書き間違いは受け付けない");
		const notList = await w.tool("profile_propose", {
			mode: "harness",
			profile: { gate, hooks: { beforePR: "pnpm ci:local" } },
			summary: "s",
		});
		assert.equal(notList.isError, true);
		const ok = await w.tool("profile_propose", {
			mode: "harness",
			profile: {
				gate,
				hooks: { afterWorktree: ["ln -sf {main}/.env .env", "pnpm install"], beforePR: ["pnpm ci:local"] },
			},
			summary: "s",
		});
		assert.equal(ok.isError, false, ok.text);
		const post = rest.calls.find((x) => x.kind === "send" && x.content?.includes("A-1"));
		assert.match(
			post?.content ?? "",
			/差し込み口:\n- afterWorktree: `ln -sf \{main\}\/\.env \.env` → `pnpm install`\n- beforePR: `pnpm ci:local`/,
		);
	} finally {
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
	assert.match(
		sent[0]?.content ?? "",
		/^🟠 \*\*\[kishimen-tool\]\*\* CI失敗\nCI @ main\nfix: 票\n<https:\/\/run\/3>\n───$/,
	);
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
			"🔵 **[kishimen-tool]** マージ完了｜#12\n票を破棄（PR #34）\n<https://github.com/jonnity/kishimen-tool/pull/34>\n───",
		);
	} finally {
		await engine.stop();
	}
});

test("窓口を /clear している間に届いた発言は溜めて、終わったら直近のやり取りと一緒に渡す", async () => {
	const { engine, rest, home, discord } = setupEngine();
	await engine.start();
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	try {
		await until(() => engine.sessions.has("concierge"));
		discord(msg("今どう？", { id: "m1" }));
		await c.event((p) => String(p.content).includes("今どう？"));
		await c.tool("reply", { text: "待機中です", chat_id: CH, reply_to: "m1" });
		assert.equal(engine.activity("concierge").events, 1);

		engine.ledger.setRules("復帰時の仮ルール");
		engine.onRefresh("concierge", "start");
		discord(msg("kishimen の件どうなった？", { id: "m2" }));
		await until(() => rest.calls.some((x) => x.kind === "react" && x.emoji === "👀"));
		assert.ok(
			!rest.calls.some((x) => x.kind === "send" && x.content?.includes("起動していない")),
			"/clear の最中は起動していない扱いにしない",
		);
		engine.onRefresh("concierge", "done");
		assert.equal((await c.event()).meta.kind, "rules");
		const handoff = await c.event();
		assert.equal(handoff.meta.kind, "handoff");
		assert.match(handoff.content, /ユーザー: 今どう？\n窓口: 待機中です/);
		const held = await c.event((p) => String(p.content).includes("kishimen の件どうなった？"));
		assert.equal(held.meta.message_id, "m2");
		assert.equal(engine.activity("concierge").events, 0, "/clear したら数え直す");
	} finally {
		c.stop();
		await engine.stop();
	}
});

// 設定の案を出し、OK の回答を受けて worker が確定するまで（ラベルの作成の有無を見るための共通の流れ）
async function activateProfile(exec: Run, propose: Record<string, unknown>) {
	const { engine, home } = setupEngine(5, exec);
	await engine.start();
	const repo = mkdtempSync(path.join(os.tmpdir(), "dle-r-"));
	engine.ledger.upsertProject({
		name: "kishimen-tool",
		repo: "jonnity/kishimen-tool",
		path: repo,
		active: true,
		mode: "harness",
	});
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "kishimen-tool", DLE_LOOP: "harness" });
	try {
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("kishimen-tool"));
		const r = await w.tool("profile_propose", { summary: "調べました", ...propose });
		assert.equal(r.isError, false, r.text);
		await c.tool("attention_answer", { id: "A-1", answer: "OK" });
		await w.event((p) => (p.meta as Record<string, string>).attention === "A-1");
		return await w.tool("profile_activate", {});
	} finally {
		c.stop();
		w.stop();
		await engine.stop();
	}
}

test("native に確定したときは harness:* ラベルを作らない（使わないラベルをリポジトリに残さない）", async () => {
	const commands: string[] = [];
	const act = await activateProfile(
		async (cmd) => {
			commands.push(path.basename(cmd));
			return { ok: true, stdout: "", stderr: "" };
		},
		{ mode: "native", initial_prompt: "/parallel-cycle-loop" },
	);
	assert.equal(act.isError, false, act.text);
	assert.ok(!commands.includes("harness-labels"));
});

test("ラベルを作れなくても harness の確定は成功し、warning で知らせる", async () => {
	const act = await activateProfile(
		async (cmd) =>
			path.basename(cmd) === "harness-labels"
				? { ok: false, stdout: "", stderr: "HTTP 403: forbidden" }
				: { ok: true, stdout: "", stderr: "" },
		{ mode: "harness", profile: { gate: [{ name: "test", run: "npm test" }] } },
	);
	assert.equal(act.isError, false, act.text);
	assert.match(act.text, /harness:\* ラベルを作れませんでした.*403/);
});

function journal(home: string) {
	const dir = path.join(home, "journal");
	return readdirSync(dir)
		.map((f) => readFileSync(path.join(dir, f), "utf8"))
		.join("\n");
}

test("worker の clear 中の A-番号付き返信は保留され、rules → outbox の順で戻り台帳を変えない", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
	try {
		await until(() => engine.sessions.has("worker"));
		engine.ledger.setRules("人の承認を待つ");
		engine.ledger.createTask({ project: "worker", title: "実装中", status: "ai-working" });
		engine.ledger.addAttention({
			project: "worker",
			kind: "merge",
			title: "承認",
			url: "u",
			issue: "2",
			pr: "3",
			taskId: "",
			summary: "確認",
		});
		const tasks = engine.ledger.tasks();
		const attention = engine.ledger.attention();
		engine.deliver("worker", "先の入力", {});
		await w.event();
		engine.onRefresh("worker", "start");
		assert.equal(engine.deliver("worker", "A-1 OK", { attention: "A-1" }), "held");
		assert.equal(engine.deliver("worker", "次の入力", {}), "held");
		const outbox = path.join(home, "outbox", "worker.jsonl");
		assert.equal(readFileSync(outbox, "utf8").trim().split("\n").length, 2);
		engine.onRefresh("worker", "done", { success: true, reason: "文脈 100k（閾値 100k）" });
		assert.equal((await w.event()).meta.kind, "rules");
		const first = await w.event();
		assert.equal(first.content, "A-1 OK");
		assert.equal(first.meta.attention, "A-1");
		assert.equal((await w.event()).content, "次の入力");
		assert.equal(readFileSync(outbox, "utf8"), "");
		assert.deepEqual(engine.ledger.tasks(), tasks);
		assert.deepEqual(engine.ledger.attention(), attention);
		assert.equal(engine.activity("worker").events, 0);
		assert.match(journal(home), /\[worker\] コンテキストを整理.*100k/);
	} finally {
		w.stop();
		await engine.stop();
	}
});

test("clear 失敗時は活動をリセットせず、rules と handoff を送らず保留分を返し失敗だけ記録する", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	try {
		await until(() => engine.sessions.has("concierge"));
		engine.ledger.setRules("仮ルール");
		engine.deliver("concierge", "既存の会話", {});
		await c.event();
		const before = engine.activity("concierge");
		engine.onRefresh("concierge", "start");
		engine.deliver("concierge", "保留分", {});
		engine.onRefresh("concierge", "done", { success: false, reason: "sessionId が変わらない" });
		assert.equal((await c.event()).content, "保留分");
		assert.deepEqual(engine.activity("concierge"), before);
		assert.match(journal(home), /コンテキストの整理に失敗.*sessionId/);
		assert.doesNotMatch(journal(home), /コンテキストを整理（/);
	} finally {
		c.stop();
		await engine.stop();
	}
});

test("clear 中に切断しても outbox は保持され、再接続で rules と保留分が届く", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	let w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
	try {
		await until(() => engine.sessions.has("worker"));
		engine.ledger.setRules("復帰時のルール");
		engine.onRefresh("worker", "start");
		engine.deliver("worker", "保留中", { attention: "A-2" });
		w.stop();
		await until(() => !engine.sessions.has("worker"));
		engine.onRefresh("worker", "done", { success: true, reason: "100k" });
		w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
		assert.equal((await w.event()).meta.kind, "rules");
		assert.equal((await w.event()).meta.attention, "A-2");
	} finally {
		w.stop();
		await engine.stop();
	}
});

test("clear の途中で再接続しても保留分を先に消費せず、done で rules → outbox の順を保つ", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	let w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
	try {
		await until(() => engine.sessions.has("worker"));
		engine.onRefresh("worker", "start");
		engine.ledger.setRules("再接続時も順番を守る");
		engine.deliver("worker", "clear の間の返信", { attention: "A-3" });
		w.stop();
		await until(() => !engine.sessions.has("worker"));
		w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
		await until(() => engine.sessions.has("worker"));
		assert.match(readFileSync(path.join(home, "outbox", "worker.jsonl"), "utf8"), /A-3/);
		engine.onRefresh("worker", "done", { success: true, reason: "100k" });
		assert.equal((await w.event()).meta.kind, "rules");
		assert.equal((await w.event()).meta.attention, "A-3");
	} finally {
		w.stop();
		await engine.stop();
	}
});

test("clear の start 後に engine を作り直しても、ディスクの outbox を再接続時に受け取れる", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	engine.ledger.setRules("再起動後も渡す");
	engine.ledger.createTask({ project: "worker", title: "作業の続き", status: "ai-working" });
	const tasks = engine.ledger.tasks();
	engine.onRefresh("worker", "start");
	assert.equal(engine.deliver("worker", "A-4 の返事", { attention: "A-4" }), "held");
	await engine.stop();
	const recovered = setupEngine(5, undefined, home).engine;
	await recovered.start();
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "worker" });
	try {
		assert.equal((await w.event()).meta.kind, "rules");
		const held = await w.event();
		assert.equal(held.content, "A-4 の返事");
		assert.equal(held.meta.attention, "A-4");
		assert.deepEqual(recovered.ledger.tasks(), tasks);
		assert.equal(readFileSync(path.join(home, "outbox", "worker.jsonl"), "utf8"), "");
	} finally {
		w.stop();
		await recovered.stop();
	}
});

test("preflight は不正形を保存前に拒否し、確認本文と保存に有効な設定を含める", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({ name: "quality", repo: "example/project", path: home, active: true, mode: "harness" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "quality", DLE_LOOP: "harness" });
	try {
		await until(() => engine.sessions.has("quality"));
		const gate = [{ name: "test", run: "true" }];
		for (const preflight of [{}, [null], [{ name: " ", run: "true" }], [{ name: "x", run: "" }]]) {
			const r = await w.tool("profile_propose", {
				mode: "harness",
				summary: "環境調査済み",
				profile: { gate, preflight },
			});
			assert.equal(r.isError, true, JSON.stringify(preflight));
			assert.match(r.text, /profile\.preflight/);
			assert.equal(engine.ledger.openAttention().length, 0);
			assert.ok(!existsSync(path.join(home, "projects", "quality", "draft.json")));
		}
		const preflight = [{ name: "runners", run: "echo online" }];
		const r = await w.tool("profile_propose", {
			mode: "harness",
			summary: "環境調査済み",
			profile: { gate, preflight },
		});
		assert.equal(r.isError, false, r.text);
		assert.ok(rest.calls.some((c) => c.content?.includes("環境確認（CI 検査より前）:\n- runners: `echo online`")));
		assert.deepEqual(engine.ledger.draft("quality")?.profile?.preflight, preflight);
	} finally {
		w.stop();
		await engine.stop();
	}
});

test("承認の明示添付は欠落・空・ディレクトリを拒否し、長文の最後の投稿に実ファイルを渡す", async () => {
	const { engine, rest, home } = setupEngine();
	await engine.start();
	const file = path.join(home, "demo.mp4");
	const args = [
		"notify",
		"--project",
		"quality",
		"--event",
		"merge-request",
		"--title",
		"動画",
		"--url",
		"https://example.test",
		"--file",
	];
	try {
		for (const invalid of [file, home]) {
			const r = await dle(home, [...args, invalid]);
			assert.equal(r.code, 1, r.stderr);
			assert.equal(engine.ledger.openAttention().length, 0);
		}
		writeFileSync(file, "");
		assert.equal((await dle(home, [...args, file])).code, 1);
		writeFileSync(file, "movie");
		const r = await dle(home, [...args, file, "--body", `${"あ".repeat(5000)}\n動画 demo.mp4 は最後の投稿に添付`]);
		assert.equal(r.code, 0, r.stderr);
		const posts = rest.calls.filter((c) => c.kind === "send" && !c.content?.includes("📋 ボード"));
		assert.ok(posts.length > 1);
		assert.deepEqual(posts.at(-1)?.files, [file]);
		assert.deepEqual(posts.at(-1)?.fileContents, ["movie"]);
		assert.ok(posts.some((c) => c.content?.includes("最後の投稿")));
		assert.ok(posts.slice(0, -1).every((c) => !c.files?.length));
	} finally {
		await engine.stop();
	}
});

for (const mode of ["success", "send-failure", "read-failure"] as const) {
	test(`承認動画: engine の送信待機と ${mode} の応答まで一時ファイルを保持する`, async () => {
		const { engine, rest, home } = setupEngine();
		await engine.start();
		const { mkdirSync } = await import("node:fs");
		mkdirSync(path.join(home, ".claude"));
		mkdirSync(path.join(home, "tmp"));
		writeFileSync(
			path.join(home, ".claude/harness.json"),
			JSON.stringify({ project: "quality", repo: "example/project", hooks: {}, notify: { envFiles: [] } }),
		);
		const input = path.join(home, "demo.webm");
		writeFileSync(input, "source");
		const mediaLog = path.join(home, "media.log");
		let prepared = "";
		let release: () => void = () => {};
		const pending = new Promise<void>((r) => {
			release = r;
		});
		const sendMessage = rest.sendMessage;
		rest.sendMessage = async (channel, m) => {
			if (m.files?.length) {
				prepared = m.files[0] ?? "";
				writeFileSync(path.join(home, "copy"), readFileSync(prepared));
				await pending;
				if (mode === "send-failure") throw new Error("送信失敗");
				if (mode === "read-failure") (await import("node:fs")).unlinkSync(prepared);
			}
			return sendMessage(channel, m);
		};
		const result = new Promise<{ code: number; stderr: string }>((resolve) => {
			execFile(
				path.join(ROOT, "bin/harness-phase"),
				["3", "awaiting-merge", "--pr", "5", "--comment", "説明", "--file", input],
				{
					timeout: 15000,
					cwd: home,
					env: {
						...process.env,
						HARNESS_CONFIG: path.join(home, ".claude/harness.json"),
						PATH: `${ROOT}/tests/harness/fixtures/media:${ROOT}/tests/harness/fixtures:${process.env.PATH}`,
						CLAUDE_PROJECT_DIR: home,
						DLE_HOME: home,
						DLE_SOCKET: path.join(home, "engine.sock"),
						PHASE_STUB: "1",
						MEDIA_MODE: "webm",
						MEDIA_LOG: mediaLog,
						SENT_COPY: path.join(home, "copy"),
						NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${ROOT}/tests/harness/fixtures/media/receipt-fetch.ts`,
						POST_BODY: path.join(home, "body"),
						TMPDIR: path.join(home, "tmp"),
						DISCORD_WEBHOOK_URL: "https://example.test/webhook",
					},
				},
				(err, _stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stderr }),
			);
		});
		try {
			await until(() => prepared !== "");
			assert.ok(existsSync(prepared));
			assert.match(readFileSync(mediaLog, "utf8"), /label\ncomment/);
			release();
			const r = await result;
			assert.equal(r.code, mode === "success" ? 0 : 4, r.stderr);
			assert.ok(!existsSync(prepared));
			assert.deepEqual(readdirSync(path.join(home, "tmp")), []);
			if (mode !== "success") {
				assert.match(
					JSON.parse(readFileSync(path.join(home, "gh-state.json"), "utf8")).comments.at(-1).body,
					/harness:pending/,
				);
			} else assert.match(readFileSync(mediaLog, "utf8"), /label/);
		} finally {
			release();
			await result;
			await engine.stop();
		}
	});
}

// status.json など接続監視だけの変化を除き、業務データをバイト列で比較する。
function businessSnapshot(home: string) {
	const files: Record<string, string> = {};
	function visit(dir: string) {
		for (const item of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, item.name);
			if (item.isDirectory()) visit(file);
			else if (item.isFile() && item.name !== "status.json")
				files[path.relative(home, file)] = readFileSync(file).toString("base64");
		}
	}
	visit(home);
	return files;
}

function startCliSocket(home: string) {
	const socket = net.createConnection(path.join(home, "engine.sock"));
	const messages: EngineMessage[] = [];
	let error: Error | undefined;
	socket.on("error", (e) => {
		error = e;
	});
	socket.on(
		"data",
		lineReader<EngineMessage>((m) => messages.push(m)),
	);
	socket.on("connect", () =>
		socket.write(
			`${JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, role: "cli", pid: process.pid, cwd: home })}\n`,
		),
	);
	let seq = 0;
	const welcome = async () => {
		await until(() => {
			if (error) throw error;
			return messages.some((m) => m.type === "welcome");
		});
		assert.deepEqual(
			messages.find((m) => m.type === "welcome"),
			{ type: "welcome", role: "cli", permissionRelay: false },
		);
	};
	const call = async (name: string, args?: unknown) => {
		const id = `validation-${++seq}`;
		socket.write(`${JSON.stringify({ type: "call", id, name, args })}\n`);
		await until(() => {
			if (error) throw error;
			return messages.some((m) => m.type === "result" && m.id === id);
		});
		const result = messages.find(
			(m): m is Extract<EngineMessage, { type: "result" }> => m.type === "result" && m.id === id,
		);
		assert.ok(result);
		assert.equal(result.id, id);
		return result;
	};
	return { socket, welcome, call };
}

function assertMcpError(result: { text: string; isError: boolean }, ...parts: string[]) {
	assert.equal(result.isError, true, result.text);
	assert.match(result.text, /^失敗: /);
	for (const part of parts) assert.ok(result.text.includes(part), result.text);
}

test("引数検査: MCP 実経路の拒否は保存・配信・投稿・台帳を変えず、後続呼出しも応答する", async () => {
	const { engine, rest, home } = setupEngine(5, async () => {
		throw new Error("外部コマンドは禁止");
	});
	engine.config.board.enabled = false;
	await engine.start();
	for (const name of ["live", "stopped"])
		engine.ledger.upsertProject({ name, repo: "example/project", path: home, active: true, mode: "harness" });
	const task = engine.ledger.createTask({ project: "live", title: "既存タスク", issue: "10" });
	const { attention } = engine.ledger.addAttention({
		taskId: task.id,
		project: "live",
		issue: "10",
		pr: "",
		kind: "interview",
		title: "確認",
		url: "",
		summary: "既存の確認",
	});
	engine.ledger.addLearning({ project: "live", issue: "10", tag: "ci-red", summary: "既存の学び", detail: "詳細" });
	engine.ledger.saveState({ doneSinceRetro: 2, lastRetroAt: new Date().toISOString() });
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "live" });
	try {
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("live"));
		const content = "# 仮ルール\n日本語の規則";
		const saved = await c.tool("rules_set", { content });
		assert.equal(saved.isError, false, saved.text);
		assert.deepEqual(JSON.parse(saved.text), { ok: true });
		const event = await w.event((p) => (p.meta as Record<string, string>).kind === "rules");
		assert.equal(event.meta.kind, "rules");
		assert.equal(event.content, `仮ルールが更新されました:\n${content}`);
		const before = businessSnapshot(home);
		const posts = [...rest.calls];
		const notifications = w.events.length;
		for (const project of ["live", "stopped"]) {
			for (const args of [{ message: "指示" }, {}, { text: "" }, { text: 123 }, { text: "正規", message: "誤名" }]) {
				const result = await c.tool("dispatch", { project, task_id: task.id, ...args });
				assertMcpError(result, "dispatch", "text");
				if ("message" in args) assertMcpError(result, "message", "text を指定してください", "許可");
				assert.deepEqual(businessSnapshot(home), before);
			}
		}
		assertMcpError(await c.tool("dispatch", { text: "指示" }), "project", "必要");
		for (const args of [
			{ text: "新ルール" },
			{},
			{ content: "" },
			{ content: 123 },
			{ content: "新ルール", typo: true },
		]) {
			const result = await c.tool("rules_set", args);
			assertMcpError(result, "rules_set", "content");
			if ("text" in args) assertMcpError(result, "text", "content を指定してください", "許可");
			assert.equal((await c.tool("rules_get", {})).text, `${content}\n`);
			assert.equal(readFileSync(path.join(home, "learnings", "rules.md"), "utf8"), `${content}\n`);
			assert.deepEqual(businessSnapshot(home), before);
		}
		for (const [name, args, key] of [
			["reply", {}, "text"],
			["reply", { text: "投稿", files: [1] }, "files[0]"],
			["task_create", { project: "live" }, "title"],
			["attention_answer", { id: attention.id }, "answer"],
			["learning_add", { tag: "ci-red" }, "summary"],
			["retro_done", {}, "summary"],
			["learnings_promote", {}, "indexes"],
			["learnings_promote", { indexes: ["0"] }, "indexes[0]"],
		] as const) {
			assertMcpError(await c.tool(name, args), name, key);
			assert.deepEqual(businessSnapshot(home), before);
		}
		assertMcpError(
			await w.tool("profile_propose", { mode: "harness", profile: { gate: [{ name: "test", run: "true" }] } }),
			"profile_propose",
			"summary",
		);
		for (const raw of [null, [], "x", 1, false]) {
			assertMcpError(await c.tool("rules_get", raw), "rules_get", "object");
			assertMcpError(await c.tool("reply", raw), "reply", "object");
		}
		// 同じ接続へのマーカー応答で、先行するイベントの収集完了を待つ。
		engine.deliver("live", "検査完了", { kind: "test-sync" });
		await w.event((p) => (p.meta as Record<string, string>).kind === "test-sync");
		assert.equal(w.events.length, notifications + 1);
		assert.deepEqual(rest.calls, posts);
		assert.deepEqual(businessSnapshot(home), before);
		assert.equal(c.child.exitCode, null);
		assert.equal((await c.tool("rules_get", {})).text, `${content}\n`);
		const nextContent = "# 更新後\n次の規則\n";
		const next = await c.tool("rules_set", { content: nextContent });
		assert.equal(next.isError, false, next.text);
		assert.deepEqual(JSON.parse(next.text), { ok: true });
		assert.equal((await c.tool("rules_get", {})).text, nextContent);
		assert.equal(readFileSync(path.join(home, "learnings", "rules.md"), "utf8"), nextContent);
		assert.equal(
			(await w.event((p) => (p.meta as Record<string, string>).kind === "rules")).content,
			`仮ルールが更新されました:\n${nextContent}`,
		);
		const later = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "stopped" });
		try {
			const restored = await later.event((p) => (p.meta as Record<string, string>).kind === "rules");
			assert.equal(restored.content, `現在の仮ルール（learnings/rules.md）:\n${nextContent}`);
		} finally {
			later.stop();
		}
	} finally {
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("引数検査: CLI ソケットと実 dle notify はエラーを返し、同じ接続で続行できる", async (t) => {
	const { engine, rest, home } = setupEngine(5, async () => {
		throw new Error("外部コマンドは禁止");
	});
	engine.config.board.enabled = false;
	await engine.start();
	for (const name of ["live", "stopped"])
		engine.ledger.upsertProject({ name, repo: "example/project", path: home, active: true, mode: "harness" });
	const task = engine.ledger.createTask({ project: "live", title: "既存タスク" });
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "live" });
	const cli = startCliSocket(home);
	try {
		await cli.welcome();
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("live"));
		assert.deepEqual((await cli.call("rules_set", { content: "# 旧ルール\n保存済み" })).data, { ok: true });
		await w.event((p) => (p.meta as Record<string, string>).kind === "rules");
		engine.supervisor = new Supervisor({
			tmuxSession: "test",
			targets: () => [],
			tmux: async () => {
				throw new Error("実 tmux は禁止");
			},
			isLive: () => true,
			notify: () => {},
		});
		const restart = t.mock.method(engine.supervisor, "restart", async () => {});
		const before = businessSnapshot(home);
		const posts = [...rest.calls];
		const notifications = w.events.length;
		for (const project of ["live", "stopped"]) {
			for (const args of [{ message: "指示" }, {}, { text: "" }, { text: 1 }, { text: "指示", typo: "x" }]) {
				const r = await cli.call("dispatch", { project, task_id: task.id, ...args });
				assert.equal(r.ok, false);
				assert.equal(Object.hasOwn(r, "data"), false);
				assert.match(r.error ?? "", /dispatch.*text/);
				if ("message" in args) assert.match(r.error ?? "", /message.*text.*許可/);
				assert.deepEqual(businessSnapshot(home), before);
			}
		}
		for (const [name, args, parts] of [
			["dispatch", { text: "指示" }, ["project", "必要"]],
			["rules_set", {}, ["content", "必要"]],
			["rules_set", { text: "規則" }, ["rules_set", "text", "content を指定してください", "許可"]],
			["rules_set", { content: "" }, ["content", "空"]],
			["rules_set", { content: false }, ["content", "string"]],
			["rules_set", { content: "規則", typo: 1 }, ["typo", "content", "許可"]],
			[
				"notify",
				{ project: "live", event: "merge-request", issue: "22", title: "不正通知", body: 123 },
				["body", "string"],
			],
			["notify", { project: "live", event: "merge-request", issue: "22", typo: true }, ["typo", "許可", "body"]],
			["restart", { name: 123 }, ["name", "string"]],
			["restart", { name: "live", typo: true }, ["typo", "許可", "name"]],
			["restart", { limited: "yes" }, ["limited", "boolean"]],
			["restart", { all: 1 }, ["all", "boolean"]],
			["restart", { all: true, except: "a" }, ["except", "array"]],
			["restart", { all: true, except: [1] }, ["except[0]", "string"]],
			["rules_get", null, ["object"]],
			["rules_get", [], ["object"]],
		] as const) {
			const r = await cli.call(name, args);
			assert.equal(r.ok, false, JSON.stringify(r));
			assert.equal(Object.hasOwn(r, "data"), false);
			for (const part of parts) assert.ok(r.error?.includes(part), r.error);
			assert.deepEqual(businessSnapshot(home), before);
		}
		const invalid = await dle(home, ["notify", "--project", "--event", "merge-request", "--issue", "22"]);
		assert.equal(invalid.code, 1, invalid.stderr);
		assert.match(invalid.stderr, /dle notify: project が必要です/);
		assert.doesNotMatch(invalid.stderr, /記録しました|起動していません/);
		assert.deepEqual(businessSnapshot(home), before);
		engine.deliver("live", "検査完了", { kind: "test-sync" });
		await w.event((p) => (p.meta as Record<string, string>).kind === "test-sync");
		assert.equal(w.events.length, notifications + 1);
		assert.deepEqual(rest.calls, posts);
		assert.equal(restart.mock.callCount(), 0);
		const read = await cli.call("rules_get");
		assert.equal(read.ok, true);
		assert.equal(read.data, "# 旧ルール\n保存済み\n");
		assert.equal((await dle(home, ["restart", "live"])).code, 0);
		assert.deepEqual(
			restart.mock.calls.map((c) => c.arguments),
			[["live"]],
		);
		const many = t.mock.method(engine.supervisor, "restartMany", async () => ({ restarted: ["live"], skipped: [] }));
		assert.equal((await dle(home, ["restart", "--all", "--except", "stopped", "--except", "x"])).code, 0);
		assert.equal((await dle(home, ["restart", "--limited"])).code, 0);
		assert.deepEqual(
			many.mock.calls.map((c) => c.arguments),
			[
				["all", ["stopped", "x"]],
				["limited", []],
			],
		);
		assert.equal((await dle(home, ["restart", "--except", "x"])).code, 1);
		assert.equal(many.mock.callCount(), 2);
		const normal = await dle(home, [
			"notify",
			"--project",
			"live",
			"--event",
			"info",
			"--title",
			"正常通知",
			"--body",
			"本文",
		]);
		assert.equal(normal.code, 0, normal.stderr);
		assert.match(normal.stderr, /記録しました/);
		assert.ok(rest.calls.some((c) => c.content === "ℹ️ **[live]** お知らせ\n正常通知\n本文\n───"));
	} finally {
		cli.socket.destroy();
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("公開 schema: 全ツールの引数・役割を共有し、CLI 専用ツールと内部情報を公開しない", async () => {
	const { TOOLS } = await import("../src/tools.ts");
	const { engine, home } = setupEngine();
	await engine.start();
	const sessions: { env: Record<string, string>; names: string }[] = [
		{
			env: { DLE_ROLE: "concierge" },
			names:
				"reply tasks_list task_get task_create task_update attention_list attention_answer dispatch board_show projects_list project_add profile_get project_mode project_set_active learning_add rules_get learnings_list learnings_promote rules_set retro_done",
		},
		{
			env: { DLE_ROLE: "worker", DLE_PROJECT: "worker" },
			names:
				"tasks_list task_get attention_list board_show profile_propose profile_template profile_get profile_activate report learning_add rules_get",
		},
		{ env: {}, names: "" },
	];
	try {
		for (const { env, names } of sessions) {
			const c = startChannel(home, env);
			try {
				const tools = (await c.rpc("tools/list", {})).result?.tools as {
					name: string;
					description: string;
					inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean };
				}[];
				assert.deepEqual(tools.map((t) => t.name).sort(), names.split(" ").filter(Boolean).sort());
				for (const tool of tools) {
					assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
					assert.deepEqual(tool.inputSchema, TOOLS.find((t) => t.name === tool.name)?.inputSchema);
					assert.equal(tool.inputSchema.additionalProperties, false);
					assert.ok(!["notify", "restart"].includes(tool.name));
				}
				for (const [name, key] of [
					["task_update", "phase"],
					["report", "title"],
					["report", "project"],
					["profile_propose", "project"],
					["profile_activate", "project"],
				]) {
					const tool = tools.find((t) => t.name === name);
					if (tool) assert.equal((tool.inputSchema.properties[key as string] as { type: string }).type, "string");
				}
				for (const [name, key] of [
					["dispatch", "text"],
					["rules_set", "content"],
				]) {
					const tool = tools.find((t) => t.name === name);
					if (tool) assert.equal((tool.inputSchema.properties[key as string] as { minLength: number }).minLength, 1);
				}
				if (env.DLE_ROLE === "worker") assert.equal((await c.tool("rules_set", { content: "x" })).isError, true);
			} finally {
				c.stop();
			}
		}
	} finally {
		await engine.stop();
	}
});

test("互換性: 正常な配信・追加5項目・project優先順位・JSON profile・falseと空値を保持する", async () => {
	const { engine, home } = setupEngine(5, async (_cmd, args) => ({
		ok: true,
		stdout: args.includes("--show-toplevel")
			? home
			: args.includes("get-url")
				? "https://github.com/example/project.git"
				: "",
		stderr: "",
	}));
	engine.config.board.enabled = false;
	await engine.start();
	for (const name of ["live", "other", "stopped"])
		engine.ledger.upsertProject({ name, repo: "example/project", path: home, active: true, mode: "harness" });
	const task = engine.ledger.createTask({ project: "live", title: "作業", next: "続き" });
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "live" });
	const cli = startCliSocket(home);
	try {
		await cli.welcome();
		await until(() => engine.sessions.has("concierge") && engine.sessions.has("live"));
		const sent = await c.tool("dispatch", { project: "live", text: "#10 を先に\n日本語", task_id: task.id });
		assert.equal(sent.isError, false, sent.text);
		assert.deepEqual(JSON.parse(sent.text), { delivery: "sent" });
		const event = await w.event((p) => (p.meta as Record<string, string>).from === "concierge");
		assert.equal(event.content, `窓口からの依頼（${task.id}）:\n#10 を先に\n日本語`);
		assert.deepEqual(event.meta, { from: "concierge", task: task.id });
		const queued = await c.tool("dispatch", { project: "stopped", text: "停止中の指示", task_id: task.id });
		assert.equal(queued.isError, false, queued.text);
		assert.deepEqual(JSON.parse(queued.text), { delivery: "queued" });
		const { at, ...outbox } = JSON.parse(readFileSync(path.join(home, "outbox", "stopped.jsonl"), "utf8"));
		assert.equal(typeof at, "string");
		assert.deepEqual(outbox, {
			content: `窓口からの依頼（${task.id}）:\n停止中の指示`,
			meta: { from: "concierge", task: task.id },
		});
		engine.ledger.updateTask(task.id, { waiting: "確認" });
		assert.equal(
			(await c.tool("task_update", { id: task.id, phase: "implementing", waiting: "", next: "" })).isError,
			false,
		);
		assert.equal(engine.ledger.task(task.id)?.phase, "implementing");
		assert.equal(engine.ledger.task(task.id)?.waiting, "");
		assert.equal(engine.ledger.task(task.id)?.next, "");
		assert.match(readFileSync(path.join(home, "tasks", `${task.id}.md`), "utf8"), /implementing/);
		const reported = await cli.call("report", { project: "other", issue: "42", title: "CLI の件名" });
		assert.equal(reported.ok, true, reported.error);
		assert.ok(engine.ledger.tasks().some((t) => t.project === "other" && t.issue === "42" && t.title === "CLI の件名"));
		assert.equal((await w.tool("report", { project: "other", issue: "43", title: "worker の件名" })).isError, false);
		assert.ok(
			engine.ledger.tasks().some((t) => t.project === "live" && t.issue === "43" && t.title === "worker の件名"),
		);
		const profile = {
			gate: [{ name: "test", run: "true" }],
			hooks: { beforePR: ["true"] },
			custom: { preserved: true },
		};
		for (const value of [profile, JSON.stringify(profile)]) {
			const result = await cli.call("profile_propose", {
				project: "other",
				mode: "harness",
				summary: "調査済み",
				profile: value,
			});
			assert.equal(result.ok, true, result.error);
			assert.deepEqual(engine.ledger.draft("other")?.profile, profile);
		}
		assert.equal((await cli.call("profile_activate", { project: "other" })).ok, true);
		assert.deepEqual(
			JSON.parse(readFileSync(path.join(home, "projects", "other", "harness.json"), "utf8")).gate,
			profile.gate,
		);
		assert.equal(
			(await w.tool("profile_propose", { project: "other", mode: "harness", summary: "worker案", profile })).isError,
			false,
		);
		assert.deepEqual(engine.ledger.draft("live")?.profile, profile);
		assert.equal((await w.tool("profile_activate", { project: "other" })).isError, false);
		assert.deepEqual(
			JSON.parse(readFileSync(path.join(home, "projects", "live", "harness.json"), "utf8")).gate,
			profile.gate,
		);
		assertMcpError(await w.tool("profile_propose", { mode: "harness", summary: "x", profile: "{}" }), "profile.gate");
		const invalidJson = await w.tool("profile_propose", { mode: "harness", summary: "x", profile: "{" });
		assertMcpError(invalidJson, "JSON");
		assert.equal((await c.tool("project_set_active", { name: "stopped", active: false })).isError, false);
		assert.equal(engine.ledger.projects().find((p) => p.name === "stopped")?.active, false);
		assert.equal((await c.tool("tasks_list", { all: false })).isError, false);
		assert.equal((await c.tool("learnings_list", { include_promoted: false })).isError, false);
		assert.deepEqual(JSON.parse((await c.tool("learnings_promote", { indexes: [] })).text), { ok: true });
		assert.equal((await c.tool("reply", { text: "添付なし", files: [] })).isError, false);
		assert.equal((await cli.call("notify", { event: "info" })).error, "project が必要です");
		for (const [name, args] of [
			["task_create", { project: "live", title: "禁止" }],
			["task_update", { id: task.id, title: "禁止" }],
			["dispatch", { project: "other", text: "禁止" }],
			["rules_set", { content: "禁止" }],
		] as const) {
			await assert.rejects(engine.call({ role: "worker", name: "live" }, name, args), /窓口だけ/);
		}
		await assert.rejects(engine.call({ role: "concierge", name: "concierge" }, "restart", { name: "live" }), /CLI/);
		await assert.rejects(engine.call({ role: "worker", name: "live" }, "restart", { limited: true }), /CLI/);
		for (const args of [
			["tasks", "--all"],
			["projects", "--json"],
			["attention"],
			["board"],
			["add", home, "--name", "added", "--harness"],
			["mode", "added", "native", "--command", "/loop", "--tmux-session", "dev"],
		]) {
			const result = await dle(home, args);
			assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
		}
		assert.equal(engine.ledger.projects().find((p) => p.name === "added")?.initialPrompt, "/loop");
	} finally {
		cli.socket.destroy();
		c.stop();
		w.stop();
		await engine.stop();
	}
});

test("W5: worktreeRootの提案検証は保存・承認依頼前、明示値の維持と承認付き除去", async () => {
	const { engine, rest, home } = setupEngine(5, async () => ({ ok: true, stdout: "", stderr: "" }));
	await engine.start();
	const p = engine.ledger.upsertProject({
		name: "paths",
		repo: "example/project",
		path: home,
		active: true,
		mode: "harness",
	});
	const w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: p.name, DLE_LOOP: "harness" });
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	const gate = [{ name: "test", run: "true" }];
	const file = engine.ledger.profilePath(p.name);
	try {
		await until(() => engine.sessions.has(p.name) && engine.sessions.has("concierge"));
		const tpl = JSON.parse((await w.tool("profile_template", {})).text);
		assert.equal(tpl.template.worktreeRoot, undefined);
		assert.deepEqual(
			Object.keys(tpl.examples).sort(),
			readdirSync(path.join(ROOT, "templates/examples"))
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -5))
				.sort(),
		);
		for (const example of Object.values(tpl.examples) as Record<string, unknown>[])
			assert.equal(example.worktreeRoot, undefined);
		for (const existingDraft of [false, true]) {
			if (existingDraft)
				engine.ledger.saveDraft(p.name, {
					mode: "harness",
					profile: { gate, worktreeRoot: ".worktrees" },
					summary: "previous",
					proposedAt: "test",
				});
			const current = existingDraft ? JSON.stringify({ gate, worktreeRoot: ".worktrees" }) : null;
			if (current) writeFileSync(file, current);
			const before = engine.ledger.draft(p.name);
			const posts = rest.calls.length;
			for (const worktreeRoot of [1, false, [], {}, "~", "~/wt", "~user/wt", "$", "$HOME/wt", `\${HOME}/wt`]) {
				const r = await w.tool("profile_propose", {
					mode: "harness",
					summary: "root change",
					profile: { gate, worktreeRoot },
				});
				assert.equal(r.isError, true);
				assert.match(
					r.text,
					typeof worktreeRoot === "string"
						? /worktreeRoot.*先頭の ~ や \$ の展開は行わない.*展開済みの絶対パス/
						: /worktreeRoot.*文字列/,
				);
				assert.deepEqual(engine.ledger.draft(p.name), before);
				assert.equal(engine.ledger.openAttention().length, 0);
				assert.equal(rest.calls.length, posts);
				assert.equal(existsSync(file), !!current);
				if (current) assert.equal(readFileSync(file, "utf8"), current);
			}
		}
		for (const value of [undefined, null, ""]) {
			engine.ledger.upsertProject({ ...p, path: path.dirname(home) });
			const before = engine.ledger.draft(p.name),
				posts = rest.calls.length;
			const current = readFileSync(file, "utf8");
			const r = await w.tool("profile_propose", {
				mode: "harness",
				summary: "root change",
				profile: { gate, worktreeRoot: value },
			});
			assert.equal(r.isError, true);
			assert.match(r.text, /worktreeRoot.*既定候補.*main/);
			assert.equal(readFileSync(file, "utf8"), current);
			assert.deepEqual(engine.ledger.draft(p.name), before);
			assert.equal(engine.ledger.openAttention().length, 0);
			assert.equal(rest.calls.length, posts);
		}
		engine.ledger.upsertProject(p);
		for (const value of [".worktrees", undefined]) {
			const r = await w.tool("profile_propose", {
				mode: "harness",
				profile: { gate, worktreeRoot: value },
				summary: "root change",
			});
			assert.equal(r.isError, false, r.text);
			if (value !== ".worktrees")
				assert.equal(engine.ledger.profile(p)?.worktreeRoot, ".worktrees", "提案だけでは既存値を変更しない");
			const id = JSON.parse(r.text).attention;
			const expectedRoot = value ? `${home}/.worktrees` : `${home}-worktrees/paths`;
			const rootLine = `worktreeRoot（${value ? "明示値" : "既定"}）: \`${expectedRoot}\``;
			const post = rest.calls.find((call) => call.kind === "send" && call.content?.includes(id));
			assert.ok(post?.content?.split("\n").includes(rootLine), post?.content);
			await c.tool("attention_answer", { id, answer: "OK" });
			const activated = await w.tool("profile_activate", {});
			assert.equal(activated.isError, false, activated.text);
			assert.equal(engine.ledger.profile(p)?.worktreeRoot, value);
			if (value === ".worktrees") {
				const before = readFileSync(file, "utf8");
				const calls: string[][] = [];
				const supervisor = new Supervisor({
					tmuxSession: "test",
					targets: () => engine.targets(),
					tmux: async (args) => {
						calls.push(args);
						return { ok: true, stdout: "" };
					},
					isLive: () => false,
					notify: () => {},
				});
				await supervisor.restart(p.name);
				await supervisor.tick();
				const worker = engine.targets().find((t) => t.name === p.name);
				assert.ok(worker?.command.includes(`${home}/.worktrees`));
				assert.equal(worker?.refresh?.worktreeRoot, `${home}/.worktrees`);
				assert.ok(
					calls.some((c) => (c[0] === "new-window" || c[0] === "new-session") && c.includes(worker?.command ?? "")),
				);
				assert.equal(readFileSync(file, "utf8"), before);
			}
			if (value === undefined) {
				assert.equal(Object.hasOwn(engine.ledger.profile(p) ?? {}, "worktreeRoot"), false);
				assert.deepEqual(engine.ledger.profile(p)?.gate, gate);
			}
		}
		for (const value of [null, "", "../relative space", `${home}-external/abs`, "/"]) {
			const r = await w.tool("profile_propose", {
				mode: "harness",
				summary: "root change",
				profile: { gate, worktreeRoot: value },
			});
			assert.equal(r.isError, false, r.text);
			const id = JSON.parse(r.text).attention;
			const expectedRoot = value ? path.resolve(home, value) : `${home}-worktrees/paths`;
			const rootLine = `worktreeRoot（${value ? "明示値" : "既定"}）: \`${expectedRoot}\``;
			const post = rest.calls.find((call) => call.kind === "send" && call.content?.includes(id));
			assert.ok(post?.content?.split("\n").includes(rootLine), post?.content);
		}
		assert.equal(existsSync(`${home}-worktrees/paths`), false);
		assert.equal(existsSync(`${home}-external`), false);
	} finally {
		w.stop();
		c.stop();
		await engine.stop();
		rmSync(home, { recursive: true, force: true });
	}
});

test("M1/M2: engineは最後の添付receiptと先頭IDを区別し、guild欠落でも投稿済みを保つ", async () => {
	for (const mode of ["normal", "guild-missing", "guild-failure", "old-message"] as const) {
		const { engine, rest, home } = setupEngine();
		const file = path.join(home, "demo.mp4");
		writeFileSync(file, "movie");
		if (mode === "guild-missing") rest.channel = async (id) => ({ id, guild_id: "", type: 1 });
		if (mode === "guild-failure")
			rest.channel = async () => {
				throw Error("no guild");
			};
		if (mode === "old-message") rest.sendMessage = async () => ({ id: "123", channel_id: "", attachments: [] });
		try {
			const result = (await engine.call({ role: "cli", name: "" }, "notify", {
				project: "quality",
				event: "merge-request",
				title: "動画",
				url: "https://example.test",
				body: "あ".repeat(5000),
				file,
			})) as {
				attention: string;
				message_id: string;
				discord?: { message_id: string; url: string | null; link_error?: string; attachments: unknown[] };
			};
			assert.match(result.attention, /^A-/);
			if (mode === "old-message") assert.equal(result.discord, undefined);
			else {
				assert.ok(result.discord);
				assert.notEqual(result.discord.message_id, result.message_id);
				assert.equal(result.discord.attachments.length, 1);
				assert.equal(engine.ledger.openAttention()[0]?.messageId, result.message_id);
				if (mode === "normal")
					assert.equal(result.discord.url, `https://discord.com/channels/800/900/${result.discord.message_id}`);
				else {
					assert.equal(result.discord.url, null);
					assert.equal(result.discord.link_error, "guild-unavailable");
				}
			}
		} finally {
			await engine.stop();
			rmSync(home, { recursive: true, force: true });
		}
	}
});

// --- Issue #19: 投稿の見出し・区切りと、依頼への ✅ / ☑️ ----------------------------------------
const CLI = { role: "cli", name: "" } as const;
const CONCIERGE = { role: "concierge", name: "concierge" } as const;
const GATES = [
	["interview", "🟡", "要件確認"],
	["merge-request", "🟢", "マージ承認"],
	["blocked", "🔴", "要対応"],
	["setup", "⚙️", "設定の確認"],
] as const;

const openGate = async (engine: Engine, event: string, issue: string, extra: Record<string, string> = {}) =>
	(await engine.call(CLI, "notify", { event, project: "proj", issue, title: `題${issue}`, ...extra })) as {
		attention: string;
		message_id: string;
	};
const sends = (rest: ReturnType<typeof fakeRest>) => rest.calls.filter((c) => c.kind === "send");
const reacts = (rest: ReturnType<typeof fakeRest>) =>
	rest.calls.filter((c) => c.kind === "react").map((c) => [c.messageId, c.emoji, c.channelId]);

for (const [event, icon, label] of GATES) {
	for (const answer of ["OK", "NG: 直して"]) {
		test(`${label}の依頼は見出しと区切りで投稿され、回答（${answer}）の記録後に元メッセージへ ✅ が付く`, async () => {
			const { engine, rest } = setupEngine();
			const g = await openGate(engine, event, "1");
			const other = await openGate(engine, event, "2");
			const post = sends(rest).find((c) => c.content?.includes(g.attention));
			assert.ok(post?.content?.startsWith(`${icon} **[proj]** ${label} ${g.attention}｜#1\n題1\n`), post?.content);
			assert.ok(post?.content?.endsWith("\n───"));
			assert.deepEqual(reacts(rest), [], "未回答には何も付けない");

			const result = await engine.call(CONCIERGE, "attention_answer", { id: g.attention, answer });
			assert.deepEqual(result, { attention: g.attention, delivery: "queued" });
			assert.equal(engine.ledger.attention().find((a) => a.id === g.attention)?.answer, answer);
			assert.deepEqual(reacts(rest), [[g.message_id, "✅", CH]]);
			assert.ok(!rest.calls.some((c) => c.kind === "edit" && c.messageId === g.message_id), "本文は書き換えない");
			assert.equal(engine.ledger.openAttention().map((a) => a.id)[0], other.attention);
		});
	}
}

test("回答なしで閉じた依頼（置き換え・作業再開・完了）には ☑️ が付き、回答済みと新しい依頼には付かない", async () => {
	const { engine, rest } = setupEngine();
	// 置き換え
	const a1 = await openGate(engine, "interview", "1");
	const a2 = await openGate(engine, "interview", "1");
	assert.deepEqual(reacts(rest), [[a1.message_id, "☑️", CH]]);
	// 作業再開（回答済みの別の依頼は対象外）
	const m1 = await openGate(engine, "merge-request", "1");
	await engine.call(CONCIERGE, "attention_answer", { id: m1.attention, answer: "OK" });
	await engine.call(CLI, "notify", { event: "phase", project: "proj", issue: "1", phase: "designing" });
	assert.deepEqual(reacts(rest).slice(1), [
		[m1.message_id, "✅", CH],
		[a2.message_id, "☑️", CH],
	]);
	// 完了: task_update / report / phase のどの入口でも付く
	for (const via of ["task_update", "report", "phase"]) {
		const issue = `1${via.length}`;
		const g = await openGate(engine, "blocked", issue);
		const task = engine.ledger.findTaskByIssue("proj", issue);
		assert.ok(task);
		const before = reacts(rest).length;
		if (via === "task_update") await engine.call(CONCIERGE, "task_update", { id: task.id, status: "done" });
		if (via === "report")
			await engine.call({ role: "worker", name: "proj" }, "report", { task_id: task.id, status: "done" });
		if (via === "phase") await engine.call(CLI, "notify", { event: "phase", project: "proj", issue, phase: "done" });
		assert.deepEqual(reacts(rest).slice(before), [[g.message_id, "☑️", CH]], via);
	}
	assert.ok(!rest.calls.some((c) => c.kind === "edit" && c.content?.includes("A-")));
});

test("印の付与に失敗しても回答・完了は成立し、短いログだけ残して後続の付与を続ける", async () => {
	const logs: string[] = [];
	const { engine, rest } = setupEngine(5, undefined, undefined, (m) => logs.push(m));
	const a = await openGate(engine, "interview", "1");
	const b = await openGate(engine, "merge-request", "1");
	rest.hooks.react = async (messageId) => {
		if (messageId === a.message_id) throw new Error(`403 Missing Permissions ${"x".repeat(500)}`);
	};
	const task = engine.ledger.findTaskByIssue("proj", "1");
	assert.ok(task);
	const t = (await engine.call(CONCIERGE, "task_update", { id: task.id, status: "done" })) as { status: string };
	assert.equal(t.status, "done");
	assert.deepEqual(reacts(rest), [[b.message_id, "☑️", CH]], "1件の失敗で後続を止めない");
	assert.equal(engine.ledger.openAttention().length, 0);
	const log = logs.find((l) => l.includes(a.attention));
	assert.ok(log && log.length < 300, log);
	assert.ok(!logs.some((l) => l.includes("fake") || l.includes("回答")));
	await assert.rejects(engine.call(CONCIERGE, "attention_answer", { id: a.attention, answer: "x" }), /既に対応済み/);

	// messageId が無い依頼は送信を試さずログだけ
	const old = engine.ledger.addAttention({
		taskId: "",
		project: "proj",
		issue: "",
		pr: "",
		kind: "setup",
		title: "古い",
		url: "",
		summary: "",
	}).attention;
	await engine.call(CONCIERGE, "attention_answer", { id: old.id, answer: "OK" });
	assert.ok(logs.some((l) => l.includes(old.id) && l.includes("元メッセージ ID がない")));
	assert.equal(reacts(rest).length, 1);
});

test("依頼の投稿中に回答されても、messageId の保存後に ✅ が付く", async () => {
	const { engine, rest } = setupEngine();
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	rest.hooks.send = () => gate;
	const opened = openGate(engine, "interview", "7");
	while (!engine.ledger.attention().some((a) => a.status === "open")) await new Promise((r) => setTimeout(r, 5));
	const id = engine.ledger.attention()[0]?.id ?? "";
	await engine.call(CONCIERGE, "attention_answer", { id, answer: "OK" });
	assert.deepEqual(reacts(rest), [], "投稿が終わるまで付けられない");
	release();
	const g = await opened;
	assert.deepEqual(reacts(rest), [[g.message_id, "✅", CH]]);
	assert.equal(engine.ledger.attention()[0]?.messageId, g.message_id);
});

test("長文は見出し付きで分割され、返信先は先頭・添付は最後だけに付き、並行する投稿は混ざらない", async () => {
	const { engine, rest, home } = setupEngine();
	const file = path.join(home, "att.txt");
	writeFileSync(file, "添付の中身");
	rest.hooks.send = () => new Promise((r) => setTimeout(r, 5));
	const long = `${"あ".repeat(1500)}\n${"い".repeat(1500)}`;
	const [r1] = await Promise.all([
		engine.call(CONCIERGE, "reply", { text: long, reply_to: "m9", files: [file], project: "窓口" }),
		engine.call(CONCIERGE, "reply", { text: "短い別の投稿" }),
		engine.call(CLI, "notify", { event: "info", project: "p2", title: "題", body: "本文" }),
	]);
	const s = sends(rest);
	assert.equal(s.length, 4);
	assert.equal(s[0]?.content?.split("\n")[0], "💬 **[窓口]** 返信");
	assert.equal(s[1]?.content?.split("\n")[0], "💬 **[窓口]** 返信（続き）");
	assert.ok(s[1]?.content?.endsWith("\n───") && !s[0]?.content?.endsWith("───"));
	assert.deepEqual([s[0]?.replyTo, s[1]?.replyTo], ["m9", undefined]);
	assert.deepEqual([s[0]?.files, s[1]?.files], [[], [file]]);
	assert.deepEqual(s[1]?.fileContents, ["添付の中身"]);
	assert.equal((r1 as { message_id: string }).message_id, "1", "返り値は先頭のメッセージ ID");
	assert.equal(s[2]?.content?.split("\n")[0], "💬 **[窓口]** 返信");
	assert.equal(s[3]?.content?.split("\n")[0], "ℹ️ **[p2]** お知らせ");

	// 先行する投稿が失敗しても次を送れる
	rest.hooks.send = async () => {
		throw new Error("送信失敗");
	};
	await assert.rejects(engine.call(CONCIERGE, "reply", { text: "失敗" }), /送信失敗/);
	rest.hooks.send = null;
	await engine.call(CONCIERGE, "reply", { text: "次" });
	assert.ok(sends(rest).at(-1)?.content?.includes("次"));
});

test("T18-6: IssueなしPRのdone/closed/owner NGはそのmerge Aだけを整理する", async () => {
	for (const [phase, body, expected] of [
		["done", "", "（PR merged）"],
		["blocked", "", "（PR closed）"],
		["blocked", "（GitHub の NG で停止）", "（GitHub の NG で停止）"],
	]) {
		const { engine, rest, home } = setupEngine();
		try {
			const base = {
				project: "quality",
				event: "merge-request",
				issue: "",
				title: "PR #25",
				url: "https://github.com/example/project/pull/25",
				body: `承認対象 head: ${"a".repeat(40)}`,
			};
			await engine.call({ role: "cli", name: "" }, "notify", { ...base, pr: "25" });
			await engine.call({ role: "cli", name: "" }, "notify", { ...base, pr: "26" });
			assert.equal(engine.ledger.tasks().length, 0);
			await engine.call({ role: "cli", name: "" }, "notify", { ...base, event: "phase", phase, body, pr: "25" });
			assert.equal(engine.ledger.attention().find((a) => a.pr === "25")?.answer, expected);
			assert.equal(engine.ledger.openAttention().find((a) => a.pr === "26")?.status, "open");
			assert.equal(rest.calls.filter((c) => c.content?.includes("マージ完了")).length, phase === "done" ? 1 : 0);
		} finally {
			await engine.stop();
			rmSync(home, { recursive: true, force: true });
		}
	}
});

// --- idle の worker を起こす（#32） ---------------------------------------------------------
function wakeStub(engine: Engine) {
	const log: string[] = [];
	engine.supervisor = {
		requestWake: (n: string, r: string) => log.push(`request ${n} ${r}`),
		wakeTick: async () => {
			log.push("wakeTick");
		},
		tick: async () => {
			log.push("tick");
		},
		onRegistered: async () => {},
	} as unknown as Supervisor;
	return log;
}

test("dispatch と A-番号の回答は worker を起こし（tick ではなく wakeTick）、窓口宛には呼ばない", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({ name: "k", repo: "x/k", path: home, active: true, mode: "harness" });
	const log = wakeStub(engine);
	const c = startChannel(home, { DLE_ROLE: "concierge" });
	try {
		await until(() => engine.sessions.has("concierge"));
		await c.tool("dispatch", { project: "k", text: "指示" });
		assert.deepEqual(log, ["request k dispatch", "wakeTick"]);
		log.length = 0;
		const { attention: a } = engine.ledger.addAttention({
			project: "k",
			kind: "merge",
			title: "t",
			url: "u",
			issue: "1",
			pr: "2",
			taskId: "",
			summary: "s",
		});
		await c.tool("attention_answer", { id: a.id, answer: "OK" });
		assert.deepEqual(log, [`request k 回答 ${a.id}`, "wakeTick"]);
		log.length = 0;
		engine.deliver("concierge", "x", {});
		assert.deepEqual(log, [], "窓口には呼ばない");
	} finally {
		c.stop();
		await engine.stop();
	}
});

test("outbox を 1 件以上払い出したときだけ worker を起こす", async () => {
	const { engine, home } = setupEngine();
	await engine.start();
	engine.ledger.upsertProject({ name: "k", repo: "x/k", path: home, active: true, mode: "harness" });
	const log = wakeStub(engine);
	let w: ReturnType<typeof startChannel> | null = null;
	try {
		w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "k" });
		await until(() => engine.sessions.has("k"));
		assert.ok(!log.some((l) => l.includes("outbox")), "空の outbox では起こさない");
		w.stop();
		await until(() => !engine.sessions.has("k"));
		engine.deliver("k", "溜める", { from: "concierge" });
		log.length = 0;
		w = startChannel(home, { DLE_ROLE: "worker", DLE_PROJECT: "k" });
		await until(() => log.includes("request k outbox"));
		assert.ok(log.includes("wakeTick"));
	} finally {
		w?.stop();
		await engine.stop();
	}
});

test("queueTick: 初回は覚えるだけ・新しい番号で 1 回だけ起こし・失敗では更新しない・外れて再付与なら再度起こす", async () => {
	let out: { ok: boolean; stdout: string } = { ok: true, stdout: "[]" };
	const seenArgs: string[][] = [];
	const exec: Run = async (cmd, args) => {
		if (cmd === "gh") seenArgs.push(args);
		return { ...out, stderr: "" };
	};
	const { engine, home } = setupEngine(5, exec);
	mkdirSync(path.join(home, "r", ".claude"), { recursive: true });
	writeFileSync(path.join(home, "r", ".claude", "harness.json"), "{}");
	const ready = { repo: "x/r", path: path.join(home, "r"), active: true, mode: "harness" as const };
	engine.ledger.upsertProject({ name: "ready", ...ready });
	engine.ledger.upsertProject({ name: "notready", repo: "x/n", path: "/nonexistent", active: true, mode: "harness" });
	engine.ledger.upsertProject({ name: "native", repo: "x/m", path: home, active: true, mode: "native" });
	const log = wakeStub(engine);
	const set = (nums: number[]) => {
		out = { ok: true, stdout: JSON.stringify(nums.map((number) => ({ number }))) };
	};
	set([1]);
	await engine.queueTick();
	assert.deepEqual(log, [], "初回は起こさない");
	assert.deepEqual(engine.ledger.state().queuedSeen, { ready: ["1"] });
	assert.ok(
		seenArgs.every((a) => a.includes("x/r")),
		"ready な harness だけ見る",
	);
	await engine.queueTick();
	assert.deepEqual(log, [], "同じ集合では起こさない");
	set([1, 2]);
	await engine.queueTick();
	assert.deepEqual(log, ["request ready queued #2", "wakeTick"]);
	for (const bad of [
		{ ok: false, stdout: "" },
		{ ok: true, stdout: "not json" },
	]) {
		log.length = 0;
		out = bad;
		await engine.queueTick();
		assert.deepEqual(log, []);
		assert.deepEqual(engine.ledger.state().queuedSeen, { ready: ["1", "2"] }, "観測できなければ更新しない");
	}
	set([1]);
	await engine.queueTick();
	log.length = 0;
	set([1, 2]);
	await engine.queueTick();
	assert.deepEqual(log, ["request ready queued #2", "wakeTick"], "外れた後の再付与は新規扱い");
});

// --- Issue #25: blocked / interview の --file が黙って落ちない -----------------------------------
for (const event of ["blocked", "interview"]) {
	test(`${event}: 存在する絶対パスの添付は投稿の files にそのまま渡る`, async () => {
		const { engine, rest, home } = setupEngine();
		const file = path.join(home, "draft.md");
		writeFileSync(file, "下書き");
		await openGate(engine, event, "1", { file });
		assert.deepEqual(sends(rest).at(-1)?.files, [file]);
		assert.deepEqual(sends(rest).at(-1)?.fileContents, ["下書き"]);
	});

	test(`${event}: 存在しない添付はエラーで、投稿も A-番号も残さない`, async () => {
		const { engine, rest, home } = setupEngine();
		await assert.rejects(
			openGate(engine, event, "1", { file: path.join(home, "nothing.md") }),
			/添付ファイルが見つかりません/,
		);
		assert.equal(sends(rest).length, 0);
		assert.equal(engine.ledger.openAttention().length, 0);
	});

	test(`${event}: ディレクトリの添付はエラーになる`, async () => {
		const { engine, rest, home } = setupEngine();
		await assert.rejects(openGate(engine, event, "1", { file: home }), /通常のファイル/);
		assert.equal(sends(rest).length, 0);
		assert.equal(engine.ledger.openAttention().length, 0);
	});
}

for (const event of ["blocked", "interview", "merge-request"]) {
	test(`${event}: 相対パスの添付は engine の cwd に同名ファイルがあっても拒否する`, async () => {
		const { engine, rest } = setupEngine();
		const name = `dle-rel-${process.pid}.md`;
		writeFileSync(name, "誤添付");
		try {
			await assert.rejects(openGate(engine, event, "1", { file: name }), /絶対パスで渡してください/);
		} finally {
			rmSync(name, { force: true });
		}
		assert.equal(sends(rest).length, 0);
		assert.equal(engine.ledger.openAttention().length, 0);
	});
}

test("merge-request: 空ファイル・存在しない添付は従来どおりエラー", async () => {
	const { engine, home } = setupEngine();
	const file = path.join(home, "empty.mp4");
	writeFileSync(file, "");
	await assert.rejects(openGate(engine, "merge-request", "1", { file }), /非空/);
	await assert.rejects(openGate(engine, "merge-request", "1", { file: path.join(home, "none.mp4") }));
	assert.equal(engine.ledger.openAttention().length, 0);
});

test("restart の引数は name / limited / all のちょうど1つ、except は limited / all のときだけ", () => {
	assert.deepEqual(restartMode({ name: "a" }), { kind: "one", name: "a" });
	assert.deepEqual(restartMode({ limited: true }), { kind: "limited", except: [] });
	assert.deepEqual(restartMode({ all: true, except: ["a", "b"] }), { kind: "all", except: ["a", "b"] });
	for (const a of [
		{},
		{ limited: false },
		{ name: "a", all: true },
		{ limited: true, all: true },
		{ name: "a", except: ["b"] },
	])
		assert.throws(() => restartMode(a), /restart:/, JSON.stringify(a));
});

test("上限の通知文は一覧・復帰（または画面で確認）・手順を含み、例のコマンドは1通にまとまる", () => {
	const text = limitNoticeText([
		{ name: "a", resetText: "3pm" },
		{ name: "b", resetText: null },
	]);
	assert.match(text, /- a（復帰: 3pm）/);
	assert.match(text, /- b（復帰: 画面で確認）/);
	assert.match(text, /dle restart --limited/);
	assert.match(text, /dle restart --all \[--except 名前\]/);
});

test("limitGaveUpText は名前・回数・dle restart --limited を含み、復帰時刻を含まない", () => {
	const text = limitGaveUpText({ names: ["a", "b"], attempts: 5 });
	assert.match(text, /a, b/);
	assert.match(text, /5 回/);
	assert.match(text, /dle restart --limited/);
	assert.doesNotMatch(text, /復帰/);
});

test("#28: attention_list は既定で開いている A だけを返し、絞り込みと includeResolved で回答済みの全文と時刻も返せる", async () => {
	const { engine, home } = setupEngine();
	try {
		for (const name of ["p1", "p2"])
			engine.ledger.upsertProject({ name, repo: "x/y", path: home, active: true, mode: "harness" });
		const mk = (project: string, issue: string) =>
			engine.ledger.addAttention({
				taskId: "",
				project,
				issue,
				pr: "",
				kind: "interview",
				title: `t${project}${issue}`,
				url: "u",
				summary: "s",
			}).attention;
		const a1 = mk("p1", "1");
		const a2 = mk("p1", "2");
		const a3 = mk("p2", "1");
		const longAnswer = `${"長い回答".repeat(40)}\n2行目`;
		engine.ledger.resolveAttention(a1.id, longAnswer);
		const W1 = { role: "worker", name: "p1" } as const;
		const ids = async (who: typeof W1 | typeof CONCIERGE, args?: Record<string, unknown>) =>
			((await engine.call(who, "attention_list", args)) as { id: string }[]).map((x) => x.id);

		// 既定の出力は従来どおり（開いているものだけ・全プロジェクト）
		assert.deepEqual(await ids(W1), [a2.id, a3.id]);
		assert.deepEqual(await ids(W1, {}), [a2.id, a3.id]);
		assert.deepEqual(await ids(CONCIERGE, { includeResolved: false }), [a2.id, a3.id]);
		// 絞り込み
		assert.deepEqual(await ids(W1, { project: "p1" }), [a2.id]);
		assert.deepEqual(await ids(W1, { issue: "1" }), [a3.id]);
		assert.deepEqual(await ids(W1, { project: "p2", issue: "1" }), [a3.id]);
		// 回答済みを含める: 全文・resolvedAt・status が付き、他プロジェクトは project で除ける
		const all = (await engine.call(W1, "attention_list", { project: "p1", issue: "1", includeResolved: true })) as {
			id: string;
			status: string;
			answer?: string;
			resolvedAt?: string;
		}[];
		assert.equal(all.length, 1);
		assert.equal(all[0]?.id, a1.id);
		assert.equal(all[0]?.status, "resolved");
		assert.equal(all[0]?.answer, longAnswer);
		assert.match(all[0]?.resolvedAt ?? "", /^\d{4}-\d\d-\d\dT.*Z$|^\d{4}-\d\d-\d\dT/);
		assert.deepEqual(await ids(W1, { project: "p1", includeResolved: true }), [a1.id, a2.id]);
		assert.ok(!(await ids(W1, { project: "p1", includeResolved: true })).includes(a3.id));
		// 未知の引数は従来どおり拒否
		await assert.rejects(engine.call(W1, "attention_list", { typo: "x" }), /typo/);
	} finally {
		await engine.stop();
	}
});
