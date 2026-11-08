import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { object } from "../src/notification-receipt.ts";
import { Rest } from "../src/rest.ts";
import { DEFAULT_REACTION_EMOJI } from "../src/route.ts";

const root = path.resolve(import.meta.dirname, "..");
const head = "a".repeat(40);
for (const mode of [
	"normal",
	"retry",
	"recover",
	"429",
	"guild-missing",
	"channel",
	"response-channel",
	"old",
	"invalid",
	"recovery",
] as const) {
	test(`#75 T2/T5/T6: RPCから動画承認とcleanupまで（${mode}）`, async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "dle75-"));
		mkdirSync(path.join(home, "tmp"));
		writeFileSync(
			path.join(home, "config.json"),
			JSON.stringify({
				channelIds: ["900", "456"],
				defaultChannelId: "456",
				allowedUserIds: ["111"],
				board: { enabled: false },
			}),
		);
		const config = loadConfig(home);
		config.socketPath = path.join(home, "engine.sock");
		const harness = path.join(home, "harness.json");
		writeFileSync(
			harness,
			JSON.stringify({
				project: "test",
				repo: "example/project",
				owners: ["111"],
				worktreeRoot: path.join(home, "worktrees"),
				hooks: {},
				notify: { envFiles: [] },
			}),
		);
		let gets = 0,
			sleeps = 0,
			sent = 0;
		const posts: { id: string; content: string; file?: string }[] = [];
		let reaction: (d: unknown, kind: "add" | "remove") => void = () => {};
		const rest = new Rest({
			token: "fixture-only",
			sleep: () => {
				sleeps++;
				return Promise.resolve();
			},
			fetchImpl: async (url, init) => {
				const route = String(url).replace("https://discord.com/api/v10", "");
				if (route === "/channels/456" && init?.method === "GET") {
					gets++;
					if (mode === "429" || (mode === "retry" && gets === 1))
						return new Response(JSON.stringify({ retry_after: 0 }), { status: 429 });
					if (mode === "retry") {
						assert.match(state().comments.at(-1).body, /harness:pending/);
						await answer(posts[0]?.id ?? "");
						const early = await call("harness-merge", ["3", "--chat-approval", "OK", "--attention", "A-1"]);
						assert.equal(early.code, 1, early.stderr);
						assert.doesNotMatch(readFileSync(env.MEDIA_LOG, "utf8"), /^merge /m);
					}
					return Response.json({
						id: mode === "channel" ? "900" : "456",
						guild_id: mode === "guild-missing" ? undefined : "123",
					});
				}
				if (route === "/channels/456/messages" && init?.method === "POST") {
					const form = init.body;
					let content: string,
						attachment: unknown[] = [],
						file: string | undefined;
					if (form instanceof FormData) {
						content = object(JSON.parse(String(form.get("payload_json")))).content as string;
						const blob = form.get("files[0]");
						assert.ok(blob instanceof File);
						const bytes = Buffer.from(await blob.arrayBuffer());
						assert.deepEqual(bytes, readFileSync(path.join(root, "tests/harness/fixtures/media/tiny.mp4")));
						file = path.join(home, "sent.mp4");
						writeFileSync(file, bytes);
						attachment = [
							{
								id: "111",
								filename: blob.name,
								size: bytes.length,
								url: "https://cdn.discordapp.com/attachments/456/111/demo.mp4?signature=secret",
							},
						];
					} else content = object(JSON.parse(String(form))).content as string;
					const id = String(++sent);
					if (content.startsWith("🟢 ")) posts.push({ id, content, file });
					return Response.json({
						id,
						channel_id: mode === "response-channel" ? "900" : "456",
						attachments: attachment,
					});
				}
				if (/^\/channels\/456\/messages\/[1-9][0-9]*\/reactions\//.test(route) && init?.method === "PUT")
					return new Response(null, { status: 204 });
				throw Error(`未知のfixture要求: ${route}`);
			},
		});
		const engine = new Engine({
			config,
			rest,
			log: () => {},
			gatewayFactory: (handlers) => {
				reaction = handlers.onReaction;
				return { start() {}, stop() {}, connected: true, user: { id: "999" } };
			},
		});
		// 旧engineと不正診断だけをRPC境界で注入し、他の状態は実Engineで作る。
		const original = engine.call.bind(engine);
		engine.call = async (who, method, args) => {
			const result = await original(who, method, args);
			if (method === "notify" && object(args).event === "merge-request") {
				const r = object(result);
				if (mode === "old") {
					delete r.discord;
					delete r.discord_error;
				}
				if (mode === "invalid") r.discord_error = { stage: "guild", reason: "https://secret\nBot secret\x1b" };
				if (mode === "recovery") {
					const state = path.join(home, ".harness/merge-recovery-3.json");
					rmSync(state);
					mkdirSync(state);
					writeFileSync(path.join(state, "keep"), "復旧書込不能");
					r.discord_error = { stage: "guild", reason: "fetch-failed" };
				}
			}
			return result;
		};
		const env = {
			...process.env,
			DLE_HOME: home,
			DLE_SOCKET: config.socketPath,
			DLE_PROJECT: "test",
			HARNESS_CONFIG: harness,
			CLAUDE_PROJECT_DIR: home,
			PATH: `${root}/tests/harness/fixtures:${process.env.PATH}`,
			PHASE_STUB: "1",
			MEDIA_LOG: path.join(home, "log"),
			POST_BODY: path.join(home, "body"),
			SENT_COPY: path.join(home, "sent.mp4"),
			TMPDIR: path.join(home, "tmp"),
			DISCORD_WEBHOOK_URL: "",
			NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${root}/tests/harness/fixtures/media/receipt-fetch.ts`,
		};
		const call = (bin: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
			new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
				execFile(
					path.join(root, "bin", bin),
					args,
					{ cwd: home, env: { ...env, ...extra }, timeout: 20000 },
					(error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
				);
			});
		const state = () => JSON.parse(readFileSync(path.join(home, "gh-state.json"), "utf8"));
		const answer = async (messageId: string) => {
			reaction(
				{
					user_id: "111",
					channel_id: "456",
					message_id: messageId,
					guild_id: "123",
					emoji: { id: null, name: DEFAULT_REACTION_EMOJI },
					member: { user: { id: "111", username: "owner" } },
				},
				"add",
			);
			for (let n = 0; n < 100 && engine.ledger.openAttention().some((a) => a.messageId === messageId); n++)
				await delay(10);
			assert.equal(
				engine.ledger.openAttention().some((a) => a.messageId === messageId),
				false,
			);
		};
		try {
			await engine.start();
			const comment = path.join(home, "comment.md");
			writeFileSync(comment, `動画の確認\n${"あ".repeat(4000)}`);
			let oldAttention = "";
			if (mode === "recover") {
				const failed = await call(
					"harness-phase",
					[
						"3",
						"awaiting-merge",
						"--pr",
						"5",
						"--comment-file",
						comment,
						"--summary",
						"あ".repeat(3500),
						"--file",
						path.join(root, "tests/harness/fixtures/media/tiny.mp4"),
					],
					{ RECEIPT_FAIL: "1" },
				);
				assert.equal(failed.code, 7, failed.stderr);
				assert.match(failed.stderr, /stage=download reason=failed/);
				assert.match(state().comments.at(-1).body, /harness:pending/);
				const old = engine.ledger.openAttention()[0];
				assert.ok(old?.messageId);
				oldAttention = old.id;
				await answer(old.messageId);
				posts.length = 0;
				gets = 0;
				sleeps = 0;
			}
			const result = await call("harness-phase", [
				"3",
				"awaiting-merge",
				"--pr",
				"5",
				"--comment-file",
				comment,
				"--summary",
				"あ".repeat(3500),
				"--file",
				path.join(root, "tests/harness/fixtures/media/tiny.mp4"),
			]);
			assert.deepEqual(readdirSync(path.join(home, "tmp")), []);
			assert.equal(gets, mode === "429" || mode === "retry" ? 2 : 1);
			assert.equal(sleeps, mode === "429" || mode === "retry" ? 1 : 0);
			const att = engine.ledger.attention().at(-1);
			assert.ok(att);
			assert.equal(att.messageId, posts[0]?.id);
			assert.ok(posts.length > 1);
			assert.ok(posts.at(-1)?.file);
			assert.ok(posts.slice(0, -1).every((p) => !p.file));
			const success = mode === "normal" || mode === "retry" || mode === "recover";
			assert.equal(result.code, success ? 0 : 7, result.stderr);
			const recovery = path.join(home, ".harness/merge-recovery-3.json");
			const workRecovery = path.join(home, "worktrees/issue-3/.harness/merge-recovery-3.json");
			if (!success) {
				const expected = {
					"429": "guild reason=fetch-failed",
					"guild-missing": "guild reason=unavailable",
					channel: "channel reason=metadata-mismatch",
					"response-channel": "channel reason=mismatch",
					old: "message reason=missing",
					invalid: "input reason=invalid",
					recovery: "guild reason=fetch-failed",
				}[mode];
				assert.ok(result.stderr.includes(`stage=${expected}`), result.stderr);
				assert.equal(result.stderr.split("\n").filter((s) => s.includes("stage=")).length, 1);
				assert.doesNotMatch(result.stderr, /https:|Bot secret|signature=| at /);
				assert.equal(result.stderr.includes("\x1b"), false);
				if (mode === "recovery") assert.match(result.stderr, /復旧状態は未確認/);
				assert.ok(existsSync(recovery));
				assert.ok(existsSync(workRecovery));
				assert.match(state().comments.at(-1).body, /harness:pending/);
			} else {
				assert.equal(existsSync(recovery), false);
				assert.equal(existsSync(workRecovery), false);
				const body = state().comments.at(-1).body;
				assert.match(body, new RegExp(`sha=${head} attention=${att.id}`));
				assert.match(body, new RegExp(`/123/456/${posts.at(-1)?.id}`));
				assert.match(body, /再取得照合済み/);
				assert.doesNotMatch(body, /harness:pending/);
			}
			assert.deepEqual(state().labels, ["harness:awaiting-merge"]);
			// 許可された人のリアクションを実Engineに渡し、保存回答をinboxとmergeに読ませる。
			if (oldAttention) {
				assert.notEqual(att.id, oldAttention);
				for (const id of [oldAttention, att.id]) {
					const rejected = await call("harness-merge", ["3", "--chat-approval", "OK", "--attention", id]);
					assert.equal(rejected.code, 1, rejected.stderr);
				}
				assert.doesNotMatch(readFileSync(env.MEDIA_LOG, "utf8"), /^merge /m);
			}
			await answer(att.messageId ?? "");
			const inbox = await call("harness-inbox");
			assert.equal(inbox.code, 0, inbox.stderr);
			const event = JSON.parse(inbox.stdout);
			if (success) {
				assert.equal(event.kind, "chat-merge-ok");
				assert.equal(event.attention, att.id);
			}
			const merge = await call(
				"harness-merge",
				["3", "--chat-approval", "OK", "--attention", att.id],
				success ? { CI_BAD: "1" } : {},
			);
			assert.equal(merge.code, 1, merge.stderr);
			assert.doesNotMatch(readFileSync(env.MEDIA_LOG, "utf8"), /^merge /m);
			if (success) {
				const merged = await call("harness-merge", [
					"3",
					"--chat-approval",
					event.body,
					"--attention",
					event.attention,
				]);
				assert.equal(merged.code, 0, merged.stderr);
				const lines = readFileSync(env.MEDIA_LOG, "utf8")
					.split("\n")
					.filter((s) => s.startsWith("merge "));
				assert.equal(lines.length, 1);
				assert.ok(lines[0]?.includes(`--match-head-commit ${head}`));
			}
		} finally {
			await engine.stop();
			rmSync(home, { recursive: true, force: true });
		}
	});
}
