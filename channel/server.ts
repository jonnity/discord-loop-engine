// Claude Code の channel（MCP サーバー, stdio）。各セッションに1つ起動され、ローカルの engine に
// 役割（窓口 / worker）で登録する。engine からのメッセージをセッションへ流し込み、台帳や Discord を扱う
// ツール（dle の各ツール）を提供する。
//
// MCP SDK を使わないのは、必要なのが initialize / tools/list / tools/call と通知の送信だけで、
// プラグインのキャッシュに node_modules を入れる手間（と依存）を増やしたくないから。

import { existsSync, readFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import {
	dleHome,
	type EngineMessage,
	lineReader,
	PROTOCOL_VERSION,
	type Role,
	send,
	socketPath,
} from "../src/protocol.ts";

import { TOOLS } from "../src/tools.ts";

const VERSION = "0.1.0";
const home = dleHome();

function log(msg: string) {
	process.stderr.write(`[dle channel] ${msg}\n`);
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// プラグインを有効にすると、engine から起動したのではない普通のセッションでもこのサーバーは立ち上がる。
// そこまで engine に登録すると、届いても読まれない所へメッセージが流れてしまうため、
// engine が DLE_ROLE を付けて起動したセッションだけを対象にする。
const roleEnv = process.env.DLE_ROLE;
const role: Role | null = roleEnv === "concierge" || roleEnv === "worker" ? roleEnv : null;
const project = process.env.DLE_PROJECT ?? "";
const engineConfig = readJson(path.join(home, "config.json")) ?? {};
const permissionRelay = role !== null && engineConfig.permissionRelay === true;
const sock =
	typeof engineConfig.socketPath === "string" && !process.env.DLE_SOCKET ? engineConfig.socketPath : socketPath(home);

// --- ツール定義 ---------------------------------------------------------------------

const myTools = role ? TOOLS.filter((t) => t.roles.includes(role)) : [];

const INSTRUCTIONS =
	role === "concierge"
		? `あなたは discord-loop-engine の窓口です。ユーザーとのやり取りはすべて Discord（<channel source="dle">）で届き、返事は reply ツールだけで返します。
振る舞いの詳細は /discord-loop-engine:concierge スキルに従ってください。meta.attention があればその A-番号への返事、meta.kind=notice は engine からのお知らせ（Discord への再投稿は不要）、meta.kind=retro は振り返りの依頼です。`
		: role === "worker" && process.env.DLE_LOOP === "native"
			? `あなたは discord-loop-engine の worker（プロジェクト「${project}」）で、このリポジトリ独自のループ（CLAUDE.md・.claude/skills の手順）で進めます。
discord-loop-engine のハーネス（issue-loop・harness-*）は使わず、リポジトリの手順・通知の仕組みをそのまま守ってください。
<channel source="dle"> で届く窓口からの依頼（meta.from=concierge）や A-番号への回答（meta.attention）は、ユーザーからの指示として扱います。
作業の節目（着手・PR 作成・マージ・止まった理由）は report ツールで台帳に一言残すと、窓口がユーザーに状況を答えられます。うまくいかなかったことは learning_add で記録します。`
			: role === "worker"
				? `あなたは discord-loop-engine の worker（プロジェクト「${project}」）です。ユーザーとは直接話さず、窓口と engine を通します。
<channel source="dle"> で届くのは、窓口からの依頼（meta.from=concierge）・A-番号への回答（meta.attention）・仮ルール（meta.kind=rules）です。扱い方は /discord-loop-engine:issue-loop スキルの「engine との連携」に従ってください。
設定がまだ無いプロジェクトでは、最初に /discord-loop-engine:onboard で調査と設定を行います。`
				: "このセッションは discord-loop-engine の中継対象ではありません（engine から起動したセッションだけが対象）。";

// --- engine との接続 -------------------------------------------------------------------
let engine: Socket | null = null;
let ready = false;
let seq = 0;
const pending = new Map<string, (r: Extract<EngineMessage, { type: "result" }>) => void>();

function connectEngine() {
	if (!existsSync(sock)) {
		setTimeout(connectEngine, 5000);
		return;
	}
	const c = net.createConnection(sock);
	c.on("connect", () => {
		engine = c;
		send(c, {
			type: "hello",
			protocol: PROTOCOL_VERSION,
			role: role as Role,
			project: project || undefined,
			pid: process.pid,
			cwd: process.cwd(),
		});
	});
	c.on(
		"data",
		lineReader<EngineMessage>((m) => onEngine(m)),
	);
	c.on("close", () => {
		if (engine === c) engine = null;
		ready = false;
		setTimeout(connectEngine, 5000);
	});
	c.on("error", () => {});
}

function onEngine(m: EngineMessage) {
	switch (m.type) {
		case "welcome":
			ready = true;
			log(`engine に登録しました（${role}${project ? ` / ${project}` : ""}）`);
			break;
		case "error":
			log(`engine: ${m.message}`);
			break;
		case "event":
			notify("notifications/claude/channel", { content: m.content, meta: m.meta });
			break;
		case "permission":
			notify("notifications/claude/channel/permission", { request_id: m.request_id, behavior: m.behavior });
			break;
		case "result": {
			const p = pending.get(m.id);
			if (p) {
				pending.delete(m.id);
				p(m);
			}
			break;
		}
	}
}

function callEngine(name: string, args: unknown): Promise<Extract<EngineMessage, { type: "result" }>> {
	return new Promise((resolve) => {
		if (!engine || !ready) {
			resolve({
				type: "result",
				id: "",
				ok: false,
				error: "discord-loop-engine が起動していないか、まだ接続されていません（dle status で確認）",
			});
			return;
		}
		const id = `c${++seq}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ type: "result", id, ok: false, error: "engine から応答がありません（60 秒）" });
		}, 60_000);
		pending.set(id, (r) => {
			clearTimeout(timer);
			resolve(r);
		});
		// 未検査の値を改変せず wire に載せ、engine の入口で検査する。
		send(engine, { type: "call", id, name, args: args as Record<string, unknown> });
	});
}

// --- MCP（stdio, 1行1メッセージの JSON-RPC） ----------------------------------------------
function write(obj: unknown) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function notify(method: string, params: unknown) {
	write({ jsonrpc: "2.0", method, params });
}

type Rpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };
const text = (t: string, isError = false) => ({
	content: [{ type: "text", text: t }],
	...(isError ? { isError: true } : {}),
});

async function handle(req: Rpc): Promise<unknown> {
	switch (req.method) {
		case "initialize": {
			const experimental: Record<string, object> = { "claude/channel": {} };
			if (permissionRelay) experimental["claude/channel/permission"] = {};
			return {
				protocolVersion: (req.params?.protocolVersion as string) || "2025-06-18",
				capabilities: { experimental, tools: {} },
				serverInfo: { name: "dle", version: VERSION },
				instructions: INSTRUCTIONS,
			};
		}
		case "ping":
			return {};
		case "tools/list":
			return { tools: myTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
		case "tools/call": {
			const name = req.params?.name as string;
			const args = req.params?.arguments === undefined ? {} : req.params.arguments;
			if (!myTools.some((t) => t.name === name)) {
				return text(
					role ? `${name} はこの役割では使えません` : "このセッションは discord-loop-engine の中継対象ではありません",
					true,
				);
			}
			if (
				name === "reply" &&
				typeof args === "object" &&
				args !== null &&
				!Array.isArray(args) &&
				"files" in args &&
				Array.isArray(args.files) &&
				args.files.every((f: unknown) => typeof f === "string")
			) {
				const missing = args.files.filter((f) => !path.isAbsolute(f) || !existsSync(f));
				if (missing.length) return text(`添付ファイルが見つかりません（絶対パスで指定）: ${missing.join(", ")}`, true);
			}
			const r = await callEngine(name, args);
			if (!r.ok) return text(`失敗: ${r.error}`, true);
			return text(typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2));
		}
		default:
			throw { code: -32601, message: `method not found: ${req.method}` };
	}
}

function onRpc(msg: Rpc) {
	if (msg.method === "notifications/claude/channel/permission_request") {
		if (permissionRelay && engine)
			send(engine, { type: "permission_request", ...(msg.params as { request_id: string; tool_name: string }) });
		return;
	}
	if (msg.id === undefined || msg.method === undefined) return; // 通知やレスポンスは無視
	handle(msg).then(
		(result) => write({ jsonrpc: "2.0", id: msg.id, result }),
		(err: { code?: number; message?: string }) =>
			write({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } }),
	);
}

process.stdin.on(
	"data",
	lineReader<Rpc>(onRpc, () => log("不正な JSON-RPC 行を無視しました")),
);
process.stdin.on("end", () => process.exit(0));
if (role) connectEngine();
