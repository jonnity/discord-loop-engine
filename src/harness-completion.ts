// 承認依頼の完成（harness-request）と未完了の採用（harness-adopt）が共有する gh 操作と復旧ファイル。
// Why not: 状態（repo・comment id 等）をここで持たない。呼び出し側が値を渡す（両側で寿命が違うため）。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validTime } from "./harness-approval.ts";
import { object } from "./notification-receipt.ts";

export type Gh = (...args: string[]) => Promise<string>;

// 復旧未確認ファイルを cwd と解決 worktree の両方へ書く。merge はどちらかがあれば拒否する。
export async function rememberRecovery(states: Iterable<string>, issue: string, pr: string) {
	for (const state of states) {
		await mkdir(path.dirname(state), { recursive: true });
		await writeFile(state, JSON.stringify({ issue, pr, stage: "復旧未確認" }), { mode: 0o600 });
	}
}
export async function patchComment(gh: Gh, repo: string, commentId: number, temp: string, body: string) {
	const input = path.join(temp, "patch.json");
	await writeFile(input, JSON.stringify({ body }), { mode: 0o600 });
	return object(
		JSON.parse(await gh("api", `repos/${repo}/issues/comments/${commentId}`, "--method", "PATCH", "--input", input)),
	);
}
export async function issueLabels(gh: Gh, issue: string) {
	const data = object(JSON.parse(await gh("issue", "view", issue, "--json", "labels")));
	if (!Array.isArray(data.labels) || data.labels.some((l) => typeof object(l).name !== "string"))
		throw Error("labels 不正");
	return data.labels.map((l) => String(object(l).name));
}
// harness:* を awaiting-merge だけにし、結果を読み直して確かめる。
export async function resetLabels(gh: Gh, issue: string) {
	const current = await issueLabels(gh, issue);
	const args: string[] = [];
	for (const label of current)
		if (label.startsWith("harness:") && label !== "harness:awaiting-merge") args.push("--remove-label", label);
	if (!current.includes("harness:awaiting-merge")) args.push("--add-label", "harness:awaiting-merge");
	if (args.length) await gh("issue", "edit", issue, ...args);
	const result = await issueLabels(gh, issue);
	if (
		!result.includes("harness:awaiting-merge") ||
		result.some((l) => l.startsWith("harness:") && l !== "harness:awaiting-merge")
	)
		throw Error("labels 未確認");
}
export async function prHead(gh: Gh, pr: string) {
	const value = await gh("pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid");
	if (!/^[a-f0-9]{40}$/.test(value)) throw Error("head 不正");
	return value;
}
export function validateComment(
	c: Record<string, unknown>,
	body: string,
	who: { repo: string; login: string },
	id?: number,
) {
	if (
		!Number.isSafeInteger(c.id) ||
		Number(c.id) <= 0 ||
		(id !== undefined && c.id !== id) ||
		typeof c.html_url !== "string" ||
		!c.html_url.startsWith(`https://github.com/${who.repo}/`) ||
		c.body !== body ||
		object(c.user).login !== who.login ||
		!validTime(c.created_at) ||
		!validTime(c.updated_at) ||
		Date.parse(c.created_at) > Date.parse(c.updated_at)
	)
		throw Error("comment 応答不正");
}
