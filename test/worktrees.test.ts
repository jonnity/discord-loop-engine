import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveWorktreeRoot } from "../src/worktrees.ts";

const config = path.resolve("bin/harness-config");
test("W1/W2: Bash/TS の共通パス契約、外部既定、明示互換、型と配置検証", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-w-"));
	const main = path.join(dir, "different-basename");
	mkdirSync(path.join(main, ".claude"), { recursive: true });
	const file = path.join(main, ".claude/harness.json");
	const cases = [
		{ value: undefined, expected: `${dir}/home-worktrees/registered` },
		{ value: null, expected: `${dir}/home-worktrees/registered` },
		{ value: "", expected: `${dir}/home-worktrees/registered` },
		{ value: ".worktrees", expected: `${main}/.worktrees` },
		{ value: "../outside worktrees/p/./child/..", expected: `${dir}/outside worktrees/p` },
		{ value: `${dir}/absolute 'root'/../final`, expected: `${dir}/final` },
	];
	const env = {
		...process.env,
		CLAUDE_PROJECT_DIR: main,
		HARNESS_CONFIG: file,
		DLE_HOME: "../home/./",
		DLE_PROJECT: "registered",
	};
	const bash = (args: string[], extra = {}) =>
		spawnSync(config, args, { cwd: main, env: { ...env, ...extra }, encoding: "utf8" });
	try {
		for (const { value, expected } of cases) {
			writeFileSync(file, JSON.stringify({ project: "repo-name", worktreeRoot: value }));
			assert.equal(
				resolveWorktreeRoot({ repoRoot: main, home: "../home/./", project: "registered", worktreeRoot: value }),
				expected,
			);
			assert.equal(bash(["--worktree-root"]).stdout, `${expected}\n`);
			assert.equal(bash(["--worktree", "9"]).stdout, `${expected}/issue-9\n`);
			assert.equal(existsSync(expected), false, "参照で mkdir しない");
		}
		for (const value of [1, false, [], {}]) {
			writeFileSync(file, JSON.stringify({ worktreeRoot: value }));
			assert.throws(
				() => resolveWorktreeRoot({ repoRoot: main, home: dir, project: "p", worktreeRoot: value }),
				/worktreeRoot.*文字列/,
			);
			const r = bash(["--worktree-root"]);
			assert.notEqual(r.status, 0);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /worktreeRoot.*文字列/);
		}
		for (const value of ["~", "~/wt", "~user/wt", "$", "$HOME/wt", `\${HOME}/wt`]) {
			writeFileSync(file, JSON.stringify({ worktreeRoot: value }));
			const reason = /worktreeRoot.*先頭の ~ や \$ の展開は行わない.*展開済みの絶対パス/;
			assert.throws(
				() => resolveWorktreeRoot({ repoRoot: main, home: dir, project: "p", worktreeRoot: value }),
				reason,
			);
			for (const args of [["--worktree-root"], ["--worktree", "9"]]) {
				const r = bash(args);
				assert.notEqual(r.status, 0);
				assert.equal(r.stdout, "");
				assert.match(r.stderr, reason);
			}
		}
		writeFileSync(file, "{}");
		for (const project of ["", ".", "..", "p/q", "../escape", "p q"]) {
			assert.throws(() => resolveWorktreeRoot({ repoRoot: main, home: dir, project }), /DLE_PROJECT|登録名/);
			const r = bash(["--worktree-root"], { DLE_PROJECT: project });
			assert.notEqual(r.status, 0);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /DLE_PROJECT|登録名/);
		}
		writeFileSync(file, JSON.stringify({ project: "repo-name" }));
		assert.equal(bash(["--worktree-root"], { DLE_PROJECT: "" }).stdout, `${dir}/home-worktrees/repo-name\n`);
		for (const home of ["/", `${main}/inside`]) {
			assert.throws(
				() => resolveWorktreeRoot({ repoRoot: main, home, project: "registered" }),
				/既定候補.*main|DLE_HOME/,
			);
			const r = bash(["--worktree-root"], { DLE_HOME: home });
			assert.notEqual(r.status, 0);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /既定候補.*main\/DLE_HOME/);
		}
		assert.equal(
			bash(["--worktree-root"], { DLE_HOME: "", HOME: dir }).stdout,
			`${dir}/.discord-loop-engine-worktrees/registered\n`,
		);
		for (const n of ["0", "-1", "x", "1/../../x", "", "1.5"]) assert.equal(bash(["--worktree", n]).status, 2);
		assert.equal(bash(["--worktree", "9", "extra"]).status, 2);
		assert.equal(bash([".worktreeRoot", ".worktrees"]).stdout, ".worktrees\n");
		const one = resolveWorktreeRoot({ repoRoot: main, home: `${dir}/home/`, project: "one" });
		const two = resolveWorktreeRoot({ repoRoot: main, home: `${dir}/other`, project: "one" });
		const three = resolveWorktreeRoot({ repoRoot: main, home: `${dir}/home`, project: "two" });
		assert.equal(new Set([one, two, three]).size, 3);
		for (const ancestor of [main, `${dir}/home`]) assert.ok(!one.startsWith(`${ancestor}/`));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("W1/W2: 兄弟配置の祖先探索は偽Bot .envに届かず、登録名不明なら実statusも停止", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-ancestor-"));
	const main = path.join(dir, "local-checkout"),
		home = path.join(dir, "home 'space'");
	mkdirSync(path.join(main, ".claude"), { recursive: true });
	mkdirSync(home);
	const file = path.join(main, ".claude/harness.json");
	writeFileSync(file, JSON.stringify({ project: "registered-p" }));
	writeFileSync(path.join(home, ".env"), "FAKE_BOT_SENTINEL");
	const env = {
		...process.env,
		CLAUDE_PROJECT_DIR: main,
		HARNESS_CONFIG: "",
		DLE_HOME: `${home}/`,
		DLE_PROJECT: "registered-p",
	};
	const bash = (args: string[], extra = {}) =>
		spawnSync(config, args, { cwd: main, env: { ...env, ...extra }, encoding: "utf8" });
	try {
		const expected = `${home}-worktrees/registered-p`;
		assert.equal(bash(["--worktree-root"]).stdout, `${expected}\n`);
		assert.equal(bash(["--worktree-root"], { DLE_PROJECT: "" }).stdout, `${expected}\n`);
		assert.equal(bash(["--worktree", "9"]).stdout, `${expected}/issue-9\n`);
		const wt = `${expected}/issue-9`;
		mkdirSync(wt, { recursive: true });
		for (const start of [expected, wt]) {
			const ancestors: string[] = [];
			for (let current = start; ; current = path.dirname(current)) {
				ancestors.push(current);
				if (current === path.dirname(current)) break;
			}
			assert.equal(ancestors.includes(home), false);
			assert.equal(ancestors.includes(main), false);
		}
		const scan = `const fs=require('node:fs'),p=require('node:path');const found=[];for(let d=process.cwd();;d=p.dirname(d)){if(d===process.argv[1]||d.startsWith(process.argv[1]+'/')){const f=p.join(d,'.env');if(fs.existsSync(f))found.push(fs.readFileSync(f,'utf8'));}if(d===p.dirname(d))break;}console.log(JSON.stringify(found));`;
		const probe = (cwd: string) => spawnSync(process.execPath, ["-e", scan, dir], { cwd, env, encoding: "utf8" });
		assert.deepEqual(JSON.parse(probe(wt).stdout), []);
		const control = path.join(home, "child");
		mkdirSync(control);
		assert.deepEqual(JSON.parse(probe(control).stdout), ["FAKE_BOT_SENTINEL"]);
		for (const h of [`${home}/`, `${dir}/second-home/./`])
			for (const project of ["registered-p", "other-p"]) {
				const expected = resolveWorktreeRoot({ repoRoot: main, home: h, project });
				assert.equal(bash(["--worktree-root"], { DLE_HOME: h, DLE_PROJECT: project }).stdout, `${expected}\n`);
			}
		writeFileSync(file, JSON.stringify({ worktreeRoot: ".worktrees" }));
		assert.equal(bash(["--worktree-root"], { DLE_PROJECT: "" }).stdout, `${main}/.worktrees\n`);
		const fromWT = spawnSync(config, ["--worktree-root"], { cwd: wt, env, encoding: "utf8" });
		assert.equal(fromWT.stdout, `${main}/.worktrees\n`);
		writeFileSync(file, "{}");
		mkdirSync(path.join(home, "projects/registered-p"), { recursive: true });
		writeFileSync(path.join(home, "projects/registered-p/harness.json"), '{"project":"registered-p"}');
		for (const [command, args] of [
			[config, ["--worktree-root"]],
			[path.resolve("bin/harness-status"), []],
			[path.resolve("bin/harness-codex-status"), ["status", "codex-impl-9"]],
		] as [string, string[]][]) {
			const r = spawnSync(command, args, {
				cwd: main,
				env: { ...env, DLE_PROJECT: "", PATH: `${path.resolve("tests/harness/fixtures")}:${process.env.PATH}` },
				encoding: "utf8",
			});
			assert.notEqual(r.status, 0);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /登録名.*DLE_PROJECT/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
