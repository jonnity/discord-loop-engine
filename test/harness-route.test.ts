import "./isolate.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	classifyChanges,
	classifyRepository,
	type FileChange,
	parseClassifyArgs,
	parseRawDiff,
	reviewMatches,
	routeTransition,
} from "../src/harness-route.ts";
import { waitForContent } from "./wait-file.ts";

const text = (s: string) => Buffer.from(s);
const file = (p: string, before: Buffer | null = text("before"), after: Buffer | null = text("after")): FileChange => ({
	path: p,
	status: before === null ? "A" : after === null ? "D" : "M",
	oldMode: before === null ? "000000" : "100644",
	newMode: after === null ? "000000" : "100644",
	before,
	after,
});
const classify = (changes: FileChange[]) => classifyChanges([changes]).route;

test("R1/R2/R5: 文書の追加/削除と禁止ディレクトリ・指示・コード・型・文字コード", () => {
	for (const p of ["README.md", "docs/a.md", "docs/a.txt", "空 白\n日本語.md", "-docs.md"])
		for (const [a, b] of [
			[null, text("x")],
			[text("x"), null],
			[text("x"), text("y")],
		] as const)
			assert.equal(classify([file(p, a, b)]), "light", p);
	for (const p of [
		"bin/a.md",
		"hooks/a.md",
		"skills/a.md",
		"agents/a.md",
		"templates/a.md",
		".github/a.md",
		".harness/a.md",
		".claude/a.md",
		"docs/x.ts",
		"docs/x.sh",
		"docs/x.json",
		"docs/x.yaml",
		"docs/a.pdf",
		"CLAUDE.md",
		"docs/AGENTS.md",
		"SKILL.md",
		".hidden.md",
		"src/x.ts",
	])
		assert.equal(classify([file(p)]), "normal", p);
	for (const f of [
		{ ...file("a.md"), newMode: "100755" },
		{ ...file("a.md"), oldMode: "120000" },
		file("a.md", text("x"), Buffer.from([0xff])),
		file("a.md", text("x"), text("x\0y")),
		file("a.md", text("x"), Buffer.alloc(10 * 1024 * 1024 + 1, 32)),
		{ ...file("a.md"), status: "U" },
	])
		assert.equal(classify([f]), "normal");
	assert.equal(classify([]), "normal");
	assert.equal(classify([file("old.ts", text("x"), null), file("new.md", null, text("x"))]), "normal");
	assert.equal(classifyChanges([[file("x.ts")], [file("x.ts", text("after"), text("before"))]]).route, "normal");
});

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
function pair(kind = "devDependencies", before = "1.0.0", after = "1.0.1") {
	const manifest = (v: string) => ({ name: "test", version: "1.0.0", [kind]: { a: v } });
	const lock = (v: string) => ({
		name: "test",
		version: "1.0.0",
		lockfileVersion: 3,
		packages: {
			"": manifest(v),
			"node_modules/a": { version: v, resolved: `https://registry.npmjs.org/a/-/a-${v}.tgz`, integrity },
		},
	});
	return [
		file("package.json", text(JSON.stringify(manifest(before))), text(JSON.stringify(manifest(after)))),
		file("package-lock.json", text(JSON.stringify(lock(before))), text(JSON.stringify(lock(after)))),
	];
}
test("R3/R4/R9: manifest/lock の全層の整合・重複・特殊指定・registry・integrity", () => {
	for (const kind of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
		assert.equal(classify(pair(kind)), "light");
	const edit = (index: number, change: (v: Record<string, unknown>) => void) => {
		const files = pair();
		const f = files[index];
		assert.ok(f?.after);
		const v = JSON.parse(f.after.toString());
		change(v);
		f.after = text(JSON.stringify(v));
		return files;
	};
	assert.equal(classify(pair().slice(0, 1)), "normal");
	assert.equal(classify(pair().slice(1)), "normal");
	assert.equal(
		classify(
			edit(0, (v) => {
				v.scripts = { test: "evil" };
			}),
		),
		"normal",
	);
	assert.equal(
		classify(
			edit(0, (v) => {
				v.dependencies = { newRuntime: "1.0.0" };
			}),
		),
		"normal",
	);
	assert.equal(
		classify(
			edit(1, (v) => {
				v.lockfileVersion = 2;
			}),
		),
		"normal",
	);
	for (const resolved of [
		"http://registry.npmjs.org/a.tgz",
		"https://registry.npmjs.org.evil/a.tgz",
		"https://u:p@registry.npmjs.org/a.tgz",
		"https://registry.npmjs.org:444/a.tgz",
		"https://registry.npmjs.org/a.tgz?x=1",
		"https://registry.npmjs.org/a.tgz#x",
		"file:a",
		"git+https://example.com/a",
	]) {
		assert.equal(
			classify(
				edit(1, (v) => {
					const p = v.packages as Record<string, Record<string, unknown>>;
					const a = p["node_modules/a"];
					assert.ok(a);
					a.resolved = resolved;
				}),
			),
			"normal",
			resolved,
		);
	}
	for (const bad of ["sha512-bad", undefined, "sha256-abc"])
		assert.equal(
			classify(
				edit(1, (v) => {
					const p = v.packages as Record<string, Record<string, unknown>>;
					const a = p["node_modules/a"];
					assert.ok(a);
					a.integrity = bad;
				}),
			),
			"normal",
		);
	const duplicate = pair();
	const f = duplicate[0];
	assert.ok(f?.after);
	f.after = text('{"devDependencies":{"a":"1.0.1","a":"1.0.2"}}');
	assert.equal(classify(duplicate), "normal");
	const unchanged = pair("devDependencies", "1.0.0", "1.0.0");
	assert.equal(classify(unchanged), "normal");
	assert.equal(classifyChanges([pair(), [file("package-lock.json")]]).route, "normal");
});

test("R3/R4/R9/U4: dev/peer/optional の追加削除・新 lock と旧 entry の検査", () => {
	for (const kind of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
		for (const remove of [false, true]) {
			const files = pair(kind);
			for (const f of files) {
				const side = remove ? "after" : "before";
				const data = f[side];
				assert.ok(data);
				const parsed = JSON.parse(data.toString());
				if (f.path === "package.json") delete parsed[kind];
				else {
					delete parsed.packages[""][kind];
					delete parsed.packages["node_modules/a"];
				}
				f[side] = text(JSON.stringify(parsed));
			}
			assert.equal(classify(files), "light", `${kind}/${remove}`);
		}
	}
	const fresh = pair();
	const lock = fresh[1];
	assert.ok(lock);
	lock.before = null;
	lock.oldMode = "000000";
	lock.status = "A";
	assert.equal(classify(fresh), "light");
	const scripts = pair();
	const scriptLock = scripts[1];
	assert.ok(scriptLock?.after);
	const scriptValue = JSON.parse(scriptLock.after.toString());
	scriptValue.packages["node_modules/a"].hasInstallScript = true;
	scriptLock.after = text(JSON.stringify(scriptValue));
	assert.equal(classify(scripts), "light");
	const old = pair();
	const oldLock = old[1];
	assert.ok(oldLock?.before);
	const value = JSON.parse(oldLock.before.toString());
	value.packages["node_modules/old"] = { version: "1.0.0", resolved: "https://evil.test/old.tgz", integrity };
	oldLock.before = text(JSON.stringify(value));
	assert.equal(classify(old), "normal");
	const mismatch = pair();
	const changed = mismatch[1];
	assert.ok(changed?.after);
	const newValue = JSON.parse(changed.after.toString());
	newValue.packages[""].devDependencies.a = "9.0.0";
	changed.after = text(JSON.stringify(newValue));
	assert.equal(classify(mismatch), "normal");
	const absent = pair();
	const manifest = absent[0];
	assert.ok(manifest);
	manifest.before = null;
	manifest.oldMode = "000000";
	manifest.status = "A";
	assert.equal(classify(absent), "normal");
	const repack = pair();
	const repackLock = repack[1];
	assert.ok(repackLock?.after);
	const repackValue = JSON.parse(repackLock.after.toString());
	repackValue.packages["node_modules/a"].resolved = "https://registry.npmjs.org/a/-/a-1.0.0.tgz";
	repackValue.packages["node_modules/a"].integrity = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
	repackLock.after = text(JSON.stringify(repackValue));
	assert.equal(classify(repack), "normal");
});

test("R7/R8/F2/F3: NUL parser・引数・昇格固定・レビュー失効", () => {
	assert.deepEqual(parseClassifyArgs(["--pr", "12", "--", "-docs"]), { dir: "-docs", pr: 12 });
	for (const args of [["--oops"], ["--pr"], ["--pr", "0"], ["--pr", "1", "--pr", "2"], ["a", "b"]])
		assert.throws(() => parseClassifyArgs(args));
	const raw = Buffer.from(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0空 白\n.md\0`);
	assert.equal(parseRawDiff(raw)[0]?.path, "空 白\n.md");
	assert.throws(() => parseRawDiff(Buffer.from("broken")));
	assert.deepEqual(routeTransition("light", "normal", false), { route: "normal", promoted: true });
	assert.deepEqual(routeTransition("normal", "light", true), { route: "normal", promoted: true });
	assert.deepEqual(routeTransition("normal", "light", false), { route: "light", promoted: false });
	assert.equal(
		reviewMatches(
			{
				version: 1,
				project: "p",
				issue: 1,
				fingerprint: "x",
				route: "light",
				model: "opus",
				reviewer: "verifier",
				verdict: "OK",
				artifact: "review.md",
			},
			{ project: "p", issue: 1, fingerprint: "x", route: "light" },
		),
		true,
	);
	assert.equal(
		reviewMatches(
			{ version: 1, project: "p", issue: 1, fingerprint: "old", verdict: "OK" },
			{ project: "p", issue: 1, fingerprint: "x", route: "light" },
		),
		false,
	);
});

test("R7: 分類 CLI の不正引数は2、設定/履歴取得失敗は副作用なし", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "route62-"));
	try {
		mkdirSync(path.join(dir, ".harness"));
		writeFileSync(path.join(dir, ".harness/gate-result.json"), "sentinel");
		const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_CONFIG: path.join(dir, "missing.json") };
		for (const args of [["--oops"], ["--pr", "1", "--pr", "2"]]) {
			const r = spawnSync(path.resolve("bin/harness-gate"), ["--classify", ...args], {
				cwd: dir,
				env,
				encoding: "utf8",
			});
			assert.equal(r.status, 2, r.stderr);
			assert.equal(r.stdout, "");
		}
		const r = spawnSync(path.resolve("bin/harness-gate"), ["--classify", dir], { env, encoding: "utf8" });
		assert.equal(r.status, 3, r.stderr);
		assert.equal(r.stdout, "");
		assert.equal(readFileSync(path.join(dir, ".harness/gate-result.json"), "utf8"), "sentinel");
		assert.equal(existsSync(path.join(dir, ".harness/route-1.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// 一時 repo 内の plumbing でだけ履歴と index を作る。実作業 repo の git 状態には触れない。
function repository() {
	const root = mkdtempSync(path.join(os.tmpdir(), "route62-git-"));
	const dir = path.join(root, "repo");
	mkdirSync(dir);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.test",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.test",
	};
	const git = (args: string[], input?: string | Buffer) =>
		execFileSync("git", ["-C", dir, ...args], { input, env, encoding: "utf8" }).trim();
	git(["init", "-q"]);
	writeFileSync(path.join(dir, ".git/info/exclude"), ".harness/\n");
	writeFileSync(
		path.join(dir, ".git/config"),
		`[core]\n repositoryformatversion = 0\n bare = false\n[remote "origin"]\n url = ${dir}/.git\n`,
	);
	const tree = (files: Record<string, string>): string => {
		const groups = new Map<string, Record<string, string>>();
		const entries: string[] = [];
		for (const [name, content] of Object.entries(files)) {
			const slash = name.indexOf("/");
			if (slash >= 0) {
				const part = name.slice(0, slash);
				const group = groups.get(part) ?? {};
				group[name.slice(slash + 1)] = content;
				groups.set(part, group);
			} else entries.push(`100644 blob ${git(["hash-object", "-w", "--stdin"], content)}\t${name}\0`);
		}
		for (const [name, group] of groups) entries.push(`040000 tree ${tree(group)}\t${name}\0`);
		return git(["mktree", "-z"], entries.join(""));
	};
	const commit = (files: Record<string, string>, parent?: string) =>
		git(
			["hash-object", "-w", "-t", "commit", "--stdin"],
			`tree ${tree(files)}\n${parent ? `parent ${parent}\n` : ""}author Test <test@example.test> 1700000000 +0000\ncommitter Test <test@example.test> 1700000000 +0000\n\nfixture\n`,
		);
	let previous: Record<string, string> = {};
	const work = (files: Record<string, string>) => {
		for (const p of Object.keys(previous)) if (!Object.hasOwn(files, p)) rmSync(path.join(dir, p), { force: true });
		for (const [p, data] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
			writeFileSync(path.join(dir, p), data);
		}
		previous = files;
	};
	const baseFiles = { "README.md": "old\n" },
		base = commit(baseFiles);
	mkdirSync(path.join(dir, ".git/refs/remotes/origin"), { recursive: true });
	writeFileSync(path.join(dir, ".git/refs/remotes/origin/main"), `${base}\n`);
	writeFileSync(path.join(dir, ".git/refs/heads/main"), `${base}\n`);
	writeFileSync(path.join(dir, ".git/HEAD"), "ref: refs/heads/feature\n");
	const head = (files: Record<string, string>, parent = base) => {
		const oid = commit(files, parent);
		writeFileSync(path.join(dir, ".git/refs/heads/feature"), `${oid}\n`);
		git(["read-tree", oid]);
		work(files);
		return oid;
	};
	const oid = head(baseFiles);
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	const config = path.join(root, "harness.json");
	writeFileSync(config, JSON.stringify({ project: "fixture", gate: [{ name: "never", run: "exit 99" }] }));
	return {
		root,
		dir,
		base,
		oid,
		git,
		head,
		tree,
		work,
		bin,
		env: { ...env, CLAUDE_PROJECT_DIR: dir, HARNESS_CONFIG: config, PATH: `${bin}:${env.PATH}` },
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("R6/R7/R8: 実累積/index/WT/未追跡を検査し fingerprint と内容 tree を照合する（N=3）", async () => {
	for (let trial = 0; trial < 3; trial++) {
		const h = repository();
		try {
			const files = { "README.md": "updated\n", "docs/空 白\n.md": "text" };
			h.head(files);
			const first = await classifyRepository(h.dir);
			assert.equal(first.route, "light", JSON.stringify(first));
			assert.equal(first.dirty, false);
			assert.equal((await classifyRepository(h.dir)).fingerprint, first.fingerprint);
			const cli = spawnSync(path.resolve("bin/harness-gate"), ["--classify", "--", h.dir], {
				env: h.env,
				encoding: "utf8",
			});
			assert.equal(cli.status, 0, cli.stderr);
			assert.equal(JSON.parse(cli.stdout).fingerprint, first.fingerprint);
			writeFileSync(path.join(h.dir, "note.md"), "untracked");
			const dirty = await classifyRepository(h.dir);
			assert.equal(dirty.route, "light");
			assert.equal(dirty.dirty, true);
			assert.notEqual(dirty.fingerprint, first.fingerprint);
			h.head({ ...files, "note.md": "untracked" });
			const committed = await classifyRepository(h.dir);
			assert.equal(committed.contentFingerprint, dirty.contentFingerprint);
			assert.notEqual(committed.fingerprint, dirty.fingerprint);
			const tree = h.tree({ ...files, "note.md": "untracked", "hidden.ts": "bad" });
			h.git(["read-tree", tree]);
			writeFileSync(path.join(h.dir, "hidden.ts"), "bad");
			assert.equal((await classifyRepository(h.dir)).route, "normal");
			h.git(["read-tree", "HEAD"]);
			rmSync(path.join(h.dir, "hidden.ts"));
			writeFileSync(path.join(h.dir, "README.md"), "dirty\n");
			assert.notEqual((await classifyRepository(h.dir)).fingerprint, committed.fingerprint);
			symlinkSync("README.md", path.join(h.dir, "linked.md"));
			assert.equal((await classifyRepository(h.dir)).route, "normal");
		} finally {
			h.close();
		}
	}
});

test("R5: core.filemode=false でも実行権と親 symlink を積極認定しない", async () => {
	const h = repository();
	try {
		h.head({ "README.md": "changed\n", "docs/note.md": "text" });
		h.git(["config", "core.filemode", "false"]);
		chmodSync(path.join(h.dir, "README.md"), 0o755);
		assert.equal((await classifyRepository(h.dir)).route, "normal");
		chmodSync(path.join(h.dir, "README.md"), 0o644);
		h.git(["update-index", "--assume-unchanged", "README.md"]);
		writeFileSync(path.join(h.dir, "README.md"), "hidden\0binary");
		assert.equal((await classifyRepository(h.dir)).route, "normal");
		h.git(["update-index", "--no-assume-unchanged", "README.md"]);
		writeFileSync(path.join(h.dir, "README.md"), "changed\n");
		rmSync(path.join(h.dir, "docs"), { recursive: true });
		mkdirSync(path.join(h.root, "outside"));
		writeFileSync(path.join(h.root, "outside/note.md"), "text");
		symlinkSync(path.join(h.root, "outside"), path.join(h.dir, "docs"));
		assert.equal((await classifyRepository(h.dir)).route, "normal");
	} finally {
		h.close();
	}
});

test("R7: remote base の移動・WT途中変更・API失敗は採用JSONを返さない（N=3）", () => {
	for (let trial = 0; trial < 3; trial++) {
		const h = repository();
		try {
			const head = h.head({ "README.md": "new\n" });
			const counter = path.join(h.root, "calls");
			writeFileSync(
				path.join(h.bin, "gh"),
				`#!${process.execPath}\nconst fs=require('node:fs');const file=${JSON.stringify(counter)};const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));console.log(JSON.stringify({headRefOid:${JSON.stringify(head)},baseRefOid:n?${JSON.stringify(head)}:${JSON.stringify(h.base)},baseRefName:'main',isCrossRepository:false,state:'OPEN'}));\n`,
				{ mode: 0o755 },
			);
			const run = () =>
				spawnSync(path.resolve("bin/harness-gate"), ["--classify", "--pr", "12", h.dir], {
					env: h.env,
					encoding: "utf8",
				});
			const moved = run();
			assert.equal(moved.status, 3, moved.stderr);
			assert.equal(moved.stdout, "");
			writeFileSync(path.join(h.bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			const failure = run();
			assert.equal(failure.status, 3);
			assert.equal(failure.stdout, "");
			const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
			const marker = path.join(h.root, "mutated");
			writeFileSync(
				path.join(h.bin, "git"),
				`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('ls-files')){const n=fs.existsSync(${JSON.stringify(marker)})?Number(fs.readFileSync(${JSON.stringify(marker)})):0;fs.writeFileSync(${JSON.stringify(marker)},String(n+1));if(n===2)fs.writeFileSync(${JSON.stringify(path.join(h.dir, "README.md"))},'raced');}const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`,
				{ mode: 0o755 },
			);
			const changed = spawnSync(path.resolve("bin/harness-gate"), ["--classify", h.dir], {
				env: h.env,
				encoding: "utf8",
			});
			assert.equal(changed.status, 3, changed.stderr);
			assert.equal(changed.stdout, "");
		} finally {
			h.close();
		}
	}
});

test("R7: 通常とclassifyの -- -docs、設定不正の終了2、通常gateは全段を維持する", () => {
	const h = repository();
	try {
		h.head({ "README.md": "new\n" });
		symlinkSync(h.dir, path.join(h.root, "-docs"));
		let r = spawnSync(path.resolve("bin/harness-gate"), ["--classify", "--", "-docs"], {
			cwd: h.root,
			env: h.env,
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).route, "light");
		writeFileSync(
			h.env.HARNESS_CONFIG,
			JSON.stringify({
				project: "fixture",
				gate: [
					{ name: "one", run: "echo one" },
					{ name: "two", run: "echo two" },
				],
			}),
		);
		r = spawnSync(path.resolve("bin/harness-gate"), ["--", "-docs"], { cwd: h.root, env: h.env, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "one\ntwo\n");
		assert.equal((r.stderr.match(/harness-gate: route /g) ?? []).length, 2);
		const result = JSON.parse(readFileSync(path.join(h.dir, ".harness/gate-result.json"), "utf8"));
		assert.deepEqual(Object.keys(result).sort(), ["dirty", "failed", "head", "policy", "skipped", "version"]);
		writeFileSync(h.env.HARNESS_CONFIG, '{"baseBranch":true}');
		r = spawnSync(path.resolve("bin/harness-gate"), ["--classify", h.dir], { env: h.env, encoding: "utf8" });
		assert.equal(r.status, 2, r.stderr);
		assert.equal(r.stdout, "");
	} finally {
		h.close();
	}
});

test("R6/R7: 累積コードを後続文書で隠せず、古い base・浅い履歴・PR不一致は light にならない", async () => {
	const h = repository();
	try {
		const code = h.head({ "README.md": "old\n", "a.ts": "code" });
		h.head({ "README.md": "new\n", "a.ts": "code" }, code);
		assert.equal((await classifyRepository(h.dir)).route, "normal");
		h.head({ "README.md": "new\n" });
		writeFileSync(path.join(h.dir, ".git/shallow"), `${h.base}\n`);
		assert.equal((await classifyRepository(h.dir)).route, "normal");
		rmSync(path.join(h.dir, ".git/shallow"));
		const moved = h.git(["rev-parse", "HEAD"]);
		writeFileSync(path.join(h.dir, ".git/refs/heads/main"), `${moved}\n`);
		assert.equal((await classifyRepository(h.dir)).route, "normal");
		writeFileSync(
			path.join(h.bin, "gh"),
			`#!/bin/sh\nprintf '%s\\n' '{"headRefOid":"${h.base}","baseRefOid":"${h.base}","baseRefName":"main","isCrossRepository":false,"state":"OPEN"}'\n`,
			{ mode: 0o755 },
		);
		const r = spawnSync(path.resolve("bin/harness-gate"), ["--classify", "--pr", "12", h.dir], {
			env: h.env,
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).route, "normal");
	} finally {
		h.close();
	}
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "group", "timeout", "parent-killed"] as const) {
	test(`R7/H5: 利用者の分類入口 ${signal} の所有子と出力を確認（N=3）`, { timeout: 120000 }, async () => {
		for (let trial = 0; trial < 3; trial++) {
			const h = repository();
			const pidFile = path.join(h.root, "child.pid");
			writeFileSync(
				path.join(h.bin, "gh"),
				`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`,
				{ mode: 0o755 },
			);
			const child = spawn(path.resolve("bin/harness-gate"), ["--classify", "--pr", "12", h.dir], {
				env: h.env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.on("data", (d) => {
				stdout += d;
			});
			child.stderr.resume();
			const done = once(child, "close");
			let ownedPid = 0;
			try {
				await waitForContent(pidFile);
				ownedPid = Number(readFileSync(pidFile, "utf8"));
				if (signal === "group") {
					assert.ok(child.pid);
					process.kill(-child.pid, "SIGINT");
				} else if (signal === "parent-killed") {
					child.kill("SIGKILL");
					process.kill(-ownedPid, "SIGKILL");
				} else if (signal !== "timeout") child.kill(signal);
				const [code] = await done;
				assert.notEqual(code, 0);
				assert.equal(stdout, "");
				// SIGKILL の配送と回収は非同期なので、消えるまで短く待ってから確認する。
				for (let i = 0; i < 50; i++) {
					try {
						process.kill(ownedPid, 0);
					} catch {
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				assert.throws(() => process.kill(ownedPid, 0));
				assert.equal(existsSync(path.join(h.dir, ".harness")), false);
			} finally {
				child.kill("SIGKILL");
				if (ownedPid) {
					try {
						process.kill(-ownedPid, "SIGKILL");
					} catch {}
				}
				h.close();
			}
		}
	});
}
