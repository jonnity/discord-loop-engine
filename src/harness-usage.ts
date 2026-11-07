// 採取方法を固定した匿名化データだけを集計する。実 transcript の探索や投稿は行わない。
import { isDeepStrictEqual } from "node:util";
import { isObject } from "./harness-json.ts";

interface Usage {
	input: number;
	output: number;
	cacheCreation: number;
	cacheRead: number;
}
interface UsageRow {
	id: string;
	project: string;
	role: string;
	model: string;
	timestamp: string;
	usage: Usage;
}
const keys = ["input", "output", "cacheCreation", "cacheRead"] as const;
const empty = (): Usage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
function validRow(value: unknown, projects: Set<string>): value is UsageRow {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		!!value.id &&
		typeof value.project === "string" &&
		projects.has(value.project) &&
		typeof value.role === "string" &&
		["window", "tick", "spec", "review"].includes(value.role) &&
		typeof value.model === "string" &&
		!!value.model &&
		typeof value.timestamp === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.timestamp) &&
		Number.isFinite(Date.parse(value.timestamp)) &&
		new Date(value.timestamp).toISOString().replace(/\.000Z$/, "Z") === value.timestamp.replace(/\.000Z$/, "Z") &&
		isObject(value.usage) &&
		keys.every((key) => {
			const v = (value.usage as Record<string, unknown>)[key];
			return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
		})
	);
}
export function summarizeUsage(rows: unknown[], projects: Set<string>, from: string, until: string) {
	const start = Date.parse(from),
		end = Date.parse(until);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error("UTC 集計期間が不正です");
	const unique = new Map<string, UsageRow>(),
		conflicts = new Set<string>();
	let invalid = 0,
		duplicates = 0,
		outside = 0;
	for (const row of rows) {
		if (!validRow(row, projects)) {
			invalid++;
			continue;
		}
		if (conflicts.has(row.id)) continue;
		const previous = unique.get(row.id);
		if (previous) {
			if (isDeepStrictEqual(previous, row)) duplicates++;
			else {
				conflicts.add(row.id);
				unique.delete(row.id);
			}
		} else unique.set(row.id, row);
	}
	const totals = empty(),
		groups = new Map<string, { project: string; role: string; model: string; count: number; usage: Usage }>();
	let count = 0;
	for (const row of unique.values()) {
		const timestamp = Date.parse(row.timestamp);
		if (timestamp < start || timestamp >= end) {
			outside++;
			continue;
		}
		const key = JSON.stringify([row.project, row.role, row.model]);
		const group = groups.get(key) ?? {
			project: row.project,
			role: row.role,
			model: row.model,
			count: 0,
			usage: empty(),
		};
		for (const key of keys) {
			totals[key] += row.usage[key];
			group.usage[key] += row.usage[key];
			if (!Number.isSafeInteger(totals[key])) throw Error("usage の整数合計が上限を超えました");
		}
		count++;
		group.count++;
		groups.set(key, group);
	}
	return { totals, groups: [...groups.values()], count, duplicates, conflicts: conflicts.size, invalid, outside };
}
export function displayTokens(value: number): string {
	if (!Number.isSafeInteger(value) || value < 0) throw Error("token は非負の安全な整数が必要です");
	const tenths = (BigInt(value) + 500n) / 1000n;
	return `${tenths / 10n}.${tenths % 10n}万`;
}
