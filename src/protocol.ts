// engine と、そこへ繋ぐもの（各 Claude Code セッションの channel・dle CLI）の間の取り決め。
// ローカルの Unix ドメインソケット上で、1行1メッセージの JSON（NDJSON）をやり取りする。
//
// 接続した側 → engine
//   {type:"hello", protocol, role:"concierge"|"worker"|"cli", project?, pid, cwd}
//   {type:"call", id, name, args}            ツール呼び出し（台帳の読み書き・Discord への返信など）
//   {type:"permission_request", ...}         許可確認の中継（有効なときだけ）
// engine → 接続した側
//   {type:"welcome", role, project?, permissionRelay} | {type:"error", message}
//   {type:"result", id, ok, data?, error?}
//   {type:"event", content, meta}            セッションに流し込むメッセージ
//   {type:"permission", request_id, behavior}

import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

// 互換性を壊す変更をしたら上げる。engine と channel のバージョンがずれたまま黙って動かないようにするため。
export const PROTOCOL_VERSION = 2;

export type Role = "concierge" | "worker" | "cli";

export type Meta = Record<string, string>;

export type ClientMessage =
	| { type: "hello"; protocol: number; role: Role; project?: string; pid: number; cwd: string }
	| { type: "call"; id: string; name: string; args: Record<string, unknown> }
	| {
			type: "permission_request";
			request_id: string;
			tool_name: string;
			description?: string;
			input_preview?: string;
	  };

export type EngineMessage =
	| { type: "welcome"; role: Role; project?: string; permissionRelay: boolean }
	| { type: "error"; message: string }
	| { type: "result"; id: string; ok: boolean; data?: unknown; error?: string }
	| { type: "event"; content: string; meta: Meta }
	| { type: "permission"; request_id: string; behavior: "allow" | "deny" };

export function dleHome(): string {
	return process.env.DLE_HOME || path.join(os.homedir(), ".discord-loop-engine");
}

export function socketPath(home = dleHome()): string {
	return process.env.DLE_SOCKET || path.join(home, "engine.sock");
}

// ソケットから届くバイト列を行ごとの JSON に切り分ける。
export function lineReader<T>(onMessage: (msg: T) => void, onError: (line: string) => void = () => {}) {
	let buf = "";
	return (chunk: Buffer | string) => {
		buf += chunk.toString();
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (line) {
				try {
					onMessage(JSON.parse(line) as T);
				} catch {
					onError(line);
				}
			}
			idx = buf.indexOf("\n");
		}
	};
}

export function send(socket: Socket | null | undefined, msg: ClientMessage | EngineMessage): boolean {
	if (!socket || socket.destroyed) return false;
	socket.write(`${JSON.stringify(msg)}\n`);
	return true;
}
