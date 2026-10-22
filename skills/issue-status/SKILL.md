---
name: issue-status
description: discord-loop-engine のループ状況（フェーズ別の Issue、Codex の tmux ウィンドウ、心拍、人間からの未処理の返事）を読み取り専用で一覧表示する。
---

# issue-status

`harness-status` を実行し、その出力をそのまま見せる（PATH に無ければ `${CLAUDE_PLUGIN_ROOT}/bin/harness-status`）。

- 読み取り専用。Codex への入力、ラベル変更、PR 操作、通知はしない
- 心拍が途絶えている警告が出ていたら、`/discord-loop-engine:issue-loop` で再開できることを一言添える
- inbox に `stale-notify` / `missing-notify` があれば、承認依頼の出し直しが必要なことを伝える
