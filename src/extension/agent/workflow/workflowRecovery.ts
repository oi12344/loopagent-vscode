import { ModelProviderError } from "../../model/types";
import type { ModelProviderErrorCode } from "../../model/types";
import type { SubagentRoleId } from "./types";

/**
 * 错误分类与恢复动作契约。
 *
 * 这里的分类必须是确定性的：同一份证据永远得到同一个分类。恢复流程要能在测试里被固定，
 * 而不是让模型每次自由发挥；分类一旦随机，RecoverySupervisor 的"禁止相同 fingerprint
 * 和动作无限重复"就无从判断。
 */
export type FailureCategory =
	| "transient"
	| "planning"
	| "context"
	| "tool"
	| "provider"
	| "side-effect-uncertain"
	| "external"
	| "unknown";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = Object.freeze([
	"transient",
	"planning",
	"context",
	"tool",
	"provider",
	"side-effect-uncertain",
	"external",
	"unknown",
] as const satisfies readonly FailureCategory[]);

export type RecoveryAction =
	| "retry"
	| "replan"
	| "replace_node"
	| "replace_tool"
	| "switch_provider"
	| "reconcile_side_effect"
	| "compensate"
	| "request_input"
	| "wait_external";

export type RecoveryPlan = {
	action: RecoveryAction;
	targetNodeId: string;
	reason: string;
	task?: string;
	role?: SubagentRoleId;
	contextFrom?: string[];
};

/**
 * 副作用证据。`outcome` 由宿主工具填写，不靠错误文本猜：
 * - `none` 请求未发出，重试安全；
 * - `applied` 已生效，重试会重复写入；
 * - `unknown` 响应丢失，必须先对账。
 */
export type SideEffectEvidence = {
	outcome: "none" | "applied" | "unknown";
	operationId?: string;
	target?: string;
};

export type FailureEvidence = {
	nodeId: string;
	error: unknown;
	role?: SubagentRoleId;
	sideEffect?: SideEffectEvidence;
};

// ModelProviderError 带类型化 code，是最可靠的分类锚点：完全不依赖错误文本。
const PROVIDER_CATEGORIES: Readonly<Record<ModelProviderErrorCode, FailureCategory>> = {
	missing_api_key: "external",
	authentication_failed: "external",
	insufficient_balance: "external",
	invalid_parameters: "provider",
	rate_limited: "transient",
	server_error: "transient",
	server_overloaded: "transient",
	request_failed: "transient",
};

/**
 * 错误文本模式。只收录代码里真实存在的错误原文（workflowOrchestrator、reactAgentRunner、
 * dynamicGraphEngine、openAiCompatibleClient、openAiReactModelTurn），不凭空发明关键字：
 * 匹配不上的错误落到 unknown 由 replan/request_input 兜底，比误分类后选错动作安全。
 * 数组顺序即优先级，具体模式必须排在通用模式之前。
 */
const ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, FailureCategory]> = [
	// 工具层。比下面的通用 not found 更具体，必须先匹配。
	[/Unknown tool/i, "tool"],
	[/Invalid JSON arguments for tool/i, "tool"],
	// 计划层。图结构、表达式和硬限制都得改计划，重试永远是同样的结果。
	[/Unknown subagent role/i, "planning"],
	[/Unsupported expression/i, "planning"],
	[/Circular dependsOn/i, "planning"],
	[/Duplicate node id/i, "planning"],
	[/Maximum (?:nodes limit|depth)/i, "planning"],
	[/GraphLimitExceeded/i, "planning"],
	[/which is not (?:a known initial node id|present in the graph)/i, "planning"],
	// 上下文层。缺输入或上游没产出，补齐上下文后可继续。
	[/\bENOENT\b|no such file or directory/i, "context"],
	[/did not complete successfully/i, "context"],
	// 外部条件层。要人提供凭据或权限，自动重试无意义。
	[/\bEACCES\b|\bEPERM\b|permission denied/i, "external"],
	[/authentication failed|balance is insufficient|missing_api_key/i, "external"],
	// 提供商层。参数被拒绝要换请求形状或换提供商，不是补上下文。
	[/rejected the request parameters/i, "provider"],
	// 瞬时层。超时和网络抖动，重试有意义。
	[/timed out|\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b/i, "transient"],
	[/rate limit|server is overloaded|server returned an error/i, "transient"],
];

/**
 * 确定性分类。优先级固定：
 * 1. 副作用不确定优先于一切。写操作可能已经生效时，`transient` 会诱导盲目重试造成重复写入，
 *    所以 `applied` 和 `unknown` 都归到 side-effect-uncertain —— 前者要补记完成，后者要先对账。
 * 2. `ModelProviderError` 的 code 优先于文本匹配：类型化字段不会因为文案调整而失效。
 * 3. 最后按错误原文模式匹配，匹配不上返回 unknown（由 replan/request_input 兜底）。
 */
export function classifyFailure(evidence: FailureEvidence): FailureCategory {
	if (evidence.sideEffect && evidence.sideEffect.outcome !== "none") return "side-effect-uncertain";
	if (evidence.error instanceof ModelProviderError) return PROVIDER_CATEGORIES[evidence.error.code];

	const message = errorText(evidence.error);
	for (const [pattern, category] of ERROR_PATTERNS) {
		if (pattern.test(message)) return category;
	}
	return "unknown";
}

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error === undefined || error === null) return "";
	return String(error);
}

/**
 * 失败指纹。抹掉数字、路径和引号内容后取前 120 字符，让"同一个错误重复出现"可判定：
 * RecoverySupervisor 靠 `fingerprint + action` 去重，指纹带上行号或时间戳就永远不重复，
 * 无限循环的护栏也就形同虚设。
 */
export function failureFingerprint(nodeId: string, category: FailureCategory, error: unknown): string {
	const normalized = errorText(error)
		.toLowerCase()
		.replace(/["'`][^"'`]*["'`]/g, "<v>")
		.replace(/[a-z]:[\\/][^\s]*/g, "<path>")
		.replace(/[\\/][^\s]*[\\/][^\s]*/g, "<path>")
		.replace(/\d+/g, "<n>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return `${nodeId}|${category}|${normalized}`;
}

export type RecoveryPolicy = {
	maxRecoveryAttempts: number;
	maxFanOut: number;
	maxTaskChars: number;
	maxReasonChars: number;
};

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
	maxRecoveryAttempts: 2,
	maxFanOut: 6,
	maxTaskChars: 800,
	maxReasonChars: 400,
});

const CATEGORY_ACTIONS: Readonly<Record<FailureCategory, readonly RecoveryAction[]>> = Object.freeze({
	transient: Object.freeze(["retry", "replace_node", "switch_provider"]),
	planning: Object.freeze(["replan", "replace_node", "request_input"]),
	context: Object.freeze(["replan", "replace_node", "request_input"]),
	tool: Object.freeze(["replace_tool", "replace_node", "replan"]),
	provider: Object.freeze(["switch_provider", "replan", "request_input"]),
	"side-effect-uncertain": Object.freeze(["reconcile_side_effect", "compensate", "request_input"]),
	external: Object.freeze(["wait_external", "request_input"]),
	unknown: Object.freeze(["replan", "replace_node", "request_input"]),
} as Record<FailureCategory, readonly RecoveryAction[]>);

// 预算耗尽后只剩持久化等待。没有这条，"达到上限后持久化等待"就只是文档里的话，
// 运行时仍可能被模型拉着无限重试。
const WAITING_ACTIONS: readonly RecoveryAction[] = Object.freeze(["request_input", "wait_external"]);

export function isRecoveryBudgetExhausted(attempt: number, policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY): boolean {
	return attempt >= policy.maxRecoveryAttempts;
}

/**
 * 某个分类下允许的动作。两条硬约束在此落地：
 * - 预算耗尽后只允许 request_input / wait_external；
 * - 有副作用的节点不得 retry，改为先 reconcile_side_effect 确认真实状态再决定。
 */
export function allowedRecoveryActions(
	category: FailureCategory,
	options: { hasSideEffect?: boolean; attempt?: number; policy?: RecoveryPolicy } = {},
): readonly RecoveryAction[] {
	const policy = options.policy ?? DEFAULT_RECOVERY_POLICY;
	if (isRecoveryBudgetExhausted(options.attempt ?? 0, policy)) return WAITING_ACTIONS;

	// 副作用节点不论错误分类，都必须先确认真实状态：retry 会重复写入，replace_node 也一样，
	// 因为替代节点执行的是同一件写操作。
	if (options.hasSideEffect) return CATEGORY_ACTIONS["side-effect-uncertain"];
	return CATEGORY_ACTIONS[category];
}

/**
 * 节点级静态动作上界，由编译器写进 `CompiledWorkflowNode.recoveryActions`。
 *
 * 副作用节点固定为对账、补偿、请求确认三选一——这是治理约束里"副作用角色只能选择对账、
 * 补偿或请求确认"的编译期落点。只读节点取各分类动作的并集，但不含 reconcile/compensate：
 * 只读节点不会产生副作用证据，给它这两个动作等于让恢复流程去对账一件没发生的写操作。
 *
 * 运行时的 `allowedRecoveryActions` 在此上界之内按真实分类和预算再收紧，只会更严不会更宽。
 */
export function nodeRecoveryActions(hasSideEffect: boolean): readonly RecoveryAction[] {
	const union = new Set<RecoveryAction>();
	// 先按分类顺序收集，再补 WAITING_ACTIONS：数组顺序会作为偏好次序交给模型，
	// 等待动作排在最后才不会诱导它一上来就挂起整条流程。
	for (const category of hasSideEffect ? ["side-effect-uncertain" as const] : FAILURE_CATEGORIES) {
		if (!hasSideEffect && category === "side-effect-uncertain") continue;
		for (const action of CATEGORY_ACTIONS[category]) union.add(action);
	}
	// 两种节点都必须含 WAITING_ACTIONS：预算耗尽后运行时只发这两个动作，上界少了它们，
	// 节点在上限处就一个合法动作都没有，"达到上限后持久化等待"会被上界自己挡掉。
	for (const action of WAITING_ACTIONS) union.add(action);
	return Object.freeze([...union]);
}

export class RecoveryPlanError extends Error {
	readonly path: string;

	constructor(message: string, path: string) {
		super(`${path}: ${message}`);
		this.name = "RecoveryPlanError";
		this.path = path;
	}
}

export type RecoveryPlanContext = {
	category: FailureCategory;
	failedNodeId: string;
	knownNodeIds: readonly string[];
	attempt?: number;
	hasSideEffect?: boolean;
	/** 失败节点的原角色。用于阻止恢复动作把只读节点提权成 executor。 */
	failedRole?: SubagentRoleId;
	policy?: RecoveryPolicy;
};

const PLAN_KEYS: ReadonlySet<string> = new Set(["action", "targetNodeId", "reason", "task", "role", "contextFrom"]);
const ACTIONS: ReadonlySet<string> = new Set<RecoveryAction>([
	"retry", "replan", "replace_node", "replace_tool", "switch_provider",
	"reconcile_side_effect", "compensate", "request_input", "wait_external",
]);
// 只有生成新节点的动作才允许携带 task；retry/switch_provider 带 task 说明模型混淆了动作语义。
const TASK_ACTIONS: ReadonlySet<string> = new Set<RecoveryAction>(["replan", "replace_node", "replace_tool", "compensate"]);
/**
 * 必须指向失败节点自身的动作。放开会让一个节点的失败去改写另一个已完成节点，
 * 恢复范围随之失控。例外只有两个：`replan` 可以改上游或下游的计划，
 * `compensate` 要补偿的往往是先前已成功节点留下的副作用。
 */
const SELF_ONLY_ACTIONS: ReadonlySet<string> = new Set<RecoveryAction>([
	"retry", "replace_node", "replace_tool", "switch_provider",
	"reconcile_side_effect", "request_input", "wait_external",
]);
const ROLES: ReadonlySet<string> = new Set<SubagentRoleId>(["explorer", "reviewer", "planner", "executor"]);

/**
 * 模板插值和箭头函数：宿主不做任何字符串替换，`${outputs.read}` 会原样进入子智能体提示词。
 * 那正是刚修掉的静默失效形态——看起来引用了上游，实际永远是字面量，所以在入口拒绝。
 */
const FREE_EXPRESSION = /\$\{|`|=>/;

/**
 * 解析模型给出的恢复动作。拒绝未知字段、未知节点、越权角色、超额 fan-out、超长任务，
 * 以及当前分类和预算下不允许的动作。
 */
export function parseRecoveryPlan(input: unknown, context: RecoveryPlanContext): RecoveryPlan {
	const policy = context.policy ?? DEFAULT_RECOVERY_POLICY;
	const plan = asRecord(input, "recovery");
	for (const key of Object.keys(plan)) {
		if (!PLAN_KEYS.has(key)) throw new RecoveryPlanError(`unknown field '${key}'`, `recovery.${key}`);
	}

	const action = asText(plan.action, "recovery.action");
	if (!ACTIONS.has(action)) throw new RecoveryPlanError(`unknown action '${action}'`, "recovery.action");
	const allowed = allowedRecoveryActions(context.category, {
		hasSideEffect: context.hasSideEffect,
		attempt: context.attempt,
		policy,
	});
	if (!allowed.includes(action as RecoveryAction)) {
		throw new RecoveryPlanError(
			`action '${action}' is not allowed for category '${context.category}'; allowed: ${allowed.join(", ")}`,
			"recovery.action",
		);
	}

	const targetNodeId = asText(plan.targetNodeId, "recovery.targetNodeId");
	if (!context.knownNodeIds.includes(targetNodeId)) {
		throw new RecoveryPlanError(`unknown node '${targetNodeId}'`, "recovery.targetNodeId");
	}
	if (SELF_ONLY_ACTIONS.has(action) && targetNodeId !== context.failedNodeId) {
		throw new RecoveryPlanError(
			`action '${action}' must target the failed node '${context.failedNodeId}'`,
			"recovery.targetNodeId",
		);
	}

	// reason 是 request_input / wait_external 下唯一给用户看的文字，空理由等于让用户猜。
	const reason = asText(plan.reason, "recovery.reason");
	if (reason.length > policy.maxReasonChars) {
		throw new RecoveryPlanError(`must be at most ${policy.maxReasonChars} characters`, "recovery.reason");
	}

	const resolved: RecoveryPlan = { action: action as RecoveryAction, targetNodeId, reason };

	if (plan.task !== undefined) {
		if (!TASK_ACTIONS.has(action)) {
			throw new RecoveryPlanError(`action '${action}' does not accept a task`, "recovery.task");
		}
		const task = asText(plan.task, "recovery.task");
		if (task.length > policy.maxTaskChars) {
			throw new RecoveryPlanError(`must be at most ${policy.maxTaskChars} characters`, "recovery.task");
		}
		if (FREE_EXPRESSION.test(task)) {
			throw new RecoveryPlanError(
				"must be plain instructions; template interpolation and arrow functions are not substituted",
				"recovery.task",
			);
		}
		resolved.task = task;
	} else if (action === "replace_node" || action === "replace_tool" || action === "compensate") {
		// 这三个动作都要生成新节点。没有 task 就只能照抄原任务，等于换个 id 重试同一件事。
		throw new RecoveryPlanError(`action '${action}' requires a task`, "recovery.task");
	}

	if (plan.role !== undefined) {
		if (!TASK_ACTIONS.has(action)) {
			throw new RecoveryPlanError(`action '${action}' does not accept a role`, "recovery.role");
		}
		const role = asText(plan.role, "recovery.role");
		if (!ROLES.has(role)) throw new RecoveryPlanError(`unknown role '${role}'`, "recovery.role");
		// 提权护栏：只读节点失败后不得借恢复动作换成 executor。否则"读文件失败"能变成
		// "写文件重试"，恢复流程本身成了绕过角色边界的通道。
		if (role === "executor" && context.failedRole !== undefined && context.failedRole !== "executor") {
			throw new RecoveryPlanError(
				`cannot escalate role '${context.failedRole}' to 'executor' during recovery`,
				"recovery.role",
			);
		}
		resolved.role = role as SubagentRoleId;
	}

	if (plan.contextFrom !== undefined) {
		if (!TASK_ACTIONS.has(action)) {
			throw new RecoveryPlanError(`action '${action}' does not accept contextFrom`, "recovery.contextFrom");
		}
		if (!Array.isArray(plan.contextFrom)) {
			throw new RecoveryPlanError("must be an array of node ids", "recovery.contextFrom");
		}
		if (plan.contextFrom.length > policy.maxFanOut) {
			throw new RecoveryPlanError(`must reference at most ${policy.maxFanOut} nodes`, "recovery.contextFrom");
		}
		const seen = new Set<string>();
		const contextFrom = plan.contextFrom.map((value, index) => {
			const path = `recovery.contextFrom[${index}]`;
			const id = asText(value, path);
			if (!context.knownNodeIds.includes(id)) throw new RecoveryPlanError(`unknown node '${id}'`, path);
			// 失败节点没有输出通道，读它只会拿到空值——那是把恢复节点建成必然失败的形状。
			if (id === context.failedNodeId) {
				throw new RecoveryPlanError(`cannot read from the failed node '${id}'`, path);
			}
			if (seen.has(id)) throw new RecoveryPlanError(`duplicate node '${id}'`, path);
			seen.add(id);
			return id;
		});
		resolved.contextFrom = contextFrom;
	}

	return resolved;
}

/**
 * 恢复节点 id。固定格式让下游能识别出这是恢复产物，也保证同一目标的多次尝试互不覆盖；
 * 成功后其产出发布到原目标的输出通道，下游契约不变。
 */
export function recoveryNodeId(targetNodeId: string, attempt: number): string {
	return `${targetNodeId}__recovery_${attempt}`;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (
		value === null
		|| typeof value !== "object"
		|| Array.isArray(value)
		|| (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	) {
		throw new RecoveryPlanError("must be a record", path);
	}
	return value as Record<string, unknown>;
}

function asText(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new RecoveryPlanError("must be a non-empty string", path);
	}
	return value;
}
