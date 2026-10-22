# discord-loop-engine

ローカルで起動しておくと、指定したリポジトリの中で Claude Code が Issue 駆動の開発ループを回し続けるエンジン。
あなたが話す相手は Discord 上の**窓口**1つだけで、窓口がすべてのプロジェクトのタスクを台帳ファイルで覚え、
「今なにが動いているか」「あなたが対応すべきことは何か」をいつでも答えます。

```
Discord 共通チャンネル ── Bot ──▶ engine（ローカル常駐）──▶ 窓口（Sonnet・あなたと話すのはここだけ）
        ▲                          │  タスク台帳（ファイル）       │ 依頼・回答
        │ A-番号の依頼・ボード        └──────────────▶ worker: kishimen-tool（issue-loop ＋ Codex）
        │                                           worker: oogiri-doc
        └── CI の結果（GitHub Actions の webhook）
```

- **窓口（concierge）**: 依頼を Issue とタスクにして worker に振る。状況に答える。あなた待ち（A-番号）を管理する。
  コードは書かず、マージもしない。迷ったら相談役の **advisor（Opus）** に聞く
- **worker**: リポジトリごとに1つ。`issue-loop` で Issue を進める（設計・実装は Codex を tmux で、レビューは Claude）。
  あなたとは直接話さない
- **engine**: Discord との接続（Bot は中継だけ）、窓口と worker の起動・再起動、台帳の記録、
  人の判断が要る報告への A-番号付けと投稿、ボードの更新
- **タスク台帳**: `~/.discord-loop-engine/` の Markdown / JSON。窓口がやり直しても、マシンを再起動しても続きが分かる
- **自己改善**: うまくいかなかったことを記録 → 振り返り → 仮ルール（すぐ効く）→ 正式な改善 PR（あなたの OK が要る）
- **マージには必ずあなたの OK が要る**

## 必要なもの

Linux か WSL2。Node 24 LTS（22.18 以上でも動く）、tmux、git、jq、[GitHub CLI](https://cli.github.com/)（`gh auth login` 済み）、
Claude Code、Codex CLI。`dle doctor` でまとめて確認できます。

## セットアップ

### 1. Discord の Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token でトークンを控える
2. Bot → Privileged Gateway Intents → **Message Content Intent** を有効にする
3. OAuth2 → URL Generator: scope `bot`、権限 View Channels / Send Messages / Send Messages in Threads /
   Read Message History / Add Reactions / Attach Files / Manage Messages（ボードのピン留め）→ 生成した URL で招待する
4. Discord の設定 → 詳細設定 → 開発者モードを有効にし、共通チャンネルの ID と自分のユーザー ID をコピーする

### 2. engine を入れる

```bash
git clone https://github.com/jonnity/discord-loop-engine ~/discord-loop-engine
ln -s ~/discord-loop-engine/bin/dle ~/.local/bin/dle   # PATH の通った場所に
dle init        # ~/.discord-loop-engine/config.json と .env の雛形を作る
```

`config.json` の `channelIds`・`allowedUserIds` を埋め、`.env` に `DISCORD_BOT_TOKEN=...` を書きます。

### 3. Claude Code にプラグインを入れる

```
/plugin marketplace add jonnity/discord-loop-engine
/plugin install discord-loop-engine@discord-loop-engine
```

### 4. 起動してリポジトリを追加する

```bash
dle doctor
dle up                              # tmux の dle セッションで常駐
dle add jonnity/kishimen-tool       # ~/dle/workspaces/ に clone（パスを渡せば既存の場所を使う）
```

窓口に「kishimen-tool もやって」と話しかけても追加できます。初回だけ `tmux attach -t dle` で各ウィンドウを開き、
フォルダの信頼と MCP サーバーの承認に答えてください（開発用 channel の警告には engine が自動で答えます）。

`.claude/harness.json` が無いリポジトリは、最初のタスクが「ハーネスの導入」になります（その PR もあなたの OK 待ち）。

## 使い方

Discord の共通チャンネルで窓口に話しかけるだけです。

| こう書く | 起きること |
|---|---|
| 「kishimen-tool の採点バグ直して」 | 窓口が Issue を起票し、タスクにする。worker が拾って進める |
| 「今どう？」「何すればいい？」 | ボードとあなた待ちを返す |
| 「A-4 OK」/ 通知に返信して「OK」 | その承認依頼への回答として worker に届き、worker がマージする |
| 「A-3 は B で」 | 要件確認への回答として worker に届く（Issue にも記録される） |

ピン留めの **ボード** に、あなた待ち・作業中・次に着手が常に出ています。

### コマンド

| コマンド | 用途 |
|---|---|
| `dle up` / `dle down` | 常駐の開始・停止（窓口と worker のセッションは止めない） |
| `dle status` | engine・Discord・セッションの状態とボード |
| `dle add <owner/repo またはパス>` | リポジトリを登録（worker が自動で起動） |
| `dle tasks [--all]` / `dle attention` / `dle board` | 台帳を見る |
| `dle restart <concierge またはプロジェクト名>` | セッションを起動し直す |
| `dle doctor` | 必要なものが揃っているか |

## 設定（`~/.discord-loop-engine/config.json`）

| キー | 既定 | 内容 |
|---|---|---|
| `channelIds` | — | 中継するチャンネル（先頭が投稿先） |
| `allowedUserIds` | — | 発言を受け取る人（あなただけにする） |
| `concierge.model` | `sonnet` | 窓口のモデル |
| `worker.model` / `worker.extraArgs` | — | worker のモデルと追加の起動引数（例: `["--permission-mode", "acceptEdits"]`） |
| `workspaceDir` | `~/dle/workspaces` | `dle add owner/repo` の clone 先 |
| `retro` | 5 件 / 7 日 / 3 回 | 振り返りの頻度と、仮ルールにする再現回数（仮置き。振り返りで見直す） |
| `permissionRelay` | `false` | 許可の確認に Discord から `yes <id>` で答えられるようにする |
| `board.enabled` | `true` | ボードのピン留め |

## 台帳（`~/.discord-loop-engine/`）

```
projects.json          登録したリポジトリ
tasks/T-0007.md        1タスク1ファイル（経緯つき）
attention.json / .md   あなた待ち（A-番号）
board.md               ボード
journal/2026-10-22.md  起きたことの時系列
learnings/             自己改善（failures.jsonl・rules.md）
outbox/                起動していないセッション宛ての指示（起動したら渡す）
```

## 注意

- Claude Code の channels はリサーチプレビューです。自作の channel を使うため `--dangerously-load-development-channels`
  で起動しています。仕様が変わったら engine の起動コマンドと channel を直します
- Team / Enterprise の組織アカウントでは、管理者が channels を有効にする必要があります（個人の Pro / Max なら不要）
- 届くのはセッションが動いている間だけです。窓口が止まっている間の発言は保存しておき、起動したら渡します

## 開発

```bash
npm install
npm test            # node --test（engine）＋ tests/harness/run.sh（ハーネスのスクリプト）
npm run typecheck
npm run check       # Biome
```

engine は TypeScript をビルドせず、Node の型ストリップでそのまま実行しています。
ハーネス（`bin/harness-*`）は bash です。
