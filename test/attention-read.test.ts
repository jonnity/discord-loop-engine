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
test("T1/T3: 共通の本文判定はownersの前置きを1回だけ除き、先頭OKだけを見る", () => {
	assert.deepEqual(
		actualAnswers.map((a) => isAttentionAnswerOk(a, ["jonnity"])),
		[true, true, true, false],
	);
	for (const answer of [
		"OK",
		" OK\n",
		"OK（Discord: 任意）",
		"OK!",
		"OK！",
		"OK。",
		"OK です",
		"OK\nただし…",
		"OK ではない",
		"OK、ただし NG",
		"OKです",
		"OKじゃない",
		"OKだけど直して",
		"OK?",
		"OK？",
		"OK:",
		"OK じゃない",
		"OK でもマージは待って",
		"OK\nではない",
		"OK(じゃない)",
		"OK.ではなくNG",
		"OK（Discord: jonnity）。ただし、…崩れているように見える。…かもしれない。",
	])
		assert.equal(isAttentionAnswerOk(answer, []), true, answer);
	for (const answer of [
		"ok",
		"ＯＫ",
		"LGTM",
		"マージして",
		"A-12 OK",
		"A12: OK",
		"NG",
		"",
		"（完了）",
		"（新しい依頼に置き換え）",
		"NG。前回 jonnity が Discord で回答。OK と書いたのは取り消し",
		"前回jonnity が Discord で回答。OK と書いたのは取り消し",
		"NG が Discord で回答。OK",
	]) {
		assert.equal(isAttentionAnswerOk(answer, ["jonnity"]), false, answer);
		assert.equal(stripDiscordAnswerPreamble(answer, ["jonnity"]), answer);
	}
	const prefixed = "jonnity が Discord で回答。OK";
	assert.equal(stripDiscordAnswerPreamble(prefixed, ["jonnity"]), "OK");
	for (const owners of [[], ["other"], ["Jonnity"], ["jonn"]])
		assert.equal(isAttentionAnswerOk(prefixed, owners), false);
	assert.equal(isAttentionAnswerOk(`jonnity が Discord で回答。${prefixed}`, ["jonnity"]), false);
	assert.equal(isAttentionAnswerOk("a.* が Discord で回答。OK", ["a.*"]), true);
	assert.equal(isAttentionAnswerOk("abc が Discord で回答。OK", ["a.*"]), false);
});
