import "./isolate.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "../src/tool-validation.ts";
import { type PropertySchema, TOOLS } from "../src/tools.ts";

// 公開契約から独立に期待値を固定する。! は必須、他は省略可能。
const cases: Record<string, Record<string, string>> = {
	reply: { text: "S!", chat_id: "S", reply_to: "S", project: "S", files: "S[]" },
	tasks_list: { status: "S", project: "S", all: "B" },
	task_get: { id: "S!" },
	task_create: { project: "S!", title: "S!", issue: "S", next: "S", note: "S" },
	task_update: {
		id: "S!",
		status: "S",
		title: "S",
		issue: "S",
		pr: "S",
		waiting: "S",
		next: "S",
		note: "S",
		phase: "S",
	},
	attention_list: {},
	attention_answer: { id: "S!", answer: "S!" },
	dispatch: { project: "S!", text: "S!", task_id: "S" },
	board_show: {},
	projects_list: {},
	project_add: { spec: "S!", native: "S", harness: "B", tmux_session: "S", name: "S" },
	profile_propose: { mode: "S!", summary: "S!", profile: "O|S", initial_prompt: "S", tmux_session: "S", project: "S" },
	profile_template: {},
	profile_get: { project: "S" },
	profile_activate: { project: "S" },
	project_mode: { name: "S!", mode: "S!", command: "S", tmux_session: "S" },
	project_set_active: { name: "S!", active: "B!" },
	report: { issue: "S", task_id: "S", status: "S", pr: "S", next: "S", note: "S", title: "S", project: "S" },
	learning_add: { tag: "S!", summary: "S!", detail: "S", issue: "S", project: "S" },
	rules_get: {},
	learnings_list: { include_promoted: "B" },
	learnings_promote: { indexes: "N[]!" },
	rules_set: { content: "S!" },
	retro_done: { summary: "S!" },
	notify: { project: "S", event: "S", title: "S", url: "S", issue: "S", pr: "S", body: "S", file: "S", phase: "S" },
	restart: { name: "S", limited: "B", all: "B", except: "S[]" },
};
const valid: Record<string, unknown> = { S: "値", B: false, "O|S": { gate: [] }, "S[]": [], "N[]": [] };
const invalid: Record<string, unknown[]> = {
	S: [123, false, {}, [], null],
	B: ["false", 0, {}, [], null],
	"O|S": [[], null, 1, false],
	"S[]": [{}, "file", null, [1]],
	"N[]": [{}, "0", null, ["0"]],
};

function failure(name: string, args: unknown, ...parts: string[]) {
	assert.throws(
		() => validateToolArguments(name, args),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			for (const part of [name, ...parts]) assert.ok(error.message.includes(part), error.message);
			return true;
		},
	);
}

test("共通カタログは26ツールの必須・型・未知キーを検査する", () => {
	assert.equal(TOOLS.length, 26);
	assert.deepEqual(TOOLS.map((t) => t.name).sort(), Object.keys(cases).sort());
	for (const [name, fields] of Object.entries(cases)) {
		const schema = TOOLS.find((t) => t.name === name)?.inputSchema;
		assert.ok(schema);
		assert.equal(schema.type, "object");
		assert.equal(schema.additionalProperties, false);
		assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(fields).sort(), name);
		const required = Object.keys(fields).filter((key) => fields[key]?.endsWith("!"));
		assert.deepEqual([...(schema.required ?? [])].sort(), required.sort(), name);
		const args = Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, valid[type.replace("!", "")]]));
		assert.deepEqual(validateToolArguments(name, args), args);
		for (const key of required) {
			const missing = { ...args };
			delete missing[key];
			failure(name, missing, key, "必要");
			failure(name, { ...args, [key]: undefined }, key, "必要");
		}
		for (const [key, spec] of Object.entries(fields)) {
			const kind = spec.replace("!", "");
			const property: PropertySchema | undefined = schema.properties[key];
			assert.ok(property);
			const types: Record<string, unknown> = {
				S: "string",
				B: "boolean",
				"O|S": ["object", "string"],
				"S[]": "array",
				"N[]": "array",
			};
			assert.deepEqual(property.type, types[kind], `${name}.${key}`);
			if (property.type === "array") assert.equal(property.items.type, kind === "S[]" ? "string" : "number");
			for (const value of invalid[kind] ?? []) {
				failure(name, { ...args, [key]: value }, Array.isArray(value) && value.length ? `${key}[0]` : key);
			}
		}
		for (const key of ["typo", "__proto__", "constructor", "toString"]) {
			failure(name, { ...args, ...JSON.parse(`{"${key}":"x"}`) }, key, "許可", ...Object.keys(fields));
		}
		for (const raw of [null, [], "x", 1, false]) failure(name, raw, "object");
		if (required.length) failure(name, undefined, required[0] as string);
		else assert.deepEqual(validateToolArguments(name, undefined), {});
	}
});

test("取り違えの候補・本文の空文字と空白のみ・値の保持を検査する", () => {
	failure("dispatch", { project: "p", message: "指示" }, "message", "text を指定してください", "必要", "許可");
	failure("rules_set", { text: "規則" }, "text", "content を指定してください", "必要", "許可");
	failure("rules_get", { typo: "x" }, "typo", "引数はありません");
	for (const [name, key, base] of [
		["dispatch", "text", { project: "p" }],
		["rules_set", "content", {}],
	] as const) {
		failure(name, { ...base, [key]: "" }, key, "空");
		failure(name, { ...base, [key]: "   \n\t" }, key, "空");
		const property = TOOLS.find((t) => t.name === name)?.inputSchema.properties[key];
		assert.ok(property?.type === "string");
		assert.equal(property.minLength, 1);
		const content = "# 仮ルール\n日本語の **規則**\n";
		assert.equal(validateToolArguments(name, { ...base, [key]: content })[key], content);
	}
	assert.deepEqual(
		validateToolArguments("profile_propose", { mode: "harness", summary: "x", profile: '{"gate":[]}' }),
		{ mode: "harness", summary: "x", profile: '{"gate":[]}' },
	);
	assert.deepEqual(validateToolArguments("tasks_list", { all: false, project: undefined }), {
		all: false,
		project: undefined,
	});
	assert.deepEqual(validateToolArguments("learnings_list", { include_promoted: false }), { include_promoted: false });
	assert.deepEqual(validateToolArguments("learnings_promote", { indexes: [0, -1, 1.5] }), { indexes: [0, -1, 1.5] });
	assert.deepEqual(validateToolArguments("task_update", { id: "T-1", waiting: "", next: "" }), {
		id: "T-1",
		waiting: "",
		next: "",
	});
	assert.throws(() => validateToolArguments("unknown", {}), /unknown tool: unknown/);
});
