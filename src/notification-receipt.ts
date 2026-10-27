// 投稿応答を境界で検査し、送信した動画を署名付きURLから再取得して照合する。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DiscordAttachment {
	id: string;
	filename: string;
	size: number;
	url: string;
	content_type?: string;
}
export interface DiscordReceipt {
	guild_id: string | null;
	channel_id: string;
	message_id: string;
	url: string | null;
	attachments: DiscordAttachment[];
	link_error?: "guild-unavailable";
}
export interface FileFingerprint {
	filename: string;
	bytes: number;
	sha256: string;
}
export interface VerifiedMedia extends FileFingerprint {
	verified: true;
}
export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function snowflake(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}
export function normalizeReceipt(
	message: unknown,
	guild: unknown,
	expectedChannel: string,
): DiscordReceipt | undefined {
	const m = object(message);
	if (!snowflake(m.id) || !snowflake(m.channel_id) || m.channel_id !== expectedChannel || !Array.isArray(m.attachments))
		return;
	const attachments: DiscordAttachment[] = [];
	for (const raw of m.attachments) {
		const a = object(raw);
		if (
			!snowflake(a.id) ||
			typeof a.filename !== "string" ||
			!Number.isSafeInteger(a.size) ||
			Number(a.size) <= 0 ||
			typeof a.url !== "string"
		)
			return;
		attachments.push({ id: a.id, filename: a.filename, size: Number(a.size), url: a.url });
	}
	const guild_id = snowflake(guild) ? guild : null;
	return {
		guild_id,
		channel_id: m.channel_id,
		message_id: m.id,
		url: guild_id ? `https://discord.com/channels/${guild_id}/${m.channel_id}/${m.id}` : null,
		attachments,
		...(!guild_id ? { link_error: "guild-unavailable" as const } : {}),
	};
}
export function webhookTarget(raw: string) {
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw Error("webhook URL が不正です");
	const meta = new URL(url);
	meta.search = "";
	url.searchParams.set("wait", "true");
	return { post: url.href, meta: meta.href, thread: url.searchParams.get("thread_id") };
}
export async function fingerprint(file: string): Promise<FileFingerprint> {
	const s = await stat(file);
	if (!s.isFile() || s.size <= 0 || !Number.isSafeInteger(s.size)) throw Error("非空の通常ファイルが必要です");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		bytes += chunk.length;
		hash.update(chunk);
	}
	if (bytes !== s.size) throw Error("ファイルが変更されました");
	return { filename: path.basename(file), bytes, sha256: hash.digest("hex") };
}
export async function verifyMedia(
	raw: unknown,
	fingerprintValue: unknown,
	source: string,
	download: string,
	fetchImpl: typeof fetch = globalThis.fetch,
	timeoutMs = 60000,
): Promise<VerifiedMedia> {
	const fp = object(fingerprintValue),
		r = object(raw);
	if (
		typeof fp.filename !== "string" ||
		!Number.isSafeInteger(fp.bytes) ||
		Number(fp.bytes) <= 0 ||
		typeof fp.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(fp.sha256)
	)
		throw Error("fingerprint が不正です");
	const bytes = Number(fp.bytes),
		sha256 = fp.sha256,
		filename = fp.filename;
	if (
		!snowflake(r.guild_id) ||
		!snowflake(r.channel_id) ||
		!snowflake(r.message_id) ||
		r.url !== `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}` ||
		!Array.isArray(r.attachments)
	)
		throw Error("メッセージリンクが不正です");
	const matches = r.attachments.map(object).filter((a) => a.filename === filename && a.size === bytes);
	const attachment = matches[0];
	if (matches.length !== 1 || !attachment || !snowflake(attachment.id) || typeof attachment.url !== "string")
		throw Error("添付が不足または重複しています");
	const url = new URL(attachment.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
		!url.pathname.startsWith("/attachments/")
	)
		throw Error("添付URLが不正です");
	const unchanged = async () => {
		const now = await fingerprint(source);
		if (now.bytes !== bytes || now.sha256 !== sha256 || now.filename !== filename)
			throw Error("送信元が変更されました");
	};
	await unchanged();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(Error("添付GET timeout"));
		}, timeoutMs);
	});
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const response = await Promise.race([fetchImpl(url, { redirect: "error", signal: controller.signal }), deadline]);
		if (!response.ok || !response.body) throw Error("添付GETに失敗しました");
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes))
			throw Error("Content-Length が一致しません");
		handle = await open(download, "w", 0o600);
		let total = 0;
		const hash = createHash("sha256");
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await Promise.race([reader.read(), deadline]);
				if (done) break;
				total += value.byteLength;
				if (total > bytes) {
					await reader.cancel();
					throw Error("添付サイズ超過");
				}
				hash.update(value);
				await handle.writeFile(value);
			}
		} catch (error) {
			void reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		await handle.close();
		handle = undefined;
		if (total !== bytes || hash.digest("hex") !== sha256) throw Error("添付bytes/hash不一致");
		const actual = await fingerprint(download);
		if (actual.bytes !== bytes || actual.sha256 !== sha256) throw Error("再取得ファイル不一致");
		await unchanged();
		return { filename, bytes, sha256, verified: true };
	} finally {
		clearTimeout(timer);
		await handle?.close();
	}
}
async function main() {
	const [cmd, first = "", second = "", third = "", fourth = ""] = process.argv.slice(2);
	let result: unknown;
	if (cmd === "fingerprint") result = await fingerprint(first);
	else if (cmd === "target") result = webhookTarget(first);
	else if (cmd === "webhook-normalize") {
		const m = JSON.parse(await readFile(first, "utf8")),
			meta = object(JSON.parse(await readFile(second, "utf8")));
		const target = webhookTarget(third);
		result = {
			status: "posted",
			source: "webhook",
			attention: null,
			message_id: object(m).id ?? null,
			discord: normalizeReceipt(m, meta.guild_id, snowflake(meta.channel_id) ? (target.thread ?? meta.channel_id) : ""),
		};
	} else if (cmd === "verify")
		result = await verifyMedia(
			JSON.parse(await readFile(first, "utf8")),
			JSON.parse(await readFile(second, "utf8")),
			third,
			fourth,
		);
	else throw Error("不明なコマンド");
	console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	main().catch(() => {
		console.error("receipt: 動画の再取得・一致確認に失敗したため承認依頼は未完了です");
		process.exitCode = 1;
	});
