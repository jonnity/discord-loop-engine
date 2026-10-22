// Gateway クライアントが保証すること:
// - Hello を受けたら必要な intents（Message Content を含む）で Identify する
// - MESSAGE_CREATE を受信ハンドラへ渡す
// - Reconnect 指示や切断のあとは、セッションを再開（Resume）する
// - トークン不正・intents 不許可の切断では再接続せず、理由を知らせて止まる
// - 接続そのものに失敗した（error のみ）場合も再接続する
import assert from "node:assert/strict";
import { test } from "node:test";
import { Gateway, INTENTS, type WsLike } from "../src/gateway.ts";

type Listener = (ev: { data?: unknown; code?: number }) => void;

class FakeWS implements WsLike {
	static instances: FakeWS[] = [];
	url: string;
	sent: { op: number; d: Record<string, unknown> | null }[] = [];
	listeners: Record<string, Listener> = {};
	closedWith: number | null = null;
	constructor(url: string) {
		this.url = url;
		FakeWS.instances.push(this);
	}
	addEventListener(type: string, fn: Listener) {
		this.listeners[type] = fn;
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number) {
		this.closedWith = code ?? null;
	}
	emit(payload: unknown) {
		this.listeners.message?.({ data: JSON.stringify(payload) });
	}
	serverClose(code: number) {
		this.listeners.close?.({ code });
	}
	fail() {
		this.listeners.error?.({});
	}
}

function setup() {
	FakeWS.instances = [];
	const timeouts: (() => void)[] = [];
	const received: unknown[] = [];
	const fatal: string[] = [];
	const fakeTimer = 0 as unknown as ReturnType<typeof setTimeout>;
	const gw = new Gateway({
		token: "T",
		WebSocketImpl: FakeWS,
		onMessage: (d) => received.push(d),
		onFatal: (r) => fatal.push(r),
		timers: {
			setTimeout: (fn) => {
				timeouts.push(fn);
				return fakeTimer;
			},
			clearTimeout: () => {},
			setInterval: () => fakeTimer,
			clearInterval: () => {},
		},
	});
	gw.start();
	const ws = () => FakeWS.instances.at(-1) as FakeWS;
	// 最後に積まれたタイマー（バックオフ後の再接続）を進める
	const fireLast = () => (timeouts.at(-1) as () => void)();
	return { gw, fireLast, received, fatal, ws };
}

const hello = { op: 10, d: { heartbeat_interval: 41250 } };
const ready = (s: number) => ({
	op: 0,
	s,
	t: "READY",
	d: { session_id: "S", resume_gateway_url: "wss://resume", user: { id: "9", username: "bot" } },
});

test("Hello → Identify（Message Content intent 込み）→ READY → MESSAGE_CREATE を渡す", () => {
	const { gw, received, ws } = setup();
	ws().emit(hello);
	const identify = ws().sent.find((p) => p.op === 2);
	assert.equal(identify?.d?.token, "T");
	assert.equal(identify?.d?.intents, INTENTS);
	assert.ok(INTENTS & (1 << 15), "MESSAGE_CONTENT");
	ws().emit(ready(1));
	assert.equal(gw.connected, true);
	ws().emit({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1", content: "hi" } });
	assert.deepEqual(received, [{ id: "m1", content: "hi" }]);
});

test("Reconnect 指示のあとは resume_gateway_url に繋ぎ直して Resume する", () => {
	const { fireLast, ws } = setup();
	ws().emit(hello);
	ws().emit(ready(5));
	const first = ws();
	first.emit({ op: 7, d: null });
	assert.notEqual(first.closedWith, 1000, "1000 で閉じるとセッションが無効になる");
	fireLast();
	assert.match(ws().url, /^wss:\/\/resume/);
	ws().emit(hello);
	assert.deepEqual(ws().sent.find((p) => p.op === 6)?.d, { token: "T", session_id: "S", seq: 5 });
});

test("予期しない切断のあとは再接続して Resume する", () => {
	const { fireLast, ws } = setup();
	ws().emit(hello);
	ws().emit(ready(3));
	ws().serverClose(1006);
	fireLast();
	ws().emit(hello);
	assert.ok(ws().sent.some((p) => p.op === 6));
});

test("Message Content intent が無い（4014）なら再接続せず理由を知らせる", () => {
	const { fatal, ws } = setup();
	const count = FakeWS.instances.length;
	ws().serverClose(4014);
	assert.equal(fatal.length, 1);
	assert.match(fatal[0] as string, /Message Content Intent/);
	assert.equal(FakeWS.instances.length, count);
});

test("再開できないセッション無効（op 9, false）なら Identify からやり直す", () => {
	const { fireLast, ws } = setup();
	ws().emit(hello);
	ws().emit(ready(3));
	ws().emit({ op: 9, d: false });
	fireLast();
	ws().emit(hello);
	assert.ok(ws().sent.some((p) => p.op === 2));
	assert.ok(!ws().sent.some((p) => p.op === 6));
});

test("接続に失敗して error だけが来ても再接続する（close を待たない）", () => {
	const { fireLast, ws } = setup();
	const count = FakeWS.instances.length;
	ws().fail();
	fireLast();
	assert.equal(FakeWS.instances.length, count + 1);
	// 後から close が来ても二重に再接続しない
	FakeWS.instances.at(-2)?.serverClose(1006);
	assert.equal(FakeWS.instances.length, count + 1);
});
