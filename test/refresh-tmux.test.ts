import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contextReader } from "../src/context.ts";
import { RefreshDiagnostics } from "../src/refresh.ts";
import { Supervisor, shq, type Tmux } from "../src/supervisor.ts";

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("tmux fixture timeout");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("専用tmuxの実送信・Enter失敗・session欠落・HUP/PG中断/終了を独立N=3で確認する", { timeout: 90000 }, async () => {
	for (const mode of ["success", "clear-enter-fail", "resume-enter-fail", "no-confirm", "hup", "group-int", "exit"]) {
		for (let trial = 0; trial < 3; trial++) {
			const root = mkdtempSync(path.join(os.tmpdir(), "refresh-tmux-"));
			const socket = path.join(root, "tmux.sock");
			const home = path.join(root, "claude");
			const cwd = path.join(root, "repo");
			mkdirSync(home);
			mkdirSync(cwd);
			const transcriptDir = path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
			mkdirSync(transcriptDir, { recursive: true });
			writeFileSync(
				path.join(transcriptDir, "old.jsonl"),
				`${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 150000 } } })}\n`,
			);
			writeFileSync(path.join(root, "handoff.md"), "fixture handoff\n");
			const paneScript = path.resolve("test/fixtures/refresh-pane.ts");
			const command = `exec ${[process.execPath, paneScript, home, cwd, mode].map(shq).join(" ")}`;
			let panePid = 0;
			const sends: string[][] = [];
			const result: boolean[] = [];
			const writer = new RefreshDiagnostics(root);
			const run: Tmux = (args) =>
				new Promise((resolve) => {
					execFile("tmux", ["-S", socket, ...args], { timeout: 3000 }, (error, stdout) =>
						resolve({ ok: !error, stdout }),
					);
				});
			try {
				execFileSync(
					"tmux",
					[
						"-S",
						socket,
						"-f",
						"/dev/null",
						"new-session",
						"-d",
						"-s",
						"fixture",
						"-n",
						"dle-worker",
						"-c",
						cwd,
						command,
					],
					{ timeout: 5000 },
				);
				await until(() => existsSync(path.join(home, "ready.json")));
				panePid = JSON.parse(readFileSync(path.join(home, "ready.json"), "utf8")).pid;
				let now = Date.now();
				const sup = new Supervisor({
					tmuxSession: "fixture",
					targets: () => [
						{
							name: "worker",
							cwd,
							command,
							initialPrompt: "/loop",
							refresh: {
								cwd,
								prompt: "/loop",
								maxTokens: 100000,
								maxEvents: 0,
								contextPercent: 15,
								idleSeconds: 180,
								cooldownMinutes: 30,
								codexIgnoreAfterMinutes: 120,
								waitForCodex: true,
							},
						},
					],
					tmux: async (args) => {
						if (args[0] === "send-keys") {
							sends.push(args);
							if (
								(mode === "clear-enter-fail" && sends.length === 2) ||
								(mode === "resume-enter-fail" && sends.length === 4)
							)
								return { ok: false, stdout: "" };
						}
						return run(args);
					},
					diagnosticTmux: run,
					...contextReader(home),
					isLive: () => true,
					notify: () => {},
					now: () => now,
					promptDelayMs: 0,
					clearConfirmMs: 2000,
					onRefresh: (_name, phase, r) => {
						if (phase === "done") result.push(r?.success ?? false);
					},
					onRefreshDecision: (d) => {
						void writer.record(d);
					},
				});
				now += 300000;
				await sup.tick();
				await sup.flushRefreshDiagnostics();
				await writer.close();
				assert.deepEqual(result, [mode === "success"], `${mode}/${trial}`);
				assert.equal(sends.filter((args) => args.includes("/clear")).length, 1);
				assert.equal(
					sends.filter((args) => args.includes("/loop")).length,
					mode === "success" || mode === "resume-enter-fail" ? 1 : 0,
				);
				if (mode === "clear-enter-fail" || mode === "resume-enter-fail") {
					const expected = mode === "clear-enter-fail" ? /❯ \/clear/ : /❯ \/loop/;
					// 負荷時は fixture の再描画が遅れるので、画面に出るまで待つ
					let screen = "";
					const deadline = Date.now() + 5000;
					while (Date.now() < deadline) {
						screen = (await run(["capture-pane", "-p", "-t", "fixture:dle-worker"])).stdout;
						if (expected.test(screen)) break;
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					assert.match(screen, expected);
				}
				const date = new Date(now).toISOString().slice(0, 10);
				const rows = readFileSync(path.join(root, `refresh/decisions/${date}.jsonl`), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.equal(rows.length, 1);
				assert.equal(rows[0].result, mode === "success");
				assert.equal(readFileSync(path.join(root, "handoff.md"), "utf8"), "fixture handoff\n");
			} finally {
				await writer.close();
				await run(["kill-server"]);
				if (panePid)
					await until(() => {
						try {
							process.kill(panePid, 0);
							return false;
						} catch {
							return true;
						}
					});
				rmSync(root, { recursive: true, force: true });
				assert.equal(existsSync(root), false);
			}
		}
	}
});

test(
	"T6/T9: 専用tmuxで強制整理の停止点確認（成功・次の作業・入力中）を独立N=3で確認し、tmux と fixture を回収する",
	{ timeout: 120000 },
	async () => {
		const boundaryId = "11111111-2222-3333-4444-555555555555";
		const row = (value: unknown) => `${JSON.stringify(value)}\n`;
		for (const mode of ["success", "next-work", "typed-input"]) {
			for (let trial = 0; trial < 3; trial++) {
				const root = mkdtempSync(path.join(os.tmpdir(), "refresh-phase-tmux-"));
				const socket = path.join(root, "tmux.sock");
				const home = path.join(root, "claude");
				const cwd = path.join(root, "repo");
				mkdirSync(home);
				mkdirSync(cwd);
				const transcriptDir = path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
				mkdirSync(transcriptDir, { recursive: true });
				const checkpoint = [
					row({ type: "assistant", message: { usage: { input_tokens: 300000 }, content: [] } }),
					row({
						type: "assistant",
						message: {
							content: [
								{
									type: "tool_use",
									id: "tu1",
									name: "mcp__plugin_discord-loop-engine_dle__refresh_checkpoint",
									input: { boundary_id: boundaryId },
								},
							],
						},
					}),
					row({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }),
					row({ type: "assistant", message: { content: [{ type: "text", text: "止まります" }] } }),
				].join("");
				const next =
					mode === "next-work"
						? row({
								type: "assistant",
								message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } }] },
							})
						: "";
				writeFileSync(path.join(transcriptDir, "old.jsonl"), checkpoint + next);
				const paneScript = path.resolve("test/fixtures/refresh-pane.ts");
				const command = `exec ${[process.execPath, paneScript, home, cwd, "success"].map(shq).join(" ")}`;
				let panePid = 0;
				const sends: string[][] = [];
				const result: boolean[] = [];
				const run: Tmux = (args) =>
					new Promise((resolve) => {
						execFile("tmux", ["-S", socket, ...args], { timeout: 3000 }, (error, stdout) =>
							resolve({ ok: !error, stdout }),
						);
					});
				try {
					execFileSync(
						"tmux",
						[
							"-S",
							socket,
							"-f",
							"/dev/null",
							"new-session",
							"-d",
							"-s",
							"fixture",
							"-n",
							"dle-worker",
							"-c",
							cwd,
							command,
						],
						{ timeout: 5000 },
					);
					await until(() => existsSync(path.join(home, "ready.json")));
					panePid = JSON.parse(readFileSync(path.join(home, "ready.json"), "utf8")).pid;
					if (mode === "typed-input") await run(["send-keys", "-t", "fixture:dle-worker", "-l", "typed"]);
					const sup = new Supervisor({
						tmuxSession: "fixture",
						targets: () => [
							{
								name: "worker",
								cwd,
								command,
								initialPrompt: "/loop",
								refresh: {
									cwd,
									prompt: "/loop",
									maxTokens: 100000,
									forceMaxTokens: 250000,
									maxEvents: 0,
									contextPercent: 15,
									idleSeconds: 180,
									cooldownMinutes: 30,
									codexIgnoreAfterMinutes: 120,
									waitForCodex: true,
								},
							},
						],
						tmux: async (args) => {
							if (args[0] === "send-keys") sends.push(args);
							return run(args);
						},
						...contextReader(home),
						isLive: () => true,
						notify: () => {},
						promptDelayMs: 0,
						clearConfirmMs: 2000,
						phasePollMs: 20,
						phaseQuietMs: 100,
						onRefresh: (_name, phase, r) => {
							if (phase === "done") result.push(r?.success ?? false);
						},
					});
					const outcome = await sup.requestPhaseRefresh(
						{
							id: boundaryId,
							project: "worker",
							issue: "7",
							phase: "designing",
							sequence: 1,
							pid: String(panePid),
							sessionId: "old",
							requestedAt: Date.now(),
							expiresAt: Date.now() + 60000,
							generation: 0,
						},
						async () => null,
					);
					const cleared = sends.filter((args) => args.includes("/clear")).length;
					if (mode === "success") {
						assert.deepEqual([outcome.success, cleared, result], [true, 1, [true]], `${mode}/${trial}`);
						assert.equal(sends.filter((args) => args.includes("/loop")).length, 1);
					} else {
						assert.equal(outcome.success, false, `${mode}/${trial}`);
						assert.equal(outcome.reason, mode === "next-work" ? "worker-active" : "input-not-empty");
						assert.equal(cleared, 0, `${mode}/${trial}: clear しない`);
						assert.deepEqual(result, []);
					}
				} finally {
					await run(["kill-server"]);
					if (panePid)
						await until(() => {
							try {
								process.kill(panePid, 0);
								return false;
							} catch {
								return true;
							}
						});
					rmSync(root, { recursive: true, force: true });
					assert.equal(existsSync(root), false);
				}
			}
		}
	},
);
