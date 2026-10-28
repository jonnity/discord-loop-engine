// awaiting-merge の外部書込みは直列化する。未確認の復旧をローカルにも残す。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gh, run, validTime } from "./harness-approval.ts";
import { resolveHarnessProject } from "./harness-project.ts";
import { object, verifyMedia } from "./notification-receipt.ts";

const bin = path.resolve(import.meta.dirname, "../bin");
const [issue = "", pr = "", commentFile = "", summaryFile = "", file = "", temp = ""] = process.argv.slice(2);
const states = new Set([path.resolve(".harness", `merge-recovery-${issue}.json`)]);
let stage = "静的通知先検査",
	attention = "不明",
	code = 4,
	repo = "",
	commentId = 0,
	pending = "",
	login = "",
	head = "";
async function rememberRecovery() {
	for (const state of states) {
		await mkdir(path.dirname(state), { recursive: true });
		await writeFile(state, JSON.stringify({ issue, pr, stage: "復旧未確認" }), { mode: 0o600 });
	}
}
async function patch(body: string) {
	const input = path.join(temp, "patch.json");
	await writeFile(input, JSON.stringify({ body }), { mode: 0o600 });
	return object(
		JSON.parse(await gh("api", `repos/${repo}/issues/comments/${commentId}`, "--method", "PATCH", "--input", input)),
	);
}
async function labels() {
	const data = object(JSON.parse(await gh("issue", "view", issue, "--json", "labels")));
	if (!Array.isArray(data.labels) || data.labels.some((l) => typeof object(l).name !== "string"))
		throw Error("labels 不正");
	return data.labels.map((l) => String(object(l).name));
}
async function resetLabels() {
	const current = await labels();
	const args: string[] = [];
	for (const label of current)
		if (label.startsWith("harness:") && label !== "harness:awaiting-merge") args.push("--remove-label", label);
	if (!current.includes("harness:awaiting-merge")) args.push("--add-label", "harness:awaiting-merge");
	if (args.length) await gh("issue", "edit", issue, ...args);
	const result = await labels();
	if (
		!result.includes("harness:awaiting-merge") ||
		result.some((l) => l.startsWith("harness:") && l !== "harness:awaiting-merge")
	)
		throw Error("labels 未確認");
}
async function currentHead() {
	const value = await gh("pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid");
	if (!/^[a-f0-9]{40}$/.test(value)) throw Error("head 不正");
	return value;
}
function validateComment(c: Record<string, unknown>, body: string, id?: number) {
	if (
		!Number.isSafeInteger(c.id) ||
		Number(c.id) <= 0 ||
		(id !== undefined && c.id !== id) ||
		typeof c.html_url !== "string" ||
		!c.html_url.startsWith(`https://github.com/${repo}/`) ||
		c.body !== body ||
		object(c.user).login !== login ||
		!validTime(c.created_at) ||
		!validTime(c.updated_at) ||
		Date.parse(c.created_at) > Date.parse(c.updated_at)
	)
		throw Error("comment 応答不正");
}
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
	const title = await gh("issue", "view", issue, "--json", "title", "-q", ".title");
	const comment = await readFile(commentFile, "utf8"),
		summary = await readFile(summaryFile, "utf8");
	stage = "開始ラベル";
	code = 5;
	await rememberRecovery();
	await resetLabels();
	stage = "仮POST";
	code = 1;
	pending = `${comment}\n\n${file ? "動画: Discord メッセージリンクを作成中です。" : "通知確認中。"}承認依頼は未完了です。\n\n<!-- harness:pending phase=awaiting-merge issue=${issue} sha=${head} -->`;
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
	const receipt = object(JSON.parse(raw));
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
		const fp = JSON.parse(await readFile(path.join(temp, "fingerprint.json"), "utf8"));
		const verified = await verifyMedia(receipt.discord, fp, file, path.join(temp, "download.mp4"));
		media = `\n\n動画: [デモ動画を開く（Discord）](${object(receipt.discord).url})\n${verified.filename} / ${verified.bytes} bytes / SHA-256: ${verified.sha256} / 再取得照合済み`;
	}
	if ((await currentHead()) !== head) throw Error("head 変更");
	const body = `${comment}${media}${attention === "none" ? "\n\nこの通知は A-番号がないため、承認は GitHub の OK/Approve 等で回答してください。" : ""}\n\n<!-- harness:gate phase=awaiting-merge issue=${issue} sha=${head} attention=${attention} -->`;
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
main().catch(async () => {
	if (commentId && pending) {
		// 一方の復旧が失敗しても、もう一方を試す。次の成功再依頼まで拒否状態を残す。
		try {
			await resetLabels();
		} catch {}
		try {
			const result = await patch(pending);
			validateComment(result, pending, commentId);
		} catch {}
		try {
			const result = object(JSON.parse(await gh("api", `repos/${repo}/issues/comments/${commentId}`)));
			validateComment(result, pending, commentId);
			await resetLabels();
		} catch {}
		await rememberRecovery();
	}
	console.error(
		`harness-phase: ${stage} 失敗（exit ${code}）。${attention === "不明" ? "A は取下げ未確認" : `この ${attention} の承認依頼は未完了です`}。OK を返してもマージできません。原因解消後に再依頼してください。`,
	);
	process.exitCode = process.exitCode || code;
});
