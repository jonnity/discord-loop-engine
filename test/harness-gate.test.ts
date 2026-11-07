import "./isolate.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { shq } from "../src/supervisor.ts";
import { waitForContent } from "./wait-file.ts";

const gate = path.resolve("bin/harness-gate");
const notify = path.resolve("bin/harness-notify");
function setup() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-g9-"));
	const main = path.join(dir, "repo");
	const home = path.join(dir, "home");
	mkdirSync(main);
	mkdirSync(path.join(home, "projects/test"), { recursive: true });
	mkdirSync(path.join(dir, "tmp"));
	const file = path.join(home, "projects/test/harness.json");
	const env = {
		...process.env,
		CLAUDE_PROJECT_DIR: main,
		HARNESS_CONFIG: file,
		DLE_HOME: home,
		DLE_CONFIG_HOME: path.join(dir, "config home"),
		DLE_SOCKET: path.join(home, "engine.sock"),
		DLE_PROJECT: "test",
		DLE_ROLE: "worker",
		DLE_LOOP: "harness",
		DLE_UNKNOWN: "private",
		DLE_EMPTY: "",
		DISCORD_WEBHOOK_URL: "https://invalid.test/fake",
		DISCORD_BOT_TOKEN: "fake",
		DISCORD_UNKNOWN: "private",
		DISCORD_EMPTY: "",
		NORMAL_SENTINEL: "kept",
		GIT_AUTHOR_NAME: "Test Author",
		GIT_AUTHOR_EMAIL: "author@example.test",
		GIT_COMMITTER_NAME: "Test Committer",
		GIT_COMMITTER_EMAIL: "committer@example.test",
		TMPDIR: path.join(dir, "tmp"),
	};
	const put = (p: unknown) => writeFileSync(file, JSON.stringify(p));
	const start = (extra = {}) => {
		const child = spawn(gate, [main], { cwd: main, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
		return { child, done };
	};
	const run = async (extra = {}, input = "") => {
		const r = start(extra);
		r.child.stdin.end(input);
		return r.done;
	};
	return { dir, main, home, file, env, put, start, run, close: () => rmSync(dir, { recursive: true, force: true }) };
}
test("G1/G2/G3/G4: 各2コマンド・並行呼出しの環境、一時home、親設定、hookと入出力", async () => {
	const h = setup();
	const record = path.join(h.dir, "record.cjs");
	writeFileSync(
		record,
		`const fs=require('node:fs'); const e=process.env; fs.appendFileSync(process.argv[2],JSON.stringify({env:e,cwd:process.cwd(),empty:fs.readdirSync(e.DLE_HOME).length===0,socket:fs.existsSync(e.DLE_SOCKET)})+'\\n');`,
	);
	const command = (out: string) => `node ${shq(record)} ${shq(out)}`;
	const log = path.join(h.dir, "log");
	h.put({
		preflight: [1, 2].map((i) => ({ name: `p${i}`, run: command(log) })),
		gate: [1, 2].map((i) => ({ name: `g${i}`, run: command(log) })),
		hooks: { beforePR: [command(`${log}-hook`)] },
	});
	try {
		const results = await Promise.all([h.run(), h.run()]);
		for (const r of results) assert.equal(r.code, 0, r.stderr);
		const rows = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		assert.equal(rows.length, 8);
		assert.equal(new Set(rows.map((r) => r.env.DLE_HOME)).size, 8);
		for (const r of rows) {
			assert.deepEqual(
				Object.keys(r.env)
					.filter((k) => /^(DLE_|DISCORD_)/.test(k))
					.sort(),
				["DLE_HOME", "DLE_SOCKET"],
			);
			assert.notEqual(r.env.DLE_HOME, h.home);
			assert.equal(r.env.DLE_SOCKET, `${r.env.DLE_HOME}/engine.sock`);
			assert.equal(r.empty, true);
			assert.equal(r.socket, false);
			assert.equal(r.cwd, h.main);
			assert.equal(existsSync(r.env.DLE_HOME), false);
			for (const k of [
				"NORMAL_SENTINEL",
				"PATH",
				"GIT_AUTHOR_NAME",
				"GIT_AUTHOR_EMAIL",
				"GIT_COMMITTER_NAME",
				"GIT_COMMITTER_EMAIL",
			])
				assert.equal(r.env[k], h.env[k as keyof typeof h.env]);
		}
		for (const r of readFileSync(`${log}-hook`, "utf8")
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s))) {
			for (const [k, v] of Object.entries(h.env)) if (/^(DLE_|DISCORD_)/.test(k)) assert.equal(r.env[k], v);
		}
		assert.equal(h.env.DLE_ROLE, "worker");
		assert.deepEqual(readdirSync(path.join(h.dir, "tmp")), []);
		h.put({ gate: [{ name: "io", run: 'read -r value; printf "out:%s\\n" "$value"; echo err:sentinel >&2' }] });
		const r = await h.run({}, "input-sentinel\n");
		assert.equal(r.code, 0);
		assert.equal(r.stdout, "out:input-sentinel\n");
		assert.match(r.stderr, /err:sentinel/);
		for (const source of ["engine", "repo", "explicit"]) {
			const p = { gate: [{ name: source, run: `echo ${source}` }] };
			// 設定探索そのものの試験だけ明示設定を外す。root/home/cwd は全て所有領域。
			let extra = { HARNESS_CONFIG: "" };
			if (source === "engine") {
				const file = path.join(h.env.DLE_CONFIG_HOME, "projects/test/harness.json");
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, JSON.stringify(p));
			}
			if (source === "repo") {
				mkdirSync(path.join(h.main, ".claude"));
				writeFileSync(path.join(h.main, ".claude/harness.json"), JSON.stringify(p));
			}
			if (source === "explicit") {
				const f = path.join(h.dir, "explicit.json");
				writeFileSync(f, JSON.stringify(p));
				extra = { HARNESS_CONFIG: f };
			}
			const result = await h.run(extra);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.stdout, `${source}\n`);
		}
	} finally {
		h.close();
	}
});

test("G5: 実notifyは継承socket/webhookに接続しない、gateとpreflightの失敗契約", async () => {
	const h = setup();
	let connections = 0;
	const server = net.createServer((s) => {
		connections++;
		s.end();
	});
	const curlLog = path.join(h.dir, "curl.log");
	const stub = path.join(h.dir, "curl");
	writeFileSync(stub, `#!/bin/sh\necho called >> ${shq(curlLog)}\nexit 1\n`, { mode: 0o755 });
	await new Promise<void>((r) => server.listen(h.env.DLE_SOCKET, r));
	try {
		for (const phase of ["gate", "preflight"]) {
			const cmd = `${shq(notify)} --event info --project test --repo example/test --title test --url https://invalid.test; rc=$?; echo "$rc" > notify-code; exit "$rc"`;
			h.put({
				preflight: phase === "preflight" ? [{ name: "notify", run: cmd }] : [],
				gate: [
					{ name: "notify", run: phase === "gate" ? cmd : "echo later" },
					{ name: "later", run: "echo later" },
				],
				hooks: { beforePR: ["echo hook"] },
			});
			const r = await h.run({ PATH: `${h.dir}:${process.env.PATH}` });
			assert.equal(readFileSync(path.join(h.main, "notify-code"), "utf8"), "3\n");
			assert.equal(r.code, phase === "gate" ? 1 : 3, r.stderr);
			assert.equal(r.stdout.includes("later"), phase === "gate");
			assert.equal(r.stdout.includes("hook"), phase === "gate");
		}
		assert.equal(connections, 0);
		assert.equal(existsSync(curlLog), false);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		h.close();
	}
});

test("G6: 終了値・全件実行・設定不備・隔離準備失敗と回収", async () => {
	const h = setup();
	try {
		for (const rc of [1, 3, 127]) {
			h.put({
				gate: [
					{ name: "fail", run: `exit ${rc}` },
					{ name: "later", run: "echo later" },
				],
				hooks: { beforePR: ["echo hook"] },
			});
			const r = await h.run();
			assert.equal(r.code, 1);
			assert.equal(r.stdout, "later\nhook\n");
		}
		h.put({ gate: [{ name: "ok", run: "true" }], hooks: { beforePR: ["false"] } });
		assert.equal((await h.run()).code, 1);
		h.put({
			preflight: [
				{ name: "fail", run: "false" },
				{ name: "never", run: "echo never" },
			],
			gate: [{ name: "never", run: "echo never" }],
		});
		assert.equal((await h.run()).code, 3);
		for (const bad of [{}, { gate: [] }, { gate: [{ name: "x", run: "echo never" }], preflight: {} }, null]) {
			h.put(bad);
			const r = await h.run();
			assert.equal(r.code, 2);
			assert.equal(r.stdout, "");
		}
		writeFileSync(h.file, "broken");
		assert.equal((await h.run()).code, 2);
		h.put({ gate: [{ name: "never", run: "echo never" }], hooks: { beforePR: ["echo hook"] } });
		for (const extra of [{ TMPDIR: path.join(h.dir, "missing") }, { PATH: `${h.dir}:${process.env.PATH}` }]) {
			writeFileSync(path.join(h.dir, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			const r = await h.run(extra);
			assert.equal(r.code, 3, r.stderr);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /一時|隔離/);
		}
		assert.deepEqual(readdirSync(path.join(h.dir, "tmp")), []);
	} finally {
		h.close();
	}
});

for (const [signal, code] of [
	["SIGHUP", 129],
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	test(`G6: ${signal} は${code}で終了しtrapが回収（3回連続）`, async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const h = setup();
			const ready = path.join(h.dir, "ready"),
				release = path.join(h.dir, "release");
			const script = path.join(h.dir, "wait.cjs");
			writeFileSync(
				script,
				`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},process.env.DLE_HOME);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10);`,
			);
			h.put({ gate: [{ name: "finite", run: `node ${shq(script)}` }] });
			const r = h.start();
			r.child.stdin.end();
			try {
				const home = await waitForContent(ready);
				assert.ok(existsSync(home));
				r.child.kill(signal);
				writeFileSync(release, "");
				const done = await Promise.race([
					r.done,
					delay(5000, undefined, { ref: false }).then(() => {
						throw new Error("gate終了の待機期限切れ");
					}),
				]);
				assert.equal(done.code, code, done.stderr);
				assert.equal(done.signal, null);
				assert.equal(existsSync(home), false);
				assert.deepEqual(readdirSync(h.env.TMPDIR), []);
			} finally {
				writeFileSync(release, "");
				r.child.kill("SIGKILL");
				await r.done;
				h.close();
			}
		}
	});
}

test("G3/G4/G6: 定義先行抽出・hook順序・コマンド専用領域の準備失敗", async () => {
	const h = setup();
	try {
		h.put({
			preflight: [
				{
					name: "first",
					run: `echo pre; printf '%s' '${JSON.stringify({ gate: [{ name: "changed", run: "echo forbidden" }] })}' > ${shq(h.file)}`,
				},
			],
			gate: [{ name: "original", run: "echo gate" }],
			hooks: { beforePR: ["echo hook"] },
		});
		const r = await h.run();
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout, "pre\ngate\n");
		h.put({
			preflight: [{ name: "pre", run: "echo pre" }],
			gate: [{ name: "gate", run: "echo gate" }],
			hooks: { beforePR: ["echo hook"] },
		});
		const ordered = await h.run();
		assert.equal(ordered.code, 0);
		assert.equal(ordered.stdout, "pre\ngate\nhook\n");
		writeFileSync(
			path.join(h.dir, "mktemp"),
			'#!/bin/sh\nif [ "$#" = 1 ]; then exec /usr/bin/mktemp "$@"; fi\nexit 1\n',
			{ mode: 0o755 },
		);
		const failed = await h.run({ PATH: `${h.dir}:${process.env.PATH}` });
		assert.equal(failed.code, 3);
		assert.equal(failed.stdout, "");
		assert.match(failed.stderr, /隔離.*一時/);
		assert.deepEqual(readdirSync(h.env.TMPDIR), []);
	} finally {
		h.close();
	}
});

test("G16: 実行homeを差し替えても設定homeの定義を順に実行し、beforePRは親環境を保持する", async () => {
	const h = setup();
	const file = path.join(h.env.DLE_CONFIG_HOME, "projects/test/harness.json");
	const log = path.join(h.dir, "phases.jsonl");
	const record = path.join(h.dir, "record.cjs");
	const runtimeHome = path.join(h.dir, "runtime");
	mkdirSync(runtimeHome);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		record,
		`const fs=require('node:fs');fs.appendFileSync(process.argv[2],JSON.stringify({phase:process.argv[3],marker:process.argv[4],env:process.env,cwd:process.cwd()})+'\\n');`,
	);
	const command = (phase: string) => `node ${shq(record)} ${shq(log)} ${phase} config-home`;
	const config = JSON.stringify({
		preflight: [{ name: "pre", run: command("preflight") }],
		gate: [{ name: "gate", run: command("gate") }],
		hooks: { beforePR: [command("beforePR")] },
	});
	writeFileSync(file, config);
	const extra = { HARNESS_CONFIG: "", DLE_HOME: runtimeHome, DLE_SOCKET: path.join(runtimeHome, "engine.sock") };
	try {
		const result = await h.run(extra);
		assert.equal(result.code, 0, result.stderr);
		const content = readFileSync(log, "utf8");
		const rows = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			rows.map((row) => row.phase),
			["preflight", "gate", "beforePR"],
		);
		for (const row of rows) {
			assert.equal(row.marker, "config-home");
			assert.equal(row.cwd, h.main);
		}
		for (const [key, value] of Object.entries({ ...h.env, ...extra })) {
			if (/^(DLE_|DISCORD_)/.test(key)) assert.equal(rows[2].env[key], value);
		}
		assert.equal(readFileSync(file, "utf8"), config);
		assert.deepEqual(readdirSync(h.env.TMPDIR), []);
		assert.deepEqual(readdirSync(runtimeHome), []);
		writeFileSync(file, JSON.stringify({ gate: [{ name: "fail", run: "false" }] }));
		assert.equal((await h.run(extra)).code, 1);
		assert.equal((await h.run({ ...extra, TMPDIR: path.join(h.dir, "missing") })).code, 3);
		rmSync(file);
		assert.equal((await h.run(extra)).code, 2);
		assert.deepEqual(readdirSync(h.env.TMPDIR), []);
		assert.ok(existsSync(h.env.DLE_CONFIG_HOME));
	} finally {
		h.close();
	}
});

// --- 未確認（skipExit: 78）---
function gitInit(dir: string) {
	for (const args of [
		["init", "-q"],
		["commit", "-q", "--allow-empty", "-m", "init"],
	])
		execFileSync("git", args, {
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	// 実運用では .harness/ は info/exclude で無視される。
	writeFileSync(path.join(dir, ".git/info/exclude"), ".harness/\n");
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}
const lastLine = (s: string) => s.trim().split("\n").at(-1) ?? "";
test("G-S1: skipExit を宣言した段の終了 78 は ⚠ 未確認で、全件実行し終了 0", async () => {
	const h = setup();
	try {
		const rec = path.join(h.dir, "rec");
		h.put({
			gate: [
				{ name: "sc", run: "echo skipped; exit 78", skipExit: 78 },
				{ name: "ok", run: `echo ran >${shq(rec)}` },
			],
		});
		const r = await h.run();
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /⚠ sc .*未確認.*CI で初めて検査される/);
		assert.match(r.stderr, /✅ ok/);
		assert.ok(!/✅ sc/.test(r.stderr));
		assert.ok(lastLine(r.stderr).startsWith("⚠ 未確認: sc"));
		assert.equal(readFileSync(rec, "utf8"), "ran\n");
	} finally {
		h.close();
	}
});
test("G-S2/S3: gateSkipPolicy=fail は終了 3、失敗が混在すれば 1。未指定・null・warn は終了 0", async () => {
	const h = setup();
	try {
		const sc = { name: "sc", run: "exit 78", skipExit: 78 };
		h.put({ gate: [sc], gateSkipPolicy: "fail" });
		const r = await h.run();
		assert.equal(r.code, 3);
		assert.match(r.stderr, /❌ 未確認（gateSkipPolicy=fail）/);
		h.put({ gate: [sc, { name: "bad", run: "exit 1" }], gateSkipPolicy: "fail" });
		assert.equal((await h.run()).code, 1);
		for (const policy of [undefined, null, "warn"]) {
			h.put({ gate: [sc], gateSkipPolicy: policy });
			assert.equal((await h.run()).code, 0);
		}
	} finally {
		h.close();
	}
});
test("G-S4/S7: gateSkipPolicy・skipExit の不正値は実行前に終了 2", async () => {
	const h = setup();
	try {
		const rec = path.join(h.dir, "rec");
		const mark = { name: "m", run: `echo x >>${shq(rec)}` };
		const bad: string[] = [];
		for (const v of ['""', '"FAIL"', "true", "1", "[]", "{}"])
			bad.push(`{"gate":[${JSON.stringify(mark)}],"gateSkipPolicy":${v}}`);
		for (const v of ["1e2", '"78"', "true", "false", "0", "1", "2", "127", "255", "256", "-1", "78.5", "[]", "{}"])
			bad.push(`{"gate":[${JSON.stringify(mark)},{"name":"s","run":"exit 78","skipExit":${v}}]}`);
		for (const text of bad) {
			writeFileSync(h.file, text);
			const r = await h.run();
			assert.equal(r.code, 2, text);
			assert.equal(r.stdout, "");
			assert.ok(!existsSync(rec), text);
		}
		for (const v of ["null", "78.0", "7.8e1"]) {
			writeFileSync(h.file, `{"gate":[{"name":"s","run":"exit 78","skipExit":${v}}]}`);
			const r = await h.run();
			assert.equal(r.code, v === "null" ? 1 : 0, v);
			assert.equal(/⚠ s /.test(r.stderr), v !== "null", v);
		}
		writeFileSync(h.file, '{"gate":[{"name":"s","run":"exit 1","skipExit":78.0}]}');
		assert.equal((await h.run()).code, 1);
	} finally {
		h.close();
	}
});
test("G-S5/S6: 宣言なしの 78 は失敗のまま。78 以外の非 0 は宣言があっても失敗。preflight・beforePR には効かない", async () => {
	const h = setup();
	try {
		h.put({
			gate: [
				{ name: "x", run: "exit 78" },
				{ name: "y", run: "true" },
			],
		});
		let r = await h.run();
		assert.equal(r.code, 1);
		assert.match(r.stderr, /❌ x.*skipExit 未宣言のため失敗/);
		assert.ok(!r.stderr.includes("⚠"));
		assert.match(r.stderr, /✅ y/);
		for (const code of [0, 1, 2, 77, 79, 255]) {
			h.put({ gate: [{ name: "x", run: `exit ${code}` }] });
			assert.equal((await h.run()).code, code === 0 ? 0 : 1, String(code));
		}
		for (const code of [1, 127, 255]) {
			h.put({ gate: [{ name: "x", run: `exit ${code}`, skipExit: 78 }] });
			r = await h.run();
			assert.equal(r.code, 1, String(code));
			assert.ok(!r.stderr.includes("⚠"));
		}
		h.put({ preflight: [{ name: "p", run: "exit 78", skipExit: 78 }], gate: [{ name: "g", run: "true" }] });
		assert.equal((await h.run()).code, 3);
		h.put({ gate: [{ name: "g", run: "true" }], hooks: { beforePR: ["exit 78"] } });
		r = await h.run();
		assert.equal(r.code, 1);
		assert.match(r.stderr, /❌ hooks.beforePR/);
	} finally {
		h.close();
	}
});
test("G-S8: 結果ファイルは現 HEAD で書かれ、設定不備・preflight 失敗では残らない", async () => {
	const h = setup();
	try {
		const head = gitInit(h.main);
		const resultPath = path.join(h.main, ".harness/gate-result.json");
		const read = () => JSON.parse(readFileSync(resultPath, "utf8"));
		const sc = { name: "sc", run: "exit 78", skipExit: 78 };
		h.put({ gate: [sc] });
		await h.run();
		assert.deepEqual(read(), { version: 1, head, dirty: false, policy: "warn", skipped: ["sc"], failed: [] });
		h.put({ gate: [sc], gateSkipPolicy: "fail" });
		assert.equal((await h.run()).code, 3);
		assert.equal(read().policy, "fail");
		h.put({ gate: [sc, { name: "bad", run: "exit 1" }], hooks: { beforePR: ["exit 1"] } });
		assert.equal((await h.run()).code, 1);
		assert.deepEqual([read().skipped, read().failed], [["sc"], ["bad", "hooks.beforePR"]]);
		writeFileSync(path.join(h.main, "new.txt"), "x");
		h.put({ gate: [sc] });
		await h.run();
		assert.equal(read().dirty, true);
		for (const config of [
			{ gate: [sc], gateSkipPolicy: "x" },
			{ gate: [sc], preflight: [{ name: "p", run: "exit 1" }] },
		]) {
			h.put({ gate: [sc] });
			await h.run();
			assert.ok(existsSync(resultPath));
			h.put(config);
			assert.notEqual((await h.run()).code, 0);
			assert.ok(!existsSync(resultPath));
		}
	} finally {
		h.close();
	}
});
test("G-S8b: git でない作業ツリーでは結果ファイルを作らず、終了コードも変わらない", async () => {
	const h = setup();
	try {
		h.put({ gate: [{ name: "sc", run: "exit 78", skipExit: 78 }] });
		assert.equal((await h.run()).code, 0);
		assert.ok(!existsSync(path.join(h.main, ".harness/gate-result.json")));
	} finally {
		h.close();
	}
});
test("G-S9: shellcheck の有無で分岐する実コマンドが、無ければ ⚠、あれば ✅ になる", async () => {
	const h = setup();
	try {
		const bin = path.join(h.dir, "bin");
		const bin2 = path.join(h.dir, "bin2");
		mkdirSync(bin);
		mkdirSync(bin2);
		for (const cmd of [
			"bash",
			"env",
			"jq",
			"git",
			"dirname",
			"basename",
			"mktemp",
			"rm",
			"seq",
			"date",
			"cat",
			"mkdir",
			"mv",
			"sed",
		])
			symlinkSync(
				execFileSync("bash", ["-c", `command -v ${cmd}`])
					.toString()
					.trim(),
				path.join(bin, cmd),
			);
		writeFileSync(path.join(bin2, "shellcheck"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
		h.put({
			gate: [
				{
					name: "shellcheck",
					skipExit: 78,
					run: "if command -v shellcheck >/dev/null; then shellcheck x; else echo 'shellcheck が無い'; exit 78; fi",
				},
			],
		});
		const exec = (p: string) =>
			spawnSync("env", ["-i", `PATH=${p}`, `HOME=${h.dir}`, `HARNESS_CONFIG=${h.file}`, "bash", gate, h.main], {
				encoding: "utf8",
			});
		const none = spawnSync(`${bin}/bash`, ["-c", "command -v shellcheck"], { env: { PATH: bin } });
		assert.notEqual(none.status, 0);
		const a = exec(bin);
		assert.equal(a.status, 0, a.stderr);
		assert.match(a.stderr, /⚠ shellcheck/);
		const b = exec(`${bin2}:${bin}`);
		assert.equal(b.status, 0, b.stderr);
		assert.match(b.stderr, /✅ shellcheck/);
	} finally {
		h.close();
	}
});
test("G-S8c: 親ディレクトリから相対パスで呼んでも、結果ファイルは対象に書かれ古い結果は消える", async () => {
	const h = setup();
	try {
		const head = gitInit(h.main);
		h.put({ gate: [{ name: "sc", run: "exit 78", skipExit: 78 }] });
		const resultPath = path.join(h.main, ".harness/gate-result.json");
		mkdirSync(path.dirname(resultPath), { recursive: true });
		writeFileSync(resultPath, JSON.stringify({ stale: true }));
		const r = spawnSync(gate, [path.basename(h.main)], { cwd: h.dir, env: h.env, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const got = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(got.head, head);
		assert.deepEqual(got.skipped, ["sc"]);
	} finally {
		h.close();
	}
});
