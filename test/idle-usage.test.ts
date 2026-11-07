import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { idleMarkdown, summarizeIdleUsage } from "../src/idle-usage.ts";

const from = "2026-01-01T00:00:00Z";
const until = "2026-01-08T00:00:00Z";
const context = { sessions: [{ sessionId: "worker", cwd: "/fixture/project", project: "sample" }] };
const command = "<command-name>/discord-loop-engine:issue-loop</command-name>";
const at = (minute: number) => new Date(Date.parse(from) + minute * 60000).toISOString();
const user = (minute: number, extra = {}, content: unknown = command) => ({
	type: "user",
	sessionId: "worker",
	cwd: "/fixture/project/../project",
	timestamp: at(minute),
	message: { content },
	...extra,
});
const assistant = (id: string, minute: number, content: unknown = [], extra = {}) => ({
	type: "assistant",
	sessionId: "worker",
	cwd: "/fixture/project",
	timestamp: at(minute),
	message: {
		id,
		model: "sonnet",
		content,
		stop_reason: "end_turn",
		usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 5 },
	},
	...extra,
});
const tool = (name: string, input: unknown = {}) => [{ type: "tool_use", name, input }];
const lines = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const snapshot = (rows: unknown[], extra = {}) => ({
	from,
	until,
	complete: true,
	counts: { duplicates: 1, conflicts: 0 },
	inputs: [{ kind: "main", text: lines(rows) }],
	...extra,
});

// 同じ入力を純関数と実CLIに渡し、混在tickでも開始時の分類が変わらないことを確認する。
function fixture() {
	const a = assistant("idle", 1);
	return snapshot([
		user(0, {
			turnOrigin: "scheduled",
			scheduledTaskId: "task",
			scheduledFireId: "fire",
			wakeupSource: "schedule_wakeup",
		}),
		user(0.1, { isMeta: true }, [{ type: "text", text: command }]),
		a,
		{ ...a, timestamp: at(1 + 1 / 60) },
		user(2, { turnOrigin: "human" }, "手入力"),
		assistant("idle-human", 3),
		user(4, {}, "キー無し"),
		assistant("idle-keyless", 5, tool("mcp__dle__report")),
		user(10, { turnOrigin: "scheduled" }),
		assistant("active", 11),
		user(12, { turnOrigin: "human" }, "作業依頼"),
		user(13, {}, "追加"),
		assistant("active-human", 14, tool("Bash", { command: "harness-phase 63 implementing" })),
		user(20, { turnOrigin: "human", origin: { kind: "human" } }),
		assistant("wake", 21),
		user(30),
		assistant("unknown", 31),
		user(40, { scheduledTaskId: "only", turnOrigin: "human" }),
		assistant("task-only", 41),
		user(50, { turnOrigin: "scheduled" }),
		assistant("unfinished", 51, [], { message: { ...assistant("unfinished", 51).message, stop_reason: null } }),
		assistant("out-of-context", 52, [], { sessionId: "manual" }),
	]);
}

test("T1: 開始行のキー・主集計・混在tick・未完了・重複を整数で集計する", () => {
	const r = summarizeIdleUsage(fixture(), context);
	assert.deepEqual(
		Object.fromEntries(Object.entries(r.categories).map(([k, v]) => [k, [v.ticks, v.calls, v.cacheRead]])),
		{
			"heartbeat-idle": [2, 4, 2000],
			"heartbeat-active": [1, 2, 1000],
			wake_or_manual: [1, 1, 500],
			unknown: [2, 2, 1000],
			"out-of-scope": [0, 1, 500],
		},
	);
	assert.deepEqual(
		[r.mixed["heartbeat-idle"].ticks, r.mixed["heartbeat-idle"].calls, r.mixed["heartbeat-idle"].cacheRead],
		[1, 3, 1500],
	);
	assert.deepEqual(
		[r.mixed["heartbeat-active"].ticks, r.mixed["heartbeat-active"].calls, r.mixed["heartbeat-active"].cacheRead],
		[1, 2, 1000],
	);
	assert.deepEqual(
		(({ input, cacheCreation, cacheRead, output }) => ({ input, cacheCreation, cacheRead, output }))(
			r.categories["heartbeat-idle"],
		),
		{ input: 40, cacheCreation: 80, cacheRead: 2000, output: 20 },
	);
	assert.deepEqual(
		(({ input, cacheCreation, cacheRead, output }) => ({ input, cacheCreation, cacheRead, output }))(
			r.mixed["heartbeat-idle"],
		),
		{ input: 30, cacheCreation: 60, cacheRead: 1500, output: 15 },
	);
	assert.equal(r.categories["heartbeat-idle"].averageContext, 530);
	assert.equal(r.categories["heartbeat-idle"].groups[0]?.project, "sample");
	assert.deepEqual(r.originKeys, {
		total: 6,
		scheduledFull: 1,
		scheduledOriginOnly: 2,
		scheduledOther: 1,
		human: 1,
		humanOriginKind: 1,
		humanWithoutOriginKind: 0,
		missing: 1,
		other: 0,
	});
	assert.equal(r.diagnostics.duplicates, 1);
	assert.equal(r.diagnostics.conflicts, 0);
	assert.equal(r.diagnostics.reasons["incomplete-response"]?.ticks, 1);
	assert.equal(r.diagnostics.reasons["unknown-trigger"]?.calls, 1);
	assert.equal(r.snapshot.complete, true);
	assert.equal(r.coverageComplete, false);
});

test("T1: meta/tool_result/peer/channel/end_turnを境界にも混在の根拠にもしない", () => {
	const rows: unknown[] = [user(0, { turnOrigin: "scheduled" }), assistant("first", 1)];
	for (const [i, extra, content] of [
		[2, { isMeta: true }, command],
		[3, {}, [{ type: "tool_result", content: command }]],
		[4, { turnOrigin: "peer" }, command],
		[5, { turnOrigin: "task_notification" }, command],
		[6, { turnOrigin: "auto_continuation" }, command],
		[6.5, { isCompactSummary: true }, command],
		[7, { isMeta: true }, '<channel source="dle">message</channel>'],
	] as const)
		rows.push(user(i, extra, content), assistant(`after-${i}`, i + 0.1));
	const r = summarizeIdleUsage(snapshot(rows), context);
	assert.equal(r.categories["heartbeat-idle"].ticks, 1);
	assert.equal(r.categories["heartbeat-idle"].calls, 8);
	assert.equal(r.mixed["heartbeat-idle"].ticks, 0);
	const textBlock = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "scheduled" }, [{ type: "text", text: `prefix${command}` }]),
			assistant("block", 1),
		]),
		context,
	);
	assert.equal(textBlock.categories["heartbeat-idle"].calls, 1);
});

for (const stopReason of ["end_turn", "stop_sequence"]) {
	test(`T1: textだけの${stopReason}は末尾でも次のtick開始前でも応答完了`, () => {
		for (const nextTick of [false, true]) {
			const row = assistant("text", 1, [{ type: "text", text: "確認済み" }]);
			row.message.stop_reason = stopReason;
			const r = summarizeIdleUsage(
				snapshot([
					user(0, { turnOrigin: "scheduled" }),
					row,
					...(nextTick ? [user(2, { turnOrigin: "human" }), assistant("next", 3)] : []),
				]),
				context,
			);
			assert.equal(r.categories["heartbeat-idle"].ticks, 1);
			assert.equal(r.categories["heartbeat-idle"].calls, 1);
			assert.equal(r.categories.unknown.calls, 0);
			assert.equal(r.diagnostics.reasons["incomplete-response"], undefined);
			assert.equal(r.coverageComplete, true);
		}
	});

	test(`T1: ${stopReason}の後に同じtickのuser行があれば未完了`, () => {
		const row = assistant("text", 1, [{ type: "text", text: "確認済み" }]);
		row.message.stop_reason = stopReason;
		const r = summarizeIdleUsage(
			snapshot([user(0, { turnOrigin: "scheduled" }), row, user(2, { turnOrigin: "human" }, "追加依頼")]),
			context,
		);
		assert.equal(r.categories.unknown.calls, 1);
		assert.equal(r.diagnostics.reasons["incomplete-response"]?.ticks, 1);
		assert.equal(r.coverageComplete, false);
	});
}

for (const stopReason of ["tool_use", "max_tokens", "pause_turn", "refusal", null]) {
	test(`T1: 最後のメインassistantが${stopReason}なら先行する完了行があっても未完了`, () => {
		const row = assistant("unfinished", 2, [{ type: "text", text: "途中" }]);
		const r = summarizeIdleUsage(
			snapshot([
				user(0, { turnOrigin: "scheduled" }),
				assistant("earlier", 1),
				{ ...row, message: { ...row.message, stop_reason: stopReason } },
				assistant("side", 3, [], { isSidechain: true }),
			]),
			context,
		);
		assert.equal(r.categories["heartbeat-idle"].ticks, 0);
		assert.equal(r.categories.unknown.calls, 2);
		assert.equal(r.diagnostics.reasons["incomplete-response"]?.ticks, 1);
		assert.equal(r.diagnostics.reasons["incomplete-response"]?.calls, 2);
		assert.equal(r.coverageComplete, false);
	});
}

for (const command of [
	"harness-gate",
	"(harness-gate 63)",
	"$(harness-phase 63 implementing)",
	"(harness-codex start 63)",
	"$(harness-merge 63)",
	"(harness-notify 63)",
	"(harness-pr create 63)",
	"$(harness-pr create 63)",
	'(cd "$WT" && harness-gate)',
	"(cd x && harness-gate) || gate_rc=$?",
	"x=$(harness-pr create)",
	"$(harness-phase 63 designing)",
	"(harness-phase)",
	"$(harness-codex)",
	"(harness-merge)",
	"$(harness-notify)",
	"(harness-pr inbox-extra)",
	"$(harness-pr scan-all)",
	"harness-gate --classify",
]) {
	test(`T1: 作業入口 ${command} をheartbeat-activeにする`, () => {
		const r = summarizeIdleUsage(
			snapshot([user(0, { turnOrigin: "scheduled" }), assistant("work", 1, tool("Bash", { command }))]),
			context,
		);
		assert.equal(r.categories["heartbeat-active"].ticks, 1);
		assert.equal(r.categories["heartbeat-active"].calls, 1);
		assert.equal(r.categories["heartbeat-idle"].calls, 0);
	});
}

test("T1: 作業検出はassistant tool_useの指定入口だけ（reportはidleのまま）", () => {
	const commands = [
		"harness-phase",
		"harness-codex start 63",
		"harness-merge",
		"harness-pr create 63",
		"harness-pr inbox; harness-phase 63 implementing",
		"harness-notify --help; harness-merge 63",
		"/plugin/bin/harness-codex start 63",
		"harness-notify",
		"gh  issue\tcomment 63",
		"gh pr comment 1",
	];
	for (const content of [
		...commands.map((command) => tool("Bash", { command })),
		tool("mcp__github__add_COMMENT"),
		tool("AgentMerge"),
	]) {
		assert.equal(
			summarizeIdleUsage(snapshot([user(0, { turnOrigin: "scheduled" }), assistant("work", 1, content)]), context)
				.categories["heartbeat-active"].ticks,
			1,
		);
	}
	for (const content of [
		tool("Bash", { command: "harness-status; harness-inbox; gh pr view 1" }),
		...[
			"harness-pr inbox",
			"harness-pr scan",
			"harness-pr inbox; harness-pr scan",
			"harness-pr inbox && harness-pr scan",
			"harness-codex-status status worker",
			"(harness-codex-status status worker)",
			"(harness-pr inbox 63)",
			"$(harness-pr scan 63)",
			"(harness-pr inbox)",
			"$(harness-pr scan)",
			"harness-gate --help",
			"(harness-gate --help)",
			"$(harness-phase --help)",
			"(harness-gate --help 63)",
			"$(harness-gate --help 63)",
			"`harness-gate`",
			"`harness-phase`",
			"`harness-pr create`",
			"git commit -m fixture",
			"gh pr create --title fixture",
			"harness-phase --help",
			"harness-merge 63 --help",
			"harness-notify --help",
			"harness-pr --help",
			"harness-codex --help",
			"harness-status",
			"harness-pr",
			"harness-printer create",
			"harness-phase-extra",
			"my-harness-merge",
		].map((command) => tool("Bash", { command })),
		tool("CronList"),
		tool("Agent"),
		tool("mcp__dle__report"),
		[{ type: "text", text: "harness-merge gh issue comment" }],
	]) {
		assert.equal(
			summarizeIdleUsage(snapshot([user(0, { turnOrigin: "scheduled" }), assistant("read", 1, content)]), context)
				.categories["heartbeat-idle"].ticks,
			1,
			JSON.stringify(content),
		);
	}
});

test("T1: 帰属/開始/時刻不明・破損はunknown、subagent/sidechain/他roleは除外", () => {
	const f = snapshot([
		assistant("no-start", 0),
		user(1, { turnOrigin: "scheduled" }),
		assistant("broken-tool", 2, [{ type: "tool_use", name: "Bash", input: {} }]),
		user(3, { turnOrigin: "scheduled" }),
		assistant("no-time", 4, [], { timestamp: "bad" }),
		user(5, { turnOrigin: "scheduled" }),
		assistant("side", 6, [], { isSidechain: true }),
		assistant("main", 7),
		assistant("foreign", 8, [], { sessionId: "unconfirmed" }),
		assistant("concierge", 9, [], { dleRole: "concierge" }),
		assistant("native", 10, [], { dleRole: "native" }),
	]);
	f.inputs.push({ kind: "subagent", text: lines([assistant("sub", 2)]) });
	const r = summarizeIdleUsage(f, context);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.categories.unknown.calls, 3);
	assert.equal(r.diagnostics.reasons["invalid-time"]?.calls, 1);
	assert.equal(r.diagnostics.reasons["unknown-attribution"], undefined);
	assert.equal(r.diagnostics.reasons["missing-tick"]?.calls, 1);
	assert.equal(r.diagnostics.reasons["damaged-input"]?.ticks, 2);
	assert.equal(r.coverageComplete, false);
	const damaged = snapshot([user(0, { turnOrigin: "scheduled" }), assistant("damaged", 1)]);
	assert.ok(damaged.inputs[0]);
	damaged.inputs[0].text += '{"type":';
	assert.equal(summarizeIdleUsage(damaged, context).categories.unknown.calls, 1);
});

test("T1: context内sessionの開始前usageはmissing-tickでcoverage不完備", () => {
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "human" }, "起動プロンプト"),
			assistant("no-start", 1),
			user(2, { turnOrigin: "scheduled" }),
			assistant("tick", 3),
		]),
		context,
	);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.categories.unknown.calls, 1);
	assert.equal(r.categories.unknown.ticks, 0);
	assert.equal(r.diagnostics.reasons["missing-tick"]?.calls, 1);
	assert.equal(r.snapshot.complete, true);
	assert.equal(r.coverageComplete, false);
});

test("T1: 期間外開始・UTC正規化・終端除外・分類前の競合全除外", () => {
	const same = assistant("duplicate", 2);
	const r = summarizeIdleUsage(
		snapshot([
			user(-1, { turnOrigin: "scheduled" }),
			assistant("inside", 0, [], { timestamp: "2026-01-01T09:00:00+09:00" }),
			same,
			{ ...same, timestamp: at(2 + 1 / 60) },
			assistant("conflict", 3),
			user(10, { turnOrigin: "human" }),
			assistant("conflict", 11),
			assistant("end", 10080),
		]),
		context,
	);
	assert.equal(r.categories["heartbeat-idle"].calls, 2);
	assert.equal(r.categories.wake_or_manual.calls, 0);
	assert.equal(r.diagnostics.conflicts, 1);
	assert.equal(r.diagnostics.duplicates, 1);
	for (const extra of [
		{ message: { ...same.message, usage: { ...same.message.usage, input_tokens: 11 } } },
		{ message: { ...same.message, model: "other" } },
		{ cwd: "/other" },
	]) {
		const conflict = summarizeIdleUsage(
			snapshot([user(0, { turnOrigin: "scheduled" }), same, { ...same, ...extra }]),
			context,
		);
		assert.equal(conflict.categories["heartbeat-idle"].calls, 0);
		assert.equal(conflict.diagnostics.conflicts, 1);
	}
});

test("T2: 同じfixtureを実CLIでJSON/Markdownへ出し、成果物・混在・誤差・終了値を確認する", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "idle-usage "));
	const cli = path.resolve("src/idle-usage.ts");
	try {
		mkdirSync(path.join(dir, "input"));
		const f = fixture();
		const { inputs, ...summary } = f;
		writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
		writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({ inputs: [{ kind: "main", copy: "input/main.jsonl" }] }),
		);
		assert.ok(inputs[0]);
		writeFileSync(path.join(dir, "input/main.jsonl"), inputs[0].text);
		writeFileSync(path.join(dir, "context.json"), JSON.stringify(context));
		const args = [cli, "--snapshot", dir, "--context", path.join(dir, "context.json"), "--format"];
		const run = (format: string) =>
			spawnSync(process.execPath, [...args, format], { encoding: "utf8", timeout: 10000 });
		const json = run("json"),
			markdown = run("markdown");
		assert.equal(json.status, 0, json.stderr);
		assert.equal(markdown.status, 0, markdown.stderr);
		assert.equal(JSON.parse(json.stdout).categories["out-of-scope"].calls, 1);
		assert.match(markdown.stdout, /out-of-scope \| 0 \| 1 \|/);
		writeFileSync(path.join(dir, "before.json"), json.stdout);
		writeFileSync(path.join(dir, "before.md"), markdown.stdout);
		assert.ok(statSync(path.join(dir, "before.json")).size > 0);
		assert.ok(statSync(path.join(dir, "before.md")).size > 0);
		assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "before.json"), "utf8")), summarizeIdleUsage(f, context));
		assert.equal(readFileSync(path.join(dir, "before.md"), "utf8"), idleMarkdown(summarizeIdleUsage(f, context)));
		for (const phrase of [
			"混在",
			"heartbeat-idle",
			"heartbeat-active",
			"wake_or_manual",
			"unknown",
			"out-of-scope",
			"incomplete-response",
			"unknown-trigger",
			"scheduledFull",
			"heartbeat-active に移",
			"heartbeat-idle に足",
			"Bash",
			"harness-gate",
			"report",
			"元snapshot",
		]) {
			assert.ok(markdown.stdout.includes(phrase), phrase);
			assert.ok(json.stdout.includes(phrase), phrase);
		}
		assert.equal(run("csv").status, 2);
		writeFileSync(path.join(dir, "context.json"), "{}");
		assert.equal(run("json").status, 2);
		writeFileSync(path.join(dir, "context.json"), JSON.stringify(context));
		writeFileSync(path.join(dir, "summary.json"), "{");
		assert.equal(run("json").status, 2);
		rmSync(path.join(dir, "summary.json"));
		assert.equal(run("json").status, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("T1/T2: JSON整数からMarkdownを生成し499/500/1499/1500の丸めを揃える", () => {
	for (const [value, display] of [
		[499, "0.0万"],
		[500, "0.1万"],
		[1499, "0.1万"],
		[1500, "0.2万"],
	] as const) {
		const row = assistant("round", 1);
		row.message.usage.cache_read_input_tokens = value;
		const r = summarizeIdleUsage(snapshot([user(0, { turnOrigin: "scheduled" }), row]), context);
		assert.equal(r.categories["heartbeat-idle"].cacheRead, value);
		assert.ok(idleMarkdown(r).includes(display));
	}
	assert.equal(summarizeIdleUsage(snapshot([]), context).categories["heartbeat-idle"].averageContext, null);
});

test("T1: 重複した入力コピーでもtick開始を1件と数え、起点キーを重複計上しない", () => {
	const f = snapshot([user(0, { turnOrigin: "scheduled" }), assistant("copied", 1)]);
	assert.ok(f.inputs[0]);
	f.inputs.push({ ...f.inputs[0] });
	const r = summarizeIdleUsage(f, context);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.categories["heartbeat-idle"].ticks, 1);
	assert.equal(r.originKeys.total, 1);
	assert.equal(r.diagnostics.duplicates, 1);
});

test("T1: 起点の補助キーだけではheartbeatにせず、不明キーとhuman補助形式も数える", () => {
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { scheduledFireId: "fire", wakeupSource: "schedule_wakeup" }),
			assistant("fire-only", 1),
			user(2, { turnOrigin: "other", origin: { kind: "human" } }),
			assistant("other", 3),
			user(4, { turnOrigin: "human" }),
			assistant("human", 5),
			user(6, { scheduledTaskId: null }),
			assistant("task-key", 7),
		]),
		context,
	);
	assert.equal(r.categories.unknown.calls, 2);
	assert.equal(r.categories.wake_or_manual.calls, 1);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.originKeys.missing, 1);
	assert.equal(r.originKeys.other, 1);
	assert.equal(r.originKeys.humanWithoutOriginKind, 1);
	assert.equal(r.originKeys.scheduledOther, 1);
});

test("T1: 期間端を越えた完了や作業で期間内の未完了判定を変えない", () => {
	const r = summarizeIdleUsage(
		snapshot([
			user(10078, { turnOrigin: "scheduled" }),
			assistant("before-end", 10079, [], { message: { ...assistant("before-end", 10079).message, stop_reason: null } }),
			assistant("after-end", 10080, tool("Bash", { command: "harness-merge 1" })),
		]),
		context,
	);
	assert.equal(r.categories.unknown.calls, 1);
	assert.equal(r.categories["heartbeat-active"].calls, 0);
	assert.equal(r.categories["heartbeat-idle"].calls, 0);
	assert.equal(r.diagnostics.reasons["incomplete-response"]?.calls, 1);
});

test("T1: humanのみ・キー無しのみの途中発話をそれぞれ混在と数え、主分類を保つ", () => {
	for (const origin of [{ turnOrigin: "human" }, {}]) {
		for (const active of [false, true]) {
			const r = summarizeIdleUsage(
				snapshot([
					user(0, { turnOrigin: "scheduled" }),
					assistant("first", 1),
					user(2, origin, "途中の入力"),
					assistant("second", 3, active ? tool("Bash", { command: "gh pr comment 1" }) : []),
				]),
				context,
			);
			const category = active ? "heartbeat-active" : "heartbeat-idle";
			assert.equal(r.categories[category].ticks, 1);
			assert.equal(r.mixed[category].ticks, 1);
			assert.equal(r.categories[category].calls, 2);
			assert.deepEqual(r.mixed[category], r.categories[category]);
			assert.equal(r.categories.wake_or_manual.calls, 0);
		}
	}
});

test("T1: 開始時刻不明を帰属不明と混同せずunknownへ出し、架空tickを作らない", () => {
	const r = summarizeIdleUsage(
		snapshot([user(0, { timestamp: "bad", turnOrigin: "scheduled" }), assistant("known-project", 1)]),
		context,
	);
	assert.equal(r.categories.unknown.calls, 1);
	assert.equal(r.categories.unknown.ticks, 0);
	assert.equal(r.diagnostics.reasons["invalid-time"]?.calls, 1);
	assert.equal(r.diagnostics.reasons["unknown-attribution"], undefined);
});

test("T1: cwdの末尾区切りも正規化して帰属を照合する", () => {
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "scheduled", cwd: "/fixture/project/" }),
			assistant("normalized", 1, [], { cwd: "/fixture/project/" }),
		]),
		context,
	);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
});

test("T1: 同IDのcontent blockは時刻が1秒違っても1call、代表時刻は最初の行", () => {
	for (const minute of [1, 10079 + 59 / 60]) {
		const first = assistant("blocks", minute);
		const r = summarizeIdleUsage(
			snapshot([
				user(0, { turnOrigin: "scheduled" }),
				first,
				{ ...first, timestamp: at(minute + 1 / 60), message: { ...first.message, content: tool("CronList") } },
			]),
			context,
		);
		assert.equal(r.diagnostics.duplicates, 1);
		assert.equal(r.diagnostics.conflicts, 0);
		assert.equal(r.categories["heartbeat-idle"].calls, 1);
		assert.equal(r.categories["heartbeat-idle"].cacheRead, 500);
	}
});

test("T1: tick途中でworktreeへcdしてもusageと作業を同じtickに帰属させる", () => {
	for (const active of [false, true]) {
		const r = summarizeIdleUsage(
			snapshot([
				user(0, { turnOrigin: "scheduled" }),
				assistant("root", 1),
				assistant("worktree", 2, active ? tool("Bash", { command: "harness-phase 63 implementing" }) : [], {
					cwd: "/fixture/project/.worktrees/issue-63",
				}),
			]),
			context,
		);
		const category = active ? "heartbeat-active" : "heartbeat-idle";
		assert.equal(r.categories[category].ticks, 1);
		assert.equal(r.categories[category].calls, 2);
		assert.equal(r.categories[category].cacheRead, 1000);
		assert.equal(r.categories.unknown.calls, 0);
		assert.equal(r.coverageComplete, true);
	}
});

test("T1: cwdを戻しても古いtickに逆戻りせずsessionの最新tickへ入れる", () => {
	const cwd = "/fixture/project/.worktrees/issue-63";
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "scheduled", cwd }),
			assistant("A", 1, [], { cwd }),
			user(2, { turnOrigin: "scheduled" }),
			assistant("B-root", 3),
			assistant("B-worktree", 4, tool("Bash", { command: "harness-phase 63 implementing" }), { cwd }),
		]),
		context,
	);
	assert.equal(r.categories["heartbeat-idle"].ticks, 1);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.categories["heartbeat-active"].ticks, 1);
	assert.equal(r.categories["heartbeat-active"].calls, 2);
	assert.equal(r.categories.unknown.calls, 0);
});

test("T1: 同じcwdの別sessionを対象外欄へ出しunknownとcoverageへ影響させない", () => {
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "scheduled" }),
			assistant("known", 1),
			user(2, { sessionId: "manual" }),
			assistant("manual", 3, [], { sessionId: "manual" }),
			assistant("foreign", 4, [], { sessionId: "another-project", cwd: "/other" }),
		]),
		context,
	);
	assert.equal(r.categories["out-of-scope"].ticks, 1);
	assert.equal(r.categories["out-of-scope"].calls, 2);
	assert.equal(r.categories["out-of-scope"].cacheRead, 1000);
	assert.equal(r.categories["heartbeat-idle"].calls, 1);
	assert.equal(r.categories.unknown.calls, 0);
	assert.equal(r.categories.unknown.ticks, 0);
	assert.equal(r.originKeys.total, 1);
	assert.deepEqual(r.diagnostics.reasons, {});
	assert.equal(r.coverageComplete, true);
	assert.match(idleMarkdown(r), /out-of-scope \| 1 \| 2 \|/);
});

test("T1: context内sessionでもcwd不一致・欠落はunknownでcoverage不完備", () => {
	for (const cwd of ["/fixture/project-other", "/other", undefined]) {
		const r = summarizeIdleUsage(
			snapshot([user(0, { turnOrigin: "scheduled" }), assistant("bad-cwd", 1, [], { cwd })]),
			context,
		);
		assert.equal(r.categories.unknown.calls, 1);
		assert.equal(r.diagnostics.reasons["unknown-attribution"]?.calls, 1);
		assert.equal(r.coverageComplete, false);
	}
});

test("T1/T2: 平均文脈の小数をJSONとMarkdownで同じ整数へ四捨五入する", () => {
	for (const [extra, average] of [
		[1, 530],
		[2, 531],
	] as const) {
		const last = assistant("last", 3);
		last.message.usage.input_tokens += extra;
		const r = summarizeIdleUsage(
			snapshot([user(0, { turnOrigin: "scheduled" }), assistant("one", 1), assistant("two", 2), last]),
			context,
		);
		assert.equal(JSON.parse(JSON.stringify(r)).categories["heartbeat-idle"].averageContext, average);
		assert.ok(idleMarkdown(r).includes(`| ${average} |`));
	}
});

test("T1: context外の不正usageや同ID競合を既知sessionのcoverageへ混ぜない", () => {
	const outside = assistant("outside-conflict", 4, [], { sessionId: "manual" });
	const r = summarizeIdleUsage(
		snapshot([
			user(0, { turnOrigin: "scheduled" }),
			assistant("known", 1),
			user(2, { sessionId: "manual" }),
			assistant("outside-invalid", 3, [], { sessionId: "manual", message: {} }),
			outside,
			{ ...outside, message: { ...outside.message, usage: { ...outside.message.usage, input_tokens: 11 } } },
			assistant("outside-valid", 5, [], { sessionId: "manual" }),
		]),
		context,
	);
	assert.equal(r.categories["out-of-scope"].calls, 1);
	assert.equal(r.diagnostics.outOfScopeConflicts, 1);
	assert.equal(r.diagnostics.outOfScopeInvalid, 1);
	assert.equal(r.diagnostics.conflicts, 0);
	assert.equal(r.diagnostics.invalid, 0);
	assert.deepEqual(r.diagnostics.reasons, {});
	assert.equal(r.coverageComplete, true);
});
