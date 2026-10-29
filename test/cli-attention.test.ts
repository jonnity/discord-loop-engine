import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("T2: attentionの新JSONモードはengine/configに依存せずDLE_HOMEだけを読む", async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-att-cli-"));
	const call = (args: string[]) =>
		new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
			execFile(
				path.resolve("bin/dle"),
				["attention", ...args],
				{
					env: {
						...process.env,
						DLE_HOME: home,
						DLE_CONFIG_HOME: path.join(home, "config"),
						DLE_SOCKET: path.join(home, "engine.sock"),
					},
					timeout: 5000,
				},
				(err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
			),
		);
	try {
		mkdirSync(path.join(home, "config"));
		writeFileSync(path.join(home, "config/attention.json"), '[{"id":"A-99","answer":"OK"}]');
		const items = [
			{ id: "A-1", status: "open" },
			{ id: "A-2", status: "resolved", answer: "NG" },
		];
		writeFileSync(path.join(home, "attention.json"), JSON.stringify(items));
		for (const mode of ["--all", "--answered"]) {
			const result = await call([mode, "--json"]);
			assert.equal(result.code, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, items: mode === "--all" ? items : [items[1]] });
		}
		for (const args of [
			["--all"],
			["--answered"],
			["--all", "--answered", "--json"],
			["--all", "--all", "--json"],
			["--all=true", "--json"],
			["--all", "x", "--json"],
			["--answered", "--json", "--wat"],
			["--all", "--json", "--json"],
		]) {
			const result = await call(args);
			assert.equal(result.code, 2, args.join(" "));
			assert.equal(result.stdout, "");
		}
		writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
		assert.deepEqual(JSON.parse((await call(["--json"])).stdout), [items[0]]);
		rmSync(path.join(home, "config.json"));
		writeFileSync(path.join(home, "attention.json"), "broken");
		const failed = await call(["--all", "--json"]);
		assert.equal(failed.code, 1);
		assert.equal(failed.stdout, "");
		assert.doesNotMatch(failed.stderr, /broken/);
		assert.equal(readFileSync(path.join(home, "attention.json"), "utf8"), "broken");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("T2: ソケットが存在しても新モードは接続しない", async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-att-sock-"));
	let connections = 0;
	const server = net.createServer((socket) => {
		connections++;
		socket.destroy();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path.join(home, "engine.sock"), resolve);
		});
		writeFileSync(path.join(home, "attention.json"), "[]");
		const stdout = await new Promise<string>((resolve, reject) =>
			execFile(
				path.resolve("bin/dle"),
				["attention", "--all", "--json"],
				{ env: { ...process.env, DLE_HOME: home, DLE_SOCKET: path.join(home, "engine.sock") } },
				(err, out) => (err ? reject(err) : resolve(out)),
			),
		);
		assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, items: [] });
		assert.equal(connections, 0);
	} finally {
		server.close();
		rmSync(home, { recursive: true, force: true });
	}
});
