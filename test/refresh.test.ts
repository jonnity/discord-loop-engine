import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { Ledger, type Project } from "../src/ledger.ts";
import { refreshCoverage, sessionTargets } from "../src/projects.ts";
import { pressure, type RefreshDecision, RefreshDiagnostics } from "../src/refresh.ts";

test("診断の閾値は本体usage優先、画面fallback、割合、件数、未知を区別する", () => {
	const settings = { maxTokens: 100000, maxEvents: 0, contextPercent: 15 };
	for (const tokens of [99999, 100000, 100001]) {
		assert.equal(pressure(settings, tokens, 200000, 1, 100).overThreshold, tokens >= 100000);
	}
	assert.deepEqual(pressure(settings, null, 100000, 50, 0), {
		tokens: 100000,
		source: "screen",
		remainingPercent: 50,
		overThreshold: true,
	});
	assert.equal(pressure(settings, null, null, 15, 0).overThreshold, true);
	assert.equal(pressure(settings, null, null, null, 0).overThreshold, null);
	assert.equal(pressure({ ...settings, maxTokens: 0 }, null, null, 1, 0).overThreshold, false);
	assert.equal(pressure({ ...settings, maxEvents: 40 }, null, null, null, 40).overThreshold, true);
});

test("診断は連続tickを集約し、理由変更・5分・結果・終了でflushし私有に保存する", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "refresh-"));
	const journal: string[] = [];
	const writer = new RefreshDiagnostics(home, (s) => journal.push(s));
	const row: RefreshDecision = {
		project: "worker",
		session: "session",
		at: Date.parse("2026-01-01T00:00:00Z"),
		tokens: 150000,
		source: "transcript",
		remainingPercent: null,
		overThreshold: true,
		primaryReason: "activity-recent",
		blockers: ["activity-recent", "screen-working"],
		notObserved: ["codex"],
	};
	try {
		await writer.record(row);
		await writer.record({ ...row, at: row.at + 30000, tokens: 160000 });
		await writer.record({ ...row, at: row.at + 300000 });
		await writer.record({ ...row, at: row.at + 330000, primaryReason: "codex-busy" });
		await writer.record({ ...row, at: row.at + 360000, primaryReason: "refresh-success", result: true });
		await writer.close();
		const file = path.join(home, "refresh/decisions/2026-01-01.jsonl");
		const rows = (await readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map((s) => JSON.parse(s));
		assert.equal(
			rows.reduce((n, r) => n + r.count, 0),
			5,
		);
		assert.equal(rows[0].count, 3);
		assert.equal(rows[0].firstAt, row.at);
		assert.equal(rows[0].lastAt, row.at + 300000);
		assert.equal(rows[0].maxTokens, 160000);
		assert.equal(rows.at(-1).result, true);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
		assert.equal(journal.length, 3);
		assert.deepEqual(await readdir(path.dirname(file)), ["2026-01-01.jsonl"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("blockersだけが変わる連続tickではjournalを増やさない", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "refresh-"));
	const journal: string[] = [];
	const writer = new RefreshDiagnostics(home, (s) => journal.push(s));
	const row: RefreshDecision = {
		project: "worker",
		session: "session",
		at: Date.parse("2026-01-01T00:00:00Z"),
		tokens: 150000,
		source: "transcript",
		remainingPercent: null,
		overThreshold: true,
		primaryReason: "activity-recent",
		blockers: ["activity-recent"],
		notObserved: [],
	};
	try {
		await writer.record(row);
		await writer.record({ ...row, at: row.at + 30000, blockers: ["activity-recent", "screen-working"] });
		await writer.record({ ...row, at: row.at + 60000, blockers: ["activity-recent", "session-busy"] });
		assert.equal(journal.length, 1);
		await writer.close();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("診断のI/O失敗は呼出し元へ投げず、失敗を観測可能にする", async () => {
	const errors: string[] = [];
	const writer = new RefreshDiagnostics(
		"/dev/null",
		() => {},
		(s) => errors.push(s),
	);
	await writer.coverage([{ project: "worker", reason: "refresh-disabled", settings: null }]);
	await writer.close();
	assert.ok(errors.length > 0);
	assert.ok(errors.every((s) => !s.includes("/dev/null")));
});

test("coverageはtargetsに現れないinactiveとnative/not-ready/OFFを区別し、設定と起動内容を変えない", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "coverage-"));
	try {
		await writeFile(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
		const cfg = loadConfig(home);
		const ledger = new Ledger(home);
		const project = (name: string, extra = {}): Project => ({
			name,
			path: `/fixture/${name}`,
			repo: `fixture/${name}`,
			mode: "harness",
			active: true,
			addedAt: "2026-01-01",
			...extra,
		});
		const projects = [
			project("inactive", { active: false }),
			project("native", { mode: "native" }),
			project("onboard"),
		];
		const targets = sessionTargets(cfg, projects, ledger);
		const coverage = refreshCoverage(cfg, projects, targets, ledger);
		assert.deepEqual(
			coverage.map((r) => [r.project, r.reason]),
			[
				["concierge", "eligible"],
				["inactive", "inactive"],
				["native", "native"],
				["onboard", "not-ready"],
			],
		);
		assert.deepEqual(coverage[0]?.settings, {
			maxTokens: 150000,
			maxEvents: 40,
			contextPercent: 15,
			idleSeconds: 180,
			cooldownMinutes: 30,
			codexIgnoreAfterMinutes: 120,
			waitForCodex: false,
		});
		assert.equal(JSON.stringify(coverage).includes(home), false);
		assert.deepEqual(sessionTargets(cfg, projects, ledger), targets);
		cfg.concierge.refresh.enabled = false;
		assert.equal(
			refreshCoverage(cfg, projects, sessionTargets(cfg, projects, ledger), ledger)[0]?.reason,
			"refresh-disabled",
		);
		assert.equal(sessionTargets(cfg, projects, ledger)[0]?.refresh, undefined);
		const ready = project("ready");
		const stopped = { name: "ready", cwd: ready.path, command: "", initialPrompt: "", startupError: "fixture" };
		assert.equal(refreshCoverage(cfg, [ready], [stopped])[1]?.reason, "startup-error");
		cfg.worker.refresh.enabled = false;
		assert.equal(refreshCoverage(cfg, [ready], [])[1]?.reason, "refresh-disabled");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("入力分類の変化は別集約となり、解析moduleの変更はimplementationHashを変える", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "refresh-hash-"));
	try {
		const source = path.join(root, "src");
		await mkdir(source);
		for (const name of [
			"refresh",
			"refresh-prompt",
			"supervisor",
			"context",
			"engine",
			"projects",
			"config",
			"protocol",
		])
			await writeFile(path.join(source, `${name}.ts`), await readFile(new URL(`../src/${name}.ts`, import.meta.url)));
		const { RefreshDiagnostics: Writer } = (await import(
			pathToFileURL(path.join(source, "refresh.ts")).href
		)) as typeof import("../src/refresh.ts");
		const row: RefreshDecision = {
			project: "worker",
			session: "s",
			at: 0,
			tokens: 150000,
			source: "transcript",
			remainingPercent: null,
			overThreshold: true,
			primaryReason: "input-not-empty",
			blockers: ["input-not-empty"],
			notObserved: [],
			promptState: "typed",
			promptReason: "real-input",
		};
		const before = new Writer(path.join(root, "before"));
		await before.record(row);
		await before.record({ ...row, promptState: "unknown", promptReason: "unrecognized-style", at: 1 });
		await before.close();
		await writeFile(path.join(source, "refresh-prompt.ts"), "// 合成変更\n");
		const after = new Writer(path.join(root, "after"));
		await after.record(row);
		await after.close();
		const read = async (dir: string) =>
			(await readFile(path.join(root, dir, "refresh/decisions/1970-01-01.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const a = await read("before"),
			b = await read("after");
		assert.equal(a.length, 2);
		assert.deepEqual(
			a.map((r) => r.promptState),
			["typed", "unknown"],
		);
		assert.notEqual(a[0].implementationHash, "unknown");
		assert.notEqual(a[0].implementationHash, b[0].implementationHash);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("既定150kはready workerと窓口のtargetとcoverageへ配線される", async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), "refresh-default-"));
	try {
		await writeFile(path.join(home, "config.json"), JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"] }));
		const cfg = loadConfig(home),
			ledger = new Ledger(home);
		await mkdir(path.dirname(ledger.profilePath("worker")), { recursive: true });
		await writeFile(ledger.profilePath("worker"), "{}");
		const projects: Project[] = [
			{ name: "worker", path: home, repo: "x/y", active: true, mode: "harness", addedAt: "" },
		];
		const targets = sessionTargets(cfg, projects, ledger);
		assert.deepEqual(
			targets.map((t) => t.refresh?.maxTokens),
			[150000, 150000],
		);
		assert.deepEqual(
			refreshCoverage(cfg, projects, targets, ledger).map((c) => c.settings?.maxTokens),
			[150000, 150000],
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
