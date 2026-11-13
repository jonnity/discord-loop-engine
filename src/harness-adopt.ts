// 動画の再取得照合に失敗して未完了のままの承認依頼を、本人の OK 済みの同じ A で完了にする。
// 完成させるだけで、merge の判定（CI・head・A の再検証など）は harness-merge が従来どおり行う。
import { rm } from "node:fs/promises";
import path from "node:path";
import {
	type AdoptionVerdict,
	evaluateAdoption,
	loadApproval,
	readLedger,
	run,
	VIDEO_PENDING_SENTENCE,
} from "./harness-approval.ts";
import { patchComment, prHead, rememberRecovery, resetLabels, validateComment } from "./harness-completion.ts";

// 仮コメントの本文から、完成本文に引き継ぐ原文（comment）と gate の注記（note）を取り出す。
// 形は harness-request の仮コメントと同じ: `${comment}\n\n${固定文}${note ? `\n\n${note}` : ""}\n\n<!-- marker -->`
export function splitPending(body: string): { comment: string; note: string } | undefined {
	const at = body.lastIndexOf(`\n\n${VIDEO_PENDING_SENTENCE}`);
	if (at < 0) return undefined;
	const rest = body.slice(at + 2 + VIDEO_PENDING_SENTENCE.length);
	const m = /^(?:\n\n([\s\S]*?))?\n\n<!-- harness:pending [^\n]* -->$/.exec(rest);
	if (!m) return undefined;
	return { comment: body.slice(0, at), note: m[1] ?? "" };
}
// 完成本文。動画は照合していないこと、本人の Discord の OK を根拠にしたことを本文で明示する。
export function completedBody(p: { comment: string; note: string; issue: string; head: string; attention: string }) {
	return `${p.comment}\n\n動画: この承認依頼の Discord メッセージ（${p.attention}）に添付した（再取得照合は未了のため、添付の存在・内容は未確認）。照合済みではありません。本人の Discord での OK を根拠に完了扱いにしました。${p.note ? `\n\n${p.note}` : ""}\n\n<!-- harness:gate phase=awaiting-merge issue=${p.issue} sha=${p.head} attention=${p.attention} -->`;
}

async function main() {
	const [issue = "", pr = "", attentionArg = "", temp = ""] = process.argv.slice(2);
	const states = new Set([path.resolve(".harness", `merge-recovery-${issue}.json`)]);
	let code: 1 | 5 | 7 = 1;
	let stage = "事前読取り";
	let repo = "",
		login = "",
		commentId = 0,
		pending = "";
	let patched = false;
	let recoveryExitCode: 1 | 5 | 7 | undefined;
	let wrote = false;
	const gh = (...args: string[]) => run("gh", args, 30000, recoveryExitCode);
	const refuse = (reason: string): never => {
		console.error(`harness-phase: 採用不可 reason=${reason}。変更していません。`);
		process.exit(1);
	};
	if (!/^[1-9][0-9]*$/.test(issue) || !/^[1-9][0-9]*$/.test(pr) || !/^A-[1-9][0-9]*$/.test(attentionArg) || !temp)
		process.exit(2);
	try {
		const config = path.resolve(import.meta.dirname, "../bin/harness-config");
		try {
			const worktree = await run(config, ["--worktree", issue]);
			if (worktree) states.add(path.join(worktree, ".harness", `merge-recovery-${issue}.json`));
		} catch {
			// worktree が未解決なら、cwd 側の復旧ファイルだけで止める（harness-request と同じ）。
		}
		const loaded = await loadApproval(issue, pr, true);
		repo = loaded.repo;
		login = loaded.login;
		let verdict: AdoptionVerdict;
		try {
			verdict = evaluateAdoption({
				issue,
				pr,
				head: loaded.head,
				login,
				owners: loaded.owners,
				ownersUnavailable: loaded.ownersUnavailable,
				comments: loaded.comments,
				attention: attentionArg,
				...(await readLedger()),
			});
		} catch {
			verdict = { state: "none", reason: "unavailable" };
		}
		if (verdict.state !== "adoptable") return refuse(verdict.reason);
		const split = splitPending(verdict.comment.body);
		if (!split) return refuse("no-video-pending");
		const head = verdict.comment.sha;
		commentId = verdict.comment.id;
		pending = verdict.comment.body;
		const body = completedBody({ ...split, issue, head, attention: verdict.attention });

		// 以降は外部へ書く。失敗しても merge は復旧ファイルで拒否されたままにする。
		stage = "開始ラベル";
		code = 5;
		await rememberRecovery(states, issue, pr);
		wrote = true;
		await resetLabels(gh, issue);
		stage = "head確認";
		code = 7;
		if ((await prHead(gh, pr)) !== head) throw Error("head 変更");
		stage = "完成PATCH";
		patched = true;
		const completed = await patchComment(gh, repo, commentId, temp, body);
		validateComment(completed, body, { repo, login }, commentId);
		if (completed.created_at !== verdict.comment.createdAt) throw Error("created_at 変更");
		stage = "最終ラベル";
		code = 5;
		await resetLabels(gh, issue);
		stage = "最終head";
		code = 7;
		if ((await prHead(gh, pr)) !== head) throw Error("head 変更");
		for (const state of states) await rm(state, { force: true });
		console.error(`harness-phase: #${issue} → awaiting-merge（採用）: ${verdict.comment.url}`);
	} catch {
		process.exitCode = code;
		recoveryExitCode = code;
		let restored = true;
		if (patched) {
			// 完成にしたまま確認できなかったときは、pending へ戻す。戻せなくても復旧ファイルは残るので merge は拒否される。
			try {
				validateComment(await patchComment(gh, repo, commentId, temp, pending), pending, { repo, login }, commentId);
			} catch {
				restored = false;
			}
		}
		console.error(
			`harness-phase: 採用 ${stage} 失敗（exit ${code}）。${restored ? "" : "pending へ戻せていません。"}${wrote ? "復旧未確認のため harness-merge は拒否のままです。" : "変更していません。"}`,
		);
	}
}
main();
