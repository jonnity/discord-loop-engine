#!/usr/bin/env bash
# harness-phase が強制整理のために engine へ渡す from_phase・transition_id と、整理の境界の出力（#61）。
# gh・dle・harness-notify・harness-request・harness-adopt はスタブにして、呼出しの引数だけを確かめる。
# run.sh の隔離環境と集計を使う。
R="$TMP/phase-refresh"
mkdir -p "$R/root/bin" "$R/root/src" "$R/stub" "$R/work"
cp "$BIN/harness-phase" "$BIN/harness-config" "$R/root/bin/"
printf 'process.exit(0);\n' >"$R/root/src/harness-request.ts"
printf 'process.exit(0);\n' >"$R/root/src/harness-adopt.ts"
cat >"$R/root/bin/harness-notify" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$R/root/bin/dle" <<'STUB'
#!/usr/bin/env bash
# 引数を1行に記録し、STUB_DLE_OUT があればそれを結果として返す
echo "$*" >>"$PHASE_LOG"
[ -z "${STUB_DLE_OUT:-}" ] || printf '%s\n' "$STUB_DLE_OUT"
exit "${STUB_DLE_EXIT:-0}"
STUB
cat >"$R/stub/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
*"--json title"*) echo title ;;
*"--json url"*) echo https://e.x/1 ;;
*"--json labels"*)
	[ -z "${STUB_LABELS_FAIL:-}" ] || exit 1
	printf '%s' "${STUB_LABELS:-}" | tr ',' '\n'
	;;
*"issue comment"*) echo https://e.x/1#c ;;
esac
exit 0
STUB
chmod +x "$R/root/bin/"* "$R/stub/gh"
# engine のソケットとして扱われる通常でないファイル（-S で真になる）。listen 後に終了すればファイルだけが残る
node -e 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))' "$R/engine.sock"
phase_run() {
	# 使い方: phase_run <labels(,区切り)> <引数...>。標準出力は $R/out、標準エラーは $R/err、dle の呼出しは $R/log
	local labels="$1"
	shift
	rm -f "$R/log"
	(cd "$R/work" && PATH="$R/stub:$PATH" PHASE_LOG="$R/log" STUB_LABELS="$labels" DLE_SOCKET="$R/engine.sock" DLE_PROJECT=proj \
		"$R/root/bin/harness-phase" "$@" >"$R/out" 2>"$R/err")
}
UUID_RE='--transition_id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

phase_run "harness:priority,harness:designing" 7 implementing; rc=$?
check "phase-refresh: priority を混ぜても from_phase は designing（一意）。transition_id は UUID" \
	'[ "$rc" = 0 ] && grep -q -- "--from_phase designing" "$R/log" && grep -qE -- "$UUID_RE" "$R/log"'
check "phase-refresh: 通常経路は --json 付きで notify し、境界が無ければ stdout は空" '[ ! -s "$R/out" ] && grep -q -- "--json" "$R/log"'
phase_run "harness:merge-ok,harness:impl-review" 7 designing; rc=$?
check "phase-refresh: merge-ok を混ぜても from_phase は impl-review" '[ "$rc" = 0 ] && grep -q -- "--from_phase impl-review" "$R/log"'
for labels in "harness:priority" "harness:designing,harness:implementing" "harness:foo" ""; do
	phase_run "$labels" 7 implementing; rc=$?
	check "phase-refresh: ラベル「$labels」では from_phase を付けない（transition_id だけ付く）" \
		'[ "$rc" = 0 ] && ! grep -q -- "--from_phase" "$R/log" && grep -qE -- "$UUID_RE" "$R/log"'
done

BOUNDARY='{"task":"T-1","refreshBoundary":{"boundary_id":"11111111-2222-3333-4444-555555555555","expires_at":1234,"project":"proj","issue":"7","phase":"implementing","extra":"x"}}'
STUB_DLE_OUT="$BOUNDARY" phase_run "harness:designing" 7 implementing; rc=$?
check "phase-refresh: 境界があるときだけ固定形式の JSON を1行 stdout へ出す（余計な項目は出さない）" \
	'[ "$rc" = 0 ] && [ "$(wc -l <"$R/out")" = 1 ] && [ "$(jq -c . "$R/out")" = "{\"refreshBoundary\":{\"boundary_id\":\"11111111-2222-3333-4444-555555555555\",\"expires_at\":1234,\"issue\":\"7\",\"phase\":\"implementing\"}}" ]'
for bad in 'not json' '{"refreshBoundary":{"boundary_id":"x","expires_at":1}}' '{"refreshBoundary":null}'; do
	STUB_DLE_OUT="$bad" phase_run "harness:designing" 7 implementing; rc=$?
	check "phase-refresh: 不正な応答「$bad」では stdout に何も出さず、遷移は成功のまま" '[ "$rc" = 0 ] && [ ! -s "$R/out" ]'
done
STUB_DLE_EXIT=3 phase_run "harness:designing" 7 implementing; rc=$?
check "phase-refresh: notify が失敗しても遷移は成功（best effort のまま）" '[ "$rc" = 0 ] && [ ! -s "$R/out" ]'

# awaiting-merge の完成経路（harness-request の前にラベルを読む）と --adopt-pending の経路
phase_run "harness:impl-review,harness:merge-ok" 7 awaiting-merge --pr 5 --comment hi; rc=$?
check "phase-refresh: awaiting-merge（完成）も from_phase と transition_id を付ける。境界は出さない" \
	'[ "$rc" = 0 ] && grep -q -- "--phase awaiting-merge" "$R/log" && grep -q -- "--from_phase impl-review" "$R/log" && grep -qE -- "$UUID_RE" "$R/log" && ! grep -q -- "--json" "$R/log" && [ ! -s "$R/out" ]'
STUB_LABELS_FAIL=1 phase_run "harness:impl-review" 7 awaiting-merge --pr 5 --comment hi; rc=$?
check "phase-refresh: ラベルを読めなくても awaiting-merge（完成）の終了値は変わらず、from_phase だけ付かない" \
	'[ "$rc" = 0 ] && ! grep -q -- "--from_phase" "$R/log" && grep -q -- "--phase awaiting-merge" "$R/log"'
phase_run "harness:awaiting-merge" 7 awaiting-merge --pr 5 --adopt-pending A-3; rc=$?
check "phase-refresh: --adopt-pending も from_phase と transition_id を付ける（同 phase の再通知は engine が見分ける）" \
	'[ "$rc" = 0 ] && grep -q -- "--from_phase awaiting-merge" "$R/log" && grep -qE -- "$UUID_RE" "$R/log"'
STUB_LABELS_FAIL=1 phase_run "harness:awaiting-merge" 7 awaiting-merge --pr 5 --adopt-pending A-3; rc=$?
check "phase-refresh: --adopt-pending のラベル読取失敗でも終了値は変わらない" '[ "$rc" = 0 ] && ! grep -q -- "--from_phase" "$R/log"'
for ph in interview blocked; do
	phase_run "harness:designing" 7 "$ph" --comment hi; rc=$?
	check "phase-refresh: $ph は通常経路で from_phase=designing を付ける" '[ "$rc" = 0 ] && grep -q -- "--phase $ph" "$R/log" && grep -q -- "--from_phase designing" "$R/log"'
done
phase_run "harness:awaiting-merge,harness:merge-ok" 7 done; rc=$?
check "phase-refresh: done は merge-ok を無視して from_phase=awaiting-merge" '[ "$rc" = 0 ] && grep -q -- "--phase done" "$R/log" && grep -q -- "--from_phase awaiting-merge" "$R/log"'
