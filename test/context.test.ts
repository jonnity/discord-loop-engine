import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyBoundaryActivity, contextReader } from "../src/context.ts";

const usage = (input: number, create: number, read: number) =>
	JSON.stringify({
		type: "assistant",
		message: { usage: { input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: read } },
	});

test("内部ファイルから最後の assistant usage の合計と本体・サブエージェントの更新時刻を読む", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "dle-context-"));
	try {
		await mkdir(path.join(home, "sessions"));
		const dir = path.join(home, "projects", "-work-repo");
		await mkdir(path.join(dir, "session", "subagents"), { recursive: true });
		await writeFile(
			path.join(home, "sessions", "123.json"),
			JSON.stringify({ sessionId: "session", cwd: "/work/repo", status: "idle", updatedAt: 1000 }),
		);
		await writeFile(
			path.join(dir, "session.jsonl"),
			[usage(1, 2, 3), "broken", usage(2, 843, 154197), '{"type":"user"}', ""].join("\n"),
		);
		await writeFile(path.join(dir, "session", "subagents", "agent.jsonl"), usage(999999, 0, 0));
		const reader = contextReader(home);
		const session = await reader.readSession("123");
		assert.ok(session);
		const result = await reader.readTranscript(session);
		assert.equal(result?.tokens, 155042);
		assert.ok((result?.mtimeMs ?? 0) > 0);
		assert.ok((result?.subagentMtimeMs ?? 0) > 0);
		assert.equal(await reader.readSession("missing"), null);
		await writeFile(path.join(home, "sessions", "123.json"), "{}");
		assert.equal(await reader.readSession("123"), null);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("会話ログが無い・空・壊れている・巨大なときも安全に末尾から読む", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "dle-context-"));
	const session = { sessionId: "s", cwd: "/w", status: "idle", updatedAt: 0 };
	try {
		const dir = path.join(home, "projects", "-w");
		await mkdir(dir, { recursive: true });
		const reader = contextReader(home);
		assert.equal((await reader.readTranscript(session))?.tokens, null);
		for (const content of ["", "broken", '{"type":"assistant","message":{"usage":{"input_tokens":-1}}}']) {
			await writeFile(path.join(dir, "s.jsonl"), content);
			assert.equal((await reader.readTranscript(session))?.tokens, null);
		}
		await writeFile(path.join(dir, "s.jsonl"), `${"x".repeat(5 * 1024 * 1024)}\n${usage(100000, 0, 0)}\n`);
		assert.equal((await reader.readTranscript(session))?.tokens, 100000);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("サブエージェントの活動が読めない場合は画面へのフォールバックを許可しない", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "dle-context-"));
	try {
		const dir = path.join(home, "projects", "-w", "s");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "subagents"), "ディレクトリではない");
		const result = await contextReader(home).readTranscript({
			sessionId: "s",
			cwd: "/w",
			status: "idle",
			updatedAt: 0,
		});
		assert.equal(result, null);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("診断readerは読取不能の固定理由と出所を返し、既存readerの値を変えない", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "dle-context-detail-"));
	try {
		const reader = contextReader(home);
		assert.deepEqual(await reader.inspectSession("123"), {
			value: null,
			reason: "session-missing",
			source: "session-file",
		});
		await mkdir(path.join(home, "sessions"));
		await writeFile(path.join(home, "sessions/123.json"), "{}");
		assert.equal((await reader.inspectSession("123")).reason, "session-invalid");
		const session = { sessionId: "s", cwd: "/fixture", status: "busy", updatedAt: 0 };
		const missing = await reader.inspectTranscript(session);
		assert.equal(missing.reason, "transcript-missing");
		assert.deepEqual(missing.value, await reader.readTranscript(session));
		const dir = path.join(home, "projects/-fixture/s");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "subagents"), "not a directory");
		assert.equal((await reader.inspectTranscript(session)).reason, "subagent-unreadable");
		assert.equal(await reader.readTranscript(session), null);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

const toolUse = (id: string, boundary: string, name = "mcp__plugin_discord-loop-engine_dle__refresh_checkpoint") =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", id, name, input: { boundary_id: boundary } }] },
	});
const toolResult = (id: string) =>
	JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const text = (value: string) =>
	JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: value }], stop_reason: "end_turn" } });

test("T6: checkpoint の tool_use を公開ツール名と boundary_id で1件に特定し、結果の後が最後のテキストだけなら settled", () => {
	const lines = ["", toolUse("tu1", "b1"), toolResult("tu1"), text("引継ぎを保存しました。ここで止まります")].filter(
		Boolean,
	);
	assert.equal(classifyBoundaryActivity(lines, "b1"), "settled");
	assert.equal(classifyBoundaryActivity(lines.slice(0, 1), "b1"), "waiting");
	// 結果の後に次の作業（tool_use・user）が続けば active
	assert.equal(classifyBoundaryActivity([...lines, toolUse("tu2", "other", "Bash")], "b1"), "active");
	assert.equal(
		classifyBoundaryActivity([...lines, JSON.stringify({ type: "user", message: { content: "next" } })], "b1"),
		"active",
	);
	// system 行（compact 以外）は許し、compact は作業の痕跡として止める
	assert.equal(
		classifyBoundaryActivity([...lines, JSON.stringify({ type: "system", subtype: "turn_duration" })], "b1"),
		"settled",
	);
	assert.equal(
		classifyBoundaryActivity([...lines, JSON.stringify({ type: "system", subtype: "compact_boundary" })], "b1"),
		"active",
	);
});

test("T6: 特定できない・曖昧・壊れたログは unknown（mtime だけで次の作業なしと推測しない）", () => {
	assert.equal(classifyBoundaryActivity([text("x")], "b1"), "unknown");
	assert.equal(classifyBoundaryActivity([toolUse("tu1", "b2"), toolResult("tu1")], "b1"), "unknown");
	// 同じ boundary_id の呼出しが2件
	assert.equal(classifyBoundaryActivity([toolUse("tu1", "b1"), toolUse("tu2", "b1")], "b1"), "unknown");
	// ツール名が違えば別物（boundary_id が同じでも拾わない）
	assert.equal(classifyBoundaryActivity([toolUse("tu1", "b1", "Bash"), toolResult("tu1")], "b1"), "unknown");
	// 結果の後の壊れた行
	assert.equal(classifyBoundaryActivity([toolUse("tu1", "b1"), toolResult("tu1"), "{broken"], "b1"), "unknown");
	// id が無い tool_use
	const noId = JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", name: "refresh_checkpoint", input: { boundary_id: "b1" } }] },
	});
	assert.equal(classifyBoundaryActivity([noId], "b1"), "unknown");
});

test("T6: readBoundaryActivity は主ログの末尾を読み、書込み途中の行は読み切れた行として扱わない", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "dle-context-"));
	try {
		const dir = path.join(home, "projects", "-work-repo");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		const session = { sessionId: "session", cwd: "/work/repo", status: "idle", updatedAt: 1 };
		const reader = contextReader(home);
		await writeFile(file, `${[toolUse("tu1", "b1"), toolResult("tu1"), text("done")].join("\n")}\n`);
		assert.equal(await reader.readBoundaryActivity(session, "b1"), "settled");
		await writeFile(file, `${[toolUse("tu1", "b1"), toolResult("tu1")].join("\n")}\n{"type":"assistant","mess`);
		assert.equal(
			await reader.readBoundaryActivity(session, "b1"),
			"settled",
			"途中の行は捨てて、読めた所までで判定する",
		);
		await rm(file);
		assert.equal(await reader.readBoundaryActivity(session, "b1"), "unknown");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
