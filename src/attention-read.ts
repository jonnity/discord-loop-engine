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
// OK 語（半角・全角、全部大文字・全部小文字・先頭だけ大文字）。`oK` のような混在は含めない
const OK_WORDS = ["OK", "ok", "Ok", "ＯＫ", "ｏｋ", "Ｏｋ"];
// OK 語の直後に許す 1 文字（語の区切り）。`、` `,` `?` `:` `…` は「ok? まだ」「OK、ただし」を弾くため入れない
const OK_BOUNDARY = /^[\s。．.!！（()）]/;
const ATTENTION_ID = /^A-[1-9][0-9]*$/;
// 空白は列挙。NBSP・BOM・LS/PS・改行を含めると不可視文字で否定語を隠せないため入れない
const SPACE = "[ \\t\u3000]";
const SEPARATOR = "[ \\t\u3000。.!！]";
const DASHES = /[‐–—―ー－]/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 先頭の `A-<番号>` を読む。無ければ null、あれば id と読み進めた後の本文
function readLeadingAttention(body: string): { id: string; rest: string } | null {
	const m = /^A-([1-9][0-9]*)(?![0-9])/.exec(body);
	return m ? { id: `A-${m[1]}`, rest: body.slice(m[0].length) } : null;
}

// OK 語の直後以降に別の A が続くか（従来形のみ）。NFKC とダッシュ畳み込みの後で見る
function followedByOtherAttention(rest: string, attention: string): boolean {
	const folded = rest.replace(/[…‥]/g, "、").normalize("NFKC").replace(DASHES, "-");
	let i = 0;
	while (i < folded.length && /[\s。.!()]/.test(folded.charAt(i))) i++;
	const other = readLeadingAttention(folded.slice(i));
	return other !== null && other.id !== attention;
}

// 新規形の残りが許可文法（区切り・です/ですね・owners 完全一致の署名）だけか。
// 自分宛ての A と OK 語の繰り返しは先に除く
function isAllowedTail(rest: string, attention: string, owners: readonly string[]): boolean {
	const separatorHead = new RegExp(`^${SEPARATOR}+`);
	const separatorNext = new RegExp(`^${SEPARATOR}`);
	let tail = rest;
	for (;;) {
		const t = tail.replace(separatorHead, "");
		const own = new RegExp(`^${attention}(?![0-9])(?=$|${SEPARATOR})`).exec(t);
		const word = OK_WORDS.find(
			(w) => t.startsWith(w) && (t.length === w.length || separatorNext.test(t.slice(w.length))),
		);
		if (own) tail = t.slice(own[0].length);
		else if (word) tail = t.slice(word.length);
		else {
			tail = t;
			break;
		}
	}
	// 署名の名前は owners との完全一致だけ。空文字の owner は名前として認めない
	const names = owners.filter((o) => o !== "");
	const signature = names.length
		? `(?:[(（]Discord[:：]${SPACE}*(?:${names.map(escapeRegExp).join("|")})[)）]${SEPARATOR}*)?`
		: "";
	return new RegExp(`^${SEPARATOR}*(?:(?:です|ですね)${SEPARATOR}*)?${signature}$`).test(tail);
}

// 回答が OK か。前置き除去 → 先頭の A の照合 → OK 語と語境界 → 形ごとの検査、の順。
// Why not: startsWith("OK") のままだと小文字・A 付き・否定の直続きを区別できない。
// Why not: 従来形（A なしの半角大文字 OK）に否定検査をかけないのは、README の人の決定を人の回答なしに覆さないため
export function isAttentionAnswerOk(answer: string, owners: readonly string[], attention: string): boolean {
	if (!ATTENTION_ID.test(attention)) return false;
	let body = stripDiscordAnswerPreamble(answer, owners);
	let legacy = true;
	const lead = readLeadingAttention(body);
	if (lead) {
		if (lead.id !== attention) return false;
		const sep = /^[ \t\u3000:：,，、。.-]+/.exec(lead.rest);
		if (!sep) return false;
		body = lead.rest.slice(sep[0].length);
		legacy = false;
	}
	const word = OK_WORDS.find((w) => body.startsWith(w));
	if (word === undefined) return false;
	if (word !== "OK") legacy = false;
	const rest = body.slice(word.length);
	if (rest !== "" && !OK_BOUNDARY.test(rest)) return false;
	if (legacy) return !followedByOtherAttention(rest, attention);
	return isAllowedTail(rest, attention, owners);
}
export function validTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}
