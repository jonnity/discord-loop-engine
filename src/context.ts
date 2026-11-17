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

export type ContextReadReason =
	| "session-read"
	| "session-missing"
	| "session-invalid"
	| "session-unreadable"
	| "transcript-read"
	| "transcript-missing"
	| "usage-unknown"
	| "transcript-unreadable"
	| "subagent-unreadable";
export interface ContextInspection<T> {
	value: T | null;
	reason: ContextReadReason;
	source: "session-file" | "transcript-file";
}
/**
 * refresh_checkpoint の呼出し以降に、worker が次の作業を始めていないかの読取結果。
 * settled: 結果の後にあるのが最後の assistant テキストだけ / waiting: 結果がまだ無い / active: 次の作業の痕跡がある /
 * unknown: 呼出しを1件に特定できない・読めない・範囲外
 */
export type BoundaryActivity = "settled" | "waiting" | "active" | "unknown";

interface ContextReader {
	readBoundaryActivity: (session: ClaudeSession, boundaryId: string) => Promise<BoundaryActivity>;
	readSession: (pid: string) => Promise<ClaudeSession | null>;
	readTranscript: (session: ClaudeSession) => Promise<TranscriptContext | null>;
	inspectSession: (pid: string) => Promise<ContextInspection<ClaudeSession>>;
	inspectTranscript: (session: ClaudeSession) => Promise<ContextInspection<TranscriptContext>>;
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

const isCheckpointTool = (name: unknown) =>
	typeof name === "string" && (name === "refresh_checkpoint" || name.endsWith("__refresh_checkpoint"));

function contentBlocks(row: Record<string, unknown> | null): Record<string, unknown>[] | null {
	const content = record(row?.message)?.content;
	if (!Array.isArray(content)) return null;
	const blocks = content.map(record);
	return blocks.every((b) => b !== null) ? (blocks as Record<string, unknown>[]) : null;
}

/**
 * 主ログの末尾から、公開ツール名と input.boundary_id の完全一致で checkpoint の tool_use を1件に特定し、
 * 対応する tool_result 以後に許すのを最後の assistant テキストだけにする。
 * Why not mtime の一致: 更新があったことしか分からず、次の作業を始めていないことの証拠にならない。
 * Why not RPC の call.id: channel の c1 等は Claude の tool_use_id と別物（channel/server.ts）。
 */
export function classifyBoundaryActivity(lines: string[], boundaryId: string): BoundaryActivity {
	const rows: (Record<string, unknown> | null)[] = lines.map((line) => {
		try {
			return record(JSON.parse(line));
		} catch {
			return null;
		}
	});
	let useIndex = -1;
	let useId = "";
	for (const [i, row] of rows.entries()) {
		if (row?.type !== "assistant") continue;
		for (const block of contentBlocks(row) ?? []) {
			if (block.type !== "tool_use" || !isCheckpointTool(block.name)) continue;
			if (record(block.input)?.boundary_id !== boundaryId) continue;
			if (useIndex >= 0) return "unknown";
			if (typeof block.id !== "string" || !block.id) return "unknown";
			useIndex = i;
			useId = block.id;
		}
	}
	if (useIndex < 0) return "unknown";
	const resultIndex = rows.findIndex((row, i) => {
		if (i <= useIndex || row?.type !== "user") return false;
		return (contentBlocks(row) ?? []).some((b) => b.type === "tool_result" && b.tool_use_id === useId);
	});
	if (resultIndex < 0) return rows.slice(useIndex + 1).every((row) => row !== null) ? "waiting" : "unknown";
	for (const row of rows.slice(resultIndex + 1)) {
		if (row === null) return "unknown";
		if (row.type === "system" && row.subtype !== "compact_boundary") continue;
		if (row.type !== "assistant") return "active";
		const blocks = contentBlocks(row);
		if (!blocks) return "unknown";
		if (!blocks.every((b) => b.type === "text" || b.type === "thinking")) return "active";
	}
	return "settled";
}

export function contextReader(
	claudeHome = path.join(os.homedir(), ".claude"),
	report: (reason: ContextReadReason) => void = () => {},
): ContextReader {
	return {
		async readBoundaryActivity(session: ClaudeSession, boundaryId: string): Promise<BoundaryActivity> {
			const filename = path.join(
				claudeHome,
				"projects",
				session.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
				`${session.sessionId}.jsonl`,
			);
			try {
				const file = await open(filename, "r");
				try {
					const info = await file.stat();
					const offset = Math.max(0, info.size - TAIL_BYTES);
					const buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES));
					const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
					const text = buffer.subarray(0, bytesRead).toString("utf8");
					const lines = text.split("\n");
					// 末尾が改行で終わらない行は書込み途中かもしれないので、読み切れた行として扱わない
					if (!text.endsWith("\n")) lines.pop();
					if (offset > 0) lines.shift();
					return classifyBoundaryActivity(
						lines.filter((line) => line.trim() !== ""),
						boundaryId,
					);
				} finally {
					await file.close();
				}
			} catch {
				return "unknown";
			}
		},
		async inspectSession(pid) {
			let reason: ContextReadReason = "session-unreadable";
			const value = await contextReader(claudeHome, (r) => {
				reason = r;
			}).readSession(pid);
			return { value, reason, source: "session-file" };
		},
		async inspectTranscript(session) {
			let reason: ContextReadReason = "transcript-unreadable";
			const value = await contextReader(claudeHome, (r) => {
				reason = r;
			}).readTranscript(session);
			return { value, reason, source: "transcript-file" };
		},
		async readSession(pid: string): Promise<ClaudeSession | null> {
			if (!/^\d+$/.test(pid)) {
				report("session-invalid");
				return null;
			}
			try {
				const row = record(JSON.parse(await readFile(path.join(claudeHome, "sessions", `${pid}.json`), "utf8")));
				if (
					!row ||
					typeof row.sessionId !== "string" ||
					!/^[\w-]+$/.test(row.sessionId) ||
					typeof row.cwd !== "string" ||
					!path.isAbsolute(row.cwd) ||
					typeof row.status !== "string"
				) {
					report("session-invalid");
					return null;
				}
				const updatedAt =
					typeof row.updatedAt === "number"
						? row.updatedAt
						: typeof row.updatedAt === "string"
							? Date.parse(row.updatedAt)
							: Number.NaN;
				if (!Number.isFinite(updatedAt) || updatedAt < 0) {
					report("session-invalid");
					return null;
				}
				report("session-read");
				return { sessionId: row.sessionId, cwd: row.cwd, status: row.status, updatedAt };
			} catch (error) {
				report(
					error instanceof SyntaxError
						? "session-invalid"
						: (error as NodeJS.ErrnoException).code === "ENOENT"
							? "session-missing"
							: "session-unreadable",
				);
				return null;
			}
		},
		async readTranscript(session: ClaudeSession): Promise<TranscriptContext | null> {
			const dir = path.join(claudeHome, "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
			let stage: ContextReadReason = "subagent-unreadable";
			try {
				const subagentMtimeMs = await latestSubagent(path.join(dir, session.sessionId, "subagents"));
				stage = "transcript-unreadable";
				const filename = path.join(dir, `${session.sessionId}.jsonl`);
				// ログ未作成は画面で補えるが、サブエージェントの活動が不明なら待機を保証できない。
				const file = await open(filename, "r").catch((e: NodeJS.ErrnoException) => {
					if (e.code === "ENOENT") return null;
					throw e;
				});
				if (!file) {
					report("transcript-missing");
					return { tokens: null, mtimeMs: session.updatedAt, subagentMtimeMs };
				}
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
					report(tokens === null ? "usage-unknown" : "transcript-read");
					return {
						tokens,
						mtimeMs: info.mtimeMs,
						subagentMtimeMs,
					};
				} finally {
					await file.close();
				}
			} catch {
				report(stage);
				return null;
			}
		},
	};
}
