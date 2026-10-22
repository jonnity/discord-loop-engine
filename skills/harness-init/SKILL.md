---
name: harness-init
description: プロジェクトに discord-loop-engine（issue-loop）を導入する。.claude/harness.json の作成、プラグインの有効化設定、harness:* ラベル作成、CI 側の Discord 通知ワークフロー、Issue テンプレート、.gitignore を整える。導入作業も Issue → worktree → PR の通常フローで行う。
---

# harness-init

新しいプロジェクトにハーネスを入れる手順。discord-loop-engine の `templates/` を元にする
（`${CLAUDE_PLUGIN_ROOT}/templates/`）。

## 1. プロジェクトを調べる（サブエージェントに任せてよい）

- パッケージマネージャ（lockfile と CI が実際に使っているもの）、テスト・型チェック・lint・E2E のコマンド
- CI のワークフロー名とジョブ内容（`gate` は **CI と同じ検査を同じ順で**並べる）
- UI があるか、録画で受け入れ条件を確かめられるか（`demo`）
- 自動では確認できないもの（実機・特定 OS・外部機器など → `humanChecks`）
- 仕様書・規約ファイル（`context`）

## 2. ファイルを用意する

| ファイル | 内容 |
|---|---|
| `.claude/harness.json` | `templates/harness.json` を元に埋める。`project` は Discord に出る名前 |
| `.claude/settings.json` | 下記のプラグイン有効化と権限 |
| `CLAUDE.md` / `AGENTS.md` | 無ければ作る。AGENTS.md は Codex が読む（規約・コマンド・やらないこと） |
| `.github/workflows/harness-notify.yml` | `templates/harness-notify.yml`（CI のワークフロー名を合わせる） |
| `.github/ISSUE_TEMPLATE/task.yml` | `templates/ISSUE_TEMPLATE/task.yml` |
| `.gitignore` | `.worktrees/` `.harness/` と demo の出力先 |

`.claude/settings.json`:

```json
{
	"extraKnownMarketplaces": {
		"discord-loop-engine": { "source": { "source": "github", "repo": "jonnity/discord-loop-engine" } }
	},
	"enabledPlugins": { "discord-loop-engine@discord-loop-engine": true },
	"permissions": {
		"allow": [
			"Bash(codex*)", "Bash(tmux:*)", "Bash(git:*)", "Bash(gh:*)",
			"Bash(harness-config:*)", "Bash(harness-phase:*)", "Bash(harness-inbox:*)",
			"Bash(harness-gate:*)", "Bash(harness-merge:*)", "Bash(harness-notify:*)",
			"Bash(harness-status:*)", "Bash(harness-labels:*)"
		]
	}
}
```

（npm / pnpm / cargo などプロジェクトのコマンドも `allow` に足す。）

## 3. GitHub 側の設定（人間に頼むもの）

- リポジトリ Secrets に `DISCORD_WEBHOOK_URL`（全プロジェクト共通のチャンネルの webhook）
- discord-loop-engine が private の場合: discord-loop-engine の Settings → Actions → General → Access で
  「Accessible from repositories owned by the user」を有効にする（composite action を使うため）
- ローカルでループを回すマシンでは `DISCORD_WEBHOOK_URL` を環境変数か `notify.envFiles` の .env に置く

## 4. ラベルと疎通確認

```bash
harness-labels
harness-notify --event info --title "ハーネスを導入しました" --url "https://github.com/<owner>/<repo>"
```

Discord に `[<project>] ℹ️ お知らせ｜…` が届くことをユーザーに確認してもらう。

## 5. PR

導入の変更も Issue → ブランチ → PR で入れる。PR 本文に、ユーザーにやってもらう設定（Secrets 等）を
チェックリストで書く。
