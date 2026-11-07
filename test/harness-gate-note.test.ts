// 承認依頼（harness-phase awaiting-merge）に載る、未確認の検査の注記を確かめる。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(root, "tests/harness/fixtures");
const media = path.join(fixtures, "media");
const HEAD = "a".repeat(40); // phase-gh.ts の現在の head
const BASE = { project: "test", repo: "example/project", hooks: {}, notify: { envFiles: [] } };
const UNKNOWN = "現在の head の gate 結果が無く、未確認の有無は不明";

function setup(config: unknown = { ...BASE, gate: [{ name: "t", run: "true" }] }) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-gn-"));
	mkdirSync(path.join(dir, ".claude"));
	mkdirSync(path.join(dir, ".harness"));
	mkdirSync(path.join(dir, "tmp"));
	const cfg = path.join(dir, ".claude/harness.json");
	writeFileSync(cfg, typeof config === "string" ? config : JSON.stringify(config));
	const env = {
		...process.env,
		HARNESS_CONFIG: cfg,
		PATH: `${media}:${fixtures}:${process.env.PATH}`,
		CLAUDE_PROJECT_DIR: dir,
		DLE_HOME: dir,
		DLE_SOCKET: path.join(dir, "no.sock"),
		DISCORD_WEBHOOK_URL: `https://discord.com/${"api"}/webhooks/123/token?thread_id=456&wait=false`,
		PHASE_STUB: "1",
		PHASE_GH_FIXTURE: path.join(fixtures, "phase-gh.ts"),
		MEDIA_LOG: path.join(dir, "log"),
		POST_BODY: path.join(dir, "body"),
		CURL_ARGS: path.join(dir, "curl"),
		TMPDIR: path.join(dir, "tmp"),
	};
	const result = (r: unknown) =>
		writeFileSync(path.join(dir, ".harness/gate-result.json"), typeof r === "string" ? r : JSON.stringify(r));
	return { dir, env, result };
}
function phase(dir: string, env: NodeJS.ProcessEnv, summary?: string) {
	const args = ["3", "awaiting-merge", "--pr", "5", "--comment", "説明"];
	if (summary !== undefined) args.push("--summary", summary);
	return new Promise<{ code: number; stderr: string; body: string; sent: string }>((resolve) => {
		execFile(path.join(root, "bin/harness-phase"), args, { env, cwd: dir, timeout: 20000 }, (err, _stdout, stderr) => {
			const read = (f: string | undefined) => {
				try {
					return readFileSync(f ?? "", "utf8");
				} catch {
					return "";
				}
			};
			resolve({ code: err ? Number(err.code) : 0, stderr, body: read(env.POST_BODY), sent: read(env.CURL_ARGS) });
		});
	});
}
const good = (over: Record<string, unknown> = {}) => ({
	version: 1,
	head: HEAD,
	dirty: false,
	policy: "warn",
	skipped: ["shellcheck"],
	failed: [],
	...over,
});

test("R-S1: 現 head・clean の未確認が、本文は marker 直前・要約は先頭に載る", async () => {
	const h = setup();
	try {
		h.result(good());
		const r = await phase(h.dir, h.env);
		assert.equal(r.code, 0, r.stderr);
		const note = "⚠ 未確認の検査: shellcheck（CI で初めて検査される）";
		assert.ok(r.body.indexOf("説明") < r.body.indexOf(note));
		assert.ok(r.body.includes(`${note}\n\n<!-- harness:gate`));
		assert.ok(r.sent.includes(note));
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});
test("R-S2: gate 定義ありで結果ファイルが無いと「不明」が載る", async () => {
	const h = setup();
	try {
		const r = await phase(h.dir, h.env);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.body.includes(UNKNOWN));
		assert.ok(r.sent.includes(UNKNOWN));
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});
test("R-S3: 古い・壊れた・形の不正な結果は「不明」で、古い名前を載せない", async () => {
	const cases: unknown[] = [
		good({ head: "b".repeat(40) }),
		good({ dirty: true }),
		"{broken",
		good({ version: 2 }),
		good({ version: "1" }),
		{ ...good(), version: undefined },
		good({ head: "xyz" }),
		good({ policy: "other" }),
		good({ skipped: "shellcheck" }),
		good({ skipped: [1] }),
		good({ failed: {} }),
		good({ dirty: "no" }),
		good({ failed: ["t"] }),
	];
	for (const c of cases) {
		const h = setup();
		try {
			h.result(c);
			const r = await phase(h.dir, h.env);
			assert.equal(r.code, 0, r.stderr);
			assert.ok(r.body.includes("不明"), JSON.stringify(c));
			assert.ok(!r.body.includes("未確認の検査: shellcheck"), JSON.stringify(c));
			assert.ok(r.sent.includes("不明") && !r.sent.includes("未確認の検査: shellcheck"), JSON.stringify(c));
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	}
});
test("R-S4: gate 定義なしは結果の有無によらず注記なしで同一出力。壊れた設定は「不明」", async () => {
	const outputs: string[] = [];
	for (const config of [BASE, { ...BASE, gate: [] }, { ...BASE, gate: null }]) {
		for (const withResult of [false, true]) {
			const h = setup(config);
			try {
				if (withResult) h.result(good());
				const r = await phase(h.dir, h.env);
				assert.equal(r.code, 0, r.stderr);
				assert.ok(!r.body.includes("未確認") && !r.body.includes("不明"));
				assert.ok(!r.sent.includes("未確認") && !r.sent.includes("不明"));
				outputs.push(r.body);
			} finally {
				rmSync(h.dir, { recursive: true, force: true });
			}
		}
	}
	assert.equal(new Set(outputs).size, 1);
});
test("R-S5: 未確認が無い現 head の結果は注記なし", async () => {
	const h = setup();
	try {
		h.result(good({ skipped: [] }));
		const r = await phase(h.dir, h.env);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!r.body.includes("未確認") && !r.body.includes("不明"));
		assert.ok(!r.sent.includes("未確認") && !r.sent.includes("不明"));
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});
test("R-S6: 名前が多くても注記は 500 コードポイント以内で、marker 記号は空白になる", async () => {
	const h = setup();
	try {
		const names = Array.from({ length: 60 }, (_, i) => `検査😀${i}<!--x-->`);
		h.result(good({ skipped: names }));
		const r = await phase(h.dir, h.env);
		assert.equal(r.code, 0, r.stderr);
		const line = r.body.split("\n").find((l) => l.startsWith("⚠ 未確認の検査:")) ?? "";
		assert.ok(line.length > 0);
		assert.ok(Array.from(line).length <= 500);
		assert.match(line, /…他 \d+ 件/);
		assert.equal(r.body.split("<!--").length, 2); // 本物の marker だけ
	} finally {
		rmSync(h.dir, { recursive: true, force: true });
	}
});
