import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_TEMPLATE, loadConfig } from "../src/config.ts";
import { parseStrictJson } from "../src/harness-json.ts";
import { agentModel, modelArgs, readModelConfig, resolveModels, validateModels } from "../src/harness-models.ts";

const expected = { window: "sonnet", tick: "sonnet", spec: "opus", review: "opus" };
test("M1/M2: 役割の既定と部分上書き・出典は要件値に一致する", () => {
	assert.deepEqual(resolveModels().values, expected);
	assert.deepEqual(CONFIG_TEMPLATE.models, expected);
	assert.equal(CONFIG_TEMPLATE.worker.model, "sonnet");
	const r = resolveModels(
		{ concierge: { model: "haiku" }, worker: { model: "old-full-id" }, models: { spec: "sonnet" } },
		{ review: "sonnet" },
	);
	assert.deepEqual(r.values, { window: "haiku", tick: "old-full-id", spec: "sonnet", review: "sonnet" });
	assert.deepEqual(r.sources, { window: "legacy", tick: "legacy", spec: "global", review: "project" });
	assert.deepEqual(resolveModels({ worker: { model: null } }).values, expected);
});

test("M3: 新 models は厳密、旧モデルは互換・警告、Agent full ID は省略フォールバック可能", () => {
	for (const bad of [null, [], "opus", { other: "opus" }, { tick: null }, { tick: 1 }, { tick: " " }, new Date()])
		assert.throws(() => validateModels(bad), /models/);
	assert.throws(() => parseStrictJson('{"models":{"tick":"opus","t\\u0069ck":"sonnet"}}'), /重複/);
	assert.throws(() => parseStrictJson('{"x":[{"a":1,"a":2}]}'), /重複/);
	assert.deepEqual(parseStrictJson('{"x":[{"a":1},{"a":2}]}'), { x: [{ a: 1 }, { a: 2 }] });
	const r = resolveModels({ worker: { model: "claude-opus-full", extraArgs: ["--agents", "{}"] } });
	assert.equal(r.values.tick, "claude-opus-full");
	assert.ok(r.warnings.length);
	assert.equal(agentModel(r, "tick").ok, false);
	assert.deepEqual(agentModel(resolveModels(), "review"), { ok: true, model: "opus" });
	assert.equal(resolveModels({ worker: { model: " " } }).values.tick, "sonnet");
	assert.ok(resolveModels({ worker: { model: " " } }).warnings.length);
	assert.equal(resolveModels({ worker: { model: 2 } }).values.tick, "sonnet");
	assert.doesNotThrow(() =>
		resolveModels({ worker: { extraArgs: [1] } } as unknown as Parameters<typeof resolveModels>[0]),
	);
	assert.deepEqual(modelArgs("sonnet", ["--model=old", "--model", "opus", "--agents", "{}"]), []);
	assert.deepEqual(modelArgs("sonnet", []), ["--model", "sonnet"]);
});

test("M1/M3: loadConfig は旧 null を Sonnet とし新 models を検証する", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "models62-"));
	const put = (extra: string) =>
		writeFileSync(path.join(dir, "config.json"), `{"channelIds":["1"],"allowedUserIds":["2"],${extra}}`);
	try {
		put('"worker":{"model":null}');
		assert.equal(loadConfig(dir).worker.model, "sonnet");
		assert.deepEqual(resolveModels(loadConfig(dir)).values, expected);
		put('"models":{"tick":"opus"}');
		assert.equal(resolveModels(loadConfig(dir)).values.tick, "opus");
		put('"models":{"tick":"opus","tick":"sonnet"}');
		assert.throws(() => loadConfig(dir), /重複/);
		put('"models":{"tick":null}');
		assert.throws(() => loadConfig(dir), /models/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("M3: 重複キーの拒否は models 配下に限り、models 外は従来どおり後勝ちで通す", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "models62-dup-"));
	try {
		const file = path.join(dir, "config.json");
		const put = (extra: string) => writeFileSync(file, `{"channelIds":["1"],"allowedUserIds":["2"],${extra}}`);
		put('"concierge":{"model":"opus","model":"haiku"},"models":{"tick":"opus"}');
		assert.equal(loadConfig(dir).concierge.model, "haiku");
		assert.doesNotThrow(() => readModelConfig(file));
		put('"models":{"window":"opus","window":"haiku"}');
		assert.throws(() => loadConfig(dir), /重複/);
		assert.throws(() => readModelConfig(file), /重複/);
		assert.throws(() => parseStrictJson('{"a":1,"a":2,"models":{"x":{"y":1,"y":2}}}', "models"), /重複/);
		assert.deepEqual(parseStrictJson('{"a":1,"a":2}', "models"), { a: 2 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("M7: 全 profile の役割モデルを独立した期待値で確認する", () => {
	const files = [
		"templates/profile.example.json",
		...readdirSync("templates/examples")
			.filter((f) => f.endsWith(".json"))
			.map((f) => `templates/examples/${f}`),
	];
	for (const f of files) assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).models, expected, f);
});

test("M2/M3: helper は選択 profile/global を解決し、full ID は起動に保持・Agentだけ診断する", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "models62-cli-"));
	try {
		const profile = path.join(dir, "harness.json");
		writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify({ worker: { model: "old-full-id" }, models: { review: "haiku" } }),
		);
		writeFileSync(profile, JSON.stringify({ models: { review: "sonnet" } }));
		const run = (args: string[]) =>
			spawnSync(path.resolve("bin/harness-config"), args, {
				cwd: dir,
				env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_CONFIG: profile, DLE_CONFIG_HOME: dir },
				encoding: "utf8",
			});
		const r = run(["--models"]);
		assert.equal(r.status, 0, r.stderr);
		const parsed = JSON.parse(r.stdout);
		assert.deepEqual(parsed.values, { window: "sonnet", tick: "old-full-id", spec: "opus", review: "sonnet" });
		assert.equal(parsed.sources.review, "project");
		assert.ok(parsed.warnings.length);
		assert.equal(run(["--model", "tick"]).stdout, "old-full-id\n");
		const agent = run(["--agent-model", "tick"]);
		assert.equal(agent.status, 1);
		assert.equal(agent.stdout, "");
		assert.match(agent.stderr, /model 引数を省略/);
		writeFileSync(path.join(dir, "config.json"), JSON.stringify({ worker: { model: 42, extraArgs: 42 } }));
		assert.equal(run(["--model", "tick"]).stdout, "sonnet\n");
		writeFileSync(profile, '{"models":{"tick":"opus","tick":"sonnet"}}');
		assert.equal(run(["--models"]).status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("M1/M2: 既定で埋めた Config でも出典を legacy と誤認しない", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "models62-source-"));
	try {
		writeFileSync(path.join(dir, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
		assert.deepEqual(resolveModels(loadConfig(dir)).sources, {
			window: "default",
			tick: "default",
			spec: "default",
			review: "default",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
