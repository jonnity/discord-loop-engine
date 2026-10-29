// リポジトリの登録（dle add）と、各セッションの起動コマンドの組み立て。

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DLE_TOOLS_RULE, expandHome, PLUGIN_SPEC } from "./config.ts";
import type { Ledger, Project } from "./ledger.ts";
import { type SessionTarget, shq } from "./supervisor.ts";

import { resolveWorktreeRoot } from "./worktrees.ts";

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const run: Run = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
			resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
		);
	});

export const RESERVED_NAMES = ["concierge", "engine"];

// 無人の worker が調べ物で止まらないよう、読むだけのコマンドは確認なしで通す
const READ_ONLY_COMMANDS = [
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"find",
	"grep",
	"rg",
	"jq",
	"git status",
	"git log",
	"git diff",
	"git show",
	"git branch",
	"git rev-parse",
	"gh issue view",
	"gh issue list",
	"gh pr view",
	"gh pr list",
	"gh pr checks",
	"gh run list",
	"gh run view",
];

const HARNESS_COMMANDS = [
	"harness-config",
	"harness-hook",
	"harness-phase",
	"harness-inbox",
	"harness-gate",
	"harness-merge",
	"harness-status",
	"harness-notify",
	"harness-labels",
	"harness-issue-md",
	// 読み取り専用の check / status だけ。起動（harness-codex）は許可に含めない
	"harness-codex-status",
];

export function repoFromRemote(url: string): string {
	const trimmed = url
		.trim()
		.replace(/\.git$/, "")
		.replace(/^[^:]+:(?!\/\/)/, "/");
	const parts = trimmed.split("/").filter(Boolean);
	return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : "";
}

function projectName(dir: string, repo: string): string {
	const harness = path.join(dir, ".claude", "harness.json");
	if (existsSync(harness)) {
		try {
			const p = (JSON.parse(readFileSync(harness, "utf8")) as { project?: string }).project;
			if (p) return p;
		} catch {}
	}
	return repo.split("/")[1] || path.basename(dir);
}

export interface AddOptions {
	/** native モードで使うリポジトリ独自のループのコマンド（例: /parallel-cycle-loop） */
	native?: string;
	/** 独自のループがあっても dle の issue-loop で進める */
	harness?: boolean;
	tmuxSession?: string;
	name?: string;
}

/**
 * spec が owner/repo なら workspaceDir に clone（済みならそのまま）、パスなら既存の場所を使う。
 * どちらも GitHub の origin を持つ git リポジトリであることを確かめる。
 */
export async function resolveProject(
	spec: string,
	cfg: Pick<Config, "workspaceDir">,
	exec: Run = run,
	opts: AddOptions = {},
): Promise<Omit<Project, "addedAt">> {
	let dir: string;
	let repo: string;
	const looksLikePath = /^[~./]/.test(spec) || existsSync(spec);
	if (looksLikePath) {
		dir = path.resolve(expandHome(spec));
		const top = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
		if (!top.ok) throw new Error(`${dir} は git リポジトリではありません`);
		dir = top.stdout.trim();
		const remote = await exec("git", ["-C", dir, "remote", "get-url", "origin"]);
		repo = remote.ok ? repoFromRemote(remote.stdout) : "";
		if (!repo) throw new Error(`${dir} に GitHub の origin がありません（Issue ベースで進めるため必須です）`);
	} else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec)) {
		repo = spec;
		dir = path.join(cfg.workspaceDir, spec.split("/")[1] as string);
		if (!existsSync(dir)) {
			mkdirSync(cfg.workspaceDir, { recursive: true });
			const r = await exec("gh", ["repo", "clone", spec, dir]);
			if (!r.ok) throw new Error(`gh repo clone ${spec} に失敗しました: ${r.stderr.trim().slice(0, 300)}`);
		}
	} else {
		throw new Error(`「${spec}」はリポジトリとして解釈できません（owner/repo かパスで指定してください）`);
	}
	const name = opts.name || projectName(dir, repo);
	if (RESERVED_NAMES.includes(name) || !/^[A-Za-z0-9._-]+$/.test(name))
		throw new Error(`プロジェクト名「${name}」は使えません`);
	return {
		name,
		repo,
		path: dir,
		active: true,
		mode: opts.native ? "native" : "harness",
		...(opts.native ? { initialPrompt: opts.native } : {}),
		...(opts.harness && !opts.native ? { harnessOnly: true } : {}),
		...(opts.tmuxSession ? { tmuxSession: opts.tmuxSession } : {}),
	};
}

// ハーネスが作業用に置くもの。リポジトリの .gitignore を書き換えずに済むよう、コミットされない
// .git/info/exclude に足す（リポジトリ側には何も置かない、という方針のため）
const LOCAL_STATE = [".harness/", ".worktrees/"];

export function excludeLocalState(dir: string) {
	const file = path.join(dir, ".git", "info", "exclude");
	if (!existsSync(path.join(dir, ".git"))) return;
	mkdirSync(path.dirname(file), { recursive: true });
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const missing = LOCAL_STATE.filter((l) => !current.split("\n").includes(l));
	if (missing.length === 0) return;
	appendFileSync(
		file,
		`${current && !current.endsWith("\n") ? "\n" : ""}# discord-loop-engine の作業用\n${missing.join("\n")}\n`,
	);
}

function claudeCommand(cfg: Config, env: Record<string, string>, args: string[]): string {
	const envPart = Object.entries(env)
		.map(([k, v]) => `${k}=${shq(v)}`)
		.join(" ");
	return `env ${envPart} ${[cfg.claudeBin, ...args].map(shq).join(" ")}`;
}

/** worker が Author identity unknown でコミットに失敗しないよう、engine の設定の作者を渡す。
 *  Why not: リポジトリごとの user.email を見て出し分けることはしない（設定されていれば常に渡す。Issue #1 の決定） */
export function gitIdentityEnv(cfg: Config): Record<string, string> {
	if (!cfg.git) return {};
	return {
		GIT_AUTHOR_NAME: cfg.git.name,
		GIT_AUTHOR_EMAIL: cfg.git.email,
		GIT_COMMITTER_NAME: cfg.git.name,
		GIT_COMMITTER_EMAIL: cfg.git.email,
	};
}

export function sessionTargets(cfg: Config, projects: Project[], ledger?: Ledger): SessionTarget[] {
	const baseEnv = { DLE_HOME: cfg.home, DLE_CONFIG_HOME: cfg.home, DLE_SOCKET: cfg.socketPath };
	const channelArgs = ["--dangerously-load-development-channels", PLUGIN_SPEC];
	const concierge: SessionTarget = {
		name: "concierge",
		cwd: path.join(cfg.home, "concierge"),
		command: claudeCommand(cfg, { ...baseEnv, DLE_ROLE: "concierge" }, [
			"--model",
			cfg.concierge.model,
			...channelArgs,
			"--allowedTools",
			DLE_TOOLS_RULE,
			// 窓口は Issue の起票と状況確認だけを gh で行う（コードは書かない）
			"Bash(gh issue create:*)",
			"Bash(gh issue view:*)",
			"Bash(gh issue list:*)",
			"Bash(gh issue comment:*)",
			"Bash(gh pr view:*)",
			"Bash(gh pr list:*)",
			"Bash(gh pr checks:*)",
			...cfg.concierge.allowedTools,
			...cfg.concierge.extraArgs,
		]),
		initialPrompt: "/discord-loop-engine:concierge",
		...(cfg.concierge.refresh.enabled
			? {
					refresh: {
						...cfg.concierge.refresh,
						prompt: "/discord-loop-engine:concierge refresh",
						idleSeconds: 180,
						cooldownMinutes: 30,
						waitForCodex: false,
						codexIgnoreAfterMinutes: 120,
						cwd: path.join(cfg.home, "concierge"),
					},
				}
			: {}),
	};
	const workers = projects
		.filter((p) => p.active)
		.map((p): SessionTarget => {
			const native = p.mode === "native";
			const profile = ledger?.profile(p) ?? null;
			const fromProfile = Array.isArray(profile?.permissions)
				? (profile.permissions as unknown[]).filter((x): x is string => typeof x === "string")
				: [];
			const ready = ledger ? ledger.isReady(p) : true;
			const initialPrompt = native
				? (p.initialPrompt ?? "")
				: ready
					? cfg.worker.initialPrompt
					: `/discord-loop-engine:onboard${p.harnessOnly ? " harness" : ""}`;
			let worktreeRoot: string | undefined;
			let startupError: string | undefined;
			if (!native) {
				try {
					worktreeRoot = resolveWorktreeRoot({
						repoRoot: p.path,
						home: cfg.home,
						project: p.name,
						worktreeRoot: profile?.worktreeRoot,
					});
				} catch (error) {
					startupError = `${p.name}: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			return {
				...(startupError ? { startupError } : {}),
				name: p.name,
				cwd: p.path,
				...(p.tmuxSession ? { tmuxSession: p.tmuxSession } : {}),
				command: startupError
					? ""
					: `${worktreeRoot ? `mkdir -p -- ${shq(worktreeRoot)} && exec ` : ""}${claudeCommand(
							cfg,
							{
								...baseEnv,
								...gitIdentityEnv(cfg),
								DLE_ROLE: "worker",
								DLE_PROJECT: p.name,
								DLE_LOOP: native ? "native" : "harness",
							},
							[
								...(worktreeRoot ? ["--add-dir", worktreeRoot] : []),
								...(cfg.worker.model ? ["--model", cfg.worker.model] : []),
								...channelArgs,
								"--allowedTools",
								DLE_TOOLS_RULE,
								// ハーネスの入口は確認なしで通す（離席中にここで止まらないように）。どれもガード付きで、
								// harness-merge は人の承認記録が無ければマージしない。native では使わないので渡さない
								...(native ? [] : HARNESS_COMMANDS.map((c) => `Bash(${c}:*)`)),
								...READ_ONLY_COMMANDS.map((c) => `Bash(${c}:*)`),
								...fromProfile,
								...(p.allow ?? []),
								...cfg.worker.extraArgs,
							],
						)}`,
				initialPrompt,
				...(!native && !startupError && ready && cfg.worker.wake?.enabled !== false ? { wake: { enabled: true } } : {}),
				...(!native && !startupError && ready && cfg.worker.refresh.enabled
					? {
							refresh: {
								...cfg.worker.refresh,
								prompt: initialPrompt,
								worktreeRoot,
								maxEvents: 0,
								waitForCodex: true,
								cwd: p.path,
							},
						}
					: {}),
			};
		});
	return [concierge, ...workers];
}

const HARNESS_LABELS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "harness-labels");

/** 調査タスクが無ければ作る（登録し直し・モードの切り替えで重複させない） */
export function ensureOnboardingTask(ledger: Ledger, project: string, note: string) {
	const open = ledger
		.tasks()
		.some((t) => t.project === project && t.title.startsWith("プロジェクトの調査") && t.status !== "done");
	if (open) return;
	ledger.createTask({
		project,
		title: "プロジェクトの調査と設定",
		status: "ai-working",
		next: "worker がリポジトリを調べて設定の案を作り、A-番号で確認を求める",
		note,
	});
}

/** harness:* ラベルを作る（冪等）。失敗したら理由を返す */
export async function ensureLabels(project: Pick<Project, "repo">, exec: Run = run): Promise<string | null> {
	const r = await exec(HARNESS_LABELS, ["--repo", project.repo]);
	return r.ok
		? null
		: `harness:* ラベルを作れませんでした（${r.stderr.trim().slice(0, 200)}）。gh の権限を確認してください`;
}

/**
 * dle add の本体（engine の project_add と、engine が止まっているときの CLI の両方から使う）。
 * 登録 → 作業用ファイルを git の除外に足す → 設定が確定済みの harness ならラベルを作る → 設定が無ければ調査タスクを作る。
 */
export async function registerProject(
	ledger: Ledger,
	cfg: Pick<Config, "workspaceDir">,
	spec: string,
	opts: AddOptions = {},
	exec: Run = run,
): Promise<{ project: Project; ready: boolean; notes: string[] }> {
	const resolved = await resolveProject(spec, cfg, exec, opts);
	const prev = ledger.projects().find((p) => p.name === resolved.name);
	// 登録し直しでは、明示されなかった項目（native の設定など）を引き継ぐ
	const project = ledger.upsertProject(
		prev && !opts.native && !opts.harness
			? { ...prev, path: resolved.path, repo: resolved.repo, active: true }
			: { ...prev, ...resolved, ...(opts.harness ? { initialPrompt: undefined, tmuxSession: undefined } : {}) },
	);
	const notes: string[] = [];
	excludeLocalState(project.path);
	const ready = ledger.isReady(project);
	// 設定が未確定なら作らない。調査の結果 native（リポジトリ独自のループ）になるかもしれず、
	// その場合は使わないラベルをリポジトリに残すことになるため（確定時に profile_activate で作る）
	if (project.mode === "harness" && ready) {
		const err = await ensureLabels(project, exec);
		if (err) notes.push(err);
	}
	if (!ready) ensureOnboardingTask(ledger, project.name, "設定が無いため調査から始める");
	ledger.journal(`[${project.name}] プロジェクトを登録（${project.repo} / ${project.path} / ${project.mode}）`);
	return { project, ready, notes };
}
