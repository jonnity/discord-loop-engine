// 窓口と各 worker の Claude Code セッションを tmux のウィンドウで起動し続ける。
// tmux を使うのは、セッションを engine から切り離して動かし続けつつ、人間が
// `tmux attach -t dle` でいつでも同じ画面を覗いて手で操作できるようにするため。

import { execFile } from "node:child_process";
import path from "node:path";
import { type ClaudeSession, contextReader, type TranscriptContext } from "./context.ts";

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
// 旧版向けの表記も残す。画面だけで待機を決めず、内部ファイルの idle と併用する。
const CONTEXT_LEFT = [/Context left until auto-compact: (\d+)%/i, /(\d+)% context left/i, /(\d+)% until auto-compact/i];

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
}

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
}

export class Supervisor {
	private o: Required<SupervisorOptions>;
	private state = new Map<string, SlotState>();
	private startedAt: number;
	private startupErrors = new Map<string, string>();
	private ticking = false;

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
			activity: () => ({ events: 0, lastAt: 0 }),
			onRefresh: () => {},
			...opts,
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
			if (this.o.isLive(t.name)) {
				s.waitingNotified = false;
				if (exists) {
					await this.checkStuck(t.name, s);
					await this.maybeRefresh(t);
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
		const s = this.state.get(name);
		if (!t || !s?.needsPrompt || !t.initialPrompt) return;
		s.needsPrompt = false;
		await new Promise((r) => setTimeout(r, this.o.promptDelayMs));
		await this.o.tmux(["send-keys", "-t", this.target(name), "-l", t.initialPrompt]);
		await this.o.tmux(["send-keys", "-t", this.target(name), "Enter"]);
		this.o.log(`supervisor: ${name} に「${t.initialPrompt}」を入力しました`);
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
