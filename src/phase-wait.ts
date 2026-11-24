// 強制整理から除外する「待ち」の判定。人の回答待ちは台帳、CI 待ちは GitHub から読む（推測しない）。
import { readCiPage } from "./harness-pr.ts";
import type { Ledger } from "./ledger.ts";
import { object } from "./notification-receipt.ts";
import type { Run } from "./projects.ts";

export type CiWait = "clear" | "busy" | "unknown";

const HUMAN_PHASES = ["interview", "awaiting-merge", "blocked"];

/**
 * 同じ project に人の回答待ちがあるか。遷移した Issue だけでなく project 全体で見る（worker は1つで、他の Issue の待ちも抱えているため）。
 * waiting の文言は解釈しない。回答済みでも項目が残っていれば保守的に待ちとして扱い、通常の状態更新で解消する。
 */
export function hasHumanWait(ledger: Ledger, project: string): boolean {
	const task = ledger
		.tasks()
		.some(
			(t) =>
				t.project === project &&
				t.status !== "done" &&
				(t.status === "waiting-human" || t.status === "blocked" || HUMAN_PHASES.includes(t.phase) || t.waiting !== ""),
		);
	return task || ledger.openAttention().some((a) => a.project === project);
}

const RUN_STATES = ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"];
const CONCLUSIONS = [
	"ACTION_REQUIRED",
	"CANCELLED",
	"FAILURE",
	"NEUTRAL",
	"SKIPPED",
	"STALE",
	"STARTUP_FAILURE",
	"SUCCESS",
	"TIMED_OUT",
];
const STATUS_STATES = ["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"];

function ciNodeState(node: unknown): CiWait {
	const c = object(node);
	if (c.__typename === "CheckRun") {
		if (c.status === "COMPLETED")
			return typeof c.conclusion === "string" && CONCLUSIONS.includes(c.conclusion) ? "clear" : "unknown";
		if (typeof c.status === "string" && RUN_STATES.includes(c.status)) return "busy";
	} else if (c.__typename === "StatusContext" && typeof c.state === "string" && STATUS_STATES.includes(c.state)) {
		return c.state === "PENDING" || c.state === "EXPECTED" ? "busy" : "clear";
	}
	return "unknown";
}

export function hasInvalidCiNodes(nodes: unknown[]): boolean {
	return nodes.some((node) => {
		const state = ciNodeState(node);
		const c = object(node);
		return state === "unknown" || (state === "busy" && c.__typename === "CheckRun" && c.conclusion !== null);
	});
}

/**
 * CI の checks を「待ち」かどうかで分類する。完了した失敗・キャンセルは待ちではない。
 * Why not ciGreen の否定: 完了した失敗まで待ちになってしまう。未知の値は unknown にして許可の証拠にしない。
 */
export function classifyCiNodes(nodes: unknown[]): CiWait {
	// contexts が0件（CI 未登録や登録前）は、これから始まるかもしれないので待ちとして扱う
	if (nodes.length === 0) return "busy";
	let busy = false;
	let unknown = false;
	for (const node of nodes) {
		const state = ciNodeState(node);
		if (state === "busy") busy = true;
		if (state === "unknown") unknown = true;
	}
	if (busy) return "busy";
	return unknown ? "unknown" : "clear";
}

const QUERY =
	"query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision mergeStateStatus commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$endCursor){nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}} pageInfo{hasNextPage endCursor}}}}}}}}}";

export const CI_READ_TIMEOUT_MS = 10_000;
const CI_MAX_BUFFER = 2 * 1024 * 1024;

async function openHeads(repo: string, exec: Run, signal: AbortSignal): Promise<Map<number, string> | null> {
	const r = await exec("gh", ["api", "--paginate", "--slurp", `repos/${repo}/pulls?state=open&per_page=100`], {
		timeoutMs: CI_READ_TIMEOUT_MS,
		maxBuffer: CI_MAX_BUFFER,
		signal,
	});
	if (!r.ok) return null;
	try {
		const raw: unknown = JSON.parse(r.stdout);
		if (!Array.isArray(raw) || raw.some((p) => !Array.isArray(p))) return null;
		const heads = new Map<number, string>();
		for (const item of raw.flat()) {
			const p = object(item);
			const sha = object(p.head).sha;
			if (typeof p.number !== "number" || !Number.isSafeInteger(p.number) || typeof sha !== "string") return null;
			if (!/^[a-f0-9]{40}$/.test(sha)) return null;
			heads.set(p.number, sha);
		}
		return heads;
	} catch {
		return null;
	}
}

/**
 * repo の open な PR すべて（draft・Dependabot・台帳に無いものも含む。安全側）の CI に、進行中があるかを読む。
 * ページ・head・応答の不整合や読取失敗は unknown（整理しない側）。合計の期限は CI_READ_TIMEOUT_MS。
 */
export async function readCiWait(repo: string, exec: Run, parent?: AbortSignal): Promise<CiWait> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "unknown";
	const signal = parent
		? AbortSignal.any([parent, AbortSignal.timeout(CI_READ_TIMEOUT_MS)])
		: AbortSignal.timeout(CI_READ_TIMEOUT_MS);
	try {
		const heads = await openHeads(repo, exec, signal);
		if (!heads) return "unknown";
		const [owner = "", name = ""] = repo.split("/");
		let state: CiWait = "clear";
		for (const [pr, head] of heads) {
			const r = await exec(
				"gh",
				[
					"api",
					"graphql",
					"--paginate",
					"--slurp",
					"-f",
					`query=${QUERY}`,
					"-F",
					`owner=${owner}`,
					"-F",
					`name=${name}`,
					"-F",
					`number=${pr}`,
				],
				{ timeoutMs: CI_READ_TIMEOUT_MS, maxBuffer: CI_MAX_BUFFER, signal },
			);
			if (!r.ok) return "unknown";
			const pages: unknown = JSON.parse(r.stdout);
			if (!Array.isArray(pages) || pages.length === 0) return "unknown";
			const nodes: unknown[] = [];
			for (const [i, page] of pages.entries()) {
				const read = readCiPage(page, i, pages.length, head);
				if ("problem" in read) return "unknown";
				nodes.push(...read.nodes);
			}
			const one = classifyCiNodes(nodes);
			if (one === "busy") state = "busy";
			else if (one === "unknown" && state === "clear") state = "unknown";
		}
		// 読取の間に head が動いていたら、読んだ CI は別の commit のものかもしれない
		const after = await openHeads(repo, exec, signal);
		if (!after || after.size !== heads.size) return "unknown";
		for (const [pr, head] of heads) if (after.get(pr) !== head) return "unknown";
		return state;
	} catch {
		return "unknown";
	}
}
