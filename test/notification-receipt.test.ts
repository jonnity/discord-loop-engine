import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fingerprint, normalizeReceipt, verifyMedia, webhookTarget } from "../src/notification-receipt.ts";

test("receipt: 3ID は文字列のまま、thread/query を維持する", () => {
	const target = webhookTarget("https://discord.com/api/webhooks/123/token?thread_id=456&wait=false");
	assert.equal(new URL(target.post).searchParams.get("wait"), "true");
	assert.equal(new URL(target.post).searchParams.get("thread_id"), "456");
	assert.equal(target.meta, "https://discord.com/api/webhooks/123/token");
	assert.equal(
		normalizeReceipt({ id: "789", channel_id: "456", attachments: [] }, "123", "456")?.url,
		"https://discord.com/channels/123/456/789",
	);
	assert.equal(normalizeReceipt({ id: "789", channel_id: "999", attachments: [] }, "123", "456"), undefined);
});

test("receipt: 実ファイルへ再取得し全bytes/hash一致、改変・不正応答を拒否する", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-receipt-"));
	const source = path.join(dir, "demo-3-h264.mp4"),
		output = path.join(dir, "download.mp4");
	const bytes = Buffer.from("fixture mp4 bytes");
	writeFileSync(source, bytes);
	const fp = await fingerprint(source);
	const receipt = normalizeReceipt(
		{
			id: "789",
			channel_id: "456",
			attachments: [
				{
					id: "111",
					filename: fp.filename,
					size: fp.bytes,
					url: "https://cdn.discordapp.com/attachments/456/111/demo.mp4?secret=signed",
				},
			],
		},
		"123",
		"456",
	);
	assert.ok(receipt);
	try {
		for (const length of [null, String(bytes.length)]) {
			const verified = await verifyMedia(receipt, fp, source, output, async (_url, init) => {
				assert.equal(init?.redirect, "error");
				assert.equal(init?.headers, undefined);
				return new Response(bytes, { headers: length ? { "Content-Length": length } : {} });
			});
			assert.equal(verified.verified, true);
			assert.deepEqual(readFileSync(output), bytes);
		}
		for (const body of [
			Buffer.alloc(0),
			Buffer.from("fixture mp4 byteX"),
			Buffer.concat([bytes, bytes]),
			bytes.subarray(1),
		]) {
			await assert.rejects(verifyMedia(receipt, fp, source, output, async () => new Response(body)));
		}
		for (const status of [403, 404, 302])
			await assert.rejects(verifyMedia(receipt, fp, source, output, async () => new Response("", { status })));
		for (const url of [
			"http://cdn.discordapp.com/attachments/a",
			"https://evil.test/attachments/a",
			"https://user@cdn.discordapp.com/attachments/a",
			"https://cdn.discordapp.com/other/a",
		]) {
			await assert.rejects(
				verifyMedia({ ...receipt, attachments: [{ ...receipt.attachments[0], url }] }, fp, source, output, async () => {
					throw Error("unexpected fetch");
				}),
			);
		}
		for (const attachments of [[], [receipt.attachments[0], receipt.attachments[0]]])
			await assert.rejects(verifyMedia({ ...receipt, attachments }, fp, source, output));
		await assert.rejects(verifyMedia({ ...receipt, url: "https://discord.com/channels/1/2/3" }, fp, source, output));
		await assert.rejects(verifyMedia(receipt, fp, source, output));
		writeFileSync(source, "changed");
		await assert.rejects(verifyMedia(receipt, fp, source, output, async () => new Response(bytes)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("M3: Content-Lengthの嘘・stream切断・全体timeout・送信元の途中変更を拒否する", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-stream-"));
	const source = path.join(dir, "demo.mp4"),
		output = path.join(dir, "download.mp4");
	writeFileSync(source, "movie");
	const fp = await fingerprint(source);
	const receipt = normalizeReceipt(
		{
			id: "3",
			channel_id: "2",
			attachments: [
				{ id: "4", filename: "demo.mp4", size: 5, url: "https://cdn.discordapp.com/attachments/2/4/demo.mp4" },
			],
		},
		"1",
		"2",
	);
	try {
		for (const length of ["4", "6", "bad"])
			await assert.rejects(
				verifyMedia(
					receipt,
					fp,
					source,
					output,
					async () => new Response("movie", { headers: { "content-length": length } }),
				),
			);
		await assert.rejects(
			verifyMedia(
				receipt,
				fp,
				source,
				output,
				async () =>
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new Uint8Array([1]));
								c.error(Error("disconnected"));
							},
						}),
					),
			),
		);
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, async () => new Promise<Response>(() => {}), 20),
			/timeout/,
		);
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, async () => new Response(new ReadableStream()), 20),
			/timeout/,
		);
		await assert.rejects(
			verifyMedia(receipt, fp, source, output, async () => {
				writeFileSync(source, "other");
				return new Response("movie");
			}),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
