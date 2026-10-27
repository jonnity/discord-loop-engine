// 副作用 import 専用。テストの先頭で読み込み、実行中の engine の環境を閉じ込める。
// Why not: テスト側で個別に env を組み立てる方式は、書き忘れた箇所から実 engine のソケットや
// Discord への投稿に繋がる。worker の中で素の npm test を走らせても安全にするため、一括で消す。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../tests/harness/fixtures/reject-fetch.ts";

for (const k of Object.keys(process.env)) {
	if (/^(DLE_|DISCORD_|GIT_AUTHOR_|GIT_COMMITTER_)/.test(k)) delete process.env[k];
}
// Unix ソケットのパス長制限（約 104 文字）に収まるよう短い場所に作る
const home = mkdtempSync(path.join(os.tmpdir(), "dle-iso-"));
process.env.TMPDIR = home;
process.env.DLE_HOME = home;
process.env.DLE_SOCKET = path.join(home, "engine.sock");
process.env.CLAUDE_PROJECT_DIR = home;
process.env.HARNESS_CONFIG = path.join(home, "harness.json");
writeFileSync(
	process.env.HARNESS_CONFIG,
	JSON.stringify({ project: "test", repo: "example/project", hooks: {}, notify: { envFiles: [] } }),
);
const denyImport = pathToFileURL(path.resolve(import.meta.dirname, "../tests/harness/fixtures/reject-fetch.ts"));
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${denyImport}`;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
