import { describe, expect, it, vi } from "vitest";

import { createDynamicWorkflowTools } from "../src/extension/agent/dynamicWorkflowTools";
import type { ReactAgentTool } from "../src/extension/agent/reactTypes";
import type { CreateSubagentConfig, SubagentResult } from "../src/extension/agent/workflow/types";
import type { WorkflowOrchestrator } from "../src/extension/agent/workflowOrchestrator";
import { createConversationStore } from "../src/extension/conversation/conversationStore";

describe("dynamic workflow tools", () => {
	it("exposes a single merged tool and rejects invalid initial graphs before execution", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		expect(tools.map((tool) => tool.name)).toEqual(["runDynamicGraph"]);

		const tool = toolByName(tools, "runDynamicGraph");
		const properties = tool.inputSchema.properties as Record<string, any>;
		const nodeProperties = properties.initialNodes.items.properties as Record<string, unknown>;

		expect(nodeProperties).toEqual(expect.objectContaining({
			dependsOn: expect.anything(),
			exportTo: expect.anything(),
			retry: expect.anything(),
			outputContract: expect.objectContaining({ type: "object" }),
		}));
		expect((nodeProperties.outputContract as any).properties.exactText).toEqual(expect.objectContaining({ type: "string" }));
		expect((properties.nodes.items.properties as Record<string, unknown>).timeoutMs).toEqual(expect.objectContaining({ type: "integer" }));
		expect(properties.initialGlobalData).toBeDefined();
		expect(properties.nodes).toBeDefined();
		expect(properties.initialState).toBeDefined();
		expect(properties.maxSteps).toBeDefined();
		expect(properties.resolvers.items.required).toEqual(["nodeId", "resolverType", "resolverConfig"]);
		expect(properties.include.items.enum).toEqual(["visualization", "debug", "mermaid"]);
		// Running a whole graph -- executor writes included -- must never share a concurrent batch.
		expect(tool.isConcurrencySafe?.(undefined)).toBe(false);

		await expect(runGraphRaw(tools, [{ id: "same", task: "a" }, { id: "same", task: "b" }])).rejects.toThrow(/duplicate/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a", dependsOn: ["missing"] }])).rejects.toThrow(/not a known initial node/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a", role: "writer" }])).rejects.toThrow(/role must be one of/i);
		await expect(runGraphRaw(tools, [{ id: "invalid id", task: "a" }])).rejects.toThrow(/node id/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a" }, { id: "b", task: "b" }], { maxNodes: 1 })).rejects.toThrow(/maximum nodes/i);
		await expect(runGraphRaw(tools, [
			{ id: "a", task: "a", dependsOn: ["b"] },
			{ id: "b", task: "b", dependsOn: ["a"] },
		])).rejects.toThrow(/circular/i);
		const deepNodes = Array.from({ length: 12 }, (_, index) => ({
			id: `depth-${index}`,
			task: `depth ${index}`,
			...(index > 0 && { dependsOn: [`depth-${index - 1}`] }),
		}));
		await expect(runGraphRaw(tools, deepNodes)).rejects.toThrow(/maximum depth \(10\)/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a" }], { include: ["timeline"] })).rejects.toThrow(/include entries must be one of/i);
		await expect(runGraphRaw(tools, [{ id: "a", task: "a" }], {
			cycles: [{ id: "invalid", from: "a", to: "missing", exit: { hardLimit: 1 } }],
		})).rejects.toThrow(/not an initial node/i);

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "review", task: "Review", role: "reviewer", dependsOn: ["read"] },
		]);
		expect(result.nodes).toEqual([
			{ id: "read", role: "explorer", dependsOn: [] },
			{ id: "review", role: "reviewer", dependsOn: ["read"] },
		]);
		expect(result.completedNodes).toEqual(["read", "review"]);
		expect(result.executionOrder).toEqual(["read", "review"]);
		expect(result.totalNodes).toBe(2);
		expect(result.statusCounts).toEqual({ completed: 2 });
		expect(result).not.toHaveProperty("visualization");
		expect(result).not.toHaveProperty("debugInfo");
		expect(result).not.toHaveProperty("mermaid");
	});

	it("rejects write nodes that declare no verifiable output contract", async () => {
		const orchestrator = scriptedOrchestrator(() => "ok");
		const tools = createDynamicWorkflowTools({ orchestrator, availableTools: [] });

		// executor 默认落进 sideEffect="unknown"，是最需要闸门的一类。
		await expect(runGraphRaw(tools, [{ id: "write", task: "Write", role: "executor" }]))
			.rejects.toThrow(/write nodes must declare a verifiable outputContract: write/i);
		// 显式声明副作用的非 executor 节点同样算写节点。
		await expect(runGraphRaw(tools, [{ id: "apply", task: "Apply", sideEffect: "applied" }]))
			.rejects.toThrow(/must declare a verifiable outputContract: apply/i);
		// 空对象不算契约。这一条由 parseOutputContract 先拦下，报的是它自己的信息；
		// hasVerifiableContract 里的同一判断是给语义图路径（不走 parseNodeConfigs）兜底。
		await expect(runGraphRaw(tools, [{ id: "write", task: "Write", role: "executor", outputContract: {} }]))
			.rejects.toThrow(/outputContract must define exactText, requiredText, requiredFields, or minLength/i);
		await expect(runGraphRaw(tools, [{ id: "write", task: "Write", role: "executor", outputContract: { requiredFields: [] } }]))
			.rejects.toThrow(/outputContract/i);
		// 错误信息要够模型一次改对：带 id、带可照抄的形状。
		await expect(runGraphRaw(tools, [{ id: "write", task: "Write", role: "executor" }]))
			.rejects.toThrow(/requiredFields/);
		// 被拒的图一个子智能体都不该起——拒绝发生在执行之前。
		expect(orchestrator.createSubagent).not.toHaveBeenCalled();

		// 只读角色不需要契约。
		const readOnly = await runGraph(tools, [{ id: "read", task: "Read", role: "explorer" }]);
		expect(readOnly.workflowStatus).toBe("completed");
		// executor 配了契约就放行。
		const contracted = await runGraph(tools, [
			{ id: "write", task: "Write", role: "executor", outputContract: { minLength: 1 } },
		]);
		expect(contracted.workflowStatus).toBe("completed");
		// sideEffect="none" 显式声明为只读的 executor 也放行。
		const declaredReadOnly = await runGraph(tools, [
			{ id: "check", task: "Check", role: "executor", sideEffect: "none" },
		]);
		expect(declaredReadOnly.workflowStatus).toBe("completed");
	});

	it("closes the resolver bypass for generated write nodes", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });

		// fanout 会把一个配置扇成 N 个写节点，构造期就要拒。
		await expect(runGraphRaw(tools, [{ id: "read", task: "Read", role: "explorer" }], {
			resolvers: [{
				nodeId: "read",
				resolverType: "fanout",
				resolverConfig: { itemsExpression: "$items", idPrefix: "edit", task: "Edit", itemInputKey: "item", role: "executor" },
			}],
		})).rejects.toThrow(/resolverConfig write nodes must declare a verifiable outputContract/i);

		// conditional 的节点走 parseNodeConfigs，同一条策略。
		await expect(runGraphRaw(tools, [{ id: "read", task: "Read", role: "explorer" }], {
			resolvers: [{
				nodeId: "read",
				resolverType: "conditional",
				resolverConfig: { expression: "read.status === 'completed'", nodes: [{ id: "write", task: "Write", role: "executor" }] },
			}],
		})).rejects.toThrow(/resolverConfig\.nodes write nodes must declare a verifiable outputContract/i);

		// iterative 生成的节点无法携带契约，所以不许把 revise 声明成 executor。
		await expect(runGraphRaw(tools, [{ id: "read", task: "Read", role: "explorer" }], {
			resolvers: [{
				nodeId: "read",
				resolverType: "iterative",
				resolverConfig: {
					maxRounds: 2,
					approvalText: "APPROVED",
					reviseTask: "Revise",
					reviewTask: "Review",
					idPrefix: "loop",
					reviseRole: "executor",
				},
			}],
		})).rejects.toThrow(/reviseRole cannot be "executor"/i);
	});

	it("passes a fanout output contract through to every generated node", async () => {
		const captured: CreateSubagentConfig[] = [];
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator(() => JSON.stringify({ filesChanged: ["a.ts"] }), captured),
			availableTools: [],
		});

		const result = await runGraph(
			tools,
			[{ id: "read", task: "Read", role: "explorer" }],
			{
				initialGlobalData: { items: ["a", "b"] },
				resolvers: [{
					nodeId: "read",
					resolverType: "fanout",
					resolverConfig: {
						itemsExpression: "$items",
						idPrefix: "edit",
						task: "Edit the file, reply with JSON {filesChanged}.",
						itemInputKey: "item",
						role: "executor",
						outputContract: { requiredFields: ["filesChanged"] },
					},
				}],
			},
		);

		expect(result.completedNodes).toEqual(expect.arrayContaining(["edit-1", "edit-2"]));
		expect(captured.filter((config) => config.role === "executor")).toHaveLength(2);
	});

	it("fails a generated write node whose output misses the fanout contract", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.role === "executor" ? "已完成，所有测试通过" : "ok"),
			availableTools: [],
		});

		const result = await runGraph(
			tools,
			[{ id: "read", task: "Read", role: "explorer" }],
			{
				initialGlobalData: { items: ["a"] },
				resolvers: [{
					nodeId: "read",
					resolverType: "fanout",
					resolverConfig: {
						itemsExpression: "$items",
						idPrefix: "edit",
						task: "Edit the file, reply with JSON {filesChanged}.",
						itemInputKey: "item",
						role: "executor",
						outputContract: { requiredFields: ["filesChanged"] },
					},
				}],
			},
		);

		// 一句自信的假报告不再算完成——契约要求的是结构化证据。
		expect(result.completedNodes).not.toContain("edit-1");
		expect(result.results["edit-1"].status).toBe("failed");
		expect(result.results["edit-1"].error).toMatch(/Output contract requires JSON content/);
	});

	it("bounds node content returned to the host and flags what it dropped", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => "x".repeat(config.task.startsWith("Read") ? 9_000 : 9_000)),
			availableTools: [],
		});

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "report", task: "Report", role: "reviewer", dependsOn: ["read"] },
		]);

		// read 有下游，按中间节点配额；report 是叶子，拿叶子配额。
		expect(result.results.read.content).toHaveLength(1_000);
		expect(result.results.read.contentTruncated).toBe(true);
		expect(result.results.read.omittedChars).toBe(8_000);
		expect(result.results.report.content).toHaveLength(4_000);
		expect(result.results.report.omittedChars).toBe(5_000);
		expect(result.resultsNote).toMatch(/不要推测被省略的内容/);
		expect(result.results.read.status).toBe("completed");
	});

	it("keeps short node content intact and omits the truncation note", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator(() => "short answer"),
			availableTools: [],
		});

		const result = await runGraph(tools, [{ id: "read", task: "Read", role: "explorer" }]);

		expect(result.results.read).toEqual({ status: "completed", content: "short answer" });
		expect(result).not.toHaveProperty("resultsNote");
	});

	it("spends the total results budget on leaf nodes before interior ones", async () => {
		// 8 个叶子 × 4000 = 32000 > 24000 总预算，逼预算耗尽。
		const leaves = Array.from({ length: 8 }, (_, index) => ({
			id: `leaf-${index}`,
			task: `Leaf ${index}`,
			role: "explorer",
		}));
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator(() => "y".repeat(5_000)),
			availableTools: [],
		});

		const result = await runGraph(tools, leaves);

		const total = Object.values(result.results as Record<string, { content?: string }>)
			.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
		expect(total).toBeLessThanOrEqual(24_000);
		// 预算耗尽的节点省略 content 而不是给空串——空串读起来像"节点没产出"。
		const starved = Object.values(result.results as Record<string, any>).filter((entry) => entry.content === undefined);
		expect(starved.length).toBeGreaterThan(0);
		for (const entry of starved) expect(entry.contentTruncated).toBe(true);
	});

	it("keeps failure errors readable even when content is starved of budget", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.role === "explorer"
				? { status: "completed", content: "z".repeat(30_000) }
				: { status: "failed", error: "downstream could not parse the upstream payload" }),
			availableTools: [],
		});

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "check", task: "Check", role: "reviewer", dependsOn: ["read"], condition: { type: "always" } },
		]);

		expect(result.results.check.error).toBe("downstream could not parse the upstream payload");
	});

	it("returns observability payloads only when include requests them", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const result = await runGraph(
			tools,
			[{ id: "read", task: "Read", role: "explorer" }],
			{ include: ["visualization", "debug", "mermaid"] },
		);

		expect(result.visualization.nodes).toEqual([expect.objectContaining({ id: "read", status: "completed" })]);
		expect(result.visualization.stats.totalNodes).toBe(1);
		expect(result.debugInfo.nodeDetails.read).toEqual(expect.objectContaining({ id: "read", task: "Read" }));
		expect(result.debugInfo.executionOrder).toEqual(["read"]);
		expect(result.mermaid).toContain("graph TD");
	});

	it("fails the tool call when no node completes so the required-tool gate stays closed", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: failingOrchestrator("subagent exploded"),
			availableTools: [],
		});

		await expect(runGraphRaw(tools, [{ id: "read", task: "Read", role: "explorer" }]))
			.rejects.toThrow(/No graph node completed \(failed: 1\)/i);
	});

	it("runs the preferred semantic plan with a state-driven review loop", async () => {
		let reviewRuns = 0;
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.role === "reviewer"
				? (++reviewRuns > 1 ? '{"decision":"approve","feedback":[]}' : '{"decision":"revise","feedback":["change it"]}')
				: "draft output"),
			availableTools: [],
		});

		const result = JSON.parse(String(await invoke(tools, "runDynamicGraph", {
			nodes: [
				{ id: "draft", task: "Draft", role: "planner" },
				{ id: "review", task: "Review", role: "reviewer", after: ["draft"], reviews: ["draft"] },
			],
		}))); 

		expect(reviewRuns).toBe(2);
		expect(result.completedNodes).toEqual(["draft", "review"]);
		expect(result.executionOrder).toEqual(["draft", "review", "draft", "review"]);
		expect(result.workflowState).toEqual(expect.objectContaining({ step: 4, stateVersion: 4 }));
	});

	it("lists only successfully completed nodes in completedNodes", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.task === "Fail"
				? { status: "failed", error: "boom" }
				: { status: "completed", content: "ok" }),
			availableTools: [],
		});

		const result = await runGraph(tools, [
			{ id: "ok", task: "Succeed" },
			{ id: "failed", task: "Fail" },
		]);

		expect(result.statusCounts).toEqual({ completed: 1, failed: 1 });
		expect(result.completedNodes).toEqual(["ok"]);
		expect(result.results.failed).toEqual({ status: "failed", error: "boom" });
	});

	it("normalizes retry with a replacement task and repairs without rerunning upstream", async () => {
		let aRuns = 0;
		let bRuns = 0;
		let plannerRuns = 0;
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner" && config.task.includes("WORKFLOW_RECOVERY_DIAGNOSIS")) {
					plannerRuns++;
					return {
						status: "completed",
						content: JSON.stringify({ action: "retry", targetNodeId: "B", reason: "sk-test-secret-" + "r".repeat(401), task: "B repaired", timeoutMs: 1_000 }),
					};
				}
				if (config.task === "A") {
					aRuns++;
					return { status: "completed", content: "A done" };
				}
				if (config.task === "B" && bRuns++ === 0) return { status: "failed", error: "schema invalid" };
				if (config.task === "B repaired") return { status: "completed", content: "B fixed" };
				return { status: "completed", content: "C done" };
			}),
			availableTools: [],
		});

		const result = await runGraph(tools, [
			{ id: "A", task: "A" },
			{ id: "B", task: "B", dependsOn: ["A"], retry: { maxAttempts: 3 } },
			{ id: "C", task: "C", dependsOn: ["B"], inputMapping: { b: "B.content" } },
		]);

		expect(result.workflowStatus).toBe("completed");
		expect(aRuns).toBe(1);
		expect(bRuns).toBe(1);
		expect(plannerRuns).toBe(1);
		expect(result.completedNodes).toEqual(expect.arrayContaining(["A", "B", "C"]));
		expect(result.recoveryDiagnostics).toEqual([expect.objectContaining({ nodeId: "B", action: "replace_node", timeoutMs: 1_000 })]);
		expect(result.recoveryDiagnostics[0].reason.length).toBeLessThanOrEqual(400);
		expect(result.recoveryDiagnostics[0].reason).not.toContain("sk-test-secret");
	});

	it("applies the same diagnosis flow to a semantic compiled graph", async () => {
		let aRuns = 0;
		let bRuns = 0;
		let plannerRuns = 0;
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner" && config.task.includes("WORKFLOW_RECOVERY_DIAGNOSIS")) {
					plannerRuns++;
					return {
						status: "completed",
						content: JSON.stringify({ action: "replace_node", targetNodeId: "B", reason: "repair semantic step", task: "B repaired" }),
					};
				}
				if (config.task === "A") {
					aRuns++;
					return { status: "completed", content: "A done" };
				}
				if (config.task.startsWith("B repaired")) return { status: "completed", content: "B fixed" };
				if (config.task.startsWith("B")) {
					bRuns++;
					return bRuns === 1 ? { status: "failed", error: "semantic schema invalid" } : { status: "completed", content: "B unexpected" };
				}
				return { status: "completed", content: "C done" };
			}),
			availableTools: [],
		});

		const result = await runGraphRaw(tools, [], {
			nodes: [
				{ id: "A", task: "A", role: "planner" },
				{ id: "B", task: "B", role: "planner", after: ["A"] },
				{ id: "C", task: "C", role: "planner", after: ["B"] },
			],
		});
		const parsed = JSON.parse(String(result));

		expect(parsed.workflowStatus).toBe("completed");
		expect(aRuns).toBe(1);
		expect(bRuns).toBe(1);
		expect(plannerRuns).toBe(1);
		expect(parsed.completedNodes).toEqual(expect.arrayContaining(["A", "B", "C"]));
	});

	it("resumes a failed graph without rerunning completed nodes", async () => {
		let aRuns = 0;
		let bRuns = 0;
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.task === "A") {
					aRuns++;
					return { status: "completed", content: "A done" };
				}
				if (config.task === "B") {
					bRuns++;
					return bRuns === 1
						? { status: "failed", error: "temporary" }
						: { status: "completed", content: "B done" };
				}
				return { status: "completed", content: "planner response" };
			}),
			availableTools: [],
			conversationId: "conversation-1",
			runId: "run-1",
			checkpointStore: store,
		});
		const input = {
			initialNodes: [
				{ id: "A", task: "A" },
				{ id: "B", task: "B", retry: { maxAttempts: 2 } },
			],
		};

		const first = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(first.workflowStatus).toBe("recovery_required");
		expect(first.resumeToken).toEqual(expect.any(String));
		expect(aRuns).toBe(1);
		expect(bRuns).toBe(1);

		const second = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(second.workflowStatus).toBe("completed");
		expect(second.completedNodes).toEqual(expect.arrayContaining(["A", "B"]));
		expect(aRuns).toBe(1);
		expect(bRuns).toBe(2);
		expect(store.loadWorkflowCheckpoint("conversation-1", "run-1")).toBeUndefined();
	});

	it("replaces a previous run checkpoint when the same conversation starts a new run", async () => {
		const store = createConversationStore();
		const firstRunTools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner") return { status: "completed", content: "invalid recovery plan" };
				return config.task === "done"
					? { status: "completed", content: "done" }
					: { status: "failed", error: "temporary" };
			}),
			availableTools: [],
			conversationId: "conversation-next-run",
			runId: "run-1",
			checkpointStore: store,
		});
		const first = JSON.parse(String(await invoke(firstRunTools, "runDynamicGraph", {
			initialNodes: [{ id: "done", task: "done" }, { id: "failed", task: "failed", dependsOn: ["done"] }],
		})));
		expect(first.workflowStatus).toBe("recovery_required");

		const secondRunTools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator(() => ({ status: "completed", content: "fresh" })),
			availableTools: [],
			conversationId: "conversation-next-run",
			runId: "run-2",
			checkpointStore: store,
		});
		const second = JSON.parse(String(await invoke(secondRunTools, "runDynamicGraph", {
			initialNodes: [{ id: "fresh", task: "fresh" }],
		})));

		expect(second.workflowStatus).toBe("completed");
		expect(second).not.toHaveProperty("checkpointError");
		expect(store.loadWorkflowCheckpoint("conversation-next-run", "run-1")).toBeUndefined();
		expect(store.loadWorkflowCheckpoint("conversation-next-run", "run-2")).toBeUndefined();
	});

	it("keeps the previous run checkpoint when a new run has invalid graph input or a resolver", async () => {
		const store = createConversationStore();
		const firstRunTools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner") return { status: "completed", content: "invalid recovery plan" };
				return config.task === "done"
					? { status: "completed", content: "done" }
					: { status: "failed", error: "temporary" };
			}),
			availableTools: [],
			conversationId: "conversation-invalid-resolver",
			runId: "run-1",
			checkpointStore: store,
		});
		const first = JSON.parse(String(await invoke(firstRunTools, "runDynamicGraph", {
			initialNodes: [{ id: "done", task: "done" }, { id: "failed", task: "failed", dependsOn: ["done"] }],
		})));
		expect(first.workflowStatus).toBe("recovery_required");

		const secondRunTools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator(() => ({ status: "completed", content: "unused" })),
			availableTools: [],
			conversationId: "conversation-invalid-resolver",
			runId: "run-2",
			checkpointStore: store,
		});
		await expect(invoke(secondRunTools, "runDynamicGraph", {
			initialNodes: [{ id: "source", task: "source" }],
			resolvers: [{ nodeId: "source", resolverType: "fanout", resolverConfig: {} }],
		})).rejects.toThrow(/itemsExpression/);

		expect(store.getWorkflowCheckpointRunId("conversation-invalid-resolver")).toBe("run-1");
		expect(store.loadWorkflowCheckpoint("conversation-invalid-resolver", "run-1")).toBeDefined();

		await expect(invoke(secondRunTools, "runDynamicGraph", {
			nodes: [{ id: "source", task: "source", contextFrom: ["missing"] }],
		})).rejects.toThrow(/unknown node reference/);

		expect(store.getWorkflowCheckpointRunId("conversation-invalid-resolver")).toBe("run-1");
		expect(store.loadWorkflowCheckpoint("conversation-invalid-resolver", "run-1")).toBeDefined();
	});

	it("restores resolver-created nodes from checkpoint definitions", async () => {
		let sourceRuns = 0;
		let dynamicRuns = 0;
		let plannerRuns = 0;
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner" && config.task.includes("WORKFLOW_RECOVERY_DIAGNOSIS")) {
					plannerRuns++;
					return { status: "completed", content: "not valid recovery json" };
				}
				if (config.task === "source") {
					sourceRuns++;
					return { status: "completed", content: "true" };
				}
				dynamicRuns++;
				return dynamicRuns === 1 ? { status: "failed", error: "temporary" } : { status: "completed", content: "dynamic done" };
			}),
			availableTools: [],
			conversationId: "conversation-resolver",
			runId: "run-resolver",
			checkpointStore: store,
		});
		const input = {
			initialNodes: [{ id: "source", task: "source" }],
			resolvers: [{
				nodeId: "source",
				resolverType: "conditional",
				resolverConfig: { expression: "source.content.includes('true')", nodes: [{ id: "dynamic", task: "dynamic", retry: { maxAttempts: 2 } }] },
			}],
		};

		const first = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(first.workflowStatus).toBe("recovery_required");
		expect(first.resumeToken).toEqual(expect.any(String));
		expect(store.loadWorkflowCheckpoint("conversation-resolver", "run-resolver")?.nodes.dynamic.definition).toEqual(expect.objectContaining({ task: "dynamic", dependsOn: ["source"] }));

		const second = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(second.workflowStatus).toBe("completed");
		expect(second.completedNodes).toEqual(expect.arrayContaining(["source", "dynamic"]));
		expect(sourceRuns).toBe(1);
		expect(dynamicRuns).toBe(2);
		expect(plannerRuns).toBe(1);
		expect(second.recoveryDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "dynamic" })]));
	});

	it("rejects a stale resume token instead of silently selecting a checkpoint", async () => {
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.task === "ok"
				? { status: "completed", content: "ok" }
				: { status: "failed", error: "no result" }),
			availableTools: [],
			conversationId: "conversation-token",
			runId: "run-token",
			checkpointStore: store,
		});
		const input = { initialNodes: [{ id: "ok", task: "ok" }, { id: "node", task: "node", dependsOn: ["ok"] }] };
		const first = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		const decoded = JSON.parse(Buffer.from(first.resumeToken, "base64url").toString("utf8"));
		decoded.revision += 1;
		const staleToken = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
		await expect(invoke(tools, "runDynamicGraph", { ...input, resumeToken: staleToken })).rejects.toThrow(/stale|no longer available/i);
	});

	it("bounds and redacts oversized checkpoint results", async () => {
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner" && config.task.includes("WORKFLOW_RECOVERY_DIAGNOSIS")) return { status: "completed", content: "invalid" };
				if (config.task === "A") return { status: "completed", content: `apiKey=sk-checkpoint-secret-${"x".repeat(300_000)}` };
				return { status: "failed", error: `Bearer checkpoint-secret-${"y".repeat(300_000)}` };
			}),
			availableTools: [],
			conversationId: "conversation-large",
			runId: "run-large",
			checkpointStore: store,
		});
		const result = JSON.parse(String(await invoke(tools, "runDynamicGraph", {
			initialNodes: [{ id: "A", task: "A" }, { id: "B", task: "B", dependsOn: ["A"] }],
		})));
		const checkpoint = store.loadWorkflowCheckpoint("conversation-large", "run-large");
		expect(result.workflowStatus).toBe("recovery_required");
		expect(result).not.toHaveProperty("checkpointError");
		expect(checkpoint?.nodes.A.result?.content?.length).toBeLessThan(10_000);
		expect(checkpoint?.nodes.A.result?.content).not.toContain("sk-checkpoint-secret");
		expect(checkpoint?.unresolvedFailures[0]?.message).not.toContain("checkpoint-secret");
	});

	it("does not automatically repeat an executor with unknown side effects", async () => {
		let executorRuns = 0;
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.role === "executor"
				? (++executorRuns, { status: "failed", error: "response lost" })
				: { status: "completed", content: "read-only result" }),
			availableTools: [],
			conversationId: "conversation-side-effect",
			runId: "run-side-effect",
			checkpointStore: store,
		});
		const input = {
			initialNodes: [
				{ id: "read", task: "Read", role: "explorer" },
				{ id: "write", task: "Write", role: "executor", outputContract: { minLength: 1 } },
			],
		};

		const first = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(store.loadWorkflowCheckpoint("conversation-side-effect", "run-side-effect")?.nodes.write.sideEffect).toBe("unknown");
		const second = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(first.workflowStatus).toBe("recovery_required");
		expect(second.workflowStatus).toBe("recovery_required");
		expect(executorRuns).toBe(1);
	});

	it("keeps a side-effect diagnosis action without executing a second write", async () => {
		let executorRuns = 0;
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.role === "planner" && config.task.includes("WORKFLOW_RECOVERY_DIAGNOSIS")) {
					return {
						status: "completed",
						content: JSON.stringify({
							action: "request_input",
							targetNodeId: "write",
							reason: "confirm whether the write was applied",
						}),
					};
				}
				if (config.role === "executor") {
					executorRuns++;
					return { status: "failed", error: "response lost" };
				}
				return { status: "completed", content: "read-only result" };
			}),
			availableTools: [],
			conversationId: "conversation-side-effect-diagnostic",
			runId: "run-side-effect-diagnostic",
			checkpointStore: store,
		});

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "write", task: "Write", role: "executor", dependsOn: ["read"], outputContract: { minLength: 1 } },
		]);

		expect(result.workflowStatus).toBe("recovery_required");
		expect(result.recoveryDiagnostics).toEqual([
			expect.objectContaining({
				nodeId: "write",
				action: "request_input",
				reason: "confirm whether the write was applied",
			}),
		]);
		expect(executorRuns).toBe(1);
		expect(store.loadWorkflowCheckpoint("conversation-side-effect-diagnostic", "run-side-effect-diagnostic")?.nodes.write.recoveryAttempts).toBe(1);
	});

	it("clears a transient checkpoint save error after a later save succeeds", async () => {
		const baseStore = createConversationStore();
		let saveCalls = 0;
		const store = {
			claimWorkflowCheckpoint: baseStore.claimWorkflowCheckpoint,
			saveWorkflowCheckpoint: (checkpoint: Parameters<typeof baseStore.saveWorkflowCheckpoint>[0]) => {
				saveCalls++;
				return saveCalls === 1 ? false : baseStore.saveWorkflowCheckpoint(checkpoint);
			},
			loadWorkflowCheckpoint: baseStore.loadWorkflowCheckpoint,
			getWorkflowCheckpointRunId: baseStore.getWorkflowCheckpointRunId,
			clearWorkflowCheckpoint: baseStore.clearWorkflowCheckpoint,
		};
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => config.role === "executor"
				? { status: "failed", error: "response lost" }
				: { status: "completed", content: "read-only result" }),
			availableTools: [],
			conversationId: "conversation-save-recovery",
			runId: "run-save-recovery",
			checkpointStore: store,
		});

		const result = await runGraph(tools, [
			{ id: "read", task: "Read", role: "explorer" },
			{ id: "write", task: "Write", role: "executor", dependsOn: ["read"], outputContract: { minLength: 1 } },
		]);

		expect(saveCalls).toBeGreaterThan(1);
		expect(result.workflowStatus).toBe("recovery_required");
		expect(result.resumeToken).toEqual(expect.any(String));
		expect(result).not.toHaveProperty("checkpointError");
	});

	it("resumes a semantic compiled plan from its saved frontier", async () => {
		let aRuns = 0;
		let bRuns = 0;
		const store = createConversationStore();
		const tools = createDynamicWorkflowTools({
			orchestrator: resultOrchestrator((config) => {
				if (config.task === "A") {
					aRuns++;
					return { status: "completed", content: "A done" };
				}
				if (config.task === "B" || config.task.startsWith("B\n")) {
					bRuns++;
					return bRuns === 1 ? { status: "failed", error: "temporary" } : { status: "completed", content: "B done" };
				}
				return { status: "completed", content: "planner response" };
			}),
			availableTools: [],
			conversationId: "conversation-semantic",
			runId: "run-semantic",
			checkpointStore: store,
		});
		const input = {
			nodes: [
				{ id: "A", task: "A", role: "planner" },
				{ id: "B", task: "B", role: "planner", after: ["A"] },
			],
		};

		const first = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(first.workflowStatus).toBe("recovery_required");
		expect(first.resumeToken).toEqual(expect.any(String));
		const second = JSON.parse(String(await invoke(tools, "runDynamicGraph", input)));
		expect(second.workflowStatus).toBe("completed");
		expect(aRuns).toBe(1);
		expect(bRuns).toBe(2);
	});

	it("rejects malformed resolver configuration before execution", async () => {
		const tools = createDynamicWorkflowTools({ orchestrator: scriptedOrchestrator(() => "ok"), availableTools: [] });
		const source = [{ id: "source", task: "Source" }];

		await expect(runGraphRaw(tools, source, {
			resolvers: [{ nodeId: "source", resolverType: "fanout", resolverConfig: { idPrefix: "scan", task: "Inspect", itemInputKey: "item" } }],
		})).rejects.toThrow(/itemsExpression/i);
		await expect(runGraphRaw(tools, source, {
			resolvers: [{ nodeId: "missing", resolverType: "conditional", resolverConfig: { expression: "true", nodes: [{ id: "x", task: "x" }] } }],
		})).rejects.toThrow(/not an initial node/i);
		await expect(runGraphRaw(tools, source, {
			resolvers: [
				{ nodeId: "source", resolverType: "conditional", resolverConfig: { expression: "true", nodes: [{ id: "x", task: "x" }] } },
				{ nodeId: "source", resolverType: "fanout", resolverConfig: { itemsExpression: "source.content", idPrefix: "s", task: "t", itemInputKey: "i" } },
			],
		})).rejects.toThrow(/duplicate resolver for node id/i);

		// An unparseable resolver expression must surface as ResolverFailed, not silently drop.
		const result = await runGraph(tools, source, {
			resolvers: [{ nodeId: "source", resolverType: "conditional", resolverConfig: { expression: "source.content + 1", nodes: [{ id: "x", task: "x" }] } }],
		});
		expect(result.resolverFailures).toEqual([
			expect.objectContaining({ nodeId: "source", error: expect.stringMatching(/unsupported expression/i) }),
		]);
	});

	it("registers a fanout resolver and injects each JSON item as untrusted graph data", async () => {
		const captured: CreateSubagentConfig[] = [];
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.task === "Generate items" ? '["alpha","beta"]' : "done", captured),
			availableTools: [],
		});
		const result = await runGraph(tools, [{ id: "source", task: "Generate items" }], {
			resolvers: [{
				nodeId: "source",
				resolverType: "fanout",
				resolverConfig: {
					itemsExpression: "source.content",
					idPrefix: "scan",
					task: "Inspect item",
					role: "explorer",
					toolHints: ["readFile"],
					retry: { maxAttempts: 2 },
					itemInputKey: "item",
				},
			}],
		});

		expect(result.completedNodes).toEqual(expect.arrayContaining(["source", "scan-1", "scan-2"]));
		const scanTasks = captured.filter((config) => config.task.startsWith("Inspect item")).map((config) => config.task);
		expect(scanTasks).toHaveLength(2);
		expect(scanTasks.join("\n")).toContain('trust="untrusted"');
		expect(scanTasks.join("\n")).toContain("alpha");
		expect(scanTasks.join("\n")).toContain("beta");
	});

	it("registers a conditional resolver and creates declared nodes only when truthy", async () => {
		let releaseGuard!: () => void;
		const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
		const captured: CreateSubagentConfig[] = [];
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator(async (config) => {
				if (config.task === "Guard") await guard;
				return "ok";
			}, captured),
			availableTools: [],
		});
		const execution = runGraphRaw(tools, [{ id: "source", task: "Source" }, { id: "guard", task: "Guard" }], {
			resolvers: [{
				nodeId: "source",
				resolverType: "conditional",
				resolverConfig: {
					expression: "source.status === 'completed'",
					nodes: [{ id: "branch", task: "Run branch", role: "reviewer", dependsOn: ["guard"] }],
				},
			}],
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(captured.some((config) => config.task === "Run branch")).toBe(false);
		releaseGuard();
		const result = JSON.parse(String(await execution));
		expect(result.completedNodes).toEqual(expect.arrayContaining(["source", "branch"]));
	});

	it("registers an iterative resolver and stops after approval", async () => {
		const tools = createDynamicWorkflowTools({
			orchestrator: scriptedOrchestrator((config) => config.task.startsWith("Review round 2") ? "APPROVED" : config.task === "Initial review" ? "REJECTED" : "revised"),
			availableTools: [],
		});
		const result = await runGraph(tools, [{ id: "review-1", task: "Initial review" }], {
			maxDepth: 5,
			resolvers: [{
				nodeId: "review-1",
				resolverType: "iterative",
				resolverConfig: {
					maxRounds: 3,
					approvalText: "APPROVED",
					reviseTask: "Revise round",
					reviewTask: "Review round",
					idPrefix: "loop",
					reviseRole: "planner",
					reviewRole: "reviewer",
				},
			}],
		});

		expect(result.completedNodes).toEqual(expect.arrayContaining(["review-1", "loop-revise-2", "loop-review-2"]));
		expect(result.completedNodes).not.toContain("loop-revise-3");
	});
});

function failingOrchestrator(error: string): WorkflowOrchestrator {
	let nextId = 1;
	return {
		createSubagent: vi.fn(() => `subagent-${nextId++}`),
		waitForSubagents: vi.fn(async (ids) => new Map(
			ids.map((id) => [id, { status: "failed", error } satisfies SubagentResult] as const),
		)),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

function resultOrchestrator(
	resultFor: (config: CreateSubagentConfig) => SubagentResult | Promise<SubagentResult>,
): WorkflowOrchestrator {
	const configs = new Map<string, CreateSubagentConfig>();
	let nextId = 1;
	return {
		createSubagent: vi.fn((config) => {
			const id = `subagent-${nextId++}`;
			configs.set(id, config);
			return id;
		}),
		waitForSubagents: vi.fn(async (ids) => new Map(await Promise.all(
			ids.map(async (id) => [id, await resultFor(configs.get(id)!)] as const),
		))),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

function scriptedOrchestrator(
	content: (config: CreateSubagentConfig) => string | Promise<string>,
	captured: CreateSubagentConfig[] = [],
): WorkflowOrchestrator {
	const configs = new Map<string, CreateSubagentConfig>();
	let nextId = 1;
	return {
		createSubagent: vi.fn((config) => {
			const id = `subagent-${nextId++}`;
			configs.set(id, config);
			captured.push(config);
			return id;
		}),
		waitForSubagents: vi.fn(async (ids) => {
			const entries = await Promise.all(ids.map(async (id) => [id, {
				status: "completed",
				content: await content(configs.get(id)!),
			} satisfies SubagentResult] as const));
			return new Map(entries);
		}),
		getSubagent: vi.fn(),
		cancelSubagent: vi.fn(() => true),
		cancelAll: vi.fn(),
		onEvent: vi.fn(() => () => {}),
	};
}

async function runGraph(
	tools: ReactAgentTool[],
	initialNodes: unknown[],
	extra: Record<string, unknown> = {},
): Promise<any> {
	return JSON.parse(String(await invoke(tools, "runDynamicGraph", { initialNodes, ...extra })));
}

function runGraphRaw(
	tools: ReactAgentTool[],
	initialNodes: unknown[],
	extra: Record<string, unknown> = {},
): Promise<string | object> {
	return invoke(tools, "runDynamicGraph", { initialNodes, ...extra });
}

function toolByName(tools: ReactAgentTool[], name: string): ReactAgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

function invoke(tools: ReactAgentTool[], name: string, input: unknown): Promise<string | object> {
	return Promise.resolve().then(() => toolByName(tools, name).invoke({
		request: { id: "request-1", name, rawArguments: JSON.stringify(input), input },
		input,
		signal: new AbortController().signal,
	}));
}
