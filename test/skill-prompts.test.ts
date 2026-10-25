// 手順書のシェル例を実行して、生成物と秘密の非露出を確かめる。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const skill = readFileSync(new URL("../skills/issue-cycle/SKILL.md", import.meta.url), "utf8");
function bash(script: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile("bash", ["-c", script], { env, timeout: 5000 }, (err, stdout, stderr) =>
			resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
		);
	});
}
test("Phase 2 の依頼生成は導入部を展開し、追記のシェル構文を文字のまま保つ", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-p-"));
	mkdirSync(path.join(dir, ".harness"));
	try {
		const start = skill.indexOf('cat > "$WT/.harness/prompt-spec-');
		const end = skill.indexOf('\nharness-codex start "codex-spec-', start);
		assert.ok(start > 0 && end > start);
		const literal = '`touch "$WT/backtick"` $PROMPT_TEST $(touch "$WT/substitution")';
		const script = skill.slice(start, end).replaceAll("{n}", "3").replace("\nCHECKLIST", `\n${literal}\nCHECKLIST`);
		const r = await bash(`harness-config() { printf '%s' 'CLAUDE.md, README.md'; }\n${script}`, {
			...process.env,
			WT: dir,
			PROMPT_TEST: "expanded",
		});
		assert.equal(r.code, 0, r.stderr);
		const prompt = readFileSync(path.join(dir, ".harness/prompt-spec-3.md"), "utf8");
		assert.ok(prompt.includes("先に CLAUDE.md, README.md と .harness/notes.md"));
		assert.ok(prompt.includes(literal));
		assert.ok(!existsSync(path.join(dir, "backtick")) && !existsSync(path.join(dir, "substitution")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("認証の疎通例は200/401/403/通信不可を区別し、秘密と応答本文を表示しない", async () => {
	const token = "fake-secret-for-probe";
	const responseBody = "private-response-must-not-be-logged";
	const server = http.createServer((req, res) => {
		assert.equal(req.headers.authorization, `Bearer ${token}`);
		res.writeHead(Number(req.url?.slice(1)));
		res.end(responseBody);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const start = skill.indexOf("# AUTH_PROBE_BEGIN");
	const end = skill.indexOf("# AUTH_PROBE_END", start);
	assert.ok(start > 0 && end > start);
	const script = skill.slice(start, end);
	const base = `http://127.0.0.1:${address.port}`;
	try {
		for (const status of [200, 401, 403]) {
			const r = await bash(script, { ...process.env, SERVICE_TOKEN: token, AUTH_CHECK_URL: `${base}/${status}` });
			assert.equal(r.code, status === 200 ? 0 : 1);
			assert.ok(!`${r.stdout}${r.stderr}`.includes(token));
			assert.ok(!`${r.stdout}${r.stderr}`.includes(responseBody));
		}
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
	const r = await bash(script, { ...process.env, SERVICE_TOKEN: token, AUTH_CHECK_URL: `${base}/200` });
	assert.equal(r.code, 1);
	assert.doesNotMatch(`${r.stdout}${r.stderr}`, new RegExp(`${token}|${responseBody}`));
});

test("PR 前の gate 例は終了値を保持し、環境不備で後続を止める", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-g-"));
	try {
		const start = skill.indexOf("gate_rc=0");
		const end = skill.indexOf('\ngit -C "$WT" push', start);
		assert.ok(start > 0 && end > start);
		for (const code of [0, 1, 2, 3]) {
			const r = await bash(`harness-gate() { return ${code}; }\n${skill.slice(start, end)}\necho push-and-pr`, {
				...process.env,
				WT: dir,
			});
			assert.equal(r.code, code);
			assert.equal(r.stdout.includes("push-and-pr"), code === 0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
