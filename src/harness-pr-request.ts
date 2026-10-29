// 依頼の進行と、寿命の長い rebase・通知抑止を別ファイルに保存する。
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAttentionSnapshot, validTime } from "./attention-read.ts";
import { gh, run } from "./harness-approval.ts";
import {
	bin,
	emit,
	exists,
	facts,
	fixedHead,
	listPrs,
	type PrContext,
	PrError,
	type PrFacts,
	type PrTarget,
	pages,
	positive,
	prNumber,
	readPr,
	shaPattern,
	validateComment,
} from "./harness-pr.ts";
import { object } from "./notification-receipt.ts";

export type ReleaseReason =
	| "owner-ng"
	| "rebase-timeout"
	| "auto-merge-enabled"
	| "approve-stopped"
	| "protection-blocked";
interface RebaseRecord {
	intentAt: string;
	requestedAt?: string;
	commentId?: number;
	settled?: boolean;
}
export interface PrControl {
	login: string;
	repo: string;
	pr: number;
	rebases: Record<string, RebaseRecord>;
	infos: Record<string, "intent" | "sent" | "unknown">;
	terminal?: { phase: "done" | "blocked"; status: "intent" | "sent" | "unknown" };
	slotReleasedHead?: string;
	slotReleasedReason?: ReleaseReason;
}
export interface PrRecovery {
	repo: string;
	pr: number;
	head: string;
	stage: string;
	pid: number;
	startedAt: string;
	commentId?: number;
	attention?: string;
	identity?: string;
	approvedReviewId?: number;
	reviewIntent?: boolean;
	mergeIntent?: boolean;
	queued?: boolean;
	merged?: boolean;
	branchDeleted?: boolean;
	doneIntent?: boolean;
	doneNotified?: boolean;
	tempDir?: string;
	tempRef?: string;
	tempWorktree?: string;
}
export const recoveryPath = (c: PrContext, pr: number) => path.join(c.root, ".harness", `pr-merge-recovery-${pr}.json`);
const controlPath = (c: PrContext, pr: number) => path.join(c.root, ".harness", `pr-merge-state-${pr}.json`);
async function readOptional(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if (object(error).code === "ENOENT" && !(await exists(file))) return undefined;
		throw error;
	}
}
export async function save(file: string, value: unknown) {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	await rename(temp, file);
}
export async function readControl(c: PrContext, pr: number): Promise<PrControl> {
	const raw = await readOptional(controlPath(c, pr));
	if (raw === undefined) return { login: c.login, repo: c.repo, pr, rebases: {}, infos: {} };
	const v = object(raw),
		rebases = object(v.rebases),
		infos = object(v.infos);
	if (
		v.repo !== c.repo ||
		v.login !== c.login ||
		v.pr !== pr ||
		!v.rebases ||
		!v.infos ||
		Array.isArray(v.rebases) ||
		Array.isArray(v.infos)
	)
		throw new PrError("PR 停止記録が不正です");
	const result: PrControl = { login: c.login, repo: c.repo, pr, rebases: {}, infos: {} };
	for (const [head, raw] of Object.entries(rebases)) {
		const r = object(raw);
		if (
			!shaPattern.test(head) ||
			!validTime(r.intentAt) ||
			(r.requestedAt !== undefined && !validTime(r.requestedAt)) ||
			(r.commentId !== undefined && !positive(r.commentId)) ||
			(r.settled !== undefined && typeof r.settled !== "boolean")
		)
			throw new PrError("rebase 記録が不正です");
		result.rebases[head] = {
			intentAt: r.intentAt,
			...(typeof r.requestedAt === "string" ? { requestedAt: r.requestedAt } : {}),
			...(positive(r.commentId) ? { commentId: r.commentId } : {}),
			...(r.settled === true ? { settled: true } : {}),
		};
	}
	for (const [key, status] of Object.entries(infos)) {
		if (!["intent", "sent", "unknown"].includes(String(status))) throw new PrError("info 記録が不正です");
		result.infos[key] = status as "intent" | "sent" | "unknown";
	}
	if (v.terminal !== undefined) {
		const t = object(v.terminal);
		if (
			(t.phase !== "done" && t.phase !== "blocked") ||
			(t.status !== "intent" && t.status !== "sent" && t.status !== "unknown")
		)
			throw new PrError("完了通知記録が不正です");
		result.terminal = { phase: t.phase, status: t.status };
	}
	if (v.slotReleasedReason !== undefined || v.slotReleasedHead !== undefined) {
		if (
			typeof v.slotReleasedHead !== "string" ||
			!shaPattern.test(v.slotReleasedHead) ||
			!["owner-ng", "rebase-timeout", "auto-merge-enabled", "approve-stopped", "protection-blocked"].includes(
				String(v.slotReleasedReason),
			)
		)
			throw new PrError("枠解放記録が不正です");
		result.slotReleasedHead = v.slotReleasedHead;
		result.slotReleasedReason = v.slotReleasedReason as ReleaseReason;
	}
	return result;
}
export const saveControl = (c: PrContext, s: PrControl) => save(controlPath(c, s.pr), s);
export async function readRecovery(c: PrContext, pr: number): Promise<PrRecovery | undefined> {
	const raw = await readOptional(recoveryPath(c, pr));
	if (raw === undefined) return;
	const r = object(raw);
	if (
		r.repo !== c.repo ||
		r.pr !== pr ||
		typeof r.head !== "string" ||
		!shaPattern.test(r.head) ||
		typeof r.stage !== "string" ||
		!/^(request|merge):/.test(r.stage) ||
		!positive(r.pid) ||
		!validTime(r.startedAt)
	)
		throw new PrError("依頼の復旧記録が不正です");
	for (const key of ["commentId", "approvedReviewId"])
		if (r[key] !== undefined && !positive(r[key])) throw new PrError("復旧 ID が不正です");
	for (const key of ["attention", "identity", "tempDir", "tempRef", "tempWorktree"])
		if (r[key] !== undefined && typeof r[key] !== "string") throw new PrError("復旧パスが不正です");
	for (const key of ["reviewIntent", "mergeIntent", "queued", "merged", "branchDeleted", "doneIntent", "doneNotified"])
		if (r[key] !== undefined && typeof r[key] !== "boolean") throw new PrError("復旧状態が不正です");
	return r as unknown as PrRecovery;
}
export const saveRecovery = (c: PrContext, r: PrRecovery) => save(recoveryPath(c, r.pr), r);
export function newRecovery(c: PrContext, t: PrTarget, stage: string): PrRecovery {
	return { repo: c.repo, pr: t.pr, head: t.head, stage, pid: process.pid, startedAt: new Date().toISOString() };
}
export async function withLock<T>(c: PrContext, key: string, fn: () => Promise<T>): Promise<T> {
	const dir = path.join(c.root, ".harness", "pr-locks", key);
	await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
	try {
		await mkdir(dir, { mode: 0o700 });
	} catch {
		throw new PrError(`PR の排他中です (${key})。残存 lock は所有プロセスを確認してください`);
	}
	try {
		await writeFile(
			path.join(dir, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
				repo: c.repo,
				key,
			}),
			{ mode: 0o600 },
		);
		return await fn();
	} finally {
		await rm(dir, { recursive: true });
	}
}
export async function jsonApi(endpoint: string, method: string, value: unknown) {
	const temp = await mkdtemp(path.join(os.tmpdir(), "dle-pr-api-"));
	try {
		const file = path.join(temp, "input.json");
		await writeFile(file, JSON.stringify(value), { mode: 0o600 });
		return JSON.parse(await gh("api", endpoint, "--method", method, "--input", file)) as unknown;
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
export async function notifyPhase(c: PrContext, t: PrTarget, phase: "done" | "blocked", reason: string) {
	await run(
		path.join(bin, "dle"),
		[
			"notify",
			"--event",
			"phase",
			"--phase",
			phase,
			"--project",
			c.project,
			"--pr",
			String(t.pr),
			"--issue",
			"",
			"--title",
			`PR #${t.pr}`,
			"--body",
			reason,
			"--url",
			t.url,
		],
		180000,
	);
}
export async function infoOnce(
	c: PrContext,
	t: PrTarget,
	keys: string[],
	body: string,
	release?: ReleaseReason,
	releaseHead = t.head,
) {
	const control = await readControl(c, t.pr);
	if (release) {
		control.slotReleasedHead = releaseHead;
		control.slotReleasedReason = release;
	}
	const seen = keys.some((key) => control.infos[key] !== undefined);
	for (const key of keys) control.infos[key] ??= "intent";
	await saveControl(c, control);
	if (seen) return;
	try {
		await run(
			path.join(bin, "harness-notify"),
			[
				"--event",
				"info",
				"--project",
				c.project,
				"--repo",
				c.repo,
				"--pr",
				String(t.pr),
				"--title",
				`PR #${t.pr}`,
				"--url",
				t.url,
				"--body",
				body,
			],
			180000,
		);
		for (const key of keys) control.infos[key] = "sent";
	} catch {
		for (const key of keys) control.infos[key] = "unknown";
		emit(`harness-pr: PR #${t.pr} の info は結果不明です。自動再送しません`, true);
	} finally {
		await saveControl(c, control);
	}
}
const rebaseMarker = (head: string) => `<!-- harness:rebase sha=${head} -->`;
async function syncRebase(c: PrContext, f: PrFacts) {
	const control = await readControl(c, f.target.pr);
	const candidates = f.comments
		.map(object)
		.filter(
			(v) =>
				object(v.user).login === c.login && typeof v.body === "string" && v.body.includes(rebaseMarker(f.target.head)),
		);
	if (candidates.length > 1) throw new PrError("重複 rebase が見つかりました");
	if (candidates.length) {
		const v = validateComment(candidates[0], c.repo, f.target.pr, c.login);
		if (v.body !== `@dependabot rebase\n\n${rebaseMarker(f.target.head)}`)
			throw new PrError("rebase marker が不正です");
		const old = control.rebases[f.target.head];
		control.rebases[f.target.head] = {
			intentAt: old?.intentAt ?? v.createdAt,
			requestedAt: v.createdAt,
			commentId: v.id,
			...(old?.settled ? { settled: true } : {}),
		};
		await saveControl(c, control);
	}
	return control;
}
export async function reconcile(c: PrContext, f: PrFacts) {
	const t = f.target;
	const control = await syncRebase(c, f);
	if (f.approval.ownerNg) {
		const keys = [`${t.head}:owner-ng`];
		const recovery = await readRecovery(c, t.pr);
		if (recovery?.approvedReviewId) keys.push(`${recovery.head}:approve-stopped`);
		await infoOnce(
			c,
			t,
			keys,
			`GitHub の NG で停止しました。${recovery?.approvedReviewId ? "Approve は残っています。" : ""}指摘解消後、窓口へ再依頼してください。`,
			"owner-ng",
		);
		if (f.latestCheck.state === "open") await notifyPhase(c, t, "blocked", "（GitHub の NG で停止）");
		return await readControl(c, t.pr);
	}
	const rebase = control.rebases[t.head];
	if (
		rebase &&
		!rebase.settled &&
		control.slotReleasedHead !== t.head &&
		Date.now() - Date.parse(rebase.requestedAt ?? rebase.intentAt) >= 120 * 60000
	) {
		const recovery = await readRecovery(c, t.pr);
		const keys = [`${t.head}:rebase-timeout`];
		if (recovery?.approvedReviewId) keys.push(`${recovery.head}:approve-stopped`);
		await infoOnce(
			c,
			t,
			keys,
			`rebase 依頼から120分 head が不変です。${recovery?.approvedReviewId ? "Approve は残っています。" : ""}原因解消後、窓口へ再依頼してください。`,
			"rebase-timeout",
		);
		return await readControl(c, t.pr);
	}
	return control;
}
export async function requestRebase(c: PrContext, f: PrFacts) {
	const control = await syncRebase(c, f);
	const t = f.target;
	if (control.rebases[t.head]) {
		if (!control.rebases[t.head]?.commentId)
			await infoOnce(c, t, [`${t.head}:rebase-unknown`], "rebase の送信結果が不明です。再送せず復旧確認を待ちます。");
		return;
	}
	control.rebases[t.head] = { intentAt: new Date().toISOString() };
	await saveControl(c, control);
	const body = `@dependabot rebase\n\n${rebaseMarker(t.head)}`;
	try {
		validateComment(
			await jsonApi(`repos/${c.repo}/issues/${t.pr}/comments`, "POST", { body }),
			c.repo,
			t.pr,
			c.login,
			body,
		);
	} catch {
		// 応答喪失時は遠隔 marker を確認し、結果が不明でも再送しない。
	}
	const updated = await facts(c, t.pr);
	const synced = await syncRebase(c, updated);
	if (!synced.rebases[t.head]?.commentId)
		await infoOnce(c, t, [`${t.head}:rebase-unknown`], "rebase の送信結果が不明です。再送せず復旧確認を待ちます。");
}
function automaticallyStopped(f: PrFacts, control: PrControl) {
	return (
		f.approval.ownerNg ||
		f.latestCheck.state === "not-approved" ||
		control.slotReleasedReason === "owner-ng" ||
		control.slotReleasedHead === f.target.head
	);
}
function occupied(f: PrFacts, control: PrControl, recovery?: PrRecovery) {
	if (f.target.state === "closed" || f.target.merged || automaticallyStopped(f, control)) return false;
	return !!recovery || !!control.rebases[f.target.head] || f.approval.status !== "missing-notify" || !!f.latest;
}
function eligible(f: PrFacts) {
	return f.target.state === "open" && !f.target.merged && !f.unknown && !f.blocked && (f.needsRebase || f.green);
}
async function tracked(c: PrContext) {
	const list = await pages(`repos/${c.repo}/pulls?state=open&per_page=100`);
	const ids = new Set<number>();
	for (const raw of list) {
		const p = object(raw);
		if (!positive(p.number) || typeof object(p.user).login !== "string" || typeof object(p.head).ref !== "string")
			throw new PrError("PR 一覧が不正です");
		if (
			object(p.user).login === "dependabot[bot]" &&
			String(object(p.head).ref).startsWith("dependabot/") &&
			p.draft !== true
		)
			ids.add(p.number);
	}
	const snapshot = await readAttentionSnapshot(c.home);
	for (const a of snapshot.items)
		if (a.project === c.project && a.kind === "merge" && a.issue === "" && typeof a.pr === "string")
			ids.add(prNumber(a.pr));
	let files: string[] = [];
	try {
		files = await readdir(path.join(c.root, ".harness"));
	} catch (error) {
		if (object(error).code !== "ENOENT") throw error;
	}
	for (const file of files) {
		const m = /^pr-merge-(?:state|recovery)-([1-9][0-9]*)\.json$/.exec(file);
		if (m?.[1]) ids.add(prNumber(m[1]));
	}
	return [...ids];
}
async function terminal(c: PrContext, t: PrTarget) {
	const r = await readRecovery(c, t.pr);
	if (t.merged && r?.stage.startsWith("merge:")) return "cleanup-pending";
	const control = await readControl(c, t.pr),
		phase = t.merged ? "done" : "blocked";
	if (control.terminal?.phase === phase) return;
	control.terminal = { phase, status: "intent" };
	await saveControl(c, control);
	try {
		await notifyPhase(c, t, phase, t.merged ? "（PR merged）" : "（PR closed）");
		control.terminal.status = "sent";
	} catch {
		control.terminal.status = "unknown";
	}
	await saveControl(c, control);
	return undefined;
}
export async function requestPr(c: PrContext, pr: number, retry: boolean) {
	await withLock(c, "requests", async () => {
		const rows: { f: PrFacts; control: PrControl; recovery?: PrRecovery }[] = [];
		for (const id of await tracked(c)) {
			await withLock(c, String(id), async () => {
				const t = await readPr(c, id);
				if (t.state === "closed" || t.merged) return;
				const f = await facts(c, id);
				rows.push({ f, control: await reconcile(c, f), recovery: await readRecovery(c, id) });
			});
		}
		const row = rows.find((r) => r.f.target.pr === pr);
		if (!row) throw new PrError("対象 PR がありません");
		const active = rows.filter((r) => occupied(r.f, r.control, r.recovery));
		if (active.some((r) => r.f.target.pr !== pr))
			throw new PrError("同時1件の枠が使用中です。枠が空いてから再依頼してください");
		if (!retry && automaticallyStopped(row.f, row.control)) return;
		// Approve 後に head が変わった停止は info 済み。副作用の確認が要らない記録なので、新 head の新 A を妨げない。
		const staleApproved =
			row.recovery?.stage.startsWith("merge:") &&
			row.recovery.head !== row.f.target.head &&
			!row.recovery.mergeIntent &&
			!row.recovery.tempDir;
		if (!retry && row.recovery && !staleApproved) throw new PrError("未完了の復旧記録があります");
		if (
			(!row.recovery || staleApproved) &&
			row.f.approval.status === "ready" &&
			!automaticallyStopped(row.f, row.control)
		) {
			if (retry) throw new PrError("同じ head の正常な完成依頼があります。その A へ回答してください");
			return;
		}
		if (!retry && row.f.approval.status === "incomplete") throw new PrError("依頼は未完了です");
		if (!eligible(row.f)) throw new PrError("CI/追従/保護状態が依頼条件を満たしません");
		const candidates = rows
			.filter((r) => eligible(r.f) && ((r.f.target.pr === pr && retry) || !automaticallyStopped(r.f, r.control)))
			.sort(
				(a, b) => Date.parse(a.f.target.createdAt) - Date.parse(b.f.target.createdAt) || a.f.target.pr - b.f.target.pr,
			);
		if (!active.length && candidates[0]?.f.target.pr !== pr)
			throw new PrError("より古い適格候補があります。指定 PR には発行していません");
		await withLock(c, String(pr), async () => {
			const f = await facts(c, pr);
			if (f.target.head !== row.f.target.head || !eligible(f)) throw new PrError("依頼条件が変わりました");
			if (retry && row.recovery?.stage.startsWith("merge:") && (row.recovery.mergeIntent || row.recovery.tempDir))
				throw new PrError("マージ/一時物の復旧確認が先に必要です");
			if (f.needsRebase) {
				await requestRebase(c, f);
				if (retry) throw new PrError("rebase 待ちのため新 A を発行していません。head/CI の更新後に再依頼してください");
				return;
			}
			await issueRequest(c, f, retry);
		});
	});
}
async function resetLabels(c: PrContext, pr: number) {
	const current = await readPr(c, pr);
	const args: string[] = [];
	if (current.labels.includes("harness:merge-ok")) args.push("--remove-label", "harness:merge-ok");
	if (!current.labels.includes("harness:awaiting-merge")) args.push("--add-label", "harness:awaiting-merge");
	if (args.length) await gh("pr", "edit", String(pr), "--repo", c.repo, ...args);
	const result = await readPr(c, pr);
	if (!result.labels.includes("harness:awaiting-merge") || result.labels.includes("harness:merge-ok"))
		throw new PrError("ラベルが未確認です");
}
function displayTitle(title: string) {
	return Array.from(title, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
		.join("")
		.replace(/[<>&`*_[\]\\]/g, (v) => `&#${v.charCodeAt(0)};`);
}
async function issueRequest(c: PrContext, f: PrFacts, retry: boolean) {
	const t = f.target;
	await run(path.join(bin, "harness-notify"), ["--check-target", "--event", "merge-request"]);
	const recovery = newRecovery(c, t, "request:labels");
	await saveRecovery(c, recovery);
	const summary = `承認対象 head: ${t.head}\nPR #${t.pr}: ${displayTitle(t.title)}\n${t.url}\nCI: SUCCESS を含む全チェック完了\nmergeMethod: ${c.method}\nbeforeMerge: ${c.hooks.length ? "承認 head の一時 worktree で実行" : "なし"}`;
	const pending = `${summary}\n\n通知確認中。承認依頼は未完了です。\n\n<!-- harness:pending phase=awaiting-merge pr=${t.pr} sha=${t.head} -->`;
	let commentId: number | undefined;
	try {
		await resetLabels(c, t.pr);
		recovery.stage = "request:post";
		await saveRecovery(c, recovery);
		const posted = validateComment(
			await jsonApi(`repos/${c.repo}/issues/${t.pr}/comments`, "POST", { body: pending }),
			c.repo,
			t.pr,
			c.login,
			pending,
		);
		commentId = posted.id;
		recovery.commentId = commentId;
		recovery.stage = "request:notify";
		await saveRecovery(c, recovery);
		const raw = await run(
			path.join(bin, "harness-notify"),
			[
				"--json",
				"--event",
				"merge-request",
				"--project",
				c.project,
				"--repo",
				c.repo,
				"--pr",
				String(t.pr),
				"--title",
				`PR #${t.pr}: ${displayTitle(t.title)}`,
				"--url",
				posted.url,
				"--body",
				summary,
			],
			180000,
		);
		const receipt = object(JSON.parse(raw));
		if (
			receipt.status !== "posted" ||
			receipt.source !== "engine" ||
			typeof receipt.attention !== "string" ||
			!/^A-[1-9][0-9]*$/.test(receipt.attention)
		)
			throw new PrError("engine の A がありません");
		recovery.attention = receipt.attention;
		const now = await facts(c, t.pr);
		// pending 中にも回答は届く。回答の内容を完成条件にせず scope/head を検査する。
		if (
			now.target.head !== t.head ||
			!now.green ||
			!now.latest ||
			now.latest.id !== receipt.attention ||
			fixedHead(now.latest.summary) !== t.head ||
			!["open", "approved", "not-approved"].includes(now.latestCheck.state)
		)
			throw new PrError("通知の A/head が一致しません");
		const body = `${summary}\n\n<!-- harness:gate phase=awaiting-merge pr=${t.pr} sha=${t.head} attention=${receipt.attention} -->`;
		recovery.stage = "request:patch";
		await saveRecovery(c, recovery);
		const completed = validateComment(
			await jsonApi(`repos/${c.repo}/issues/comments/${commentId}`, "PATCH", { body }),
			c.repo,
			t.pr,
			c.login,
			body,
			commentId,
		);
		if (completed.createdAt !== posted.createdAt) throw new PrError("依頼時刻が変わりました");
		await resetLabels(c, t.pr);
		const final = await facts(c, t.pr);
		if (
			final.target.head !== t.head ||
			!final.green ||
			final.approval.status !== "ready" ||
			final.approval.gate?.attention !== receipt.attention ||
			final.approval.gate.commentId !== commentId ||
			!["open", "approved", "not-approved"].includes(final.check.state)
		)
			throw new PrError("完成を確認できません");
		if (retry) {
			const control = await readControl(c, t.pr);
			delete control.slotReleasedReason;
			delete control.slotReleasedHead;
			const rebase = control.rebases[t.head];
			if (rebase) rebase.settled = true;
			await saveControl(c, control);
		}
		await rm(recoveryPath(c, t.pr));
	} catch (error) {
		if (commentId) {
			try {
				validateComment(
					await jsonApi(`repos/${c.repo}/issues/comments/${commentId}`, "PATCH", { body: pending }),
					c.repo,
					t.pr,
					c.login,
					pending,
					commentId,
				);
			} catch {}
		}
		throw error;
	}
}
export async function scan(c: PrContext) {
	for (const t of await listPrs(c)) {
		try {
			const f = await facts(c, t.pr);
			const recovery = await readRecovery(c, t.pr),
				control = await readControl(c, t.pr);
			emit(
				JSON.stringify({
					pr: t.pr,
					head: t.head,
					createdAt: t.createdAt,
					url: f.approval.url,
					status: recovery?.stage.startsWith("request:") ? "incomplete" : f.approval.status,
					ci: f.green ? "green" : "waiting",
					mergeState: f.needsRebase ? "rebase" : f.unknown ? "unknown" : f.blocked ? "blocked" : "ready",
					stopped: automaticallyStopped(f, control),
				}),
			);
		} catch {
			emit(JSON.stringify({ pr: t.pr, head: t.head, url: t.url, status: "incomplete" }));
		}
	}
}
export async function inbox(c: PrContext) {
	for (const pr of await tracked(c)) {
		await withLock(c, String(pr), async () => {
			let t: PrTarget | undefined;
			try {
				t = await readPr(c, pr);
				if (t.state === "closed" || t.merged) {
					const kind = await terminal(c, t);
					if (kind) emit(JSON.stringify({ pr, kind, head: t.head, url: t.url }));
					return;
				}
				const f = await facts(c, pr),
					control = await reconcile(c, f),
					recovery = await readRecovery(c, pr);
				let kind: string | undefined;
				if (f.approval.ownerNg || f.latestCheck.state === "not-approved") kind = "merge-ng";
				else if (control.slotReleasedHead === t.head) return;
				else if (recovery?.stage.startsWith("merge:")) kind = recovery.merged ? "cleanup-pending" : "merge-wait";
				else if (
					recovery ||
					f.approval.status === "incomplete" ||
					["unavailable", "missing", "mismatch"].includes(f.check.state)
				)
					kind = "incomplete";
				else if (f.approval.status === "stale-notify") kind = "stale-notify";
				else if (f.approval.status === "ready" && f.check.state === "approved") kind = "merge-ok";
				if (f.blocked)
					await infoOnce(
						c,
						t,
						[`${t.head}:protection-blocked`],
						"保護条件が不足しています。GitHub で確認してください。",
						"protection-blocked",
					);
				if (kind === "incomplete")
					await infoOnce(
						c,
						t,
						[`${t.head}:incomplete`],
						"承認依頼が未完了です。原因解消後、窓口へ再依頼してください。",
					);
				if (kind)
					emit(
						JSON.stringify({
							pr,
							kind,
							attention: f.approval.gate?.attention,
							head: t.head,
							url: f.approval.url,
							...(kind === "merge-ok" && f.check.state === "approved" ? { body: f.check.body } : {}),
						}),
					);
			} catch {
				if (t)
					await infoOnce(c, t, [`${t.head}:incomplete`], "GitHub または台帳を検証できません。復旧確認が必要です。");
				emit(JSON.stringify({ pr, kind: "incomplete", url: t?.url ?? `https://github.com/${c.repo}/pull/${pr}` }));
			}
		});
	}
}
