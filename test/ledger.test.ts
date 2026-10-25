// タスク台帳が保証すること:
// - タスクは1件1ファイルで、読み書きしても中身（経緯を含む）が失われない
// - Issue に対応するタスクは1つにまとまる
// - あなた待ちは A-番号で採番され、同じタスクの同じ種類は新しい依頼に置き換わる
// - worker がいない間の指示は outbox に残り、取り出すと空になる
// - ボードには「あなた待ち」「作業中」「次に着手」が出る
import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";

const fresh = () =>
	new Ledger(mkdtempSync(path.join(os.tmpdir(), "dle-ledger-")), () => new Date("2026-10-22T10:15:00"));

test("タスクを作って更新しても経緯が残る（Markdown で人が読める）", () => {
	const l = fresh();
	const t = l.createTask({ project: "kishimen-tool", title: "票を破棄", issue: "12" });
	assert.equal(t.id, "T-0001");
	assert.equal(t.status, "queued");
	l.updateTask(t.id, { status: "waiting-human", waiting: "A-1 マージ承認" }, "承認を依頼");
	const back = l.task(t.id);
	assert.equal(back?.status, "waiting-human");
	assert.equal(back?.waiting, "A-1 マージ承認");
	assert.equal(back?.history.length, 2);
	const md = readFileSync(path.join(l.dir, "tasks", "T-0001.md"), "utf8");
	assert.match(md, /^---\nid: T-0001\n/);
	assert.match(md, /## 経緯\n- 10-22 10:15 受け付け\n- 10-22 10:15 承認を依頼/);
});

test("Issue に対応するタスクは1つにまとまる", () => {
	const l = fresh();
	const a = l.ensureTaskForIssue("kishimen-tool", "12", "票を破棄");
	const b = l.ensureTaskForIssue("kishimen-tool", "12", "票を破棄");
	assert.equal(a.id, b.id);
	assert.equal(l.tasks().length, 1);
});

test("あなた待ちは A-番号で採番され、同じタスクの同じ種類は置き換わる", () => {
	const l = fresh();
	const t = l.createTask({ project: "k", title: "x", issue: "1" });
	const base = { taskId: t.id, project: "k", issue: "1", pr: "5", title: "x", url: "u", summary: "" };
	const a1 = l.addAttention({ ...base, kind: "merge" });
	const a2 = l.addAttention({ ...base, kind: "merge" });
	assert.deepEqual([a1.id, a2.id], ["A-1", "A-2"]);
	assert.deepEqual(
		l.openAttention().map((a) => a.id),
		["A-2"],
	);
	l.resolveAttention("a-2", "OK");
	assert.equal(l.openAttention().length, 0);
	assert.throws(() => l.resolveAttention("A-2", "OK"), /対応済み/);
	assert.match(readFileSync(path.join(l.dir, "attention.md"), "utf8"), /（なし）/);
});

test("worker がいない間の指示は outbox に残り、取り出すと空になる", () => {
	const l = fresh();
	l.enqueue("k", { content: "#3 を先に", meta: { from: "concierge" } });
	assert.deepEqual(
		l.drain("k").map((x) => x.content),
		["#3 を先に"],
	);
	assert.deepEqual(l.drain("k"), []);
});

test("学びの記録と仮ルール", () => {
	const l = fresh();
	l.addLearning({ project: "k", issue: "1", tag: "ci-red", summary: "型エラー", detail: "" });
	l.addLearning({ project: "k", issue: "2", tag: "ci-red", summary: "型エラー", detail: "" });
	l.markPromoted([0]);
	assert.deepEqual(
		l.learnings().map((x) => x.promoted),
		[true, false],
	);
	l.setRules("- PR 前に型チェックを通す");
	assert.equal(l.rules(), "- PR 前に型チェックを通す\n");
});

test("ボードにあなた待ち・作業中・次に着手が出る", () => {
	const l = fresh();
	const t = l.createTask({ project: "k", title: "票を破棄", issue: "12" });
	l.createTask({ project: "o", title: "お題", issue: "80", status: "ai-working" });
	l.addAttention({
		taskId: t.id,
		project: "k",
		issue: "12",
		pr: "34",
		kind: "merge",
		title: "票を破棄",
		url: "u",
		summary: "",
	});
	const b = l.renderBoard();
	assert.match(b, /■ あなた待ち\n {2}A-1 \[k\] #12 マージ承認 → PR #34/);
	assert.match(b, /■ AI 作業中\n {2}T-0002 \[o\] #80 お題/);
	assert.match(b, /■ 次に着手\n {2}T-0001 \[k\] #12 票を破棄/);
});
