// 人の実回答を再検証してからだけ Approve とマージを行い、結果不明は再送しない。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gh, run } from "./harness-approval.ts";
import { bin, facts, type PrContext, PrError, type PrFacts, type PrTarget, pages, readPr } from "./harness-pr.ts";
import {
	infoOnce,
	jsonApi,
	newRecovery,
	notifyPhase,
	type PrRecovery,
	readControl,
	readRecovery,
	reconcile,
	recoveryPath,
	requestRebase,
	saveControl,
	saveRecovery,
	withLock,
} from "./harness-pr-request.ts";
import { object } from "./notification-receipt.ts";

function identity(c: PrContext, f: PrFacts) {
	return JSON.stringify({
		repo: c.repo,
		project: c.project,
		pr: f.target.pr,
		head: f.target.head,
		gate: f.approval.gate,
		answer: f.check,
	});
}
function requireApproval(f: PrFacts, chat?: string, attention?: string) {
	if (f.approval.ownerNg) throw new PrError("github-ng");
	if (f.approval.status !== "ready" || !f.approval.gate || f.check.state !== "approved")
		throw new PrError("有効な A の OK がありません");
	if (attention !== undefined && (f.approval.gate.attention !== attention || f.check.body !== chat))
		throw new PrError("回答の引用が台帳と一致しません");
	if (f.target.state !== "open" || f.target.merged || !f.green || f.unknown || f.blocked)
		throw new PrError("CI/保護状態がマージ条件を満たしません");
}
function autoMergeDisabled(t: PrTarget) {
	if (
		t.autoMerge === undefined ||
		(t.autoMerge !== null && (typeof t.autoMerge !== "object" || Array.isArray(t.autoMerge)))
	)
		throw new PrError("auto_merge が未確認です");
	return t.autoMerge === null;
}
async function revalidate(c: PrContext, pr: number, initial: string, chat?: string, attention?: string) {
	const f = await facts(c, pr);
	requireApproval(f, chat, attention);
	if (f.needsRebase || identity(c, f) !== initial) throw new PrError("承認した head/依頼/回答が変わりました");
	return f;
}
async function cleanupTemp(c: PrContext, r: PrRecovery) {
	if (!r.tempDir) return;
	// 保存した所有印と専用パスを照合してから、その領域だけを回収する。
	const temp = r.tempDir;
	if (
		!path.basename(temp).startsWith("dle-pr-hook-") ||
		path.dirname(temp) !== os.tmpdir() ||
		r.tempWorktree !== path.join(temp, "worktree") ||
		!r.tempRef?.startsWith(`refs/harness/pr-${r.pr}/`)
	)
		throw new PrError("一時物の所有範囲が不正です");
	const owner = object(JSON.parse(await readFile(path.join(temp, "owner.json"), "utf8")));
	if (
		owner.repo !== r.repo ||
		owner.pr !== r.pr ||
		owner.head !== r.head ||
		owner.startedAt !== r.startedAt ||
		owner.pid !== r.pid
	)
		throw new PrError("一時物の所有印が一致しません");
	const list = await run("git", ["-C", c.root, "worktree", "list", "--porcelain"]);
	if (list.split("\n").includes(`worktree ${r.tempWorktree}`))
		await run("git", ["-C", c.root, "worktree", "remove", "--force", r.tempWorktree]);
	const after = await run("git", ["-C", c.root, "worktree", "list", "--porcelain"]);
	if (after.split("\n").includes(`worktree ${r.tempWorktree}`)) throw new PrError("一時 worktree の回収が未確認です");
	await run("git", ["-C", c.root, "update-ref", "-d", r.tempRef]);
	await rm(temp, { recursive: true, force: true });
	delete r.tempDir;
	delete r.tempWorktree;
	delete r.tempRef;
	await saveRecovery(c, r);
}
async function beforeMerge(c: PrContext, t: PrTarget, r: PrRecovery) {
	if (!c.hooks.length) return;
	const temp = await mkdtemp(path.join(os.tmpdir(), "dle-pr-hook-"));
	r.stage = "merge:hook";
	r.tempDir = temp;
	r.tempWorktree = path.join(temp, "worktree");
	r.tempRef = `refs/harness/pr-${t.pr}/${path.basename(temp)}`;
	await writeFile(
		path.join(temp, "owner.json"),
		JSON.stringify({ repo: r.repo, pr: r.pr, head: r.head, pid: r.pid, startedAt: r.startedAt }),
		{ mode: 0o600 },
	);
	await saveRecovery(c, r);
	await run("git", ["-C", c.root, "fetch", "--no-tags", "origin", `pull/${t.pr}/head:${r.tempRef}`]);
	if ((await run("git", ["-C", c.root, "rev-parse", r.tempRef])) !== t.head)
		throw new PrError("取得した head が承認と一致しません");
	await run("git", ["-C", c.root, "worktree", "add", "--detach", r.tempWorktree, t.head]);
	if ((await run("git", ["-C", r.tempWorktree, "rev-parse", "HEAD"])) !== t.head)
		throw new PrError("hook の HEAD が一致しません");
	await run(
		"env",
		[
			`HARNESS_CONFIG=${c.configPath}`,
			`CLAUDE_PROJECT_DIR=${c.root}`,
			path.join(bin, "harness-hook"),
			"beforeMerge",
			"--pr",
			String(t.pr),
			"--dir",
			r.tempWorktree,
		],
		180000,
	);
	if ((await run("git", ["-C", r.tempWorktree, "rev-parse", "HEAD"])) !== t.head)
		throw new PrError("hook が HEAD を変えました");
}
function reviewBody(attention: string, head: string) {
	return `人の ${attention} の OK を検証しました。\n承認対象 head: ${head}`;
}
function validReview(raw: unknown, c: PrContext, r: PrRecovery) {
	const v = object(raw);
	return (
		typeof v.id === "number" &&
		Number.isSafeInteger(v.id) &&
		v.id > 0 &&
		object(v.user).login === c.login &&
		v.state === "APPROVED" &&
		v.commit_id === r.head &&
		v.body === reviewBody(r.attention ?? "", r.head)
	);
}
async function approve(c: PrContext, f: PrFacts, r: PrRecovery) {
	if (!r.attention) throw new PrError("A がありません");
	const matches = f.reviews.filter((v) => validReview(v, c, r));
	if (matches.length > 1) throw new PrError("重複した Approve があります");
	if (matches[0]) {
		r.approvedReviewId = Number(object(matches[0]).id);
		await saveRecovery(c, r);
		return;
	}
	if (r.reviewIntent) throw new PrError("Approve の送信結果が不明です。再送しません");
	r.stage = "merge:approve";
	r.reviewIntent = true;
	await saveRecovery(c, r);
	let review: unknown;
	try {
		review = await jsonApi(`repos/${c.repo}/pulls/${r.pr}/reviews`, "POST", {
			event: "APPROVE",
			commit_id: r.head,
			body: reviewBody(r.attention, r.head),
		});
	} catch {
		const next = await facts(c, r.pr);
		review = next.reviews.find((v) => validReview(v, c, r));
	}
	if (!validReview(review, c, r)) throw new PrError("Approve の結果が未確認です。再送しません");
	r.approvedReviewId = Number(object(review).id);
	await saveRecovery(c, r);
}
async function exactRef(c: PrContext, t: PrTarget) {
	const repository = object(JSON.parse(await gh("api", `repos/${c.repo}`)));
	if (
		repository.full_name !== c.repo ||
		typeof repository.default_branch !== "string" ||
		t.headRef === repository.default_branch ||
		t.headRef === t.baseRef
	)
		throw new PrError("default/base ブランチは削除しません");
	const encoded = t.headRef.split("/").map(encodeURIComponent).join("/");
	const endpoint = `repos/${c.repo}/git/ref/heads/${encoded}`;
	const read = async () => {
		try {
			const v = object(JSON.parse(await gh("api", endpoint)));
			if (v.ref !== `refs/heads/${t.headRef}` || typeof object(v.object).sha !== "string")
				throw new PrError("ref が不正です");
			return String(object(v.object).sha);
		} catch {
			// exact ref の不存在だけを許す。認証・通信失敗を不存在と読み替えない。
			const repo = object(JSON.parse(await gh("api", `repos/${c.repo}`)));
			if (repo.full_name !== c.repo) throw new PrError("repo が読めません");
			const matching = await pages(`repos/${c.repo}/git/matching-refs/heads/${encoded}`);
			if (matching.some((v) => object(v).ref === `refs/heads/${t.headRef}`))
				throw new PrError("exact ref の読取りが未確認です");
			return undefined;
		}
	};
	const sha = await read();
	if (sha !== undefined && sha !== t.head) throw new PrError("ブランチは別 SHA なので削除しません");
	if (sha !== undefined) await gh("api", `repos/${c.repo}/git/refs/heads/${encoded}`, "--method", "DELETE");
	if ((await read()) !== undefined) throw new PrError("ブランチの削除が未確認です");
}
async function finish(c: PrContext, t: PrTarget, r: PrRecovery) {
	if (!t.merged || t.head !== r.head) throw new PrError("実マージ/head が未確認です");
	r.merged = true;
	r.stage = "merge:cleanup";
	await saveRecovery(c, r);
	try {
		await cleanupTemp(c, r);
		if (!r.branchDeleted) {
			await exactRef(c, t);
			r.branchDeleted = true;
			await saveRecovery(c, r);
		}
		if (!r.doneNotified) {
			if (r.doneIntent) throw new PrError("done 通知は結果不明です。手動確認が必要です");
			r.doneIntent = true;
			await saveRecovery(c, r);
			await notifyPhase(c, t, "done", "（PR merged）");
			r.doneNotified = true;
			const control = await readControl(c, t.pr);
			control.terminal = { phase: "done", status: "sent" };
			await saveControl(c, control);
			await saveRecovery(c, r);
		}
		await rm(recoveryPath(c, t.pr));
	} catch (error) {
		await infoOnce(
			c,
			t,
			[`${r.head}:cleanup:${!r.branchDeleted ? "branch" : !r.doneNotified ? "done" : "temp"}`],
			"マージ済み・後始末未完了です。復旧記録を確認してください。",
		);
		throw error;
	}
}
export async function mergeDependabotPr(c: PrContext, pr: number, chat?: string, attention?: string) {
	await withLock(c, String(pr), async () => {
		let t = await readPr(c, pr);
		let r = await readRecovery(c, pr);
		if (t.merged) {
			if (r?.stage.startsWith("merge:")) await finish(c, t, r);
			return;
		}
		if (r?.stage.startsWith("request:")) throw new PrError("依頼が未完了です");
		if (r?.tempDir) {
			if (r.stage === "merge:hook") throw new PrError("中断した hook/子孫の停止と一時物の所有を先に確認してください");
			let alive = true;
			try {
				process.kill(r.pid, 0);
			} catch (error) {
				if (object(error).code === "ESRCH") alive = false;
				else throw error;
			}
			if (alive) throw new PrError("一時物の所有プロセスが残っています");
			await cleanupTemp(c, r);
		}
		if (r?.mergeIntent) {
			if (t.head !== r.head) {
				await infoOnce(
					c,
					t,
					[`${r.head}:approve-stopped`],
					"キュー/結果確認中に head が変わりました。Approve がある場合は残っています。新 head の新 A を待ちます。",
					"approve-stopped",
					r.head,
				);
				throw new PrError("キューの head が変わりました");
			}
			if (r.queued) {
				const current = await facts(c, pr);
				if (current.queued && current.target.head === r.head) return;
				if (r.approvedReviewId)
					await infoOnce(
						c,
						t,
						[`${r.head}:approve-stopped`],
						"Approve が残っています。キューからの離脱を確認したため停止しました。GitHub で確認してください。",
						"approve-stopped",
						r.head,
					);
				throw new PrError("キューから離脱しました。実結果を確認してください");
			}
			throw new PrError("マージ送信の結果不明です。無条件に再送しません");
		}
		let f = await facts(c, pr);
		const control = await reconcile(c, f);
		if (control.slotReleasedHead === t.head || control.slotReleasedReason === "owner-ng")
			throw new PrError("停止中です。窓口経由の明示再依頼を待ちます");
		requireApproval(f, chat, attention);
		if (f.needsRebase) {
			await requestRebase(c, f);
			throw new PrError("rebase 待ちです");
		}
		const initial = identity(c, f);
		if (r?.identity && r.identity !== initial) throw new PrError("復旧記録の承認と一致しません");
		r ??= newRecovery(c, t, "merge:validated");
		r.identity = initial;
		r.attention = f.approval.gate?.attention;
		await saveRecovery(c, r);
		try {
			await beforeMerge(c, t, r);
			r.stage = "merge:hook-complete";
			await saveRecovery(c, r);
			f = await revalidate(c, pr, initial, chat, attention);
			// 監査は回答の原文を構造化 JSON で保持する。PR 本文は使用しない。
			if (f.check.state !== "approved" || !r.attention) throw new PrError("実回答がありません");
			await jsonApi(`repos/${c.repo}/issues/${pr}/comments`, "POST", {
				body: `チャットでマージ承認を受けました:\n${f.check.body}\n\n<!-- harness:approval source=chat attention=${r.attention} sha=${r.head} -->`,
			});
			const needsReview = f.review === "REVIEW_REQUIRED" || r.reviewIntent || r.approvedReviewId;
			if (needsReview) {
				f = await revalidate(c, pr, initial, chat, attention);
				if (!autoMergeDisabled(f.target)) {
					await infoOnce(
						c,
						t,
						[`${r.head}:auto-merge-enabled`],
						"auto-merge が有効なので Approve せず停止しました。GitHub で扱ってください。",
						"auto-merge-enabled",
					);
					throw new PrError("auto-merge-enabled");
				}
				await approve(c, f, r);
				f = await revalidate(c, pr, initial, chat, attention);
				// stale な Approve は保護設定によって新 head でも数えられうる。dismiss せず、新 A を待つ。
				if (!autoMergeDisabled(f.target)) throw new PrError("Approve 後に auto-merge が有効になりました");
				if (f.review === "REVIEW_REQUIRED" || !["CLEAN", "HAS_HOOKS"].includes(f.protection))
					throw new PrError("必要レビュー数/CODEOWNERS 等の保護条件が不足しています");
			}
			f = await revalidate(c, pr, initial, chat, attention);
			if (r.approvedReviewId && !autoMergeDisabled(f.target))
				throw new PrError("Approve 後に auto-merge が有効になりました");
			r.mergeIntent = true;
			r.stage = "merge:send";
			await saveRecovery(c, r);
			let sent = false;
			try {
				await gh("pr", "merge", String(pr), `--${c.method}`, "--match-head-commit", r.head);
				sent = true;
			} catch {
				// CLI の結果にかかわらず、実 PR を先に再取得する。
			}
			t = await readPr(c, pr);
			if (t.merged) {
				await finish(c, t, r);
				return;
			}
			if (!sent || t.head !== r.head) throw new PrError("マージ結果不明または head 変更です");
			const result = await facts(c, pr);
			if (!result.queued) throw new PrError("実マージもキュー投入も未確認です");
			if (r.approvedReviewId && !autoMergeDisabled(result.target))
				throw new PrError("Approve 後に auto-merge が有効になりました");
			r.queued = true;
			r.stage = "merge:queue";
			await saveRecovery(c, r);
		} catch (error) {
			if (r.approvedReviewId || r.reviewIntent) {
				const reason = error instanceof PrError ? error.message : "API/CLI の検証または操作に失敗しました";
				let auto = "auto_merge は再確認できませんでした。";
				try {
					const after = await readPr(c, pr);
					auto = after.autoMerge === null ? "" : "auto_merge が非 null または未確認です。";
				} catch {}
				const keys = [`${r.head}:approve-stopped`];
				try {
					if ((await facts(c, pr)).approval.ownerNg) keys.push(`${t.head}:owner-ng`);
				} catch {}
				await infoOnce(
					c,
					t,
					keys,
					`Approve が残っている、または送信結果が不明です。${reason}。${auto}GitHub で確認してください。`,
					"approve-stopped",
					r.head,
				);
			} else if (!r.mergeIntent && !r.tempDir) {
				// 副作用が無い検査失敗だけは次回の正常な検査に戻せる。
				await rm(recoveryPath(c, pr), { force: true });
			}
			throw error;
		} finally {
			if (r.tempDir) {
				try {
					await cleanupTemp(c, r);
				} catch {
					await saveRecovery(c, r);
					await infoOnce(
						c,
						t,
						[`${r.head}:cleanup:temp`],
						`${r.merged ? "マージ済み・後始末未完了" : "一時 worktree 回収未完了"}です。所有プロセスを確認してください。`,
					);
					process.exitCode ||= 1;
				}
			}
		}
	});
}
