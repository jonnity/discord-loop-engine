import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateApproval } from "../src/harness-approval.ts";

const head = "a".repeat(40);
const t0 = "2026-10-27T00:00:00Z",
	t1 = "2026-10-27T00:00:05Z",
	t2 = "2026-10-27T00:00:10Z",
	t3 = "2026-10-27T00:00:11Z";
function comment(body: string, at = t3, login = "owner", id = 20) {
	return {
		id,
		body,
		user: { login },
		created_at: at,
		updated_at: at,
		html_url: `https://github.com/example/project/pull/5#issuecomment-${id}`,
	};
}
function request(marker = `<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} attention=A-12 -->`) {
	return { ...comment(`reason sha=wrong\n${marker}`, t0, "bot", 10), updated_at: t2 };
}
function evaluate(comments: unknown[] = [request()], reviews: unknown[] = [], labels = ["harness:awaiting-merge"]) {
	return evaluateApproval({
		issue: "3",
		head,
		login: "bot",
		owners: ["owner"],
		comments,
		reviews,
		labels,
		prUrl: "https://github.com/example/project/pull/5",
	});
}
test("M6: pending/旧gate/偽marker/欠落/複数/別headを拒否し、最新IDだけを使う", () => {
	assert.equal(evaluate().gate?.attention, "A-12");
	for (const marker of [
		`<!-- harness:pending phase=awaiting-merge issue=3 sha=${head} -->`,
		`<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} -->`,
		`<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} attention=A-12 -->\n<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} attention=A-13 -->`,
	])
		assert.equal(evaluate([request(marker)]).status, "missing-notify");
	assert.equal(evaluate([]).status, "missing-notify");
	assert.equal(
		evaluate([request(`<!-- harness:gate phase=awaiting-merge issue=3 sha=${"b".repeat(40)} attention=A-12 -->`)])
			.status,
		"stale-notify",
	);
	assert.equal(
		evaluate([request(), comment("<!-- harness:pending phase=awaiting-merge issue=3 -->", t3, "stranger", 99)]).status,
		"ready",
	);
	assert.equal(
		evaluate([
			request(),
			{ ...request(), id: 11, body: `<!-- harness:pending phase=awaiting-merge issue=3 sha=${head} -->` },
		]).status,
		"missing-notify",
	);
	assert.equal(evaluate([request()], [], []).status, "missing-notify");
});
test("M6e: OKは完成後のみ、NGは仮POST以後、reviewは現head", () => {
	for (const at of [t0, t1, t2]) assert.equal(evaluate([request(), comment("OK", at)]).verdict, undefined);
	assert.equal(evaluate([request(), comment("OK")]).verdict?.kind, "merge-ok");
	for (const at of [t0, t1, t2, t3]) assert.equal(evaluate([request(), comment("NG", at)]).verdict?.kind, "merge-ng");
	assert.equal(evaluate([request(), comment("NG", "2026-10-26T23:59:59Z")]).verdict, undefined);
	const review = (state: string, at = t3, commit_id: string | undefined = head) => ({
		state,
		submitted_at: at,
		commit_id,
		user: { login: "owner" },
		html_url: "review",
	});
	for (const at of [t1, t2]) assert.equal(evaluate([request()], [review("APPROVED", at)]).verdict, undefined);
	assert.equal(evaluate([request()], [review("APPROVED")]).verdict?.kind, "merge-ok");
	for (const commit of ["b".repeat(40), ""])
		assert.equal(evaluate([request()], [review("APPROVED", t3, commit)]).verdict, undefined);
	assert.equal(evaluate([request()], [review("CHANGES_REQUESTED", t1, "old")]).verdict?.kind, "merge-ng");
	assert.equal(evaluate([request(), comment("NG", t1), comment("OK", t2)]).verdict?.kind, "merge-ng");
	assert.equal(evaluate([request(), comment("OK"), comment("NG")]).verdict?.kind, "merge-ng");
	assert.equal(evaluate([{ ...request(), updated_at: t3 }, comment("OK", t3)]).verdict, undefined);
	assert.equal(
		evaluate([{ ...request(), updated_at: t3 }, comment("OK", "2026-10-27T00:00:12Z")]).verdict?.kind,
		"merge-ok",
	);
});
test("追加注意: pendingや旧gateでもt0以後のNGを優先する", () => {
	for (const marker of [
		`<!-- harness:pending phase=awaiting-merge issue=3 sha=${head} -->`,
		`<!-- harness:gate phase=awaiting-merge issue=3 sha=${head} -->`,
	]) {
		const result = evaluate([request(marker), comment("NG", t1)]);
		assert.equal(result.status, "missing-notify");
		assert.equal(result.verdict?.kind, "merge-ng");
	}
});
test("M6e: 不正時刻で停止し、第三者回答は数えない", () => {
	for (const updated_at of ["", "bad", "2026-10-26T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-27T24:00:00Z"])
		assert.equal(evaluate([{ ...request(), updated_at }]).status, "missing-notify");
	assert.throws(() => evaluate([request(), comment("OK", "bad")]));
	assert.equal(evaluate([request(), comment("OK", t3, "stranger")]).verdict, undefined);
});

// 保存済み回答は最新完成依頼の A・scope と結び付く場合だけ使う。
import { evaluateAttention } from "../src/harness-approval.ts";

const record = {
	id: "A-12",
	taskId: "test#3",
	kind: "merge",
	project: "test",
	issue: "3",
	pr: "5",
	title: "承認",
	url: "url",
	summary: "概要",
	status: "resolved",
	createdAt: "2026-10-28T01:00:00.000Z",
	resolvedAt: "2026-10-28T01:00:00.001Z",
	answer: "OK",
};
function attention(items: unknown = [record], overrides: Record<string, unknown> = {}, sequence = 12) {
	return evaluateAttention({
		gate: evaluate().gate,
		project: "test",
		issue: "3",
		pr: "5",
		owners: ["owner"],
		snapshot: { schemaVersion: 1, items },
		sequence,
		...overrides,
	});
}
test("T3: 台帳の版・sequence・存在・scope・新しいAを順に検証する", () => {
	assert.equal(attention().state, "approved");
	assert.deepEqual(attention([]), { state: "missing", attention: "A-12" });
	for (const items of [[], [record]])
		assert.deepEqual(attention(items, {}, 11), { state: "unavailable", reason: "attention-seq-behind" });
	for (const snapshot of [
		[],
		{ schemaVersion: 2, items: [record] },
		{ schemaVersion: 1, items: [{ id: "A-01" }] },
		{ schemaVersion: 1, items: [record, record] },
	])
		assert.deepEqual(attention([], { snapshot }), { state: "unavailable", reason: "attention-unavailable" });
	for (const field of ["kind", "project", "issue", "pr"]) {
		for (const value of [undefined, "other", 3])
			assert.deepEqual(attention([{ ...record, [field]: value }]), {
				state: "mismatch",
				reason: "attention-scope-mismatch",
			});
	}
	assert.equal(attention([{ ...record, status: "unexpected" }]).state, "unavailable");
	assert.equal(attention([record, { id: "A-99999999999999999999", kind: "future", status: 42 }]).state, "approved");
	assert.deepEqual(attention([record, { ...record, id: "A-13" }]), {
		state: "mismatch",
		reason: "attention-superseded",
	});
	assert.equal(attention([record, { ...record, id: "A-13", status: "bad" }]).state, "unavailable");
	assert.equal(attention([{ ...record, future: { unknown: true } }]).state, "approved");
	assert.equal(attention([{ ...record, status: "open", answer: undefined, resolvedAt: undefined }]).state, "open");
	assert.equal(attention([], { gate: undefined }).state, "not-applicable");
	assert.equal(attention([], { gate: { ...evaluate().gate, attention: null } }).state, "not-applicable");
});
test("T3: 回答証拠・厳密時刻・作成境界を確認し、完成時刻とは比較しない", () => {
	for (const [change, reason] of [
		[{ answer: undefined }, "answer-missing"],
		[{ answer: 1 }, "answer-missing"],
		[{ resolvedAt: undefined }, "resolved-at-missing"],
		[{ resolvedAt: "bad" }, "invalid-time"],
		[{ createdAt: "2026-02-30T00:00:00Z" }, "invalid-time"],
		[{ resolvedAt: "2026-10-28T00:59:59.999Z" }, "answer-before-created"],
		[{ answer: "NG" }, "answer-not-ok"],
		[{ answer: "（完了）" }, "answer-not-ok"],
	] as const)
		assert.deepEqual(attention([{ ...record, ...change }]), {
			state: "not-approved",
			attention: "A-12",
			reason,
			...(reason === "answer-not-ok" ? { resolvedAt: record.resolvedAt } : {}),
		});
	for (const resolvedAt of [record.createdAt, record.resolvedAt, "2026-10-28T01:00:05Z", "2026-10-28T01:00:06Z"])
		assert.equal(
			attention([{ ...record, resolvedAt }], { gate: { ...evaluate().gate, completedAt: "2026-10-28T01:00:05Z" } })
				.state,
			"approved",
		);
	const raw = " owner が Discord で回答。OK、ただし NG\n";
	assert.deepEqual(attention([{ ...record, answer: raw }]), {
		state: "approved",
		attention: "A-12",
		body: raw,
		resolvedAt: record.resolvedAt,
	});
	assert.deepEqual(
		evaluate([request(`<!-- harness:pending phase=awaiting-merge issue=3 sha=${head} -->`)]).requestState,
		"pending",
	);
	assert.equal(evaluate([request("<!-- harness:pending phase=awaiting-merge issue=3 -->")]).requestState, undefined);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarnessProject } from "../src/harness-project.ts";

test("T3: 共通project解決はenv→設定→root、設定不正をfallbackにしない", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-project-"));
	const keys = ["DLE_PROJECT", "HARNESS_CONFIG", "CLAUDE_PROJECT_DIR"] as const;
	const saved = keys.map((key) => [key, process.env[key]] as const);
	try {
		process.env.CLAUDE_PROJECT_DIR = dir;
		process.env.HARNESS_CONFIG = path.join(dir, "profile.json");
		for (const project of [null, "", "configured", undefined]) {
			writeFileSync(process.env.HARNESS_CONFIG, JSON.stringify({ project }));
			process.env.DLE_PROJECT = "environment";
			assert.equal(await resolveHarnessProject(), "environment");
			delete process.env.DLE_PROJECT;
			assert.equal(await resolveHarnessProject(), project || path.basename(dir));
		}
		for (const raw of ["{", '{"project":3}', '{"project":false}', '{"project":[]}']) {
			writeFileSync(process.env.HARNESS_CONFIG, raw);
			await assert.rejects(resolveHarnessProject());
			process.env.DLE_PROJECT = "environment";
			await assert.rejects(resolveHarnessProject());
			delete process.env.DLE_PROJECT;
		}
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("T3: 現物4件は台帳原文のまま照合し、完成コメント編集でもchat回答を失効させない", () => {
	const answers = [
		"OK（Discord: jonnity）",
		"jonnity が Discord で回答。OK(マージを承認)。",
		"jonnity が Discord で回答。OK(PR #23 のマージを承認)。設計外の追加(formatEmbeds: false)も含めて承認。マージ後に #17 を rebase してください。",
		"NG: 表示は良い感じ。ただし…（この返事は OK ではない）。（Discord: jonnity）",
	];
	const checks = answers.map((answer) => attention([{ ...record, answer }], { owners: ["jonnity"] }));
	assert.deepEqual(
		checks.map((check) => check.state === "approved"),
		[true, true, true, false],
	);
	for (const [index, check] of checks.entries())
		if (check.state === "approved") assert.equal(check.body, answers[index]);
	for (const completedAt of ["2026-10-28T01:00:05Z", "2026-10-29T01:00:05Z"])
		assert.equal(attention([record], { gate: { ...evaluate().gate, completedAt } }).state, "approved");
});
