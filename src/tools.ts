// 公開 schema と engine の入力検査を、同じ定義から作る。
import type { Role } from "./protocol.ts";

export type PropertySchema = { description?: string } & (
	| { type: "string"; minLength?: 1 }
	| { type: "boolean" }
	| { type: "number" }
	| { type: "array"; items: PropertySchema }
	| { type: "object" }
	| { type: ["object", "string"] }
);

export interface InputSchema {
	type: "object";
	properties: Record<string, PropertySchema>;
	required?: string[];
	additionalProperties: false;
}

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: InputSchema;
	roles: Role[];
	argumentHints?: Record<string, string>;
}

const s = (description: string) => ({ type: "string" as const, description });
export const TOOLS: ToolDef[] = [
	{
		name: "reply",
		description:
			"Discord に投稿する（あなたの声はこれだけ）。届いたメッセージへの返事なら chat_id と reply_to に meta の値を渡す。",
		inputSchema: {
			additionalProperties: false,
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
			additionalProperties: false,
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
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { id: s("T-0007 など") },
			required: ["id"],
		},
		roles: ["concierge", "worker"],
	},
	{
		name: "task_create",
		description: "台帳にタスクを作る。リポジトリの作業なら先に Issue を起票して issue を渡す",
		inputSchema: {
			additionalProperties: false,
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
			additionalProperties: false,
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
				phase: s("作業フェーズ"),
			},
			required: ["id"],
		},
		roles: ["concierge"],
	},
	{
		name: "attention_list",
		description:
			"あなた待ち（A-番号）の一覧。project・issue で絞れる。includeResolved を true にすると回答済みの A も返し、回答の全文（answer）と回答時刻（resolvedAt）が付く",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: {
				project: s("このプロジェクトの A だけ"),
				issue: s("この Issue 番号の A だけ（#なしの数字）"),
				includeResolved: { type: "boolean", description: "回答済みの A も含める（既定は開いているものだけ）" },
			},
		},
		roles: ["concierge", "worker"],
	},
	{
		name: "attention_answer",
		description: "A-番号への回答を記録し、該当の worker に渡す（worker が止まっていれば起動後に渡る）",
		inputSchema: {
			additionalProperties: false,
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
			additionalProperties: false,
			type: "object",
			properties: { project: s("プロジェクト名"), text: { ...s("指示"), minLength: 1 }, task_id: s("関係するタスク") },
			required: ["project", "text"],
		},
		argumentHints: { message: "text" },
		roles: ["concierge"],
	},
	{
		name: "board_show",
		description: "ボード（あなた待ち・作業中・次に着手）を文字で得る",
		inputSchema: { additionalProperties: false, type: "object", properties: {} },
		roles: ["concierge", "worker"],
	},
	{
		name: "projects_list",
		description: "登録済みのリポジトリと、worker が動いているか",
		inputSchema: { additionalProperties: false, type: "object", properties: {} },
		roles: ["concierge"],
	},
	{
		name: "project_add",
		description: "リポジトリを登録する（owner/repo なら clone、パスなら既存の場所）。worker は自動で起動する",
		inputSchema: {
			additionalProperties: false,
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
			additionalProperties: false,
			type: "object",
			properties: {
				mode: s("harness（issue-loop で進める）か native（そのリポジトリ独自のループで進める）"),
				profile: {
					type: ["object", "string"],
					description:
						"harness のときの設定（gate・setup・context・demo・humanChecks・permissions など。templates/profile.example.json の形）",
				},
				initial_prompt: s("native のとき、そのリポジトリのループを始めるコマンド"),
				tmux_session: s("native のとき、そのリポジトリが前提にしている tmux セッション名（あれば）"),
				summary: s("人に見せる要約（調べて分かったこと・判断の理由・自動では確かめられないこと）"),
				project: s("非workerから指定するプロジェクト名"),
			},
			required: ["mode", "summary"],
		},
		roles: ["worker"],
	},
	{
		name: "profile_template",
		description: "プロジェクト設定の雛形と、調査済みの例（onboard で設定の案を作るときに使う）",
		inputSchema: { additionalProperties: false, type: "object", properties: {} },
		roles: ["worker"],
	},
	{
		name: "profile_get",
		description: "プロジェクトの設定（使われている harness.json の場所と中身・確認待ちの案）",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { project: s("窓口から見るときのプロジェクト名") },
		},
		roles: ["concierge", "worker"],
	},
	{
		name: "profile_activate",
		description: "確認で OK をもらった設定の案を確定する",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { project: s("非workerから指定するプロジェクト名") },
		},
		roles: ["worker"],
	},
	{
		name: "project_mode",
		description:
			"ループの進め方を切り替える。harness は dle の issue-loop（設定が無ければ worker が調べ直して A-番号で確認する）、native はそのリポジトリ独自のループ。worker は起動し直す",
		inputSchema: {
			additionalProperties: false,
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
			additionalProperties: false,
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
			additionalProperties: false,
			type: "object",
			properties: {
				issue: s("Issue 番号"),
				task_id: s("T-0007 など"),
				status: s("ai-working/blocked/done など"),
				pr: s(""),
				next: s("次にやること"),
				note: s("経緯に残す一言"),
				title: s("件名"),
				project: s("非workerから指定するプロジェクト名"),
			},
		},
		roles: ["worker"],
	},
	{
		name: "learning_add",
		description: "うまくいかなかったこと（CI 失敗・NG・差し戻し・止まった・訂正された）を記録する。自己改善の材料",
		inputSchema: {
			additionalProperties: false,
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
		inputSchema: { additionalProperties: false, type: "object", properties: {} },
		roles: ["concierge", "worker"],
	},
	{
		name: "learnings_list",
		description: "未整理の学びの一覧（index 付き）",
		inputSchema: { additionalProperties: false, type: "object", properties: { include_promoted: { type: "boolean" } } },
		roles: ["concierge"],
	},
	{
		name: "learnings_promote",
		description: "ルール化した学びに印を付ける",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { indexes: { type: "array", items: { type: "number" } } },
			required: ["indexes"],
		},
		roles: ["concierge"],
	},
	{
		name: "rules_set",
		description: "仮ルールを丸ごと書き換える（動いている worker にすぐ届く）",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { content: { ...s("Markdown"), minLength: 1 } },
			required: ["content"],
		},
		argumentHints: { text: "content" },
		roles: ["concierge"],
	},
	{
		name: "retro_done",
		description: "振り返りを終えたことを記録する",
		inputSchema: {
			additionalProperties: false,
			type: "object",
			properties: { summary: s("要約") },
			required: ["summary"],
		},
		roles: ["concierge"],
	},
	{
		name: "notify",
		description: "CLI からの通知",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				project: s(""),
				event: s(""),
				title: s(""),
				url: s(""),
				issue: s(""),
				pr: s(""),
				body: s(""),
				file: s(""),
				phase: s(""),
			},
		},
		roles: ["cli"],
	},
	{
		name: "restart",
		description:
			"CLI からセッションを再起動する。name / limited / all のどれか1つ。except は limited / all のときだけ（除外する名前）",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: s("セッション名"),
				limited: { type: "boolean", description: "使用量の上限で止まっている worker だけ" },
				all: { type: "boolean", description: "窓口と全 worker" },
				except: { type: "array", items: { type: "string" }, description: "除外するセッション名" },
			},
		},
		roles: ["cli"],
	},
];
