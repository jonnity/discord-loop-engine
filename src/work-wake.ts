import { ciGreen, fixedHead, readCiPage } from "./harness-pr.ts";
import type { Attention, Task } from "./ledger.ts";
import { object } from "./notification-receipt.ts";
import { classifyCiNodes, hasInvalidCiNodes } from "./phase-wait.ts";
import type { Run } from "./projects.ts";

export type ReadSource =
	| "projects"
	| "issues"
	| "prs"
	| "tasks"
	| "attention"
	| "outbox"
	| "answer-evidence"
	| "queued-state"
	| "ci";
type FailureCode = "unavailable" | "timeout" | "invalid" | "incomplete";
export type ReadFailure = { source: ReadSource; code: FailureCode };
type Reason = "issue" | "queued-new" | "pr-own" | "pr-dependabot" | "task" | "answer" | "fetch-failed";
type WakeIssue = { number: number; updatedAt: string; labels: string[] };
type PrCi = { kind: "empty" } | { kind: "running" } | { kind: "complete"; green: boolean };

export type WakePr = {
	number: number;
	ownership: "own" | "dependabot" | "other";
	draft: boolean;
	head: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	createdAt: string;
	updatedAt: string;
	ci?: PrCi;
};
export type WakeRemote = {
	issues: WakeIssue[] | null;
	prs: WakePr[] | null;
	failures: ReadFailure[];
	answerEvidence?: Map<string, string>;
};
export type WakeLocal = {
	tasks: Task[];
	attention: Attention[];
	outbox: Record<string, string>[];
	failures: ReadFailure[];
};

const issueFields = "number updatedAt labels(first:100){nodes{name} pageInfo{hasNextPage}}";
const prFields =
	"number createdAt updatedAt isDraft mergeable author{__typename login} headRefName headRefOid reviewDecision commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}";
const variables = "($owner:String!,$name:String!,$endCursor:String)";
const repository = "repository(owner:$owner,name:$name)";
const paging = "totalCount pageInfo{hasNextPage endCursor}";
const listing = "first:50,after:$endCursor,orderBy:{field:CREATED_AT,direction:ASC}";
const issuesQuery = `query${variables}{${repository}{nameWithOwner issues(states:OPEN,${listing}){${paging} nodes{${issueFields}}}}}`;
const prsQuery = `query${variables}{viewer{login} ${repository}{nameWithOwner pullRequests(states:OPEN,${listing}){${paging} nodes{${prFields}}}}}`;
const labelsQuery = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){${repository}{nameWithOwner issue(number:$number){number state updatedAt labels(first:100,after:$endCursor){${paging} nodes{name}}}}}`;
const ciQuery = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){${repository}{nameWithOwner pullRequest(number:$number){headRefOid updatedAt reviewDecision mergeStateStatus commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$endCursor){${paging} nodes{__typename ... on CheckRun{id status conclusion} ... on StatusContext{id state}}}}}}}}}}`;

const timeoutMs = 10_000;
const maxBuffer = 2 * 1024 * 1024;
const minute = 60_000;
const positive = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const login = (x: unknown): x is string => typeof x === "string" && /^[\w-]+(?:\[bot\])?$/.test(x);
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}$/.test(x);
const statusStates = ["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"];

class ReadProblem extends Error {
	readonly code: FailureCode;
	constructor(code: FailureCode) {
		super(code);
		this.code = code;
	}
}

function requireRead(condition: unknown, code: FailureCode = "invalid"): asserts condition {
	if (!condition) throw new ReadProblem(code);
}

function utc(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
	const ms = Date.parse(value);
	if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
	return ms;
}

function pages(value: unknown): unknown[] {
	requireRead(Array.isArray(value) && value.length > 0, "incomplete");
	return value;
}

function countedConnection(items: unknown[], size: number): unknown[] {
	let total: unknown;
	const cursors = new Set<string>();
	const nodes: unknown[] = [];
	for (const [index, raw] of items.entries()) {
		const connection = object(raw);
		const { hasNextPage, endCursor } = object(connection.pageInfo);
		const next = index < items.length - 1;
		if (index === 0) total = connection.totalCount;
		requireRead(typeof total === "number" && Number.isSafeInteger(total) && total >= 0);
		requireRead(total === connection.totalCount && hasNextPage === next, "incomplete");
		requireRead(endCursor === null || (typeof endCursor === "string" && endCursor.length > 0));
		requireRead(Array.isArray(connection.nodes) && connection.nodes.length <= size);
		requireRead(connection.nodes.length ? typeof endCursor === "string" : endCursor === null, "incomplete");
		if (typeof endCursor === "string") {
			requireRead(!cursors.has(endCursor), "incomplete");
			cursors.add(endCursor);
		}
		if (next) requireRead(connection.nodes.length === size, "incomplete");
		nodes.push(...connection.nodes);
	}
	requireRead(nodes.length === total, "incomplete");
	return nodes;
}

function names(nodes: unknown): string[] {
	requireRead(Array.isArray(nodes));
	const labels = nodes.map((node) => {
		const name = object(node).name;
		requireRead(typeof name === "string" && name.length > 0);
		return name;
	});
	requireRead(new Set(labels).size === labels.length, "incomplete");
	return labels;
}

function graphPage(page: unknown, repo: string) {
	requireRead(object(page).errors === undefined);
	const data = object(object(page).data);
	const result = object(data.repository);
	requireRead(typeof result.nameWithOwner === "string" && result.nameWithOwner.toLowerCase() === repo.toLowerCase());
	return { data, result };
}

function uniqueNumbers<T extends { number: number }>(items: T[]): T[] {
	requireRead(new Set(items.map((item) => item.number)).size === items.length, "incomplete");
	return items;
}

function decodePr(raw: unknown, viewer: string): WakePr {
	const p = object(raw);
	const author = object(p.author);
	const commits = object(p.commits).nodes;
	requireRead(
		positive(p.number) &&
			typeof p.isDraft === "boolean" &&
			sha(p.headRefOid) &&
			typeof p.headRefName === "string" &&
			p.headRefName.length > 0 &&
			login(author.login) &&
			typeof author.__typename === "string" &&
			["Bot", "User", "Organization", "Mannequin", "EnterpriseUserAccount"].includes(author.__typename) &&
			typeof p.createdAt === "string" &&
			Number.isFinite(utc(p.createdAt)) &&
			typeof p.updatedAt === "string" &&
			utc(p.createdAt) <= utc(p.updatedAt),
	);
	const { mergeable, reviewDecision } = p;
	requireRead(mergeable === "MERGEABLE" || mergeable === "CONFLICTING" || mergeable === "UNKNOWN");
	requireRead(
		reviewDecision === null ||
			reviewDecision === "APPROVED" ||
			reviewDecision === "CHANGES_REQUESTED" ||
			reviewDecision === "REVIEW_REQUIRED",
	);
	requireRead(Array.isArray(commits) && commits.length === 1);
	const commit = object(object(commits[0]).commit);
	requireRead(commit.oid === p.headRefOid, "incomplete");
	const rollupState = object(commit.statusCheckRollup).state;
	requireRead(
		commit.statusCheckRollup === null || (typeof rollupState === "string" && statusStates.includes(rollupState)),
	);
	const bot =
		author.__typename === "Bot" && author.login.toLowerCase() === "dependabot" && /^dependabot\/.+/.test(p.headRefName);
	let ownership: WakePr["ownership"] = "other";
	if (bot) ownership = "dependabot";
	else if (author.login.toLowerCase() === viewer) ownership = "own";
	return {
		number: p.number,
		ownership,
		draft: p.isDraft,
		head: p.headRefOid,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
		mergeable,
		reviewDecision,
	};
}

export async function readWork(
	repo: string,
	exec: Run,
	parent: AbortSignal,
	now: () => number,
	local?: { project: string; read: () => WakeLocal },
): Promise<WakeRemote> {
	const result: WakeRemote = { issues: null, prs: null, failures: [] };
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		result.failures.push({ source: "projects", code: "invalid" });
		return result;
	}
	const limit = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([parent, limit]);
	const [owner, name] = repo.split("/");
	let viewer: string | undefined;

	async function read(args: string[]): Promise<unknown[]> {
		requireRead(!signal.aborted, "timeout");
		const response = await exec("gh", args, { timeoutMs, maxBuffer, signal, waitForClose: true });
		requireRead(!signal.aborted, "timeout");
		requireRead(response.ok, response.failure ?? "unavailable");
		try {
			return pages(JSON.parse(response.stdout));
		} catch (error) {
			if (error instanceof ReadProblem) throw error;
			throw new ReadProblem("invalid");
		}
	}

	const graphql = (query: string, number?: number) =>
		read([
			"api",
			"graphql",
			"--paginate",
			"--slurp",
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
			"-f",
			`query=${query}`,
			...(number === undefined ? [] : ["-F", `number=${number}`]),
		]);
	const failed = (source: ReadSource, error: unknown) => {
		const code = error instanceof ReadProblem ? error.code : "unavailable";
		if (!result.failures.some((f) => f.source === source && f.code === code)) result.failures.push({ source, code });
	};

	await Promise.all([
		(async () => {
			try {
				const issuePages = (await graphql(issuesQuery)).map((page) => graphPage(page, repo).result.issues);
				const issues: WakeIssue[] = [];
				for (const raw of countedConnection(issuePages, 50)) {
					const issue = object(raw);
					const labels = object(issue.labels);
					const more = object(labels.pageInfo).hasNextPage;
					requireRead(
						positive(issue.number) &&
							typeof issue.updatedAt === "string" &&
							Number.isFinite(utc(issue.updatedAt)) &&
							typeof more === "boolean",
					);
					let list = names(labels.nodes);
					requireRead(list.length <= 100);
					if (more) {
						const connections = (await graphql(labelsQuery, issue.number)).map((page) => {
							const item = object(graphPage(page, repo).result.issue);
							requireRead(
								item.number === issue.number && item.state === "OPEN" && item.updatedAt === issue.updatedAt,
								"incomplete",
							);
							return item.labels;
						});
						const all = names(countedConnection(connections, 100));
						requireRead(
							list.length === 100 && all.length > 100 && list.every((label) => all.slice(0, 100).includes(label)),
							"incomplete",
						);
						list = all;
					}
					issues.push({ number: issue.number, updatedAt: issue.updatedAt, labels: list });
				}
				result.issues = uniqueNumbers(issues);
			} catch (error) {
				failed("issues", error);
			}
		})(),
		(async () => {
			try {
				const connections = (await graphql(prsQuery)).map((page) => {
					const { data, result: repository } = graphPage(page, repo);
					const actor = object(data.viewer).login;
					requireRead(login(actor));
					const canonical = actor.toLowerCase();
					requireRead(viewer === undefined || canonical === viewer, "incomplete");
					viewer = canonical;
					return repository.pullRequests;
				});
				const actor = viewer;
				requireRead(actor);
				result.prs = uniqueNumbers(countedConnection(connections, 50).map((p) => decodePr(p, actor)));
			} catch (error) {
				failed("prs", error);
			}
		})(),
	]);

	const snapshot = local?.read();
	for (const pr of result.prs ?? []) {
		if (pr.ownership === "other") continue;
		if (utc(pr.updatedAt) > now()) {
			failed("prs", new ReadProblem("invalid"));
			continue;
		}
		if (
			pr.ownership === "own" &&
			!snapshot?.attention.some(
				(a) =>
					openGate(a) &&
					(a.pr === String(pr.number) ||
						snapshot.tasks.some((task) => task.id === a.taskId && task.pr === String(pr.number))),
			)
		)
			continue;
		try {
			const response = await graphql(ciQuery, pr.number);
			const connections: unknown[] = [];
			for (const [index, page] of response.entries()) {
				const item = object(graphPage(page, repo).result.pullRequest);
				requireRead(
					item.headRefOid === pr.head && item.updatedAt === pr.updatedAt && item.reviewDecision === pr.reviewDecision,
					"incomplete",
				);
				const decoded = readCiPage(page, index, response.length, pr.head);
				requireRead("nodes" in decoded, "incomplete");
				const commits = object(item.commits).nodes;
				requireRead(Array.isArray(commits));
				const rollup = object(object(commits[0]).commit).statusCheckRollup;
				if (rollup !== null) connections.push(object(rollup).contexts);
			}
			const nodes = connections.length ? countedConnection(connections, 100) : [];
			const ids = nodes.map((node) => object(node).id);
			requireRead(ids.every((id) => typeof id === "string" && id.length > 0));
			requireRead(new Set(ids).size === ids.length, "incomplete");
			requireRead(!hasInvalidCiNodes(nodes));
			if (!nodes.length) pr.ci = { kind: "empty" };
			else if (classifyCiNodes(nodes) === "busy") pr.ci = { kind: "running" };
			else pr.ci = { kind: "complete", green: ciGreen(nodes) };
		} catch (error) {
			failed("ci", error);
		}
	}

	if (local && snapshot && result.issues && viewer) {
		const actor = viewer;
		const evidence = new Map<string, string>();
		result.answerEvidence = evidence;
		for (const a of latestAttentions(local.project, snapshot.attention)) {
			if (
				!actualAnswer(a) ||
				!issueAnswerTarget(a, result.issues) ||
				a !== latestForIssue(local.project, a.issue, snapshot.attention) ||
				matchesOutbox(a, snapshot.outbox)
			)
				continue;
			try {
				requireRead(Number.isFinite(utc(a.resolvedAt)) && utc(a.resolvedAt) >= utc(a.createdAt));
				const replies = await read([
					"api",
					"--method",
					"GET",
					"--paginate",
					"--slurp",
					`repos/${repo}/issues/${a.issue}/comments?per_page=100`,
				]);
				const ids = new Set<number>();
				let handled = false;
				for (const [index, replyPage] of replies.entries()) {
					requireRead(
						Array.isArray(replyPage) &&
							replyPage.length <= 100 &&
							(index === replies.length - 1 || replyPage.length === 100),
						"incomplete",
					);
					for (const raw of replyPage) {
						const c = object(raw);
						requireRead(
							positive(c.id) &&
								!ids.has(c.id) &&
								typeof c.body === "string" &&
								login(object(c.user).login) &&
								Number.isFinite(utc(c.created_at)),
						);
						ids.add(c.id);
						const author = object(c.user).login;
						if (
							login(author) &&
							author.toLowerCase() === actor &&
							utc(c.created_at) > utc(a.resolvedAt) &&
							/^\s*<!-- harness:(?:note\b|gate\s|(?:resume|unblock)\b)/m.test(c.body)
						)
							handled = true;
					}
				}
				if (handled && a.resolvedAt) evidence.set(a.id, a.resolvedAt);
			} catch (error) {
				failed("answer-evidence", error);
			}
		}
	} else if (
		local &&
		snapshot &&
		!viewer &&
		latestAttentions(local.project, snapshot.attention).some(
			(a) => actualAnswer(a) && issueAnswerTarget(a, result.issues ?? []) && !matchesOutbox(a, snapshot.outbox),
		)
	) {
		failed("answer-evidence", new ReadProblem("unavailable"));
	}
	return result;
}

function actualAnswer(a: Attention): boolean {
	return (
		a.status === "resolved" &&
		Boolean(a.answer?.trim()) &&
		!["（新しい依頼に置き換え）", "（完了）", "（作業再開）"].includes(a.answer ?? "")
	);
}

function openGate(a: Attention): boolean {
	return a.status === "open" && !a.answer;
}

function latestAttentions(project: string, attention: Attention[]): Attention[] {
	const latest = new Map<string, Attention>();
	for (const a of attention) {
		if (a.project !== project) continue;
		let scope = JSON.stringify([a.kind, a.issue, a.pr, a.taskId]);
		if (a.issue && (a.kind === "interview" || a.kind === "blocked")) scope = `issue:${a.issue}`;
		if (a.kind === "setup") scope = `setup:${a.taskId}`;
		if (a.kind === "merge" && a.pr && !a.issue) scope = `pr:${a.pr}`;
		const previous = latest.get(scope);
		if (!previous || BigInt(a.id.slice(2)) > BigInt(previous.id.slice(2))) latest.set(scope, a);
	}
	return [...latest.values()];
}

function latestForIssue(project: string, issue: string, attention: Attention[]): Attention | undefined {
	let latest: Attention | undefined;
	for (const a of attention) {
		if (a.project === project && a.issue === issue && (!latest || BigInt(a.id.slice(2)) > BigInt(latest.id.slice(2))))
			latest = a;
	}
	return latest;
}

function deliveredMerge(a: Attention, issue: WakeIssue | undefined, pr: WakePr | undefined): boolean {
	// 台帳から同じ head で残る回答だけを拾う。承認の成立・枠・復旧の判定は実行側に任せる。
	if (
		a.kind !== "merge" ||
		!pr ||
		fixedHead(a.summary) !== pr.head ||
		!a.answer ||
		!Number.isFinite(utc(a.resolvedAt)) ||
		utc(a.resolvedAt) < utc(a.createdAt)
	)
		return false;
	if (a.issue) {
		if (!issue || phaseOf(issue) !== "awaiting-merge") return false;
	} else if (a.taskId || pr.ownership !== "dependabot") return false;
	return isAttentionAnswerOk(a.answer, [], a.id);
}

function matchesOutbox(a: Attention, outbox: WakeLocal["outbox"]) {
	return (
		["setup", "merge", "blocked", "interview"].includes(a.kind) &&
		outbox.some(
			(m) =>
				m.attention === a.id &&
				m.kind === a.kind &&
				m.issue === a.issue &&
				m.task === a.taskId &&
				m.pr === a.pr &&
				(m.project === undefined || m.project === a.project),
		)
	);
}

function issueAnswerTarget(a: Attention, issues: WakeIssue[]) {
	return (
		(a.kind === "interview" || a.kind === "blocked") &&
		issues.some((i) => String(i.number) === a.issue && phaseOf(i) === a.kind)
	);
}

const phaseLabels = [
	"queued",
	"interview",
	"designing",
	"spec-review",
	"implementing",
	"impl-review",
	"awaiting-merge",
	"blocked",
];
function phaseOf(issue: WakeIssue): string | undefined {
	const phases = phaseLabels.filter((phase) => issue.labels.includes(`harness:${phase}`));
	return phases.length === 1 ? phases[0] : undefined;
}

function matchingIssueGate(issue: WakeIssue, a: Attention): boolean {
	if (!openGate(a) || a.issue !== String(issue.number)) return false;
	const phase = phaseOf(issue);
	return (
		(a.kind === phase && (phase === "interview" || phase === "blocked")) ||
		(a.kind === "merge" && phase === "awaiting-merge" && !issue.labels.includes("harness:merge-ok"))
	);
}

function completedCi(pr: WakePr, now: number) {
	return pr.ci?.kind === "complete" || (pr.ci?.kind === "empty" && now - utc(pr.updatedAt) > 30 * minute);
}

export function classifyWork(project: string, remote: WakeRemote, local: WakeLocal, now: number, fresh = false) {
	const issues = remote.issues ?? [];
	const prs = (remote.prs ?? []).filter((p) => p.ownership !== "other");
	const attention = latestAttentions(project, local.attention);
	const findIssue = (number: string) => issues.find((i) => String(i.number) === number);
	const findPr = (number: string) => prs.find((p) => String(p.number) === number);
	const answer = attention.some(
		(a) =>
			actualAnswer(a) &&
			((a.kind !== "interview" && a.kind !== "blocked") || a === latestForIssue(project, a.issue, local.attention)) &&
			(matchesOutbox(a, local.outbox) ||
				deliveredMerge(a, findIssue(a.issue), findPr(a.pr)) ||
				(issueAnswerTarget(a, issues) && (!a.resolvedAt || remote.answerEvidence?.get(a.id) !== a.resolvedAt))),
	);
	const activeIssues = issues.filter((i) => i.labels.some((label) => label.startsWith("harness:")));
	const tasks = local.tasks.filter(
		(t) => t.project === project && t.status !== "done" && ((!t.issue && !t.pr) || findIssue(t.issue) || findPr(t.pr)),
	);
	const issueWait = (i: WakeIssue) => {
		const gate = latestForIssue(project, String(i.number), local.attention);
		return gate !== undefined && matchingIssueGate(i, gate);
	};
	const prWait = (pr: WakePr) => {
		if (
			!completedCi(pr, now) ||
			pr.mergeable !== "MERGEABLE" ||
			(pr.reviewDecision !== null && pr.reviewDecision !== "REVIEW_REQUIRED")
		)
			return false;
		const controls = attention.filter((a) => a.pr === String(pr.number) && a.kind === "merge");
		if (pr.ownership === "dependabot")
			return controls.some((a) => openGate(a) && !a.issue && !a.taskId && fixedHead(a.summary) === pr.head);
		return attention.some((a) => {
			const issue = findIssue(a.issue);
			const task = tasks.find((t) => t.id === a.taskId && t.pr === String(pr.number));
			return (
				(a.pr === String(pr.number) || task) &&
				issue &&
				a === latestForIssue(project, a.issue, local.attention) &&
				matchingIssueGate(issue, a) &&
				(!fixedHead(a.summary) || fixedHead(a.summary) === pr.head)
			);
		});
	};
	const failures = [...remote.failures, ...local.failures].sort(
		(a, b) => a.source.localeCompare(b.source) || a.code.localeCompare(b.code),
	);
	const reasons: Reason[] = [];
	if (activeIssues.length) reasons.push("issue");
	if (fresh) reasons.push("queued-new");
	if (prs.some((p) => p.ownership === "own")) reasons.push("pr-own");
	if (prs.some((p) => p.ownership === "dependabot")) reasons.push("pr-dependabot");
	if (tasks.length) reasons.push("task");
	if (answer) reasons.push("answer");
	if (failures.length) reasons.push("fetch-failed");
	const human =
		reasons.length > 0 &&
		!fresh &&
		!answer &&
		!failures.length &&
		activeIssues.every(issueWait) &&
		prs.every(prWait) &&
		tasks.every((t) => {
			if (["ai-working", "queued", "inbox"].includes(t.status) || ["designing", "implementing"].includes(t.phase))
				return false;
			const issue = findIssue(t.issue);
			const pr = findPr(t.pr);
			return Boolean((issue && issueWait(issue)) || (pr && prWait(pr)));
		});
	const ordered = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
	const fingerprint = human
		? JSON.stringify([
				ordered(activeIssues.map((i) => [i.number, i.updatedAt, [...i.labels].sort()])),
				ordered(prs.map((p) => [p.number, p.head, p.draft, p.updatedAt, p.mergeable, p.reviewDecision, p.ci])),
				ordered(tasks.map((t) => [t.id, t.phase, t.status, t.updated])),
				ordered(attention.map((a) => [a.id, a.status, a.resolvedAt])),
			])
		: null;
	return { reasons, failures, human, fingerprint };
}

export type Cadence = "none" | "active-15m" | "human-60m" | "human-120m";
const intervals = { "active-15m": 15 * minute, "human-60m": 60 * minute, "human-120m": 120 * minute };
export const periodicValidityMs = 75_000;

export class WorkClock {
	private fingerprint: string | null = null;
	private since = 0;
	private observedAt: number | null = null;
	private lastSentAt: number | null = null;

	observe(now: number, fingerprint: string | null): Exclude<Cadence, "none"> {
		if (fingerprint !== this.fingerprint || this.observedAt === null || now - this.observedAt > periodicValidityMs)
			this.since = now;
		this.fingerprint = fingerprint;
		this.observedAt = now;
		if (fingerprint === null) return "active-15m";
		return now - this.since >= 120 * minute ? "human-120m" : "human-60m";
	}

	sent(now: number) {
		this.lastSentAt = now;
	}

	due(now: number, cadence: Exclude<Cadence, "none">) {
		return this.lastSentAt === null || now - this.lastSentAt >= intervals[cadence];
	}
}

import { isAttentionAnswerOk } from "./attention-read.ts";
