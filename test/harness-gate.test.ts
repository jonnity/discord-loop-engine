import "./isolate.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { shq } from "../src/supervisor.ts";

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
async function until(file: string) {
	for (let i = 0; i < 500; i++) {
		if (existsSync(file)) return;
		await delay(10);
	}
	throw new Error(`timeout: ${file}`);
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
				await until(ready);
				const home = readFileSync(ready, "utf8");
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
