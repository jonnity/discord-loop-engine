---
name: issue-loop
description: issue-cycle を心拍（CronCreate）で繰り返し呼び出す上位のループ制御スキル。harness:queued の Issue からのキュー自動補充、CI red の仕分けと Codex への差し戻し、Codex ウィンドウのシェパード、人間からの返信の取り込み、自己コンテキスト管理（clear/resume）を担う。マージ承認は自動化しない。
---

# issue-loop

`issue-cycle` を道具として繰り返し呼ぶ、ハーネスの一つ上の階層。oogiri-doc の `parallel-cycle-loop` を
プロジェクト非依存にしたもの。`issue-cycle` の手順・禁止事項はすべてそのまま適用される。

このスキルが自律化するのは次の4つだけ:

1. **次に何を着手するか**（キュー補充）
2. **CI が落ちたら直す**（仕分け → Codex へ差し戻し）
3. **Codex が止まっていたら面倒を見る**（承認プロンプト・未送信・usage limit）
4. **自分のコンテキストを薄く保つ**（サブエージェント委譲・clear/resume）

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
（`$(harness-config --root)/<worktreeRoot>/issue-*/.harness/codex-*.id`。`harness-codex start` が保存）のウィンドウごとに
`harness-codex-status status <window>` を呼ぶ。`tmux list-windows -a | grep` のような名前での検索はしない
（別プロジェクトの同名ウィンドウを拾い、終了済みのウィンドウ（`remain-on-exit` で残る）も区別できず、
サブエージェントを毎 tick 起こしてしまう）。

- **`running` が無ければこの節のサブエージェントは起動しない**
- `exited:*` はサブエージェントを起こさず、成果物の有無で分ける:
  - `exited:0` で成果物あり（spec なら `.harness/spec/{n}.md`、impl なら `.harness/impl/{n}.md`）→ 正常終了。
    再起動せず `harness-codex stop <window> <worktree>` で片付けるだけ（`.id`・`.exit` も消えるので次の tick から拾わない）
  - 成果物なし、または非 0 → `issue-cycle` の「Codex の監視と再起動」の判定
    （認証切れ・usage limit → フォールバック、それ以外 → `harness-codex stop` して `harness-codex start` で再起動）

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

`harness-inbox` の結果を `issue-cycle` Step 0 の振り分けに従って処理する。
`stale-notify` / `missing-notify` は**必ずその tick で**承認依頼をやり直す（承認依頼後に push したのに
依頼を出し直さない、という oogiri-doc で繰り返した抜けを機械的に塞ぐ）。

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
   （Claude はコードを直さない）。直ったら `harness-gate` → push
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
    - `meta.kind=merge` で承認 → `harness-merge {meta.issue} --chat-approval "<本文>"`。NG・指摘なら Phase 6 NG
    - `meta.kind=interview` → 回答を Issue に「## 要件メモ（Discord で回答）」として
      `<!-- harness:note source=discord -->` 付きでコメントしてから Phase 2 へ（GitHub を正本に保つ。
      この印があるので `harness-inbox` は二重に拾わない）
    - `meta.kind=blocked` → 書かれた指示に従って再開する
  - `meta.from=concierge`（窓口からの依頼）: 優先順位の変更・特定 Issue の着手など。従う
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

1. **本体を薄く保つ（根本策）**: 本体で直接やるのは、ループ判断・`harness-*` コマンド・`handoff.md` の
   読み書き・cron 管理・Codex 起動・人間ゲートだけ。ソース調査・tmux ログ・CI ログ・diff・大きな `gh`
   出力はサブエージェントに読ませて結論だけ受け取る。`gh` は `--json`/`-q` で必要な項目に絞る
2. **自己 clear → 自己 resume**（保険）: Issue が1件マージされた区切り、または
   `loop_meta.ticks_since_clear` が 4 以上になったら、**メインの心拍には触らず** one-shot を2本張る:
   ```
   CronCreate({ prompt: "/clear", recurring: false, durable: true })               # 約1分後
   CronCreate({ prompt: "/discord-loop-engine:issue-loop", recurring: false, durable: true }) # 約4分後
   ```
   張ったら `ticks_since_clear=0`、`pending_self_resume_at=<時刻>` を記録。次の起動時に
   `pending_self_resume_at` を過ぎているのに clear されていなければ失敗回数を数え、2回続いたら
   この仕組みを止めて手動 `/clear` を促す
3. **人間待ちだけのときは心拍を緩める**: アクティブが全部 `interview` / `awaiting-merge` / `blocked` で、
   Codex も CI も動いていなければ、心拍を `*/60` に張り替える（2時間変化が無ければ `*/120`）。
   Codex・CI が動き出すか人間の返事でフェーズが進んだら `*/15` に戻す。
   ※ Issue コメントでの返事はセッションを起こさないので、緩めた分だけ取り込みが遅れる
   （PR の購読イベントは即時に起こす）。discord-loop-engine で起動したセッションなら、Discord での
   返信がその場でセッションを起こすので遅れない

## `.harness/handoff.md`（ローカル・gitignore・無くても動く）

```
## loop_meta
- heartbeat_interval: 15min
- ticks_since_clear: 0
- pending_self_resume_at: none
- self_clear_fail_count: 0
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

- キューが空で、アクティブも全部終わった → 心拍を `CronDelete` し、`harness-notify --event info` で
  「キュー完了」を1回だけ通知して終える
- ユーザーが止めるよう言った → 心拍・one-shot を全部消す
