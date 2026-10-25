import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contextReader } from "../src/context.ts";

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
