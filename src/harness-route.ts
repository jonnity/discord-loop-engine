import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isObject, parseStrictJson } from "./harness-json.ts";

export type ReviewRoute = "light" | "normal";
export interface FileChange {
	path: string;
	status: string;
	oldMode: string;
	newMode: string;
	before: Buffer | null;
	after: Buffer | null;
	binary?: boolean;
}
interface RawChange {
	path: string;
	status: string;
	oldMode: string;
	newMode: string;
	oldOid: string;
	newOid: string;
}
export interface RouteSnapshot {
	version: 1;
	policyVersion: 1;
	project: string;
	issue: number;
	pr?: number;
	route: ReviewRoute;
	reasons: string[];
	baseOid: string;
	mergeBaseOid: string;
	headOid: string;
	fingerprint: string;
	contentFingerprint: string;
	dirty: boolean;
	files: { path: string; status: string; category: string }[];
}
const maps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const decoder = new TextDecoder("utf-8", { fatal: true });
const blobLimit = 10 * 1024 * 1024;
const totalLimit = 50 * 1024 * 1024;

function decode(buffer: Buffer): string {
	if (buffer.length > blobLimit || buffer.includes(0)) throw Error("binary/サイズ上限");
	return decoder.decode(buffer);
}
function documentKind(p: string): "docs" | "manifest" | "lock" | "normal" {
	const parts = p.split("/");
	if (
		parts.some((part) => part.startsWith(".") || ["bin", "hooks", "skills", "agents", "templates"].includes(part)) ||
		parts.some((part) => ["CLAUDE.md", "AGENTS.md", "SKILL.md"].includes(part))
	)
		return "normal";
	const name = parts.at(-1);
	if (name === "package.json") return "manifest";
	if (name === "package-lock.json") return "lock";
	return p.endsWith(".md") || (p.startsWith("docs/") && p.endsWith(".txt")) ? "docs" : "normal";
}
function json(buffer: Buffer | null): Record<string, unknown> {
	if (!buffer) throw Error("依存ファイルの新設/削除");
	const value = parseStrictJson(decode(buffer));
	if (!isObject(value)) throw Error("依存ファイルは object が必要");
	return value;
}
function dependencyMaps(value: Record<string, unknown>): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};
	for (const key of maps) {
		const map = value[key] === undefined ? {} : value[key];
		if (!isObject(map) || Object.values(map).some((v) => typeof v !== "string" || !/^[~^]?\d+\.\d+\.\d+$/.test(v)))
			throw Error(`未知/不正な依存指定: ${key}`);
		result[key] = map as Record<string, string>;
	}
	if (value.workspaces !== undefined) throw Error("workspace は未対応");
	return result;
}
function validateLock(lock: Record<string, unknown>, manifest: Record<string, unknown>): Map<string, string> {
	if (lock.lockfileVersion !== 3 || !isObject(lock.packages) || !isObject(lock.packages[""]))
		throw Error("lock v3/root が必要");
	const root = lock.packages[""];
	if (!isDeepStrictEqual(dependencyMaps(root), dependencyMaps(manifest))) throw Error("manifest/root の依存不一致");
	for (const key of ["name", "version"]) {
		if (manifest[key] !== undefined && (root[key] !== manifest[key] || lock[key] !== manifest[key]))
			throw Error(`lock の ${key} 不一致`);
	}
	const identities = new Map<string, string>();
	const urls = new Map<string, string>();
	for (const [entryPath, entry] of Object.entries(lock.packages)) {
		if (!entryPath) continue;
		if (
			!entryPath.startsWith("node_modules/") ||
			!isObject(entry) ||
			entry.link !== undefined ||
			typeof entry.resolved !== "string" ||
			typeof entry.integrity !== "string"
		)
			throw Error("lock entry の取得元/整合性が不明");
		const url = new URL(entry.resolved);
		if (
			url.origin !== "https://registry.npmjs.org" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!url.pathname.endsWith(".tgz") ||
			url.pathname === "/.tgz" ||
			!entry.resolved.startsWith("https://registry.npmjs.org/")
		)
			throw Error("許可されていない registry URL");
		const encoded = entry.integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)?.[1];
		if (!encoded) throw Error("未知の integrity");
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length !== 64 || bytes.toString("base64") !== encoded) throw Error("不正な sha512");
		if (urls.has(entry.resolved) && urls.get(entry.resolved) !== entry.integrity)
			throw Error("同じ URL の integrity 不一致");
		urls.set(entry.resolved, entry.integrity);
		const name = typeof entry.name === "string" ? entry.name : entryPath.split("node_modules/").at(-1);
		if (typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.version))
			throw Error("lock の版が不明");
		const identity = JSON.stringify([name, entry.version, entry.resolved]);
		if (identities.has(identity) && identities.get(identity) !== entry.integrity)
			throw Error("同名/版/URL の integrity 不一致");
		identities.set(identity, entry.integrity);
	}
	return urls;
}
function validatePair(manifest: FileChange, lock: FileChange): void {
	const before = json(manifest.before),
		after = json(manifest.after);
	const oldMaps = dependencyMaps(before),
		newMaps = dependencyMaps(after);
	const other = (value: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(value).filter(([key]) => !maps.includes(key)));
	if (!isDeepStrictEqual(other(before), other(after)) || isDeepStrictEqual(oldMaps, newMaps))
		throw Error("依存 map 以外の変更/意味上の依存変更なし");
	if (Object.keys(newMaps.dependencies ?? {}).some((key) => !Object.hasOwn(oldMaps.dependencies ?? {}, key)))
		throw Error("新規 runtime dependency");
	const oldLock = lock.before ? validateLock(json(lock.before), before) : new Map<string, string>();
	const newLock = validateLock(json(lock.after), after);
	for (const [resolved, integrity] of oldLock)
		if (newLock.has(resolved) && newLock.get(resolved) !== integrity)
			throw Error("同じ resolved URL の integrity が変更された");
}

export function classifyChanges(layers: FileChange[][]): Pick<RouteSnapshot, "route" | "reasons" | "files"> {
	const reasons: string[] = [],
		files: RouteSnapshot["files"] = [];
	let size = 0;
	for (const layer of layers) {
		for (const change of layer) {
			const kind = documentKind(change.path);
			files.push({ path: change.path, status: change.status, category: kind });
			try {
				if (
					kind === "normal" ||
					!["A", "M", "D"].includes(change.status) ||
					change.binary ||
					![change.oldMode, change.newMode].every((m) => m === "000000" || m === "100644")
				)
					throw Error("禁止/不明なファイル種別・mode・status");
				if (
					(change.oldMode === "000000") !== (change.before === null) ||
					(change.newMode === "000000") !== (change.after === null) ||
					(change.status === "A" && change.oldMode !== "000000") ||
					(change.status === "D" && change.newMode !== "000000") ||
					(change.status === "M" && (change.before === null || change.after === null))
				)
					throw Error("status/mode/blob の不一致");
				for (const data of [change.before, change.after])
					if (data) {
						size += data.length;
						decode(data);
					}
				if (size > totalLimit) throw Error("全体サイズ上限");
			} catch (error) {
				reasons.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const pairs = new Map<string, { manifest?: FileChange; lock?: FileChange }>();
		for (const change of layer) {
			const kind = documentKind(change.path);
			if (kind !== "manifest" && kind !== "lock") continue;
			const dir = path.posix.dirname(change.path),
				pair = pairs.get(dir) ?? {};
			pair[kind] = change;
			pairs.set(dir, pair);
		}
		for (const [dir, pair] of pairs) {
			try {
				if (!pair.manifest || !pair.lock) throw Error("manifest/lock の片側だけの変更");
				validatePair(pair.manifest, pair.lock);
			} catch (error) {
				reasons.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (!files.length) reasons.push("empty-diff");
	return {
		route: reasons.length ? "normal" : "light",
		reasons: reasons.length ? reasons : ["文書または整合する依存対のみ"],
		files,
	};
}

export function parseClassifyArgs(args: string[]): { dir: string; pr?: number } {
	let pr: number | undefined,
		dir: string | undefined,
		positional = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!positional && a === "--") {
			positional = true;
			continue;
		}
		if (!positional && a === "--pr") {
			const value = args[++i];
			if (pr !== undefined || !value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
				throw Error("--pr は重複しない正整数が必要です");
			pr = Number(value);
			continue;
		}
		if (!a || (!positional && a.startsWith("-")) || dir !== undefined) throw Error("未知 option/余分な dir");
		dir = a;
	}
	return { dir: dir ?? process.cwd(), ...(pr === undefined ? {} : { pr }) };
}
export function parseRawDiff(raw: Buffer): RawChange[] {
	if (!raw.length) return [];
	const chunks = decoder.decode(raw).split("\0");
	if (chunks.pop() !== "" || chunks.length % 2) throw Error("不正な raw/NUL diff");
	const result: RawChange[] = [];
	for (let i = 0; i < chunks.length; i += 2) {
		const header = chunks[i]?.match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDUTX])$/);
		const p = chunks[i + 1];
		if (!header || !p) throw Error("不正な raw diff status/path");
		result.push({
			path: p,
			oldMode: header[1] ?? "",
			newMode: header[2] ?? "",
			oldOid: header[3] ?? "",
			newOid: header[4] ?? "",
			status: header[5] ?? "",
		});
	}
	return result;
}

export function routeTransition(
	previous: ReviewRoute,
	current: ReviewRoute,
	promoted: boolean,
): { route: ReviewRoute; promoted: boolean } {
	const fixed = promoted || (previous === "light" && current === "normal");
	return { route: fixed ? "normal" : current, promoted: fixed };
}
export function reviewMatches(
	receipt: unknown,
	snapshot: Pick<RouteSnapshot, "project" | "issue" | "fingerprint" | "route">,
): boolean {
	return (
		isObject(receipt) &&
		receipt.version === 1 &&
		receipt.project === snapshot.project &&
		receipt.issue === snapshot.issue &&
		receipt.fingerprint === snapshot.fingerprint &&
		receipt.route === snapshot.route &&
		receipt.reviewer === "verifier" &&
		receipt.verdict === "OK" &&
		typeof receipt.model === "string" &&
		!!receipt.model.trim() &&
		typeof receipt.artifact === "string" &&
		!!receipt.artifact.trim()
	);
}
const hash = (parts: (string | Buffer)[]) => {
	const digest = createHash("sha256");
	for (const p of parts) {
		const bytes = Buffer.from(p);
		digest.update(`${bytes.length}:`);
		digest.update(bytes);
	}
	return digest.digest("hex");
};

// 子を専用 PG に置き、中断と時間切れでは所有するプロセスだけを止める。
function command(cmd: string, args: string[], cwd: string, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(Error("分類を中断しました"));
			return;
		}
		const child = spawn(cmd, args, {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0,
			stderr = "",
			failure: Error | undefined;
		const stop = () => {
			failure ??= Error("分類を中断しました");
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
		};
		signal.addEventListener("abort", stop, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			size += data.length;
			if (size > totalLimit + blobLimit) {
				failure = Error("分類出力のサイズ上限");
				stop();
			} else chunks.push(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			if (stderr.length < 2000) stderr += data.toString();
		});
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", stop);
			if (failure || code !== 0) reject(failure ?? Error(`${cmd} の取得失敗: ${stderr.trim()}`));
			else resolve(Buffer.concat(chunks));
		});
	});
}

export async function classifyRepository(
	dir: string,
	pr?: number,
	signal = AbortSignal.timeout(30000),
): Promise<RouteSnapshot> {
	const cwd = path.resolve(dir);
	const git = (...args: string[]) =>
		command("git", ["-c", "diff.renames=false", "-c", "core.filemode=true", ...args], cwd, signal);
	const string = async (...args: string[]) => decoder.decode(await git(...args)).trim();
	const top = await string("rev-parse", "--show-toplevel");
	if (path.resolve(top) !== cwd) return classifyRepository(top, pr, signal);
	const configPath = decoder
		.decode(await command(path.resolve(import.meta.dirname, "../bin/harness-config"), ["--path"], cwd, signal))
		.trim();
	let config: Record<string, unknown> = {};
	try {
		config = json(await readFile(configPath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RouteConfigError(`設定不正: ${String(error)}`);
	}
	if (
		config.baseBranch !== undefined &&
		(typeof config.baseBranch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.baseBranch))
	)
		throw new RouteConfigError("baseBranch が不正です");
	const baseBranch = typeof config.baseBranch === "string" ? config.baseBranch : "main";
	const head = await string("rev-parse", "--verify", "HEAD^{commit}");
	let base: string,
		metadata = "",
		refusal = "";
	async function remote(): Promise<string> {
		if (pr !== undefined) {
			const raw = await command(
				"gh",
				["pr", "view", String(pr), "--json", "headRefOid,baseRefOid,baseRefName,isCrossRepository,state"],
				cwd,
				signal,
			);
			const data = json(raw);
			if (
				typeof data.headRefOid !== "string" ||
				!/^[a-f0-9]{40,64}$/.test(data.headRefOid) ||
				typeof data.baseRefOid !== "string" ||
				!/^[a-f0-9]{40,64}$/.test(data.baseRefOid) ||
				typeof data.baseRefName !== "string" ||
				typeof data.isCrossRepository !== "boolean" ||
				typeof data.state !== "string"
			)
				throw Error("PR metadata が不正です");
			if (data.headRefOid !== head || data.isCrossRepository || data.state !== "OPEN")
				refusal = "PR head 不一致/fork/非 OPEN";
			return JSON.stringify(data);
		}
		const raw = await string("ls-remote", "--exit-code", "origin", `refs/heads/${baseBranch}`);
		const oid = raw.split(/\s/)[0];
		if (!oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw Error("remote base の鮮度不明");
		return oid;
	}
	metadata = await remote();
	if (pr !== undefined) base = (JSON.parse(metadata) as { baseRefOid: string }).baseRefOid;
	else {
		base = await string("rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`);
		if (base !== metadata) refusal = "origin/base が未更新";
	}
	if ((await string("rev-parse", "--is-shallow-repository")) !== "false") refusal = "浅い履歴";
	const bases = (await string("merge-base", "--all", base, head)).split("\n");
	const mergeBase = bases[0] ?? "";
	if (bases.length !== 1) refusal = "複数 merge-base";
	async function snapshot() {
		const rawLayers: Buffer[] = [],
			layers: FileChange[][] = [];
		const statParts: string[] = [];
		let bytesRead = 0;
		// assume-unchanged/sparse の隠れた WT 差分を省略の根拠にしない。
		const indexFlags = await git("ls-files", "-v", "-z");
		rawLayers.push(indexFlags);
		if (
			decoder
				.decode(indexFlags)
				.split("\0")
				.filter(Boolean)
				.some((entry) => !entry.startsWith("H "))
		)
			refusal = "index の除外/競合フラグ";
		const content = new Map<string, string>();
		const tree = await git("ls-tree", "-r", "-z", head);
		for (const entry of decoder.decode(tree).split("\0").filter(Boolean)) {
			const match = entry.match(/^(\d{6}) \w+ ([a-f0-9]+)\t([\s\S]+)$/);
			if (!match?.[1] || !match[2] || !match[3]) throw Error("tree 解析失敗");
			content.set(match[3], `${match[1]}:${match[2]}`);
		}
		const definitions = [[mergeBase, head], ["--cached", head], []];
		for (let index = 0; index < definitions.length; index++) {
			const def = definitions[index] ?? [];
			const options = ["--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"];
			const raw = await git("diff", "--raw", "--no-abbrev", "-z", ...options, ...def, "--");
			rawLayers.push(raw);
			const nums = decoder
				.decode(await git("diff", "--numstat", "-z", ...options, ...def, "--"))
				.split("\0")
				.filter(Boolean);
			const binaries = new Set(nums.filter((row) => row.startsWith("-\t-\t")).map((row) => row.slice(4)));
			const layer: FileChange[] = [];
			for (const row of parseRawDiff(raw)) {
				const blob = async (oid: string, mode: string): Promise<Buffer | null> => {
					if (/^0+$/.test(oid) || mode !== "100644") return null;
					const size = Number(await string("cat-file", "-s", oid));
					if (!Number.isSafeInteger(size) || size > blobLimit || bytesRead + size > totalLimit) {
						refusal = "blob サイズ上限";
						return null;
					}
					bytesRead += size;
					return git("cat-file", "blob", oid);
				};
				const before = await blob(row.oldOid, row.oldMode);
				let after: Buffer | null;
				if (index === 2 && row.newMode !== "000000") after = await workFile(row.path);
				else after = await blob(row.newOid, row.newMode);
				layer.push({ ...row, before, after, binary: binaries.has(row.path) });
				if (index > 0) {
					if (row.newMode === "000000") content.delete(row.path);
					else content.set(row.path, `${row.newMode}:${index === 2 && after ? blobOid(after) : row.newOid}`);
				}
			}
			layers.push(layer);
		}
		async function workFile(p: string): Promise<Buffer | null> {
			const parts = p.split("/");
			for (let i = 1; i <= parts.length; i++) {
				const stat = await lstat(path.join(cwd, ...parts.slice(0, i)));
				statParts.push(JSON.stringify([p, i, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]));
				if (
					stat.isSymbolicLink() ||
					(i === parts.length && (!stat.isFile() || stat.size > blobLimit || bytesRead + stat.size > totalLimit))
				) {
					refusal = "symlink/非通常ファイル/サイズ上限";
					return null;
				}
			}
			const data = await readFile(path.join(cwd, p));
			bytesRead += data.length;
			if (data.length > blobLimit || bytesRead > totalLimit) {
				refusal = "ファイルサイズ上限";
				return null;
			}
			return data;
		}
		function blobOid(data: Buffer) {
			const algo = head.length === 64 ? "sha256" : "sha1";
			return createHash(algo).update(`blob ${data.length}\0`).update(data).digest("hex");
		}
		const untracked = await git("ls-files", "--others", "--exclude-standard", "-z");
		rawLayers.push(untracked);
		const untrackedLayer: FileChange[] = [];
		for (const p of decoder.decode(untracked).split("\0").filter(Boolean)) {
			const data = await workFile(p);
			const stat = await lstat(path.join(cwd, p));
			const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
			untrackedLayer.push({ path: p, status: "A", oldMode: "000000", newMode: mode, before: null, after: data });
			content.set(p, `${mode}:${data ? blobOid(data) : "unknown"}`);
		}
		layers.push(untrackedLayer);
		const fingerprint = hash([
			"1",
			base,
			mergeBase,
			head,
			...rawLayers,
			...layers.flatMap((layer) => layer.flatMap((f) => [f.path, f.oldMode, f.newMode, f.before ?? "", f.after ?? ""])),
		]);
		const contentFingerprint = hash([...content.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flat());
		return {
			layers,
			fingerprint,
			contentFingerprint,
			statFingerprint: hash(statParts),
			dirty: layers.slice(1).some((layer) => layer.length),
		};
	}
	const first = await snapshot();
	const second = await snapshot();
	if (
		first.fingerprint !== second.fingerprint ||
		first.statFingerprint !== second.statFingerprint ||
		(await string("rev-parse", "HEAD")) !== head ||
		(await remote()) !== metadata
	)
		throw Error("分類中に HEAD/base/index/作業ファイルが変化しました。再判定してください");
	if (
		pr === undefined &&
		(await string("rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`)) !== base
	)
		throw Error("分類中に origin/base が変化しました");
	const classified = classifyChanges(first.layers);
	if (refusal) {
		classified.route = "normal";
		classified.reasons.push(refusal);
	}
	return {
		version: 1,
		policyVersion: 1,
		project: process.env.DLE_PROJECT || (typeof config.project === "string" ? config.project : path.basename(cwd)),
		issue: 0,
		...(pr === undefined ? {} : { pr }),
		...classified,
		baseOid: base,
		mergeBaseOid: mergeBase,
		headOid: head,
		fingerprint: first.fingerprint,
		contentFingerprint: first.contentFingerprint,
		dirty: first.dirty,
	};
}

class RouteConfigError extends Error {}
async function cli() {
	let options: ReturnType<typeof parseClassifyArgs>;
	try {
		options = parseClassifyArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`harness-gate: ${String(error)}\n`);
		process.exitCode = 2;
		return;
	}
	const controller = new AbortController();
	let exitCode = 3;
	const handlers = (["SIGHUP", "SIGINT", "SIGTERM"] as const).map((signal, i) => {
		const handler = () => {
			exitCode = [129, 130, 143][i] ?? 3;
			controller.abort();
		};
		process.on(signal, handler);
		return { signal, handler };
	});
	const timer = setTimeout(() => controller.abort(), 30000);
	try {
		const result = await classifyRepository(options.dir, options.pr, controller.signal);
		if (controller.signal.aborted) throw Error("分類中断/時間切れ");
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(`harness-gate: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = error instanceof RouteConfigError ? 2 : exitCode;
	} finally {
		clearTimeout(timer);
		for (const { signal, handler } of handlers) process.off(signal, handler);
	}
}
if (process.argv[1] === import.meta.filename) await cli();
