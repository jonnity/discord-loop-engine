import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/harness-approval.ts")).href;
for (const [name, expected, initial, options, stop] of [
	["通常経路は非0を拒否", false, 7, undefined, ""],
	["復旧は同じ一次終了値だけ許可", true, 7, 7, ""],
	["別の失敗終了値は拒否", false, 7, 4, ""],
	["シグナル終了値を指定しても拒否", false, 143, 143, ""],
	["復旧中のSIGTERMは拒否して143を保持", false, 7, 7, "signal"],
	["復旧中のtimeoutも拒否", false, 7, 7, "timeout"],
] as const) {
	test(`#75: ${name}`, () => {
		const script = `
import { run } from ${JSON.stringify(moduleUrl)};
process.exitCode = ${initial};
const promise = run(process.execPath, ['-e', ${JSON.stringify(stop ? "setTimeout(() => {}, 1000)" : "process.stdout.write('fixture')")}], ${stop === "timeout" ? 10 : 3000}, ${options});
if (${JSON.stringify(stop)} === 'signal') process.emit('SIGTERM');
let accepted = false, output = '';
try { output = await promise; accepted = true; } catch {}
console.log(JSON.stringify({ accepted, output, code: process.exitCode }));
process.exitCode = 0;
`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			accepted: expected,
			output: expected ? "fixture" : "",
			code: stop === "signal" ? 143 : initial,
		});
	});
}
