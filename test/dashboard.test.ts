// Web ダッシュボードが保証すること:
// - open の A だけが出て、回答済み・置き換え済み・タスク完了で閉じた A は出ない
// - 行には A-番号・プロジェクト・Issue/PR・種別・件名・経過が出て、経過は描画時点で決まる
// - リンクは GitHub の安全な URL だけ。件名は HTML エスケープされる
// - 台帳が変わると revision が変わり、変わらなければ本文を読み直さない
// - attention.json が無い（なし）と読めない（警告）が区別され、tasks/ が壊れても 500 を返して落ちない
// - 127.0.0.1 で待ち受け、GET/HEAD 以外は 405、知らない名前の Host は 421
import "./isolate.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dashboardKey, readDashboard, renderDashboardHtml, startDashboard } from "../src/dashboard.ts";
import { Ledger } from "../src/ledger.ts";

const T0 = new Date("2026-11-11T10:00:00Z");
const fresh = () => new Ledger(mkdtempSync(path.join(os.tmpdir(), "dle-dash-")), () => T0);
const model = (l: Ledger) => readDashboard(l, dashboardKey(l));
const add = (l: Ledger, o: Partial<Parameters<Ledger["addAttention"]>[0]> = {}) =>
	l.addAttention({
		taskId: "T-1",
		project: "p",
		issue: "7",
		pr: "",
		kind: "merge",
		title: "件名",
		url: "https://github.com/o/r/issues/7#issuecomment-1",
		summary: "",
		...o,
	}).attention;

function get(port: number, p: string, opt: { method?: string; host?: string } = {}) {
	return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: p,
				method: opt.method ?? "GET",
				headers: opt.host ? { Host: opt.host } : {},
				agent: false,
			},
			(res) => {
				let body = "";
				res.on("data", (c) => {
					body += c;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function serve(l: Ledger, allowedHosts: string[] = [], logs: string[] = []) {
	const d = await startDashboard({
		ledger: l,
		host: "127.0.0.1",
		port: 0,
		allowedHosts,
		log: (m) => logs.push(m),
		now: () => new Date("2026-11-11T12:30:00Z"),
	});
	return { d, port: Number(new URL(d.url).port) };
}

test("回答済み・置き換え済み・タスク完了・PR 単位で閉じた A は一覧にも HTML にも出ない", () => {
	const l = fresh();
	const a1 = add(l, { title: "置換前" });
	add(l, { title: "置換後" }); // a1 を置き換える
	const a3 = add(l, { kind: "interview", title: "回答済み", taskId: "T-2" });
	l.resolveAttention(a3.id, "OK");
	add(l, { kind: "blocked", title: "タスク完了", taskId: "T-3" });
	l.resolveAttentionForTask("T-3", "完了");
	add(l, { kind: "merge", title: "PR 単位", taskId: "", issue: "", pr: "9" });
	l.resolveAttentionForPr("p", "9", "merged");
	const m = model(l);
	assert.deepEqual(
		m.attention.map((r) => r.title),
		["置換後"],
	);
	assert.deepEqual(
		m.attention.map((r) => r.id),
		l.openAttention().map((a) => a.id),
	);
	assert.notEqual(a1.id, m.attention[0]?.id);
	const html = renderDashboardHtml(m, T0);
	for (const gone of ["置換前", "回答済み", "タスク完了", "PR 単位"]) assert.ok(!html.includes(gone), gone);
});

test("行の列が出て、経過は描画時の now で決まる", () => {
	const l = fresh();
	add(l, { pr: "34" });
	const m = model(l);
	const h1 = renderDashboardHtml(m, new Date("2026-11-11T10:30:00Z"));
	const h2 = renderDashboardHtml(m, new Date("2026-11-11T14:00:00Z"));
	assert.match(
		h1,
		/<td>A-1<\/td><td>p<\/td><td>#7 PR #34<\/td><td>マージ承認<\/td>.*件名.*<time datetime="[^"]+">30分<\/time>/,
	);
	assert.match(h2, />4時間<\/time>/);
});

test("リンク: コメント URL はそのまま、不正な URL は Issue の URL に置き換え、作れなければリンクなし", () => {
	const l = fresh();
	l.upsertProject({ name: "p", repo: "o/r", path: "/x", active: true, mode: "harness" });
	add(l, { title: "c", url: "https://github.com/o/r/issues/7#issuecomment-1", taskId: "T-1", kind: "merge" });
	add(l, { title: "js", url: "javascript:alert(1)", taskId: "T-2", kind: "interview", issue: "8" });
	add(l, { title: "other", url: "https://evil.example/x", taskId: "T-3", kind: "blocked", issue: "9" });
	add(l, { title: "none", url: "", taskId: "T-4", kind: "setup", issue: "", project: "unknown" });
	l.createTask({ project: "p", title: "task", issue: "11" });
	l.createTask({ project: "-", title: "nolink", issue: "12" });
	const m = model(l);
	const link = (t: string) => [...m.attention, ...m.queued].find((r) => r.title === t)?.link;
	assert.equal(link("c"), "https://github.com/o/r/issues/7#issuecomment-1");
	assert.equal(link("js"), "https://github.com/o/r/issues/8");
	assert.equal(link("other"), "https://github.com/o/r/issues/9");
	assert.equal(link("none"), null);
	assert.equal(link("task"), "https://github.com/o/r/issues/11");
	assert.equal(link("nolink"), null);
	assert.match(
		renderDashboardHtml(m, T0),
		/<a href="https:\/\/github.com\/o\/r\/issues\/8" target="_blank" rel="noopener noreferrer">js<\/a>/,
	);
});

test("件名の HTML は エスケープされる", () => {
	const l = fresh();
	add(l, { title: `<script>alert("x")</script>'` });
	const html = renderDashboardHtml(model(l), T0);
	assert.ok(!html.includes('<script>alert("x")'));
	assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;"));
});

test("revision は台帳の書き込みで変わり、書き込みが無ければ同じ", () => {
	const l = fresh();
	const r0 = model(l).revision;
	assert.equal(model(l).revision, r0);
	const a = add(l);
	const r1 = model(l).revision;
	assert.notEqual(r1, r0);
	l.resolveAttention(a.id, "OK");
	assert.notEqual(model(l).revision, r1);
});

test("attention.json が無いときは（なし）、壊れているときは警告を出し（なし）とは書かない", () => {
	const l = fresh();
	const empty = model(l);
	assert.equal(empty.health, "missing");
	assert.match(renderDashboardHtml(empty, T0), /あなた待ち<\/h2><p class="none">（なし）/);
	const revMissing = empty.revision;
	for (const bad of ["{ broken", "{}", "null"]) {
		writeFileSync(path.join(l.dir, "attention.json"), bad);
		const m = model(l);
		assert.equal(m.health, "unreadable", bad);
		const html = renderDashboardHtml(m, T0);
		assert.match(html, /読めません/);
		assert.ok(!/あなた待ち<\/h2>.*（なし）.*AI 作業中/s.test(html));
		assert.notEqual(m.revision, revMissing);
	}
});

test("HTTP 経由でも経過は注入した now で決まる（固定値）", async () => {
	const l = fresh();
	add(l, { pr: "34" }); // createdAt は T0（10:00）、サーバーの now は 12:30
	const { d, port } = await serve(l);
	try {
		const r = await get(port, "/");
		assert.match(
			r.body,
			/<td>A-1<\/td><td>p<\/td><td>#7 PR #34<\/td><td>マージ承認<\/td>.*件名.*<time datetime="2026-11-11T10:00:00.000Z">2時間<\/time>/,
		);
	} finally {
		await d.close();
	}
});

test("状態ごとの振り分け: ai-working・blocked は作業中、queued・inbox は次に着手、done は出ない", () => {
	const l = fresh();
	const st = ["ai-working", "blocked", "queued", "inbox", "done"] as const;
	for (const status of st) l.createTask({ project: "p", title: `t-${status}`, issue: "1", status });
	const m = readDashboard(l, dashboardKey(l));
	assert.deepEqual(m.working.map((r) => r.title).sort(), ["t-ai-working", "t-blocked"]);
	assert.deepEqual(m.queued.map((r) => r.title).sort(), ["t-inbox", "t-queued"]);
});

test("attention が読めなくても作業中・次に着手は出る（HTTP）", async () => {
	const l = fresh();
	l.createTask({ project: "p", title: "作業のやつ", issue: "1", status: "ai-working" });
	l.createTask({ project: "p", title: "待機のやつ", issue: "2" });
	writeFileSync(path.join(l.dir, "attention.json"), "{ broken");
	const { d, port } = await serve(l);
	try {
		const r = await get(port, "/");
		assert.equal(r.status, 200);
		assert.match(r.body, /読めません/);
		assert.match(r.body, /作業のやつ/);
		assert.match(r.body, /待機のやつ/);
	} finally {
		await d.close();
	}
});

test("HTTP: 200・405・404・Host の規則・安全なヘッダ", async () => {
	const l = fresh();
	add(l);
	const { d, port } = await serve(l, ["pc.example"]);
	try {
		const r = await get(port, "/");
		assert.equal(r.status, 200);
		assert.match(r.body, /A-1/);
		assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
		assert.equal(r.headers["cache-control"], "no-store");
		assert.equal((await get(port, "/revision")).status, 200);
		assert.equal((await get(port, "/", { method: "POST" })).status, 405);
		assert.equal((await get(port, "/nothing")).status, 404);
		for (const host of ["localhost:9999", `127.0.0.1:${port}`, `[::1]:${port}`, "192.168.1.10:1", "pc.example"])
			assert.equal((await get(port, "/", { host })).status, 200, host);
		assert.equal((await get(port, "/", { host: "evil.example" })).status, 421);
	} finally {
		await d.close();
	}
});

test("HTTP: 台帳を書いた直後の要求に待たず最新を返し、不変なら同じ revision を返す", async () => {
	const l = fresh();
	const { d, port } = await serve(l);
	try {
		const r0 = (await get(port, "/revision")).body;
		assert.equal((await get(port, "/revision")).body, r0);
		add(l, { title: "追加直後" });
		const r1 = await get(port, "/revision");
		assert.notEqual(r1.body, r0);
		assert.match((await get(port, "/")).body, /追加直後/);
	} finally {
		await d.close();
	}
});

test("HTTP: tasks/ が壊れていても 500（固定文・パスなし）を返し、戻すと 200 に戻る", async () => {
	const l = fresh();
	const logs: string[] = [];
	const { d, port } = await serve(l, [], logs);
	try {
		rmSync(path.join(l.dir, "tasks"), { recursive: true });
		const bad = await get(port, "/");
		assert.equal(bad.status, 500);
		assert.equal(bad.body, "台帳を読めません");
		assert.ok(!bad.body.includes(l.dir));
		assert.ok(logs.some((m) => m.includes("台帳を読めません")));
		mkdirSync(path.join(l.dir, "tasks"));
		assert.equal((await get(port, "/")).status, 200);
	} finally {
		await d.close();
	}
});

test("HTTP: tasks/T-0001.md がディレクトリでも 500 を返し、戻すと 200 に戻る", async () => {
	const l = fresh();
	l.createTask({ project: "p", issue: "1", title: "t" });
	const { d, port } = await serve(l);
	try {
		assert.equal((await get(port, "/")).status, 200);
		const f = path.join(l.dir, "tasks", "T-0001.md");
		const saved = readFileSync(f);
		rmSync(f);
		mkdirSync(f);
		const bad = await get(port, "/");
		assert.equal(bad.status, 500);
		assert.ok(!bad.body.includes(l.dir));
		rmSync(f, { recursive: true });
		writeFileSync(f, saved);
		assert.equal((await get(port, "/")).status, 200);
	} finally {
		await d.close();
	}
});

test("鍵が同じ間は Ledger.tasks を読み直さず、台帳が変われば読み直す", async () => {
	const l = fresh();
	let calls = 0;
	const orig = l.tasks.bind(l);
	l.tasks = () => {
		calls++;
		return orig();
	};
	const { d, port } = await serve(l);
	try {
		await get(port, "/");
		const base = calls;
		await get(port, "/");
		await get(port, "/revision");
		assert.equal(calls, base, "鍵が同じなら再読込しない");
		add(l);
		await get(port, "/");
		assert.equal(calls, base + 1);
	} finally {
		await d.close();
	}
});

test("attention.json の要素に null などが混じっても 500 にならず「読めません」を出す", async () => {
	const l = fresh();
	const { d, port } = await serve(l);
	try {
		for (const bad of [
			"[null]",
			"[1]",
			'["x"]',
			'[{"status":"open"},null]',
			'[{"status":"open"}]',
			'[{"id":"A-1","project":"p","issue":"1","pr":"","kind":"merge","title":5,"url":"","status":"open","createdAt":"2026-11-11T10:00:00Z"}]',
		]) {
			writeFileSync(path.join(l.dir, "attention.json"), bad);
			const r = await get(port, "/");
			assert.equal(r.status, 200, bad);
			assert.match(r.body, /読めません/, bad);
		}
	} finally {
		await d.close();
	}
});
