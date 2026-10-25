// 設定ファイルの読み込みが保証すること:
// - git の作者は名前とメールが両方そろっているときだけ採用し、それ以外（欠落・片方・空・型違い）は未設定にする
//   （既存の config.json を壊さず、雛形の空文字は未設定として扱う）
import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_TEMPLATE, loadConfig } from "../src/config.ts";

function load(extra: Record<string, unknown>) {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-c-"));
	writeFileSync(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"], ...extra }));
	return loadConfig(home);
}

test("git の作者は名前とメールがそろっているときだけ採用する", () => {
	assert.deepEqual(load({ git: { name: "A B", email: "a@example.com" } }).git, { name: "A B", email: "a@example.com" });
	for (const git of [
		undefined,
		null,
		{},
		{ name: "A" },
		{ email: "a@example.com" },
		{ name: "", email: "" },
		{ name: 1, email: 2 },
		"x",
	])
		assert.equal(load({ git }).git ?? null, null, JSON.stringify(git));
});

test("雛形の git は空で、未設定として読まれる（個人情報を雛形に書かない）", () => {
	assert.deepEqual(CONFIG_TEMPLATE.git, { name: "", email: "" });
	assert.equal(load({ git: CONFIG_TEMPLATE.git }).git ?? null, null);
});
