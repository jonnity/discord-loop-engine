// あなた待ち・作業中・次に着手を1枚の読み取り専用 HTML にする（127.0.0.1 だけで待ち受ける）。
// 絞り込みは ledger.ts の述語を共有し、attention_list・ボードと食い違わないようにする。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
	type Attention,
	isOpenAttention,
	isQueuedTask,
	isWorkingTask,
	KIND_LABEL,
	type Ledger,
	type Project,
	type Task,
} from "./ledger.ts";

export type AttentionHealth = "ok" | "missing" | "unreadable";

export interface DashboardRow {
	id: string;
	project: string;
	issue: string;
	pr: string;
	kind: string;
	title: string;
	/** 安全な https://github.com/ の URL だけ。無ければ null */
	link: string | null;
	/** 経過の起点（ISO） */
	since: string;
}

/** キャッシュするのはこれ。描画時刻・経過時間は含めない（要求ごとに now から出す） */
export interface DashboardModel {
	key: string;
	revision: string;
	health: AttentionHealth;
	attention: DashboardRow[];
	working: DashboardRow[];
	queued: DashboardRow[];
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const NUM_RE = /^[1-9][0-9]*$/;

/** 台帳の読み出しがこれより遅いときはログに出す */
const SLOW_MS = 200;

function githubLink(repo: string | undefined, issue: string, pr: string): string | null {
	if (!repo || !REPO_RE.test(repo)) return null;
	if (NUM_RE.test(pr)) return `https://github.com/${repo}/pull/${pr}`;
	if (NUM_RE.test(issue)) return `https://github.com/${repo}/issues/${issue}`;
	return null;
}

/** コメント URL はそのまま使うが、github.com の https 以外（javascript: など）は href に入れない */
function safeUrl(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && u.host === "github.com" ? u.href : null;
	} catch {
		return null;
	}
}

/** 変化の鍵。本文は読まず stat だけで作る（台帳は一時ファイル → rename で書くので ino が変わる） */
export function dashboardKey(ledger: Ledger): string {
	const stat = (f: string) => {
		try {
			const s = statSync(f);
			return `${s.ino}:${s.size}:${s.mtimeMs}`;
		} catch {
			return "-";
		}
	};
	const tasksDir = path.join(ledger.dir, "tasks");
	const parts = [stat(path.join(ledger.dir, "attention.json")), stat(path.join(ledger.dir, "projects.json"))];
	for (const f of readdirSync(tasksDir)
		.filter((n) => /^T-\d+\.md$/.test(n))
		.sort()) {
		const k = stat(path.join(tasksDir, f));
		if (k !== "-") parts.push(`${f}:${k}`);
	}
	return parts.join("|");
}

/** 描画が文字列として使うフィールド。欠ける・型違いの項目があれば台帳ごと「読めない」にする */
const ATTENTION_STRINGS = ["id", "project", "issue", "pr", "kind", "title", "url", "status", "createdAt"];

function isAttentionShape(x: unknown): boolean {
	if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
	const o = x as Record<string, unknown>;
	return ATTENTION_STRINGS.every((k) => typeof o[k] === "string");
}

function readArray(file: string, check?: (x: unknown) => boolean): { list: unknown[]; health: AttentionHealth } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		return { list: [], health: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
	}
	try {
		const v: unknown = JSON.parse(text);
		// 要素が想定の形でない（null・欠けたフィールドなど）台帳は、一部だけ拾わず「読めない」にする
		const ok = Array.isArray(v) && (!check || v.every(check));
		return ok ? { list: v as unknown[], health: "ok" } : { list: [], health: "unreadable" };
	} catch {
		return { list: [], health: "unreadable" };
	}
}

export function readDashboard(ledger: Ledger, key: string): DashboardModel {
	// attention.json は health と一覧を同じ1回の読みから作る
	const att = readArray(path.join(ledger.dir, "attention.json"), isAttentionShape);
	// projects.json は repo の組み立てにしか使わない。壊れていてもリンクが無くなるだけにする
	const projects = readArray(path.join(ledger.dir, "projects.json")).list as Project[];
	const repoOf = (name: string) => {
		const repo = projects.find((p) => typeof p === "object" && p !== null && p.name === name)?.repo;
		return typeof repo === "string" ? repo : undefined;
	};
	const attention = (att.list as Attention[]).filter(isOpenAttention).map(
		(a): DashboardRow => ({
			id: a.id,
			project: a.project,
			issue: a.issue,
			pr: a.pr,
			kind: KIND_LABEL[a.kind] ?? String(a.kind),
			title: a.title,
			link: safeUrl(a.url) ?? githubLink(repoOf(a.project), a.issue, a.pr),
			since: a.createdAt,
		}),
	);
	const tasks = ledger.tasks().filter((t) => t.status !== "done");
	const taskRow = (t: Task): DashboardRow => ({
		id: t.id,
		project: t.project,
		issue: t.issue,
		pr: t.pr,
		kind: `${t.status}${t.phase ? `（${t.phase}）` : ""}`,
		title: t.title,
		link: githubLink(repoOf(t.project), t.issue, t.pr),
		since: t.updated,
	});
	return {
		key,
		revision: createHash("sha256").update(key).digest("hex").slice(0, 16),
		health: att.health === "unreadable" ? "unreadable" : att.health,
		attention,
		working: tasks.filter(isWorkingTask).map(taskRow),
		queued: tasks.filter(isQueuedTask).map(taskRow),
	};
}

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function elapsed(since: string, now: Date): string {
	const t = Date.parse(since);
	if (Number.isNaN(t)) return "-";
	const min = Math.max(0, Math.floor((now.getTime() - t) / 60000));
	if (min < 60) return `${min}分`;
	if (min < 60 * 24) return `${Math.floor(min / 60)}時間`;
	return `${Math.floor(min / 1440)}日`;
}

// ページに埋める固定スクリプト。10秒ごとに版を問い合わせ、1分ごとに経過を書き直す。
// SSE にしない理由: 接続を張りっぱなしにすると停止時に残り、掃除の設計が増えるため
const SCRIPT = `(function(){
var rev=document.body.getAttribute("data-rev");
function fmt(s){var t=Date.parse(s);if(isNaN(t))return"-";var m=Math.max(0,Math.floor((Date.now()-t)/60000));
if(m<60)return m+"分";if(m<1440)return Math.floor(m/60)+"時間";return Math.floor(m/1440)+"日";}
function tick(){var a=document.querySelectorAll("time[datetime]");for(var i=0;i<a.length;i++)a[i].textContent=fmt(a[i].getAttribute("datetime"));}
setInterval(tick,60000);
setInterval(function(){var x=new XMLHttpRequest();x.open("GET","/revision");
x.onload=function(){if(x.status===200&&x.responseText.trim()!==rev)location.reload();};x.send();},10000);
})();`;
const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");

const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function table(rows: DashboardRow[], now: Date, head: string[], empty: string): string {
	if (rows.length === 0) return `<p class="none">${empty}</p>`;
	const th = head.map((h) => `<th>${h}</th>`).join("");
	const body = rows
		.map((r) => {
			const num = [r.issue ? `#${r.issue}` : "", r.pr ? `PR #${r.pr}` : ""].filter(Boolean).join(" ");
			const title = r.link
				? `<a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>`
				: esc(r.title);
			return `<tr><td>${esc(r.id)}</td><td>${esc(r.project)}</td><td>${esc(num)}</td><td>${esc(r.kind)}</td><td>${title}</td><td><time datetime="${esc(r.since)}">${elapsed(r.since, now)}</time></td></tr>`;
		})
		.join("");
	return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderDashboardHtml(m: DashboardModel, now: Date): string {
	const aHead = ["A-番号", "プロジェクト", "Issue/PR", "種別", "件名", "経過"];
	const tHead = ["T-番号", "プロジェクト", "Issue/PR", "状態", "件名", "最終更新から"];
	const warn =
		m.health === "unreadable"
			? `<p class="warn">台帳（attention.json）を読めません。あなた待ちが無いとは限りません</p>`
			: "";
	const aBody = m.health === "unreadable" ? "" : table(m.attention, now, aHead, "（なし）");
	return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>discord-loop-engine ダッシュボード</title>
<style>body{font-family:sans-serif;margin:1.5em;}table{border-collapse:collapse;margin-bottom:1em}th,td{border:1px solid #ccc;padding:.3em .6em;text-align:left}.none{color:#666}.warn{color:#b00;font-weight:bold}</style>
</head><body data-rev="${m.revision}">
<p>読み取り専用。回答は Discord の A-番号か GitHub の OK コメントで。</p>
<h2>あなた待ち</h2>${warn}${aBody}
<h2>AI 作業中</h2>${table(m.working, now, tHead, "（なし）")}
<h2>次に着手</h2>${table(m.queued, now, tHead, "（なし）")}
<script>${SCRIPT}</script>
</body></html>
`;
}

export function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Host ヘッダの許可。名前だけを絞り（DNS リバインディング対策）、ポートと IP リテラルは絞らない */
function hostAllowed(header: string | undefined, allowed: string[]): boolean {
	if (!header) return false;
	let name: string;
	try {
		name = new URL(`http://${header}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (name === "localhost" || name.startsWith("[")) return true;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
	return allowed.some((h) => h.toLowerCase() === name);
}

export function startDashboard(o: {
	ledger: Ledger;
	host: string;
	port: number;
	allowedHosts: string[];
	log: (m: string) => void;
	now?: () => Date;
}): Promise<{ url: string; close(): Promise<void> }> {
	const now = o.now ?? (() => new Date());
	let cache: DashboardModel | null = null;
	const current = (): DashboardModel => {
		const t0 = Date.now();
		const key = dashboardKey(o.ledger);
		if (!cache || cache.key !== key) cache = readDashboard(o.ledger, key);
		const ms = Date.now() - t0;
		if (ms > SLOW_MS)
			o.log(
				`engine: ダッシュボードの台帳読み出しが遅い ${ms}ms（タスク ${cache.working.length + cache.queued.length} 件）`,
			);
		return cache;
	};
	const server = http.createServer((req, res) => {
		const send = (code: number, type: string, body: string) => {
			res.writeHead(code, {
				"Content-Type": `${type}; charset=utf-8`,
				"Content-Security-Policy": CSP,
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Cache-Control": "no-store",
			});
			res.end(req.method === "HEAD" ? undefined : body);
		};
		if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "method not allowed");
		if (!hostAllowed(req.headers.host, o.allowedHosts)) return send(421, "text/plain", "misdirected request");
		const p = (req.url ?? "/").split("?")[0];
		if (p !== "/" && p !== "/revision") return send(404, "text/plain", "not found");
		try {
			const m = current();
			if (p === "/revision") return send(200, "text/plain", m.revision);
			return send(200, "text/html", renderDashboardHtml(m, now()));
		} catch (e) {
			cache = null;
			// パスは応答に出さず、詳細はログだけに残す
			o.log(`engine: ダッシュボードの台帳を読めません ${(e as Error).message}`);
			return send(500, "text/plain", "台帳を読めません");
		}
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	server.keepAliveTimeout = 5000;
	server.maxRequestsPerSocket = 100;
	server.on("clientError", (_e, socket) => socket.destroy());
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(o.port, o.host, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : o.port;
			const host = o.host.includes(":") ? `[${o.host}]` : o.host;
			resolve({
				url: `http://${host}:${port}/`,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
						server.closeAllConnections();
					}),
			});
		});
	});
}
