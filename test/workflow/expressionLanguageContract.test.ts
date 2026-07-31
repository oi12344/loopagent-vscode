import { describe, it, expect } from "vitest";
import { createDataFlowManager, type ExpressionContext } from "../../src/extension/agent/workflow/dataFlowManager";
import type { SubagentResult } from "../../src/extension/agent/workflow/types";

// runDynamicGraph 的工具描述（dynamicWorkflowTools.ts 的 EXPRESSION LANGUAGE 段）向模型逐条
// 承诺了一批表达式形式。描述里出现但求值器不支持的形式，会让模型写出永远静默失效的
// breakWhen / condition —— 循环只能靠 hardLimit 结束，且不报任何错。本文件锁死两个方向：
// 承诺的形式必须可用，明确声明“不支持”的形式必须抛错而不是静默返回假值。
describe("EXPRESSION LANGUAGE 契约", () => {
	function contextOf(nodes: Record<string, string>, globalData: Record<string, unknown> = {}): ExpressionContext {
		return {
			nodes: new Map<string, SubagentResult>(
				Object.entries(nodes).map(([id, content]) => [id, { status: "completed", content } as SubagentResult]),
			),
			globalData: new Map(Object.entries(globalData)) as ExpressionContext["globalData"],
		};
	}

	function evaluate(expression: string, context: ExpressionContext) {
		return createDataFlowManager().evaluateExpression(expression, context);
	}

	describe("子串测试 <nodeId>.content.includes('text')", () => {
		it("命中子串返回 true", () => {
			expect(evaluate("review.content.includes('APPROVED')", contextOf({ review: "APPROVED: 全部通过" }))).toBe(true);
		});

		it("未命中返回 false", () => {
			expect(evaluate("review.content.includes('APPROVED')", contextOf({ review: "发现 3 个问题" }))).toBe(false);
		});

		it("双引号写法同样可用", () => {
			expect(evaluate('review.content.includes("APPROVED")', contextOf({ review: "APPROVED" }))).toBe(true);
		});

		it("被测子串含括号时不破坏解析", () => {
			expect(evaluate("review.content.includes('score(9)')", contextOf({ review: "final score(9) ok" }))).toBe(true);
		});

		it("节点不存在时返回 false 而不抛错", () => {
			expect(evaluate("missing.content.includes('APPROVED')", contextOf({ review: "x" }))).toBe(false);
		});

		it("JSON 内容不会被 JSON path 分支吞掉", () => {
			// 回归用例：修复前 includes 会落入 JSON path 分支，JSON.parse 失败后静默返回 null。
			expect(evaluate("review.content.includes('decision')", contextOf({ review: '{"decision":"approve"}' }))).toBe(true);
		});
	});

	describe("一元取反 !<expr>", () => {
		it("对未命中的子串取反得到 true", () => {
			expect(evaluate("!review.content.includes('APPROVED')", contextOf({ review: "发现 3 个问题" }))).toBe(true);
		});

		it("对命中的子串取反得到 false", () => {
			expect(evaluate("!review.content.includes('APPROVED')", contextOf({ review: "APPROVED" }))).toBe(false);
		});

		it("取反不与 !== 混淆", () => {
			expect(evaluate("review.status !== 'failed'", contextOf({ review: "x" }))).toBe(true);
		});
	});

	describe("逻辑与 <exprA> && <exprB>", () => {
		it("两侧为真时返回 true", () => {
			expect(evaluate(
				"review.status === 'completed' && review.content.includes('APPROVED')",
				contextOf({ review: "APPROVED" }),
			)).toBe(true);
		});

		it("一侧为假时返回 false", () => {
			expect(evaluate(
				"review.status === 'completed' && review.content.includes('APPROVED')",
				contextOf({ review: "还有问题" }),
			)).toBe(false);
		});

		it("支持三段串联", () => {
			expect(evaluate(
				"a.content.includes('x') && b.content.includes('y') && c.content.includes('z')",
				contextOf({ a: "x", b: "y", c: "z" }),
			)).toBe(true);
		});

		it("左侧为假时短路，右侧非法也不抛错", () => {
			expect(evaluate(
				"review.content.includes('APPROVED') && nodes.get('x')",
				contextOf({ review: "未通过" }),
			)).toBe(false);
		});
	});

	describe("数值比较", () => {
		const context = contextOf({ count: "7" });

		it.each([
			[">= 5", "count.content >= 5", true],
			[">= 9", "count.content >= 9", false],
			["> 5", "count.content > 5", true],
			["<= 7", "count.content <= 7", true],
			["< 5", "count.content < 5", false],
		])("%s", (_label, expression, expected) => {
			expect(evaluate(expression, context)).toBe(expected);
		});

		it("非数值内容比较返回 false 而不抛错", () => {
			expect(evaluate("count.content >= 5", contextOf({ count: "not-a-number" }))).toBe(false);
		});
	});

	describe("已有形式回归", () => {
		it("=== 严格比较", () => {
			expect(evaluate("review.status === 'completed'", contextOf({ review: "x" }))).toBe(true);
		});

		it("裸节点引用返回内容", () => {
			expect(evaluate("review.content", contextOf({ review: "hello" }))).toBe("hello");
		});

		it("$globalKey 引用", () => {
			expect(evaluate("$total", contextOf({}, { total: 42 }))).toBe(42);
		});

		it("JSON path 仍可读嵌套字段", () => {
			expect(evaluate("plan.content.summary", contextOf({ plan: '{"summary":"done"}' }))).toBe("done");
		});
	});

	describe("明确声明不支持的形式必须抛错", () => {
		it.each([
			["nodes.get('x')", "nodes.get('x')"],
			["optional chaining", "review?.content"],
			["length", "review.content.length"],
			["cycleState", "cycleState.round >= 2"],
			["逻辑或", "review.content === 'a' || review.content === 'b'"],
			["空表达式", "   "],
		])("%s 抛 Unsupported expression", (_label, expression) => {
			expect(() => evaluate(expression, contextOf({ review: "x" }))).toThrow(/Unsupported expression/);
		});
	});
});
