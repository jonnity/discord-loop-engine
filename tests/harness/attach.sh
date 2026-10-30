#!/usr/bin/env bash
# 添付（--file）が黙って落ちない回帰試験（#25 / #34）。run.sh の隔離環境と集計を使う。
A="$TMP/attach"
mkdir -p "$A/work/sub" "$A/stub" "$A/bin"
printf 'hello\n' >"$A/work/sub/draft.md"

# harness-notify: 相対パスは絶対パスになって dle notify 相当（dry-run の出力）へ渡る
out="$(cd "$A/work" && "$BIN/harness-notify" --event blocked --title t --url https://e.x --file sub/draft.md --dry-run 2>&1)"
check "attach: harness-notify は相対 --file を絶対パスにする" 'grep -qF "添付: $A/work/sub/draft.md" <<<"$out"'
out="$(cd "$A/work/sub" && "$BIN/harness-notify" --event blocked --title t --url https://e.x --file ../sub/draft.md --dry-run 2>&1)"
check "attach: ../ を含む相対パスも解決する" 'grep -qF "添付: $A/work/sub/draft.md" <<<"$out"'

for mode in "--dry-run" ""; do
	out="$(cd "$A/work" && "$BIN/harness-notify" --event blocked --title t --url https://e.x --file nothing.md $mode 2>&1)"; rc=$?
	check "attach: 存在しない --file は exit 4 で通知しない ($mode)" '[ "$rc" = 4 ] && grep -q "添付ファイルが見つかりません" <<<"$out" && ! grep -q "dry-run" <<<"$out"'
done
out="$(cd "$A/work" && "$BIN/harness-notify" --event blocked --title t --url https://e.x --file /no/such/dir/x.md --dry-run 2>&1)"; rc=$?
check "attach: ディレクトリごと無い --file も exit 4（cd 失敗を / 直下に化けさせない）" '[ "$rc" = 4 ]'
out="$(cd "$A/work" && "$BIN/harness-notify" --event blocked --title t --url https://e.x --file sub --dry-run 2>&1)"; rc=$?
check "attach: ディレクトリを --file にしたら exit 4" '[ "$rc" = 4 ]'

# harness-phase: gh と harness-notify をスタブにして呼び出しを記録する
cp "$BIN/harness-phase" "$A/bin/harness-phase"
cat >"$A/bin/harness-notify" <<'STUB'
#!/usr/bin/env bash
echo "notify $*" >>"$ATTACH_LOG"
STUB
cat >"$A/stub/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$ATTACH_LOG"
case "$*" in
*"--json title"*) echo title ;;
*"--json url"*) echo https://e.x/1 ;;
*"issue comment"*) echo https://e.x/1#c ;;
esac
exit 0
STUB
chmod +x "$A/bin/harness-phase" "$A/bin/harness-notify" "$A/stub/gh"
phase() { (cd "$A/work" && PATH="$A/stub:$PATH" ATTACH_LOG="$A/log" "$A/bin/harness-phase" "$@" >"$A/phase.out" 2>&1); }

for ph in blocked interview; do
	rm -f "$A/log"
	phase 7 "$ph" --comment hi --file sub/draft.md; rc=$?
	check "attach: harness-phase $ph は相対 --file を絶対パスにして notify へ渡す" '[ "$rc" = 0 ] && grep -qF -- "--file $A/work/sub/draft.md" "$A/log"'
	rm -f "$A/log"
	phase 7 "$ph" --comment hi --file nothing.md; rc=$?
	check "attach: harness-phase $ph は存在しない --file で exit 4、gh も notify も呼ばない" '[ "$rc" = 4 ] && [ ! -e "$A/log" ] && grep -q "添付ファイルが見つかりません" "$A/phase.out"'
done
