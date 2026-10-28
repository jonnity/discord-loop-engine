#!/usr/bin/env bash
#
# discord-loop-engine のスクリプトのテスト（ネットワーク・GitHub 不要な範囲）。
# 何を保証するか:
#   - harness-notify の payload にプロジェクト名とリンクが必ず入る（共通チャンネルで見分けられる）
#   - webhook 未設定は既定で失敗になり、notify.required=false のときだけ skip になる
#   - リンク・タイトル無しの通知は送らない
#   - harness-guard がハーネスの入口を迂回するコマンドを止め、通常のコマンドは通す
#   - harness-config が既定値と設定値を返す
#   - harness-hook がフェーズの差し込み口を順に実行し、最初の失敗で止め、置換と環境変数を渡す
#   - harness-gate が gate の後に hooks.beforePR を実行し、失敗を結果に含める

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 実行中の engine（worker の中で走らせる場合）の環境を拾わない。拾うと harness-notify / harness-phase が
# 実 engine のソケットに繋がり、本物の Discord に投稿してしまう
unset DLE_ROLE DLE_PROJECT DLE_LOOP DLE_CONFIG_HOME DISCORD_WEBHOOK_URL DISCORD_BOT_TOKEN HARNESS_CONFIG
export DLE_HOME="$TMP/iso-home"
export DLE_SOCKET="$DLE_HOME/engine.sock"
mkdir -p "$DLE_HOME"
reject_fetch_url="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$ROOT/tests/harness/fixtures/reject-fetch.ts")" || exit "$?"
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=$reject_fetch_url"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ng() { fail=$((fail + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else ng "$1"; fi; }

check "isolate: engine のソケットは一時ディレクトリで、存在しない" '[ "$DLE_SOCKET" = "$TMP/iso-home/engine.sock" ] && [ ! -S "$DLE_SOCKET" ]'

# --- テスト用プロジェクト ------------------------------------------------------
PROJ="$TMP/proj"
mkdir -p "$PROJ/.claude"
git -C "$PROJ" init -q
cat >"$PROJ/.claude/harness.json" <<'EOF'
{ "project": "kishimen-tool", "repo": "jonnity/kishimen-tool", "maxParallel": 2, "notify": { "envFiles": [".env"] } }
EOF
export CLAUDE_PROJECT_DIR="$PROJ"
unset DISCORD_WEBHOOK_URL

# --- harness-config -------------------------------------------------------------
check "config: 設定値を返す" '[ "$("$BIN/harness-config" .maxParallel 3)" = 2 ]'
check "config: 未定義は既定値" '[ "$("$BIN/harness-config" .worktreeRoot .worktrees)" = .worktrees ]'

# --- harness-notify payload --------------------------------------------------
payload="$(cd "$PROJ" && "$BIN/harness-notify" --event merge-request --title "採点の修正" \
	--url "https://github.com/jonnity/kishimen-tool/pull/5#issuecomment-1" --issue 3 --pr 5 --body "判定 ✅" --dry-run)"
check "notify: 送信者名がプロジェクト名" '[ "$(jq -r .username <<<"$payload")" = kishimen-tool ]'
check "notify: 本文先頭にプロジェクト名" 'jq -r .content <<<"$payload" | head -n1 | grep -q "^\*\*\[kishimen-tool\]\*\*"'
check "notify: 本文にリンク" 'jq -r .content <<<"$payload" | grep -q "<https://github.com/jonnity/kishimen-tool/pull/5#issuecomment-1>"'
check "notify: 要対応の種別は返信を促す" 'jq -r .content <<<"$payload" | grep -q "返信"'
check "notify: embed タイトルがリンク先" '[ "$(jq -r ".embeds[0].url" <<<"$payload")" = "https://github.com/jonnity/kishimen-tool/pull/5#issuecomment-1" ]'
check "notify: embed author がプロジェクト" '[ "$(jq -r ".embeds[0].author.name" <<<"$payload")" = kishimen-tool ]'
check "notify: Issue と PR のリンク欄" '[ "$(jq -r "[.embeds[0].fields[].value] | join(\" \")" <<<"$payload")" = "[#3](https://github.com/jonnity/kishimen-tool/issues/3) [#5](https://github.com/jonnity/kishimen-tool/pull/5)" ]'
check "notify: メンションしない" '[ "$(jq -c .allowed_mentions <<<"$payload")" = "{\"parse\":[]}" ]'
check "notify: 見出しに Issue 番号" 'jq -r ".embeds[0].title" <<<"$payload" | grep -q "#3 採点の修正"'

info="$(cd "$PROJ" && "$BIN/harness-notify" --event merged --title t --url https://example.com --dry-run)"
check "notify: 情報系は返信を促さない" '! jq -r .content <<<"$info" | grep -q "返信"'

override="$(cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$BIN/harness-notify" --event info --title t --url https://e.x --repo jonnity/oogiri-doc --dry-run)"
check "notify: 設定が無くても --repo からプロジェクト名" '[ "$(jq -r .username <<<"$override")" = oogiri-doc ]'

(cd "$PROJ" && "$BIN/harness-notify" --event info --title t --dry-run) >/dev/null 2>&1
check "notify: URL 無しは拒否" '[ $? -eq 2 ]'
(cd "$PROJ" && "$BIN/harness-notify" --event nope --title t --url https://e.x --dry-run) >/dev/null 2>&1
check "notify: 不明な種別は拒否" '[ $? -eq 2 ]'

(cd "$PROJ" && "$BIN/harness-notify" --event info --title t --url https://e.x) >/dev/null 2>&1
check "notify: webhook 未設定は既定で失敗(3)" '[ $? -eq 3 ]'

jq '.notify.required = false' "$PROJ/.claude/harness.json" >"$TMP/h.json" && mv "$TMP/h.json" "$PROJ/.claude/harness.json"
(cd "$PROJ" && "$BIN/harness-notify" --event info --title t --url https://e.x) >/dev/null 2>&1
check "notify: required=false なら skip(0)" '[ $? -eq 0 ]'

# --- harness-inbox（gh はスタブ） ---------------------------------------------
inbox="$(cd "$PROJ" && PATH="$ROOT/tests/harness/fixtures:$PATH" "$BIN/harness-inbox" 2>/dev/null)"
check "inbox: 質問後の owner の返信だけを回答にする" '[ "$(jq -sc "[.[] | select(.issue==3) | .url]" <<<"$inbox")" = "[\"u3\"]" ]'
check "inbox: 第三者の OK は承認にしない・最新の owner 判断を採る" '[ "$(jq -sc "[.[] | select(.issue==5) | .kind + \":\" + .url]" <<<"$inbox")" = "[\"merge-ok:c4\"]" ]'
check "inbox: 依頼後に head が進んだら stale-notify" '[ "$(jq -sr ".[] | select(.issue==6) | .kind" <<<"$inbox")" = stale-notify ]'
check "inbox: harness:merge-ok ラベルは承認" '[ "$(jq -sr ".[] | select(.issue==7) | .kind" <<<"$inbox")" = merge-ok ]'

# --- harness-issue-md（gh はスタブ） --------------------------------------------
GHSTUB="$ROOT/tests/harness/fixtures"
md20="$(PATH="$GHSTUB:$PATH" "$BIN/harness-issue-md" 20 2>&1)"
check "issue-md: 見出しにタイトルと番号" 'head -n1 <<<"$md20" | grep -q "^# #20 本文ありのIssue$"'
check "issue-md: 本文（受け入れ条件）が入る" 'grep -q "1. これができる" <<<"$md20"'
check "issue-md: 本文がコメントより前" '[ "$(grep -n "これができる" <<<"$md20" | cut -d: -f1)" -lt "$(grep -n "要件メモ" <<<"$md20" | cut -d: -f1)" ]'
check "issue-md: コメントの見出しに author と authorAssociation" 'grep -q "^### jonnity（OWNER, 2026-10-02T00:00:00Z）$" <<<"$md20" && grep -q "^### stranger（NONE, " <<<"$md20"'
check "issue-md: 本文が重複しない" '[ "$(grep -c "これができる" <<<"$md20")" = 1 ]'
md21="$(PATH="$GHSTUB:$PATH" "$BIN/harness-issue-md" 21 2>&1)"
check "issue-md: コメント 0 件でも本文を出す" 'grep -q "本文だけ" <<<"$md21" && ! grep -q "^### " <<<"$md21"'
md22="$(PATH="$GHSTUB:$PATH" "$BIN/harness-issue-md" 22 2>&1)"
check "issue-md: 本文が空でもエラーにしない" '[ -n "$md22" ] && grep -q "^# #22 " <<<"$md22"'
PATH="$GHSTUB:$PATH" "$BIN/harness-issue-md" >/dev/null 2>&1
check "issue-md: 番号無しは拒否(2)" '[ $? -eq 2 ]'

# 旧配置を明示した利用者の互換試験。
jq '.worktreeRoot = ".worktrees"' "$PROJ/.claude/harness.json" > "$TMP/h.json" && mv "$TMP/h.json" "$PROJ/.claude/harness.json"

# --- harness-codex / harness-codex-status（codex・tmux はスタブ） ------------------
STUBS="$ROOT/tests/harness/fixtures"
CW="$TMP/cwt dir"   # 空白入りの worktree
mkdir -p "$CW/.harness"
echo "依頼 'quote' です" >"$TMP/prompt.md"
export TMUX_STUB_LOG="$TMP/tmux.log" TMUX_STUB_PANES="$TMP/panes"
cs() { (cd "$PROJ" && PATH="$STUBS:$PATH" "$BIN/harness-codex-status" "$@"); }
cx() { (cd "$PROJ" && PATH="$STUBS:$PATH" "$BIN/harness-codex" "$@"); }

cs check >/dev/null 2>&1
check "codex check: ログイン済みなら 0" '[ $? -eq 0 ]'
err="$(CODEX_STUB_LOGIN=1 cs check 2>&1 >/dev/null)"; rc=$?
check "codex check: 未ログインは 10 と reason=not-logged-in" '[ $rc -eq 10 ] && head -n1 <<<"$err" | grep -q "^reason=not-logged-in"'
MIN="$TMP/minbin"; mkdir -p "$MIN"
for t in dirname head cut cat; do ln -sf "$(command -v $t)" "$MIN/$t"; done
err="$(PATH="$MIN" "$(command -v bash)" "$BIN/harness-codex-status" check 2>&1 >/dev/null)"; rc=$?
check "codex check: codex が無ければ 10 と reason=not-installed" '[ $rc -eq 10 ] && head -n1 <<<"$err" | grep -q "^reason=not-installed"'

: >"$TMUX_STUB_LOG"
CODEX_STUB_LOGIN=1 cx start codex-spec-9 "$CW" "$TMP/prompt.md" >/dev/null 2>&1
check "codex start: 未ログインは 10 で、tmux のウィンドウを作らない" '[ $? -eq 10 ] && ! grep -q new-window "$TMUX_STUB_LOG"'
echo old >"$CW/.harness/codex-spec-9.exit"
: >"$TMUX_STUB_LOG"
cx start codex-spec-9 "$CW" "$TMP/prompt.md" >/dev/null 2>&1
check "codex start: ログイン済みなら起動できる" '[ $? -eq 0 ] && grep -q "^new-window -n codex-spec-9 -P -F #{window_id} " "$TMUX_STUB_LOG"'
check "codex start: new-window と remain-on-exit が同じ tmux 呼び出し（\; 連結）で、名前では -t しない" 'grep -c "^new-window" "$TMUX_STUB_LOG" | grep -qx 1 && grep -q "^new-window .* ; set-option -w remain-on-exit on$" "$TMUX_STUB_LOG" && ! grep -q "set-option .* -t " "$TMUX_STUB_LOG"'
check "codex start: window-id を .id に保存し、フォーカスを元に戻す" '[ "$(cat "$CW/.harness/codex-spec-9.id")" = @7 ] && grep -qx "select-window -t @1" "$TMUX_STUB_LOG"'
check "codex start: 前回の .exit を消す" '[ ! -e "$CW/.harness/codex-spec-9.exit" ]'
check "codex start: EXIT= を残す" 'grep -q "echo EXIT=" "$TMUX_STUB_LOG"'
# 起動文字列を実際に sh で動かし、空白入りのパス・引用符入りの依頼文が壊れずに codex へ渡ることを確かめる
inner="$(grep "^new-window" "$TMUX_STUB_LOG" | sed -e "s/^new-window -n codex-spec-9 -P -F #{window_id} //" -e "s/ ; set-option.*$//")"
mkdir -p "$TMP/echobin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" >"$ECHO_OUT"\n' >"$TMP/echobin/codex"; chmod +x "$TMP/echobin/codex"
ECHO_OUT="$TMP/echo.out" PATH="$TMP/echobin:$PATH" bash -c "$inner" >/dev/null 2>&1
check "codex start: 空白入りの worktree と引用符入りの依頼文が壊れない" 'grep -qx "$CW" "$TMP/echo.out" && grep -qx "依頼 '"'"'quote'"'"' です" "$TMP/echo.out"'
check "codex start: 終了コードを .exit に残す" 'grep -qx "EXIT=0" "$CW/.harness/codex-spec-9.exit"'
cx start codex-spec-9 >/dev/null 2>&1
check "codex start: 引数不正は 2" '[ $? -eq 2 ]'

# T17a/b: 配布値だけでなく、tmux 内の bash が実際に渡す argv と片付けを確認する。
EXPECTED17='codex -C {worktree} -c model_reasoning_effort=high -c sandbox_workspace_write.network_access=true exec --sandbox workspace-write'
check "T17a: ラッパーの既定 command は完全一致" 'grep -Fqx "DEFAULT_CODEX='"'"'$EXPECTED17'"'"'" "$BIN/harness-codex"'
for template17 in "$ROOT/templates/profile.example.json" "$ROOT/templates/examples/kishimen-tool.json"; do
	check "T17a: テンプレートの command は完全一致（${template17##*/}）" 'jq -e --arg expected "$EXPECTED17" '\''.codex.command == $expected'\'' "$template17" >/dev/null'
done
launch17() (
	case17="$1"
	root17="$TMP/launch17-$case17"
	wt17="$root17/wt space '\$ (x)"
	prompt17="$root17/prompt space '\$ (x).md"
	mkdir -p "$wt17/.harness" "$root17/bin" || exit 1
	export HARNESS_CONFIG="$root17/profile.json" TMUX_STUB_LOG="$root17/tmux.log" TMUX_STUB_PANES="$root17/panes"
	case "$case17" in
	absent) echo '{}' > "$HARNESS_CONFIG" ;;
	empty) echo '{"codex":{}}' > "$HARNESS_CONFIG" ;;
	legacy) jq -n --arg c 'codex -C {worktree} exec --dangerously-bypass-approvals-and-sandbox' '{codex:{command:$c}}' > "$HARNESS_CONFIG" ;;
	custom) jq -n --arg c 'codex -C {worktree} exec --model custom' '{codex:{command:$c}}' > "$HARNESS_CONFIG" ;;
	esac
	printf '%s' '依頼 "quote" '\''single'\'' $value `literal`
次の行' > "$prompt17"
	cat > "$root17/bin/codex" <<'STUB17'
#!/usr/bin/env bash
printf '%s\0' "$@" | jq -Rs 'split("\u0000")[:-1]' > "$ARGV17"
STUB17
	chmod +x "$root17/bin/codex" || exit 1
	: > "$TMUX_STUB_LOG"
	echo old > "$wt17/.harness/codex-spec-17.exit"
	cx start codex-spec-17 "$wt17" "$prompt17" >/dev/null 2>&1 || exit 1
	[ "$(cat "$wt17/.harness/codex-spec-17.id")" = @7 ] || exit 1
	[ ! -e "$wt17/.harness/codex-spec-17.exit" ] || exit 1
	inner17="$(sed -n 's/^new-window -n codex-spec-17 -P -F #{window_id} //; s/ ; set-option.*$//p' "$TMUX_STUB_LOG")"
	ARGV17="$root17/argv.json" PATH="$root17/bin:$PATH" bash -c "$inner17" >/dev/null 2>&1 || exit 1
	[ -s "$root17/argv.json" ] || exit 1
	case "$case17" in
	absent|empty) args17='["-c","model_reasoning_effort=high","-c","sandbox_workspace_write.network_access=true","exec","--sandbox","workspace-write"]' ;;
	legacy) args17='["exec","--dangerously-bypass-approvals-and-sandbox"]' ;;
	custom) args17='["exec","--model","custom"]' ;;
	esac
	jq -e --arg wt "$wt17" --rawfile prompt "$prompt17" --argjson args "$args17" \
		'. == (["-C", $wt] + $args + [$prompt])' "$root17/argv.json" >/dev/null || exit 1
	[ "$(cat "$wt17/.harness/codex-spec-17.exit")" = EXIT=0 ] || exit 1
	printf '@7 codex-spec-17 1\n' > "$TMUX_STUB_PANES"
	cx stop codex-spec-17 "$wt17" >/dev/null 2>&1 || exit 1
	grep -qx 'kill-window -t @7' "$TMUX_STUB_LOG" &&
		[ ! -e "$wt17/.harness/codex-spec-17.id" ] && [ ! -e "$wt17/.harness/codex-spec-17.exit" ]
)
for case17 in absent empty legacy custom; do
	check "T17a/b: $case17 の実 argv・ID・exit・stop" 'launch17 "$case17"'
done

# status は window 名ではなく start が保存した window-id で引く
: >"$TMUX_STUB_PANES"; rm -f "$CW/.harness/codex-impl-4.exit" "$CW/.harness/codex-impl-4.id"
check "codex status: ウィンドウも .exit も無ければ none" '[ "$(cs status codex-impl-4 "$CW")" = none ]'
echo "@4" >"$CW/.harness/codex-impl-4.id"
echo "@4 codex-impl-4 0" >"$TMUX_STUB_PANES"
check "codex status: 生きていれば running" '[ "$(cs status codex-impl-4 "$CW")" = running ]'
echo "@4 codex-impl-4 1" >"$TMUX_STUB_PANES"
check "codex status: 死んでいて .exit が無ければ exited:unknown" '[ "$(cs status codex-impl-4 "$CW")" = exited:unknown ]'
echo "EXIT=1" >"$CW/.harness/codex-impl-4.exit"
check "codex status: 死んでいて .exit があれば exited:<code>" '[ "$(cs status codex-impl-4 "$CW")" = exited:1 ]'
: >"$TMUX_STUB_PANES"
check "codex status: ウィンドウが消えていても .exit から読む" '[ "$(cs status codex-impl-4 "$CW")" = exited:1 ]'
printf '@9 codex-impl-4 0\n@3 codex-impl-4 0\n' >"$TMUX_STUB_PANES"
check "codex status: 別のウィンドウ（同名の別プロジェクトを含む）が生きていても、自分の id が無ければ running にしない" '[ "$(cs status codex-impl-4 "$CW")" = exited:1 ]'
printf '@9 codex-impl-4 0\n@4 codex-impl-4 1\n' >"$TMUX_STUB_PANES"
check "codex status: 同名の別ウィンドウが生きていても、自分の id が死んでいれば exited" '[ "$(cs status codex-impl-4 "$CW")" = exited:1 ]'
rm -f "$CW/.harness/codex-impl-4.exit"
check "codex status: 自分の id が死んでいて .exit が無ければ、他が生きていても exited:unknown" '[ "$(cs status codex-impl-4 "$CW")" = exited:unknown ]'
rm -f "$CW/.harness/codex-impl-4.id"
printf '@9 codex-impl-4 0\n' >"$TMUX_STUB_PANES"
check "codex status: id ファイルが無ければ他のウィンドウは見ず none" '[ "$(cs status codex-impl-4 "$CW")" = none ]'
echo "@4" >"$CW/.harness/codex-impl-4.id"
printf '@4 other-window 0\n' >"$TMUX_STUB_PANES"
check "codex status: id が一致しても名前が違えば（tmux 再起動で振り直された id）running にしない" '[ "$(cs status codex-impl-4 "$CW")" = none ]'

# stop: 空・不在の id では tmux に -t "" を渡さない（今いるウィンドウ＝worker 自身を消してしまう）
rm -f "$CW/.harness/codex-impl-4.id"; : >"$TMUX_STUB_LOG"
cx stop codex-impl-4 "$CW" >/dev/null 2>&1
check "codex stop: id ファイルが無ければ何もせず 0（kill-window しない）" '[ $? -eq 0 ] && ! grep -q kill-window "$TMUX_STUB_LOG"'
: >"$CW/.harness/codex-impl-4.id"; : >"$TMUX_STUB_LOG"
cx stop codex-impl-4 "$CW" >/dev/null 2>&1
check "codex stop: id が空でも kill-window しない" '[ $? -eq 0 ] && ! grep -q kill-window "$TMUX_STUB_LOG"'
echo "@4" >"$CW/.harness/codex-impl-4.id"; echo "EXIT=0" >"$CW/.harness/codex-impl-4.exit"
printf '@4 other-window 0\n' >"$TMUX_STUB_PANES"; : >"$TMUX_STUB_LOG"
cx stop codex-impl-4 "$CW" >/dev/null 2>&1
check "codex stop: 名前が違うウィンドウは kill しない" '! grep -q kill-window "$TMUX_STUB_LOG"'
echo "@4" >"$CW/.harness/codex-impl-4.id"; echo "EXIT=0" >"$CW/.harness/codex-impl-4.exit"
printf '@4 codex-impl-4 1\n' >"$TMUX_STUB_PANES"; : >"$TMUX_STUB_LOG"
cx stop codex-impl-4 "$CW" >/dev/null 2>&1
check "codex stop: id と名前が一致すれば id で kill-window し、.id と .exit を消す" 'grep -qx "kill-window -t @4" "$TMUX_STUB_LOG" && [ ! -e "$CW/.harness/codex-impl-4.id" ] && [ ! -e "$CW/.harness/codex-impl-4.exit" ]'
check "codex stop: 片付けた後の status は none（exited:0 を返し続けない）" '[ "$(cs status codex-impl-4 "$CW")" = none ]'
cx stop codex-impl-4 >/dev/null 2>&1
check "codex stop: 引数不正は 2" '[ $? -eq 2 ]'
mkdir -p "$PROJ/.worktrees/issue-5/.harness"; echo "EXIT=0" >"$PROJ/.worktrees/issue-5/.harness/codex-spec-5.exit"; : >"$TMUX_STUB_PANES"
check "codex status: worktree 省略時は window 名の番号から探す" '[ "$(cs status codex-spec-5)" = exited:0 ]'

# harness-status は自分のプロジェクトの id ファイルにあるウィンドウだけを表示する
mkdir -p "$PROJ/.worktrees/issue-4/.harness"
echo "@4" >"$PROJ/.worktrees/issue-4/.harness/codex-impl-4.id"; echo "EXIT=1" >"$PROJ/.worktrees/issue-4/.harness/codex-impl-4.exit"
echo "@5" >"$PROJ/.worktrees/issue-5/.harness/codex-spec-5.id"; rm -f "$PROJ/.worktrees/issue-5/.harness/codex-spec-5.exit"
printf '@4 codex-impl-4 1\n@5 codex-spec-5 0\n@8 codex-impl-8 0\n' >"$TMUX_STUB_PANES"
st="$(cd "$PROJ" && PATH="$STUBS:$PATH" "$BIN/harness-status" 2>/dev/null)"
check "status: 自分の codex ウィンドウを終了コード付きで見分けられる" 'grep -q "codex-impl-4: exited:1" <<<"$st" && grep -q "codex-spec-5: running" <<<"$st" && ! grep -q "@8" <<<"$st"'

# --- harness-guard -------------------------------------------------------------
guard() { jq -nc --arg c "$1" '{tool_input:{command:$c}}' | "$BIN/harness-guard" >/dev/null 2>&1; echo $?; }
check "guard: フェーズラベル直接付与を止める" '[ "$(guard "gh issue edit 3 --add-label harness:awaiting-merge")" = 2 ]'
check "guard: merge-ok の自己付与を止める" '[ "$(guard "gh issue edit 3 --add-label harness:merge-ok")" = 2 ]'
check "guard: queued の付与は通す" '[ "$(guard "gh issue edit 3 --add-label harness:queued")" = 0 ]'
check "guard: gh pr merge を止める" '[ "$(guard "gh pr merge 5 --merge")" = 2 ]'
check "guard: git add -f を止める" '[ "$(guard "git -C /w add -f .harness/spec/3.md")" = 2 ]'
check "guard: git add --force を止める" '[ "$(guard "git add --force x")" = 2 ]'
check "guard: webhook 直接 curl を止める" '[ "$(guard "curl -F x=1 https://discord.com/api/webhooks/1/abc")" = 2 ]'
check "guard: harness-phase は通す" '[ "$(guard "harness-phase 3 awaiting-merge --pr 5 --comment-file /tmp/x")" = 0 ]'
check "guard: プラグインパス経由の harness-merge は通す" '[ "$(guard "/root/.claude/plugins/x/bin/harness-merge 3")" = 0 ]'
check "guard: 通常の git add は通す" '[ "$(guard "git add src/a.ts")" = 0 ]'
check "guard: 空コミットを止める" '[ "$(guard "git commit --allow-empty -m retrigger")" = 2 ]'
check "guard: 通常のコミットは通す" '[ "$(guard "git commit -m fix")" = 0 ]'
check "guard: 通常の gh は通す" '[ "$(guard "gh pr view 5 --json url")" = 0 ]'
rm "$PROJ/.claude/harness.json"
check "guard: harness.json が無いプロジェクトでは何もしない" '[ "$(guard "gh pr merge 5")" = 0 ]'

# --- engine 側の設定（リポジトリに何も置かない形） ---------------------------------
DLEH="$TMP/dle-home"
mkdir -p "$DLEH/projects/kishimen-tool"
echo '{ "project": "kishimen-tool", "maxParallel": 4 }' >"$DLEH/projects/kishimen-tool/harness.json"
check "config: リポジトリに無ければ engine 側の設定を読む" '[ "$(DLE_HOME="$DLEH" DLE_PROJECT=kishimen-tool "$BIN/harness-config" .maxParallel 3)" = 4 ]'
check "config: DLE_PROJECT が無ければ engine 側は見ない" '[ "$(DLE_HOME="$DLEH" "$BIN/harness-config" .maxParallel 3)" = 3 ]'
echo '{ "maxParallel": 2 }' >"$PROJ/.claude/harness.json"
check "config: リポジトリに置いてあればそちらを優先する" '[ "$(DLE_HOME="$DLEH" DLE_PROJECT=kishimen-tool "$BIN/harness-config" .maxParallel 3)" = 2 ]'
rm "$PROJ/.claude/harness.json"
gguard() { jq -nc --arg c "$1" '{tool_input:{command:$c}}' | env "${@:2}" "$BIN/harness-guard" >/dev/null 2>&1; echo $?; }
check "guard: engine 側の設定があれば働く" '[ "$(gguard "gh pr merge 5" DLE_HOME="$DLEH" DLE_PROJECT=kishimen-tool)" = 2 ]'
check "guard: native モードでは何もしない（独自のループの gh pr merge を止めない）" '[ "$(gguard "gh pr merge 5" DLE_HOME="$DLEH" DLE_PROJECT=kishimen-tool DLE_LOOP=native)" = 0 ]'
check "guard: 設定の無いプロジェクトでは何もしない" '[ "$(gguard "gh pr merge 5" DLE_HOME="$DLEH" DLE_PROJECT=oogiri-doc)" = 0 ]'

# --- C16: 設定 home と実行 home の分離 -------------------------------------------
(
	C16="$TMP/config16"
	MAIN16="$C16/main"
	CWD16="$C16/wt"
	LEGACY16="$C16/legacy home"
	CONFIG16="$C16/config home"
	USER16="$C16/user"
	mkdir -p "$MAIN16/.claude" "$CWD16" "$USER16"
	for base in "$LEGACY16" "$MAIN16/legacy relative" "$USER16/.discord-loop-engine"; do
		mkdir -p "$base/projects/fixture"
		echo '{"project":"legacy"}' > "$base/projects/fixture/harness.json"
	done
	for base in "$CONFIG16" "$MAIN16/config relative"; do
		mkdir -p "$base/projects/fixture"
		echo '{"project":"config-home"}' > "$base/projects/fixture/harness.json"
	done
	echo '{"project":"explicit"}' > "$C16/explicit.json"
	cd "$CWD16" || exit 1
	export CLAUDE_PROJECT_DIR="$MAIN16" DLE_PROJECT=fixture
	unset HARNESS_CONFIG DLE_HOME DLE_CONFIG_HOME
	config16() { env HOME="$USER16" "$@" "$BIN/harness-config" "${ARGS16[@]}"; }
	assert16() {
		local expected_path="$1" expected_value="$2"
		shift 2
		ARGS16=(--path)
		[ "$(config16 "$@")" = "$expected_path" ] || return 1
		ARGS16=(.project)
		[ "$(config16 "$@")" = "$expected_value" ]
	}
	missing16() {
		ARGS16=(.project)
		config16 "$@" >/dev/null 2>&1
		[ "$?" = 1 ] || return 1
		ARGS16=(.project fallback)
		[ "$(config16 "$@")" = fallback ]
	}
	for runtime in unset '' "$LEGACY16" 'legacy relative'; do
		RUNTIME16=()
		case "$runtime" in
		unset) BASE16="$USER16/.discord-loop-engine" ;;
		'') BASE16="$USER16/.discord-loop-engine"; RUNTIME16=(DLE_HOME=) ;;
		/*) BASE16="$runtime"; RUNTIME16=("DLE_HOME=$runtime") ;;
		*) BASE16="$MAIN16/$runtime"; RUNTIME16=("DLE_HOME=$runtime") ;;
		esac
		for config in unset '' "$CONFIG16" 'config relative'; do
			CONFIG_ENV16=()
			VALUE16=legacy
			EXPECTED16="$BASE16/projects/fixture/harness.json"
			case "$config" in
			unset) ;;
			'') CONFIG_ENV16=(DLE_CONFIG_HOME=) ;;
			/*) CONFIG_ENV16=("DLE_CONFIG_HOME=$config"); EXPECTED16="$config/projects/fixture/harness.json"; VALUE16="config-home" ;;
			*) CONFIG_ENV16=("DLE_CONFIG_HOME=$config"); EXPECTED16="$MAIN16/$config/projects/fixture/harness.json"; VALUE16="config-home" ;;
			esac
			check "C16: home=$runtime config=$config のパスと値" 'assert16 "$EXPECTED16" "$VALUE16" "${RUNTIME16[@]}" "${CONFIG_ENV16[@]}"'
		done
	done
	check "C16: 専用設定homeでもworktreeRootは実行homeの兄弟" 'ARGS16=(--worktree-root); [ "$(config16 "DLE_HOME=$LEGACY16" "DLE_CONFIG_HOME=$CONFIG16")" = "$LEGACY16-worktrees/fixture" ]'
	echo '{"project":"repo"}' > "$MAIN16/.claude/harness.json"
	check "C16: repoは設定homeに優先する" 'assert16 "$MAIN16/.claude/harness.json" repo "DLE_HOME=$LEGACY16" "DLE_CONFIG_HOME=$CONFIG16"'
	check "C16: 明示指定はrepoと設定homeに優先する" 'assert16 "$C16/explicit.json" explicit "HARNESS_CONFIG=$C16/explicit.json" "DLE_CONFIG_HOME=$CONFIG16"'
	check "C16: 欠損した明示指定はfallbackしない" 'ARGS16=(--path); [ "$(config16 "HARNESS_CONFIG=$C16/missing.json" "DLE_CONFIG_HOME=$CONFIG16")" = "$C16/missing.json" ] && missing16 "HARNESS_CONFIG=$C16/missing.json" "DLE_CONFIG_HOME=$CONFIG16"'
	rm "$MAIN16/.claude/harness.json"
	check "C16: 登録名なしでは設定homeを使わない" 'ARGS16=(--path); [ "$(config16 DLE_PROJECT= "DLE_CONFIG_HOME=$CONFIG16")" = "$MAIN16/.claude/harness.json" ] && ARGS16=(.project fallback) && [ "$(config16 DLE_PROJECT= "DLE_CONFIG_HOME=$CONFIG16")" = fallback ]'
	check "C16: 設定home欠損時は旧homeを探し直さない" 'ARGS16=(--path); [ "$(config16 "DLE_HOME=$LEGACY16" "DLE_CONFIG_HOME=$C16/missing")" = "$MAIN16/.claude/harness.json" ] && missing16 "DLE_HOME=$LEGACY16" "DLE_CONFIG_HOME=$C16/missing"'
	check "C16: 全候補欠損は終了1、既定値付きは終了0" 'missing16 "DLE_HOME=$C16/missing"'
	printf '%s %s\n' "$pass" "$fail" > "$C16/counts"
) || exit 1
read -r pass fail < "$TMP/config16/counts"

# --- harness-hook / harness-gate ------------------------------------------------
HP="$TMP/hookproj"
mkdir -p "$HP/.claude"
git -C "$HP" init -q
cat >"$HP/.claude/harness.json" <<'JSON'
{
  "setup": ["echo setup >> log"],
  "gate": [{ "name": "ok", "run": "true" }],
  "hooks": {
    "afterWorktree": ["echo after {n} >> log", "echo \"$HARNESS_ISSUE:$HARNESS_PR\" >> log"],
    "beforePR": ["echo before-pr >> log"],
    "beforeMerge": ["echo one >> log", "false", "echo never >> log"]
  },
  "ciTriage": "echo legacy-triage >> log"
}
JSON
hook() { (cd "$HP" && CLAUDE_PROJECT_DIR="$HP" "$BIN/harness-hook" "$@") >/dev/null 2>&1; echo $?; }
rm -f "$HP/log"
check "hook: afterWorktree は setup の後に hooks を順に実行し、{n} と環境変数を渡す" '[ "$(hook afterWorktree --issue 7 --pr 9)" = 0 ] && [ "$(cat "$HP/log")" = "$(printf "setup\nafter 7\n7:9")" ]'
rm -f "$HP/log"
check "hook: 失敗したら止め、後のコマンドは実行しない" '[ "$(hook beforeMerge)" = 1 ] && [ "$(cat "$HP/log")" = one ]'
rm -f "$HP/log"
check "hook: onCIRed が無ければ以前の ciTriage を使う" '[ "$(hook onCIRed)" = 0 ] && [ "$(cat "$HP/log")" = legacy-triage ]'
check "hook: 不明なフェーズは拒否" '[ "$(hook nope)" = 2 ]'
check "hook: 設定の無いリポジトリでは何もしない" '[ "$(cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$BIN/harness-hook" beforePR >/dev/null 2>&1; echo $?)" = 0 ]'
rm -f "$HP/log"
gate_out="$(cd "$HP" && CLAUDE_PROJECT_DIR="$HP" "$BIN/harness-gate" 2>&1)"
check "gate: gate の後に hooks.beforePR を実行して結果に載せる" 'grep -q "✅ hooks.beforePR" <<<"$gate_out" && [ "$(cat "$HP/log")" = before-pr ]'
jq '.hooks.beforePR = ["false"]' "$HP/.claude/harness.json" >"$TMP/h.json" && mv "$TMP/h.json" "$HP/.claude/harness.json"
(cd "$HP" && CLAUDE_PROJECT_DIR="$HP" "$BIN/harness-gate" >/dev/null 2>&1)
check "gate: hooks.beforePR が失敗したらゲートも失敗" '[ $? -eq 1 ]'

echo ""
source "$ROOT/tests/harness/quality.sh" || exit 1
source "$ROOT/tests/harness/worktrees.sh" || exit 1

echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
