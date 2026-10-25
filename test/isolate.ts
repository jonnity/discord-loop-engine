// 副作用 import 専用。テストの先頭で読み込み、実行中の engine の環境を閉じ込める。
// Why not: テスト側で個別に env を組み立てる方式は、書き忘れた箇所から実 engine のソケットや
// Discord への投稿に繋がる。worker の中で素の npm test を走らせても安全にするため、一括で消す。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

for (const k of Object.keys(process.env)) {
	if (/^(DLE_|DISCORD_|GIT_AUTHOR_|GIT_COMMITTER_)/.test(k)) delete process.env[k];
}
// Unix ソケットのパス長制限（約 104 文字）に収まるよう短い場所に作る
const home = mkdtempSync(path.join(os.tmpdir(), "dle-iso-"));
process.env.DLE_HOME = home;
process.env.DLE_SOCKET = path.join(home, "engine.sock");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
