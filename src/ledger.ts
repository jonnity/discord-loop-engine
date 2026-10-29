// タスク台帳。engine だけが書く（窓口・worker・CLI は engine に頼んで書く）ので、同時書き込みで壊れない。
// 人が開いて読めるよう、タスクは1件1ファイルの Markdown（先頭に key: value）、記録は JSONL にしている。
//
// <home>/
//   projects.json           登録したリポジトリ
//   state.json              採番・ボードのメッセージ ID・振り返りの進み具合
//   tasks/T-0001.md         1タスク1ファイル
//   attention.json / .md    あなた待ち（A-番号）
//   outbox/<project>.jsonl  worker がいない間に届いた指示（起動したら渡す）
//   board.md                ボードの元
//   journal/YYYY-MM-DD.md   起きたことの時系列
//   learnings/failures.jsonl / rules.md   自己改善

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TaskStatus = "inbox" | "queued" | "ai-working" | "waiting-human" | "blocked" | "done";
export const TASK_STATUSES: TaskStatus[] = ["inbox", "queued", "ai-working", "waiting-human", "blocked", "done"];

export interface Task {
	id: string;
	project: string;
	issue: string;
	pr: string;
	title: string;
	status: TaskStatus;
	phase: string;
	waiting: string;
	created: string;
	updated: string;
	next: string;
	history: string[];
}

export type AttentionKind = "interview" | "merge" | "blocked" | "setup" | "permission" | "session";

export interface Attention {
	id: string;
	taskId: string;
	project: string;
	issue: string;
	pr: string;
	kind: AttentionKind;
	title: string;
	url: string;
	summary: string;
	status: "open" | "resolved";
	createdAt: string;
	resolvedAt?: string;
	answer?: string;
	messageId?: string;
}

export interface AddedAttention {
	attention: Attention;
	resolved: Attention[];
}

/**
 * harness: discord-loop-engine の issue-loop で進める（設定はリポジトリか engine 側の harness.json）
 * native:  リポジトリ独自のループ（oogiri-doc の /parallel-cycle-loop など）で進める。ハーネスの設定もガードも使わない
 */
export type LoopMode = "harness" | "native";

export interface Project {
	name: string;
	repo: string;
	path: string;
	active: boolean;
	addedAt: string;
	mode: LoopMode;
	/** native のとき worker に最初に入力するコマンド（例: /parallel-cycle-loop） */
	initialPrompt?: string;
	/** native のとき、そのリポジトリのスクリプトが前提にしている tmux セッション名（例: dev） */
	tmuxSession?: string;
	/** worker を起動するときに追加で許可するもの（--allowedTools の形式） */
	allow?: string[];
	/**
	 * 独自のループがあっても harness で進めると人が決めているとき（dle add --harness / dle mode harness）。
	 * 調査では native を提案せず、独自のループから固有の手順を hooks に写す。設定が確定したら消す
	 */
	harnessOnly?: boolean;
}

export interface ProfileDraft {
	mode: LoopMode;
	profile?: Record<string, unknown>;
	initialPrompt?: string;
	tmuxSession?: string;
	summary: string;
	attention?: string;
	proposedAt: string;
}

export interface Learning {
	ts: string;
	project: string;
	issue: string;
	tag: string;
	summary: string;
	detail: string;
	promoted: boolean;
}

interface State {
	taskSeq: number;
	attentionSeq: number;
	boardMessageId: string | null;
	boardChannelId: string | null;
	doneSinceRetro: number;
	lastRetroAt: string;
	retroRequestedAt: string | null;
	/** プロジェクトごとに、通知済み（または起動時に既にあった）CI の run ID */
	ciSeen: Record<string, number[]>;
	defaultBranches: Record<string, string>;
}

export const KIND_LABEL: Record<AttentionKind, string> = {
	interview: "要件確認",
	merge: "マージ承認",
	blocked: "要対応",
	setup: "設定の確認",
	permission: "許可の確認",
	session: "セッションの確認",
};

function writeAtomic(file: string, content: string) {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, content);
	// 途中で落ちても、元のファイルか新しいファイルのどちらかが必ず残る
	renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export class Ledger {
	readonly dir: string;
	readonly now: () => Date;

	constructor(dir: string, now: () => Date = () => new Date()) {
		this.dir = dir;
		this.now = now;
		for (const d of ["tasks", "journal", "learnings", "outbox"]) mkdirSync(path.join(dir, d), { recursive: true });
	}

	private iso() {
		return this.now().toISOString();
	}

	private stamp() {
		const d = this.now();
		return `${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
	}

	// --- state -------------------------------------------------------------------
	state(): State {
		return {
			taskSeq: 0,
			attentionSeq: 0,
			boardMessageId: null,
			boardChannelId: null,
			doneSinceRetro: 0,
			lastRetroAt: this.iso(),
			retroRequestedAt: null,
			ciSeen: {},
			defaultBranches: {},
			...readJson<Partial<State>>(path.join(this.dir, "state.json"), {}),
		};
	}

	saveState(patch: Partial<State>) {
		writeAtomic(path.join(this.dir, "state.json"), `${JSON.stringify({ ...this.state(), ...patch }, null, 2)}\n`);
	}

	// --- projects ----------------------------------------------------------------
	projects(): Project[] {
		// mode が無いのは 0.1.0 の形式。その頃はすべて harness だった
		return readJson<Project[]>(path.join(this.dir, "projects.json"), []).map((p) => ({
			...p,
			mode: p.mode ?? "harness",
		}));
	}

	// --- プロジェクトの設定（engine 側の harness.json） ----------------------------------
	profilePath(name: string): string {
		return path.join(this.dir, "projects", name, "harness.json");
	}

	/** 実際に使われる harness.json（リポジトリにあればそちらを優先）。無ければ null */
	effectiveProfilePath(p: Project): string | null {
		const inRepo = path.join(p.path, ".claude", "harness.json");
		if (existsSync(inRepo)) return inRepo;
		const own = this.profilePath(p.name);
		return existsSync(own) ? own : null;
	}

	profile(p: Project): Record<string, unknown> | null {
		const f = this.effectiveProfilePath(p);
		return f ? readJson<Record<string, unknown> | null>(f, null) : null;
	}

	/** 調査が終わって使える状態か（native は設定ファイル不要） */
	isReady(p: Project): boolean {
		return p.mode === "native" || this.effectiveProfilePath(p) !== null;
	}

	saveDraft(name: string, draft: ProfileDraft) {
		writeAtomic(path.join(this.dir, "projects", name, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
	}

	draft(name: string): ProfileDraft | null {
		return readJson<ProfileDraft | null>(path.join(this.dir, "projects", name, "draft.json"), null);
	}

	/** 確認済みの案を本番の設定にする */
	activateDraft(name: string): Project {
		const d = this.draft(name);
		const p = this.projects().find((x) => x.name === name);
		if (!d || !p) throw new Error(`${name} の設定案がありません`);
		if (d.mode === "harness") {
			if (!d.profile) throw new Error("harness モードの案に profile がありません");
			writeAtomic(
				this.profilePath(name),
				`${JSON.stringify({ project: name, repo: p.repo, ...d.profile }, null, "\t")}\n`,
			);
		}
		const next = this.upsertProject({
			...p,
			mode: d.mode,
			initialPrompt: d.mode === "native" ? d.initialPrompt : undefined,
			tmuxSession: d.mode === "native" ? d.tmuxSession : undefined,
			harnessOnly: undefined,
		});
		writeAtomic(path.join(this.dir, "projects", name, "draft.json"), "null\n");
		this.journal(`[${name}] 設定を確定（${d.mode}）`);
		return next;
	}

	upsertProject(p: Omit<Project, "addedAt"> & { addedAt?: string }): Project {
		const list = this.projects().filter((x) => x.name !== p.name);
		const prev = this.projects().find((x) => x.name === p.name);
		const next: Project = { ...p, addedAt: prev?.addedAt ?? p.addedAt ?? this.iso() };
		list.push(next);
		writeAtomic(path.join(this.dir, "projects.json"), `${JSON.stringify(list, null, 2)}\n`);
		return next;
	}

	// --- tasks -------------------------------------------------------------------
	private taskFile(id: string) {
		return path.join(this.dir, "tasks", `${id}.md`);
	}

	static renderTask(t: Task): string {
		const head = ["id", "project", "issue", "pr", "title", "status", "phase", "waiting", "created", "updated"] as const;
		const fm = head.map((k) => `${k}: ${String(t[k] ?? "").replace(/\n/g, " ")}`).join("\n");
		return `---\n${fm}\n---\n## 次にやること\n${t.next || "-"}\n\n## 経緯\n${t.history.map((h) => `- ${h}`).join("\n")}\n`;
	}

	static parseTask(text: string): Task | null {
		const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
		if (!m) return null;
		const fields: Record<string, string> = {};
		for (const line of (m[1] as string).split("\n")) {
			const i = line.indexOf(":");
			if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		const body = m[2] as string;
		const next = /## 次にやること\n([\s\S]*?)\n\n## 経緯/.exec(body)?.[1]?.trim() ?? "";
		const history = (/## 経緯\n([\s\S]*)$/.exec(body)?.[1] ?? "")
			.split("\n")
			.filter((l) => l.startsWith("- "))
			.map((l) => l.slice(2));
		return {
			id: fields.id ?? "",
			project: fields.project ?? "",
			issue: fields.issue ?? "",
			pr: fields.pr ?? "",
			title: fields.title ?? "",
			status: (TASK_STATUSES as string[]).includes(fields.status ?? "") ? (fields.status as TaskStatus) : "inbox",
			phase: fields.phase ?? "",
			waiting: fields.waiting ?? "",
			created: fields.created ?? "",
			updated: fields.updated ?? "",
			next: next === "-" ? "" : next,
			history,
		};
	}

	tasks(): Task[] {
		const dir = path.join(this.dir, "tasks");
		return readdirSync(dir)
			.filter((f) => /^T-\d+\.md$/.test(f))
			.sort()
			.map((f) => Ledger.parseTask(readFileSync(path.join(dir, f), "utf8")))
			.filter((t): t is Task => t !== null);
	}

	task(id: string): Task | null {
		const f = this.taskFile(id);
		return existsSync(f) ? Ledger.parseTask(readFileSync(f, "utf8")) : null;
	}

	findTaskByIssue(project: string, issue: string): Task | null {
		return this.tasks().find((t) => t.project === project && t.issue === issue && t.status !== "done") ?? null;
	}

	createTask(input: {
		project: string;
		title: string;
		issue?: string;
		status?: TaskStatus;
		next?: string;
		note?: string;
	}) {
		const seq = this.state().taskSeq + 1;
		this.saveState({ taskSeq: seq });
		const t: Task = {
			id: `T-${pad(seq, 4)}`,
			project: input.project,
			issue: input.issue ?? "",
			pr: "",
			title: input.title,
			status: input.status ?? (input.issue ? "queued" : "inbox"),
			phase: "",
			waiting: "",
			created: this.iso(),
			updated: this.iso(),
			next: input.next ?? "",
			history: [`${this.stamp()} ${input.note ?? "受け付け"}`],
		};
		writeAtomic(this.taskFile(t.id), Ledger.renderTask(t));
		this.journal(`${t.id} [${t.project}] 作成: ${t.title}${t.issue ? ` (#${t.issue})` : ""}`);
		return t;
	}

	updateTask(id: string, patch: Partial<Omit<Task, "id" | "history" | "created">>, note?: string): Task {
		const t = this.task(id);
		if (!t) throw new Error(`タスク ${id} がありません`);
		const next: Task = { ...t, ...patch, updated: this.iso() };
		if (note) next.history = [...t.history, `${this.stamp()} ${note}`];
		writeAtomic(this.taskFile(id), Ledger.renderTask(next));
		if (note) this.journal(`${id} [${next.project}] ${note}`);
		return next;
	}

	/** issue に対応するタスクを探し、無ければ作る（worker がキューから拾った Issue など） */
	ensureTaskForIssue(project: string, issue: string, title: string): Task {
		return (
			this.findTaskByIssue(project, issue) ??
			this.createTask({ project, issue, title, status: "queued", note: `#${issue} を台帳に追加` })
		);
	}

	// --- attention -----------------------------------------------------------------
	attention(): Attention[] {
		return readJson<Attention[]>(path.join(this.dir, "attention.json"), []);
	}

	private saveAttention(list: Attention[]) {
		writeAtomic(path.join(this.dir, "attention.json"), `${JSON.stringify(list, null, 2)}\n`);
		const open = list.filter((a) => a.status === "open");
		const md = open.length
			? open
					.map(
						(a) =>
							`- **${a.id}** [${a.project}] ${KIND_LABEL[a.kind]}${a.issue ? ` #${a.issue}` : a.pr ? ` PR #${a.pr}` : ""} ${a.title} — ${a.url}`,
					)
					.join("\n")
			: "（なし）";
		writeAtomic(path.join(this.dir, "attention.md"), `# あなた待ち\n\n${md}\n`);
	}

	openAttention(): Attention[] {
		return this.attention().filter((a) => a.status === "open");
	}

	/** attention=新しい依頼、resolved=それに置き換えられて閉じた古い依頼（engine が印を付けるため） */
	addAttention(input: Omit<Attention, "id" | "status" | "createdAt">): AddedAttention {
		const list = this.attention();
		const resolved: Attention[] = [];
		// 同じタスクの同じ種類は1つだけ開いておく（承認依頼の出し直しは古い方を置き換える）
		for (const a of list) {
			const samePr =
				!input.issue &&
				!input.taskId &&
				input.kind === "merge" &&
				input.pr &&
				!a.issue &&
				!a.taskId &&
				a.project === input.project &&
				a.pr === input.pr;
			if (a.status === "open" && a.kind === input.kind && ((a.taskId === input.taskId && input.taskId) || samePr)) {
				a.status = "resolved";
				a.resolvedAt = this.iso();
				a.answer = "（新しい依頼に置き換え）";
				resolved.push(a);
			}
		}
		const seq = this.state().attentionSeq + 1;
		this.saveState({ attentionSeq: seq });
		const a: Attention = { ...input, id: `A-${seq}`, status: "open", createdAt: this.iso() };
		list.push(a);
		this.saveAttention(list);
		this.journal(
			`${a.id} [${a.project}] ${KIND_LABEL[a.kind]}${a.issue ? ` #${a.issue}` : a.pr ? ` PR #${a.pr}` : ""}: ${a.title}`,
		);
		return { attention: a, resolved };
	}

	setAttentionMessage(id: string, messageId: string) {
		const list = this.attention();
		const a = list.find((x) => x.id === id);
		if (a) {
			a.messageId = messageId;
			this.saveAttention(list);
		}
	}

	resolveAttention(id: string, answer: string): Attention {
		const list = this.attention();
		const a = list.find((x) => x.id.toLowerCase() === id.toLowerCase());
		if (!a) throw new Error(`${id} はありません`);
		if (a.status !== "open") throw new Error(`${a.id} は既に対応済みです（${a.answer ?? ""}）`);
		a.status = "resolved";
		a.resolvedAt = this.iso();
		a.answer = answer;
		this.saveAttention(list);
		this.journal(`${a.id} [${a.project}] 回答: ${answer}`);
		return a;
	}

	/** このタスクの開いている依頼を閉じ、今回閉じたものを返す（すでに閉じていたものは含めない） */
	resolveAttentionForTask(taskId: string, answer: string): Attention[] {
		const list = this.attention();
		const closed: Attention[] = [];
		for (const a of list) {
			if (a.status === "open" && a.taskId === taskId) {
				a.status = "resolved";
				a.resolvedAt = this.iso();
				a.answer = answer;
				closed.push(a);
			}
		}
		if (closed.length) this.saveAttention(list);
		return closed;
	}

	resolveAttentionForPr(project: string, pr: string, answer: string) {
		// Issue・setup 等の空 taskId は巻き込まない。
		for (const a of this.openAttention()) {
			if (a.project === project && a.pr === pr && a.kind === "merge" && !a.issue && !a.taskId)
				this.resolveAttention(a.id, answer);
		}
	}

	// --- outbox（worker が起動していない間の指示） -------------------------------------
	enqueue(project: string, item: { content: string; meta: Record<string, string> }) {
		appendFileSync(
			path.join(this.dir, "outbox", `${project}.jsonl`),
			`${JSON.stringify({ ...item, at: this.iso() })}\n`,
		);
	}

	drain(project: string): { content: string; meta: Record<string, string> }[] {
		const f = path.join(this.dir, "outbox", `${project}.jsonl`);
		if (!existsSync(f)) return [];
		const items = readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { content: string; meta: Record<string, string> });
		writeAtomic(f, "");
		return items;
	}

	// --- journal ---------------------------------------------------------------------
	journal(line: string) {
		const d = this.now();
		const f = path.join(
			this.dir,
			"journal",
			`${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}.md`,
		);
		appendFileSync(f, `- ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)} ${line}\n`);
	}

	// --- learnings（自己改善） ----------------------------------------------------------
	addLearning(l: Omit<Learning, "ts" | "promoted">): Learning {
		const entry: Learning = { ...l, ts: this.iso(), promoted: false };
		appendFileSync(path.join(this.dir, "learnings", "failures.jsonl"), `${JSON.stringify(entry)}\n`);
		this.journal(`学び [${l.project || "-"}] ${l.tag}: ${l.summary}`);
		return entry;
	}

	learnings(): Learning[] {
		const f = path.join(this.dir, "learnings", "failures.jsonl");
		if (!existsSync(f)) return [];
		return readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Learning);
	}

	markPromoted(indexes: number[]) {
		const all = this.learnings().map((l, i) => (indexes.includes(i) ? { ...l, promoted: true } : l));
		writeAtomic(path.join(this.dir, "learnings", "failures.jsonl"), all.map((l) => `${JSON.stringify(l)}\n`).join(""));
	}

	rules(): string {
		const f = path.join(this.dir, "learnings", "rules.md");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}

	setRules(content: string) {
		writeAtomic(path.join(this.dir, "learnings", "rules.md"), content.endsWith("\n") ? content : `${content}\n`);
		this.journal("仮ルールを更新");
	}

	// --- board -------------------------------------------------------------------------
	renderBoard(): string {
		const d = this.now();
		const tasks = this.tasks().filter((t) => t.status !== "done");
		const open = this.openAttention();
		const line = (t: Task) =>
			`  ${t.id} [${t.project}]${t.issue ? ` #${t.issue}` : ""} ${t.title}${t.phase ? `（${t.phase}）` : ""}`;
		const sections: string[] = [
			`📋 ボード（${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)} 更新）`,
		];
		sections.push("■ あなた待ち");
		sections.push(
			open.length
				? open
						.map(
							(a) =>
								`  ${a.id} [${a.project}]${a.issue ? ` #${a.issue}` : ""} ${KIND_LABEL[a.kind]}${a.pr ? ` → PR #${a.pr}` : ""}`,
						)
						.join("\n")
				: "  （なし）",
		);
		const working = tasks.filter((t) => t.status === "ai-working" || t.status === "blocked");
		sections.push("■ AI 作業中");
		sections.push(working.length ? working.map(line).join("\n") : "  （なし）");
		const queued = tasks.filter((t) => t.status === "queued" || t.status === "inbox");
		sections.push("■ 次に着手");
		sections.push(queued.length ? queued.slice(0, 8).map(line).join("\n") : "  （なし）");
		const text = sections.join("\n");
		writeAtomic(path.join(this.dir, "board.md"), `${text}\n`);
		return text;
	}
}
