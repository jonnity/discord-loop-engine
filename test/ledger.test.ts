// タスク台帳が保証すること:
// - タスクは1件1ファイルで、読み書きしても中身（経緯を含む）が失われない
// - Issue に対応するタスクは1つにまとまる
// - あなた待ちは A-番号で採番され、同じタスクの同じ種類は新しい依頼に置き換わる
// - 依頼の投稿の全メッセージ ID（分割投稿）を任意項目として残せ、持たない古い項目もそのまま読める
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
	const a1 = l.addAttention({ ...base, kind: "merge" }).attention;
	const a2 = l.addAttention({ ...base, kind: "merge" }).attention;
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

test("依頼の置き換え・タスクでの解消は、今回閉じた依頼だけを返す", () => {
	const l = fresh();
	const t = l.createTask({ project: "k", title: "x", issue: "1" });
	const other = l.createTask({ project: "k", title: "y", issue: "2" });
	const base = { taskId: t.id, project: "k", issue: "1", pr: "", title: "x", url: "u", summary: "" };
	const first = l.addAttention({ ...base, kind: "merge" });
	assert.deepEqual(first.resolved, []);
	l.addAttention({ ...base, kind: "interview" });
	l.addAttention({ ...base, taskId: other.id, kind: "merge" });
	const none1 = l.addAttention({ ...base, taskId: "", kind: "setup" });
	const none2 = l.addAttention({ ...base, taskId: "", kind: "setup" });
	assert.deepEqual(none1.resolved, [], "taskId が空なら置き換えない");
	assert.deepEqual(none2.resolved, []);
	const replaced = l.addAttention({ ...base, kind: "merge" });
	assert.deepEqual(
		replaced.resolved.map((a) => [a.id, a.status, a.answer]),
		[[first.attention.id, "resolved", "（新しい依頼に置き換え）"]],
	);
	l.resolveAttention(l.openAttention().find((a) => a.kind === "interview")?.id ?? "", "回答");
	const closed = l.resolveAttentionForTask(t.id, "（完了）");
	assert.deepEqual(
		closed.map((a) => a.id),
		[replaced.attention.id],
		"回答済みは含めない",
	);
	assert.deepEqual(l.resolveAttentionForTask(t.id, "（完了）"), []);
	const saved = JSON.parse(readFileSync(path.join(l.dir, "attention.json"), "utf8"));
	assert.ok(Array.isArray(saved));
	assert.equal(saved.find((a: { id: string }) => a.id === first.attention.id).answer, "（新しい依頼に置き換え）");
});

test("T18-6: IssueなしPRのmerge Aだけを置換・完了解決し、PRを表示する", () => {
	const l = fresh();
	const base = { taskId: "", project: "k", issue: "", pr: "25", title: "x", url: "u", summary: "" };
	const old = l.addAttention({ ...base, kind: "merge" });
	const other = l.addAttention({ ...base, pr: "26", kind: "merge" });
	const setup = l.addAttention({ ...base, kind: "setup" });
	const issue = l.addAttention({ ...base, issue: "1", taskId: "T-1", kind: "merge" });
	const next = l.addAttention({ ...base, kind: "merge" });
	assert.equal(l.attention().find((a) => a.id === old.attention.id)?.status, "resolved");
	assert.match(readFileSync(path.join(l.dir, "attention.md"), "utf8"), /PR #25/);
	l.resolveAttentionForPr("k", "25", "（GitHub の NG で停止）");
	assert.equal(l.attention().find((a) => a.id === next.attention.id)?.status, "resolved");
	assert.deepEqual(
		l.openAttention().map((a) => a.id),
		[other.attention.id, setup.attention.id, issue.attention.id],
	);
});

test("分割投稿の全メッセージ ID を保存でき、先頭は messageId のまま。渡さなければ項目を作らない", () => {
	const l = fresh();
	const base = { taskId: "", project: "k", issue: "1", pr: "5", title: "x", url: "u", summary: "" };
	const a = l.addAttention({ ...base, kind: "merge" }).attention;
	const b = l.addAttention({ ...base, issue: "2", kind: "interview" }).attention;
	l.setAttentionMessage(a.id, "m1", ["m1", "m2", "m3"]);
	l.setAttentionMessage(b.id, "m9");
	const back = l.attention();
	assert.equal(back.find((x) => x.id === a.id)?.messageId, "m1");
	assert.deepEqual(back.find((x) => x.id === a.id)?.messageIds, ["m1", "m2", "m3"]);
	assert.equal(back.find((x) => x.id === b.id)?.messageId, "m9");
	assert.equal("messageIds" in (back.find((x) => x.id === b.id) ?? {}), false);
});

test("messageIds の無い既存形式の attention.json（messageId だけ）がそのまま読める", () => {
	const l = fresh();
	const a = l.addAttention({
		taskId: "",
		project: "k",
		issue: "1",
		pr: "",
		title: "x",
		url: "",
		summary: "",
		kind: "merge",
	}).attention;
	l.setAttentionMessage(a.id, "m1");
	const again = new Ledger(l.dir);
	assert.equal(again.attention()[0]?.messageId, "m1");
	assert.equal(again.attention()[0]?.messageIds, undefined);
});

test("attentionByMessageId は messageIds のどれでも・対応済みでも引け、旧形式や空文字では誤一致しない", () => {
	const l = fresh();
	const base = {
		taskId: "",
		project: "k",
		issue: "1",
		pr: "5",
		title: "x",
		url: "u",
		summary: "",
		kind: "merge" as const,
	};
	const a = l.addAttention(base).attention;
	const b = l.addAttention({ ...base, issue: "2" }).attention;
	const old = l.addAttention({ ...base, issue: "3" }).attention; // messageId が無い旧形式
	l.setAttentionMessage(a.id, "m1", ["m1", "m2"]);
	l.setAttentionMessage(b.id, "m9");
	assert.equal(l.attentionByMessageId("m1")?.id, a.id);
	assert.equal(l.attentionByMessageId("m2")?.id, a.id);
	assert.equal(l.attentionByMessageId("m9")?.id, b.id);
	l.resolveAttention(a.id, "OK");
	assert.equal(l.attentionByMessageId("m2")?.status, "resolved");
	assert.equal(l.attentionByMessageId("zzz"), undefined);
	assert.equal(l.attentionByMessageId(""), undefined);
	assert.equal(l.attentionByMessageId("undefined"), undefined);
	assert.notEqual(old.id, "");
});

test("ボードの出力は変更前（origin/main）と同一: 置き換え済み・9件以上の queued・phase・blocked・done を含む台帳", () => {
	const l = fresh();
	const t = l.createTask({ project: "k", title: "a", issue: "1" });
	const input = {
		taskId: t.id,
		project: "k",
		issue: "1",
		pr: "",
		kind: "merge" as const,
		title: "a",
		url: "u",
		summary: "",
	};
	l.addAttention(input);
	l.addAttention(input); // A-1 は置き換えられて閉じる
	l.addAttention({ ...input, kind: "interview" });
	l.resolveAttention("A-3", "OK");
	l.addAttention({ ...input, taskId: "T-9", pr: "5", issue: "", kind: "blocked" });
	assert.deepEqual(
		l.openAttention().map((a) => a.id),
		["A-2", "A-4"],
	);
	for (let i = 0; i < 9; i++) {
		const q = l.createTask({ project: "q", title: `q${i}`, issue: String(10 + i) });
		if (i === 2) l.updateTask(q.id, { phase: "impl" }, "x");
	}
	l.createTask({ project: "b", title: "blk", issue: "30", status: "blocked" });
	const w = l.createTask({ project: "w", title: "work", issue: "", status: "ai-working" });
	l.updateTask(w.id, { phase: "review" }, "x");
	const d = l.createTask({ project: "d", title: "done", issue: "40" });
	l.updateTask(d.id, { status: "done" }, "x");
	// 期待値は変更前の renderBoard が同じ台帳に出した全文（9件目の queued と done は出ない）
	assert.equal(
		l.renderBoard(),
		[
			"📋 ボード（10/22 10:15 更新）",
			"■ あなた待ち",
			"  A-2 [k] #1 マージ承認",
			"  A-4 [k] 要対応 → PR #5",
			"■ AI 作業中",
			"  T-0011 [b] #30 blk",
			"  T-0012 [w] work（review）",
			"■ 次に着手",
			"  T-0001 [k] #1 a",
			"  T-0002 [q] #10 q0",
			"  T-0003 [q] #11 q1",
			"  T-0004 [q] #12 q2（impl）",
			"  T-0005 [q] #13 q3",
			"  T-0006 [q] #14 q4",
			"  T-0007 [q] #15 q5",
			"  T-0008 [q] #16 q6",
		].join("\n"),
	);
	assert.equal(readFileSync(path.join(l.dir, "board.md"), "utf8"), `${l.renderBoard()}\n`);
});
