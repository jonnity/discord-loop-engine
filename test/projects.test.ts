// リポジトリの登録とセッションの起動コマンドが保証すること:
// - origin の URL（https / ssh / プロキシ経由）から owner/repo を読める
// - パス指定は既存の場所を使い、harness.json が無ければ導入から始める印を付ける
// - owner/repo 指定は workspaceDir に clone する（済みなら clone しない）
// - 窓口は Sonnet で、worker は DLE_PROJECT 付きで、どちらも開発用 channel と dle ツールの許可付きで起動する
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Config, loadConfig } from "../src/config.ts";
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
import { Supervisor } from "../src/supervisor.ts";
import { waitForContent } from "./wait-file.ts";

test("origin の URL から owner/repo を読む", () => {
	assert.equal(repoFromRemote("https://github.com/jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("git@github.com:jonnity/kishimen-tool.git"), "jonnity/kishimen-tool");
	assert.equal(repoFromRemote("http://proxy@127.0.0.1:1234/git/jonnity/kishimen-tool"), "jonnity/kishimen-tool");
});

test("M4: 役割モデルと旧 extraArgs を起動引数へ接続し、不正 profile は対象だけ止める", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-model-p-"));
	try {
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"], models: { tick: "opus" } }),
		);
		const cfg = loadConfig(home),
			ledger = new Ledger(home);
		const projects: Project[] = ["good", "bad", "native"].map((name) => ({
			name,
			repo: "x/y",
			path: path.join(home, name),
			mode: name === "native" ? "native" : "harness",
			active: true,
			addedAt: "",
		}));
		for (const p of projects) {
			mkdirSync(path.dirname(ledger.profilePath(p.name)), { recursive: true });
			writeFileSync(
				ledger.profilePath(p.name),
				JSON.stringify({ models: { tick: p.name === "bad" ? null : "haiku" } }),
			);
		}
		writeFileSync(ledger.profilePath("good"), '{"concierge":{"x":1,"x":2},"models":{"tick":"haiku"}}');
		let targets = sessionTargets(cfg, projects, ledger);
		assert.equal(targets[1]?.startupError, undefined);
		assert.match(targets[1]?.command ?? "", /--model haiku/);
		assert.match(targets[3]?.command ?? "", /--model haiku/);
		assert.match(targets[2]?.startupError ?? "", /models/);
		assert.equal(targets[2]?.command, "");
		assert.match(targets[1]?.command ?? "", /DLE_MODELS=/);
		cfg.worker.extraArgs = ["--model=old-full-id", "--model", "opus", "--agents", "{}"];
		targets = sessionTargets(cfg, projects, ledger);
		assert.match(targets[1]?.command ?? "", /--model=old-full-id --model opus --agents '\{\}'$/);
		assert.doesNotMatch(targets[1]?.command ?? "", /--model haiku/);
		assert.equal(targets[1]?.startupError, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("M4/H2: fake claude の実argvでモデルと上書き・DLE_MODELSを照合する（N=3）", () => {
	for (let trial = 0; trial < 3; trial++) {
		const root = mkdtempSync(path.join(os.tmpdir(), "dle-argv62-")),
			home = path.join(root, "home");
		mkdirSync(home);
		try {
			writeFileSync(
				path.join(home, "config.json"),
				JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"], worker: { model: "old-full-id" } }),
			);
			const cfg = loadConfig(home);
			const out = path.join(root, "argv.json");
			cfg.claudeBin = path.join(root, "claude");
			writeFileSync(
				cfg.claudeBin,
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({args:process.argv.slice(2),models:JSON.parse(process.env.DLE_MODELS)}));\n`,
				{ mode: 0o755 },
			);
			mkdirSync(path.join(root, "repo"));
			const project: Project = {
				name: "p",
				repo: "x/y",
				path: path.join(root, "repo"),
				active: true,
				mode: "harness",
				addedAt: "",
			};
			for (const extra of [[], ["--model=legacy-extra", "--model", "opus", "--agents", "{}"]]) {
				cfg.worker.extraArgs = extra;
				const target = sessionTargets(cfg, [project])[1];
				assert.ok(target);
				assert.equal(target.startupError, undefined);
				const run = spawnSync("bash", ["-c", target.command], { cwd: root, encoding: "utf8" });
				assert.equal(run.status, 0, run.stderr);
				const result = JSON.parse(readFileSync(out, "utf8"));
				assert.deepEqual(result.models.values, { window: "sonnet", tick: "old-full-id", spec: "opus", review: "opus" });
				const args = result.args as string[];
				if (extra.length) {
					assert.deepEqual(args.slice(-extra.length), extra);
					assert.equal(args.filter((a) => a === "--model" || a.startsWith("--model=")).length, 2);
				} else {
					assert.equal(args.filter((a) => a === "--model").length, 1);
					assert.equal(args[args.indexOf("--model") + 1], "old-full-id");
				}
				assert.equal(args[args.indexOf("--add-dir") + 1], `${home}-worktrees/p`);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
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
		concierge: {
			model: "sonnet",
			extraArgs: [],
			allowedTools: [],
			refresh: { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 },
		},
		worker: {
			model: null,
			extraArgs: [],
			initialPrompt: "/discord-loop-engine:issue-loop",
			refresh: {
				enabled: true,
				maxTokens: 100000,
				contextPercent: 15,
				idleSeconds: 180,
				cooldownMinutes: 30,
				codexIgnoreAfterMinutes: 120,
			},
		},
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
		concierge: {
			model: "sonnet",
			extraArgs: [],
			allowedTools: [],
			refresh: { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 },
		},
		worker: {
			model: null,
			extraArgs: ["--permission-mode", "acceptEdits"],
			refresh: {
				enabled: true,
				maxTokens: 100000,
				contextPercent: 15,
				idleSeconds: 180,
				cooldownMinutes: 30,
				codexIgnoreAfterMinutes: 120,
			},
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
	for (const target of [c, k, o]) {
		assert.ok(target?.command.includes(`DLE_HOME=${home} `));
		assert.ok(target?.command.includes(`DLE_CONFIG_HOME=${home} `));
		assert.ok(target?.command.includes(`DLE_SOCKET=${cfg.socketPath} `));
	}
	assert.match(
		c?.command ?? "",
		/DLE_ROLE=concierge claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle /,
	);
	assert.match(c?.command ?? "", /'Bash\(gh issue create:\*\)'/);
	assert.equal(c?.initialPrompt, "/discord-loop-engine:concierge");

	assert.equal(k?.refresh, undefined);
	assert.equal(o?.refresh, undefined);
	assert.equal(c?.refresh?.prompt, "/discord-loop-engine:concierge refresh");
	assert.equal(k?.initialPrompt, "/discord-loop-engine:onboard", "設定が無ければ調査から");
	assert.match(k?.command ?? "", /DLE_ROLE=worker DLE_PROJECT=kishimen-tool DLE_LOOP=harness claude /);
	assert.match(k?.command ?? "", /'Bash\(harness-merge:\*\)'.* --permission-mode acceptEdits$/);

	assert.match(k?.command ?? "", /'Bash\(harness-issue-md:\*\)'/);
	assert.match(k?.command ?? "", /'Bash\(harness-codex-status:\*\)'/, "読み取り専用の確認は無人で通す");
	// #50: 起動の入口は start / stop だけを許可する（引数と所有はラッパーが検証する）
	assert.match(k?.command ?? "", /'Bash\(harness-codex start:\*\)'/, "Codex の起動はラッパー経由だけ許可");
	assert.match(k?.command ?? "", /'Bash\(harness-codex stop:\*\)'/);
	// T17d: サブコマンド全体の許可や、直接起動・判定回避用の mode は渡さない。
	for (const permission of ["Bash(harness-codex:*)", "Bash(tmux new-window:*)", "Bash(codex exec:*)"])
		assert.ok(!k?.command.includes(permission), permission);
	assert.doesNotMatch(
		k?.command ?? "",
		/Bash\([^)]*(?:harness-codex(?!-status| start:| stop:)(?:\s|:)|tmux\s+new-window|codex\s+exec)/,
	);
	assert.doesNotMatch(
		k?.command ?? "",
		/--permission-mode (?:bypassPermissions|dontAsk)|--dangerously-skip-permissions/,
	);
	assert.deepEqual(k?.command.match(/--permission-mode \S+/g), ["--permission-mode acceptEdits"]);

	assert.equal(o?.initialPrompt, "/parallel-cycle-loop", "native はそのリポジトリのループで始める");
	assert.equal(o?.tmuxSession, "dev");
	assert.match(o?.command ?? "", /DLE_LOOP=native/);
	assert.doesNotMatch(o?.command ?? "", /harness-merge/, "native にはハーネスの許可を渡さない");
	assert.doesNotMatch(o?.command ?? "", /harness-codex start/, "native には Codex 起動の許可も渡さない");

	// 設定が確定したら issue-loop で始め、設定の permissions も許可に加える
	mkdirSync(path.join(home, "projects", "kishimen-tool"), { recursive: true });
	writeFileSync(
		path.join(home, "projects", "kishimen-tool", "harness.json"),
		JSON.stringify({ gate: [], permissions: ["Bash(cargo:*)"] }),
	);
	const k2 = sessionTargets(cfg, projects, ledger)[1];
	assert.equal(k2?.refresh?.prompt, cfg.worker.initialPrompt);
	assert.equal(k2?.refresh?.maxTokens, 100000);
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
		concierge: {
			model: "sonnet",
			extraArgs: [],
			allowedTools: [],
			refresh: { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 },
		},
		worker: {
			model: null,
			extraArgs: [],
			initialPrompt: "/discord-loop-engine:issue-loop",
			refresh: {
				enabled: true,
				maxTokens: 100000,
				contextPercent: 15,
				idleSeconds: 180,
				cooldownMinutes: 30,
				codexIgnoreAfterMinutes: 120,
			},
		},
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

test("enabled: false と旧 maxEvents: 0 の窓口には refresh を配線しない", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-disabled-"));
	writeFileSync(
		path.join(home, "config.json"),
		JSON.stringify({
			channelIds: ["1"],
			allowedUserIds: ["2"],
			concierge: { refresh: { maxEvents: 0 } },
			worker: { refresh: { enabled: false } },
		}),
	);
	const c = loadConfig(home);
	const targets = sessionTargets(c, [
		{ name: "worker", path: "/w", repo: "x/y", mode: "harness", active: true, addedAt: "" },
	]);
	assert.ok(targets.every((t) => t.refresh === undefined));
});

test("W6: --add-dir・exec env の実argv/cwd/PID、sh/dash、mkdir失敗とrepo優先", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-launch-"));
	const home = path.join(dir, "home space 'quoted'"),
		main = path.join(dir, "main");
	mkdirSync(home);
	mkdirSync(main);
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
	const cfg = loadConfig(home);
	const ledger = new Ledger(home);
	const p: Project = { name: "registered", path: main, repo: "x/y", active: true, mode: "harness", addedAt: "" };
	const profile = ledger.profilePath(p.name);
	mkdirSync(path.dirname(profile), { recursive: true });
	const stub = path.join(dir, "claude");
	const ready = path.join(dir, "ready"),
		release = path.join(dir, "release");
	writeFileSync(
		stub,
		`#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),configHome:process.env.DLE_CONFIG_HOME,exists:fs.existsSync(process.argv[process.argv.indexOf('--add-dir')+1])}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`,
		{ mode: 0o755 },
	);
	cfg.claudeBin = stub;
	try {
		for (const root of [undefined, ".worktrees", "../outside space", path.join(dir, "absolute 'quoted'")]) {
			writeFileSync(profile, JSON.stringify({ worktreeRoot: root }));
			const expected = root === undefined ? `${home}-worktrees/registered` : path.resolve(main, root);
			const [c, t] = sessionTargets(cfg, [p], ledger);
			assert.ok(t);
			assert.match(t.command, /&& exec env /);
			assert.ok(t.command.includes("--add-dir"));
			assert.equal(t.refresh?.worktreeRoot, expected);
			assert.doesNotMatch(c?.command ?? "", /--add-dir/);
			for (const shell of ["sh", "dash"]) {
				rmSync(ready, { force: true });
				rmSync(release, { force: true });
				const child: ReturnType<typeof spawn> = spawn(shell, ["-c", t.command], {
					cwd: main,
					env: { ...process.env, DLE_CONFIG_HOME: path.join(dir, "other") },
				});
				const done = once(child, "close");
				try {
					const r = JSON.parse(await waitForContent(ready, { label: t.command }));
					assert.equal(r.pid, child.pid);
					assert.equal(r.cwd, main);
					assert.equal(r.configHome, home);
					assert.equal(r.exists, true);
					assert.equal(r.argv.filter((x: string) => x === "--add-dir").length, 1);
					assert.equal(r.argv[r.argv.indexOf("--add-dir") + 1], expected);
					writeFileSync(release, "");
					assert.equal((await done)[0], 0);
				} finally {
					writeFileSync(release, "");
					child.kill("SIGKILL");
					await done;
				}
			}
		}
		rmSync(ready, { force: true });
		writeFileSync(path.join(dir, "file"), "");
		writeFileSync(profile, JSON.stringify({ worktreeRoot: path.join(dir, "file/child") }));
		const t = sessionTargets(cfg, [p], ledger)[1];
		assert.ok(t);
		const r = spawnSync("sh", ["-c", t.command], { cwd: main, env: process.env });
		assert.notEqual(r.status, 0);
		assert.equal(existsSync(ready), false);
		for (const value of [1, false, [], {}]) {
			writeFileSync(profile, JSON.stringify({ worktreeRoot: value }));
			const bad = sessionTargets(cfg, [p], ledger)[1];
			assert.match(bad?.startupError ?? "", /registered.*worktreeRoot.*文字列/);
			assert.equal(bad?.refresh, undefined);
			assert.equal(bad?.command, "");
		}
		writeFileSync(profile, '{"worktreeRoot":".worktrees"}');
		assert.equal(ledger.profile(p)?.worktreeRoot, ".worktrees");
		assert.match(sessionTargets(cfg, [p], ledger)[1]?.command ?? "", /\.worktrees/);
		mkdirSync(path.join(main, ".claude"));
		writeFileSync(path.join(main, ".claude/harness.json"), '{"worktreeRoot":"../repo-wins"}');
		assert.equal(sessionTargets(cfg, [p], ledger)[1]?.refresh?.worktreeRoot, path.join(dir, "repo-wins"));
		cfg.worker.refresh.enabled = false;
		assert.match(sessionTargets(cfg, [p], ledger)[1]?.command ?? "", /--add-dir/);
		rmSync(path.join(main, ".claude/harness.json"));
		rmSync(profile);
		assert.match(sessionTargets(cfg, [p], ledger)[1]?.command ?? "", /--add-dir/);
		assert.equal(sessionTargets(cfg, [p], ledger)[1]?.refresh, undefined);
		assert.doesNotMatch(sessionTargets(cfg, [{ ...p, mode: "native" }], ledger)[1]?.command ?? "", /--add-dir/);
		cfg.home = path.join(main, "inside");
		const bad = sessionTargets(cfg, [p], ledger)[1];
		assert.match(bad?.startupError ?? "", /worktreeRoot.*既定候補.*main/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("W6: 実targetの型/既定配置エラーはsupervisorで初回診断し起動とrefreshを抑止", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-startup-"));
	const home = path.join(dir, "home"),
		main = path.join(dir, "main");
	mkdirSync(home);
	mkdirSync(main);
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
	const cfg = loadConfig(home),
		ledger = new Ledger(home);
	const p: Project = { name: "bad", repo: "x/y", path: main, active: true, mode: "harness", addedAt: "" };
	const good = { ...p, name: "good", path: path.join(dir, "good") };
	const f = ledger.profilePath("bad");
	mkdirSync(path.dirname(f), { recursive: true });
	try {
		for (const value of [7, undefined]) {
			cfg.home = value === undefined ? path.join(main, "inside") : home;
			writeFileSync(f, JSON.stringify({ worktreeRoot: value }));
			const targets = () => sessionTargets(cfg, [p, good], ledger);
			const t = targets().find((t) => t.name === "bad");
			assert.ok(t?.startupError);
			assert.equal(t.refresh, undefined);
			const logs: string[] = [],
				notes: string[] = [],
				calls: string[][] = [];
			const sup = new Supervisor({
				tmuxSession: "test",
				targets,
				tmux: async (args) => {
					calls.push(args);
					return { ok: true, stdout: "" };
				},
				isLive: () => false,
				log: (s) => logs.push(s),
				notify: (_n, s) => notes.push(s),
			});
			await sup.tick();
			const first = notes.length;
			await sup.tick();
			assert.equal(notes.length, first);
			assert.equal(notes.length, 1);
			const reason = value === undefined ? /bad.*worktreeRoot.*既定候補.*main\/DLE_HOME/ : /bad.*worktreeRoot.*文字列/;
			assert.ok(logs.some((s) => reason.test(s)));
			assert.match(notes[0] ?? "", reason);
			assert.ok(!calls.some((c) => c.includes("dle-bad")));
			assert.ok(calls.some((c) => c.includes("dle-good")));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("起こしの対象（wake）は harness・ready の worker にだけ付き、送る文字列は持たない", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-t-"));
	const ledger = new Ledger(home);
	const repo = path.join(home, "r");
	mkdirSync(path.join(repo, ".claude"), { recursive: true });
	writeFileSync(path.join(repo, ".claude", "harness.json"), "{}");
	const mk = (enabled?: boolean) =>
		({
			home,
			socketPath: `${home}/engine.sock`,
			claudeBin: "claude",
			concierge: { model: "sonnet", extraArgs: [], allowedTools: [], refresh: { enabled: false } },
			worker: {
				model: null,
				extraArgs: [],
				initialPrompt: "/discord-loop-engine:issue-loop",
				refresh: { enabled: false },
				...(enabled === undefined ? {} : { wake: { enabled } }),
			},
		}) as unknown as Config;
	const base = { repo: "x/y", active: true, addedAt: "" };
	const projects: Project[] = [
		{ ...base, name: "ready", path: repo, mode: "harness" },
		{ ...base, name: "onboard", path: "/w/o", mode: "harness" },
		{ ...base, name: "native", path: "/w/n", mode: "native", initialPrompt: "/x" },
	];
	const wake = (cfg: Config) => Object.fromEntries(sessionTargets(cfg, projects, ledger).map((t) => [t.name, t.wake]));
	assert.deepEqual(wake(mk()), {
		concierge: undefined,
		ready: { enabled: true },
		onboard: undefined,
		native: undefined,
	});
	assert.equal(wake(mk(false)).ready, undefined, "enabled:false は付けない");
	assert.deepEqual(Object.keys(wake(mk()).ready ?? {}), ["enabled"], "prompt は持たない");
});

// ---- #82: worker の permission mode ----
// OFF の経路の期待値は、変更前（origin/main）のコードから同じ入力で作った command の固定値。
// 変更後のコードで取り直さない。ずれたら固定値ではなく実装を疑う。<HOME> は一時ディレクトリに置き換えて比べる。
const MAIN_CONCIERGE =
	'env DLE_MODELS=\'{"values":{"window":"sonnet","tick":"sonnet","spec":"opus","review":"opus"},"sources":{"window":"legacy","tick":"default","spec":"default","review":"default"},"warnings":[]}\' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_ROLE=concierge claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle \'Bash(gh issue create:*)\' \'Bash(gh issue view:*)\' \'Bash(gh issue list:*)\' \'Bash(gh issue comment:*)\' \'Bash(gh pr view:*)\' \'Bash(gh pr list:*)\' \'Bash(gh pr checks:*)\'';

const MAIN_DEFAULT_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const AUTO_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --permission-mode auto --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const ACCEPT_EDITS_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --permission-mode acceptEdits --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const MAIN_DEFAULT_N =
	"env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=n DLE_LOOP=native claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const AUTO_N =
	"env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=n DLE_LOOP=native claude --model sonnet --permission-mode auto --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const MAIN_DEFAULT_READY_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const AUTO_READY_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --permission-mode auto --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const ACCEPT_EDITS_READY_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --permission-mode acceptEdits --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)'";

const MAIN_EXTRA_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)' --permission-mode acceptEdits";

const MAIN_EXTRA_EQ_H =
	"mkdir -p -- <HOME>-worktrees/h && exec env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=h DLE_LOOP=harness claude --add-dir <HOME>-worktrees/h --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(harness-config:*)' 'Bash(harness-hook:*)' 'Bash(harness-phase:*)' 'Bash(harness-inbox:*)' 'Bash(harness-gate:*)' 'Bash(harness-merge:*)' 'Bash(harness-status:*)' 'Bash(harness-notify:*)' 'Bash(harness-labels:*)' 'Bash(harness-issue-md:*)' 'Bash(harness-codex-status:*)' 'Bash(harness-codex start:*)' 'Bash(harness-codex stop:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)' --permission-mode=plan";

const MAIN_EXTRA_N =
	"env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=n DLE_LOOP=native claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)' --permission-mode acceptEdits";

const MAIN_EXTRA_EQ_N =
	"env DLE_MODELS='{\"values\":{\"window\":\"sonnet\",\"tick\":\"sonnet\",\"spec\":\"opus\",\"review\":\"opus\"},\"sources\":{\"window\":\"legacy\",\"tick\":\"default\",\"spec\":\"default\",\"review\":\"default\"},\"warnings\":[]}' DLE_HOME=<HOME> DLE_CONFIG_HOME=<HOME> DLE_SOCKET=<HOME>/engine.sock DLE_MODEL_PROFILE='' DLE_ROLE=worker DLE_PROJECT=n DLE_LOOP=native claude --model sonnet --dangerously-load-development-channels plugin:discord-loop-engine@discord-loop-engine --allowedTools mcp__plugin_discord-loop-engine_dle 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(wc:*)' 'Bash(find:*)' 'Bash(grep:*)' 'Bash(rg:*)' 'Bash(jq:*)' 'Bash(git status:*)' 'Bash(git log:*)' 'Bash(git diff:*)' 'Bash(git show:*)' 'Bash(git branch:*)' 'Bash(git rev-parse:*)' 'Bash(gh issue view:*)' 'Bash(gh issue list:*)' 'Bash(gh pr view:*)' 'Bash(gh pr list:*)' 'Bash(gh pr checks:*)' 'Bash(gh run list:*)' 'Bash(gh run view:*)' --permission-mode=plan";

function pmTargets(
	workerExtra: { permissionMode?: Config["worker"]["permissionMode"]; extraArgs?: string[] },
	overrides: Partial<Project> = {},
	only?: "h" | "n",
) {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-pm-"));
	try {
		const cfg = {
			home,
			socketPath: `${home}/engine.sock`,
			claudeBin: "claude",
			concierge: { model: "sonnet", extraArgs: [], allowedTools: [], refresh: { enabled: false } },
			worker: {
				model: null,
				extraArgs: workerExtra.extraArgs ?? [],
				...("permissionMode" in workerExtra ? { permissionMode: workerExtra.permissionMode } : {}),
				refresh: { enabled: false },
				initialPrompt: "/discord-loop-engine:issue-loop",
			},
		} as unknown as Config;
		const base = { repo: "x/y", active: true, addedAt: "" };
		const projects: Project[] = [
			{ ...base, name: "h", path: "/w/h", mode: "harness", ...(only === "h" ? overrides : {}) },
			{ ...base, name: "n", path: "/w/n", mode: "native", initialPrompt: "/x", ...(only === "n" ? overrides : {}) },
		];
		const norm = (t: { command: string; startupError?: string }) => ({
			command: t.command.split(home).join("<HOME>"),
			startupError: t.startupError,
		});
		const [c, h, n] = sessionTargets(cfg, projects, new Ledger(home)).map(norm);
		// ledger なし = 設定済み（ready）の経路
		const readyH = sessionTargets(cfg, projects.slice(0, 1))[1];
		return { c, h, n, readyH: readyH ? norm(readyH) : undefined };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("T2: 既定は --permission-mode auto を --model の直後に入れる（窓口は変えない）", () => {
	const t = pmTargets({});
	assert.equal(t.c?.command, MAIN_CONCIERGE);
	assert.equal(t.h?.command, AUTO_H);
	assert.equal(t.n?.command, AUTO_N);
	assert.equal(t.readyH?.command, AUTO_READY_H);
	assert.equal(pmTargets({ permissionMode: "auto" }).h?.command, AUTO_H);
});

test("T3: 全体で null にすると、窓口・worker とも変更前の command と完全一致する", () => {
	const t = pmTargets({ permissionMode: null });
	assert.equal(t.c?.command, MAIN_CONCIERGE);
	assert.equal(t.h?.command, MAIN_DEFAULT_H);
	assert.equal(t.n?.command, MAIN_DEFAULT_N);
	assert.equal(t.readyH?.command, MAIN_DEFAULT_READY_H);
});

test("T4: プロジェクトの permissionMode が全体設定より優先される", () => {
	// (a) 全体 auto + h だけ null
	const a = pmTargets({}, { permissionMode: null }, "h");
	assert.equal(a.c?.command, MAIN_CONCIERGE);
	assert.equal(a.h?.command, MAIN_DEFAULT_H);
	assert.equal(a.n?.command, AUTO_N);
	// (b) acceptEdits
	const b = pmTargets({}, { permissionMode: "acceptEdits" }, "h");
	assert.equal(b.h?.command, ACCEPT_EDITS_H);
	assert.equal(b.n?.command, AUTO_N);
	assert.equal(b.c?.command, MAIN_CONCIERGE);
	// (c) 全体 null + n だけ auto
	const c = pmTargets({ permissionMode: null }, { permissionMode: "auto" }, "n");
	assert.equal(c.n?.command, AUTO_N);
	assert.equal(c.h?.command, MAIN_DEFAULT_H);
	assert.equal(c.c?.command, MAIN_CONCIERGE);
	// 設定済みの経路でも同じ（ledger なしで h のみ）
	assert.equal(b.readyH?.command, ACCEPT_EDITS_READY_H);
});

test("T6: 不正なプロジェクト値はその target だけ起動せず、設定で bypass 系は選べない", () => {
	for (const permissionMode of ["bypassPermissions", "dontAsk"] as unknown as Project["permissionMode"][]) {
		const t = pmTargets({}, { permissionMode }, "h");
		assert.equal(t.h?.command, "");
		assert.match(t.h?.startupError ?? "", /h: .*permissionMode/);
		assert.equal(t.n?.command, AUTO_N, "他のプロジェクトは起動する");
	}
	const ok = [
		pmTargets({}),
		pmTargets({ permissionMode: null }),
		pmTargets({}, { permissionMode: "acceptEdits" }, "h"),
		pmTargets({ permissionMode: null }, { permissionMode: "auto" }, "n"),
	];
	for (const t of ok)
		for (const x of [t.c, t.h, t.n, t.readyH])
			assert.doesNotMatch(x?.command ?? "", /bypassPermissions|dontAsk|--dangerously-skip-permissions/);
});

test("T7: extraArgs に mode があれば engine は足さず、変更前の command と完全一致する", () => {
	for (const permissionMode of [undefined, "acceptEdits", null] as const) {
		const e1 = pmTargets({ permissionMode, extraArgs: ["--permission-mode", "acceptEdits"] });
		assert.equal(e1.c?.command, MAIN_CONCIERGE);
		assert.equal(e1.h?.command, MAIN_EXTRA_H);
		assert.equal(e1.n?.command, MAIN_EXTRA_N);
		const e2 = pmTargets({ permissionMode, extraArgs: ["--permission-mode=plan"] });
		assert.equal(e2.c?.command, MAIN_CONCIERGE);
		assert.equal(e2.h?.command, MAIN_EXTRA_EQ_H);
		assert.equal(e2.n?.command, MAIN_EXTRA_EQ_N);
	}
});
