import { describe, expect, it } from "vitest";

import { classifyTask, getExecutionGuidance } from "../../src/extension/agent/taskClassifier";

describe("classifyTask", () => {
  describe("simple tasks", () => {
    it("classifies read-only operations as simple", () => {
      const queries = [
        "读取 src/auth.ts 的内容",
        "查看登录模块的实现",
        "显示配置文件",
        "列出所有测试文件",
        "打开 package.json",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("simple");
        expect(result.confidence).toBe("high");
      }
    });

    it("classifies precise location queries as simple", () => {
      const result = classifyTask("在 auth.ts 文件第 42 行");
      expect(result.complexity).toBe("simple");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toBe("精确定位");
    });

    it("classifies conceptual questions as simple", () => {
      const queries = [
        "什么是依赖注入",
        "为什么需要类型守卫",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("simple");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("概念问题");
      }
    });

    it("classifies 'how it works' questions as simple", () => {
      const result = classifyTask("这个模块如何工作");
      expect(result.complexity).toBe("simple");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toBe("概念问题");
    });

    it("classifies symbol search as simple", () => {
      const queries = [
        "找 UserAuth 类的定义",
        "搜索 validateToken 函数",
        "定位 IAuthProvider 接口",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("simple");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("符号查找");
      }
    });

    it("classifies code understanding queries as simple", () => {
      const result = classifyTask("这段代码做什么");
      expect(result.complexity).toBe("simple");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toBe("代码理解");
    });
  });

  describe("complex tasks", () => {
    it("classifies feature additions as complex", () => {
      const queries = [
        "添加用户登录功能",
        "新增文件上传模块",
        "实现实时通知特性",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("新功能开发");
      }
    });

    it("classifies architectural changes as complex", () => {
      const queries = [
        "重构整个认证系统",
        "优化数据库架构",
        "改进路由模块的架构",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("架构级变更");
      }
    });

    it("classifies batch operations as complex", () => {
      const result = classifyTask("修复所有的类型错误");
      expect(result.complexity).toBe("complex");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toBe("批量修复");
    });

    it("classifies system integrations as complex", () => {
      const queries = [
        "集成第三方支付",
        "连接 Redis 缓存",
        "对接 OAuth 服务",
        "迁移到新的 API",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("系统集成");
      }
    });

    it("classifies global-scope changes as complex", () => {
      const queries = [
        "更新所有组件的样式",
        "修改整个项目模块的 ESLint 配置",
        "重命名每个文件中的 API 调用",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("全局范围");
      }
    });

    it("classifies cross-cutting concerns as complex", () => {
      const queries = [
        "添加深色模式支持",
        "添加主题切换",
        "添加国际化支持",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        expect(result.reasoning).toBe("横切关注点");
      }
    });

    it("classifies multi-goal tasks as complex", () => {
      const queries = [
        "修复登录 bug 并添加记住密码功能",
        "重构代码，优化性能，添加测试",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("complex");
        expect(result.confidence).toBe("high");
        // The first query matches "添加...功能" pattern, so reasoning will be "新功能开发"
        // The second query has multiple punctuation splits, so it triggers multi-goal detection
      }
    });

    it("specifically detects multi-goal pattern", () => {
      // Use a query that won't match other complex patterns
      const result = classifyTask("做这个，做那个，还要做另一个");
      expect(result.complexity).toBe("complex");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toBe("包含多个独立目标");
    });
  });

  describe("medium tasks (default fallback)", () => {
    it("defaults unmatched patterns to medium with low confidence", () => {
      const queries = [
        "更新这个函数",
        "改一下样式",
        "调整配置",
      ];

      for (const query of queries) {
        const result = classifyTask(query);
        expect(result.complexity).toBe("medium");
        expect(result.confidence).toBe("low");
        expect(result.reasoning).toBe("未匹配已知模式");
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty query", () => {
      const result = classifyTask("");
      expect(result.complexity).toBe("medium");
      expect(result.confidence).toBe("low");
    });

    it("handles query with mixed case", () => {
      const result = classifyTask("读取 Auth.TS 文件");
      expect(result.complexity).toBe("simple");
    });

    it("handles query with extra whitespace", () => {
      const result = classifyTask("   查看  登录模块   ");
      expect(result.complexity).toBe("simple");
    });
  });
});

describe("getExecutionGuidance", () => {
  it("provides direct tool call guidance for simple tasks", () => {
    const guidance = getExecutionGuidance({
      complexity: "simple",
      confidence: "high",
      reasoning: "只读操作",
    });

    expect(guidance).toContain("direct tool calls");
    expect(guidance).toContain("browseSymbols or exploreCode");
    expect(guidance).toContain("Avoid creating subagents");
  });

  it("provides structured exploration guidance for medium tasks", () => {
    const guidance = getExecutionGuidance({
      complexity: "medium",
      confidence: "low",
      reasoning: "未匹配已知模式",
    });

    expect(guidance).toContain("medium-complexity");
    expect(guidance).toContain("one or two subagents");
    expect(guidance).toContain("explore → implement");
  });

  it("provides multi-phase coordination guidance for complex tasks", () => {
    const guidance = getExecutionGuidance({
      complexity: "complex",
      confidence: "high",
      reasoning: "新功能开发",
    });

    expect(guidance).toContain("complex task");
    expect(guidance).toContain("spawnSubagent");
    expect(guidance).toContain("Parallel explorers");
    expect(guidance).toContain("planner");
    expect(guidance).toContain("Parallel executors");
    expect(guidance).toContain("waitForSubagents");
  });
});
