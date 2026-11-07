// 専用tmux内だけで動く端末fixture。Claudeや外部サービスには接続しない。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [home, cwd, mode] = process.argv.slice(2);
if (!home || !cwd || !mode) throw new Error("fixture arguments");
mkdirSync(path.join(home, "sessions"), { recursive: true });
const sessionFile = path.join(home, "sessions", `${process.pid}.json`);
function session(id: string) {
	writeFileSync(sessionFile, JSON.stringify({ sessionId: id, cwd, status: "idle", updatedAt: 0 }));
}
session("old");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (text: string) => {
	for (const char of text) {
		if (char === "\r" || char === "\n") {
			appendFileSync(path.join(home, "commands.jsonl"), `${JSON.stringify(input)}\n`);
			if (input === "/clear") {
				if (mode === "hup") process.kill(process.pid, "SIGHUP");
				else if (mode === "group-int") process.kill(-process.pid, "SIGINT");
				else if (mode === "exit") process.exit(0);
				else if (mode !== "no-confirm") session("new");
			}
			input = "";
			process.stdout.write("\r\n❯ ");
		} else {
			input += char;
			process.stdout.write(char);
		}
	}
});
process.stdout.write("fixture ready\x1b[24;1H❯ ");
writeFileSync(path.join(home, "ready.json"), JSON.stringify({ pid: process.pid }));
