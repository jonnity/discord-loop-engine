// awaiting-merge の外部書込みは直列化する。未確認の復旧をローカルにも残す。
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type RecoveryExitCode, run } from "./harness-approval.ts";
import {
	patchComment,
	prHead,
	rememberRecovery as rememberRecoveryFiles,
	resetLabels as resetIssueLabels,
	validateComment as validateCommentResponse,
} from "./harness-completion.ts";
import { resolveHarnessProject } from "./harness-project.ts";
import {
	formatReceiptFailure,
	MediaVerificationError,
	object,
	parseReceiptFailure,
	receiptFailure,
	verifyMedia,
} from "./notification-receipt.ts";

const bin = path.resolve(import.meta.dirname, "../bin");
const [issue = "", pr = "", commentFile = "", summaryFile = "", file = "", temp = "", gateDefinedArg = ""] =
	process.argv.slice(2);
const states = new Set([path.resolve(".harness", `merge-recovery-${issue}.json`)]);
let stage = "静的通知先検査",
	attention = "不明",
	repo = "",
	commentId = 0,
	pending = "",
	login = "",
	head = "",
	note = "";
let code: RecoveryExitCode = 4;
let recoveryExitCode: RecoveryExitCode | undefined;
const gh = (...args: string[]) => run("gh", args, 30000, recoveryExitCode);
// harness-gate が残す結果ファイル。承認依頼に未確認の検査（skipExit 宣言の段の終了 78）を載せるために読む。
type GateResult = {
	version: 1;
	head: string;
	dirty: boolean;
	policy: "warn" | "fail";
	skipped: string[];
	failed: string[];
};
// harness-phase から渡す「gate が定義されているか」。無い・空は未定義と同じ。想定外の値は「不明」側に倒す。
type GateDefined = "1" | "0" | "unreadable";
const NOTE_MAX = 500;
const gateDefined: GateDefined =
	gateDefinedArg === "" || gateDefinedArg === "0" ? "0" : gateDefinedArg === "1" ? "1" : "unreadable";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
function isGateResult(v: unknown): v is GateResult {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const r = v as Record<string, unknown>;
	return (
		r.version === 1 &&
		typeof r.head === "string" &&
		/^[a-f0-9]{40}$/.test(r.head) &&
		typeof r.dirty === "boolean" &&
		(r.policy === "warn" || r.policy === "fail") &&
		isStrings(r.skipped) &&
		isStrings(r.failed)
	);
}
const cpLength = (s: string) => Array.from(s).length;
// 未確認の注記。表示のみで、承認や merge は止めない。コードポイントで NOTE_MAX 以内に収める。
async function gateNote(currentHeadSha: string): Promise<string> {
	if (gateDefined === "0") return "";
	const rerun = "`harness-gate` を再実行してください";
	const noResult = `⚠ 現在の head の gate 結果が無く、未確認の有無は不明です。${rerun}`;
	let raw: string;
	try {
		raw = await readFile(path.resolve(".harness", "gate-result.json"), "utf8");
	} catch {
		return noResult;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		data = undefined;
	}
	if (!isGateResult(data)) return `⚠ gate の結果ファイルを読めないため、未確認の検査の有無は不明です。${rerun}`;
	if (data.head !== currentHeadSha || data.dirty) return noResult;
	if (data.failed.length) return `⚠ gate が失敗した結果しかありません。未確認の有無は不明です。${rerun}`;
	if (!data.skipped.length) return "";
	// 名前は任意文字列なので、marker を作れる記号と改行を空白にする。
	const names = data.skipped.map((n) =>
		n
			.replace(/<!--|-->/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
	const build = (n: number) => {
		const rest = names.length - n;
		return `⚠ 未確認の検査: ${names.slice(0, n).join(", ")}${rest > 0 ? ` …他 ${rest} 件` : ""}（CI で初めて検査される）`;
	};
	let n = names.length;
	while (n > 0 && cpLength(build(n)) > NOTE_MAX) n--;
	if (n > 0) return build(n);
	return Array.from(build(0)).slice(0, NOTE_MAX).join("");
}
const rememberRecovery = () => rememberRecoveryFiles(states, issue, pr);
const patch = (body: string) => patchComment(gh, repo, commentId, temp, body);
const resetLabels = () => resetIssueLabels(gh, issue);
const currentHead = () => prHead(gh, pr);
const validateComment = (c: Record<string, unknown>, body: string, id?: number) =>
	validateCommentResponse(c, body, { repo, login }, id);
async function main() {
	try {
		await run(path.join(bin, "harness-notify"), ["--check-target", "--event", "merge-request"]);
	} catch (error) {
		if (object(error).code === 2) code = 2;
		throw error;
	}
	const config = path.join(bin, "harness-config");
	const project = await resolveHarnessProject();
	try {
		const worktree = await run(config, ["--worktree", issue]);
		if (worktree) states.add(path.join(worktree, ".harness", `merge-recovery-${issue}.json`));
	} catch {
		// worktree が未解決なら、従来どおり cwd 側の状態で止める。
	}
	stage = "事前読取り";
	code = 1;
	repo = await gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw Error("repo 不正");
	login = await gh("api", "user", "--jq", ".login");
	if (!login) throw Error("login 不正");
	head = await currentHead();
	note = await gateNote(head);
	const title = await gh("issue", "view", issue, "--json", "title", "-q", ".title");
	const comment = await readFile(commentFile, "utf8"),
		summaryText = await readFile(summaryFile, "utf8");
	// Discord は先頭 3500 文字で切るため、注記は要約の先頭に置く。要約は切らない（切るのは harness-phase の 1 か所）。
	const summary = note ? `${note}\n\n${summaryText}` : summaryText;
	stage = "開始ラベル";
	code = 5;
	await rememberRecovery();
	await resetLabels();
	stage = "仮POST";
	code = 1;
	pending = `${comment}\n\n${file ? "動画: Discord メッセージリンクを作成中です。" : "通知確認中。"}承認依頼は未完了です。${note ? `\n\n${note}` : ""}\n\n<!-- harness:pending phase=awaiting-merge issue=${issue} sha=${head} -->`;
	const postFile = path.join(temp, "post.json");
	await writeFile(postFile, JSON.stringify({ body: pending }), { mode: 0o600 });
	const posted = object(
		JSON.parse(await gh("api", `repos/${repo}/issues/${pr}/comments`, "--method", "POST", "--input", postFile)),
	);
	validateComment(posted, pending);
	commentId = Number(posted.id);
	stage = "通知";
	code = 4;
	const args = [
		"--json",
		"--event",
		"merge-request",
		"--title",
		title,
		"--url",
		String(posted.html_url),
		"--issue",
		issue,
		"--pr",
		pr,
		"--project",
		project,
		"--repo",
		repo,
		"--body",
		summary,
	];
	if (file) args.push("--file", file);
	const raw = await run(path.join(bin, "harness-notify"), args, 180000);
	await writeFile(path.join(temp, "receipt.json"), raw, { mode: 0o600 });
	let receipt: Record<string, unknown>;
	try {
		receipt = object(JSON.parse(raw));
	} catch (error) {
		if (!file) throw error;
		throw new MediaVerificationError({ stage: "input", reason: "invalid" });
	}
	if (receipt.status !== "posted") throw Error("通知未完了");
	stage = "A/動画照合";
	code = 7;
	if (receipt.source === "engine") {
		if (typeof receipt.attention !== "string" || !/^A-[1-9][0-9]*$/.test(receipt.attention)) throw Error("A 欠落");
		attention = receipt.attention;
	} else if (receipt.source === "webhook" && receipt.attention === null) attention = "none";
	else throw Error("source 不正");
	let media = "";
	if (file) {
		if ("discord_error" in receipt) throw new MediaVerificationError(parseReceiptFailure(receipt.discord_error));
		let fp: unknown;
		try {
			fp = JSON.parse(await readFile(path.join(temp, "fingerprint.json"), "utf8"));
		} catch {
			throw new MediaVerificationError({ stage: "input", reason: "invalid" });
		}
		const verified = await verifyMedia(receipt.discord, fp, file, path.join(temp, "download.mp4"));
		media = `\n\n動画: [デモ動画を開く（Discord）](${object(receipt.discord).url})\n${verified.filename} / ${verified.bytes} bytes / SHA-256: ${verified.sha256} / 再取得照合済み`;
	}
	if ((await currentHead()) !== head) throw Error("head 変更");
	const body = `${comment}${media}${attention === "none" ? "\n\nこの通知は A-番号がないため、承認は GitHub の OK/Approve 等で回答してください。" : ""}${note ? `\n\n${note}` : ""}\n\n<!-- harness:gate phase=awaiting-merge issue=${issue} sha=${head} attention=${attention} -->`;
	// PATCH の応答喪失やプロセス終了でも、後続の merge は停止したままにする。
	await rememberRecovery();
	stage = "完成PATCH";
	const completed = await patch(body);
	validateComment(completed, body, commentId);
	if (completed.created_at !== posted.created_at) throw Error("created_at 変更");
	stage = "最終ラベル";
	code = 5;
	await resetLabels();
	stage = "最終head";
	code = 7;
	if ((await currentHead()) !== head) throw Error("head 変更");
	for (const state of states) await rm(state, { force: true });
	console.error(`harness-phase: #${issue} → awaiting-merge: ${posted.html_url}`);
}
main().catch(async (error: unknown) => {
	process.exitCode = process.exitCode || code;
	recoveryExitCode = code;
	const primary =
		error instanceof MediaVerificationError || (file && stage === "A/動画照合")
			? `${formatReceiptFailure(receiptFailure(error))} `
			: "";
	let recoveryFailed = false;
	if (commentId && pending) {
		// 一方の復旧が失敗しても、もう一方を試す。次の成功再依頼まで拒否状態を残す。
		try {
			await resetLabels();
		} catch {
			recoveryFailed = true;
		}
		try {
			const result = await patch(pending);
			validateComment(result, pending, commentId);
		} catch {
			recoveryFailed = true;
		}
		try {
			const result = object(JSON.parse(await gh("api", `repos/${repo}/issues/comments/${commentId}`)));
			validateComment(result, pending, commentId);
			await resetLabels();
		} catch {
			recoveryFailed = true;
		}
		try {
			await rememberRecovery();
		} catch {
			recoveryFailed = true;
		}
	}
	console.error(
		`harness-phase: ${primary}${stage} 失敗（exit ${code}）。${recoveryFailed ? "復旧状態は未確認。" : ""}${attention === "不明" ? "A は取下げ未確認" : `この ${attention} の承認依頼は未完了です`}。OK を返してもそのままではマージできません。原因解消後に再依頼してください。動画ありで本人の OK が Discord にある未完了は、\`harness-phase <issue> awaiting-merge --pr <PR> --adopt-pending <A>\` で完了できます。`,
	);
});
