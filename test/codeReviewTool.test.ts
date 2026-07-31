import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodeReviewTool, type CodeReviewToolOptions } from "../src/extension/agent/codeReviewTool";

// ---------------------------------------------------------------------------
// 辅助函数：创建模拟的文件系统
// ---------------------------------------------------------------------------

type MockFiles = Record<string, string>;

function createMockOptions(mockFiles: MockFiles, targetIsDir: boolean = false): CodeReviewToolOptions {
  const entries: string[] = Object.keys(mockFiles);

  return {
    readFile: vi.fn(async (path: string) => {
      const content = mockFiles[path];
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    }),
    listFiles: vi.fn(async (dirPath: string) => {
      // 返回该目录下的直接子文件/子目录名
      const dirEntries = new Set<string>();
      for (const entry of entries) {
        if (entry.startsWith(dirPath + "/") || (dirPath === "" && !entry.includes("/"))) {
          const relative = entry.startsWith(dirPath + "/") ? entry.slice(dirPath.length + 1) : entry;
          const parts = relative.split("/");
          if (parts.length > 0 && parts[0]) {
            dirEntries.add(parts[0]);
          }
        }
      }
      return Array.from(dirEntries);
    }),
    isDirectory: vi.fn(async (path: string) => {
      if (targetIsDir) {
        // 如果根目标是目录，且 path 就是目标路径，返回 true
        // 否则检查是否有子文件以 path 为前缀
        for (const entry of entries) {
          if (entry.startsWith(path + "/") || entry === path) {
            if (entry === path) return false; // 是文件
            return true; // 有子文件说明它是目录
          }
        }
        return false;
      }
      return false;
    }),
    workspaceRoot: "/mock/workspace",
  };
}

// ---------------------------------------------------------------------------
// 测试代码样本
// ---------------------------------------------------------------------------

const SAMPLE_CLEAN_CODE = `import { foo } from "bar";

function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("World"));
`;

const SAMPLE_WITH_LONG_LINE = `import { something } from "somewhere";

// 这一行非常长，超过了 120 个字符的限制，应该被检测为长行问题
const veryLongString = "这是一个非常长的字符串目的是为了测试长行检测功能是否能够正确识别超过120个字符的行 limit";

function doStuff(): void {
  // TODO: 实现这个函数
}
`;

const SAMPLE_WITH_EMPTY_CATCH = `try {
  riskyOperation();
} catch (error) {}
`;

const SAMPLE_WITH_TODO = `function unfinished() {
  // TODO: 完成这个实现
  // FIXME: 这里有个已知问题
  // HACK: 临时解决方案
  return null;
}
`;

const SAMPLE_WITH_DUPLICATE_IMPORT = `import { foo } from "lodash";
import { bar } from "lodash";
import { baz } from "other";
`;

const SAMPLE_WITH_SECRET = `const config = {
  apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
  secret: "supersecretvalue123",
};
`;

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("createCodeReviewTool", () => {
  let toolOptions: CodeReviewToolOptions;

  beforeEach(() => {
    // 默认选项指向单个文件
    toolOptions = createMockOptions(
      { "src/test.ts": SAMPLE_CLEAN_CODE },
      false,
    );
  });

  it("应该创建具有正确工具名称和描述的工具", () => {
    const tool = createCodeReviewTool(toolOptions);
    expect(tool.name).toBe("codeReview");
    expect(tool.description).toBeDefined();
    expect(typeof tool.description).toBe("string");
  });

  it("应该声明为并发安全", () => {
    const tool = createCodeReviewTool(toolOptions);
    expect(tool.isConcurrencySafe).toBeDefined();
    expect(tool.isConcurrencySafe!()).toBe(true);
  });

  it("应该包含正确的 inputSchema", () => {
    const tool = createCodeReviewTool(toolOptions);
    const schema = tool.inputSchema;
    expect(schema).toBeDefined();
    expect((schema as Record<string, unknown>).type).toBe("object");
    const properties = (schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(properties).toBeDefined();
    expect(properties).toHaveProperty("targetPath");
    expect(properties).toHaveProperty("includePatterns");
    expect(properties).toHaveProperty("excludePatterns");
    const required = (schema as Record<string, unknown>).required as string[];
    expect(required).toContain("targetPath");
  });

  it("缺少 targetPath 时应该抛出错误", async () => {
    const tool = createCodeReviewTool(toolOptions);
    await expect(
      tool.invoke({
        request: { id: "1", name: "codeReview", rawArguments: "{}", input: {} },
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid codeReview input");
  });

  it("空的 targetPath 应该抛出错误", async () => {
    const tool = createCodeReviewTool(toolOptions);
    await expect(
      tool.invoke({
        request: {
          id: "1",
          name: "codeReview",
          rawArguments: '{"targetPath":""}',
          input: { targetPath: "" },
        },
        input: { targetPath: "" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid codeReview input");
  });

  it("应该能检测 console.log", async () => {
    const tool = createCodeReviewTool(toolOptions);
    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/test.ts"}',
        input: { targetPath: "src/test.ts" },
      },
      input: { targetPath: "src/test.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    expect(report.totalIssues).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((i: { message: string }) => i.message.includes("console"))).toBe(true);
  });

  it("应该能检测长行", async () => {
    const mockFiles = { "src/long.ts": SAMPLE_WITH_LONG_LINE };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/long.ts"}',
        input: { targetPath: "src/long.ts" },
      },
      input: { targetPath: "src/long.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    const longLineIssues = report.issues.filter((i: { message: string }) => i.message.includes("过长"));
    expect(longLineIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("应该能检测空 catch 块", async () => {
    const mockFiles = { "src/catch.ts": SAMPLE_WITH_EMPTY_CATCH };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/catch.ts"}',
        input: { targetPath: "src/catch.ts" },
      },
      input: { targetPath: "src/catch.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    const emptyCatchIssues = report.issues.filter((i: { message: string }) => i.message.includes("空的 catch"));
    expect(emptyCatchIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("应该能检测 TODO/FIXME/HACK 注释", async () => {
    const mockFiles = { "src/todo.ts": SAMPLE_WITH_TODO };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/todo.ts"}',
        input: { targetPath: "src/todo.ts" },
      },
      input: { targetPath: "src/todo.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    const todoIssues = report.issues.filter((i: { message: string }) => i.message.includes("TODO") || i.message.includes("FIXME") || i.message.includes("HACK"));
    expect(todoIssues.length).toBeGreaterThanOrEqual(3);
  });

  it("应该能检测重复导入", async () => {
    const mockFiles = { "src/imports.ts": SAMPLE_WITH_DUPLICATE_IMPORT };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/imports.ts"}',
        input: { targetPath: "src/imports.ts" },
      },
      input: { targetPath: "src/imports.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    const duplicateIssues = report.issues.filter((i: { message: string }) => i.message.includes("重复导入"));
    expect(duplicateIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("应该能检测硬编码的敏感凭据", async () => {
    const mockFiles = { "src/config.ts": SAMPLE_WITH_SECRET };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/config.ts"}',
        input: { targetPath: "src/config.ts" },
      },
      input: { targetPath: "src/config.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    const secretIssues = report.issues.filter((i: { message: string }) => i.message.includes("敏感凭据"));
    expect(secretIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("生成的报告应该包含正确的统计信息", async () => {
    const mockFiles = {
      "src/a.ts": SAMPLE_WITH_TODO,
      "src/b.ts": SAMPLE_WITH_EMPTY_CATCH,
    };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/a.ts"}',
        input: { targetPath: "src/a.ts" },
      },
      input: { targetPath: "src/a.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);

    expect(report).toHaveProperty("id");
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("targetPath");
    expect(report).toHaveProperty("totalIssues");
    expect(report).toHaveProperty("issuesBySeverity");
    expect(report).toHaveProperty("issuesByCategory");
    expect(report).toHaveProperty("issues");
    expect(Array.isArray(report.issues)).toBe(true);

    // 验证统计一致性
    const totalFromIssues = report.issues.length;
    expect(report.totalIssues).toBe(totalFromIssues);

    const severitySum = Object.values(report.issuesBySeverity as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
    expect(severitySum).toBe(totalFromIssues);

    const categorySum = Object.values(report.issuesByCategory as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
    expect(categorySum).toBe(totalFromIssues);
  });

  it("应该能通过 includePatterns 过滤文件", async () => {
    const mockFiles = {
      "src/foo.ts": SAMPLE_CLEAN_CODE,
      "src/bar.js": SAMPLE_CLEAN_CODE,
    };
    const options = createMockOptions(mockFiles, false);
    const tool = createCodeReviewTool(options);

    // 只包含 .ts 文件
    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: JSON.stringify({
          targetPath: "src/foo.ts",
          includePatterns: ["**/*.ts"],
        }),
        input: {
          targetPath: "src/foo.ts",
          includePatterns: ["**/*.ts"],
        },
      },
      input: {
        targetPath: "src/foo.ts",
        includePatterns: ["**/*.ts"],
      },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);
    expect(report.targetPath).toBe("src/foo.ts");
  });

  it("没有文件匹配时应该返回空报告", async () => {
    const options = createMockOptions({}, false);
    const tool = createCodeReviewTool(options);

    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: '{"targetPath":"src/nonexistent.ts"}',
        input: { targetPath: "src/nonexistent.ts" },
      },
      input: { targetPath: "src/nonexistent.ts" },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);
    expect(report.totalIssues).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  it("无效的 includePatterns 应该抛出错误", async () => {
    const tool = createCodeReviewTool(toolOptions);
    await expect(
      tool.invoke({
        request: {
          id: "1",
          name: "codeReview",
          rawArguments: '{"targetPath":"src/test.ts","includePatterns":"not-an-array"}',
          input: { targetPath: "src/test.ts", includePatterns: "not-an-array" as unknown as string[] },
        },
        input: { targetPath: "src/test.ts", includePatterns: "not-an-array" as unknown as string[] },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid codeReview input");
  });

  it("应该支持通过 excludePatterns 排除文件", async () => {
    const tool = createCodeReviewTool(toolOptions);
    const result = await tool.invoke({
      request: {
        id: "1",
        name: "codeReview",
        rawArguments: JSON.stringify({
          targetPath: "src/test.ts",
          excludePatterns: ["**/*.ts"],
        }),
        input: {
          targetPath: "src/test.ts",
          excludePatterns: ["**/*.ts"],
        },
      },
      input: {
        targetPath: "src/test.ts",
        excludePatterns: ["**/*.ts"],
      },
      signal: new AbortController().signal,
    });

    const content = typeof result === "string" ? result : result.content;
    const report = JSON.parse(content);
    // 由于文件被排除，应该返回空报告
    expect(report.totalIssues).toBe(0);
  });
});
