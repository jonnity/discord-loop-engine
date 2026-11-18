import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCodexCommand } from "../src/harness-guard-codex.ts";

const bypass = "--dangerously-bypass-approvals-and-sandbox";

test("P1: Codex の実行位置、オプション、値を区別する", () => {
	const cases = [
		["codex exec", "direct-exec"],
		[`"/opt/plugin path/codex" 'ex'ec`, "direct-exec"],
		['MODE=test 2>error </dev/null codex -C "$WT" -c model_reasoning_effort=high exec', "direct-exec"],
		['codex --cd="$WT" exec "固定のプロンプト $TEXT"', "direct-exec"],
		["MO\\\nDE=test codex exec", "direct-exec"],
		["codex --cd=exec -m exec --search exec --output-schema=schema -o out", "direct-exec"],
		["codex exec -- --help", "direct-exec"],
		[`codex '${bypass}'`, "bypass"],
		[`codex exec prompt ${bypass}`, "bypass"],
		[`codex exec ${bypass} --unknown`, "unknown"],
		["codex exec --image a.png b.png prompt", "unknown"],
		["codex -C exec login status", "pass"],
		["codex -- exec", "pass"],
		["codex --help", "pass"],
		["codex e", "pass"],
		["codex -C /tmp exec --help", "pass"],
		["codex exec --color --help", "unknown"],
		[`codex exec ${bypass} -h`, "pass"],
		["command codex exec; env MODE=test codex exec; exec codex exec", "pass"],
		[`codex -c ${bypass} login status`, "unknown"],
		[`codex --config=${bypass} login status`, "pass"],
		[`codex -- ${bypass}`, "pass"],
		[`codex ${bypass}=true`, "unknown"],
		[`printf '%s\\n' ${bypass}; my-codex exec; codex/ exec`, "pass"],
		[`codex --unknown exec; codex ${bypass}`, "bypass"],
		[`codex exec; codex ${bypass}`, "direct-exec"],
	] as const;
	for (const [command, expected] of cases) assert.equal(classifyCodexCommand(command), expected, command);
});

test("P1: tmux のオプション、複数 argv、シェルに渡す一語を区別する", () => {
	const cases = [
		[
			"tmux -L socket -u neww -ad -c '/tmp/my work' -e A=B -F '#{pane_id}' -n work -t session -- /opt/bin/codex exec",
			"tmux-codex",
		],
		["tmux -Lsocket new-window -adnwork codex", "tmux-codex"],
		["tmux new-window -n work 'printf ok; codex exec'", "tmux-codex"],
		["tmux new-window -n work ': | codex exec'", "tmux-codex"],
		["tmux new-window -n codex -t codex -F 'codex exec'", "pass"],
		["tmux new-window -n codex bash", "pass"],
		["tmux new-window \"echo 'codex exec'\"", "pass"],
		["tmux new-window printf '%s\\n' 'codex exec'", "pass"],
		["tmux new-window 'codex exec --help'", "pass"],
		["tmux new-window codex e", "pass"],
		["tmux new-window 'command codex exec'", "pass"],
		["tmux new-window codex ';' list-windows", "unknown"],
		["tmux new-window -Z codex", "unknown"],
		['tmux new-window "$SHELL_COMMAND"', "unknown"],
		["tmux -L codex capture-pane -t 'codex exec'", "pass"],
	] as const;
	for (const [command, expected] of cases) assert.equal(classifyCodexCommand(command), expected, command);
});

test("P2: コマンド境界と引用、リダイレクト、heredoc の本文を区別する", () => {
	const cases = [
		[":; codex exec", "direct-exec"],
		[": && # 継続\n\n codex exec", "direct-exec"],
		[": |\\\n| codex exec", "direct-exec"],
		[":\nco\\\ndex exec", "direct-exec"],
		[": \\; codex exec", "pass"],
		["printf '%s\\n' '# test\ncodex exec; | &&' \"codex exec\"", "pass"],
		["printf a#b codex exec # codex exec\n:", "pass"],
		[": <<< 'codex exec' 3<&0 4>&1 >|out &>>err", "pass"],
		[`cat 3<<-'END' <<"E"OF\n\tcodex exec\n\tEND\n${bypass}\nEOF`, "pass"],
		["cat <<EOF |\ntmux new-window codex\nEOF\ncodex exec", "direct-exec"],
		["cat <<EOF; codex exec\ncodex exec\nEOF", "direct-exec"],
		["cat <<EOF\nEO\\\nF\ncodex exec", "direct-exec"],
		["cat <<'EOF'\nEO\\\nF\ncodex exec\nEOF", "pass"],
		["cat <<EOF\nEOF \ncodex exec\nEOF", "pass"],
		["cat <<EOF\n\\\\\nEOF\ncodex exec", "direct-exec"],
		["cat <<'EOF'\n$(codex exec)\nEOF\n", "pass"],
		["cat <<''\ncodex exec\n\n:", "pass"],
		["cat <<$END\ncodex exec\n$END\n:", "pass"],
	] as const;
	for (const [command, expected] of cases) assert.equal(classifyCodexCommand(command), expected, command);
});

test("P3: 構文の境界が不明なら前半の候補も通過させる", () => {
	for (const command of [
		"codex exec; printf '%s",
		"codex exec; cat <<EOF\n未終端",
		"codex exec; if true; then :; fi",
		"codex exec; work() { :; }",
		"codex exec; (echo hello)",
		"codex exec; echo $(printf hello)",
		'codex exec; echo "`printf hello`"',
		"codex exec; cat <(echo hello)",
		`codex exec; printf \${var:-'a;b'}`,
		"codex exec |& cat",
		"codex exec; sleep 1 &",
		"codex exec &&",
		"codex exec; echo >",
		"codex exec; ; echo",
		"codex exec; \\",
		'"$TOOL" codex exec',
		"$TOOL codex exec",
		'codex -C "$@" exec',
		"codex exec $\\\nHELP",
		"codex -C path* exec",
		"codex -C {x,y} exec",
		"codex exec\0",
	])
		assert.equal(classifyCodexCommand(command), "unknown", command);
	assert.equal(classifyCodexCommand(`$TOOL exec; codex -C "\${WT}" exec`), "direct-exec");
});

const commandLimit = 256 * 1024;
const jsonLimit = 1024 * 1024;
const helper = fileURLToPath(new URL("../src/harness-guard-codex.ts", import.meta.url));
const hookJson = (command: string) => JSON.stringify({ tool_input: { command } });

function assertCli(input: string, output: string) {
	const result = spawnSync(process.execPath, [helper], { input, encoding: "utf8", timeout: 5000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout, `${output}\n`);
}

test("P3: CLI は hook JSON だけを読み、末尾改行と UTF-8 のバイト上限を保つ", () => {
	for (const input of ["", "{", "null", "[]", "{}", '{"tool_input":{"command":12}}', hookJson(""), hookJson("\0")]) {
		assertCli(input, "unknown");
	}
	assertCli(hookJson("cat <<''\ncodex exec\n\n"), "pass");
	assertCli(hookJson("cat <<''\ncodex exec\n"), "unknown");
	const suffix = "\ncodex exec\n";
	const prefix = `#${"あ".repeat(Math.floor((commandLimit - Buffer.byteLength(suffix) - 1) / 3))}`;
	const atLimit = prefix + "x".repeat(commandLimit - Buffer.byteLength(prefix + suffix)) + suffix;
	assertCli(hookJson(atLimit.slice(0, -1)), "direct-exec");
	assertCli(hookJson(atLimit), "direct-exec");
	assertCli(hookJson(`${atLimit}x`), "unknown");
	const smallJson = hookJson("codex exec");
	const nearLimit = " ".repeat(jsonLimit - Buffer.byteLength(smallJson) - 1) + smallJson;
	assertCli(nearLimit, "direct-exec");
	assertCli(`${nearLimit} `, "direct-exec");
	assertCli(`${nearLimit}  `, "unknown");
});
