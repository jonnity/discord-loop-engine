import { realpathSync } from "node:fs";

type Word = { kind: "literal"; text: string; quoted: boolean } | { kind: "opaque"; single: boolean; prefix: string };
type HereDoc = { delimiter: string; stripTabs: boolean; quoted: boolean };
type Result = "bypass" | "direct-exec" | "tmux-codex" | "pass" | "unknown";

const COMMAND_LIMIT = 256 * 1024;
const JSON_LIMIT = 1024 * 1024;
const WORD_BREAK = /[ \t\n;&|<>()]/;
const OPERATOR = /^(<<<|<<-|<<|<>|<&|<|>>|>\||>&|>|&>>|&>|&&|&|\|\||\|&|\||;;&|;;|;&|;)/;
const ASSIGNMENT_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*\+?$/;
const PARAMETER = /[a-zA-Z_][a-zA-Z_0-9]*|[0-9@*#?$!-]|\{(?:[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[@*#?$!-])\}/y;
const RESERVED = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"case",
	"esac",
	"for",
	"while",
	"until",
	"select",
	"do",
	"done",
	"function",
	"coproc",
	"time",
	"!",
	"{",
	"}",
	"[[",
	"]]",
]);

function continued(input: string, index: number): boolean {
	return input[index] === "\\" && input[index + 1] === "\n";
}

function wordAt(input: string, start: number, delimiter = false) {
	let end = start;
	let text = "";
	let quote: "'" | '"' | undefined;
	let quoted = false;
	let prefix: string | undefined;
	let single = true;
	let unquotedBrace = false;
	let assignment: boolean | undefined;
	while (end < input.length) {
		const char = input.charAt(end);
		const next = input[end + 1];
		if (quote === "'") {
			if (char === quote) quote = undefined;
			else text += char;
		} else if (!quote && WORD_BREAK.test(char)) {
			break;
		} else if (char === "\\" && (!quote || '\\"$`\n'.includes(next ?? ""))) {
			if (next === undefined) return undefined;
			end += 2;
			if (next === "\n") continue;
			quoted = true;
			text += next;
			continue;
		} else if (char === quote) {
			quote = undefined;
		} else if (!quote && (char === "'" || char === '"')) {
			quote = char;
			quoted = true;
		} else if (char === "`") {
			return undefined;
		} else if (char === "$") {
			let afterDollar = end + 1;
			while (continued(input, afterDollar)) afterDollar += 2;
			const following = input[afterDollar];
			if (following === "(" || following === "[" || (!quote && (following === "'" || following === '"'))) {
				return undefined;
			}
			PARAMETER.lastIndex = afterDollar;
			const parameter = PARAMETER.exec(input)?.[0];
			if (!parameter && following === "{") return undefined;
			if (parameter && !delimiter) {
				prefix ??= text;
				single &&= Boolean(quote) && parameter !== "@" && parameter !== "{@}";
				end = PARAMETER.lastIndex;
				continue;
			}
			text += char;
		} else {
			if (!quote && !delimiter) {
				if (char === "*" || char === "?" || char === "[") {
					prefix ??= text;
					single = false;
				}
				if (char === "{" || char === "}") unquotedBrace = true;
				if (char === "~" && end === start) prefix = "";
				if (char === "=" && assignment === undefined) {
					assignment = !quoted && prefix === undefined && ASSIGNMENT_NAME.test(text);
				}
			}
			text += char;
		}
		end++;
	}
	if (quote || end === start) return undefined;
	if (unquotedBrace && text !== "{" && text !== "}") {
		prefix = "";
		single = false;
	}
	const reserved = !quoted && (prefix === undefined || text === "[[") && RESERVED.has(text);
	const word: Word =
		prefix !== undefined && !reserved ? { kind: "opaque", single, prefix } : { kind: "literal", text, quoted };
	return { word, end, assignment, reserved, fdVariable: !quoted && /^\{[a-zA-Z_][a-zA-Z_0-9]*\}$/.test(text) };
}

function operatorAt(input: string, start: number) {
	if (!";&|<>".includes(input.charAt(start))) return undefined;
	let source = "";
	const ends: number[] = [];
	for (let index = start; source.length < 3 && index < input.length; index++) {
		if (continued(input, index)) {
			index++;
			continue;
		}
		const char = input.charAt(index);
		if (!";&|<>-".includes(char)) break;
		source += char;
		ends.push(index + 1);
	}
	const text = OPERATOR.exec(source)?.[0];
	const end = text && ends[text.length - 1];
	if (text && end) return { text, end };
}

function skipHereDocs(input: string, start: number, docs: HereDoc[]): number | undefined {
	let index = start;
	for (const doc of docs) {
		let line = "";
		let found = false;
		while (index < input.length) {
			const newline = input.indexOf("\n", index);
			const end = newline === -1 ? input.length : newline;
			const startOfLine = index;
			index = newline === -1 ? end : end + 1;
			if (!doc.quoted && newline !== -1) {
				let escapes = end;
				while (escapes > startOfLine && input[escapes - 1] === "\\") escapes--;
				if ((end - escapes) % 2 !== 0) {
					line += input.slice(startOfLine, end - 1);
					continue;
				}
			}
			line += input.slice(startOfLine, end);
			if (doc.stripTabs) line = line.replace(/^\t+/, "");
			if (line === doc.delimiter) {
				found = true;
				break;
			}
			line = "";
		}
		if (!found) return undefined;
	}
	return index;
}

function parseCommands(input: string): Word[][] | undefined {
	const commands: Word[][] = [];
	const hereDocs: HereDoc[] = [];
	let argv: Word[] = [];
	let hasCommand = false;
	let continuation = false;
	let index = 0;
	let redirect: string | undefined;
	const finish = () => {
		if (argv.length > 0) commands.push(argv);
		argv = [];
		hasCommand = false;
	};
	while (index < input.length) {
		const char = input[index];
		if (continued(input, index)) {
			index += 2;
			continue;
		}
		if (char === " " || char === "\t") {
			index++;
			continue;
		}
		if (char === "#") {
			const end = input.indexOf("\n", index);
			index = end === -1 ? input.length : end;
			continue;
		}
		if (char === "\n") {
			if (redirect) return undefined;
			if (hasCommand) {
				finish();
				continuation = false;
			}
			const end = skipHereDocs(input, index + 1, hereDocs);
			if (end === undefined) return undefined;
			index = end;
			hereDocs.length = 0;
			continue;
		}
		const op = operatorAt(input, index);
		if (op) {
			if (redirect) return undefined;
			index = op.end;
			switch (op.text) {
				case ";":
				case "&&":
				case "||":
				case "|":
					if (!hasCommand) return undefined;
					finish();
					continuation = op.text !== ";";
					break;
				case "<":
				case ">":
				case ">>":
				case ">|":
				case "<&":
				case ">&":
				case "&>":
				case "&>>":
				case "<<<":
				case "<<":
				case "<<-":
					redirect = op.text;
					break;
				default:
					return undefined;
			}
			continue;
		}
		const hereDoc = redirect === "<<" || redirect === "<<-";
		const token = wordAt(input, index, hereDoc);
		if (!token) return undefined;
		index = token.end;
		const { word } = token;
		if (redirect) {
			if (hereDoc && word.kind === "literal") {
				hereDocs.push({ delimiter: word.text, quoted: word.quoted, stripTabs: redirect === "<<-" });
			}
			redirect = undefined;
		} else {
			if (input[index] === "<" || input[index] === ">") {
				if (token.fdVariable) return undefined;
				if (word.kind === "literal" && !word.quoted && /^\d+$/.test(word.text)) continue;
			}
			if (argv.length === 0 && token.reserved) return undefined;
			if (argv.length > 0 || !token.assignment) argv.push(word);
		}
		hasCommand = true;
	}
	if (redirect || (!hasCommand && continuation) || hereDocs.length > 0) return undefined;
	finish();
	return commands;
}

const BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const CODEX_VALUES = new Set([
	"-C",
	"--cd",
	"-c",
	"--config",
	"-m",
	"--model",
	"-s",
	"--sandbox",
	"-p",
	"--profile",
	"--add-dir",
	"--enable",
	"--disable",
	"--local-provider",
]);
const CODEX_FLAGS = new Set(["--approve-for-me", "--oss", "--strict-config"]);
const ROOT_VALUES = new Set(["-a", "--ask-for-approval", "--remote", "--remote-auth-token-env"]);
const ROOT_FLAGS = new Set(["--search", "--worktree"]);
const EXEC_VALUES = new Set(["--thread-source", "--output-schema", "--color", "-o", "--output-last-message"]);
const EXEC_FLAGS = new Set([
	"--skip-git-repo-check",
	"--ephemeral",
	"--ignore-user-config",
	"--ignore-rules",
	"--json",
]);

function oneWord(word: Word | undefined): word is Word {
	return word !== undefined && (word.kind === "literal" || word.single);
}

function classifyCodex(argv: Word[]): Exclude<Result, "tmux-codex"> | "launch" {
	let exec = false;
	let bypass = false;
	for (let i = 1; ; ) {
		const word = argv[i++];
		if (!word) break;
		const arg = word.kind === "literal" ? word.text : word.prefix;
		if (word.kind === "opaque") {
			if (!word.single) return "unknown";
			if (exec && arg && !arg.startsWith("-")) continue;
			if (!arg.startsWith("--") || !arg.includes("=")) return "unknown";
		}
		if (arg === "--") break;
		if (arg === "-h" || arg === "--help" || (!exec && (arg === "-V" || arg === "--version"))) return "pass";
		if (!arg.startsWith("-") || arg === "-") {
			if (exec) continue;
			if (arg === "e") return bypass ? "bypass" : "pass";
			if (arg !== "exec") break;
			exec = true;
			continue;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const option = equals === -1 ? arg : arg.slice(0, equals);
		if (CODEX_VALUES.has(option) || (exec ? EXEC_VALUES : ROOT_VALUES).has(option)) {
			if (equals === -1) {
				const value = argv[i++];
				if (!oneWord(value) || (value.kind === "literal" && value.text.length > 1 && value.text.startsWith("-"))) {
					return "unknown";
				}
			}
		} else if (arg === BYPASS) {
			bypass = true;
		} else if (!CODEX_FLAGS.has(arg) && !(exec ? EXEC_FLAGS : ROOT_FLAGS).has(arg)) {
			return "unknown";
		}
	}
	if (bypass) return "bypass";
	return exec ? "direct-exec" : "launch";
}

function executable(word: Word | undefined): string | undefined {
	if (word?.kind === "literal") return word.text.slice(word.text.lastIndexOf("/") + 1);
}

function tmuxOperand(argv: Word[], start: number, switches: string, values: string): number | undefined {
	for (let i = start; ; i++) {
		const word = argv[i];
		if (!word) return i;
		if (word.kind === "opaque") return undefined;
		const arg = word.text;
		if (arg === "--") return i + 1;
		if (!arg.startsWith("-") || arg === "-") return i;
		for (let flag = 1; flag < arg.length; flag++) {
			const option = arg.charAt(flag);
			if (values.includes(option)) {
				if (flag === arg.length - 1 && !oneWord(argv[++i])) return undefined;
				break;
			}
			if (!switches.includes(option)) return undefined;
		}
	}
}

function classifyTmux(argv: Word[]): Result {
	const subcommand = tmuxOperand(argv, 1, "2ClNuv", "LSfT");
	if (subcommand === undefined) return "unknown";
	const action = argv[subcommand];
	if (action?.kind !== "literal" || (action.text !== "new-window" && action.text !== "neww")) return "pass";
	const start = tmuxOperand(argv, subcommand + 1, "abdkPS", "ceFnt");
	if (start === undefined) return "unknown";
	const first = argv[start];
	const single = start === argv.length - 1;
	if (argv.some((word, i) => !(single && i === start) && word.kind === "literal" && word.text.endsWith(";"))) {
		return "unknown";
	}
	if (!first) return "pass";
	if (first.kind === "opaque") return "unknown";
	if (first.text === ";") return "unknown";
	// tmux は一語ならシェルに渡し、複数語なら argv のまま実行する。
	const commands = single ? parseCommands(first.text) : [argv.slice(start)];
	return commands ? classifyCommands(commands, true) : "unknown";
}

function classifyCommands(commands: Word[][], insideTmux = false): Result {
	let unknown = false;
	for (const argv of commands) {
		const name = executable(argv[0]);
		if (name === "codex") {
			const result = classifyCodex(argv);
			if (result === "unknown") unknown = true;
			else if (result !== "pass" && insideTmux) return "tmux-codex";
			else if (result === "direct-exec" || result === "bypass") return result;
		} else if (name === "tmux" && !insideTmux) {
			const result = classifyTmux(argv);
			if (result === "unknown") unknown = true;
			else if (result !== "pass") return result;
		} else if (name === undefined) {
			unknown = true;
		}
	}
	return unknown ? "unknown" : "pass";
}

export function classifyCodexCommand(command: string): Result {
	if (command.length === 0 || command.includes("\0") || Buffer.byteLength(command) > COMMAND_LIMIT) return "unknown";
	const commands = parseCommands(command);
	return commands ? classifyCommands(commands) : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function classifyHookInput(): Promise<Result> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
		size += chunk.length;
		// 上限超過後も書き手が SIGPIPE を受けないよう stdin を読み切る。
		if (size > JSON_LIMIT) chunks.length = 0;
		else chunks.push(chunk);
	}
	if (size > JSON_LIMIT) return "unknown";
	try {
		const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
		if (isRecord(input) && isRecord(input.tool_input) && typeof input.tool_input.command === "string") {
			return classifyCodexCommand(input.tool_input.command);
		}
	} catch {
		return "unknown";
	}
	return "unknown";
}

function isEntryPoint(path: string | undefined): boolean {
	if (!path) return false;
	try {
		return realpathSync(path) === realpathSync(new URL(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint(process.argv[1])) {
	process.stdout.write(`${await classifyHookInput()}\n`);
}
