// 使用量の上限で止まった worker を、画面（tmux capture-pane の出力）の文言から見つける。
// 文言は Claude Code の更新で変わり得るので、正規表現は設定で差し替えられる。

export interface WorkerLimit {
	enabled: boolean;
	/** 上限表示の正規表現（i フラグ）。行頭アンカー `^` 付きで書く */
	patterns: string[];
	/** 復帰時刻の抽出。捕捉グループ 1 を優先 */
	resetPatterns: string[];
	/** 探す範囲（末尾の空行を除いた最後の N 行） */
	tailLines: number;
	/** 上限中の worker を起こし直す最初の間隔（分）。送信成功ごとに倍。画面の復帰時刻は使わない固定間隔 */
	wakeIntervalMinutes: number;
	/** 起こす最大回数。0 は自動で起こさない */
	wakeMaxAttempts: number;
}

// 暫定。実機で上限画面を採取するまで確定しない（spec §6-1）。単語だけの `usage limit` は会話文と区別できないので入れない
export const DEFAULT_WORKER_LIMIT: WorkerLimit = {
	enabled: true,
	patterns: [
		"^(claude )?usage limit reached",
		"^you(?:'|’)ve hit your .*limit",
		"^limit reached\\b.*(resets?|try again)",
	],
	resetPatterns: ["resets? (?:at )?([0-9: ]+(?:am|pm)?)"],
	tailLines: 12,
	wakeIntervalMinutes: 30,
	wakeMaxAttempts: 5,
};

export interface LimitHit {
	/** 画面にあった復帰時刻の文字列。表示専用で、制御には使わない */
	resetText: string | null;
}

const MARKER = /^[⏺⎿>❯]/;
// 作業中の画面は上限ではないとみなす
const WORKING = "esc to interrupt";

export function detectLimit(
	pane: string,
	cfg: Pick<WorkerLimit, "patterns" | "resetPatterns" | "tailLines">,
): LimitHit | null {
	const lines = pane.split("\n");
	// 会話・ツール出力・入力エコーのブロックは画面全体を上から走査して決める（範囲の上端がブロックの途中でも見分けるため）
	const excluded: boolean[] = [];
	let inBlock = false;
	for (const line of lines) {
		if (MARKER.test(line.trimStart())) {
			inBlock = true;
			excluded.push(true);
		} else if (!line.trim()) {
			excluded.push(false);
		} else if (/^\s/.test(line)) {
			excluded.push(inBlock);
		} else {
			inBlock = false;
			excluded.push(false);
		}
	}
	let end = lines.length;
	while (end > 0 && !(lines[end - 1] ?? "").trim()) end--;
	const start = Math.max(0, end - cfg.tailLines);
	if (lines.slice(start, end).some((l) => l.includes(WORKING))) return null;
	const patterns = cfg.patterns.map((p) => new RegExp(p, "i"));
	for (let i = end - 1; i >= start; i--) {
		if (excluded[i]) continue;
		const text = (lines[i] ?? "").trimStart();
		if (!patterns.some((re) => re.test(text))) continue;
		for (const p of cfg.resetPatterns) {
			const m = new RegExp(p, "i").exec(text);
			if (m) return { resetText: (m[1] ?? m[0]).trim() || null };
		}
		return { resetText: null };
	}
	return null;
}
