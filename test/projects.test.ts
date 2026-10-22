// リポジトリの登録とセッションの起動コマンドが保証すること:
// - origin の URL（https / ssh / プロキシ経由）から owner/repo を読める
// - パス指定は既存の場所を使い、harness.json が無ければ導入から始める印を付ける
// - owner/repo 指定は workspaceDir に clone する（済みなら clone しない）
// - 窓口は Sonnet で、worker は DLE_PROJECT 付きで、どちらも開発用 channel と dle ツールの許可付きで起動する
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { type Run, repoFromRemote, resolveProject, sessionTargets } from "../src/projects.ts";

test("origin の URL から owner/repo を読む", () => {
	assert.equal(repoFromRemote("https://github.com/jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("git@github.com:jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("http://proxy@127.0.0.1:1234/git/jonnity/kishimen-tool"), "jonnity/kishimen-tool");
});

test("パス指定は既存の場所を使い、harness.json が無ければ needsInit", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-p-"));
	execFileSync("git", ["-C", dir, "init", "-q"]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/jonnity/kishimen-tool"]);
	const p = await resolveProject(dir, { workspaceDir: "/nowhere" });
	assert.deepEqual(
		{ name: p.name, repo: p.repo, needsInit: p.needsInit },
		{ name: "kishimen-tool", repo: "jonnity/kishimen-tool", needsInit: true },
	);
	mkdirSync(path.join(dir, ".claude"));
	writeFileSync(path.join(dir, ".claude", "harness.json"), JSON.stringify({ project: "kishimen" }));
	const q = await resolveProject(dir, { workspaceDir: "/nowhere" });
	assert.deepEqual({ name: q.name, needsInit: q.needsInit }, { name: "kishimen", needsInit: false });
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

test("窓口は Sonnet、worker は DLE_PROJECT 付きで、どちらも channel と dle ツールの許可付きで起動する", () => {
	const cfg = {
		home: "/h",
		socketPath: "/h/engine.sock",
		claudeBin: "claude",
		concierge: { model: "sonnet", extraArgs: [], allowedTools: [] },
		worker: {
			model: null,
			extraArgs: ["--permission-mode", "acceptEdits"],
			initialPrompt: "/discord-loop-engine:issue-loop",
		},
	} as unknown as Config;
	const [c, w, ...rest] = sessionTargets(cfg, [
		{ name: "kishimen-tool", repo: "jonnity/kishimen-tool", path: "/w/k", active: true, addedAt: "", needsInit: false },
		{ name: "paused", repo: "x/y", path: "/w/p", active: false, addedAt: "", needsInit: false },
	]);
	assert.equal(rest.length, 0, "active でないものは起動しない");
	assert.match(
		c?.command ?? "",
		/^env DLE_HOME=\/h DLE_SOCKET=\/h\/engine.sock DLE_ROLE=concierge claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle /,
	);
	assert.match(c?.command ?? "", /'Bash\(gh issue create:\*\)'/);
	assert.equal(c?.initialPrompt, "/discord-loop-engine:concierge");
	assert.match(
		w?.command ?? "",
		/DLE_ROLE=worker DLE_PROJECT=kishimen-tool claude --dangerously-load-development-channels/,
	);
	assert.match(w?.command ?? "", /'Bash\(harness-merge:\*\)'.* --permission-mode acceptEdits$/);
	assert.equal(w?.cwd, "/w/k");
});
