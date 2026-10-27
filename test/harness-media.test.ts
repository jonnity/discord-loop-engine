// 動画準備の中断・道具の不足・実際の変換を隔離環境で確認する。
import "./isolate.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(root, "tests/harness/fixtures");
const media = path.join(fixtures, "media");
function setup() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "dle-m-"));
	mkdirSync(path.join(dir, ".claude"));
	mkdirSync(path.join(dir, "tmp"));
	writeFileSync(
		path.join(dir, ".claude/harness.json"),
		JSON.stringify({ project: "test", repo: "example/project", hooks: {}, notify: { envFiles: [] } }),
	);
	const input = path.join(dir, "動画 'demo'.mp4");
	writeFileSync(input, "source");
	const env = {
		...process.env,
		HARNESS_CONFIG: path.join(dir, ".claude/harness.json"),
		PATH: `${media}:${fixtures}:${process.env.PATH}`,
		CLAUDE_PROJECT_DIR: dir,
		DLE_HOME: dir,
		DLE_SOCKET: path.join(dir, "no.sock"),
		DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token?thread_id=456&wait=false",
		NODE_OPTIONS: `${process.env.NODE_OPTIONS} --import=${path.join(media, "receipt-fetch.ts")}`,
		PHASE_STUB: "1",
		PHASE_GH_FIXTURE: path.join(fixtures, "phase-gh.ts"),
		MEDIA_MODE: "webm",
		MEDIA_LOG: path.join(dir, "log"),
		MEDIA_PID: path.join(dir, "pid"),
		POST_BODY: path.join(dir, "body"),
		CURL_ARGS: path.join(dir, "curl"),
		SENT_FILE: path.join(dir, "sent"),
		SENT_COPY: path.join(dir, "copy"),
		TMPDIR: path.join(dir, "tmp"),
	};
	return { dir, env, input, args: ["3", "awaiting-merge", "--pr", "5", "--comment", "説明", "--file", input] };
}
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("開始マーカーの待機期限切れ");
		await new Promise((r) => setTimeout(r, 10));
	}
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(command, args, { env, cwd: env.CLAUDE_PROJECT_DIR, timeout: 15000 }, (err, stdout, stderr) => {
			resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
		});
	});
}
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "child", "ignore"] as const) {
	test(`動画変換: ${signal} の中断を3回連続で回収する`, async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const { dir, env, args, input } = setup();
			const child = spawn(path.join(root, "bin/harness-phase"), args, {
				cwd: dir,
				env: { ...env, CONVERT_MODE: signal === "ignore" ? "ignore" : "wait" },
				stdio: "ignore",
			});
			const done = new Promise<number | null>((r) => child.once("exit", r));
			let converter = 0;
			try {
				await until(() => existsSync(env.MEDIA_PID));
				converter = Number(readFileSync(env.MEDIA_PID, "utf8"));
				if (signal === "child") process.kill(converter, "SIGTERM");
				else child.kill(signal === "ignore" ? "SIGTERM" : signal);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const code = await Promise.race([
					done,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("中断の回収期限切れ")), 5000);
					}),
				]).finally(() => clearTimeout(timer));
				assert.equal(code, signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : signal === "child" ? 6 : 143);
				assert.throws(() => process.kill(converter, 0));
				assert.deepEqual(readdirSync(env.TMPDIR), []);
				assert.equal(readFileSync(input, "utf8"), "source");
				assert.doesNotMatch(readFileSync(env.MEDIA_LOG, "utf8"), /comment|notify|label/);
			} finally {
				child.kill("SIGKILL");
				if (converter) {
					try {
						process.kill(converter, "SIGKILL");
					} catch {}
				}
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});
}
for (const { available, compatible } of [
	{ available: [], compatible: false },
	{ available: ["ffmpeg"], compatible: false },
	{ available: ["ffprobe"], compatible: false },
	{ available: ["ffprobe"], compatible: true },
]) {
	test(`動画変換: ツール存在=${available.join(",")}、適合動画=${compatible}`, async () => {
		const { dir, env, args } = setup();
		const min = path.join(dir, "bin");
		mkdirSync(min);
		try {
			for (const cmd of [
				"bash",
				"dirname",
				"basename",
				"cat",
				"jq",
				"rm",
				"mktemp",
				"wc",
				"cp",
				"grep",
				"tail",
				"date",
				"node",
				"mv",
				...available,
			]) {
				const source = available.includes(cmd)
					? path.join(media, cmd)
					: (await run("which", [cmd], process.env)).stdout.trim();
				symlinkSync(source, path.join(min, cmd));
			}
			symlinkSync(path.join(fixtures, "gh"), path.join(min, "gh"));
			symlinkSync(path.join(media, "curl"), path.join(min, "curl"));
			const r = await run(path.join(root, "bin/harness-phase"), args, {
				...env,
				PATH: min,
				MEDIA_MODE: compatible ? "" : "webm",
			});
			assert.equal(r.code, compatible ? 0 : 6, r.stderr);
			if (compatible) assert.match(readFileSync(env.MEDIA_LOG, "utf8"), /notify\npatch/);
			else {
				assert.match(r.stderr, new RegExp(available.includes("ffprobe") ? "ffmpeg" : "ffprobe"));
				assert.ok(!existsSync(env.MEDIA_LOG) || !/comment|notify|label/.test(readFileSync(env.MEDIA_LOG, "utf8")));
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("実 FFmpeg: 音声なし・奇数寸法の WebM を変換→再検査→添付まで3回連続成功", async (t) => {
	if ((await run("which", ["ffmpeg", "ffprobe"], process.env)).code !== 0) {
		t.skip("FFmpeg がありません");
		return;
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		const { dir, env, args, input } = setup();
		const min = path.join(dir, "bin");
		mkdirSync(min);
		try {
			symlinkSync(path.join(fixtures, "gh"), path.join(min, "gh"));
			symlinkSync(path.join(media, "curl"), path.join(min, "curl"));
			const realEnv = { ...env, PATH: `${min}:${process.env.PATH}` };
			const source = await run(
				"ffmpeg",
				[
					"-nostdin",
					"-v",
					"error",
					"-y",
					"-f",
					"lavfi",
					"-i",
					"color=s=66x64:r=5",
					"-vf",
					"format=yuv444p,crop=65:63",
					"-t",
					"0.4",
					"-c:v",
					"libvpx-vp9",
					"-f",
					"webm",
					input,
				],
				realEnv,
			);
			assert.equal(source.code, 0, source.stderr);
			{
				writeFileSync(env.MEDIA_LOG, "");
				const result = await run(path.join(root, "bin/harness-phase"), args, realEnv);
				assert.equal(result.code, 0, result.stderr);
				const probe = await run(
					"ffprobe",
					["-v", "error", "-show_streams", "-show_format", "-of", "json", env.SENT_COPY],
					realEnv,
				);
				assert.equal(probe.code, 0, probe.stderr);
				const info = JSON.parse(probe.stdout);
				assert.equal(info.streams[0].codec_name, "h264");
				assert.equal(info.streams[0].pix_fmt, "yuv420p");
				assert.equal(info.streams[0].width, 66);
				assert.equal(info.streams[0].height, 64);
				assert.ok(Number(info.format.duration) > 0);
				assert.equal(info.format.tags.major_brand, "isom");
				assert.deepEqual(readdirSync(env.TMPDIR), []);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

for (const mode of ["parent-killed", "process-group"] as const) {
	test(`M5: ${mode} の所有物を3回連続で検出・回収する`, async () => {
		for (let trial = 0; trial < 3; trial++) {
			const { dir, env, args, input } = setup();
			const child = spawn(path.join(root, "bin/harness-phase"), args, {
				cwd: dir,
				env: { ...env, CONVERT_MODE: "wait" },
				detached: true,
				stdio: "ignore",
			});
			const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
				child.once("exit", (code, signal) => resolve({ code, signal })),
			);
			let converter = 0;
			try {
				await until(() => existsSync(env.MEDIA_PID));
				converter = Number(readFileSync(env.MEDIA_PID, "utf8"));
				assert.ok(child.pid);
				if (mode === "parent-killed") {
					child.kill("SIGKILL");
					assert.equal((await done).signal, "SIGKILL");
					assert.doesNotThrow(() => process.kill(converter, 0));
					assert.ok(readdirSync(env.TMPDIR).length > 0);
				} else {
					process.kill(-child.pid, "SIGTERM");
					assert.equal((await done).code, 143);
					assert.deepEqual(readdirSync(env.TMPDIR), []);
				}
				assert.equal(readFileSync(input, "utf8"), "source");
				assert.doesNotMatch(readFileSync(env.MEDIA_LOG, "utf8"), /comment|notify|label/);
			} finally {
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
				if (converter) {
					try {
						process.kill(converter, "SIGKILL");
					} catch {}
				}
				await done;
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});
}
