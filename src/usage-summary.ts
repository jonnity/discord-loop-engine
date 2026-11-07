// 集計仕様案。ClaudeのJSONLだけを入力にし、この単一ファイルを私有領域へコピーして実行できる。
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const RULES = "claude-usage-message-id-proposal-v1";
const SELF = fileURLToPath(import.meta.url);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Totals {
	input: number;
	cacheCreation: number;
	cacheRead: number;
	output: number;
	calls: number;
	averageContext: number | null;
}
interface Input {
	source: string;
	copy: string;
	hash: string;
	bytes: number;
	kind: string;
}
interface Issue {
	input: string;
	line?: number;
	reason: string;
}
interface Attribution {
	cwd: string;
	session: string;
	model: string;
	role: string;
	project: string;
	kind: string;
}
interface Call {
	usage: Totals;
	attribution: Attribution;
	at: number;
}
interface Summary {
	schemaVersion: number;
	specification: string;
	rules: string;
	complete: boolean;
	from: string;
	until: string;
	durationMs: number;
	scriptHash: string;
	manifestHash: string;
	totals: Totals;
	counts: Record<string, number>;
	groups: Record<string, Record<string, Totals>>;
}
class Failure extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function absoluteTime(value: string): number {
	if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
		throw new Failure(2, "日時には絶対時刻とタイムゾーンが必要です");
	return Date.parse(value);
}
function empty(): Totals {
	return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, calls: 0, averageContext: null };
}
function add(total: Totals, usage: Totals) {
	for (const key of ["input", "cacheCreation", "cacheRead", "output", "calls"] as const) {
		if (!Number.isSafeInteger(total[key] + usage[key])) throw new Failure(1, "整数合計が安全な範囲を超えました");
		total[key] += usage[key];
	}
	const context = total.input + total.cacheCreation + total.cacheRead;
	if (!Number.isSafeInteger(context)) throw new Failure(1, "文脈合計が安全な範囲を超えました");
	total.averageContext = total.calls ? context / total.calls : null;
}
function usageOf(value: unknown): Totals | null {
	const u = object(value);
	if (!u || u.input_tokens === undefined) return null;
	const values = [
		u.input_tokens,
		u.cache_creation_input_tokens ?? 0,
		u.cache_read_input_tokens ?? 0,
		u.output_tokens ?? 0,
	];
	if (!values.every((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return null;
	const [input = 0, cacheCreation = 0, cacheRead = 0, output = 0] = values as number[];
	if (!Number.isSafeInteger(input + cacheCreation + cacheRead)) return null;
	return { input, cacheCreation, cacheRead, output, calls: 1, averageContext: input + cacheCreation + cacheRead };
}
function flags(args: string[], required: string[]): Record<string, string> {
	const parsed: Record<string, string> = Object.create(null);
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i]?.replace(/^--/, "");
		const value = args[i + 1];
		if (
			!args[i]?.startsWith("--") ||
			!key ||
			!required.includes(key) ||
			key in parsed ||
			!value ||
			value.startsWith("--")
		)
			throw new Failure(2, "引数が不正です");
		parsed[key] = value;
	}
	if (required.some((key) => !parsed[key]))
		throw new Failure(2, `必須引数: ${required.map((key) => `--${key}`).join(" ")}`);
	return parsed;
}
function required(f: Record<string, string>, key: string): string {
	const value = f[key];
	if (!value) throw new Failure(2, "必須引数がありません");
	return value;
}
function privateDir(dir: string) {
	mkdirSync(dir, { mode: 0o700 });
}
function atomic(dir: string, name: string, contents: string | Buffer) {
	const tmp = path.join(dir, `${name}.tmp`);
	const dest = path.join(dir, name);
	writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 });
	if (digest(readFileSync(tmp)) !== digest(contents)) throw new Failure(1, "保存の再読取に失敗しました");
	if (existsSync(dest)) throw new Failure(1, "既存ファイルは上書きできません");
	renameSync(tmp, dest);
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function outputDirectory(dir: string, work: (out: string) => number): number {
	const out = path.resolve(dir);
	// 完成前のrunを成功成果物として公開しない。既存dirは空でも再利用しない。
	if (existsSync(out)) throw new Failure(1, "出力先は既に存在します");
	const parent = path.dirname(out);
	if (!lstatSync(parent).isDirectory()) throw new Failure(1, "出力先の親ディレクトリが必要です");
	privateDir(out);
	try {
		return work(out);
	} catch (error) {
		rmSync(out, { recursive: true, force: true });
		throw error;
	}
}
function snapshot(f: Record<string, string>): number {
	const from = absoluteTime(required(f, "from"));
	const until = absoluteTime(required(f, "until"));
	if (until - from !== WEEK || until > Date.now()) throw new Failure(2, "終了済みの7日間を指定してください");
	const sourceRoot = path.resolve(required(f, "claude-home"), "projects");
	if (!lstatSync(sourceRoot).isDirectory() || lstatSync(sourceRoot).isSymbolicLink())
		throw new Failure(1, "projectsを読み取れません");
	const output = path.join(
		realpathSync(path.dirname(path.resolve(required(f, "out")))),
		path.basename(required(f, "out")),
	);
	const relativeOutput = path.relative(realpathSync(sourceRoot), output);
	if (
		!relativeOutput ||
		(!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))
	)
		throw new Failure(2, "入力領域の配下へは出力できません");
	return outputDirectory(required(f, "out"), (out) => {
		const issues: Issue[] = [];
		const inputs: Input[] = [];
		const calls = new Map<string, Call>();
		const counts = {
			duplicates: 0,
			conflicts: 0,
			nonAssistant: 0,
			outsideWindow: 0,
			invalid: 0,
			unknownAttribution: 0,
		};
		const inputDir = path.join(out, "input");
		privateDir(inputDir);
		function issue(input: string, reason: string, line?: number) {
			issues.push({ input, reason, ...(line === undefined ? {} : { line }) });
			counts.invalid++;
		}
		function scan(file: string, relative: string) {
			let data: Buffer;
			try {
				const before = lstatSync(file);
				data = readFileSync(file);
				const after = lstatSync(file);
				if (
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.ino !== after.ino ||
					digest(readFileSync(file)) !== digest(data)
				)
					issue(relative, "changed-during-copy");
			} catch {
				issue(relative, "unreadable");
				return;
			}
			const name = `${inputs.length.toString().padStart(6, "0")}.jsonl`;
			atomic(inputDir, name, data);
			const kind = relative.split(path.sep).includes("subagents") ? "subagent" : "main";
			inputs.push({ source: relative, copy: `input/${name}`, bytes: data.length, hash: digest(data), kind });
			const text = data.toString("utf8");
			if (!Buffer.from(text).equals(data)) issue(relative, "invalid-utf8");
			const lines = text.split("\n");
			if (lines.at(-1) !== "") {
				issue(relative, "partial-tail", lines.length);
				lines.pop();
			}
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (!line?.trim()) continue;
				let row: Record<string, unknown> | null;
				try {
					row = object(JSON.parse(line));
				} catch {
					issue(relative, "invalid-json", index + 1);
					continue;
				}
				if (!row) {
					issue(relative, "invalid-row", index + 1);
					continue;
				}
				if (row.type !== "assistant") {
					counts.nonAssistant++;
					continue;
				}
				let at: number;
				try {
					at = absoluteTime(typeof row.timestamp === "string" ? row.timestamp : "");
				} catch {
					issue(relative, "invalid-timestamp", index + 1);
					continue;
				}
				if (at < from || at >= until) {
					counts.outsideWindow++;
					continue;
				}
				const message = object(row.message);
				const id = message?.id;
				const usage = usageOf(message?.usage);
				if (typeof id !== "string" || !id) {
					issue(relative, "missing-message-id", index + 1);
					continue;
				}
				if (!usage) {
					issue(relative, "invalid-usage", index + 1);
					continue;
				}
				const field = (value: unknown) => (typeof value === "string" && value ? value : "unknown");
				const attribution: Attribution = {
					cwd: field(row.cwd),
					session: field(row.sessionId),
					model: field(message?.model),
					role: ["worker", "concierge", "native"].includes(String(row.dleRole)) ? String(row.dleRole) : "unknown",
					project: field(row.project),
					kind,
				};
				const call = { usage, attribution, at };
				const prev = calls.get(id);
				if (prev) {
					if (
						JSON.stringify(prev.usage) === JSON.stringify(usage) &&
						JSON.stringify(prev.attribution) === JSON.stringify(attribution) &&
						new Date(prev.at).toISOString().slice(0, 10) === new Date(at).toISOString().slice(0, 10)
					)
						counts.duplicates++;
					else {
						counts.conflicts++;
						issue(relative, "conflicting-message-id", index + 1);
					}
					continue;
				}
				if (Object.values(attribution).includes("unknown")) counts.unknownAttribution++;
				calls.set(id, call);
			}
		}
		function walk(dir: string) {
			let names: string[];
			try {
				names = readdirSync(dir).sort();
			} catch {
				issue(path.relative(sourceRoot, dir), "directory-unreadable");
				return;
			}
			for (const name of names) {
				const file = path.join(dir, name);
				const relative = path.relative(sourceRoot, file);
				try {
					const info = lstatSync(file);
					if (info.isSymbolicLink()) {
						issue(relative, "symlink-excluded");
						continue;
					}
					if (info.isDirectory()) walk(file);
					else if (info.isFile() && name.endsWith(".jsonl")) scan(file, relative);
				} catch {
					issue(relative, "input-unreadable");
				}
			}
		}
		walk(sourceRoot);
		if (!inputs.length) issue("projects", "no-jsonl-inputs");
		const totals = empty();
		const groups: Summary["groups"] = Object.create(null);
		for (const name of ["project", "role", "model", "day"]) groups[name] = Object.create(null);
		for (const call of calls.values()) {
			add(totals, call.usage);
			for (const [name, key] of Object.entries({
				project: call.attribution.project,
				role: call.attribution.role,
				model: call.attribution.model,
				day: new Date(call.at).toISOString().slice(0, 10),
			})) {
				const group = groups[name];
				if (group) {
					group[key] ??= empty();
					add(group[key], call.usage);
				}
			}
		}
		const scriptHash = digest(readFileSync(SELF));
		const manifest = {
			schemaVersion: VERSION,
			specification: "proposal",
			rules: RULES,
			sourceRoot,
			scriptHash,
			inputs,
			issues,
			attribution: [...calls].map(([id, call]) => ({ id, ...call.attribution, at: new Date(call.at).toISOString() })),
		};
		const manifestText = json(manifest);
		const summary: Summary = {
			schemaVersion: VERSION,
			specification: "proposal",
			rules: RULES,
			complete: issues.length === 0,
			from: new Date(from).toISOString(),
			until: new Date(until).toISOString(),
			durationMs: WEEK,
			scriptHash,
			manifestHash: digest(manifestText),
			totals,
			counts,
			groups,
		};
		atomic(out, "manifest.json", manifestText);
		atomic(out, "summary.json", json(summary));
		atomic(
			out,
			"report.md",
			`# Claude usage 集計仕様案\n\n期間: ${summary.from} 〜 ${summary.until}（終端を含まない）\n\ncomplete: ${summary.complete}\ncache read: ${totals.cacheRead}\ncache creation: ${totals.cacheCreation}\ncalls: ${totals.calls}\n平均文脈: ${totals.averageContext ?? "不明"}\n\n帰属不明: ${counts.unknownAttribution}、競合: ${counts.conflicts}、欠測: ${issues.length}。元集計との照合前です。\n`,
		);
		return summary.complete ? 0 : 3;
	});
}

function readSummary(file: string): Summary {
	const data = object(JSON.parse(readFileSync(file, "utf8")));
	if (
		!data ||
		data.schemaVersion !== VERSION ||
		data.specification !== "proposal" ||
		data.rules !== RULES ||
		data.complete !== true ||
		data.durationMs !== WEEK ||
		typeof data.from !== "string" ||
		typeof data.until !== "string" ||
		typeof data.scriptHash !== "string" ||
		typeof data.manifestHash !== "string"
	)
		throw new Failure(3, "完備した同じ集計仕様の入力が必要です");
	if (absoluteTime(data.until) - absoluteTime(data.from) !== WEEK || absoluteTime(data.until) > Date.now())
		throw new Failure(3, "比較窓が不正です");
	const totals = object(data.totals);
	if (
		!totals ||
		!["input", "cacheCreation", "cacheRead", "output", "calls"].every(
			(key) => typeof totals[key] === "number" && Number.isSafeInteger(totals[key]) && (totals[key] as number) >= 0,
		)
	)
		throw new Failure(3, "集計値が不正です");
	const manifest = path.join(path.dirname(file), "manifest.json");
	if (digest(readFileSync(manifest)) !== data.manifestHash) throw new Failure(3, "入力manifestが一致しません");
	const inputs = object(JSON.parse(readFileSync(manifest, "utf8")))?.inputs;
	if (!Array.isArray(inputs) || inputs.length === 0) throw new Failure(3, "保存入力がありません");
	for (const value of inputs) {
		const input = object(value);
		if (!input || typeof input.copy !== "string" || !/^input\/\d+\.jsonl$/.test(input.copy))
			throw new Failure(3, "保存入力の参照が不正です");
		try {
			const bytes = readFileSync(path.join(path.dirname(file), input.copy));
			if (bytes.length !== input.bytes || digest(bytes) !== input.hash) throw new Error("changed");
		} catch {
			throw new Failure(3, "保存入力のhash/bytesが一致しません");
		}
	}
	return data as unknown as Summary;
}
function compare(f: Record<string, string>): number {
	const beforeFile = path.resolve(required(f, "before"));
	const afterFile = path.resolve(required(f, "after"));
	const before = readSummary(beforeFile);
	const after = readSummary(afterFile);
	if (
		before.scriptHash !== after.scriptHash ||
		before.scriptHash !== digest(readFileSync(SELF)) ||
		absoluteTime(before.until) > absoluteTime(after.from)
	)
		throw new Failure(3, "版または比較窓が一致しません");
	return outputDirectory(required(f, "out"), (out) => {
		const delta = after.totals.cacheRead - before.totals.cacheRead;
		const numerator = -delta;
		const denominator = before.totals.cacheRead;
		const rate = denominator === 0 ? null : numerator / denominator;
		const display = rate === null ? "算出不可（before=0）" : `${(rate * 100).toFixed(1)}%`;
		const manifestText = json({
			schemaVersion: VERSION,
			scriptHash: before.scriptHash,
			inputs: [beforeFile, afterFile].map((source) => ({
				source,
				hash: digest(readFileSync(source)),
				bytes: readFileSync(source).length,
			})),
		});
		atomic(out, "manifest.json", manifestText);
		atomic(
			out,
			"summary.json",
			json({
				schemaVersion: VERSION,
				specification: "proposal",
				comparable: true,
				rules: RULES,
				scriptHash: before.scriptHash,
				manifestHash: digest(manifestText),
				before,
				after,
				delta,
				reduction: { numerator, denominator, rate },
			}),
		);
		atomic(
			out,
			"report.md",
			`# Claude usage 比較（集計仕様案）\n\n| 指標 | before | after |\n|---|---:|---:|\n| cache read | ${before.totals.cacheRead} | ${after.totals.cacheRead} |\n| cache creation | ${before.totals.cacheCreation} | ${after.totals.cacheCreation} |\n| calls | ${before.totals.calls} | ${after.totals.calls} |\n\nbefore: [${before.from}, ${before.until})\nafter: [${after.from}, ${after.until})\n\n差: ${delta}、削減率: ${display}\n\nモデル・project・role・日別の内訳はsummary.jsonを参照。帰属不明はbefore ${before.counts.unknownAttribution} / after ${after.counts.unknownAttribution}。対象外native・稼働量・同時変更は運用者が照合してください。元集計との一致・因果・プラン制限内への到達を示すものではありません。\n`,
		);
		return 0;
	});
}

try {
	const [command, ...args] = process.argv.slice(2);
	if (command === "snapshot") process.exitCode = snapshot(flags(args, ["claude-home", "from", "until", "out"]));
	else if (command === "compare") process.exitCode = compare(flags(args, ["before", "after", "out"]));
	else throw new Failure(2, "snapshot または compare を指定してください");
} catch (error) {
	console.error(error instanceof Failure ? error.message : "集計の入出力に失敗しました");
	process.exitCode = error instanceof Failure ? error.code : 1;
}
