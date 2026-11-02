// 子プロセスが書くファイルを、中身が空でなくなるまで期限付きで待って読む。
// Why not: existsSync だけで待つと、子の「作成 → 書き込み」の間の空を読んでしまう（#46）。
// 「非空」は「書き終わった」の保証ではないので、1回の write で済む小さな内容にだけ使う。
// 子側（スタブ・fixture）を rename での原子的な書き込みにする案は、変更範囲が広がるため採らない。
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function readNonEmpty(file: string): string | undefined {
	try {
		const text = readFileSync(file, "utf8");
		return text.trim() === "" ? undefined : text;
	} catch {
		// 作成前・作成直後の競合は「まだ」として扱う
		return undefined;
	}
}

// 戻り値は trim 前の生の内容（末尾改行を含む）。期限切れは、期限後にもう1回だけ読んでから投げる。
export async function waitForContent(file: string, opts: { timeoutMs?: number; label?: string } = {}): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? 5000;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const text = readNonEmpty(file);
		if (text !== undefined) return text;
		if (Date.now() >= deadline) break;
		await delay(10);
	}
	const last = readNonEmpty(file);
	if (last !== undefined) return last;
	throw new Error(
		`ファイルの内容が空でなくなるまでの待機期限切れ: ${file} (${timeoutMs}ms)${opts.label ? ` ${opts.label}` : ""}`,
	);
}
