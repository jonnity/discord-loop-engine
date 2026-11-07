import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const row = (id: string | null, cache: number, timestamp = "2026-01-01T00:00:00Z", extra = {}) => ({
	type: "assistant",
	timestamp,
	sessionId: "session",
	cwd: "/fixture",
	...extra,
	message: {
		id,
		model: "sonnet",
		usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: cache, output_tokens: 5 },
	},
});

function fixture() {
	const root = mkdtempSync(path.join(os.tmpdir(), "usage outside repo "));
	const script = path.join(root, "usage-summary.ts");
	const source = path.resolve("src/usage-summary.ts");
	copyFileSync(source, script);
	assert.equal(hash(readFileSync(source)), hash(readFileSync(script)));
	const home = path.join(root, "claude logs");
	mkdirSync(path.join(home, "projects/project/session/subagents"), { recursive: true });
	const file = path.join(home, "projects/project/session.jsonl");
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [script, ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 30000,
			env: { ...process.env, NODE_OPTIONS: "" },
		});
	const snapshot = (out: string, from = "2026-01-01T00:00:00Z", until = "2026-01-08T00:00:00Z") =>
		run("snapshot", "--claude-home", home, "--from", from, "--until", until, "--out", path.join(root, out));
	const json = (name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
	return { root, script, home, file, run, snapshot, json };
}

test("単一ファイルの実コピーCLIで前後各7日を集計・保全・比較する（独立N=3）", () => {
	for (let trial = 0; trial < 3; trial++) {
		const f = fixture();
		try {
			const before = [row("one", 100), row("one", 100), row("excluded", 900, "2026-01-08T00:00:00Z"), { type: "user" }];
			writeFileSync(f.file, `${before.map((r) => JSON.stringify(r)).join("\n")}\n`);
			writeFileSync(
				path.join(f.home, "projects/project/session/subagents/agent.jsonl"),
				`${JSON.stringify(row("sub", 50))}\n`,
			);
			const original = readFileSync(f.file);
			const b = f.snapshot("before");
			assert.equal(b.status, 0, b.stderr);
			const summary = f.json("before/summary.json");
			assert.equal(summary.schemaVersion, 1);
			assert.equal(summary.specification, "proposal");
			assert.equal(summary.complete, true);
			assert.equal(summary.totals.cacheRead, 150);
			assert.equal(summary.totals.calls, 2);
			assert.equal(summary.totals.averageContext, 105);
			assert.equal(summary.counts.duplicates, 1);
			assert.equal(summary.scriptHash, hash(readFileSync(f.script)));
			const manifest = f.json("before/manifest.json");
			assert.equal(manifest.inputs.length, 2);
			for (const input of manifest.inputs) {
				const copy = readFileSync(path.join(f.root, "before", input.copy));
				assert.equal(hash(copy), input.hash);
				assert.equal(copy.length, input.bytes);
			}
			assert.equal(hash(readFileSync(path.join(f.root, "before/manifest.json"))), summary.manifestHash);
			assert.deepEqual(readFileSync(f.file), original);
			assert.equal(statSync(path.join(f.root, "before/summary.json")).mode & 0o777, 0o600);
			assert.equal(f.snapshot("before").status, 1, "既存出力を上書きしない");
			writeFileSync(f.file, `${JSON.stringify(row("after", 60, "2026-01-08T00:00:00+00:00"))}\n`);
			assert.equal(f.snapshot("after", "2026-01-08T09:00:00+09:00", "2026-01-15T09:00:00+09:00").status, 0);
			const compared = f.run(
				"compare",
				"--before",
				path.join(f.root, "before/summary.json"),
				"--after",
				path.join(f.root, "after/summary.json"),
				"--out",
				path.join(f.root, "comparison"),
			);
			assert.equal(compared.status, 0, compared.stderr);
			const comparison = f.json("comparison/summary.json");
			assert.equal(comparison.comparable, true);
			assert.equal(comparison.delta, -90);
			assert.deepEqual(comparison.reduction, { numerator: 90, denominator: 150, rate: 0.6 });
			assert.match(readFileSync(path.join(f.root, "comparison/report.md"), "utf8"), /60\.0%/);
			assert.ok(statSync(path.join(f.root, "comparison/manifest.json")).size > 0);
			assert.equal(existsSync(path.join(f.root, "package.json")), false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test("集計仕様案は競合・欠損・途中行を不完全とし、比較成功を生成しない", () => {
	for (const lines of [
		`${[JSON.stringify(row("same", 1)), JSON.stringify(row("same", 2))].join("\n")}\n`,
		`${JSON.stringify(row(null, 1))}\n`,
		`${JSON.stringify(row("bad", -1))}\n`,
		JSON.stringify(row("partial", 1)),
		"{broken}\n",
		`${JSON.stringify(row("bad-time", 1, "invalid"))}\n`,
	]) {
		const f = fixture();
		try {
			writeFileSync(f.file, lines);
			assert.equal(f.snapshot("incomplete").status, 3);
			assert.equal(f.json("incomplete/summary.json").complete, false);
			assert.ok(f.json("incomplete/manifest.json").issues.length > 0);
			const result = f.run(
				"compare",
				"--before",
				path.join(f.root, "incomplete/summary.json"),
				"--after",
				path.join(f.root, "incomplete/summary.json"),
				"--out",
				path.join(f.root, "rejected"),
			);
			assert.equal(result.status, 3);
			assert.equal(existsSync(path.join(f.root, "rejected/report.md")), false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test("未来窓・7日以外・タイムゾーン欠損を拒否し、入力領域が無ければ失敗する", () => {
	const f = fixture();
	try {
		for (const [from, until] of [
			["2026-01-01", "2026-01-08"],
			["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
			["2099-01-01T00:00:00Z", "2099-01-08T00:00:00Z"],
		]) {
			assert.equal(f.snapshot("invalid", from, until).status, 2);
		}
		rmSync(path.join(f.home, "projects"), { recursive: true });
		assert.equal(f.snapshot("missing").status, 1);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("帰属をパス名から推測せず、モデル・project・role・UTC日別を整数で集計する", () => {
	const f = fixture();
	try {
		const lines = [
			row("a", 10, "2026-01-01T09:00:00+09:00", { project: "p", dleRole: "worker" }),
			row("b", 20, "2026-01-02T00:00:00Z", { project: "p", dleRole: "concierge" }),
		];
		writeFileSync(f.file, `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`);
		assert.equal(f.snapshot("groups").status, 0);
		const s = f.json("groups/summary.json");
		assert.equal(s.groups.project.p.cacheRead, 30);
		assert.equal(s.groups.role.worker.cacheRead, 10);
		assert.equal(s.groups.role.concierge.cacheRead, 20);
		assert.equal(s.groups.model.sonnet.cacheRead, 30);
		assert.equal(s.groups.day["2026-01-01"].cacheRead, 10);
		assert.equal(s.groups.day["2026-01-02"].cacheRead, 20);
		assert.equal(s.totals.input, 20);
		assert.equal(s.totals.cacheCreation, 40);
		assert.equal(s.totals.output, 10);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("ゼロ分母はnull、保存入力の改変は比較拒否、入力配下への出力は拒否する", () => {
	const f = fixture();
	try {
		writeFileSync(f.file, `${JSON.stringify(row("zero", 0))}\n`);
		assert.equal(f.snapshot("before").status, 0);
		writeFileSync(f.file, `${JSON.stringify(row("zero-after", 0, "2026-01-08T00:00:00Z"))}\n`);
		assert.equal(f.snapshot("after", "2026-01-08T00:00:00Z", "2026-01-15T00:00:00Z").status, 0);
		const compare = (out: string) =>
			f.run(
				"compare",
				"--before",
				path.join(f.root, "before/summary.json"),
				"--after",
				path.join(f.root, "after/summary.json"),
				"--out",
				path.join(f.root, out),
			);
		assert.equal(compare("zero").status, 0);
		assert.equal(f.json("zero/summary.json").reduction.rate, null);
		writeFileSync(path.join(f.root, "before/input/000000.jsonl"), "changed");
		assert.equal(compare("tampered").status, 3);
		const out = path.join(f.home, "projects/output");
		assert.equal(
			f.run(
				"snapshot",
				"--claude-home",
				f.home,
				"--from",
				"2026-01-01T00:00:00Z",
				"--until",
				"2026-01-08T00:00:00Z",
				"--out",
				out,
			).status,
			2,
		);
		assert.equal(existsSync(out), false);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
