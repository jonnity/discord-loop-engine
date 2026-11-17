// 業務処理より前に検査する。値の補正や文字列化で誤入力を隠さない。
import { type PropertySchema, TOOLS } from "./tools.ts";

function matchesType(value: unknown, type: string): boolean {
	if (type === "array") return Array.isArray(value);
	if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
	return typeof value === type;
}

/** properties を持つ object の中身を、トップレベルの引数と同じ規則で検査する（未知キー・required・各値の再帰） */
function validateFields(
	args: Record<string, unknown>,
	properties: Record<string, PropertySchema>,
	required: string[],
	path: string,
	errors: string[],
	hint?: (key: string) => string | undefined,
) {
	const keys = Object.keys(properties);
	const allowed = keys.length ? `許可: ${keys.join(", ")}` : "許可: 引数はありません";
	const at = (key: string) => (path ? `${path}.${key}` : key);
	for (const key of Object.keys(args)) {
		if (!Object.hasOwn(properties, key)) {
			const h = hint?.(key);
			errors.push(`${at(key)} は使えません。${h ? `${h} を指定してください。` : ""}（${allowed}）`);
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(args, key) || args[key] === undefined) errors.push(`${at(key)} が必要です`);
	}
	for (const [key, schema] of Object.entries(properties)) {
		if (Object.hasOwn(args, key) && args[key] !== undefined) validateValue(args[key], schema, at(key), errors);
	}
}

function validateValue(value: unknown, schema: PropertySchema, path: string, errors: string[]) {
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (!types.some((type) => matchesType(value, type))) {
		errors.push(`${path} は ${types.join(" / ")} にしてください`);
		return;
	}
	if (
		schema.type === "string" &&
		schema.minLength &&
		typeof value === "string" &&
		value.trim().length < schema.minLength
	) {
		errors.push(`${path} は空にできません`);
	}
	if (schema.type === "object" && "properties" in schema && matchesType(value, "object")) {
		validateFields(value as Record<string, unknown>, schema.properties, schema.required ?? [], path, errors);
	}
	if (schema.type === "array" && Array.isArray(value)) {
		value.forEach((item: unknown, index: number) => {
			validateValue(item, schema.items, `${path}[${index}]`, errors);
		});
	}
}

export function validateToolArguments(name: string, raw?: unknown): Record<string, unknown> {
	const tool = TOOLS.find((tool) => tool.name === name);
	if (!tool) throw new Error(`unknown tool: ${name}`);
	const value = raw === undefined ? {} : raw;
	if (!matchesType(value, "object")) throw new Error(`${name}: 引数は object にしてください`);
	const args = value as Record<string, unknown>;
	const { properties, required = [] } = tool.inputSchema;
	const errors: string[] = [];
	validateFields(args, properties, required, "", errors, (key) =>
		tool.argumentHints && Object.hasOwn(tool.argumentHints, key) ? tool.argumentHints[key] : undefined,
	);
	if (errors.length) throw new Error(`${name}: ${errors.join("。")}。`);
	return args;
}
