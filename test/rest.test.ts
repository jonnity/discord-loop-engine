import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Rest } from "../src/rest.ts";

test("REST: multipartの実bytesとMessage保持、channel GET、429を1回だけ再試行", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-rest-"));
	const file = path.join(dir, "demo.mp4");
	writeFileSync(file, "movie");
	let calls = 0;
	const sleeps: number[] = [];
	const message = {
		id: "123",
		channel_id: "456",
		attachments: [
			{ id: "789", filename: "demo.mp4", size: 5, url: "https://cdn.discordapp.com/attachments/456/789/demo.mp4" },
		],
	};
	const rest = new Rest({
		token: "fake",
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		fetchImpl: async (url, init) => {
			calls++;
			if (calls === 1) return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 });
			if (String(url).endsWith("/messages")) {
				assert.ok(init?.body instanceof FormData);
				assert.equal(await (init.body.get("files[0]") as Blob).text(), "movie");
				assert.deepEqual(JSON.parse(String(init.body.get("payload_json"))).allowed_mentions, { parse: [] });
				return Response.json(message);
			}
			assert.equal(init?.method, "GET");
			return Response.json({ id: "456", guild_id: "900", type: 0 });
		},
	});
	try {
		assert.deepEqual(await rest.sendMessage("456", { content: "text", files: [file] }), message);
		assert.equal((await rest.channel("456")).guild_id, "900");
		assert.deepEqual(sleeps, [10]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
