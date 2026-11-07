import "./isolate.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { SessionTarget } from "../src/supervisor.ts";

// 同じassertを変更前ソースにも実行できる。通常gateはこのcheckoutを検証する。
const source = process.env.REFRESH_BASELINE_SOURCE ?? path.resolve("src");
const { Supervisor } = (await import(
	pathToFileURL(path.join(source, "supervisor.ts")).href
)) as typeof import("../src/supervisor.ts");

test("refresh OFFの起動・初期prompt・再接続・通常wake・上限抑止は診断ON/OFFで同じ", async () => {
	for (const diagnostics of [false, true]) {
		for (const name of ["worker", "concierge"]) {
			let now = 0;
			let live = false;
			let windows = "";
			const calls: string[][] = [];
			const phases: string[] = [];
			const target: SessionTarget = {
				name,
				cwd: "/fixture",
				command: "claude",
				initialPrompt: "/loop",
				...(name === "worker" ? { wake: { enabled: true } } : {}),
			};
			const sup = new Supervisor({
				tmuxSession: "fixture",
				targets: () => [target],
				isLive: () => live,
				notify: () => {},
				tmux: async (args) => {
					calls.push(args);
					return {
						ok: true,
						stdout:
							args[0] === "list-windows"
								? windows
								: args[0] === "capture-pane"
									? "history\n❯ "
									: args[0] === "display-message"
										? "123"
										: "",
					};
				},
				readSession: async () => ({ sessionId: "session", cwd: "/fixture", status: "idle", updatedAt: 0 }),
				readTranscript: async () => ({ tokens: 200000, mtimeMs: 0, subagentMtimeMs: 0 }),
				now: () => now,
				wait: async () => {},
				promptDelayMs: 0,
				onRefresh: (_name, phase) => {
					phases.push(phase);
				},
				...(diagnostics ? { onRefreshDecision: () => {} } : {}),
			});
			await sup.tick();
			assert.equal(calls.filter((c) => c[0] === "new-window").length, 1);
			windows = `dle-${name}`;
			live = true;
			now = 180000;
			await sup.onRegistered(name);
			assert.deepEqual(
				calls.filter((c) => c[0] === "send-keys").map((c) => c.at(-1)),
				["/loop", "Enter"],
			);
			calls.length = 0;
			await sup.tick();
			assert.deepEqual(
				calls.filter((c) => c[0] === "send-keys"),
				[],
			);
			for (const reason of ["dispatch", "回答", "queued", "outbox", "reconnect"]) {
				now += 60000;
				sup.requestWake(name, reason);
				await sup.wakeTick();
			}
			assert.equal(calls.filter((c) => c[0] === "send-keys").length, name === "worker" ? 10 : 0);
			now += 60000;
			await sup.onRegistered(name);
			await sup.wakeTick();
			assert.equal(calls.filter((c) => c[0] === "send-keys").length, name === "worker" ? 12 : 0);
			const state = (sup as unknown as { st(n: string): { limited: boolean } }).st(name);
			state.limited = true;
			calls.length = 0;
			now += 60000;
			sup.requestWake(name, "dispatch");
			await sup.wakeTick();
			assert.deepEqual(
				calls.filter((c) => c[0] === "send-keys"),
				[],
			);
			assert.deepEqual(phases, []);
		}
	}
});
