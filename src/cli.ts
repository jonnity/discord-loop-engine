// dle — discord-loop-engine の CLI。
//
//   dle init                 設定の雛形を ~/.discord-loop-engine/ に作る
//   dle doctor               設定・トークン・Bot の権限・必要なコマンドを確認する
//   dle up                   tmux（dle セッションの engine ウィンドウ）で常駐させる
//   dle down                 常駐を止める（各セッションは止めない）
//   dle start                フォアグラウンドで起動する（up が中で使う）
//   dle status               engine・Discord・セッションの状態
//   dle add <owner/repo|パス> リポジトリを登録する（--native <コマンド> で独自ループのまま、
//                            --harness で独自ループがあっても dle のループで回す）
//   dle projects [--json]    登録済みのリポジトリ（モード・接続・設定の状態）
//   dle tasks [--all]        台帳のタスク
//   dle attention            あなた待ち（--all / --answered と --json で保存済み台帳）
//   dle board                ボード
//   dle restart <名前>       窓口や worker を起動し直す（concierge / プロジェクト名）
//   dle restart --limited | --all [--except 名前...]   上限で止まった worker だけ / 全員を起動し直す
//   dle mode <名前> harness|native [--command <c>]  ループの進め方を切り替える（登録し直しでは引き継がれるため）
//   dle notify ...           harness-notify から使う（人の判断が要る通知を A-番号付きで出す）

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAttentionSnapshot } from "./attention-read.ts";
import { CONFIG_TEMPLATE, type Config, loadConfig, readToken } from "./config.ts";
import { Engine } from "./engine.ts";
import { Gateway } from "./gateway.ts";
import { Ledger, type Project } from "./ledger.ts";
import { registerProject } from "./projects.ts";
import { dleHome, type EngineMessage, lineReader, PROTOCOL_VERSION, send } from "./protocol.ts";
import { Rest } from "./rest.ts";
import { parseRestartArgs } from "./restart-args.ts";
import { Supervisor, tmuxRunner } from "./supervisor.ts";

const SELF = fileURLToPath(import.meta.url);
const BIN = path.join(path.dirname(SELF), "..", "bin", "dle");
const home = dleHome();
const tmux = tmuxRunner();

function log(msg: string) {
	console.error(`${new Date().toISOString()} ${msg}`);
}

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

function parseFlags(args: string[]) {
	const flags: Record<string, string | boolean> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) flags[key] = true;
			else {
				flags[key] = next;
				i++;
			}
		} else rest.push(a);
	}
	return { flags, rest };
}

/** engine に CLI として繋いでツールを1回呼ぶ。engine が動いていなければ null */
async function callEngine(cfg: Config, name: string, args: Record<string, unknown>): Promise<unknown | null> {
	if (!existsSync(cfg.socketPath)) return null;
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(cfg.socketPath);
		let welcomed = false;
		sock.on("connect", () =>
			send(sock, { type: "hello", protocol: PROTOCOL_VERSION, role: "cli", pid: process.pid, cwd: process.cwd() }),
		);
		sock.on(
			"data",
			lineReader<EngineMessage>((m) => {
				if (m.type === "welcome" && !welcomed) {
					welcomed = true;
					send(sock, { type: "call", id: "1", name, args });
				} else if (m.type === "error") {
					sock.end();
					reject(new Error(m.message));
				} else if (m.type === "result") {
					sock.end();
					if (m.ok) resolve(m.data);
					else reject(new Error(m.error));
				}
			}),
		);
		sock.on("error", (error) => {
			if (welcomed) reject(error);
			else resolve(null);
		});
		sock.on("close", () => {
			if (welcomed) reject(new Error("engine への依頼送信後、結果を受け取る前に接続が閉じました"));
			else resolve(null);
		});
	});
}

const show = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

// --- commands -------------------------------------------------------------------------------
function cmdInit() {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const file = path.join(home, "config.json");
	if (existsSync(file)) fail(`既にあります: ${file}`);
	writeFileSync(file, `${JSON.stringify(CONFIG_TEMPLATE, null, "\t")}\n`, { mode: 0o600 });
	const envFile = path.join(home, ".env");
	if (!existsSync(envFile)) writeFileSync(envFile, "DISCORD_BOT_TOKEN=\n", { mode: 0o600 });
	console.log(
		`作成しました:\n  ${file}\n  ${envFile}\nチャンネル ID・ユーザー ID・トークンを埋めてから dle doctor を実行してください。`,
	);
}

async function cmdStart() {
	const config = loadConfig(home);
	const token = readToken(home);
	if (!token) fail(`Bot トークンがありません（環境変数 DISCORD_BOT_TOKEN か ${path.join(home, ".env")}）`);
	const rest = new Rest({ token });
	const ledger = new Ledger(home);
	let engine: Engine | null = null;
	const supervisor = new Supervisor({
		tmuxSession: config.tmuxSession,
		targets: () => engine?.targets() ?? [],
		tmux,
		isLive: (n) => engine?.sessions.has(n) ?? false,
		notify: (n, t) => engine?.notifyOps(n === "concierge" ? "窓口" : n, t),
		activity: (n) => engine?.activity(n) ?? { events: 0, lastAt: 0 },
		onRefresh: (n, phase, result) => engine?.onRefresh(n, phase, result),
		onRefreshSkipped: (n, reason) => ledger.journal(`[${n}] ${reason}`),
		onWakeSkipped: (n, reason) => ledger.journal(`[${n}] ${reason}`),
		limit: config.worker.limit,
		onLimit: (entries) => engine?.limitNotice(entries),
		onLimitGaveUp: (e) => engine?.limitGaveUpNotice(e),
		log,
	});
	engine = new Engine({ config, rest, ledger, supervisor, log, gatewayFactory: (h) => new Gateway({ token, ...h }) });
	await engine.start();
	writeFileSync(path.join(home, "engine.pid"), `${process.pid}\n`);
	const tick = () => supervisor.tick().catch((e: Error) => log(`supervisor: ${e.message}`));
	// channel の再接続を待ってから起動判定する（engine 再起動時に既存セッションを二重起動しない）
	setTimeout(tick, 15_000);
	setInterval(tick, 30_000);
	const ci = () => engine?.ciTick().catch((e: Error) => log(`ci: ${e.message}`));
	setTimeout(ci, 20_000);
	setInterval(ci, 5 * 60_000);
	const queue = () => engine?.queueTick().catch((e: Error) => log(`queue: ${e.message}`));
	setTimeout(queue, 25_000);
	setInterval(queue, 60_000);
	setInterval(() => {
		engine?.writeStatus();
		engine?.maybeRequestRetro();
	}, 60 * 60_000);
	engine.scheduleBoard();
	const shutdown = async () => {
		log("engine: 停止します");
		await engine?.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

async function cmdUp() {
	const config = loadConfig(home);
	const has = await tmux(["has-session", "-t", config.tmuxSession]);
	const wins = has.ok
		? (await tmux(["list-windows", "-t", config.tmuxSession, "-F", "#{window_name}"])).stdout.split("\n")
		: [];
	if (wins.includes("engine")) fail(`既に起動しています（tmux ${config.tmuxSession}:engine）`);
	const cmd = `${JSON.stringify(BIN)} start`;
	const args = has.ok
		? ["new-window", "-d", "-t", config.tmuxSession, "-n", "engine", cmd]
		: ["new-session", "-d", "-s", config.tmuxSession, "-n", "engine", cmd];
	if (!(await tmux(args)).ok) fail("tmux での起動に失敗しました");
	console.log(
		`起動しました。窓口と worker は 15 秒ほどで立ち上がります（tmux attach -t ${config.tmuxSession} で確認できます）`,
	);
}

async function cmdDown() {
	const config = loadConfig(home);
	const r = await tmux(["send-keys", "-t", `${config.tmuxSession}:engine`, "C-c"]);
	if (!r.ok) {
		const pidFile = path.join(home, "engine.pid");
		if (!existsSync(pidFile)) fail("起動していません");
		process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
	}
	console.log("停止しました（窓口と各 worker のセッションは動いたままです）");
}

function cmdStatus() {
	const file = path.join(home, "status.json");
	if (!existsSync(file)) fail("status がありません（engine 未起動）");
	const s = JSON.parse(readFileSync(file, "utf8"));
	let alive = false;
	try {
		process.kill(s.pid, 0);
		alive = true;
	} catch {}
	console.log(`engine: ${alive ? `動作中 (pid ${s.pid})` : "停止"}  更新 ${s.updatedAt}`);
	console.log(
		`Discord: ${s.discord.connected ? `接続中 (${s.discord.bot})` : "未接続"}${s.discord.fatal ? `  ⚠️ ${s.discord.fatal}` : ""}`,
	);
	console.log("セッション:");
	if (s.sessions.length === 0) console.log("  （なし）");
	for (const x of s.sessions) console.log(`  ${x.name.padEnd(18)} ${x.role.padEnd(9)} pid ${x.pid}  ${x.cwd}`);
	const ledger = new Ledger(home);
	console.log(`\n${ledger.renderBoard()}`);
}

async function cmdAdd(spec: string | undefined, flags: Record<string, string | boolean>) {
	if (!spec)
		fail("dle add <owner/repo またはパス> [--native <コマンド> | --harness] [--tmux-session <名前>] [--name <名前>]");
	const config = loadConfig(home);
	const args = {
		spec,
		native: typeof flags.native === "string" ? flags.native : undefined,
		harness: flags.harness === true,
		tmux_session: typeof flags["tmux-session"] === "string" ? flags["tmux-session"] : undefined,
		name: typeof flags.name === "string" ? flags.name : undefined,
	};
	const viaEngine = (await callEngine(config, "project_add", args)) as Awaited<
		ReturnType<typeof registerProject>
	> | null;
	// engine が止まっていれば台帳に直接書く（書き手が engine だけ、という前提は起動中にだけ要る）
	const r =
		viaEngine ??
		(await registerProject(new Ledger(home), config, spec, {
			native: args.native,
			harness: args.harness,
			tmuxSession: args.tmux_session,
			name: args.name,
		}));
	const p = r.project;
	console.log(
		`${p.name} を登録しました（${p.path} / ${p.mode === "native" ? `native: ${p.initialPrompt ?? "（コマンドなし）"}` : "harness"}）`,
	);
	if (p.mode === "harness" && !r.ready)
		console.log("  設定が無いので、worker がまずリポジトリを調べて設定の案を出します（A-番号で確認が来ます）");
	for (const n of r.notes) console.log(`  ⚠️ ${n}`);
	if (!viaEngine) console.log("  engine が止まっています。dle up で worker が起動します");
}

async function cmdRead(name: string, args: Record<string, unknown>, local: (l: Ledger) => unknown) {
	const config = loadConfig(home);
	const r = await callEngine(config, name, args).catch((e: Error) => fail(e.message));
	show(r ?? local(new Ledger(home)));
}

async function cmdAttention(argv: string[]) {
	if (!argv.some((arg) => /^--(?:all|answered)(?:=|$)/.test(arg)))
		return cmdRead("attention_list", {}, (l) => l.openAttention());
	const valid = new Set(["--all", "--answered", "--json"]);
	if (
		argv.length !== 2 ||
		new Set(argv).size !== 2 ||
		!argv.includes("--json") ||
		argv.some((arg) => !valid.has(arg))
	) {
		console.error("attention: --all または --answered と --json を指定してください");
		process.exitCode = 2;
		return;
	}
	try {
		const snapshot = await readAttentionSnapshot(home);
		if (argv.includes("--answered")) snapshot.items = snapshot.items.filter((item) => item.status === "resolved");
		console.log(JSON.stringify(snapshot));
	} catch {
		console.error("attention: 保存済み台帳を読み取れません");
		process.exitCode = 1;
	}
}

async function cmdProjects(json: boolean) {
	const config = loadConfig(home);
	const viaEngine = (await callEngine(config, "projects_list", {}).catch(() => null)) as
		| (Project & { live: boolean; ready: boolean })[]
		| null;
	const ledger = new Ledger(home);
	const list = viaEngine ?? ledger.projects().map((p) => ({ ...p, live: false, ready: ledger.isReady(p) }));
	if (json) return show(list);
	if (list.length === 0) return console.log("登録されているリポジトリはありません（dle add で登録）");
	if (!viaEngine) console.log("※ engine が止まっているため、接続の状態は分かりません\n");
	for (const p of list) {
		const how =
			p.mode === "native"
				? `native（${p.initialPrompt ?? "コマンドなし"}${p.tmuxSession ? ` / tmux ${p.tmuxSession}` : ""}）`
				: p.ready
					? "harness"
					: `harness・設定の確認待ち${p.harnessOnly ? "（独自ループから写す）" : ""}`;
		const state = !p.active ? "⏸ 停止中" : !viaEngine ? "　" : p.live ? "🟢 接続中" : "⚪ 未接続";
		console.log(`${state} ${p.name}  ${how}\n    ${p.repo}  ${p.path}`);
	}
}

async function cmdRestart(args: string[]) {
	const parsed = (() => {
		try {
			return parseRestartArgs(args);
		} catch (e) {
			return fail((e as Error).message);
		}
	})();
	const config = loadConfig(home);
	// ウィンドウは engine が閉じる（プロジェクトごとの tmux セッションを engine だけが知っているため）
	if ("name" in parsed) {
		const r = await callEngine(config, "restart", { name: parsed.name });
		if (r === null) fail("engine に接続できません（dle up で起動してください）");
		console.log(`${parsed.name} を次の巡回（30 秒以内）で起動し直します`);
		return;
	}
	const r = (await callEngine(config, "restart", {
		[parsed.mode]: true,
		...(parsed.except.length ? { except: parsed.except } : {}),
	}).catch((e: Error) => fail(e.message))) as {
		restarted: string[];
		skipped: { name: string; reason: string }[];
	} | null;
	if (r === null) fail("engine に接続できません（dle up で起動してください）");
	console.log(
		r.restarted.length
			? `次の巡回（30 秒以内）で起動し直します: ${r.restarted.join(", ")}`
			: parsed.mode === "limited"
				? "上限中の worker はありません"
				: "起動し直す対象がありません",
	);
	for (const s of r.skipped) console.log(`見送り: ${s.name}（${s.reason}）。しばらくしてからもう一度実行してください`);
}

async function cmdMode(name: string | undefined, mode: string | undefined, flags: Record<string, string | boolean>) {
	if (!name || (mode !== "harness" && mode !== "native"))
		fail("dle mode <名前> harness|native [--command <ループを始めるコマンド>] [--tmux-session <名前>]");
	const config = loadConfig(home);
	const r = (await callEngine(config, "project_mode", {
		name,
		mode,
		command: typeof flags.command === "string" ? flags.command : undefined,
		tmux_session: typeof flags["tmux-session"] === "string" ? flags["tmux-session"] : undefined,
	}).catch((e: Error) => fail(e.message))) as {
		project: { mode: string; initialPrompt?: string };
		notes: string[];
	} | null;
	if (r === null) fail("engine に接続できません（dle up で起動してください）");
	console.log(
		`${name} を ${r.project.mode === "native" ? `native（${r.project.initialPrompt}）` : "harness（issue-loop）"} に切り替えました。worker は 30 秒以内に起動し直します`,
	);
	for (const n of r.notes) console.log(`  ${n}`);
}

async function cmdNotify(flags: Record<string, string | boolean>) {
	const config = loadConfig(home);
	const args: Record<string, unknown> = {};
	for (const k of ["project", "event", "title", "url", "issue", "pr", "body", "file", "phase"]) {
		if (typeof flags[k] === "string") args[k] = flags[k];
	}
	// engine の cwd からは相対パスが見えないので、呼び出し側の cwd で絶対パスにしてから渡す
	if (typeof args.file === "string" && args.file) args.file = path.resolve(process.cwd(), args.file);
	const r = await callEngine(config, "notify", args).catch((e: Error) => fail(`dle notify: ${e.message}`));
	if (r === null) {
		console.error("dle notify: engine が起動していません");
		process.exit(3);
	}
	const att = (r as { attention?: string }).attention;
	console.error(`dle notify: 記録しました${att ? `（${att} を Discord に投稿）` : ""}`);
	if (flags.json) console.log(JSON.stringify(r));
	else if (att) console.log(att);
}

async function cmdDoctor() {
	const results: string[] = [];
	const check = (ok: boolean, label: string, hint = "") =>
		results.push(`${ok ? "✅" : "❌"} ${label}${!ok && hint ? `\n   → ${hint}` : ""}`);
	// TypeScript の型ストリップが既定で使えるのが 22.18 から
	const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
	check(
		major > 22 || (major === 22 && minor >= 18),
		`Node ${process.versions.node}`,
		"Node 24 LTS の最新を入れてください（22.18 以上が必要）",
	);
	let config: Config | null = null;
	try {
		config = loadConfig(home);
		check(true, `設定 ${path.join(home, "config.json")}`);
	} catch (e) {
		check(false, "設定", (e as Error).message);
	}
	const token = readToken(home);
	check(Boolean(token), "Bot トークン", `DISCORD_BOT_TOKEN を環境変数か ${path.join(home, ".env")} に`);
	const which = (cmd: string, args: string[]) =>
		new Promise<string | null>((r) =>
			execFile(cmd, args, (err, out) => r(err ? null : (String(out).trim().split("\n")[0] ?? ""))),
		);
	for (const [cmd, args, hint] of [
		["tmux", ["-V"], "tmux をインストールしてください"],
		["claude", ["--version"], "Claude Code をインストールしてください"],
		["codex", ["--version"], "Codex CLI をインストールしてください（worker が設計・実装に使う）"],
		["gh", ["--version"], "GitHub CLI を入れて gh auth login してください"],
		["git", ["--version"], ""],
		["jq", ["--version"], "jq をインストールしてください（ハーネスのスクリプトが使う）"],
	] as const) {
		const v = await which(cmd, [...args]);
		check(Boolean(v), `${cmd} ${v ?? ""}`, hint);
	}
	if (token && config) {
		const rest = new Rest({ token });
		try {
			const me = await rest.me();
			check(true, `Bot として認証できる（${me.username}）`);
			for (const id of config.channelIds) {
				try {
					const ch = await rest.channel(id);
					check(true, `チャンネル #${ch.name} を参照できる`);
				} catch (e) {
					check(
						false,
						`チャンネル ${id}`,
						`Bot をサーバーに招待し、View Channels / Send Messages / Read Message History / Add Reactions / Attach Files / Manage Messages（ピン留め）を許可してください（${(e as Error).message}）`,
					);
				}
			}
		} catch (e) {
			check(false, "Bot の認証", (e as Error).message);
		}
	}
	const ledger = new Ledger(home);
	for (const p of ledger.projects()) check(existsSync(p.path), `プロジェクト ${p.name}`, `${p.path} がありません`);
	console.log(results.join("\n"));
	console.log(
		"\n※ Developer Portal の Bot → Privileged Gateway Intents で Message Content Intent を有効にしてください（無効だと起動時に close 4014 で止まります）。",
	);
	console.log(
		"※ Claude Code にプラグインを入れておいてください: /plugin marketplace add jonnity/discord-loop-engine → /plugin install discord-loop-engine@discord-loop-engine",
	);
}

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);
const commands: Record<string, () => unknown> = {
	init: cmdInit,
	doctor: cmdDoctor,
	start: cmdStart,
	up: cmdUp,
	down: cmdDown,
	status: cmdStatus,
	add: () => cmdAdd(rest[0], flags),
	projects: () => cmdProjects(flags.json === true),
	tasks: () =>
		cmdRead("tasks_list", { all: flags.all === true }, (l) =>
			l.tasks().filter((t) => flags.all || t.status !== "done"),
		),
	attention: () => cmdAttention(argv),
	board: () => cmdRead("board_show", {}, (l) => l.renderBoard()),
	restart: () => cmdRestart(argv),
	mode: () => cmdMode(rest[0], rest[1], flags),
	notify: () => cmdNotify(flags),
};
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
	console.error(
		readFileSync(SELF, "utf8")
			.split("\n")
			.slice(0, 17)
			.map((l) => l.replace(/^\/\/ ?/, ""))
			.join("\n"),
	);
	process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn()).catch((e: Error) => fail(e.message));
