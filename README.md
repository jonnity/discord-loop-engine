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

Gateway の intents にはリアクション（サーバー・DM のメッセージリアクション）も使います。Message Content のような
特権 intent ではないので、Developer Portal での追加設定は要りません。

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

### マージ前に必須の検査を要求する（`merge.requiredChecks`）

`harness.json` の任意の `merge.requiredChecks` に検査名の配列（例: `["Local E2E"]`）を書くと、`harness-merge` は
その検査が **現在の PR head で SUCCESS** であることを要求します。`statusCheckRollup` の `name`（StatusContext は `context`）と完全一致で照合し、
SKIPPED・NEUTRAL・実行中・未実行・失敗、古い head の結果は満たしたことになりません（同名が複数あれば全件 SUCCESS が要ります）。
満たさないときは検査名と状態を表示して止まり、足すものは任意の `merge.hint`（文字列）で上書きできます。
未指定・空配列なら従来どおり（SUCCESS・NEUTRAL・SKIPPED を green と見る CI 判定だけ）です。
`requiredChecks` や `hint` の型が不正、または `merge` がオブジェクトでないときは、設定ミスで検査が外れないよう拒否します。
`harness-merge <issue> --pr <番号>` にも同じ判定が効きます。Dependabot 用の `harness-merge --pr <番号>` には課しません。

### 環境の前提を確認する（`preflight`）

`harness.json` の任意の `preflight` は `[{"name":"環境名","run":"確認コマンド"}]` です。
設定の検証→preflight→gate（全件実行）→hooks.beforePR の順で毎回実行します。
未指定・null・空配列なら既存動作です。最初の preflight 失敗で終了3となり、後続と push/PR 作成を止めます。
終了1はコード検査、2は設定不備です。環境不備をコード修正の再試行に数えません。
self-hosted の対象ラベル・オンライン台数・API 権限は onboard で調べ、コマンドを提案します。
連動するエコシステムの依存名・版の整合・manifest/lockfile の確認方法は notes に記します。
既存プロジェクトは自動で設定を書き換えません。再調査/設定見直しで追加できます。

### 未確認（skip）の扱い（`skipExit`・`gateSkipPolicy`）

検査道具が無くて実行できなかった段（例: shellcheck 未導入）を、成功の ✅ と区別します。
gate の段に `"skipExit": 78` を書くと、その段が終了コード 78 で終わったときだけ「未確認」として `⚠` で一覧に出し、
末尾に `⚠ 未確認: <検査名>（CI で初めて検査される）` を要約します。`skipExit` に書けるのは 78 だけで、ほかの値は終了2です。
`skipExit` を書いていない段の 78 は今までどおり失敗で、書いた段でも 78 以外の非0は失敗です。`preflight` と `hooks.beforePR` には効きません。
`skipExit: 78` を書く段は、`exit 78` を意図した分岐の 1 箇所だけで返し、外部ツールの終了コードをそのまま返さないでください。

```json
{"name": "shellcheck", "skipExit": 78, "run": "if command -v shellcheck >/dev/null; then shellcheck -S warning bin/*; else echo 'shellcheck が無い'; exit 78; fi"}
```

既定は警告のみで gate は通します（終了0）。トップレベルの `"gateSkipPolicy": "fail"` にすると、失敗が無く未確認があるときは終了3（環境不備。他に失敗があれば終了1）にします。`"warn"` か `"fail"` 以外は終了2です。
`harness-gate` は結果を `<実行ディレクトリ>/.harness/gate-result.json` に残します。承認依頼（`harness-phase … awaiting-merge`）は、
その結果が PR の現在の head のものであるときだけ、未確認の検査を本文と Discord の要約に自動で載せます。
gate が定義されているのに現在の head の結果が無い（gate を回していない・head が動いた）ときは、「未確認の有無は不明」と載せます。
載せるのは表示だけで、マージの判定は変えません。gate を定義していないプロジェクトの出力は変わりません。

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

本文は ECMAScript の trim 後、owners の `<名前> が Discord で回答。` に先頭が完全一致する場合だけ1回除いて再度 trim します。
続けて先頭の `A-<番号>`（回答先の A と一致するものだけ。別の A を指す回答は非 OK）と区切りを除き、先頭語が `OK` `ok` `Ok`（全角 `ＯＫ` なども含む）で、直後が空白・`。` `.` `!` `！`・括弧・終端のときだけ承認です。
`OKではない`・`OKです`・`OK、ただし…`・`ok? まだ`・`NG`・`保留`・`LGTM` は非 OK です。
A 付き・小文字・全角で始まる回答は、OK 語の後ろが空・`です`・`ですね`・owners と完全一致する署名 `（Discord: <名前>）` だけのときに限り承認し、後ろに否定・保留・NG などが続くと非 OK です。
**従来の半角大文字 `OK`（A なし）で始まる回答は、区切りの後に `OK ではない` のような否定が続いても OK になります**（従来どおり。人が承知のうえで選んだ仕様）。
台帳原文を変更せず、マージの記録にも原文を使います。
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
`src/attention-read.ts` は readAttentionSnapshot(home)、readAttentionSequence(home)、stripDiscordAnswerPreamble(answer, owners)、isAttentionAnswerOk(answer, owners, attention)（attention は回答先の A-番号）を公開します。
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

check:ci は format と lint の両方。shellcheck 不在は、`skipExit` を宣言した gate 定義の場合は未確認として警告し、CI で確認します。
socket/spawn が EPERM なら失敗テスト名・メッセージを残し、制限のない環境で全体を再実行します。

### 更新する

ローカル環境の所有者が、再起動できる状態で行います。以下は Linux/WSL2 + Bash、`~/discord-loop-engine`、user scope の例です。
実際のインストール先と scope、`claude plugin update --help` / `claude plugin uninstall --help` / `claude plugin install --help`、GitHub の読取り権限を確認してください。
失敗した段で止まり、原因を確認してから進みます。

```bash
git -C ~/discord-loop-engine pull
claude plugin marketplace update discord-loop-engine
claude plugin update discord-loop-engine@discord-loop-engine --scope user
```

marketplace の取得とインストール済み plugin の更新は別です。同じ version のままでは cache の内容は更新されず、`latest` と出ても内容が古い場合があります。
plugin の cache が古いと、worker の PATH に `harness-codex` などの入口が入らず、許可を足しても届きません。

user scope の marketplace checkout は `~/.claude/plugins/marketplaces/discord-loop-engine` です。冒頭で pull した開発用クローン `~/discord-loop-engine` とは別のディレクトリです。
`claude plugin list --json` で対象の version・installPath・有効/無効の状態を確認し、次をこの marketplace checkout と照合します。

- version を、marketplace checkout の `.claude-plugin/plugin.json` と比較する。版の一致だけで更新成功としない。
- installPath と marketplace checkout の `skills/concierge/SKILL.md` を比較し、そのリリースで変更されたファイルも確認する（代表1件だけでは全配布物の一致を証明できません）。
- installPath の `bin/harness-codex` が存在し、実行可能であることを確認する。

内容が古いままなら、有効/無効の状態を控えてから同じ scope に再インストールし、上の観点と状態の保持を再確認します。

```bash
claude plugin uninstall discord-loop-engine@discord-loop-engine --scope user --keep-data
claude plugin install discord-loop-engine@discord-loop-engine --scope user
```

内容を確認したら、engine と既存セッションを順に再起動します。まず engine を停止します。

```bash
dle down
```

起動していないときは「起動していません」と出て非0になります。稼働中の停止に失敗した場合は原因を確認してください。
停止指示はすぐ戻るため、次で engine が停止になったのを確かめてから起動へ進みます。

```bash
dle status
```

停止を確認したら起動します。

```bash
dle up
```

窓口が立ち上がったら（15 秒ほど）、既存セッションを再起動します。`dle down` では窓口と worker のセッションは止まりません。

```bash
dle restart --all
```

busy で見送られたセッションは作業完了後に `dle restart <名前>` で再起動し、新しい窓口/worker がロードした版と bin を確認します。
engine・plugin・CLI・worker の配置と版を揃えてください。許可とスキルはセッションの起動時に読み込まれます。

### Codex の設定移行

Codex の既定値と配布雛形は次のコマンドです。`codex.command` は固定の文法（`codex` の後に `-C {worktree}` を 1 回、`-c <許可された key>=<値>`、`--model <名>`、`exec`、`--sandbox <workspace-write|read-only>` だけ）に全体一致するときだけ使われ、外れたもの（bypass・`--yolo`・danger-full-access・引用・`$` などを含むもの）は警告（stdout の `warning: bypass-rejected`。プロジェクトごとに初回だけ）を出して、上の既定で起動します。設定の書き換えはしないので、各プロジェクトの設定はオーナーが直してください。

```text
codex -C {worktree} -c model_reasoning_effort=high -c sandbox_workspace_write.network_access=true exec --sandbox workspace-write
```

`workspace-write` では `$HOME` は読取り専用です（codex-cli 0.164.0 で確認）。ネットワークを許しても `~/.npm`・`~/.cargo` 等のキャッシュ書込みや、
依存導入・ビルドが失敗しえます。依存導入は worker 側の `hooks.afterWorktree` か gate で行い、Codex の書込み範囲は広げません。
一時領域・追加 root の可否は実設定に依存し、外側の sandbox・OS・組織ポリシー・認証・プロキシをネットワーク設定で越えることはできません。

engine 側の harness.json に `codex.command` を明示しているプロジェクトのうち、文法に合うものは既定値の変更が効きません。
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
| 🙆‍♂️ を付けても進まない | 付けた人が `allowedUserIds` にいるか、マージ承認の投稿か（要件確認・要対応などは文字で返す）、すでに対応済みでないか。engine のログの `リアクションを無視`（理由）と、起動時の `リアクションで OK`（設定の絵文字）を見る。受け付けられた（「OK として受け付けました」が返った）のにマージされないときは、head が動いた・CI が通っていないなど `harness-merge` の検査で止まっている（新しい承認依頼を出し直す）。受け付けた回答は取り消せない |
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

### 投稿の見出しと、依頼の印

engine が出す投稿（窓口の返信・A-番号の依頼・マージ完了・お知らせ・CI 失敗・許可確認など）は、1行目が
「アイコン **[プロジェクト名]** 種類（A-番号・Issue 番号）」の見出しで、最後が `───` です。2000 字を超えて
分けた投稿は、2通目以降の見出しに「（続き）」が付き、`───` は最後の1通だけです。ボードと、engine を通らない
webhook の通知は対象外です。

A-番号の依頼の元メッセージには、Bot がリアクションで状態を示します（本文は書き換えません）。

| 印 | 意味 |
|---|---|
| なし | 未回答（開いている） |
| ✅ | 回答を記録した（OK でも NG でも付く） |
| ☑️ | 回答なしで閉じた（新しい依頼への置き換え・作業再開・完了） |

印には Bot の Add Reactions / Read Message History 権限が要ります。付けられなかったときは回答・作業を止めず、
engine のログに残すだけで、あとから付け直しません。依頼を出したチャンネルを `defaultChannelId` から変えた
後の古い依頼には付きません。窓口の返信の「（続き）」への返信には A-番号・Issue 番号が付きません。

#### リアクションで OK を返す

許可されたユーザー（`allowedUserIds`）がマージ承認の投稿に 🙆‍♂️ を付けると、文字で「OK」と返したのと同じに
受け付けられます（長文で分割された投稿は、どのメッセージに付けても効きます。ただし、この機能の導入前に出た旧い依頼は先頭のメッセージだけが効きます）。

- 対象は今のところマージ承認だけです。要件確認・要対応・設定の確認などは文字で返してください（リアクションは無視されます）
- 受け付けると「A-NNN を OK として受け付けました」が返り、元の投稿に ✅ が付きます。✅ を付けても受け付けません（ダブルタップの誤操作を避けるため）
- 最初の 🙆‍♂️ だけが有効です。外す・別の絵文字に変える・対応済みの依頼に付けるのは無視されます。**受け付けた回答は取り消せません**。マージ前なら窓口に頼んで worker を止められる場合があります
- マージの検査（台帳の OK・head の不変・CI）は文字の回答と同じで、リアクションでも緩みません
- engine が止まっている間のリアクションは拾いません。`defaultChannelId` を変えた後の古い依頼にも効きません
- 絵文字は設定 `reactionEmoji` で変えられます（`false` で無効）

### コマンド

| コマンド | 用途 |
|---|---|
| `dle up` / `dle down` | 常駐の開始・停止（窓口と worker のセッションは止めない） |
| `dle status` | engine・Discord・セッションの状態とボード |
| `dle add <owner/repo またはパス> [--native <コマンド> \| --harness] [--tmux-session <名前>] [--name <名前>]` | リポジトリを登録（worker が自動で起動） |
| `dle projects [--json]` | 登録済みのリポジトリ（モード・接続中か・設定の確認待ちか） |
| `dle tasks [--all]` / `dle attention` / `dle board` | 台帳を見る |
| `dle restart <concierge またはプロジェクト名>` | セッションを起動し直す |
| `dle restart --limited` / `dle restart --all [--except 名前]...` | 使用量の上限で止まった worker だけ／窓口を含む全員を起動し直す（`--except` は複数指定可。作業の入力中の worker は見送って一覧に出す） |
| `dle mode <名前> harness\|native [--command <コマンド>]` | 進め方を切り替える |
| `dle doctor` | 必要なものが揃っているか |
| `dle runner status [--json]` | self-hosted runner（専用ユーザー `dle-runner`）の状態。sudo 不要・読み取りだけ |
| `dle runner start\|stop\|update [名前...\|--all]` | 実行すべき `sudo` コマンドを表示する（dle 自身は実行しない。終了コード 1） |

### self-hosted runner（`dle runner`）

private リポジトリの CI をこの PC（WSL2）の self-hosted runner で走らせ、GitHub Actions の無料枠を使わないための仕組みです。
runner は専用の OS ユーザー `dle-runner` の下に、リポジトリごとに登録します（systemd のユーザーサービスを runner ごとに 1 つ）。
**セットアップ・登録・起動・停止・更新は人が（sudo で）行い、dle は状態の確認とコマンドの表示だけをします。**
トークンは dle も worker も扱いません。

安全の前提:
- **private のリポジトリだけに登録する**。起動のたびに `runner-start.sh` が登録先を確認し、public なら起動しません（終了コード 71）
- job は `dle-runner` の権限で動きます。jonnity の資格情報（gh・ssh・Discord Bot トークン）には届きません（`/home/jonnity` が 0750）
- `PrivateTmp`・`InaccessiblePaths` は **事故防止であって防御ではありません**。job は同じ uid で `systemd-run --user` などにより迂回できます
- **WSL interop**（Windows の実行ファイルの起動）は、`binfmt_misc` の `WSLInterop` を無効化し、再起動後も戻らないようにしてから登録します。有効な間は `runner-start.sh` が起動を拒否し（終了コード 72）、`dle runner status` が `⚠ interop 有効` を出します
- 登録した時点から、リポジトリに push できる人は誰でも `runs-on: [self-hosted, linux, dle]` の workflow をこの PC で走らせられます。登録は検証の直前に行い、検証後は切り替えの日まで runner を止めておきます

#### セットアップ（オーナーが一度だけ。sudo が要る）

`<リポジトリ>` はこのリポジトリのチェックアウト、`<コミット>` は入れる内容を読んで決めたコミットです。**root 所有の場所に入れるファイルは、入れる前に内容を読み、作業ツリーでなく `git show <コミット>:<パス>` の出力から入れます。**

```bash
sudo adduser --disabled-password --gecos "" dle-runner     # sudo・docker グループに入れない
sudo loginctl enable-linger dle-runner                      # WSL の再起動後に user manager を起動する
H=$(getent passwd dle-runner | cut -d: -f6)
sudo chmod 711 "$H"                                         # jonnity から状態を読めるように（通り抜けだけ）
sudo -H -u dle-runner install -d -m 755 "$H/actions-runners"
sudo install -d -m 755 /usr/local/libexec/dle /usr/local/libexec/dle/baseline
# runner-start.sh・job-completed.sh を /usr/local/libexec/dle/ に、dle-runner@.service を /etc/systemd/user/ に（root 所有）
for f in templates/runner/runner-start.sh templates/runner/job-completed.sh; do
  git -C <リポジトリ> show <コミット>:$f | sudo install -m 755 -o root -g root /dev/stdin /usr/local/libexec/dle/$(basename $f)
done
git -C <リポジトリ> show <コミット>:templates/systemd/dle-runner@.service | sudo install -m 644 -o root -g root /dev/stdin /etc/systemd/user/dle-runner@.service
# cron・at を dle-runner に使わせない（先に /etc/cron.allow・at.allow が無いことを確認する）
echo dle-runner | sudo tee -a /etc/cron.deny /etc/at.deny >/dev/null
# 以降で使う関数（dle-runner の user manager を操作する。--machine は使えない。systemd-machined が無い）
DR() { local u; u=$(id -u dle-runner)
  sudo -H -u dle-runner env XDG_RUNTIME_DIR=/run/user/$u DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$u/bus "$@"; }
DR systemctl --user daemon-reload
```

**WSL interop の無効化（必須）**: `/etc/wsl.conf` の `[interop] enabled=false` は、この環境では効いていないことがあります。
`binfmt_misc` を無効化する system ユニット `templates/systemd/dle-no-wsl-interop.service` を `/etc/systemd/system/` に置いて
`sudo systemctl enable --now dle-no-wsl-interop` します。**WSL を再起動した後も、`/proc/sys/fs/binfmt_misc/WSLInterop` が無い（`echo -1` はエントリを削除するので、通常はファイルごと消える）か、あっても 1 行目が `disabled` であること**を確認してください（`dle runner status` も、`enabled` のときだけ警告します）。**再起動後にこのユニットが効くか（WSL が binfmt を登録する順序との競合）は、実機で確認していません。**
無効化すると、jonnity も Linux から `explorer.exe`・`clip.exe` などの Windows の実行ファイルを起動できなくなります。
無効化できない場合は登録しないでください。

runner の登録は 4 段階（1 展開・2 登録・3 基準値の保存・4 起動）です（runner ごと）。**各ブロックは単独で貼って動きます**（`H`・`N` を各ブロックの先頭で定義・検証し、前のブロックのシェル変数や関数に頼りません。別のシェルに貼っても `actions-runners//…` や空の `$H` にはなりません）。
先頭の `N=` を runner 名に書き換えてから貼ります（例の `oogiri-doc-1`）。Rust を使う runner は、登録・基準値の保存後、起動前に「Rust の分離・導入・復旧」の rust-bootstrap を行います。新規登録では rust-before は不要です。起動後に rust-after で Listener の環境を照合します（変更前の容量記録がなければ、容量比較は省きます）。

**runner 名の制約**: `^[a-z0-9][a-z0-9-]*$`（小文字英数字で始まり、あとは小文字英数字とハイフンだけ）。
**ディレクトリ名 1 個であり、`/home/…` のようなパスを入れてはいけません**（`actions-runners//home/…` というディレクトリができ、`dle runner status` に警告が出ます）。

登録後、status が読めるようにディレクトリの権限を整えます（`.credentials` は 0600 のまま）。
トークンは引数でなく環境変数 `ACTIONS_RUNNER_INPUT_TOKEN` で渡し（`ps` に出るため）、`umask 077` は `config.sh` の間だけにします。**`enable --now` の前に、改変検知の基準値を保存します。**

1. 展開。配布物（GitHub の runner のリリースの `actions-runner-linux-x64-<版>.tar.gz`）の絶対パスと sha256 は、リリースのページで確認した値に置き換えます（置き換えないと検証で止まります）。
   配布物は jonnity だけが書ける場所に置いてください（検査と展開の間に差し替えられないように）。展開先が既にあるときは止まります:

```bash
# [dle-runner-block:expand]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  A='<公式の配布物（tar.gz）の絶対パス。版は GitHub の runner のリリースで確認する>'
  S='<配布物の sha256>'
  [[ "$A" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo '配布物の絶対パスを指定してください' >&2; exit 1; }
  echo "$S  $A" | sha256sum -c --quiet -
  [[ ! -e "$H/actions-runners/$N" ]] || { echo '既にあります' >&2; exit 1; }
  sudo -H -u dle-runner install -d -m 755 -- "$H/actions-runners/$N"
  sudo -H -u dle-runner tar -xzf - -C "$H/actions-runners/$N" < "$A"
)
```

2. 登録。`R` は登録先のリポジトリ（owner/repo）です。実行ユーザーは `dle-runner`、カレントディレクトリは展開先の絶対パス、`--name` は `dle-<名前>`、`--work` は絶対パスです。
   トークンは `dle-runner` のシェルに人が入力します（履歴・引数・ログに残しません）。`config.sh` は標準入力を読まないよう `</dev/null` を付けています:

```bash
# [dle-runner-block:register]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  R=jonnity/oogiri-doc
  [[ "$R" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo 'リポジトリは owner/repo の形で指定してください' >&2; exit 1; }
  sudo -H -u dle-runner bash -s -- "$H" "$N" "$R" <<'RUNNER_REGISTER'
set -euo pipefail
H=$1
N=$2
R=$3
d="$H/actions-runners/$N"
cd -- "$d"
test -f "$d/config.sh"
(
  umask 077
  IFS= read -r -s -p '登録用トークン: ' TOKEN </dev/tty
  printf '\n' >/dev/tty
  test -n "$TOKEN"
  ACTIONS_RUNNER_INPUT_TOKEN="$TOKEN" ./config.sh --unattended \
    --url "https://github.com/$R" --name "dle-$N" --work "$d/_work" --labels dle </dev/null
  unset TOKEN
)
RUNNER_REGISTER
)
```

3. 登録後、status が読めるようにディレクトリの権限を整えてから（`.credentials` は 0600 のまま）、基準値を保存します。保存前にハッシュの内容を表示するので、正当な内容か確認して `yes` を入力してください:

```bash
# [dle-runner-block:baseline]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  d="$H/actions-runners/$N"
  B=/usr/local/libexec/dle/baseline
  test -f "$d/.runner"
  R_SUMS=$(for f in .runner .env .path run.sh run-helper.sh.template env.sh config.sh; do
    if [ -f "$d/$f" ]; then sudo -H -u dle-runner sha256sum "$d/$f" || exit 1; else echo "absent  $d/$f"; fi
  done)
  H_SUMS=$(for f in .bashrc .profile .bash_logout; do
    if [ -f "$H/$f" ]; then sudo -H -u dle-runner sha256sum "$H/$f" || exit 1; else echo "absent  $H/$f"; fi
  done)
  printf '%s\n' "$R_SUMS" "$H_SUMS"
  IFS= read -r -p '内容が正しければ yes: ' OK </dev/tty
  [[ "$OK" == yes ]] || { echo '中止' >&2; exit 1; }
  printf '%s\n' "$R_SUMS" | sudo tee "$B/$N.sha256" >/dev/null
  printf '%s\n' "$H_SUMS" | sudo tee "$B/home.sha256" >/dev/null
)
```

4. 起動。基準値を保存したあとにだけ行います:

```bash
# [dle-runner-block:start]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  test -d "$H/actions-runners/$N"
  test -s "/usr/local/libexec/dle/baseline/$N.sha256"
  u=$(id -u dle-runner)
  [[ "$u" =~ ^[0-9]+$ ]] || { echo 'dle-runner の uid を確認してください' >&2; exit 1; }
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" systemctl --user enable --now "dle-runner@$N"
)
dle runner status --json    # ? と警告が無いこと
```

#### PATH を変える変更の反映

Rust の分離を導入する際は、先に「Rust の分離・導入・復旧」の rust-before と rust-bootstrap を Rust 使用対象全てで完了させてから、この節で配布・再起動します。

root 所有のファイルは自動では更新されません。`templates/runner/runner-start.sh` を変えたら、セットアップと同じ形で入れ直します
（`job-completed.sh` は変更が無ければ不要）。ユニットを変えたときだけ `/etc/systemd/user/dle-runner@.service` も入れ直し、先に `daemon-reload` を実行します（下の再起動のブロックの `restart "dle-runner@$N"` を `daemon-reload` に替えて、`dle-runner@$N` は付けずに実行）。そのあとで、下の再起動のブロックをそのまま実行します（入れ直し → daemon-reload → 再起動の順）。

```bash
git -C <リポジトリ> show <コミット>:templates/runner/runner-start.sh | sudo install -m 755 -o root -g root /dev/stdin /usr/local/libexec/dle/runner-start.sh
```

走行中の job が無いことを `dle runner status` で確かめてから、runner ごとに再起動します（`dle runner stop|start` が表示するコマンドでもよい）:

```bash
# [dle-runner-block:restart]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  test -d "$H/actions-runners/$N"
  u=$(id -u dle-runner)
  [[ "$u" =~ ^[0-9]+$ ]] || { echo 'dle-runner の uid を確認してください' >&2; exit 1; }
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" systemctl --user restart "dle-runner@$N"
)
```

- run.sh に渡る PATH は固定で `/usr/local/bin:/usr/bin:/bin:<home>/actions-runners/<名前>/.cargo/bin` です（`<home>` は `getent passwd` の結果。環境変数 `HOME` は使わない）。確認処理は `/usr/bin:/bin` のままで、広げるのは exec の直前だけです。`CARGO_HOME` と `RUSTUP_HOME` も同じ runner の場所から渡します。job や `.env` による上書きは防げないため、実効環境を確認します。job や `.env` の `PATH` 行は信用しません（`.env`・`.path` の改変は `dle runner status` が検知します）
- 反映の確認は、入れ直して再起動した後に行います。Listener の 4 つの環境値は下の rust-after ブロックで、job 側は検証用の workflow で 4 つの環境値と `command -v pwsh rustup cargo rustc` を確かめます
- 標準のサービスの経路（`bin/runsvc.sh`）は `.path` を読んで PATH を設定しますが、DLE の `runner-start.sh` は `run.sh` を直接 exec するのでその経路を通りません。`.path` を直したら内容を確認してから基準値を取り直します（下の「改変検知の範囲と基準値の取り直し」）

#### Rust の分離・導入・復旧

旧共有ディレクトリへの symlink や hardlink によるコピーは使わず、runner ごとに新しい `.cargo` と `.rustup` を作ります。`credentials.toml`・`config.toml` は秘密を含み得るため、一括コピーしません。

`HOME` は共有のまま、`CARGO_HOME`・`RUSTUP_HOME` をそれぞれ `actions-runners/<名前>/.cargo`・`.rustup` に分け、Rust の実行ファイルも runner ごとに置きます。`runner-start.sh` が exec の直前にこの 2 つの環境変数と `PATH` を渡し、`HOME` は systemd の値を引き継ぎます。同じ UID で動くため、runner 間のセキュリティ境界にはなりません。また、分離だけでは同じ runner 内の cache による rustup の削除は防げません。所有者が workflow の cache 設定を確認し、同じ runner の次の job まで検証してください。

容量は Rust を使う runner の数・toolchain の版・component・target に応じて増えます。`dle runner status` が表示する容量は `_work` だけなので、Rust のディレクトリの使用量は `du`・`df` で別に確認します。

以下は所有者が実行する手順です。worker・Codex は実機を実行・変更しません。各ブロックはシェル変数や関数を引き継がずに実行できます。移行時の記録ファイルは、実行者のホームの `.local/state/dle-runner-rust/<名前>` に保存し、後のブロックで読みます（ブロック内の変数 `E` がこの記録先です）。`N` は API の表示名ではなく `actions-runners` 直下のディレクトリ名です。例の `oogiri-doc-1` を対象名に書き換えてください。

##### 通し手順と中断の扱い

既存 runner の移行は、**新規 job の受付停止と idle の確認 → 全対象の変更前記録・停止・残存プロセスの確認 → 全対象の rust-bootstrap → 設定・基準値の確認 → root 所有ファイルの配布 → 全対象の再起動 → job・基準値の前後比較と容量の確認 → 後片付け**の順で行います。ここで「全対象」は Rust を使う runner を指します。Rust を使わない runner には bootstrap は不要です。

wrapper と unit は全 instance に共通する配布物です。使う instance を棚卸しし、Rust を使う全対象の準備が終わってから配布してください。未準備のまま配布すると、`Restart=always`・自己更新・WSL の再起動による次回起動で、準備していない `CARGO_HOME` を使います。Rust を使わなかった runner に Rust の job を追加する場合も、その初回起動前に bootstrap します。新規登録では登録・基準値の保存後に rust-bootstrap を実行し、起動後に rust-after を実行します。rust-before の記録がない場合、rust-after は容量比較を省き、Listener の環境を照合します。

中断時間と対象の runner は所有者が決めます。job を無断で cancel したり、busy の runner を強制停止したりしないでください。同じ UID の他の job が共有領域へ書き込む間は、共有 Rust の修復を行いません。旧共有 Rust は保持し、新規の個別ディレクトリに rustup を再導入します。共有 `.rustup` を再利用する暫定修復が必要なら、全該当 runner を停止して別の復旧計画を立てます。自動的には共有へ切り替えません。

1. 全対象について変更前の記録を取り、停止します。新規 job の受付を止め、`dle runner status` と GitHub の busy 表示の両方で idle を確認してから貼ってください。ブロック内でも Worker の不在を確認し、実行中または確認に失敗した場合は、記録先の作成や停止へ進まず中断します。

```bash
# [dle-runner-block:rust-before]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || exit 1
  O=$(getent passwd "$(id -un)" | cut -d: -f6)
  [[ "$O" =~ ^/[A-Za-z0-9._/-]+$ && "$O" != "$H" ]] || exit 1
  E="$O/.local/state/dle-runner-rust/$N"
  d="$H/actions-runners/$N"
  test -d "$d"
  [[ ! -e "$E" && ! -L "$E" ]] || { echo "既存の記録を確認してください: $E" >&2; exit 1; }
  u=$(id -u dle-runner)
  [[ "$u" =~ ^[0-9]+$ ]] || exit 1
  worker_re=${d//./\\.}
  if pgrep -af "^$worker_re/bin/Runner[.]Worker( |$)"; then
    echo 'job が実行中なので停止しません' >&2
    exit 1
  else
    rc=$?
    [[ "$rc" -eq 1 ]] || exit "$rc"
  fi
  umask 077
  mkdir -p "$E"
  sudo cat /usr/local/libexec/dle/runner-start.sh > "$E/runner-start.before.sh"
  sudo cat /etc/systemd/user/dle-runner@.service > "$E/unit.before"
  sha256sum "$E/runner-start.before.sh" "$E/unit.before" > "$E/before.sha256"
  cat "$E/before.sha256"
  sudo -H -u dle-runner du -s -B1 "$H/.cargo" "$H/.rustup" > "$E/usage.before"
  df -B1 "$H" > "$E/df.before"
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" \
    systemctl --user stop "dle-runner@$N"
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" \
    systemctl --user show "dle-runner@$N" -p ActiveState -p MainPID > "$E/stopped.txt"
  if pgrep -af "^$worker_re/bin/Runner[.](Listener|Worker)( |$)"; then
    echo '残存プロセスを確認してください' >&2
    exit 1
  else
    rc=$?
    [[ "$rc" -eq 1 ]] || exit "$rc"
  fi
  test -s "$E/runner-start.before.sh"
  test -s "$E/unit.before"
  test -s "$E/usage.before"
)
```

Worker が実行中、または UID の取得・Worker の確認に失敗した場合は、記録先を作らず中断します。記録先が残るのは、記録取得の途中で失敗した場合、または記録後の停止・確認まで進んだ場合です。表示した `before.sha256` は、所有者が記録先の外にも保管します。記録開始後に `du` などが失敗しても、記録先は消しません。

再開時は、表示された記録先の絶対パスで各ファイル（wrapper・unit・usage・df・stopped）の存在・非空・内容と、対象 service の実際の停止状態を確認してください。記録と停止が揃っていれば、rust-before を繰り返さずに次へ進みます。記録取得の途中で失敗して不足している場合は、同じ私有親ディレクトリ内の未使用の別名（runner 名と採取日時を含む）へ移し、証拠を保持します。元の記録先が存在しないことと、受付停止・idle を確認してから、rust-before を実行し直してください。壊れた共有ディレクトリの欠落などで `du` が失敗した場合は、失敗対象と理由を記録し、所有者が存在する対象に限定して採取し直します。空ファイルは成功記録として扱いません。

記録が揃った後の停止・確認だけが失敗した場合は、記録先を移動・再作成しません。受付停止・idle を再確認し、既存の記録を保持して停止と残存プロセスの確認をやり直します。

停止の前後に job が到着する競合があるため、受付停止・idle の判定・全対象の停止完了を人が確認します。HUP・INT・TERM・親シェル終了後も、自動で runner を起動し直しません。systemd の control-group による停止と 5 分の timeout の結果を確認し、Listener・Worker とその子孫が残っていないことを確かめてください。`pgrep` だけでは全子孫の不在を証明できません。未完了なら停止状態と記録先を保持し、共有の engine・tmux や他の runner を kill しないでください。

2. **配布前に全対象で**、rustup を個別に再導入します。明示した環境変数で実行するため、新しい wrapper は不要です。Rust 本体は root として実行しません。壊れた共有領域は消さず、新規の `.cargo`・`.rustup` だけを作ります。個別ディレクトリが既にある場合は止め、内容を確認して別の復旧計画を立ててください。公式の[導入方法](https://rust-lang.github.io/rustup/installation/other.html)に従い、`--no-modify-path` で共有の profile を変更せずに導入します。

```bash
# [dle-runner-block:rust-bootstrap]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || exit 1
  d="$H/actions-runners/$N"
  test -d "$d"
  [[ ! -e "$d/.cargo" && ! -L "$d/.cargo" ]] || exit 1
  [[ ! -e "$d/.rustup" && ! -L "$d/.rustup" ]] || exit 1
  I=$(mktemp)
  trap 'rm -f -- "$I"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$I"
  test -s "$I"
  sha256sum "$I"
  sudo -H -u dle-runner install -d -m 755 -- "$d/.cargo" "$d/.rustup"
  sudo -H -u dle-runner env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin \
    CARGO_HOME="$d/.cargo" RUSTUP_HOME="$d/.rustup" \
    /bin/sh -s -- -y --no-modify-path --profile minimal --default-toolchain none < "$I"
  sudo -H -u dle-runner test -s "$d/.cargo/bin/rustup"
  sudo -H -u dle-runner test -x "$d/.cargo/bin/rustup"
  sudo -H -u dle-runner env -i HOME="$H" PATH="/usr/local/bin:/usr/bin:/bin:$d/.cargo/bin" \
    CARGO_HOME="$d/.cargo" RUSTUP_HOME="$d/.rustup" "$d/.cargo/bin/rustup" --version
)
```

表示した sha256 は取得ファイルの記録であり、既知の期待値と照合した証明ではありません。インストーラを固定の SHA・配布物で管理する場合は、所有者が確認した公式配布物と照合してください。プロキシなどが必要で `env -i` では通信できない場合は、必要な項目を所有者が確認して追加します。呼出元の資格情報は丸ごと渡しません。ダウンロードの失敗・割込み時にはインストーラの一時ファイルだけを回収し、途中生成の個別ディレクトリは消さず、停止したまま調査します。

3. 停止中に設定を確認します。`.env` に旧 `CARGO_HOME`・`RUSTUP_HOME` があれば、内容を確認して修正してください。`.env`・`.path`・ホームの基準値に差がある場合は「改変検知の範囲と基準値の取り直し」で差を確認して保存します。警告を黙らせる目的では取り直しません。各対象で `.cargo`・`.rustup` の存在、`bin/rustup` の非空・実行可能・`--version` の成功を確認し、**全対象の bootstrap が成功してから配布します**。root 所有ファイルは「PATH を変える変更の反映」に従い、レビューしたコミットから wrapper を入れ直します。unit も変更した場合にだけ入れ直し、daemon-reload します。新規登録でも、起動前に bootstrap を行ってください。

4. 準備と配布が終わったら、「PATH を変える変更の反映」の再起動ブロックを全対象へ実行します。新規登録の場合は「起動」のブロックを使います。Listener が立ち上がったことを確認してから、下の記録・環境照合ブロックを貼ってください。`HOME`・`CARGO_HOME`・`RUSTUP_HOME`・`PATH` の 4 つを照合し、変更前の容量記録がある場合にだけ容量も比較します。

```bash
# [dle-runner-block:rust-after]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || exit 1
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || exit 1
  O=$(getent passwd "$(id -un)" | cut -d: -f6)
  [[ "$O" =~ ^/[A-Za-z0-9._/-]+$ && "$O" != "$H" ]] || exit 1
  E="$O/.local/state/dle-runner-rust/$N"
  d="$H/actions-runners/$N"
  umask 077
  mkdir -p "$E"
  test -s "/usr/local/libexec/dle/baseline/$N.sha256"
  sudo -H -u dle-runner test -x "$d/.cargo/bin/rustup"
  u=$(id -u dle-runner)
  [[ "$u" =~ ^[0-9]+$ ]] || exit 1
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" \
    systemctl --user show "dle-runner@$N" -p ActiveState -p MainPID > "$E/service.after"
  PID=$(ps -eo pid=,args= | awk -v exe="$d/bin/Runner.Listener" '$2 == exe { print $1 }')
  [[ "$PID" =~ ^[0-9]+$ ]] || { echo '対象の Listener を1件に特定してください' >&2; exit 1; }
  sudo -H -u dle-runner cat "/proc/$PID/environ" | tr '\0' '\n' | \
    grep -E '^(HOME|PATH|CARGO_HOME|RUSTUP_HOME)=' > "$E/exec-env.after"
  grep -Fxq -- "HOME=$H" "$E/exec-env.after"
  grep -Fxq -- "CARGO_HOME=$d/.cargo" "$E/exec-env.after"
  grep -Fxq -- "RUSTUP_HOME=$d/.rustup" "$E/exec-env.after"
  grep -Fxq -- "PATH=/usr/local/bin:/usr/bin:/bin:$d/.cargo/bin" "$E/exec-env.after"
  test -s "$E/service.after"
  if test -s "$E/usage.before"; then
    sudo -H -u dle-runner du -s -B1 "$d/.cargo" "$d/.rustup" > "$E/usage.after"
    df -B1 "$H" > "$E/df.after"
    test -s "$E/usage.after"
    printf '%s\n' '旧共有 Rust の使用量（保持分、bytes）'
    cat "$E/usage.before"
    printf '%s\n' '対象 runner の個別 Rust の使用量（追加分、bytes）'
    cat "$E/usage.after"
    diff -u "$E/df.before" "$E/df.after" || test "$?" -eq 1
  else
    printf '%s\n' '変更前の容量記録がないため、Listener の環境照合のみ行いました。'
  fi
)
```

`service.after` は稼働状態と PID の記録です。環境の合格判定には使わず、**wrapper の exec 先から Listener へ渡った環境**を `exec-env.after` に抽出して照合します。MainPID と Listener の対応も確認し、環境全文は公開しないでください。さらに所有者が用意する一時的な検証 workflow の job 内で、同じ 4 変数と `command -v rustup cargo rustc`・`readlink -f`・`rustup show home` を確認します。Listener・`.env`・action による上書きも確認し、unit の Environment 表示は job の環境の証拠に使いません。

最低 2 つの runner を使い、各試行前に job と残存プロセスがないこと、新しい一意の目印ファイルがあることを確認します。一方だけが toolchain・cache を更新しても他方の bin・目印・設定が保持されることを **3 試行連続**で確かめてください。同じ runner の次の job も確認し、失敗したら連続数を 0 に戻します。各試行で別の run・job ID と変更前後のハッシュ・実効パスを残します。終了コード 0、期待値の一致、rustup の実体とリンクの解決成功、status の既存出力・警告の意味の維持を合格条件とします。systemd の stop・start を含む通常経路も 3 回確認します。これらは所有者が実施します。

検証 job の後にも同じ `du`・`df` で容量を測り、全導入対象の `.cargo`・`.rustup` の合計と、旧共有の保持分を別に記録します。容量のために旧共有や Rust のバイナリを自動削除しません。job が共有の固定パスへアクセスしていれば、完了とせず原因と対象を報告します。

5. 後片付けを行います。インストーラの一時ファイルは rust-bootstrap の trap で自身の分だけを回収します。記録先は証拠として保持し、旧共有の `.cargo`・`.rustup` は他の用途がないことを所有者が確認するまで削除しません。検証 workflow と目印も、所有者が作ったものだけを回収します。「削除」の手順では runner のディレクトリ全体と個別の `.cargo`・`.rustup` も消えます。再登録時には容量を確認し、再導入してください。

rollback 時はまず全対象の受付を止め、idle・停止・孤児不在を確認します。戻す元は **所有者が内容をレビューしたコミットの git show の出力**に固定します。記録先（`E`）は実行者が書ける場所なので、その before ファイルを root 所有の場所へはコピーしません。手配布版の before と同一の版が git にあるとは限りません。before の差分・記録先の外に保管した sha256 と照合して必要な動作をレビューし、rollback 用コミットとその wrapper の期待 SHA-256 を所有者が別途確定してください。同一の手配布版をそのまま復元する必要がある場合は停止を保ち、別の復旧計画を立てます。

次のブロックの R・C・S を、その絶対リポジトリパス・レビューした 40 桁コミット・事前確認した 64 桁 SHA-256 に書き換えて実行します。S はこのブロックが生成するハッシュをそのまま採用せず、レビュー時に記録した期待値を使います。取得元とインストール後の両方を照合し、wrapper は構文も確認します。このブロックは起動しません。

```bash
# [dle-runner-rollback]
(
  set -euo pipefail
  R=/absolute/path/to/discord-loop-engine
  [[ "$R" =~ ^/[A-Za-z0-9._/-]+$ ]] && test -d "$R" || exit 1
  C=レビューした40桁のコミットID
  [[ "$C" =~ ^[0-9a-f]{40}$ ]] || exit 1
  S=事前確認した64桁のSHA256
  [[ "$S" =~ ^[0-9a-f]{64}$ ]] || exit 1
  I=$(mktemp)
  trap 'rm -f -- "$I"' EXIT
  git -C "$R" show "$C:templates/runner/runner-start.sh" > "$I"
  test -s "$I"
  printf '%s  %s\n' "$S" "$I" | sha256sum -c -
  bash -n "$I"
  sudo install -m 755 -o root -g root "$I" /usr/local/libexec/dle/runner-start.sh
  printf '%s  %s\n' "$S" /usr/local/libexec/dle/runner-start.sh | sudo sha256sum -c -
)
```

unit を変えた場合も、レビューしたコミットの `git show` から取得し、別途確定した期待 SHA-256 と照合して root 所有で戻します。配置後の sha256 を確認してから daemon-reload してください。**旧共有の rustup が欠落したままなら、旧 wrapper を戻しても復旧しないため、そのまま再起動しないでください。** rollback での共有領域の修復・フォールバック方針は所有者が判断します。失敗したら停止したまま報告し、自動で旧共有へは向けません。配布の途中や SIGKILL・親の無信号終了で trap が動かない場合は、所有する一時ファイルと PID を特定して回収します。共有領域は一括削除しません。

#### 実機で確認していないこと

この節の手順と仕組みのうち、次は **実機で確認していません**（テストで確かめたのは、スクリプト・コード・テンプレートの文字列の振る舞いだけです）:
別ユーザーの systemd 操作（`sudo -H -u dle-runner env XDG_RUNTIME_DIR=…`）、`runner-start.sh` の 71 と `RestartPreventExitStatus=71` の挙動、オフライン・強制終了・自己更新の後の復帰、
`PrivateTmp`・`InaccessiblePaths` の動作、WSL interop が止まること（`/init <exe>` の直接実行を含む）と再起動後の持続、資源の上限、
自己更新で基準値の対象が変わるか、`bin/runnerversion` の有無、**フックに `GITHUB_WORKSPACE`・`RUNNER_TEMP` の環境変数が渡ること**（ソースの読み取りでは渡る見込み）、
**job から `pwsh`・`rustup` が見えること**（PATH の変更の実機での効果。Listener や `.path` が PATH を上書きしないか）。
また、`PrivateUsers` の下で `sudo -H -u dle-runner cat /proc/PID/environ` により Listener の `CARGO_HOME`・`RUSTUP_HOME` を読み取れること、
`--default-toolchain none` で rustup 本体だけを事前導入しても既存の job が動くこと、rustup-init が `env -i` の環境で通信できることも、実機での確認が必要です。
セットアップのあと、検証用の一時ブランチの workflow で確かめてください（掃除フックの目印ファイルが消えること、interop が起動できないこと、など）。

#### 日常

- `dle runner status` — 動作中か・何件走っているか・public でないか・異常停止・改変の疑い・再起動の繰り返し・interop 有効、を表示します（sudo 不要）。
  enabled のまま Listener がいなければ `⚠ 異常停止`、`disable` して止めた runner は `停止（無効化済み）`（警告にならない）です。
  警告が 1 つでもあれば終了コード 1。**public の警告が出たら、すぐ `dle runner stop --force` が表示するコマンドで止めてください**
- `dle runner start|stop` — 実行する `sudo ... systemctl --user ...` のコマンドを表示します。走行中の runner は、`--force` を付けない限り stop のコマンドを表示しません
- `dle runner update [--check]` — 最新の runner との比較と、手動で更新する手順（一時ディレクトリへの展開→検証→差し替え。失敗したら自動で元に戻す）を表示します。表示は利用者が 1 runner ずつ貼り付けて実行する前提で、展開先はホームの絶対パスで書かれます（`~` は実行したシェルの HOME で変わるため使いません）。runner は自己更新するので、実行は任意です。**更新が成功しても `bin.dle-bak`・`externals.dle-bak` などの退避（`*.dle-bak`）は残ります。起動を確認してから削除してください**（次の更新の最初に消えます）

#### 改変検知の範囲と基準値の取り直し

`dle runner status` が検知するのは、ユニットの上書き・drop-in（`~/.config/systemd/user/`）、想定外のユーザーサービス、`environment.d`、
`.bashrc`・`.profile`・`.bash_logout`、各 runner の `.runner`・`.env`・`.path`・`run.sh`・`run-helper.sh.template`・`env.sh`・`config.sh` の変更です（登録直後の sha256 との比較）。
**検知できないもの**: `bin/`・`externals/`、`hooks`、`_work` の中、メモリ上の改変、`systemd-run --user` の一時ユニット、cron・at・autostart。
**警告が無いことは、安全の証明ではありません。**
crontab は `sudo crontab -l -u dle-runner`（`no crontab` が出ること）で定期的に確認してください。

基準値は、次のときに **内容を確認してから** 取り直します（上の保存の手順のうち、対象の runner か `home.sha256` の分）:
- runner の更新（`dle runner update` が表示する手順）の後
- `.bashrc`・`.profile` を正当に変更した後
- runner の自己更新の後に `⚠ 設定の改変の疑い` が出たとき。`run.sh` などの差分が runner のリリースの正当な変更か（リリースの tar.gz の同名ファイルと比べて）確認し、確認できないときは取り直さず調査する。
  なお、自己更新で基準値の対象のファイルが変わるかは、実機で確認していません（変わるなら、更新のたびにこの手順が要ります）

#### 切り替えと元に戻す

oogiri-doc は `runs-on: ${{ fromJson(vars.CI_RUNNER_LABELS) }}` を使っているので、リポジトリ変数を変えるだけです（workflow の編集は不要）。

```bash
gh variable set CI_RUNNER_LABELS --repo jonnity/oogiri-doc --body '["self-hosted","linux","dle"]'   # self-hosted へ
gh variable set CI_RUNNER_LABELS --repo jonnity/oogiri-doc --body '["ubuntu-latest"]'              # 元に戻す
```

変数を戻しても、`queued` のまま待っている job は動きません（`gh run cancel` → `gh run rerun`）。
PC が止まっている間は、runner を指す job が待機になります（自動のフォールバックはありません）。長く止まるときは変数を戻します。
**切り替える前に**、Playwright の `--with-deps`（sudo を使うので `dle-runner` では失敗する）を、`runner.environment == 'github-hosted'` のときだけ実行するよう workflow を直してください。
secrets を使う job も全部 self-hosted になります。repository secrets は、push できる人の workflow から GitHub-hosted でも見えます（self-hosted で増えるのは、PC 上で永続的に動き LAN に届く点です）。

#### 削除

先に止めます（ディレクトリを消すと CHDIR で失敗し続けるため）。続いて、人がトークンを入力して登録を解除し、**消す対象のパスを確認してから**ディレクトリと基準値を消します:

```bash
# [dle-runner-block:remove]
(
  set -euo pipefail
  H=$(getent passwd dle-runner | cut -d: -f6)
  [[ "$H" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'dle-runner のホームを確認してください' >&2; exit 1; }
  N=oogiri-doc-1
  [[ "$N" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'runner 名にはパスを入れないでください' >&2; exit 1; }
  d="$H/actions-runners/$N"
  test -d "$d"
  u=$(id -u dle-runner)
  [[ "$u" =~ ^[0-9]+$ ]] || { echo 'dle-runner の uid を確認してください' >&2; exit 1; }
  sudo -H -u dle-runner env XDG_RUNTIME_DIR="/run/user/$u" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$u/bus" systemctl --user disable --now "dle-runner@$N"
  sudo -H -u dle-runner bash -s -- "$d" <<'RUNNER_REMOVE'
set -euo pipefail
d=$1
cd -- "$d"
IFS= read -r -s -p '解除用トークン: ' TOKEN </dev/tty
printf '\n' >/dev/tty
test -n "$TOKEN"
ACTIONS_RUNNER_INPUT_TOKEN="$TOKEN" ./config.sh remove --unattended </dev/null
RUNNER_REMOVE
  echo "消す: $d と /usr/local/libexec/dle/baseline/$N.sha256"
  IFS= read -r -p '対象が正しければ yes: ' OK </dev/tty
  [[ "$OK" == yes ]] || { echo '中止' >&2; exit 1; }
  sudo rm -rf -- "$d" "/usr/local/libexec/dle/baseline/$N.sha256"
)
```

## 設定（`~/.discord-loop-engine/config.json`）

| キー | 既定 | 内容 |
|---|---|---|
| `channelIds` | — | 中継するチャンネル（先頭が投稿先） |
| `allowedUserIds` | — | 発言を受け取る人（あなただけにする） |
| `concierge.model` | `sonnet` | 窓口のモデル |
| `concierge.refresh` | 有効 / 100k / 40 件 / 残り15% | `enabled`・`maxTokens`・`maxEvents`・`contextPercent`。文脈量または件数が閾値に達したら engine が待機中に `/clear` し、`concierge refresh` で挨拶を出さず再開。`enabled: false` で無効。旧形式の `maxEvents: 0` だけでも全無効を維持。件数だけ無効にするには `enabled: true, maxEvents: 0` |
| `worker.refresh` | 有効 / 100k / 残り15% / 180秒 / 30分 | `enabled`・`maxTokens`・`contextPercent`・`idleSeconds`・`cooldownMinutes`。ready な harness worker のみ対象。待機が続いたら `/clear` し、`worker.initialPrompt`（既定 `/discord-loop-engine:issue-loop`）で再開する。native と onboard 中は対象外 |
| `worker.refresh.codexIgnoreAfterMinutes` | 120 | 同じプロジェクト配下の Codex 窓がある間は待つ。engine が窓を観測してからこの分数残り続けたら無視する |
| `worker.wake` | `{ "enabled": true }` | `enabled`。idle の worker を engine が起こす（下記）。`false` で無効 |
| `worker.limit` | `enabled: true` / `tailLines: 12` / `wakeIntervalMinutes: 30` / `wakeMaxAttempts: 5` | `enabled`・`patterns`・`resetPatterns`・`tailLines`・`wakeIntervalMinutes`（正の数）・`wakeMaxAttempts`（0 以上の整数。0 は自動で起こさない）。使用量の上限の表示を画面から探し、止まった worker を固定間隔で起こし直す（下記）。`patterns` は行頭アンカー `^` 付きの正規表現（大文字小文字を区別しない）で、既定は暫定 |
| `worker.model` / `worker.extraArgs` | `sonnet` / — | worker のモデル（未指定・null は `sonnet`。`models` で上書き可）と追加の起動引数（例: `["--permission-mode", "acceptEdits"]`） |
| `git` | なし | worker の `git commit` の作者（`name` と `email` の両方が要る）。worker の起動時に `GIT_AUTHOR_*` / `GIT_COMMITTER_*` で渡す。リポジトリ側の `user.email` より優先される |
| `reactionEmoji` | 🙆‍♂️ | マージ承認の投稿に付けると OK になる絵文字（Unicode 絵文字1つ。サーバー独自絵文字は不可）。`false` でリアクションでの OK を無効にする。変えたら engine を再起動する |
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

idle の worker を engine が起こす。worker は idle だと次の心拍か人の入力まで Discord の回答や dispatch を読まないので、
engine が A-番号の回答・dispatch・`harness:queued` の追加（60 秒ごとに `gh issue list`）・保留分の払い出し・再接続を検知したら、
worker が idle（status idle・画面が静止して入力欄が空・直前の会話ログ更新から10秒以上）と確認できたときだけ、
入力欄に `/discord-loop-engine:issue-loop` を送る。作業中・確認画面・入力途中・判定できないときは送らず、次の30秒 tick で再試行する。
送る文字列はこの定数だけで、回答文や Issue の中身は入力しない。マージは従来どおり承認記録がなければ行われない。
`worker.wake.enabled: false` で無効にできる。この場合は新queuedのpollも無効になり、空キュー時のdispatch・回答も
次の心拍まで120分超遅れ得る。新Issue検知はactive・repo設定済み・readyなharnessプロジェクトのopenな
`harness:queued` が対象で、初回pollは記憶だけ、上限50件。ラベル無しや50件超の完全検知は行わない。

issue-loopはセッションを保持し、空キューでblockedを含む未完了Issue/PRもDependabot監視もないengine配下workerの
心拍を120分 `0 */2 * * *` にする。人間待ちだけ・Dependabot監視だけなら60分 `0 * * * *` から無変化2時間で120分へ、
実行可能な作業や未処理の回答があれば15分 `*/15 * * * *` へ戻す。状態取得失敗は空とせず現間隔を維持する。
標準cronでは旧式の分欄 `*/60` と `*/120` はともに毎時0分であり、2時間ごとにはならない。
実予約に合わせてheartbeat_intervalとloop-heartbeatのINTERVALを記録し、毎tick CronListで生存を確認、消失時は張り直す。
harness-statusの警告は記録間隔×2+5分（120minなら245分）で、起動や実処理の上限保証ではない。
単体実行の全完了・明示停止では心拍を削除し、キュー完了の通知は1回だけにする。

dispatch・新queued・回答による既存engineの起こしを主にし、心拍は取りこぼしの安全網にする。
Issueコメントの返事はセッションを起こさないため心拍で回収する。PR購読は継続し、通知消失時も状態を読み直す。
120分は予約間隔であり、busy・recurringの最大30分の遅延・sleep・上限・確認待ち・engine/session停止で処理はさらに遅れる。
7日失効は次tick/通常再開時のCronListで復旧し、tickが来なくなった場合は所有者が通常手順で再開する。
セッションを残すのでtmux/メモリとrefreshによるclear/再開消費は残る。refreshは従来どおり有効。
配布はplugin更新、workerが新スキルをロードしたことの確認、通常の実機起動確認の順に行う。
仮ルール9のdispatch/回答後の不作動時に起こす運用とは矛盾しない。ルール変更を選ぶ場合だけ、その後にrules_setし、
rules_getの一致とworker受信を確認する。保存回答の確認・人のマージOK・harness-guard・Codexのgit操作禁止を維持する。

### 自動整理の診断

自動整理の診断は `DLE_HOME/refresh/decisions/YYYY-MM-DD.jsonl`、対象と実効設定は
`DLE_HOME/refresh/coverage/YYYY-MM-DD.jsonl` に保存する（UTC日付、ディレクトリ0700・ファイル0600）。
coverage には inactive・native・onboard・設定無効・起動エラーも含む。native は独自ループ、onboard は導入中のため整理対象外。
接続断とウィンドウ欠落は decision に記録する。ソースの fingerprint は `implementationHash` で照合できるが、
実際に読み込まれた worker/plugin の版・認証・配布元は運用者が別に確認する。

decision は通常の巡回につき最大1件、同じ対象の量読取は30秒に最大1回で重ねない。
busy 中も最新 usage を独立して読み、`overThreshold` と、実際の見送り順に従う `primaryReason`、
独立観測で分かった併存理由 `blockers` を記録する。量不明は `null`、未読は `notObserved`、
内部ファイルの読取結果は `readReasons` で表す。`source` は transcript / screen / unknown。
割合しか読めない場合は token 値に換算しない。観測は整理の許可に使わず、失敗・2秒の timeout でも通常の判定を続ける。
通常 idle の整理は worker の保存応答を待たず、既存の再開プロンプトを送る。

同じ session・理由の連続記録は `count`・`firstAt`・`lastAt`・`maxTokens`・`overThresholdCount`・`unknownCount` に集約し、
理由変更・整理結果・5分経過・正常終了（INT/TERM/HUP）で保存する。journal は理由の変化だけを短く記録し、Discord 通知は増やさない。
本文・回答・絶対パスは診断へ保存しない。`count × 30秒` は正確な阻害時間ではなく、クラッシュ直前の未保存区間は欠測になる。
証拠の自動削除は行わない。比較完了まで必要な入力と診断を私有の永続領域へ保全し、容量・保持期間・バックアップは運用者が管理する。

### 文脈整理の基準取得と比較

`src/usage-summary.ts` は Node 標準ライブラリだけの単一ファイルで、私有領域へコピーして実行できる。
Claude の `projects` 配下の本体・subagent JSONLを集計し、assistant usage を `message.id` で重複除外する集計仕様案。
Codex 使用量は含めない。期間は絶対時刻の `[from, until)`、終了済みの各7×24時間を指定する。
同じ id・usage・帰属・UTC日の重複は1件とし、競合、id欠損、読取不能、途中末尾行は `complete:false` にする。
role/project は JSONLの明示的な `dleRole` / `project` を使い、なければ unknown として数える。
パス名から役割を推測しない。比較対象の範囲、帰属、重複競合、期間境界は元の計測規則と同一入力で照合してから運用比較へ使う。

1. 診断・原因修正の導入前に、実設定・版・対象とログの権限/容量を確認する。停止・ローテーション等で対象JSONLの書込みを確定させる。
2. 次の Bash で私有の永続runを作り、診断導入前の時刻Bと前窓を固定して取得する。既存の出力先は上書きできない。

```bash
umask 077
MEASURE_ROOT="${DLE_MEASURE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/discord-loop-engine/context-measure}"
[[ "$MEASURE_ROOT" = /* && ! -L "$MEASURE_ROOT" ]] || exit 1
mkdir -p "$MEASURE_ROOT" && chmod 700 "$MEASURE_ROOT" || exit 1
MEASURE_DIR=$(mktemp -d "$MEASURE_ROOT/run.XXXXXX") || exit 1
export MEASURE_DIR
cp src/usage-summary.ts "$MEASURE_DIR/usage-summary.ts" || exit 1
node --input-type=module <<'JS' || exit 1
import { writeFileSync } from "node:fs";
import path from "node:path";
const end = new Date();
writeFileSync(path.join(process.env.MEASURE_DIR, "window.json"), JSON.stringify({
  beforeFrom: new Date(end.getTime() - 7 * 86400000).toISOString(),
  beforeUntil: end.toISOString(), deploymentAt: null, afterUntil: null
}, null, 2) + "\n", { mode: 0o600 });
JS
BEFORE_FROM=$(jq -r .beforeFrom "$MEASURE_DIR/window.json") || exit 1
BEFORE_UNTIL=$(jq -r .beforeUntil "$MEASURE_DIR/window.json") || exit 1
node "$MEASURE_DIR/usage-summary.ts" snapshot --claude-home "$HOME/.claude" \
  --from "$BEFORE_FROM" --until "$BEFORE_UNTIL" --out "$MEASURE_DIR/before" || exit 1
jq -e '.complete == true and .schemaVersion == 1' "$MEASURE_DIR/before/summary.json" >/dev/null || exit 1
printf '%s\n' "$MEASURE_DIR"
```

3. summary/manifest/report と選択JSONLの私有コピー（input）の bytes・hash・形式を確認する。
   `complete:false` は終了3、引数不正は2、I/O失敗は1、完備した集計は0。欠測を0として比較しない。
   総量と project/role/model/UTC日別の input・cache creation・cache read・output・call数・平均文脈を summary に保存する。
   原因修正を導入する場合だけ、通常の承認・配布手順を経て、導入時刻T・版・設定・同時変更を同runの deployment.json に記録する。
   診断のみなら基準と証拠を保全し、効果計測へ進まない。診断導入〜原因修正導入の移行区間は前後窓から除外する。
4. 原因修正の導入確認時に次を一度実行し、Tと後窓を固定する。別シェルでは表示済みの絶対runパスを `MEASURE_DIR` に設定する。

```bash
export MEASURE_DIR
node --input-type=module <<'JS' || exit 1
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
const file = path.join(process.env.MEASURE_DIR, "window.json");
const window = JSON.parse(readFileSync(file, "utf8"));
if (window.deploymentAt !== null) throw new Error("導入時刻は記録済み");
const start = new Date();
window.deploymentAt = start.toISOString();
window.afterUntil = new Date(start.getTime() + 7 * 86400000).toISOString();
writeFileSync(file + ".tmp", JSON.stringify(window, null, 2) + "\n", { mode: 0o600 });
renameSync(file + ".tmp", file);
JS
```

5. T+7日後、同じコピーを使って比較する。7日未経過はCLIが拒否する。

```bash
DEPLOYMENT_AT=$(jq -r .deploymentAt "$MEASURE_DIR/window.json") || exit 1
AFTER_UNTIL=$(jq -r .afterUntil "$MEASURE_DIR/window.json") || exit 1
node "$MEASURE_DIR/usage-summary.ts" snapshot --claude-home "$HOME/.claude" \
  --from "$DEPLOYMENT_AT" --until "$AFTER_UNTIL" --out "$MEASURE_DIR/after" || exit 1
node "$MEASURE_DIR/usage-summary.ts" compare --before "$MEASURE_DIR/before/summary.json" \
  --after "$MEASURE_DIR/after/summary.json" --out "$MEASURE_DIR/comparison" || exit 1
jq -e '.comparable == true' "$MEASURE_DIR/comparison/summary.json" >/dev/null || exit 1
cat "$MEASURE_DIR/comparison/report.md"
```

6. 元集計と整合する各7日・合計・差・率・call数・モデル/対象/日別配分・欠測・同時変更を照合し、効果報告を行う。
   差は after−before、削減率は (before−after)/before。before=0 は率null、表示だけ小数1桁の%にする。
   CLIには投稿機能がなく、減少だけで因果を断定しない。実装の検証と7日間の効果確認は別に扱う。
7. 比較・報告後、必要な成果物を私有保管先へコピーして hash/bytes を再確認してから、所有するrunだけを掃除する。
   元のClaudeログ・journal・台帳は消さない。永続領域を用意できない場合は計測を開始せず、一時領域へ自動fallbackしない。

### idle心拍の使用量を見積もる

`src/idle-usage.ts` は既存usage-summaryのsnapshot（summary.json・manifest.json・inputコピー）だけを読むCLI。
所有者が確認したharness workerのメインsessionIdをcontextのsessionsで照合し、cwdは正規化して登録cwdと同じか配下かを確認する。
tickはsessionIdごとに追うため、途中で `.worktrees/…` に移動しても同じtickに属する。
現在のPID記録だけで過去sessionの所属が確認できなければ追加せず、同じcwdの手動sessionをworkerと推測しない。
contextは `{"sessions":[{"sessionId":"確認済みID","cwd":"確認済み絶対パス","project":"登録名"}]}` の形で、
tickごとのtrigger/idleは入力しない。context外のsessionは対象外（out-of-scope）欄に件数・量を出し、unknownやcoverageCompleteに含めない。
context内のsessionでcwd・tick等の帰属が不明なusageはunknown。subagent・isSidechain・concierge/nativeは対象外。

メインuser行のtextに `<command-name>/discord-loop-engine:issue-loop</command-name>` があるとtick開始。
同じsessionの次の開始行だけで区切り、isCompactSummary:trueの要約行・isMeta・tool_result・peer/task_notification/auto_continuation・channel行・end_turnでは区切らない。
開始行がturnOrigin=scheduledまたはscheduledTaskIdキーありならheartbeat、それ以外でhumanならwake_or_manual、
キー無し/その他はunknown。開始後のhuman行でもtriggerは変えない。engine起こしと手入力は区別しない。
作業ありはassistantのBashでharness-prのinbox/scan以外のサブコマンド、harness-codex（harness-codex-statusを除く）、
--helpを付けないharness-phase/merge/notify/gate、またはgh issue/pr commentを検出した場合と、
MCP・Agentのツール名のcomment/merge部分一致だけ（成否不問）。本文中の言及やstatus/inbox/scan/CronList、harnessコマンドの--helpは作業にしない。
コマンド名の前は行頭・空白・`/`・`(` を境界として照合し、`(harness-gate …)` や `$(harness-phase …)` も拾う。
コマンド名・サブコマンド名の直後が `)` でも拾う。
バッククォート直後は本文中の言及が多いため境界にせず、サブコマンドを照合し、`;` 等でつないだ読取りもidleのままにする。
主集計はheartbeat-idleのみ。heartbeat-active、wake_or_manual、unknown、out-of-scopeを別欄にし、未完了/破損はunknownへ分ける。
応答完了は、tick内で最後のメインassistant行のstop_reasonがend_turnかstop_sequenceで、その後にuser行がないこと（compact要約行を除く）。
tool_use・max_tokens・pause_turn・refusal等は未完了のまま扱う。

次のBashをリポジトリのルートで実行する。GNU date（Linux/WSL2）を使い、終了済み7×24時間窓を固定する。
別OSではNode等で同じ絶対時刻の窓を計算する。比較する場合は変更前・変更後で窓を分ける。

```bash
umask 077
IDLE_REPORT_BASE="${TMPDIR:-/tmp}/dle-idle-usage"
mkdir -p "$IDLE_REPORT_BASE" || exit 1
IDLE_REPORT_RUN=$(mktemp -d "$IDLE_REPORT_BASE/run.XXXXXX") || exit 1
IDLE_UNTIL=$(date -u +%FT%TZ) || exit 1
IDLE_FROM=$(date -u -d "$IDLE_UNTIL -7 days" +%FT%TZ) || exit 1
node src/usage-summary.ts snapshot --claude-home "$HOME/.claude" \
  --from "$IDLE_FROM" --until "$IDLE_UNTIL" --out "$IDLE_REPORT_RUN/snapshot"
```

snapshotの終了0は完備、3は欠測あり。summary/manifest/reportとinputコピーの存在・非空・JSON形式・bytes/hashを確認する。
欠測時はmanifestのissuesを読み、完全な見積もりとはしない。元transcriptは変更しない。
同じrunのcontext.jsonに確認したsessionsを保存し、同じ入力で両形式を作る。

```bash
node src/idle-usage.ts --snapshot "$IDLE_REPORT_RUN/snapshot" \
  --context "$IDLE_REPORT_RUN/context.json" --format json > "$IDLE_REPORT_RUN/usage.json"
node src/idle-usage.ts --snapshot "$IDLE_REPORT_RUN/snapshot" \
  --context "$IDLE_REPORT_RUN/context.json" --format markdown > "$IDLE_REPORT_RUN/usage.md"
```

終了0はunknownを含め出力できたことを示す。引数/構造不正は2、入力読取失敗は1。
usage.json/usage.mdの存在・サイズ・再読取り形式を確認する。JSONの4種tokenの整数が正本で、表は万単位の小数1桁へ四捨五入、
平均文脈は(input+cacheCreation+cacheRead)/callsを整数へ四捨五入（0件はnull）。同IDのusage/project/model/tick帰属が同じなら1件、
行ごとのtimestampは照合に含めず、代表時刻はそのIDの最初の行を使う。余分な行はduplicatesに数え、
競合は分類前に全除外する。元snapshotは競合の先頭を残すので、両方の重複/競合件数と差を照合する。
snapshotのcompleteと分類範囲のcoverageCompleteは別で、context外のsessionは分類範囲の判定から外す。unknownの件数・量・理由を0消費扱いしない。
起動・再起動直後のtick開始前のターン（起動プロンプト・dispatch処理）はmissing-tickとしてunknownになり、workerが集計窓の中で再起動されるとcoverageCompleteはfalseになる。

unknownの帰属不明・キー欠損・未完了等で主集計が小さく出得る。混在tickは、次の開始行までにisCompactSummary:trueでもisMetaでもtool_resultでもなく、
turnOriginがhumanまたはキー無しのuser行が入るtick。新ターン後の作業はheartbeat-activeに移り、作業の無い手入力の分は
heartbeat-idleに足される。両方向の誤差は混在tickのidle/active別件数・call数・token欄を見る（主集計の内数）。
MCP・Agentのツール名の部分一致は実データでは当たらず、作業あり判定は実質Bashの検出だけ。
dleのreportツールは作業ありに数えないため見逃しになる（reportのみでidle=trueのtickが実データにある）。
指定外の作業（git commitによるコミットやgh pr createによるPR作成等）の見逃しやcommand中の文字列一致による除外もある。
`harness-gate --classify` は分類だけをJSONで返す読取りだが、作業入口として数える既知の誤差がある。
途中のhumanターンも開始行までのtickに含め、reportのみならidleとして集計する。

集計窓のsession/cwdと起点キー形式別件数を照合する。共有する場合はusage.mdから公開用の要約を作り、
期間・規則・分類/混在別の件数と量・unknownの理由・対象外の量・元集計との差・帰属方法を残す。
絶対パス・session識別子・本文・私有context/snapshotは公開用本文へ入れない。
プラン制限への換算や削減率は出さない。成果物は同じrunで保管し、不要な採取一時物はそのrunの所有物だけ掃除する。
元ログ・台帳・他runは削除しない。

### 使用量の上限で止まったとき

engine は30秒ごとに各 worker の画面の末尾（`worker.limit.tailLines` 行）を読み、`worker.limit.patterns` に合う行があれば
「上限で止まっている」とみなして、窓口に1通だけ知らせる（一覧・画面から読めた復帰時刻・手順）。通知は上限の
エピソードごとに1回で、誰かが上限中のうちに別の worker が加わっても再通知しない。全員が解除されるとエピソードが終わる。
復帰時刻の表示は画面の文字列のままで、制御には使わない。再起動はしない。

上限中の worker は、検出から `wakeIntervalMinutes`（既定30分）後に、idle を確認したうえで `/discord-loop-engine:issue-loop` を
送って起こし直す（`worker.wake` が有効なときだけ）。まだ上限なら待ちを倍にして再試行する（30→60→120→240→480分、
最大 `wakeMaxAttempts` 回）。上限中は、他の理由（dispatch・回答など）の起こしはこの再試行のときにまとめて送り、
上限中の自動の整理（`/clear`）は止める。最後の起こしでも復帰しなければ、窓口に1回だけ知らせて止める
（エピソードごとに1回、worker が複数でもまとめて1通）。起こした後は、作業中の画面になるまで上限の解除と数えない。

1. 別のアカウントに切り替える
2. `dle restart --limited`（上限中の worker だけ）か `dle restart --all [--except 名前]`（窓口を含む全員。除外できる）
3. 再起動した harness の worker は、`issue-loop` が `tasks_list` の `次にやること` を読んで続きから再開する

> **未確認（実機で確かめて、この欄を結果に書き換える）**
> - 上限時の実際の画面の文言。既定の `patterns` / `resetPatterns` は暫定で、文言が違うだけなら設定で差し替える（下の字下げ・`⎿` の場合は除く）
>   （採取: `tmux capture-pane -p -t <セッション>:dle-<名前> | tail -30`。アカウント名などは伏せる）
> - 上限の行が `⎿` の下や字下げされた位置に出る場合は、`patterns` を変えても検出されない（`src/limit.ts` の除外規則を直す必要がある）
> - `dle restart` した新しい窓が、切り替えた新アカウントを拾うか／`/login` が要るか。tmux サーバーが最初の
>   セッションの環境を保持するため、古い環境のままになる可能性もある。切り替え後に新しい窓で `/status` を確認する

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
  exit 10 だけで代行を決めません。拒否時の自動再試行・直接起動・フラグ変更・許可追加による迂回は行いません（engine が組み込みで渡す `harness-codex start` / `stop` を除く）
- 届くのはセッションが動いている間だけです。窓口が止まっている間の発言は保存しておき、起動したら渡します

### Codex の起動と拒否時の案内

全ての起動・再起動は [issue-cycle の共通起動手順](skills/issue-cycle/SKILL.md#codex-の共通起動手順) に従います。
依頼ファイル作成・stop・フェーズ変更を準備で済ませ、解決済み絶対パスを引用した `harness-codex start` の1コマンドを
単独の Bash ツール呼び出しで実行し、監視は別の呼び出しに分けます。worker の許可には `harness-codex start` と `harness-codex stop` だけを足します（`tmux new-window`・`codex exec` は許可しません）。引数・窓の所有はラッパーが検証します（窓名 `codex-(spec|impl)-<n>`・worktree が `harness-config --worktree <n>` と一致・依頼ファイルは `.harness/` の下）。許可を足した効果（分類器の拒否が止まるか）は実測待ちです。依頼ファイルの検査（realpath）と複製の読み出しの間には狭い競合が残ります（塞いでいません）。

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

プラグインに効く変更の版更新は、[プラグインのリリース手順](docs/plugin-release.md)を参照してください。

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
| UI 変更の型（統合の先行質問・配置図の事前合意・状態の組合せ試験・旧配置の全文検索・viewport×状態の実測表・NG 時の期待形の確認）。画面に触れる Issue だけ | Phase 1・2・3・4・5-1・軽い実装レビュー・5-2・5-4・Phase 6 NG | U80a〜U80e | 実際の UI Issue で質問・表が過不足ないか、NG 後に期待形を確かめてから直したか |
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

### Dependabot PR の承認とマージ

harness プロジェクトで、作成者が厳密に `dependabot[bot]` **かつ** head が `dependabot/*` の PR **のみ**に対応します。
同じ repo の open・非 draft PR だけが対象です。main の `.github/dependabot.yml` がある、または対象の open PR がある
プロジェクトだけを worker が心拍で監視します。全ページの読取り失敗は「対象なし」と扱いません。

`harness-pr scan` は状態一覧、`harness-pr inbox` は保存済み回答と待ち状態を JSONL で返します。
CI green 後に `harness-pr request --pr N` で承認 head SHA を固定した A-番号を発行します。
人の A への実回答の OK 後、`harness-merge --pr N` が現 head・CI・依頼・台帳を再検証します。
PR 本文は依頼・A.summary・通知・scan/inbox に含めません。内容は PR リンクで確認してください。
GitHub の OK/Approve/merge-ok ラベルだけではこの経路の承認になりません。GitHub の手動マージは可能です。
PR 専用依頼には A を発行できる engine が必須です。webhook だけで A なしの完成依頼にはしません。
既存の Issue/fix ブランチの GitHub 承認・webhook 経路はそのままです。

PR の枠は Issue の maxParallel と別で、プロジェクトごとに同時1件、created_at→PR 番号の古い順です。
同じ head の完成依頼は再利用し、pending/復旧未確認・rebase 待ち・OK 後・キュー待ちも枠を保持します。
owner NG/非 OK、rebase 期限切れ、auto-merge 有効での停止、Approve 後の停止や保護不足は、info 後に枠を解放します。
owner NG は open A をシステム理由で解決します。システムによる置換・完了解決は OK になりません。
NG/非 OK 後は新 head でも自動再依頼しません。原因解消と窓口経由の人の再依頼を確認した場合だけ、
worker が `harness-pr request --pr N --retry` で新 A を発行し、新しい OK を待ちます。
retry も指定 PR だけを対象とし、枠使用中や先行候補があれば理由付きの非0です。窓口へその理由を返します。

CI 未登録（`statusCheckRollup` が null）の PR は CI 待ち（0 件）として扱い、`request` 全体は止めません。
CI 未登録の behind/dirty PR も rebase 依頼の対象です。読めない応答で失敗するときは、どの PR・どのページ・どの条件かを1行で出します。

behind/dirty の rebase は枠に入る候補と OK 後のマージ段階だけで依頼し、head が変われば CI と新 A からやり直します。
**解釈**として rebase の期限は120分です。再起動しても開始時刻を延長せず、同じ head のコメントを増やしません。
新経路の CI green は SUCCESS が1件以上で全件 SUCCESS/NEUTRAL/SKIPPED、CheckRun は COMPLETED が必要という解釈です。
チェックなし・全 skip/neutral は依頼しません。同一 repo 限定・maxParallel 枠外・台帳の A の OK のみも解釈です。

設定済み mergeMethod と beforeMerge を使います。beforeMerge がある場合だけ承認 SHA の一時 worktree を作り、
Issue は空、PR 番号と一時 worktree/main の変数を渡します。依存導入や afterWorktree は追加せず、準備も既存 hook の責務です。
hook が0件なら fetch/一時 worktree を作りません。実行上限180秒は解釈です。空 Issue・一時 worktree・上限に
対応しない hook は省略せず止めます。main や Issue の既存 worktree で代用しません。

レビュー必須の場合も人の A の OK 後だけ、その head に Approve します。直前に auto_merge が厳密に null と確認できなければ停止し、
有効なら Approve せず PR/head ごとに1回知らせます。Approve 後にも auto_merge・head・CI・A・保護状態を確認します。
停止時は Approve が残ることと理由を1回知らせ、dismiss はしません。stale な Approve は保護設定によって新 head でも
必要レビュー数に数えられうるため、dle はマージを止め、新 head の新 A を待ちます。worker が直接 Approve したり auto-merge を有効にしたりしません。
必要レビュー数/CODEOWNERS/不足権限を迂回しません。merge queue は実 merged まで待ち、投入を繰り返しません。

実 merged/head の確認後だけ、同じ SHA の exact remote branch を削除し、PR の done を通知します。外部 closed は done にしません。
依頼進行の復旧記録は成功時に消しますが、rebase・info の送信意図/結果・枠解放の記録は独立して保持します。
送信結果不明は成功扱いや自動再送にせず、未完了は復旧確認後の明示 retry だけで再依頼します。
マージ済み・後始末未完了は実 state を再取得し、マージを再送せず削除/回収/通知だけを再開します。
通知自体の結果不明は自動再送せず、人が確認します。残存 lock と一時物は所有 PID・起動時刻・専用パスを確認し、
実行中の hook/子孫が停止してから所有領域だけを回収してください。共有 worktree の一括回収はしません。
既存 runner は直接の子を扱い、強制終了時の子孫・孤児の終了までは保証しません。

実 GitHub/Discord の認証・権限、auto_merge 応答、Approve/rebase/削除、対象保護・queue と hook の適合は
fake 試験と区別して実環境で確認してください。この repo の read-only CI だけでは実効性を証明できません。

### 実 diff による軽微判定

`harness-gate --classify [--pr N] [--] [dir]` は分類だけを JSON で返します。品質コマンド・hook・通知・
phase・gate-result・経路記録は変更しません。light/normal は終了0、引数/設定不正は2、取得不能は3です。
通常の `harness-gate [dir]` は従来の検査を全部行い、その前後に分類結果を標準エラーへ記録します。
先頭が `-` のディレクトリは `harness-gate -- -docs` / `harness-gate --classify -- -docs` で指定できます。

対象は merge-base からの累積差分と index・作業ツリー・未追跡。classifier は fetch や ref 更新を行わず、
worker が更新した origin/base の鮮度を読取り専用の ls-remote で照合します。PR 指定時は GitHub の現在の
head/base を固定し、同一 repo の OPEN と local HEAD 一致を確認します。履歴不足や不明点は省略の根拠にしません。
NUL 区切りで path を解析し、rename の両側、削除元、全変更層を検査します。
分類では実行ビットを検査し、assume-unchanged/sparse など index の除外フラグがある場合は通常へ倒します。

初期の light 候補は通常の `.md` と docs 内 `.txt`、または同じディレクトリの `package.json` と
`package-lock.json` の依存変更対です。bin/hooks/skills/agents/templates/.github、dot 設定や指示文書、コード、
symlink/submodule・実行権・binary・不正 UTF-8・空 diff は通常へ倒します。上限は blob 10 MiB・全体50 MiBです。
manifest は dependencies/devDependencies/peerDependencies/optionalDependencies だけの意味上の変更を許可し、
新規 runtime dependency、片側だけの変更、重複 JSON キー、lock v1/v2/workspace/link は通常です。
版範囲は exact/caret/tilde の数値3成分、lock 全 entry は npm registry の HTTPS tarball と単一 sha512 が必要です。
既存 entry も検査します。dev/peer/optional 追加は候補のままにし、hasInstallScript による追加制限は導入しません。
取得済み tarball 自体の真正性は classifier では保証せず、依存準備・verifier・gate・CI を維持します。

実 diff がある入口で light なら以降の設計作成/設計レビューを省き、実装レビューは独立 verifier 1 段です。
新規 Issue の空 diff は通常の設計を行い、実装後だけ1段化できます。既に終わった設計を省略回数には数えません。
light から normal に変われば、その Issue は設計・設計二段階レビュー・実装修正・実装二段階レビューへ戻り、
通常へ固定します。実装後・コミット後・gate 前後・PR 更新・CI 修正後・rebase 後・承認依頼/merge 呼出直前に再判定します。
head/base/policy/fingerprint が変われば旧レビューを失効させ、light 継続でも verifier をやり直します。
dirty レビューは仮の記録で、コミット後の内容 tree も照合します。経路/レビュー JSON と GitHub の進捗を照合し、
不明な履歴は通常へ倒します。ローカル JSON は承認の証拠ではありません。
全 gate・CI green・現 head の新しい人の OK・harness-phase・guard・Codex の git 禁止と WT 範囲は維持します。
merge 呼出後の base 移動を原子的に防ぐ保証は追加しません。Issue 無し Dependabot の既存経路も維持します。

### 役割モデルと移行

engine の config.json と選択 harness.json に `models` の部分上書きを指定できます。

```json
{ "models": { "window": "sonnet", "tick": "sonnet", "spec": "opus", "review": "opus" } }
```

既定 < 旧 concierge.model/worker.model < global models < project models の順で役割ごとに解決します。
worker null/欠落/空の有効値も Sonnet、空は警告です。新 models は既知 role と非空文字列を検証し、
full ID は起動時に保持します。`extraArgs` の model/agents は警告付きで保持し、model が明示されれば
resolver の --model は追加しません。既存の引数順序や agents 定義は変えません。
`harness-config --models` は要求値/出典/warnings、`--model <role>` は起動文字列、
`--agent-model <role>` は完全一致する sonnet/opus/haiku の Agent alias を返します。
full ID が Agent で未対応の場合は理由付き非0です。worker は理由を gate/レビュー記録と warnings に残し、
model 引数を省略して親モデルを継承し同じ作業を起動します。工程やレビューは省略しません。

window は共有窓口、tick は native/harness の日常 worker と通常設計レビュー/実装懐疑役、review は
最終実装 verifier、spec は設計代行へ接続します。通常の設計担当は Codex を維持し、設定上の spec=opus を
実際の設計担当モデルと混同しません。project.window が異なる場合の共有窓口の委譲方式は未決です。
監視の haiku と advisor の opus は現状を維持します。Agent full ID の変換も推測で追加しません。

1. 更新前の有効設定・出典・full ID/extraArgs/native の例外と稼働版を保存します。
2. gate/CI 後、engine/plugin/CLI を同じ版に揃え、他項目を保持した完全な profile を提案し、人の OK 後に activate します。
3. global は engine/窓口/worker、profile は対象 worker を restart します。hot reload は行いません。
4. helper と sessionTargets の探索先を照合します。不一致は診断されるので restart して揃えます。
   各役割を独立した新 session で3回連続確認し、要求値・実応答モデル・処理を照合します。
   fake 起動や依頼文のテストは実 Agent の採用/課金モデルの証明にはなりません。

### Opus 利用の変更前後の報告

1. 変更適用前に、実機で既存の Claude usage 集計方式・権限・UTC 期間を確認し、同じ方式を固定します。
   保存先は `.harness/reports/<変更番号>/<UTC-run-id>/before/`。models.json に登録 project/role/設定出典/要求モデル/稼働版、
   method.json に採取コマンド・期間・role の割当て・例外、usage.json に4種の整数 token、coverage.json に未読/欠損理由を保存します。
   採取コマンドを未確認のまま発明せず、取得不能 project は未確認と記します。生 transcript はコピー/commit しません。
2. 変更を適用・restart し、各役割の実採用と軽い/通常経路を実機で確認します。
3. 比較可能な7日の UTC 窓で同じ採取を after/ に保存します。message id で重複除外し、同ID不一致・ID無し・
   未知 project・不正 timestamp/usage を数えます。同時施策、処理 Issue/経路数も記し、差を単一変更の因果としません。
4. compare.md の project/role/出典/前後モデル/実測 Opus/4種 token/処理・未読件数/期間/例外は同じ整数集計から作ります。
   `src/harness-usage.ts` の匿名化入力は id/project/role/model/timestamp と usage の input/output/cacheCreation/cacheRead。
   期間は開始を含み終了を含まず、同ID不一致は全件を除外して件数を報告します。表示は万単位小数1桁の四捨五入を共用します。
5. 秘密/個人情報を除く summary-public.md の存在・非空・JSON と表の一致を確認し、変更後に対象の報告 Issue へ
   `gh issue comment <報告先> --repo <owner/repo> --body-file <公開本文の絶対パス>` で報告し、URL を compare.md に保存して読取り照合します。
6. 確認後に所有 temp だけを回収し、匿名化した before/after・比較・公開本文/URL は管理外に保持します。
   生 transcript は削除しません。設定一覧を実測と呼ばず、Codex token とプラン換算は含めません。

実権限・依存準備/runner・特殊な md 実行用途、各役割の実採用、実 GitHub/Discord の経路/承認/通知と
実測期間の確保・報告は実機確認が必要です。分類 CLI は Linux/bash/Git 前提で30秒上限、HUP/INT/TERM では
所有子を回収して非成功で終了します。SIGKILL/親の無信号終了は自動回収の保証外です。
PID/開始時刻を照合して残存子を止めてから、所有する一時物だけを回収し、共有 engine/tmux は止めません。
