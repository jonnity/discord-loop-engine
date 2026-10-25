// Claude Code の内部ファイルは公開仕様ではないため、読めないときは推測せず不明を返す。
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClaudeSession {
	sessionId: string;
	cwd: string;
	status: string;
	updatedAt: number;
}

export interface TranscriptContext {
	tokens: number | null;
	mtimeMs: number;
	subagentMtimeMs: number;
}

const TAIL_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function usageTokens(line: string): number | null {
	try {
		const row = record(JSON.parse(line));
		if (row?.type !== "assistant") return null;
		const usage = record(record(row.message)?.usage);
		if (!usage || typeof usage.input_tokens !== "number") return null;
		const values = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
		if (!values.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
		const total = values.reduce((a, b) => a + b, 0);
		return Number.isFinite(total) ? total : null;
	} catch {
		return null;
	}
}

async function latestSubagent(dir: string): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw e;
	}
	const times = await Promise.all(
		entries.filter((f) => f.endsWith(".jsonl")).map(async (f) => (await stat(path.join(dir, f))).mtimeMs),
	);
	return Math.max(0, ...times);
}

export function contextReader(claudeHome = path.join(os.homedir(), ".claude")) {
	return {
		async readSession(pid: string): Promise<ClaudeSession | null> {
			if (!/^\d+$/.test(pid)) return null;
			try {
				const row = record(JSON.parse(await readFile(path.join(claudeHome, "sessions", `${pid}.json`), "utf8")));
				if (
					!row ||
					typeof row.sessionId !== "string" ||
					!/^[\w-]+$/.test(row.sessionId) ||
					typeof row.cwd !== "string" ||
					!path.isAbsolute(row.cwd) ||
					typeof row.status !== "string"
				)
					return null;
				const updatedAt =
					typeof row.updatedAt === "number"
						? row.updatedAt
						: typeof row.updatedAt === "string"
							? Date.parse(row.updatedAt)
							: Number.NaN;
				if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
				return { sessionId: row.sessionId, cwd: row.cwd, status: row.status, updatedAt };
			} catch {
				return null;
			}
		},
		async readTranscript(session: ClaudeSession): Promise<TranscriptContext | null> {
			const dir = path.join(claudeHome, "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
			try {
				const subagentMtimeMs = await latestSubagent(path.join(dir, session.sessionId, "subagents"));
				const filename = path.join(dir, `${session.sessionId}.jsonl`);
				// ログ未作成は画面で補えるが、サブエージェントの活動が不明なら待機を保証できない。
				const file = await open(filename, "r").catch((e: NodeJS.ErrnoException) => {
					if (e.code === "ENOENT") return null;
					throw e;
				});
				if (!file) return { tokens: null, mtimeMs: session.updatedAt, subagentMtimeMs };
				try {
					const info = await file.stat();
					const offset = Math.max(0, info.size - TAIL_BYTES);
					const buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES));
					const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
					const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
					if (offset > 0) lines.shift();
					let tokens: number | null = null;
					for (let i = lines.length - 1; i >= 0; i--) {
						tokens = usageTokens(lines[i] ?? "");
						if (tokens !== null) break;
					}
					return {
						tokens,
						mtimeMs: info.mtimeMs,
						subagentMtimeMs,
					};
				} finally {
					await file.close();
				}
			} catch {
				return null;
			}
		},
	};
}
