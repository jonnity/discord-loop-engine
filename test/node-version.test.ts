// Node の版の確認が保証すること:
// - 2026-10-21 のセキュリティ修正が入った版（22.23.4 / 24.22.1 / 26.12.1 以上）だけを通す
// - サポート対象外の系列（奇数・古い系列）は通さず、表より新しい系列は通す
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNode } from "../src/node-version.ts";

test("修正済みの版だけを通す", () => {
	for (const v of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "27.0.0"])
		assert.equal(checkNode(v).ok, true, v);
	for (const v of ["22.22.0", "22.23.3", "24.22.0", "24.5.0", "26.12.0", "25.9.0", "20.19.0"])
		assert.equal(checkNode(v).ok, false, v);
});

test("通さないときは上げるべき版を示す", () => {
	const r = checkNode("24.5.0");
	assert.equal(r.ok, false);
	assert.match(r.ok ? "" : r.reason, /24\.22\.1 以上/);
});
