// 承認用の読取りは補完・修復・RPC をせず、保存された証拠だけを返す。
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AttentionRecord {
	id: string;
	[field: string]: unknown;
}
export interface AttentionSnapshot {
	schemaVersion: 1;
	items: AttentionRecord[];
}
export function validateAttentionSnapshot(value: unknown): AttentionSnapshot {
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("items" in value) ||
		!Array.isArray(value.items)
	)
		throw Error("台帳の出力形式が不正です");
	const ids = new Set<string>();
	const items: AttentionRecord[] = [];
	for (const item of value.items) {
		if (
			typeof item !== "object" ||
			item === null ||
			Array.isArray(item) ||
			typeof item.id !== "string" ||
			!/^A-[1-9][0-9]*$/.test(item.id) ||
			ids.has(item.id)
		)
			throw Error("台帳の ID が不正です");
		ids.add(item.id);
		items.push(item);
	}
	return { schemaVersion: 1, items };
}
export async function readAttentionSnapshot(home: string): Promise<AttentionSnapshot> {
	const items: unknown = JSON.parse(await readFile(path.join(home, "attention.json"), "utf8"));
	return validateAttentionSnapshot({ schemaVersion: 1, items });
}
export async function readAttentionSequence(home: string): Promise<number> {
	const value: unknown = JSON.parse(await readFile(path.join(home, "state.json"), "utf8"));
	if (
		typeof value !== "object" ||
		value === null ||
		!("attentionSeq" in value) ||
		typeof value.attentionSeq !== "number" ||
		!Number.isSafeInteger(value.attentionSeq) ||
		value.attentionSeq < 0
	)
		throw Error("台帳の発行番号が不正です");
	return value.attentionSeq;
}
export function stripDiscordAnswerPreamble(answer: string, owners: readonly string[]): string {
	const body = answer.trim();
	for (const owner of owners) {
		const preamble = `${owner} が Discord で回答。`;
		if (body.startsWith(preamble)) return body.slice(preamble.length).trim();
	}
	return body;
}
export function isAttentionAnswerOk(answer: string, owners: readonly string[]): boolean {
	return stripDiscordAnswerPreamble(answer, owners).startsWith("OK");
}
export function validTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}
