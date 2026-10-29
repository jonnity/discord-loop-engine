// Discord からの発言の扱いが保証すること:
// - 許可リスト外・Bot・webhook・対象外チャンネルの発言は窓口に渡さない
// - engine の A-番号付き投稿への返信は、その A-番号への返事として渡る
// - 「A-4 OK」のように番号から書き始めても、その A-番号への返事になる
// - CI（webhook）の通知への返信は、プロジェクトと Issue/PR を付けて渡る
// - 許可確認の返事は、待っている request_id にだけ結び付く
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, type DiscordMessage, formatPostChunks, parsePost, route } from "../src/route.ts";

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

const nonNewline = (t: string) => t.replace(/\n/g, "");

test("投稿は見出しで始まり、区切り線は最後の1通にだけ付き、本文を欠落させず2000文字以内に収まる", () => {
	const heading = { icon: "🟡", label: "要件確認", attention: "A-5", issue: "19" };
	const fence = `\`\`\`\n${"x".repeat(1900)}\n${"y".repeat(1900)}\n\`\`\``;
	const bodies = [
		"短い本文",
		"",
		"a".repeat(5000),
		`${"行\n".repeat(1500)}終わり`,
		"😀".repeat(2500),
		"b".repeat(1950),
		"c".repeat(1960),
		fence,
	];
	for (const body of bodies) {
		const chunks = formatPostChunks("proj", body, heading);
		assert.ok(chunks.length >= 1);
		for (const [i, c] of chunks.entries()) {
			assert.ok(c.length <= 2000, `${c.length}`);
			const first = c.split("\n")[0];
			assert.equal(first, i === 0 ? "🟡 **[proj]** 要件確認 A-5｜#19" : "🟡 **[proj]** 要件確認 A-5｜#19（続き）");
			assert.equal(c.endsWith("\n───"), i === chunks.length - 1, "区切り線は最後だけ");
			assert.equal(c.split("───").length - 1, i === chunks.length - 1 ? 1 : 0);
		}
		const rebuilt = chunks
			.map((c) =>
				c
					.split("\n")
					.slice(1)
					.join("\n")
					.replace(/\n───$/, ""),
			)
			.join("");
		assert.equal(nonNewline(rebuilt).replace(/───$/, ""), nonNewline(body));
	}
	assert.deepEqual(formatPostChunks("p", "", { icon: "🔔", label: "お知らせ" }), ["🔔 **[p]** お知らせ\n───"]);
	assert.throws(() => formatPostChunks("p".repeat(2000), "x", heading));
});

test("新しい見出しも旧形式も1行目から読み取り、窓口の返信は本文1行目の A-番号と issue を読む", () => {
	const post = (content: string) => parsePost({ id: "1", channel_id: CH, content });
	assert.deepEqual(post("🟡 **[k]** 要件確認 A-5｜#19\nタイトル"), {
		project: "k",
		headline: "要件確認 A-5｜#19",
		attention: "A-5",
		issue: "19",
	});
	assert.equal(post("⚙️ **[k]** 設定 A-6（続き）\n本文")?.attention, "A-6");
	assert.equal(post("🔵 **[k]** マージ完了｜#7\n本文")?.issue, "7");
	assert.equal(post("**[k]** 🟢 A-4 マージ承認｜#12 票")?.attention, "A-4");
	assert.equal(post("前置き 🟡 **[k]** 要件確認 A-5"), null, "先頭以外は拾わない");
	assert.equal(post("本文\n🟡 **[k]** 要件確認 A-5"), null, "1行目以外の偽見出しは拾わない");
	const reply = post("💬 **[窓口]** 返信\nA-9 は OK です。#7 も");
	assert.deepEqual([reply?.attention, reply?.issue], ["A-9", "7"]);
	assert.equal(post("💬 **[窓口]** 返信（続き）\nA-9 の続き")?.attention, undefined, "返信の続きは1行目だけ");
	assert.equal(post("🟡 **[k]** 要件確認 A-5\nA-99 と #7")?.attention, "A-5", "他種別の2行目は読まない");
	assert.equal(post("🟢 **[k]** マージ承認 A-5\n#7")?.issue, undefined);
	assert.equal(post("**[窓口]** 承知しました。A-3 です")?.attention, "A-3", "旧形式の返信は従来どおり");
});
