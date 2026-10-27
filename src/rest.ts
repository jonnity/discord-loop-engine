// Discord REST API の最小クライアント（送信・編集・ピン留め・リアクション・疎通確認）。
// 送信は1本の列に並べて順番に出す（チャンネルあたりの送信制限に当たりにくくするため）。
// 429 は retry_after だけ待って1回やり直す。それ以外の失敗は呼び出し側に返す。

import { readFile } from "node:fs/promises";
import path from "node:path";

const API = "https://discord.com/api/v10";

export interface SendInput {
	content: string;
	replyTo?: string;
	files?: string[];
}

export interface DiscordSentMessage {
	id: string;
	channel_id?: string;
	attachments?: import("./notification-receipt.ts").DiscordAttachment[];
}
export interface DiscordChannel {
	id: string;
	type?: number;
	name?: string | null;
	guild_id?: string;
}

export interface DiscordApi {
	channel(channelId: string): Promise<DiscordChannel>;
	sendMessage(channelId: string, input: SendInput): Promise<DiscordSentMessage>;
	editMessage(channelId: string, messageId: string, content: string): Promise<unknown>;
	pin(channelId: string, messageId: string): Promise<unknown>;
	react(channelId: string, messageId: string, emoji: string): Promise<unknown>;
}

export class Rest implements DiscordApi {
	private token: string;
	private fetchImpl: typeof fetch;
	private sleep: (ms: number) => Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(opts: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
		this.token = opts.token;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	async request(
		method: string,
		route: string,
		body?: { json?: unknown; form?: FormData },
		retried = false,
	): Promise<unknown> {
		const headers: Record<string, string> = {
			Authorization: `Bot ${this.token}`,
			"User-Agent": "DiscordBot (discord-loop-engine, 0.1)",
		};
		let payload: string | FormData | undefined;
		if (body?.form) {
			payload = body.form;
		} else if (body?.json !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body.json);
		}
		const res = await this.fetchImpl(`${API}${route}`, { method, headers, body: payload });
		if (res.status === 429 && !retried) {
			const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
			await this.sleep(Math.ceil((data.retry_after ?? 1) * 1000));
			return this.request(method, route, body, true);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Discord API ${method} ${route} → ${res.status} ${text.slice(0, 200)}`);
		}
		return res.status === 204 ? null : res.json();
	}

	sendMessage(channelId: string, { content, replyTo, files = [] }: SendInput): Promise<DiscordSentMessage> {
		return this.enqueue(async () => {
			const payload: Record<string, unknown> = { content, allowed_mentions: { parse: [] } };
			if (replyTo) payload.message_reference = { message_id: replyTo, fail_if_not_exists: false };
			if (files.length === 0) {
				return (await this.request("POST", `/channels/${channelId}/messages`, { json: payload })) as DiscordSentMessage;
			}
			const form = new FormData();
			form.append("payload_json", JSON.stringify(payload));
			for (const [i, file] of files.entries()) {
				form.append(`files[${i}]`, new Blob([new Uint8Array(await readFile(file))]), path.basename(file));
			}
			return (await this.request("POST", `/channels/${channelId}/messages`, { form })) as DiscordSentMessage;
		});
	}

	editMessage(channelId: string, messageId: string, content: string) {
		return this.enqueue(() =>
			this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { json: { content } }),
		);
	}

	pin(channelId: string, messageId: string) {
		return this.enqueue(() => this.request("PUT", `/channels/${channelId}/pins/${messageId}`));
	}

	react(channelId: string, messageId: string, emoji: string) {
		return this.enqueue(() =>
			this.request("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`),
		);
	}

	me() {
		return this.request("GET", "/users/@me") as Promise<{ id: string; username: string }>;
	}

	channel(channelId: string) {
		return this.request("GET", `/channels/${channelId}`) as Promise<DiscordChannel>;
	}
}
