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
export type ReceiptFailure =
	| { stage: "message"; reason: "missing" | "invalid" }
	| { stage: "channel"; reason: "mismatch" | "metadata-mismatch" }
	| { stage: "guild"; reason: "fetch-failed" | "unavailable" }
	| { stage: "attachment"; reason: "mismatch" }
	| { stage: "attachment-url"; reason: "invalid" }
	| { stage: "download"; reason: "failed" }
	| { stage: "integrity"; reason: "mismatch" }
	| { stage: "input"; reason: "invalid" }
	| { stage: "verification"; reason: "unexpected" };
export type ReceiptInspection =
	| { receipt: DiscordReceipt; failure?: ReceiptFailure }
	| { receipt?: undefined; failure: ReceiptFailure };
const descriptions = [
	["message", "missing", "投稿応答", "動画の受領情報がない"],
	["message", "invalid", "投稿応答", "形式が不正"],
	["channel", "mismatch", "チャンネル照合", "投稿先と応答先が一致しない"],
	["channel", "metadata-mismatch", "チャンネル照合", "GETの応答IDが期待するチャンネルIDと一致しない"],
	["guild", "fetch-failed", "guild確認", "投稿先の情報を取得できない"],
	["guild", "unavailable", "guild確認", "サーバーIDがない"],
	["attachment", "mismatch", "添付照合", "一致する添付がないか複数ある"],
	["attachment-url", "invalid", "添付取得先", "URLの形式が不正または許可外"],
	["download", "failed", "添付取得", "取得を完了できない（GET/body/timeout）"],
	["integrity", "mismatch", "内容照合", "サイズ・SHA-256・送信元のいずれかが一致しない"],
	["input", "invalid", "照合入力", "入力の形式またはファイルの読書きが不正"],
	["verification", "unexpected", "動画照合", "予期しない処理失敗"],
] as const;
export function formatReceiptFailure(failure: ReceiptFailure): string {
	const row = descriptions.find(([stage, reason]) => stage === failure.stage && reason === failure.reason);
	if (!row) return formatReceiptFailure({ stage: "verification", reason: "unexpected" });
	return `stage=${row[0]} reason=${row[1]} 段階=${row[2]} 理由=${row[3]}`;
}
export class MediaVerificationError extends Error {
	readonly failure: ReceiptFailure;
	constructor(failure: ReceiptFailure) {
		super(formatReceiptFailure(failure));
		this.failure = failure;
	}
}
export function parseReceiptFailure(raw: unknown): ReceiptFailure {
	const value = object(raw);
	if (!descriptions.some(([stage, reason]) => stage === value.stage && reason === value.reason))
		throw new MediaVerificationError({ stage: "input", reason: "invalid" });
	return { stage: value.stage, reason: value.reason } as ReceiptFailure;
}
export function receiptFailure(error: unknown): ReceiptFailure {
	return error instanceof MediaVerificationError ? error.failure : { stage: "verification", reason: "unexpected" };
}
async function boundary<T>(failure: ReceiptFailure, operation: () => T | Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof MediaVerificationError) throw error;
		throw new MediaVerificationError(failure);
	}
}
export function inspectReceipt(message: unknown, guild: unknown, expectedChannel: string): ReceiptInspection {
	const m = object(message);
	if (message === undefined || message === null) return { failure: { stage: "message", reason: "missing" } };
	if (!snowflake(m.id) || !snowflake(m.channel_id)) return { failure: { stage: "message", reason: "invalid" } };
	if (m.channel_id !== expectedChannel) return { failure: { stage: "channel", reason: "mismatch" } };
	if (!Array.isArray(m.attachments)) return { failure: { stage: "message", reason: "invalid" } };
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
			return { failure: { stage: "attachment", reason: "mismatch" } };
		attachments.push({ id: a.id, filename: a.filename, size: Number(a.size), url: a.url });
	}
	const guild_id = snowflake(guild) ? guild : null;
	return {
		receipt: {
			guild_id,
			channel_id: m.channel_id,
			message_id: m.id,
			url: guild_id ? `https://discord.com/channels/${guild_id}/${m.channel_id}/${m.id}` : null,
			attachments,
			...(!guild_id ? { link_error: "guild-unavailable" as const } : {}),
		},
		...(!guild_id ? { failure: { stage: "guild", reason: "unavailable" } as const } : {}),
	};
}
export function normalizeReceipt(
	message: unknown,
	guild: unknown,
	expectedChannel: string,
): DiscordReceipt | undefined {
	return inspectReceipt(message, guild, expectedChannel).receipt;
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
	return boundary({ stage: "input", reason: "invalid" }, async () => {
		const s = await stat(file);
		if (!s.isFile() || s.size <= 0 || !Number.isSafeInteger(s.size)) throw Error("非空の通常ファイルが必要です");
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of createReadStream(file)) {
			bytes += chunk.length;
			hash.update(chunk);
		}
		if (bytes !== s.size) throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
		return { filename: path.basename(file), bytes, sha256: hash.digest("hex") };
	});
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
		throw new MediaVerificationError({ stage: "input", reason: "invalid" });
	const bytes = Number(fp.bytes),
		sha256 = fp.sha256,
		filename = fp.filename;
	if (raw === undefined || raw === null) throw new MediaVerificationError({ stage: "message", reason: "missing" });
	if (!snowflake(r.guild_id)) throw new MediaVerificationError({ stage: "guild", reason: "unavailable" });
	if (
		!snowflake(r.channel_id) ||
		!snowflake(r.message_id) ||
		r.url !== `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}` ||
		!Array.isArray(r.attachments)
	)
		throw new MediaVerificationError({ stage: "message", reason: "invalid" });
	const matches = r.attachments.map(object).filter((a) => a.filename === filename && a.size === bytes);
	const attachment = matches[0];
	if (matches.length !== 1 || !attachment || !snowflake(attachment.id) || typeof attachment.url !== "string")
		throw new MediaVerificationError({ stage: "attachment", reason: "mismatch" });
	let url: URL;
	try {
		url = new URL(attachment.url);
	} catch {
		throw new MediaVerificationError({ stage: "attachment-url", reason: "invalid" });
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
		!url.pathname.startsWith("/attachments/")
	)
		throw new MediaVerificationError({ stage: "attachment-url", reason: "invalid" });
	const unchanged = async () => {
		const now = await fingerprint(source);
		if (now.bytes !== bytes || now.sha256 !== sha256 || now.filename !== filename)
			throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
	};
	await unchanged();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new MediaVerificationError({ stage: "download", reason: "failed" }));
		}, timeoutMs);
	});
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let body: ReadableStream<Uint8Array> | undefined;
	try {
		const response = await boundary({ stage: "download", reason: "failed" }, () =>
			Promise.race([fetchImpl(url, { redirect: "error", signal: controller.signal }), deadline]),
		);
		body = response.body ?? undefined;
		if (!response.ok || !body) throw new MediaVerificationError({ stage: "download", reason: "failed" });
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes))
			throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
		const output = await boundary({ stage: "input", reason: "invalid" }, () => open(download, "w", 0o600));
		handle = output;
		let total = 0;
		const hash = createHash("sha256");
		const stream = body;
		const reader = await boundary({ stage: "download", reason: "failed" }, () => stream.getReader());
		try {
			while (true) {
				const { done, value } = await boundary({ stage: "download", reason: "failed" }, () =>
					Promise.race([reader.read(), deadline]),
				);
				if (done) break;
				total += value.byteLength;
				if (total > bytes) {
					void reader.cancel().catch(() => {});
					throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
				}
				hash.update(value);
				await boundary({ stage: "input", reason: "invalid" }, () => output.writeFile(value));
			}
		} catch (error) {
			void reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		await boundary({ stage: "input", reason: "invalid" }, () => output.close());
		handle = undefined;
		if (total !== bytes || hash.digest("hex") !== sha256)
			throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
		const actual = await fingerprint(download);
		if (actual.bytes !== bytes || actual.sha256 !== sha256)
			throw new MediaVerificationError({ stage: "integrity", reason: "mismatch" });
		await unchanged();
		return { filename, bytes, sha256, verified: true };
	} catch (error) {
		throw new MediaVerificationError(receiptFailure(error));
	} finally {
		clearTimeout(timer);
		if (body && !body.locked) void body.cancel().catch(() => {});
		await handle?.close().catch(() => {});
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
		const inspected = inspectReceipt(
			m,
			meta.guild_id,
			snowflake(meta.channel_id) ? (target.thread ?? meta.channel_id) : "",
		);
		// shell が metadata 取得失敗を空にするため、HTTP の失敗理由までは推測しない。
		const failure =
			inspected.failure?.stage === "channel" && !snowflake(meta.channel_id) && !snowflake(meta.guild_id)
				? ({ stage: "guild", reason: "unavailable" } as const)
				: inspected.failure;
		result = {
			status: "posted",
			source: "webhook",
			attention: null,
			message_id: object(m).id ?? null,
			discord: inspected.receipt,
			...(failure ? { discord_error: failure } : {}),
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
	boundary({ stage: "input", reason: "invalid" }, main).catch((error: unknown) => {
		console.error(
			`receipt: ${formatReceiptFailure(receiptFailure(error))}。動画の再取得・一致確認に失敗したため承認依頼は未完了です`,
		);
		process.exitCode = 1;
	});
