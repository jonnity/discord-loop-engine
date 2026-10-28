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
	"worker": { "model": null, "extraArgs": [] },
	"git": { "name": "<コミットの作者名>", "email": "<コミットの作者メール>" }   // 任意。無いとコミットできない環境で必要
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

まだ登録していないリポジトリを最初から dle のループで回すなら、`dle add <owner/repo またはパス> --harness` で登録します
（独自のループがあっても native を提案せず、固有の手順を写した案を出します）。
登録し直し（`dle add`）では今のモードが引き継がれるので、登録済みの切り替えはこちらで行います。worker は起動し直します。
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

### 環境の前提を確認する（`preflight`）

`harness.json` の任意の `preflight` は `[{"name":"環境名","run":"確認コマンド"}]` です。
設定の検証→preflight→gate（全件実行）→hooks.beforePR の順で毎回実行します。
未指定・null・空配列なら既存動作です。最初の preflight 失敗で終了3となり、後続と push/PR 作成を止めます。
終了1はコード検査、2は設定不備です。環境不備をコード修正の再試行に数えません。
self-hosted の対象ラベル・オンライン台数・API 権限は onboard で調べ、コマンドを提案します。
連動するエコシステムの依存名・版の整合・manifest/lockfile の確認方法は notes に記します。
既存プロジェクトは自動で設定を書き換えません。再調査/設定見直しで追加できます。

### 承認依頼の動画

demo 設定があり UI・操作を変える場合、要件確認で「どこからどこまで」を決めます。
開始状態・操作順・終了状態・含めないものを要件メモから設計・録画・映像レビューへ引き継ぎます。
明示的に動画を使う案件も同様です。UI 非変更/demo=null の全案件に録画は要求しません。

`harness-phase <issue> awaiting-merge --pr <pr> --comment-file <本文> --file <現 head の録画>` で依頼します。
`ffprobe` で H.264/yuv420p/MP4 を検査し、必要なら `ffmpeg`（libx264/AAC）で変換・再検査します。
適合動画も私有一時領域に `demo-<issue>-h264.mp4` として固定し、元動画を保持します。
静的通知先検査→旧 merge-ok 取消し/他 phase 除去/追跡 awaiting 確認→仮コメント pending→必須通知→
Discord 添付の再取得・bytes/SHA-256 照合→同 ID の完成 PATCH→merge-ok 再取消し/最終ラベル確認の順です。
PR 完成コメントの「デモ動画を開く（Discord）」から、動画のあるメッセージを開けます。
長文なら添付は最後の投稿です。PR には最終名・bytes・SHA-256・再取得照合済みを記録し、署名付き CDN URL は残しません。

未実装/見せる操作がなく動かない動画なら、本文の見出しより前の最初の行と --summary の先頭へ具体的な理由を書きます。
動く場合は雛形の条件行を削除します。固定文字列「【動きのない動画の場合だけ」が残る依頼は終了2です。
humanChecks は普通の箇条書きで結果/未確認を書きます。
**完成コメントを編集すると、それより前の OK/Approve は数えない**ため、編集後に再回答してください。

容量は `notify.maxAttachMB` の正整数 MiB（既定10）。Discord の制限・権限で上限内でも失敗し得ます。
超過は短縮/再録画し、本文だけへ降格しません。保存先は Discord、専用置き場ブランチは作らず、main 履歴へ動画を追加しません。
再実行・過去 head・マージ後も自動削除しません。手動削除は人が Discord 上で判断し、削除すると PR リンクは切れます。
メッセージを閲覧するサーバー/チャンネルの権限が必要です。

承認依頼は動画なしも `notify.required=false` で skip できず通知必須になりました。
GitHub コメント・Discord 通知・ラベルの人間ゲートを揃える安全柵強化です。通常 info 等の skip は維持します。
`harness-notify --check-target --event merge-request` は設定/envFiles を通常送信と同様に解決し、
engine ソケット候補/webhook 候補の有無だけを秘密なし JSON で返します。疎通や投稿はしません。
ソケットがあっても接続成功は保証しません。

awaiting-merge は追跡用です。再依頼の開始時と完了時に merge-ok を外すため、処理中に付けても消えます。
新しい完成依頼を確認して承認し直してください。最新の認証投稿者の完成marker・現 head・ラベルを全経路で検査します。
attention 属性なしの旧 gate は GitHub/チャットとも再依頼が必要です。
GitHub の OK は完成 PATCH の updated_at より厳密に後、Approve はその時刻に加え commit_id が現 head のものだけ。
同秒の OK/Approve は再回答してください。NG/CHANGES_REQUESTED は仮 POST の created_at 以後から保持します。
pending/旧 gate でもこの NG は inbox が先に返します。同時刻の正負は NG が優先です。
最終確認後に付く merge-ok ラベルを head/依頼へ結び付けるイベント照合はありません。最新完成依頼を確認して付けてください。

engine の回答は worker が `harness-merge <issue> --chat-approval "<引用>" --attention "<回答のmeta.attention>"` に渡します。
引数の引用は承認の証拠にせず、保存済み台帳の同じ A が回答済み OK で、project/Issue/PR・最新完成marker・現 head・時刻が一致することを2回読み直します。
読取不能・A 不在・非 OK ではマージしません。回答時刻は A 作成時刻以後が条件で、完成前に届いた OK も同じ A の完成後に使えます。
worker は即時配送に加え tick の `chat-merge-ok` を同じ tick で回収し、main 取り込みや CI red/競合修正等の head 変更前にも確認します。
CI 待ちだけなら同じ A を保ち、進めない具体的理由は Issue に残します。新 head/新依頼には新回答が必要です。
正常な台帳内に A が本当にない場合だけ正式に再依頼します。台帳不通・sequence 不足・scope 不一致は再確認し、自動解消できなければ blocked で人に返します。
単独運用で保存済み engine 台帳を使わない場合はチャット承認を利用できません。webhook の attention=none は従来の GitHub 承認を使います。engine が停止中、MCP 未接続でも同じホストの保存台帳が読めれば回収できます。

本文は ECMAScript の trim 後、owners の `<名前> が Discord で回答。` に先頭が完全一致する場合だけ1回除いて再度 trim し、`OK` で始まれば承認です。
大小文字変換・全角化の補正・否定語/後続文の検査はしません。`OK ではない`・`OK、ただし NG`・`OKです`・`OKじゃない` も OK になることは、**人が承知のうえで選んだ**仕様です。
`ok`・`ＯＫ`・`LGTM`・`A-12 OK` はこの本文判定では非 OK です。台帳原文を変更せず、マージの記録にも原文を使います。
前置きの名前は Discord の表示名で、owners（GitHub login）と完全に一致するときだけ除きます。表示名を変えると前置き付きの回答は非 OK になり、以下の出口に回ります。
承認できる人は allowedUserIds で決まり、owners 限定はそれを絞りません。前置きのない `OK（Discord: 任意の名前）` は owners に関係なく本文判定を通ります。

承認に使えなかった回答は A・理由ごとに1回だけ info で理由と現在の依頼 URL を案内します。
現在の A の有効な非 OK 回答は GitHub の OK（コメント・Approve・merge-ok ラベルの付与時刻）と比べ、下記の条件なら GitHub 経路も止め、同じ共通通知へ回します。台帳を照合できない場合の GitHub 承認経路は従来どおりです。owners が読めない場合はスナップショットの ownersUnavailable で故障を伝え、inbox は承認判定より先に attention-unavailable を返し、マージも GitHub 経路を含め拒否します。
解釈: 比較は保存された時刻を絶対時刻に変換し、engine の時計の遅れに5分の余裕を持たせ、`resolvedAt >= GitHub OK の時刻 − 5分` なら止めます。GitHub OK と同時刻、5分前の境界も止める側です。余裕は `src/harness-approval.ts` の定数 GITHUB_APPROVAL_CLOCK_SKEW_MS で定義します。時計自体を同期するものではなく、5分を超えるずれや読取り後の更新による限界は残ります。
現在の完成依頼を確認して PR に GitHub で『OK』とコメントするか、窓口に『#n の承認依頼を出し直して』と頼んでください。
後者は worker が正式な新 A を発行し新回答を待ちます。resolved の古い A への再入力や旧 OK の付け替えはしません。
通知の正本は認証 login 自身の Issue コメントの claimed/posted/failed-or-unknown です。他者の同じキーでは抑制せず、結果不明でも自動再送しません。
Phase 5-4 はフォアグラウンドで、終了前に届いた OK は終了後に処理します。終了0・完成marker・復旧ファイル消失後なら info 0回で回収します。
pending の異常や非0終了、完成 marker と復旧ファイルが残って終了値不明の状態は失敗仕分けへ送り、自動解消できなければ blocked にします。

`dle attention --answered --json` は resolved の全件（非 OK・置換も含む）、`dle attention --all --json` は存在と回答の照合用の全件を返します。
新モードは `schemaVersion: 1, items: [...]` の JSON で、DLE_HOME の attention.json を読取り専用で参照します。DLE_CONFIG_HOME は台帳には使いません。
新モードは --json 必須・併用不可、正常0・読取/形式失敗1・不正引数2です。従来の `dle attention` / `--json` 単独は open 一覧のままです。
`src/attention-read.ts` は readAttentionSnapshot(home)、readAttentionSequence(home)、stripDiscordAnswerPreamble(answer, owners)、isAttentionAnswerOk(answer, owners) を公開します。
本文判定の boolean だけでは A/head/scope/時刻を保証しません。利用側が対象との結び付きを別途検証してください。

更新後は plugin/CLI と engine の配置・同じ DLE_HOME の読取り権限を確認し、稼働 worker を再起動して新スキルのロード版を確認します。
旧 worker は tick の新手順を自動では学びません。旧 engine の既存台帳は形式を変更せず利用できます。
番号が有効な別 home までは自動識別できないため、実配置の home 一致を確認してください。

失敗時は終了値と段階を保存します。0 だけが依頼完了です。

| 終了 | 対応 |
|---|---|
| 2/6 | 引数・雛形/設定、動画の道具・入力・容量を直す。準備失敗は副作用前停止 |
| 4 | 通知失敗/結果不明。静的未設定なら副作用なし、投稿後なら最新 pending と追跡 awaiting が残る |
| 7 | A/リンク/再取得照合/head/完成 PATCH 失敗。依頼未完了、旧 receipt/A を流用しない |
| 5 | ラベル編集/確認失敗。merge-ok 除去・awaiting 復元・同コメントの pending 化と再読取りを試す |
| 中断 | 所有 PID/PGID・送信結果・一時物を調べ、子を止めてから所有領域だけ回収。共有 engine は停止しない |

依頼とマージは対象の同じ worktree を cwd にして実行します。
復旧未確認は worktree 内の `.harness/merge-recovery-<issue>.json`（git 管理外）にも残り、harness-merge が拒否します。
次の全手順の再依頼が成功したとき消えます。通信断では遠隔に完成 gate/ラベルが残った可能性もあり、成功扱いしません。
A の取下げは保証しません。架空回答・台帳直接編集で取り下げず、通信復旧後に最新状態を読み直します。
最新が自分の失敗した依頼の pending なら、原因を直せたときだけ再実行し、直せなければ blocked にします。
tick ごとに無条件でコメント・通知・A を増やしません。長い変換は呼出し側 timeout を延長します。
SIGKILL/親の無信号終了では trap の回収保証はありません。

更新時は engine・plugin・CLI・worker を揃えて再起動します。protocol は2を維持し既存の先頭 message_id/A 出力は互換です。
旧 engine の不完全 receipt を成功扱いしません。認証 login を変えた場合は新 login で再依頼します。

| 受け入れ条件 | 自動確認 | 人の確認 |
|---|---|---|
| 1 PR→動画リンク・取出し一致 | M1〜M4: notification-receipt/rest/engine/cli-notify/harness-media/harness-merge のテスト | H1/H2 |
| 2 合意範囲の引継ぎ | S2: test/skill-prompts.test.ts の各節・生成依頼 | H3 |
| 3 動かない理由を先頭へ | S3/M1: 雛形・固定文字列拒否・完成本文と要約 | H3 |
| 4 保管/容量/掃除 | S1/M2/M5: README/スキル・通知/メディアテスト | H4 |
| 5 既存 gate と安全柵 | T0/M6a〜e: isolate/harness-approval/harness-merge、既存全件と Q1〜Q5 | H1〜H5 |

実サービスへ触れない fixture 試験で代用できない確認:

- H1: PC/スマートフォンで PR→動画付き最後のメッセージ、Copy Message Link の3ID一致、閲覧権限。
- H2: engine/webhook を別々に毎回新しい入力で3回連続、hash/bytes/実 MP4 と両端末の再生を確認。失敗で連続数を0へ。
- H3: 合意した開始状態/操作順/終了状態/含めないものと映像、冒頭理由の正確さ。
  サマリの動画パス・録画時 full SHA を PR 現 head/完成markerと照合し「動画を撮ったhead＝現head」を確認。
  違う/不明なら撮り直す。5-2・5-3後・依頼直前・完成後に確認。bytes/hash は撮影headの証明ではありません。
- H4: 4/7/5/中断時の残存 A/結果不明/コメント/ラベル/所有子と一時回収、保管・手動削除判断。tmux は記録済 window-id のみ。
- H5: GitHub 認証/読取り/コメント権限、Bot 閲覧/送信/添付、webhook token GET/POST、CDN HTTPS、配布版/再起動。
  秘密や応答全文は表示せず、疎通不良なら依存作業を止めます。

CI と同じ品質確認（Q1〜Q5）:

```bash
npm run check:ci
npm run typecheck
shellcheck -S warning bin/harness-* bin/dle
shellcheck -S warning -e SC2034 tests/harness/run.sh
for f in .claude-plugin/*.json hooks/hooks.json .mcp.json templates/profile.example.json templates/examples/*.json; do
  jq empty "$f" || exit 1
done
(
  quality_home="$(mktemp -d)" || exit 1
  trap 'rm -rf -- "$quality_home"' EXIT
  env -u DLE_ROLE -u DLE_PROJECT -u DLE_LOOP DLE_HOME="$quality_home" DLE_SOCKET="$quality_home/engine.sock" npm test
)
```

check:ci は format と lint の両方。shellcheck 不在は skip と記録し CI で確認します。
socket/spawn が EPERM なら失敗テスト名・メッセージを残し、制限のない環境で全体を再実行します。

### 更新する

```bash
git -C ~/discord-loop-engine pull
claude plugin marketplace update discord-loop-engine
claude plugin update discord-loop-engine@discord-loop-engine
dle down && dle up
```

### Codex の設定移行

Codex の既定値と配布雛形は次のコマンドです。明示された `codex.command` は優先されるため、既存設定は自動で変わりません。

```text
codex -C {worktree} -c model_reasoning_effort=high -c sandbox_workspace_write.network_access=true exec --sandbox workspace-write
```

`workspace-write` では `$HOME` は読取り専用です（codex-cli 0.164.0 で確認）。ネットワークを許しても `~/.npm`・`~/.cargo` 等のキャッシュ書込みや、
依存導入・ビルドが失敗しえます。依存導入は worker 側の `hooks.afterWorktree` か gate で行い、Codex の書込み範囲は広げません。
一時領域・追加 root の可否は実設定に依存し、外側の sandbox・OS・組織ポリシー・認証・プロキシをネットワーク設定で越えることはできません。

engine 側の harness.json に `codex.command` を明示しているプロジェクトには、既定値の変更が効きません。
窓口が該当するプロジェクトと実効設定の一覧を確認します。`HARNESS_CONFIG`、main の設定、engine 側設定の優先を確認し、
対象ごとの旧→新 command・他項目を保つ完全な設定案・Codex に依存導入やビルドをさせているか・ホーム制限の影響と worker との分担を提示します。
独自 command を自動置換せず、上書き元が不明なら移行を止めます。
plugin/engine/worker の更新後、A-番号の承認を得てから窓口が書き換えます。worker は engine 側 harness.json やユーザーの settings を編集しません。
作業中の Codex の二重起動・途中切替を避け、次の起動で command・cwd・ネットワーク・拒否時分岐を確認し、同じ回答先へ結果を返します。
拒否時に代行させる旧来の仮ルールが台帳にあれば、窓口が撤回または更新し、復帰時も新方針が渡ることを確認します。

更新から設定移行まで、明示 bypass の設定には既定変更が効かず、拒否時の代行だけがなくなるため blocked が増えうる影響があります。

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
| `dle add <owner/repo またはパス> [--native <コマンド> \| --harness] [--tmux-session <名前>] [--name <名前>]` | リポジトリを登録（worker が自動で起動） |
| `dle projects [--json]` | 登録済みのリポジトリ（モード・接続中か・設定の確認待ちか） |
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
| `concierge.refresh` | 有効 / 100k / 40 件 / 残り15% | `enabled`・`maxTokens`・`maxEvents`・`contextPercent`。文脈量または件数が閾値に達したら engine が待機中に `/clear` し、`concierge refresh` で挨拶を出さず再開。`enabled: false` で無効。旧形式の `maxEvents: 0` だけでも全無効を維持。件数だけ無効にするには `enabled: true, maxEvents: 0` |
| `worker.refresh` | 有効 / 100k / 残り15% / 180秒 / 30分 | `enabled`・`maxTokens`・`contextPercent`・`idleSeconds`・`cooldownMinutes`。ready な harness worker のみ対象。待機が続いたら `/clear` し、`worker.initialPrompt`（既定 `/discord-loop-engine:issue-loop`）で再開する。native と onboard 中は対象外 |
| `worker.refresh.codexIgnoreAfterMinutes` | 120 | 同じプロジェクト配下の Codex 窓がある間は待つ。engine が窓を観測してからこの分数残り続けたら無視する |
| `worker.model` / `worker.extraArgs` | — | worker のモデルと追加の起動引数（例: `["--permission-mode", "acceptEdits"]`） |
| `git` | なし | worker の `git commit` の作者（`name` と `email` の両方が要る）。worker の起動時に `GIT_AUTHOR_*` / `GIT_COMMITTER_*` で渡す。リポジトリ側の `user.email` より優先される |
| `workspaceDir` | `~/dle/workspaces` | `dle add owner/repo` の clone 先 |
| `retro` | 5 件 / 7 日 / 3 回 | 振り返りの頻度と、仮ルールにする再現回数（仮置き。振り返りで見直す） |
| `permissionRelay` | `false` | 許可の確認に Discord から `yes <id>` で答えられるようにする |
| `board.enabled` | `true` | ボードのピン留め |

文脈量は Claude Code の `~/.claude/sessions/<pid>.json` と会話ログの最後の usage
（入力＋キャッシュ作成＋キャッシュ読取）から取得する。取得できない場合は画面の `~Nk uncached`、
残り割合の順で補う。`maxTokens: 0` はトークン量と残り割合の判定を無効にする。
`contextPercent` は残り割合の予備閾値（`N% context used` の表示は残りに換算）。

窓口・worker とも、セッションが idle、応答・許可確認中ではなく入力欄が空、直近の入力・会話ログ・
サブエージェントの更新から180秒（worker は設定可）以上、という条件をすべて確認してから整理する。
engine 起動直後も同じ秒数待ち、整理の成功・失敗後は30分（worker は設定可）冷却する。
内部ファイルの形式変更などで待機を確認できない場合は見送る。
`/clear` は sessionId の変化を最大15秒確認してから再開し、確認できない場合は再開プロンプトを送らない。

アップデート後は worker の自動整理が既定で有効になる。整理の理由・文脈量、失敗、文脈量不明による
見送りは journal に残る。A-番号とタスクは台帳に保持し、整理中のメッセージは outbox に保留する。
復帰時は仮ルール、窓口だけの直近のやり取り、保留メッセージの順で渡す。
issue-loop は復帰時に状態を読み直し、心拍が消えていれば張り直す。

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
- Codex が使えないとき（`reason=not-installed` / `not-logged-in`、確認済みの認証切れ・usage limit）は、worker が Discord に info で一度だけ知らせ、
  設計・実装を Claude（`harness-implementer`）に自動で切り替えます。Codex が戻れば次の段階から Codex に戻ります
- 起動の権限拒否・`reason=launch-failed`（tmux 起動失敗）・拒否/利用不可の判別不能は、代行せず `blocked` と人向け起動1行を案内します。
  exit 10 だけで代行を決めません。拒否時の自動再試行・直接起動・フラグ変更・許可追加による迂回は行いません
- 届くのはセッションが動いている間だけです。窓口が止まっている間の発言は保存しておき、起動したら渡します

### Codex の起動と拒否時の案内

全ての起動・再起動は [issue-cycle の共通起動手順](skills/issue-cycle/SKILL.md#codex-の共通起動手順) に従います。
依頼ファイル作成・stop・フェーズ変更を準備で済ませ、解決済み絶対パスを引用した `harness-codex start` の1コマンドを
単独の Bash ツール呼び出しで実行し、監視は別の呼び出しに分けます。engine に起動許可は追加しません。

権限拒否・launch-failed・判別不能は、理由と当該段階の人向け起動1行を GitHub 本文・Discord summary の両方へ入れ、
`harness-phase` で blocked にします。両方の1行をフェンスのコードブロックに入れて、Markdown に引用を壊させません。
人向け1行は実効 `HARNESS_CONFIG` と解決済み絶対入口を含みます。ホーム末尾の `/` を除き、`$HOME` と `realpath "$HOME"` の
接頭辞を引用前に外して残りだけを `%q` で引用し、`"$HOME"/…` とつなぎます。本文のパスも同じ表記にします。
生成して通知する実行例は [issue-cycle の blocked 手順](skills/issue-cycle/SKILL.md#codex-起動を-blocked-にする) にあります。
同じユーザー・同じ tmux サーバーの Bash で人が実行し、同じ blocked の回答先へ結果を返します。
worker は回答・status・workdir・成果物を確認して元の段階へ復帰し、二重起動しません。
通知失敗を完了扱いせず、blocked 中の tick では再起動・再通知を繰り返しません。

原因の切り分けでは、ラッパー集約が Bash に直接の bypass や tmux 起動を渡す経路を減らし、
単独呼び出しへの分離が準備や通知との複合経路を減らします。既定値の変更はラッパー内部の Codex の実権限に効きます。
分類器の内部因果は推測であり、workspace-write なら必ず通るとは断定しません。
拒否として数えたのは、`is_error: true` かつ本文が `Permission for this action was denied` で始まる tool_result と、
対応する Bash tool_use だけです。`tool_use_id` で重複を除外し、bypass 有無・起動の経路・単独／複合の形を交差集計しました。
対象は運用中の transcript です。読み取れなかったファイルの件数は未記録です。

集計（2026-10）: Bash の拒否は 18 件で、そのうち Codex 起動は 15 件でした（残り 3 件は Codex と無関係）。

| bypass フラグ | 起動の経路 | 単独 | 複合 | 計 |
|---|---|---|---|---|
| あり | 直接（tmux new-window / codex exec） | 1 | 11 | 12 |
| なし | 直接（tmux new-window） | 0 | 3 | 3 |
| あり・なし | harness-codex start 経由 | 0 | 0 | 0 |

複合は、heredoc・harness-phase・Issue コメント・tmux new-session・sleep/grep などを `&&` や改行で同じコマンドにまとめたものです。
harness-codex start 経由の呼び出しは 23 件あり、拒否は 0 件でした。`--sandbox workspace-write` を含む起動の拒否も 0 件でした。
言えるのは「拒否は直接起動と複合呼び出しに集中していた」までで、分類器の内部因果や将来の成功率は断定できません。

## 開発

```bash
npm install
npm test            # node --test（engine）＋ tests/harness/run.sh（ハーネスのスクリプト）
npm run typecheck
npm run check       # Biome
```

engine は TypeScript をビルドせず、Node の型ストリップでそのまま実行しています。
ハーネス（`bin/harness-*`）は bash です。

### ツールの入力契約

ツールは engine の入口で必須項目・型・未知の引数名を検査し、不正な入力はエラーにする。
未知の引数名には許可された名前の候補を案内する（`dispatch.message` → `text`、`rules_set.text` → `content`）。
`dispatch.text` と `rules_set.content` は空文字・空白だけの本文を拒否する。入力の自動補正は行わない。

### worktree の場所と worker のアクセス許可

`worktreeRoot` の未指定・null・空文字列は、字句正規化した DLE_HOME の兄弟
`${DLE_HOME}-worktrees/<登録名>/issue-<番号>` を使います。通常は
`~/.discord-loop-engine-worktrees/<登録名>/issue-9` です。main の親 lint 設定との入れ子を避け、
上方探索で Bot トークンの `DLE_HOME/.env` を通らない配置にします。
相対値は main を基準とし、絶対値も指定できます。明示 `.worktrees` は従来の
`<main>/.worktrees/issue-9` のままです。既存設定・作業領域は自動で移動・削除しません。
`~`・`$` 始まりの値は展開を行わないため拒否します。展開済みの絶対パスか通常の相対パスを指定してください。
symlink の実体解決は行いません。親の lint 設定、依存の準備、相対パス、権限・容量、
祖先の `.env` と共有 symlink は実配置で確認してください。

`harness-config --worktree-root` と `harness-config --worktree 9` は解決済みの絶対パスを返し、
参照だけでは mkdir しません。登録名は `DLE_PROJECT`、単体実行では設定の `.project` を使います。
basename とは異なる場合があるため推測しません。両方なければ `DLE_PROJECT=<登録名>` の指定を求めて停止します。
文字列以外の root、不正な登録名、既定候補が main/DLE_HOME 配下になる配置はエラーです。
提案時は draft 保存・承認依頼前に拒否し、手編集による起動時エラーは engine の log と通知に
プロジェクト名・worktreeRoot・具体的理由を出します。その worker の起動・refresh を止め、他のプロジェクトは継続します。

harness worker は起動前に root を作り、解決値を Claude の `--add-dir` へ1引数で渡します。
最後の `exec env … claude …` により tmux の pane PID と Claude の PID を揃えます。
ready worker の自動整理も同じ root の Codex を待ちます（同 id/cwd を120分観測した後は従来どおり無視）。
設定の activate だけでは実行中の許可は更新されません。起動後、無害な一時ファイルで外部 WT の
Read/Edit/Write・gate・代行実装への許可継承を確認してください。実 Claude/Codex/tmux の認証・信頼確認は手動です。

標準 linked worktree 内でも設定探索の root は main になります。
設定の優先順位は非空 `HARNESS_CONFIG` → main の `.claude/harness.json` →
`DLE_CONFIG_HOME/projects/$DLE_PROJECT/harness.json` です。DLE_CONFIG_HOME が未設定・空なら `DLE_HOME`、
さらに未設定・空なら `$HOME/.discord-loop-engine` を使い、相対 home は main 基準です。
DLE_CONFIG_HOME は engine 側の設定先だけを変え、worktreeRoot の既定計算は従来どおり DLE_HOME を使います。
engine は worker・窓口の起動時に `DLE_CONFIG_HOME=cfg.home` を渡します。
gate/hook/Codex はこの規則で定義を読み、実行 cwd は WT のままです。
通常は手で DLE_HOME を差し替える必要はありません。設定の場所を別に指す必要があれば
DLE_CONFIG_HOME（または既存の HARNESS_CONFIG）を指定します。
notify の `.env` と相対 `notify.envFiles` も main 基準です。WT 側だけで設定や `.env` を変えても自動では選ばれません。
ブランチの定義を試す場合は `HARNESS_CONFIG=<WT の設定ファイルの絶対パス>` を明示します。

preflight と gate の各コマンドは、継承したすべての `DLE_*`・`DISCORD_*` を外し、
空の専用一時ディレクトリを `DLE_HOME`、その直下の存在しない `engine.sock` を `DLE_SOCKET` に設定します。
設定とコマンド定義は隔離前の親環境で読みます。PATH・通常の認証・git 作者・cwd・標準入出力は維持し、
`hooks.beforePR` は呼出し元の環境で実行し、渡された DLE_HOME/DLE_SOCKET/DLE_CONFIG_HOME を保持します。
DLE_CONFIG_HOME は通知無効化の保証を与えません。隔離準備失敗は終了3で停止し、元の環境へ戻して再試行しません。
これはネットワークを遮断する sandbox ではありません。main の `.env`、envFiles、BASH_ENV、明示 URL/socket からの
再設定や任意の秘密ファイル読取りを防ぐものではありません。

通常終了と HUP/INT/TERM では trap が所有する一時領域を回収し、信号時は129/130/143で終了します。
foreground の子待ちで trap は遅延しえます。即時中断・子孫の停止は保証しません。
SIGKILL・マシン停止後は、使用した TMPDIR の一時領域と残るプロセスを確認し、実行中でないことを確かめて整理してください。

### 既存 worktree 設定を切り替える手順

1. plugin と engine の更新・再起動を確認し、`profile_get` / `harness-config --path` で有効設定を確認します。
   明示 `.worktrees` は更新しても従来パスを使います。以前からキー未指定で旧 WT が作業中なら、
   旧 `.worktrees` を明示して継続できます。新旧で同じ Issue を二重作成しません。
2. 作業中の Issue/WT/Codex・未完了作業を確認し、作業中なら旧 root を維持して切替を延期します。
   データは自動移動・削除しません。
3. onboard の再調査/設定見直しで外部候補の親 lint 設定、依存・相対パス、書込権限・容量、祖先の `.env` と symlink、
   隔離後の preflight/gate と非隔離の beforePR を確認します。lint の競合があるプロジェクトから切り替えを検討します。
4. 他の項目を保持し、**worktreeRoot キーだけを除いた完全な profile** を `profile_propose` へ渡します。
   差分パッチだけでは activate 時に他の項目が失われます。summary には旧 root、新既定の絶対パス、変更理由、
   確認結果、残る手動確認、再起動の必要性を記します。提案時に現行ファイルを直接書き換えません。
5. 人の OK 後に `profile_activate` します。repo の `.claude/harness.json` が優先なら engine 側のキー除去だけでは
   有効値は変わりません。その旨を示し、repo 側の変更は別途承認を求めます。
6. `dle restart <名前>` 後、`harness-config --worktree-root` と起動時 `--add-dir` が一致することを確認してから
   新規 WT を作ります。実 lint/gate、Claude の外部操作、代行実装、監視・片付けを確認します。旧領域の掃除は別途判断します。

新規 onboard も省略が既定で、別 root を確定したら worker を再起動してから WT を作ります。

### 要件と検証の対応

| 要件・決定 | 対応ファイルと自動試験 | 手動確認 |
|---|---|---|
| 専用 home からの設定探索とセッションへの引継ぎ、通常は手動差替え不要 | `bin/harness-config`、`src/projects.ts`、`test/projects.test.ts` S16、`tests/harness/run.sh` C16、`test/harness-gate.test.ts` G16 | 実際の設定場所、更新後の engine・worker・窓口の再起動、beforePR の環境 |
| 条件付き存廃質問 | issue-cycle Phase 1、`test/skill-prompts.test.ts` P16a/P16c | 関連案件だけに残す／消すの選択肢があり、質問1〜3点に収まるか |
| 廃止に伴う表示の棚卸し | issue-cycle Phase 2・3・5-1、`test/skill-prompts.test.ts` P16b/P16c | UI・CLI 出力・通知文面の一覧と残す／消すの理由の十分さ |
| preflight/gate は常時 DLE_*/DISCORD_* を除去、一時 home/socket、親で設定先行読取り、beforePR 非隔離 | `bin/harness-gate`、`test/harness-gate.test.ts` G1〜G6、`tests/harness/quality.sh` | 独自 hook の環境依存・明示接続先 |
| lint 競合の回避方法は外部既定、絶対/相対、明示 .worktrees 互換 | `src/worktrees.ts`、`bin/harness-config`、status/codex-status、templates、`test/worktrees.test.ts` W1/W2、`tests/harness/worktrees.sh` W3 | 配置先の親設定・権限・依存・実 lint |
| 作成・再開・シェパード・片付けは同じ WT、登録名不明なら停止 | issue-cycle/issue-loop、`test/skill-prompts.test.ts` W4 | 実 Codex/tmux の復帰と片付け |
| 既存値維持、完全な提案→人の OK→activate→restart、提案の型/配置検証と解決済み root の表示 | `src/engine.ts`、`test/engine.test.ts` W5、上の切替手順 | 配置先の確認と切替の承認 |
| --add-dir、exec の PID 維持、初回から起動エラー診断、外部 Codex 中の整理抑止 | `src/projects.ts` / `src/supervisor.ts`、各 test の W6 | 実 Claude と代行実装への許可継承 |
| DLE_HOME の兄弟配置で Bot 用 .env を祖先から外す | `test/worktrees.test.ts` W1/W2 | symlink・他の祖先の .env |
| WT 内でも main 設定/.env、実行 cwd は WT | `tests/harness/worktrees.sh` W8、config/gate/notify | 各 notify.envFiles・秘密ファイル |
| 信号時は trap 回収と128+nに限定 | `test/harness-gate.test.ts` G6（各信号3回） | SIGKILL、子孫、回収の遅延 |
| engine/channel の通信形式・必須項目を維持 | `test/engine.test.ts`、PROTOCOL_VERSION=2 | plugin 更新と実 engine/worker 再起動後の確認 |

### 設計品質チェックリストとレビュー

[issue-cycle](skills/issue-cycle/SKILL.md) の Phase 2 では、設計依頼に生成時点の gate を添付します。
非空の配列は name/run と順序を保ち、コマンドとして実行しません。未定義・空・配列以外は未確認と明記し、
CI から必要な品質コマンドとテストの対象を確認する手順を残します。これを gate 成功の根拠にはしません。
取得失敗時の blocked は防御的な分岐です。不正 JSON は本番では手前の `harness-config --worktree` が
終了1で停止します。T5 の取得失敗は stub による単体検証です。

チェックリストは「常に確かめる項目」と「該当するときだけの項目」に分け、非該当には理由を記します。
生成した依頼は Phase 3 と 5-1 の懐疑役・検証役の両方に渡し、再依頼でもチェックリストと gate を残します。
gate の定義を変えた場合は更新後の列と CI の対応を照合します。

| 確認項目 | 担当フェーズ | [自動試験](test/skill-prompts.test.ts) | 人による確認（humanChecks） |
|---|---|---|---|
| gate と同じコマンド列・順序、format/lint/test/build の省略なし、新規テストの glob・除外・呼び出し元 | Phase 2・Phase 3・5-1 | T1/T2: 値・順序・文字保持・非実行、T3/T4: 依頼と両レビュー、T5: 欠落・空・型と防御分岐 | 実プロジェクトでの gate と CI の対応、新規テストの対象包含 |
| 憲章・規約のレビューゲートと該当節ごとの自動確認/humanChecks | Phase 2・Phase 3・5-1 | T3/T4 | 該当節と確認の対応が十分か |
| 設定値はスキーマに加え要件値を期待値との assert で確認 | Phase 2・Phase 3・5-1 | T3/T4 | 誤った値を見逃さない期待値か |
| 長時間 CLI の実経路（パッケージマネージャー/スクリプトランナー経由・パイプ）の異常系、N・初期化・中断/回収 | Phase 2・Phase 3・5-1 | T3/T4 | 利用者の経路を代表し、成果物・子・一時ファイルを確認したか |
| メジャー版更新の対応版を一次情報で確認、確認不能な環境依存の停止計画 | Phase 2・レビュー共通・Phase 3・5-1・5-3 | T3/T4/T6 | 対象・未確認理由・影響・CI での確認手順が十分か。実ログと修正回数の運用 |
| 文言・式・数値例などの具体化を「解釈」と明記 | Phase 2・Phase 3・5-1 | T3/T4 | 確定要件にすり替わっていないか |
| 廃止に伴う表示の棚卸しと残す／消すの設計 | Phase 2・Phase 3・5-1 | P16b/P16c | 廃止対象のためだけにあった UI・CLI 出力・通知文面の漏れがないか |
| 表示崩れはボタン名・要素 × 状態 × viewport と期待結果を列挙 | Phase 2・Phase 3・5-1・5-2 | T3/T4 | 実アプリの動画・スクショで網羅性と操作性を確認 |
| 既存 gate 回帰と恒久文書の確認先 | 5-3 | T6 と [CI の全検査](.github/workflows/ci.yml) | CI green と人のマージ承認、guard、Codex の git 禁止を維持 |

検証役は、一次情報で対応版を確認し、未確認の理由・影響・CI での確認手順と停止計画があれば、
設計段階の検証計画として足りると判断します。実行できないという理由だけで同じ確認を繰り返しません。
5-1 は停止計画の impl サマリへの引継ぎを確認し、PR 後の実ログ・修正回数を要求しません。
5-3 は設計で停止ルール対象とした環境依存に限り、PR CI の実ログに基づく修正1回で未解消なら blocked で人に返します。
「1回」は同じ PR で対象の失敗後に push した修正コミットと、そのコミットに対する CI 結果から数えます。
`gh pr view {PR} --json commits` でコミットを確認し、`gh pr checks {PR}` と、過去の結果が必要なら
`gh run list --commit <SHA>` / `gh run view <run-id> --log-failed` で対象の失敗と修正後の結果を照合します。
clear/resume 後も worker が読めるこの履歴から復元します。既存の `learning_add`（tag: `ci-red`、engine 不在時は
failure-log.jsonl）は記録先としてだけ使い、新しい仕組みは作りません。REAL 3回よりこの上限を優先し、CI green 後に承認依頼を出します。
issue-loop §5 からこの例外への参照はありません。通常の CI red 運用でも上限を適用できるかは humanChecks に残します。
文章の存在を確かめる試験だけでは、実際のレビュー役の意味理解・判断・運用順序は保証できません。
