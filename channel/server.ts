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
type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
interface ToolDef {
	name: string;
	description: string;
	inputSchema: Schema;
	roles: Role[];
}

const s = (description: string) => ({ type: "string", description });
const TOOLS: ToolDef[] = [
	{
		name: "reply",
		description:
			"Discord に投稿する（あなたの声はこれだけ）。届いたメッセージへの返事なら chat_id と reply_to に meta の値を渡す。",
		inputSchema: {
			type: "object",
			properties: {
				text: s("本文（長ければ自動で分割される）"),
				chat_id: s("返信先チャンネル（meta.chat_id）。省略時は共通チャンネル"),
				reply_to: s("返信元メッセージ ID（meta.message_id）"),
				project: s("話題のプロジェクト名（先頭の [..] に出る）。省略時は「窓口」"),
				files: { type: "array", items: { type: "string" }, description: "添付するローカルファイルの絶対パス" },
			},
			required: ["text"],
		},
		roles: ["concierge"],
	},
	{
		name: "tasks_list",
		description: "台帳のタスク一覧（既定は未完了だけ）",
		inputSchema: {
			type: "object",
			properties: {
				status: s("inbox/queued/ai-working/waiting-human/blocked/done"),
				project: s("プロジェクト名"),
				all: { type: "boolean", description: "完了も含める" },
			},
		},
		roles: ["concierge", "worker"],
	},
	{
		name: "task_get",
		description: "タスク1件（経緯つき）",
		inputSchema: { type: "object", properties: { id: s("T-0007 など") }, required: ["id"] },
		roles: ["concierge", "worker"],
	},
	{
		name: "task_create",
		description: "台帳にタスクを作る。リポジトリの作業なら先に Issue を起票して issue を渡す",
		inputSchema: {
			type: "object",
			properties: {
				project: s("プロジェクト名（リポジトリ外の用事は -）"),
				title: s("件名"),
				issue: s("Issue 番号"),
				next: s("次にやること"),
				note: s("経緯に残す一言"),
			},
			required: ["project", "title"],
		},
		roles: ["concierge"],
	},
	{
		name: "task_update",
		description: "タスクを更新し、経緯に一言残す",
		inputSchema: {
			type: "object",
			properties: {
				id: s("T-0007 など"),
				status: s("inbox/queued/ai-working/waiting-human/blocked/done"),
				title: s(""),
				issue: s(""),
				pr: s(""),
				waiting: s("何を待っているか"),
				next: s("次にやること"),
				note: s("経緯に残す一言"),
			},
			required: ["id"],
		},
		roles: ["concierge"],
	},
	{
		name: "attention_list",
		description: "あなた待ち（A-番号）の一覧",
		inputSchema: { type: "object", properties: {} },
		roles: ["concierge", "worker"],
	},
	{
		name: "attention_answer",
		description: "A-番号への回答を記録し、該当の worker に渡す（worker が止まっていれば起動後に渡る）",
		inputSchema: {
			type: "object",
			properties: { id: s("A-4 など"), answer: s("回答の本文（誰がどこで答えたかも添える）") },
			required: ["id", "answer"],
		},
		roles: ["concierge"],
	},
	{
		name: "dispatch",
		description: "worker に指示を渡す（起動していなければ起動後に渡る）",
		inputSchema: {
			type: "object",
			properties: { project: s("プロジェクト名"), text: s("指示"), task_id: s("関係するタスク") },
			required: ["project", "text"],
		},
		roles: ["concierge"],
	},
	{
		name: "board_show",
		description: "ボード（あなた待ち・作業中・次に着手）を文字で得る",
		inputSchema: { type: "object", properties: {} },
		roles: ["concierge", "worker"],
	},
	{
		name: "projects_list",
		description: "登録済みのリポジトリと、worker が動いているか",
		inputSchema: { type: "object", properties: {} },
		roles: ["concierge"],
	},
	{
		name: "project_add",
		description: "リポジトリを登録する（owner/repo なら clone、パスなら既存の場所）。worker は自動で起動する",
		inputSchema: {
			type: "object",
			properties: {
				spec: s("jonnity/kishimen-tool または ~/src/kishimen-tool"),
				native: s("そのリポジトリ独自のループで進める場合、それを始めるコマンド（例: /parallel-cycle-loop）"),
				harness: {
					type: "boolean",
					description: "独自のループがあっても dle の issue-loop で進めると決まっているとき true",
				},
				tmux_session: s("native のとき、そのリポジトリのスクリプトが前提にしている tmux セッション名（例: dev）"),
				name: s("プロジェクト名を変えたいとき"),
			},
			required: ["spec"],
		},
		roles: ["concierge"],
	},
	{
		name: "profile_propose",
		description:
			"調査したプロジェクトの設定の案を出す。engine が A-番号で人に確認を求め、回答は meta.attention 付きで届く。OK なら profile_activate を呼ぶ",
		inputSchema: {
			type: "object",
			properties: {
				mode: s("harness（issue-loop で進める）か native（そのリポジトリ独自のループで進める）"),
				profile: {
					type: "object",
					description:
						"harness のときの設定（gate・setup・context・demo・humanChecks・permissions など。templates/profile.example.json の形）",
				},
				initial_prompt: s("native のとき、そのリポジトリのループを始めるコマンド"),
				tmux_session: s("native のとき、そのリポジトリが前提にしている tmux セッション名（あれば）"),
				summary: s("人に見せる要約（調べて分かったこと・判断の理由・自動では確かめられないこと）"),
			},
			required: ["mode", "summary"],
		},
		roles: ["worker"],
	},
	{
		name: "profile_template",
		description: "プロジェクト設定の雛形と、調査済みの例（onboard で設定の案を作るときに使う）",
		inputSchema: { type: "object", properties: {} },
		roles: ["worker"],
	},
	{
		name: "profile_get",
		description: "プロジェクトの設定（使われている harness.json の場所と中身・確認待ちの案）",
		inputSchema: { type: "object", properties: { project: s("窓口から見るときのプロジェクト名") } },
		roles: ["concierge", "worker"],
	},
	{
		name: "profile_activate",
		description: "確認で OK をもらった設定の案を確定する",
		inputSchema: { type: "object", properties: {} },
		roles: ["worker"],
	},
	{
		name: "project_mode",
		description:
			"ループの進め方を切り替える。harness は dle の issue-loop（設定が無ければ worker が調べ直して A-番号で確認する）、native はそのリポジトリ独自のループ。worker は起動し直す",
		inputSchema: {
			type: "object",
			properties: {
				name: s("プロジェクト名"),
				mode: s("harness か native"),
				command: s("native のとき、そのリポジトリのループを始めるコマンド（例: /parallel-cycle-loop）"),
				tmux_session: s("native のとき、そのリポジトリが前提にしている tmux セッション名（あれば）"),
			},
			required: ["name", "mode"],
		},
		roles: ["concierge"],
	},
	{
		name: "project_set_active",
		description: "worker を動かすかどうかを切り替える",
		inputSchema: {
			type: "object",
			properties: { name: s("プロジェクト名"), active: { type: "boolean" } },
			required: ["name", "active"],
		},
		roles: ["concierge"],
	},
	{
		name: "report",
		description:
			"自分のタスクの進み具合を台帳に残す（フェーズの変化は harness-phase が自動で報告するので、それ以外の節目に使う）",
		inputSchema: {
			type: "object",
			properties: {
				issue: s("Issue 番号"),
				task_id: s("T-0007 など"),
				status: s("ai-working/blocked/done など"),
				pr: s(""),
				next: s("次にやること"),
				note: s("経緯に残す一言"),
			},
		},
		roles: ["worker"],
	},
	{
		name: "learning_add",
		description: "うまくいかなかったこと（CI 失敗・NG・差し戻し・止まった・訂正された）を記録する。自己改善の材料",
		inputSchema: {
			type: "object",
			properties: {
				tag: s("ci-red / user-ng / review-ng / stall / correction / scope-miss など"),
				summary: s("一言"),
				detail: s("原因と状況"),
				issue: s(""),
				project: s(""),
			},
			required: ["tag", "summary"],
		},
		roles: ["concierge", "worker"],
	},
	{
		name: "rules_get",
		description: "現在の仮ルール（learnings/rules.md）",
		inputSchema: { type: "object", properties: {} },
		roles: ["concierge", "worker"],
	},
	{
		name: "learnings_list",
		description: "未整理の学びの一覧（index 付き）",
		inputSchema: { type: "object", properties: { include_promoted: { type: "boolean" } } },
		roles: ["concierge"],
	},
	{
		name: "learnings_promote",
		description: "ルール化した学びに印を付ける",
		inputSchema: {
			type: "object",
			properties: { indexes: { type: "array", items: { type: "number" } } },
			required: ["indexes"],
		},
		roles: ["concierge"],
	},
	{
		name: "rules_set",
		description: "仮ルールを丸ごと書き換える（動いている worker にすぐ届く）",
		inputSchema: { type: "object", properties: { content: s("Markdown") }, required: ["content"] },
		roles: ["concierge"],
	},
	{
		name: "retro_done",
		description: "振り返りを終えたことを記録する",
		inputSchema: { type: "object", properties: { summary: s("要約") }, required: ["summary"] },
		roles: ["concierge"],
	},
];

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

function callEngine(name: string, args: Record<string, unknown>): Promise<Extract<EngineMessage, { type: "result" }>> {
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
		send(engine, { type: "call", id, name, args });
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
			return { tools: myTools.map(({ roles: _r, ...t }) => t) };
		case "tools/call": {
			const name = req.params?.name as string;
			const args = (req.params?.arguments as Record<string, unknown>) ?? {};
			if (!myTools.some((t) => t.name === name)) {
				return text(
					role ? `${name} はこの役割では使えません` : "このセッションは discord-loop-engine の中継対象ではありません",
					true,
				);
			}
			if (name === "reply" && Array.isArray(args.files)) {
				const missing = (args.files as string[]).filter((f) => !path.isAbsolute(f) || !existsSync(f));
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
