// 未対応の引数は必ず失敗する。実 GitHub・engine・git へ委譲しない。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
const dir = process.env.PR_FIXTURE;
if (!dir) throw Error("PR_FIXTURE が必要です");
const file = path.join(dir, "remote.json");
const state = JSON.parse(readFileSync(file, "utf8"));
const [command, ...args] = process.argv.slice(2);
state.calls.push([command, ...args]);
const at = "2026-10-29T00:00:00Z";
let output: unknown;
const value = (flag: string) => args[args.indexOf(flag) + 1];
const input = () => JSON.parse(readFileSync(value("--input"), "utf8"));
function stop(code = 1) { writeFileSync(file, JSON.stringify(state)); process.exit(code); }
function comment(pr: number, body: string) {
	const id = state.next++;
	const time = body.includes("harness:rebase") ? new Date().toISOString() : new Date(Date.parse(at) + id * 1000).toISOString();
	const result = { id, user: { login: "worker" }, body, html_url: `https://github.com/example/project/issues/${pr}#issuecomment-${id}`, created_at: time, updated_at: time };
	(state.comments[pr] ??= []).push(result);
	return result;
}
if (command === "gh") {
	const endpoint = args.find((v) => v.startsWith("repos/"));
	if (args[0] === "repo" && args[1] === "view") output = "example/project";
	else if (args[0] === "api" && args[1] === "user") output = "worker";
	else if (args[0] === "api" && args.includes("graphql")) {
		const pr = Number(args.find((a) => a.startsWith("number="))?.slice(7));
		const p = state.prs.find((v: { number: number }) => v.number === pr);
		const checks = state.checkPages ?? [state.checksByPr?.[pr] ?? state.checks];
		output = checks.map((nodes: unknown[], i: number) => ({ data: { repository: { pullRequest: { mergeQueueEntry: state.queue ? { id: "queue-entry" } : null, reviewDecision: state.reviewDecision, mergeStateStatus: state.mergeStateStatus, commits: { nodes: [{ commit: { oid: p.head.sha, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: i < checks.length - 1, endCursor: i < checks.length - 1 ? "next" : null } } } } }] } } } } }));
	} else if (args[0] === "api" && endpoint === "repos/example/project/pulls?state=open&per_page=100") output = state.prs.map((p: { state: string }) => p.state === "open" ? [p] : []).filter((p: unknown[]) => p.length);
	else if (args[0] === "api" && endpoint === "repos/example/project") output = { full_name: "example/project", default_branch: "main" };
	else if (args[0] === "pr" && args[1] === "edit") {
		const pr = state.prs.find((v: { number: number }) => v.number === Number(args[2]));
		if (args.includes("--remove-label")) pr.labels = pr.labels.filter((l: { name: string }) => l.name !== value("--remove-label"));
		if (args.includes("--add-label")) pr.labels.push({ name: value("--add-label") });
		output = "";
	} else if (args[0] === "pr" && args[1] === "merge") {
		const pr = state.prs.find((v: { number: number }) => v.number === Number(args[2]));
		if (value("--match-head-commit") !== pr.head.sha || !args.includes("--squash") || args.some((a) => ["--auto", "--admin", "--delete-branch"].includes(a))) stop(94);
		if (state.fail === "merge") stop();
		if (!state.queue) { pr.merged = true; pr.merged_at = at; pr.state = "closed"; }
		output = "";
	} else if (endpoint) {
		let match;
		if ((match = /^repos\/example\/project\/pulls\/(\d+)$/.exec(endpoint))) {
			if (state.fail === "labels-final" && state.patched) stop();
			output = state.prs.find((v: { number: number }) => v.number === Number(match[1]));
		} else if ((match = /^repos\/example\/project\/issues\/(\d+)\/comments(?:\?per_page=100)?$/.exec(endpoint))) {
			const pr = Number(match[1]);
			if (value("--method") === "POST") { output = comment(pr, input().body); if (state.fail === "post") stop(); }
			else if (args.includes("--paginate")) output = [state.comments[pr] ?? []];
			else stop(92);
		} else if ((match = /^repos\/example\/project\/issues\/comments\/(\d+)$/.exec(endpoint))) {
			const id = Number(match[1]);
			const all = Object.values(state.comments).flat() as { id: number; body: string }[];
			const c = all.find((c) => c.id === id);
			if (!c) stop(93);
			if (value("--method") === "PATCH") { Object.assign(c, input()); state.patched = true; if (state.fail === "patch") stop(); }
			output = c;
		} else if ((match = /^repos\/example\/project\/pulls\/(\d+)\/reviews(?:\?per_page=100)?$/.exec(endpoint))) {
			const pr = Number(match[1]);
			if (value("--method") === "POST") {
				const v = input();
				if (v.event !== "APPROVE" || !v.commit_id || !v.body.includes("A-")) stop(94);
				output = { id: state.next++, user: { login: "worker" }, state: "APPROVED", commit_id: v.commit_id, body: v.body, submitted_at: at };
				(state.reviews[pr] ??= []).push(output);
				if (state.afterReview !== "protection") { state.reviewDecision = "APPROVED"; state.mergeStateStatus = "CLEAN"; state.prs[0].mergeable_state = "clean"; }
				if (state.afterReview === "head-after") state.prs[0].head.sha = "b".repeat(40);
				if (state.afterReview === "auto-after") state.prs[0].auto_merge = {};
				if (state.afterReview === "ci-after") state.checksByPr = { 25: [{ __typename: "StatusContext", state: "FAILURE" }] };
				if (state.fail === "review") stop();
			} else if (args.includes("--paginate")) output = [state.reviews[pr] ?? []];
			else stop(92);
		} else if (endpoint.startsWith("repos/example/project/git/matching-refs/heads/dependabot/")) { output = state.deleted ? [[]] : [[{ ref: `refs/heads/${endpoint.split("/heads/")[1]}` }]];
		} else if (endpoint.startsWith("repos/example/project/git/ref/heads/dependabot/")) {
			if (state.deleted) {
				if (args.includes("--include")) output = "HTTP/2.0 404 Not Found\n";
				else stop();
			} else output = { ref: `refs/heads/${endpoint.split("/heads/")[1]}`, object: { sha: state.refSha ?? state.prs[0].head.sha } };
		} else if (endpoint.startsWith("repos/example/project/git/refs/heads/dependabot/") && value("--method") === "DELETE") {
			if (!state.prs[0].merged || state.fail === "delete") stop();
			state.deleted = true; output = "";
		} else stop(91);
	} else stop(90);
} else if (command === "git") {
	const a = args[0] === "-C" ? args.slice(2) : args;
	if (a.join(" ") === "remote get-url origin") output = "https://github.com/example/project.git";
	else if (a[0] === "fetch") { state.tempRef = a.at(-1)?.split(":")[1]; output = ""; }
	else if (a[0] === "rev-parse" && a.includes("--git-common-dir")) output = `${dir}/.git`;
	else if (a[0] === "rev-parse" && a.includes("--show-toplevel")) output = process.cwd();
	else if (a[0] === "rev-parse") output = state.prs[0].head.sha;
	else if (a[0] === "worktree" && a[1] === "add") { state.worktree = a[3]; mkdirSync(state.worktree, { recursive: true }); output = ""; }
	else if (a[0] === "worktree" && a[1] === "list") output = state.worktree ? `worktree ${state.worktree}\n` : "";
	else if (a[0] === "worktree" && a[1] === "remove") { rmSync(a[3], { recursive: true, force: true }); delete state.worktree; output = ""; }
	else if (a[0] === "update-ref" && a[1] === "-d") { delete state.tempRef; output = ""; }
	else stop(90);
} else if (command === "harness-notify" || command === "dle") {
	if (args.includes("--check-target")) output = "";
	else if (value("--event") === "merge-request") {
		const af = path.join(dir, "attention.json"), sf = path.join(dir, "state.json");
		const items = JSON.parse(readFileSync(af, "utf8"));
		const seq = JSON.parse(readFileSync(sf, "utf8")).attentionSeq + 1;
		for (const a of items) if (a.pr === value("--pr") && a.status === "open") Object.assign(a, { status: "resolved", answer: "（新しい依頼に置き換え）", resolvedAt: at });
		items.push({ id: `A-${seq}`, project: value("--project"), issue: "", pr: value("--pr"), taskId: "", kind: "merge", title: value("--title"), summary: value("--body"), url: value("--url"), status: "open", createdAt: at });
		writeFileSync(af, JSON.stringify(items)); writeFileSync(sf, JSON.stringify({ attentionSeq: seq }));
		if (state.fail === "notify") stop();
		output = { status: "posted", source: "engine", attention: `A-${seq}` };
	} else if (value("--event") === "phase") {
		if (state.fail === "done") stop();
		const af = path.join(dir, "attention.json"), items = JSON.parse(readFileSync(af, "utf8"));
		for (const a of items) if (a.pr === value("--pr") && a.status === "open") Object.assign(a, { status: "resolved", answer: value("--body"), resolvedAt: at });
		writeFileSync(af, JSON.stringify(items)); output = {};
	} else if (value("--event") === "info") { if (state.fail === "info") stop(); output = ""; }
	else stop(90);
} else stop(90);
writeFileSync(file, JSON.stringify(state));
if (output === undefined) stop(95);
const bytes = Buffer.from(typeof output === "string" ? output : JSON.stringify(output));
let offset = 0;
while (offset < bytes.length) {
	try { offset += writeSync(1, bytes, offset, Math.min(4096, bytes.length - offset)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
}
