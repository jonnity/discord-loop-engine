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

// engine の投稿と harness-notify（webhook）の投稿は、どちらも本文先頭が "**[<project>]** ..." になっている
const HEADLINE_RE = /^\*\*\[([^\]]+)\]\*\*\s*(.*)$/;
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
	const firstLine = (message.content ?? "").split("\n")[0] ?? "";
	const m = HEADLINE_RE.exec(firstLine);
	if (!m) return null;
	const out: ParsedPost = { project: m[1] as string, headline: (m[2] as string).trim() };
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
		if (cut < limit / 2) cut = limit;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) out.push(rest);
	return out;
}

export function withProject(project: string, text: string): string {
	return `**[${project}]** ${text}`;
}
