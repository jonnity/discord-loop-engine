// テストの環境の閉じ込めが保証すること:
// - 実行中の engine の環境（DLE_ROLE・DLE_SOCKET・Discord の設定・git の作者）を親から引き継がない
// - DLE_HOME と DLE_SOCKET は一時ディレクトリを指し、既定の ~/.discord-loop-engine を使わない
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ISOLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "isolate.ts");

test("親の engine の環境変数を消し、DLE_HOME と DLE_SOCKET を一時ディレクトリに向ける", () => {
	const out = execFileSync(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			"--input-type=module",
			"-e",
			`await import(${JSON.stringify(ISOLATE)}); console.log(JSON.stringify(process.env))`,
		],
		{
			env: {
				...process.env,
				DLE_ROLE: "worker",
				DLE_PROJECT: "x",
				DLE_LOOP: "harness",
				DLE_SOCKET: "/real/engine.sock",
				DLE_HOME: "/real/home",
				DISCORD_WEBHOOK_URL: "http://invalid.example/",
				DISCORD_BOT_TOKEN: "secret",
				GIT_AUTHOR_EMAIL: "a@example.com",
				GIT_COMMITTER_NAME: "n",
			},
			encoding: "utf8",
		},
	);
	const env = JSON.parse(out) as Record<string, string>;
	for (const k of ["DLE_ROLE", "DLE_PROJECT", "DLE_LOOP", "DISCORD_WEBHOOK_URL", "DISCORD_BOT_TOKEN"])
		assert.equal(env[k], undefined, k);
	assert.equal(env.GIT_AUTHOR_EMAIL, undefined);
	assert.equal(env.GIT_COMMITTER_NAME, undefined);
	assert.ok(env.DLE_HOME?.startsWith(os.tmpdir()), "一時ディレクトリを指す");
	assert.equal(env.DLE_SOCKET, path.join(env.DLE_HOME ?? "", "engine.sock"));
	assert.equal(env.HARNESS_CONFIG, path.join(env.DLE_HOME ?? "", "harness.json"));
	assert.equal(env.CLAUDE_PROJECT_DIR, env.DLE_HOME);
	assert.ok(env.NODE_OPTIONS?.includes("reject-fetch.ts"));
});

test("T0: 明示fixtureがなくても子のCDN通信と親の設定を拒否する", () => {
	const result = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
  await import(${JSON.stringify(ISOLATE)});
  const {spawnSync} = await import("node:child_process");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", 'try { await fetch("https://cdn.discordapp.com/attachments/1/2/demo.mp4"); process.exitCode=9; } catch { process.stdout.write("denied"); }'], {env:process.env,encoding:"utf8"});
  if (child.error) throw child.error;
  if (child.status !== 0 || child.stdout !== "denied") throw Error("fetch isolation failed");
  process.stdout.write("isolated");
 `,
		],
		{
			encoding: "utf8",
			env: { ...process.env, HARNESS_CONFIG: "/must-not-read/harness.json", CLAUDE_PROJECT_DIR: "/must-not-read" },
		},
	);
	assert.equal(result, "isolated");
});
