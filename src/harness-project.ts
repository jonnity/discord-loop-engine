// 依頼と照合で登録名の探索順を揃える。設定の失敗をルート名に読み替えない。
import path from "node:path";
import { run } from "./harness-approval.ts";

export async function resolveHarnessProject(): Promise<string> {
	const config = path.resolve(import.meta.dirname, "../bin/harness-config");
	const raw: unknown = JSON.parse(await run(config, ["{project: .project}", '{"project":null}']));
	if (
		typeof raw !== "object" ||
		raw === null ||
		!("project" in raw) ||
		(raw.project !== null && typeof raw.project !== "string")
	)
		throw Error("project が不正です");
	const project = process.env.DLE_PROJECT || raw.project || path.basename(await run(config, ["--root"]));
	if (!project) throw Error("project がありません");
	return project;
}
