// 保存済みsnapshotだけを読み、開始行のキーとtool_useで心拍消費を見積もる。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isObject } from "./harness-json.ts";
import { displayTokens, summarizeUsage } from "./harness-usage.ts";

type Trigger = "heartbeat" | "wake_or_manual" | "unknown";
type Category = "heartbeat-idle" | "heartbeat-active" | "wake_or_manual" | "unknown" | "out-of-scope";
type Usage = { input: number; cacheCreation: number; cacheRead: number; output: number };
type SessionRef = { sessionId: string; cwd: string; project: string };
interface Snapshot {
	from: string;
	until: string;
	complete: boolean;
	counts: Record<string, number>;
	inputs: { kind: string; text: string }[];
}
interface Tick {
	id: string;
	start: number;
	end: number;
	trigger: Trigger;
	origin: Record<string, unknown>;
	inScope: boolean;
	attributed: boolean;
	work: boolean;
	complete: boolean;
	damaged: boolean;
	mixed: boolean;
}
interface Call {
	id: string;
	project: string;
	role: "tick";
	model: string;
	timestamp: string;
	usage: Usage;
}
interface Candidate {
	call: Call;
	tick: Tick | undefined;
	at: number;
	inScope: boolean;
	identity: unknown;
	reasons: string[];
}
const categories: Category[] = ["heartbeat-idle", "heartbeat-active", "wake_or_manual", "unknown", "out-of-scope"];
const command = "<command-name>/discord-loop-engine:issue-loop</command-name>";
const explanations = [
	"unknownの件数・量・理由を確認する。帰属不明・キー欠損・応答未完了は主集計から外れるので心拍idle量が小さく出得る。",
	"Bashの作業入口はharness-prのinbox/scan以外のサブコマンド、--helpを付けないharness-phase / harness-codex（harness-codex-statusを除く）/ harness-merge / harness-notify / harness-gate、gh issue/pr comment。harnessコマンドの--helpと読取りはidleを妨げない。",
	"次の開始行までにcompact要約を除くhuman起点またはキー無しのuser行が入る混在tickでは、新ターン後の作業は heartbeat-active に移り、作業の無い手入力の分は heartbeat-idle に足される。両方向の誤差は混在tick欄を参照する（主集計の内数であり加算しない）。",
	"MCP・Agentのツール名のcomment/merge部分一致は実データでは当たらず、作業ありの判定は実質 Bash の検出だけである。dleのreportツールは作業ありに数えないため見逃しになる（reportのみでidle=trueになるtickが実データにある）。",
	"指定外の作業の見逃しとcommand中の文字列一致による除外があり、実作業の完全な証明ではない。human起点はengineと手入力を分けずwake_or_manualにまとめる。",
	"元snapshotは同ID競合の先頭を残すが、本集計はtick帰属も含む競合IDを全除外する。元snapshotの件数と完全一致するとは限らない。context外のsessionはout-of-scope欄に件数・量を出し、unknownとcoverageCompleteには含めない。subagentとconcierge/nativeは対象外。プラン制限や削減率には換算しない。",
];
class Failure extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}
function time(value: unknown): number {
	return typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : Number.NaN;
}
function sessionsOf(value: unknown): SessionRef[] {
	if (!isObject(value) || !Array.isArray(value.sessions)) throw new Failure(2, "context.sessions が必要です");
	const sessions: SessionRef[] = [];
	const seen = new Map<string, string>();
	for (const item of value.sessions) {
		if (!isObject(item) || ![item.sessionId, item.cwd, item.project].every((s) => typeof s === "string" && s))
			throw new Failure(2, "sessionId/cwd/project が必要です");
		const ref = item as unknown as SessionRef;
		if (!path.isAbsolute(ref.cwd)) throw new Failure(2, "cwd は絶対パスが必要です");
		const normalized = { ...ref, cwd: path.resolve(ref.cwd) };
		const key = JSON.stringify([ref.sessionId, normalized.cwd]);
		if (seen.has(key) && seen.get(key) !== ref.project) throw new Failure(2, "sessionの帰属が競合しています");
		seen.set(key, ref.project);
		sessions.push(normalized);
	}
	return sessions;
}
function usageOf(value: unknown): Usage | null {
	if (!isObject(value) || value.input_tokens === undefined) return null;
	const usage = {
		input: value.input_tokens,
		cacheCreation: value.cache_creation_input_tokens ?? 0,
		cacheRead: value.cache_read_input_tokens ?? 0,
		output: value.output_tokens ?? 0,
	};
	return Object.values(usage).every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
		? (usage as Usage)
		: null;
}
function contentOf(row: Record<string, unknown>): unknown {
	return isObject(row.message) ? row.message.content : undefined;
}
function userText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
		: "";
}
function toolResult(content: unknown): boolean {
	return Array.isArray(content) && content.some((b) => isObject(b) && b.type === "tool_result");
}
function workOf(content: unknown): { work: boolean; damaged: boolean } {
	let work = false,
		damaged = false;
	if (!Array.isArray(content)) return { work, damaged: typeof content !== "string" };
	for (const block of content) {
		if (!isObject(block)) {
			damaged = true;
			continue;
		}
		if (block.type !== "tool_use") continue;
		if (typeof block.name !== "string" || !isObject(block.input)) {
			damaged = true;
			continue;
		}
		if (block.name === "Bash") {
			if (typeof block.input.command !== "string") {
				damaged = true;
				continue;
			}
			// --helpは同じ単純コマンドだけに適用し、後続の作業コマンドを隠さない。
			for (const part of block.input.command.split(/[;&|\n]+/)) {
				if (/\bgh\s+(?:issue|pr)\s+comment\b/.test(part)) work = true;
				if (/(?:^|\s)--help(?:\s|\)|$)/.test(part)) continue;
				if (/(?:^|[\s/(])harness-(?:phase|codex|merge|notify|gate)(?=[\s)]|$)/.test(part)) work = true;
				if (/(?:^|[\s/(])harness-pr\s+(?!(?:inbox|scan)(?=[\s)]|$))[a-z][\w-]*(?=[\s)]|$)/.test(part)) work = true;
			}
		} else if (/^(?:mcp(?:__|_)|Agent)/i.test(block.name) && /comment|merge/i.test(block.name)) work = true;
	}
	return { work, damaged };
}
function categoryOf(tick: Tick | undefined): Category {
	if (tick && !tick.inScope) return "out-of-scope";
	if (!tick || !tick.attributed) return "unknown";
	if (tick.trigger === "wake_or_manual") return "wake_or_manual";
	if (tick.trigger === "unknown" || tick.damaged || !tick.complete) return "unknown";
	return tick.work ? "heartbeat-active" : "heartbeat-idle";
}
function tickReasons(tick: Tick): string[] {
	return [
		...(!tick.attributed ? ["unknown-attribution"] : []),
		...(!Number.isFinite(tick.start) ? ["invalid-time"] : []),
		...(tick.trigger === "unknown" ? ["unknown-trigger"] : []),
		...(tick.damaged ? ["damaged-input"] : []),
		...(!tick.complete ? ["incomplete-response"] : []),
	];
}

export function summarizeIdleUsage(snapshot: Snapshot, context: unknown) {
	const from = time(snapshot.from),
		until = time(snapshot.until);
	if (
		!Number.isFinite(from) ||
		!Number.isFinite(until) ||
		from >= until ||
		typeof snapshot.complete !== "boolean" ||
		!Array.isArray(snapshot.inputs)
	)
		throw new Failure(2, "snapshot の期間/構造が不正です");
	const sessions = sessionsOf(context);
	const refs = new Map<string, SessionRef[]>();
	for (const session of sessions) {
		const list = refs.get(session.sessionId) ?? [];
		list.push(session);
		refs.set(session.sessionId, list);
	}
	for (const list of refs.values()) list.sort((a, b) => b.cwd.length - a.cwd.length);
	const ticks: Tick[] = [],
		candidates: Candidate[] = [];
	const diagnostics = {
		duplicates: 0,
		conflicts: 0,
		invalid: 0,
		inputMissing: 0,
		outside: 0,
		excluded: 0,
		outOfScopeInvalid: 0,
		outOfScopeConflicts: 0,
		reasons: {} as Record<string, { ticks: number; calls: number }>,
	};
	const reason = (key: string) => {
		diagnostics.reasons[key] ??= { ticks: 0, calls: 0 };
		return diagnostics.reasons[key];
	};
	for (const input of snapshot.inputs) {
		if (input.kind !== "main") continue;
		if (typeof input.text !== "string") throw new Failure(2, "inputコピーの構造が不正です");
		const current = new Map<string, Tick>();
		const damage = () => {
			diagnostics.inputMissing++;
			for (const tick of current.values()) tick.damaged = true;
		};
		const rows = input.text.split("\n");
		const partial = rows.pop();
		if (partial) diagnostics.inputMissing++;
		for (const line of rows) {
			if (!line.trim()) continue;
			let row: Record<string, unknown>;
			try {
				const value: unknown = JSON.parse(line);
				if (!isObject(value)) throw Error();
				row = value;
			} catch {
				damage();
				continue;
			}
			if (row.isSidechain === true || row.dleRole === "concierge" || row.dleRole === "native") {
				diagnostics.excluded++;
				continue;
			}
			const cwd = typeof row.cwd === "string" && path.isAbsolute(row.cwd) ? path.resolve(row.cwd) : null;
			if (row.type === "user" && row.isCompactSummary === true) continue;
			const key = typeof row.sessionId === "string" ? row.sessionId : "";
			const sessionRefs = refs.get(key);
			const inScope = sessionRefs !== undefined;
			const project = sessionRefs?.find((ref) => {
				if (!cwd) return false;
				const relative = path.relative(ref.cwd, cwd);
				return (
					relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
				);
			})?.project;
			const at = time(row.timestamp);
			const content = contentOf(row);
			let tick = current.get(key);
			const isStart =
				row.type === "user" &&
				row.isMeta !== true &&
				!toolResult(content) &&
				!["peer", "task_notification", "auto_continuation"].includes(String(row.turnOrigin)) &&
				!userText(content).includes('<channel source="dle">') &&
				userText(content).includes(command);
			if (isStart) {
				if (tick) tick.end = Number.isFinite(at) ? Math.min(at, until) : tick.end;
				const trigger: Trigger =
					row.turnOrigin === "scheduled" || Object.hasOwn(row, "scheduledTaskId")
						? "heartbeat"
						: row.turnOrigin === "human"
							? "wake_or_manual"
							: "unknown";
				tick = {
					id: JSON.stringify([key, Number.isFinite(at) ? new Date(at).toISOString() : row.timestamp]),
					start: at,
					end: until,
					trigger,
					origin: row,
					inScope,
					attributed: project !== undefined,
					work: false,
					complete: false,
					damaged: !Number.isFinite(at),
					mixed: false,
				};
				current.set(key, tick);
				ticks.push(tick);
			} else if (tick && row.type === "user" && (!Number.isFinite(at) || at < until)) {
				if (
					row.isMeta !== true &&
					!toolResult(content) &&
					(row.turnOrigin === "human" || !Object.hasOwn(row, "turnOrigin"))
				)
					tick.mixed = true;
			}
			if (tick && (project !== undefined || !inScope) && (!Number.isFinite(at) || at < until)) {
				if (!Number.isFinite(at)) tick.damaged = true;
				if (row.type === "user") tick.complete = false;
				if (row.type === "assistant") {
					const result = workOf(content);
					tick.work ||= result.work;
					tick.damaged ||= result.damaged;
					tick.complete =
						isObject(row.message) &&
						(row.message.stop_reason === "end_turn" || row.message.stop_reason === "stop_sequence");
				}
			}
			if (row.type !== "assistant") continue;
			const message = isObject(row.message) ? row.message : {};
			const usage = usageOf(message.usage);
			if (!usage || typeof message.id !== "string" || !message.id) {
				if (inScope) diagnostics.invalid++;
				else diagnostics.outOfScopeInvalid++;
				if (tick) tick.damaged = true;
				continue;
			}
			const reasons = [
				...(!project ? ["unknown-attribution"] : []),
				...(!tick ? ["missing-tick"] : []),
				...(!Number.isFinite(at) ? ["invalid-time"] : []),
			];
			candidates.push({
				tick,
				at,
				inScope,
				reasons: inScope ? reasons : [],
				identity: [key, tick?.id, project, message.model, usage],
				call: {
					id: message.id,
					project: project ?? "unknown",
					role: "tick",
					model: typeof message.model === "string" && message.model ? message.model : "unknown",
					// 時刻不明のusageもunknown欄へ残す。帰属の判断にはこの補助時刻を使わない。
					timestamp: new Date(Number.isFinite(at) ? at : from).toISOString(),
					usage,
				},
			});
		}
		if (partial) for (const tick of current.values()) tick.damaged = true;
	}
	// 分類と期間の選別より先に全候補の競合を除く。除外側の同IDも照合する。
	const unique = new Map<string, Candidate>(),
		conflicts = new Set<string>();
	for (const candidate of candidates) {
		const id = JSON.stringify([candidate.inScope, candidate.call.id]);
		if (conflicts.has(id)) continue;
		const previous = unique.get(id);
		if (!previous) unique.set(id, candidate);
		else if (
			isDeepStrictEqual(
				[previous.identity, previous.tick?.trigger, categoryOf(previous.tick)],
				[candidate.identity, candidate.tick?.trigger, categoryOf(candidate.tick)],
			)
		)
			diagnostics.duplicates++;
		else {
			conflicts.add(id);
			if (candidate.inScope) diagnostics.conflicts++;
			else diagnostics.outOfScopeConflicts++;
			unique.delete(id);
		}
	}
	const originKeys = {
		total: 0,
		scheduledFull: 0,
		scheduledOriginOnly: 0,
		scheduledOther: 0,
		human: 0,
		humanOriginKind: 0,
		humanWithoutOriginKind: 0,
		missing: 0,
		other: 0,
	};
	const relevantTicks = [
		...new Map(
			ticks.filter((t) => Number.isFinite(t.start) && t.start < until && t.end > from).map((tick) => [tick.id, tick]),
		).values(),
	];
	for (const tick of relevantTicks) {
		if (!tick.inScope) continue;
		originKeys.total++;
		const o = tick.origin;
		if (tick.trigger === "heartbeat") {
			if (
				o.turnOrigin === "scheduled" &&
				Object.hasOwn(o, "scheduledTaskId") &&
				Object.hasOwn(o, "scheduledFireId") &&
				o.wakeupSource === "schedule_wakeup"
			)
				originKeys.scheduledFull++;
			else if (o.turnOrigin === "scheduled" && !Object.hasOwn(o, "scheduledTaskId")) originKeys.scheduledOriginOnly++;
			else originKeys.scheduledOther++;
		} else if (tick.trigger === "wake_or_manual") {
			originKeys.human++;
			if (isObject(o.origin) && o.origin.kind === "human") originKeys.humanOriginKind++;
			else originKeys.humanWithoutOriginKind++;
		} else if (!Object.hasOwn(o, "turnOrigin") && !Object.hasOwn(o, "scheduledTaskId")) originKeys.missing++;
		else originKeys.other++;
		for (const r of tickReasons(tick)) reason(r).ticks++;
	}
	const selected: { candidate: Candidate; category: Category }[] = [];
	for (const candidate of unique.values()) {
		if (Number.isFinite(candidate.at) && (candidate.at < from || candidate.at >= until)) {
			diagnostics.outside++;
			continue;
		}
		const reasons = [...new Set([...candidate.reasons, ...(candidate.tick ? tickReasons(candidate.tick) : [])])];
		if (candidate.inScope) for (const r of reasons) reason(r).calls++;
		const category = !candidate.inScope
			? "out-of-scope"
			: candidate.reasons.length
				? "unknown"
				: categoryOf(candidate.tick);
		selected.push({ candidate, category });
	}
	const projects = new Set([...sessions.map((s) => s.project), "unknown"]);
	function aggregate(category: Category, mixed = false) {
		const rows = selected
			.filter((s) => s.category === category && (!mixed || s.candidate.tick?.mixed))
			.map((s) => s.candidate.call);
		const summary = summarizeUsage(rows, projects, new Date(from).toISOString(), new Date(until).toISOString());
		const t = summary.totals;
		return {
			ticks: relevantTicks.filter((t) => categoryOf(t) === category && (!mixed || t.mixed)).length,
			calls: summary.count,
			...t,
			averageContext: summary.count ? Math.round((t.input + t.cacheCreation + t.cacheRead) / summary.count) : null,
			groups: summary.groups,
		};
	}
	return {
		schemaVersion: 1,
		rules: "heartbeat-start-keys-v1",
		from: new Date(from).toISOString(),
		until: new Date(until).toISOString(),
		snapshot: { complete: snapshot.complete, counts: snapshot.counts },
		coverageComplete:
			snapshot.complete &&
			!diagnostics.invalid &&
			!diagnostics.inputMissing &&
			!diagnostics.conflicts &&
			!Object.keys(diagnostics.reasons).length,
		categories: Object.fromEntries(categories.map((c) => [c, aggregate(c)])) as Record<
			Category,
			ReturnType<typeof aggregate>
		>,
		mixed: {
			"heartbeat-idle": aggregate("heartbeat-idle", true),
			"heartbeat-active": aggregate("heartbeat-active", true),
		},
		originKeys,
		diagnostics,
		explanations,
	};
}

export function idleMarkdown(report: ReturnType<typeof summarizeIdleUsage>): string {
	const tableText = (s: string) => s.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
	const rows = Object.entries(report.categories).map(([k, v]) => [k, v] as const);
	rows.push(...Object.entries(report.mixed).map(([k, v]) => [`混在tick ${k}（内数）`, v] as const));
	const lines = [
		"# worker 心拍使用量の見積もり",
		"",
		`期間: ${report.from} 〜 ${report.until}（終端を含まない）`,
		`規則: ${report.rules} / 元snapshot complete: ${report.snapshot.complete} / 分類範囲 complete: ${report.coverageComplete}`,
		"",
		"| 分類 | tick | call | input | cache creation | cache read | output | 平均文脈 |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
		...rows.map(
			([k, v]) =>
				`| ${k} | ${v.ticks} | ${v.calls} | ${displayTokens(v.input)} | ${displayTokens(v.cacheCreation)} | ${displayTokens(v.cacheRead)} | ${displayTokens(v.output)} | ${v.averageContext ?? "不明"} |`,
		),
		"",
		"project/model別内訳（tokenは整数）:",
		"",
		"| 分類 | project | model | call | input | cache creation | cache read | output |",
		"|---|---|---|---:|---:|---:|---:|---:|",
		...rows.flatMap(([k, v]) =>
			v.groups.map(
				(g) =>
					`| ${k} | ${tableText(g.project)} | ${tableText(g.model)} | ${g.count} | ${g.usage.input} | ${g.usage.cacheCreation} | ${g.usage.cacheRead} | ${g.usage.output} |`,
			),
		),
		"",
		"起点キーの形式別件数:",
		...Object.entries(report.originKeys).map(([k, v]) => `- ${k}: ${v}`),
		"",
		"unknown・欠落の理由（重複し得る）:",
		...Object.entries(report.diagnostics.reasons).map(([k, v]) => `- ${k}: tick=${v.ticks}, call=${v.calls}`),
		`- 重複=${report.diagnostics.duplicates}, 競合ID全除外=${report.diagnostics.conflicts}, 不正usage/id=${report.diagnostics.invalid}, 入力欠損=${report.diagnostics.inputMissing}, 期間外=${report.diagnostics.outside}, 対象外行=${report.diagnostics.excluded}, context外不正usage/id=${report.diagnostics.outOfScopeInvalid}, context外競合ID全除外=${report.diagnostics.outOfScopeConflicts}`,
		`- 元snapshot件数: ${JSON.stringify(report.snapshot.counts)}`,
		"",
		...report.explanations.map((s) => `- ${s}`),
		"",
	];
	return lines.join("\n");
}
function read(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		throw new Failure(1, "入力ファイルを読めません");
	}
}
function json(file: string): unknown {
	try {
		return JSON.parse(read(file));
	} catch (error) {
		if (error instanceof Failure) throw error;
		throw new Failure(2, "JSON構造が不正です");
	}
}
function cli(args: string[]): void {
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i],
			value = args[i + 1];
		if (
			!key ||
			!["--snapshot", "--context", "--format"].includes(key) ||
			flags.has(key) ||
			!value ||
			value.startsWith("--")
		)
			throw new Failure(2, "引数が不正です");
		flags.set(key, value);
	}
	const dir = flags.get("--snapshot"),
		context = flags.get("--context"),
		format = flags.get("--format");
	if (!dir || !context || !format || !["json", "markdown"].includes(format))
		throw new Failure(2, "--snapshot --context --format json|markdown が必要です");
	const summary = json(path.join(dir, "summary.json")),
		manifest = json(path.join(dir, "manifest.json"));
	if (
		!isObject(summary) ||
		!isObject(manifest) ||
		!Array.isArray(manifest.inputs) ||
		typeof summary.from !== "string" ||
		typeof summary.until !== "string" ||
		typeof summary.complete !== "boolean" ||
		!isObject(summary.counts)
	)
		throw new Failure(2, "snapshot構造が不正です");
	const inputs: Snapshot["inputs"] = [];
	for (const input of manifest.inputs) {
		if (!isObject(input) || typeof input.copy !== "string" || !["main", "subagent"].includes(String(input.kind)))
			throw new Failure(2, "manifest.inputs が不正です");
		if (input.kind === "main") inputs.push({ kind: "main", text: read(path.resolve(dir, input.copy)) });
	}
	const report = summarizeIdleUsage(
		{
			from: summary.from,
			until: summary.until,
			complete: summary.complete,
			counts: summary.counts as Record<string, number>,
			inputs,
		},
		json(context),
	);
	process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : idleMarkdown(report));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		cli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "集計に失敗しました"}\n`);
		process.exitCode = error instanceof Failure ? error.code : 1;
	}
}
