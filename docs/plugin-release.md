# プラグインのリリース手順

プラグインに効く変更をマージしたら version を上げます。利用者の手元での操作は [README の「更新する」](../README.md#更新する)を参照してください。

## 更新判定と確認範囲

公式資料の確認日: 2026-11-08（JST）。

- [Release a new version](https://code.claude.com/docs/en/plugins/host-marketplace#release-a-new-version): コピー配布は computed version が変わると更新されます。manifest の version が marketplace entry より優先され、同じ version ではコミットが進んでも cache は更新されない仕組みです。
- [Versions and updates](https://code.claude.com/docs/en/plugins/loading#versions-and-updates): 判定順は manifest → marketplace entry → 配布元に応じた SHA 等です。marketplace の取得、plugin のディスク更新、稼働セッションへの反映をそれぞれ確認します。同版の明示 update で未完了の依存導入だけ再試行される場合もあります。
- [version の仕様](https://code.claude.com/docs/en/plugins-reference#version): version は文字列で、更新判定を semver の大小比較とみなさないでください。local path の marketplace + relative source は in-place 読込み、command source は内容ハッシュなどの例外があります。claude.ai hosted の配布にも別の扱いがあります。
- [自動更新](https://code.claude.com/docs/en/plugins/host-marketplace#turn-on-auto-update): この marketplace のバックグラウンド自動更新は既定 off で、利用者または管理者の有効化が必要です。

上記の公式資料と隔離実測で、version が同じままだと cache が更新されないことを確認しました。隔離実測は公開 GitHub の実コミット間の更新・認証・ネットワークを保証しません。CLI の版や source の違いにも留意し、実機では README に沿って実ファイルと再起動後のロード版を確認します。

## リリース対象

skills/・agents/・bin/・hooks/・.claude-plugin/ の変更を対象にします。スキルの Markdown も実行時の指示なので含みます。

channel/・src/・.mcp.json・templates/ の変更も対象にします。`.mcp.json` が `${CLAUDE_PLUGIN_ROOT}/channel/server.ts` を起動し、channel が `src/protocol.ts` と `src/tools.ts` を import、`bin/dle` が `src/cli.ts` を実行します。engine の `profile_template` は plugin root の `templates/profile.example.json` と `templates/examples/` を読みます。いずれも配布 cache の内容に依存するためです。templates/ は bin/・hooks/・skills/・agents/ と同様に、通常の説明文書とは区別します。

通常の説明文書だけの変更には bump を要求しません。

## 担当とタイミング

対象変更のマージ後、所有者が別リリース PR を作成し、次の利用者更新の案内までにマージします。対象作者/worker は版更新の必要性を所有者へ伝えます。複数の対象マージをまとめる場合は、PR に含む範囲を明記します。

採用する方式と対象 PR 内で上げる方式の得失は次のとおりです。

| 方式 | 得失 |
|---|---|
| 対象 PR の中で上げる | 変更と版更新が同時に入り、取りこぼしを防げる。並行 PR で版が衝突する |
| マージ後に別リリース PR で上げる（採用する方式） | 複数変更をまとめられる。main が進んでも版が古い期間が生まれ、人の作業が増える |

対象・担当・タイミング・版の基準・更新方式の方針を変えるときは、この文書を更新します。

リリース PR は既存 CI の成功と人の新しいマージ OK を経ます。harness-guard と Codex の git 操作禁止を維持し、git の書込みは worker/人が担当します。版更新 PR の自動作成は行いません。

## 変更する値と確認手順

1. 最新 main の両現在値と既存履歴を確認し、対象変更とリリース範囲を揃えて未使用の版を選びます。並行リリースや競合があれば、マージ前に最新版を取り直して選び直します。
2. `.claude-plugin/plugin.json` の top-level `version` と、`.claude-plugin/marketplace.json` の `plugins[]` から `name` が `discord-loop-engine` の entry を選んだ `version` を、同じ値に更新します。配列の先頭固定で選ばないでください。
3. 両 JSON の妥当性に加え、選んだ期待リリース値との厳密一致を確認します。既存 CI を通し、通常のレビューと人のマージ OK を経て配布します。
4. マージ後、README の手順で取得元と installPath の代表 skill・対象変更ファイル・bin を照合し、engine と窓口/worker の再起動後のロード版を確認します。

manifest が存在する構成では marketplace entry だけを上げても更新に効きません。公式は version の二重定義を避けることを推奨していますが、既存の二重定義を維持する間は両値を同期します。
`package.json` / `package-lock.json` の版と `PROTOCOL_VERSION` はプラグインの版に連動させません。通信の取り決めの変更は従来の protocol 更新規約に従います。タグや GitHub Release の作成は必須にしません。

対象コードがマージ済みでも版更新が配布されるまで、通常 update で新内容が届くとは案内しません。必要な利用者は README の再インストール手順で内容を確認します。

## 版の選び方

数値3成分 `major.minor.patch` を使い、次の基準で選びます。これは本プロジェクトの運用方針で、Claude Code の必須仕様ではありません。

- 後方互換の修正・指示改善は patch。例: `0.1.1 → 0.1.2`。
- 互換性のある機能追加は minor。例: `0.1.1 → 0.2.0`。
- 互換性を壊す変更は、移行手順と版をリリース PR のレビューで合意します。

例は次のリリース版を指定するものではありません。同じ版を再利用せず、この基準に沿って選定します。

## 自動化・二重定義解消の提案

以下は比較提案です。自動採番・helper・npm scripts・CI 検査は追加しません。

第一候補は、公式の [Release a new version](https://code.claude.com/docs/en/plugins/host-marketplace#release-a-new-version) にある、manifest と marketplace entry の両方から version を省く方式です。commit を追跡するため採番や上げ忘れがなくなり、二重定義も消えます。一方、説明文書だけの commit でも更新が走り、版名は SHA になります。採用には、明示 version を上げる方針の変更が必要です。

明示 version を維持する第二候補は、手動起動 helper です。Node と jq を使えば依存追加なしで小さく実装できます。例えば `npm run plugin:bump -- patch|minor` で対象 entry を名前で選び、旧2値の一致と未使用版を確認して両方へ同じ値を書き出します。このコマンドは提案例です。版の基準と起動時点は上記の方針に従い、git 操作は含めません。起動忘れは残ります。

二重定義の解消だけなら片方の version を削除する案もありますが、毎回の bump は必要です。両方省略・片方削除は方式変更の比較提案です。現行の手順は両値を同期して更新する方式です。

`npm version patch` は package.json と lockfile を主対象とし、plugin の2値を同期しないため、そのまま採用できません。
マージ時の自動採番には書込み権限、main の保護、同時更新の競合・再試行・重複 bump、bot の承認経路を検討する必要があります。手動 helper と同じ軽さでは扱えず、既存 CI の read-only 権限も変更しません。
