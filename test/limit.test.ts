// 画面の文言から、使用量の上限と復帰時刻を取り出せる。
// 会話（⏺）・ツール出力（⎿）・入力のエコー（> ❯）に出る同じ文言は上限としない。
import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WORKER_LIMIT, detectLimit } from "../src/limit.ts";

const cfg = DEFAULT_WORKER_LIMIT;
const detect = (pane: string, over: Partial<typeof cfg> = {}) => detectLimit(pane, { ...cfg, ...over });

test("下部の上限表示を検出し、復帰時刻の文字列を返す", () => {
	assert.deepEqual(detect("作業\n\nClaude usage limit reached. Your limit will reset at 3pm\n"), { resetText: "3pm" });
});

test("復帰時刻が無い文言は resetText が null", () => {
	assert.deepEqual(detect("You've hit your usage limit\n"), { resetText: null });
});

test("範囲（最後の tailLines 行）より上にだけある文言は検出しない", () => {
	const pane = ["Usage limit reached", ...Array.from({ length: 12 }, (_, i) => `line${i}`), "", ""].join("\n");
	assert.equal(detect(pane), null);
	assert.notEqual(detect(pane, { tailLines: 13 }), null);
});

test("⏺ 行と字下げされた継続行（空行を挟んでも）は検出しない", () => {
	assert.equal(detect("⏺ Usage limit reached\n"), null);
	assert.equal(detect("⏺ 説明\n  Usage limit reached\n"), null);
	assert.equal(detect("⏺ 説明\n\n  Usage limit reached\n"), null);
	assert.equal(detect("  ⏺ Usage limit reached\n"), null);
});

test("字下げの無い非空行でブロックが終わり、その後の本物の行は検出する", () => {
	assert.notEqual(detect("⏺ 説明\n  続き\nUsage limit reached\n"), null);
});

test("⎿ のツール出力行とその継続行は検出しない", () => {
	assert.equal(detect("⏺ Bash(cat x)\n  ⎿  Usage limit reached\n     Usage limit reached again\n"), null);
});

test("> / ❯ の入力エコー行は検出しない", () => {
	assert.equal(detect("> Usage limit reached\n"), null);
	assert.equal(detect("  ❯ Usage limit reached\n"), null);
});

test("ブロックの途中から範囲が始まっても、継続行は検出しない", () => {
	const pane = ["⏺ 長い応答", "  Usage limit reached", "  もう1行", ""].join("\n");
	assert.equal(detect(pane, { tailLines: 2 }), null);
});

test("説明文は行頭アンカーにより検出しない", () => {
	assert.equal(detect("この Issue は usage limit を検出する\nthe limit reached handler is x\n"), null);
});

test("esc to interrupt を含む（作業中の）画面は検出しない", () => {
	assert.equal(detect("Usage limit reached\n✻ 作業中 (esc to interrupt)\n"), null);
});

test("patterns を差し替えると別の文言を検出する", () => {
	assert.equal(detect("上限です\n"), null);
	assert.notEqual(detect("上限です\n", { patterns: ["^上限です"] }), null);
});
