// JSON.parse の前に全階層のキーを検査する。後勝ちで安全設定が隠れることを防ぐ。
// scope を渡すと、最上位のそのキー配下だけを検査する（それ以外の重複は従来どおり後勝ちで通す）。
export function parseStrictJson(text: string, scope?: string): unknown {
	let pos = 0;
	const space = () => {
		while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
	};
	function string(): string {
		const start = pos++;
		while (pos < text.length) {
			const c = text[pos++];
			if (c === "\\") pos++;
			else if (c === '"') return JSON.parse(text.slice(start, pos)) as string;
		}
		throw Error("不正な JSON 文字列");
	}
	function value(check: boolean, top: boolean): void {
		space();
		const c = text[pos];
		if (c === '"') {
			string();
			return;
		}
		if (c === "{" || c === "[") {
			pos++;
			const end = c === "{" ? "}" : "]";
			const keys = new Set<string>();
			let lastKey = "";
			space();
			if (text[pos] === end) {
				pos++;
				return;
			}
			while (pos < text.length) {
				space();
				if (c === "{") {
					if (text[pos] !== '"') throw Error("不正な JSON キー");
					const key = string();
					lastKey = key;
					if (check && keys.has(key)) throw Error(`JSON の重複キー: ${key}`);
					keys.add(key);
					space();
					if (text[pos++] !== ":") throw Error("不正な JSON 区切り");
				}
				value(check || (top && c === "{" && scope !== undefined && lastKey === scope), false);
				space();
				if (text[pos] === end) {
					pos++;
					return;
				}
				if (text[pos++] !== ",") throw Error("不正な JSON 区切り");
			}
			throw Error("閉じていない JSON");
		}
		const start = pos;
		while (pos < text.length && !/[\s,}\]]/.test(text[pos] ?? "")) pos++;
		if (start === pos) throw Error("不正な JSON 値");
		JSON.parse(text.slice(start, pos));
	}
	value(scope === undefined, true);
	space();
	if (pos !== text.length) throw Error("JSON の後に余分な値があります");
	return JSON.parse(text);
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
