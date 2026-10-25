// リポジトリの登録とセッションの起動コマンドが保証すること:
// - origin の URL（https / ssh / プロキシ経由）から owner/repo を読める
// - パス指定は既存の場所を使い、harness.json が無ければ導入から始める印を付ける
// - owner/repo 指定は workspaceDir に clone する（済みなら clone しない）
// - 窓口は Sonnet で、worker は DLE_PROJECT 付きで、どちらも開発用 channel と dle ツールの許可付きで起動する
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { Ledger, type Project } from "../src/ledger.ts";
import {
	excludeLocalState,
	type Run,
	registerProject,
	repoFromRemote,
	resolveProject,
	run,
	sessionTargets,
} from "../src/projects.ts";

test("origin の URL から owner/repo を読む", () => {
	assert.equal(repoFromRemote("https://github.com/jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("git@github.com:jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("http://proxy@127.0.0.1:1234/git/jonnity/kishimen-tool"), "jonnity/kishimen-tool");
});

test("パス指定は既存の場所を使い、既定は harness、--native ならそのコマンドで native", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-p-"));
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/jonnity/kishimen-tool"]);
	const p = await resolveProject(dir, { workspaceDir: "/nowhere" });
	assert.deepEqual(
		{ name: p.name, repo: p.repo, mode: p.mode },
		{ name: "kishimen-tool", repo: "jonnity/kishimen-tool", mode: "harness" },
	);
	const n = await resolveProject(dir, { workspaceDir: "/nowhere" }, undefined, {
		native: "/parallel-cycle-loop",
		tmuxSession: "dev",
		name: "oogiri-doc",
	});
	assert.deepEqual(
		{ name: n.name, mode: n.mode, initialPrompt: n.initialPrompt, tmuxSession: n.tmuxSession },
		{ name: "oogiri-doc", mode: "native", initialPrompt: "/parallel-cycle-loop", tmuxSession: "dev" },
	);
});

test("作業用ディレクトリはリポジトリの .gitignore ではなく .git/info/exclude に足す（何度呼んでも1回だけ）", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-x-"));
	execFileSync("git", ["-C", dir, "init", "-q"]);
	excludeLocalState(dir);
	excludeLocalState(dir);
	const ex = readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
	assert.equal(ex.split("\n").filter((l) => l === ".harness/").length, 1);
	assert.ok(ex.includes(".worktrees/"));
	assert.ok(!existsSync(path.join(dir, ".gitignore")), "リポジトリには何も置かない");
});

test("登録すると、設定が無ければ調査タスクを作り、ラベルは設定の確定まで作らない（native も作らない）", async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-h-"));
	const ledger = new Ledger(home);
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-r-"));
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/jonnity/kishimen-tool"]);
	const calls: string[] = [];
	const exec: Run = async (cmd, args) => {
		calls.push(path.basename(cmd));
		return cmd === "git" ? run(cmd, args) : { ok: true, stdout: "", stderr: "" };
	};
	const r = await registerProject(ledger, { workspaceDir: "/nowhere" }, dir, {}, exec);
	assert.equal(r.ready, false);
	assert.ok(!calls.includes("harness-labels"), "調査の結果 native になるかもしれないので、まだ作らない");
	assert.deepEqual(
		ledger.tasks().map((t) => t.title),
		["プロジェクトの調査と設定"],
	);
	await registerProject(ledger, { workspaceDir: "/nowhere" }, dir, {}, exec);
	assert.equal(ledger.tasks().length, 1, "登録し直しても調査タスクは増やさない");

	// 設定が確定済みなら、登録し直しのときにラベルを作る（冪等）
	mkdirSync(path.dirname(ledger.profilePath("kishimen-tool")), { recursive: true });
	writeFileSync(ledger.profilePath("kishimen-tool"), JSON.stringify({ gate: [{ name: "t", run: "true" }] }));
	calls.length = 0;
	const again = await registerProject(ledger, { workspaceDir: "/nowhere" }, dir, {}, exec);
	assert.equal(again.ready, true);
	assert.ok(calls.includes("harness-labels"));

	calls.length = 0;
	const n = await registerProject(
		ledger,
		{ workspaceDir: "/nowhere" },
		dir,
		{ native: "/parallel-cycle-loop", name: "oogiri-doc" },
		exec,
	);
	assert.equal(n.ready, true);
	assert.ok(!calls.includes("harness-labels"));
});

test("--harness で登録すると、独自のループがあっても調査は harness で進める（native からの登録し直しも）", async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-h-"));
	const ledger = new Ledger(home);
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-r-"));
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/jonnity/oogiri-doc"]);
	const exec: Run = async (cmd, args) => (cmd === "git" ? run(cmd, args) : { ok: true, stdout: "", stderr: "" });
	await registerProject(
		ledger,
		{ workspaceDir: "/nowhere" },
		dir,
		{ native: "/parallel-cycle-loop", tmuxSession: "dev" },
		exec,
	);
	const r = await registerProject(ledger, { workspaceDir: "/nowhere" }, dir, { harness: true }, exec);
	assert.equal(r.project.mode, "harness");
	assert.equal(r.project.harnessOnly, true);
	assert.equal(r.project.initialPrompt, undefined);
	assert.equal(r.project.tmuxSession, undefined);
	const cfg = {
		home,
		socketPath: "/s",
		claudeBin: "claude",
		concierge: { model: "sonnet", extraArgs: [], allowedTools: [], refresh: { maxEvents: 40, contextPercent: 15 } },
		worker: { model: null, extraArgs: [], initialPrompt: "/discord-loop-engine:issue-loop" },
	} as unknown as Config;
	const t = sessionTargets(cfg, ledger.projects(), ledger).find((x) => x.name === "oogiri-doc");
	assert.equal(t?.initialPrompt, "/discord-loop-engine:onboard harness");
});

test("owner/repo 指定は workspaceDir に gh repo clone する", async () => {
	const ws = mkdtempSync(path.join(os.tmpdir(), "dle-ws-"));
	const calls: string[][] = [];
	const fake: Run = async (cmd, args) => {
		calls.push([cmd, ...args]);
		if (cmd === "gh") mkdirSync(args[3] as string, { recursive: true });
		return { ok: true, stdout: "", stderr: "" };
	};
	const p = await resolveProject("jonnity/kishimen-tool", { workspaceDir: ws }, fake);
	assert.deepEqual(calls, [["gh", "repo", "clone", "jonnity/kishimen-tool", path.join(ws, "kishimen-tool")]]);
	assert.equal(p.path, path.join(ws, "kishimen-tool"));
	await resolveProject("jonnity/kishimen-tool", { workspaceDir: ws }, fake);
	assert.equal(calls.length, 1, "clone 済みなら clone しない");
	await assert.rejects(resolveProject("not a repo", { workspaceDir: ws }, fake), /解釈できません/);
});

test("窓口は Sonnet、worker は DLE_PROJECT 付きで、設定の有無と mode で最初のコマンドが変わる", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-t-"));
	const ledger = new Ledger(home);
	const cfg = {
		home,
		socketPath: `${home}/engine.sock`,
		claudeBin: "claude",
		concierge: { model: "sonnet", extraArgs: [], allowedTools: [], refresh: { maxEvents: 40, contextPercent: 15 } },
		worker: {
			model: null,
			extraArgs: ["--permission-mode", "acceptEdits"],
			initialPrompt: "/discord-loop-engine:issue-loop",
		},
	} as unknown as Config;
	const base = { repo: "x/y", active: true, addedAt: "" };
	const projects: Project[] = [
		{ ...base, name: "kishimen-tool", path: "/w/k", mode: "harness" },
		{
			...base,
			name: "oogiri-doc",
			path: "/w/o",
			mode: "native",
			initialPrompt: "/parallel-cycle-loop",
			tmuxSession: "dev",
		},
		{ ...base, name: "paused", path: "/w/p", mode: "harness", active: false },
	];
	const [c, k, o, ...rest] = sessionTargets(cfg, projects, ledger);
	assert.equal(rest.length, 0, "active でないものは起動しない");
	assert.match(
		c?.command ?? "",
		/DLE_ROLE=concierge claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle /,
	);
	assert.match(c?.command ?? "", /'Bash\(gh issue create:\*\)'/);
	assert.equal(c?.initialPrompt, "/discord-loop-engine:concierge");

	assert.equal(k?.initialPrompt, "/discord-loop-engine:onboard", "設定が無ければ調査から");
	assert.match(k?.command ?? "", /DLE_ROLE=worker DLE_PROJECT=kishimen-tool DLE_LOOP=harness claude /);
	assert.match(k?.command ?? "", /'Bash\(harness-merge:\*\)'.* --permission-mode acceptEdits$/);

	assert.match(k?.command ?? "", /'Bash\(harness-issue-md:\*\)'/);
	assert.match(k?.command ?? "", /'Bash\(harness-codex-status:\*\)'/, "読み取り専用の確認は無人で通す");
	assert.doesNotMatch(k?.command ?? "", /harness-codex:|harness-codex\)/, "Codex の起動（start）は許可しない");

	assert.equal(o?.initialPrompt, "/parallel-cycle-loop", "native はそのリポジトリのループで始める");
	assert.equal(o?.tmuxSession, "dev");
	assert.match(o?.command ?? "", /DLE_LOOP=native/);
	assert.doesNotMatch(o?.command ?? "", /harness-merge/, "native にはハーネスの許可を渡さない");

	// 設定が確定したら issue-loop で始め、設定の permissions も許可に加える
	mkdirSync(path.join(home, "projects", "kishimen-tool"), { recursive: true });
	writeFileSync(
		path.join(home, "projects", "kishimen-tool", "harness.json"),
		JSON.stringify({ gate: [], permissions: ["Bash(cargo:*)"] }),
	);
	const k2 = sessionTargets(cfg, projects, ledger)[1];
	assert.equal(k2?.initialPrompt, "/discord-loop-engine:issue-loop");
	assert.match(k2?.command ?? "", /'Bash\(cargo:\*\)'/);
});

test("git の作者を設定していれば worker にだけ GIT_* で渡し、無い Config でも落ちない", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-t-"));
	const ledger = new Ledger(home);
	const base = {
		home,
		socketPath: `${home}/engine.sock`,
		claudeBin: "claude",
		concierge: { model: "sonnet", extraArgs: [], allowedTools: [], refresh: { maxEvents: 40, contextPercent: 15 } },
		worker: { model: null, extraArgs: [], initialPrompt: "/discord-loop-engine:issue-loop" },
	};
	const p = { repo: "x/y", active: true, addedAt: "" };
	const projects: Project[] = [
		{ ...p, name: "kishimen-tool", path: "/w/k", mode: "harness" },
		{ ...p, name: "oogiri-doc", path: "/w/o", mode: "native", initialPrompt: "/loop" },
	];

	const none = sessionTargets(base as unknown as Config, projects, ledger);
	assert.doesNotMatch(none.map((t) => t.command).join("\n"), /GIT_/, "git が無い Config では何も渡さない");
	const nul = sessionTargets({ ...base, git: null } as unknown as Config, projects, ledger);
	assert.doesNotMatch(nul.map((t) => t.command).join("\n"), /GIT_/);

	const cfg = { ...base, git: { name: "Taro 'T' Yamada", email: "taro@example.com" } } as unknown as Config;
	const [c, k, o] = sessionTargets(cfg, projects, ledger);
	assert.doesNotMatch(c?.command ?? "", /GIT_/, "窓口はコミットしないので渡さない");
	for (const t of [k, o]) {
		assert.match(t?.command ?? "", /GIT_AUTHOR_EMAIL=taro@example\.com /);
		assert.match(t?.command ?? "", /GIT_COMMITTER_EMAIL=taro@example\.com /);
		assert.match(t?.command ?? "", /GIT_AUTHOR_NAME='Taro '\\''T'\\'' Yamada' /, "空白・引用符を含む名前も引用される");
		assert.match(t?.command ?? "", /GIT_COMMITTER_NAME='Taro '\\''T'\\'' Yamada' /);
	}
});
