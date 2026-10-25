---
name: onboard
description: discord-loop-engine に登録されたばかりのリポジトリを調べ、ループの進め方（issue-loop の設定か、リポジトリ独自のループか）を決めて、A-番号で人に確認してから確定する。設定が無いプロジェクトの worker が最初に行う。リポジトリには何もコミットしない。
---

# onboard（プロジェクトの調査と設定）

登録されたリポジトリで、これからどうループを回すかを決める。決めた設定は **engine 側**
（`~/.discord-loop-engine/projects/<名前>/harness.json`）に保存され、リポジトリには何も置かない。

> ⚠️ この作業ではリポジトリにコミットしない・PR を作らない。調べるだけ。
> 設定の案は `profile_propose` で出し、人の OK をもらってから `profile_activate` で確定する。

## 1. 調べる（サブエージェントに任せ、結論だけ受け取る）

- **既に独自のループがあるか**: `.claude/skills/` や `.claude/commands/` に、Issue を拾って設計・実装・PR まで
  回す仕組み（例: `parallel-cycle-loop`）があるか。CLAUDE.md にその運用が書かれているか。
  あれば、それを始めるコマンドと、そのスクリプトが前提にしている tmux セッション名
  （`tmux ... -t <名前>:` のような記述）を控える
- **CI**: `.github/workflows/` のジョブと、検査の順番（lint・型・テスト・E2E・ビルドなど）
- **self-hosted ランナー**: CI の `runs-on`、必要な OS/ラベル・オンライン最低台数（既定1、複数なら根拠）、
  リポジトリ/組織の runner API を既存権限で読めるか。online と idle を分け、runner 名・認証値は通知しない
- **連動するエコシステム**: npm/cargo 等の依存名・版の対応・双方の manifest/lockfile・更新ルールと確認コマンドを調査する。
  実装を調べずに版の一致を決めつけず、固有知識を notes に提案する
- **録画の道具**: 既存 demo の録画コマンドと成果物、ffprobe の有無・ffmpeg の libx264/AAC 機能を調べる
- **パッケージマネージャ**: CI が実際に使っているもの（lockfile が複数あっても CI に合わせる）
- **既定ブランチ**・マージの方法（merge / squash の慣習）
- **規約・仕様のファイル**: CLAUDE.md・AGENTS.md・README・仕様書
- **UI があるか**・録画で受け入れ条件を確かめられるか
- **自動では確かめられないもの**: 実機・特定 OS・外部機器・本番環境など
- worker が無人で使うことになるコマンド（テスト・ビルド・パッケージマネージャなど）
- **このマシンの worker がコミットできるか**: `[ -n "${GIT_AUTHOR_EMAIL:-}" ] || git -C <repo> config user.email`
  （engine の設定の作者は環境変数で渡るため、`git config` だけでは見えない。両方を見る）。どちらも空なら、
  次の「確認を求める」の `summary` に「このマシンの worker はコミットできない（git の作者が未設定）。
  `~/.discord-loop-engine/config.json` の `git`（name・email）を設定して `dle restart <名前>`」と書く。
  メールアドレスの値は summary に書かない

## 2. 進め方を決める

| 状況 | mode |
|---|---|
| リポジトリ独自のループが既にあり、それで回っている | `native`（そのループをそのまま使う。ハーネスの設定もガードも使わない） |
| それ以外 | `harness`（`/discord-loop-engine:issue-loop` で進める） |

迷ったら native にしない（独自のループが「Issue → 設計 → 実装 → PR → 人の承認でマージ」を自分で回せる場合だけ）。

**引数が `harness` のとき**（`dle add --harness` や `dle mode <名前> harness` で人が決めている）は、この表で
決めない。独自のループがあっても harness で進め、下の「独自のループから固有の手順を写す」に従う
（native の案は engine が受け付けない）。

### harness の場合: 設定の案を作る

`profile_template` ツールで雛形と調査済みの例を受け取り、その形で作る。

- `preflight`: 環境の前提確認を `{name, run}[]` で提案する。不要なら `[]`。
  self-hosted なら下の正本のコマンドを対象 API・ラベル・最低台数に合わせて run に入れる。
  存在しないスクリプトへの参照や認証値を入れない。API が読めなければ未確定と必要な権限を summary に記す
- `gate`: **CI と同じ検査を同じ順で**。1つずつ実際に main で一度走らせ、通るか確かめる
  （もともと赤いものがあれば、案の要約にそう書く）
- `context`: 実在する規約・仕様のファイルだけ
- `notes`: 規約ファイルが無い・足りないときの、このプロジェクトの決まりごと（Codex とレビュー役が読む）
- `hooks`: リポジトリ固有の手順を、ループの決まった位置に差し込む（どれもコマンドの配列。最初の失敗で止まる。
  `{n}` `{pr}` `{worktree}` `{main}` が使える）
  - `afterWorktree`: worktree を作った直後（依存のインストール、gitignore された `.env` などの symlink）
  - `beforePR`: CI と同じ検査（gate）の後に回す、リポジトリ独自の PR 前検査（例: `pnpm ci:local`）
  - `onCIRed`: CI が赤くなったときの仕分け。終了コード 0 = コード起因ではなく対処済み（再実行した等）、
    0 以外 = コード起因。リポジトリに仕分けのスクリプトがあるときだけ
  - `beforeMerge`: マージ前の確認（例: 静的解析の新しい指摘が 0 であること）
  - 規約ファイルに「PR 前に必ず〜」「マージ前に〜を確認」などがあれば、ここに写す。無ければ書かない
- `permissions`: worker が確認なしで使ってよいコマンド（`Bash(npm:*)` など。広げすぎない）。
  Codex の起動（`harness-codex` / `tmux new-window` / `codex exec`）の許可は**足さない**（権限判定が拒否したときは
  issue-cycle が info で知らせて Claude に切り替える。判定を回避する許可を雛形で配らない）
- `humanChecks`: 自動では確かめられないもの
- `demo`: 録画の手順が既にあるときだけ。無ければ `null`
- `specRecordDir`: 設計記録を PR に含める慣習がリポジトリにあるときだけ。無ければ `null`

### self-hosted の preflight コマンド例（正本）

`RUNNER_API` は調査した `repos/<owner>/<repo>/actions/runners` または `orgs/<org>/actions/runners`、
`REQUIRED_LABELS` は必要ラベルの JSON 配列、`MIN_ONLINE` は正整数で設定する。
これらの非秘密値の代入と次の本文をまとめて run に入れる。リポジトリにスクリプトを置く必要はない。
ページごとの応答を全件集計し、全ラベル一致の online を数える。busy でも online に含め、idle は別に示す。
API/解析エラー（終了2）をオンライン不足/0台（終了1）に置き換えない。

```bash
# RUNNER_CHECK_BEGIN
set -uo pipefail
[[ "$MIN_ONLINE" =~ ^[1-9][0-9]*$ ]] || exit 2
jq -en --argjson labels "$REQUIRED_LABELS" '$labels | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' >/dev/null 2>&1 || exit 2
pages="$(gh api --paginate "$RUNNER_API" 2>/dev/null)" || { echo 'runner API を確認できません（権限・接続を確認）' >&2; exit 2; }
counts="$(jq -ser --argjson labels "$REQUIRED_LABELS" '
  if length == 0 or any(.[]; (.runners | type) != "array") then error("invalid runners") else
    [.[] | .runners[] | select(.status == "online") |
      select((([.labels[].name] as $actual | $labels - $actual) | length) == 0)] |
    "online=\(length) idle=\([.[] | select(.busy == false)] | length)"
  end' <<<"$pages" 2>/dev/null)" || { echo 'runner API の解析に失敗しました' >&2; exit 2; }
echo "$counts"
online="${counts#online=}"; online="${online%% *}"
[ "$online" -ge "$MIN_ONLINE" ] || exit 1
# RUNNER_CHECK_END
```

設定案は preflight→gate→hooks.beforePR の順で一度実行する。既存プロジェクトの設定は自動で書き換えず、
再調査による設定案を profile_propose/activate で確認してから反映する。

### 独自のループから固有の手順を写す（引数が `harness` のとき）

独自のループ（例: `.claude/skills/` の parallel-cycle-loop）を、dle の issue-loop に置き換えるための調査。
独自のループのスキルを読み、**ループの本体ではなく、そのリポジトリ固有の手順**を拾って設定に写す:

| 独自のループにあるもの | 写す先 |
|---|---|
| worktree を作った後の手順（`.env` の symlink・依存のインストール） | `hooks.afterWorktree` |
| PR 前に必ず通す検査（`pnpm ci:local` など） | `gate`（CI と同じ部分）と `hooks.beforePR`（それ以外） |
| CI が赤いときの仕分けスクリプト | `hooks.onCIRed` |
| マージ前の確認（静的解析の指摘 0 など） | `hooks.beforeMerge` |
| 規約・設計記録の置き場所 | `context`・`specRecordDir` |
| 自動では確かめられないこと | `humanChecks` |

Issue の拾い方・Codex への委譲・心拍・人への確認は issue-loop が持っているので、写さない。
独自のループのスキルはリポジトリに残したまま（消すかどうかは、dle で1周回ったのを確かめてから人が決める）。
summary には、何をどこに写したかと、写さなかったもの（とその理由）を書く。

## 3. 確認を求める

```
profile_propose（mode・profile または initial_prompt / tmux_session・summary）
```

`summary` には、調べて分かったこと・mode をそう決めた理由・自動では確かめられないこと・
（コミットできないときは）その旨・
「リポジトリには何も置かない」ことを短く書く。engine が A-番号（設定の確認）で Discord に出す。

## 4. 回答を受けたら

回答は `<channel source="dle">` に `meta.attention`・`meta.kind=setup` で届く。

- **OK** → `profile_activate` で確定する。続けて
  - harness: `/discord-loop-engine:issue-loop` を始める（Skill ツールで呼ぶ）
  - native: 確定した `initial_prompt` のスキル・コマンドを始める
  - `permissions` は次の起動から効く。必要なら窓口経由で `dle restart <名前>` を頼む
- **NG・指摘** → 直して、もう一度 `profile_propose`（古い依頼は自動で置き換わる）

## やらないこと

- リポジトリへのコミット・PR・ファイルの追加（`.gitignore` も触らない。作業用ディレクトリは engine が
  `.git/info/exclude` に入れてある）
- 確認をもらう前に確定すること
