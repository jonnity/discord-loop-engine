import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

function config(extra: Record<string, unknown>) {
	const home = mkdtempSync(path.join(os.tmpdir(), "dle-config-"));
	try {
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({ channelIds: ["1"], allowedUserIds: ["2"], ...extra }),
		);
		return loadConfig(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("refresh の既定値は有効・100k・180秒・30分、Codex の待機上限は120分", () => {
	const c = config({});
	assert.deepEqual(c.concierge.refresh, { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 });
	assert.deepEqual(c.worker.refresh, {
		enabled: true,
		maxTokens: 100000,
		contextPercent: 15,
		idleSeconds: 180,
		cooldownMinutes: 30,
		codexIgnoreAfterMinutes: 120,
	});
});

test("旧 maxEvents: 0 は全無効を保ち、enabled の明示を優先する", () => {
	assert.equal(config({ concierge: { refresh: { maxEvents: 0 } } }).concierge.refresh.enabled, false);
	assert.equal(config({ concierge: { refresh: { maxEvents: 0, enabled: true } } }).concierge.refresh.enabled, true);
	assert.equal(config({ concierge: { refresh: { enabled: false } } }).concierge.refresh.enabled, false);
});

test("負数・文字列・範囲外は既定値に戻し、0 のトークン閾値は保持する", () => {
	const c = config({
		concierge: { refresh: { maxEvents: -1, maxTokens: "100", contextPercent: 101 } },
		worker: {
			refresh: { enabled: false, maxTokens: 0, idleSeconds: -1, cooldownMinutes: "30", codexIgnoreAfterMinutes: -1 },
		},
	});
	assert.equal(c.concierge.refresh.maxEvents, 40);
	assert.equal(c.concierge.refresh.maxTokens, 100000);
	assert.equal(c.concierge.refresh.contextPercent, 15);
	assert.equal(c.worker.refresh.enabled, false);
	assert.equal(c.worker.refresh.maxTokens, 0);
	assert.equal(c.worker.refresh.idleSeconds, 180);
	assert.equal(c.worker.refresh.cooldownMinutes, 30);
	assert.equal(c.worker.refresh.codexIgnoreAfterMinutes, 120);
});
