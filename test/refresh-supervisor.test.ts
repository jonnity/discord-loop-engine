import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RefreshDecision } from "../src/refresh.ts";
import { type SessionTarget, Supervisor } from "../src/supervisor.ts";

function fixture(
	options: {
		diagnostics?: boolean;
		pane?: string;
		status?: string;
		activity?: boolean;
		tokens?: number | null;
		sessionMissing?: boolean;
		transcriptMissing?: boolean;
		cwd?: string;
		codex?: string;
		offline?: boolean;
		windowMissing?: boolean;
		disabled?: boolean;
		failObservation?: boolean;
		readTranscript?: () => Promise<never>;
		logRecent?: boolean;
		subagentRecent?: boolean;
		captureFail?: boolean;
		codexFail?: boolean;
		initialState?: Record<string, unknown>;
		observationSession?: string;
		observationFailure?: "throw" | "timeout";
	} = {},
) {
	let now = 0;
	let cleared = false;
	const decisions: RefreshDecision[] = [];
	const calls: string[][] = [];
	const target: SessionTarget = {
		name: "worker",
		cwd: "/fixture",
		command: "claude",
		initialPrompt: "/loop",
		...(!options.disabled
			? {
					refresh: {
						cwd: "/fixture",
						prompt: "/loop",
						maxTokens: 100000,
						maxEvents: 0,
						contextPercent: 15,
						idleSeconds: 180,
						cooldownMinutes: 30,
						waitForCodex: true,
						codexIgnoreAfterMinutes: 120,
					},
				}
			: {}),
	};
	const sup = new Supervisor({
		tmuxSession: "fixture",
		targets: () => [target],
		isLive: () => !options.offline,
		notify: () => {},
		tmux: async (args) => {
			calls.push(args);
			if (args[0] === "list-windows") return { ok: true, stdout: options.windowMissing ? "" : "dle-worker" };
			if (args[0] === "capture-pane") return { ok: !options.captureFail, stdout: options.pane ?? "history\n❯ " };
			if (args[0] === "display-message") return { ok: true, stdout: "123" };
			if (args[0] === "list-panes") return { ok: !options.codexFail, stdout: options.codex ?? "" };
			if (args.includes("/clear")) cleared = true;
			return { ok: true, stdout: "" };
		},
		readSession: async () =>
			options.sessionMissing
				? null
				: {
						sessionId: cleared ? "new" : "old",
						cwd: options.cwd ?? "/fixture",
						status: options.status ?? "idle",
						updatedAt: 0,
					},
		readTranscript:
			options.readTranscript ??
			(async () =>
				options.transcriptMissing
					? null
					: {
							tokens: options.tokens === undefined ? 150000 : options.tokens,
							mtimeMs: options.logRecent ? now : 0,
							subagentMtimeMs: options.subagentRecent ? now : 0,
						}),
		activity: () => ({ events: 0, lastAt: options.activity ? now : 0 }),
		...(options.observationSession
			? {
					inspectSession: async () => ({
						value: { sessionId: options.observationSession ?? "", cwd: "/fixture", status: "idle", updatedAt: 0 },
						reason: "session-read" as const,
						source: "session-file" as const,
					}),
				}
			: {}),
		now: () => now,
		wait: async () => {},
		promptDelayMs: 0,
		clearConfirmMs: 0,
		...(options.diagnostics === false
			? {}
			: {
					onRefreshDecision: (d: RefreshDecision) => {
						if (options.failObservation) throw new Error("diagnostic failed");
						decisions.push(d);
					},
					refreshObservationTimeoutMs: 10,
				}),
		...(options.observationFailure
			? {
					diagnosticTmux: async () => {
						if (options.observationFailure === "throw") throw new Error("fixture I/O");
						return new Promise(() => {});
					},
				}
			: {}),
	});
	const tick = async (time: number) => {
		now = time;
		await sup.tick();
		await sup.flushRefreshDiagnostics();
	};
	const state = () => (sup as unknown as { st(n: string): { codexSince: Map<string, number> } }).st("worker");
	Object.assign(state(), options.initialState);
	const refresh = async (time: number) => {
		now = time;
		await (sup as unknown as { maybeRefresh(t: SessionTarget): Promise<void> }).maybeRefresh(target);
		await sup.flushRefreshDiagnostics();
	};
	return {
		sup,
		target,
		calls,
		decisions,
		tick,
		refresh,
		state,
		sends: () => calls.filter((c) => c[0] === "send-keys"),
	};
}

test("busy中も超過量と併存理由を記録し、主理由は従来のreturn順になる", async () => {
	const f = fixture({
		activity: true,
		status: "busy",
		pane: "esc to interrupt\n❯ ",
		codex: "codex-impl-1\t/fixture\t@1",
	});
	await f.tick(180000);
	const d = f.decisions.at(-1);
	assert.equal(d?.primaryReason, "activity-recent");
	assert.equal(d?.tokens, 150000);
	assert.equal(d?.overThreshold, true);
	assert.ok(d?.blockers.includes("screen-working"));
	assert.ok(d?.blockers.includes("session-busy"));
	assert.ok(d?.notObserved.includes("codex-age"));
	assert.equal(f.state().codexSince.size, 0, "診断が未登録Codexの観測起点を作らない");
	assert.deepEqual(f.sends(), []);
});

test("全到達前除外・画面・session・量不明の理由とnullを記録する", async () => {
	for (const [options, reason] of [
		[{ offline: true }, "channel-offline"],
		[{ windowMissing: true }, "window-missing"],
		[{ disabled: true }, "refresh-disabled"],
		[{ pane: "esc to interrupt\n❯ " }, "screen-working"],
		[{ pane: "Do you want to proceed?\n❯ " }, "permission-prompt"],
		[{ pane: "❯ input" }, "input-not-empty"],
		[{ sessionMissing: true }, "session-unknown"],
		[{ status: "busy" }, "session-busy"],
		[{ cwd: "/other" }, "cwd-mismatch"],
		[{ transcriptMissing: true }, "transcript-unknown"],
		[{ tokens: null }, "context-unknown"],
		[{ tokens: 99999 }, "below-threshold"],
	] as const) {
		const f = fixture(options);
		await f.tick(180000);
		assert.equal(f.decisions.at(-1)?.primaryReason, reason);
		assert.deepEqual(f.sends(), []);
		if (reason === "context-unknown" || reason === "session-unknown")
			assert.equal(f.decisions.at(-1)?.overThreshold, null);
	}
});

test("診断ON/OFFでCodexの120分起点・期限と通常idleの送信は同じ（独立N=3）", async () => {
	for (let trial = 0; trial < 3; trial++) {
		for (const codex of ["", "codex-impl-1\t/fixture\t@1"]) {
			const on = fixture({ codex });
			const off = fixture({ codex, diagnostics: false });
			for (const time of [0, 180000, 180000 + 120 * 60000 - 1, 180000 + 120 * 60000, 180000 + 120 * 60000 + 1]) {
				await on.tick(time);
				await off.tick(time);
				assert.deepEqual(on.sends(), off.sends());
				assert.deepEqual(on.state().codexSince, off.state().codexSince);
			}
			assert.equal(on.sends().filter((c) => c.includes("/clear")).length, codex ? 1 : 2);
		}
	}
});

test("診断は消えたCodexキーを削除せず、通常判定だけが削除する", async () => {
	const f = fixture({ activity: true });
	f.state().codexSince.set("@old:/fixture", 1);
	await f.tick(180000);
	assert.equal(f.state().codexSince.get("@old:/fixture"), 1);
});

test("排他・起動猶予・冷却・更新時刻・遷移中のearly returnにも固定主理由が付く", async () => {
	for (const [options, time, reason] of [
		[{ initialState: { refreshing: true } }, 180000, "refreshing"],
		[{ initialState: { wake: { sending: true } } }, 180000, "wake-sending"],
		[{ initialState: { limited: true } }, 180000, "limited"],
		[{}, 179999, "startup-grace"],
		[{ initialState: { lastRefreshAt: 180000 } }, 180000, "cooldown"],
		[{ captureFail: true }, 180000, "capture-unknown"],
		[{ logRecent: true }, 180000, "transcript-recent"],
		[{ subagentRecent: true }, 180000, "subagent-recent"],
		[{ codexFail: true }, 180000, "codex-busy"],
		[{ initialState: { transitionSession: "old" }, tokens: null }, 180000, "transition-unknown"],
	] as const) {
		const f = fixture(options);
		await f.refresh(time);
		assert.equal(f.decisions.at(-1)?.primaryReason, reason);
		assert.deepEqual(f.sends(), []);
	}
});

test("観測中にsessionが切り替わっても整理結果の量は実際の判定sessionへ結ぶ", async () => {
	const f = fixture({ observationSession: "another-session" });
	await f.tick(180000);
	assert.equal(f.decisions.at(-1)?.primaryReason, "refresh-success");
	assert.equal(f.decisions.at(-1)?.session, "old");
	assert.equal(f.decisions.at(-1)?.tokens, 150000);
});

test("診断のcallback失敗・timeoutが既存の整理判定を妨げず、30秒周期で重ねない", async () => {
	const failed = fixture({ failObservation: true });
	await failed.tick(180000);
	assert.equal(failed.sends().filter((c) => c.includes("/clear")).length, 1);
	let reads = 0;
	const pending = fixture({
		activity: true,
		readTranscript: () => {
			reads++;
			return new Promise(() => {});
		},
	});
	await pending.tick(180000);
	assert.equal(pending.decisions.at(-1)?.source, "unknown");
	await pending.tick(180001);
	assert.equal(reads, 1);
	await pending.tick(210000);
	assert.equal(reads, 1, "timeout後も未完了の読取に新しい読取を重ねない");
});

test("29.9秒間隔の連続tickでも整理が走ったtickのrefresh-successが残る", async () => {
	const f = fixture();
	await f.tick(150100);
	assert.equal(f.sends().filter((c) => c.includes("/clear")).length, 0);
	await f.tick(180000);
	assert.equal(f.sends().filter((c) => c.includes("/clear")).length, 1);
	assert.equal(f.decisions.at(-1)?.primaryReason, "refresh-success");
});

test("独立診断のI/O例外・timeoutでもengine単独の通常idle整理は進む（独立N=3）", async () => {
	for (let trial = 0; trial < 3; trial++) {
		for (const observationFailure of ["throw", "timeout"] as const) {
			const f = fixture({ observationFailure });
			await f.tick(180000);
			assert.equal(f.sends().filter((c) => c.includes("/clear")).length, 1);
			assert.equal(f.sends().filter((c) => c.includes("/loop")).length, 1);
			assert.equal(f.decisions.at(-1)?.result, true);
		}
	}
});
