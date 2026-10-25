// 送信後に切れた接続は成功にも webhook への再送にもならない。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lineReader, PROTOCOL_VERSION } from "../src/protocol.ts";

for (const mode of ["close", "error", "refused"] as const) {
	test(`notify: ${mode} の接続切断と再送の境界`, async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "dle-n-"));
		const socket = path.join(home, "engine.sock");
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({ socketPath: socket, channelIds: ["900"], allowedUserIds: ["111"] }),
		);
		let called = false;
		const server = net.createServer((s) => {
			s.on("error", () => {});
			s.on(
				"data",
				lineReader<{ type: string }>((m) => {
					if (m.type === "hello") s.write(`${JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION })}\n`);
					if (m.type === "call") {
						called = true;
						if (mode === "error") s.destroy(new Error("送信後のエラー"));
						else s.end();
					}
				}),
			);
		});
		if (mode !== "refused") await new Promise<void>((r) => server.listen(socket, r));
		else writeFileSync(socket, "stale");
		try {
			const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
				execFile(
					"bash",
					[
						"bin/harness-notify",
						"--event",
						"merge-request",
						"--title",
						"test",
						"--url",
						"https://example.test",
						"--project",
						"test",
						"--repo",
						"example/project",
					],
					{
						timeout: 5000,
						env: {
							...process.env,
							HARNESS_CONFIG: "",
							DLE_HOME: home,
							DLE_SOCKET: socket,
							DISCORD_WEBHOOK_URL: "",
							CLAUDE_PROJECT_DIR: home,
						},
					},
					(err, _out, stderr) => resolve({ code: err ? Number(err.code) : 0, stderr }),
				);
			});
			if (mode === "refused") {
				assert.equal(result.code, 3, result.stderr);
			} else {
				assert.ok(called);
				assert.equal(result.code, 4, result.stderr);
				assert.doesNotMatch(result.stderr, /webhook で投稿します/);
			}
		} finally {
			if (server.listening) await new Promise<void>((r) => server.close(() => r()));
		}
	});
}
