import type {
	CompiledWorkflowChannel,
	CompiledWorkflowGraph,
	CompiledWorkflowNode,
	CompiledWorkflowRoute,
	GeneratedWorkflowNode,
	GeneratedWorkflowPlan,
	WorkflowCompileError,
} from "./generatedWorkflowTypes";
import { WorkflowCompileError as CompileError } from "./generatedWorkflowTypes";

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DEFAULT_COMPILED_WORKFLOW_LIMITS = Object.freeze({
	maxSteps: 50,
	maxExecutionsPerNode: 10,
	maxConcurrentExecutions: 4,
});

export function compileGeneratedWorkflow(plan: GeneratedWorkflowPlan): CompiledWorkflowGraph {
	const byId = new Map<string, GeneratedWorkflowNode>();
	for (const [index, node] of plan.nodes.entries()) {
		const path = `plan.nodes[${index}]`;
		if (!NODE_ID.test(node.id)) {
			throw new CompileError("must contain only letters, numbers, '.', '_' or '-'", `${path}.id`, node.id);
		}
		if (byId.has(node.id)) {
			throw new CompileError("duplicate node id", `${path}.id`, node.id);
		}
		byId.set(node.id, node);
	}

	for (const [index, node] of plan.nodes.entries()) {
		for (const [field, refs] of [["after", node.after], ["contextFrom", node.contextFrom], ["reviews", node.reviews]] as const) {
			for (const [refIndex, ref] of (refs ?? []).entries()) ensureNode(byId, ref, `plan.nodes[${index}].${field}[${refIndex}]`);
		}
		if ((node.reviews?.length ?? 0) > 1) {
			throw new CompileError("reviews accepts exactly one target", `plan.nodes[${index}].reviews`, node.id);
		}
	}

	const entry = plan.entry ?? plan.nodes.filter((node) => (node.after?.length ?? 0) === 0).map((node) => node.id);
	if (entry.length === 0) throw new CompileError("must have an entry node", "plan.entry");
	for (const [index, id] of entry.entries()) ensureNode(byId, id, `plan.entry[${index}]`);

	const reviewersByTarget = new Map<string, string>();
	for (const [index, node] of plan.nodes.entries()) {
		const target = node.reviews?.[0];
		if (!target) continue;
		if (reviewersByTarget.has(target)) {
			throw new CompileError("a node may have only one reviewer", `plan.nodes[${index}].reviews`, node.id);
		}
		reviewersByTarget.set(target, node.id);
	}

	const routes: CompiledWorkflowRoute[] = [];
	const reviewerIds = new Set(plan.nodes.filter((node) => (node.reviews?.length ?? 0) > 0).map((node) => node.id));
	for (const node of plan.nodes) {
		for (const dependency of node.after ?? []) {
			if (!reviewerIds.has(dependency)) routes.push({ from: dependency, to: node.id, type: "dependency" });
		}
	}

	for (const reviewer of plan.nodes) {
		const target = reviewer.reviews?.[0];
		if (!target) continue;
		const approvedTargets = plan.nodes.filter((node) => (node.after ?? []).includes(reviewer.id)).map((node) => node.id);
		if (approvedTargets.length === 0) approvedTargets.push("__end__");
		for (const next of approvedTargets) {
			routes.push({ from: reviewer.id, to: next, type: "review", when: "approve" });
		}
		routes.push({ from: reviewer.id, to: target, type: "review", when: "revise" });
	}

	const nodes: CompiledWorkflowNode[] = plan.nodes.map((node) => ({
		...node,
		inputChannel: `inputs.${node.id}`,
		outputChannel: `outputs.${node.id}`,
	}));
	const channels: CompiledWorkflowChannel[] = [
		...nodes.map((node) => ({ name: node.outputChannel, mode: "single" as const, producer: node.id })),
		{ name: "history", mode: "append" as const },
	];

	return {
		nodes,
		routes,
		channels,
		expansionRules: [],
		limits: {
			maxSteps: plan.maxSteps ?? DEFAULT_COMPILED_WORKFLOW_LIMITS.maxSteps,
			maxExecutionsPerNode: DEFAULT_COMPILED_WORKFLOW_LIMITS.maxExecutionsPerNode,
			maxConcurrentExecutions: DEFAULT_COMPILED_WORKFLOW_LIMITS.maxConcurrentExecutions,
		},
	};
}

function ensureNode(nodes: ReadonlyMap<string, GeneratedWorkflowNode>, id: string, path: string): void {
	if (!nodes.has(id)) throw new CompileError(`unknown node reference '${id}'`, path, id);
}

export type { WorkflowCompileError };
