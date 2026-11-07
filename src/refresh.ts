// 診断は整理の許可に使わない。判定・送信器とは独立に、数値と固定理由だけを保存する。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ContextReadReason } from "./context.ts";

export type RefreshReason =
	| "refresh-disabled"
	| "native"
	| "not-ready"
	| "inactive"
	| "startup-error"
	| "channel-offline"
	| "window-missing"
	| "refreshing"
	| "wake-sending"
	| "limited"
	| "startup-grace"
	| "cooldown"
	| "activity-recent"
	| "capture-unknown"
	| "screen-working"
	| "permission-prompt"
	| "input-not-empty"
	| "session-unknown"
	| "session-busy"
	| "cwd-mismatch"
	| "transcript-unknown"
	| "transcript-recent"
	| "subagent-recent"
	| "codex-busy"
	| "codex-unknown"
	| "transition-unknown"
	| "context-unknown"
	| "below-threshold"
	| "activity-race"
	| "wake-race"
	| "refresh-success"
	| "refresh-failed"
	| "decision-unknown";

export interface RefreshPressure {
	tokens: number | null;
	source: "transcript" | "screen" | "unknown";
	remainingPercent: number | null;
	overThreshold: boolean | null;
}

export interface RefreshDecision extends RefreshPressure {
	project: string;
	session: string | null;
	at: number;
	primaryReason: RefreshReason;
	blockers: RefreshReason[];
	notObserved: string[];
	result?: boolean;
	readReasons?: ContextReadReason[];
}

export interface RefreshCoverage {
	project: string;
	reason: RefreshReason | "eligible";
	settings: {
		maxTokens: number;
		maxEvents: number;
		contextPercent: number;
		idleSeconds: number;
		cooldownMinutes: number;
		codexIgnoreAfterMinutes: number;
		waitForCodex: boolean;
	} | null;
	mode?: string;
	ready?: boolean;
	enabled?: boolean;
}

export function pressure(
	r: Pick<NonNullable<RefreshCoverage["settings"]>, "maxTokens" | "maxEvents" | "contextPercent">,
	transcript: number | null,
	screen: number | null,
	remainingPercent: number | null,
	events: number,
): RefreshPressure {
	const tokens = transcript ?? screen;
	const reached =
		(r.maxTokens > 0 &&
			(tokens !== null ? tokens >= r.maxTokens : remainingPercent !== null && remainingPercent <= r.contextPercent)) ||
		(r.maxEvents > 0 && events >= r.maxEvents);
	return {
		tokens,
		source: transcript !== null ? "transcript" : screen !== null ? "screen" : "unknown",
		remainingPercent,
		overThreshold: reached ? true : r.maxTokens > 0 && tokens === null && remainingPercent === null ? null : false,
	};
}

interface Aggregate extends RefreshDecision {
	count: number;
	firstAt: number;
	lastAt: number;
	maxTokens: number | null;
	overThresholdCount: number;
	unknownCount: number;
}

export class RefreshDiagnostics {
	private pending = new Map<string, Aggregate>();
	private reasons = new Map<string, string>();
	/** journalは session / primaryReason の変化だけで出す（blockers のゆれで増やさない）。 */
	private journalKeys = new Map<string, string>();
	private covered = new Map<string, string>();
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		privateHome: string,
		journal: (message: string) => void = () => {},
		onError: (message: string) => void = () => {},
	) {
		this.home = privateHome;
		this.journal = journal;
		this.onError = onError;
		try {
			const hash = createHash("sha256");
			for (const name of ["refresh", "supervisor", "context", "engine", "projects", "config", "protocol"])
				hash.update(readFileSync(new URL(`./${name}.ts`, import.meta.url)));
			this.implementationHash = hash.digest("hex");
		} catch {
			this.implementationHash = "unknown";
		}
	}
	private home: string;
	private journal: (message: string) => void;
	private onError: (message: string) => void;
	private implementationHash: string;

	private enqueue(work: () => Promise<void>): Promise<void> {
		if (this.closed) return this.queue;
		this.queue = this.queue.then(work).catch(() => {
			// エラーメッセージには絶対パスや入力本文が含まれ得るため固定文だけを返す。
			try {
				this.onError("refresh: 診断の保存に失敗しました（欠測）");
			} catch {}
		});
		return this.queue;
	}

	private async append(kind: "decisions" | "coverage", at: number, row: unknown) {
		const base = path.join(this.home, "refresh");
		for (const dir of [base, path.join(base, kind)]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const info = await lstat(dir);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe-directory");
			await chmod(dir, 0o700);
		}
		const file = path.join(base, kind, `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
		const info = await lstat(file).catch((e: NodeJS.ErrnoException) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
		if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("unsafe-file");
		await appendFile(
			file,
			`${JSON.stringify({ schemaVersion: 1, implementationHash: this.implementationHash, ...(row as object) })}\n`,
			{ mode: 0o600 },
		);
		await chmod(file, 0o600);
	}

	record(row: RefreshDecision): Promise<void> {
		return this.enqueue(async () => {
			const key = JSON.stringify([row.session, row.primaryReason, row.blockers, row.notObserved, row.readReasons]);
			const previous = this.pending.get(row.project);
			if (
				previous &&
				(this.reasons.get(row.project) !== key ||
					new Date(previous.firstAt).toISOString().slice(0, 10) !== new Date(row.at).toISOString().slice(0, 10))
			) {
				await this.append("decisions", previous.firstAt, previous);
				this.pending.delete(row.project);
			}
			const journalKey = JSON.stringify([row.session, row.primaryReason]);
			if (this.journalKeys.get(row.project) !== journalKey || row.result !== undefined) {
				this.journal(`[${row.project}] refresh: ${row.primaryReason}`);
			}
			this.journalKeys.set(row.project, journalKey);
			this.reasons.set(row.project, key);
			const prev = this.pending.get(row.project);
			const aggregate: Aggregate = {
				...row,
				count: (prev?.count ?? 0) + 1,
				firstAt: prev?.firstAt ?? row.at,
				lastAt: row.at,
				maxTokens: row.tokens === null ? (prev?.maxTokens ?? null) : Math.max(prev?.maxTokens ?? 0, row.tokens),
				overThresholdCount: (prev?.overThresholdCount ?? 0) + Number(row.overThreshold === true),
				unknownCount: (prev?.unknownCount ?? 0) + Number(row.overThreshold === null),
			};
			this.pending.set(row.project, aggregate);
			if (row.result !== undefined || row.at - aggregate.firstAt >= 300000) {
				await this.append("decisions", aggregate.firstAt, aggregate);
				this.pending.delete(row.project);
			}
		});
	}

	coverage(rows: RefreshCoverage[], at = Date.now()): Promise<void> {
		return this.enqueue(async () => {
			for (const row of rows) {
				const key = JSON.stringify(row);
				if (this.covered.get(row.project) === key) continue;
				await this.append("coverage", at, { ...row, at, runtime: process.version });
				this.covered.set(row.project, key);
			}
		});
	}

	async close(): Promise<void> {
		await this.enqueue(async () => {
			for (const row of this.pending.values()) await this.append("decisions", row.firstAt, row);
			this.pending.clear();
		});
		this.closed = true;
	}
}
