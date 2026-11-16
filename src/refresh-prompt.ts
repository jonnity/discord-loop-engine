// 実機で実入力との識別を確認するまで、薄い文字を空欄として扱わない。
// 診断は入力欄の構造と数値属性だけを保存し、生captureはメモリから出さない。
import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Tmux } from "./supervisor.ts";

export type PromptState = "empty" | "ghost-only" | "typed" | "unknown";
export type PromptReason =
	| "strict-empty"
	| "real-input"
	| "unrecognized-layout"
	| "unrecognized-style"
	| "unrecognized-control"
	| "unstable"
	| "capture-failed";

export interface PromptEvidence {
	state: PromptState;
	reason: PromptReason;
}

interface Geometry {
	width: number;
	height: number;
	x: number;
	y: number;
}
interface MaskedSpan {
	kind: "blank" | "masked";
	columns: number;
	dim: boolean;
	foreground: number[];
	attributes: number[];
}
export interface PromptSample extends PromptEvidence {
	schemaVersion: 1;
	at: number;
	tmuxVersion: string;
	width: number;
	height: number;
	cursor: { x: number; relativeRow: number } | null;
	frame: "recognized" | "unknown";
	spans: MaskedSpan[][];
	oldEmpty: boolean;
}

export function strictEmptyPrompt(pane: string): boolean {
	const lines = pane.split("\n").slice(-15);
	const index = lines.findLastIndex((line) => /^\s*❯/.test(line));
	if (index < 0 || !/^\s*❯\s*$/.test(lines[index] ?? "")) return false;
	// 区切り線より上に続きの入力があれば、先頭行が空でも割り込まない。
	const below = lines.slice(index + 1);
	const divider = below.findIndex((line) => /^\s*[─━-]{3,}\s*$/.test(line));
	return (divider < 0 ? below : below.slice(0, divider)).every((line) => !line.trim());
}

export function inspectPrompt(pane: string): PromptEvidence {
	if (strictEmptyPrompt(pane)) return { state: "empty", reason: "strict-empty" };
	if (/^\s*❯/m.test(pane) && !pane.includes("\x1b")) return { state: "typed", reason: "real-input" };
	return { state: "unknown", reason: "unrecognized-layout" };
}

interface Cell {
	text: string;
	dim: boolean;
	foreground: number[];
	attributes: number[];
}

function styledLines(raw: string): Cell[][] | null {
	if (Buffer.byteLength(raw) > 65536) return null;
	const lines: Cell[][] = [[]];
	let dim = false;
	let foreground: number[] = [];
	const attributes = new Set<number>();
	let background: number[] = [];
	for (let i = 0; i < raw.length; ) {
		if (raw.startsWith("\x1b]", i)) {
			const rest = raw.slice(i + 2);
			const bel = rest.indexOf("\x07");
			const st = rest.indexOf("\x1b\\");
			let end = bel;
			if (end < 0 || (st >= 0 && st < end)) end = st;
			if (end < 0) return null;
			i += 2 + end + (end === st ? 2 : 1);
			continue;
		}
		if (raw[i] === "\x1b") {
			const match = /^\[([\d;]*)m/.exec(raw.slice(i + 1));
			if (!match || match[0].length > 128) return null;
			const codes = (match[1] || "0").split(";").map(Number);
			for (let j = 0; j < codes.length; j++) {
				const code = codes[j];
				if (code === 0) {
					dim = false;
					foreground = [];
					background = [];
					attributes.clear();
				} else if (code === 2) dim = true;
				else if (code === 22) {
					dim = false;
					attributes.delete(1);
				} else if (code === 39) foreground = [];
				else if (code !== undefined && ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))) foreground = [code];
				else if (code === 38 || code === 48) {
					const count = codes[j + 1] === 5 ? 1 : 3;
					if (codes[j + 1] !== 5 && codes[j + 1] !== 2) return null;
					const color = codes.slice(j + 2, j + 2 + count);
					if (color.length !== count || color.some((n) => n < 0 || n > 255)) return null;
					const value = [code, codes[j + 1] ?? 0, ...color];
					if (code === 38) foreground = value;
					else background = value;
					j += count + 1;
				} else if (
					code !== undefined &&
					[1, 3, 4, 7, 23, 24, 27, 49, 40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107].includes(
						code,
					)
				) {
					if (code === 23) attributes.delete(3);
					else if (code === 24) attributes.delete(4);
					else if (code === 27) attributes.delete(7);
					else if (code === 49) background = [];
					else if (code >= 40) background = [code];
					else attributes.add(code);
				} else return null;
			}
			i += 1 + match[0].length;
			continue;
		}
		const text = raw[i] ?? "";
		i++;
		if (text === "\n") lines.push([]);
		else if (text.charCodeAt(0) < 32 || text.charCodeAt(0) === 127) return null;
		else
			lines.at(-1)?.push({
				text,
				dim,
				foreground: [...foreground],
				attributes: [...attributes].sort((a, b) => a - b).concat(background),
			});
	}
	return lines;
}

export function maskPrompt(raw: string, meta: Geometry, version: string, at: number): PromptSample {
	const sample: PromptSample = {
		schemaVersion: 1,
		at,
		tmuxVersion: /^\d{1,3}\.\d{1,3}[a-z]?$/.test(version) ? version : "unknown",
		width: meta.width,
		height: meta.height,
		cursor: null,
		frame: "unknown",
		spans: [],
		oldEmpty: false,
		state: "unknown",
		reason: "unrecognized-layout",
	};
	const lines = styledLines(raw);
	if (!lines) return { ...sample, reason: "unrecognized-control" };
	const plain = lines.map((line) => line.map((cell) => cell.text).join(""));
	sample.oldEmpty = strictEmptyPrompt(plain.join("\n"));
	const index = plain.findLastIndex((line, i) => i >= plain.length - 15 && /^ *❯ /.test(line));
	const line = plain[index] ?? "";
	const divider = /^ *[─━-]{3,} *$/;
	if (index < 1 || !divider.test(plain[index - 1] ?? "") || !divider.test(plain[index + 1] ?? "")) return sample;
	if (!/^ *❯ [\x20-\x7e]*$/.test(line) || line.length > meta.width || plain.length > meta.height + 1) return sample;
	if (meta.y !== index || meta.x < 0 || meta.x >= meta.width) return sample;
	const start = line.indexOf("❯") + 2;
	const cells = (lines[index] ?? []).slice(start);
	const spans: MaskedSpan[] = [];
	for (const cell of cells) {
		const span: MaskedSpan = {
			kind: cell.text === " " ? "blank" : "masked",
			columns: 1,
			dim: cell.dim,
			foreground: cell.foreground,
			attributes: cell.attributes,
		};
		const prev = spans.at(-1);
		if (prev && JSON.stringify({ ...prev, columns: 1 }) === JSON.stringify(span)) prev.columns++;
		else spans.push(span);
	}
	sample.frame = "recognized";
	sample.cursor = { x: meta.x, relativeRow: 0 };
	sample.spans = [spans];
	if (sample.oldEmpty) return { ...sample, state: "empty", reason: "strict-empty" };
	// 肯定できる実機署名は未登録。任意のdim/灰色を候補と推定しない。
	if (cells.some((c) => c.text !== " " && (c.dim || c.foreground.length || c.attributes.length)))
		return { ...sample, reason: "unrecognized-style" };
	return { ...sample, state: "typed", reason: "real-input" };
}

// Linux/WSL2 の fd 相対パスを使い、親dirの差替えでも symlink を辿らない。
function privateDirectory(home: string): number {
	let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	const rootUid = fstatSync(fd).uid;
	try {
		const parts = home.split("/").filter(Boolean);
		for (const [i, part] of [...parts, "refresh", "prompt-once-v1"].entries()) {
			const entry = `/proc/self/fd/${fd}/${part}`;
			if (i >= parts.length) {
				try {
					mkdirSync(entry, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			const next = openSync(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			closeSync(fd);
			fd = next;
			const info = fstatSync(fd);
			const uid = process.getuid?.();
			if (info.uid !== uid && info.uid !== rootUid) throw new Error("unsafe-directory");
			if (i >= parts.length - 1 && info.uid !== uid) throw new Error("unsafe-owner");
			if (info.mode & 0o022 && !(info.uid === rootUid && info.mode & 0o1000 && i < parts.length - 1))
				throw new Error("unsafe-directory");
			if (i >= parts.length && (info.mode & 0o777) !== 0o700) throw new Error("unsafe-mode");
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function exclusiveJson(dir: number, name: string, value: object) {
	const fd = openSync(
		`/proc/self/fd/${dir}/${name}`,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
	} finally {
		closeSync(fd);
	}
}

function readGeometry(text: string, pane: string): Geometry | null {
	const fields = text.trim().split("\t");
	if (fields.length !== 6 || fields[0] !== pane || !/^\$\d+$/.test(fields[1] ?? "")) return null;
	if (fields.slice(2).some((field) => !/^\d{1,4}$/.test(field))) return null;
	const [width = 0, height = 0, x = -1, y = -1] = fields.slice(2).map(Number);
	if (width < 1 || width > 1000 || height < 1 || height > 1000 || x >= width || y >= height) return null;
	return { width, height, x, y };
}

export async function samplePrompt(
	home: string,
	pane: string,
	injected?: Tmux,
	timeoutMs = 2000,
	signal?: AbortSignal,
): Promise<0 | 1 | 2 | 3> {
	if (!path.isAbsolute(home) || path.normalize(home) !== home || !/^%\d+$/.test(pane)) return 2;
	let dir: number;
	try {
		dir = privateDirectory(home);
	} catch {
		return 1;
	}
	try {
		try {
			exclusiveJson(dir, "claim.json", { schemaVersion: 1, at: Date.now() });
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EEXIST" ? 3 : 1;
		}
		let reason: PromptReason = "capture-failed";
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const run: Tmux =
				injected ??
				((args) =>
					new Promise((resolve) => {
						execFile(
							"tmux",
							args,
							{ timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 65536, signal: controller.signal },
							(error, stdout) => resolve({ ok: !error, stdout }),
						);
					}));
			const read = async (args: string[]) => {
				if (controller.signal.aborted) throw new Error("capture-failed");
				const result = await run(args);
				if (!result.ok || Buffer.byteLength(result.stdout) > 65536 || controller.signal.aborted)
					throw new Error("capture-failed");
				return result.stdout;
			};
			const obtain = async () => {
				const version = (await read(["-V"])).trim().replace(/^tmux /, "");
				const args = [
					"display-message",
					"-p",
					"-t",
					pane,
					"#{pane_id}\t#{session_id}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}",
				];
				const before = await read(args);
				const meta = readGeometry(before, pane);
				if (!meta) throw new Error("capture-failed");
				const raw = await read(["capture-pane", "-p", "-e", "-t", pane]);
				const after = await read(args);
				if (before !== after) {
					reason = "unstable";
					throw new Error("unstable");
				}
				return maskPrompt(raw, meta, version, Date.now());
			};
			const sample = await Promise.race([
				obtain(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => {
							controller.abort();
							reject(new Error("capture-failed"));
						},
						Math.min(2000, timeoutMs),
					);
				}),
			]);
			if (sample.reason === "unrecognized-control") {
				reason = sample.reason;
				throw new Error("capture-failed");
			}
			// 保存DTOは自由文字列を受け付けず、既知の数値・enumだけから作ったものを再構築する。
			exclusiveJson(dir, "sample.json", validatedSample(sample));
			return 0;
		} catch {
			try {
				exclusiveJson(dir, "failure.json", { schemaVersion: 1, reason });
			} catch {}
			return 1;
		} finally {
			clearTimeout(timer);
			controller.abort();
			signal?.removeEventListener("abort", abort);
		}
	} finally {
		closeSync(dir);
	}
}

function validatedSample(s: PromptSample): PromptSample {
	const integer = (value: number, max: number) => {
		if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("invalid-sample");
		return value;
	};
	if (
		!["empty", "typed", "unknown"].includes(s.state) ||
		!["strict-empty", "real-input", "unrecognized-layout", "unrecognized-style"].includes(s.reason)
	)
		throw new Error("invalid-sample");
	if (s.frame !== "recognized" && s.frame !== "unknown") throw new Error("invalid-sample");
	if (s.spans.length > 15) throw new Error("invalid-sample");
	return {
		schemaVersion: 1,
		at: integer(s.at, Number.MAX_SAFE_INTEGER),
		tmuxVersion: /^\d{1,3}\.\d{1,3}[a-z]?$/.test(s.tmuxVersion) ? s.tmuxVersion : "unknown",
		width: integer(s.width, 1000),
		height: integer(s.height, 1000),
		cursor: s.cursor ? { x: integer(s.cursor.x, s.width - 1), relativeRow: integer(s.cursor.relativeRow, 14) } : null,
		frame: s.frame,
		spans: s.spans.map((row) => {
			if (row.length > s.width || row.reduce((n, span) => n + span.columns, 0) > s.width)
				throw new Error("invalid-sample");
			return row.map((span) => {
				if (span.kind !== "blank" && span.kind !== "masked") throw new Error("invalid-sample");
				if (span.foreground.length > 5 || span.attributes.length > 32) throw new Error("invalid-sample");
				return {
					kind: span.kind,
					columns: integer(span.columns, s.width),
					dim: span.dim === true,
					foreground: span.foreground.map((v) => integer(v, 255)),
					attributes: span.attributes.map((v) => integer(v, 255)),
				};
			});
		}),
		oldEmpty: s.oldEmpty === true,
		state: s.state,
		reason: s.reason,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, abort);
	process.stdout.on("error", () => {
		process.exitCode = 1;
		controller.abort();
	});
	let code = 2;
	if (args.length === 5 && args[0] === "sample" && args[1] === "--home" && args[3] === "--pane")
		code = await samplePrompt(args[2] ?? "", args[4] ?? "", undefined, 2000, controller.signal);
	process.exitCode = controller.signal.aborted ? 1 : code;
	const messages = ["saved", "failed", "invalid-arguments", "already-claimed"];
	process.stdout.write(`prompt-sample: ${messages[code]}\n`);
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(name, abort);
}
