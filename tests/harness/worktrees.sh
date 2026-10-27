#!/usr/bin/env bash
# W3/W8: 実入口を隔離した一時 repo と tmux/curl スタブで実行する。
W="$TMP/worktrees"
mkdir -p "$W/main/.claude" "$W/home"
(
	export CLAUDE_PROJECT_DIR="$W/main" DLE_HOME="$W/home" DLE_SOCKET="$W/home/engine.sock" DLE_PROJECT=registered
	export PATH="$ROOT/tests/harness/fixtures:$PATH" TMUX_STUB_LOG="$W/tmux.log" TMUX_STUB_PANES="$W/panes"
	for value in null '".worktrees"' "\"$W/absolute space\""; do
		printf '{"worktreeRoot":%s,"repo":"example/test"}\n' "$value" > "$W/main/.claude/harness.json"
		wroot="$("$BIN/harness-config" --worktree-root)"
		case "$value" in null) expected="$W/home-worktrees/registered" ;; '".worktrees"') expected="$W/main/.worktrees" ;; *) expected="$W/absolute space" ;; esac
		check "W3: root $value の全文" '[ "$wroot" = "$expected" ]'
		for state in running exited:0 exited:1 exited:unknown none; do
			wt="$wroot/issue-9"; mkdir -p "$wt/.harness"
			echo @9 > "$wt/.harness/codex-impl-9.id"
			rm -f "$wt/.harness/codex-impl-9.exit"
			case "$state" in
				running) echo '@9 codex-impl-9 0' > "$W/panes" ;;
				exited:unknown) echo '@9 codex-impl-9 1' > "$W/panes" ;;
				none) echo '@10 codex-impl-9 0' > "$W/panes" ;;
				*) echo '@9 codex-impl-9 1' > "$W/panes"; echo "EXIT=${state#*:}" > "$wt/.harness/codex-impl-9.exit" ;;
			esac
			actual="$("$BIN/harness-codex-status" status codex-impl-9)"
			output="$("$BIN/harness-status")"
			check "W3: $value status=$state を実入口で共有" '[ "$actual" = "$state" ] && grep -q "codex-impl-9: $state" <<< "$output"'
		done
		: > "$W/tmux.log"; echo '@9 codex-impl-9 1' > "$W/panes"
		"$BIN/harness-codex" stop codex-impl-9 "$wt"
		check 'W3: stop は保存idでkill' 'grep -qx "kill-window -t @9" "$W/tmux.log"'
	done
	printf '{"worktreeRoot":false}' > "$W/main/.claude/harness.json"
				"$BIN/harness-status" > "$W/invalid-out" 2> "$W/invalid-err"; rc=$?
				check 'W3: 解決失敗では旧配置を走査しない' '[ "$rc" != 0 ] && [ ! -s "$W/invalid-out" ] && grep -q "worktreeRoot.*文字列" "$W/invalid-err"'
				"$BIN/harness-codex-status" status codex-impl-9 > "$W/invalid-out" 2> "$W/invalid-err"; rc=$?
				check 'W3: 省略WTの解決失敗はnoneへフォールバックしない' '[ "$rc" != 0 ] && [ ! -s "$W/invalid-out" ]'
				echo "$pass $fail" > "$W/counts"
)
read -r pass fail < "$W/counts"

(
	unset CLAUDE_PROJECT_DIR HARNESS_CONFIG DISCORD_WEBHOOK_URL
	export DLE_HOME="$W/home" DLE_SOCKET="$W/home/engine.sock" DLE_PROJECT=registered
	main="$W/main"; wt="$W/linked"
	git -C "$main" init -q
	git -C "$main" -c user.name=Test -c user.email=test@example.test commit -q --allow-empty -m init
	git -C "$main" worktree add -q "$wt" -b linked
	mkdir -p "$wt/.claude" "$W/stubs"
	printf '{"gate":[{"name":"main","run":"echo main; pwd"}]}' > "$main/.claude/harness.json"
	printf '{"gate":[{"name":"wt","run":"echo wt; pwd"}]}' > "$wt/.claude/harness.json"
	echo 'DISCORD_WEBHOOK_URL=https://example.test/main-fake' > "$main/.env"
	echo 'DISCORD_WEBHOOK_URL=https://example.test/wt-fake' > "$wt/.env"
	cat > "$W/stubs/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$CURL_LOG"
echo 204
CURL
	chmod +x "$W/stubs/curl"
	export PATH="$W/stubs:$PATH" CURL_LOG="$W/curl.log"
	cd "$wt" || exit 1
	actual_root="$("$BIN/harness-config" --root)"; actual_path="$("$BIN/harness-config" --path)"
	check 'W8: linked WT内からroot/pathはmain' '[ "$actual_root" = "$main" ] && [ "$actual_path" = "$main/.claude/harness.json" ]'
	gate_output="$("$BIN/harness-gate" 2> "$W/gate.err")"; rc=$?
	check 'W8: gate定義はmain、cwdはWT' '[ "$rc" = 0 ] && [ "$gate_output" = "$(printf "main\n%s" "$wt")" ]'
	"$BIN/harness-notify" --event info --project registered --repo example/test --title test --url https://example.test > "$W/notify.out" 2>&1; rc=$?
	check 'W8: 実notifyはmainの偽webhookを使う' '[ "$rc" = 0 ] && grep -qx "https://example.test/main-fake?wait=true" "$CURL_LOG" && ! grep -q wt-fake "$CURL_LOG"'
	gate_output="$(HARNESS_CONFIG="$wt/.claude/harness.json" "$BIN/harness-gate" 2> "$W/gate.err")"; rc=$?
	check 'W8: 絶対HARNESS_CONFIGでWTの定義を検証可能' '[ "$rc" = 0 ] && [ "$gate_output" = "$(printf "wt\n%s" "$wt")" ]'
	for project_dir in '' "$main"; do
		actual_root="$(CLAUDE_PROJECT_DIR="$project_dir" "$BIN/harness-config" --root)"
		actual_wt="$(CLAUDE_PROJECT_DIR="$project_dir" "$BIN/harness-config" --worktree 9)"
		check 'W4/W8: CLAUDE_PROJECT_DIR有無でmain/WTが一致' '[ "$actual_root" = "$main" ] && [ "$actual_wt" = "$W/home-worktrees/registered/issue-9" ]'
	done
	echo "$pass $fail" > "$W/counts"
)
read -r pass fail < "$W/counts"
