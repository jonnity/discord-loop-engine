// waitForContent が保証すること:
// - 非空の内容を、末尾改行を保ったまま返す
// - 空の間は返さず、遅れて書かれた内容を返す（ファイルが後から作られる場合も）
// - 空のまま期限が来たら、パスと label を含むエラーで失敗する
import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { waitForContent } from "./wait-file.ts";

function tmp() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-wf-"));
	return { dir, file: path.join(dir, "f"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("waitForContent: 最初から非空ならそのまま返し、末尾改行を保つ", async () => {
	const t = tmp();
	try {
		writeFileSync(t.file, "123\n");
		assert.equal(await waitForContent(t.file), "123\n");
	} finally {
		t.done();
	}
});

test("waitForContent: 最初は空でも、後で書かれた内容を返す", async () => {
	const t = tmp();
	try {
		writeFileSync(t.file, "");
		setTimeout(() => writeFileSync(t.file, "later"), 50);
		assert.equal(await waitForContent(t.file), "later");
	} finally {
		t.done();
	}
});

test("waitForContent: ファイルが後から作られても待って返す", async () => {
	const t = tmp();
	try {
		setTimeout(() => writeFileSync(t.file, "created"), 50);
		assert.equal(await waitForContent(t.file), "created");
	} finally {
		t.done();
	}
});

test("waitForContent: 空のまま期限が来たら、パスと label を含むエラーで失敗する", async () => {
	const t = tmp();
	try {
		writeFileSync(t.file, "");
		await assert.rejects(
			waitForContent(t.file, { timeoutMs: 100, label: "ラベル-xyz" }),
			(e: Error) => e.message.includes(t.file) && e.message.includes("ラベル-xyz"),
		);
	} finally {
		t.done();
	}
});
