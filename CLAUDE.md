# CLAUDE.md

## プロジェクト

discord-loop-engine — Discord を窓口に、ローカルの Claude Code が Issue 駆動で開発ループを回し続けるエンジン。
使い方と全体像は README.md。このリポジトリ自体が Claude Code のプラグイン（とマーケットプレイス）になっている。

## 構成

```
src/            engine（常駐）と dle CLI。TypeScript をビルドせず Node の型ストリップで実行する
  engine.ts       Discord・窓口・worker・CLI の間の中継と、ツール（台帳操作）の実装
  ledger.ts       タスク台帳（~/.discord-loop-engine/）。書くのは engine だけ
  route.ts        Discord の発言の読み取り（宛先は常に窓口）
  gateway.ts      Discord Gateway の最小クライアント / rest.ts: REST
  supervisor.ts   tmux で窓口・worker を起動し続ける
  projects.ts     dle add と、各セッションの起動コマンド
channel/server.ts 各セッションに入る MCP サーバー（channel）。役割（DLE_ROLE）で出すツールが変わる
skills/           concierge（窓口）・issue-loop / issue-cycle（worker）・retrospective（自己改善）など
agents/           advisor（Opus の相談役）・harness-implementer（Codex の代打）
bin/              dle と harness-*（bash。ハーネスの入口）
hooks/            harness-guard（入口の迂回を止める）
templates/        利用するリポジトリに置くもの
test/             node --test / tests/harness/run.sh（bash スクリプトのテスト）
```

## コマンド

```bash
npm test            # engine とハーネスのテスト
npm run typecheck   # tsc --noEmit
npm run check       # Biome（--write で整形）
```

## 規約

- Biome: タブインデント・ダブルクォート。`any` を使わない
- 型ストリップで動かすため、TypeScript は消せる構文だけを使う（enum・parameter property・namespace を使わない。
  tsconfig の `erasableSyntaxOnly`）。import は `.ts` 拡張子付き
- 実行時の依存は増やさない（Discord・MCP は自前の最小実装）。増やすなら理由を PR に書く
- engine と channel の取り決めを壊す変更をしたら `src/protocol.ts` の `PROTOCOL_VERSION` を上げる
- コメントは日本語。コードには How、テストには What、コミットには Why、コメントには Why not
- 台帳のファイル形式（tasks/*.md の項目名など）は既存の利用者のデータを壊さないよう、項目の追加で変える
- 安全柵（マージに人の OK が要る・harness-guard・Codex に git 操作をさせない）を弱める変更は、Issue で合意してから
