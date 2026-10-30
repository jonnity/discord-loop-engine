// 手順書のシェル例を実行して、生成物と秘密の非露出を確かめる。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
		for (const term of ["開始状態", "操作順", "終了状態", "含めないもの"]) assert.ok(r.prompt.includes(term), term);
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
		/動画利用時[\s\S]*開始状態・操作順・終了状態・含めないもの[\s\S]*設計シナリオ・試験・humanChecks[\s\S]*全て対応[\s\S]*未決範囲は Phase 1/,
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
				HARNESS_CONFIG: path.join(main, ".claude/harness.json"),
				DLE_HOME: path.join(dir, "home"),
				DLE_PROJECT: "registered",
			};
			const record = 'node -e \'require("node:fs").writeSync(1,JSON.stringify(process.argv.slice(1))+"\\n")\' -- "$@"';
			// 起動例のパスは、共通手順どおり準備で解決した実値へ置き換える。
			const quoted = await bash('printf %q "$TEST_WORKTREE"', { ...env, TEST_WORKTREE: `${expected}/issue-9` });
			assert.equal(quoted.code, 0, quoted.stderr);
			const prepared = after.replaceAll("/absolute/worktree", quoted.stdout);
			const r = await bash(
				`harness-hook() { ${record}; }; harness-codex() { ${record}; }; git() { ${record}; };\n${init}\n${prepared}`,
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
test("S1: 失敗pendingの再依頼は原因解消時だけ、回答先Aを保って承認する", () => {
	for (const doc of [section(skill, "## Step 0", "## Phase 1"), loopSkill]) {
		assert.match(doc, /自分の失敗した依頼の pending/);
		assert.match(doc, /5-4/);
		assert.match(doc, /原因を直せたときだけ再実行/);
		assert.match(doc, /直せなければ blocked/);
	}
	for (const doc of [section(skill, "### 5-4", "## Phase 6"), readme7]) {
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
	for (const doc of [section(skill, "## Phase 6", "## フォールバック"), loopSkill]) {
		for (const term of ["info", "PRコメントURL", "現在のA", "付け替え", "同じ", "引用"])
			assert.ok(doc.includes(term), term);
	}
	assert.match(readme7, /単独.*チャット承認/);
});
test("S2: 動画の合意範囲を質問から設計・実装・映像レビューに渡す", async () => {
	for (const doc of [
		section(skill, "## Phase 1", "## Phase 2"),
		section(skill, "## Phase 2", "## Phase 3"),
		section(skill, "## Phase 4", "## Phase 5"),
		section(skill, "### 5-2", "### 5-3"),
	]) {
		for (const term of ["開始状態", "操作順", "終了状態", "含めないもの"]) assert.ok(doc.includes(term), term);
	}
	assert.match(section(skill, "## Phase 1", "## Phase 2"), /demo.*UI・操作/);
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-prompt7-"));
	mkdirSync(path.join(dir, ".harness"));
	try {
		const request = section(skill, "# IMPLEMENTATION_REQUEST_BEGIN", "# IMPLEMENTATION_REQUEST_END");
		const r = await bash(`harness-config() { echo demo; }\n${request.replaceAll("{n}", "3")}`, {
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
	assert.match(section(skill, "### 5-2", "### 5-3"), /動画を撮ったhead＝現head/);
});
test("S3: 動かない理由は本文・要約先頭、humanChecksは普通の箇条書き", () => {
	const template = section(skill, "### 5-4", "## Phase 6");
	assert.match(template, /【動きのない動画の場合だけ/);
	assert.match(template, /最初の行/);
	assert.match(template, /summary.*先頭/);
	assert.doesNotMatch(template, /- \[ \]/);
	for (const doc of [template, readme7])
		assert.match(doc, /完成コメントを編集すると、それより前の OK\/Approve は数えない/);
});

test("P16a: Phase 1は既存フロー・画面・出力に触れるときだけ存廃も選択肢にする", () => {
	const phase = section(skill, "## Phase 1:", "## Phase 2:");
	assert.match(phase, /既存のフロー・画面・出力に触れる案件/);
	assert.match(phase, /残す前提にせず[\s\S]*残すか消すかも選択肢/);
	assert.match(phase, /決まっている場合は回答を引用/);
	assert.match(phase, /関係しない案件に[\s\S]*機械的に追加しない/);
	assert.match(phase, /1〜3点の質問/);
});

test("P16b: 生成依頼の該当時だけに廃止表示の棚卸しを置き、両レビューへ引き継ぐ", async () => {
	const r = await designRequest({ stub: true, profile: { gate: sampleGate } });
	assert.equal(r.code, 0, r.stderr);
	const always = section(r.prompt, "常に確かめる項目", "該当するときだけの項目");
	assert.doesNotMatch(always, /廃止|棚卸し/);
	const conditional = section(r.prompt, "該当するときだけの項目", "プロジェクトの gate");
	assert.match(
		conditional,
		/廃止する場合[\s\S]*その要素のためだけにあった表示[\s\S]*UI・CLI の出力・通知の文面[\s\S]*残すか消すかを設計に書く/,
	);
	for (const phase of [section(skill, "## Phase 3:", "## Phase 4:"), section(skill, "### 5-1.", "### 5-2.")]) {
		assert.match(phase, /廃止対象に付随した表示の棚卸しと残す／消すの判断/);
		assert.match(phase, /設計品質チェックリスト/);
	}
});

test("P16c: READMEとスキルは設定探索と隔離の契約、要件の確認先を説明する", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	for (const text of [
		section(readme, "標準 linked worktree", "### 既存 worktree"),
		section(skill, "## 設定", "主に使うキー"),
	]) {
		assert.match(text, /HARNESS_CONFIG[\s\S]*main[\s\S]*DLE_CONFIG_HOME[\s\S]*DLE_HOME/);
		assert.match(text, /手で DLE_HOME を差し替える必要は(ない|ありません)/);
		assert.match(text, /hooks.beforePR[\s\S]*呼出し元[\s\S]*環境/);
		assert.match(text, /DLE_CONFIG_HOME[\s\S]*通知[\s\S]*保証/);
		assert.doesNotMatch(text, /\.harness\//);
	}
	const mapping = section(readme, "### 要件と検証の対応", "検証役は、");
	for (const term of ["S16", "C16", "G16", "P16a", "P16b", "P16c", "条件付き存廃質問", "廃止に伴う表示の棚卸し"])
		assert.ok(mapping.includes(term), term);
});

test("T17c: 起動の分離・拒否時の blocked・利用不可だけの代行を全手順で揃える", () => {
	const common = section(skill, "## Codex の共通起動手順", "## フェーズ");
	for (const term of ["単独の Bash", "別の Bash", "シェル変数", "絶対パス", "権限を広げ", "直接", "再試行"])
		assert.ok(common.includes(term), term);
	for (const stage of ["2", "4"]) {
		const phase = section(skill, `## Phase ${stage}:`, `## Phase ${Number(stage) + 1}:`);
		assert.match(phase, /共通起動手順/);
		assert.match(phase, /準備[\s\S]*起動[\s\S]*監視/);
		const starts = [...phase.matchAll(/```bash\n(harness-codex start[^\n]*)\n```/g)];
		assert.equal(starts.length, 1);
		assert.doesNotMatch(starts[0]?.[1] ?? "", /\$WT|&&|;|\|/);
		assert.match(phase, /WT="\$\(harness-config --worktree/);
	}
	for (const phase of [
		section(skill, "### Codex の監視", "## レビュー共通"),
		section(skill, "## Phase 3:", "## Phase 4:"),
		section(skill, "### 5-1.", "### 5-2."),
		section(skill, "## Phase 6:", "## Codex 起動を blocked"),
	])
		assert.match(phase, /共通起動手順/);
	const principle = section(skill, "3. **設計・実装は Codex**", "4. **");
	const principleReasons = principle.match(/Codex が使えないとき（([^）]+)）/)?.[1];
	assert.ok(principleReasons);
	assert.doesNotMatch(principleReasons, /拒否|launch-failed|判別不能/);
	const loopFallback = loopSkill.split("\n").find((line) => line.includes("既存の代行へ進む"));
	assert.ok(loopFallback);
	assert.doesNotMatch(loopFallback, /拒否|launch-failed|判別不能/);
	assert.match(loopFallback, /exit 10 一律で切り替えず/);
	const readmeReasons = readme7.match(/^- Codex が使えないとき（([^）]+)）/m)?.[1];
	assert.ok(readmeReasons);
	assert.doesNotMatch(readmeReasons, /拒否|launch-failed|判別不能/);
	for (const doc of [skill, loopSkill, readme7]) {
		for (const term of ["launch-failed", "判別不能", "blocked", "not-installed", "not-logged-in", "usage limit"])
			assert.ok(doc.includes(term), term);
	}
	const fallback = section(skill, "## フォールバック", "## やらないこと");
	assert.doesNotMatch(fallback, /launch-failed|権限判定で拒否|対処（codex login・許可/);
	assert.match(fallback, /reason=not-installed.*not-logged-in/);
	assert.match(fallback, /git add \/ commit \/ push/);
	const blocked = section(skill, "## Codex 起動を blocked", "## フォールバック");
	for (const term of ["通知失敗", "未遷移", "同じ tmux サーバー", "二重起動", "回答", "自動解除", "tick"])
		assert.ok(blocked.includes(term), term);
	assert.match(loopSkill, /共通起動手順/);
	assert.match(loopSkill, /blocked[\s\S]*tick[\s\S]*再試行・代行しない/);
	const onboard = readFileSync(new URL("../skills/onboard/SKILL.md", import.meta.url), "utf8");
	assert.match(onboard, /起動1行[\s\S]*blocked/);
	assert.doesNotMatch(onboard, /拒否したときは[\s\S]{0,80}Claude に切り替える/);
	assert.doesNotMatch(readme7, /worker が記入/);
	for (const term of [
		"is_error: true",
		"Permission for this action was denied",
		"harness-codex start 経由",
		"tool_use_id",
		"未記録",
		"仮ルール",
		"A-番号",
		"hooks.afterWorktree",
		"読取り専用",
		"blocked が増えうる",
	])
		assert.ok(readme7.includes(term), term);
	assert.match(readme7, /Bash の拒否は 18 件[\s\S]*Codex 起動は 15 件/);
	assert.match(readme7, /harness-codex start 経由の呼び出しは 23 件[\s\S]*拒否は 0 件/);
});

async function blocked17(options: {
	stage: "spec" | "impl";
	trailing?: boolean;
	physicalHome?: boolean;
	missing?: "config" | "prompt";
	phaseCode?: number;
}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-block17-"));
	const physical = path.join(dir, "physical '\"$` (home)\n");
	const logical = path.join(dir, "logical '\"$` (home)\n");
	const home = (options.physicalHome ? physical : logical) + (options.trailing ? "/" : "");
	const suffix = "space '\"$` (path)\n";
	const wt = path.join(physical, suffix, "wt");
	const config = path.join(physical, suffix, "profile.json");
	const entry = path.join(physical, suffix, "bin", "harness-codex");
	const prompt = path.join(wt, `.harness/prompt-${options.stage}-3.md`);
	mkdirSync(path.dirname(entry), { recursive: true });
	mkdirSync(path.dirname(prompt), { recursive: true });
	symlinkSync(physical, logical, "dir");
	writeFileSync(config, "{}");
	writeFileSync(prompt, "本文を起動1行に埋め込まない");
	writeFileSync(entry, '#!/usr/bin/env bash\nprintf "%s\\0" "$HARNESS_CONFIG" "$@" > "$TEST_CAPTURE/replayed"\n', {
		mode: 0o755,
	});
	if (options.missing === "config") rmSync(config);
	if (options.missing === "prompt") rmSync(prompt);
	try {
		const r = await bash(
			`harness-config() { printf '%s\\n' "$HARNESS_CONFIG"; }
harness-phase() {
  printf '%s\\0' "$@" > "$TEST_CAPTURE/phase-args"
  cp "$4" "$TEST_CAPTURE/body"
  printf '%s' "$6" > "$TEST_CAPTURE/summary"
  return ${options.phaseCode ?? 0}
}
${section(skill, "# CODEX_BLOCKED_BEGIN", "# CODEX_BLOCKED_END").replaceAll("{n}", "3")}
quote_home "$HOME/logical path" > "$TEST_CAPTURE/logical-quote"
quote_home "$TEST_OUTSIDE" > "$TEST_CAPTURE/outside-quote"
touch "$TEST_CAPTURE/ready"`,
			{
				...process.env,
				HOME: home,
				WT: wt,
				CODEX_STAGE: options.stage,
				CODEX_REASON: "launch-failed",
				HARNESS_CONFIG: config,
				PATH: `${path.dirname(entry)}:${process.env.PATH}`,
				TEST_CAPTURE: dir,
				TEST_OUTSIDE: `${logical}-other/file`,
			},
		);
		if (options.missing || options.phaseCode) {
			assert.notEqual(r.code, 0);
			assert.ok(!existsSync(path.join(dir, "ready")));
			assert.equal(existsSync(path.join(dir, "phase-args")), !options.missing);
			return;
		}
		assert.equal(r.code, 0, r.stderr);
		const body = readFileSync(path.join(dir, "body"), "utf8");
		const summary = readFileSync(path.join(dir, "summary"), "utf8");
		const lines = [body, summary].map((text) => {
			assert.ok(!text.includes(logical), "論理 HOME を含めない");
			assert.ok(!text.includes(physical), "realpath HOME を含めない");
			assert.ok(!text.includes("本文を起動1行に埋め込まない"));
			const fences = [...text.matchAll(/^```bash\n([^\n]+)\n```$/gm)];
			assert.equal(fences.length, 1, "起動1行がフェンス内にある");
			assert.match(fences[0]?.[1] ?? "", /^HARNESS_CONFIG="\$HOME"\//);
			return fences[0]?.[1] ?? "";
		});
		assert.equal(lines[0], lines[1], "本文と summary は同じ1行");
		const phaseArgs = readFileSync(path.join(dir, "phase-args"), "utf8").split("\0").slice(0, -1);
		assert.deepEqual(phaseArgs, [
			"3",
			"blocked",
			"--comment-file",
			path.join(wt, ".harness/codex-blocked-3.md"),
			"--summary",
			summary,
		]);
		assert.match(readFileSync(path.join(dir, "logical-quote"), "utf8"), /^"\$HOME"\//);
		const replay = await bash(
			`${lines[0]}\n${readFileSync(path.join(dir, "outside-quote"), "utf8").replace(/^/, "printf '%s' ")} > "$TEST_CAPTURE/outside-replayed"`,
			{
				...process.env,
				HOME: home,
				TEST_CAPTURE: dir,
				HARNESS_CONFIG: "/wrong-config",
			},
		);
		assert.equal(replay.code, 0, replay.stderr);
		const args = readFileSync(path.join(dir, "replayed"), "utf8").split("\0").slice(0, -1);
		assert.deepEqual(args, [
			`${home}/${suffix}/profile.json`,
			"start",
			`codex-${options.stage}-3`,
			`${home}/${suffix}/wt`,
			`${home}/${suffix}/wt/.harness/prompt-${options.stage}-3.md`,
		]);
		assert.deepEqual(
			[args[0], args[3], args[4]].map((v) => realpathSync(v ?? "")),
			[config, wt, prompt],
		);
		assert.equal(readFileSync(path.join(dir, "outside-replayed"), "utf8"), `${logical}-other/file`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("T17c: 設計/実装の fenced 起動1行は symlink・末尾スラッシュ・特殊文字を含む HOME で貼り直せる", async () => {
	for (const stage of ["spec", "impl"] as const)
		for (const trailing of [false, true])
			for (const physicalHome of [false, true]) await blocked17({ stage, trailing, physicalHome });
});

test("T17c: 設定・依頼の欠損は案内を捏造せず、通知失敗も完了にしない", async () => {
	for (const missing of ["config", "prompt"] as const) await blocked17({ stage: "spec", missing });
	await blocked17({ stage: "impl", phaseCode: 4 });
});

const loop15 = readFileSync(new URL("../skills/issue-loop/SKILL.md", import.meta.url), "utf8");
const readme15 = readFileSync(new URL("../README.md", import.meta.url), "utf8");
test("S1/S2/S3: 回収は同tick・head変更前、失敗は復旧仕分けとblockedに接続する", () => {
	for (const text of [skill, loop15]) {
		for (const word of [
			"chat-merge-ok",
			"Phase 6 NG",
			"missing-attention",
			"attention-unavailable",
			"attention-mismatch",
			"Phase 5-4",
			"blocked",
			"CHAT_REJECTION_BEGIN",
			"allowedUserIds",
			"表示名",
			"非 OK",
			"窓口に『#n の承認依頼を出し直して』と頼む",
			"PR に GitHub で『OK』",
			"完成 marker＋復旧ファイル＋対象 phase の終了値なし",
		])
			assert.ok(text.includes(word), word);
	}
	const phase6 = section(skill, "## Phase 6:", "### NG");
	assert.ok(phase6.indexOf("harness-merge") < phase6.indexOf("main 取り込み"));
	assert.ok(phase6.includes('git -C "$WT" fetch origin && git -C "$WT" merge origin/<base>'));
	assert.ok(phase6.indexOf("harness-merge") < phase6.indexOf("fetch origin &&"));
	assert.ok(phase6.includes("衝突の解消は Codex に依頼"));
	assert.ok(phase6.includes("push 後は CI green を待って承認依頼をやり直す"));
	const immediate = section(loop15, "`meta.kind=merge`", "`meta.kind=interview`");
	assert.ok(immediate.includes("明示の NG・修正指示なら Phase 6 NG（issue-cycle の ### NG）"));
	for (const word of [
		"OK ではない",
		"OK、ただし NG",
		"OKです",
		"OKじゃない",
		"人が承知のうえで選んだ",
		"allowedUserIds",
		"Discord の表示名",
	])
		assert.ok(readme15.includes(word), word);
});
async function rejection15(
	script: string,
	dir: string,
	a: string,
	reason: string,
	phase = "unknown",
	state = "completed",
	extra = "",
) {
	return bash(
		`set -uo pipefail
cd "$WT" || exit 1
gh() { node "$WT/gh.cjs" "$@"; }
harness-notify() { printf '%s\\n' "$*" >> "$WT/notifies"; printf '%s\\n' '{"status":"posted"}'; }
${extra}
${script}
chat_rejection test 3 5 '${a}' '${reason}' https://github.com/example/project/pull/5#issuecomment-10 テスト '${phase}' '${state}' "$WT"
`,
		{ ...process.env, WT: dir },
	);
}
test("S3: 共通シェル例は自分のclaimを正本にし、即時/tick/再開の重複通知を抑える", async () => {
	const script = section(skill, "# CHAT_REJECTION_BEGIN", "# CHAT_REJECTION_END");
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-rejection-"));
	try {
		writeFileSync(path.join(dir, "comments.json"), "[]");
		writeFileSync(
			path.join(dir, "gh.cjs"),
			`
const fs=require('node:fs'),p=__dirname+'/comments.json',a=process.argv.slice(2),comments=JSON.parse(fs.readFileSync(p)),out=x=>fs.writeSync(1,JSON.stringify(x)+'\\n');
if(a.join(' ')==='api user --jq .login') fs.writeSync(1,'bot\\n');
else if(a[0]==='repo') fs.writeSync(1,'example/project\\n');
else if(a.includes('--slurp')) out([comments]);
else if(a.includes('--input')) {
const body=JSON.parse(fs.readFileSync(a[a.indexOf('--input')+1])).body;
if(a.includes('POST')){const c={id:comments.length+1,body,user:{login:'bot'},html_url:'https://github.com/example/project/issues/3#issuecomment-'+(comments.length+1)};comments.push(c);out(c);}
else {const c=comments.find(c=>c.id===Number(a[1].split('/').at(-1)));c.body=body;out(c);}
fs.writeFileSync(p,JSON.stringify(comments));
} else process.exit(1);
`,
		);
		const run = (a = "A-12", reason = "answer-not-ok", phase = "unknown", state = "completed", extra = "") =>
			rejection15(script, dir, a, reason, phase, state, extra);
		for (let i = 0; i < 3; i++) assert.equal((await run()).code, 0);
		let notifications = readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n");
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /本文の先頭が OK ではない/);
		assert.match(notifications[0] ?? "", /窓口に『#3 の承認依頼を出し直して』と頼む/);
		assert.match(notifications[0] ?? "", /PR に GitHub で『OK』/);
		assert.equal((await run("A-13")).code, 0);
		assert.equal((await run("A-12", "invalid-time")).code, 0);
		for (let i = 0; i < 2; i++) assert.equal((await run("unknown", "attention-missing")).code, 0);
		const comments = JSON.parse(readFileSync(path.join(dir, "comments.json"), "utf8"));
		const unknownMarker = /<!-- harness:chat-rejection (.*) -->/.exec(comments.at(-1).body);
		assert.deepEqual(JSON.parse(JSON.parse(unknownMarker?.[1] ?? "{}").key), [
			"chat-rejection-v1",
			"test",
			"3",
			"5",
			"unknown",
			"attention-missing",
		]);
		assert.match(comments.at(-1).body, /unknown/);
		comments[0].user.login = "stranger";
		writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
		assert.equal((await run()).code, 0);
		notifications = readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n");
		assert.equal(notifications.length, 5);
		const count = notifications.length;
		assert.notEqual((await run("A-14", "answer-not-ok", "unknown", "completed", "gh() { return 1; }")).code, 0);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length, count);
		assert.equal((await run("A-14", "ci-not-green")).code, 0);
		assert.equal((await run("A-14", "attention-open", "unknown", "open")).code, 0);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length, count);
		assert.equal((await run("A-14", "attention-open")).code, 0);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length, count + 1);
		assert.equal((await run("A-14", "request-pending", "0", "pending")).code, 3);
		mkdirSync(path.join(dir, ".harness"));
		symlinkSync(path.join(dir, "missing"), path.join(dir, ".harness/merge-recovery-3.json"));
		assert.equal((await run("A-15", "request-pending", "nonzero", "pending")).code, 3);
		assert.equal((await run("A-16", "recovery-unconfirmed", "unknown", "completed")).code, 3);
		assert.equal((await run("A-17", "request-pending", "unknown", "pending")).code, 3);
		rmSync(path.join(dir, ".harness/merge-recovery-3.json"));
		assert.equal(
			(
				await run(
					"A-18",
					"answer-not-ok",
					"unknown",
					"completed",
					`harness-notify() { echo skip >> "$WT/notifies"; echo '{"status":"skipped"}'; }`,
				)
			).code,
			1,
		);
		const failedCount = readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length;
		assert.equal((await run("A-18")).code, 1);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length, failedCount);
		const sentences = [
			["attention-missing", "回答先の A-番号を確認できない"],
			["invalid-arguments", "承認確認に必要な引数が正しくない"],
			["pr-unavailable", "対象の PR を確認できない"],
			["approval-unavailable", "GitHub の承認依頼を読み取れない"],
			["recovery-unconfirmed", "承認依頼の復旧完了を確認できない"],
			["request-failed", "承認依頼が失敗したか、未完了のまま復旧記録が失われている"],
			["github-ng", "GitHub にマージへの NG がある"],
			["request-missing", "有効な完成済みの承認依頼がない"],
			["request-stale", "承認依頼の head と現在の head が一致しない"],
			["request-inactive", "現在の Issue がマージ承認待ちではない"],
			["attention-none", "この依頼は A-番号を持たず、チャット承認を利用できない"],
			["attention-stale", "回答先の A-番号が現在の完成依頼と一致しない"],
			["attention-unavailable", "台帳または照合に必要な設定を読み取れない"],
			["attention-seq-behind", "読んでいる台帳の発行番号が承認依頼の A-番号に追い付いていない"],
			["attention-not-found", "回答先の A-番号が台帳に見つからない"],
			["attention-open", "台帳ではこの A-番号がまだ回答待ちになっている"],
			["attention-scope-mismatch", "回答の種類・プロジェクト・Issue・PR が対象の依頼と一致しない"],
			["attention-superseded", "同じ対象に、より新しい承認依頼がある"],
			["answer-missing", "台帳に回答本文が記録されていない"],
			["resolved-at-missing", "台帳に回答時刻が記録されていない"],
			["invalid-time", "台帳の依頼作成時刻または回答時刻が正しくない"],
			["answer-before-created", "回答時刻が A-番号の作成時刻より前になっている"],
			["answer-not-ok", "本文の先頭が OK ではない"],
			["approval-changed", "マージ直前の再確認で依頼または回答が変わった"],
		] as const;
		for (const [reason, sentence] of sentences) {
			assert.equal((await run("A-30", reason)).code, 0, reason);
			const latest = readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").at(-1) ?? "";
			assert.ok(latest.includes(sentence), reason);
			assert.ok(latest.includes("窓口に『#3 の承認依頼を出し直して』と頼む"), reason);
		}
		const config = path.join(dir, "profile.json");
		writeFileSync(
			config,
			JSON.stringify({ project: "test", owners: ["owner"], worktreeRoot: path.join(dir, "worktrees"), hooks: {} }),
		);
		writeFileSync(path.join(dir, "state.json"), '{"attentionSeq":41}');
		writeFileSync(
			path.join(dir, "gh-state.json"),
			JSON.stringify({
				head: "a".repeat(40),
				labels: ["harness:awaiting-merge"],
				comments: [
					{
						id: 10,
						user: { login: "bot" },
						body: `<!-- harness:gate phase=awaiting-merge issue=3 sha=${"a".repeat(40)} attention=A-41 -->`,
						created_at: "2026-10-27T00:00:00Z",
						updated_at: "2026-10-27T00:00:10Z",
						html_url: "https://github.com/example/project/pull/5#issuecomment-10",
					},
				],
				reviews: [],
				edits: 0,
			}),
		);
		writeFileSync(path.join(dir, "gh-log"), "");
		const actual = (bin: string, args: string[]) =>
			new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
				execFile(
					path.resolve("bin", bin),
					args,
					{
						cwd: dir,
						env: {
							...process.env,
							DLE_HOME: dir,
							HARNESS_CONFIG: config,
							CLAUDE_PROJECT_DIR: dir,
							PHASE_STUB: "1",
							MEDIA_LOG: path.join(dir, "gh-log"),
							PATH: `${path.resolve("tests/harness/fixtures")}:${process.env.PATH}`,
						},
						timeout: 10000,
					},
					(err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
				),
			);
		for (const [answer, resolvedAt, expectedReason] of [
			["NG", "2026-10-27T00:00:12Z", "answer-not-ok"],
			["OK", "2026-10-26T00:00:00Z", "answer-before-created"],
		]) {
			const github = JSON.parse(readFileSync(path.join(dir, "gh-state.json"), "utf8"));
			github.comments = github.comments.filter((c: { id: number }) => c.id !== 20);
			if (expectedReason === "answer-not-ok")
				github.comments.push({
					id: 20,
					user: { login: "owner" },
					body: "OK",
					created_at: "2026-10-27T00:00:11Z",
				});
			writeFileSync(path.join(dir, "gh-state.json"), JSON.stringify(github));
			writeFileSync(
				path.join(dir, "attention.json"),
				JSON.stringify([
					{
						id: "A-41",
						kind: "merge",
						taskId: "test#3",
						project: "test",
						issue: "3",
						pr: "5",
						title: "承認",
						url: "url",
						summary: "概要",
						status: "resolved",
						createdAt: "2026-10-27T00:00:00Z",
						resolvedAt,
						answer,
					},
				]),
			);
			const immediate = await actual("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-41"]);
			assert.equal(immediate.code, 1);
			const rejection = JSON.parse(
				immediate.stderr.split("\n").find((line) => line.startsWith('{"kind":"chat-rejection"')) ?? "{}",
			);
			assert.equal(rejection.reason, expectedReason);
			assert.equal((await run(rejection.attention, rejection.reason)).code, 0);
			const afterImmediate = readFileSync(path.join(dir, "notifies"), "utf8");
			const notificationCount = afterImmediate.trim().split("\n").length;
			if (expectedReason === "answer-not-ok")
				assert.equal(
					afterImmediate.split("\n").filter((line) => line.includes("A-41") && line.includes("answer-not-ok")).length,
					1,
				);
			const githubMerge = await actual("harness-merge", ["3"]);
			assert.equal(githubMerge.code, 1, githubMerge.stderr);
			for (let tick = 0; tick < 2; tick++) {
				const inbox = await actual("harness-inbox", []);
				assert.equal(inbox.code, 0, inbox.stderr);
				const event = JSON.parse(inbox.stdout);
				assert.equal(event.kind, "chat-not-approved");
				assert.equal((await run(event.attention, event.reason)).code, 0);
				assert.equal(readFileSync(path.join(dir, "notifies"), "utf8"), afterImmediate);
			}
			assert.equal(readFileSync(path.join(dir, "notifies"), "utf8").trim().split("\n").length, notificationCount);
		}
		assert.doesNotMatch(readFileSync(path.join(dir, "gh-log"), "utf8"), /^merge /m);

		const own = JSON.parse(readFileSync(path.join(dir, "comments.json"), "utf8"));
		const claimedComment = own.find(
			(c: { body: string }) => c.body.includes("A-30") && c.body.includes("approval-changed"),
		);
		claimedComment.body = claimedComment.body.replace('"state":"posted"', '"state":"claimed"');
		writeFileSync(path.join(dir, "comments.json"), JSON.stringify(own));
		const beforeClaimed = readFileSync(path.join(dir, "notifies"), "utf8");
		assert.equal((await run("A-30", "approval-changed")).code, 1);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8"), beforeClaimed);
		assert.equal(
			(
				await run(
					"A-31",
					"answer-not-ok",
					"unknown",
					"completed",
					`gh() { if [[ "$*" == *PATCH* ]]; then return 1; fi; node "$WT/gh.cjs" "$@"; }`,
				)
			).code,
			1,
		);
		const afterClaim = readFileSync(path.join(dir, "notifies"), "utf8");
		assert.equal((await run("A-31")).code, 1);
		assert.equal(readFileSync(path.join(dir, "notifies"), "utf8"), afterClaim);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("T18-8: PR監視・回答・枠・明示retry・承認操作の入口を定義する", () => {
	const loop = readFileSync(path.resolve(import.meta.dirname, "../skills/issue-loop/SKILL.md"), "utf8");
	const concierge = readFileSync(path.resolve(import.meta.dirname, "../skills/concierge/SKILL.md"), "utf8");
	for (const phrase of [
		"harness-pr inbox",
		"harness-pr scan",
		"dependabot.yml",
		"読取り失敗",
		"maxParallel 枠外",
		"rebase 待ちも枠",
		"同時1件",
		"meta.issue が空",
		"meta.pr",
		"meta.from=concierge",
		"--retry",
		"枠が空いてから再依頼",
		"60分",
		"120分",
		"監視は継続",
	])
		assert.ok(loop.includes(phrase), phrase);
	for (const text of [loop, skill])
		assert.ok(text.includes("worker が直接 Approve したり、auto-merge を有効にしたりしない"));
	assert.ok(concierge.includes("meta.issue が空で meta.pr"));
});

test("issue-loop: 心拍は空キューでも張り、engine 配下では削除せず緩めて保持する。承認記録なしのマージはしない", () => {
	const loop = readFileSync(path.resolve(import.meta.dirname, "../skills/issue-loop/SKILL.md"), "utf8");
	assert.match(loop, /早期終了せず必ず実行する/);
	assert.match(loop, /`DLE_ROLE=worker`（engine 配下）→ 心拍は `CronDelete` せず `\*\/60` に緩めて保持/);
	assert.match(loop, /engine 無しの単体実行 → 心拍を `CronDelete`/);
	assert.match(loop, /承認記録が無ければマージしない/);
	assert.ok(
		loop.includes('prompt: "/discord-loop-engine:issue-loop", recurring: true'),
		"心拍のプロンプトは単体呼び出しのまま",
	);
});

test("#31 設計: 冒頭に追跡ファイル不変更の1行、該当時の項目に D3〜D7 が「実装依頼の項目」より前にある", async () => {
	const r = await designRequest({ stub: true, profile: { gate: sampleGate } });
	assert.equal(r.code, 0, r.stderr);
	const head = section(r.prompt, ".harness/issue-3.md", "設計品質チェックリスト");
	assert.match(head, /リポジトリの追跡ファイルは変更しない[\s\S]*必ず/);
	assert.ok(
		head.indexOf("リポジトリの追跡ファイルは変更しない") < head.indexOf("先に"),
		"追跡ファイル不変更の行は「先に」より前（冒頭）にある",
	);
	const conditional = section(r.prompt, "該当するときだけの項目", "実装依頼の項目（");
	for (const pattern of [
		/読みが割れる[\s\S]*決定せず[\s\S]*未確定事項/,
		/A-番号[\s\S]*回答待ち[\s\S]*\.harness\/[\s\S]*リンク/,
		/scripts[\s\S]*import[\s\S]*devDependencies/,
		/変更前の取得[\s\S]*変更後の比較[\s\S]*掃除[\s\S]*追跡外/,
		/丸め規則[\s\S]*OS 固有/,
	])
		assert.match(conditional, pattern);
	assert.equal(r.prompt.split("\n").filter((l) => l.includes("解釈を含む具体化")).length, 1);
});

test("#31 実装・差し戻しの節は固定の見出しで、項目と上限行数を持つ", async () => {
	const r = await designRequest({ stub: true, profile: { gate: sampleGate } });
	const impl = section(
		r.prompt,
		"実装依頼の項目（該当するときだけ。非該当なら理由を実装完了サマリに書く）:",
		"差し戻し時の項目（",
	);
	for (const pattern of [
		/OFF の全経路[\s\S]*origin\/main/,
		/ID[\s\S]*列挙[\s\S]*fixture[\s\S]*結合テスト/,
		/重なりを実測[\s\S]*ready 以外/,
		/Sonar[\s\S]*await のない async[\s\S]*三項演算子/,
		/既存コメントを消さない[\s\S]*英語[\s\S]*フォーマッタ/,
	])
		assert.match(impl, pattern);
	const back = section(r.prompt, "差し戻し時の項目（再依頼の指示に含める）:", "プロジェクトの gate");
	assert.match(back, /同じ節の要求全体[\s\S]*横展開/);
	assert.match(back, /未確定[\s\S]*設計書の該当節を引用/);
	for (const s of [impl, back]) assert.ok(s.trim().split("\n").length <= 15);
});

test("#31 照合文は新項目を列挙せず、実装依頼と各差し戻し箇所と代打が参照する", async () => {
	const review = `${section(skill, "## Phase 3", "## Phase 4")}${section(skill, "### 5-1", "### 5-2")}`;
	for (const w of ["丸め規則", "OFF の全経路", "横展開", "時点依存"]) assert.ok(!review.includes(w), w);
	assert.match(review, /prompt-spec-\{n\}\.md[\s\S]*全項目/);
	const ref = /prompt-spec-\{n\}\.md`? の「差し戻し時の項目」/;
	for (const [b, e] of [
		["## Phase 3", "## Phase 4"],
		["### 5-1", "### 5-2"],
		["### 5-2", "### 5-3"],
		["gate の終了1は", "PR を作ったら CI"],
		["### NG（`merge-ng`", "## Codex 起動を blocked"],
	] as const)
		assert.match(section(skill, b, e), ref, b);
	assert.match(section(loopSkill, "3. `REAL` →", "4. **同じ PR"), ref);

	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-prompt31-"));
	mkdirSync(path.join(dir, ".harness"));
	try {
		const request = section(skill, "# IMPLEMENTATION_REQUEST_BEGIN", "# IMPLEMENTATION_REQUEST_END");
		const r = await bash(`harness-config() { echo demo; }\n${request.replaceAll("{n}", "3")}`, {
			...process.env,
			WT: dir,
		});
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stderr, "");
		const prompt = readFileSync(path.join(dir, ".harness/prompt-impl-3.md"), "utf8");
		assert.match(prompt, /\.harness\/prompt-spec-3\.md の「実装依頼の項目」/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const fallback = section(skill, "## フォールバック: Codex が使えない", "## やらないこと");
	assert.ok(fallback.split("\n").some((l) => l.includes("prompt-impl-{n}.md") && l.includes("prompt-spec-{n}.md")));
	const implementer = readFileSync(new URL("../agents/harness-implementer.md", import.meta.url), "utf8");
	assert.match(implementer, /prompt-impl-\{n\}\.md[\s\S]*prompt-spec-\{n\}\.md[\s\S]*実装依頼の項目/);
});
