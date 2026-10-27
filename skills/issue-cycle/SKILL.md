---
name: issue-cycle
description: GitHub Issue を harness:* ラベルを状態機械として並列に1段階ずつ進めるスキル。設計・実装は Codex CLI（tmux ウィンドウ）に委譲し、Claude はレビュー・オーケストレーション・人間ゲートの通知に徹する。人間ゲート（要件確認・マージ承認・要対応）は必ず harness-phase 経由で GitHub コメント＋Discord 通知とセットで遷移させる。キュー補充・CI 自動対応・心拍まで含む自律運転は上位スキル issue-loop が担う。
---

# issue-cycle

`.claude/harness.json` があるプロジェクトで、アクティブな Issue を **1段階ずつ** 進める。
oogiri-doc の `parallel-cycle` をプロジェクト非依存にし、状態の置き場をローカルのディレクトリから
**GitHub の Issue ラベル**へ移したもの。

## 原則

1. **状態の真実は GitHub**。フェーズは Issue の `harness:*` ラベル、要件の決定・設計書・承認依頼は
   Issue/PR のコメントに残す。ローカルの `.harness/`（gitignore）はキャッシュに過ぎず、消えても
   ラベルと worktree から復元できる。どのマシン・どのセッションから再開しても同じ状態が見える。
2. **人間ゲートは `harness-phase` だけが入口**。`interview` / `awaiting-merge` / `blocked` へは
   `harness-phase` で遷移させる（GitHub にコメント → Discord 通知 → 成功時のみラベル付与）。
   ラベルの直接操作・`gh pr merge`・Discord への直接 curl は `harness-guard` hook が止める。
   **「通知したつもり」を構造的に起こさない**ための設計なので、迂回策を探さない。
3. **設計・実装は Codex**。Claude は設計書もコードも直接書かない（NG 時も Codex に差し戻す）。
   Codex が使えないとき（未ログイン・起動の拒否・usage limit など）は、info で知らせて
   `harness-implementer` に自動で切り替える（「フォールバック」節）。
4. **主セッションを薄く保つ**。設計書・diff・CI ログ・tmux ログ全文は主セッションに読み込まず、
   サブエージェントに読ませて結論だけ受け取る。
5. **マージは人間が決める**。どれだけ green でも `harness-merge` は人間の承認記録なしには通らない。

## コマンド

プラグインの `bin/` にある（PATH に無ければ `${CLAUDE_PLUGIN_ROOT}/bin/` を前置して呼ぶ）:

| コマンド | 役割 |
|---|---|
| `harness-config '<jq>' [既定値]` | `.claude/harness.json` を読む |
| `harness-phase <n> <phase> [...]` | フェーズ遷移（人間ゲートは通知必須） |
| `harness-inbox` | 人間の返信・承認/差し戻し・通知の鮮度切れを JSON で拾う |
| `harness-gate [dir]` | PR 前ゲート（CI と同じ検査を全部回して一覧。最後に `hooks.beforePR`） |
| `harness-hook <phase> [--issue n] [--pr n] [--dir d]` | profile の `hooks.<phase>` を実行する |
| `harness-issue-md <n>` | Issue 本文＋コメントを設計の入力用 Markdown にして出力する |
| `harness-codex-status check` / `status <window>` | Codex が使えるか・ウィンドウの状態（読み取り専用。確認なしで通る） |
| `harness-codex start <window> <worktree> <prompt-file>` | Codex を tmux で起動する（認証確認・終了コード記録つき。**Codex の起動は必ずこれを通す**） |
| `harness-merge <n> [--chat-approval "<引用>"]` | 承認・CI・mergeable を確認してマージ → done |
| `harness-notify --event ... --title ... --url ...` | Discord 通知（通常は harness-phase が呼ぶ） |
| `harness-status` | 読み取り専用の状況一覧 |

## 設定（engine 側の `projects/<名前>/harness.json`、またはリポジトリの `.claude/harness.json`）

主に使うキー（全体は discord-loop-engine の `templates/profile.example.json`）:

- `project` / `repo` / `baseBranch` / `owners`
- `maxParallel`（既定 3）/ `worktreeRoot`（省略時は `${DLE_HOME}-worktrees/<登録名>`。相対値は main 基準、絶対値も可）/ `branchPrefix`（既定 `fix/issue-`）
- `gate`: PR 前ゲート `[{name, run}]`（CI と同じ検査を同じ順で）
- `hooks`: リポジトリ固有の手順の差し込み口（`harness-hook <phase>` が実行。どれもコマンドの配列で、最初の失敗で止まる。
  `{n}` `{pr}` `{worktree}` `{main}` を置換）
  - `afterWorktree`: worktree 作成直後（依存のインストール、`.env` の symlink など）。以前の `setup` もここで先に実行される
  - `beforePR`: PR 前の追加の検査（`harness-gate` が gate の後に実行）
  - `onCIRed`: CI が赤くなったときの仕分け（issue-loop が実行。0 = 対処済み、0 以外 = コード起因）
  - `beforeMerge`: マージ前の確認（`harness-merge` が実行）
- `codex.command`: Codex 起動コマンド（`{worktree}` を置換）
- `context`: Codex とレビュー役に必ず読ませるファイル（CLAUDE.md・仕様書など）
- `notes`: リポジトリに規約ファイルが無いときの決まりごと（Phase 2 で worktree の `.harness/notes.md` に書き出して読ませる）
- `permissions`: worker が確認なしで使ってよいコマンド（engine が起動時に渡す）
- `demo`: UI 変更の録画手順 `{spec, run, output}`（`{n}` を置換）。無ければ動画なし
- `specRecordDir`: 設計記録をコミットする場所（`null` ならコミットしない）
- `humanChecks`: 自動では確認できず、毎回マージ承認依頼に載せる確認項目

再依頼・復帰・Phase 6 の片付けでも、同じ `WT="$(harness-config --worktree {n})" || exit 1` で初期化する。解決失敗では後続操作を止め、旧既定へフォールバックしない。

以下 `{n}` は Issue 番号、`$WT` は `harness-config --worktree {n}` の解決済み絶対パス。

## フェーズ（ラベル）

```
harness:queued ──(issue-loop が選定)──▶ harness:interview ──(owner が Issue で回答)──▶
harness:designing ──(Codex: $WT/.harness/spec/{n}.md)──▶ harness:spec-review ──OK──▶
harness:implementing ──(Codex: $WT/.harness/impl/{n}.md)──▶ harness:impl-review ──OK──▶
PR 作成・ゲート・CI green ──▶ harness:awaiting-merge ──(owner が OK)──▶ harness-merge ──▶ done
                          どこからでも ──▶ harness:blocked（自動では進められない）
```

ラベルとファイルの位置がずれていたら（例: `designing` なのに spec が既にある）、**ファイルが示す
進み具合を正として**ラベルを `harness-phase` で合わせ直してから続ける。

---

## Step 0: 状態の把握

```bash
harness-codex-status check                    # 10 なら「フォールバック」節へ（理由は stderr の reason=）
tmux ls >/dev/null 2>&1 || tmux new-session -d -s harness
harness-status
harness-inbox                                 # 人間からの返事・承認・鮮度切れ
```

アクティブ集合 = `interview`〜`awaiting-merge`・`blocked` のラベルが付いた open Issue。
closed なのに `harness:*` ラベルが残っている Issue（GitHub 画面からのマージ）は Phase 6 の片付けだけ行う
（`gh issue list --state closed --label harness:awaiting-merge --json number`）。
引数で番号が渡された場合は、その Issue を `harness-phase {n} interview ...` から始める（Phase 1）。

`harness-inbox` の結果を先に処理する:

- `answer`（interview への回答）→ Phase 1 の続き
- `merge-ok` → Phase 6 OK
- `merge-ng` / awaiting-merge 中の `answer` → Phase 6 NG
- `stale-notify` / `missing-notify` → 承認依頼をやり直す（Phase 5 の「承認依頼」を現 head で再実行）

## Phase 1: 要件確認（非ブロッキング）

**省略しない**。Issue と `context` のファイルを読み、実装前に決めるべき仕様・UX の選択肢・影響範囲を
1〜3点の質問にする。受け入れ条件が書かれていなければ、それも質問に含める。

```bash
harness-phase {n} interview --comment-file /tmp/harness-q-{n}.md \
  --summary "Q1. ...（1行）"
```

- 質問本文は **Issue コメント**になり、Discord には「[プロジェクト名] 🟡 要件確認｜#n タイトル」と
  そのコメントへのリンクが飛ぶ。スマホでリンクを開き、GitHub アプリでそのまま返信できる文面にする
  （番号付きの質問・選択肢・「おすすめ」を明記）。
- 質問を出したら **同じターンで回答を待たない**。他の Issue を進める。
- 回答（`harness-inbox` の `answer`）が来たら、決定事項を **「## 要件メモ」として Issue にコメント**し
  （`gh issue comment {n} --body-file ...`、本文末尾に `<!-- harness:note -->` を付ける）、Phase 2 へ。
- 回答が CLAUDE.md の明記規約から一意に導ける質問だけなら、issue-loop の「非ブロッキング進行」に従ってよい。

### 認証情報を人に依頼した後（Phase 1・blocked 解除の共通手順）

値は Discord/Issue に貼らせず、環境変数・秘密ファイル等の設定先だけを案内する。
設定完了の回答後、公式の読取り専用 API（whoami 等）で、値を見ずに疎通を確認する。
シェルのトレース・verbose は使わず、レスポンス本文・認証ヘッダを保存/表示せず HTTP ステータスか終了値だけを見る。
成功時のみ依存作業を再開する。401は認証、403は権限、通信失敗は接続の問題として、
値と応答本文を含めず正規の人間ゲートで対応を依頼する。専用 config キーは追加しない。

例えばサービスの仕様に合わせ、秘密は設定済み環境変数から渡し、次の形で本文を捨てる。
認証の仕組みが異なるサービスでは公式クライアントの安全な読取りコマンドを使う。

```bash
# AUTH_PROBE_BEGIN
set +x
status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SERVICE_TOKEN" "$AUTH_CHECK_URL" 2>/dev/null)" || status=network
case "$status" in
200) echo '疎通成功'; exit 0 ;;
401) echo '認証を確認してください'; exit 1 ;;
403) echo '必要な権限を確認してください'; exit 1 ;;
*) echo '通信先・接続状態を確認してください'; exit 1 ;;
esac
# AUTH_PROBE_END
```

## Phase 2: 設計書生成（Codex・並列）

```bash
ROOT="$(harness-config --root)" || exit 1
WT="$(harness-config --worktree {n})" || exit 1
mkdir -p "$(dirname "$WT")" || exit 1
git -C "$ROOT" fetch origin "$(harness-config '.baseBranch' main)"
git -C "$ROOT" worktree add "$WT" -b "$(harness-config '.branchPrefix' fix/issue-){n}" \
  "origin/$(harness-config '.baseBranch' main)"
harness-hook afterWorktree --issue {n} --dir "$WT" || exit 1   # 失敗したら worktree の準備ができていない。人に渡す
mkdir -p "$WT/.harness/spec" "$WT/.harness/impl"
harness-issue-md {n} > "$WT/.harness/issue-{n}.md"           # Codex の入力（本文→コメント＝要件メモの順）
harness-config '.notes' '' > "$WT/.harness/notes.md"          # engine 側の設定にある決まりごと
harness-phase {n} designing --notify

cat > "$WT/.harness/prompt-spec-{n}.md" <<EOF
.harness/issue-{n}.md の Issue と要件メモを読み、詳細設計書を .harness/spec/{n}.md に書いてください。
先に $(harness-config '.context | join(", ")' AGENTS.md) と .harness/notes.md を読むこと。
含めるもの: 受け入れ条件の対応表・変更ファイル一覧・実装方針・型/データ構造・テスト方針・
自動では確認できない点（humanChecks に該当するもの）・未確定事項。
git add / commit / push はしないこと。書き終えたら終了してください。
EOF
cat >> "$WT/.harness/prompt-spec-{n}.md" <<'CHECKLIST'

設計品質チェックリスト（正本。レビューと再依頼でもこの依頼ファイルを参照する）:
- 先頭に人向けの要約と Issue 本文の受け入れ条件の逐語引用を置く。番号を復元・推定しない。
  要件メモの回答と引用元は別記する。入力に本文がなければ harness-issue-md または GitHub の読取りで
  再取得し、取得できなければ不足を明記して確定設計にしない。
- 現状の各記述には `path:line` の根拠を付け、新しい提案と区別する。lockfile・vite/vitest 等の挙動は
  安全な一時ディレクトリで一度実行し、コマンド・終了コード・結果・実ファイルの検証を記す。
- 外部ツール・API は公式資料または使うラッパーの実装/README の URL・確認日・既知の制限を調べ、
  「本当に効くか」を最小プローブで確かめる。未実行なら理由・影響・後の確認手順を未確定事項に残す。
- 連動するエコシステムは notes/context から依存名・版の対応・双方の manifest/lockfile・更新時の検証を
  列挙する。該当しなければ非該当と理由を書く。
- 実装環境で道具の存在と機能を確認して検証手順を選ぶ。ログだけで成功にせず、成果物ファイルの
  存在・サイズ・内容/形式を調べる。シェル例の `$VAR` や `$(...)` も実際の環境で使える形にする。
- 録画・プロセス起動・タイミング依存には数値の N と独立した試行の初期化・成果物条件を決め、
  N 回連続成功を完了条件にする。中途失敗で連続回数を数え直す。SIGHUP・親の終了・プロセスグループの
  中断・孤児と一時ファイルの回収を扱う。
- 環境の前提（認証の疎通・self-hosted ランナー）を先に確認し、受け入れ条件ごとのテスト/確認手順と
  自動では確認できない humanChecks、未確認の前提を明記する。
CHECKLIST
# 完成した prompt-spec を読み、導入部とチェックリストが揃ったことを確認してから起動する。
cat "$WT/.harness/prompt-spec-{n}.md"
harness-codex start "codex-spec-{n}" "$WT" "$WT/.harness/prompt-spec-{n}.md"   # 10 なら「フォールバック」節へ
sleep 5; tmux capture-pane -t "$(cat "$WT/.harness/codex-spec-{n}.id")" -p -S -30 | grep "workdir:"   # $WT であること（必須）
```

> `harness-codex start` が `codex login status` で認証を確かめ、終了時に `EXIT=<code>` を
> ペインと `$WT/.harness/<window>.exit` に残し、ウィンドウを終了後も残す（`remain-on-exit`）。
> **`tmux new-window` で直接 codex を起こさない**（失敗が見えなくなる）。
> ウィンドウは名前ではなく **window-id**（`$WT/.harness/<window>.id`）で指す（Issue 番号はリポジトリ間で重複し、
> 別プロジェクトや死んだ同名ウィンドウと取り違えるため。`status` / `capture-pane` / `stop` とも id）。
> 起動コマンドは `codex.command`（`-C <worktree>` を含む）を使う。

> ⚠️ **`-C <worktree>` は必須**（tmux の `-c` や `cd` では Codex の作業ルートが変わらない。
> oogiri-doc で main の作業ツリーが直接書き換わり `.worktrees/` が消えた事故がある）。
> 起動直後に `workdir:` 行が `$WT` であることを必ず確認する。
>
> ⚠️ **Codex に git add/commit/push を任せない**。任せると ignore 対象を `git add -f` した実例がある。
> コミットは常に Claude がパスを列挙して行う。

`$WT/.harness/spec/{n}.md` の出現を **最大2分だけ** 出力なしでポーリングし（`until ...; do sleep 10; done`
を12回で打ち切り。各回 `harness-codex-status status codex-spec-{n} "$WT"` も見て、`exited:*` で成果物が無ければ
待たずに「Codex の監視と再起動」の判定に入る）、出たら `harness-phase {n} spec-review` → Phase 3。出なければ次の心拍に任せる。

### Codex の監視と再起動（全 Phase 共通）

**終了済みのウィンドウ**（`harness-codex-status status` が `exited:<code>` / `exited:unknown`）は、
サブエージェントを起こさずに判定する: ペイン末尾（`tmux capture-pane -pt "$(cat "$WT/.harness/<window>.id")" | tail -30`）か
`$WT/.harness/<window>.exit` を見て、認証切れ・usage limit なら「フォールバック」節へ、それ以外は
`harness-codex stop <window> "$WT"`（ウィンドウと `.id`・`.exit` を消す。`tmux kill-window` を直接打たない）で片付けてから同じ依頼で `harness-codex start` し直す。**終了済みのウィンドウは必ず
`harness-codex stop` で片付ける**（残すとシェパードが毎 tick 拾う）。

15分経っても出力が無ければ `tmux capture-pane -pt "$(cat "$WT/.harness/codex-<spec|impl>-{n}.id")" | tail -30` を **サブエージェントに**
読ませて状態だけ受け取る。

- 異常終了・無応答 → `harness-codex stop <window> "$WT"` して同じ依頼で `harness-codex start` し直す（`exec` は一回実行なので
  `send-keys` で追い依頼しない）
- 承認プロンプト・usage limit で止まっている → issue-loop の「codex シェパード」に従う
- 同じ依頼で2回失敗 → 依頼を具体化（対象ファイル・期待出力）して再依頼
- 3回失敗 → `harness-phase {n} blocked --comment-file ...`（状況と必要な対応を書く）

## レビュー共通: 二段階の敵対的検証

Phase 3・5 のレビューは、成果物を作った文脈から切り離した **fresh なサブエージェント2体**で行う。

1. **懐疑役**: 「問題がある」前提で反証を試みる。良い点は書かない。候補指摘を
   `/tmp/harness-review-{n}-{spec|impl}-candidate.md` に書いて終わる。
2. **検証役**: 別の fresh context で、候補指摘を成果物・実コード・テスト・一次情報に照らして再検証し、
   実証できないものを棄却する。返却は先頭 `OK` / `NG`、確定指摘ごとに
   `[深刻度][確度] 箇所 — 指摘 — 根拠`、最後に `反証を試みたが壊せなかった点:` を1〜2行。

主セッションは検証役の結果（数行）だけを受け取り、採否を決める。過剰設計になる指摘は棄却してよい。
渡すのはパスだけ（`$WT`、spec、Issue ファイル、`context`。Phase 3 は生成済みの `prompt-spec-{n}.md` も渡す）。Codex の説明や主セッションの会話は渡さない。

## Phase 3: 設計書レビュー

懐疑役の観点: 受け入れ条件の取りこぼし・要件メモとの矛盾・実装不能な前提・変更ファイル一覧の誤り・
既存の仕様書（`context`）との齟齬・テスト方針の欠落。
加えて `.harness/prompt-spec-{n}.md` の「設計品質チェックリスト」を正本として全項目を照合する。
参照行を実コードと、外部制限を一次資料と、挙動を実行結果・成果物と突き合わせる。
未確認の前提を推測で通さず、未実行の理由と確認方法を明示させる。

- **OK** → 設計書を Issue にコメント（`## 実装プラン` 見出し＋本文、末尾 `<!-- harness:note -->`）し、
  `harness-phase {n} implementing` → Phase 4
- **NG** → `prompt-spec-{n}.md` に確定指摘を追記し、チェックリストを残した同じファイルを渡して
  `codex-spec-{n}` を `harness-codex stop` → `harness-codex start` で再起動し、spec を書き直させる（Claude は直さない）。
  フォールバックにもこの同じ依頼ファイルのパスを渡す

## Phase 4: 実装（Codex）

```bash
harness-codex stop codex-spec-{n} "$WT"   # id が無くても安全（harness-implementer で書いた場合など）
cat > "$WT/.harness/prompt-impl-{n}.md" <<EOF
.harness/spec/{n}.md の設計書に従って実装してください。テストを先に書き、既存テストを壊さないこと。
完了したら .harness/impl/{n}.md に完了サマリ（変更ファイル・受け入れ条件ごとの確認方法・
自動では確認できない点）を書いてください。
（demo がある場合）UI や操作に関わる変更なら $(harness-config '.demo.spec') を作成し
$(harness-config '.demo.run') で pass させ、動画が $(harness-config '.demo.output') に 0 バイトでなく
出ていることを確認して、そのパスをサマリに書いてください。
Issue と無関係なファイルの差分（フォーマッタの巻き込み等）は git checkout HEAD -- <file> で戻すこと。
git add / commit / push はしないこと。
EOF
harness-codex start "codex-impl-{n}" "$WT" "$WT/.harness/prompt-impl-{n}.md"   # 10 なら「フォールバック」節へ
sleep 5; tmux capture-pane -t "$(cat "$WT/.harness/codex-impl-{n}.id")" -p -S -30 | grep "workdir:"
```

（`{n}` の置換は `harness-config` の出力に対しても行う。）
`$WT/.harness/impl/{n}.md` を最大2分ポーリングし（Phase 2 と同じく `harness-codex-status status` も見る）、出たら `harness-phase {n} impl-review` → Phase 5。

## Phase 5: 実装レビュー → PR → 承認依頼

### 5-1. 敵対的検証

懐疑役には `$WT`・spec・impl サマリ・Issue ファイルのパスを渡し、
`git -C $WT diff origin/<base>...` と未コミット差分を対象に、spec との乖離・境界値・失敗経路・回帰・
規約違反・スコープ外変更を壊しに行かせる（可能ならテスト・最小再現を実行させる）。

- **NG** → 指摘を添えて `codex-impl-{n}` を `harness-codex start` で再起動（軽微でも Claude は直さない）

### 5-2. 実動作の確認（UI 変更のとき）

`demo.output` の動画・スクショが存在し 0 バイトでないことを確認し、**サブエージェントに**受け入れ条件と
突き合わせさせて ✅/❌ を判定する。送る動画は**実アプリを実際に操作した録画**に限る（DOM 差し込み・
モック・加工で「それらしい」証跡を作らない）。❌ なら Codex に差し戻す。

### 5-3. コミット・ゲート・PR

```bash
git -C "$WT" status                     # スコープ外の差分が無いか確認し、あれば checkout で戻す
# 設計記録（specRecordDir が null でなければ）
REC=$(harness-config '.specRecordDir' '')
if [ -n "$REC" ]; then mkdir -p "$WT/$REC"; { cat "$WT/.harness/spec/{n}.md"; \
  printf '\n\n---\n\n# 実装完了サマリ\n\n'; cat "$WT/.harness/impl/{n}.md"; } > "$WT/$REC/{n}.md"; fi
git -C "$WT" add <変更ファイルを列挙> ${REC:+$REC/{n}.md}   # .harness/ は絶対に add しない
git -C "$WT" commit -m "<Why が分かるメッセージ>"
gate_rc=0
(cd "$WT" && harness-gate) || gate_rc=$?
# 0=成功、1=コード検査失敗、2=設定不備、3=環境不備。非0ならこのブロックを止める。
if [ "$gate_rc" -ne 0 ]; then exit "$gate_rc"; fi
git -C "$WT" push -u origin "$(harness-config '.branchPrefix' fix/issue-){n}"
gh pr create --base "$(harness-config '.baseBranch' main)" --head "$(harness-config '.branchPrefix' fix/issue-){n}" \
  --title "<種別>: <要約> (#{n})" --body-file /tmp/harness-pr-{n}.md   # 本文に必ず "closes #{n}"
```

gate の終了1は Codex にコード修正を差し戻し、終了2は設定を修正する。終了3は環境不備として
push/PR 作成を止める。ランナー停止・権限不足をコード修正へ差し戻さず、REAL の回数にも数えない。
自動解消できなければ `harness-phase {n} blocked --comment-file ...` で項目名・失敗理由・必要な対応を通知し、
解消後に gate 全体を再実行する。

PR を作ったら CI の結果を待つ（issue-loop 経由なら `subscribe_pr_activity` のイベントで、単体なら次の心拍で）。
CI が赤なら issue-loop の「CI red 対応」に従う。**CI が green になってから**承認依頼を出す。

### 5-4. 承認依頼（必ず harness-phase で）

UI 変更では現 head の実アプリの動画を `--file` に指定する。動画の検査・必要時 H.264 MP4 への変換と
添付位置の追記は harness-phase が行う。UI 非変更や demo=null の案件に一律に録画を強制しない。
変換に時間がかかるため、Bash ツールの timeout は既定120秒から延ばす（例: 600000 ms。長さに応じて調整）。
終了値を保存し、0 のときだけ承認依頼済みと扱う。

```bash
harness-phase {n} awaiting-merge --pr <PR番号> --comment-file /tmp/harness-merge-{n}.md \
  --summary "判定 ✅ / 受け入れ条件 1✅ 2✅ / 要実機確認 1件" \
  --file "<demo の mp4（UI 変更時・現 head で撮ったもの）>"
```

終了6なら stderr の不足ツール名・失敗段階と必要な対応（FFmpeg 導入・再録画・短縮等）を、
秘密を含めず別の本文ファイルにまとめ、`harness-phase {n} blocked --comment-file ...` で通知する。
動画準備に失敗した awaiting-merge 自体は投稿しない。blocked の通知失敗も成功扱いせず原因を解消して再実行する。
6以外の非0も仕分ける: 2は引数/設定、4は通知、5はラベルの問題を解消して同じ head で再実行する。
143/137等の中断・timeout は残存プロセスと一時ファイルを確認し、timeout を延ばして再実行できるか判断する。
自動解消できなければ blocked で対応を依頼する。対応後に動画準備から承認依頼をやり直す。

コメント本文（PR に載る。Discord のリンク先はこのコメント）には次を書く:

```
## マージ承認のお願い（#{n} {タイトル}）
- 判定: ✅ 完了 / 受け入れ条件: 1. ✅ … 2. ✅ …
- レビュー: 敵対的検証 OK（壊せなかった点: …）
- ゲート: harness-gate 全 ✅ / CI green
- 人間に確認してほしいこと（humanChecks）: - [ ] …
- 変更概要: …

マージしてよければこの PR に「OK」とコメント（または Approve / Issue に harness:merge-ok ラベル）、
直してほしい点があれば「NG: 〜」とコメントしてください。
```

- `--file` に付ける動画は**現在の head で撮ったもの**だけ。差し戻し・rebase 後に再依頼するときは撮り直す。
- 依頼後に head が進むと `harness-inbox` が `stale-notify` を返す。そのときは現 head で同じ手順を
  やり直す（承認依頼コメントに sha が埋め込まれているので、送ったかどうかを記憶に頼らない）。
- チャットで依頼内容を伝えるのは自由だが、**依頼の正本はこのコメントと Discord 通知**。

## Phase 6: 結果処理

### OK（`harness-inbox` の `merge-ok`、またはチャットでの OK）

```bash
git -C "$WT" fetch origin && git -C "$WT" merge "origin/$(harness-config '.baseBranch' main)"   # base が進んでいれば
# 衝突したコードの解消は Codex に依頼（`harness-codex start`）。push 後は CI green を待ち、head が変わったので承認依頼をやり直す
harness-merge {n}                                   # PR 上の承認
harness-merge {n} --chat-approval "<ユーザーの発言>"  # チャットでの承認
harness-codex stop codex-impl-{n} "$WT"   # worktree を消す前に（消した後は id を読めない）
git -C "$(harness-config --root)" worktree remove "$WT"
```

`harness-merge` が承認・head の一致・CI・mergeable を確認し、マージ後に `done`（ラベル除去）まで行う。
拒否されたら理由に従って直す（迂回しない）。「🔵 マージ完了」の Discord 通知は、`done` の報告を受けた
engine が出すので、ここでは送らない。

**人間が GitHub の画面から直接マージした場合**: Issue は `closes #{n}` で閉じるが、ラベルと worktree が残る。
Step 0 で「closed なのに `harness:*` ラベルが残っている Issue」を見つけたら、`harness-phase {n} done` と
worktree・tmux ウィンドウの片付けだけを行う。

### NG（`merge-ng` / 承認待ち中のコメント）

1. PR は閉じない。worktree も残す
2. `learning_add`（tag: `user-ng`）で記録する（自己改善の材料）。engine が無い環境では `.harness/failure-log.jsonl` に1行追記:
   `jq -nc --arg ts "$(date -u +%FT%TZ)" --argjson issue {n} --arg tag user-ng --arg summary "..." --arg detail "..." '{ts:$ts,issue:$issue,tag:$tag,summary:$summary,detail:$detail,promoted:false}' >> "$(harness-config --root)/.harness/failure-log.jsonl"`
3. 指摘を添えて `codex-impl-{n}` を `harness-codex start` で再起動し、`harness-phase {n} impl-review` で Phase 5 へ戻す

## フォールバック: Codex が使えない（自動で Claude に切り替える）

次のどれも「Codex 不可」として同じに扱う。**Codex の起動・再起動は、どの場面でも**（Phase 2/4、Phase 3/5/6 の
NG 差し戻し、マージ前の衝突解消、issue-loop の CI 差し戻しを含む）`harness-codex start` を通し、
exit 10 ならこの節に入る。

- `harness-codex-status check` / `harness-codex start` が exit 10（`reason=not-installed` / `not-logged-in` / `launch-failed`）
- `harness-codex start` を含む Bash 呼び出しが**権限判定で拒否された**。別のコマンド・別のフラグ・別の経路を
  探さない（判定を回避しない）。拒否の理由を info の本文に入れる
- 監視中に usage limit・認証切れ・起動直後の即終了（`exited:*` で原因が認証か limit）を確認した

動作:

1. `harness-notify --event info --title "Codex が使えないため Claude で進めます（#{n}）" --url <Issue の URL> --body "<reason と対処（codex login・許可・復帰時刻）>"`
   を**同じ原因につき一度だけ**出す（`handoff.md` の `loop_meta.codex_unavailable: <reason>@<時刻>` に記録し、
   `harness-codex-status check` が 0 になるまで再通知しない）。info なので人の返事は待たず、blocked にもしない。
   Codex が制限で止まっているなら Claude 側に余裕があるはず、という前提で待たずに切り替える
2. 動いていた `codex-*-{n}` ウィンドウは `harness-codex stop <window> "$WT"` で片付ける。実装の途中（usage limit など）で
   切り替えるときは、worktree の**未コミット差分をそのまま残し**（`git checkout`・`stash` で消さない）、
   `harness-implementer` に「続きから」と渡す
3. 設計・実装を `harness-implementer` サブエージェント（このプラグインの agent）に委譲する。
   渡すのは Issue 番号・`$WT`・入出力ファイルのパスだけ。
   設計時は生成済みの `$WT/.harness/prompt-spec-{n}.md` も必ず渡し、同じ依頼とチェックリストに従わせる
4. レビューは引き続き別のサブエージェントで行う（書いた agent に自己採点させない）
5. 確認ゲート・承認依頼・マージ条件は一切緩めない。`git add / commit / push` は implementer にも任せない
6. 次の Phase を始める前に `harness-codex-status check` を見て、0 ならその Phase から Codex に戻す
   （途中の Phase を巻き戻して作り直さない）

## やらないこと

- Claude が設計書・コードを直接書く（フォールバック以外）
- `harness:*` ラベルの直接編集、`gh pr merge` の直接実行、Discord への直接 curl
- `.harness/` を commit する、`git add -f`
- 承認依頼前の「確認だけ先に」、古い head の動画の流用
- 再トリガー目的の空コミット（再実行は `gh run rerun`）
