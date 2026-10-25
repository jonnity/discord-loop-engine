// engine 本体。Discord（Bot 1つ）・窓口・各 worker・dle CLI の間に立ち、すべてのやり取りを台帳に残す。
// - Discord から届いた発言はすべて窓口へ（AI とのやり取りの口を1本にするため）
// - worker の「人の判断が要る」報告は、台帳に A-番号で記録してから engine が Bot で投稿する
//   （LLM の判断を挟まないので、通知の漏れが起きない）
// - 窓口からの指示・回答は、worker がいなければ outbox に積み、起動したら渡す（忘れない）

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { type AttentionKind, KIND_LABEL, Ledger, TASK_STATUSES, type Task, type TaskStatus } from "./ledger.ts";
import {
	run as defaultRun,
	ensureLabels,
	ensureOnboardingTask,
	type Run,
	registerProject,
	sessionTargets,
} from "./projects.ts";
import { type ClientMessage, lineReader, type Meta, PROTOCOL_VERSION, type Role, send } from "./protocol.ts";
import type { DiscordApi } from "./rest.ts";
import { chunkText, type DiscordMessage, route, withProject } from "./route.ts";
import type { RefreshResult, Supervisor } from "./supervisor.ts";

export interface GatewayLike {
	start(): void;
	stop(): void;
	connected: boolean;
	user: { id: string; username?: string } | null;
}

interface Session {
	socket: Socket;
	role: Role;
	name: string; // "concierge" またはプロジェクト名
	pid: number;
	cwd: string;
	since: string;
}

const GATE_EVENTS: Record<string, { kind: AttentionKind; icon: string; how: (id: string) => string }> = {
	interview: { kind: "interview", icon: "🟡", how: (id) => `👉 「${id} …」のように回答してください` },
	"merge-request": {
		kind: "merge",
		icon: "🟢",
		how: (id) => `👉 よければ「${id} OK」、直してほしい点があれば「${id} NG: …」と返信してください`,
	},
	blocked: { kind: "blocked", icon: "🔴", how: (id) => `👉 「${id} …」で指示してください` },
	setup: {
		kind: "setup",
		icon: "⚙️",
		how: (id) => `👉 この設定で始めてよければ「${id} OK」、直してほしい点があれば「${id} NG: …」と返信してください`,
	},
};

const PHASE_STATUS: Record<string, TaskStatus> = {
	queued: "queued",
	designing: "ai-working",
	"spec-review": "ai-working",
	implementing: "ai-working",
	"impl-review": "ai-working",
	interview: "waiting-human",
	"awaiting-merge": "waiting-human",
	blocked: "waiting-human",
	done: "done",
};

// profile.hooks に書けるフェーズ（bin/harness-hook と揃える）
const HOOK_PHASES = ["afterWorktree", "beforePR", "onCIRed", "beforeMerge"];

/** profile.hooks の形を確かめる。差し込み口の名前の書き間違いは、黙って実行されないまま気づけないため */
function validateHooks(hooks: unknown) {
	if (hooks === undefined || hooks === null) return;
	if (typeof hooks !== "object" || Array.isArray(hooks))
		throw new Error("profile.hooks は { フェーズ: [コマンド, ...] } の形にしてください");
	for (const [k, v] of Object.entries(hooks)) {
		if (!HOOK_PHASES.includes(k)) throw new Error(`profile.hooks.${k} は使えません（${HOOK_PHASES.join(" / ")}）`);
		if (!Array.isArray(v) || !v.every((c) => typeof c === "string" && c.trim() !== ""))
			throw new Error(`profile.hooks.${k} はコマンドの配列にしてください`);
	}
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export interface EngineOptions {
	config: Config;
	rest: DiscordApi;
	gatewayFactory: (handlers: {
		onMessage: (d: unknown) => void;
		onReady: (user: { id: string } | null) => void;
		onFatal: (reason: string) => void;
		log: (m: string) => void;
	}) => GatewayLike;
	supervisor?: Supervisor | null;
	ledger?: Ledger;
	log?: (m: string) => void;
	exec?: Run;
	boardDebounceMs?: number;
}

export class Engine {
	readonly config: Config;
	readonly ledger: Ledger;
	private rest: DiscordApi;
	private gateway: GatewayLike;
	supervisor: Supervisor | null;
	private log: (m: string) => void;
	private exec: Run;
	readonly sessions = new Map<string, Session>();
	private pendingPermissions = new Map<string, string>(); // request_id → session name
	private botUserId: string | null = null;
	private server: net.Server | null = null;
	private boardTimer: ReturnType<typeof setTimeout> | null = null;
	private boardDebounceMs: number;
	private fatal: string | null = null;
	private startedAt = new Date().toISOString();
	// セッションごとの、前回の /clear 以降に流し込んだ件数と最後のやり取り（supervisor が /clear の判断に使う）
	private activityBy = new Map<string, { events: number; lastAt: number }>();
	// /clear している最中のセッション。この間に届いたものは outbox に溜め、終わってから渡す
	private refreshing = new Set<string>();
	// 窓口との直近のやり取り。/clear の後に渡し直して、会話の続きが分かるようにする
	private recentChat: string[] = [];

	constructor(o: EngineOptions) {
		this.config = o.config;
		this.rest = o.rest;
		this.supervisor = o.supervisor ?? null;
		this.ledger = o.ledger ?? new Ledger(o.config.home);
		this.log = o.log ?? ((m) => console.error(m));
		this.exec = o.exec ?? defaultRun;
		this.boardDebounceMs = o.boardDebounceMs ?? 3000;
		this.gateway = o.gatewayFactory({
			onMessage: (d) => {
				this.onDiscordMessage(d as DiscordMessage).catch((e: Error) => this.log(`engine: 受信処理の失敗 ${e.message}`));
			},
			onReady: (user) => {
				this.botUserId = user?.id ?? null;
				this.writeStatus();
			},
			onFatal: (reason) => {
				this.log(`engine: Discord に接続できません: ${reason}`);
				this.fatal = reason;
				this.writeStatus();
			},
			log: this.log,
		});
	}

	targets() {
		return sessionTargets(this.config, this.ledger.projects(), this.ledger);
	}

	async start() {
		mkdirSync(path.dirname(this.config.socketPath), { recursive: true });
		mkdirSync(path.join(this.config.home, "concierge"), { recursive: true });
		if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
		this.server = net.createServer((s) => this.onConnection(s));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.config.socketPath, () => resolve());
		});
		// 同じマシンの他ユーザーから注入されないよう、ソケットは本人だけが読み書きできるようにする
		chmodSync(this.config.socketPath, 0o600);
		this.gateway.start();
		this.writeStatus();
		this.log(`engine: 待ち受け開始 ${this.config.socketPath}`);
		const c = this.config.concierge.refresh;
		const w = this.config.worker.refresh;
		this.log(
			`engine: 自動コンテキスト整理 concierge: ${c.enabled ? `${c.maxTokens / 1000}k / ${c.maxEvents} 件` : "無効"}、worker: ${w.enabled ? `${w.maxTokens / 1000}k` : "無効"}`,
		);
	}

	async stop() {
		this.gateway.stop();
		if (this.boardTimer) clearTimeout(this.boardTimer);
		for (const s of this.sessions.values()) s.socket.destroy();
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
		if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
	}

	// --- 接続 ---------------------------------------------------------------------------
	private onConnection(socket: Socket) {
		let session: Session | null = null;
		let cli = false;
		socket.on(
			"data",
			lineReader<ClientMessage>(
				(msg) => {
					if (!session && !cli) {
						if (msg.type !== "hello") {
							send(socket, { type: "error", message: "最初に hello を送ってください" });
							socket.end();
							return;
						}
						const r = this.onHello(socket, msg);
						if (r === "cli") cli = true;
						else if (r) session = r;
						else socket.end();
						return;
					}
					const who = session ?? { role: "cli" as Role, name: "cli", socket, pid: 0, cwd: "", since: "" };
					if (msg.type === "call") {
						if (session) this.touch(session.name, 0);
						this.call(who, msg.name, msg.args ?? {}).then(
							(data) => send(socket, { type: "result", id: msg.id, ok: true, data }),
							(err: Error) => send(socket, { type: "result", id: msg.id, ok: false, error: err.message }),
						);
					} else if (msg.type === "permission_request" && session) {
						this.onPermissionRequest(session, msg).catch(() => {});
					}
				},
				() => this.log("engine: 不正な行を受け取りました"),
			),
		);
		socket.on("close", () => {
			if (session && this.sessions.get(session.name)?.socket === socket) {
				this.sessions.delete(session.name);
				this.log(`engine: ${session.name} が切断しました`);
				this.writeStatus();
			}
		});
		socket.on("error", () => {});
	}

	private onHello(socket: Socket, msg: Extract<ClientMessage, { type: "hello" }>): Session | "cli" | null {
		if (msg.protocol !== PROTOCOL_VERSION) {
			send(socket, {
				type: "error",
				message: `engine と接続元のバージョンが合いません（engine ${PROTOCOL_VERSION} / 接続元 ${msg.protocol}）。discord-loop-engine を揃えて更新してください。`,
			});
			return null;
		}
		if (msg.role === "cli") {
			send(socket, { type: "welcome", role: "cli", permissionRelay: this.config.permissionRelay });
			return "cli";
		}
		const name = msg.role === "concierge" ? "concierge" : (msg.project ?? "");
		if (!name) {
			send(socket, { type: "error", message: "worker には project が必要です" });
			return null;
		}
		const prev = this.sessions.get(name);
		if (prev && prev.socket !== socket) {
			// 同じ相手が2つあると、どちらに届けるか曖昧になる。新しい方を正とする。
			send(prev.socket, {
				type: "error",
				message: "同じ役割の新しいセッションが接続したため、こちらへの中継を止めます。",
			});
			prev.socket.end();
		}
		const session: Session = {
			socket,
			role: msg.role,
			name,
			pid: msg.pid,
			cwd: msg.cwd,
			since: new Date().toISOString(),
		};
		this.sessions.set(name, session);
		send(socket, {
			type: "welcome",
			role: msg.role,
			project: msg.project,
			permissionRelay: this.config.permissionRelay,
		});
		this.log(`engine: ${name} が接続しました（pid ${msg.pid}）`);
		this.writeStatus();
		// clear 中の再接続では、rules と保留分を done まで待つ。
		if (!this.refreshing.has(name)) {
			this.sendRules(session);
			this.flushOutbox(session);
		}
		this.supervisor?.onRegistered(name).catch(() => {});
		return session;
	}

	/**
	 * セッションへ流し込む。いなければ outbox に積んでおき、接続したときに渡す。
	 * /clear の最中なら outbox に溜めて "held"（起動していないわけではないので、そう扱わない）
	 */
	deliver(name: string, content: string, meta: Meta): "sent" | "queued" | "held" {
		if (this.refreshing.has(name)) {
			this.ledger.enqueue(name, { content, meta });
			return "held";
		}
		const s = this.sessions.get(name);
		if (s && send(s.socket, { type: "event", content, meta })) {
			this.touch(name, 1);
			return "sent";
		}
		this.ledger.enqueue(name, { content, meta });
		return "queued";
	}

	private touch(name: string, events: number) {
		const a = this.activityBy.get(name) ?? { events: 0, lastAt: 0 };
		this.activityBy.set(name, { events: a.events + events, lastAt: Date.now() });
	}

	activity(name: string) {
		return this.activityBy.get(name) ?? { events: 0, lastAt: 0 };
	}

	private remember(line: string) {
		this.recentChat.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
		if (this.recentChat.length > 12) this.recentChat.shift();
	}

	private sendRules(session: Session) {
		const rules = this.ledger.rules().trim();
		if (rules)
			send(session.socket, {
				type: "event",
				content: `現在の仮ルール（learnings/rules.md）:\n${rules}`,
				meta: { kind: "rules" },
			});
	}

	private flushOutbox(session: Session) {
		let disconnected = false;
		for (const item of this.ledger.drain(session.name)) {
			if (disconnected || !send(session.socket, { type: "event", content: item.content, meta: item.meta })) {
				disconnected = true;
				this.ledger.enqueue(session.name, item);
			}
		}
	}

	/** supervisor が /clear する前後に呼ぶ */
	onRefresh(
		name: string,
		phase: "start" | "done",
		result: RefreshResult = { success: true, reason: "手が空いたため" },
	) {
		if (phase === "start") {
			this.refreshing.add(name);
			return;
		}
		this.refreshing.delete(name);
		if (result.success) {
			this.activityBy.set(name, { events: 0, lastAt: Date.now() });
			this.ledger.journal(`[${name}] コンテキストを整理（/clear して始め直し）: ${result.reason}`);
		} else {
			this.ledger.journal(`[${name}] コンテキストの整理に失敗（${result.reason}）`);
		}
		const s = this.sessions.get(name);
		if (!s) return;
		if (result.success) {
			this.sendRules(s);
			if (name === "concierge" && this.recentChat.length > 0)
				send(s.socket, {
					type: "event",
					content: `/clear する前の直近のやり取り（古い順）:\n${this.recentChat.join("\n")}`,
					meta: { kind: "handoff" },
				});
		}
		this.flushOutbox(s);
	}

	// --- Discord から ---------------------------------------------------------------------
	async onDiscordMessage(d: DiscordMessage) {
		const r = route(d, {
			botUserId: this.botUserId,
			allowedUserIds: this.config.allowedUserIds,
			channelIds: this.config.channelIds,
			pendingPermissions: this.pendingPermissions,
		});
		if (r.action === "ignore") return;
		if (r.action === "permission") {
			this.pendingPermissions.delete(r.request_id);
			const s = this.sessions.get(r.target);
			if (!send(s?.socket, { type: "permission", request_id: r.request_id, behavior: r.behavior })) {
				await this.rest.sendMessage(d.channel_id, {
					content: withProject(r.target, "セッションが切断されていて届けられませんでした。"),
					replyTo: d.id,
				});
				return;
			}
			await this.rest.react(d.channel_id, d.id, r.behavior === "allow" ? "✅" : "🚫").catch(() => {});
			return;
		}
		// 返事先の A-番号が分かっていれば、窓口が迷わないよう依頼の中身も添える
		const meta = { ...r.meta };
		const att = meta.attention ? this.ledger.attention().find((a) => a.id === meta.attention) : undefined;
		let content = r.content;
		if (att) {
			Object.assign(meta, { project: att.project, kind: att.kind, task: att.taskId, attention_status: att.status });
			if (att.issue) meta.issue = att.issue;
			if (att.pr) meta.pr = att.pr;
			content += `\n\n（${att.id}: [${att.project}] ${KIND_LABEL[att.kind]}${att.issue ? ` #${att.issue}` : ""} ${att.title} / ${att.status === "open" ? "未対応" : "対応済み"}）`;
		}
		const how = this.deliver("concierge", content, meta);
		// /clear の最中に届いたものは、この後そのまま渡すので直近のやり取りには入れない（二重になるため）
		if (how !== "held") this.remember(`ユーザー: ${d.content}`);
		if (how === "queued") {
			await this.rest.sendMessage(d.channel_id, {
				content: "窓口が起動していないため、起動したら渡します。",
				replyTo: d.id,
			});
			return;
		}
		await this.rest.react(d.channel_id, d.id, "👀").catch(() => {});
	}

	private async onPermissionRequest(s: Session, msg: Extract<ClientMessage, { type: "permission_request" }>) {
		if (!this.config.permissionRelay) return;
		this.pendingPermissions.set(msg.request_id, s.name);
		const preview = (msg.input_preview ?? "").slice(0, 800);
		const text = [
			withProject(s.name, `🔐 許可の確認 \`${msg.request_id}\``),
			`ツール: \`${msg.tool_name}\``,
			msg.description ? `内容: ${msg.description}` : null,
			preview ? `\`\`\`\n${preview}\n\`\`\`` : null,
			`許可するなら \`yes ${msg.request_id}\`、拒否するなら \`no ${msg.request_id}\` と送ってください。`,
		]
			.filter(Boolean)
			.join("\n");
		await this.rest.sendMessage(this.config.defaultChannelId, { content: text });
	}

	/** プロジェクト名を付けて送る。長文は分割し、返信先は先頭、添付は最後の1通に付ける。 */
	async post(name: string, text: string, opts: { channelId?: string; replyTo?: string; files?: string[] } = {}) {
		const chunks = chunkText(withProject(name, text), 2000);
		let firstId: string | null = null;
		for (const [i, content] of chunks.entries()) {
			const res = await this.rest.sendMessage(opts.channelId ?? this.config.defaultChannelId, {
				content,
				replyTo: i === 0 ? opts.replyTo : undefined,
				files: i === chunks.length - 1 ? (opts.files ?? []) : [],
			});
			firstId ??= res?.id ?? null;
		}
		return firstId;
	}

	notifyOps(name: string, text: string) {
		this.post(name, text).catch((e: Error) => this.log(`engine: 通知失敗 ${e.message}`));
		this.ledger.journal(`[${name}] ${text}`);
	}

	// --- ツール（窓口・worker・CLI から） -----------------------------------------------------
	async call(who: Pick<Session, "role" | "name">, name: string, a: Record<string, unknown>): Promise<unknown> {
		const isConcierge = who.role === "concierge";
		const isCli = who.role === "cli";
		const conciergeOnly = () => {
			if (!isConcierge && !isCli) throw new Error(`${name} は窓口だけが使えます`);
		};
		switch (name) {
			case "tasks_list": {
				const status = str(a.status);
				const project = str(a.project);
				return this.ledger
					.tasks()
					.filter((t) => (a.all ? true : t.status !== "done"))
					.filter((t) => !status || t.status === status)
					.filter((t) => !project || t.project === project);
			}
			case "task_get": {
				const t = this.ledger.task(str(a.id));
				if (!t) throw new Error(`タスク ${str(a.id)} がありません`);
				return t;
			}
			case "attention_list":
				return this.ledger.openAttention();
			case "board_show":
				return this.ledger.renderBoard();
			case "projects_list":
				return this.ledger.projects().map((p) => ({
					...p,
					live: this.sessions.has(p.name),
					ready: this.ledger.isReady(p),
					profile: this.ledger.effectiveProfilePath(p),
				}));
			case "rules_get":
				return this.ledger.rules();
			case "learning_add": {
				const l = this.ledger.addLearning({
					project: str(a.project) || (who.role === "worker" ? who.name : ""),
					issue: str(a.issue),
					tag: str(a.tag) || "other",
					summary: str(a.summary),
					detail: str(a.detail),
				});
				this.maybeRequestRetro();
				return l;
			}
			case "reply": {
				conciergeOnly();
				if (isConcierge) this.remember(`窓口: ${str(a.text)}`);
				const id = await this.post(str(a.project) || "窓口", str(a.text), {
					channelId: str(a.chat_id) || undefined,
					replyTo: str(a.reply_to) || undefined,
					files: Array.isArray(a.files) ? (a.files as string[]) : [],
				});
				return { message_id: id };
			}
			case "task_create": {
				conciergeOnly();
				const t = this.ledger.createTask({
					project: str(a.project) || "-",
					title: str(a.title),
					issue: str(a.issue) || undefined,
					next: str(a.next) || undefined,
					note: str(a.note) || undefined,
				});
				this.scheduleBoard();
				return t;
			}
			case "task_update": {
				conciergeOnly();
				const patch: Partial<Task> = {};
				for (const k of ["title", "issue", "pr", "waiting", "next", "phase"] as const) {
					if (typeof a[k] === "string") patch[k] = a[k] as string;
				}
				if (typeof a.status === "string") {
					if (!(TASK_STATUSES as string[]).includes(a.status))
						throw new Error(`status は ${TASK_STATUSES.join(" / ")}`);
					patch.status = a.status as TaskStatus;
				}
				const t = this.ledger.updateTask(str(a.id), patch, str(a.note) || undefined);
				if (patch.status === "done") this.onTaskDone(t);
				this.scheduleBoard();
				return t;
			}
			case "attention_answer":
				conciergeOnly();
				return this.answerAttention(str(a.id), str(a.answer));
			case "dispatch": {
				conciergeOnly();
				const project = str(a.project);
				if (!this.ledger.projects().some((p) => p.name === project))
					throw new Error(`プロジェクト ${project} は登録されていません`);
				const task = str(a.task_id);
				const how = this.deliver(project, `窓口からの依頼${task ? `（${task}）` : ""}:\n${str(a.text)}`, {
					from: "concierge",
					...(task ? { task } : {}),
				});
				if (task) this.ledger.updateTask(task, {}, `worker に依頼: ${str(a.text).slice(0, 80)}`);
				return { delivery: how };
			}
			case "project_add": {
				conciergeOnly();
				const r = await registerProject(
					this.ledger,
					this.config,
					str(a.spec),
					{
						native: str(a.native) || undefined,
						harness: a.harness === true,
						tmuxSession: str(a.tmux_session) || undefined,
						name: str(a.name) || undefined,
					},
					this.exec,
				);
				this.scheduleBoard();
				this.supervisor?.tick().catch(() => {});
				return r;
			}
			case "project_mode": {
				conciergeOnly();
				const p = this.ledger.projects().find((x) => x.name === str(a.name));
				if (!p) throw new Error(`プロジェクト ${str(a.name)} は登録されていません`);
				const mode = str(a.mode);
				if (mode !== "harness" && mode !== "native") throw new Error("mode は harness か native です");
				const command = str(a.command) || (p.mode === "native" ? (p.initialPrompt ?? "") : "");
				if (mode === "native" && !command)
					throw new Error("native では command（そのリポジトリのループを始めるコマンド）が必要です");
				// 起動先のセッションが変わることがあるので、変更前のセッションで動いている worker を閉じる
				const before = this.targets().find((t) => t.name === p.name);
				const oldSession = before?.tmuxSession ?? this.config.tmuxSession;
				const next = this.ledger.upsertProject({
					...p,
					mode,
					initialPrompt: mode === "native" ? command : undefined,
					tmuxSession: mode === "native" ? str(a.tmux_session) || p.tmuxSession : undefined,
					// 調査し直すときに native を提案させない（人が harness に決めたので）
					harnessOnly: mode === "harness" && !this.ledger.isReady({ ...p, mode }) ? true : undefined,
				});
				const notes: string[] = [];
				const ready = this.ledger.isReady(next);
				if (mode === "harness") {
					if (ready) {
						const err = await ensureLabels(next, this.exec);
						if (err) notes.push(err);
					} else {
						ensureOnboardingTask(this.ledger, next.name, "native から harness に切り替えたため、設定を作り直す");
						notes.push("設定が無いので、worker がリポジトリを調べて設定の案を出します（A-番号で確認が来ます）");
					}
				}
				this.ledger.journal(`[${next.name}] モードを ${p.mode} → ${mode} に切り替え`);
				await this.supervisor?.restart(next.name, oldSession);
				this.scheduleBoard();
				return { project: next, ready, notes };
			}
			case "project_set_active": {
				conciergeOnly();
				const p = this.ledger.projects().find((x) => x.name === str(a.name));
				if (!p) throw new Error(`プロジェクト ${str(a.name)} は登録されていません`);
				return this.ledger.upsertProject({ ...p, active: a.active === true });
			}
			case "learnings_list":
				conciergeOnly();
				return this.ledger
					.learnings()
					.map((l, index) => ({ index, ...l }))
					.filter((l) => a.include_promoted || !l.promoted);
			case "learnings_promote":
				conciergeOnly();
				this.ledger.markPromoted(Array.isArray(a.indexes) ? (a.indexes as number[]) : []);
				return { ok: true };
			case "rules_set": {
				conciergeOnly();
				this.ledger.setRules(str(a.content));
				// 動いている worker にすぐ効かせる
				for (const s of this.sessions.values()) {
					if (s.role === "worker")
						send(s.socket, {
							type: "event",
							content: `仮ルールが更新されました:\n${str(a.content)}`,
							meta: { kind: "rules" },
						});
				}
				return { ok: true };
			}
			case "retro_done": {
				conciergeOnly();
				this.ledger.saveState({ doneSinceRetro: 0, lastRetroAt: new Date().toISOString(), retroRequestedAt: null });
				this.ledger.journal(`振り返り: ${str(a.summary)}`);
				return { ok: true };
			}
			case "report":
				return this.report(who, a);
			case "profile_propose":
				return this.proposeProfile(who, a);
			case "profile_template": {
				// プラグインのキャッシュは worker の作業ディレクトリの外にあり、読むと許可の確認で止まるため、engine が渡す
				const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
				const examples: Record<string, unknown> = {};
				const exDir = path.join(dir, "examples");
				for (const f of existsSync(exDir) ? readdirSync(exDir).filter((x) => x.endsWith(".json")) : []) {
					examples[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(exDir, f), "utf8"));
				}
				return { template: JSON.parse(readFileSync(path.join(dir, "profile.example.json"), "utf8")), examples };
			}
			case "profile_get": {
				const name = who.role === "worker" ? who.name : str(a.project);
				const p = this.ledger.projects().find((x) => x.name === name);
				if (!p) throw new Error(`プロジェクト ${name} は登録されていません`);
				return {
					project: p,
					path: this.ledger.effectiveProfilePath(p),
					profile: this.ledger.profile(p),
					draft: this.ledger.draft(name),
				};
			}
			case "profile_activate": {
				const name = who.role === "worker" ? who.name : str(a.project);
				const p = this.ledger.activateDraft(name);
				const labelError = p.mode === "harness" ? await ensureLabels(p, this.exec) : null;
				const task = this.ledger
					.tasks()
					.find((t) => t.project === name && t.title.startsWith("プロジェクトの調査") && t.status !== "done");
				if (task) this.ledger.updateTask(task.id, { status: "done", waiting: "" }, `設定を確定（${p.mode}）`);
				this.scheduleBoard();
				return {
					project: p,
					note:
						p.mode === "native"
							? `以後は ${p.initialPrompt} で進める`
							: "以後は /discord-loop-engine:issue-loop で進める。permissions は次の起動（dle restart）から反映される",
					...(labelError ? { warning: labelError } : {}),
				};
			}
			case "notify":
				return this.notify(who, a);
			case "restart": {
				if (!isCli) throw new Error("restart は dle CLI から使います");
				await this.supervisor?.restart(str(a.name));
				return { ok: true };
			}
			default:
				throw new Error(`unknown tool: ${name}`);
		}
	}

	/** 人の判断が要る依頼を A-番号付きで台帳に記録し、Bot で投稿し、窓口に知らせる */
	private async openGate(
		project: string,
		gate: (typeof GATE_EVENTS)[string],
		o: { task: Task | null; issue: string; pr: string; title: string; url: string; body: string; file?: string },
	) {
		const { task, issue, pr, title, url, body } = o;
		const att = this.ledger.addAttention({
			taskId: task?.id ?? "",
			project,
			issue,
			pr,
			kind: gate.kind,
			title,
			url,
			summary: body,
		});
		const label = KIND_LABEL[gate.kind];
		const text = [
			`${gate.icon} ${att.id} ${label}｜${issue ? `#${issue} ` : ""}${title}`,
			body || null,
			gate.how(att.id),
			url ? `<${url}>` : null,
		]
			.filter(Boolean)
			.join("\n");
		const messageId = await this.post(project, text, { files: o.file && existsSync(o.file) ? [o.file] : [] });
		if (messageId) this.ledger.setAttentionMessage(att.id, messageId);
		if (task) {
			this.ledger.updateTask(
				task.id,
				{ status: "waiting-human", waiting: `${att.id} ${label}${pr ? `（PR #${pr}）` : ""}`, ...(pr ? { pr } : {}) },
				`${att.id} ${label}を依頼`,
			);
		}
		this.deliver(
			"concierge",
			`[${project}] ${att.id} ${label}を Discord に出しました${task ? `（${task.id}）` : ""}。あなたから重ねて投稿する必要はありません。`,
			{ kind: "notice", attention: att.id, project },
		);
		this.scheduleBoard();
		return { attention: att.id, message_id: messageId };
	}

	/** worker の調査結果（設定の案）を受け取り、A-番号で確認を求める */
	private async proposeProfile(who: Pick<Session, "role" | "name">, a: Record<string, unknown>) {
		const project = who.role === "worker" ? who.name : str(a.project);
		const p = this.ledger.projects().find((x) => x.name === project);
		if (!p) throw new Error(`プロジェクト ${project} は登録されていません`);
		const mode = str(a.mode) === "native" ? "native" : "harness";
		let profile: Record<string, unknown> | undefined;
		if (mode === "harness") {
			profile = (typeof a.profile === "string" ? JSON.parse(a.profile) : a.profile) as
				| Record<string, unknown>
				| undefined;
			const gate = profile?.gate;
			if (
				!Array.isArray(gate) ||
				gate.length === 0 ||
				!gate.every((g) => typeof g?.name === "string" && typeof g?.run === "string")
			) {
				throw new Error(
					'profile.gate に [{ "name": ..., "run": ... }] を1つ以上入れてください（CI と同じ検査を同じ順で）',
				);
			}
			validateHooks(profile?.hooks);
		} else if (p.harnessOnly) {
			throw new Error(
				"このプロジェクトは harness で進めると決まっています。独自のループの固有の手順を hooks に写した案を出してください",
			);
		} else if (!str(a.initial_prompt)) {
			throw new Error("native では initial_prompt（そのリポジトリのループを始めるコマンド）が必要です");
		}
		const summary = str(a.summary);
		const task =
			this.ledger
				.tasks()
				.find((t) => t.project === project && t.title.startsWith("プロジェクトの調査") && t.status !== "done") ?? null;
		this.ledger.saveDraft(project, {
			mode,
			...(profile ? { profile } : {}),
			...(mode === "native"
				? { initialPrompt: str(a.initial_prompt), tmuxSession: str(a.tmux_session) || undefined }
				: {}),
			summary,
			proposedAt: new Date().toISOString(),
		});
		const hooks = Object.entries((profile?.hooks ?? {}) as Record<string, string[]>).filter(([, v]) => v.length > 0);
		const draftView =
			mode === "harness"
				? [
						`検査（PR 前に CI と同じ順で）:\n${(profile?.gate as { name: string; run: string }[]).map((g) => `- ${g.name}: \`${g.run}\``).join("\n")}`,
						...(hooks.length
							? [`差し込み口:\n${hooks.map(([k, v]) => `- ${k}: ${v.map((c) => `\`${c}\``).join(" → ")}`).join("\n")}`]
							: []),
					].join("\n")
				: `このリポジトリ独自のループで進めます: \`${str(a.initial_prompt)}\``;
		return this.openGate(project, GATE_EVENTS.setup as (typeof GATE_EVENTS)[string], {
			task,
			issue: "",
			pr: "",
			title: `${project} の設定`,
			url: `https://github.com/${p.repo}`,
			body: [summary, draftView].filter(Boolean).join("\n"),
		});
	}

	/** harness-notify（harness-phase）から。人の判断が要る通知は A-番号を付けて投稿する */
	private async notify(who: Pick<Session, "role" | "name">, a: Record<string, unknown>) {
		const project = str(a.project) || (who.role === "worker" ? who.name : "");
		if (!project) throw new Error("project が必要です");
		const event = str(a.event);
		const issue = str(a.issue);
		const pr = str(a.pr);
		const title = str(a.title);
		const url = str(a.url);
		const body = str(a.body);
		const gate = GATE_EVENTS[event];
		const task = issue ? this.ledger.ensureTaskForIssue(project, issue, title) : null;

		if (gate) {
			return this.openGate(project, gate, { task, issue, pr, title, url, body, file: str(a.file) });
		}

		if (event === "phase") {
			const phase = str(a.phase);
			const status = PHASE_STATUS[phase];
			if (task && status) {
				const t = this.ledger.updateTask(
					task.id,
					{ status, phase: phase === "done" ? "" : phase, ...(pr ? { pr } : {}) },
					`フェーズ → ${phase}`,
				);
				if (status === "done") this.onTaskDone(t);
				else if (status === "ai-working") this.ledger.resolveAttentionForTask(task.id, "（作業再開）");
			}
			// マージ完了は CI の webhook ではなく engine が知らせる（リポジトリ側に通知の仕組みを置かないため）
			if (phase === "done" && pr) {
				const p = this.ledger.projects().find((x) => x.name === project);
				await this.post(
					project,
					`🔵 マージ完了｜${issue ? `#${issue} ` : ""}${title}（PR #${pr}）${p ? `\n<https://github.com/${p.repo}/pull/${pr}>` : ""}`,
				);
			}
			this.scheduleBoard();
			return { task: task?.id ?? null };
		}

		// それ以外（着手・お知らせ）は台帳にだけ残す。投稿はボードの更新で足りる
		this.ledger.journal(`[${project}] ${event}: ${title}${issue ? ` (#${issue})` : ""}`);
		if (event === "info" && body) await this.post(project, `ℹ️ ${title}\n${body}${url ? `\n<${url}>` : ""}`);
		this.scheduleBoard();
		return { task: task?.id ?? null };
	}

	/** worker からの進み具合の報告（harness-phase を通らない作業の記録） */
	private report(who: Pick<Session, "role" | "name">, a: Record<string, unknown>) {
		const project = who.role === "worker" ? who.name : str(a.project);
		const taskId =
			str(a.task_id) ||
			(str(a.issue)
				? this.ledger.ensureTaskForIssue(project, str(a.issue), str(a.title) || "（件名は未取得）").id
				: "");
		if (!taskId) throw new Error("task_id か issue が必要です");
		const patch: Partial<Task> = {};
		if (typeof a.status === "string" && (TASK_STATUSES as string[]).includes(a.status))
			patch.status = a.status as TaskStatus;
		if (typeof a.pr === "string") patch.pr = a.pr;
		if (typeof a.next === "string") patch.next = a.next;
		const t = this.ledger.updateTask(taskId, patch, str(a.note) || undefined);
		if (patch.status === "done") this.onTaskDone(t);
		this.scheduleBoard();
		return t;
	}

	private answerAttention(id: string, answer: string) {
		const a = this.ledger.resolveAttention(id, answer);
		const label = KIND_LABEL[a.kind];
		let delivery: string = "none";
		if (a.kind === "interview" || a.kind === "merge" || a.kind === "blocked" || a.kind === "setup") {
			delivery = this.deliver(
				a.project,
				`${a.id}（${label}${a.issue ? `・#${a.issue}` : ""}${a.pr ? `・PR #${a.pr}` : ""}）への回答が届きました（窓口経由・Discord）:\n${answer}`,
				{ attention: a.id, kind: a.kind, issue: a.issue, pr: a.pr, task: a.taskId, source: "discord" },
			);
		}
		if (a.taskId)
			this.ledger.updateTask(a.taskId, { status: "ai-working", waiting: "" }, `${a.id} 回答: ${answer.slice(0, 80)}`);
		this.scheduleBoard();
		return { attention: a.id, delivery };
	}

	private onTaskDone(t: Task) {
		this.ledger.resolveAttentionForTask(t.id, "（完了）");
		const st = this.ledger.state();
		this.ledger.saveState({ doneSinceRetro: st.doneSinceRetro + 1 });
		this.maybeRequestRetro();
	}

	/** 完了件数か日数が閾値を超えたら、窓口に振り返りを頼む（1回だけ） */
	maybeRequestRetro() {
		const st = this.ledger.state();
		if (st.retroRequestedAt) return;
		const days = (Date.now() - new Date(st.lastRetroAt).getTime()) / 86_400_000;
		const pending = this.ledger.learnings().filter((l) => !l.promoted).length;
		const due =
			st.doneSinceRetro >= this.config.retro.everyDoneTasks ||
			(days >= this.config.retro.everyDays && (st.doneSinceRetro > 0 || pending > 0));
		if (!due) return;
		this.ledger.saveState({ retroRequestedAt: new Date().toISOString() });
		this.deliver(
			"concierge",
			`振り返りの時期です（前回から完了 ${st.doneSinceRetro} 件・未整理の学び ${pending} 件）。/discord-loop-engine:retrospective を実行してください。`,
			{ kind: "retro" },
		);
	}

	// --- CI の監視 -------------------------------------------------------------------------------
	/**
	 * 各リポジトリの既定ブランチの CI を見て、新しく失敗した run を Bot で知らせる。
	 * リポジトリに通知用のワークフローや Secrets を置かずに済むよう、engine が gh で見に行く。
	 * PR の CI は worker が自分で見て直すので、ここでは既定ブランチだけを見る。
	 * 初めて見るリポジトリは、既にある run を「通知済み」として覚えるだけにする（過去の失敗を一度に流さない）。
	 */
	async ciTick() {
		const st = this.ledger.state();
		const seen = { ...st.ciSeen };
		const branches = { ...st.defaultBranches };
		let changed = false;
		for (const p of this.ledger.projects().filter((x) => x.active && x.repo)) {
			let branch = branches[p.name];
			if (!branch) {
				const r = await this.exec("gh", [
					"repo",
					"view",
					p.repo,
					"--json",
					"defaultBranchRef",
					"-q",
					".defaultBranchRef.name",
				]);
				if (!r.ok || !r.stdout.trim()) continue;
				branch = r.stdout.trim();
				branches[p.name] = branch;
				changed = true;
			}
			const r = await this.exec("gh", [
				"run",
				"list",
				"-R",
				p.repo,
				"--branch",
				branch,
				"--limit",
				"10",
				"--json",
				"databaseId,status,conclusion,workflowName,displayTitle,url",
			]);
			if (!r.ok) continue;
			let runs: {
				databaseId: number;
				status: string;
				conclusion: string;
				workflowName: string;
				displayTitle: string;
				url: string;
			}[];
			try {
				runs = JSON.parse(r.stdout);
			} catch {
				continue;
			}
			const known = seen[p.name];
			const done = runs.filter((x) => x.status === "completed");
			if (!known) {
				seen[p.name] = done.map((x) => x.databaseId);
				changed = true;
				continue;
			}
			for (const run of done) {
				if (known.includes(run.databaseId)) continue;
				known.push(run.databaseId);
				changed = true;
				if (["failure", "timed_out", "startup_failure"].includes(run.conclusion)) {
					await this.post(p.name, `🟠 CI失敗｜${run.workflowName} @ ${branch}\n${run.displayTitle}\n<${run.url}>`);
					this.ledger.journal(`[${p.name}] CI 失敗: ${run.workflowName} @ ${branch}`);
				}
			}
			seen[p.name] = known.slice(-50);
		}
		if (changed) this.ledger.saveState({ ciSeen: seen, defaultBranches: branches });
	}

	// --- ボード -------------------------------------------------------------------------------
	scheduleBoard() {
		if (!this.config.board.enabled) {
			this.ledger.renderBoard();
			return;
		}
		if (this.boardTimer) clearTimeout(this.boardTimer);
		this.boardTimer = setTimeout(() => {
			this.boardTimer = null;
			this.updateBoard().catch((e: Error) => this.log(`engine: ボード更新失敗 ${e.message}`));
		}, this.boardDebounceMs);
	}

	async updateBoard() {
		const text = this.ledger.renderBoard();
		const st = this.ledger.state();
		const channelId = this.config.defaultChannelId;
		if (st.boardMessageId && st.boardChannelId === channelId) {
			try {
				await this.rest.editMessage(channelId, st.boardMessageId, text);
				return;
			} catch {
				// 消されていたら作り直す
			}
		}
		const msg = await this.rest.sendMessage(channelId, { content: text });
		this.ledger.saveState({ boardMessageId: msg.id, boardChannelId: channelId });
		await this.rest.pin(channelId, msg.id).catch(() => {});
	}

	// --- 状態ファイル（dle status が読む） --------------------------------------------------------
	writeStatus() {
		const status = {
			pid: process.pid,
			startedAt: this.startedAt,
			updatedAt: new Date().toISOString(),
			discord: { connected: this.gateway.connected, bot: this.gateway.user?.username ?? null, fatal: this.fatal },
			sessions: [...this.sessions.values()].map((s) => ({
				name: s.name,
				role: s.role,
				pid: s.pid,
				cwd: s.cwd,
				since: s.since,
			})),
			permissionRelay: this.config.permissionRelay,
		};
		try {
			writeFileSync(path.join(this.config.home, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
		} catch {}
	}
}
