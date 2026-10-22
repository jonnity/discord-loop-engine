// Discord Gateway（受信用 WebSocket）の最小クライアント。
// discord.js を使わないのは、このエンジンが「メッセージの中継」しかせず、必要なのが
// Hello / Identify / Heartbeat / Resume / MESSAGE_CREATE だけだから。依存を増やさず、
// Node 標準の WebSocket で済ませる。

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, ACK: 11 };

// これらで閉じられたら、再接続しても直らない（トークン・intents の設定ミス）
const FATAL_CLOSE = new Map<number, string>([
	[4004, "トークンが無効です"],
	[4010, "shard 設定が不正です"],
	[4011, "shard が必要です"],
	[4012, "API バージョンが不正です"],
	[4013, "intents が不正です"],
	[
		4014,
		"Message Content Intent が許可されていません（Developer Portal の Bot → Privileged Gateway Intents で有効にしてください）",
	],
]);

export interface WsLike {
	addEventListener(type: string, fn: (ev: { data?: unknown; code?: number }) => void): void;
	send(data: string): void;
	close(code?: number): void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface GatewayOptions {
	token: string;
	onMessage?: (d: unknown) => void;
	onReady?: (user: { id: string; username?: string } | null) => void;
	onFatal?: (reason: string) => void;
	log?: (msg: string) => void;
	WebSocketImpl?: new (url: string) => WsLike;
	timers?: {
		setTimeout: (fn: () => void, ms: number) => Timer;
		clearTimeout: (t: Timer | null) => void;
		setInterval: (fn: () => void, ms: number) => Timer;
		clearInterval: (t: Timer | null) => void;
	};
}

export class Gateway {
	private token: string;
	private onMessage: (d: unknown) => void;
	private onReady: (user: { id: string; username?: string } | null) => void;
	private onFatal: (reason: string) => void;
	private log: (msg: string) => void;
	private WS: new (
		url: string,
	) => WsLike;
	private timers: NonNullable<GatewayOptions["timers"]>;
	private seq: number | null = null;
	private sessionId: string | null = null;
	private resumeUrl: string | null = null;
	private ws: WsLike | null = null;
	private heartbeat: Timer | null = null;
	private heartbeatStart: Timer | null = null;
	private helloTimer: Timer | null = null;
	private helloReceived = false;
	private acked = true;
	private stopped = false;
	private resuming = false;
	private backoffMs = 1000;
	connected = false;
	user: { id: string; username?: string } | null = null;

	constructor(opts: GatewayOptions) {
		this.token = opts.token;
		this.onMessage = opts.onMessage ?? (() => {});
		this.onReady = opts.onReady ?? (() => {});
		this.onFatal = opts.onFatal ?? (() => {});
		this.log = opts.log ?? (() => {});
		this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
		this.timers = opts.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (t) => {
				if (t) clearTimeout(t);
			},
			setInterval: (fn, ms) => setInterval(fn, ms),
			clearInterval: (t) => {
				if (t) clearInterval(t);
			},
		};
	}

	start() {
		this.stopped = false;
		this.connect(false);
	}

	stop() {
		this.stopped = true;
		this.stopHeartbeat();
		this.timers.clearTimeout(this.helloTimer);
		try {
			this.ws?.close(1000);
		} catch {}
	}

	private connect(resume: boolean) {
		const url = resume && this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL;
		this.resuming = Boolean(resume && this.sessionId);
		const ws = new this.WS(url);
		this.ws = ws;
		ws.addEventListener("message", (ev) => this.handle(ws, ev.data));
		ws.addEventListener("close", (ev) => this.handleClose(ws, ev.code ?? 1006));
		// Node の WebSocket は接続自体に失敗すると error だけを出して close を出さないことがある
		// （プロキシ拒否で確認）。close を待たずに切断として扱う。後から close が来ても ws が
		// 入れ替わっているので二重には処理されない。
		ws.addEventListener("error", () => {
			if (ws !== this.ws) return;
			this.log("gateway: WebSocket エラー");
			this.handleClose(ws, 1006);
		});
		this.helloReceived = false;
		// Hello が来ないまま固まった接続も切断として扱う
		this.helloTimer = this.timers.setTimeout(() => {
			if (this.ws === ws && !this.helloReceived) {
				this.log("gateway: Hello が届かないため再接続します");
				this.handleClose(ws, 1006);
			}
		}, 30_000);
	}

	private sendOp(op: number, d: unknown) {
		try {
			this.ws?.send(JSON.stringify({ op, d }));
		} catch (err) {
			this.log(`gateway: 送信失敗 ${(err as Error).message}`);
		}
	}

	private handle(ws: WsLike, raw: unknown) {
		if (ws !== this.ws) return;
		let p: { op: number; d: unknown; s?: number | null; t?: string };
		try {
			p = JSON.parse(typeof raw === "string" ? raw : String(raw));
		} catch {
			return;
		}
		if (p.s != null) this.seq = p.s;
		switch (p.op) {
			case OP.HELLO:
				this.helloReceived = true;
				this.timers.clearTimeout(this.helloTimer);
				this.startHeartbeat((p.d as { heartbeat_interval: number }).heartbeat_interval);
				if (this.resuming) {
					this.sendOp(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.seq });
				} else {
					this.sendOp(OP.IDENTIFY, {
						token: this.token,
						intents: INTENTS,
						properties: { os: process.platform, browser: "discord-loop-engine", device: "discord-loop-engine" },
					});
				}
				break;
			case OP.ACK:
				this.acked = true;
				break;
			case OP.HEARTBEAT:
				this.sendOp(OP.HEARTBEAT, this.seq);
				break;
			case OP.RECONNECT:
				this.reconnect(true);
				break;
			case OP.INVALID_SESSION:
				if (!p.d) {
					this.sessionId = null;
					this.seq = null;
				}
				this.reconnect(Boolean(p.d));
				break;
			case OP.DISPATCH:
				this.dispatch(p.t ?? "", p.d);
				break;
		}
	}

	private dispatch(t: string, d: unknown) {
		if (t === "READY") {
			const r = d as { session_id: string; resume_gateway_url: string; user: { id: string; username?: string } };
			this.sessionId = r.session_id;
			this.resumeUrl = r.resume_gateway_url;
			this.user = r.user;
			this.connected = true;
			this.backoffMs = 1000;
			this.log(`gateway: 接続しました（${r.user?.username}）`);
			this.onReady(r.user);
		} else if (t === "RESUMED") {
			this.connected = true;
			this.backoffMs = 1000;
			this.log("gateway: 再開しました");
		} else if (t === "MESSAGE_CREATE") {
			this.onMessage(d);
		}
	}

	private startHeartbeat(interval: number) {
		this.stopHeartbeat();
		this.acked = true;
		const beat = () => {
			if (!this.acked) {
				// 前回の heartbeat に応答が無い＝接続が死んでいる
				this.log("gateway: heartbeat 応答なし、再接続します");
				this.reconnect(true);
				return;
			}
			this.acked = false;
			this.sendOp(OP.HEARTBEAT, this.seq);
		};
		// 最初の1回は仕様どおり interval * jitter 後に送る
		this.heartbeatStart = this.timers.setTimeout(
			() => {
				beat();
				this.heartbeat = this.timers.setInterval(beat, interval);
			},
			Math.floor(interval * Math.random()),
		);
	}

	private stopHeartbeat() {
		this.timers.clearTimeout(this.heartbeatStart);
		this.timers.clearInterval(this.heartbeat);
		this.heartbeatStart = null;
		this.heartbeat = null;
	}

	private reconnect(resume: boolean) {
		this.stopHeartbeat();
		this.timers.clearTimeout(this.helloTimer);
		this.connected = false;
		const old = this.ws;
		this.ws = null;
		try {
			// 1000/1001 で閉じるとセッションが無効になるため、再開したいときは別のコードで閉じる
			old?.close(resume ? 4900 : 1000);
		} catch {}
		if (this.stopped) return;
		const wait = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
		this.timers.setTimeout(() => this.connect(resume), wait);
	}

	private handleClose(ws: WsLike, code: number) {
		if (ws !== this.ws) return; // reconnect() で自分から閉じたもの
		this.connected = false;
		const fatal = FATAL_CLOSE.get(code);
		if (fatal) {
			this.stopped = true;
			this.stopHeartbeat();
			this.onFatal(`${fatal}（close ${code}）`);
			return;
		}
		this.log(`gateway: 切断されました（close ${code}）、再接続します`);
		// 4007(seq 不正) / 4009(タイムアウト) は再開できないので新規に identify する
		const resumable = code !== 4007 && code !== 4009;
		if (!resumable) {
			this.sessionId = null;
			this.seq = null;
		}
		this.reconnect(resumable);
	}
}
