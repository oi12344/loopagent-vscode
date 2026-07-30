import type { SubagentRoleId } from "./types";

export type GeneratedWorkflowPlan = {
	nodes: GeneratedWorkflowNode[];
	entry?: string[];
	initialState?: Record<string, unknown>;
	maxSteps?: number;
};

export type GeneratedWorkflowNode = {
	id: string;
	task: string;
	role?: SubagentRoleId;
	after?: string[];
	contextFrom?: string[];
	reviews?: string[];
};

export type CompiledWorkflowNode = GeneratedWorkflowNode & {
	inputChannel: string;
	outputChannel: string;
};

export type CompiledWorkflowRoute = {
	from: string;
	to: string;
	type: "dependency" | "review";
	when?: "approve" | "revise";
};

export type CompiledWorkflowChannel = {
	name: string;
	mode: "single" | "append" | "merge";
	producer?: string;
};

export type CompiledWorkflowExpansionRule = {
	id: string;
	nodeId: string;
	trigger: string;
};

export type CompiledWorkflowGraph = {
	nodes: CompiledWorkflowNode[];
	entry: string[];
	routes: CompiledWorkflowRoute[];
	channels: CompiledWorkflowChannel[];
	expansionRules: CompiledWorkflowExpansionRule[];
	limits: {
		maxSteps?: number;
		maxExecutionsPerNode?: number;
		maxConcurrentExecutions?: number;
	};
};

export class WorkflowCompileError extends Error {
	readonly path: string;
	readonly nodeId?: string;

	constructor(message: string, path: string, nodeId?: string) {
		super(`${path}: ${message}`);
		this.name = "WorkflowCompileError";
		this.path = path;
		this.nodeId = nodeId;
	}
}

const PLAN_KEYS = new Set(["nodes", "entry", "initialState", "maxSteps"]);
const NODE_KEYS = new Set(["id", "task", "role", "after", "contextFrom", "reviews"]);
const ROLES = new Set<SubagentRoleId>(["explorer", "reviewer", "planner", "executor"]);

export function parseGeneratedWorkflowPlan(input: unknown): GeneratedWorkflowPlan {
	const plan = record(input, "plan");
	assertKeys(plan, PLAN_KEYS, "plan");
	if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
		throw new WorkflowCompileError("must be a non-empty array", "plan.nodes");
	}

	const ids = new Set<string>();
	const nodes = plan.nodes.map((value, index) => {
		const path = `plan.nodes[${index}]`;
		const node = record(value, path);
		assertKeys(node, NODE_KEYS, path);
		const id = text(node.id, `${path}.id`);
		if (ids.has(id)) throw new WorkflowCompileError("duplicate node id", `${path}.id`, id);
		ids.add(id);
		const task = text(node.task, `${path}.task`);
		const role = node.role === undefined ? undefined : text(node.role, `${path}.role`);
		if (role !== undefined && !ROLES.has(role as SubagentRoleId)) {
			throw new WorkflowCompileError("unknown role", `${path}.role`, id);
		}
		const normalized: GeneratedWorkflowNode = {
			id,
			task,
		};
		if (role !== undefined) normalized.role = role as SubagentRoleId;
		const after = strings(node.after, `${path}.after`);
		const contextFrom = strings(node.contextFrom, `${path}.contextFrom`);
		const reviews = strings(node.reviews, `${path}.reviews`);
		if (after !== undefined) normalized.after = after;
		if (contextFrom !== undefined) normalized.contextFrom = contextFrom;
		if (reviews !== undefined) normalized.reviews = reviews;
		return normalized;
	});

	const entry = strings(plan.entry, "plan.entry");
	const initialState = plan.initialState === undefined ? undefined : record(plan.initialState, "plan.initialState");
	const maxSteps = plan.maxSteps === undefined ? undefined : positiveInteger(plan.maxSteps, "plan.maxSteps");
	return { nodes, entry, initialState, maxSteps };
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		throw new WorkflowCompileError("must be a record", path);
	}
	return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new WorkflowCompileError(`unknown field '${key}'`, `${path}.${key}`);
	}
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new WorkflowCompileError("must be a non-empty string", path);
	}
	return value;
}

function strings(value: unknown, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	const values = Array.isArray(value) ? value : [value];
	return values.map((item, index) => text(item, `${path}[${index}]`));
}

function positiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new WorkflowCompileError("must be a positive integer", path);
	}
	return value;
}
