import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isObject, parseStrictJson } from "./harness-json.ts";

export type ModelAlias = "sonnet" | "opus" | "haiku";
export type ModelRole = "window" | "tick" | "spec" | "review";
export type RoleModels = Record<ModelRole, string>;
export type ModelOverrides = Partial<RoleModels>;
export interface ModelResolution {
	values: RoleModels;
	sources: Record<ModelRole, "default" | "legacy" | "global" | "project">;
	warnings: string[];
}
export type AgentModelResult =
	| { ok: true; model: ModelAlias }
	| { ok: false; role: ModelRole; configured: string; reason: string };
export const DEFAULT_ROLE_MODELS = { window: "sonnet", tick: "sonnet", spec: "opus", review: "opus" } as const;
const roles = Object.keys(DEFAULT_ROLE_MODELS) as ModelRole[];

export function validateModels(value: unknown): ModelOverrides {
	if (value === undefined) return {};
	if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw Error("models は役割と非空文字列の object にしてください");
	for (const [key, model] of Object.entries(value)) {
		if (!roles.includes(key as ModelRole) || typeof model !== "string" || !model.trim())
			throw Error(`models.${key}: 既知の役割に非空文字列を指定してください`);
	}
	return value as ModelOverrides;
}

export function modelArgs(model: string, extraArgs: string[]): string[] {
	return extraArgs.some((a) => a === "--model" || a.startsWith("--model=")) ? [] : ["--model", model];
}

export function resolveModels(
	config: {
		legacyModels?: { window?: unknown; tick?: unknown };
		models?: unknown;
		concierge?: { model?: unknown; extraArgs?: string[] };
		worker?: { model?: unknown; extraArgs?: string[] };
	} = {},
	projectModels?: unknown,
): ModelResolution {
	const result: ModelResolution = {
		values: { ...DEFAULT_ROLE_MODELS },
		sources: { window: "default", tick: "default", spec: "default", review: "default" },
		warnings: [],
	};
	for (const [role, legacy] of [
		["window", config.concierge],
		["tick", config.worker],
	] as const) {
		const legacyValue = config.legacyModels ? config.legacyModels[role] : legacy?.model;
		if (typeof legacyValue === "string") {
			if (legacyValue.trim()) {
				result.values[role] = legacyValue;
				result.sources[role] = "legacy";
			} else result.warnings.push(`${role}: 旧 model が空のため未指定として扱います`);
		}
		if (
			Array.isArray(legacy?.extraArgs) &&
			legacy.extraArgs.some(
				(a) =>
					typeof a === "string" &&
					(a === "--model" || a.startsWith("--model=") || a === "--agents" || a.startsWith("--agents=")),
			)
		)
			result.warnings.push(`${role}: extraArgs の model/agents を保持します。起動上書きと役割要求値は別です`);
	}
	for (const [source, models] of [
		["global", config.models],
		["project", projectModels],
	] as const) {
		for (const [role, model] of Object.entries(validateModels(models))) {
			result.values[role as ModelRole] = model;
			result.sources[role as ModelRole] = source;
		}
	}
	for (const role of roles) {
		const a = agentModel(result, role);
		if (!a.ok) result.warnings.push(a.reason);
	}
	return result;
}

export function agentModel(resolution: ModelResolution, role: ModelRole): AgentModelResult {
	const model = resolution.values[role];
	if (model === "sonnet" || model === "opus" || model === "haiku") return { ok: true, model };
	return {
		ok: false,
		role,
		configured: model,
		reason: `${role}: ${model} は Agent alias に変換できません。model 引数を省略し親モデルを継承して同じ作業を起動し、gate 実行の記録/レビュー記録に理由を残してください`,
	};
}

export function readModelConfig(file: string): Record<string, unknown> {
	const value = parseStrictJson(readFileSync(file, "utf8"), "models");
	if (!isObject(value)) throw Error(`${file}: 設定は object にしてください`);
	validateModels(value.models);
	return value;
}

function cli() {
	const [command, profilePath, configHome, role, ...extra] = process.argv.slice(2);
	if (
		!command ||
		!profilePath ||
		!configHome ||
		extra.length ||
		!["--models", "--model", "--agent-model"].includes(command) ||
		(command === "--models" ? role !== undefined : !roles.includes(role as ModelRole))
	)
		throw Error("--models / --model <role> / --agent-model <role> を指定してください");
	if (process.env.DLE_MODEL_PROFILE && path.resolve(process.env.DLE_MODEL_PROFILE) !== path.resolve(profilePath))
		throw Error("モデル設定の探索先が sessionTargets と違います。設定を揃えて restart してください");
	const globalPath = path.join(configHome, "config.json");
	const global = existsSync(globalPath) ? readModelConfig(globalPath) : {};
	const profile = existsSync(profilePath) ? readModelConfig(profilePath) : {};
	let r = resolveModels(global, profile.models);
	if (process.env.DLE_MODELS) {
		const inherited = parseStrictJson(process.env.DLE_MODELS);
		if (
			!isObject(inherited) ||
			!isObject(inherited.values) ||
			!isObject(inherited.sources) ||
			!Array.isArray(inherited.warnings)
		)
			throw Error("DLE_MODELS が不正です。restart してください");
		validateModels(inherited.values);
		if (roles.some((key) => typeof inherited.values === "object" && !Object.hasOwn(inherited.values as object, key)))
			throw Error("DLE_MODELS の役割が不足しています");
		// 起動時の global 解決値を維持し、選択 profile だけを合成する。
		r = {
			values: { ...(inherited.values as RoleModels) },
			sources: { ...(inherited.sources as ModelResolution["sources"]) },
			warnings: inherited.warnings.filter((w): w is string => typeof w === "string"),
		};
		for (const [key, model] of Object.entries(validateModels(profile.models))) {
			r.values[key as ModelRole] = model;
			r.sources[key as ModelRole] = "project";
		}
		for (const key of roles) {
			const a = agentModel(r, key);
			if (!a.ok && !r.warnings.includes(a.reason)) r.warnings.push(a.reason);
		}
	}
	for (const warning of r.warnings) process.stderr.write(`harness-config: ${warning}\n`);
	if (command === "--models") process.stdout.write(`${JSON.stringify(r)}\n`);
	else if (command === "--model") process.stdout.write(`${r.values[role as ModelRole]}\n`);
	else {
		const result = agentModel(r, role as ModelRole);
		if (!result.ok) {
			process.stderr.write(`${result.reason}\n`);
			process.exitCode = 1;
		} else process.stdout.write(`${result.model}\n`);
	}
}
if (process.argv[1] === import.meta.filename) {
	try {
		cli();
	} catch (error) {
		process.stderr.write(`harness-config: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
