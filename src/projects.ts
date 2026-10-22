// リポジトリの登録（dle add）と、各セッションの起動コマンドの組み立て。

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Config, DLE_TOOLS_RULE, expandHome, PLUGIN_SPEC } from "./config.ts";
import type { Project } from "./ledger.ts";
import { type SessionTarget, shq } from "./supervisor.ts";

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const run: Run = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
			resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
		);
	});

export const RESERVED_NAMES = ["concierge", "engine"];

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

/**
 * spec が owner/repo なら workspaceDir に clone（済みならそのまま）、パスなら既存の場所を使う。
 * どちらも git リポジトリであることを確かめ、.claude/harness.json が無ければ needsInit にする。
 */
export async function resolveProject(
	spec: string,
	cfg: Pick<Config, "workspaceDir">,
	exec: Run = run,
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
	const name = projectName(dir, repo);
	if (RESERVED_NAMES.includes(name)) throw new Error(`プロジェクト名「${name}」は予約されています`);
	return { name, repo, path: dir, active: true, needsInit: !existsSync(path.join(dir, ".claude", "harness.json")) };
}

function claudeCommand(cfg: Config, env: Record<string, string>, args: string[]): string {
	const envPart = Object.entries(env)
		.map(([k, v]) => `${k}=${shq(v)}`)
		.join(" ");
	return `env ${envPart} ${[cfg.claudeBin, ...args].map(shq).join(" ")}`;
}

export function sessionTargets(cfg: Config, projects: Project[]): SessionTarget[] {
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
		.map(
			(p): SessionTarget => ({
				name: p.name,
				cwd: p.path,
				command: claudeCommand(cfg, { ...baseEnv, DLE_ROLE: "worker", DLE_PROJECT: p.name }, [
					...(cfg.worker.model ? ["--model", cfg.worker.model] : []),
					...channelArgs,
					"--allowedTools",
					DLE_TOOLS_RULE,
					// ハーネスの入口は確認なしで通す（離席中にここで止まらないように）。どれもガード付きで、
					// harness-merge は人の承認記録が無ければマージしない
					...HARNESS_COMMANDS.map((c) => `Bash(${c}:*)`),
					...cfg.worker.extraArgs,
				]),
				initialPrompt: cfg.worker.initialPrompt,
			}),
		);
	return [concierge, ...workers];
}
