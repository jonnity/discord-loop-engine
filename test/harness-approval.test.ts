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
