// Discord のメッセージを窓口に渡すかどうか・何を付けて渡すかを決める純粋関数群。
// 宛先は常に窓口（AI とのやり取りの口を1本にするため）。ここでは「誰の発言か」「どの依頼への返事か」を読み取る。

import type { Meta } from "./protocol.ts";

export interface DiscordMessage {
	id: string;
	channel_id: string;
	guild_id?: string;
	webhook_id?: string;
	content?: string;
	author?: { id: string; username?: string; global_name?: string; bot?: boolean };
	attachments?: { url: string }[];
	embeds?: { footer?: { text?: string }; fields?: { name: string; value: string }[] }[];
	referenced_message?: DiscordMessage | null;
}

// engine の投稿と harness-notify（webhook）の投稿は、どちらも本文先頭が "**[<project>]** ..." になっている。
// engine の新しい見出しは前に絵文字が1つ付く（"🟡 **[<project>]** ..."）。任意の前置きは読み飛ばさない
const HEADLINE_RE =
	/^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s+)?\*\*\[([^\]]+)\]\*\*\s*(.*)$/u;
// 窓口の返信は1行目が種類だけで、A-番号や issue は本文の1行目（2行目）にある。「（続き）」は含めない
const REPLY_HEADLINE_RE =
	/^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s+)?\*\*\[[^\]]+\]\*\*\s*返信$/u;
const ATTENTION_RE = /\bA-(\d+)\b/;
const LEADING_ATTENTION_RE = /^\s*A-?(\d+)\b[\s:：、,]*([\s\S]*)$/i;
const NUMBER_IN_LINK_RE = /\[#(\d+)\]/;
const FOOTER_EVENT_RE = /(?:claude-harness|discord-loop-engine) · ([a-z-]+)/;
const PERMISSION_RE = /^(yes|no|y|n|allow|deny|許可|拒否)\s+([A-Za-z0-9_-]+)\s*$/i;

export interface ParsedPost {
	project: string;
	headline: string;
	attention?: string;
	issue?: string;
	pr?: string;
	event?: string;
}

export function parsePost(message: DiscordMessage | null | undefined): ParsedPost | null {
	if (!message) return null;
	const lines = (message.content ?? "").split("\n");
	const firstLine = lines[0] ?? "";
	const m = HEADLINE_RE.exec(firstLine);
	if (!m) return null;
	let headline = (m[2] as string).trim();
	if (REPLY_HEADLINE_RE.test(firstLine)) headline = `${headline} ${lines[1] ?? ""}`.trim();
	const out: ParsedPost = { project: m[1] as string, headline };
	const att = ATTENTION_RE.exec(out.headline);
	if (att) out.attention = `A-${att[1]}`;
	const embed = message.embeds?.[0];
	for (const field of embed?.fields ?? []) {
		const num = NUMBER_IN_LINK_RE.exec(field.value ?? "");
		if (!num) continue;
		if (field.name === "Issue") out.issue = num[1];
		if (field.name === "PR") out.pr = num[1];
	}
	const ev = FOOTER_EVENT_RE.exec(embed?.footer?.text ?? "");
	if (ev) out.event = ev[1];
	if (!out.issue) {
		const inHeadline = /#(\d+)/.exec(out.headline);
		if (inHeadline) out.issue = inHeadline[1];
	}
	return out;
}

export interface RouteContext {
	botUserId: string | null;
	allowedUserIds: string[];
	channelIds: string[];
	pendingPermissions: Map<string, string>;
}

export type RouteResult =
	| { action: "ignore"; reason: string }
	| { action: "permission"; target: string; request_id: string; behavior: "allow" | "deny" }
	| { action: "deliver"; content: string; meta: Meta };

export function route(msg: DiscordMessage, ctx: RouteContext): RouteResult {
	const author = msg.author ?? { id: "" };
	if (msg.webhook_id) return { action: "ignore", reason: "webhook" };
	if (author.bot || author.id === ctx.botUserId) return { action: "ignore", reason: "bot" };
	if (!ctx.allowedUserIds.includes(author.id)) return { action: "ignore", reason: "not-allowed" };
	const isDm = !msg.guild_id;
	if (!isDm && !ctx.channelIds.includes(msg.channel_id)) return { action: "ignore", reason: "other-channel" };

	const text = (msg.content ?? "").trim();
	const attachments = (msg.attachments ?? []).map((a) => a.url).filter(Boolean);
	if (!text && attachments.length === 0) return { action: "ignore", reason: "empty" };

	const perm = PERMISSION_RE.exec(text);
	if (perm && ctx.pendingPermissions.has(perm[2] as string)) {
		return {
			action: "permission",
			target: ctx.pendingPermissions.get(perm[2] as string) as string,
			request_id: perm[2] as string,
			behavior: /^(yes|y|allow|許可)$/i.test(perm[1] as string) ? "allow" : "deny",
		};
	}

	const who = author.global_name || author.username || author.id;
	const meta: Meta = {
		chat_id: msg.channel_id,
		message_id: msg.id,
		user: who,
		user_id: author.id,
		source: isDm ? "dm" : "channel",
	};
	const ref = parsePost(msg.referenced_message);
	if (ref) {
		meta.project = ref.project;
		if (ref.attention) meta.attention = ref.attention;
		if (ref.issue) meta.issue = ref.issue;
		if (ref.pr) meta.pr = ref.pr;
		if (ref.event) meta.event = ref.event;
	}
	// 「A-4 OK」のように番号から書き始めた場合も、その依頼への返事として扱う
	const lead = LEADING_ATTENTION_RE.exec(text);
	if (lead && !meta.attention) meta.attention = `A-${lead[1]}`;

	const lines = [
		ref
			? `Discord で ${who} が「[${ref.project}] ${ref.headline}」に返信しました:`
			: `Discord で ${who} からメッセージが届きました:`,
		text,
	];
	if (attachments.length) lines.push("", "添付:", ...attachments.map((u) => `- ${u}`));
	return { action: "deliver", content: lines.join("\n"), meta };
}

// Discord の 2000 文字制限に合わせて分割する。改行の位置で切れるならそこで切る。
export function chunkText(text: string, limit = 2000): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) {
			cut = limit;
			// サロゲートペア（絵文字など）の真ん中では切らない
			const c = rest.charCodeAt(cut - 1);
			if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
		}
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) out.push(rest);
	return out;
}

export function withProject(project: string, text: string): string {
	return `**[${project}]** ${text}`;
}

export interface PostHeading {
	icon: string;
	label: string;
	attention?: string;
	issue?: string;
}

const POST_SEPARATOR = "───";
const CONTINUED = "（続き）";

function headingLine(project: string, h: PostHeading): string {
	return `${h.icon} **[${project}]** ${h.label}${h.attention ? ` ${h.attention}` : ""}${h.issue ? `｜#${h.issue}` : ""}`;
}

/**
 * 1回の投稿を、見出し付き・末尾に区切り線付きの Discord メッセージ（2000 文字以下）に分ける。
 * 2通目以降の見出しには「（続き）」を付け、区切り線は最後の1通にだけ置く。
 * 見出しのために本文を黙って切り捨てることはしない（見出しが長すぎるときは例外）。
 */
export function formatPostChunks(project: string, body: string, heading: PostHeading, limit = 2000): string[] {
	const head = headingLine(project, heading);
	const cont = `${head}${CONTINUED}`;
	const budget = limit - Math.max(head.length, cont.length) - 1 - `\n${POST_SEPARATOR}`.length;
	if (budget <= 0) throw new Error("見出しが長すぎて本文を置けません");
	const parts = chunkText(body, budget);
	if (parts.length === 0) parts.push("");
	return parts.map((part, i) => {
		const lines = [i === 0 ? head : cont];
		if (part) lines.push(part);
		if (i === parts.length - 1) lines.push(POST_SEPARATOR);
		return lines.join("\n");
	});
}
