import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	fingerprint,
	formatReceiptFailure,
	inspectReceipt,
	MediaVerificationError,
	normalizeReceipt,
	parseReceiptFailure,
	receiptFailure,
	verifyMedia,
} from "../src/notification-receipt.ts";

const message = {
	id: "12345678901234567890",
	channel_id: "2",
	attachments: [{ id: "4", filename: "demo.mp4", size: 5, url: "https://cdn.discordapp.com/attachments/2/4/demo.mp4" }],
};
const failure = (stage: string, reason: string) => (error: unknown) => {
	assert.ok(error instanceof MediaVerificationError);
	assert.deepEqual(error.failure, { stage, reason });
	assert.equal(error.message.includes("\x1b"), false);
	assert.doesNotMatch(error.message, /https:|Bot secret|\n/);
	return true;
};

test("#75 T1: 受領検査は互換receiptと固定の失敗理由を返す", () => {
	const good = inspectReceipt(message, "1", "2");
	assert.deepEqual(good.receipt, normalizeReceipt(message, "1", "2"));
	assert.equal(good.receipt?.message_id, message.id);
	assert.equal(good.failure, undefined);
	for (const [raw, guild, expected, stage, reason] of [
		[undefined, "1", "2", "message", "missing"],
		[{ ...message, id: "bad" }, "1", "2", "message", "invalid"],
		[message, "1", "3", "channel", "mismatch"],
		[message, undefined, "2", "guild", "unavailable"],
		[{ ...message, attachments: [{}] }, "1", "2", "attachment", "mismatch"],
	] as const) {
		const result = inspectReceipt(raw, guild, expected);
		assert.deepEqual(result.failure, { stage, reason });
		assert.deepEqual(result.receipt, normalizeReceipt(raw, guild, expected));
	}
	assert.equal(inspectReceipt(message, undefined, "2").receipt?.link_error, "guild-unavailable");
});

test("#75 T4: 診断は組合せを許可し、外部の本文・余分な情報を表示しない", () => {
	for (const raw of [null, {}, { stage: "guild", reason: "missing" }, { stage: "https://secret", reason: "x\n" }])
		assert.throws(() => parseReceiptFailure(raw), failure("input", "invalid"));
	assert.deepEqual(receiptFailure(Error("https://secret\nBot secret")), {
		stage: "verification",
		reason: "unexpected",
	});
	assert.equal(
		formatReceiptFailure(parseReceiptFailure({ stage: "channel", reason: "metadata-mismatch" })),
		"stage=channel reason=metadata-mismatch 段階=チャンネル照合 理由=GETの応答IDが期待するチャンネルIDと一致しない",
	);
	assert.equal(
		formatReceiptFailure({ stage: "channel", reason: "mismatch" }),
		"stage=channel reason=mismatch 段階=チャンネル照合 理由=投稿先と応答先が一致しない",
	);
	const parsed = parseReceiptFailure({ stage: "guild", reason: "fetch-failed", secret: "Bot secret\nhttps://secret" });
	assert.deepEqual(parsed, { stage: "guild", reason: "fetch-failed" });
	assert.equal(
		formatReceiptFailure(parsed),
		"stage=guild reason=fetch-failed 段階=guild確認 理由=投稿先の情報を取得できない",
	);
});

test("#75 T3: 各境界の失敗を分類し、正常時は実ファイル全bytesが一致する", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle75-unit-"));
	const source = path.join(dir, "demo.mp4"),
		output = path.join(dir, "download.mp4");
	writeFileSync(source, "movie");
	const fp = await fingerprint(source);
	const receipt = normalizeReceipt(message, "1", "2");
	const ok = () => Promise.resolve(new Response("movie"));
	try {
		assert.equal((await verifyMedia(receipt, fp, source, output, ok)).verified, true);
		assert.deepEqual(readFileSync(output), readFileSync(source));
		await assert.rejects(verifyMedia(undefined, fp, source, output, ok), failure("message", "missing"));
		await assert.rejects(
			verifyMedia({ ...receipt, url: "bad" }, fp, source, output, ok),
			failure("message", "invalid"),
		);
		await assert.rejects(
			verifyMedia({ ...receipt, guild_id: null }, fp, source, output, ok),
			failure("guild", "unavailable"),
		);
		await assert.rejects(verifyMedia(receipt, {}, source, output, ok), failure("input", "invalid"));
		for (const attachments of [
			[],
			[message.attachments[0], message.attachments[0]],
			[{ ...message.attachments[0], size: 6 }],
		])
			await assert.rejects(
				verifyMedia({ ...receipt, attachments }, fp, source, output, ok),
				failure("attachment", "mismatch"),
			);
		for (const url of [
			"bad\nBot secret",
			"https://evil.test/attachments/x",
			"https://user@cdn.discordapp.com/attachments/x",
		])
			await assert.rejects(
				verifyMedia({ ...receipt, attachments: [{ ...message.attachments[0], url }] }, fp, source, output, ok),
				failure("attachment-url", "invalid"),
			);
		for (const fetcher of [
			() => Promise.reject(Error("https://secret?token=x\nBot secret\x1b")),
			() => Promise.resolve(new Response(null, { status: 204 })),
			() => Promise.resolve(new Response("", { status: 403 })),
			() =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(c) {
								c.error(Error("Bot secret"));
							},
						}),
					),
				),
			() => new Promise<Response>(() => {}),
			() => Promise.resolve(new Response(new ReadableStream())),
		])
			await assert.rejects(verifyMedia(receipt, fp, source, output, fetcher, 10), failure("download", "failed"));
		const unexpected = new Response("movie");
		Object.defineProperty(unexpected, "headers", {
			get() {
				throw Error("https://secret?token=x\nBot secret");
			},
		});
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, () => Promise.resolve(unexpected)),
			failure("verification", "unexpected"),
		);
		for (const fetcher of [
			() => Promise.resolve(new Response("other")),
			() => Promise.resolve(new Response("movie!")),
			() => Promise.resolve(new Response("movie", { headers: { "content-length": "bad" } })),
		])
			await assert.rejects(verifyMedia(receipt, fp, source, output, fetcher), failure("integrity", "mismatch"));
		await assert.rejects(verifyMedia(receipt, fp, source, dir, ok), failure("input", "invalid"));
		await assert.rejects(verifyMedia(receipt, fp, `${dir}/missing`, output, ok), failure("input", "invalid"));
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, () => {
				writeFileSync(source, "other");
				return ok();
			}),
			failure("integrity", "mismatch"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#75 T4: CLIの不正JSONでもstdoutは空、stderrは秘密なしの1行", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle75-cli-"));
	try {
		const bad = path.join(dir, "bad.json");
		writeFileSync(bad, "https://secret?token=x\nBot secret\x1b");
		for (const args of [
			["verify", bad, bad, bad, bad],
			["webhook-normalize", bad, bad, "https://secret"],
		]) {
			const r = spawnSync(process.execPath, ["src/notification-receipt.ts", ...args], { encoding: "utf8" });
			assert.equal(r.status, 1);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /stage=input reason=invalid/);
			assert.equal(r.stderr.trim().split("\n").length, 1);
			assert.equal(r.stderr.includes("\x1b"), false);
			assert.doesNotMatch(r.stderr, /https:|Bot secret| at /);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#75 T1/T4: webhook metadata欠落を捏造せず、threadと任意診断をJSONで返す", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle75-webhook-"));
	try {
		const messageFile = path.join(dir, "message.json"),
			metaFile = path.join(dir, "meta.json");
		writeFileSync(messageFile, JSON.stringify(message));
		for (const [meta, expected] of [
			[{ channel_id: "9", guild_id: "1" }, undefined],
			[{}, { stage: "guild", reason: "unavailable" }],
			[{ channel_id: "9" }, { stage: "guild", reason: "unavailable" }],
		] as const) {
			writeFileSync(metaFile, JSON.stringify(meta));
			const r = spawnSync(
				process.execPath,
				[
					"src/notification-receipt.ts",
					"webhook-normalize",
					messageFile,
					metaFile,
					"https://discord.com/api/webhooks/123/token?thread_id=2",
				],
				{ encoding: "utf8" },
			);
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.stderr, "");
			const result = JSON.parse(r.stdout);
			assert.equal(result.status, "posted");
			assert.equal(result.source, "webhook");
			assert.equal(result.attention, null);
			assert.deepEqual(result.discord_error, expected);
			if (Object.keys(meta).length) assert.equal(result.discord.channel_id, "2");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#75 T3/T4: verify CLIもtyped診断を1行にし、streamのtimeoutでabortとlock解放を行う", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle75-verify-"));
	try {
		const source = path.join(dir, "demo.mp4"),
			output = path.join(dir, "download.mp4");
		writeFileSync(source, "movie");
		const fp = await fingerprint(source);
		const receipt = normalizeReceipt(message, "1", "2");
		const receiptFile = path.join(dir, "receipt.json"),
			fpFile = path.join(dir, "fingerprint.json");
		writeFileSync(fpFile, JSON.stringify(fp));
		for (const [raw, expected] of [
			[null, "message reason=missing"],
			[{ ...receipt, guild_id: null }, "guild reason=unavailable"],
			[
				{ ...receipt, attachments: [{ ...message.attachments[0], url: "https://secret?token=x\nBot secret" }] },
				"attachment-url reason=invalid",
			],
			[receipt, "download reason=failed"],
		] as const) {
			writeFileSync(receiptFile, JSON.stringify(raw));
			const r = spawnSync(
				process.execPath,
				["src/notification-receipt.ts", "verify", receiptFile, fpFile, source, output],
				{ encoding: "utf8" },
			);
			assert.equal(r.status, 1);
			assert.equal(r.stdout, "");
			assert.ok(r.stderr.includes(`stage=${expected}`), r.stderr);
			assert.equal(r.stderr.trim().split("\n").length, 1);
			assert.doesNotMatch(r.stderr, /https:|Bot secret|token=| at /);
		}
		let signal: AbortSignal | null | undefined,
			cancelled = false;
		const stream = new ReadableStream({
			cancel() {
				cancelled = true;
			},
		});
		await assert.rejects(
			verifyMedia(
				receipt,
				fp,
				source,
				output,
				(_url, init) => {
					signal = init?.signal;
					return Promise.resolve(new Response(stream));
				},
				10,
			),
			failure("download", "failed"),
		);
		assert.equal(signal?.aborted, true);
		assert.equal(cancelled, true);
		assert.equal(stream.locked, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#75 T3: ヘッダー不一致でもbodyを回収し、cancel失敗でサイズ超過の一次理由を上書きしない", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle75-cancel-"));
	try {
		const source = path.join(dir, "demo.mp4"),
			output = path.join(dir, "download.mp4");
		writeFileSync(source, "movie");
		const fp = await fingerprint(source),
			receipt = normalizeReceipt(message, "1", "2");
		let cancelled = false;
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, () =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							cancel() {
								cancelled = true;
							},
						}),
						{ headers: { "content-length": "99" } },
					),
				),
			),
			failure("integrity", "mismatch"),
		);
		assert.equal(cancelled, true);
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, () =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new Uint8Array(6));
							},
							cancel() {
								throw Error("https://secret?token=x");
							},
						}),
					),
				),
			),
			failure("integrity", "mismatch"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
