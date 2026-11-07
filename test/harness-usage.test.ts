import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { displayTokens, summarizeUsage } from "../src/harness-usage.ts";

test("AC3: 同IDを重複排除し不一致・欠損を報告、整数合計と表示丸めを一本化する", () => {
	const row = {
		id: "a",
		project: "p",
		role: "tick",
		model: "opus",
		timestamp: "2026-11-01T00:00:00Z",
		usage: { input: 9999, output: 1, cacheCreation: 0, cacheRead: 10000 },
	};
	const result = summarizeUsage(
		[
			row,
			row,
			{ ...row, id: "b" },
			{ ...row, id: "conflict" },
			{ ...row, id: "conflict", model: "sonnet" },
			{ ...row, id: "" },
			{ ...row, id: "bad", usage: { ...row.usage, input: -1 } },
		],
		new Set(["p"]),
		"2026-11-01T00:00:00Z",
		"2026-11-08T00:00:00Z",
	);
	assert.deepEqual(result.totals, { input: 19998, output: 2, cacheCreation: 0, cacheRead: 20000 });
	assert.equal(result.count, 2);
	assert.equal(result.duplicates, 1);
	assert.equal(result.conflicts, 1);
	assert.equal(result.invalid, 2);
	assert.deepEqual(result.groups[0]?.usage, result.totals);
	assert.equal(displayTokens(19998), "2.0万");
	assert.equal(displayTokens(10499), "1.0万");
	assert.equal(displayTokens(10500), "1.1万");
	assert.throws(() => displayTokens(1.5));
	assert.equal(summarizeUsage([row], new Set(), "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z").invalid, 1);
	assert.equal(
		summarizeUsage(
			[{ ...row, timestamp: "2026-02-30T00:00:00Z" }],
			new Set(["p"]),
			"2026-01-01T00:00:00Z",
			"2027-01-01T00:00:00Z",
		).invalid,
		1,
	);
});
