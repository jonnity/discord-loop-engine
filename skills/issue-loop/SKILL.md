---
name: issue-loop
description: issue-cycle を心拍（CronCreate）で繰り返し呼び出す上位のループ制御スキル。harness:queued の Issue からのキュー自動補充、CI red の仕分けと Codex への差し戻し、Codex ウィンドウのシェパード、人間からの返信の取り込みを担う。マージ承認は自動化しない。
---

# issue-loop

`issue-cycle` を道具として繰り返し呼ぶ、ハーネスの一つ上の階層。oogiri-doc の `parallel-cycle-loop` を
プロジェクト非依存にしたもの。`issue-cycle` の手順・禁止事項はすべてそのまま適用される。

このスキルが自律化するのは次の3つだけ:

1. **次に何を着手するか**（キュー補充）
2. **CI が落ちたら直す**（仕分け → Codex へ差し戻し）
3. **Codex が止まっていたら面倒を見る**（承認プロンプト・未送信・usage limit）

> ⚠️ **緩めない安全ゲート**
> - Phase 1 の質問は必ず作る（推定で進める場合も、質問と推定回答を Issue に残し通知する）
> - **マージ承認は自動化しない**。`harness-merge` は人間の承認記録なしには通らない
> - 人間ゲートへの遷移は必ず `harness-phase`（GitHub コメント＋Discord 通知＋ラベルが不可分）

## 前提

- `issue-cycle` の前提（tmux・gh。codex は無くても `harness-implementer` で進む。`.claude/harness.json`、`harness-labels` 済み）
- `CronCreate` / `CronList` / `CronDelete` が使えること。使えない環境では手動で `/discord-loop-engine:issue-loop`
  を繰り返す運用に落とす
- 人の判断が要る通知を出せること。discord-loop-engine の engine が動いていれば engine 経由で出る。
  engine を使わず単体で回すときは、`DISCORD_WEBHOOK_URL` を環境変数か設定の `notify.envFiles` に置く
  （どちらも無いと `harness-notify` は失敗する）

## 起動時

1. **状態把握**: `issue-cycle` の Step 0（`harness-status` / `harness-inbox`）
2. **心拍**: `CronList` にこのループの心拍が無ければ張る。プロンプトは**スキル呼び出し単体**に固定し、
   複合プロンプト（`/clear` を混ぜる等）にしない（oogiri-doc で心拍が無言で空振りし続けた事故がある）:
   ```
   CronCreate({ cron: "*/15 * * * *", prompt: "/discord-loop-engine:issue-loop", recurring: true, durable: true })
   ```
   心拍は Claude のセッションに紐づき、セッションが終わると消える。7日で失効もする。毎 tick
   `CronList` で生存を確かめ、無ければ張り直す。セッションが落ちたら人間が再実行する前提
   （状態は GitHub にあるので、どこから再開しても続きになる）。
3. **PR の購読**（`subscribe_pr_activity` がある環境のみ）: `awaiting-merge` / `impl-review` で PR が
   ある Issue を購読する。購読済みは `.harness/handoff.md` の `subscribed_prs` に記録して重複させない。

## 毎 tick の処理

### 0. heartbeat の記録

```bash
ROOT=$(harness-config --root); mkdir -p "$ROOT/.harness"
printf 'last_tick_at=%s\nheartbeat_interval=%s\n' "$(date -u +%FT%TZ)" "${INTERVAL:-15min}" \
  > "$ROOT/.harness/loop-heartbeat.tmp" && mv "$ROOT/.harness/loop-heartbeat.tmp" "$ROOT/.harness/loop-heartbeat"
```

`harness-status` はこれを見て「待機中」と「止まっている」を区別する。

### 1. Codex のシェパード（サブエージェントに丸ごと任せる）

まず無料のチェックだけを本体で行う: **このプロジェクトの worktree** にある id ファイル
（解決済み worktreeRoot の `issue-*/.harness/codex-*.id`。`harness-codex start` が保存）のウィンドウごとに
`harness-codex-status status <window> "$WT"` を呼ぶ。`tmux list-windows -a | grep` のような名前での検索はしない
（別プロジェクトの同名ウィンドウを拾い、終了済みのウィンドウ（`remain-on-exit` で残る）も区別できず、
サブエージェントを毎 tick 起こしてしまう）。

実際の走査は以下。id の所在から WT を得るので、外部・相対・絶対・空白入りの配置でも同じ場所を監視し、片付ける。解決失敗では走査を始めない。

```bash
# CODEX_SCAN_BEGIN
ROOT="$(harness-config --root)" || exit 1
WROOT="$(harness-config --worktree-root)" || exit 1
running_windows=()
for idf in "$WROOT"/issue-*/.harness/codex-*.id; do
  [ -f "$idf" ] || continue
  WT="$(dirname "$(dirname "$idf")")"
  window="$(basename "$idf" .id)"
  state="$(harness-codex-status status "$window" "$WT")" || exit 1
  n="${window##*-}"
  phase="${window#codex-}"; phase="${phase%-*}"
  case "$state" in
  running) running_windows+=("$idf") ;;
  exited:0)
    if [ -f "$WT/.harness/$phase/$n.md" ]; then
      harness-codex stop "$window" "$WT" || exit 1
    fi
    ;;
  esac
 done
# CODEX_SCAN_END
```

- **`running` が無ければこの節のサブエージェントは起動しない**
- `exited:*` はサブエージェントを起こさず、成果物の有無で分ける:
  - `exited:0` で成果物あり（spec なら `.harness/spec/{n}.md`、impl なら `.harness/impl/{n}.md`）→ 正常終了。
    再起動せず `harness-codex stop <window> <worktree>` で片付けるだけ（`.id`・`.exit` も消えるので次の tick から拾わない）
  - 成果物なし、または非 0 → `issue-cycle` の「Codex の監視と再起動」の判定
    （認証切れ・usage limit → フォールバック、それ以外 → 共通起動手順の準備で `harness-codex stop`、別 Bash の `harness-codex start` で再起動）

再依頼も issue-cycle の共通起動手順（準備・単独の Bash 起動・別 Bash の監視）へ従う。
起動の権限拒否・`reason=launch-failed`・拒否/利用不可の判別不能は、代行せず blocked と人向け起動1行へ進む。
blocked 中は tick で再試行・代行しない。通知も繰り返さず人の回答を待ち、login check の成功だけで解除しない。
exit 10 一律で切り替えず、`reason=not-installed` / `not-logged-in` と確認済みの認証切れ・usage limit だけ既存の代行へ進む。

`running` のウィンドウがあれば `model: "haiku"` のサブエージェント1体に、全ウィンドウの監視を最大3分任せる:

```
tmux ウィンドウ {codex-impl-12 の window-id, ...} を最大3分監視し、結論だけを1ウィンドウ1行で返してください。
`tmux capture-pane -t {window-id} -p | tail -5`（window-id は `.id` ファイルの値） を繰り返し見て:
- y/n の承認待ち: 対象 worktree 内の編集・テスト・lint・型チェック・診断なら Enter で承認して続行。
  main への push、force push、worktree 外の削除（rm -rf 等）、git add -f は承認せず内容を報告。
- usage/rate limit: 承認せず、復帰予定時刻をそのまま報告。
- 入力欄に指示が残ったまま未送信: Enter だけ送る。
- 動作中: 何もしない。
生ログやコマンド全文は返さないこと。
```

- 本体は報告（数行）だけを受け取る。危険な操作の判断は本体（必要なら人間）が行う
- usage limit は**待たずに** `issue-cycle` の「フォールバック」へ入る（info で一度知らせ、`harness-implementer` に
  続きを渡す。Codex が制限で止まっているなら Claude 側に余裕がある、という判断）。
  `loop_meta.codex_limit_until` は新しくは書かない（古い handoff にあれば読むだけ）
- 「動作中・変化なし」が 2〜3 tick 続いたら stall とみなし、`issue-cycle` の「Codex の監視と再起動」へ

### 2. 人間からの返事を取り込む

`harness-inbox` の終了値と全 JSONL を確認し、非0なら部分出力を採用せず head 変更も止める。
`issue-cycle` Step 0 と「承認回収の仕分けと共通通知」（CHAT_REJECTION_BEGIN〜CHAT_REJECTION_END）を使う。
`chat-merge-ok` は対象 WT を解決し、body と attention を引数のまま渡して同じ tick の Phase 6 で harness-merge を試す。
GitHub NG を優先し、ready な GitHub OK より台帳の非 OK 回答（resolvedAt）が新しければ `chat-not-approved` として共通通知へ回す。それ以外の `merge-ok` は台帳系より優先。open A は回答待ちで通知/再依頼しない。
`chat-not-approved` は A・reason ごとに1回だけ共通通知。失敗した tick 中に具体的な待ち理由を Issue に残す。
`missing-attention` は正常な台帳と attentionSeq で実不在を確認したものだけ、同じ WT で Phase 5-4 の正式な新 A を発行する。
`attention-unavailable`（sequence 超過を含む）/`attention-mismatch` は再読取りして home/設定/権限等を確認し、
自動解消できなければ `harness-phase {n} blocked --comment-file ...` で通知する。自動再依頼はしない。
`stale-notify` / `missing-notify` は再依頼の前に pending と復旧状態を仕分ける。自分の失敗した依頼の pending は Phase 5-4 に従い、原因を直せたときだけ再実行し、直せなければ blocked にする。
Phase 5-4 はフォアグラウンドなので実行中の tick 処理はない。対象 phase の終了値 `0 / nonzero / unknown` を共通例へ明示引数で渡す。
終了前に届いた OK も終了0・同じ A/head の完成marker・復旧ファイル消失後に処理し、info 0回・merge 1回とする。
pending＋復旧ファイルなしは request-failed。pending＋復旧ファイルありは非0終了で request-failed、終了0または不明なら recovery-unconfirmed。
完成 marker＋復旧ファイル＋対象 phase の終了値なしも Phase 5-4 の失敗仕分けへ送り、自動解消できなければ blocked。
復旧ファイルは cwd と WT の両方で symlink も存在とする。プロセス台帳を作らず、別 Issue の終了値や単に記録がないことを実行中の証拠にしない。
原因が続いたまま tick ごとに仮コメント・Discord 投稿・A-番号を増やさない。旧 OK の付け替えは禁止。
通知には PR に GitHub で『OK』とコメントするか、窓口に『#n の承認依頼を出し直して』と頼む、の出口を必ず含める。
理由の正本は Issue。通知のURLは現在の依頼先PRコメントURLを使い、現在のA や marker 全文は表示しない。認証済み login 自身の claimed/posted/failed-or-unknown を照合し、他者の同じキーでは抑制しない。
通知/記録未確認なら自動再送せず handoff に残して停止する。

### 2a. Dependabot PR（Issue なし）

起動・復帰時と各 tick で、Issue のフェーズ進行・キュー補充の前に `harness-pr inbox` を実行する。
全 JSONL と終了値を確認し、非0の部分出力は採用しない。`merge-ok` は `harness-merge --pr N`、
`merge-wait` / `cleanup-pending` も同じ入口で結果確認・後始末を再開する。PR 本文は scan/inbox に含まれない。
`incomplete` は自動 retry せず復旧確認、`merge-ng` は人へ返す。NG をコード修正タスクへ自動変換しない。

main に `.github/dependabot.yml` が存在するか、読み取り専用の全ページ PR 一覧に
作成者 `dependabot[bot]` かつ head `dependabot/*` の open PR がある harness プロジェクトだけを監視する。
`harness-pr scan` を毎 tick 実行し、一覧の読取り失敗は「対象なし」とせず次 tick で再確認する。
CI green の未依頼/新 head は `harness-pr request --pr N` へ進める。behind/dirty は request に rebase を任せる。
request 自身が古い順（created_at→PR 番号）とプロジェクトごとに同時1件を排他下で再検査する。
rebase を頼むのは枠に入る最も古い候補と OK 後のマージ段階だけ。rebase 待ちも枠に数える。
Dependabot PR は Issue の maxParallel 枠外。pending・未完了・OK 後・キュー待ちも PR の枠を保持する。
非 OK/owner NG、120分 head 不変の rebase 期限切れ、auto-merge 有効/Approve 後の停止/保護不足は
info 後に枠を解放する。同じ head の停止中は自動再依頼/マージしない。owner NG/非 OK 後は新 head でも自動再依頼しない。

`--retry` は meta.from=concierge の人の「PR #N の承認依頼を出し直して」と原因解消を確認した場合だけ、
`harness-pr request --pr N --retry` とする。指定の PR にしか発行せず、枠使用中/より古い候補などで
非0なら理由を窓口へ返し「枠が空いてから再依頼してください」と伝える。tick では付けない。
新しい A に旧 OK/NG を付け替えない。PR の GitHub OK/Approve/merge-ok ラベルは人の A の OK の代用にならない。
Approve と auto-merge の操作は `harness-merge --pr` の中だけで行う。worker が直接 Approve したり、auto-merge を有効にしたりしない。

### 3. フェーズ進行

`issue-cycle` の Phase 1〜6 を、アクティブな各 Issue について1段階ずつ進める。
PR を作ったら購読する（購読できる環境なら）。

### 4. キュー補充

アクティブ（`interview`〜`awaiting-merge`、`blocked` は数えない）が `maxParallel` 未満なら補充する:

```bash
gh issue list --state open --label harness:queued --json number,title,labels,createdAt \
  -q 'sort_by((if any(.labels[]; .name=="harness:priority") then 0 else 1 end), .createdAt) | .[] | "\(.number)\t\(.title)"'
```

- 上から空き枠の数だけ選び、`issue-cycle` Phase 1 から始める（**選定前に人間の承認は取らない**。
  `harness-phase {n} interview` の通知が「着手した」ことの通知を兼ねる）
- キューは「`harness:queued` が付いた open Issue」だけ。ラベルの無い Issue を推測で拾わない
- 候補が無ければ枠を空けたまま終える

### 4'. 非ブロッキング進行（一般ルールから答えが一意に決まる質問だけ）

Phase 1 の質問の答えが **CLAUDE.md に明記された規約**から一意に導ける場合に限り、回答を待たずに進めてよい。

- 質問は省略しない。Issue コメントに「質問 → 推定回答（根拠: CLAUDE.md の節名）／異なる場合は
  コメントしてください。この内容で進めます」と書き、`harness-notify --event info` で知らせて
  `harness-phase {n} designing` へ進む（interview ラベルは付けない）
- 根拠は「直近の別 Issue でそう答えていた」では足りない。繰り返し同じ答えが出ているなら、先に
  CLAUDE.md への追記をユーザーに提案する
- 製品仕様・UX・セキュリティ・データ整合性に関わる新しい判断を含むなら、必ずブロッキングで待つ
- 迷ったら待つ

### 5. CI red への対応

PR の CI が失敗したら（購読イベント、または tick ごとの `gh pr checks <PR>`）:

**head を変える前に再確認する**。awaiting-merge は inbox を再読取りし、未処理 OK をまず現 head の harness-merge に渡す。CI 待ちだけなら head/A を保持する。衝突や CI red の修正が必要なら、その head で進めない理由を Issue に残してから変更し、修正後は Phase 5-4 の新依頼・新回答を待つ。

1. **仕分ける**。profile に `hooks.onCIRed` があれば `harness-hook onCIRed --issue {n} --pr <PR>` を実行する
   （例: oogiri-doc の `pnpm ci:triage` → INFRA なら `gh run rerun`）。
   - 終了コード 0 → コード起因ではなく対処済み（再実行した等）。このフェーズでは何もせず、次の CI の結果を待つ
   - 0 以外 → `REAL` として 3 へ（出力を根本原因の手がかりとしてサブエージェントに渡す）

   差し込み口が無ければ、サブエージェントにログを読ませて `REAL`（コード起因）/ `INFRA`（ランナー・ネットワーク・
   チェックアウト等、テスト本体が走る前に死んだ）/ `STALE`（新しい run に追い越された）に分けさせる
2. `INFRA` → `gh run rerun <run-id>` を **1回だけ**。2回目も落ちたら REAL として扱う。
   **再トリガー目的の空コミットは積まない**（harness-guard が止める）
3. `REAL` → サブエージェントに「根本原因と、Codex に渡す修正指示を1段落で」まとめさせ、
   `learning_add`（tag: `ci-red`。engine が無ければ `.harness/failure-log.jsonl` に1行）で記録してから `codex-impl-{n}` に再依頼する
   （Claude はコードを直さない。再依頼も共通起動手順で起動を単独の Bash に分け、拒否されたら直ちに blocked）。直ったら `harness-gate` の終了値を `gate_rc=0; harness-gate || gate_rc=$?` で保持する。
   0なら push、1ならコード検査失敗として差し戻し、2なら設定を修正する。
   3なら環境不備なので push を止め、Codex へ再差し戻しせず、この失敗は REAL の回数に加算しない。
   自動解消できなければ `harness-phase {n} blocked --comment-file ...` で項目名・失敗理由・必要な環境対応を依頼する。
   環境解消後に gate 全体を再実行して0を確認してから push する
4. **同じ PR で REAL が3回続いたら**自動リトライをやめ、
   `harness-phase {n} blocked --comment-file ...`（失敗しているチェック・試したこと・必要な判断）で人間に渡す
5. CI が green になったら Phase 5-4 の承認依頼へ（head が変わっているので必ず出し直す）

### 5'. engine との連携（discord-loop-engine の worker として動いているとき）

環境変数 `DLE_ROLE=worker` で起動されたセッションは、discord-loop-engine の worker。
**ユーザーとは直接話さない**（Discord に投稿するツールは持たない）。人とのやり取りは窓口と engine が受け持つ。

- **人の判断が要る通知は、これまでどおり `harness-phase` で出す**。engine が動いていれば
  `harness-notify` が自動で engine に渡し、engine が台帳に A-番号を付けて Bot から投稿する。
  フェーズの変化も `harness-phase` が台帳に報告する
- `<channel source="dle">` で届くもの:
  - `meta.attention`（A-番号への回答）:
    - `meta.kind=merge` で meta.issue が空かつ meta.pr が正整数なら PR 経路:
      `harness-merge --pr N --chat-approval "<本文>" --attention "{meta.attention}"` を使う。
      A は推測せず、非0なら PR inbox と待ち理由を窓口へ返す。Issue の NG 手順へ流さない。
    - `meta.kind=merge` で meta.issue が非空 → 明示の NG・修正指示なら Phase 6 NG（issue-cycle の ### NG）へ進む。
      それ以外は対象 WT で `harness-merge {meta.issue} --chat-approval "<本文>" --attention "{meta.attention}"` を試す即時経路を維持する。
      台帳の保存済み回答・最新完成marker・現 head・scope を再検証し、引数の引用だけでは承認しない。meta.attention 欠落は推測しない。
      非0なら stderr の構造化診断を issue-cycle の CHAT_REJECTION_BEGIN〜CHAT_REJECTION_END の共通手順へ渡す。
      pending/復旧は対象 phase の終了値で再分類し、同じ A・reason の通知は1回。CI/mergeable/hook は Issue の待ち理由だけを残す。
      先頭が OK でないだけの承認風の回答は共通通知へ回す。「非 OK だけを自動で NG と断定して実装を始めない」は tick の chat-not-approved に限る。現在の A や marker 全文は表示せず、拒否した OK の付け替えをしない。
      通知を再処理して merge は再実行しない。新 head/新依頼には新回答が必要。
      前置きの名前は Discord の表示名で owners（GitHub login）と完全一致のときだけ除く。表示名変更後の前置き付き回答は非 OK になり出口へ回る。
      承認できる人は allowedUserIds で決まり、owners 限定はそれを絞らない。
    - `meta.kind=interview` → 回答を Issue に「## 要件メモ（Discord で回答）」として
      `<!-- harness:note source=discord -->` 付きでコメントしてから Phase 2 へ（GitHub を正本に保つ。
      この印があるので `harness-inbox` は二重に拾わない）
    - `meta.kind=blocked` → 書かれた指示に従って再開する
  - `meta.from=concierge`（窓口からの依頼）: 優先順位の変更・特定 Issue の着手など。従う。窓口に『#n の承認依頼を出し直して』と頼む案内から届いた依頼なら、対象 Issue/PR/WT・依頼内容・現 head・humanChecks を確認し、Phase 5-4 の harness-phase で新 A を発行してその回答を待つ。既にマージ済みなら再依頼せず片付ける
  - `meta.kind=rules`（仮ルール）: 以後の作業で守る。起動時にも届く
- **うまくいかなかったことは `learning_add` で記録する**（CI 失敗・レビュー NG・人の NG・Codex が止まった・
  マージ後に見つかった漏れ）。自己改善の材料になる。`tag` は `ci-red` / `review-ng` / `user-ng` / `stall` /
  `scope-miss` など
- harness-phase を通らない節目（ブロッカーの解消・方針の変更など）は `report` で台帳に一言残す
- **設定（リポジトリの `.claude/harness.json` か engine 側の設定）が無いプロジェクトでは、
  最初に `/discord-loop-engine:onboard` を行う**（調べて案を出し、A-番号で確認をもらってから確定する。
  リポジトリには何も置かない）
- **onboard の前に起票された Issue**（設定が確定するまで harness:* ラベルが無く、窓口が `harness:queued` を付けられない）:
  窓口の依頼に「確定後に #N へ `harness:queued` を付けて」とあれば、`profile_activate` の後（ラベルは確定時に
  engine が作る）に `harness-phase {n} queued` で付ける。`profile_activate` が `warning`（ラベルを作れなかった）を
  返したら、付けずに窓口へ知らせる

### 6. 何も変化が無い tick

出力も通知もせずに終える。

## コンテキスト管理

コンテキストの `/clear` は engine が行う。cron による自己 clear・自己 resume は予約しない。
clear 後は「起動時」の状態把握からやり直し、`CronList` で心拍を確認して、無ければ張り直す。

1. **本体を薄く保つ（根本策）**: 本体で直接やるのは、ループ判断・`harness-*` コマンド・`handoff.md` の
   読み書き・cron 管理・Codex 起動・人間ゲートだけ。ソース調査・tmux ログ・CI ログ・diff・大きな `gh`
   出力はサブエージェントに読ませて結論だけ受け取る。`gh` は `--json`/`-q` で必要な項目に絞る
2. **人間待ちだけのときは心拍を緩める**: アクティブが全部 `interview` / `awaiting-merge` / `blocked` で、
   Codex も CI も動いていなければ、心拍を `*/60` に張り替える（2時間変化が無ければ `*/120`）。
   Codex・CI が動き出すか人間の返事でフェーズが進んだら `*/15` に戻す。
   ※ Issue コメントでの返事はセッションを起こさないので、緩めた分だけ取り込みが遅れる
   （PR の購読イベントは即時に起こす）。discord-loop-engine で起動したセッションなら、Discord での
   返信がその場でセッションを起こすので遅れない

## `.harness/handoff.md`（ローカル・gitignore・無くても動く）

```
## loop_meta
- heartbeat_interval: 15min
- codex_limit_until: none
## subscribed_prs
- #12: PR#34
## ci_retry_count
- #12: 1
## stall
- #12: codex-impl-12 working/no-change x2
```

フェーズや決定事項はここに書かない（GitHub が正）。このファイルは1件1行・現在値だけを保ち、
完了した Issue の行は消す。

## 終了条件

- Dependabot の監視対象なら、Issue キューが空でも心拍を60分、無変化2時間後120分で保持する。
  キュー完了通知は「Issue キュー完了・Dependabot PR の監視は継続」と1回だけ補足する。
  両方の監視条件が無くなれば PR 監視用心拍を削除する。読取り失敗では削除しない。
- キューが空で、アクティブも全部終わり、Dependabot の監視対象でもない → 心拍を `CronDelete` し、`harness-notify --event info` で
  「キュー完了」を1回だけ通知して終える
- ユーザーが止めるよう言った → 心拍・one-shot を全部消す
