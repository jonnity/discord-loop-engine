// dle restart の引数解釈（cli.ts は読み込むだけで実行されるため、テストできるよう分ける）

const RESTART_USAGE =
	"dle restart <concierge またはプロジェクト名> | --limited [--except 名前...] | --all [--except 名前...]";

/** dle restart の引数解釈。名前 / --limited / --all はちょうど1つ、--except は --limited / --all のときだけ */
export function parseRestartArgs(args: string[]): { name: string } | { mode: "limited" | "all"; except: string[] } {
	let name: string | undefined;
	let limited = false;
	let all = false;
	const except: string[] = [];
	let sawExcept = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === "--limited") limited = true;
		else if (a === "--all") all = true;
		else if (a === "--except") {
			sawExcept = true;
			const v = args[i + 1];
			if (v === undefined || v.startsWith("--")) throw new Error(`--except に名前が要ります。${RESTART_USAGE}`);
			except.push(v);
			i++;
		} else if (a.startsWith("--")) throw new Error(`知らない引数です: ${a}。${RESTART_USAGE}`);
		else if (name === undefined) name = a;
		else throw new Error(`名前は1つだけ指定できます。${RESTART_USAGE}`);
	}
	if ([name !== undefined, limited, all].filter(Boolean).length !== 1)
		throw new Error(`名前 / --limited / --all のどれか1つを指定してください。${RESTART_USAGE}`);
	if (name !== undefined) {
		if (sawExcept) throw new Error(`--except は --limited / --all のときだけ使えます。${RESTART_USAGE}`);
		return { name };
	}
	return { mode: all ? "all" : "limited", except };
}
