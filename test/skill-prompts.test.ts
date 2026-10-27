// 手順書のシェル例を実行して、生成物と秘密の非露出を確かめる。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		for (const term of ["開始状態", "操作順", "終了状態", "含めないもの"]) assert.ok(prompt.includes(term), term);
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

test("W4: 実cycleのWT初期化と後続引数、loopのid走査とstatus/stop", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-skill-"));
	const main = path.join(dir, "main");
	mkdirSync(path.join(main, ".claude"), { recursive: true });
	const loop = readFileSync(new URL("../skills/issue-loop/SKILL.md", import.meta.url), "utf8");
	const extract = (text: string, begin: string, end: string) => {
		const a = text.indexOf(begin),
			b = text.indexOf(end, a);
		assert.ok(a >= 0 && b > a);
		return text.slice(a, b).replaceAll("{n}", "9");
	};
	try {
		const init = extract(skill, 'ROOT="$(harness-config --root)"', '\nmkdir -p "$WT/.harness/spec"');
		const scan = extract(loop, "# CODEX_SCAN_BEGIN", "# CODEX_SCAN_END");
		const after = skill
			.split("\n")
			.filter(
				(l) =>
					l.startsWith("harness-hook afterWorktree") ||
					l.startsWith("harness-codex start ") ||
					l.startsWith("harness-codex stop ") ||
					l.startsWith('git -C "$(harness-config --root)" worktree remove'),
			)
			.join("\n")
			.replaceAll("{n}", "9");
		assert.ok(after.includes("afterWorktree") && after.includes("worktree remove"));
		for (const root of [undefined, ".worktrees", "../relative space", path.join(dir, "absolute space")]) {
			const expected = root === undefined ? `${dir}/home-worktrees/registered` : path.resolve(main, root);
			writeFileSync(path.join(main, ".claude/harness.json"), JSON.stringify({ worktreeRoot: root }));
			const env = {
				...process.env,
				PATH: `${path.resolve("bin")}:${process.env.PATH}`,
				CLAUDE_PROJECT_DIR: main,
				HARNESS_CONFIG: path.join(main, ".claude/harness.json"),
				DLE_HOME: path.join(dir, "home"),
				DLE_PROJECT: "registered",
			};
			const record = 'node -e \'require("node:fs").writeSync(1,JSON.stringify(process.argv.slice(1))+"\\n")\' -- "$@"';
			const r = await bash(
				`harness-hook() { ${record}; }; harness-codex() { ${record}; }; git() { ${record}; };\n${init}\n${after}`,
				env,
			);
			assert.equal(r.code, 0, r.stderr);
			for (const row of r.stdout
				.trim()
				.split("\n")
				.map((s) => JSON.parse(s))
				.filter((r) => !r.includes("fetch")))
				assert.equal(row.filter((x: string) => x === `${expected}/issue-9`).length, 1, JSON.stringify(row));
			for (const n of [9, 10]) {
				mkdirSync(`${expected}/issue-${n}/.harness`, { recursive: true });
				writeFileSync(`${expected}/issue-${n}/.harness/codex-impl-${n}.id`, "@9");
				mkdirSync(`${expected}/issue-${n}/.harness/impl`, { recursive: true });
				writeFileSync(`${expected}/issue-${n}/.harness/impl/${n}.md`, "done");
			}
			const unrelated = path.join(dir, "unrelated/issue-11/.harness");
			mkdirSync(unrelated, { recursive: true });
			writeFileSync(path.join(unrelated, "codex-impl-11.id"), "@11");
			const r2 = await bash(
				`harness-codex-status() { echo exited:0; ${record} >&2; }; harness-codex() { ${record}; };\n${scan}`,
				env,
			);
			assert.equal(r2.code, 0, r2.stderr);
			for (const stream of [r2.stdout, r2.stderr]) {
				const rows = stream
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((s) => JSON.parse(s));
				assert.equal(rows.length, 2);
				assert.deepEqual(rows.map((r) => r.at(-1)).sort(), [`${expected}/issue-10`, `${expected}/issue-9`]);
			}
		}
		const r = await bash(
			`harness-config() { return 1; }; harness-codex-status() { echo forbidden; }; harness-codex() { echo forbidden; };\n${scan}\necho forbidden`,
			process.env,
		);
		assert.notEqual(r.code, 0);
		assert.equal(r.stdout, "");
		const bad = await bash(`harness-config() { return 1; };\n${init}\necho forbidden`, process.env);
		assert.notEqual(bad.code, 0);
		assert.equal(bad.stdout, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("D1/E2: 恒久文書に移行・許可・隔離の境界と確認先が残る", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const onboard = readFileSync(new URL("../skills/onboard/SKILL.md", import.meta.url), "utf8");
	for (const doc of [readme, onboard]) {
		for (const term of [
			"DLE_PROJECT",
			"--add-dir",
			"profile_propose",
			"profile_activate",
			"beforePR",
			"HARNESS_CONFIG",
			"SIGKILL",
			"symlink",
			"完全な profile",
		])
			assert.ok(doc.includes(term), term);
		assert.doesNotMatch(doc, /\.harness\/(?:spec\/9|spec-review|issue-9)/);
	}
	for (const id of ["G1〜G6", "W1/W2", "W3", "W4", "W5", "W6", "W8"]) assert.ok(readme.includes(id), id);
	assert.match(onboard, /GIT_AUTHOR_|git.*作者|作者.*git/);
});

const loopSkill = readFileSync(new URL("../skills/issue-loop/SKILL.md", import.meta.url), "utf8");
const conciergeSkill = readFileSync(new URL("../skills/concierge/SKILL.md", import.meta.url), "utf8");
const readme7 = readFileSync(new URL("../README.md", import.meta.url), "utf8");
function section(begin: string, end: string) {
	const a = skill.indexOf(begin),
		b = skill.indexOf(end, a + begin.length);
	assert.ok(a >= 0 && b > a, begin);
	return skill.slice(a, b);
}
test("S1: 失敗pendingの再依頼は原因解消時だけ、回答先Aを保って承認する", () => {
	for (const doc of [section("## Step 0", "## Phase 1"), loopSkill]) {
		assert.match(doc, /自分の失敗した依頼の pending/);
		assert.match(doc, /5-4/);
		assert.match(doc, /原因を直せたときだけ再実行/);
		assert.match(doc, /直せなければ blocked/);
	}
	for (const doc of [section("### 5-4", "## Phase 6"), readme7]) {
		for (const term of [
			"Discord",
			"SHA-256",
			"手動削除",
			"merge-ok",
			"pending",
			"復旧未確認",
			"required=false",
			"updated_at",
			"created_at",
		])
			assert.ok(doc.includes(term), term);
	}
	for (const doc of [skill, loopSkill, conciergeSkill]) {
		assert.match(doc, /--attention/);
		assert.match(doc, /meta.attention/);
	}
	for (const doc of [section("## Phase 6", "## フォールバック"), loopSkill]) {
		for (const term of ["info", "PRコメントURL", "現在のA", "付け替え", "同じ", "引用"])
			assert.ok(doc.includes(term), term);
	}
	assert.match(readme7, /単独.*チャット承認/);
});
test("S2: 動画の合意範囲を質問から設計・実装・映像レビューに渡す", async () => {
	for (const doc of [
		section("## Phase 1", "## Phase 2"),
		section("## Phase 2", "## Phase 3"),
		section("## Phase 4", "## Phase 5"),
		section("### 5-2", "### 5-3"),
	]) {
		for (const term of ["開始状態", "操作順", "終了状態", "含めないもの"]) assert.ok(doc.includes(term), term);
	}
	assert.match(section("## Phase 1", "## Phase 2"), /demo.*UI・操作/);
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-prompt7-"));
	mkdirSync(path.join(dir, ".harness"));
	try {
		const start = skill.indexOf('cat > "$WT/.harness/prompt-impl-');
		const end = skill.indexOf('\nharness-codex start "codex-impl-', start);
		assert.ok(start > 0 && end > start);
		const r = await bash(`harness-config() { echo demo; }\n${skill.slice(start, end).replaceAll("{n}", "3")}`, {
			...process.env,
			WT: dir,
		});
		assert.equal(r.code, 0, r.stderr);
		const prompt = readFileSync(path.join(dir, ".harness/prompt-impl-3.md"), "utf8");
		for (const term of [
			"開始状態",
			"操作順",
			"終了状態",
			"含めないもの",
			"full SHA",
			"動画パス",
			"git add/commit/push/checkout/stash",
		])
			assert.ok(prompt.includes(term), term);
		assert.doesNotMatch(prompt, /git checkout HEAD/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.match(section("### 5-2", "### 5-3"), /動画を撮ったhead＝現head/);
});
test("S3: 動かない理由は本文・要約先頭、humanChecksは普通の箇条書き", () => {
	const template = section("### 5-4", "## Phase 6");
	assert.match(template, /【動きのない動画の場合だけ/);
	assert.match(template, /最初の行/);
	assert.match(template, /summary.*先頭/);
	assert.doesNotMatch(template, /- \[ \]/);
	for (const doc of [template, readme7])
		assert.match(doc, /完成コメントを編集すると、それより前の OK\/Approve は数えない/);
});
