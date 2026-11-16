import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectPrompt, maskPrompt, samplePrompt } from "../src/refresh-prompt.ts";
import type { Tmux } from "../src/supervisor.ts";

const canary = "PRIVATE_CANARY_61";
const meta = { width: 100, height: 24, x: 2, y: 2 };
const frame = (input: string) => `conversation ${canary}\n──────────\n❯ ${input}\n──────────\nstatus ${canary}`;
const ghost = frame(`\x1b[2;90m${canary}\x1b[0m`);
const geometry = "%1\t$1\t100\t24\t2\t2";
const cli = path.resolve("src/refresh-prompt.ts");

function fake(raw = ghost): { run: Tmux; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: (args) => {
			calls.push(args);
			let stdout = geometry;
			if (args[0] === "-V") stdout = "tmux 3.4";
			if (args[0] === "capture-pane") stdout = raw;
			return Promise.resolve({ ok: true, stdout });
		},
	};
}

async function files(root: string): Promise<string> {
	const all: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		all.push(entry.isDirectory() ? await files(file) : await readFile(file, "utf8"));
	}
	return all.join("\n");
}

function runCli(args: string[], env = process.env) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, [cli, ...args], { env, timeout: 5000 }, (error, stdout, stderr) => {
			resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
		});
	});
}

test("厳密空欄は維持し、属性だけでは候補を肯定せず入力と未知を拒否する", () => {
	for (const pane of ["history\n❯ ", frame(""), "❯ \n\n───\nstatus"])
		assert.deepEqual(inspectPrompt(pane), { state: "empty", reason: "strict-empty" });
	for (const pane of [frame(canary), frame(`/${canary}`), "❯ \ncontinued\n───", "no prompt", ghost])
		assert.notEqual(inspectPrompt(pane).state, "empty");
	assert.equal(maskPrompt(ghost, meta, "3.4", 0).reason, "unrecognized-style");
	assert.equal(maskPrompt(frame(canary), meta, "3.4", 0).state, "typed");
	assert.equal(maskPrompt(frame(canary), { ...meta, x: 0 }, "3.4", 0).state, "typed");
});

test("匿名化は入力欄だけをspanへ変え、会話・OSC・入力・候補・statusを残さない", () => {
	const sample = maskPrompt(`\x1b]0;${canary}\x07${ghost}\x1b]8;;${canary}\x1b\\`, meta, "3.4", 123);
	assert.equal(sample.frame, "recognized");
	assert.deepEqual(sample.cursor, { x: 2, relativeRow: 0 });
	assert.deepEqual(sample.spans.flat().find((s) => s.kind === "masked")?.foreground, [90]);
	assert.equal(
		sample.spans.flat().some((s) => s.dim),
		true,
	);
	assert.deepEqual(
		Object.keys(sample).sort(),
		[
			"schemaVersion",
			"at",
			"tmuxVersion",
			"width",
			"height",
			"cursor",
			"frame",
			"spans",
			"oldEmpty",
			"state",
			"reason",
		].sort(),
	);
	for (const secret of [canary, Buffer.from(canary).toString("base64"), "conversation", "status", "❯", "─"])
		assert.equal(JSON.stringify(sample).includes(secret), false);
	for (const raw of [
		frame("日本語"),
		frame("😀"),
		frame(`\x1b[999m${canary}`),
		frame(`\x1b[2J${canary}`),
		frame(`${canary}\ncontinued`),
		`❯ ${canary}`,
		"history ❯ text",
	])
		assert.equal(maskPrompt(raw, meta, "3.4", 0).frame, "unknown");
});

test("20並行採取も1回だけ、再実行にもclaimを保持し、保存物は0700/0600", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "prompt-once-"));
	const f = fake();
	try {
		const results = await Promise.all(Array.from({ length: 20 }, () => samplePrompt(home, "%1", f.run)));
		assert.equal(results.filter((r) => r === 0).length, 1);
		assert.equal(results.filter((r) => r === 3).length, 19);
		assert.equal(f.calls.filter((a) => a[0] === "capture-pane").length, 1);
		assert.deepEqual(
			f.calls.find((a) => a[0] === "capture-pane"),
			["capture-pane", "-p", "-e", "-t", "%1"],
		);
		assert.ok(f.calls.every((a) => ["-V", "display-message", "capture-pane"].includes(a[0] ?? "")));
		const dir = path.join(home, "refresh/prompt-once-v1");
		for (const name of ["", "claim.json", "sample.json"]) {
			const info = await stat(path.join(dir, name));
			assert.equal(info.mode & 0o777, name ? 0o600 : 0o700);
		}
		const sample = JSON.parse(await readFile(path.join(dir, "sample.json"), "utf8"));
		assert.equal(sample.schemaVersion, 1);
		assert.equal(sample.state, "unknown");
		assert.equal(await samplePrompt(home, "%1", f.run), 3);
		assert.equal((await files(home)).includes(canary), false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("取得失敗・例外・timeout・サイズ変化・上限超過でclaimを戻さず固定理由だけ残す", async () => {
	for (const mode of ["error", "timeout", "resize", "oversize", "control", "disappeared", "save"]) {
		const home = await mkdtemp(path.join(os.tmpdir(), "prompt-failure-"));
		let captures = 0;
		let displays = 0;
		const run: Tmux = async (args) => {
			if (args[0] === "-V") return { ok: true, stdout: "tmux 3.4" };
			if (args[0] === "display-message") {
				displays++;
				return {
					ok: mode !== "disappeared",
					stdout: mode === "resize" && displays > 1 ? geometry.replace("100", "101") : geometry,
				};
			}
			captures++;
			if (mode === "error") throw new Error(canary);
			if (mode === "timeout") return new Promise(() => {});
			if (mode === "save") await writeFile(path.join(home, "refresh/prompt-once-v1/sample.json"), "existing");
			let stdout = ghost;
			if (mode === "oversize") stdout = canary.repeat(10000);
			if (mode === "control") stdout = frame("\x1b[2J");
			return { ok: true, stdout };
		};
		try {
			assert.equal(await samplePrompt(home, "%1", run, 30), 1, mode);
			assert.equal(await samplePrompt(home, "%1", run), 3, mode);
			assert.ok(captures <= 1);
			const contents = await files(home);
			assert.equal(contents.includes(canary), false);
			assert.ok(JSON.parse(await readFile(path.join(home, "refresh/prompt-once-v1/failure.json"), "utf8")).reason);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

test("不正引数・symlink・所有者以外への書込可能な保存先を拒否する", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "prompt-unsafe-"));
	try {
		const f = fake();
		for (const [home, pane] of [
			["relative", "%1"],
			[root, ";bad"],
			[root, "%1;bad"],
		])
			assert.equal(await samplePrompt(home ?? "", pane ?? "", f.run), 2);
		assert.equal(f.calls.length, 0);
		await mkdir(path.join(root, "real"));
		await symlink(path.join(root, "real"), path.join(root, "alias"));
		assert.equal(await samplePrompt(path.join(root, "alias"), "%1", f.run), 1);
		await symlink(path.join(root, "real"), path.join(root, "refresh"));
		assert.equal(await samplePrompt(root, "%1", f.run), 1);
		await rm(path.join(root, "refresh"));
		await mkdir(path.join(root, "refresh"), { mode: 0o777 });
		await chmod(path.join(root, "refresh"), 0o777);
		assert.equal(await samplePrompt(root, "%1", f.run), 1);
		assert.equal(f.calls.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("node直呼びCLIは固定出力、未知コマンド拒否、別processのclaimも拒否する", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "prompt-cli-"));
	try {
		assert.equal((await runCli(["wrong"])).code, 2);
		await samplePrompt(home, "%1", fake().run);
		const result = await runCli(["sample", "--home", home, "--pane", "%1"]);
		assert.deepEqual(result, { code: 3, stdout: "prompt-sample: already-claimed\n", stderr: "" });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

async function waitUntil(check: () => boolean | Promise<boolean>) {
	const until = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() >= until) throw new Error("fixture timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function command(bin: string, args: string[], env = process.env) {
	return new Promise<string>((resolve, reject) => {
		execFile(bin, args, { env, timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

test("専用tmuxの実属性をnode CLIから採取し、paneと入力を変えない（独立N=3）", { timeout: 20000 }, async () => {
	for (let trial = 0; trial < 3; trial++) {
		const root = await mkdtemp(path.join(os.tmpdir(), "prompt-real-"));
		const socket = path.join(root, "tmux.sock");
		const home = path.join(root, "home");
		await mkdir(home, { mode: 0o700 });
		const script = path.join(root, "pane.cjs");
		await writeFile(
			script,
			`process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${("\n".repeat(17) + ghost).replaceAll("\n", "\r\n")}\x1b[20;3H`)}); setInterval(() => {}, 1000);`,
		);
		let pid = 0;
		try {
			await command("tmux", [
				"-S",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"fixture",
				"-x",
				"100",
				"-y",
				"24",
				process.execPath,
				script,
			]);
			const pane = (await command("tmux", ["-S", socket, "display-message", "-p", "#{pane_id}"])).trim();
			pid = Number(await command("tmux", ["-S", socket, "display-message", "-p", "#{pane_pid}"]));
			await waitUntil(async () =>
				(await command("tmux", ["-S", socket, "capture-pane", "-p", "-t", pane])).includes(canary),
			);
			const before = await command("tmux", ["-S", socket, "capture-pane", "-p", "-e", "-t", pane]);
			const result = await runCli(["sample", "--home", home, "--pane", pane], {
				...process.env,
				TMUX: `${socket},0,0`,
			});
			assert.deepEqual(result, { code: 0, stdout: "prompt-sample: saved\n", stderr: "" });
			assert.equal(await command("tmux", ["-S", socket, "capture-pane", "-p", "-e", "-t", pane]), before);
			const sample = JSON.parse(await readFile(path.join(home, "refresh/prompt-once-v1/sample.json"), "utf8"));
			assert.equal(sample.frame, "recognized");
			assert.equal(sample.reason, "unrecognized-style");
			assert.equal(
				sample.spans.flat().some((span: { dim: boolean }) => span.dim),
				true,
			);
			assert.equal((await files(home)).includes(canary), false);
		} finally {
			await command("tmux", ["-S", socket, "kill-server"]).catch(() => {});
			if (pid)
				await waitUntil(() => {
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				});
			await rm(root, { recursive: true, force: true });
		}
	}
});

test(
	"helper CLIのHUP/TERM/INT・pipe・親終了でもclaim保持、子clientを回収する（独立N=3）",
	{ timeout: 40000 },
	async () => {
		for (const mode of ["SIGHUP", "SIGTERM", "SIGINT", "group-int", "pipe", "parent-exit"]) {
			for (let trial = 0; trial < 3; trial++) {
				const root = await mkdtemp(path.join(os.tmpdir(), "prompt-signal-"));
				const home = path.join(root, "home");
				await mkdir(home, { mode: 0o700 });
				const bin = path.join(root, "bin");
				await mkdir(bin);
				const pidfile = path.join(root, "client-pid");
				await writeFile(
					path.join(bin, "tmux"),
					`#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif(args[0] === '-V') console.log('tmux 3.4');\nelse if(args[0] === 'display-message') console.log(${JSON.stringify(geometry)});\nelse {fs.writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 1000);}\n`,
					{ mode: 0o700 },
				);
				const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
				let childPid = 0;
				let helperPid = 0;
				let args = [cli, "sample", "--home", home, "--pane", "%1"];
				let executable = process.execPath;
				if (mode === "pipe") {
					executable = "bash";
					args = [
						"-o",
						"pipefail",
						"-c",
						'"$1" "$2" sample --home "$3" --pane %1 | head -c 0',
						"fixture",
						process.execPath,
						cli,
						home,
					];
				}
				if (mode === "parent-exit") {
					args = [
						"-e",
						`const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath, ${JSON.stringify(args)}, {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(path.join(root, "helper-pid"))}, String(child.pid)); setInterval(()=>{},1000);`,
					];
				}
				const child = spawn(executable, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (data) => {
					stdout += String(data);
				});
				child.stderr.on("data", (data) => {
					stderr += String(data);
				});
				const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
				try {
					await waitUntil(async () => {
						try {
							childPid = Number(await readFile(pidfile, "utf8"));
							return childPid > 0;
						} catch {
							return false;
						}
					});
					if (mode === "parent-exit") {
						helperPid = Number(await readFile(path.join(root, "helper-pid"), "utf8"));
						child.kill("SIGKILL");
					} else if (mode === "group-int") process.kill(-(child.pid ?? 0), "SIGINT");
					else if (mode !== "pipe") child.kill(mode as NodeJS.Signals);
					assert.notEqual(await closed, 0);
					await waitUntil(() => {
						try {
							process.kill(childPid, 0);
							return false;
						} catch {
							return true;
						}
					}).catch(() => {
						throw new Error(`client remains: ${mode}/${trial}`);
					});
					assert.equal((await runCli(["sample", "--home", home, "--pane", "%1"], env)).code, 3);
					const saved = await files(home);
					assert.equal(saved.includes(canary), false);
					assert.equal((stdout + stderr).includes(canary), false);
					assert.equal(stderr, "");
					assert.equal((await readdir(path.join(home, "refresh/prompt-once-v1"))).includes("sample.json"), false);
				} finally {
					for (const pid of [childPid, helperPid, child.pid]) {
						if (pid) {
							try {
								process.kill(pid, "SIGKILL");
							} catch {}
						}
					}
					await closed;
					await rm(root, { recursive: true, force: true });
				}
			}
		}
	},
);

test("壊れたclaim・claim symlink・既存sampleは削除や上書きをしない", async () => {
	for (const mode of ["broken-claim", "claim-symlink", "sample-symlink"]) {
		const home = await mkdtemp(path.join(os.tmpdir(), "prompt-existing-"));
		const dir = path.join(home, "refresh/prompt-once-v1");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(path.dirname(dir), 0o700);
		const sentinel = path.join(home, "sentinel");
		await writeFile(sentinel, "preserve");
		if (mode === "broken-claim") await writeFile(path.join(dir, "claim.json"), "{");
		if (mode === "claim-symlink") await symlink(sentinel, path.join(dir, "claim.json"));
		if (mode === "sample-symlink") await symlink(sentinel, path.join(dir, "sample.json"));
		const f = fake();
		try {
			assert.equal(await samplePrompt(home, "%1", f.run), mode === "sample-symlink" ? 1 : 3);
			assert.equal(await readFile(sentinel, "utf8"), "preserve");
			if (mode !== "sample-symlink") assert.equal(f.calls.length, 0);
			assert.equal(await samplePrompt(home, "%1", f.run), 3);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});
