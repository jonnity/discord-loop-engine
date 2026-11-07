// Rust の実体は導入せず、製品 wrapper の exec 先と掃除フックを一時領域で確かめる。
import "./isolate.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const START = path.join(ROOT, "templates/runner/runner-start.sh");
const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";
type RustProbe = { home: string; cargoHome: string | null; rustupHome: string | null; path: string };

function fixture(rootName = "actions-runners") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-rust-"));
	const runners = path.join(dir, rootName);
	const curl = path.join(dir, "curl");
	const curlPath = path.join(dir, "curl-path");
	const interop = path.join(dir, "interop");
	fs.writeFileSync(
		curl,
		`#!/bin/sh\nprintf %s "$PATH" > "$CURL_PATH_FILE"\nprintf %s "\${HTTP_CODE:-404}"\nexit "\${HTTP_RC:-0}"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(interop, "disabled\n");
	for (const name of ["runner-a", "runner-b"]) {
		const d = path.join(runners, name);
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, ".runner"), '{"gitHubUrl":"https://github.com/example/private"}');
		const script = `const e = process.env; require("node:fs").writeFileSync("probe.json", JSON.stringify({home:e.HOME, cargoHome:e.CARGO_HOME ?? null, rustupHome:e.RUSTUP_HOME ?? null, path:e.PATH}));`;
		fs.writeFileSync(path.join(d, "run.sh"), `#!/bin/sh\nexec '${process.execPath}' -e '${script}'\n`, {
			mode: 0o755,
		});
	}
	const env: NodeJS.ProcessEnv = {
		PATH: "/untrusted/path",
		HOME: path.join(dir, "shared-home"),
		CARGO_HOME: "/untrusted/cargo",
		RUSTUP_HOME: "/untrusted/rustup",
		DLE_CURL: curl,
		DLE_RUNNERS_ROOT: runners,
		DLE_INTEROP_FILE: interop,
		CURL_PATH_FILE: curlPath,
	};
	return {
		dir,
		runners,
		env,
		curlPath,
		interop,
		run(name: string, extra: NodeJS.ProcessEnv = {}, script = START) {
			const probe = path.join(runners, name, "probe.json");
			fs.rmSync(probe, { force: true });
			fs.rmSync(curlPath, { force: true });
			const r = spawnSync("/bin/bash", [script, name], { env: { ...env, ...extra }, encoding: "utf8" });
			return { ...r, probe: fs.existsSync(probe) ? (JSON.parse(fs.readFileSync(probe, "utf8")) as RustProbe) : null };
		},
		close: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

test("Rust 環境: 同じ HOME の2 runnerへ固有の絶対2 homeとbinを渡し、呼出元の値を置き換える", () => {
	const fx = fixture();
	try {
		for (const name of ["runner-a", "runner-b"]) {
			const d = path.join(fx.runners, name);
			const r = fx.run(name);
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(r.probe, {
				home: fx.env.HOME,
				cargoHome: `${d}/.cargo`,
				rustupHome: `${d}/.rustup`,
				path: `${BASE_PATH}:${d}/.cargo/bin`,
			});
			assert.equal(fs.readFileSync(fx.curlPath, "utf8"), "/usr/bin:/bin");
		}
		const r = fx.run("runner-a", { HOME: "/different/ambient-home" });
		assert.equal(r.probe?.home, "/different/ambient-home");
		assert.equal(r.probe?.cargoHome, `${fx.runners}/runner-a/.cargo`);
		const script = path.join(fx.dir, "default-root.sh");
		fs.writeFileSync(script, fs.readFileSync(START, "utf8").replace(/^HOME_DIR=.*$/m, `HOME_DIR='${fx.dir}'`));
		const fromHome = fx.run("runner-a", { DLE_RUNNERS_ROOT: undefined }, script);
		assert.equal(fromHome.status, 0, fromHome.stderr);
		assert.equal(fromHome.probe?.cargoHome, `${fx.dir}/actions-runners/runner-a/.cargo`);
		assert.equal(fromHome.probe?.rustupHome, `${fx.dir}/actions-runners/runner-a/.rustup`);
		assert.equal(fromHome.probe?.home, fx.env.HOME);
		assert.equal(fx.run("runner-a", { DLE_RUNNERS_ROOT: "relative/not-present" }).status, 71);
	} finally {
		fx.close();
	}
});

test("Rust 環境: HOME_DIR が不正でも差し替え ROOT が有効なら、その場所の2 homeを渡す", () => {
	const fx = fixture();
	try {
		for (const home of ["relative/home", "/home/a:b"]) {
			const script = path.join(fx.dir, "start-home.sh");
			fs.writeFileSync(script, fs.readFileSync(START, "utf8").replace(/^HOME_DIR=.*$/m, `HOME_DIR='${home}'`));
			for (const ambient of [true, false]) {
				const r = fx.run("runner-a", ambient ? {} : { CARGO_HOME: undefined, RUSTUP_HOME: undefined }, script);
				assert.equal(r.status, 0, r.stderr);
				assert.deepEqual(r.probe, {
					home: fx.env.HOME,
					cargoHome: `${fx.runners}/runner-a/.cargo`,
					rustupHome: `${fx.runners}/runner-a/.rustup`,
					path: `${BASE_PATH}:${fx.runners}/runner-a/.cargo/bin`,
				});
			}
		}
	} finally {
		fx.close();
	}
});

test("Rust 環境: ROOT にコロンがある場合は2 homeを注入せず、PATHを分割させない", () => {
	const fx = fixture("a:b");
	try {
		for (const ambient of [true, false]) {
			const r = fx.run("runner-a", ambient ? {} : { CARGO_HOME: undefined, RUSTUP_HOME: undefined });
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(r.probe, {
				home: fx.env.HOME,
				cargoHome: ambient ? "/untrusted/cargo" : null,
				rustupHome: ambient ? "/untrusted/rustup" : null,
				path: BASE_PATH,
			});
		}
	} finally {
		fx.close();
	}
});

test("Rust 環境: 起動禁止・判定失敗ではexecせず、既存の終了コードを保つ", () => {
	const fx = fixture();
	try {
		assert.equal(fx.run("runner-a").status, 0);
		for (const [extra, expected] of [
			[{ HTTP_CODE: "200" }, 71],
			[{ HTTP_CODE: "403" }, 75],
			[{ HTTP_CODE: "429" }, 75],
			[{ HTTP_CODE: "500" }, 75],
			[{ HTTP_RC: "28" }, 75],
		] as const) {
			const r = fx.run("runner-a", extra);
			assert.equal(r.status, expected, r.stderr);
			assert.equal(r.probe, null);
		}
		fs.writeFileSync(fx.interop, "enabled\n");
		assert.equal(fx.run("runner-a").status, 72);
		assert.equal(fs.existsSync(fx.curlPath), false);
		assert.equal(fx.run("A").status, 71);
		const script = path.join(fx.dir, "empty-home.sh");
		fs.writeFileSync(script, fs.readFileSync(START, "utf8").replace(/^HOME_DIR=.*$/m, "HOME_DIR=''"));
		assert.equal(fx.run("runner-a", {}, script).status, 74);
	} finally {
		fx.close();
	}
});

test("Rust 保持: job 終了でworkspace/tempだけを消し、両 runner の2 homeを保持する", () => {
	const fx = fixture();
	try {
		for (const n of ["runner-a", "runner-b"]) {
			for (const home of [".cargo", ".rustup"]) {
				fs.mkdirSync(path.join(fx.runners, n, home));
				fs.writeFileSync(path.join(fx.runners, n, home, "keep"), `${n}/${home}`);
			}
		}
		const workspace = path.join(fx.runners, "runner-a/_work/repo/repo");
		const temp = path.join(fx.runners, "runner-a/_work/_temp");
		for (const p of [workspace, temp]) {
			fs.mkdirSync(p, { recursive: true });
			fs.writeFileSync(path.join(p, "remove"), "job");
		}
		const r = spawnSync("/bin/bash", ["-e", path.join(ROOT, "templates/runner/job-completed.sh"), fx.runners], {
			env: { PATH: "/usr/bin:/bin", GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp },
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(fs.readdirSync(workspace), []);
		assert.deepEqual(fs.readdirSync(temp), []);
		for (const n of ["runner-a", "runner-b"]) {
			for (const home of [".cargo", ".rustup"])
				assert.equal(fs.readFileSync(path.join(fx.runners, n, home, "keep"), "utf8"), `${n}/${home}`);
		}
	} finally {
		fx.close();
	}
});
