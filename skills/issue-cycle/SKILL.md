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
2. **Issue の人間ゲートは `harness-phase` だけが入口**。`interview` / `awaiting-merge` / `blocked` へは
   `harness-phase` で遷移させる（GitHub にコメント → Discord 通知 → 成功時のみラベル付与）。
   ラベルの直接操作・`gh pr merge`・Discord への直接 curl は `harness-guard` hook が止める。
   **「通知したつもり」を構造的に起こさない**ための設計なので、迂回策を探さない。
3. **設計・実装は Codex**。Claude は設計書もコードも直接書かない（NG 時も Codex に差し戻す）。
   Codex が使えないとき（未導入・未ログイン・usage limit）は、info で知らせて
   `harness-implementer` に自動で切り替える（「フォールバック」節）。
   起動の権限拒否・launch-failed・判別不能は代行せず blocked と人向け起動1行へ進む。
4. **主セッションを薄く保つ**。設計書・diff・CI ログ・tmux ログ全文は主セッションに読み込まず、
   サブエージェントに読ませて結論だけ受け取る。
5. **マージは人間が決める**。どれだけ green でも `harness-merge` は人間の承認記録なしには通らない。

Issue のない Dependabot PR は `harness-pr request --pr N` で A/head を固定し、人の実回答の OK 後に
`harness-merge --pr N` を使う。Issue 番号を偽造せず、既存の Issue の Phase 手順を維持する。
Approve と auto-merge の操作は `harness-merge --pr` の中だけで行う。worker が直接 Approve したり、auto-merge を有効にしたりしない。
PR 本文を A.summary・通知・scan/inbox へ入れない。人は PR リンクから確認する。

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
| `harness-pr scan` / `harness-pr inbox` | Dependabot PR の検出・台帳の承認回収・後始末の確認（Issue なし） |
| `harness-pr request --pr N [--retry]` | 古い順・同時1件で新 A/head の依頼。retry は窓口経由の人の再依頼だけ |
| `harness-merge --pr N` | PR 用 A の実 OK・head・CI・hook を検証し、必要時に Approve、マージと後始末 |
| `harness-status` | 読み取り専用の状況一覧 |

## 設定（engine 側の `projects/<名前>/harness.json`、またはリポジトリの `.claude/harness.json`）

設定の優先順位は非空 `HARNESS_CONFIG` → main の `.claude/harness.json` →
`DLE_CONFIG_HOME/projects/$DLE_PROJECT/harness.json`。DLE_CONFIG_HOME が未設定・空なら `DLE_HOME`、
さらに未設定・空なら `$HOME/.discord-loop-engine` を使う。相対 home は main 基準。
engine は worker・窓口の起動時に `DLE_CONFIG_HOME=cfg.home` を渡す。
通常は手で DLE_HOME を差し替える必要はない。設定の場所を別に指す必要があれば
DLE_CONFIG_HOME（または既存の HARNESS_CONFIG）を指定する。
preflight/gate は自分で全 DLE_*/DISCORD_* を除去し、一時 home/socket に隔離する。
`hooks.beforePR` は呼出し元の環境で実行する。DLE_CONFIG_HOME は通知無効化の保証を与えない。

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

## Codex の共通起動手順

全ての起動・再起動（Phase 2/4、設計/実装レビューNG、監視、CI red、衝突解消、ユーザーNG）は、
以下の3段階を守る。各段階を別の Bash ツール呼び出しにする。

1. **準備**: `WT` の解決、必要な `harness-codex stop`、依頼ファイルの作成・内容確認、フェーズ変更を済ませる。
   `harness-config --path` と `command -v harness-codex`（PATH に無ければ `${CLAUDE_PLUGIN_ROOT}/bin/harness-codex`）を
   `realpath` で絶対パスにし、実効設定・入口・WT・非空の依頼ファイルが実在することを確認する。
2. **起動**: `harness-codex start` の1コマンドだけを単独の Bash で呼ぶ。`cd`、代入、`&&`、`;`、pipe、
   通知・フェーズ変更・status・capture を同じ呼び出しへ足さない。呼び出し間でシェル変数が残ると考えず、
   準備の出力から得た絶対パスを `printf %q` で引用して直接記載する。入口が PATH に無ければ解決済みの絶対入口を使う。
   パスは %q の出力をそのまま置き、さらに引用符で囲まない。
   以下の起動例の `{n}` とパスは実値へ置き換える。
3. **監視**: 起動受付の0を確認した後だけ、別の Bash で WT を解決し直し、保存ID・status・`workdir:`・成果物を確認する。
   起動受付は処理完了ではない。拒否された場合は監視へ進まない。

Bash の権限判定による拒否は、start が動いていない場合もあり exit 10 として扱わない。
`reason=launch-failed`（tmux 起動失敗、exit 10 は維持）と拒否/利用不可の判別不能も、
「Codex 起動を blocked にする」へ進む。自動再試行・Claude 代行・直接の `tmux new-window … codex` / `codex exec`・
フラグや別シェル/別名/env 経由の迂回をしない。worker が permissions・permission mode・設定を変えて権限を広げない。
`reason=not-installed` / `not-logged-in` の exit 10 と、確認できた認証切れ・usage limit だけがフォールバック対象。

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
- `stale-notify` / `missing-notify` → 先に「承認回収の仕分けと共通通知」で pending と復旧を分類してから、現 head で承認依頼をやり直す。ただし最新が自分の失敗した依頼の pending なら、5-4 の失敗の仕分けに従う。原因を直せたときだけ再実行し、直せなければ blocked にする。tick ごとの無条件再送をしない。

Step 0 の追加振り分け: `chat-merge-ok` は同じ tick の Phase 6、`chat-not-approved` は共通通知へ。
`missing-attention` は Phase 5-4、`attention-unavailable` / `attention-mismatch` は再確認後に解消不能なら blocked。
`stale-notify` / `missing-notify` の pending は先に「承認回収の仕分けと共通通知」で分類する。


## Phase 1: 要件確認（非ブロッキング）

**省略しない**。Issue と `context` のファイルを読み、実装前に決めるべき仕様・UX の選択肢・影響範囲を
1〜3点の質問にする。受け入れ条件が書かれていなければ、それも質問に含める。

既存のフロー・画面・出力に触れる案件では、それらを残す前提にせず、残すか消すかも選択肢に含める。
決まっている場合は回答を引用する。関係しない案件にこの質問を機械的に追加しない。

demo が設定されていて UI・操作に関わる変更、または動画利用が明示された案件では、
「動画で見せる範囲（どこからどこまで）」を質問に含める。実アプリに合わせて具体案を出し、
開始状態・操作順・終了状態・含めないものの4項目を要件メモへ記録する。決定済みなら回答を引用する。
未実装/見せる操作がない場合は、映せる状態と動かない理由も決める。範囲が未決なら Phase 1 で解決し、
設計で「最小」「実装者判断」に委ねない。demo=null/UI 非変更の全案件には録画を強制しない。

```bash
harness-phase {n} interview --comment-file /tmp/harness-q-{n}.md \
  --summary "Q1. ...（1行）"
```

- 質問本文は **Issue コメント**になり、Discord には「🟡 **[プロジェクト名]** 要件確認 A-n｜#n」の見出し
  （タイトルは本文冒頭）とそのコメントへのリンクが飛ぶ（engine 不在の webhook 経路は旧形式）。スマホでリンクを開き、GitHub アプリでそのまま返信できる文面にする
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

````bash
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
# DESIGN_REQUEST_BEGIN
gate_rc=0
gate_output="$(harness-config '.gate' '')" || gate_rc=$?
if [ "$gate_rc" -ne 0 ]; then
  cat > "$WT/.harness/gate-error-{n}.md" <<'GATE_ERROR'
設計依頼に添付する gate を取得できませんでした。
有効な harness 設定の JSON と gate 定義を確認してください。
設計依頼の作成と designing 遷移・Codex 起動は行っていません。
GATE_ERROR
  printf '\n取得の終了コード: %s\n' "$gate_rc" >> "$WT/.harness/gate-error-{n}.md"
  harness-phase {n} blocked --comment-file "$WT/.harness/gate-error-{n}.md" || exit 1
  exit "$gate_rc"
fi
harness-phase {n} designing --notify || exit 1

cat > "$WT/.harness/prompt-spec-{n}.md" <<EOF
.harness/issue-{n}.md の Issue と要件メモを読み、詳細設計書を .harness/spec/{n}.md に書いてください。
リポジトリの追跡ファイルは変更しないこと（設計書は必ず保存する）。
先に $(harness-config '.context | join(", ")' AGENTS.md) と .harness/notes.md を読むこと。
含めるもの: 受け入れ条件の対応表・変更ファイル一覧・実装方針・型/データ構造・テスト方針・
自動では確認できない点（humanChecks に該当するもの）・未確定事項。
git add / commit / push はしないこと。書き終えたら終了してください。
EOF
cat >> "$WT/.harness/prompt-spec-{n}.md" <<'CHECKLIST'

設計品質チェックリスト（正本。レビューと再依頼でもこの依頼ファイルを参照する）:

常に確かめる項目:
- 先頭に人向けの要約と Issue 本文の受け入れ条件の逐語引用を置く。番号を復元・推定しない。
  要件メモの回答と引用元は別記する。入力に本文がなければ harness-issue-md または GitHub の読取りで
  再取得し、取得できなければ不足を明記して確定設計にしない。
  解釈を含む具体化（文言・式・数値例など）は「確定要件」とせず「解釈」と明記する。
- 現状の各記述には `path:line` の根拠を付け、新しい提案と区別する。lockfile・テストランナーの探索/除外等の
  挙動を前提にする場合は安全な一時ディレクトリで一度実行し、コマンド・終了コード・結果・実ファイルの検証を記す。
- 添付されたプロジェクトの gate が非空の配列なら、そのコマンド列・順序を実装後の確認手順に明示する。
  format / lint / test / build など、gate にある検査を省略しない。新しいテストファイルがその対象に入るか、
  glob・除外設定・呼び出し元も確かめる。gate 未定義・空・配列以外は未確認として記し、CI との対応を確認する手順を残す。
- 実装環境で道具の存在と機能を確認して検証手順を選ぶ。ログだけで成功にせず、成果物ファイルの
  存在・サイズ・内容/形式を調べる。シェル例の `$VAR` や `$(...)` も実際の環境で使える形にする。
- 環境の前提（認証の疎通・self-hosted ランナー）を先に確認し、受け入れ条件ごとのテスト/確認手順と
  自動では確認できない humanChecks、未確認の前提を明記する。

該当するときだけの項目（非該当なら理由を書く）:
- 要素・フロー・画面・出力を廃止する場合は、その要素のためだけにあった表示（UI・CLI の出力・通知の文面）を
  洗い出し、残すか消すかを設計に書く。
- 動画利用時は要件メモの開始状態・操作順・終了状態・含めないものを、設計シナリオ・試験・humanChecks に
  全て対応させる。未決範囲は Phase 1 へ戻し、「最小」「実装者判断」で確定しない。
- リポジトリに憲章・規約のレビューゲートがある場合は、そのファイルと該当節を挙げ、節ごとに満たす確認を
  自動テストまたは humanChecks に対応付ける。
- 設定ファイルを変える Issue では、スキーマ検証に加え、要件で指定された値を期待値との assert で確かめる。
  型や形式が正しいだけで、異なる値が通る確認にしない。
- 外部ツール・API は公式資料または使うラッパーの実装/README の URL・確認日・既知の制限を調べ、
  最小プローブで実効性を確かめる。ツールのメジャー版を上げる場合は、連携するツール/セットアップ手段の対応版を
  一次情報で確かめる。未実行なら理由・影響・後の確認手順を未確定事項に残す。
  確かめられない環境依存は「PR CI の実ログを根拠に 1 回だけ直し、だめなら blocked で人に返す」停止ルールを
  検証計画に含める。対象の環境依存・未確認理由・CI で確かめる手順を特定し、停止計画は実装完了サマリにも引き継ぐ。
- 連動するエコシステムは notes/context から依存名・版の対応・双方の manifest/lockfile・更新時の検証を
  列挙する。該当しなければ非該当と理由を書く。
- 録画・プロセス起動・タイミング依存には数値の N と独立した試行の初期化・成果物条件を決め、
  N 回連続成功を完了条件にする。中途失敗で連続回数を数え直す。SIGHUP・親の終了・プロセスグループの
  中断・孤児と一時ファイルの回収を扱う。
  長時間動く子プロセスを持つ CLI では、利用者が実際に叩く経路（パッケージマネージャー/スクリプトランナー経由
  〔例: pnpm〕・パイプ）での異常系を設計する。子を直接終了する試験だけで代用しない。
- はみ出し・表示崩れの修正では、対象のボタン名・要素を列挙し、各状態での viewport（幅・高さ）と
  確認方法・期待結果を対応付ける。
- 仕様の読みが割れる点は決定せず、未確定事項に挙げる（解釈の明記だけで済ませない）。
- docs に、A-番号・「回答待ち」などの時点依存の文言と、gitignore 対象（.harness/）へのリンクを書かない。
- 依存の用途を書くときは、package.json の scripts と scripts/ 配下の import も確かめる（devDependencies だけで判断しない）。
- 手順は、出力先と順序（変更前の取得→変更→変更後の比較→掃除）を一本の手順として書き、通しで実行可能かを見直す。
  追跡外ファイル（基準画像・生成物）も差分の確認に含める。
- 同じ値を2か所で数える設計は、丸め規則を揃えるテストを入れる。OS 固有の意味論に依る処理は、方式の選択肢と前提を書く。

実装依頼の項目（該当するときだけ。非該当なら理由を実装完了サマリに書く）:
- 設定フラグで挙動を分ける機能は、OFF の全経路が origin/main と同じことのテストを入れる。
- ID を削除・無効化する機能は、参照する全ての場所を列挙して掃除する。TS と Rust など二重に検証する値は、
  共通の fixture で揃える。両側で状態を持つ処理は、結合テストを必須にする。
- 新しい UI は、近くの固定・浮動 UI との重なりを実測し、ready 以外の状態も描画テストする。
- Sonar の代表ルール（await のない async・入れ子の三項演算子）を避ける。
- 既存コメントを消さない・英語にしない・フォーマッタの整形を巻き込まない。

差し戻し時の項目（再依頼の指示に含める）:
- 指摘の行だけでなく、同じ節の要求全体と、同種の箇所の横展開を指示に含める。
- 「未確定」と書く前に、設計書の該当節を引用させる。
CHECKLIST
cat >> "$WT/.harness/prompt-spec-{n}.md" <<'GATE_NOTE'

プロジェクトの gate（依頼生成時の harness-config '.gate' の出力。配列以外は null と表示）:
```json
GATE_NOTE
if printf '%s\n' "$gate_output" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
  printf '%s\n' "$gate_output" '```' >> "$WT/.harness/prompt-spec-{n}.md"
  cat >> "$WT/.harness/prompt-spec-{n}.md" <<'GATE_NOTE'
実装後の確認はこの gate と同じコマンド列・順序にする（format / lint / test / build などを省略しない）。
新しいテストファイルがこの列の対象に入るか、glob・除外設定・呼び出し元を確かめる。
GATE_NOTE
else
  if printf '%s\n' "$gate_output" | jq -e 'type=="array" and length==0' >/dev/null 2>&1; then
    printf '%s\n' "$gate_output" >> "$WT/.harness/prompt-spec-{n}.md"
  else
    printf '%s\n' 'null' >> "$WT/.harness/prompt-spec-{n}.md"
  fi
  printf '%s\n' '```' >> "$WT/.harness/prompt-spec-{n}.md"
  cat >> "$WT/.harness/prompt-spec-{n}.md" <<'GATE_NOTE'
gate は未定義・空または配列以外。CI と品質コマンドの対応は未確認として明記し、この状態を gate の確認完了の根拠にしない。
CI から必要な品質コマンドと新しいテストファイルの対象を確認し、不足する前提・後の確認手順を残す。
GATE_NOTE
fi
# 完成した prompt-spec を読み、導入部・チェックリスト・gate と欠落時の説明が揃ったことを確認してから起動する。
cat "$WT/.harness/prompt-spec-{n}.md"
# DESIGN_REQUEST_END
````

準備はここで終了。共通起動手順に従い、解決済みのパスへ置換した次の1行を単独の Bash で起動する。
exit 10 は reason を読んでフォールバックと blocked を分ける。

```bash
harness-codex start "codex-spec-{n}" /absolute/worktree /absolute/worktree/.harness/prompt-spec-{n}.md
```

起動受付後の監視は別の Bash で行う。

```bash
WT="$(harness-config --worktree {n})" || exit 1
sleep 5; tmux capture-pane -t "$(cat "$WT/.harness/codex-spec-{n}.id")" -p -S -30 | grep "workdir:"   # $WT であること（必須）
```

gate は依頼生成時のスナップショットとして、非空の配列をコマンドの再評価・実行・並べ替えなしで添付する。
定義を後で変えた場合は、更新後の列と CI の対応をレビューで照合する。欠落・空・配列以外の表示は
gate 成功を意味せず、設定の型の許容や既定コマンドの追加でもない。
取得失敗から blocked へ進む処理は防御的な分岐である。不正 JSON は本番では手前の
`harness-config --worktree {n}` が終了1となって停止するため、この分岐には到達しない。
T5 は gate 取得の非0を stub で注入する単体検証であり、不正 JSON が本番で blocked になることを示さない。
この分岐では古い依頼を上書き・起動せず、blocked 通知の失敗も成功扱いしない。

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

再起動も共通起動手順の準備・単独起動・監視へ分ける。再起動時の権限拒否は上限回数を待たず直ちに blocked とし、再試行しない。

**終了済みのウィンドウ**（`harness-codex-status status` が `exited:<code>` / `exited:unknown`）は、
サブエージェントを起こさずに判定する: ペイン末尾（`tmux capture-pane -pt "$(cat "$WT/.harness/<window>.id")" | tail -30`）か
`$WT/.harness/<window>.exit` を見て、認証切れ・usage limit なら「フォールバック」節へ、それ以外は
`harness-codex stop <window> "$WT"`（ウィンドウと `.id`・`.exit` を消す。`tmux kill-window` を直接打たない）で片付けてから同じ依頼で共通起動手順に従い `harness-codex start` し直す。**終了済みのウィンドウは必ず
`harness-codex stop` で片付ける**（残すとシェパードが毎 tick 拾う）。

15分経っても出力が無ければ `tmux capture-pane -pt "$(cat "$WT/.harness/codex-<spec|impl>-{n}.id")" | tail -30` を **サブエージェントに**
読ませて状態だけ受け取る。

- 異常終了・無応答 → `harness-codex stop <window> "$WT"` して同じ依頼で共通起動手順に従い `harness-codex start` し直す（`exec` は一回実行なので
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

検証役の判定基準: ツールのメジャー版更新で、ローカルでは確かめられない環境依存については、一次情報で
対応版を確認し、未確認の理由・影響・CI での確認手順を明記した上で、「PR CI の実ログを根拠に 1 回だけ直し、
だめなら blocked で人に返す」停止ルールを用意していれば、設計段階の検証計画として足りる。
設計時に実行できないという理由だけで同じ確認の再依頼を繰り返さない。一般のコード不備や未対応の受け入れ条件を
通す根拠にはしない。実装段階の修正回数の判定は PR 作成後の 5-3 で行う。

主セッションは検証役の結果（数行）だけを受け取り、採否を決める。過剰設計になる指摘は棄却してよい。
渡すのはパスだけ（`$WT`、spec、Issue ファイル、`context`。Phase 3・5 両方の懐疑役・検証役に生成済みの
`prompt-spec-{n}.md` も渡す）。Codex の説明や主セッションの会話は渡さない。

## Phase 3: 設計書レビュー

懐疑役の観点: 受け入れ条件の取りこぼし・要件メモとの矛盾・実装不能な前提・変更ファイル一覧の誤り・
既存の仕様書（`context`）との齟齬・テスト方針の欠落。
加えて `.harness/prompt-spec-{n}.md` の「設計品質チェックリスト」を正本として全項目を照合する。
gate と同じ列・順序の検査、新規テストの探索/除外/呼び出し元、憲章・規約の該当節と自動確認/humanChecks、
スキーマに加えた要件値の assert、長時間 CLI の実経路（パッケージマネージャー/スクリプトランナー・パイプ）の
異常系と N・初期化/回収、一次情報による対応版と環境依存の停止計画、確定要件と解釈の区別、
表示崩れの要素 × 状態 × viewport を、設計のテスト・期待値・humanChecks と照合する。
廃止対象に付随した表示の棚卸しと残す／消すの判断も照合する。
参照行を実コードと、外部制限を一次資料と、挙動を実行結果・成果物と突き合わせる。
未確認の前提を推測で通さず、未実行の理由と確認方法を明示させる。

- **OK** → 設計書を Issue にコメント（`## 実装プラン` 見出し＋本文、末尾 `<!-- harness:note -->`）し、
  `harness-phase {n} implementing` → Phase 4
- **NG** → `prompt-spec-{n}.md` に確定指摘を追記し、チェックリストと gate を残した同じファイルを渡して
  `codex-spec-{n}` を共通起動手順（準備で `harness-codex stop` → 別 Bash で `harness-codex start`）で再起動し、spec を書き直させる（Claude は直さない）。
  指示には .harness/prompt-spec-{n}.md の「差し戻し時の項目」を含める。
  フォールバックにもこの同じ依頼ファイルのパスを渡す

## Phase 4: 実装（Codex）

共通起動手順の準備として、WT を解決し直してから依頼を作る。

```bash
WT="$(harness-config --worktree {n})" || exit 1
harness-codex stop codex-spec-{n} "$WT"   # id が無くても安全（harness-implementer で書いた場合など）
# IMPLEMENTATION_REQUEST_BEGIN
cat > "$WT/.harness/prompt-impl-{n}.md" <<EOF
.harness/spec/{n}.md の設計書に従って実装してください。テストを先に書き、既存テストを壊さないこと。
完了したら .harness/impl/{n}.md に完了サマリ（変更ファイル・受け入れ条件ごとの確認方法・
自動では確認できない点）を書いてください。
（demo がある場合）UI や操作に関わる変更なら $(harness-config '.demo.spec') を作成し
$(harness-config '.demo.run') で pass させ、動画が $(harness-config '.demo.output') に 0 バイトでなく
出ていることを確認してください。動画利用時は要件メモの開始状態・操作順・終了状態・含めないものを
録画シナリオへ全て対応させ、独断で短縮しない。設計不足なら差し戻してください。
.harness/prompt-spec-{n}.md の「実装依頼の項目」を読み、該当するものを満たすこと。非該当は理由を完了サマリに書くこと。
合意項目・録画時headのfull SHA・動画パス・未実装制限の対応をサマリに書いてください。
Issue と無関係な差分は元の内容に戻し、戻せなければサマリで worker へ報告してください。
Codex は git add/commit/push/checkout/stash 等の git 操作をしないこと。
EOF
# IMPLEMENTATION_REQUEST_END
cat "$WT/.harness/prompt-impl-{n}.md"
```

準備後、共通起動手順に従いパスを実値に置換して、次の1行だけを単独の Bash で起動する。
exit 10 は reason を確認し、拒否・launch-failed・判別不能なら blocked とする。

```bash
harness-codex start "codex-impl-{n}" /absolute/worktree /absolute/worktree/.harness/prompt-impl-{n}.md
```

起動受付後の監視は別の Bash にする。

```bash
WT="$(harness-config --worktree {n})" || exit 1
sleep 5; tmux capture-pane -t "$(cat "$WT/.harness/codex-impl-{n}.id")" -p -S -30 | grep "workdir:"
```

（`{n}` の置換は `harness-config` の出力に対しても行う。）
`$WT/.harness/impl/{n}.md` を最大2分ポーリングし（Phase 2 と同じく `harness-codex-status status` も見る）、出たら `harness-phase {n} impl-review` → Phase 5。

## Phase 5: 実装レビュー → PR → 承認依頼

### 5-1. 敵対的検証

懐疑役・検証役には `$WT`・spec・impl サマリ・Issue ファイル・生成済みの `prompt-spec-{n}.md` のパスを渡し、
`git -C $WT diff origin/<base>...` と未コミット差分を対象に、spec との乖離・境界値・失敗経路・回帰・
規約違反・スコープ外変更を壊しに行かせる（可能ならテスト・最小再現を実行させる）。
設計品質チェックリストの全項目を、実コード・テスト・ローカルの実行ログ・成果物と照合する。
gate の列・順序と終了値、新規テストの探索/除外/呼び出し元、憲章・規約の該当節と自動確認/humanChecks、
スキーマに加えた要件値の assert、長時間 CLI の実経路（パッケージマネージャー/スクリプトランナー・パイプ）の
異常系と N・初期化/回収、一次情報による対応版、確定要件と解釈の区別、表示崩れの要素 × 状態 × viewport を確認する。
廃止対象に付随した表示の棚卸しと残す／消すの判断も照合する。
停止計画が impl サマリへ引き継がれたかも確認する。未実施は未確認として残す。
この時点では実 CI ログ・修正回数を要求せず、その判定は PR 作成後の 5-3 に置く。

- **NG** → 指摘を添えて `codex-impl-{n}` を共通起動手順で `harness-codex start` により再起動（軽微でも Claude は直さない）。指示には .harness/prompt-spec-{n}.md の「差し戻し時の項目」を含める。

### 5-2. 実動作の確認（UI 変更のとき）

`demo.output` の動画・スクショが存在し 0 バイトでないことを確認し、**サブエージェントに**受け入れ条件および要件メモの開始状態・操作順・終了状態・含めないものと
突き合わせさせて ✅/❌ を判定する。送る動画は**実アプリを実際に操作した録画**に限る（DOM 差し込み・
モック・加工で「それらしい」証跡を作らない）。途中操作欠落・範囲外の無断追加も ❌ とし、Codex に差し戻して修正/再録画を依頼する。指示には .harness/prompt-spec-{n}.md の「差し戻し時の項目」を含める。
サマリの録画時 full SHA と PR の現 head を照合し、**動画を撮ったhead＝現head** を確かめる。
違う/撮影head不明なら撮り直す。5-3 のコミット後、5-4 直前と完成後にも完成markerの full SHA と照合する。
ファイルの SHA-256 一致だけでは撮影headを証明できない（README の H3）。
はみ出し・表示崩れの修正では、設計で列挙した対象のボタン名・要素 × 状態 × viewport（幅・高さ）ごとに、
実アプリの動画・スクショを期待結果と照合する。

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

gate の終了1は Codex にコード修正を差し戻し（指示には .harness/prompt-spec-{n}.md の「差し戻し時の項目」を含める。）、終了2は設定を修正する。終了3は環境不備として
push/PR 作成を止める。ランナー停止・権限不足をコード修正へ差し戻さず、REAL の回数にも数えない。
自動解消できなければ `harness-phase {n} blocked --comment-file ...` で項目名・失敗理由・必要な対応を通知し、
解消後に gate 全体を再実行する。

PR を作ったら CI の結果を待つ（issue-loop 経由なら `subscribe_pr_activity` のイベントで、単体なら次の心拍で）。
CI が赤なら issue-loop の「CI red 対応」に従う。ただし、設計で停止ルール対象とした環境依存の失敗は、
PR CI の実ログに基づく修正1回で解消しなければ `harness-phase {n} blocked --comment-file ...` で人に返す。
「1回」は、同じ PR で対象の失敗後に push した修正コミットと、そのコミットに対する CI 結果から数える。
`gh pr view {PR} --json commits` でコミットを確認し、`gh pr checks {PR}` と、過去の結果が必要なら
`gh run list --commit <SHA>` / `gh run view <run-id> --log-failed` で対象の失敗と修正後の結果を照合する。
clear/resume 後も worker が読めるこの履歴から復元する。既存の `learning_add`（tag: `ci-red`。engine が無ければ
`.harness/failure-log.jsonl`）は記録先としてだけ使う。新しい計数の仕組みは作らない。この1回上限は issue-loop の
REAL 3回より優先する。失敗しているチェック・実ログの根拠・試した修正・残る判断を記す。
対象以外の CI red は従来どおりとし、**CI が green になってから**承認依頼を出す。

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
動画なしは `--file` を省く。フォアグラウンドで実行し、対象 Issue/PR/WT の終了値を保存し、**0 だけ**承認依頼済みと扱う。
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

先に対象 WT を解決し、`harness-inbox` の終了値と全 JSONL を確認する。`chat-merge-ok` は body と attention を引数として渡し、同じ tick でフェーズ進行より先に試す。即時配送も同じ入口を使う。

```bash
(cd "$WT" && harness-merge {n}) || exit 1              # PR 上の承認だけの場合
(cd "$WT" && harness-merge {n} --chat-approval "$BODY" --attention "$ATTENTION") || exit 1  # 保存済み回答を再照合
```

どちらか該当する一方だけを実行する。成功時だけ従来の done・`harness-codex stop`・worktree の片付けへ進む。
`harness-merge` が承認・head の一致・CI・mergeable を確認し、マージ後に `done`（ラベル除去）まで行う。
実 PR が MERGED かも確認し、merge queue への投入だけなら done/片付けを完了扱いしない。
確認できた成功時の片付けは従来どおり:

```bash
harness-codex stop codex-impl-{n} "$WT"   # worktree を消す前に（消した後は id を読めない）
git -C "$(harness-config --root)" worktree remove "$WT"
```

最新完成marker・ラベル・現 head・回答先 A の一致が全承認経路で必須。meta.attention 欠落は推測しない。
webhook は GitHub 承認だけ。engine の保存台帳を読めれば MCP 未接続でも tick で回収できる。
CI/mergeable/hook の拒否だけで同じ依頼/head なら、元の同じ A と台帳原文で再試行できる。
新 head/新依頼には新回答が必要。拒否理由に従って直す（迂回しない）。「🔵 マージ完了」の Discord 通知は、`done` の報告を受けた
engine が出すので、ここでは送らない。

**head 変更前の確認**: main 取り込み、rebase、amend、競合修正、CI red の Codex 再依頼の直前には inbox を再読取りする。
前 tick の空結果は使わない。GitHub NG を優先し、判定不能・走査非0なら head を変えない。
未処理 OK があればまず現 head で harness-merge を試す。CI 待ちだけなら同じ head/A のまま待つ。
衝突等で修正が必要な場合だけ、OK とその head で進めない理由を記録してから変更し、push/CI 後は Phase 5-4 で新 A を発行し新回答を待つ。
base の取り込みが必要なら、この確認と harness-merge の試行後に以下を実行する（`<base>` は harness-config の baseBranch、既定 main に置き換える）:

```bash
git -C "$WT" fetch origin && git -C "$WT" merge origin/<base>
```

衝突の解消は Codex に依頼し（共通起動手順で別 Bash の harness-codex start）、push 後は CI green を待って承認依頼をやり直す（Phase 5-4）。

失敗した tick 中に「Issue/PR・対象 head・回答 A（判明時）・具体的理由・次の確認/操作・確認時刻」を
私有一時ファイルへ書き、`gh issue comment --body-file` で Issue に残す。理由の正本は Issue。通知のURLは現在の依頼先PRコメントURLを使い、現在のA や marker 全文は表示しない。
認証 login 自身の同じ head/A/理由のコメントを再利用し、他者の同じキーでは抑制しない。
記録できなければローカル handoff に理由と記録失敗を残し、成功扱いしない。

### 承認回収の仕分けと共通通知

Step 0、tick、即時配送は逐次処理する。`harness-inbox` の終了値が非0なら部分 JSONL を採用しない。
- `merge-ng` は Phase 6 NG の既存処理。GitHub OK より台帳の非 OK 回答（resolvedAt）が新しければ `chat-not-approved` として共通通知へ回す。それ以外の `merge-ok` は GitHub の経路を優先し、台帳異常で新 A を作らない。
- `chat-merge-ok` は同じ tick の Phase 6。open A は回答待ちで通知も再依頼もしない。
- `missing-attention` は正常台帳と attentionSeq の確認後の実不在だけ。同じ WT で現在のレビュー・humanChecks・依頼本文を再構成して Phase 5-4 を実行する。
  動画がある案件は現 head と合意範囲を照合し必要なら撮り直す。終了0、新完成marker、新 A を確認する。旧 OK の付け替えは禁止。
- `attention-unavailable`（attention-seq-behind を含む）/`attention-mismatch` はその tick で再読取りし、home・設定・権限・scope を確認する。
  自動解消できなければ `harness-phase {n} blocked --comment-file ...` で必要な対応を通知する。missing とみなした自動再依頼はしない。
- pending＋復旧ファイルなしは異常で request-failed。pending＋復旧ファイルありは対象 phase の非0終了なら request-failed、終了0でも pending のまま、または終了値不明なら recovery-unconfirmed。
- **完成 marker＋復旧ファイル＋対象 phase の終了値なし**も recovery-unconfirmed として Phase 5-4 の失敗仕分けへ送り、自動解消できなければ blocked。
  確認済みの phase 非0終了・残留する復旧ファイル・通知失敗も同じ失敗仕分けへ進む。原因未解消のまま毎 tick 再依頼しない。

Phase 5-4 はフォアグラウンドなので実行中の tick 処理はない。通知後・完成 PATCH 前に届いた OK も終了を待ってから処理する。
対象 Issue/PR/WT の呼出しの終了値を `0 / nonzero / unknown` の明示引数で共通例へ渡す。再起動・clear 等で失ったら unknown とし、別 Issue や古い終了値を使わない。
終了0・完成marker・復旧ファイル消失後は同じ A/head の OK を回収し、info 0回・merge 1回。プロセス台帳は作らない。

`chat-not-approved`、実際に届いた chat の構造化拒否診断（stderr の kind=chat-rejection）、pending/復旧の失敗は以下の関数を使う。
入力は project、Issue、PR、拒否 A（不明なら unknown）、reason、現在の依頼 URL（不明なら既知 PR URL）、タイトル、対象 phase 終了値、request 状態（pending/completed/open/other）、WT の10引数。
番号/本文を eval やシェルコードへ変換せず、各引数で渡す。CLI の診断順だけで待機を決めず、復旧ファイルと終了値で仕分け直す。
戻り値0は通知済みまたは通知不要、3は Phase 5-4 の失敗仕分け、1は記録/通知未確認なので handoff を残して停止する。
同じキーの claimed/failed-or-unknown は自動再送せず、成否を確認して人に引き継ぐ。通知の再処理で merge を実行しない。
実際の chat を受けていない unavailable/mismatch は info へ流さず、上記の再確認と blocked に進む。

PR に GitHub で『OK』とコメントするか、窓口に『#n の承認依頼を出し直して』と頼む、の2つを出口として案内する。
後者は worker が Phase 5-4 で新 A を発行する。resolved の古い A への再入力や台帳の直接編集は促さない。非 OK だけで毎 tick 新 A を自動発行しない。
本文は trim 後、owners のリテラルな `<名前> が Discord で回答。` を先頭から1回だけ除き startsWith("OK") で判定する。
前置きの名前は Discord の表示名で、owners（GitHub login）と完全に一致するときだけ除く。表示名を変えると前置き付き回答は非 OK になり、上記の出口へ回る。
承認できる人は allowedUserIds で決まり、owners 限定はそれを絞らない。前置きなしの OK は表示名によらず本文判定を通る。

```bash
# CHAT_REJECTION_BEGIN
chat_rejection() (
  [ "$#" -eq 10 ] || exit 1
  project="$1" issue="$2" pr="$3" attention="$4" reason="$5" url="$6" title="$7" phase_exit="$8" request_state="$9" wt="${10}"
  [ -n "$project" ] && [ -n "$url" ] || exit 1
  [[ "$issue" =~ ^[1-9][0-9]*$ && "$pr" =~ ^[1-9][0-9]*$ ]] || exit 1
  case "$phase_exit" in 0|nonzero|unknown) ;; *) exit 1 ;; esac
  recovery=0 route=0
  for file in ".harness/merge-recovery-$issue.json" "$wt/.harness/merge-recovery-$issue.json"; do
    if [ -e "$file" ] || [ -L "$file" ]; then recovery=1; fi
  done
  if [ "$request_state" = pending ]; then
    route=3
    if [ "$recovery" = 0 ] || [ "$phase_exit" = nonzero ]; then reason="request-failed"; else reason="recovery-unconfirmed"; fi
  elif [ "$request_state" = completed ] && { [ "$recovery" = 1 ] || [ "$phase_exit" = nonzero ]; }; then
    route=3
    if [ "$phase_exit" = nonzero ]; then reason="request-failed"; else reason="recovery-unconfirmed"; fi
  fi
  [ "$request_state" != open ] || exit 0
  case "$reason" in
  ci-not-green|mergeable-unconfirmed|before-merge-failed) exit 0 ;;
  attention-open) sentence="台帳ではこの A-番号がまだ回答待ちになっている" ;;
  attention-missing) sentence="回答先の A-番号を確認できない" ;;
  invalid-arguments) sentence="承認確認に必要な引数が正しくない" ;;
  pr-unavailable) sentence="対象の PR を確認できない" ;;
  approval-unavailable) sentence="GitHub の承認依頼を読み取れない" ;;
  recovery-unconfirmed) sentence="承認依頼の復旧完了を確認できない" ;;
  request-failed) sentence="承認依頼が失敗したか、未完了のまま復旧記録が失われている" ;;
  github-ng) sentence="GitHub にマージへの NG がある" ;;
  request-pending) exit 1 ;;
  request-missing) sentence="有効な完成済みの承認依頼がない" ;;
  request-stale) sentence="承認依頼の head と現在の head が一致しない" ;;
  request-inactive) sentence="現在の Issue がマージ承認待ちではない" ;;
  attention-none) sentence="この依頼は A-番号を持たず、チャット承認を利用できない" ;;
  attention-stale) sentence="回答先の A-番号が現在の完成依頼と一致しない" ;;
  attention-unavailable) sentence="台帳または照合に必要な設定を読み取れない" ;;
  attention-seq-behind) sentence="読んでいる台帳の発行番号が承認依頼の A-番号に追い付いていない" ;;
  attention-not-found) sentence="回答先の A-番号が台帳に見つからない" ;;
  attention-scope-mismatch) sentence="回答の種類・プロジェクト・Issue・PR が対象の依頼と一致しない" ;;
  attention-superseded) sentence="同じ対象に、より新しい承認依頼がある" ;;
  answer-missing) sentence="台帳に回答本文が記録されていない" ;;
  resolved-at-missing) sentence="台帳に回答時刻が記録されていない" ;;
  invalid-time) sentence="台帳の依頼作成時刻または回答時刻が正しくない" ;;
  answer-before-created) sentence="回答時刻が A-番号の作成時刻より前になっている" ;;
  answer-not-ok) sentence="本文の先頭が OK ではない" ;;
  approval-changed) sentence="マージ直前の再確認で依頼または回答が変わった" ;;
  *) exit 1 ;;
  esac
  subject="unknown" display="A 不明"
  if [[ "$attention" =~ ^A-[1-9][0-9]*$ ]]; then subject="$attention"; display="$attention"; fi
  key="$(jq -nc --arg project "$project" --arg issue "$issue" --arg pr "$pr" --arg subject "$subject" --arg reason "$reason" '["chat-rejection-v1",$project,$issue,$pr,$subject,$reason]')" || exit 1
  login="$(gh api user --jq .login)" || exit 1
  [ -n "$login" ] || exit 1
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || exit 1
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
  temp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$temp"' EXIT
  read_comments() {
    gh api --paginate --slurp "repos/$repo/issues/$issue/comments" > "$temp/comments.json" || return 1
    jq -e 'type == "array" and all(.[]; type == "array")' "$temp/comments.json" >/dev/null
  }
  read_comments || exit 1
  existing="$(jq -r --arg login "$login" --arg key "$key" '
    [.[][] | select(.user.login == $login) | .body | split("\n")[]
     | capture("^<!-- harness:chat-rejection (?<record>.*) -->$")? | .record | fromjson?
     | select(.key == $key) | .state] | first // empty' "$temp/comments.json")" || exit 1
  if [ -n "$existing" ]; then
    [ "$existing" = posted ] || exit 1
    exit "$route"
  fi
  printf -v body '#%s / PR #%s: %s / %s: %s。現在の依頼: %s。現在の完成依頼を確認し、PR に GitHub で『OK』とコメントするか、窓口に『#%s の承認依頼を出し直して』と頼む。' "$issue" "$pr" "$display" "$reason" "$sentence" "$url" "$issue"
  make_body() {
    marker="$(jq -nc --arg key "$key" --arg state "$1" '{key:$key,state:$state}')" || return 1
    jq -n --arg body "$body" --arg marker "$marker" '{body:($body+"\n\n<!-- harness:chat-rejection "+$marker+" -->")}' > "$temp/body.json"
  }
  make_body claimed || exit 1
  claimed="$(gh api "repos/$repo/issues/$issue/comments" --method POST --input "$temp/body.json")" || exit 1
  id="$(jq -er --arg login "$login" 'select(.user.login == $login and (.id | type == "number") and .id > 0 and .id == (.id | floor)) | .id' <<<"$claimed")" || exit 1
  read_comments || exit 1
  jq -e --arg login "$login" --argjson id "$id" --slurpfile expected "$temp/body.json"     'any(.[][]; .id == $id and .user.login == $login and .body == $expected[0].body)' "$temp/comments.json" >/dev/null || exit 1
  state="failed-or-unknown"
  if result="$(harness-notify --json --event info --title "$title" --project "$project" --issue "$issue" --pr "$pr" --url "$url" --body "$body")"; then
    if jq -e '.status == "posted"' <<<"$result" >/dev/null; then state=posted; fi
  fi
  make_body "$state" || exit 1
  updated="$(gh api "repos/$repo/issues/comments/$id" --method PATCH --input "$temp/body.json")" || exit 1
  jq -e --arg login "$login" --argjson id "$id" --slurpfile expected "$temp/body.json"     '.id == $id and .user.login == $login and .body == $expected[0].body' <<<"$updated" >/dev/null || exit 1
  [ "$state" = posted ] || exit 1
  exit "$route"
)
# CHAT_REJECTION_END
```

**人間が GitHub の画面から直接マージした場合**: Issue は `closes #{n}` で閉じるが、ラベルと worktree が残る。
Step 0 で「closed なのに `harness:*` ラベルが残っている Issue」を見つけたら、`harness-phase {n} done` と
worktree・tmux ウィンドウの片付けだけを行う。

### NG（`merge-ng` / 承認待ち中のコメント）

1. PR は閉じない。worktree も残す
2. `learning_add`（tag: `user-ng`）で記録する（自己改善の材料）。engine が無い環境では `.harness/failure-log.jsonl` に1行追記:
   `jq -nc --arg ts "$(date -u +%FT%TZ)" --argjson issue {n} --arg tag user-ng --arg summary "..." --arg detail "..." '{ts:$ts,issue:$issue,tag:$tag,summary:$summary,detail:$detail,promoted:false}' >> "$(harness-config --root)/.harness/failure-log.jsonl"`
3. 指摘を添えて `codex-impl-{n}` を共通起動手順で `harness-codex start` により再起動し、`harness-phase {n} impl-review` で Phase 5 へ戻す。
   指示には .harness/prompt-spec-{n}.md の「差し戻し時の項目」を含める。

## Codex 起動を blocked にする

権限拒否・`reason=launch-failed`・判別不能は、観測した層と秘密を除いた理由を本文へ書き、
起動とは別の Bash で `harness-phase {n} blocked --comment-file ... --summary ...` を呼ぶ。
通知失敗なら未遷移であり、blocked 完了としない。ラベルを直接変更しない。
`loop_meta.codex_unavailable` は利用不可専用で、権限拒否の解除には使わない。

以下は人が貼る起動1行を準備して通知する例であり、自動再試行には使わない。
`WT` を解決し、`CODEX_STAGE` を拒否された段階（設計 `spec`、実装 `impl`）、
`CODEX_REASON` を `tool-denied` / `launch-failed` / `unknown` のいずれかに設定してから実行する。
実際の理由の補足も秘密・生ログ・ホーム絶対パスを含めずに記す。
設定・入口・依頼が欠損する場合、この例は通知前に止まる。不足を本文へ書いて既存の blocked 入口で依頼し、
実在しない設定指定や起動1行を捏造しない。

ホーム末尾の `/` を除き、論理 `$HOME` と `realpath "$HOME"` の両方を接頭辞候補にする。
引用前にディレクトリ境界で接頭辞を外し、残りだけを `%q` で引用して `"$HOME"/…` へ連結する。
本文の説明も同じ表記にする。Markdown がバックスラッシュを消さないよう、本文・Discord summary の両方で
同じ起動1行をフェンスのコードブロックに入れる（インラインコードにしない）。

````bash
# CODEX_BLOCKED_BEGIN
case "$CODEX_STAGE" in spec|impl) ;; *) exit 1 ;; esac
case "$CODEX_REASON" in tool-denied|launch-failed|unknown) ;; *) exit 1 ;; esac
home_prefix="$HOME"
while [ "$home_prefix" != / ] && [ "${home_prefix%/}" != "$home_prefix" ]; do
  home_prefix="${home_prefix%/}"
done
IFS= read -r -d '' real_home < <(realpath -z "$home_prefix") || exit 1
quote_home() {
  local value="$1" prefix remainder quoted
  for prefix in "$home_prefix" "$real_home"; do
    if [ "$value" = "$prefix" ]; then
      printf '"$HOME"'
      return
    fi
    case "$value" in
    "${prefix%/}/"*)
      remainder="${value#"${prefix%/}/"}"
      printf -v quoted '%q' "$remainder"
      printf '"$HOME"/%s' "$quoted"
      return
      ;;
    esac
  done
  printf '%q' "$value"
}
config_path="$(harness-config --path)" || exit 1
config_path="$(realpath "$config_path")" || exit 1
[ -s "$config_path" ] || exit 1
codex_entry="$(command -v harness-codex)" || codex_entry="${CLAUDE_PLUGIN_ROOT:-}/bin/harness-codex"
codex_entry="$(realpath "$codex_entry")" || exit 1
[ -x "$codex_entry" ] || exit 1
WT="$(realpath "$WT")" || exit 1
window="codex-$CODEX_STAGE-{n}"
prompt_path="$WT/.harness/prompt-$CODEX_STAGE-{n}.md"
[ -s "$prompt_path" ] || exit 1
config_q="$(quote_home "$config_path")"
entry_q="$(quote_home "$codex_entry")"
wt_q="$(quote_home "$WT")"
prompt_q="$(quote_home "$prompt_path")"
printf -v window_q '%q' "$window"
human_line="HARNESS_CONFIG=$config_q $entry_q start $window_q $wt_q $prompt_q"
blocked_file="$WT/.harness/codex-blocked-{n}.md"
{
  printf 'Issue #%s / %s\n理由: %s（起動停止。代行・迂回・自動再試行なし）\n' '{n}' "$CODEX_STAGE" "$CODEX_REASON"
  printf '実効設定: %s\n入口: %s\nworktree: %s\n依頼: %s\n' "$config_q" "$entry_q" "$wt_q" "$prompt_q"
  printf '\n同じユーザー・同じ tmux サーバーに接続した Bash で実行してください。\n\n```bash\n%s\n```\n' "$human_line"
  printf '\n起動結果を同じ blocked の回答先へ返してください。回答・status・workdir・成果物を確認して元の段階へ復帰します。\n'
} > "$blocked_file"
printf -v blocked_summary 'Codex 起動停止: %s\n\n```bash\n%s\n```' "$CODEX_REASON" "$human_line"
harness-phase {n} blocked --comment-file "$blocked_file" --summary "$blocked_summary" || exit 1
# CODEX_BLOCKED_END
````

人は既存 engine と同じユーザー・同じ tmux サーバーに接続した Bash ターミナルで起動する。
カスタム socket・PATH・配置の違いがあれば接続先を確認して案内し直す。人が既に実行した可能性があるときは
`.id` と status を先に確認し、二重起動しない。設定内容・認証値・依頼本文は公開本文へ貼らない。
人の回答後、worker は status・正しい cwd・成果物を確認し、元の designing/implementing または対応する review へ
`harness-phase` で戻す。成果物や login check の成功だけで blocked を自動解除しない。
blocked 中の tick で起動や通知を繰り返さず、人の回答を待つ。

## フォールバック: Codex が使えない（自動で Claude に切り替える）

exit 10 一律ではなく reason と監視結果で、次の場合だけ「Codex 利用不可」と判断する。
全起動・再起動は共通起動手順を通す。

- `harness-codex-status check` / `harness-codex start` が exit 10 かつ `reason=not-installed` / `not-logged-in`
- 監視中に usage limit・認証切れ・起動直後の即終了（`exited:*` で原因が認証か limit）を確認した

動作:

1. `harness-notify --event info --title "Codex が使えないため Claude で進めます（#{n}）" --url <Issue の URL> --body "<reason と対処（codex login・復帰時刻）>"`
   を**同じ原因につき一度だけ**出す（`handoff.md` の `loop_meta.codex_unavailable: <reason>@<時刻>` に記録し、
   `harness-codex-status check` が 0 になるまで再通知しない）。info なので人の返事は待たず、blocked にもしない。
   Codex が制限で止まっているなら Claude 側に余裕があるはず、という前提で待たずに切り替える
2. 動いていた `codex-*-{n}` ウィンドウは `harness-codex stop <window> "$WT"` で片付ける。実装の途中（usage limit など）で
   切り替えるときは、worktree の**未コミット差分をそのまま残し**（`git checkout`・`stash` で消さない）、
   `harness-implementer` に「続きから」と渡す
3. 設計・実装を `harness-implementer` サブエージェント（このプラグインの agent）に委譲する。
   渡すのは Issue 番号・`$WT`・入出力ファイルのパスだけ。
   設計時は生成済みの `$WT/.harness/prompt-spec-{n}.md` も必ず渡し、同じ依頼とチェックリストに従わせる。
   実装時は `$WT/.harness/prompt-impl-{n}.md` と `$WT/.harness/prompt-spec-{n}.md` の両方を渡す
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
