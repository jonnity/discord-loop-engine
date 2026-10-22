#!/usr/bin/env bash
#
# discord-loop-engine のスクリプトのテスト（ネットワーク・GitHub 不要な範囲）。
# 何を保証するか:
#   - harness-notify の payload にプロジェクト名とリンクが必ず入る（共通チャンネルで見分けられる）
#   - webhook 未設定は既定で失敗になり、notify.required=false のときだけ skip になる
#   - リンク・タイトル無しの通知は送らない
#   - harness-guard がハーネスの入口を迂回するコマンドを止め、通常のコマンドは通す
#   - harness-config が既定値と設定値を返す

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="$ROOT/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ng() { fail=$((fail + 1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else ng "$1"; fi; }

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

echo ""
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
