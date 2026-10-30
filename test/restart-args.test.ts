// dle restart の引数は、名前 / --limited / --all のどれか1つ。--except は --limited / --all のときだけ（複数可）。
import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRestartArgs } from "../src/restart-args.ts";

test("名前・--limited・--all をそれぞれ解釈する", () => {
	assert.deepEqual(parseRestartArgs(["concierge"]), { name: "concierge" });
	assert.deepEqual(parseRestartArgs(["--limited"]), { mode: "limited", except: [] });
	assert.deepEqual(parseRestartArgs(["--all"]), { mode: "all", except: [] });
});

test("--except は複数指定できる", () => {
	assert.deepEqual(parseRestartArgs(["--all", "--except", "a", "--except", "b"]), { mode: "all", except: ["a", "b"] });
	assert.deepEqual(parseRestartArgs(["--except", "a", "--limited"]), { mode: "limited", except: ["a"] });
});

test("併用・欠落・--except 単独や名前との併用は誤り", () => {
	for (const args of [
		[],
		["a", "--limited"],
		["--limited", "--all"],
		["a", "b"],
		["--except", "a"],
		["a", "--except", "b"],
		["--all", "--except"],
		["--all", "--except", "--limited"],
		["--bogus"],
	])
		assert.throws(() => parseRestartArgs(args), /dle restart|--except|名前/, JSON.stringify(args));
});
