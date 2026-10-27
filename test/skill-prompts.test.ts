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
function section(text: string, begin: string, end?: string) {
	const start = text.indexOf(begin);
	const stop = end === undefined ? text.length : text.indexOf(end, start + begin.length);
	assert.ok(start >= 0 && stop > start, `${begin} / ${end}`);
	return text.slice(start, stop);
}

const checklistLiteral = '`touch "$WT/backtick"` $PROMPT_TEST $(touch "$WT/substitution")';
const sampleGate = [
	{ name: "format / lint", run: 'echo "quotes" $PROMPT_TEST `touch "$WT/gate-backtick"`' },
	{ name: "test / build", run: 'echo {n}\n$(touch "$WT/gate-substitution")' },
];

async function designRequest(options: {
	profile?: Record<string, unknown>;
	rawProfile?: string;
	missingConfig?: boolean;
	checkWorktree?: boolean;
	stub?: boolean;
	gateCode?: number;
	phaseCode?: number;
	previous?: string;
}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-p-"));
	mkdirSync(path.join(dir, ".harness"));
	try {
		const profile = options.profile ?? {};
		if (!options.missingConfig)
			writeFileSync(path.join(dir, "profile.json"), options.rawProfile ?? JSON.stringify(profile));
		writeFileSync(
			path.join(dir, "gate-input"),
			profile.gate === undefined ? "" : JSON.stringify(profile.gate, null, 2),
		);
		const promptPath = path.join(dir, ".harness/prompt-spec-3.md");
		if (options.previous !== undefined) writeFileSync(promptPath, options.previous);
		const script = section(skill, "# DESIGN_REQUEST_BEGIN", "# DESIGN_REQUEST_END")
			.replaceAll("{n}", "3")
			.replace("\nCHECKLIST", `\n${checklistLiteral}\nCHECKLIST`);
		const env = {
			...process.env,
			PATH: `${path.resolve("bin")}:${process.env.PATH}`,
			CLAUDE_PROJECT_DIR: dir,
			HARNESS_CONFIG: path.join(dir, "profile.json"),
			WT: dir,
			PROMPT_TEST: "expanded",
		};
		const config = options.stub
			? `harness-config() {
case "$1" in
'.gate') cat "$WT/gate-input"; return ${options.gateCode ?? 0} ;;
'.context | join(", ")') printf '%s' 'CLAUDE.md, README.md' ;;
*) return 90 ;;
esac
}`
			: "";
		const r = await bash(
			`${config}
git() { echo 'unexpected git operation' >&2; return 91; }
harness-phase() {
  printf '%s\\n' "$*" >> "$WT/phases"
  if [ "$2" = blocked ]; then
    [ "$3" = --comment-file ] && [ -s "$4" ] || return 92
    cp "$4" "$WT/error-copy"
    return ${options.phaseCode ?? 0}
  fi
}
${options.checkWorktree ? section(skill, 'ROOT="$(harness-config --root)"', '\nmkdir -p "$(dirname "$WT")"').replaceAll("{n}", "3") : ""}
${script}
touch "$WT/ready"`,
			env,
		);
		const read = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");
		const wrapper = options.stub ? undefined : await bash("harness-config '.gate' ''", env);
		return {
			...r,
			prompt: read(".harness/prompt-spec-3.md"),
			promptExists: existsSync(promptPath),
			phases: read("phases").trim().split("\n").filter(Boolean),
			error: read("error-copy"),
			ready: existsSync(path.join(dir, "ready")),
			sideEffects: ["backtick", "substitution", "gate-backtick", "gate-substitution"].filter((f) =>
				existsSync(path.join(dir, f)),
			),
			wrapper,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function attachedGate(prompt: string) {
	const note = section(prompt, "プロジェクトの gate（依頼生成時");
	const match = /```json\n([\s\S]*?)\n```/.exec(note);
	assert.ok(match, "閉じた JSON 節");
	return { note, raw: match[1], value: JSON.parse(match[1] ?? "") };
}

test("T1/T2: Phase 2 の生成例は導入部を展開し、CHECKLIST と gate の値・順序・シェル記号を保つ", async () => {
	for (const stub of [true, false]) {
		const r = await designRequest({ profile: { context: ["CLAUDE.md", "README.md"], gate: sampleGate }, stub });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.prompt.length > 0);
		assert.ok(r.prompt.includes("先に CLAUDE.md, README.md と .harness/notes.md"));
		assert.ok(r.prompt.includes(checklistLiteral));
		const gate = attachedGate(r.prompt);
		assert.deepEqual(gate.value, sampleGate);
		assert.match(gate.note, /この gate と同じコマンド列・順序/);
		assert.doesNotMatch(gate.note, /gate は未定義/);
		if (!stub) {
			assert.equal(r.wrapper?.code, 0);
			assert.equal(`${gate.raw}\n`, r.wrapper?.stdout);
		}
		assert.deepEqual(r.sideEffects, []);
		assert.deepEqual(r.phases, ["3 designing --notify"]);
		assert.ok(r.ready);
	}
});

test("T3: 生成依頼の常時・該当時チェックリストが要件と既存の確認条件を含む", async () => {
	const r = await designRequest({ stub: true, profile: { gate: sampleGate } });
	assert.equal(r.code, 0, r.stderr);
	const always = section(r.prompt, "常に確かめる項目", "該当するときだけの項目");
	for (const pattern of [
		/逐語引用[\s\S]*番号を復元・推定しない/,
		/解釈[\s\S]*「解釈」と明記/,
		/path:line[\s\S]*コマンド・終了コード・結果・実ファイル/,
		/gate[\s\S]*コマンド列・順序[\s\S]*format \/ lint \/ test \/ build/,
		/新しいテストファイル[\s\S]*glob・除外設定・呼び出し元/,
		/道具の存在と機能[\s\S]*存在・サイズ・内容\/形式/,
		/環境の前提[\s\S]*humanChecks[\s\S]*未確認/,
	])
		assert.match(always, pattern);
	const conditional = section(r.prompt, "該当するときだけの項目", "プロジェクトの gate");
	for (const pattern of [
		/憲章・規約[\s\S]*該当節[\s\S]*自動テストまたは humanChecks/,
		/スキーマ検証に加え[\s\S]*要件[\s\S]*値[\s\S]*期待値[\s\S]*assert/,
		/メジャー版[\s\S]*対応版[\s\S]*一次情報/,
		/PR CI の実ログ[\s\S]*1 回だけ[\s\S]*blocked[\s\S]*実装完了サマリ/,
		/エコシステム[\s\S]*manifest\/lockfile[\s\S]*非該当と理由/,
		/N 回連続成功[\s\S]*中途失敗[\s\S]*数え直す[\s\S]*SIGHUP[\s\S]*親の終了[\s\S]*プロセスグループ[\s\S]*孤児と一時ファイルの回収/,
		/長時間[\s\S]*パッケージマネージャー\/スクリプトランナー経由[\s\S]*pnpm[\s\S]*パイプ[\s\S]*異常系/,
		/ボタン名・要素[\s\S]*各状態[\s\S]*viewport[\s\S]*期待結果/,
	])
		assert.match(conditional, pattern);
});

test("T5: 実 config の欠落・空・配列以外は閉じた JSON 節と未確認の説明になり、同じ列を指示しない", async () => {
	for (const options of [
		{ profile: {} },
		{ profile: { gate: null } },
		{ profile: { gate: [] } },
		{ profile: { gate: "" } },
		{ missingConfig: true },
		{ profile: { gate: "npm test" } },
		{ profile: { gate: { run: "npm test" } } },
		{ profile: { gate: 1 } },
		{ profile: { gate: false } },
	]) {
		const r = await designRequest(options);
		assert.equal(r.code, 0, r.stderr);
		const gate = attachedGate(r.prompt);
		assert.deepEqual(gate.value, Array.isArray(options.profile?.gate) ? options.profile.gate : null);
		assert.match(gate.note, /gate は未定義・空または配列以外/);
		assert.match(gate.note, /CI と品質コマンドの対応は未確認/);
		assert.match(gate.note, /gate の確認完了の根拠にしない/);
		assert.match(
			gate.note,
			/CI から必要な品質コマンド[\s\S]*新しいテストファイルの対象[\s\S]*不足する前提・後の確認手順/,
		);
		assert.doesNotMatch(gate.note, /この gate と同じコマンド列/);
		assert.deepEqual(r.phases, ["3 designing --notify"]);
		assert.ok(r.ready);
	}
});

test("T5: 不正 JSON は本番の前提となる worktree 解決で終了1になり、gate の防御分岐まで進まない", async () => {
	for (const previous of [undefined, "以前の依頼を保持\n"]) {
		const r = await designRequest({ rawProfile: "{ invalid-json", checkWorktree: true, previous });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /parse error/);
		assert.equal(r.wrapper?.code, 5);
		assert.equal(r.prompt, previous ?? "");
		assert.equal(r.promptExists, previous !== undefined);
		assert.deepEqual(r.phases, []);
		assert.equal(r.error, "");
		assert.ok(!r.ready);
	}
});

test("T5: gate 取得失敗の防御分岐は stub による単体検証で、既存依頼を保ち blocked 通知後に停止する", async () => {
	for (const previous of [undefined, "以前の依頼を上書きしない\n"]) {
		for (const phaseCode of [0, 4]) {
			const r = await designRequest({ stub: true, gateCode: 5, phaseCode, previous });
			assert.equal(r.code, phaseCode === 0 ? 5 : 1, r.stderr);
			assert.equal(r.prompt, previous ?? "");
			assert.equal(r.promptExists, previous !== undefined);
			assert.equal(r.phases.length, 1);
			assert.match(r.phases[0] ?? "", /^3 blocked --comment-file .*gate-error-3\.md$/);
			assert.match(r.error, /取得の終了コード: 5/);
			assert.match(r.error, /JSON[\s\S]*designing[\s\S]*Codex/);
			assert.ok(!r.ready);
		}
	}
});

test("T4/T6: 両レビューに同じ観点を渡し、設計の停止計画と PR 後の修正上限を各段階で確認する", () => {
	const common = section(skill, "## レビュー共通:", "## Phase 3:");
	const design = section(skill, "## Phase 3:", "## Phase 4:");
	const impl = section(skill, "### 5-1.", "### 5-2.");
	const ui = section(skill, "### 5-2.", "### 5-3.");
	const pr = section(skill, "### 5-3.", "### 5-4.");
	assert.match(common, /Phase 3・5[\s\S]*両[\s\S]*prompt-spec-\{n\}\.md/);
	assert.match(
		common,
		/一次情報[\s\S]*対応版[\s\S]*未確認の理由・影響[\s\S]*CI[\s\S]*1 回だけ[\s\S]*blocked[\s\S]*設計段階[\s\S]*足りる/,
	);
	for (const review of [design, impl]) {
		assert.match(review, /prompt-spec-\{n\}\.md[\s\S]*全項目/);
		for (const term of [
			"gate",
			"新規テスト",
			"憲章",
			"該当節",
			"humanChecks",
			"スキーマ",
			"要件値",
			"assert",
			"パッケージマネージャー/スクリプトランナー",
			"パイプ",
			"一次情報",
			"対応版",
			"停止計画",
			"解釈",
			"要素",
			"状態",
			"viewport",
		])
			assert.ok(review.includes(term), term);
	}
	assert.match(design, /チェックリストと gate を残した同じファイル/);
	assert.match(impl, /停止計画[\s\S]*impl サマリ[\s\S]*引き継/);
	assert.match(impl, /実 CI ログ[\s\S]*修正回数[\s\S]*5-3/);
	assert.match(ui, /ボタン名・要素[\s\S]*状態[\s\S]*viewport/);
	assert.match(ui, /実アプリを実際に操作した録画/);
	assert.match(pr, /設計で停止ルール対象とした環境依存[\s\S]*実ログ[\s\S]*修正1回[\s\S]*解消しなければ[\s\S]*blocked/);
	assert.match(pr, /同じ PR[\s\S]*対象の失敗後に push した修正コミット[\s\S]*CI 結果から数える/);
	assert.match(pr, /gh pr view \{PR\} --json commits/);
	assert.match(pr, /gh pr checks \{PR\}/);
	assert.match(pr, /gh run list --commit[\s\S]*gh run view[\s\S]*--log-failed/);
	assert.match(pr, /clear\/resume 後も[\s\S]*履歴から復元/);
	assert.match(pr, /learning_add[\s\S]*ci-red[\s\S]*記録先としてだけ/);
	assert.doesNotMatch(pr, /learning_add[^。]*数える/);
	assert.match(pr, /REAL 3回より優先/);
	assert.match(pr, /CI が green になってから[\s\S]*承認依頼/);
});

test("T6: README の恒久対応表はフェーズ・試験・人による確認とリポジトリ内の確認先を結ぶ", () => {
	const readme = section(
		readFileSync(new URL("../README.md", import.meta.url), "utf8"),
		"### 設計品質チェックリストとレビュー",
	);
	for (const term of [
		"gate",
		"憲章",
		"設定値",
		"CLI",
		"対応版",
		"停止",
		"解釈",
		"viewport",
		"既存 gate",
		"Phase 3",
		"5-1",
		"5-3",
		"T1",
		"T2",
		"T3",
		"T4",
		"T5",
		"T6",
		"humanChecks",
		"REAL 3回",
		"learning_add",
		"ci-red",
	])
		assert.ok(readme.includes(term), term);
	for (const link of ["skills/issue-cycle/SKILL.md", "test/skill-prompts.test.ts", ".github/workflows/ci.yml"])
		assert.ok(readme.includes(`](${link}`), link);
	assert.match(readme, /同じ PR[\s\S]*対象の失敗後に push した修正コミット[\s\S]*CI 結果から数え/);
	assert.match(readme, /gh pr view \{PR\} --json commits[\s\S]*gh pr checks \{PR\}/);
	assert.match(readme, /gh run list --commit[\s\S]*gh run view[\s\S]*--log-failed/);
	assert.match(readme, /clear\/resume 後も[\s\S]*履歴から復元/);
	assert.match(readme, /learning_add[\s\S]*ci-red[\s\S]*記録先としてだけ/);
	assert.doesNotMatch(readme, /learning_add[^。]*数え/);
	assert.doesNotMatch(readme, /\]\([^)]*\.harness\//);
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
		const start = skill.indexOf("gate_rc=0", skill.indexOf("### 5-3."));
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
				DLE_HOME: path.join(dir, "home"),
				DLE_PROJECT: "registered",
			};
			const record = "node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- \"$@\"";
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
