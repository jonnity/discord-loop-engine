// リポジトリの登録（dle add）と、各セッションの起動コマンドの組み立て。

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, DLE_TOOLS_RULE, expandHome, PLUGIN_SPEC } from "./config.ts";
import type { Ledger, Project } from "./ledger.ts";
import { type SessionTarget, shq } from "./supervisor.ts";

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
	"harness-phase",
	"harness-inbox",
	"harness-gate",
	"harness-merge",
	"harness-status",
	"harness-notify",
	"harness-labels",
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

export function sessionTargets(cfg: Config, projects: Project[], ledger?: Ledger): SessionTarget[] {
	const baseEnv = { DLE_HOME: cfg.home, DLE_SOCKET: cfg.socketPath };
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
					: "/discord-loop-engine:onboard";
			return {
				name: p.name,
				cwd: p.path,
				...(p.tmuxSession ? { tmuxSession: p.tmuxSession } : {}),
				command: claudeCommand(
					cfg,
					{ ...baseEnv, DLE_ROLE: "worker", DLE_PROJECT: p.name, DLE_LOOP: native ? "native" : "harness" },
					[
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
				),
				initialPrompt,
			};
		});
	return [concierge, ...workers];
}

const HARNESS_LABELS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "harness-labels");

/**
 * dle add の本体（engine の project_add と、engine が止まっているときの CLI の両方から使う）。
 * 登録 → 作業用ファイルを git の除外に足す → harness モードならラベルを作る → 設定が無ければ調査タスクを作る。
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
		prev && !opts.native ? { ...prev, path: resolved.path, repo: resolved.repo, active: true } : resolved,
	);
	const notes: string[] = [];
	excludeLocalState(project.path);
	if (project.mode === "harness") {
		const r = await exec(HARNESS_LABELS, ["--repo", project.repo]);
		if (!r.ok)
			notes.push(`harness:* ラベルを作れませんでした（${r.stderr.trim().slice(0, 200)}）。gh の権限を確認してください`);
	}
	const ready = ledger.isReady(project);
	if (
		!ready &&
		!ledger
			.tasks()
			.some((t) => t.project === project.name && t.title.startsWith("プロジェクトの調査") && t.status !== "done")
	) {
		ledger.createTask({
			project: project.name,
			title: "プロジェクトの調査と設定",
			status: "ai-working",
			next: "worker がリポジトリを調べて設定の案を作り、A-番号で確認を求める",
			note: "設定が無いため調査から始める",
		});
	}
	ledger.journal(`[${project.name}] プロジェクトを登録（${project.repo} / ${project.path} / ${project.mode}）`);
	return { project, ready, notes };
}
