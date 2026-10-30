// 窓口と各 worker の Claude Code セッションを tmux のウィンドウで起動し続ける。
// tmux を使うのは、セッションを engine から切り離して動かし続けつつ、人間が
// `tmux attach -t dle` でいつでも同じ画面を覗いて手で操作できるようにするため。

import { execFile } from "node:child_process";
import path from "node:path";
import { type ClaudeSession, contextReader, type TranscriptContext } from "./context.ts";
import { DEFAULT_WORKER_LIMIT, detectLimit, type WorkerLimit } from "./limit.ts";

import { withinDirectory } from "./worktrees.ts";

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS = 3;
const REGISTER_TIMEOUT_MS = 3 * 60_000;
// --dangerously-load-development-channels は起動のたびに確認画面を出す（Claude Code 2.1.306 で確認）。
// 既定の選択肢が「I am using this for local development」なので Enter だけ送る。
// フォルダの信頼・MCP サーバーの承認・ログインは自動で答えない（初回に人が tmux で答える）。
const DEV_CHANNEL_PROMPT = "I am using this for local development";
// 許可確認で止まっている画面の目印
const PERMISSION_PROMPTS = ["Do you want to proceed?", "Do you want to make this edit", "Do you want to create"];
// 応答の途中に出る目印（この間は /clear を入れない）
const WORKING_MARK = "esc to interrupt";
/** 上限中の自動の起こしを要求するときの理由（`limited` の間はこの理由でしか送らない） */
const LIMIT_REASON = "limit";
// 旧版向けの表記も残す。画面だけで待機を決めず、内部ファイルの idle と併用する。
const CONTEXT_LEFT = [/Context left until auto-compact: (\d+)%/i, /(\d+)% context left/i, /(\d+)% until auto-compact/i];

/** idle の worker に送る文字列。定数のみを送り、Discord・Issue・target 由来の文字列は send-keys に入れない（入力注入を避けるため） */
export const WAKE_PROMPT = "/discord-loop-engine:issue-loop";
const WAKE_MAX_REASONS = 10;

export interface WakeTarget {
	enabled: true;
}

interface WakeState {
	reasons: string[];
	since: number | null;
	lastSentAt: number | null;
	sending: boolean;
	enterOnly: boolean;
	unknownNotified: boolean;
}

export interface RefreshResult {
	success: boolean;
	reason: string;
}

export interface RefreshTarget {
	worktreeRoot?: string;
	prompt: string;
	maxTokens: number;
	maxEvents: number;
	contextPercent: number;
	idleSeconds: number;
	cooldownMinutes: number;
	waitForCodex: boolean;
	codexIgnoreAfterMinutes: number;
	cwd: string;
}

function emptyPrompt(pane: string): boolean {
	const lines = pane.split("\n").slice(-15);
	const index = lines.findLastIndex((line) => /^\s*❯/.test(line));
	if (index < 0 || !/^\s*❯\s*$/.test(lines[index] ?? "")) return false;
	// 区切り線より上に続きの入力があれば、先頭行が空でも割り込まない。
	const below = lines.slice(index + 1);
	const divider = below.findIndex((line) => /^\s*[─━-]{3,}\s*$/.test(line));
	return (divider < 0 ? below : below.slice(0, divider)).every((line) => !line.trim());
}

/** 入力欄（末尾 15 行の最後の ❯ 行）の文字。❯ 行が無い、または区切り線までの下に続きの入力があれば null */
function inputText(pane: string): string | null {
	const lines = pane.split("\n").slice(-15);
	const index = lines.findLastIndex((line) => /^\s*❯/.test(line));
	if (index < 0) return null;
	const below = lines.slice(index + 1);
	const divider = below.findIndex((line) => /^\s*[─━-]{3,}\s*$/.test(line));
	if (!(divider < 0 ? below : below.slice(0, divider)).every((line) => !line.trim())) return null;
	return (/^\s*❯\s?(.*)$/.exec(lines[index] ?? "")?.[1] ?? "").trim();
}

/**
 * 起こしてよいかの判定（純関数）。肯定的な証拠が揃ったときだけ真にし、未知の画面は偽に倒す。
 * why が "unknown" で始まるのは「判定できない」場合（journal に残す）。
 * typed を渡すと「入力欄が空」の代わりに「入力欄が typed と一致」を求める（Enter だけの再送用）。
 */
export function wakeReadiness(input: {
	panes: [string, string] | null;
	session: ClaudeSession | null;
	cwd: string;
	transcript: TranscriptContext | null;
	now: number;
	quietMs: number;
	typed?: string;
}): { ready: boolean; why: string } {
	const no = (why: string) => ({ ready: false, why });
	if (!input.panes) return no("画面を取得できない");
	const [a, b] = input.panes;
	if (a !== b) return no("画面が動いている");
	if (b.includes(WORKING_MARK)) return no("作業中");
	if ([...PERMISSION_PROMPTS, DEV_CHANNEL_PROMPT].some((p) => b.includes(p))) return no("確認画面");
	if (input.typed === undefined ? !emptyPrompt(b) : inputText(b) !== input.typed) return no("入力欄が空でない");
	if (!input.session) return no("unknown: セッションを読めない");
	if (input.session.status !== "idle") return no("status が idle でない");
	if (path.resolve(input.session.cwd) !== path.resolve(input.cwd)) return no("cwd が違う");
	if (!input.transcript) return no("unknown: 会話ログを読めない");
	if (
		input.now - input.transcript.mtimeMs < input.quietMs ||
		input.now - input.transcript.subagentMtimeMs < input.quietMs
	)
		return no("直前まで動いていた");
	return { ready: true, why: "" };
}

function screenContext(pane: string): { tokens: number | null; left: number | null } {
	const uncached = /~([\d.]+)k uncached/i.exec(pane);
	const remaining = CONTEXT_LEFT.map((re) => re.exec(pane)).find(Boolean);
	const used = /(\d+)% context used/i.exec(pane);
	const left = remaining ? Number(remaining[1]) : used ? 100 - Number(used[1]) : null;
	const tokens = uncached ? Number(uncached[1]) * 1000 : null;
	return {
		tokens: tokens !== null && Number.isFinite(tokens) ? tokens : null,
		left: left !== null && left >= 0 && left <= 100 ? left : null,
	};
}

export type Tmux = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr?: string }>;

export function tmuxRunner(): Tmux {
	return (args) =>
		new Promise((resolve) => {
			execFile("tmux", args, (err, stdout, stderr) =>
				resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
			);
		});
}

export interface SessionTarget {
	startupError?: string;
	name: string; // "concierge" または プロジェクト名
	cwd: string;
	command: string; // シェルで実行する1行
	initialPrompt: string;
	/** worker・窓口の待機中に文脈を整理する設定 */
	refresh?: RefreshTarget;
	/** 既定以外の tmux セッションで起動したいとき（そのリポジトリのスクリプトが特定のセッション名を前提にしている場合） */
	tmuxSession?: string;
	/** idle の worker を engine が起こす対象（harness・ready の worker のみ）。送る文字列は WAKE_PROMPT 固定 */
	wake?: WakeTarget;
}

export function windowName(name: string) {
	return `dle-${name}`;
}

/** シェルの1引数として安全に渡せる形にする */
export function shq(s: string): string {
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

interface SlotState {
	restarts: number[];
	spawnedAt: number | null;
	waitingNotified: boolean;
	gaveUp: boolean;
	needsPrompt: boolean;
	devPromptAnswered: boolean;
	stuckTicks: number;
	stuckNotified: boolean;
	lastRefreshAt: number | null;
	transitionSession: string | null;
	unknownSession: string | null;
	codexSince: Map<string, number>;
	refreshing: boolean;
	wake: WakeState;
	/** onRegistered が初期プロンプトを入れる間（5 秒待ち＋送信）だけ真 */
	promptPending: boolean;
	/** 画面に上限表示が出ている間だけ真（メモリのみ。台帳には書かない） */
	limited: boolean;
	limitMisses: number;
	limitSince: number | null;
	limitResetText: string | null;
	/** 起こしを送れた回数・次に要求してよい時刻・最後に送った時刻・あきらめ済み（このエピソード内。clearLimit で戻す） */
	limitAttempts: number;
	limitNextAt: number | null;
	limitLastWakeAt: number | null;
	limitGaveUp: boolean;
}

export interface LimitedEntry {
	name: string;
	since: number;
	resetText: string | null;
}

// 最後の起こしを送ってから、その結果が画面に出るのを待つ猶予（約 3 tick）。この後もまだ上限ならあきらめる
const LIMIT_GIVE_UP_GRACE_MS = 90_000;

// 2 回連続（約 1 分）で上限表示が消えたら解除する。一瞬の描画の揺れで通知の回数管理を壊さないため
const LIMIT_CLEAR_MISSES = 2;

export interface SupervisorOptions {
	tmuxSession: string;
	targets: () => SessionTarget[];
	tmux: Tmux;
	isLive: (name: string) => boolean;
	notify: (name: string, text: string) => void;
	/** 前回の /clear 以降に流し込んだ件数と、最後にやり取りした時刻 */
	activity?: (name: string) => { events: number; lastAt: number };
	/** /clear の前後に呼ぶ（その間に届いたものは engine が溜めておき、終わってから渡す） */
	onRefresh?: (name: string, phase: "start" | "done", result?: RefreshResult) => void;
	onRefreshSkipped?: (name: string, reason: string) => void;
	readSession?: (pid: string) => Promise<ClaudeSession | null>;
	readTranscript?: (session: ClaudeSession) => Promise<TranscriptContext | null>;
	clearConfirmMs?: number;
	wait?: (ms: number) => Promise<void>;
	log?: (msg: string) => void;
	now?: () => number;
	promptDelayMs?: number;
	/** 起こしを見送った・確かめられなかったときに呼ぶ（journal 用） */
	onWakeSkipped?: (name: string, reason: string) => void;
	wakeProbeMs?: number;
	wakeQuietMs?: number;
	wakeMinIntervalMs?: number;
	wakeVerifyMs?: number;
	/** 上限表示の検出設定。省略・undefined は既定値 */
	limit?: WorkerLimit;
	/** 上限エピソードの開始時に1回だけ呼ぶ（その時点で上限中の全 worker） */
	onLimit?: (entries: LimitedEntry[]) => void;
	/** 自動の起こしをあきらめたとき。上限エピソードにつき1回だけ（その tick で新たにあきらめた全 worker の名前） */
	onLimitGaveUp?: (e: { names: string[]; attempts: number }) => void;
}

export class Supervisor {
	private o: Required<SupervisorOptions>;
	private state = new Map<string, SlotState>();
	private startedAt: number;
	private startupErrors = new Map<string, string>();
	private ticking = false;
	private waking = false;
	/** 現在の上限エピソードで通知済みか。全員が解除されたら戻す */
	private limitNotified = false;
	/** 現在の上限エピソードであきらめ通知を出したか。limitNotified と同じ所で戻す */
	private limitGaveUpNotified = false;
	/** 今の tick で新たにあきらめた slot（finishLimitTick で通知にまとめる） */
	private limitGaveUpNow: string[] = [];

	constructor(opts: SupervisorOptions) {
		// channel の接続直後は入力欄がまだ準備できていないことがあるため、少し待ってから入力する
		this.o = {
			...contextReader(),
			clearConfirmMs: 15000,
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			onRefreshSkipped: () => {},
			log: () => {},
			now: Date.now,
			promptDelayMs: 5000,
			onWakeSkipped: () => {},
			wakeProbeMs: 1500,
			wakeQuietMs: 10_000,
			wakeMinIntervalMs: 60_000,
			wakeVerifyMs: 3000,
			activity: () => ({ events: 0, lastAt: 0 }),
			onRefresh: () => {},
			onLimit: () => {},
			onLimitGaveUp: () => {},
			...opts,
			// ...opts に limit: undefined が入っていても既定値になるよう、後ろに置く
			limit: opts.limit ?? DEFAULT_WORKER_LIMIT,
		};
		this.startedAt = this.o.now();
	}

	private st(name: string): SlotState {
		let s = this.state.get(name);
		if (!s) {
			s = {
				restarts: [],
				spawnedAt: null,
				waitingNotified: false,
				gaveUp: false,
				needsPrompt: false,
				devPromptAnswered: false,
				stuckTicks: 0,
				stuckNotified: false,
				lastRefreshAt: null,
				transitionSession: null,
				unknownSession: null,
				codexSince: new Map(),
				refreshing: false,
				wake: { reasons: [], since: null, lastSentAt: null, sending: false, enterOnly: false, unknownNotified: false },
				promptPending: false,
				limited: false,
				limitMisses: 0,
				limitSince: null,
				limitResetText: null,
				limitAttempts: 0,
				limitNextAt: null,
				limitLastWakeAt: null,
				limitGaveUp: false,
			};
			this.state.set(name, s);
		}
		return s;
	}

	private sessionOf(t: Pick<SessionTarget, "tmuxSession">) {
		return t.tmuxSession ?? this.o.tmuxSession;
	}

	private target(name: string) {
		const t = this.o.targets().find((x) => x.name === name);
		return `${t ? this.sessionOf(t) : this.o.tmuxSession}:${windowName(name)}`;
	}

	private async windows(session: string): Promise<string[] | null> {
		const r = await this.o.tmux(["list-windows", "-t", session, "-F", "#{window_name}"]);
		return r.ok ? r.stdout.split("\n").filter(Boolean) : null; // null = tmux セッション自体が無い
	}

	async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.tickOnce();
		} finally {
			this.ticking = false;
		}
	}

	private async tickOnce() {
		const targets = this.o.targets();
		const bySession = new Map<string, string[] | null>();
		for (const session of new Set(targets.map((t) => this.sessionOf(t))))
			bySession.set(session, await this.windows(session));
		for (const t of targets) {
			if (t.startupError) {
				if (this.startupErrors.get(t.name) !== t.startupError) {
					this.o.log(`supervisor: ${t.startupError}`);
					this.o.notify(t.name, `🔴 ${t.startupError}`);
					this.startupErrors.set(t.name, t.startupError);
				}
				continue;
			}
			this.startupErrors.delete(t.name);
			const s = this.st(t.name);
			const wins = bySession.get(this.sessionOf(t)) ?? null;
			const exists = wins?.includes(windowName(t.name)) ?? false;
			// 窓が無い・channel が切れたなら、上限表示は残っていても「上限中」とは扱わない
			if (!(this.o.isLive(t.name) && exists)) this.clearLimit(s);
			if (this.o.isLive(t.name)) {
				s.waitingNotified = false;
				if (exists) {
					await this.checkStuck(t.name, s);
					await this.checkLimit(t, s);
					await this.maybeRefresh(t);
					await this.maybeWake(t, exists);
				}
				continue;
			}
			if (exists) {
				if (!s.devPromptAnswered) {
					const pane = await this.o.tmux(["capture-pane", "-p", "-t", this.target(t.name)]);
					if (pane.ok && pane.stdout.includes(DEV_CHANNEL_PROMPT)) {
						await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
						s.devPromptAnswered = true;
						this.o.log(`supervisor: ${t.name} の開発用 channel の確認に答えました`);
						continue;
					}
				}
				// ウィンドウはあるのに channel が繋がってこない（フォルダの信頼・MCP の承認・ログイン待ちなど）
				if (s.spawnedAt !== null && this.o.now() - s.spawnedAt > REGISTER_TIMEOUT_MS && !s.waitingNotified) {
					s.waitingNotified = true;
					this.o.notify(
						t.name,
						`⚠️ セッションを起動しましたが engine に繋がっていません。\`tmux attach -t ${this.sessionOf(t)}\` で \`${windowName(t.name)}\` を開き、表示されている確認に答えてください。`,
					);
				}
				continue;
			}
			if (s.gaveUp) continue;
			s.restarts = s.restarts.filter((x) => this.o.now() - x < RESTART_WINDOW_MS);
			if (s.restarts.length >= MAX_RESTARTS) {
				s.gaveUp = true;
				this.o.notify(
					t.name,
					`🔴 セッションが短時間に ${MAX_RESTARTS} 回落ちたため、自動起動を止めました。原因を確認して \`dle restart ${t.name}\` で再開してください。`,
				);
				continue;
			}
			await this.spawn(t, wins !== null);
			// 同じセッションの次の起動は new-window にする
			if (wins === null) bySession.set(this.sessionOf(t), [windowName(t.name)]);
		}
		this.finishLimitTick(targets);
	}

	private clearLimit(s: SlotState) {
		s.limited = false;
		s.limitMisses = 0;
		s.limitSince = null;
		s.limitResetText = null;
		s.limitAttempts = 0;
		s.limitNextAt = null;
		s.limitLastWakeAt = null;
		s.limitGaveUp = false;
		// 復帰後に古い要求が残って余計な起こしを送らない
		s.wake.reasons = s.wake.reasons.filter((r) => r !== LIMIT_REASON);
	}

	/**
	 * 上限表示を読む。read-only（send-keys をしない）なので wake / refresh と衝突せず、それらの判定にも使わない。
	 * capture に失敗したら状態を変えない。
	 */
	private async checkLimit(t: SessionTarget, s: SlotState) {
		const name = t.name;
		const cfg = this.o.limit;
		if (!cfg.enabled) return;
		const pane = await this.capture(name);
		if (pane === null) return;
		const hit = detectLimit(pane, cfg);
		if (hit) {
			s.limitMisses = 0;
			if (!s.limited) {
				s.limited = true;
				s.limitSince = this.o.now();
				s.limitAttempts = 0;
				s.limitNextAt = this.o.now() + this.limitIntervalMs(0);
				s.limitLastWakeAt = null;
				s.limitGaveUp = false;
			}
			// 後から取れた復帰時刻で更新するだけで、再通知はしない
			if (hit.resetText !== null) s.limitResetText = hit.resetText;
			this.limitRetry(t, s);
			return;
		}
		if (!s.limited) return;
		// 起こした後は、入力のエコー（>）や応答（⎿）で上限の行が除外・範囲外になり得る。作業中の印が無いなら復帰とは数えない。
		// 数えると解除→古い行の再検出で新しいエピソードになり、通知と起こしが繰り返される
		// limitMisses は触らない（上限行が検出された tick だけが 0 に戻す）。ここで戻すと、短く動いて idle に戻った復帰済みの worker が解除されない
		// 次の起こし・あきらめの判断は上限行が見えない間も続ける（limitRetry を通さないと再試行もあきらめ通知も止まる）
		// 作業中の印は detectLimit と同じ末尾だけで見る（上のほうに残った古い表示で数え違えない）
		const tail = pane.split("\n").slice(-cfg.tailLines).join("\n");
		if (this.o.limit.wakeMaxAttempts > 0 && s.limitAttempts > 0 && !tail.includes(WORKING_MARK)) {
			this.limitRetry(t, s);
			return;
		}
		s.limitMisses += 1;
		if (s.limitMisses >= LIMIT_CLEAR_MISSES) this.clearLimit(s);
	}

	/** 次の起こしまでの待ち。attempts 回送った後は 2^attempts 倍（復帰時刻は使わない固定間隔の倍々） */
	private limitIntervalMs(attempts: number): number {
		return this.o.limit.wakeIntervalMinutes * 60_000 * 2 ** attempts;
	}

	/** 上限が続いている tick で、起こしの要求かあきらめを判断する。送信は maybeWake の判定を通ったときだけ */
	private limitRetry(t: SessionTarget, s: SlotState) {
		const max = this.o.limit.wakeMaxAttempts;
		if (!t.wake || max <= 0 || s.limitGaveUp) return;
		const now = this.o.now();
		if (s.limitAttempts >= max) {
			if (s.limitLastWakeAt !== null && now >= s.limitLastWakeAt + LIMIT_GIVE_UP_GRACE_MS) {
				s.limitGaveUp = true;
				// 通知は上限エピソードにつき1回。後からあきらめた slot は通知しない（dle restart --limited が全員を対象にする）
				if (!this.limitGaveUpNotified) this.limitGaveUpNow.push(t.name);
			}
			return;
		}
		if (s.limitNextAt !== null && now >= s.limitNextAt) this.requestWake(t.name, LIMIT_REASON);
	}

	/** 現在の targets() にあり startupError の無い名前（上限の数え方はこの集合だけを見る） */
	private currentNames(): Set<string> {
		return new Set(
			this.o
				.targets()
				.filter((t) => !t.startupError)
				.map((t) => t.name),
		);
	}

	private limitedEntries(current: Set<string>): LimitedEntry[] {
		const list: LimitedEntry[] = [];
		for (const [name, s] of this.state)
			if (s.limited && current.has(name))
				list.push({ name, since: s.limitSince ?? this.o.now(), resetText: s.limitResetText });
		return list;
	}

	/**
	 * tick の最後。対象から外れた slot（project_set_active で外れた・startupError）は this.state に残るので、
	 * ここで解除する。残すとエピソードが終わらず、以後の上限が通知されない。
	 */
	private finishLimitTick(targets: SessionTarget[]) {
		const current = new Set(targets.filter((t) => !t.startupError).map((t) => t.name));
		for (const [name, s] of this.state) if (!current.has(name)) this.clearLimit(s);
		const entries = this.limitedEntries(current);
		if (entries.length === 0) {
			this.limitNotified = false;
			this.limitGaveUpNotified = false;
			this.limitGaveUpNow = [];
			return;
		}
		if (this.limitGaveUpNow.length > 0) {
			const names = this.limitGaveUpNow;
			this.limitGaveUpNow = [];
			if (!this.limitGaveUpNotified) {
				this.limitGaveUpNotified = true;
				this.o.onLimitGaveUp({ names, attempts: this.o.limit.wakeMaxAttempts });
			}
		}
		if (this.limitNotified) return;
		this.limitNotified = true;
		this.o.onLimit(entries);
	}

	/** 上限中の worker の名前（現在の対象のみ） */
	limitedNames(): string[] {
		return this.limitedEntries(this.currentNames()).map((e) => e.name);
	}

	/**
	 * 上限で止まった worker（limited）または全員を、1件ずつ窓を閉じて起動し直させる。起動は次の巡回の spawn に任せる。
	 * 入力途中の slot は壊さないよう kill せず skipped で返す。台帳には触れない。
	 */
	async restartMany(
		mode: "limited" | "all",
		except: string[],
	): Promise<{ restarted: string[]; skipped: { name: string; reason: string }[] }> {
		const known = new Set(this.o.targets().map((t) => t.name));
		for (const n of except) if (!known.has(n)) throw new Error(`--except に存在しない名前があります: ${n}`);
		const names = (mode === "limited" ? this.limitedNames() : [...this.currentNames()]).filter(
			(n) => !except.includes(n),
		);
		const restarted: string[] = [];
		const skipped: { name: string; reason: string }[] = [];
		const busy = (name: string) => {
			const s = this.state.get(name);
			if (!s) return null;
			if (s.refreshing) return "文脈の整理中";
			if (s.wake.sending) return "起こしの送信中";
			if (s.promptPending) return "初期プロンプトの入力中";
			return null;
		};
		for (const name of names) {
			// 判定と kill の間に await が無いので、判定は kill 時点でも有効
			const why = busy(name);
			if (why) {
				skipped.push({ name, reason: why });
				continue;
			}
			await this.restart(name);
			restarted.push(name);
		}
		return { restarted, skipped };
	}

	private async checkStuck(name: string, s: SlotState) {
		const pane = await this.o.tmux(["capture-pane", "-p", "-t", this.target(name)]);
		const stuck = pane.ok && PERMISSION_PROMPTS.some((p) => pane.stdout.includes(p));
		if (!stuck) {
			s.stuckTicks = 0;
			s.stuckNotified = false;
			return;
		}
		s.stuckTicks += 1;
		// 一瞬の確認は人がその場で答えていることが多いので、2回続けて見えたら知らせる
		if (s.stuckTicks >= 2 && !s.stuckNotified) {
			s.stuckNotified = true;
			this.o.notify(
				name,
				`⏸ 許可の確認で止まっています。\`tmux attach -t ${this.target(name).split(":")[0]}\` で \`${windowName(name)}\` を開いて答えてください。`,
			);
		}
	}

	private async spawn(t: SessionTarget, sessionExists: boolean) {
		const s = this.st(t.name);
		const session = this.sessionOf(t);
		// -t は「セッション名:」にする。「dle」だけだと tmux が窓名の前方一致で dle-concierge を指し、
		// その番号に作ろうとして「index 0 in use」で失敗するため
		const args = sessionExists
			? ["new-window", "-d", "-t", `${session}:`, "-n", windowName(t.name), "-c", t.cwd, t.command]
			: ["new-session", "-d", "-s", session, "-n", windowName(t.name), "-c", t.cwd, t.command];
		const r = await this.o.tmux(args);
		s.restarts.push(this.o.now());
		if (!r.ok) {
			this.o.log(`supervisor: ${t.name} の起動に失敗しました: ${(r.stderr ?? "").trim().slice(0, 300)}`);
			return;
		}
		s.spawnedAt = this.o.now();
		s.waitingNotified = false;
		s.devPromptAnswered = false;
		s.needsPrompt = Boolean(t.initialPrompt);
		this.o.log(`supervisor: ${t.name} を起動しました（tmux ${session}:${windowName(t.name)}）`);
	}

	/** channel が繋がったときに呼ぶ。engine が起動したセッションなら最初のプロンプトを入れる。 */
	async onRegistered(name: string) {
		const t = this.o.targets().find((x) => x.name === name);
		if (!t) return;
		const s = this.st(name);
		if (!s.needsPrompt || !t.initialPrompt) {
			// engine 再起動後に生きている worker が戻った場合。/clear 後の再接続は maybeRefresh が自前で入れるので除く。
			// 即 wakeTick はしない（再接続の直後は入力欄が落ち着いていないことがあるため、次の 30 秒 tick に任せる）
			if (!s.needsPrompt && !s.refreshing) this.requestWake(name, "reconnect");
			return;
		}
		s.needsPrompt = false;
		// 初期プロンプトが issue-loop そのものなので、溜まっている起こしは不要。待っている間に走る wakeTick を止めるため先に立てる
		s.promptPending = true;
		s.wake.reasons = [];
		s.wake.since = null;
		s.wake.enterOnly = false;
		try {
			await new Promise((r) => setTimeout(r, this.o.promptDelayMs));
			await this.o.tmux(["send-keys", "-t", this.target(name), "-l", t.initialPrompt]);
			await this.o.tmux(["send-keys", "-t", this.target(name), "Enter"]);
			this.o.log(`supervisor: ${name} に「${t.initialPrompt}」を入力しました`);
		} finally {
			s.promptPending = false;
		}
	}

	/** 起こしの要求を積む（wake が付いていない target は無視）。送るのは maybeWake の判定が通ったときだけ。 */
	requestWake(name: string, reason: string) {
		if (!this.o.targets().some((x) => x.name === name && x.wake && !x.startupError)) return;
		const w = this.st(name).wake;
		if (!w.reasons.includes(reason)) w.reasons.push(reason);
		if (w.reasons.length > WAKE_MAX_REASONS) w.reasons.splice(0, w.reasons.length - WAKE_MAX_REASONS);
		w.since ??= this.o.now();
	}

	/**
	 * 起こし専用の入口。spawn・checkStuck を通さないのは、初回 tick（15 秒遅延）より前に呼ばれても
	 * 再接続前の worker を二重起動しないため。通常 tick の最中は何もしない（tick も maybeWake を呼ぶ）。
	 */
	async wakeTick() {
		if (this.ticking || this.waking) return;
		this.waking = true;
		try {
			const targets = this.o.targets().filter((t) => t.wake && !t.startupError);
			const bySession = new Map<string, string[] | null>();
			for (const session of new Set(targets.map((t) => this.sessionOf(t))))
				bySession.set(session, await this.windows(session));
			for (const t of targets) {
				const exists = bySession.get(this.sessionOf(t))?.includes(windowName(t.name)) ?? false;
				await this.maybeWake(t, exists);
			}
		} finally {
			this.waking = false;
		}
	}

	private async capture(name: string): Promise<string | null> {
		const r = await this.o.tmux(["capture-pane", "-p", "-t", this.target(name)]);
		return r.ok ? r.stdout : null;
	}

	/** 画面だけで見られる条件（作業中・確認画面・入力欄）。送信直前の再確認でも使う */
	private screenOk(pane: string | null, typed: string | undefined): boolean {
		return (
			pane !== null &&
			!pane.includes(WORKING_MARK) &&
			![...PERMISSION_PROMPTS, DEV_CHANNEL_PROMPT].some((p) => pane.includes(p)) &&
			(typed === undefined ? emptyPrompt(pane) : inputText(pane) === typed)
		);
	}

	/** pending があり idle と確認できたときだけ WAKE_PROMPT を入力欄に送る。曖昧なら送らず次の機会へ。 */
	private async maybeWake(t: SessionTarget, exists: boolean) {
		if (!t.wake) return;
		const s = this.st(t.name);
		const w = s.wake;
		// 最初の await より前に同期的に check-and-set する（判定中の await で別の maybeWake が割り込んでも二重に送らない）
		if (w.sending || (w.reasons.length === 0 && !w.enterOnly)) return;
		// 上限中は limit の起こし以外では送らない（他の理由が再試行の回数を食わず、あきらめ後は何も送らない）。理由は積んだまま。
		// 同期の早期 return で、sending を立てる前なので finally の解放には影響しない
		if (this.o.limit.wakeMaxAttempts > 0 && s.limited && !w.enterOnly && !w.reasons.includes(LIMIT_REASON)) return;
		w.sending = true;
		try {
			const now = this.o.now();
			// 最小間隔は成功した送信どうしだけに効かせる。失敗は lastSentAt を更新しないので再試行を止めない
			if (!w.enterOnly && w.lastSentAt !== null && now - w.lastSentAt < this.o.wakeMinIntervalMs) return;
			const blocked = () => !exists || !this.o.isLive(t.name) || s.refreshing || s.needsPrompt || s.promptPending;
			if (blocked()) return;
			const typed = w.enterOnly ? WAKE_PROMPT : undefined;
			const first = await this.capture(t.name);
			await this.o.wait(this.o.wakeProbeMs);
			const second = await this.capture(t.name);
			// Enter の再送で、入力欄が WAKE_PROMPT 以外なら人の入力とみなして諦める（送らない）
			if (w.enterOnly && second !== null && inputText(second) !== WAKE_PROMPT) {
				w.enterOnly = false;
				return;
			}
			const current = await this.session(t.name);
			const transcript = current ? await this.o.readTranscript(current.session) : null;
			const verdict = wakeReadiness({
				panes: first !== null && second !== null ? [first, second] : null,
				session: current?.session ?? null,
				cwd: t.cwd,
				transcript,
				now: this.o.now(),
				quietMs: this.o.wakeQuietMs,
				typed,
			});
			if (verdict.why.startsWith("unknown")) {
				if (!w.unknownNotified) {
					w.unknownNotified = true;
					this.o.onWakeSkipped(t.name, "待機を判定できないため起こしを見送り中");
				}
			} else w.unknownNotified = false;
			if (!verdict.ready) return;
			// 判定と送信の間に人が入力・作業開始、または初期プロンプト・/clear が始まった場合に備えて撮り直す
			const last = await this.capture(t.name);
			if (!this.screenOk(last, typed)) return;
			if (blocked() || (w.reasons.length === 0 && !w.enterOnly)) return;
			if (!w.enterOnly) {
				const typedOk = await this.o.tmux(["send-keys", "-t", this.target(t.name), "-l", WAKE_PROMPT]);
				if (!typedOk.ok) return;
			}
			const enter = await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
			if (!enter.ok) {
				// 入力欄にコマンドが残っている。次は -l を送らず Enter だけ再送する
				w.enterOnly = true;
				return;
			}
			w.reasons = [];
			w.since = null;
			w.enterOnly = false;
			w.lastSentAt = this.o.now();
			if (this.o.limit.wakeMaxAttempts > 0 && s.limited) {
				// 実際に上限中の worker に入力した1回。次の待ちは倍
				s.limitAttempts += 1;
				s.limitLastWakeAt = w.lastSentAt;
				s.limitNextAt = w.lastSentAt + this.limitIntervalMs(s.limitAttempts);
			}
			this.o.log(`supervisor: ${t.name} を起こしました`);
			await this.verifyWake(t);
		} finally {
			w.sending = false;
		}
	}

	/** 送信後、入力欄に残ったままなら Enter を 1 回だけ足す。それでも残れば人が見るべき状態として journal に残す */
	private async verifyWake(t: SessionTarget) {
		const stuck = (pane: string | null) =>
			pane !== null && !pane.includes(WORKING_MARK) && inputText(pane) === WAKE_PROMPT;
		await this.o.wait(this.o.wakeVerifyMs);
		if (!stuck(await this.capture(t.name))) return;
		await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
		await this.o.wait(this.o.wakeVerifyMs);
		if (stuck(await this.capture(t.name)))
			this.o.onWakeSkipped(t.name, "起こしのコマンドが入力欄に残っています（確認してください）");
	}

	private async session(name: string): Promise<{ pid: string; session: ClaudeSession } | null> {
		const r = await this.o.tmux(["display-message", "-p", "-t", this.target(name), "#{pane_pid}"]);
		if (!r.ok || !/^\d+$/.test(r.stdout.trim())) return null;
		const pid = r.stdout.trim();
		const session = await this.o.readSession(pid);
		return session ? { pid, session } : null;
	}

	private async codexBusy(r: RefreshTarget, s: SlotState): Promise<boolean> {
		const result = await this.o.tmux(["list-panes", "-a", "-F", "#{window_name}\t#{pane_current_path}\t#{window_id}"]);
		if (!result.ok) return true;
		const seen = new Set<string>();
		let busy = false;
		for (const line of result.stdout.split("\n").filter(Boolean)) {
			const [name, cwd, id] = line.split("\t");
			if (!name || !cwd || !id) return true;
			if (
				!/^codex-(spec|impl)-/.test(name) ||
				!(withinDirectory(r.cwd, cwd) || (r.worktreeRoot && withinDirectory(r.worktreeRoot, cwd)))
			)
				continue;
			const key = `${id}:${cwd}`;
			seen.add(key);
			const since = s.codexSince.get(key) ?? this.o.now();
			s.codexSince.set(key, since);
			if (this.o.now() - since < r.codexIgnoreAfterMinutes * 60000) busy = true;
		}
		for (const key of s.codexSince.keys()) if (!seen.has(key)) s.codexSince.delete(key);
		return busy;
	}

	private async confirmClear(
		name: string,
		pid: string,
		oldSession: string,
		before: string,
	): Promise<ClaudeSession | null> {
		// 時刻注入が固定でも必ず上限内で終わるよう、試行回数でポーリングする。
		const attempts = Math.ceil(this.o.clearConfirmMs / 1000);
		for (let i = 0; i <= attempts; i++) {
			if (i > 0) await this.o.wait(Math.min(1000, this.o.clearConfirmMs - (i - 1) * 1000));
			const session = await this.o.readSession(pid);
			if (session && session.sessionId !== oldSession) return session;
			if (!session) {
				const pane = await this.o.tmux(["capture-pane", "-p", "-t", this.target(name)]);
				// 同じ空プロンプトを再観測しただけでは、会話が消えた証拠にしない。
				if (
					pane.ok &&
					pane.stdout !== before &&
					emptyPrompt(pane.stdout) &&
					pane.stdout.split("\n").every((line) => !line.trim() || /^\s*❯\s*$/.test(line))
				)
					return { sessionId: "", cwd: "", status: "idle", updatedAt: this.o.now() };
			}
		}
		return null;
	}

	private contextUnknown(t: SessionTarget, s: SlotState, sessionId: string) {
		if (s.transitionSession !== null || s.unknownSession === sessionId) return;
		s.unknownSession = sessionId;
		this.o.onRefreshSkipped(t.name, "文脈量が読めないため自動の整理を見送り中");
	}

	/** cron の空振りを避けるため、engine が待機と clear の成功を確認してから再開する。 */
	private async maybeRefresh(t: SessionTarget) {
		const r = t.refresh;
		if (!r) return;
		const s = this.st(t.name);
		const now = this.o.now();
		const idleMs = r.idleSeconds * 1000;
		if (
			s.refreshing ||
			s.wake.sending ||
			// 上限中に /clear すると上限の行が画面から消え、解除と誤認して通知が増える。上限中は整理しても進まない
			(this.o.limit.wakeMaxAttempts > 0 && s.limited) ||
			now - this.startedAt < idleMs ||
			(s.lastRefreshAt !== null && now - s.lastRefreshAt < r.cooldownMinutes * 60000)
		)
			return;
		const a = this.o.activity(t.name);
		if (now - a.lastAt < idleMs) return;
		const pane = await this.o.tmux(["capture-pane", "-p", "-t", this.target(t.name)]);
		if (
			!pane.ok ||
			pane.stdout.includes(WORKING_MARK) ||
			PERMISSION_PROMPTS.some((p) => pane.stdout.includes(p)) ||
			!emptyPrompt(pane.stdout)
		)
			return;
		const current = await this.session(t.name);
		if (!current) {
			this.contextUnknown(t, s, "unreadable");
			return;
		}
		if (current.session.status !== "idle" || path.resolve(current.session.cwd) !== path.resolve(r.cwd)) return;
		const transcript = await this.o.readTranscript(current.session);
		if (!transcript) {
			this.contextUnknown(t, s, current.session.sessionId);
			return;
		}
		if (now - transcript.mtimeMs < idleMs || now - transcript.subagentMtimeMs < idleMs) return;
		if (r.waitForCodex && (await this.codexBusy(r, s))) return;
		if (s.transitionSession !== null) {
			if (s.transitionSession === "") s.transitionSession = current.session.sessionId;
			if (s.transitionSession === current.session.sessionId && transcript?.tokens == null) return;
			s.transitionSession = null;
		}
		const screen = screenContext(pane.stdout);
		const tokens = transcript?.tokens ?? screen.tokens;
		let reason: string | null = null;
		if (r.maxTokens > 0 && tokens !== null && tokens >= r.maxTokens)
			reason = `文脈 ${tokens / 1000}k（閾値 ${r.maxTokens / 1000}k）`;
		if (r.maxTokens > 0 && tokens === null && screen.left !== null && screen.left <= r.contextPercent)
			reason = `残り ${screen.left}%`;
		if (!reason && r.maxEvents > 0 && a.events >= r.maxEvents) reason = `${a.events} 件のやり取り`;
		if (!reason && r.maxTokens > 0 && tokens === null && screen.left === null) {
			this.contextUnknown(t, s, current.session.sessionId);
		} else s.unknownSession = null;
		if (!reason) return;
		// ファイルや tmux を読む間に入力が届いていたら、古い待機判定では clear しない。
		if (this.o.now() - this.o.activity(t.name).lastAt < idleMs) return;
		// 上の await の間に wakeTick が送信を始めていたら見送る。ここから refreshing を立てるまでは同期（check-and-set）。
		if (s.wake.sending) return;
		s.refreshing = true;
		let result: RefreshResult = { success: false, reason: "clear の成功を確認できませんでした" };
		this.o.onRefresh(t.name, "start");
		try {
			const clear = await this.o.tmux(["send-keys", "-t", this.target(t.name), "-l", "/clear"]);
			if (!clear.ok) throw new Error("/clear を入力できませんでした");
			const enter = await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
			if (!enter.ok) throw new Error("/clear を送信できませんでした");
			const next = await this.confirmClear(t.name, current.pid, current.session.sessionId, pane.stdout);
			if (!next) return;
			s.transitionSession = next.sessionId;
			s.unknownSession = null;
			await this.o.wait(this.o.promptDelayMs);
			const prompt = await this.o.tmux(["send-keys", "-t", this.target(t.name), "-l", r.prompt]);
			if (!prompt.ok) throw new Error("再開プロンプトを入力できませんでした");
			const resumed = await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
			if (!resumed.ok) throw new Error("再開プロンプトを送信できませんでした");
			result = { success: true, reason };
		} catch (error) {
			result = { success: false, reason: error instanceof Error ? error.message : String(error) };
		} finally {
			s.lastRefreshAt = this.o.now();
			s.refreshing = false;
			this.o.log(`supervisor: ${t.name} のコンテキスト整理${result.success ? "完了" : "失敗"}（${result.reason}）`);
			this.o.onRefresh(t.name, "done", result);
		}
	}

	/** 自動起動を止めたセッションを再開させる */
	reset(name: string) {
		this.state.delete(name);
	}

	/**
	 * ウィンドウを閉じて、次の巡回で起動し直させる。session には閉じる側（変更前）のセッションを渡す。
	 * 今の targets から求めないのは、モードの切り替えで起動先のセッションが変わった直後にも
	 * 古いウィンドウを閉じられるようにするため（残すと同じプロジェクトの worker が2つ動く）。
	 */
	async restart(name: string, session?: string) {
		const t = this.o.targets().find((x) => x.name === name);
		const s = session ?? (t ? this.sessionOf(t) : this.o.tmuxSession);
		await this.o.tmux(["kill-window", "-t", `${s}:${windowName(name)}`]);
		this.reset(name);
	}
}
