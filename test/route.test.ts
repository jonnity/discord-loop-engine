// Discord からの発言の扱いが保証すること:
// - 許可リスト外・Bot・webhook・対象外チャンネルの発言は窓口に渡さない
// - engine の A-番号付き投稿への返信は、その A-番号への返事として渡る
// - 「A-4 OK」のように番号から書き始めても、その A-番号への返事になる
// - CI（webhook）の通知への返信は、プロジェクトと Issue/PR を付けて渡る
// - 許可確認の返事は、待っている request_id にだけ結び付く
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, type DiscordMessage, parsePost, route } from "../src/route.ts";

const ME = "111";
const CH = "900";
const base = (over: Partial<DiscordMessage> = {}): DiscordMessage => ({
	id: "m1",
	channel_id: CH,
	guild_id: "g1",
	author: { id: ME, username: "jonnity" },
	content: "hello",
	attachments: [],
	...over,
});
const ctx = (pending = new Map<string, string>()) => ({
	botUserId: "999",
	allowedUserIds: [ME],
	channelIds: [CH],
	pendingPermissions: pending,
});

test("許可リスト外・Bot・webhook・他チャンネル・空は無視する", () => {
	assert.equal(route(base({ author: { id: "222" } }), ctx()).action, "ignore");
	assert.equal(route(base({ author: { id: "999", bot: true } }), ctx()).action, "ignore");
	assert.equal(route(base({ webhook_id: "w" }), ctx()).action, "ignore");
	assert.equal(route(base({ channel_id: "901" }), ctx()).action, "ignore");
	assert.equal(route(base({ content: "  " }), ctx()).action, "ignore");
});

test("A-番号付きの投稿への返信は、その A-番号への返事として渡る", () => {
	const r = route(
		base({
			content: "OK",
			referenced_message: {
				id: "b1",
				channel_id: CH,
				content: "**[kishimen-tool]** 🟢 A-4 マージ承認｜#12 票を破棄\n<https://x>",
			},
		}),
		ctx(),
	);
	assert.equal(r.action, "deliver");
	if (r.action !== "deliver") return;
	assert.deepEqual(
		{ a: r.meta.attention, p: r.meta.project, i: r.meta.issue },
		{ a: "A-4", p: "kishimen-tool", i: "12" },
	);
	assert.match(r.content, /\nOK$/);
});

test("「A-4 OK」のように番号から書き始めても、その A-番号への返事になる", () => {
	for (const content of ["A-4 OK", "a4 OK", "A-4: B でお願いします"]) {
		const r = route(base({ content }), ctx());
		assert.equal(r.action === "deliver" && r.meta.attention, "A-4", content);
	}
	const r = route(base({ content: "kishimen の A-4 はどうなった？" }), ctx());
	assert.equal(r.action === "deliver" && r.meta.attention, undefined, "文中の番号は返事扱いにしない");
});

test("CI（webhook）の通知への返信はプロジェクトと Issue/PR 付きで渡る", () => {
	const ci = {
		id: "w1",
		channel_id: CH,
		content: "**[kishimen-tool]** 🟠 CI失敗｜CI @ fix/issue-12\n<https://run>",
		embeds: [{ footer: { text: "discord-loop-engine · ci-red" }, fields: [{ name: "PR", value: "[#34](u)" }] }],
	};
	assert.deepEqual(parsePost(ci), {
		project: "kishimen-tool",
		headline: "🟠 CI失敗｜CI @ fix/issue-12",
		pr: "34",
		event: "ci-red",
	});
	const r = route(base({ content: "直して", referenced_message: ci }), ctx());
	assert.equal(r.action === "deliver" && r.meta.event, "ci-red");
});

test("DM は対象チャンネル外でも許可リストの本人なら渡る", () => {
	const r = route(base({ guild_id: undefined, channel_id: "dm1" }), ctx());
	assert.equal(r.action === "deliver" && r.meta.source, "dm");
});

test("許可確認の返事は待っている request_id にだけ結び付く", () => {
	const pending = new Map([["abcde", "kishimen-tool"]]);
	assert.deepEqual(route(base({ content: "yes abcde" }), ctx(pending)), {
		action: "permission",
		target: "kishimen-tool",
		request_id: "abcde",
		behavior: "allow",
	});
	assert.equal(route(base({ content: "no abcde" }), ctx(pending)).action, "permission");
	assert.equal(route(base({ content: "yes zzzzz" }), ctx(pending)).action, "deliver");
});

test("添付は URL として本文に付き、長文は 2000 文字以内に分割する", () => {
	const r = route(base({ content: "これ見て", attachments: [{ url: "https://cdn/x.png" }] }), ctx());
	assert.match(r.action === "deliver" ? r.content : "", /- https:\/\/cdn\/x\.png/);
	const chunks = chunkText(`${"a".repeat(1500)}\n${"b".repeat(1500)}`);
	assert.equal(chunks.length, 2);
	assert.ok(chunks.every((c) => c.length <= 2000));
});
