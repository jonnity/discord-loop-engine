# discord-loop-engine

ローカルで起動しておくと、指定したリポジトリの中で Claude Code が Issue 駆動の開発ループを回し続けるエンジン。
あなたが話す相手は Discord 上の**窓口**1つだけで、窓口がすべてのプロジェクトのタスクを台帳ファイルで覚え、
「今なにが動いているか」「あなたが対応すべきことは何か」をいつでも答えます。

```
Discord 共通チャンネル ── Bot ──▶ engine（ローカル常駐）──▶ 窓口（Sonnet・あなたと話すのはここだけ）
        ▲                          │  タスク台帳（ファイル）       │ 依頼・回答
          A-番号の依頼・ボード        └──────────────▶ worker: kishimen-tool（issue-loop ＋ Codex）
          CI 失敗・マージ完了         │  CI の監視（gh）            worker: oogiri-doc（リポジトリ独自のループ）
```

**対象のリポジトリには何も置きません。** `dle add` するだけで、worker がリポジトリを調べて進め方の案を出し、
あなたの OK をもらってから回り始めます。設定は engine 側（`~/.discord-loop-engine/projects/`）に保存されます。

- **窓口（concierge）**: 依頼を Issue とタスクにして worker に振る。状況に答える。あなた待ち（A-番号）を管理する。
  コードは書かず、マージもしない。迷ったら相談役の **advisor（Opus）** に聞く
- **worker**: リポジトリごとに1つ。`issue-loop` で Issue を進める（設計・実装は Codex を tmux で、レビューは Claude）。
  既に独自のループを持つリポジトリ（oogiri-doc の `/parallel-cycle-loop` など）は、そのループをそのまま使う（native モード）。
  あなたとは直接話さない
- **engine**: Discord との接続（Bot は中継だけ）、窓口と worker の起動・再起動、台帳の記録、
  人の判断が要る報告への A-番号付けと投稿、ボードの更新、各リポジトリの CI の監視とマージ完了の通知
- **タスク台帳**: `~/.discord-loop-engine/` の Markdown / JSON。窓口がやり直しても、マシンを再起動しても続きが分かる
- **自己改善**: うまくいかなかったことを記録 → 振り返り → 仮ルール（すぐ効く）→ 正式な改善 PR（あなたの OK が要る）
- **マージには必ずあなたの OK が要る**

## セットアップ

main を clone して、下の順に進めれば使えます。engine は実行時に npm のパッケージを使わないので、
`npm install` は要りません（開発するときだけ必要）。所要時間は 20〜30 分ほどです。

### 1. 必要なものを入れる（Linux か WSL2）

| もの | 入れ方の例 | 確認 |
|---|---|---|
| Node 24 LTS（最新を推奨。22.18 以上で動く） | `fnm install 24 && fnm default 24`（nvm でも可） | `node -v` |
| tmux・git・jq | `sudo apt install -y tmux git jq` | `tmux -V` |
| GitHub CLI | [cli.github.com](https://cli.github.com/) の手順 → `gh auth login` | `gh auth status` |
| Claude Code | [公式の手順](https://code.claude.com/docs) → `claude` を一度起動してログイン | `claude --version` |
| Codex CLI | 公式の手順 → `codex` を一度起動してログイン | `codex --version` |

engine は Discord と常時通信するので、Node のセキュリティリリースが出たら更新してください。

### 2. Discord の Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → **Reset Token** でトークンを控える
2. 同じ画面の Privileged Gateway Intents で **Message Content Intent** を有効にする
3. OAuth2 → URL Generator: scope に `bot`、権限に View Channels / Send Messages / Send Messages in Threads /
   Read Message History / Add Reactions / Attach Files / Manage Messages（ボードのピン留め）を選び、
   生成した URL を開いて、共通チャンネルのあるサーバーに招待する
4. Discord の設定 → 詳細設定 → **開発者モード**を有効にし、共通チャンネルを右クリック → 「チャンネル ID をコピー」、
   自分のアイコンを右クリック → 「ユーザー ID をコピー」

Bot はメッセージを中継するだけです。サーバーは要らず、手元の engine が Discord に繋ぎに行きます。

### 3. engine を置く

```bash
git clone https://github.com/jonnity/discord-loop-engine ~/discord-loop-engine
mkdir -p ~/.local/bin && ln -sf ~/discord-loop-engine/bin/dle ~/.local/bin/dle
dle init
```

`~/.local/bin` が PATH に無ければ、`~/.bashrc` に `export PATH="$HOME/.local/bin:$PATH"` を足してください。

`dle init` が作った2つのファイルを埋めます（どちらも本人だけが読める権限で作られます）。

```jsonc
// ~/.discord-loop-engine/config.json
{
	"channelIds": ["<共通チャンネルの ID>"],
	"allowedUserIds": ["<自分のユーザー ID>"],
	"workspaceDir": "~/dle/workspaces",   // dle add owner/repo の clone 先
	"concierge": { "model": "sonnet" },
	"worker": { "model": null, "extraArgs": [] }
	// 残りの項目は既定のままで良い（「設定」の表を参照）
}
```

```bash
# ~/.discord-loop-engine/.env
DISCORD_BOT_TOKEN=<控えたトークン>
```

### 4. Claude Code にプラグインを入れる

ターミナルで（Claude Code の中なら `/plugin marketplace add …` と `/plugin install …`）:

```bash
claude plugin marketplace add jonnity/discord-loop-engine
claude plugin install discord-loop-engine@discord-loop-engine
```

ユーザー単位で入ります。窓口と worker は engine がこのプラグインを付けて起動します。

### 5. 確認して起動する

```bash
dle doctor   # すべて ✅ になるまで直す
dle up       # tmux の dle セッションで engine が常駐し、15 秒ほどで窓口が立ち上がる
```

**最初の1回だけ**、窓口の画面で確認に答えます。

```bash
tmux attach -t dle        # Ctrl-b w でウィンドウ一覧 → dle-concierge を選ぶ
```

- 「Is this a project you created or one you trust?」→ **Yes, I trust this folder**
- MCP サーバーの承認が出たら → 使う、を選ぶ
- 「Loading development channels」の警告には engine が自動で答えます

`Ctrl-b d` で tmux から抜けても動き続けます。Discord に窓口から「窓口を起動しました」と届けば準備完了です。

### 6. リポジトリを追加する

```bash
dle add jonnity/kishimen-tool     # ~/dle/workspaces/kishimen-tool に clone
dle add ~/src/kishimen-tool       # 既存の場所を使う
```

Discord で窓口に「kishimen-tool もやって」と頼んでも同じです。追加すると worker が起動するので、
5. と同じように `dle-<プロジェクト名>` のウィンドウで、最初の1回だけフォルダの信頼に答えてください。

追加したあとの流れ:

1. engine が作業用のディレクトリ（`.harness/`・`.worktrees/`）を
   `.git/info/exclude`（コミットされない除外設定）に足す。リポジトリのファイルは変えない
2. worker がリポジトリを調べ（CI・テストのコマンド・規約・UI の有無・実機でしか確かめられないこと）、
   **「⚙️ A-1 設定の確認」** を出す
3. 「A-1 OK」と返すと設定が確定し、ループが始まる。設定は `~/.discord-loop-engine/projects/<名前>/harness.json`。
   issue-loop で進めることに決まったときだけ、ここで `harness:*` ラベルを作る（独自のループを使うなら作らない）

**リポジトリ側の準備は要りません。** CI の失敗とマージ完了は engine が `gh` で見て Discord に知らせるので、
通知用のワークフローや Secrets も不要です。チームで設定を共有したいときだけ、同じ内容をリポジトリの
`.claude/harness.json` に置けば、そちらが優先されます。

### 独自のループを持つリポジトリ（native モード）

oogiri-doc のように、Issue を拾ってマージ承認まで自分で回す仕組みを既に持っているリポジトリは、
その仕組みをそのまま使います。ハーネスの設定もガードも適用しません。

```bash
# oogiri-doc: リポジトリの /parallel-cycle-loop で回す
dle add jonnity/oogiri-doc --native /parallel-cycle-loop
```

- リポジトリの手順・通知（`scripts/notify-discord.sh` など）・権限の設定はそのまま使われます
- 窓口からの依頼や A-番号への回答は、ユーザーからの指示として worker に届きます
- そのリポジトリのスクリプトが特定の tmux セッション名を前提にしているときは `--tmux-session <名前>` を付けます
- `--native` を付けずに追加しても、worker が独自のループを見つければ native を提案してきます

### 進め方を切り替える（`dle mode`）

```bash
dle mode oogiri-doc harness                           # dle の issue-loop で回す（設定が無ければ調べ直して A-番号で確認）
dle mode oogiri-doc native --command /parallel-cycle-loop   # リポジトリ独自のループに戻す
```

登録し直し（`dle add`）では今のモードが引き継がれるので、切り替えはこちらで行います。worker は起動し直します。
harness に切り替えると、worker は独自のループのスキルを読み、**そのリポジトリ固有の手順だけ**を
設定の差し込み口（下記）に写した案を出します。独自のループのスキルはリポジトリに残ります。

### リポジトリ固有の手順を足す（`hooks`）

ループの本体（issue-loop）はどのリポジトリでも同じで、違いは設定の `hooks` に書きます。
どれもコマンドの配列で、順に実行し、最初の失敗で止まります。`{n}`（Issue 番号）・`{pr}`・`{worktree}`・
`{main}`（メインのチェックアウト）が使えます。

| フェーズ | 呼ばれる場所 | 失敗したとき | 例（oogiri-doc） |
|---|---|---|---|
| `afterWorktree` | worktree を作った直後 | その Issue を進めない | `.env` / `.wrangler` の symlink、`pnpm install` |
| `beforePR` | `harness-gate` の最後（gate の後） | PR を出さない | `pnpm ci:local` |
| `onCIRed` | CI が赤くなったとき | 0 以外 = コード起因として Codex に差し戻す。0 = 対処済み（再実行など） | `pnpm ci:triage` → INFRA なら `gh run rerun` |
| `beforeMerge` | `harness-merge` の直前 | マージしない | SonarCloud の新しい指摘が 0 か |

### 更新する

```bash
git -C ~/discord-loop-engine pull
claude plugin marketplace update discord-loop-engine
claude plugin update discord-loop-engine@discord-loop-engine
dle down && dle up
```

### うまく動かないとき

| 症状 | 見るところ |
|---|---|
| Discord に何も届かない | `dle status` の Discord 欄。`close 4014` なら Message Content Intent が無効、`トークンが無効` なら .env |
| 「セッションが engine に繋がっていません」と届く | `tmux attach -t dle` で該当ウィンドウを開き、表示されている確認に答える |
| 「許可の確認で止まっています」と届く | 同じく tmux で答える。よく出るものは、そのリポジトリの `permissions.allow` に足す |
| 窓口が返事をしない | `dle restart concierge`。台帳は残っているので続きから再開する |
| 設定を見直したい | `~/.discord-loop-engine/projects/<名前>/harness.json` を直して `dle restart <名前>`。窓口に「kishimen-tool の設定を見直して」と頼んでもよい |

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
| `dle add <owner/repo またはパス> [--native <コマンド>] [--tmux-session <名前>] [--name <名前>]` | リポジトリを登録（worker が自動で起動） |
| `dle tasks [--all]` / `dle attention` / `dle board` | 台帳を見る |
| `dle restart <concierge またはプロジェクト名>` | セッションを起動し直す |
| `dle mode <名前> harness\|native [--command <コマンド>]` | 進め方を切り替える |
| `dle doctor` | 必要なものが揃っているか |

## 設定（`~/.discord-loop-engine/config.json`）

| キー | 既定 | 内容 |
|---|---|---|
| `channelIds` | — | 中継するチャンネル（先頭が投稿先） |
| `allowedUserIds` | — | 発言を受け取る人（あなただけにする） |
| `concierge.model` | `sonnet` | 窓口のモデル |
| `concierge.refresh` | 40 件 / 15% | 窓口とのやり取りがこの件数に達するか、コンテキストの残りがこの割合を切ったら、手が空いたとき（3分やり取りが無く、応答中でない）に engine が `/clear` して始め直す。直前のやり取りは渡し直し、挨拶は出さない。`maxEvents: 0` で無効 |
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
projects/<名前>/       プロジェクトごとの設定（harness.json）と確認待ちの案
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
