#!/usr/bin/env bash
# #48: runner 用のスクリプト（runner-start.sh・job-completed.sh）。
# 偽の curl は PATH でなく DLE_CURL で差し替える（スクリプトは PATH を固定するため）。実ネットワークには出ない。
R="$TMP/runner-scripts"
mkdir -p "$R/fake"
START="$ROOT/templates/runner/runner-start.sh"
DONE="$ROOT/templates/runner/job-completed.sh"

# 偽の curl: 引数を記録し、FAKE_CODE（HTTP ステータス）を出して FAKE_RC で終わる
cat >"$R/fake/curl" <<'SH'
#!/bin/sh
echo "$@" >> "${FAKE_LOG:-/dev/null}"
[ -n "${FAKE_EMPTY:-}" ] && exit 0
printf '%s' "${FAKE_CODE:-404}"
exit "${FAKE_RC:-0}"
SH
chmod +x "$R/fake/curl"
echo "disabled" >"$R/interop-off"
echo "enabled" >"$R/interop-on"

# runner のディレクトリ（偽の run.sh は目印を作るだけ）
mkrunner() { # $1=名前 $2=.runner の内容
	mkdir -p "$R/root/$1"
	printf '#!/bin/sh\necho started > "$(dirname "$0")/started"\n' >"$R/root/$1/run.sh"
	chmod +x "$R/root/$1/run.sh"
	rm -f "$R/root/$1/started"
	printf '%s' "$2" >"$R/root/$1/.runner"
}
GOOD='{"gitHubUrl":"https://github.com/jonnity/oogiri-doc"}'
# 終了コードを返す（FAKE_* は環境変数で渡す）
start() { DLE_CURL="${CURLBIN:-$R/fake/curl}" DLE_RUNNERS_ROOT="$R/root" DLE_INTEROP_FILE="${INTEROP:-$R/interop-off}" bash "$START" "$@" >/dev/null 2>&1; echo $?; }
not_retry_stop() { [ "$1" != 71 ] && [ "$1" != 0 ]; } # 71（再試行しない）でも 0 でもない = 再試行される失敗

mkrunner oogiri-doc-1 "$GOOD"
: >"$R/curl.log"
code="$(FAKE_CODE=404 FAKE_LOG="$R/curl.log" start oogiri-doc-1)"
check "runner-start: private（404）なら run.sh に exec する" '[ "$code" = 0 ] && [ -f "$R/root/oogiri-doc-1/started" ]'
check "runner-start: 問い合わせ先は Web ページ（API ではない）" 'grep -q "https://github.com/jonnity/oogiri-doc" "$R/curl.log" && ! grep -q "api.github.com" "$R/curl.log"'
check "runner-start: curl にタイムアウトを付ける" 'grep -q -- "--max-time 10" "$R/curl.log" && grep -q -- "--connect-timeout 5" "$R/curl.log"'
mkrunner oogiri-doc-1 "$GOOD"
check "runner-start: public（200）は 71（起動しない・再試行しない）" '[ "$(FAKE_CODE=200 start oogiri-doc-1)" = 71 ] && [ ! -f "$R/root/oogiri-doc-1/started" ]'
for c in 429 403 301 500 000; do
	check "runner-start: HTTP '$c' は判定できない（71 以外。再試行される）" 'rc="$(FAKE_CODE="$c" start oogiri-doc-1)"; not_retry_stop "$rc"'
done
check "runner-start: 応答が空（HTTP ステータスが無い）なら 71 以外" 'x="$(FAKE_EMPTY=1 start oogiri-doc-1)"; not_retry_stop "$x"'
for rc in 6 7 28 127; do
	check "runner-start: curl が終了コード $rc なら 71 以外（再試行される）" 'x="$(FAKE_RC="$rc" start oogiri-doc-1)"; not_retry_stop "$x"'
done
check "runner-start: curl が存在しない（127）なら 71 以外" 'x="$(CURLBIN="$R/fake/nothing" start oogiri-doc-1)"; not_retry_stop "$x"'
mkrunner oogiri-doc-1 "$GOOD"; rm -f "$R/root/oogiri-doc-1/run.sh"
check "runner-start: run.sh が無い（exec の失敗）なら 71 以外" 'x="$(FAKE_CODE=404 start oogiri-doc-1)"; not_retry_stop "$x"'
mkdir -p "$R/root/no-runner"
check "runner-start: .runner が無ければ 71" '[ "$(start no-runner)" = 71 ]'
mkrunner bad-url '{"gitHubUrl":"https://github.com/../.."}'
check "runner-start: gitHubUrl が書式違反（..）なら 71" '[ "$(start bad-url)" = 71 ]'
mkrunner bad-url2 '{"gitHubUrl":"https://evil.example/a/b"}'
check "runner-start: 他のホストの gitHubUrl は 71" '[ "$(start bad-url2)" = 71 ]'
mkrunner oogiri-doc-1 "$GOOD"
check "runner-start: WSL interop が有効なら起動せず 72（71 でも 0 でもない。再試行される）" '[ "$(INTEROP="$R/interop-on" FAKE_CODE=404 start oogiri-doc-1)" = 72 ] && [ ! -f "$R/root/oogiri-doc-1/started" ]'
check "runner-start: interop の無効化後は起動する" '[ "$(INTEROP="$R/interop-off" FAKE_CODE=404 start oogiri-doc-1)" = 0 ]'

# 引数の書式検証: 他のディレクトリの .runner を読まずに 71（読もうとしたことを、偽の curl の記録で確かめる）
mkdir -p "$R/other"; printf '%s' "$GOOD" >"$R/other/.runner"
: >"$R/curl.log"
for arg in "../other" "a b" "a;b" "" "A"; do
	check "runner-start: 名前 '$arg' は書式違反で 71（curl も呼ばない）" '[ "$(FAKE_LOG="$R/curl.log" start "$arg")" = 71 ] && [ ! -s "$R/curl.log" ]'
done
check "runner-start: 引数が 0 個・2 個以上なら 71" '[ "$(start)" = 71 ] && [ "$(start oogiri-doc-1 oogiri-doc-2)" = 71 ]'

# PATH の固定: PATH の先頭の偽の curl は使われず、DLE_CURL の明示だけが効く
mkdir -p "$R/pathfake"
printf '#!/bin/sh\necho path_curl >> "%s"\nprintf 404\n' "$R/path.log" >"$R/pathfake/curl"; chmod +x "$R/pathfake/curl"
printf '#!/bin/sh\necho dle_curl >> "%s"\nprintf 404\n' "$R/path.log" >"$R/fake/curl2"; chmod +x "$R/fake/curl2"
mkrunner oogiri-doc-1 "$GOOD"; : >"$R/path.log"
(PATH="$R/pathfake:$PATH" CURLBIN="$R/fake/curl2" start oogiri-doc-1 >/dev/null)
check "runner-start: PATH の先頭の偽の curl は使われず、DLE_CURL だけが効く" 'grep -q dle_curl "$R/path.log" && ! grep -q path_curl "$R/path.log"'

# run.sh に渡る PATH: 固定のリテラル + getent の HOME_DIR を基にした runner の場所（呼び出し元の PATH・HOME は影響しない）
mkprobe() { # PATH を記録する偽の run.sh を持つ runner
	rm -f "$R/root/path-probe/path" # 前回の値で通る偽陽性を防ぐ
	mkrunner path-probe "$GOOD"
	printf '#!/bin/sh\nprintf %%s "$PATH" > "$(dirname "$0")/path"\n' >"$R/root/path-probe/run.sh"
}
EXP="/usr/local/bin:/usr/bin:/bin:$R/root/path-probe/.cargo/bin"
mkprobe
check "runner-start: run.sh の PATH は /usr/local/bin:/usr/bin:/bin:<runner>/.cargo/bin" '[ "$(FAKE_CODE=404 start path-probe)" = 0 ] && [ "$(cat "$R/root/path-probe/path")" = "$EXP" ]'
mkprobe
check "runner-start: 環境変数 HOME を変えても run.sh の PATH は同じ" '[ "$(HOME=/nonexistent/fake FAKE_CODE=404 start path-probe)" = 0 ] && [ "$(cat "$R/root/path-probe/path")" = "$EXP" ]'
mkprobe
check "runner-start: 呼び出し側の PATH を差し替えても run.sh の PATH は固定で、.cargo/bin が最後" \
	'(PATH="$R/pathfake:/tmp/evil:$PATH" FAKE_CODE=404 start path-probe >/dev/null); p=$(cat "$R/root/path-probe/path"); [ "$p" = "$EXP" ] && case $p in */.cargo/bin) true ;; *) false ;; esac'
check "runner-start: 確認処理の PATH は /usr/bin:/bin のまま（広げるのは exec の直前の 1 か所だけ）" \
	'grep -q "^export PATH=/usr/bin:/bin$" "$START" && [ "$(grep -v "^[[:space:]]*#" "$START" | grep -c "\bPATH=")" = 2 ]'
# HOME_DIR と ROOT の検査: getent の行だけ差し替えても、実際に値を組む ROOT が優先される
path_with_home() { # $1=HOME_DIR の値
	sed "s|^HOME_DIR=.*|HOME_DIR='$1'|" "$START" >"$R/start-home.sh"
	mkprobe
	DLE_CURL="$R/fake/curl" DLE_RUNNERS_ROOT="$R/root" DLE_INTEROP_FILE="$R/interop-off" FAKE_CODE=404 bash "$R/start-home.sh" path-probe >/dev/null 2>&1
	cat "$R/root/path-probe/path"
}
check "runner-start: HOME_DIR が絶対パスなら末尾に <runner>/.cargo/bin" '[ "$(path_with_home /home/dle-runner)" = "$EXP" ]'
check "runner-start: HOME_DIR が相対パスでも絶対 ROOT の .cargo/bin を使う" '[ "$(path_with_home relative/home)" = "$EXP" ]'
check "runner-start: HOME_DIR に : があっても絶対 ROOT の .cargo/bin を使う" '[ "$(path_with_home /home/a:b)" = "$EXP" ]'

# ROOT に : がある場合は、HOME_DIR が正常でも PATH を分割せず Rust の環境変数も注入しない。
mkdir -p "$R/a:b/path-probe"
printf '%s' "$GOOD" >"$R/a:b/path-probe/.runner"
cat >"$R/a:b/path-probe/run.sh" <<'SH'
#!/bin/sh
printf '%s|%s|%s' "$PATH" "${CARGO_HOME-unset}" "${RUSTUP_HOME-unset}" > "$(dirname "$0")/env"
SH
chmod +x "$R/a:b/path-probe/run.sh"
root_with_colon() {
	rm -f "$R/a:b/path-probe/env"
	env -u CARGO_HOME -u RUSTUP_HOME DLE_CURL="$R/fake/curl" DLE_RUNNERS_ROOT="$R/a:b" \
		DLE_INTEROP_FILE="$R/interop-off" FAKE_CODE=404 bash "$START" path-probe >/dev/null 2>&1 &&
		cat "$R/a:b/path-probe/env"
}
check "runner-start: ROOT に : があると PATH は固定3要素、Rust の環境変数は未設定のまま" \
	'[ "$(root_with_colon)" = "/usr/local/bin:/usr/bin:/bin|unset|unset" ]'

# --- job-completed.sh ----------------------------------------------------------------------------
AR="$R/ar"
mkws() { # 作業ディレクトリと _temp に、消えるはずのファイルを作る
	rm -rf "$AR"; mkdir -p "$AR/oogiri-doc-1/_work/oogiri-doc/oogiri-doc/sub" "$AR/oogiri-doc-1/_work/_temp" "$AR/oogiri-doc-1/_work/_tool"
	echo x >"$AR/oogiri-doc-1/_work/oogiri-doc/oogiri-doc/file"; echo x >"$AR/oogiri-doc-1/_work/oogiri-doc/oogiri-doc/sub/deep"
	echo x >"$AR/oogiri-doc-1/_work/_temp/t"; echo keep >"$AR/oogiri-doc-1/_work/_tool/keep"
}
done_hook() { # $1=GITHUB_WORKSPACE $2=RUNNER_TEMP（引数の root は $AR）
	GITHUB_WORKSPACE="$1" RUNNER_TEMP="$2" bash "$DONE" "$AR" >/dev/null 2>&1; echo $?
}
mkws
WS="$AR/oogiri-doc-1/_work/oogiri-doc/oogiri-doc"
check "job-completed: 作業ディレクトリと _temp の中身だけ消し、_tool と作業ディレクトリ自体は残す（終了コード 0）" \
	'[ "$(done_hook "$WS" "$AR/oogiri-doc-1/_work/_temp")" = 0 ] && [ -d "$WS" ] && [ -z "$(ls -A "$WS")" ] && [ -z "$(ls -A "$AR/oogiri-doc-1/_work/_temp")" ] && [ -f "$AR/oogiri-doc-1/_work/_tool/keep" ]'
mkws; mkdir -p "$R/outside"; echo precious >"$R/outside/f"
check "job-completed: .. を含むパスでは何も消さず 0" '[ "$(done_hook "$WS/../../oogiri-doc/oogiri-doc" "")" = 0 ] && [ -f "$WS/file" ]'
ln -s "$R/outside" "$AR/oogiri-doc-1/_work/oogiri-doc/link"
check "job-completed: _work の外を指すシンボリックリンクでは何も消さず 0" '[ "$(done_hook "$AR/oogiri-doc-1/_work/oogiri-doc/link" "")" = 0 ] && [ -f "$R/outside/f" ]'
check "job-completed: _work 自体・別の root・空では何も消さず 0" '[ "$(done_hook "$AR/oogiri-doc-1/_work" "")" = 0 ] && [ "$(done_hook "$R/outside" "")" = 0 ] && [ "$(done_hook "" "")" = 0 ] && [ -f "$R/outside/f" ] && [ -f "$WS/file" ]'
mkws
check "job-completed: 環境変数 DLE_RUNNERS_ROOT は無視する（job の env: が届きうるため）" \
	'DLE_RUNNERS_ROOT="$AR" GITHUB_WORKSPACE="$WS" bash "$DONE" >/dev/null 2>&1; [ "$?" = 0 ] && [ -f "$WS/file" ]'

# bash -e で呼ばれても（runner は `bash -e <path>` で呼ぶ）、chmod 000 のサブディレクトリがあっても、
# 掃除を続けて終了コード 0 で終わる（失敗は警告にとどめ、_temp の掃除も続ける）
mkws
mkdir -p "$WS/locked/inner" "$AR/oogiri-doc-1/_work/_temp/locked2"
echo x >"$WS/locked/inner/f"; echo x >"$AR/oogiri-doc-1/_work/_temp/locked2/f"
chmod 000 "$WS/locked/inner" "$AR/oogiri-doc-1/_work/_temp/locked2"
GITHUB_WORKSPACE="$WS" RUNNER_TEMP="$AR/oogiri-doc-1/_work/_temp" bash -e "$DONE" "$AR" >/dev/null 2>&1
rc=$?
chmod -R u+rwX "$WS" "$AR/oogiri-doc-1/_work/_temp" 2>/dev/null
check "job-completed: bash -e でも、chmod 000 のサブディレクトリを消して終了コード 0（_temp も掃除する）" \
	'[ "$rc" = 0 ] && [ -z "$(ls -A "$WS")" ] && [ -z "$(ls -A "$AR/oogiri-doc-1/_work/_temp")" ]'
mkws
GITHUB_WORKSPACE="$R/outside" RUNNER_TEMP="$AR/oogiri-doc-1/_work/_temp" bash -e "$DONE" "$AR" >/dev/null 2>&1
rc=$?
check "job-completed: bash -e で workspace が範囲外でも終了コード 0 で、_temp の掃除は続ける" \
	'[ "$rc" = 0 ] && [ -z "$(ls -A "$AR/oogiri-doc-1/_work/_temp")" ] && [ -f "$R/outside/f" ]'

# 掃除フックは狭い PATH（/usr/bin:/bin）で足りる
mkws
check "job-completed: 環境変数が空・PATH=/usr/bin:/bin でも掃除できる（PATH を広げなくてよい）" \
	'env -i PATH=/usr/bin:/bin GITHUB_WORKSPACE="$WS" RUNNER_TEMP="$AR/oogiri-doc-1/_work/_temp" /usr/bin/bash "$DONE" "$AR" >/dev/null 2>&1; [ "$?" = 0 ] && [ -z "$(ls -A "$WS")" ] && [ -z "$(ls -A "$AR/oogiri-doc-1/_work/_temp")" ] && [ -f "$AR/oogiri-doc-1/_work/_tool/keep" ]'
check "job-completed: 使うコマンドは /usr/bin:/bin で解決でき、PATH の固定は変えない" \
	'PATH=/usr/bin:/bin command -v getent id cut realpath chmod find rm >/dev/null && grep -q "^export PATH=/usr/bin:/bin$" "$DONE"'
