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
- **パッケージマネージャ**: CI が実際に使っているもの（lockfile が複数あっても CI に合わせる）
- **既定ブランチ**・マージの方法（merge / squash の慣習）
- **規約・仕様のファイル**: CLAUDE.md・AGENTS.md・README・仕様書
- **UI があるか**・録画で受け入れ条件を確かめられるか
- **自動では確かめられないもの**: 実機・特定 OS・外部機器・本番環境など
- worker が無人で使うことになるコマンド（テスト・ビルド・パッケージマネージャなど）

## 2. 進め方を決める

| 状況 | mode |
|---|---|
| リポジトリ独自のループが既にあり、それで回っている | `native`（そのループをそのまま使う。ハーネスの設定もガードも使わない） |
| それ以外 | `harness`（`/discord-loop-engine:issue-loop` で進める） |

迷ったら native にしない（独自のループが「Issue → 設計 → 実装 → PR → 人の承認でマージ」を自分で回せる場合だけ）。

### harness の場合: 設定の案を作る

`profile_template` ツールで雛形と調査済みの例を受け取り、その形で作る。

- `gate`: **CI と同じ検査を同じ順で**。1つずつ実際に main で一度走らせ、通るか確かめる
  （もともと赤いものがあれば、案の要約にそう書く）
- `setup`: worktree を作った直後に要るもの（依存のインストールなど）
- `context`: 実在する規約・仕様のファイルだけ
- `notes`: 規約ファイルが無い・足りないときの、このプロジェクトの決まりごと（Codex とレビュー役が読む）
- `permissions`: worker が確認なしで使ってよいコマンド（`Bash(npm:*)` など。広げすぎない）
- `humanChecks`: 自動では確かめられないもの
- `demo`: 録画の手順が既にあるときだけ。無ければ `null`
- `specRecordDir`: 設計記録を PR に含める慣習がリポジトリにあるときだけ。無ければ `null`

## 3. 確認を求める

```
profile_propose（mode・profile または initial_prompt / tmux_session・summary）
```

`summary` には、調べて分かったこと・mode をそう決めた理由・自動では確かめられないこと・
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
