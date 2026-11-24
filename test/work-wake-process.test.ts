import "./isolate.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const cli = path.resolve(import.meta.dirname, "../bin/dle");
const fakeDiscord = `
globalThis.fetch = async (url) => {
	if (!/^https:\\/\\/discord\\.com\\/api\\/v10\\//.test(String(url))) throw Error("fixture: external request");
	return Response.json({ id: "fixture" });
};
globalThis.WebSocket = class {
	addEventListener(type, fn) {
		if (type === "message") queueMicrotask(() => {
			fn({data: JSON.stringify({op:10,d:{heartbeat_interval:60000}})});
			fn({data: JSON.stringify({op:0,t:"READY",d:{user:{id:"fixture"},session_id:"fixture",resume_gateway_url:"wss://gateway.discord.gg"}})});
		});
	}
	send() {}
	close() {}
};
`;
const fakeGh = `
import { writeFileSync } from "node:fs";
const dir = process.env.WAKE_TEST_DIR;
const repo = { nameWithOwner: "example/repo" };
const connection = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
if (!process.argv.includes("graphql")) {
	console.log("{}");
} else if (process.argv.some((arg) => arg.includes("issues("))) {
	process.on("SIGTERM", () => {});
	writeFileSync(dir + "/started.json", JSON.stringify({pid: process.pid}));
	setInterval(() => {}, 1000);
} else {
	console.log(JSON.stringify([{ data: { viewer: { login: "fixture" }, repository: { ...repo, pullRequests: connection } } }]));
}
`;

function stat(pid: number) {
	try {
		const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ") ?? [];
		if (fields[0] !== "Z" && fields[0] !== "X") return { group: Number(fields[2]) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH")
			throw error;
	}
}

function groupMembers(group: number) {
	return readdirSync("/proc")
		.filter((entry) => /^\d+$/.test(entry))
		.map(Number)
		.filter((pid) => stat(pid)?.group === group);
}

async function until<T>(fn: () => T | undefined | false, timeout: number): Promise<T> {
	const end = performance.now() + timeout;
	while (performance.now() < end) {
		const result = fn();
		if (result !== undefined && result !== false) return result;
		await delay(25);
	}
	throw new Error(`fixture の待機期限 ${timeout}ms`);
}

type Ending =
	| "SIGHUP"
	| "SIGTERM"
	| "SIGINT"
	| "group"
	| "wrapper-parent"
	| "pipe-reader"
	| "engine-sigkill"
	| "timeout";

async function trial(ending: Ending, runner: "direct" | "bash" | "pnpm") {
	const dir = mkdtempSync("/tmp/dle-96.");
	const bin = path.join(dir, "bin");
	const repo = path.join(dir, "repo");
	const socket = path.join(dir, "engine.sock");
	const log = path.join(dir, "engine.log");
	const recorded = path.join(dir, "started.json");
	const pidFile = path.join(dir, "engine.pid");
	assert.deepEqual(readdirSync(dir), []);
	mkdirSync(bin);
	mkdirSync(path.join(repo, ".claude"), { recursive: true });
	writeFileSync(path.join(repo, ".claude", "harness.json"), "{}");
	writeFileSync(
		path.join(dir, "config.json"),
		JSON.stringify({
			channelIds: ["1"],
			allowedUserIds: ["2"],
			tmuxSession: "fixture-96",
			claudeBin: "claude",
			worker: { refresh: { enabled: false } },
		}),
	);
	writeFileSync(
		path.join(dir, "projects.json"),
		JSON.stringify([{ name: "fixture", repo: "example/repo", path: repo, mode: "harness", active: true }]),
	);
	writeFileSync(path.join(dir, "discord.mjs"), fakeDiscord);
	writeFileSync(path.join(dir, "gh.mjs"), fakeGh);
	writeFileSync(path.join(bin, "gh"), '#!/bin/bash\nexec node "$WAKE_TEST_DIR/gh.mjs" "$@"\n', { mode: 0o700 });
	writeFileSync(path.join(bin, "claude"), '#!/bin/bash\necho "claude" >> "$WAKE_TEST_DIR/starts"\nexit 1\n', {
		mode: 0o700,
	});
	writeFileSync(
		path.join(bin, "tmux"),
		'#!/bin/bash\n[[ "$1" == send-keys ]] && printf "%s\\n" "$*" >> "$WAKE_TEST_DIR/sends"\nexit 1\n',
		{ mode: 0o700 },
	);

	const env = {
		...process.env,
		WAKE_TEST_DIR: dir,
		DLE_HOME: dir,
		DLE_SOCKET: socket,
		DISCORD_BOT_TOKEN: "fixture",
		PATH: `${bin}:${process.env.PATH}`,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(dir, "discord.mjs"))}`,
	};
	const fd = openSync(log, "w", 0o600);
	const pipe =
		runner === "pnpm"
			? 'pnpm exec ./bin/dle start 2>&1 | tee "$WAKE_TEST_DIR/engine.log"'
			: '"$1" start 2>&1 | tee "$WAKE_TEST_DIR/engine.log"';
	const child =
		runner === "direct"
			? spawn(cli, ["start"], { env, detached: true, stdio: ["ignore", fd, fd] })
			: spawn("bash", ["-o", "pipefail", "-c", pipe, "fixture", cli], {
					cwd: path.dirname(path.dirname(cli)),
					env,
					detached: true,
					stdio: "ignore",
				});
	closeSync(fd);
	const group = child.pid;
	const closed = once(child, "exit");
	assert.ok(group);
	try {
		const started = await until(() => {
			if (existsSync(recorded)) {
				const raw = readFileSync(recorded, "utf8");
				if (raw.endsWith("}")) return JSON.parse(raw) as { pid: number };
			}
			if (child.exitCode !== null) throw Error(readFileSync(log, "utf8"));
		}, 45_000);
		const engine = Number(readFileSync(pidFile, "utf8"));
		assert.ok(existsSync(socket));
		assert.equal(stat(engine)?.group, group);
		assert.equal(stat(started.pid)?.group, group);
		if (ending === "timeout") {
			await until(() => !stat(started.pid), 12_000);
			await until(() => readFileSync(log, "utf8").includes('"code":"timeout"'), 5_000);
			process.kill(engine, "SIGTERM");
		} else if (ending === "group") {
			process.kill(-group, "SIGINT");
		} else if (ending === "wrapper-parent") {
			assert.notEqual(group, engine);
			process.kill(group, "SIGKILL");
			assert.deepEqual(await closed, [null, "SIGKILL"]);
			assert.equal(stat(engine)?.group, group);
			process.kill(engine, "SIGTERM");
		} else if (ending === "engine-sigkill") {
			process.kill(engine, "SIGKILL");
			await until(() => !stat(engine), 5_000);
			assert.equal(stat(started.pid)?.group, group);
			assert.ok(existsSync(socket));
			process.kill(-group, "SIGKILL");
			await until(() => !groupMembers(group).length, 5_000);
			rmSync(socket);
			rmSync(pidFile);
		} else if (ending === "pipe-reader") {
			const reader = await until(
				() =>
					groupMembers(group).find((pid) => {
						try {
							return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "tee";
						} catch {
							return false;
						}
					}),
				5_000,
			);
			process.kill(reader, "SIGKILL");
			assert.equal(stat(engine)?.group, group);
			await until(() => !stat(started.pid), 12_000);
		} else {
			process.kill(engine, ending);
		}
		await until(() => !groupMembers(group).length && !existsSync(socket), 5_000);
		assert.equal(stat(started.pid), undefined);
		assert.ok(!existsSync(pidFile));
		assert.ok(!existsSync(path.join(dir, "sends")));
		assert.ok(!existsSync(path.join(dir, "starts")));
		if (ending !== "pipe-reader" && ending !== "engine-sigkill") {
			const output = readFileSync(log, "utf8");
			assert.ok(output.endsWith("\n"));
			const match = [...output.matchAll(/engine: work-wake (\{[^\n]+\})/g)];
			assert.equal(match.length, 1, output);
			const decision = JSON.parse(match[0]?.[1] ?? "{}");
			assert.equal(decision.project, "fixture");
			assert.equal(decision.result, ending === "timeout" ? "deferred" : "stopped");
			assert.equal(decision.fetchFailed, true);
		}
		if (runner === "direct")
			assert.deepEqual(await closed, ending === "engine-sigkill" ? [null, "SIGKILL"] : [0, null]);
	} finally {
		if (groupMembers(group).length) process.kill(-group, "SIGKILL");
		await until(() => !groupMembers(group).length, 5_000);
		rmSync(dir, { recursive: true, force: true });
		assert.ok(!existsSync(dir));
	}
}

test(
	"T5 実 CLI の読み取り子を独立環境で回収する",
	{ concurrency: 8, skip: process.platform !== "linux" },
	async (t) => {
		await Promise.all(
			(
				["SIGHUP", "SIGTERM", "SIGINT", "group", "wrapper-parent", "pipe-reader", "engine-sigkill", "timeout"] as const
			).map((ending) =>
				t.test(`T5 実 CLI の子回収 ${ending} を独立環境で3回`, async () => {
					let runner: "direct" | "bash" | "pnpm" =
						ending === "wrapper-parent" || ending === "pipe-reader" ? "bash" : "direct";
					if (process.env.WAKE_TEST_PNPM === "1") runner = "pnpm";
					for (let i = 0; i < 3; i++) await trial(ending, runner);
				}),
			),
		);
	},
);
