// 実行中の Node が、セキュリティ修正の入った版かを確かめる。
// engine は Discord と TLS（fetch・WebSocket）で通信するので、TLS の証明書検証や undici・zlib の
// 修正が入っていない Node では動かさない。新しいセキュリティリリースが出たらこの表を更新する。

// 2026-10-21 のセキュリティリリース（CVE-2026-105482 ほか。TLS のホスト名検証・Brotli・undici など）
// https://nodejs.org/ja/blog/vulnerability/october-2026-security-releases
export const MIN_PATCHED: Record<number, [number, number, number]> = {
	22: [22, 23, 4],
	24: [24, 22, 1],
	26: [26, 12, 1],
};

export const RECOMMENDED = "Node 24 LTS（24.22.1 以上）";

export type NodeCheck = { ok: true } | { ok: false; reason: string };

export function parseVersion(v: string): [number, number, number] {
	const [a, b, c] = v
		.replace(/^v/, "")
		.split(".")
		.map((x) => Number.parseInt(x, 10));
	return [a ?? 0, b ?? 0, c ?? 0];
}

function atLeast(v: [number, number, number], min: [number, number, number]) {
	for (let i = 0; i < 3; i++) {
		if ((v[i] as number) !== (min[i] as number)) return (v[i] as number) > (min[i] as number);
	}
	return true;
}

export function checkNode(version: string = process.versions.node): NodeCheck {
	const v = parseVersion(version);
	const min = MIN_PATCHED[v[0]];
	if (!min) {
		// 表に無い系列は、サポート終了（奇数・古い偶数）か、表より新しい系列
		const newest = Math.max(...Object.keys(MIN_PATCHED).map(Number));
		if (v[0] > newest) return { ok: true };
		return {
			ok: false,
			reason: `Node ${version} はセキュリティ修正の対象外の系列です。${RECOMMENDED} を使ってください`,
		};
	}
	if (!atLeast(v, min)) {
		return {
			ok: false,
			reason: `Node ${version} にはセキュリティ修正（2026-10-21）が入っていません。${min.join(".")} 以上に上げてください（推奨: ${RECOMMENDED}）`,
		};
	}
	return { ok: true };
}
