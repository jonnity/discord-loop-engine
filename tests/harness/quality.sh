#!/usr/bin/env bash
# preflight・動画・通知の回帰試験。run.sh の隔離環境と集計を使う。
Q="$TMP/quality"
mkdir -p "$Q/.claude" "$Q/tmp"
qconfig() { printf '%s\n' "$1" > "$Q/.claude/harness.json"; }
qgate() { CLAUDE_PROJECT_DIR="$Q" "$BIN/harness-gate" "$Q" >"$Q/out" 2>&1; }
for pre in 'null' '[]'; do
	qconfig "{\"preflight\":$pre,\"gate\":[{\"name\":\"first\",\"run\":\"echo gate >> log; false\"},{\"name\":\"second\",\"run\":\"echo second >> log\"}],\"hooks\":{\"beforePR\":[\"echo hook >> log\"]}}"
	rm -f "$Q/log"; qgate; rc=$?
	check "preflight: $pre は既存の全件実行を維持" '[ "$rc" = 1 ] && [ "$(cat "$Q/log")" = "$(printf "gate\nsecond\nhook")" ]'
done
qconfig '{"preflight":[{"name":"env","run":"echo pre >> log"}],"gate":[{"name":"ok","run":"echo gate >> log"}],"hooks":{"beforePR":["echo hook >> log"]}}'
rm -f "$Q/log"; qgate; rc=$?
check 'preflight: 指定 cwd で環境→gate→hook' '[ "$rc" = 0 ] && [ "$(cat "$Q/log")" = "$(printf "pre\ngate\nhook")" ]'
qconfig '{"preflight":[{"name":"offline","run":"echo pre >> log; false"},{"name":"never","run":"echo never >> log"}],"gate":[{"name":"ok","run":"echo gate >> log"}],"hooks":{"beforePR":["echo hook >> log"]}}'
rm -f "$Q/log"; qgate; rc=$?
check 'preflight: 最初の失敗で終了3、後続を実行しない' '[ "$rc" = 3 ] && [ "$(cat "$Q/log")" = pre ]'
for bad in '{}' '[{"name":" ","run":"true"}]' '[{"name":"x","run":""}]' '[null]' '[{"name":1,"run":"true"}]'; do
	qconfig "{\"preflight\":$bad,\"gate\":[{\"name\":\"ok\",\"run\":\"true\"}]}"
	qgate; rc=$?
	check "preflight: 不正形 $bad は終了2" '[ "$rc" = 2 ] && grep -q "preflight の設定が不正です" "$Q/out"'
done
rm "$Q/.claude/harness.json"
qgate; rc=$?
check 'gate: 設定ファイルなしは終了2で従来の案内' '[ "$rc" = 2 ] && grep -qx "harness-gate: harness.json に gate が定義されていません" "$Q/out"'
qconfig broken
qgate; rc=$?
check 'gate: 不正JSONは終了2で従来の案内' '[ "$rc" = 2 ] && grep -qx "harness-gate: harness.json に gate が定義されていません" "$Q/out"'
for g in true false '"x"' '{}' 1; do
	qconfig "{\"preflight\":[{\"name\":\"env\",\"run\":\"echo pre >> log\"}],\"gate\":$g}"
	rm -f "$Q/log"
	qgate; rc=$?
	check "gate: gate が $g は終了2で素通りしない" '[ "$rc" = 2 ] && grep -qx "harness-gate: harness.json に gate が定義されていません" "$Q/out" && [ ! -e "$Q/log" ]'
done
for top in null '[]' '"x"'; do
	qconfig "$top"
	qgate; rc=$?
	check "gate: トップレベル $top は従来の案内で終了2" '[ "$rc" = 2 ] && grep -qx "harness-gate: harness.json に gate が定義されていません" "$Q/out"'
done

(
	export PATH="$ROOT/tests/harness/fixtures/media:$ROOT/tests/harness/fixtures:$PATH"
	export CLAUDE_PROJECT_DIR="$Q" PHASE_STUB=1
	export MEDIA_LOG="$Q/media.log" CURL_ARGS="$Q/curl.args" SENT_FILE="$Q/sent" SENT_COPY="$Q/copy" POST_BODY="$Q/body" MEDIA_PID="$Q/pid" TMPDIR="$Q/tmp"
	export DISCORD_WEBHOOK_URL=https://example.test/webhook
	qconfig '{"project":"test","repo":"example/project","notify":{"required":false,"maxAttachMB":1}}'
	input="$Q/動画 'test'.MP4"; echo source > "$input"
	phase() { "$BIN/harness-phase" 3 awaiting-merge --pr 5 --comment "${COMMENT_TEST:-説明}" --file "$input" "$@" >"$Q/out" 2>&1; }
	reset_media() { : > "$MEDIA_LOG"; rm -f "$SENT_FILE" "$MEDIA_PID"; }
	reset_media; phase; rc=$?
	check 'video: 適合MP4は変換せず probe→comment→notify→label' '[ "$rc" = 0 ] && [ "$(cat "$MEDIA_LOG")" = "$(printf "probe\ncomment\nnotify\nlabel")" ] && [ "$(cat "$SENT_FILE")" = "$input" ]'
	for mode in webm hevc mov pix brand format; do
		reset_media; MEDIA_MODE="$mode" phase; rc=$?
		check "video: $mode は変換・再検査して添付" '[ "$rc" = 0 ] && [ "$(cat "$MEDIA_LOG")" = "$(printf "probe\nconvert\nprobe\ncomment\nnotify\nlabel")" ] && [ "$(cat "$SENT_COPY")" = converted ] && [ ! -e "$(cat "$SENT_FILE")" ] && [ "$(cat "$input")" = source ]'
	done
	saved="$input"; input="$Q/actually.mov"; echo source > "$input"
	reset_media; phase; rc=$?
	check 'video: MP4形式でも拡張子がMOVなら変換' '[ "$rc" = 0 ] && grep -q convert "$MEDIA_LOG"'
	input="$saved"
	reset_media
	"$BIN/harness-phase" 3 awaiting-merge --pr 5 --comment 説明 >"$Q/out" 2>&1; rc=$?
	check 'video: fileなしの承認は検査しない' '[ "$rc" = 0 ] && ! grep -Eq "probe|convert" "$MEDIA_LOG"'
	reset_media
	"$BIN/harness-phase" 3 blocked --comment 説明 --file "$input" >"$Q/out" 2>&1; rc=$?
	check 'video: 他フェーズは動画として扱わない' '[ "$rc" = 0 ] && ! grep -Eq "probe|convert" "$MEDIA_LOG"'
	for mode in fail json none zero; do
		reset_media; PROBE_MODE="$mode" phase; rc=$?
		check "video: probe $mode で終了6、副作用なし" '[ "$rc" = 6 ] && ! grep -Eq "comment|notify|label" "$MEDIA_LOG"'
	done
	reset_media; PROBE_MODE=vanish phase; rc=$?
	check 'video: 検査中に消えた最終ファイルも終了6' '[ "$rc" = 6 ] && ! grep -Eq "comment|notify|label" "$MEDIA_LOG"'
	echo source > "$input"
	for mode in fail empty invalid; do
		reset_media; MEDIA_MODE=webm CONVERT_MODE="$mode" phase; rc=$?
		check "video: 変換 $mode で終了6、副作用なし" '[ "$rc" = 6 ] && ! grep -Eq "comment|notify|label" "$MEDIA_LOG" && [ -z "$(ls -A "$Q/tmp")" ]'
	done
	for kind in missing empty directory; do
		saved="$input"; input="$Q/$kind"
		[ "$kind" = empty ] && : > "$input"
		[ "$kind" = directory ] && mkdir -p "$input"
		reset_media; phase; rc=$?
		check "video: $kind で終了6、副作用なし" '[ "$rc" = 6 ] && [ ! -s "$MEDIA_LOG" ]'
		input="$saved"
	done
	for summary in default explicit; do
		reset_media
		long="a$(printf 'あ%.0s' {1..4000})"
		if [ "$summary" = default ]; then COMMENT_TEST="$long" phase; else phase --summary "$long"; fi
		rc=$?
		description="$(sed -n 's/^payload_json=//p' "$CURL_ARGS" | jq -r '.embeds[0].description')"
		summary_chars="$(sed -n 's/^payload_json=//p' "$CURL_ARGS" | jq '.embeds[0].description | split("\n\n動画:")[0] | length')"
		check "video: $summary の長い日本語要約も位置と名前を保持" '[ "$rc" = 0 ] && [[ "$description" = *最後の投稿* && "$description" = *test* && "$description" != *�* ]] && { [ "$summary" != default ] || [ "$summary_chars" = 300 ]; } && grep -q "sha=abc123456789" "$POST_BODY"'
	done
	jq -nr '"あ" * 50000' > "$Q/long-comment.md"
	expected_summary="$(printf 'あ%.0s' {1..300})"
	for human_phase in interview blocked awaiting-merge; do
		reset_media
		phase_args=()
		[ "$human_phase" != awaiting-merge ] || phase_args=(--pr 5 --file "$input")
		"$BIN/harness-phase" 3 "$human_phase" --comment-file "$Q/long-comment.md" "${phase_args[@]}" >"$Q/out" 2>&1; rc=$?
		summary_text="$(sed -n 's/^payload_json=//p' "$CURL_ARGS" | jq -r '.embeds[0].description | split("\n\n動画:")[0]')"
		check "phase: $human_phase は5万字のコメントから文字単位で300文字を要約して遷移" '[ "$rc" = 0 ] && [ "$summary_text" = "$expected_summary" ] && grep -qx label "$MEDIA_LOG" && [ "$(head -n 1 "$POST_BODY" | wc -m)" = 50001 ]'
	done
	reset_media; CURL_FAIL=1 phase; rc=$?
	check 'video: HTTP失敗は終了4、ラベル未変更' '[ "$rc" = 4 ] && ! grep -q label "$MEDIA_LOG"'
	for max in 0 -1 bad; do
		qconfig "{\"project\":\"test\",\"repo\":\"example/project\",\"notify\":{\"maxAttachMB\":\"$max\"}}"
		reset_media; phase; rc=$?
		check "video: 上限不正 $max は終了6" '[ "$rc" = 6 ] && ! grep -Eq "comment|notify|label" "$MEDIA_LOG"'
	done
	qconfig '{"project":"test","repo":"example/project","notify":{"required":false,"maxAttachMB":1}}'
	dd if=/dev/zero of="$input" bs=1048577 count=1 status=none
	reset_media; phase; rc=$?
	check 'video: 最終サイズ超過は終了6' '[ "$rc" = 6 ] && ! grep -Eq "comment|notify|label" "$MEDIA_LOG"'
	notify() { "$BIN/harness-notify" --event merge-request --title test --url https://example.test --file "$input" >"$Q/out" 2>&1; }
	notify; rc=$?
	check 'notify: 明示添付の超過は終了4' '[ "$rc" = 4 ]'
	echo source > "$input"
	DISCORD_WEBHOOK_URL='' notify; rc=$?
	check 'notify: required=false でも承認動画をskipしない' '[ "$rc" = 3 ]'
	rm "$input"; notify; rc=$?
	check 'notify: 明示添付の欠落は終了4' '[ "$rc" = 4 ]'
	echo source > "$input"
	for attempt in 1 2 3; do
		reset_media; MEDIA_MODE=webm phase; rc=$?
		check "video: 初期状態から変換→送信の連続成功 $attempt/3" '[ "$rc" = 0 ] && [ "$(cat "$SENT_COPY")" = converted ] && [ -z "$(ls -A "$Q/tmp")" ]'
	done
	echo "$pass $fail" > "$Q/counts"
)
read -r pass fail < "$Q/counts"

# onboard の正本のコマンドを、そのまま gh スタブに対して実行する。
runner_command="$(sed -n '/^# RUNNER_CHECK_BEGIN$/,/^# RUNNER_CHECK_END$/p' "$ROOT/skills/onboard/SKILL.md")"
export RUNNER_API=repos/example/project/actions/runners REQUIRED_LABELS='["self-hosted","linux"]' MIN_ONLINE=2
export RUNNER_STUB=1 RUNNER_PAGES="$Q/runners.json"
cat > "$RUNNER_PAGES" <<'JSON'
{"runners":[{"status":"online","busy":true,"labels":[{"name":"self-hosted"},{"name":"linux"}]},{"status":"online","busy":false,"labels":[{"name":"linux"}]}]}
{"runners":[{"status":"online","busy":false,"labels":[{"name":"self-hosted"},{"name":"linux"}]},{"status":"offline","busy":false,"labels":[{"name":"self-hosted"},{"name":"linux"}]}]}
JSON
runner_check() { PATH="$ROOT/tests/harness/fixtures:$PATH" bash -c "$runner_command" > "$Q/runner-out" 2>&1; }
runner_check; rc=$?
check 'runner: 全ラベル一致と複数ページ、busyもonlineに含めidleと区別' '[ -n "$runner_command" ] && [ "$rc" = 0 ] && grep -q "online=2 idle=1" "$Q/runner-out"'
echo '{"runners":[]}' > "$RUNNER_PAGES"
runner_check; rc=$?
check 'runner: 0台は終了1' '[ "$rc" = 1 ] && grep -q "online=0" "$Q/runner-out"'
RUNNER_FAIL=1 runner_check; rc=$?
check 'runner: APIエラーは台数0と区別して終了2' '[ "$rc" = 2 ] && ! grep -q "online=0" "$Q/runner-out"'
unset RUNNER_STUB RUNNER_API REQUIRED_LABELS MIN_ONLINE RUNNER_PAGES
