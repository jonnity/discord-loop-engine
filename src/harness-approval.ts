// inbox と merge が同じ投稿者・marker・時刻境界を使うための読取り。
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AttentionRecord,
	isAttentionAnswerOk,
	readAttentionSequence,
	validateAttentionSnapshot,
	validTime,
} from "./attention-read.ts";
import { resolveHarnessProject } from "./harness-project.ts";
import type { Attention } from "./ledger.ts";
import { dleHome } from "./protocol.ts";

export { validTime } from "./attention-read.ts";

import { object } from "./notification-receipt.ts";

const GITHUB_APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface CompletedGate {
	commentId: number;
	authorLogin: string;
	issue: string;
	head: string;
	attention: string | null;
	commentUrl: string;
	requestedAt: string;
	completedAt: string;
}
interface Verdict {
	kind: "merge-ok" | "merge-ng";
	at: string;
	url: string;
	body: string;
}
interface ApprovalInput {
	issue: string;
	head: string;
	login: string;
	owners: string[];
	comments: unknown[];
	reviews: unknown[];
	labels: string[];
	labelEvents?: unknown[];
	prUrl: string;
}
export function evaluateApproval(p: ApprovalInput) {
	const candidates = p.comments
		.map(object)
		.filter(
			(c) =>
				object(c.user).login === p.login &&
				typeof c.body === "string" &&
				new RegExp(`<!-- harness:(?:gate|pending) phase=awaiting-merge issue=${p.issue}(?: | -->)`).test(c.body),
		)
		.sort((a, b) => Number(a.id) - Number(b.id));
	const latest = candidates.at(-1);
	const body = String(latest?.body ?? "");
	const url = String(latest?.html_url ?? p.prUrl);
	const markers = body.split(/\r?\n/).filter((line) => line.includes("<!-- harness:"));
	const match =
		markers.length === 1
			? /^<!-- harness:gate phase=awaiting-merge issue=([1-9][0-9]*) sha=([a-f0-9]{40}) attention=(A-[1-9][0-9]*|none) -->$/.exec(
					markers[0] ?? "",
				)
			: null;
	let status = "missing-notify";
	let gate: CompletedGate | undefined;
	if (
		latest &&
		Number.isSafeInteger(latest.id) &&
		typeof latest.html_url === "string" &&
		validTime(latest.created_at) &&
		validTime(latest.updated_at) &&
		Date.parse(latest.created_at) <= Date.parse(latest.updated_at) &&
		match &&
		match[1] === p.issue &&
		p.labels.includes("harness:awaiting-merge")
	) {
		if (match[2] !== p.head) status = "stale-notify";
		else {
			status = "ready";
			gate = {
				commentId: Number(latest.id),
				authorLogin: p.login,
				issue: p.issue,
				head: p.head,
				attention: match[3] === "none" ? null : (match[3] ?? null),
				commentUrl: url,
				requestedAt: latest.created_at,
				completedAt: latest.updated_at,
			};
		}
	}
	const events: Verdict[] = [];
	function add(kind: Verdict["kind"], at: unknown, eventUrl: unknown, eventBody: unknown, commit?: unknown) {
		if (!validTime(at)) throw Error("回答時刻が不正です");
		if (!latest || !validTime(latest.created_at)) return;
		const time = Date.parse(at);
		if (
			kind === "merge-ng"
				? time >= Date.parse(latest.created_at)
				: gate && time > Date.parse(gate.completedAt) && (commit === undefined || commit === p.head)
		)
			events.push({ kind, at, url: String(eventUrl ?? p.prUrl), body: String(eventBody ?? "") });
	}
	for (const raw of p.comments) {
		const c = object(raw);
		if (!p.owners.includes(String(object(c.user).login))) continue;
		const b = String(c.body ?? "");
		if (b.includes("<!-- harness:")) continue;
		if (/^\s*(OK|ok|ＯＫ|LGTM|マージして)/.test(b)) add("merge-ok", c.created_at, c.html_url, b);
		else if (/^\s*(NG|ng|ＮＧ)/.test(b)) add("merge-ng", c.created_at, c.html_url, b);
	}
	for (const raw of p.reviews) {
		const r = object(raw);
		if (!p.owners.includes(String(object(r.user).login))) continue;
		if (r.state === "APPROVED") add("merge-ok", r.submitted_at, r.html_url, r.body, r.commit_id ?? null);
		if (r.state === "CHANGES_REQUESTED") add("merge-ng", r.submitted_at, r.html_url, r.body);
	}
	events.sort(
		(a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === "merge-ng" ? 1 : 0) - (b.kind === "merge-ng" ? 1 : 0),
	);
	// ラベル承認の既存優先順位を維持し、完成依頼にだけ適用する。
	let verdict = events.at(-1);
	if (gate && p.labels.includes("harness:merge-ok")) {
		const labels = (p.labelEvents ?? [])
			.map(object)
			.filter((e) => e.event === "labeled" && object(e.label).name === "harness:merge-ok");
		if (!labels.length || labels.some((e) => !validTime(e.created_at))) throw Error("ラベル承認の時刻が不正です");
		const at = [
			...events.filter((e) => e.kind === "merge-ok").map((e) => e.at),
			...labels.map((e) => String(e.created_at)),
		]
			.sort((a, b) => Date.parse(a) - Date.parse(b))
			.at(-1);
		if (!at) throw Error("ラベル承認の時刻がありません");
		verdict = { kind: "merge-ok", at, url: p.prUrl, body: "" };
	}
	const pending =
		markers.length === 1 &&
		new RegExp(`^<!-- harness:pending phase=awaiting-merge issue=${p.issue} sha=[a-f0-9]{40} -->$`).test(
			markers[0] ?? "",
		) &&
		latest &&
		Number.isSafeInteger(latest.id) &&
		typeof latest.html_url === "string" &&
		validTime(latest.created_at) &&
		validTime(latest.updated_at) &&
		Date.parse(latest.created_at) <= Date.parse(latest.updated_at);
	return {
		status,
		gate,
		url,
		verdict,
		...(!p.labels.includes("harness:awaiting-merge") ? { requestInactive: true } : {}),
		...(pending ? { requestState: "pending" as const } : {}),
	};
}
export function run(command: string, args: string[], timeout = 30000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stdout = "",
			stderr = "",
			stopped = false;
		let killed: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			child.kill("SIGTERM");
			killed = setTimeout(() => child.kill("SIGKILL"), 1000);
		};
		const handlers = new Map<NodeJS.Signals, () => void>();
		for (const [signal, exitCode] of [
			["SIGHUP", 129],
			["SIGINT", 130],
			["SIGTERM", 143],
		] as const) {
			const handler = () => {
				process.exitCode = exitCode;
				stop();
			};
			handlers.set(signal, handler);
			process.once(signal, handler);
		}
		const timer = setTimeout(stop, timeout);
		const cleanup = () => {
			clearTimeout(timer);
			clearTimeout(killed);
			for (const [signal, handler] of handlers) process.off(signal, handler);
		};
		child.stdout.on("data", (data) => {
			stdout += data;
			if (stdout.length > 16 * 1024 * 1024) stop();
		});
		child.stderr.on("data", (data) => {
			stderr = (stderr + data).slice(-16000);
		});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code) => {
			cleanup();
			if (code === 0 && !stopped && !process.exitCode) resolve(stdout.trim());
			else
				reject(
					Object.assign(new Error(`${command} failed (${code})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`), { code }),
				);
		});
	});
}
export const gh = (...args: string[]) => run("gh", args);
async function loadApproval(issue: string, pr: string, tolerateOwners = false) {
	const repo = await gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
	const login = await gh("api", "user", "--jq", ".login");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !login) throw Error("repo/login が不正です");
	const labelsRaw: unknown = JSON.parse(await gh("issue", "view", issue, "--json", "labels"));
	const labels = object(labelsRaw).labels;
	if (!Array.isArray(labels) || labels.some((l) => typeof object(l).name !== "string"))
		throw Error("labels が不正です");
	const prData = object(JSON.parse(await gh("pr", "view", pr, "--json", "headRefOid,url")));
	if (
		typeof prData.headRefOid !== "string" ||
		!/^[a-f0-9]{40}$/.test(prData.headRefOid) ||
		typeof prData.url !== "string"
	)
		throw Error("PR が不正です");
	const pages = async (endpoint: string) => {
		const raw: unknown = JSON.parse(await gh("api", "--paginate", "--slurp", endpoint));
		if (!Array.isArray(raw) || raw.some((p) => !Array.isArray(p))) throw Error("ページ応答が不正です");
		return raw.flat();
	};
	const comments = await pages(`repos/${repo}/issues/${pr}/comments`),
		reviews = await pages(`repos/${repo}/pulls/${pr}/reviews`);
	const cfg = path.resolve(import.meta.dirname, "../bin/harness-config");
	let owners: string[] = [];
	let ownersUnavailable = false;
	try {
		const value: unknown = JSON.parse(
			await run(cfg, ['{owners: (if has("owners") then .owners else [] end)}', '{"owners":[]}']),
		);
		const configured = object(value).owners;
		if (!Array.isArray(configured) || configured.some((o) => typeof o !== "string")) throw Error("owners が不正です");
		owners = configured;
	} catch {
		if (!tolerateOwners) throw Error("owners が不正です");
		ownersUnavailable = true;
	}
	const result = evaluateApproval({
		issue,
		head: prData.headRefOid,
		login,
		owners: owners.length ? owners : ownersUnavailable ? [] : [repo.split("/")[0] ?? ""],
		comments,
		reviews,
		labels: labels.map((l) => String(object(l).name)),
		labelEvents: labels.some((l) => object(l).name === "harness:merge-ok")
			? await pages(`repos/${repo}/issues/${issue}/events`)
			: [],
		prUrl: prData.url,
	});
	return { result, owners, ownersUnavailable };
}
export async function approvalSnapshot(issue: string, pr: string) {
	return (await loadApproval(issue, pr)).result;
}
export type AttentionCheck =
	| { state: "not-applicable" }
	| { state: "missing"; attention: string }
	| { state: "unavailable"; reason: "attention-unavailable" | "attention-seq-behind" }
	| { state: "mismatch"; reason: "attention-scope-mismatch" | "attention-superseded" }
	| { state: "open"; attention: string }
	| { state: "not-approved"; attention: string; reason: AnswerRejectionReason; resolvedAt?: string }
	| { state: "approved"; attention: string; body: string; resolvedAt: string };
export type AnswerRejectionReason =
	| "answer-missing"
	| "resolved-at-missing"
	| "invalid-time"
	| "answer-before-created"
	| "answer-not-ok";
export type ChatRejectionReason =
	| AnswerRejectionReason
	| "attention-missing"
	| "invalid-arguments"
	| "pr-unavailable"
	| "approval-unavailable"
	| "recovery-unconfirmed"
	| "request-failed"
	| "github-ng"
	| "request-pending"
	| "request-missing"
	| "request-stale"
	| "request-inactive"
	| "attention-none"
	| "attention-stale"
	| "attention-unavailable"
	| "attention-seq-behind"
	| "attention-not-found"
	| "attention-open"
	| "attention-scope-mismatch"
	| "attention-superseded"
	| "approval-changed"
	| "ci-not-green"
	| "mergeable-unconfirmed"
	| "before-merge-failed";
function structuralAttention(
	item: AttentionRecord,
): item is AttentionRecord & Pick<Attention, "taskId" | "title" | "url" | "summary" | "status"> {
	return (
		["taskId", "title", "url", "summary"].every((key) => typeof item[key] === "string") &&
		(item.status === "open" || item.status === "resolved") &&
		(item.messageId === undefined || typeof item.messageId === "string") &&
		(item.status === "resolved" || validTime(item.createdAt))
	);
}
export function evaluateAttention(p: {
	gate?: CompletedGate;
	project: string;
	issue: string;
	pr: string;
	owners: readonly string[];
	snapshot: unknown;
	sequence: number;
}): AttentionCheck {
	const id = p.gate?.attention;
	if (!id) return { state: "not-applicable" };
	const unavailable: AttentionCheck = { state: "unavailable", reason: "attention-unavailable" };
	try {
		const snapshot = validateAttentionSnapshot(p.snapshot);
		if (!Number.isSafeInteger(p.sequence) || p.sequence < 0) return unavailable;
		if (BigInt(id.slice(2)) > BigInt(p.sequence)) return { state: "unavailable", reason: "attention-seq-behind" };
		const target = snapshot.items.find((item) => item.id === id);
		if (!target) return { state: "missing", attention: id };
		const sameScope = (item: AttentionRecord) =>
			item.kind === "merge" &&
			item.project === p.project &&
			item.issue === p.issue &&
			item.pr === p.pr &&
			/^[1-9][0-9]*$/.test(p.issue) &&
			/^[1-9][0-9]*$/.test(p.pr);
		if (!sameScope(target)) return { state: "mismatch", reason: "attention-scope-mismatch" };
		if (!structuralAttention(target)) return unavailable;
		const newer = snapshot.items.filter((item) => BigInt(item.id.slice(2)) > BigInt(id.slice(2)) && sameScope(item));
		if (
			newer.some(
				(item) =>
					!structuralAttention(item) ||
					!validTime(item.createdAt) ||
					(item.status === "resolved" &&
						(typeof item.answer !== "string" ||
							!validTime(item.resolvedAt) ||
							Date.parse(item.resolvedAt) < Date.parse(item.createdAt))),
			)
		)
			return unavailable;
		if (newer.length) return { state: "mismatch", reason: "attention-superseded" };
		if (target.status === "open") return { state: "open", attention: id };
		const denied = (reason: AnswerRejectionReason): Extract<AttentionCheck, { state: "not-approved" }> => ({
			state: "not-approved",
			attention: id,
			reason,
		});
		if (typeof target.answer !== "string") return denied("answer-missing");
		if (target.resolvedAt === undefined || target.resolvedAt === null || target.resolvedAt === "")
			return denied("resolved-at-missing");
		if (!validTime(target.createdAt) || !validTime(target.resolvedAt)) return denied("invalid-time");
		if (Date.parse(target.resolvedAt) < Date.parse(target.createdAt)) return denied("answer-before-created");
		if (!isAttentionAnswerOk(target.answer, p.owners))
			return { ...denied("answer-not-ok"), resolvedAt: target.resolvedAt };
		return { state: "approved", attention: id, body: target.answer, resolvedAt: target.resolvedAt };
	} catch {
		return unavailable;
	}
}
export async function approvalSnapshotWithAttention(issue: string, pr: string) {
	const { result, owners, ownersUnavailable } = await loadApproval(issue, pr, true);
	let attentionCheck: AttentionCheck = { state: "not-applicable" };
	if (ownersUnavailable) attentionCheck = { state: "unavailable", reason: "attention-unavailable" };
	else if (result.gate?.attention) {
		try {
			const project = await resolveHarnessProject();
			const snapshot: unknown = JSON.parse(
				await run(path.resolve(import.meta.dirname, "../bin/dle"), ["attention", "--all", "--json"]),
			);
			const sequence = await readAttentionSequence(dleHome());
			attentionCheck = evaluateAttention({ gate: result.gate, project, issue, pr, owners, snapshot, sequence });
		} catch {
			attentionCheck = { state: "unavailable", reason: "attention-unavailable" };
		}
	}
	// GitHub と engine の保存時刻を同じ絶対時刻として比較する。台帳照合不能時は既存の GitHub 経路を保つ。
	// 解釈: engine の時計の遅れを5分まで見込み、境界と同時刻も非 OK を優先する。
	const githubApprovalBlocked =
		result.verdict?.kind === "merge-ok" &&
		attentionCheck.state === "not-approved" &&
		attentionCheck.reason === "answer-not-ok" &&
		attentionCheck.resolvedAt !== undefined &&
		Date.parse(attentionCheck.resolvedAt) >= Date.parse(result.verdict.at) - GITHUB_APPROVAL_CLOCK_SKEW_MS;
	return {
		...result,
		attentionCheck,
		...(ownersUnavailable ? { ownersUnavailable: true } : {}),
		...(githubApprovalBlocked ? { githubApprovalBlocked: true } : {}),
	};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	(process.argv.includes("--with-attention") ? approvalSnapshotWithAttention : approvalSnapshot)(
		process.argv[2] ?? "",
		process.argv[3] ?? "",
	)
		.then((r) => console.log(JSON.stringify(r)))
		.catch(() => {
			console.error("承認依頼の読取りに失敗しました");
			process.exitCode = 1;
		});
