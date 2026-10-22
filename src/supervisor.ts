// 窓口と各 worker の Claude Code セッションを tmux のウィンドウで起動し続ける。
// tmux を使うのは、セッションを engine から切り離して動かし続けつつ、人間が
// `tmux attach -t dle` でいつでも同じ画面を覗いて手で操作できるようにするため。

import { execFile } from "node:child_process";

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
// コンテキストの残りの表示（Claude Code が残り少なくなると出す。表記の揺れに備えて2通り）
const CONTEXT_LEFT = [/Context left until auto-compact: (\d+)%/i, /(\d+)% context left/i];
// 最後のやり取りからこれだけ経つまでは /clear しない（会話の途中で記憶を消さないため）
const REFRESH_IDLE_MS = 3 * 60_000;

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
	name: string; // "concierge" または プロジェクト名
	cwd: string;
	command: string; // シェルで実行する1行
	initialPrompt: string;
	/**
	 * コンテキストが溜まったら、手が空いているときに /clear して prompt で始め直す（窓口用）。
	 * maxEvents 件のやり取りか、コンテキストの残りが contextPercent% 以下になったら行う。
	 */
	refresh?: { prompt: string; maxEvents: number; contextPercent: number };
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
	onRefresh?: (name: string, phase: "start" | "done") => void;
	log?: (msg: string) => void;
	now?: () => number;
	promptDelayMs?: number;
}

export class Supervisor {
	private o: Required<SupervisorOptions>;
	private state = new Map<string, SlotState>();

	constructor(opts: SupervisorOptions) {
		// channel の接続直後は入力欄がまだ準備できていないことがあるため、少し待ってから入力する
		this.o = {
			log: () => {},
			now: Date.now,
			promptDelayMs: 5000,
			activity: () => ({ events: 0, lastAt: 0 }),
			onRefresh: () => {},
			...opts,
		};
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
		const targets = this.o.targets();
		const bySession = new Map<string, string[] | null>();
		for (const session of new Set(targets.map((t) => this.sessionOf(t))))
			bySession.set(session, await this.windows(session));
		for (const t of targets) {
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

	/**
	 * 窓口のコンテキストが溜まっていて、手が空いていれば /clear して始め直す。
	 * 窓口が自分で /clear を予約する形（oogiri-doc の parallel-cycle-loop の one-shot 連鎖）を採らないのは、
	 * 予約が空振りすると気づけないため。ペインを持っている engine が入力するほうが確実。
	 */
	private async maybeRefresh(t: SessionTarget) {
		const r = t.refresh;
		if (!r || r.maxEvents <= 0) return;
		const a = this.o.activity(t.name);
		if (a.events === 0 || this.o.now() - a.lastAt < REFRESH_IDLE_MS) return;
		const pane = await this.o.tmux(["capture-pane", "-p", "-t", this.target(t.name)]);
		if (!pane.ok || pane.stdout.includes(WORKING_MARK) || PERMISSION_PROMPTS.some((p) => pane.stdout.includes(p)))
			return;
		const left = CONTEXT_LEFT.map((re) => re.exec(pane.stdout)).find(Boolean);
		const low = left ? Number(left[1]) <= r.contextPercent : false;
		if (!low && a.events < r.maxEvents) return;
		this.o.onRefresh(t.name, "start");
		try {
			await this.o.tmux(["send-keys", "-t", this.target(t.name), "-l", "/clear"]);
			await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
			await new Promise((res) => setTimeout(res, this.o.promptDelayMs));
			await this.o.tmux(["send-keys", "-t", this.target(t.name), "-l", r.prompt]);
			await this.o.tmux(["send-keys", "-t", this.target(t.name), "Enter"]);
			this.o.log(
				`supervisor: ${t.name} のコンテキストを整理しました（${low ? `残り ${left?.[1]}%` : `${a.events} 件のやり取り`}）`,
			);
		} finally {
			this.o.onRefresh(t.name, "done");
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
