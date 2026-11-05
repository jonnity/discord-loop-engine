import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	isAttentionAnswerOk,
	readAttentionSequence,
	readAttentionSnapshot,
	stripDiscordAnswerPreamble,
} from "../src/attention-read.ts";

test("T1: 厳密な読取りは旧項目・未知項目を保持し、成功時も失敗時も書き込まない", async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-read-"));
	try {
		const file = path.join(home, "attention.json");
		writeFileSync(path.join(home, "state.json"), '{"attentionSeq":12,"future":true}');
		const items = [
			{ id: "A-1", status: "open" },
			{ id: "A-12", status: "resolved", answer: " OK\n", future: [1] },
		];
		writeFileSync(file, JSON.stringify(items));
		const before = () =>
			readdirSync(home).map((f) => [f, readFileSync(path.join(home, f), "utf8"), statSync(path.join(home, f)).mtimeMs]);
		const original = before();
		assert.deepEqual(await readAttentionSnapshot(home), { schemaVersion: 1, items });
		assert.equal(await readAttentionSequence(home), 12);
		assert.deepEqual(before(), original);
		for (const raw of ["", "{", "{}", '[{"id":"A-01"}]', '[{"id":"A-1"},{"id":"A-1"}]', "[null]", '[{"id":12}]']) {
			writeFileSync(file, raw);
			const saved = before();
			await assert.rejects(readAttentionSnapshot(home));
			assert.deepEqual(before(), saved);
		}
		writeFileSync(file, "[]");
		assert.deepEqual((await readAttentionSnapshot(home)).items, []);
		for (const value of [-1, 1.1, "12", null, Number.MAX_SAFE_INTEGER + 1]) {
			writeFileSync(path.join(home, "state.json"), JSON.stringify({ attentionSeq: value }));
			await assert.rejects(readAttentionSequence(home));
		}
		rmSync(file);
		await assert.rejects(readAttentionSnapshot(home));
		await assert.rejects(readAttentionSequence(path.join(home, "missing")));
		assert.deepEqual(readdirSync(home), ["state.json"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

const actualAnswers = [
	"OK（Discord: jonnity）",
	"jonnity が Discord で回答。OK(マージを承認)。",
	"jonnity が Discord で回答。OK(PR #23 のマージを承認)。設計外の追加(formatEmbeds: false)も含めて承認。マージ後に #17 を rebase してください。",
	"NG: 表示は良い感じ。ただし…（この返事は OK ではない）。（Discord: jonnity）",
];
const ok = (answer: string, attention = "A-12", owners: readonly string[] = ["jonnity"]) =>
	isAttentionAnswerOk(answer, owners, attention);

test("T1/T3: 共通の本文判定はownersの前置きを1回だけ除く", () => {
	assert.deepEqual(
		actualAnswers.map((a) => ok(a)),
		[true, true, true, false],
	);
	const prefixed = "jonnity が Discord で回答。OK";
	assert.equal(stripDiscordAnswerPreamble(prefixed, ["jonnity"]), "OK");
	for (const owners of [[], ["other"], ["Jonnity"], ["jonn"]]) assert.equal(ok(prefixed, "A-12", owners), false);
	assert.equal(ok(`jonnity が Discord で回答。${prefixed}`), false);
	assert.equal(ok("a.* が Discord で回答。OK", "A-12", ["a.*"]), true);
	assert.equal(ok("abc が Discord で回答。OK", "A-12", ["a.*"]), false);
	for (const owners of [[], ["other"], ["Jonnity"]])
		assert.equal(ok("jonnity が Discord で回答。A-12 OK", "A-12", owners), false);
	for (const answer of ["NG が Discord で回答。OK", "jonnity が Discord で回答。jonnity が Discord で回答。OK"])
		assert.equal(ok(answer), false, answer);
});

test("OK と読める回答: A なし・A 付き・小文字・全角・従来形", () => {
	for (const answer of [
		"OK",
		" OK\n",
		"ok",
		"Ok",
		"ＯＫ",
		"ｏｋ",
		"Ｏｋ",
		"A-12 ok",
		"A-12 OK",
		"A-12 Ok",
		"A-12: OK",
		"A-12、OK",
		"A-12　ＯＫ",
		"A-12 ok（Discord: jonnity）",
		"A-12 ok(Discord: jonnity)",
		"OK（Discord: 任意）",
		"OK(PR #23 のマージを承認)。",
		"OK。",
		"OK!",
		"OK！",
		"OK\n追記",
		"OK です",
		"jonnity が Discord で回答。A-12 ok（Discord: jonnity）",
		"OK（A-12 ok）（Discord: jonnity）",
		"OK（A-12 ok）",
		"A-12\u3000ok",
		"A-12 ok\tです",
		"A-12 ok\u3000です",
		"A-12 ok。",
		"A-12 ok です",
		"A-12 ok ですね。",
		"A-12 ok です（Discord: jonnity）",
		"A-12 ok A-12",
		"ok ok",
		"A-12 ok\n",
		"A-12 ok\ufeff",
		"OK（Discord: jonnity）。ただし、…崩れているように見える。…かもしれない。",
	])
		assert.equal(ok(answer), true, answer);
});

test("OK にしない回答: 否定・保留・条件付き・NG・OK 語でない", () => {
	for (const answer of [
		"OKではない",
		"A-12 OKではない",
		"ok? まだ",
		"A-12 ok? まだ",
		"OK？",
		"OK?",
		"OK、ただし直して",
		"OK、ただし NG",
		"A-12 OK、ただし…",
		"OKです",
		"OKだけど直して",
		"OKじゃない",
		"NG",
		"A-12 NG",
		"NG: OK ではない",
		"保留",
		"A-12 保留",
		"A-12 は保留",
		"あとで",
		"A-12 はOK",
		"(A-12) ok",
		"A-12ok",
		"A-12 A-12 ok",
		"A12: OK",
		"oK",
		"oＫ",
		"lgtm",
		"LGTM",
		"マージして",
		"",
		"（完了）",
		"（新しい依頼に置き換え）",
		"OK:",
		"OK：",
		"OK…",
		"NG。前回 jonnity が Discord で回答。OK と書いたのは取り消し",
		"前回jonnity が Discord で回答。OK と書いたのは取り消し",
	])
		assert.equal(ok(answer), false, answer);
});

test("新規形（A 付き・小文字・全角）は区切りの後に否定・保留・NG が続くと OK にしない", () => {
	const ng = [
		"A-12 ok ではない",
		"ok じゃない",
		"A-12 OK 保留",
		"A-12 OK。やっぱりNG",
		"A-12 OK.NG",
		"A-12 OK!NG",
		"A-12 OK（保留）",
		"ok(じゃない)",
		"Ok.ではなくNG",
		"A-12 ＯＫ NG",
		"A-12 OK\nただし…",
		"A-12 ok ? まだ",
		"A-12 ok 、ただし直して",
		"A-12 ok ：NG",
		"A-12 ok …保留",
		"A-12 ok -NG",
		"A-12 ok 「保留」",
		"A-12 ok ｎｇ",
		"A-12 ok Ｎｇ",
		"A-12 ok ＮＧ",
		"A-12 ok ・NG",
		"A-12 ok ※保留",
		"A-12 ok ~NG",
		'A-12 ok "保留"',
		"ok (「保留」)",
		"A-12 ok。、ただし",
		"A-12 ok\nＮＧ",
		"A-12 ok ‥NG",
		"Ok , ただし",
		"ＯＫ ？まだ",
		"A-12 ok N G",
		"A-12 ok ｎ ｇ",
		"A-12 ok ダ メ",
		"A-12 ok だ め",
		"A-12 ok 直して",
		"A-12 ok 修正してから",
		"A-12 ok でも",
		"A-12 ok いや",
		"A-12 ok やめて",
		"A-12 ok 無理",
		"A-12 ok 中止",
		"A-12 ok don't",
		"A-12 ok never",
		"A-12 ok cancel",
		"A-12 ok stop",
		"A-12 ok n",
		"A-12 ok A-12 NG",
		"A-12 ok A-12 保留",
		"A-12 ok ok 保留",
		"A-12 ok OK NG",
		"A-12 ok ですが",
		"A-12 ok です NG",
		"A-12 ok（Discord: jonnity）NG",
		"A-12 ok （Discord: John Smith）",
		"A-12 ok よろしく",
		"A-12 ok\nNG",
		...["*", "+", "=", "_", "#", "@", "|", "{", "$", "%", "&", "^"].flatMap((c) => [`A-12 ok ${c}NG`, `A-12 ok${c}NG`]),
		...["\u200b", "\u2060", "\u00ad", "\u0085", "\ufe0f", "\u0301", "\u00a0", "\ufeff", "\u2028", "\u2029"].flatMap(
			(c) => [`A-12 ok ${c}NG`, `A-12 ok${c}NG`, `A-12${c}ok`],
		),
	];
	for (const answer of ng) assert.equal(ok(answer), false, JSON.stringify(answer));
});

test("署名の名前は owners との完全一致だけ", () => {
	for (const sig of [
		"（Discord: NG,保留,やっぱり待って）",
		"（Discord:やっぱりNGです）",
		"（Discord: ではない。まだ）",
		"（Discord:NG）",
		"（Discord: ）",
		"（Discord:）",
		"（Discord: jonnity(NG)）",
		"（Discord: （jonnity））",
		"（Discord: other）",
		"（Discord: jonnit）",
		"（Discord: jonnityy）",
		"（Discord: Jonnity）",
		"（Discord: jonnity ）",
		"（Discord: jon nity）",
		"（discord: jonnity）",
		"（Discord: jonnity）（Discord: jonnity）",
		"（Discord:\u00a0jonnity）",
		"（Discord:\njonnity）",
		"（Discord: jonnity\u200b）",
	])
		assert.equal(ok(`A-12 ok${sig}`), false, sig);
	for (const sig of [
		"（Discord: jonnity）",
		"(Discord: jonnity)",
		"（Discord:jonnity）",
		"（Discord：jonnity）",
		"（Discord: jonnity）。",
	])
		assert.equal(ok(`A-12 ok${sig}`), true, sig);
	for (const owners of [[], ["other"], ["Jonnity"], [""]])
		for (const sig of ["（Discord: jonnity）", "(Discord: jonnity)", "（Discord: ）"])
			assert.equal(ok(`A-12 ok${sig}`, "A-12", owners), false, `${JSON.stringify(owners)} ${sig}`);
	assert.equal(ok("A-12 ok（Discord: jonnity）", "A-12", ["jonnity", "other"]), true);
	assert.equal(ok("A-12 ok(Discord: other)", "A-12", ["jonnity", "other"]), true);
	// 空文字の owner は名前として認めない
	assert.equal(ok("A-12 ok（Discord: ）", "A-12", ["", "jonnity"]), false);
	assert.equal(ok("A-12 ok（Discord: jonnity）", "A-12", ["", "jonnity"]), true);
});

test("従来形（A なしの半角大文字 OK）は区切りの後の語を検査しない（現行互換）", () => {
	// 人の回答（区切りの後に否定が続く場合の扱い）が出るまで現行どおり。安全とは主張しない
	for (const answer of [
		"OK ではない",
		"OK じゃない",
		"OK でもマージは待って",
		"OK\nではない",
		"OK。やっぱりNG",
		"OK.NG",
		"OK!NG",
		"OK（保留）",
		"OK.ではなくNG",
		"OK(じゃない)",
		"OK（Discord: jonnity）。ただし、…",
	])
		assert.equal(ok(answer), true, answer);
});

test("別の A を指す回答は OK にしない", () => {
	for (const answer of [
		"A-11 ok",
		"A-411 ok",
		"A-120 ok",
		"A-1 ok",
		"A-012 ok",
		"jonnity が Discord で回答。A-11 ok",
		"A-11 OK（Discord: jonnity）",
		"OK（A-11 ok）",
		"OK A-11 ok",
		"OK（A-11 ok）（Discord: jonnity）",
		"A-12 ok A-１１ ok",
		"Ａ-11 ok",
		"A–11 ok",
		"A‐11 ok",
		"A—11 ok",
		"A―11 ok",
		"Aー11 ok",
		"A－11 ok",
		"A-12 ok A–11 ok",
		"OK A–11 ok",
		"OK（Ａ-11 ok）",
	])
		assert.equal(ok(answer), false, answer);
	for (const answer of ["A-12 ok", "OK", "OK（A-12 ok）"]) assert.equal(ok(answer), true, answer);
	for (const attention of ["", "A-0", "12", "A-012", "a-12"]) assert.equal(ok("OK", attention), false, attention);
});

test("実際に落ちた本文 A-412 ok（…）/ A-413 OK（…）は回答先が一致するときだけ OK", () => {
	const a412 = "A-412 ok（Discord: jonnity）";
	const a413 = "A-413 OK（Discord: jonnity）";
	assert.equal(ok(a412, "A-412"), true);
	assert.equal(ok(a413, "A-413"), true);
	for (const attention of ["A-411", "A-414", "A-41", "A-4120"]) {
		assert.equal(ok(a412, attention), false, attention);
		assert.equal(ok(a413, attention), false, attention);
	}
});

// 総当たり: 現行実装（startsWith("OK")）で false なのに新実装で true になる入力が、許可文法に合う新規形だけであること
test("総当たり: 現行 false で新実装 true は許可文法に合う新規形だけ", () => {
	const oldOk = (a: string, owners: readonly string[]) => stripDiscordAnswerPreamble(a, owners).startsWith("OK");
	const owners = ["jonnity"];
	const sepc = "[ \\t\u3000。.!！]";
	const oracle = new RegExp(
		`^${sepc}*(?:(?:A-12|OK|ok|Ok|ＯＫ|ｏｋ|Ｏｋ)(?:${sepc}+|$))*${sepc}*(?:(?:です|ですね)${sepc}*)?(?:[(（]Discord[:：][ \\t\u3000]*jonnity[)）]${sepc}*)?$`,
	);
	const words = ["OK", "ok", "Ok", "ＯＫ", "ｏｋ", "Ｏｋ", "oK", "oＫ"];
	const okWord = /(?:OK|ok|Ok|ＯＫ|ｏｋ|Ｏｋ)/su;
	let total = 0;
	let newly = 0;
	const bad: string[] = [];
	const check = (a: string) => {
		total++;
		if (oldOk(a, owners) || !ok(a, "A-12", owners)) return;
		newly++;
		const after = a
			.replace(new RegExp(`^.*?(?=${okWord.source})`, "su"), "")
			.replace(new RegExp(`^${okWord.source}`, "u"), "");
		if (!oracle.test(after.replace(/^\s+/, ""))) bad.push(a);
	};
	// 代表の直積: 前置き 5 × OK 語 8 × 間の文字列 49 × 後ろ 75
	const pre = ["", "A-12 ", "A-12: ", "jonnity が Discord で回答。A-12 ", "jonnity が Discord で回答。"];
	const gaps = [
		"\u3000",
		"\t",
		"\u00a0",
		"\ufeff",
		"\u2028",
		"\u2029",
		"\u0085",
		"\u200b",
		"",
		" ",
		"  ",
		"\n",
		"。",
		"。 ",
		"! ",
		"！",
		"(",
		"（",
		"）",
		" (",
		"、",
		" 、",
		", ",
		" ，",
		"?",
		" ?",
		"？",
		" ？",
		":",
		" :",
		"：",
		"…",
		" …",
		"・",
		" ・",
		"※",
		" ※",
		"「",
		" 「",
		"-",
		" -",
		"~",
		" ~",
		"ー",
		" ー",
		"/",
		" /",
		";",
		" ;",
	];
	const tails = [
		"（Discord: NG,保留,やっぱり待って）",
		"（Discord:やっぱりNGです）",
		"（Discord: ではない。まだ）",
		"（Discord:NG）",
		"（Discord: ）",
		"（Discord:）",
		"（Discord: jonnity(NG)）",
		"（Discord: （jonnity））",
		"（Discord: jonnit）",
		"（Discord: jonnityy）",
		"（Discord: Jonnity）",
		"（Discord: jonnity ）",
		"（Discord: jon nity）",
		"（Discord: other）",
		"（Discord: jonnity）NG",
		"（Discord: jonnity）（Discord: jonnity）",
		"（Discord：jonnity）",
		"（Discord:\u3000jonnity）",
		"（Discord:\u00a0jonnity）",
		"（Discord:\njonnity）",
		"（Discord: jonnity\u200b）",
		"(Discord: jonnity)",
		"（discord: jonnity）",
		"",
		"まだ",
		"ただし直して",
		"NG",
		"ng",
		"ｎｇ",
		"Ｎｇ",
		"ＮＧ",
		"保留",
		"「保留」",
		"じゃない",
		"ではない",
		"やっぱりNG",
		"待って",
		"追記",
		"です",
		"ですね",
		"（Discord: jonnity）",
		"です（Discord: jonnity）",
		"A-11 ok",
		"A-12 ok",
		"A-12 NG",
		"A-12 保留",
		"ok 保留",
		"OK NG",
		"ok ok",
		"直して",
		"修正してから",
		"でも",
		"いや",
		"やめて",
		"無理",
		"中止",
		"don't",
		"never",
		"cancel",
		"stop",
		"n",
		"N G",
		"ｎ ｇ",
		"ダ メ",
		"だ め",
		"A-１１ ok",
		"Ａ-11 ok",
		"A–11 ok",
		"A‐11 ok",
		"A—11 ok",
		"A―11 ok",
		"Aー11 ok",
		"A－11 ok",
		"A-12 ok A-１１ ok",
	];
	for (const p of pre) for (const w of words) for (const g of gaps) for (const t of tails) check(p + w + g + t);
	// 記号・不可視・結合・制御・空白: BMP 全走査（代表の直積に絞る: 前置き 2 × OK 語 2 × 後ろ 2 × 配置 2）
	const specials: string[] = [];
	for (let c = 0; c <= 0xffff; c++) {
		if (c >= 0xd800 && c <= 0xdfff) continue;
		const ch = String.fromCharCode(c);
		if (/[\p{P}\p{S}\p{Cf}\p{M}\p{Cc}\p{Z}]/u.test(ch)) specials.push(ch);
	}
	for (let c = 0x20; c < 0x7f; c++) specials.push(String.fromCharCode(c));
	for (const p of ["A-12 ", ""])
		for (const w of ["ok", "ＯＫ"])
			for (const c of specials)
				for (const t of ["NG", "保留"])
					for (const [l, r] of [
						["", ""],
						[" ", " "],
					])
						check(p + w + l + c + r + t);
	assert.deepEqual(bad.slice(0, 20), []);
	assert.ok(newly > 0 && total > 100000, `${newly}/${total}`);
	// owners 変種: 署名付きが true になるのは名前が owners と完全一致のときだけ
	for (const ow of [[], ["other"], ["Jonnity"], ["jonnity", "other"], [""]])
		for (const w of ["ok", "OK", "Ok", "ＯＫ"])
			for (const sig of [
				"（Discord: jonnity）",
				"(Discord: jonnity)",
				"（Discord: other）",
				"（Discord: Jonnity）",
				"（Discord: NG）",
			]) {
				const expected = ow.includes(sig.slice(sig.indexOf(" ") + 1, -1));
				assert.equal(ok(`A-12 ${w}${sig}`, "A-12", ow), expected, `${JSON.stringify(ow)} ${w}${sig}`);
			}
});
