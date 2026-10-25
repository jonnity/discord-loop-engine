// engine の設定。リポジトリには置かず ~/.discord-loop-engine/config.json に置く
// （Bot トークンや Discord の ID はマシン固有で、秘密情報を含むため）。
// トークンは環境変数 DISCORD_BOT_TOKEN、無ければ同じディレクトリの .env の DISCORD_BOT_TOKEN=...

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dleHome, socketPath } from "./protocol.ts";

export const PLUGIN_SPEC = "plugin:discord-loop-engine@discord-loop-engine";
// reply などの dle ツールを許可確認なしで使えるようにする（離席中に返事だけで止まらないように）
export const DLE_TOOLS_RULE = "mcp__plugin_discord-loop-engine_dle";

export interface WorkerRefresh {
	enabled: boolean;
	maxTokens: number;
	contextPercent: number;
	idleSeconds: number;
	cooldownMinutes: number;
	codexIgnoreAfterMinutes: number;
}

export interface Config {
	home: string;
	socketPath: string;
	channelIds: string[];
	defaultChannelId: string;
	allowedUserIds: string[];
	permissionRelay: boolean;
	tmuxSession: string;
	workspaceDir: string;
	claudeBin: string;
	concierge: {
		model: string;
		extraArgs: string[];
		allowedTools: string[];
		/** 件数または文脈量が閾値以上で、待機を確認したら /clear する */
		refresh: { enabled: boolean; maxTokens: number; maxEvents: number; contextPercent: number };
	};
	worker: { model: string | null; extraArgs: string[]; initialPrompt: string; refresh: WorkerRefresh };
	retro: { everyDoneTasks: number; everyDays: number; promoteAfter: number };
	board: { enabled: boolean };
}

export const CONFIG_TEMPLATE = {
	channelIds: ["000000000000000000"],
	allowedUserIds: ["000000000000000000"],
	permissionRelay: false,
	tmuxSession: "dle",
	workspaceDir: "~/dle/workspaces",
	concierge: { model: "sonnet", refresh: { enabled: true, maxTokens: 100000, maxEvents: 40, contextPercent: 15 } },
	worker: {
		model: null,
		extraArgs: [],
		refresh: {
			enabled: true,
			maxTokens: 100000,
			contextPercent: 15,
			idleSeconds: 180,
			cooldownMinutes: 30,
			codexIgnoreAfterMinutes: 120,
		},
	},
	retro: { everyDoneTasks: 5, everyDays: 7, promoteAfter: 3 },
	board: { enabled: true },
};

export function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function readToken(home = dleHome()): string {
	if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN.trim();
	const envFile = path.join(home, ".env");
	if (!existsSync(envFile)) return "";
	const line = readFileSync(envFile, "utf8")
		.split("\n")
		.reverse()
		.find((l) => /^\s*DISCORD_BOT_TOKEN\s*=/.test(l));
	if (!line) return "";
	return line
		.slice(line.indexOf("=") + 1)
		.trim()
		.replace(/^["']|["']$/g, "");
}

const isIdList = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && /^\d+$/.test(x));

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function loadConfig(home = dleHome()): Config {
	const file = path.join(home, "config.json");
	if (!existsSync(file)) throw new Error(`設定ファイルがありません: ${file}（dle init で雛形を作れます）`);
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const errors: string[] = [];
	if (!isIdList(raw.channelIds)) errors.push("channelIds: Discord のチャンネル ID（数字の文字列）を1つ以上");
	if (!isIdList(raw.allowedUserIds))
		errors.push("allowedUserIds: 中継を許す Discord ユーザー ID（数字の文字列）を1つ以上");
	if (errors.length) throw new Error(`設定が不正です（${file}）:\n- ${errors.join("\n- ")}`);
	const channelIds = raw.channelIds as string[];
	const c = (raw.concierge ?? {}) as Record<string, unknown>;
	const cr = (c.refresh ?? {}) as Record<string, unknown>;
	const w = (raw.worker ?? {}) as Record<string, unknown>;
	const wr = (w.refresh ?? {}) as Record<string, unknown>;
	const r = (raw.retro ?? {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
	const nonnegative = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
	const percent = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : 15);
	return {
		home,
		socketPath: typeof raw.socketPath === "string" ? raw.socketPath : socketPath(home),
		channelIds,
		defaultChannelId: typeof raw.defaultChannelId === "string" ? raw.defaultChannelId : (channelIds[0] as string),
		allowedUserIds: raw.allowedUserIds as string[],
		permissionRelay: raw.permissionRelay === true,
		tmuxSession: typeof raw.tmuxSession === "string" ? raw.tmuxSession : "dle",
		workspaceDir: expandHome(typeof raw.workspaceDir === "string" ? raw.workspaceDir : "~/dle/workspaces"),
		claudeBin: typeof raw.claudeBin === "string" ? raw.claudeBin : "claude",
		concierge: {
			model: typeof c.model === "string" ? c.model : "sonnet",
			extraArgs: strList(c.extraArgs),
			allowedTools: strList(c.allowedTools),
			refresh: {
				// 旧設定で maxEvents: 0 にしていた利用者は、明示しない限り無効のままにする。
				enabled: typeof cr.enabled === "boolean" ? cr.enabled : cr.maxEvents !== 0,
				maxTokens: nonnegative(cr.maxTokens, 100000),
				maxEvents: nonnegative(cr.maxEvents, 40),
				contextPercent: percent(cr.contextPercent),
			},
		},
		worker: {
			model: typeof w.model === "string" ? w.model : null,
			extraArgs: strList(w.extraArgs),
			initialPrompt: typeof w.initialPrompt === "string" ? w.initialPrompt : "/discord-loop-engine:issue-loop",
			refresh: {
				enabled: typeof wr.enabled === "boolean" ? wr.enabled : true,
				maxTokens: nonnegative(wr.maxTokens, 100000),
				contextPercent: percent(wr.contextPercent),
				idleSeconds: num(wr.idleSeconds, 180),
				cooldownMinutes: num(wr.cooldownMinutes, 30),
				codexIgnoreAfterMinutes: num(wr.codexIgnoreAfterMinutes, 120),
			},
		},
		retro: {
			everyDoneTasks: num(r.everyDoneTasks, 5),
			everyDays: num(r.everyDays, 7),
			promoteAfter: num(r.promoteAfter, 3),
		},
		board: { enabled: (raw.board as Record<string, unknown> | undefined)?.enabled !== false },
	};
}
