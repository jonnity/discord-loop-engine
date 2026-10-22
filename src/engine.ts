// engine 本体。Discord（Bot 1つ）・窓口・各 worker・dle CLI の間に立ち、すべてのやり取りを台帳に残す。
// - Discord から届いた発言はすべて窓口へ（AI とのやり取りの口を1本にするため）
// - worker の「人の判断が要る」報告は、台帳に A-番号で記録してから engine が Bot で投稿する
//   （LLM の判断を挟まないので、通知の漏れが起きない）
// - 窓口からの指示・回答は、worker がいなければ outbox に積み、起動したら渡す（忘れない）

import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { Config } from "./config.ts";
import { type AttentionKind, KIND_LABEL, Ledger, TASK_STATUSES, type Task, type TaskStatus } from "./ledger.ts";
import { run as defaultRun, type Run, resolveProject, sessionTargets } from "./projects.ts";
import { type ClientMessage, lineReader, type Meta, PROTOCOL_VERSION, type Role, send } from "./protocol.ts";
import type { DiscordApi } from "./rest.ts";
import { chunkText, type DiscordMessage, route, withProject } from "./route.ts";
import type { Supervisor } from "./supervisor.ts";

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
		return sessionTargets(this.config, this.ledger.projects());
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
		// 起動していない間に届いていたものと、今の仮ルールを渡す
		const rules = this.ledger.rules().trim();
		if (rules)
			send(socket, {
				type: "event",
				content: `現在の仮ルール（learnings/rules.md）:\n${rules}`,
				meta: { kind: "rules" },
			});
		for (const item of this.ledger.drain(name)) send(socket, { type: "event", content: item.content, meta: item.meta });
		this.supervisor?.onRegistered(name).catch(() => {});
		return session;
	}

	/** セッションへ流し込む。いなければ outbox に積んでおき、接続したときに渡す */
	deliver(name: string, content: string, meta: Meta): "sent" | "queued" {
		const s = this.sessions.get(name);
		if (s && send(s.socket, { type: "event", content, meta })) return "sent";
		this.ledger.enqueue(name, { content, meta });
		return "queued";
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
				return this.ledger.projects().map((p) => ({ ...p, live: this.sessions.has(p.name) }));
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
				const p = await resolveProject(str(a.spec), this.config, this.exec);
				const saved = this.ledger.upsertProject(p);
				this.ledger.journal(`[${p.name}] プロジェクトを登録（${p.repo} / ${p.path}）`);
				if (
					p.needsInit &&
					!this.ledger
						.tasks()
						.some((t) => t.project === p.name && t.title.includes("ハーネスの導入") && t.status !== "done")
				) {
					this.ledger.createTask({
						project: p.name,
						title: "ハーネスの導入（harness-init）",
						status: "queued",
						next: ".claude/harness.json などを用意する PR を作り、OK をもらう",
						note: "harness.json が無いため導入から始める",
					});
				}
				this.scheduleBoard();
				this.supervisor?.tick().catch(() => {});
				return saved;
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
			case "notify":
				return this.notify(who, a);
			case "restart": {
				if (!isCli) throw new Error("restart は dle CLI から使います");
				this.supervisor?.reset(str(a.name));
				return { ok: true };
			}
			default:
				throw new Error(`unknown tool: ${name}`);
		}
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
			const file = str(a.file);
			const messageId = await this.post(project, text, { files: file && existsSync(file) ? [file] : [] });
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
				{
					kind: "notice",
					attention: att.id,
					project,
				},
			);
			this.scheduleBoard();
			return { attention: att.id, message_id: messageId };
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
				? this.ledger.ensureTaskForIssue(project, str(a.issue), str(a.title) || `#${str(a.issue)}`).id
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
		if (a.kind === "interview" || a.kind === "merge" || a.kind === "blocked") {
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
