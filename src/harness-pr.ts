// PR 本文は扱わず、GitHub の事実と台帳の証拠だけで承認を判断する。
import { writeSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AttentionRecord, readAttentionSequence, readAttentionSnapshot, validTime } from "./attention-read.ts";
import { evaluateAttention, gh, run } from "./harness-approval.ts";
import { resolveHarnessProject } from "./harness-project.ts";
import { object } from "./notification-receipt.ts";
import { dleHome } from "./protocol.ts";

export class PrError extends Error {}
export function emit(value: unknown, error = false) {
	const bytes = Buffer.from(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeSync(error ? 2 : 1, bytes, offset, Math.min(4096, bytes.length - offset));
		} catch (failure) {
			if (object(failure).code !== "EAGAIN") throw failure;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
		}
	}
}
export const bin = path.resolve(import.meta.dirname, "../bin");
export const shaPattern = /^[a-f0-9]{40}$/;
export function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function prNumber(value: string): number {
	const n = Number(value);
	if (!/^[1-9][0-9]*$/.test(value) || !positive(n)) throw new PrError("PR は安全な正の整数が必要です");
	return n;
}
export interface PrTarget {
	repo: string;
	project: string;
	pr: number;
	title: string;
	url: string;
	head: string;
	headRef: string;
	baseRef: string;
	createdAt: string;
	labels: string[];
	state: "open" | "closed";
	merged: boolean;
	mergeable: boolean | null;
	mergeableState: string;
	autoMerge: unknown;
}
export function parsePrTarget(raw: unknown, repo: string, project: string, allowClosed = false): PrTarget {
	const p = object(raw),
		head = object(p.head),
		base = object(p.base);
	if (
		!positive(p.number) ||
		typeof p.title !== "string" ||
		p.html_url !== `https://github.com/${repo}/pull/${p.number}` ||
		object(p.user).login !== "dependabot[bot]" ||
		typeof head.ref !== "string" ||
		!head.ref.startsWith("dependabot/") ||
		head.ref.length <= 11 ||
		typeof head.sha !== "string" ||
		!shaPattern.test(head.sha) ||
		object(head.repo).full_name !== repo ||
		object(base.repo).full_name !== repo ||
		typeof base.ref !== "string" ||
		!base.ref ||
		base.ref === head.ref ||
		p.draft !== false ||
		!validTime(p.created_at) ||
		(p.state !== "open" && !(allowClosed && p.state === "closed")) ||
		!Array.isArray(p.labels) ||
		p.labels.some((l) => typeof object(l).name !== "string")
	)
		throw new PrError("対象外または不正な PR です");
	if (
		(p.mergeable !== null && typeof p.mergeable !== "boolean") ||
		typeof p.mergeable_state !== "string" ||
		typeof p.merged !== "boolean" ||
		(p.merged && !validTime(p.merged_at))
	)
		throw new PrError("PR 状態が不正です");
	return {
		repo,
		project,
		pr: p.number,
		title: p.title,
		url: String(p.html_url),
		head: head.sha,
		headRef: head.ref,
		baseRef: base.ref,
		createdAt: p.created_at,
		labels: p.labels.map((l) => String(object(l).name)),
		state: p.state === "closed" ? "closed" : "open",
		merged: p.merged,
		mergeable: p.mergeable,
		mergeableState: p.mergeable_state,
		autoMerge: p.auto_merge,
	};
}
export function ciGreen(raw: unknown): boolean {
	if (!Array.isArray(raw) || raw.length === 0) return false;
	let success = false;
	for (const value of raw) {
		const c = object(value);
		const result =
			c.__typename === "CheckRun" && c.status === "COMPLETED"
				? c.conclusion
				: c.__typename === "StatusContext"
					? c.state
					: undefined;
		if (result !== "SUCCESS" && result !== "NEUTRAL" && result !== "SKIPPED") return false;
		if (result === "SUCCESS") success = true;
	}
	return success;
}
export function fixedHead(body: unknown): string | undefined {
	if (typeof body !== "string") return;
	const lines = body.split(/\r?\n/);
	const match = /^承認対象 head: ([a-f0-9]{40})$/.exec(lines[0] ?? "");
	if (match && lines.filter((l) => l.startsWith("承認対象 head:")).length === 1) return match[1];
}
export interface PrCompletedGate {
	pr: number;
	head: string;
	attention: string;
	commentId: number;
	authorLogin: string;
	commentUrl: string;
	requestedAt: string;
	completedAt: string;
}
export function validateComment(raw: unknown, repo: string, pr: number, login: string, body?: string, id?: number) {
	const c = object(raw);
	if (
		!positive(c.id) ||
		(id !== undefined && c.id !== id) ||
		(body !== undefined && c.body !== body) ||
		typeof c.body !== "string" ||
		object(c.user).login !== login ||
		(c.html_url !== `https://github.com/${repo}/issues/${pr}#issuecomment-${c.id}` &&
			c.html_url !== `https://github.com/${repo}/pull/${pr}#issuecomment-${c.id}`) ||
		!validTime(c.created_at) ||
		!validTime(c.updated_at) ||
		Date.parse(c.created_at) > Date.parse(c.updated_at)
	)
		throw new PrError("依頼コメントが不正です");
	return { id: c.id, body: c.body, url: String(c.html_url), createdAt: c.created_at, updatedAt: c.updated_at };
}
export function evaluatePrApproval(p: {
	target: PrTarget;
	login: string;
	owners: readonly string[];
	comments: unknown[];
	reviews: unknown[];
}) {
	const t = p.target;
	// 不正な対象 marker も候補に残し、過去の完成依頼へ戻らない。
	const pattern = new RegExp(`<!-- harness:(?:gate|pending) phase=awaiting-merge pr=${t.pr}(?: | -->)`);
	const candidates = p.comments.map(object).filter((c) => typeof c.body === "string" && pattern.test(c.body));
	const own = candidates.filter((c) => object(c.user).login === p.login);
	if (own.some((c) => !positive(c.id))) throw new PrError("依頼 ID が不正です");

	const latest = own.sort((a, b) => Number(a.id) - Number(b.id)).at(-1);
	let status: "ready" | "missing-notify" | "stale-notify" | "incomplete" =
		latest || candidates.length ? "incomplete" : "missing-notify";
	let gate: PrCompletedGate | undefined;
	let requestedAt: string | undefined;
	if (latest) {
		const c = validateComment(latest, t.repo, t.pr, p.login);
		requestedAt = c.createdAt;
		const markers = c.body.split(/\r?\n/).filter((line) => line.includes("<!-- harness:"));
		const match =
			markers.length === 1
				? /^<!-- harness:gate phase=awaiting-merge pr=([1-9][0-9]*) sha=([a-f0-9]{40}) attention=(A-[1-9][0-9]*) -->$/.exec(
						markers[0] ?? "",
					)
				: null;
		if (
			match &&
			Number(match[1]) === t.pr &&
			fixedHead(c.body) === match[2] &&
			t.labels.includes("harness:awaiting-merge")
		) {
			gate = {
				pr: t.pr,
				head: match[2] ?? "",
				attention: match[3] ?? "",
				commentId: c.id,
				authorLogin: p.login,
				commentUrl: c.url,
				requestedAt: c.createdAt,
				completedAt: c.updatedAt,
			};
			status = gate.head === t.head ? "ready" : "stale-notify";
		}
	}
	let ownerNg = false;
	const ngOwners = p.owners.length ? p.owners : [t.repo.split("/")[0] ?? ""];
	for (const raw of [...p.comments, ...p.reviews]) {
		const e = object(raw);
		if (!ngOwners.includes(String(object(e.user).login))) continue;
		const ng =
			e.state === "CHANGES_REQUESTED" ||
			(typeof e.body === "string" && !e.body.includes("<!-- harness:") && /^\s*(NG|ng|ＮＧ)/.test(e.body));
		if (!ng) continue;
		const time = e.submitted_at ?? e.created_at;
		if (!validTime(time)) throw new PrError("NG 時刻が不正です");
		if (requestedAt && Date.parse(time) >= Date.parse(requestedAt)) ownerNg = true;
	}
	return { status, gate, ownerNg, url: gate?.commentUrl ?? t.url };
}
export interface PrContext {
	root: string;
	configPath: string;
	repo: string;
	project: string;
	login: string;
	owners: string[];
	method: "merge" | "squash" | "rebase";
	hooks: string[];
	home: string;
}
export async function context(): Promise<PrContext> {
	const config = path.join(bin, "harness-config");
	const root = await run(config, ["--root"]);
	const configPath = path.resolve(await run(config, ["--path"]));
	const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new PrError("設定が不正です");
	const c = object(raw),
		method = c.mergeMethod ?? "merge",
		owners = Object.hasOwn(c, "owners") ? c.owners : [];
	if (
		!["merge", "squash", "rebase"].includes(String(method)) ||
		typeof method !== "string" ||
		!Array.isArray(owners) ||
		owners.some((v) => typeof v !== "string")
	)
		throw new PrError("method/owners が不正です");
	if (c.hooks !== undefined && (typeof c.hooks !== "object" || c.hooks === null || Array.isArray(c.hooks)))
		throw new PrError("hooks が不正です");
	const hooks = object(c.hooks).beforeMerge ?? [];
	if (!Array.isArray(hooks)) throw new PrError("beforeMerge が不正です");
	const repo = await gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
	const origin = await run("git", ["-C", root, "remote", "get-url", "origin"]);
	const originRepo = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
		origin,
	)?.[1];
	if (
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
		originRepo !== repo ||
		(c.repo !== undefined && c.repo !== repo)
	)
		throw new PrError("main と対象 repo が一致しません");
	const login = await gh("api", "user", "--jq", ".login");
	if (!/^[A-Za-z0-9[\]_.-]+$/.test(login)) throw new PrError("login が不正です");
	return {
		root,
		configPath,
		repo,
		project: await resolveHarnessProject(),
		login,
		owners,
		method: method as PrContext["method"],
		hooks: hooks.filter((v): v is string => typeof v === "string" && v !== ""),
		home: dleHome(),
	};
}
export async function pages(endpoint: string): Promise<unknown[]> {
	const raw: unknown = JSON.parse(await gh("api", "--paginate", "--slurp", endpoint));
	if (!Array.isArray(raw) || raw.some((p) => !Array.isArray(p))) throw new PrError("全ページを取得できません");
	return raw.flat();
}
export async function readPr(c: PrContext, pr: number) {
	const t = parsePrTarget(JSON.parse(await gh("api", `repos/${c.repo}/pulls/${pr}`)), c.repo, c.project, true);
	if (t.pr !== pr) throw new PrError("PR が一致しません");
	return t;
}
export async function listPrs(c: PrContext) {
	const all = await pages(`repos/${c.repo}/pulls?state=open&per_page=100`);
	const result: PrTarget[] = [];
	for (const raw of all) {
		const p = object(raw);
		if (!positive(p.number) || typeof object(p.user).login !== "string" || typeof object(p.head).ref !== "string")
			throw new PrError("PR 一覧が不正です");
		if (object(p.user).login !== "dependabot[bot]" || !String(object(p.head).ref).startsWith("dependabot/")) continue;
		if (p.draft === true) continue;
		// 一覧には mergeable/merged が無いので、対象の詳細を別途読む。
		result.push(await readPr(c, p.number));
	}
	return result.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.pr - b.pr);
}
export async function facts(c: PrContext, pr: number) {
	const target = await readPr(c, pr);
	const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision mergeStateStatus mergeQueueEntry{id} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$endCursor){nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}} pageInfo{hasNextPage endCursor}}}}}}}}}`;
	const [owner = "", name = ""] = c.repo.split("/");
	const raw: unknown = JSON.parse(
		await gh(
			"api",
			"graphql",
			"--paginate",
			"--slurp",
			"-f",
			`query=${query}`,
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
			"-F",
			`number=${pr}`,
		),
	);
	if (!Array.isArray(raw) || !raw.length) throw new PrError("CI ページがありません");
	const checks: unknown[] = [];
	let review = "",
		protection = "",
		queued = false;
	for (const [i, page] of raw.entries()) {
		const p = object(object(object(object(page).data).repository).pullRequest);
		const nodes = object(p.commits).nodes;
		if (object(page).errors || !Array.isArray(nodes) || nodes.length !== 1) throw new PrError("CI 応答が不正です");
		const commit = object(object(nodes[0]).commit);
		const contexts = object(object(commit.statusCheckRollup).contexts);
		if (
			commit.oid !== target.head ||
			!Array.isArray(contexts.nodes) ||
			object(contexts.pageInfo).hasNextPage !== i < raw.length - 1 ||
			typeof p.mergeStateStatus !== "string" ||
			(p.reviewDecision !== null && typeof p.reviewDecision !== "string")
		)
			throw new PrError("CI 全件/head が未確認です");
		checks.push(...contexts.nodes);
		const nextReview = p.reviewDecision === null ? "" : String(p.reviewDecision);
		if (i && (review !== nextReview || protection !== p.mergeStateStatus))
			throw new PrError("CI 取得中に保護状態が変わりました");
		if (
			p.mergeQueueEntry !== null &&
			(typeof object(p.mergeQueueEntry).id !== "string" || !object(p.mergeQueueEntry).id)
		)
			throw new PrError("キュー状態が未確認です");
		queued = p.mergeQueueEntry !== null;
		review = nextReview;
		protection = p.mergeStateStatus;
	}
	const after = await readPr(c, pr);
	if (after.head !== target.head) throw new PrError("CI 取得中に head が変わりました");
	const comments = await pages(`repos/${c.repo}/issues/${pr}/comments?per_page=100`);
	const reviews = await pages(`repos/${c.repo}/pulls/${pr}/reviews?per_page=100`);
	const approval = evaluatePrApproval({ target: after, login: c.login, owners: c.owners, comments, reviews });
	const snapshot = await readAttentionSnapshot(c.home);
	const sequence = await readAttentionSequence(c.home);
	const scope = {
		project: c.project,
		issue: "",
		pr: String(pr),
		scope: "pr" as const,
		owners: c.owners,
		snapshot,
		sequence,
	};
	let check = evaluateAttention({ ...scope, gate: approval.gate });
	if (approval.gate) {
		const a = snapshot.items.find((a) => a.id === approval.gate?.attention);
		if (fixedHead(a?.summary) !== approval.gate.head) check = { state: "unavailable", reason: "attention-unavailable" };
	}
	const scoped = snapshot.items
		.filter((a) => a.project === c.project && a.pr === String(pr) && a.kind === "merge")
		.sort((a, b) => (BigInt(a.id.slice(2)) < BigInt(b.id.slice(2)) ? -1 : 1));
	const latest: AttentionRecord | undefined = scoped.at(-1);
	const latestCheck = evaluateAttention({ ...scope, gate: latest ? { attention: latest.id } : undefined });
	if (latest && ["unavailable", "mismatch", "missing"].includes(latestCheck.state))
		throw new PrError("最新 A が不正です");
	const needsRebase =
		after.mergeable === false ||
		["dirty", "behind"].includes(after.mergeableState) ||
		["DIRTY", "BEHIND"].includes(protection);
	const unknown =
		after.mergeable === null ||
		!["clean", "dirty", "behind", "blocked", "has_hooks"].includes(after.mergeableState) ||
		!["CLEAN", "HAS_HOOKS", "BEHIND", "DIRTY", "BLOCKED"].includes(protection) ||
		!["", "APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(review);
	const reviewOnly = protection === "BLOCKED" && review === "REVIEW_REQUIRED" && !needsRebase;
	const blocked = (protection === "BLOCKED" && !reviewOnly) || (after.mergeableState === "blocked" && !reviewOnly);
	return {
		target: after,
		comments,
		reviews,
		approval,
		check,
		latest,
		latestCheck,
		green: ciGreen(checks),
		queued,
		needsRebase,
		unknown,
		blocked,
		review,
		protection,
	};
}
export type PrFacts = Awaited<ReturnType<typeof facts>>;
export async function exists(file: string) {
	try {
		await lstat(file);
		return true;
	} catch (error) {
		if (object(error).code === "ENOENT") return false;
		throw error;
	}
}

async function main(args: string[]) {
	const [command, ...rest] = args;
	let pr: number | undefined,
		retry = false,
		chat: string | undefined,
		attention: string | undefined;
	try {
		if (!["scan", "inbox", "request", "merge"].includes(command ?? "")) throw new PrError("不明なコマンドです");
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i];
			if (arg === "--pr" && pr === undefined) pr = prNumber(rest[++i] ?? "");
			else if (arg === "--retry" && !retry && command === "request") retry = true;
			else if (arg === "--chat-approval" && chat === undefined && command === "merge") {
				chat = rest[++i];
				if (!chat) throw new PrError("回答がありません");
			} else if (arg === "--attention" && attention === undefined && command === "merge") {
				attention = rest[++i];
				if (!attention || !/^A-[1-9][0-9]*$/.test(attention)) throw new PrError("A が不正です");
			} else throw new PrError("引数が不正です");
		}
		if (
			(command === "request" || command === "merge") !== (pr !== undefined) ||
			(chat === undefined) !== (attention === undefined)
		)
			throw new PrError("引数が不足しています");
	} catch {
		process.exitCode = 2;
		emit("harness-pr: 引数が不正です", true);
		return;
	}
	const c = await context();
	if (command === "merge" && pr !== undefined) {
		const { mergeDependabotPr } = await import("./harness-pr-merge.ts");
		await mergeDependabotPr(c, pr, chat, attention);
	} else {
		const { requestPr, inbox, scan } = await import("./harness-pr-request.ts");
		if (command === "request" && pr !== undefined) await requestPr(c, pr, retry);
		else if (command === "inbox") await inbox(c);
		else await scan(c);
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error) => {
		emit(
			`harness-pr: ${error instanceof PrError ? error.message : "検証または操作に失敗しました。復旧記録を確認してください"}`,
			true,
		);
		process.exitCode ||= 1;
	});
}
