import { describe, expect, it } from "vitest";
import { ModelProviderError } from "../../src/extension/model/types";
import {
	DEFAULT_RECOVERY_POLICY,
	FAILURE_CATEGORIES,
	allowedRecoveryActions,
	classifyFailure,
	failureFingerprint,
	isRecoveryBudgetExhausted,
	nodeRecoveryActions,
	parseRecoveryPlan,
	recoveryNodeId,
} from "../../src/extension/agent/workflow/workflowRecovery";
import type { FailureCategory, RecoveryPlanContext } from "../../src/extension/agent/workflow/workflowRecovery";

/**
 * 分类表里的错误原文全部来自运行时真实抛出的位置（workflowOrchestrator、reactAgentRunner、
 * dynamicGraphEngine、openAiCompatibleClient、openAiReactModelTurn、Node 的 errno）。
 * 用真实原文而不是想象的关键字，是这张表唯一有意义的前提：分类若对不上真实错误，
 * RecoverySupervisor 会自信地选错动作。
 */
describe("classifyFailure", () => {
	it.each([
		["subagent timeout", "Subagent timed out after 30000ms", "transient"],
		["rate limit", "DeepSeek rate limit reached", "transient"],
		["overloaded", "DeepSeek server is overloaded", "transient"],
		["socket reset", "ECONNRESET: socket hang up", "transient"],
		["unsupported expression", "Unsupported expression: review.content.length", "planning"],
		["circular dependency", 'Circular dependsOn detected involving initial node "a"', "planning"],
		["duplicate node", "Duplicate node id: analyze", "planning"],
		["node limit", "Maximum nodes limit (10) exceeded", "planning"],
		["depth limit", "Maximum depth (5) exceeded for node analyze", "planning"],
		["step limit", "GraphLimitExceeded: maxSteps 50", "planning"],
		["dangling reference", 'Node "b" declares dependsOn "z", which is not a known initial node id', "planning"],
		["unknown role", "Unknown subagent role: architect", "planning"],
		["missing file", "ENOENT: no such file or directory, open 'src/missing.ts'", "context"],
		["blocked dependency", "Dependency read did not complete successfully", "context"],
		["unknown tool", 'Tool error: Unknown tool "writeFile"', "tool"],
		["bad tool arguments", "Tool error: Invalid JSON arguments for tool editFile", "tool"],
		["rejected parameters", "DeepSeek rejected the request parameters: messages too long", "provider"],
		["permission denied", "EACCES: permission denied, open '/etc/hosts'", "external"],
		["auth failure", "DeepSeek API authentication failed", "external"],
		["no balance", "DeepSeek account balance is insufficient", "external"],
		["internal invariant", "Node read returned no result", "unknown"],
		["unrecognized text", "something went sideways", "unknown"],
	] as const)("classifies %s as %s", (_name, error, expected) => {
		expect(classifyFailure({ nodeId: "read", error })).toBe(expected satisfies FailureCategory);
	});

	// 类型化 code 优先于文本匹配：文案改了分类也不会跟着失效。
	it.each([
		["missing_api_key", "external"],
		["authentication_failed", "external"],
		["insufficient_balance", "external"],
		["invalid_parameters", "provider"],
		["rate_limited", "transient"],
		["server_error", "transient"],
		["server_overloaded", "transient"],
		["request_failed", "transient"],
	] as const)("maps provider code %s to %s", (code, expected) => {
		const error = new ModelProviderError(code, "wording that matches no pattern at all");
		expect(classifyFailure({ nodeId: "draft", error })).toBe(expected satisfies FailureCategory);
	});

	it.each([
		["unknown", "unknown"],
		["applied", "applied"],
	] as const)("puts side effect outcome %s ahead of a transient error", (_name, outcome) => {
		// 写操作可能已生效时归到 transient 会诱导盲目重试造成重复写入，所以副作用优先。
		expect(classifyFailure({
			nodeId: "write",
			error: "Subagent timed out after 30000ms",
			sideEffect: { outcome },
		})).toBe("side-effect-uncertain");
	});

	it("keeps normal classification when the side effect never happened", () => {
		expect(classifyFailure({
			nodeId: "write",
			error: "Subagent timed out after 30000ms",
			sideEffect: { outcome: "none" },
		})).toBe("transient");
	});

	it.each([
		["Error 实例", new Error("Subagent timed out after 30000ms"), "transient"],
		["字符串", "Subagent timed out after 30000ms", "transient"],
		["undefined", undefined, "unknown"],
		["非错误对象", { code: 500 }, "unknown"],
	] as const)("accepts %s without throwing", (_name, error, expected) => {
		expect(classifyFailure({ nodeId: "read", error })).toBe(expected satisfies FailureCategory);
	});
});

describe("failureFingerprint", () => {
	it("collapses varying numbers and paths so a repeated failure stays identifiable", () => {
		// Supervisor 靠 fingerprint + action 去重。指纹带上超时毫秒数或行号就永远不重复，
		// "禁止相同动作无限重复"的护栏也就失效。
		const first = failureFingerprint("read", "transient", "Subagent timed out after 30000ms");
		const second = failureFingerprint("read", "transient", "Subagent timed out after 45000ms");
		expect(first).toBe(second);
	});

	it("separates different nodes, categories and messages", () => {
		const base = failureFingerprint("read", "transient", "Subagent timed out after 30000ms");
		expect(failureFingerprint("write", "transient", "Subagent timed out after 30000ms")).not.toBe(base);
		expect(failureFingerprint("read", "unknown", "Subagent timed out after 30000ms")).not.toBe(base);
		expect(failureFingerprint("read", "transient", "DeepSeek rate limit reached")).not.toBe(base);
	});
});

describe("allowedRecoveryActions", () => {
	it.each([
		["transient", ["retry", "replace_node", "switch_provider"]],
		["planning", ["replan", "replace_node", "request_input"]],
		["context", ["replan", "replace_node", "request_input"]],
		["tool", ["replace_tool", "replace_node", "replan"]],
		["provider", ["switch_provider", "replan", "request_input"]],
		["side-effect-uncertain", ["reconcile_side_effect", "compensate", "request_input"]],
		["external", ["wait_external", "request_input"]],
		["unknown", ["replan", "replace_node", "request_input"]],
	] as const)("offers category %s exactly the declared actions", (category, expected) => {
		expect(allowedRecoveryActions(category)).toEqual(expected);
	});

	it.each(FAILURE_CATEGORIES)("forces category %s to reconcile first when the node may have written something", (category) => {
		// 盲目重试写操作正是治理约束禁止的形态。replace_node 同样被排除：替代节点执行的是
		// 同一件写操作，换个 id 不会让重复写入变安全。
		expect(allowedRecoveryActions(category, { hasSideEffect: true }))
			.toEqual(["reconcile_side_effect", "compensate", "request_input"]);
	});

	it("leaves only persistent waiting once the recovery budget is exhausted", () => {
		// 没有这条，"达到上限后持久化等待"只是文档里的话；运行时仍会被拉着无限重试。
		expect(allowedRecoveryActions("transient", { attempt: DEFAULT_RECOVERY_POLICY.maxRecoveryAttempts }))
			.toEqual(["request_input", "wait_external"]);
	});

	it.each([
		[0, false],
		[1, false],
		[2, true],
		[3, true],
	] as const)("reports attempt %i as exhausted=%s", (attempt, expected) => {
		expect(isRecoveryBudgetExhausted(attempt)).toBe(expected);
	});
});

describe("nodeRecoveryActions", () => {
	it("gives a side-effecting node only reconcile, compensate or wait on a human", () => {
		// 治理约束"副作用角色只能选择对账、补偿或请求确认"的编译期落点。
		// wait_external 一并纳入：预算耗尽后运行时只剩 request_input/wait_external，
		// 上界少了它就会把副作用节点逼到无合法动作可选。
		expect(nodeRecoveryActions(true)).toEqual([
			"reconcile_side_effect", "compensate", "request_input", "wait_external",
		]);
	});

	it("never offers a read-only node reconciliation of a write that cannot exist", () => {
		const actions = nodeRecoveryActions(false);
		expect(actions).not.toContain("reconcile_side_effect");
		expect(actions).not.toContain("compensate");
		expect(actions).toEqual(expect.arrayContaining(["retry", "replan", "replace_node", "replace_tool", "switch_provider"]));
	});

	it.each(FAILURE_CATEGORIES)("keeps the runtime set for %s inside the static upper bound", (category) => {
		// 静态上界写进编译产物，运行时只能在其内收紧。任一分类越界，说明编译产物在骗下游。
		// 只读节点跳过 side-effect-uncertain：classifyFailure 只在存在副作用证据时才返回该分类，
		// 而只读角色拿不到 applyEdit/runCommand，永远产不出这种证据。上界因此不必覆盖它。
		for (const hasSideEffect of [true, false]) {
			if (!hasSideEffect && category === "side-effect-uncertain") continue;
			const bound = nodeRecoveryActions(hasSideEffect);
			for (const action of allowedRecoveryActions(category, { hasSideEffect })) {
				expect(bound).toContain(action);
			}
		}
	});

	it("covers the exhausted-budget actions for both node kinds", () => {
		// 预算耗尽后运行时只给 request_input/wait_external，两种节点的上界都必须含这两个，
		// 否则"达到上限后持久化等待"会被上界挡掉，节点无路可走。
		for (const hasSideEffect of [true, false]) {
			const exhausted = allowedRecoveryActions("transient", {
				hasSideEffect,
				attempt: DEFAULT_RECOVERY_POLICY.maxRecoveryAttempts,
			});
			for (const action of exhausted) expect(nodeRecoveryActions(hasSideEffect)).toContain(action);
		}
	});
});

const baseContext: RecoveryPlanContext = {
	category: "context",
	failedNodeId: "read",
	knownNodeIds: ["probe", "read", "summarize"],
	failedRole: "explorer",
};

describe("parseRecoveryPlan", () => {
	it("accepts a replacement node that pulls context from a succeeded sibling", () => {
		expect(parseRecoveryPlan({
			action: "replace_node",
			targetNodeId: "read",
			reason: "the original path did not exist",
			task: "List the files under src/ first, then read the one that matches",
			role: "explorer",
			contextFrom: ["probe"],
		}, baseContext)).toEqual({
			action: "replace_node",
			targetNodeId: "read",
			reason: "the original path did not exist",
			task: "List the files under src/ first, then read the one that matches",
			role: "explorer",
			contextFrom: ["probe"],
		});
	});

	it("accepts a minimal wait plan when the category calls for it", () => {
		expect(parseRecoveryPlan({
			action: "wait_external",
			targetNodeId: "read",
			reason: "DEEPSEEK_API_KEY is not configured",
		}, { ...baseContext, category: "external" })).toEqual({
			action: "wait_external",
			targetNodeId: "read",
			reason: "DEEPSEEK_API_KEY is not configured",
		});
	});

	it("accepts a bounded timeout override for a repair attempt", () => {
		expect(parseRecoveryPlan({
			action: "replace_node",
			targetNodeId: "read",
			reason: "the original attempt timed out",
			task: "Return the required output",
			timeoutMs: 60_000,
		}, baseContext)).toEqual(expect.objectContaining({ timeoutMs: 60_000 }));
	});

	it("names the offending path so the model can correct one field", () => {
		expect(() => parseRecoveryPlan({
			action: "replace_node",
			targetNodeId: "read",
			reason: "retry with context",
			task: "read the file",
			contextFrom: ["probe", "probe"],
		}, baseContext)).toThrow(/^recovery\.contextFrom\[1\]:/);
	});
});

const wideContext: RecoveryPlanContext = {
	...baseContext,
	knownNodeIds: ["read", "n1", "n2", "n3", "n4", "n5", "n6", "n7"],
};

/**
 * 每条用例都断言精确的字段 path，而不只是"抛错了"。模型只有拿到 path 才能改对那一个字段；
 * 只说"invalid plan"会让它整份重写，恢复预算就在重写里烧光了。
 */
describe("parseRecoveryPlan 拒绝越界的恢复动作", () => {
	it.each([
		[
			"未知字段",
			{ action: "replan", targetNodeId: "read", reason: "r", hint: "extra" },
			baseContext,
			"recovery.hint",
		],
		[
			"未知动作",
			{ action: "restart_everything", targetNodeId: "read", reason: "r" },
			baseContext,
			"recovery.action",
		],
		[
			"分类不允许的动作",
			{ action: "retry", targetNodeId: "read", reason: "r" },
			baseContext,
			"recovery.action",
		],
		[
			"预算耗尽后仍想自动重试",
			{ action: "retry", targetNodeId: "read", reason: "r" },
			{ ...baseContext, category: "transient" as const, attempt: DEFAULT_RECOVERY_POLICY.maxRecoveryAttempts },
			"recovery.action",
		],
		[
			"副作用节点想直接重试",
			{ action: "retry", targetNodeId: "read", reason: "r" },
			{ ...baseContext, category: "transient" as const, hasSideEffect: true },
			"recovery.action",
		],
		[
			"未知目标节点",
			{ action: "replan", targetNodeId: "ghost", reason: "r" },
			baseContext,
			"recovery.targetNodeId",
		],
		[
			"重试指向别的节点",
			{ action: "retry", targetNodeId: "summarize", reason: "r" },
			{ ...baseContext, category: "transient" as const },
			"recovery.targetNodeId",
		],
		[
			"任务里的模板插值",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "Read ${outputs.probe} again" },
			baseContext,
			"recovery.task",
		],
		[
			"任务里的箭头函数",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "files.filter(f => f.ok)" },
			baseContext,
			"recovery.task",
		],
		[
			"超长任务",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "x".repeat(DEFAULT_RECOVERY_POLICY.maxTaskChars + 1) },
			baseContext,
			"recovery.task",
		],
		[
			"不接受 task 的动作带了 task",
			{ action: "request_input", targetNodeId: "read", reason: "r", task: "ask the user" },
			baseContext,
			"recovery.task",
		],
		[
			"replace_node 缺少 task",
			{ action: "replace_node", targetNodeId: "read", reason: "r" },
			baseContext,
			"recovery.task",
		],
		[
			"提权到 executor",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "write it", role: "executor" },
			{ ...baseContext, failedRole: "explorer" as const },
			"recovery.role",
		],
		[
			"未知角色",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "t", role: "architect" },
			baseContext,
			"recovery.role",
		],
		[
			"不接受 role 的动作带了 role",
			{ action: "request_input", targetNodeId: "read", reason: "r", role: "explorer" },
			baseContext,
			"recovery.role",
		],
		[
			"contextFrom 超出 fan-out 上限",
			{
				action: "replace_node",
				targetNodeId: "read",
				reason: "r",
				task: "t",
				contextFrom: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"],
			},
			wideContext,
			"recovery.contextFrom",
		],
		[
			"contextFrom 读失败节点自身",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "t", contextFrom: ["read"] },
			baseContext,
			"recovery.contextFrom[0]",
		],
		[
			"contextFrom 重复引用",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "t", contextFrom: ["probe", "probe"] },
			baseContext,
			"recovery.contextFrom[1]",
		],
		[
			"contextFrom 引用未知节点",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "t", contextFrom: ["ghost"] },
			baseContext,
			"recovery.contextFrom[0]",
		],
		[
			"contextFrom 不是数组",
			{ action: "replace_node", targetNodeId: "read", reason: "r", task: "t", contextFrom: "probe" },
			baseContext,
			"recovery.contextFrom",
		],
		[
			"不接受 contextFrom 的动作带了 contextFrom",
			{ action: "request_input", targetNodeId: "read", reason: "r", contextFrom: ["probe"] },
			baseContext,
			"recovery.contextFrom",
		],
		[
			"超长 reason",
			{ action: "replan", targetNodeId: "read", reason: "x".repeat(DEFAULT_RECOVERY_POLICY.maxReasonChars + 1) },
			baseContext,
			"recovery.reason",
		],
		[
			"空 reason",
			{ action: "replan", targetNodeId: "read", reason: "   " },
			baseContext,
			"recovery.reason",
		],
		[
			"缺少 targetNodeId",
			{ action: "replan", reason: "r" },
			baseContext,
			"recovery.targetNodeId",
		],
		[
			"整体不是对象",
			"replan read",
			baseContext,
			"recovery",
		],
	] as const)("拒绝%s", (_name, plan, context, path) => {
		expect(() => parseRecoveryPlan(plan, context)).toThrow(path);
	});
});

describe("recoveryNodeId", () => {
	it("keeps attempts distinct so a second recovery cannot overwrite the first", () => {
		expect(recoveryNodeId("read", 1)).toBe("read__recovery_1");
		expect(recoveryNodeId("read", 2)).not.toBe(recoveryNodeId("read", 1));
	});
});

describe("recovery timeout validation", () => {
	it("rejects non-positive and over-limit timeout overrides", () => {
		for (const timeoutMs of [0, DEFAULT_RECOVERY_POLICY.maxTimeoutMs + 1]) {
			expect(() => parseRecoveryPlan({
				action: "replace_node",
				targetNodeId: "read",
				reason: "r",
				task: "t",
				timeoutMs,
			}, baseContext)).toThrow("recovery.timeoutMs");
		}
	});

	it("rejects timeout overrides on waiting actions", () => {
		expect(() => parseRecoveryPlan({
			action: "request_input",
			targetNodeId: "read",
			reason: "r",
			timeoutMs: 1_000,
		}, baseContext)).toThrow("recovery.timeoutMs");
	});
});
