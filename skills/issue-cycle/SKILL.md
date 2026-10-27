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
| `harness-merge <n> [--chat-approval "<引用>" --attention <回答先A-id>]` | 承認・CI・mergeable を確認してマージ → done |
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
- `stale-notify` / `missing-notify` → 現 head で承認依頼をやり直す。ただし最新が自分の失敗した依頼の pending なら、5-4 の失敗の仕分けに従う。原因を直せたときだけ再実行し、直せなければ blocked にする。tick ごとの無条件再送をしない。

## Phase 1: 要件確認（非ブロッキング）

**省略しない**。Issue と `context` のファイルを読み、実装前に決めるべき仕様・UX の選択肢・影響範囲を
1〜3点の質問にする。受け入れ条件が書かれていなければ、それも質問に含める。

demo が設定されていて UI・操作に関わる変更、または動画利用が明示された案件では、
「動画で見せる範囲（どこからどこまで）」を質問に含める。実アプリに合わせて具体案を出し、
開始状態・操作順・終了状態・含めないものの4項目を要件メモへ記録する。決定済みなら回答を引用する。
未実装/見せる操作がない場合は、映せる状態と動かない理由も決める。範囲が未決なら Phase 1 で解決し、
設計で「最小」「実装者判断」に委ねない。demo=null/UI 非変更の全案件には録画を強制しない。

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
- 動画利用時は要件メモの開始状態・操作順・終了状態・含めないものを、設計シナリオ・試験・humanChecks に
  全て対応させる。未決範囲は Phase 1 へ戻し、「最小」「実装者判断」で確定しない。
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
出ていることを確認してください。動画利用時は要件メモの開始状態・操作順・終了状態・含めないものを
録画シナリオへ全て対応させ、独断で短縮しない。設計不足なら差し戻してください。
合意項目・録画時headのfull SHA・動画パス・未実装制限の対応をサマリに書いてください。
Issue と無関係な差分は元の内容に戻し、戻せなければサマリで worker へ報告してください。
Codex は git add/commit/push/checkout/stash 等の git 操作をしないこと。
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

`demo.output` の動画・スクショが存在し 0 バイトでないことを確認し、**サブエージェントに**受け入れ条件および要件メモの開始状態・操作順・終了状態・含めないものと
突き合わせさせて ✅/❌ を判定する。送る動画は**実アプリを実際に操作した録画**に限る（DOM 差し込み・
モック・加工で「それらしい」証跡を作らない）。途中操作欠落・範囲外の無断追加も ❌ とし、修正/再録画を依頼する。
サマリの録画時 full SHA と PR の現 head を照合し、**動画を撮ったhead＝現head** を確かめる。
違う/撮影head不明なら撮り直す。5-3 のコミット後、5-4 直前と完成後にも完成markerの full SHA と照合する。
ファイルの SHA-256 一致だけでは撮影headを証明できない（README の H3）。

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

動画を使う場合、合意した範囲を映した現 head の実アプリの録画を `--file` に指定する。
UI 非変更や demo=null の全案件には録画を強制しない。長い変換には Bash timeout を延ばす（例600000 ms）。
サマリの録画時 full SHA・PR 現 head・完成markerを直前/完成後に照合し、違う/不明なら撮り直す。

```bash
(cd "$WT" && harness-phase {n} awaiting-merge --pr <PR番号> --comment-file /tmp/harness-merge-{n}.md \
  --summary "判定 ✅ / 受け入れ条件 1✅ 2✅ / 要実機確認 1件" \
  --file "<合意範囲を現 head で録画した mp4>")
```

依頼とマージは対象の同じ worktree を cwd にして実行する。復旧未確認の状態ファイルもそこに置かれる。
動画なしは `--file` を省く。終了値を保存し、**0 だけ**承認依頼済みと扱う。
処理は静的通知先検査→merge-ok 取消し/他 phase ラベル除去/追跡 awaiting 確認→仮コメント pending→
必須通知→添付の再取得・bytes/SHA-256 照合→同 ID のリンク/A 入り完成 PATCH→merge-ok 再取消し/最終ラベル確認。
PR 本文には「添付」だけで済ませず、harness-phase が生成する Discord メッセージリンクを使う。
動画は Discord 保管、長文なら最後の投稿。署名付き CDN URL は PR に残さない。
容量は notify.maxAttachMB の正整数 MiB（既定10）。上限内でも Discord の制限/権限で失敗し得る。
短縮/再録画で対処し、本文だけへ降格しない。専用置き場ブランチは作らず main 履歴へ動画を追加しない。
過去 head・再実行・マージ後も自動削除しない。手動削除は人が Discord 上で判断し、削除すれば PR リンクは切れる。
詳細な保管/復旧/実機確認は [README](../../README.md#承認依頼の動画) の H1〜H5 に従う。

harness:merge-ok は動画なしも再依頼の開始時/完了時に外れる。処理中に付けたものも外れるので、
新しい依頼の完了を確認してから承認し直す。awaiting-merge だけを追跡用に残し、ラベルだけで完了を判断しない。
承認依頼は required=false でも動画なしを含め通知必須にする。GitHub コメント・Discord 通知・ラベルの
人間ゲートを揃える安全柵強化のため。通常 info 等の skip は維持する。

失敗の仕分け:
- 2: 引数/設定/雛形の未置換、6: ffprobe/ffmpeg/入力/容量。外部副作用前に止まる。道具導入・再録画等を行う。
- 4: 通知、7: 投稿後の A/リンク/再取得照合/head/完成 PATCH、5: ラベル確認。最新 pending は inbox が missing-notify として返す。
  最新が自分の失敗した依頼の pending なら、原因を直せたときだけ再実行し、直せなければ blocked にする。
  失敗 A は取下げ保証なし。OK を返しても未完了依頼はマージできない。A の偽回答や台帳編集で取り下げない。
- 完成後の失敗では merge-ok 除去・awaiting 維持/復元・同コメントの pending 化を試す。
  通信断等で復旧未確認なら worktree 内の git 管理外状態ファイルに残り harness-merge が拒否する。
  通信回復後も再読取り・全手順の成功までマージしない。再依頼が成功したとき状態ファイルが消える。
- 中断/timeout: 所有 PID/PGID・送信結果・一時ファイルを確認。TERM 無視の子も回収し、共有 engine を停止しない。
  SIGKILL/親の無信号終了は trap 保証なし。残存子を止めてから所有一時領域だけ回収する。

自動解消できなければ失敗段階・必要な対応を秘密なしで別本文にまとめ、`harness-phase {n} blocked --comment-file ...`。
blocked 通知失敗も成功にしない。原因解消後は動画準備から新コメント・新通知・新 A で再依頼し、旧 receipt/A を流用しない。

コメント雛形（動画欄は自動生成。入力に架空 URL を書かない）:

```text
【動きのない動画の場合だけ、この最初の行に理由を記入: 未実装/見せる操作がない具体的理由】
## マージ承認のお願い（#{n} {タイトル}）
- 動画で見せる範囲: {開始状態→操作順→終了状態、含めないもの}
- 判定: ✅ 完了 / 受け入れ条件: 1. ✅ … 2. ✅ …
- レビュー: 敵対的検証 OK（壊せなかった点: …）
- ゲート: harness-gate 全 ✅ / CI green
- 人間に確認してほしいこと（humanChecks）: …（普通の箇条書きで結果/未確認を記す）
- 変更概要: …

マージしてよければこの PR に「OK」とコメント（または Approve / Issue に harness:merge-ok ラベル）、
直してほしい点があれば「NG: 〜」とコメントしてください。
完成コメントを編集すると、それより前の OK/Approve は数えないため、編集後に再回答してください。
```

動く動画なら条件行を削除、動かない場合は「理由: …」へ置換して見出し前の最初の行に置く。
--summary も理由を先頭に置く。省略時は本文冒頭から自動要約。動画なしは範囲欄も省く。
固定文字列 `【動きのない動画の場合だけ` が残れば終了2。内容の真偽は人が照合する。
GitHub OK は完成 PATCH の updated_at より厳密に後だけ（同秒なら再回答）、Approve は現 head の commit_id も必須。
NG/CHANGES_REQUESTED は仮 POST の created_at 以後から保持し、途中の NG を完成前 OK で消さない。
attention 属性のない旧 gate は全承認経路で再依頼が必要。依頼後の head 変更も現 head で再依頼する。
チャットで伝える場合も依頼の正本はこのコメントと Discord 通知。

## Phase 6: 結果処理

### OK（`harness-inbox` の `merge-ok`、またはチャットでの OK）

```bash
git -C "$WT" fetch origin && git -C "$WT" merge "origin/$(harness-config '.baseBranch' main)"   # base が進んでいれば
# 衝突したコードの解消は Codex に依頼（`harness-codex start`）。push 後は CI green を待ち、head が変わったので承認依頼をやり直す
(cd "$WT" && harness-merge {n}) || exit 1             # PR 上の承認
(cd "$WT" && harness-merge {n} --chat-approval "<回答本文>" --attention "<回答のmeta.attention>") || exit 1  # engine の回答だけ
harness-codex stop codex-impl-{n} "$WT"   # worktree を消す前に（消した後は id を読めない）
git -C "$(harness-config --root)" worktree remove "$WT"
```

`harness-merge` が承認・head の一致・CI・mergeable を確認し、マージ後に `done`（ラベル除去）まで行う。
最新完成marker・ラベル・現 head・回答先 A の一致が全承認経路で必須。meta.attention 欠落は推測しない。
webhook は GitHub 承認だけ。engine なしで単独利用する issue-cycle ではチャット承認を利用できない。
旧 A/A なし/pending 等で拒否されたら harness-notify の info で理由・現在の依頼先PRコメントURL・
完成内容を確認して回答する必要を伝える（未完了なら復旧待ち）。現在のA は表示せず、同じ OK の付け替えをしない。
URL が診断に無ければ認証 login の最新依頼を同じ規則で読み、取得不能ならその旨と既知 PR URL を案内する。
info の通知失敗も記録する。CI/mergeable/hook だけが理由で同じ依頼/head なら、同じ --attention と引用での再試行は可能。
新 head/新依頼には新回答が必要。拒否理由に従って直す（迂回しない）。「🔵 マージ完了」の Discord 通知は、`done` の報告を受けた
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
