// engine 本体。Discord（Bot 1つ）・窓口・各 worker・dle CLI の間に立ち、すべてのやり取りを台帳に残す。
// - Discord から届いた発言はすべて窓口へ（AI とのやり取りの口を1本にするため）
// - worker の「人の判断が要る」報告は、台帳に A-番号で記録してから engine が Bot で投稿する
//   （LLM の判断を挟まないので、通知の漏れが起きない）
// - 窓口からの指示・回答は、worker がいなければ outbox に積み、起動したら渡す（忘れない）

import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DEFAULT_FORCE_MAX_TOKENS } from "./config.ts";
import { isLoopbackHost, startDashboard } from "./dashboard.ts";
import { isObject, parseStrictJson } from "./harness-json.ts";
import { resolveModels, validateModels } from "./harness-models.ts";
import {
	type Attention,
	type AttentionKind,
	KIND_LABEL,
	Ledger,
	TASK_STATUSES,
	type Task,
	type TaskStatus,
	wakeLedgerFailure,
} from "./ledger.ts";
import { type DiscordReceipt, inspectReceipt, object, type ReceiptFailure } from "./notification-receipt.ts";
import { hasHumanWait, readCiWait } from "./phase-wait.ts";
import {
	run as defaultRun,
	ensureLabels,
	ensureOnboardingTask,
	type Run,
	refreshCoverage,
	registerProject,
	sessionTargets,
} from "./projects.ts";
import { type ClientMessage, lineReader, type Meta, PROTOCOL_VERSION, type Role, send } from "./protocol.ts";
import { checkHandoff, checkNextText, type NextTextRule, type RefreshReason } from "./refresh.ts";
import type { DiscordApi } from "./rest.ts";
import {
	codePoints,
	DEFAULT_REACTION_EMOJI,
	type DiscordMessage,
	formatPostChunks,
	isOkEmoji,
	type PostHeading,
	parseReaction,
	route,
	sanitizeUser,
} from "./route.ts";
import type { PeriodicWake, PhaseBoundary, RefreshResult, Supervisor, WakeDetail, WakeSend } from "./supervisor.ts";
import { validateToolArguments } from "./tool-validation.ts";
import { type Cadence, classifyWork, periodicValidityMs, type ReadFailure, readWork, WorkClock } from "./work-wake.ts";
import { resolveWorktreeRoot } from "./worktrees.ts";

export interface GatewayLike {
	start(): void;
	stop(): void;
	connected: boolean;
	user: { id: string; username?: string } | null;
}

type AttentionMark = "✅" | "☑️";

interface PostOpts {
	channelId?: string;
	replyTo?: string;
	files?: string[];
	heading?: PostHeading;
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

/** harness-phase の遷移元として受け付けるフェーズ（done は遷移先にしかならない） */
const FROM_PHASES = Object.keys(PHASE_STATUS).filter((k) => k !== "done");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 整理の機会（ticket）の有効時間。この間に checkpoint が来なければ、通常どおり作業を続けさせる */
const PHASE_TICKET_MS = 60_000;
const HANDOFF_MAX_BYTES = 64 * 1024;

/** checkpoint の拒否応答。text や本文は含めない */
export type RefreshCheckpointRejected = {
	accepted: false;
	reason: "next-text-invalid" | "checkpoint-invalid" | "checkpoint-race" | "phase-expired";
	task_id?: string;
	rule?: NextTextRule;
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

/** restart の引数解釈。name / limited / all はちょうど1つ、except は limited / all のときだけ */
export function restartMode(
	a: Record<string, unknown>,
): { kind: "one"; name: string } | { kind: "limited" | "all"; except: string[] } {
	const name = str(a.name);
	const chosen = [name !== "", a.limited === true, a.all === true].filter(Boolean).length;
	if (chosen !== 1) throw new Error("restart: name / limited / all のどれか1つを指定してください");
	const except = Array.isArray(a.except) ? (a.except as string[]) : [];
	if (name) {
		if (a.except !== undefined) throw new Error("restart: except は limited / all のときだけ使えます");
		return { kind: "one", name };
	}
	return { kind: a.all === true ? "all" : "limited", except };
}

/** 上限で止まった worker を窓口に知らせる文面。表示専用で、send-keys には使わない */
export function limitNoticeText(entries: { name: string; resetText: string | null }[]): string {
	const list = entries.map((e) => `- ${e.name}（復帰: ${e.resetText ?? "画面で確認"}）`).join("\n");
	return `⚠️ 使用量の上限で止まっている worker があります\n${list}\n手順: 別アカウントに切り替えたら、\`dle restart --limited\`（上限中のみ）か \`dle restart --all [--except 名前]\` で起動し直してください。`;
}

/** 上限が続いて自動の起こしをあきらめたことを窓口に知らせる文面。復帰時刻は載せない */
export function limitGaveUpText(e: { names: string[]; attempts: number }): string {
	return `⚠️ 使用量の上限が続いているため、worker ${e.names.join(", ")} の自動の起こしを ${e.attempts} 回で止めました。\n手順: 別アカウントに切り替えたら、\`dle restart --limited\`（上限中のみ）か \`dle restart --all [--except 名前]\` で起動し直してください。`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export interface EngineOptions {
	config: Config;
	rest: DiscordApi;
	gatewayFactory: (handlers: {
		onMessage: (d: unknown) => void;
		onReaction: (d: unknown, kind: "add" | "remove") => void;
		onReady: (user: { id: string } | null) => void;
		onFatal: (reason: string) => void;
		log: (m: string) => void;
	}) => GatewayLike;
	supervisor?: Supervisor | null;
	ledger?: Ledger;
	log?: (m: string) => void;
	exec?: Run;
	boardDebounceMs?: number;
	wakeNow?: () => number;
	wakeWall?: () => number;
}

type WakeProject = { name: string; repo: string; cwd: string; tmuxSession?: string };
type WakeLogResult =
	| { result: "empty" | "not-due" | "stopped" }
	| { result: "sent"; sendId: string }
	| { result: "deferred"; detail: WakeDetail };

export class Engine {
	readonly config: Config;
	readonly ledger: Ledger;
	private rest: DiscordApi;
	private gateway: GatewayLike;
	supervisor: Supervisor | null;
	private log: (m: string) => void;
	private exec: Run;
	private wakeNow: () => number;
	private wakeWall: () => number;
	private wakeBoot = randomUUID();
	private wakeSequence = 0;
	private wakeSendSequence = 0;
	private workController = new AbortController();
	private workPoll?: Promise<void>;
	private workTargets = new Map<string, WakeProject>();
	private workClocks = new Map<string, WorkClock>();
	private workLogs = new Map<string, (outcome: WakeLogResult) => void>();
	readonly sessions = new Map<string, Session>();
	private pendingPermissions = new Map<string, string>(); // request_id → session name
	private postQueue: Promise<unknown> = Promise.resolve(); // 論理投稿を直列にする
	private postingAttentions = new Set<string>(); // 依頼を投稿中（messageId の保存前）の A-番号
	private pendingAttentionMarks = new Map<string, AttentionMark>(); // 投稿中に閉じた依頼の印
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
	private dashboard: { url: string; close(): Promise<void> } | null = null;
	// 窓口との直近のやり取り。/clear の後に渡し直して、会話の続きが分かるようにする
	private recentChat: string[] = [];
	// 強制整理の機会（メモリだけ。再起動後に復活させない）と、割り込みを検出する世代番号
	private phasePending = new Map<string, PhaseBoundary & { timer: ReturnType<typeof setTimeout> }>();
	private phaseGeneration = new Map<string, number>();
	private phaseController = new AbortController();

	constructor(o: EngineOptions) {
		this.config = o.config;
		this.rest = o.rest;
		this.supervisor = o.supervisor ?? null;
		this.ledger = o.ledger ?? new Ledger(o.config.home);
		this.log = o.log ?? ((m) => console.error(m));
		this.exec = o.exec ?? defaultRun;
		this.wakeNow = o.wakeNow ?? (() => performance.now());
		this.wakeWall = o.wakeWall ?? Date.now;
		this.supervisor?.observeWake?.((send) => this.onWakeSent(send));
		this.boardDebounceMs = o.boardDebounceMs ?? 3000;
		this.gateway = o.gatewayFactory({
			onMessage: (d) => {
				this.onDiscordMessage(d as DiscordMessage).catch((e: Error) => this.log(`engine: 受信処理の失敗 ${e.message}`));
			},
			onReaction: (d, kind) => {
				this.onDiscordReaction(d, kind).catch((e: Error) => this.log(`engine: リアクション処理の失敗 ${e.message}`));
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

	refreshCoverage() {
		return refreshCoverage(this.config, this.ledger.projects(), this.targets(), this.ledger);
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
		await this.startDashboard();
		this.writeStatus();
		this.log(`engine: 待ち受け開始 ${this.config.socketPath}`);
		const emoji = this.reactionEmoji();
		this.log(`engine: リアクションで OK: ${emoji === null ? "無効" : `${emoji}（${codePoints(emoji)}）`}`);
		const c = this.config.concierge.refresh;
		const w = this.config.worker.refresh;
		this.log(
			`engine: 自動コンテキスト整理 concierge: ${c.enabled ? `${c.maxTokens / 1000}k / ${c.maxEvents} 件` : "無効"}、worker: ${w.enabled ? `${w.maxTokens / 1000}k` : "無効"}`,
		);
	}

	/** ダッシュボードの失敗で engine（Discord 中継が本体）を止めない */
	private async startDashboard() {
		const d = this.config.dashboard;
		if (d?.enabled !== true) return;
		// 認証を持たないので、同じ PC から以外は受けない。LAN へ出すなら認証つきの別 Issue で
		if (!isLoopbackHost(d.host)) {
			this.log(`engine: ダッシュボードを起動できません host ${d.host} は 127.0.0.1 / localhost / ::1 だけ使えます`);
			return;
		}
		try {
			this.dashboard = await startDashboard({
				ledger: this.ledger,
				host: d.host,
				port: d.port,
				allowedHosts: d.allowedHosts,
				log: this.log,
			});
			this.log(`engine: ダッシュボード ${this.dashboard.url}`);
		} catch (e) {
			this.log(`engine: ダッシュボードを起動できません ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
		}
	}

	async stop() {
		this.workController.abort();
		for (const name of this.workTargets.keys()) this.supervisor?.cancelPeriodicWake?.(name);
		for (const finish of this.workLogs.values()) finish({ result: "stopped" });
		await this.workPoll;
		this.gateway.stop();
		await this.dashboard?.close();
		this.dashboard = null;
		if (this.boardTimer) clearTimeout(this.boardTimer);
		for (const p of this.phasePending.values()) clearTimeout(p.timer);
		this.phasePending.clear();
		this.phaseController.abort();
		// 待機中の強制整理も止める（止めないと engine のソケットを閉じる前に wake が通りうる） // テストの代役 supervisor には無いことがある
		this.supervisor?.cancelPhaseRefreshes?.();
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
						this.call(who, msg.name, msg.args).then(
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
		this.bump(name);
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
		this.bump(name);
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
		const rules = this.ledger.rules();
		if (rules.trim())
			send(session.socket, {
				type: "event",
				content: `現在の仮ルール（learnings/rules.md）:\n${rules}`,
				meta: { kind: "rules" },
			});
	}

	private flushOutbox(session: Session) {
		let disconnected = false;
		let sent = 0;
		for (const item of this.ledger.drain(session.name)) {
			if (disconnected || !send(session.socket, { type: "event", content: item.content, meta: item.meta })) {
				disconnected = true;
				this.ledger.enqueue(session.name, item);
			} else sent++;
		}
		if (sent > 0 && session.name !== "concierge") this.requestWake(session.name, "outbox");
	}

	/**
	 * idle の worker を起こす要求。検知したことだけを伝え、Issue の中身や回答文はキー入力に使わない。
	 * reconnect だけは supervisor 側で積む（ここからは呼ばない）。
	 */
	private requestWake(
		project: string,
		reason: string,
		request?:
			| PeriodicWake
			| {
					decisionId: string;
					queued: string[];
					deferred: (detail: WakeDetail) => void;
			  },
	) {
		if (!request || !("isCurrent" in request)) this.bump(project);
		if (!this.supervisor) return;
		this.supervisor.requestWake(project, reason, request);
		// 同じ判定の queued と定期をまとめてから起こす。
		if (!request) this.supervisor.wakeTick().catch(() => {});
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
			attentionOfMessage: (id) => this.ledger.attentionByMessageId(id)?.id,
		});
		if (r.action === "ignore") return;
		if (r.action === "permission") {
			this.pendingPermissions.delete(r.request_id);
			const s = this.sessions.get(r.target);
			if (!send(s?.socket, { type: "permission", request_id: r.request_id, behavior: r.behavior })) {
				await this.post(r.target, "セッションが切断されていて届けられませんでした。", {
					channelId: d.channel_id,
					replyTo: d.id,
					heading: { icon: "⚠️", label: "お知らせ" },
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
		if (meta.attention_conflict) {
			// 返信先と本文の A が違う。どちらにも決めず、両方の中身と状態を添えて窓口に聞き返させる
			const describe = (label: string, id: string | undefined) => {
				const x = this.ledger.attention().find((y) => y.id === id);
				return x
					? `（${label} ${x.id}: [${x.project}] ${KIND_LABEL[x.kind]}${x.issue ? ` #${x.issue}` : ""} ${x.title} / ${x.status === "open" ? "未対応" : "対応済み"}）`
					: `（${label} ${id}: 台帳に無い）`;
			};
			const replied = this.ledger.attention().find((y) => y.id === meta.reply_attention);
			if (replied) meta.project = replied.project; // 見出しが読めない返信先でも project を補う
			content += `\n\n${describe("返信先", meta.reply_attention)}\n${describe("本文の", meta.text_attention)}\nどちらの A への回答か確認が必要です。`;
		}
		const how = this.deliver("concierge", content, meta);
		// /clear の最中に届いたものは、この後そのまま渡すので直近のやり取りには入れない（二重になるため）
		if (how !== "held") this.remember(`ユーザー: ${d.content}`);
		if (how === "queued") {
			await this.post("窓口", "窓口が起動していないため、起動したら渡します。", {
				channelId: d.channel_id,
				replyTo: d.id,
				heading: { icon: "ℹ️", label: "受付" },
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
			`ID: \`${msg.request_id}\``,
			`ツール: \`${msg.tool_name}\``,
			msg.description ? `内容: ${msg.description}` : null,
			preview ? `\`\`\`\n${preview}\n\`\`\`` : null,
			`許可するなら \`yes ${msg.request_id}\`、拒否するなら \`no ${msg.request_id}\` と送ってください。`,
		]
			.filter(Boolean)
			.join("\n");
		await this.post(s.name, text, { heading: { icon: "🔐", label: "許可の確認" } });
	}

	/** プロジェクト名と種類の見出し・末尾の区切り線を付けて送る。長文は分割し、返信先は先頭、添付は最後の1通に付ける。 */
	async post(name: string, text: string, opts: PostOpts = {}) {
		return (await this.postMessages(name, text, opts)).firstId;
	}

	private postMessages(name: string, text: string, opts: PostOpts = {}) {
		// 別の投稿が長文の途中に割り込まないよう、論理投稿の単位で直列にする。前の失敗は次に持ち越さない
		const run = this.postQueue.then(() => this.sendChunks(name, text, opts));
		this.postQueue = run.catch(() => {});
		return run;
	}

	private async sendChunks(name: string, text: string, opts: PostOpts) {
		const chunks = formatPostChunks(name, text, opts.heading ?? { icon: "🔔", label: "お知らせ" });
		let lastMessage: unknown;
		let firstId: string | null = null;
		const ids: string[] = [];
		for (const [i, content] of chunks.entries()) {
			const res = await this.rest.sendMessage(opts.channelId ?? this.config.defaultChannelId, {
				content,
				replyTo: i === 0 ? opts.replyTo : undefined,
				files: i === chunks.length - 1 ? (opts.files ?? []) : [],
			});
			firstId ??= res?.id ?? null;
			if (res?.id) ids.push(res.id);
			lastMessage = res;
		}
		return { firstId, ids, lastMessage };
	}

	/**
	 * 依頼の元メッセージにリアクションを付ける。失敗しても台帳や worker の処理は止めない（ログだけ）。
	 * 依頼の投稿中（messageId の保存前）に閉じたものは、保存直後に付けるため覚えておく。
	 */
	private async markAttention(a: Attention, emoji: AttentionMark) {
		if (!a.messageId) {
			if (this.postingAttentions.has(a.id)) {
				if (!this.pendingAttentionMarks.has(a.id)) this.pendingAttentionMarks.set(a.id, emoji);
			} else this.log(`engine: ${a.id} は元メッセージ ID がないため ${emoji} を付けません`);
			return;
		}
		try {
			await this.rest.react(this.config.defaultChannelId, a.messageId, emoji);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.log(`engine: ${a.id} への ${emoji} 失敗 messageId=${a.messageId} ${reason.slice(0, 120)}`);
		}
	}

	private async markAll(list: Attention[], emoji: AttentionMark) {
		for (const a of list) await this.markAttention(a, emoji);
	}

	notifyOps(name: string, text: string) {
		this.post(name, text).catch((e: Error) => this.log(`engine: 通知失敗 ${e.message}`));
		this.ledger.journal(`[${name}] ${text}`);
	}

	/** 上限エピソードの開始時に1通だけ窓口へ。A-番号は付けない（台帳の attention を増やさない） */
	limitNotice(entries: { name: string; resetText: string | null }[]) {
		this.notifyOps("窓口", limitNoticeText(entries));
	}

	/** 自動の起こしをあきらめた通知。エピソードにつき1回（supervisor が保証する） */
	limitGaveUpNotice(e: { names: string[]; attempts: number }) {
		this.notifyOps("窓口", limitGaveUpText(e));
	}

	// --- ツール（窓口・worker・CLI から） -----------------------------------------------------
	async call(who: Pick<Session, "role" | "name">, name: string, raw?: unknown): Promise<unknown> {
		const a = validateToolArguments(name, raw);
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
			case "attention_list": {
				const project = str(a.project);
				const issue = str(a.issue);
				// 既定（引数なし）は従来どおり開いている A だけ。回答済みは includeResolved のときだけ（台帳の形式は変えない）
				return (a.includeResolved ? this.ledger.attention() : this.ledger.openAttention())
					.filter((x) => !project || x.project === project)
					.filter((x) => !issue || x.issue === issue);
			}
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
					heading: { icon: "💬", label: "返信" },
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
				if (patch.status === "done") await this.onTaskDone(t);
				this.scheduleBoard();
				return t;
			}
			case "refresh_checkpoint":
				if (who.role !== "worker") throw new Error("refresh_checkpoint は worker だけが使えます");
				return this.refreshCheckpoint(who.name, a);
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
				this.requestWake(project, "dispatch");
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
				const draftFile = path.join(this.config.home, "projects", name, "draft.json");
				if (existsSync(draftFile)) {
					const draft = parseStrictJson(readFileSync(draftFile, "utf8"));
					if (isObject(draft) && isObject(draft.profile)) validateModels(draft.profile.models);
				}
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
				const mode = restartMode(a);
				if (mode.kind === "one") {
					await this.supervisor?.restart(mode.name);
					return { ok: true };
				}
				if (!this.supervisor) throw new Error("supervisor が動いていません");
				return { ok: true, ...(await this.supervisor.restartMany(mode.kind, mode.except)) };
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
		if (o.file) {
			// 相対パスは engine の cwd で解決され、同名の別ファイルを誤添付しうるため、種別を問わず拒否する
			if (!path.isAbsolute(o.file)) {
				throw new Error(`添付ファイルは絶対パスで渡してください（engine の cwd からは見えません）: ${o.file}`);
			}
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(o.file);
			} catch {
				throw new Error(`添付ファイルが見つかりません: ${o.file}`);
			}
			if (gate.kind === "merge") {
				if (!stat.isFile() || stat.size === 0) throw new Error("承認添付は通常の非空ファイルが必要です");
				accessSync(o.file, constants.R_OK);
			} else if (!stat.isFile()) {
				throw new Error(`添付ファイルは通常のファイルが必要です: ${o.file}`);
			}
		}
		const added = this.ledger.addAttention({
			taskId: task?.id ?? "",
			project,
			issue,
			pr,
			kind: gate.kind,
			title,
			url,
			summary: body,
		});
		const att = added.attention;
		// この後の投稿中に回答・解消されても印を取りこぼさないよう、投稿中の目印を同期的に付ける
		this.postingAttentions.add(att.id);
		try {
			await this.markAll(added.resolved, "☑️");
			return await this.postGate(project, gate, att, task, o);
		} finally {
			this.postingAttentions.delete(att.id);
			this.pendingAttentionMarks.delete(att.id);
		}
	}

	private async postGate(
		project: string,
		gate: (typeof GATE_EVENTS)[string],
		att: Attention,
		task: Task | null,
		o: { issue: string; pr: string; title: string; url: string; body: string; file?: string },
	) {
		const { issue, pr, title, url, body } = o;
		const label = KIND_LABEL[gate.kind];
		const text = [title, body || null, gate.how(att.id), url ? `<${url}>` : null].filter(Boolean).join("\n");
		const {
			firstId: messageId,
			ids,
			lastMessage,
		} = await this.postMessages(project, text, {
			heading: { icon: gate.icon, label, attention: att.id, ...(issue ? { issue } : {}) },
			files: o.file ? [o.file] : [],
		});
		if (messageId) {
			this.ledger.setAttentionMessage(att.id, messageId, ids);
			const pending = this.pendingAttentionMarks.get(att.id);
			this.pendingAttentionMarks.delete(att.id);
			if (pending) await this.markAttention({ ...att, messageId }, pending);
		}
		if (task) {
			this.ledger.updateTask(
				task.id,
				{ status: "waiting-human", waiting: `${att.id} ${label}${pr ? `（PR #${pr}）` : ""}`, ...(pr ? { pr } : {}) },
				`${att.id} ${label}を依頼`,
			);
		}
		this.deliver(
			"concierge",
			`[${project}] ${att.id} ${label}を Discord に出しました${task ? `（${task.id}）` : pr ? `（PR #${pr}）` : ""}。あなたから重ねて投稿する必要はありません。`,
			{ kind: "notice", attention: att.id, project },
		);
		this.scheduleBoard();
		let discord: DiscordReceipt | undefined;
		let discord_error: ReceiptFailure | undefined;
		if (gate.kind === "merge" && o.file) {
			let guild: unknown;
			try {
				const channel = await this.rest.channel(this.config.defaultChannelId);
				if (channel.id === this.config.defaultChannelId) guild = object(channel).guild_id;
				else discord_error = { stage: "channel", reason: "metadata-mismatch" };
			} catch {
				discord_error = { stage: "guild", reason: "fetch-failed" };
			}
			const inspected = inspectReceipt(lastMessage, guild, this.config.defaultChannelId);
			discord = inspected.receipt;
			// 投稿応答そのものの不正を先に示し、guild 欠落には GET の失敗理由を補う。
			discord_error = inspected.failure?.stage === "guild" ? (discord_error ?? inspected.failure) : inspected.failure;
		}
		return {
			attention: att.id,
			message_id: messageId,
			...(discord ? { discord } : {}),
			...(discord_error ? { discord_error } : {}),
		};
	}

	/** worker の調査結果（設定の案）を受け取り、A-番号で確認を求める */
	private async proposeProfile(who: Pick<Session, "role" | "name">, a: Record<string, unknown>) {
		const project = who.role === "worker" ? who.name : str(a.project);
		const p = this.ledger.projects().find((x) => x.name === project);
		if (!p) throw new Error(`プロジェクト ${project} は登録されていません`);
		const mode = str(a.mode) === "native" ? "native" : "harness";
		let profile: Record<string, unknown> | undefined;
		let resolvedWorktreeRoot: string | undefined;
		if (mode === "harness") {
			profile = (typeof a.profile === "string" ? parseStrictJson(a.profile) : a.profile) as
				| Record<string, unknown>
				| undefined;
			validateModels(profile?.models);
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
			const preflight: unknown = profile?.preflight;
			if (
				preflight != null &&
				(!Array.isArray(preflight) ||
					!preflight.every(
						(p: unknown) =>
							typeof p === "object" &&
							p !== null &&
							"name" in p &&
							typeof p.name === "string" &&
							p.name.trim().length > 0 &&
							"run" in p &&
							typeof p.run === "string" &&
							p.run.trim().length > 0,
					))
			)
				throw new Error("profile.preflight は空でない name/run の配列にしてください");
			validateHooks(profile?.hooks);
			resolvedWorktreeRoot = resolveWorktreeRoot({
				repoRoot: p.path,
				home: this.config.home,
				project: p.name,
				worktreeRoot: profile?.worktreeRoot,
			});
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
		const preflight = (profile?.preflight ?? []) as { name: string; run: string }[];
		const draftView =
			mode === "harness"
				? [
						`worktreeRoot（${profile?.worktreeRoot ? "明示値" : "既定"}）: \`${resolvedWorktreeRoot}\``,
						`検査（PR 前に CI と同じ順で）:\n${(profile?.gate as { name: string; run: string }[]).map((g) => `- ${g.name}: \`${g.run}\``).join("\n")}`,
						...(preflight.length
							? [`環境確認（CI 検査より前）:\n${preflight.map((p) => `- ${p.name}: \`${p.run}\``).join("\n")}`]
							: []),
						...(hooks.length
							? [`差し込み口:\n${hooks.map(([k, v]) => `- ${k}: ${v.map((c) => `\`${c}\``).join(" → ")}`).join("\n")}`]
							: []),
						`モデル要求値・出典・警告: ${JSON.stringify(resolveModels(this.config, profile?.models))}`,
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
				if (status === "done") await this.onTaskDone(t);
				else if (status === "ai-working")
					await this.markAll(this.ledger.resolveAttentionForTask(task.id, "（作業再開）"), "☑️");
			}
			if (!issue && /^[1-9][0-9]*$/.test(pr) && (phase === "done" || phase === "blocked")) {
				this.ledger.resolveAttentionForPr(
					project,
					pr,
					phase === "done" ? "（PR merged）" : body === "（GitHub の NG で停止）" ? body : "（PR closed）",
				);
			}
			// マージ完了は CI の webhook ではなく engine が知らせる（リポジトリ側に通知の仕組みを置かないため）
			if (phase === "done" && pr) {
				const p = this.ledger.projects().find((x) => x.name === project);
				await this.post(project, `${title}（PR #${pr}）${p ? `\n<https://github.com/${p.repo}/pull/${pr}>` : ""}`, {
					heading: { icon: "🔵", label: "マージ完了", ...(issue ? { issue } : {}) },
				});
			}
			this.scheduleBoard();
			// 強制整理の機会。失敗しても phase の台帳報告は成功のまま返す（GitHub の遷移を巻き戻さない）
			const refreshBoundary = await this.phaseOpportunity(project, issue, phase, a).catch((e: Error) => {
				this.log(`engine: 強制整理の判定に失敗 ${e.message}`);
				return null;
			});
			return { task: task?.id ?? null, ...(refreshBoundary ? { refreshBoundary } : {}) };
		}

		// それ以外（着手・お知らせ）は台帳にだけ残す。投稿はボードの更新で足りる
		this.ledger.journal(`[${project}] ${event}: ${title}${issue ? ` (#${issue})` : pr ? ` (PR #${pr})` : ""}`);
		if (event === "info" && body)
			await this.post(project, `${title}\n${body}${url ? `\n<${url}>` : ""}`, {
				heading: { icon: "ℹ️", label: "お知らせ" },
			});
		this.scheduleBoard();
		return { task: task?.id ?? null };
	}

	// --- harness-phase の遷移直後の強制整理 ---------------------------------------------------------

	private generation(project: string): number {
		return this.phaseGeneration.get(project) ?? 0;
	}

	/** 配送・再接続・phase/report/Task の更新・wake 要求のたびに進める。整理の機会の後に割り込みがあったことの検出に使う */
	private bump(project: string) {
		this.phaseGeneration.set(project, this.generation(project) + 1);
	}

	private forceLimit(project: string): number {
		const t = this.targets().find((x) => x.name === project);
		if (!t?.refresh || project === "concierge") return 0;
		return t.refresh.forceMaxTokens ?? DEFAULT_FORCE_MAX_TOKENS;
	}

	/**
	 * phase 通知1回を、整理の機会にするかを決める。ticket を返すのは、実際の遷移で、worker が超過しており、
	 * 人待ち・Codex・CI 待ちのどれでもないと確認できたときだけ。判定は台帳の項目・tmux・GitHub から読み、推測しない。
	 * 強制が無効な project では何も読まず何も書かない（OFF の挙動を変えない）。
	 */
	private async phaseOpportunity(project: string, issue: string, phase: string, a: Record<string, unknown>) {
		if (!issue || !Object.hasOwn(PHASE_STATUS, phase) || this.forceLimit(project) <= 0) return null;
		const sup = this.supervisor;
		const skip = (reason: RefreshReason, session?: string) => {
			sup?.recordPhaseDecision(project, reason, { session: session ?? null });
			return null;
		};
		const transitionId = UUID_PATTERN.test(str(a.transition_id)) ? str(a.transition_id) : "";
		const from = FROM_PHASES.includes(str(a.from_phase)) ? str(a.from_phase) : "";
		// 読み・比較・書きは同期。seen の保存前に await を挟むと、同時の通知で二重に機会を作る
		let all: ReturnType<Ledger["strictPhaseSeen"]>;
		try {
			all = this.ledger.strictPhaseSeen();
		} catch {
			this.log("engine: state.json を厳格に読めないため強制整理を見送ります");
			return skip("phase-unverified");
		}
		const prev = all[project]?.[issue];
		if ((transitionId && prev?.transitionId === transitionId) || prev?.phase === phase) return skip("phase-duplicate");
		const seen = { phase, sequence: (prev?.sequence ?? 0) + 1, ...(transitionId ? { transitionId } : {}) };
		try {
			this.ledger.saveState({ phaseRefreshSeen: { ...all, [project]: { ...all[project], [issue]: seen } } });
		} catch {
			this.log("engine: phase の記録を保存できないため強制整理を見送ります");
			return skip("phase-unverified");
		}
		this.bump(project);
		const old = this.phasePending.get(project);
		if (old) {
			clearTimeout(old.timer);
			this.phasePending.delete(project);
			sup?.recordPhaseDecision(project, "phase-superseded", { session: old.sessionId });
		}
		if (PHASE_STATUS[phase] === "waiting-human") return skip("human-wait");
		if (!transitionId || !from || from === phase || (prev && prev.phase !== from)) return skip("phase-unverified");
		if (!sup || this.sessions.get(project)?.role !== "worker") return skip("channel-offline");
		if (hasHumanWait(this.ledger, project)) return skip("human-wait");
		const generation = this.generation(project);
		const probe = await sup.phaseProbe(project);
		if (!probe.ok) return skip(probe.reason);
		const withSession = { session: probe.sessionId, pressure: probe.pressure };
		const decide = (reason: RefreshReason) => {
			sup.recordPhaseDecision(project, reason, withSession);
			return null;
		};
		if (probe.pressure.overThreshold === null) return decide("context-unknown");
		if (probe.pressure.overThreshold !== true) return decide("below-threshold");
		if (probe.codex === "busy") return decide("codex-busy");
		if (probe.codex === "unknown") return decide("codex-unknown");
		const repo = this.ledger.projects().find((p) => p.name === project)?.repo ?? "";
		const ci = await readCiWait(repo, this.exec, this.phaseController.signal);
		if (ci === "busy") return decide("ci-wait");
		if (ci === "unknown") return decide("ci-unknown");
		if (generation !== this.generation(project) || hasHumanWait(this.ledger, project))
			return decide("phase-superseded");
		const now = Date.now();
		const boundary: PhaseBoundary = {
			id: randomUUID(),
			project,
			issue,
			phase,
			sequence: seen.sequence,
			pid: probe.pid,
			sessionId: probe.sessionId,
			requestedAt: now,
			expiresAt: now + PHASE_TICKET_MS,
			generation,
		};
		const timer = setTimeout(() => {
			if (this.phasePending.get(project)?.id !== boundary.id) return;
			this.phasePending.delete(project);
			sup.recordPhaseDecision(project, "phase-expired", withSession);
		}, PHASE_TICKET_MS);
		timer.unref();
		this.phasePending.set(project, { ...boundary, timer });
		return { boundary_id: boundary.id, expires_at: boundary.expiresAt, project, issue, phase };
	}

	/** 固定の main/.harness/handoff.md を、symlink を辿らず通常ファイルとして読む。hash・bytes が合わなければ null */
	private async readHandoff(repoPath: string, bytes: number, sha256: string): Promise<string | null> {
		const file = path.join(repoPath, ".harness", "handoff.md");
		try {
			const dir = await lstat(path.dirname(file));
			if (!dir.isDirectory() || dir.isSymbolicLink()) return null;
			const link = await lstat(file);
			if (!link.isFile() || link.isSymbolicLink()) return null;
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const info = await handle.stat();
				// lstat と開いた実体が同じでなければ、読む間に差し替えられている
				if (!info.isFile() || info.dev !== link.dev || info.ino !== link.ino) return null;
				if (info.size <= 0 || info.size > HANDOFF_MAX_BYTES || info.size !== bytes) return null;
				const buffer = Buffer.alloc(info.size);
				const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
				if (bytesRead !== info.size) return null;
				if (createHash("sha256").update(buffer).digest("hex") !== sha256) return null;
				return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
			} finally {
				await handle.close();
			}
		} catch {
			return null;
		}
	}

	/**
	 * worker が整理の前に引継ぎ（handoff と Task.next）を渡す口。検証・保存・再読取りが全部通ったときだけ、
	 * supervisor の強制整理へ渡す。accepted は clear の成功を意味しない（worker は以後ツールを使わず、ターンを終える）。
	 */
	private async refreshCheckpoint(project: string, a: Record<string, unknown>): Promise<unknown> {
		const sup = this.supervisor;
		const ticket = this.phasePending.get(project);
		const reject = (
			diag: RefreshReason,
			reason: RefreshCheckpointRejected["reason"],
			extra: Partial<RefreshCheckpointRejected> = {},
		): RefreshCheckpointRejected => {
			// 失敗した機会は再試行しない。worker は止まっていないので、通常どおり作業を続けられる
			if (ticket && this.phasePending.get(project)?.id === ticket.id) {
				clearTimeout(ticket.timer);
				this.phasePending.delete(project);
			}
			sup?.recordPhaseDecision(project, diag, { session: ticket?.sessionId ?? null });
			return { accepted: false, reason, ...extra };
		};
		if (!ticket || ticket.id !== str(a.boundary_id) || !sup) return reject("checkpoint-missing", "phase-expired");
		if (Date.now() > ticket.expiresAt) return reject("phase-expired", "phase-expired");
		if (ticket.generation !== this.generation(project)) return reject("phase-superseded", "phase-expired");
		const p = this.ledger.projects().find((x) => x.name === project);
		if (!p) return reject("checkpoint-invalid", "checkpoint-invalid");
		const bytes = a.handoff_bytes as number;
		const sha = str(a.handoff_sha256);
		const handoff = await this.readHandoff(p.path, bytes, sha);
		const check = handoff === null ? null : checkHandoff(handoff);
		if (!check?.ok) return reject("checkpoint-invalid", "checkpoint-invalid");
		// ここから Task の照合・保存・再読取りまでは同期（窓口の task_update・worker の report と交互に走らせない）
		const items = a.next as { task_id: string; expected: string; text: string }[];
		const ids = items.map((i) => i.task_id);
		if (new Set(ids).size !== ids.length) return reject("checkpoint-invalid", "checkpoint-invalid");
		const open = this.ledger.tasks().filter((t) => t.project === project && t.status !== "done");
		if (!ids.every((id) => open.some((t) => t.id === id)) || open.some((t) => !ids.includes(t.id)))
			return reject("checkpoint-race", "checkpoint-race");
		const current = new Map(open.map((t) => [t.id, t.next]));
		if (items.some((i) => current.get(i.task_id) !== i.expected)) return reject("checkpoint-race", "checkpoint-race");
		const finalNext = new Map(items.map((i) => [i.task_id, i.text]));
		for (const i of items) {
			if (i.text === i.expected) continue;
			const r = checkNextText(i.text);
			if (!r.ok) return reject("checkpoint-invalid", "next-text-invalid", { task_id: i.task_id, rule: r.rule });
		}
		const own = open.find((t) => t.issue === ticket.issue);
		if (own && finalNext.get(own.id) === "")
			return reject("checkpoint-invalid", "next-text-invalid", { task_id: own.id, rule: "empty" });
		try {
			for (const i of items) {
				if (i.text !== i.expected)
					this.ledger.updateTask(i.task_id, { next: i.text }, "引継ぎ: 整理の前に next を保存");
			}
		} catch {
			return reject("checkpoint-invalid", "checkpoint-invalid");
		}
		const saved = new Map(this.ledger.tasks().map((t) => [t.id, t.next]));
		if (items.some((i) => saved.get(i.task_id) !== i.text)) return reject("checkpoint-race", "checkpoint-race");
		// 保存後にもう一度 handoff を照合する（保存の間の差替えを検出）
		if ((await this.readHandoff(p.path, bytes, sha)) !== handoff)
			return reject("checkpoint-invalid", "checkpoint-invalid");
		if (this.phasePending.get(project)?.id !== ticket.id || ticket.generation !== this.generation(project))
			return reject("phase-superseded", "phase-expired");
		clearTimeout(ticket.timer);
		this.phasePending.delete(project);
		const finalCheck = async (signal: AbortSignal): Promise<RefreshReason | null> => {
			if (this.generation(project) !== ticket.generation) return "phase-superseded";
			if (hasHumanWait(this.ledger, project)) return "human-wait";
			const now = this.ledger.tasks().filter((t) => t.project === project && t.status !== "done");
			if (now.length !== finalNext.size || now.some((t) => finalNext.get(t.id) !== t.next)) return "checkpoint-race";
			// 送信直前に handoff を取り直す。arm 後に transcript に出ない経路で書き換えられても、clear までに検出する
			if ((await this.readHandoff(p.path, bytes, sha)) !== handoff) return "checkpoint-invalid";
			const ci = await readCiWait(p.repo, this.exec, AbortSignal.any([signal, this.phaseController.signal]));
			if (ci === "busy") return "ci-wait";
			if (ci === "unknown") return "ci-unknown";
			return this.generation(project) === ticket.generation ? null : "phase-superseded";
		};
		sup
			.requestPhaseRefresh(ticket, finalCheck)
			.then((r) => this.log(`engine: [${project}] 強制整理 ${r.success ? "完了" : `見送り（${r.reason}）`}`))
			.catch((e: Error) => this.log(`engine: 強制整理の失敗 ${e.message}`));
		return { accepted: true, action: "end-turn", expiresAt: Date.now() + 30_000 };
	}

	/** worker からの進み具合の報告（harness-phase を通らない作業の記録） */
	private async report(who: Pick<Session, "role" | "name">, a: Record<string, unknown>) {
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
		this.bump(t.project);
		if (patch.status === "done") await this.onTaskDone(t);
		this.scheduleBoard();
		return t;
	}

	/** 設定の絵文字。未指定は既定、null は無効 */
	private reactionEmoji(): string | null {
		return this.config.reactionEmoji === undefined ? DEFAULT_REACTION_EMOJI : this.config.reactionEmoji;
	}

	/**
	 * A-番号の投稿（マージ承認）への 🙆‍♂️ を OK として受け付ける。窓口（LLM）は通さず answerAttention に乗せる。
	 * 外した・別の絵文字・対応済み・対象外は、受け付け済みの回答を取り消さずログだけ残す（猶予も設けない）。
	 */
	private async onDiscordReaction(d: unknown, kind: "add" | "remove") {
		const ev = parseReaction(d);
		if (!ev) return;
		// bot が自分で付ける ✅ / ☑️ も届くので、ログを汚さないよう静かに捨てる。READY 前は許可ユーザー判定が落とす
		if (ev.userId === this.botUserId || ev.isBot) return;
		if (ev.channelId !== this.config.defaultChannelId) return;
		const a = this.ledger.attention().find((x) => (x.messageIds ?? [x.messageId]).includes(ev.messageId));
		if (!a) return;
		const ignore = (reason: string) =>
			this.log(`engine: リアクションを無視 ${reason} ${a.id} user=${ev.userId} emoji=${codePoints(ev.emojiName)}`);
		if (!this.config.allowedUserIds.includes(ev.userId)) return ignore("not-allowed");
		if (kind === "remove") return ignore("removed");
		const configured = this.reactionEmoji();
		if (configured === null || !isOkEmoji({ id: ev.emojiId, name: ev.emojiName }, configured))
			return ignore("other-emoji");
		if (a.status !== "open") return ignore("already-resolved");
		if (a.kind !== "merge") return ignore("not-eligible");
		// ここから answerAttention の最初の文（同期の resolveAttention）までに await を挟まない。
		// 挟むと同時の反応や文字の回答と二重に答えうる
		const user = sanitizeUser(ev.userName, ev.userId);
		await this.answerAttention(a.id, `OK（Discord リアクション: ${user}）`);
		this.log(`engine: ${a.id} を OK として受け付けました（リアクション・user=${ev.userId}）`);
		const notice = `[${a.project}] ${a.id} を Discord のリアクションで OK として受け付けました。あなたから attention_answer する必要はありません`;
		if (this.deliver("concierge", notice, { kind: "notice", attention: a.id, project: a.project }) !== "held")
			this.remember(notice);
		await this.post(a.project, `${a.id} を OK として受け付けました（${user}・Discord リアクション）`, {
			replyTo: ev.messageId,
			heading: { icon: "ℹ️", label: "受付" },
		}).catch((e: Error) => this.log(`engine: ${a.id} の受付投稿に失敗 ${e.message.slice(0, 120)}`));
	}

	private async answerAttention(id: string, answer: string) {
		const a = this.ledger.resolveAttention(id, answer);
		const label = KIND_LABEL[a.kind];
		let delivery: string = "none";
		if (a.kind === "interview" || a.kind === "merge" || a.kind === "blocked" || a.kind === "setup") {
			delivery = this.deliver(
				a.project,
				`${a.id}（${label}${a.issue ? `・#${a.issue}` : ""}${a.pr ? `・PR #${a.pr}` : ""}）への回答が届きました（窓口経由・Discord）:\n${answer}`,
				{ attention: a.id, kind: a.kind, issue: a.issue, pr: a.pr, task: a.taskId, source: "discord" },
			);
			this.requestWake(a.project, `回答 ${a.id}`);
		}
		if (a.taskId)
			this.ledger.updateTask(a.taskId, { status: "ai-working", waiting: "" }, `${a.id} 回答: ${answer.slice(0, 80)}`);
		this.scheduleBoard();
		// 保存・配信を終えてから印を付ける（印の失敗で回答は取り消さない）
		await this.markAttention(a, "✅");
		return { attention: a.id, delivery };
	}

	private async onTaskDone(t: Task) {
		const closed = this.ledger.resolveAttentionForTask(t.id, "（完了）");
		const st = this.ledger.state();
		this.ledger.saveState({ doneSinceRetro: st.doneSinceRetro + 1 });
		this.maybeRequestRetro();
		await this.markAll(closed, "☑️");
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

	// --- 仕事と CI の監視 -------------------------------------------------------------------------
	private workClock(name: string) {
		const existing = this.workClocks.get(name);
		if (existing) return existing;
		const clock = new WorkClock();
		this.workClocks.set(name, clock);
		return clock;
	}

	private onWakeSent(send: WakeSend) {
		this.workClock(send.project).sent(this.wakeNow());
		if (send.causes.includes("initial") || send.causes.includes("refresh"))
			this.supervisor?.cancelPeriodicWake(send.project);
		const sendId = `${this.wakeBoot}-s${++this.wakeSendSequence}`;
		this.log(
			`engine: wake-sent ${JSON.stringify({
				v: 1,
				boot: this.wakeBoot,
				project: send.project,
				sendId,
				at: new Date(this.wakeWall()).toISOString(),
				causes: send.causes,
				decisions: send.decisions,
			})}`,
		);
		for (const id of send.decisions) this.workLogs.get(id)?.({ result: "sent", sendId });
	}

	private currentWakeProjects(strict: boolean): Map<string, WakeProject> {
		const projects = strict ? this.ledger.wakeProjects() : this.ledger.projects();
		const map = new Map<string, WakeProject>();
		for (const target of sessionTargets(this.config, projects, this.ledger)) {
			const project = projects.find((p) => p.name === target.name);
			if (project?.active && project.mode === "harness" && target.wake && !target.startupError)
				map.set(project.name, {
					name: project.name,
					repo: typeof project.repo === "string" ? project.repo : "",
					cwd: target.cwd,
					tmuxSession: target.tmuxSession,
				});
		}
		return map;
	}

	private sameWorkTarget(a: WakeProject, b?: WakeProject) {
		return Boolean(b && a.repo === b.repo && a.cwd === b.cwd && a.tmuxSession === b.tmuxSession);
	}

	private isWorkTarget(project: WakeProject, failedRegistration: boolean): boolean {
		try {
			return this.sameWorkTarget(project, this.currentWakeProjects(!failedRegistration).get(project.name));
		} catch {
			return false;
		}
	}

	/**
	 * ラベルの変化を購読できないので、既存の 60 秒周期で読む。queued の初回は差分の基準だけを作る。
	 * 一覧が取得できなかったときは queuedSeen を進めず、次の成功時に新規を拾う。
	 */
	queueTick(): Promise<void> {
		if (this.workController.signal.aborted || this.config.worker.wake?.enabled === false || !this.supervisor)
			return Promise.resolve();
		this.workPoll ??= this.pollWork().finally(() => {
			this.workPoll = undefined;
		});
		return this.workPoll;
	}

	private async pollWork() {
		let targets: Map<string, WakeProject>;
		let registrationFailure: ReadFailure | undefined;
		try {
			targets = this.currentWakeProjects(true);
			for (const [name, previous] of this.workTargets) {
				if (this.sameWorkTarget(previous, targets.get(name))) continue;
				this.supervisor?.cancelPeriodicWake?.(name);
				this.supervisor?.reconcileQueuedWake?.(name, []);
				this.workClocks.delete(name);
			}
			this.workTargets = targets;
		} catch (error) {
			registrationFailure = wakeLedgerFailure("projects", error);
			targets = this.workTargets;
			if (!targets.size)
				this.log(
					`engine: work-wake-read ${JSON.stringify({
						v: 1,
						boot: this.wakeBoot,
						at: new Date(this.wakeWall()).toISOString(),
						failure: registrationFailure,
					})}`,
				);
		}
		const pending = [...targets.values()];
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, pending.length) }, async () => {
				while (next < pending.length && !this.workController.signal.aborted) {
					const project = pending[next++];
					if (project) await this.pollWorkProject(project, registrationFailure);
				}
			}),
		);
	}

	private async pollWorkProject(project: WakeProject, registrationFailure?: ReadFailure) {
		const signal = this.workController.signal;
		const { name, repo } = project;
		const localRead = () => this.ledger.wakeLocal(name);
		const remote = registrationFailure
			? { issues: null, prs: null, failures: [registrationFailure] }
			: await readWork(repo, this.exec, signal, this.wakeWall, { project: name, read: localRead });
		const local = localRead();
		const current = !signal.aborted && this.isWorkTarget(project, Boolean(registrationFailure));
		const numbers = remote.issues?.filter((i) => i.labels.includes("harness:queued")).map((i) => String(i.number));
		let fresh: string[] = [];
		if (current) {
			try {
				fresh = this.ledger.wakeQueued(name, numbers ?? null);
			} catch (error) {
				local.failures.push(wakeLedgerFailure("queued-state", error));
			}
			if (numbers) this.supervisor?.reconcileQueuedWake?.(name, numbers);
		}
		const { reasons, failures, fingerprint } = classifyWork(name, remote, local, this.wakeWall(), fresh.length > 0);
		const id = `${this.wakeBoot}-${++this.wakeSequence}`;
		const at = new Date(this.wakeWall()).toISOString();
		const now = this.wakeNow();
		const work = reasons.length > 0;
		const clock = this.workClock(name);
		const cadence: Cadence = work ? clock.observe(now, fingerprint) : "none";
		if (!work) clock.observe(now, null);
		const log = (result: WakeLogResult) =>
			this.log(
				`engine: work-wake ${JSON.stringify({
					v: 1,
					boot: this.wakeBoot,
					id,
					project: name,
					at,
					work,
					reasons,
					fetchFailed: failures.length > 0,
					failures,
					cadence,
					...result,
				})}`,
			);
		if (!current || cadence === "none") {
			this.supervisor?.cancelPeriodicWake?.(name);
			log({ result: current ? "empty" : "stopped" });
			return;
		}

		const due = clock.due(now, cadence);
		if (!due) this.supervisor?.cancelPeriodicWake?.(name);
		if (!due && !fresh.length) {
			log({ result: "not-due" });
			return;
		}
		const timer = setTimeout(() => finish({ result: "deferred", detail: "in-flight" }), 10_000);
		timer.unref();
		const finish = (result: WakeLogResult) => {
			if (!this.workLogs.delete(id)) return;
			clearTimeout(timer);
			log(result);
		};
		this.workLogs.set(id, finish);
		const deferred = (detail: WakeDetail) => finish({ result: "deferred", detail });
		if (fresh.length)
			this.requestWake(name, `queued #${fresh.join(",#")}`, { decisionId: id, queued: fresh, deferred });
		if (due)
			this.requestWake(name, "periodic", {
				decisionId: id,
				isCurrent: () =>
					!signal.aborted &&
					this.wakeNow() < now + periodicValidityMs &&
					this.isWorkTarget(project, Boolean(registrationFailure)),
				beforeInput: () => this.bump(name),
				deferred,
			});
		void this.supervisor?.wakeTick().catch(() => deferred("send-error"));
	}

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
					await this.post(p.name, `${run.workflowName} @ ${branch}\n${run.displayTitle}\n<${run.url}>`, {
						heading: { icon: "🟠", label: "CI失敗" },
					});
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
