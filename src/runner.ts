// dle runner — self-hosted runner（専用ユーザー dle-runner の下の GitHub Actions runner）の状態確認と、
// 起動・停止・更新のコマンド表示。
//
// 何をしないか（Why not）:
//   - 起動・停止・更新を dle から実行しない。dle は jonnity の権限で動き、dle-runner の systemd を
//     sudo なしでは操作できない。sudoers で許可すると、worker・Codex が CI を止められる経路ができるため、
//     オーナーが実行するコマンドを表示するだけにしている
//   - 登録（config.sh）・トークンの発行は扱わない（人の判断が要る操作）
//   - dle-runner の領域にあるファイルは job が書き換えられる。中身を信用せず、実行もしない。
//     画面と --json に出す値は、厳密な形に合うものだけにする（worker・Codex が出力を読むため）

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNNER_USER = "dle-runner";
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** 画面と --json に出す警告。ファイルの内容を埋め込まないよう、固定の語彙だけにする */
export type Warning =
	| "異常停止"
	| "状態不明"
	| "public"
	| "設定の改変の疑い"
	| "再起動を繰り返している疑い"
	| "基準値なし"
	| "不一致"
	| "権限不足"
	| "interop 有効"
	| "ディスク逼迫";

const RUNNER_USAGE = [
	"dle runner status [--json]",
	"dle runner start  [<名前>... | --all]",
	"dle runner stop   [<名前>... | --all] [--force]",
	"dle runner update [<名前>... | --all] [--check]",
].join("\n");

export type RunnerArgs =
	| { cmd: "status"; json: boolean }
	| { cmd: "start" | "stop" | "update"; names: string[]; force: boolean; check: boolean };

/** dle runner の引数解釈。名前は表示するコマンドに埋め込むため、書式に合うものだけ受け付ける */
export function parseRunnerArgs(args: string[]): RunnerArgs {
	const usage = (msg: string) => new Error(`${msg}\n${RUNNER_USAGE}`);
	const [sub, ...rest] = args;
	if (sub !== "status" && sub !== "start" && sub !== "stop" && sub !== "update")
		throw usage("サブコマンド（status / start / stop / update）を指定してください。");
	const names: string[] = [];
	let all = false;
	let json = false;
	let force = false;
	let check = false;
	for (const a of rest) {
		if (a === "--all") all = true;
		else if (a === "--json") json = true;
		else if (a === "--force") force = true;
		else if (a === "--check") check = true;
		else if (a.startsWith("--")) throw usage(`知らない引数です: ${sanitize(a)}`);
		else if (!NAME_RE.test(a)) throw usage(`名前の書式が違います: ${sanitize(a)}`);
		else names.push(a);
	}
	if (sub === "status") {
		if (all || force || check || names.length) throw usage("status は全件が対象です（指定できるのは --json だけ）。");
		return { cmd: "status", json };
	}
	if (json) throw usage("--json は status のときだけ使えます。");
	if (force && sub !== "stop") throw usage("--force は stop のときだけ使えます。");
	if (check && sub !== "update") throw usage("--check は update のときだけ使えます。");
	if (all && names.length) throw usage("--all と名前は同時に指定できません。");
	return { cmd: sub, names, force, check };
}

// --- 入力の検証 -----------------------------------------------------------------------------

/** 制御文字（エスケープシーケンス・改行）を除き、長さを制限する。値の検証の後の、念のための最後の防御 */
export function sanitize(s: string, max = 80): string {
	let out = "";
	for (const c of s) {
		const n = c.codePointAt(0) ?? 0;
		if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) continue;
		out += c;
		if (out.length >= max) break;
	}
	return out;
}

/** `^\d+\.\d+\.\d+$` に合うバージョンだけ返す（ログの 1 行などの自由な文字列を出さない） */
export function safeVersion(s: string | null | undefined): string | null {
	const t = (s ?? "").trim();
	return VERSION_RE.test(t) ? t : null;
}

export interface RepoRef {
	owner: string;
	repo: string;
}

/** .runner の JSON から登録先を取り出す。https://github.com/<owner>/<repo> の全体に合うものだけ（`..` を拒否） */
export function parseRunnerFile(text: string): RepoRef | null {
	let v: unknown;
	try {
		v = JSON.parse(text.replace(/^﻿/, ""));
	} catch {
		return null;
	}
	if (typeof v !== "object" || v === null) return null;
	const url = (v as Record<string, unknown>).gitHubUrl;
	if (typeof url !== "string") return null;
	const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
	if (!m) return null;
	const [, owner = "", repo = ""] = m;
	if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
	return { owner, repo };
}

export type SafeRead = { kind: "ok"; data: Buffer } | { kind: "missing" } | { kind: "denied" } | { kind: "suspicious" };

/**
 * ファイルを O_NOFOLLOW|O_NONBLOCK で開き、開いた記述子を fstat して通常ファイルとサイズを確認してから読む。
 * Why not lstat してから読む: lstat と読み取りの間に、job が通常ファイルを FIFO や jonnity のファイルを指す
 * シンボリックリンクに差し替えられる。親ディレクトリの差し替えは防げない（dle-runner の所有のため）。
 */
export function readSafeFile(p: string, maxBytes: number, hooks?: { afterOpen?: () => void }): SafeRead {
	let fd: number;
	try {
		fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
		if (code === "EACCES" || code === "EPERM") return { kind: "denied" };
		return { kind: "suspicious" }; // ELOOP（シンボリックリンク）・ENXIO など
	}
	try {
		hooks?.afterOpen?.();
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > maxBytes) return { kind: "suspicious" };
		const buf = Buffer.alloc(maxBytes + 1);
		const n = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
		if (n > maxBytes) return { kind: "suspicious" };
		return { kind: "ok", data: buf.subarray(0, n) };
	} catch {
		return { kind: "denied" };
	} finally {
		fs.closeSync(fd);
	}
}

const MAX_SMALL_FILE = 64 * 1024;

export function readSafeText(p: string, maxBytes = MAX_SMALL_FILE): SafeRead & { text?: string } {
	const r = readSafeFile(p, maxBytes);
	return r.kind === "ok" ? { ...r, text: r.data.toString("utf8") } : r;
}

/** runner のディレクトリを列挙する。書式に合う名前の、シンボリックリンクでないディレクトリだけ */
export function listRunnerDirs(root: string): { names: string[]; problem: "missing" | "denied" | null } {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return { names: [], problem: code === "EACCES" || code === "EPERM" ? "denied" : "missing" };
	}
	const names = entries
		.filter((n) => NAME_RE.test(n))
		.filter((n) => {
			try {
				return fs.lstatSync(path.join(root, n)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
	return { names, problem: null };
}

// --- プロセス --------------------------------------------------------------------------------

/**
 * `ps -eo pid,etimes,args` の出力から、その runner の Listener（常駐中）と Worker（job の実行中）を数える。
 * argv[0] が `<dir>/bin/Runner.Listener|Runner.Worker` に完全一致する行だけ。
 * Why not 部分一致: job が引数にそのパスを含むプロセスを作るだけで「走行中」に見せかけられ、stop の安全確認を誤らせる。
 */
export function findProcesses(psOut: string, dir: string): { listeners: number; workers: number } {
	let listeners = 0;
	let workers = 0;
	for (const line of psOut.split("\n")) {
		const m = /^\s*\d+\s+\d+\s+(\S+)(?:\s|$)/.exec(line);
		if (!m) continue;
		if (m[1] === `${dir}/bin/Runner.Listener`) listeners++;
		else if (m[1] === `${dir}/bin/Runner.Worker`) workers++;
	}
	return { listeners, workers };
}

export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}
export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * タイムアウト付きの外部コマンド実行。dle 共通の Run（projects.ts）はタイムアウトを持たず、
 * job が巨大なツリーを作って du を止められると status が戻らないため、ここだけ別に持つ。
 */
export const runWithTimeout: Exec = (cmd, args, timeoutMs) =>
	new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const killed = (err as { killed?: boolean } | null)?.killed === true;
				resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: killed });
			},
		);
	});

// --- バージョン・ディスク ------------------------------------------------------------------

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

/** du の KB が閾値（GB）以上か。境界は以上 */
export function diskWarning(kb: number, limitGb = 20): boolean {
	return kb >= limitGb * 1024 * 1024;
}

export function formatDisk(kb: number): string {
	const gb = kb / (1024 * 1024);
	if (gb >= 1) return `${gb.toFixed(1)}G`;
	return `${Math.max(1, Math.round(kb / 1024))}M`;
}

/** du の出力（非 0 終了でも、合計は標準出力に出る）。取れなければ null。非 0 終了は下限値 */
export function parseDu(r: ExecResult): { kb: number; lowerBound: boolean } | null {
	const m = /^\s*(\d+)\s/.exec(r.stdout);
	if (!m) return null;
	return { kb: Number(m[1]), lowerBound: !r.ok };
}

/** _diag の Runner_*.log のうち、直近の窓に作られた数。再起動の繰り返しの検知（ヒューリスティック） */
export function countRecentLogs(diagDir: string, nowMs: number, windowMs = 30 * 60 * 1000): number | null {
	let names: string[];
	try {
		names = fs.readdirSync(diagDir);
	} catch {
		return null;
	}
	let n = 0;
	for (const f of names) {
		if (!/^Runner_.*\.log$/.test(f)) continue;
		try {
			const st = fs.lstatSync(path.join(diagDir, f));
			const created = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
			if (created >= nowMs - windowMs) n++;
		} catch {}
	}
	return n;
}

// --- 改変検知 --------------------------------------------------------------------------------

/** 基準値（登録直後の sha256）の対象。自己更新で正当に変わるものが入りうる（README の取り直し手順） */
export const RUNNER_BASELINE_FILES = [
	".runner",
	".env",
	".path",
	"run.sh",
	"run-helper.sh.template",
	"env.sh",
	"config.sh",
];
export const HOME_BASELINE_FILES = [".bashrc", ".profile", ".bash_logout"];

/** `sha256sum` の出力形式（`<hex>  <パス>` と `absent  <パス>`）。キーはファイル名 */
export function parseBaseline(text: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const line of text.split("\n")) {
		const h = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
		if (h?.[1] && h[2]) m.set(path.basename(h[2]), h[1]);
		const a = /^absent\s+(.+)$/.exec(line);
		if (a?.[1]) m.set(path.basename(a[1]), "absent");
	}
	return m;
}

export type FileState = "same" | "changed" | "suspicious" | "denied";

/** ファイルの sha256 を基準値と比べる。開き方は readSafeFile と同じ（記述子から読む） */
export function compareFile(p: string, expected: string | undefined): FileState {
	return compareData(readSafeFile(p, MAX_SMALL_FILE), expected);
}

/** 読み取り済みの結果を基準値と比べる（.runner を 1 回の読み取りで、比較と解釈の両方に使うため） */
export function compareData(r: SafeRead, expected: string | undefined): FileState {
	if (expected === undefined) return "changed";
	if (r.kind === "missing") return expected === "absent" ? "same" : "changed";
	if (r.kind === "denied") return "denied";
	if (r.kind === "suspicious") return "suspicious";
	if (expected === "absent") return "changed";
	return createHash("sha256").update(r.data).digest("hex") === expected ? "same" : "changed";
}

function readBaseline(file: string): Map<string, string> | null {
	const r = readSafeText(file);
	return r.kind === "ok" && r.text !== undefined ? parseBaseline(r.text) : null;
}

/** ホームの想定外のもの（ユニットの上書き・drop-in・想定外のサービス・environment.d）と、.bashrc 等の変更 */
export function detectHomeTampering(home: string, registered: string[], baselineDir: string): Warning[] {
	const out = new Set<Warning>();
	const unitDir = path.join(home, ".config", "systemd", "user");
	try {
		for (const e of fs.readdirSync(unitDir)) {
			if (e !== "default.target.wants") {
				out.add("設定の改変の疑い");
				continue;
			}
			const wants = path.join(unitDir, e);
			if (!fs.lstatSync(wants).isDirectory()) {
				out.add("設定の改変の疑い");
				continue;
			}
			for (const w of fs.readdirSync(wants)) {
				const ok =
					registered.some((n) => w === `dle-runner@${n}.service`) && fs.lstatSync(path.join(wants, w)).isSymbolicLink();
				if (!ok) out.add("設定の改変の疑い");
			}
		}
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") out.add("権限不足");
	}
	try {
		if (fs.readdirSync(path.join(home, ".config", "environment.d")).length) out.add("設定の改変の疑い");
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") out.add("権限不足");
	}
	const base = readBaseline(path.join(baselineDir, "home.sha256"));
	if (!base) out.add("基準値なし");
	else {
		for (const f of HOME_BASELINE_FILES) {
			const s = compareFile(path.join(home, f), base.get(f));
			if (s === "denied") out.add("権限不足");
			else if (s !== "same") out.add("設定の改変の疑い");
		}
	}
	return [...out];
}

// --- GitHub 側 -------------------------------------------------------------------------------

/** `gh api .../actions/runners --jq '.runners[]|[.name,.status,.busy]|@tsv'` の出力。列挙値だけ受け付ける */
export function parseGithubRunners(out: string): Map<string, { status: "online" | "offline"; busy: boolean }> {
	const m = new Map<string, { status: "online" | "offline"; busy: boolean }>();
	for (const line of out.split("\n")) {
		const [name, status, busy] = line.split("\t");
		if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) continue;
		if ((status !== "online" && status !== "offline") || (busy !== "true" && busy !== "false")) continue;
		m.set(name, { status, busy: busy === "true" });
	}
	return m;
}

// --- 状態の組み立て -----------------------------------------------------------------------

export interface StatusDeps {
	exec: Exec;
	runnersDir: string;
	home: string;
	baselineDir: string;
	now: number;
	interopFile: string;
}

export interface RunnerStatus {
	name: string;
	repo: string | null;
	private: boolean | null;
	listener: boolean;
	workers: number;
	/** ps が失敗・タイムアウトで、Listener・Worker の有無が分からない（異常停止と誤判定しない） */
	procUnknown: boolean;
	enabled: boolean | null;
	github: { status: "online" | "offline"; busy: boolean } | null;
	version: string | null;
	diskKb: number | null;
	diskLowerBound: boolean;
	warnings: Warning[];
}

export interface StatusReport {
	runners: RunnerStatus[];
	global: Warning[];
	problem: "missing" | "denied" | null;
}

/** WSL interop（binfmt_misc の WSLInterop）が有効か。Windows の実行ファイルが Linux から起動できる状態 */
export function interopEnabled(file: string): boolean {
	try {
		return fs.readFileSync(file, "utf8").split("\n")[0]?.trim() === "enabled";
	} catch {
		return false;
	}
}

function enabledState(home: string, name: string): boolean | null {
	try {
		fs.lstatSync(path.join(home, ".config", "systemd", "user", "default.target.wants", `dle-runner@${name}.service`));
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
	}
}

/** バージョン: bin/runnerversion → _diag のログの先頭付近の行。どちらも ^\d+\.\d+\.\d+$ に合うものだけ */
function readVersion(dir: string): string | null {
	const r = readSafeText(path.join(dir, "bin", "runnerversion"), 256);
	if (r.kind === "ok") {
		const v = safeVersion(r.text);
		if (v) return v;
	}
	try {
		const logs = fs
			.readdirSync(path.join(dir, "_diag"))
			.filter((f) => /^Runner_.*\.log$/.test(f))
			.sort();
		const last = logs[logs.length - 1];
		if (!last) return null;
		const head = readHead(path.join(dir, "_diag", last), 4096);
		const line = head.split("\n").find((l) => /version/i.test(l));
		const m = line ? /\bv?(\d+\.\d+\.\d+)\b/.exec(line) : null;
		return safeVersion(m?.[1]);
	} catch {
		return null;
	}
}

function readHead(p: string, max: number): string {
	let fd: number;
	try {
		fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch {
		return "";
	}
	try {
		if (!fs.fstatSync(fd).isFile()) return "";
		const buf = Buffer.alloc(max);
		const n = fs.readSync(fd, buf, 0, max, 0);
		return buf.subarray(0, n).toString("utf8");
	} catch {
		return "";
	} finally {
		fs.closeSync(fd);
	}
}

/** 全 runner の状態を集める。読み取りだけ（sudo 不要）。実行ファイルは実行しない */
export async function buildStatus(deps: StatusDeps): Promise<StatusReport> {
	const { names, problem } = listRunnerDirs(deps.runnersDir);
	const global: Warning[] = [];
	if (problem) return { runners: [], global, problem };
	if (interopEnabled(deps.interopFile)) global.push("interop 有効");
	const ps = await deps.exec("ps", ["-eo", "pid,etimes,args"], 10_000);
	// ps が失敗・タイムアウトしたら、全 runner の Listener・Worker の有無が分からない。空の出力を「いない」と
	// みなすと、全 runner を異常停止と誤判定し、stop・update の安全確認（走行中か）も誤る
	const procUnknown = !ps.ok || ps.timedOut;
	const runners: RunnerStatus[] = [];
	for (const name of names) {
		const dir = path.join(deps.runnersDir, name);
		const w = new Set<Warning>();
		const procs = procUnknown ? { listeners: 0, workers: 0 } : findProcesses(ps.stdout, dir);
		const listener = procs.listeners > 0;
		if (procUnknown) w.add("状態不明");
		const enabled = enabledState(deps.home, name);
		// 登録情報と基準値
		const base = readBaseline(path.join(deps.baselineDir, `${name}.sha256`));
		let runnerChanged = false;
		// .runner は 1 回だけ読み、基準値との比較と登録先の解釈の両方に使う（読み取りの間の差し替えで食い違わない）
		const rf = readSafeFile(path.join(dir, ".runner"), MAX_SMALL_FILE);
		if (!base) w.add("基準値なし");
		else {
			for (const f of RUNNER_BASELINE_FILES) {
				const s = f === ".runner" ? compareData(rf, base.get(f)) : compareFile(path.join(dir, f), base.get(f));
				if (s === "denied") w.add("権限不足");
				else if (s !== "same") {
					w.add("設定の改変の疑い");
					if (f === ".runner") runnerChanged = true;
				}
			}
		}
		let ref: RepoRef | null = null;
		if (rf.kind === "ok") {
			ref = parseRunnerFile(rf.data.toString("utf8"));
			if (!ref) w.add("設定の改変の疑い");
		} else if (rf.kind === "denied") w.add("権限不足");
		else if (rf.kind === "suspicious") w.add("設定の改変の疑い");
		// .runner が基準値と違うときは、書き換えられた値を出さず、GitHub にも問い合わせない
		if (runnerChanged) ref = null;
		// 起動しているか
		if (!listener && !procUnknown) {
			if (enabled === true) w.add("異常停止");
			else if (enabled === null) w.add("状態不明");
		}
		const logs = countRecentLogs(path.join(dir, "_diag"), deps.now);
		if (logs !== null && logs >= 3) w.add("再起動を繰り返している疑い");
		// GitHub 側と private 判定
		let github: RunnerStatus["github"] = null;
		let isPrivate: boolean | null = null;
		if (ref) {
			const slug = `${ref.owner}/${ref.repo}`;
			const gr = await deps.exec(
				"gh",
				["api", `repos/${slug}/actions/runners`, "--jq", ".runners[] | [.name, .status, .busy] | @tsv"],
				15_000,
			);
			if (gr.ok) github = parseGithubRunners(gr.stdout).get(`dle-${name}`) ?? null;
			const pr = await deps.exec("gh", ["api", `repos/${slug}`, "--jq", ".private"], 15_000);
			if (pr.ok) {
				const t = pr.stdout.trim();
				isPrivate = t === "true" ? true : t === "false" ? false : null;
			}
			if (isPrivate === false) w.add("public");
			if (!procUnknown && github && github.busy !== procs.workers > 0) w.add("不一致");
		}
		// ディスク。_tool は _work/_tool なので _work だけ数える（二重に数えない）
		const du = parseDu(await deps.exec("du", ["-sk", path.join(dir, "_work")], 10_000));
		if (du && diskWarning(du.kb)) w.add("ディスク逼迫");
		runners.push({
			name,
			repo: ref ? `${ref.owner}/${ref.repo}` : null,
			private: isPrivate,
			listener,
			workers: procs.workers,
			procUnknown,
			enabled,
			github,
			version: readVersion(dir),
			diskKb: du?.kb ?? null,
			diskLowerBound: du?.lowerBound ?? false,
			warnings: [...w],
		});
	}
	for (const x of detectHomeTampering(
		deps.home,
		runners.map((r) => r.name),
		deps.baselineDir,
	))
		if (!global.includes(x)) global.push(x);
	return { runners, global, problem: null };
}

export function statusExitCode(r: StatusReport): 0 | 1 {
	if (r.problem || r.runners.length === 0) return 1;
	if (r.global.length) return 1;
	return r.runners.some((x) => x.warnings.length) ? 1 : 0;
}

export function renderStatus(r: StatusReport, json: boolean): string {
	if (json) {
		return JSON.stringify(
			{
				runners: r.runners.map((x) => ({
					name: x.name,
					repo: x.repo,
					private: x.private,
					listener: x.procUnknown ? null : x.listener,
					enabled: x.enabled,
					busy: x.procUnknown ? null : x.workers > 0,
					github: x.github,
					version: x.version,
					diskBytes: x.diskKb === null ? null : x.diskKb * 1024,
					diskLowerBound: x.diskLowerBound,
					warnings: x.warnings,
				})),
				global: r.global,
				running: r.runners.filter((x) => x.workers > 0).length,
				total: r.runners.length,
			},
			null,
			2,
		);
	}
	if (r.problem === "denied") return "runner のディレクトリを読めません（権限の設定不足。README の手順を参照）";
	if (r.problem === "missing" || r.runners.length === 0)
		return "登録されていません（runner のディレクトリがありません）。README の手順を参照";
	const rows: string[][] = [["runner", "リポジトリ", "Listener", "job", "GitHub", "バージョン", "ディスク"]];
	for (const x of r.runners) {
		const listener = x.procUnknown ? "?" : x.listener ? "動作" : x.enabled === false ? "停止（無効化済み）" : "停止";
		const job = x.procUnknown ? "?" : x.listener ? (x.workers > 0 ? "走行" : "待機") : "-";
		const gh = x.github ? `${x.github.status}/${x.github.busy ? "busy" : "idle"}` : "?";
		const disk = x.diskKb === null ? "?" : formatDisk(x.diskKb) + (x.diskLowerBound ? " 以上" : "");
		rows.push([x.name, x.repo ?? "?", listener, job, gh, x.version ?? "?", disk]);
	}
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => width(row[i] ?? "")))) ?? [];
	const lines = rows.map((row, ri) => {
		const line = row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ");
		const warn = ri === 0 ? [] : (r.runners[ri - 1]?.warnings ?? []);
		return (line + (warn.length ? `  ${warn.map((x) => `⚠ ${x}`).join(" ")}` : "")).trimEnd();
	});
	const running = r.runners.filter((x) => x.workers > 0).length;
	const up = r.runners.filter((x) => x.listener).length;
	lines.push(`走行 ${running} / ${r.runners.length}（動作中 ${up} / ${r.runners.length}）`);
	for (const g of r.global) lines.push(`⚠ ${g}`);
	return lines.join("\n");
}

function width(s: string): number {
	let w = 0;
	for (const c of s) w += (c.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
	return w;
}
function pad(s: string, w: number): string {
	return s + " ".repeat(Math.max(0, w - width(s)));
}

// --- 表示するコマンド（実行はオーナー） ---------------------------------------------------------

/** dle-runner の user manager の systemctl を呼ぶコマンド。--machine は使えない（systemd-machined が無い） */
export function systemctlCommand(uid: string, verb: "start" | "stop", name: string): string {
	if (!/^\d+$/.test(uid)) throw new Error(`uid の書式が違います: ${sanitize(uid)}`);
	if (!NAME_RE.test(name)) throw new Error(`名前の書式が違います: ${sanitize(name)}`);
	const rt = `/run/user/${uid}`;
	return `sudo -H -u ${RUNNER_USER} env XDG_RUNTIME_DIR=${rt} DBUS_SESSION_BUS_ADDRESS=unix:path=${rt}/bus systemctl --user ${verb} dle-runner@${name}`;
}

export function renderStartCommands(names: string[], uid: string): string[] {
	return names.map((n) => systemctlCommand(uid, "start", n));
}

/** busy の runner は止めるコマンドを出さない（--force でだけ出す） */
export function renderStopCommands(
	runners: { name: string; busy: boolean }[],
	uid: string,
	force: boolean,
): { commands: string[]; skipped: string[] } {
	const commands: string[] = [];
	const skipped: string[] = [];
	for (const r of runners) {
		if (r.busy && !force) skipped.push(r.name);
		else commands.push(systemctlCommand(uid, "stop", r.name));
	}
	return { commands, skipped };
}

/**
 * 更新の差し替え（bash）。変数 F（tar.gz）・d（runner のディレクトリ）・DL（作業の置き場）を呼び出し側が設定する。
 * リリースの tar.gz のメンバー名は `./bin` のように `./` 付きなので、メンバーを名指しせず、全体を一時ディレクトリに
 * 展開して検証してから差し替える。途中で失敗したら、退避から戻し、新規に置いたものを消し、一時ディレクトリを消す。
 */
export function renderUpdateSwapScript(): string {
	return [
		'mkdir -p "$DL"',
		'T=$(mktemp -d "$DL/new.XXXXXX")',
		// tar の失敗などで途中で終わっても、一時ディレクトリを残さない
		"trap 'rm -rf \"$T\"' EXIT",
		'tar xzf "$F" -C "$T"',
		'if ! { test -x "$T/bin/Runner.Listener" && test -d "$T/externals" && test -f "$T/run.sh"; }; then',
		'  echo "展開物が不完全なので中止（何も変更していない）" >&2; rm -rf "$T"; exit 1',
		"fi",
		'FILES="bin externals run.sh run-helper.sh.template env.sh config.sh"',
		'NEW=""',
		"rollback() {",
		"  trap - ERR",
		"  for f in $FILES; do",
		'    if [ -e "$d/$f.dle-bak" ]; then rm -rf "$d/$f"; mv "$d/$f.dle-bak" "$d/$f"; fi',
		"  done",
		'  for f in $NEW; do rm -rf "$d/$f"; done',
		'  rm -rf "$T"',
		'  echo "差し替えに失敗したので元に戻した" >&2',
		"  exit 1",
		"}",
		'for f in $FILES; do rm -rf "$d/$f.dle-bak"; done',
		"trap rollback ERR",
		"for f in $FILES; do",
		'  if [ -e "$d/$f" ]; then mv "$d/$f" "$d/$f.dle-bak"; else NEW="$NEW $f"; fi',
		'  if [ -e "$T/$f" ]; then mv "$T/$f" "$d/$f"; fi',
		"done",
		"trap - ERR",
		'rm -rf "$T"',
	].join("\n");
}

/** 更新の取得（bash）。sha256 が取れない・一致しないときは、何も変更せずに中止する */
export function renderUpdateFetchScript(version: string, name: string): string {
	if (!VERSION_RE.test(version)) throw new Error(`バージョンの書式が違います: ${sanitize(version)}`);
	if (!NAME_RE.test(name)) throw new Error(`名前の書式が違います: ${sanitize(name)}`);
	return [
		"set -euo pipefail",
		`V=${version}; N=${name}`,
		'SHA=$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/tags/v$V" \\',
		"  | sed -n 's/.*BEGIN SHA linux-x64 -->\\([0-9a-f]\\{64\\}\\)<!-- END SHA linux-x64.*/\\1/p' | head -1)",
		'test -n "$SHA" || { echo "sha256 が取れないので中止（何も変更していない）" >&2; exit 1; }',
		"DL=~/actions-runners/.dl",
		'F="$DL/actions-runner-linux-x64-$V.tar.gz"',
		'mkdir -p "$DL"',
		'curl -fsSL -o "$F" "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz"',
		'echo "$SHA  $F" | sha256sum -c - >&2 || { echo "sha256 が一致しないので中止（何も変更していない）" >&2; exit 1; }',
		"d=~/actions-runners/$N",
	].join("\n");
}

/** オーナーが実行する更新の手順（1 つの runner 分） */
export function renderUpdateCommands(name: string, version: string, uid: string, home: string): string {
	const stop = systemctlCommand(uid, "stop", name);
	const start = systemctlCommand(uid, "start", name);
	return [
		`# ${name} を ${version} に更新する（idle のときに。実行は 1 つずつ）`,
		stop,
		`pgrep -af '^${home}/actions-runners/${name}/bin/Runner'   # 空であること（孤児が残っていない）`,
		`sudo -H -u ${RUNNER_USER} bash -s <<'EOF'`,
		renderUpdateFetchScript(version, name),
		renderUpdateSwapScript(),
		"EOF",
		start,
		"# 起動に成功したら、改変検知の基準値を取り直す（README の「基準値の取り直し」）",
	].join("\n");
}

// --- dle runner の本体 --------------------------------------------------------------------------

export async function defaultDeps(exec: Exec = runWithTimeout): Promise<StatusDeps & { uid: string | null }> {
	const g = await exec("getent", ["passwd", RUNNER_USER], 5_000);
	const homeField = g.ok ? g.stdout.trim().split(":")[5] : undefined;
	const home = homeField && /^\/[A-Za-z0-9._/-]+$/.test(homeField) ? homeField : `/home/${RUNNER_USER}`;
	const id = await exec("id", ["-u", RUNNER_USER], 5_000);
	const uid = id.ok && /^\d+$/.test(id.stdout.trim()) ? id.stdout.trim() : null;
	return {
		exec,
		home,
		uid,
		// DLE_RUNNERS_DIR はテスト用に runner の置き場所を変える。jonnity の環境変数なので job には届かない
		// （status が信用するのは dle-runner の領域の中身であって、この変数ではない）
		runnersDir: process.env.DLE_RUNNERS_DIR || path.join(home, "actions-runners"),
		baselineDir: "/usr/local/libexec/dle/baseline",
		now: Date.now(),
		interopFile: "/proc/sys/fs/binfmt_misc/WSLInterop",
	};
}

/** 引数の名前（ディレクトリ名・またはリポジトリ名）を runner のディレクトリ名に解決する */
export function resolveTargets(args: string[], available: string[]): { names: string[]; unknown: string[] } {
	if (args.length === 0) return { names: [...available], unknown: [] };
	const names = new Set<string>();
	const unknown: string[] = [];
	for (const a of args) {
		if (available.includes(a)) names.add(a);
		else {
			const m = available.filter((n) => n.startsWith(`${a}-`) && /^\d+$/.test(n.slice(a.length + 1)));
			if (m.length) for (const n of m) names.add(n);
			else unknown.push(a);
		}
	}
	return { names: [...names].sort(), unknown };
}

/** dle runner の実行。標準出力に出す内容と終了コードを返す（cli.ts が出力する） */
export async function cmdRunner(argv: string[], deps?: StatusDeps & { uid: string | null }): Promise<number> {
	let args: RunnerArgs;
	try {
		args = parseRunnerArgs(argv);
	} catch (e) {
		console.error((e as Error).message);
		return 1;
	}
	const d = deps ?? (await defaultDeps());
	const report = await buildStatus(d);
	if (args.cmd === "status") {
		console.log(renderStatus(report, args.json));
		return statusExitCode(report);
	}
	if (report.problem || report.runners.length === 0) {
		console.log(renderStatus(report, false));
		return 1;
	}
	const { names, unknown } = resolveTargets(
		args.names,
		report.runners.map((r) => r.name),
	);
	if (unknown.length) {
		console.error(`runner が見つかりません: ${unknown.map((u) => sanitize(u)).join(", ")}`);
		return 1;
	}
	if (!d.uid) {
		console.error(`ユーザー ${RUNNER_USER} が見つかりません（README のセットアップ手順を参照）`);
		return 1;
	}
	const targets = report.runners.filter((r) => names.includes(r.name));
	// 走行中かどうかが分からないときは、stop・update のコマンドを出さない（走行中の job を取り消す恐れがある）
	if ((args.cmd === "stop" || args.cmd === "update") && targets.some((t) => t.procUnknown)) {
		console.error(
			"プロセスの状態（ps）を取得できず、走行中か分からないので、コマンドを表示しません。しばらくしてからもう一度実行してください",
		);
		return 1;
	}
	const note = "実行の直前に dle runner status で走行中でないことを確認してください。";
	if (args.cmd === "start") {
		console.log("次のコマンドをオーナーが実行してください（dle は何も実行しません）:");
		for (const c of renderStartCommands(names, d.uid)) console.log(c);
		return 1;
	}
	if (args.cmd === "stop") {
		const { commands, skipped } = renderStopCommands(
			targets.map((t) => ({ name: t.name, busy: t.workers > 0 })),
			d.uid,
			args.force,
		);
		for (const s of skipped) console.log(`${s}: 走行中のため止めない（--force で止めるコマンドを表示）`);
		if (commands.length) {
			console.log(`次のコマンドをオーナーが実行してください（dle は何も実行しません）。${note}`);
			for (const c of commands) console.log(c);
			console.log("止めたあと、dle runner status で Listener・Worker が残っていないことを確認してください。");
		}
		return 1;
	}
	// update
	const latestR = await d.exec("gh", ["api", "repos/actions/runner/releases/latest", "--jq", ".tag_name"], 15_000);
	const latest = latestR.ok ? /^v(\d+\.\d+\.\d+)$/.exec(latestR.stdout.trim())?.[1] : undefined;
	if (!latest) {
		console.error("最新のバージョンを取得できませんでした");
		return 1;
	}
	let unknownVersion = false;
	const outdated: RunnerStatus[] = [];
	for (const t of targets) {
		if (!t.version) {
			unknownVersion = true;
			console.log(`${t.name}: バージョン ? → 最新 ${latest}`);
		} else {
			const cmp = compareVersions(t.version, latest);
			console.log(`${t.name}: ${t.version} → 最新 ${latest}${cmp < 0 ? "（古い）" : "（最新）"}`);
			if (cmp < 0) outdated.push(t);
		}
	}
	if (args.check) return unknownVersion ? 1 : 0;
	if (!outdated.length) return unknownVersion ? 1 : 0;
	console.log(
		"runner は自己更新するので、実行しなくても構いません。揃えたいときだけ、オーナーが 1 つずつ実行してください。",
	);
	for (const t of outdated) {
		if (t.workers > 0) console.log(`${t.name}: スキップ（走行中）`);
		else console.log(`\n${renderUpdateCommands(t.name, latest, d.uid, d.home)}`);
	}
	return 1;
}
