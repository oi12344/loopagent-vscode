import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { createJavaAdapter } from "../src/extension/intelligence/languages/javaAdapter";
import type { ParsedSource } from "../src/extension/intelligence/parser/parserRuntime";
import { createTreeSitterParserRuntime } from "../src/extension/intelligence/parser/treeSitterRuntime";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

async function extractWithTree(text: string) {
  const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
  const parsed = await runtime.parse("app/Sample.java", "java", text);
  try {
    return createJavaAdapter().extract(parsed);
  } finally {
    parsed.tree?.delete();
  }
}

describe("JavaAdapter", () => {
  const adapter = createJavaAdapter();

  it("should have correct metadata", () => {
    expect(adapter.id).toBe("java");
    expect(adapter.languageIds).toEqual(["java"]);
    expect(adapter.extensions).toEqual([".java"]);
  });

  it("should extract class from Java source", () => {
    const source = `
package com.example;

public class LogisticsService {
    private String name;

    public void addLogisticsInfo(String info) {
        System.out.println(info);
    }
}
`;

    const parsed: ParsedSource = {
      filePath: "LogisticsService.java",
      text: source,
      tree: null,
    };

    const result = adapter.extract(parsed);

    // 应该提取到文件节点
    const fileNode = result.nodes.find((n) => n.kind === "module");
    expect(fileNode).toBeDefined();

    // 应该提取到类
    const classNode = result.nodes.find((n) => n.kind === "class" && n.name === "LogisticsService");
    expect(classNode).toBeDefined();
    expect(classNode?.id).toBe("com.example.LogisticsService");

    // 应该提取到方法
    const methodNode = result.nodes.find((n) => n.kind === "function" && n.name === "addLogisticsInfo");
    expect(methodNode).toBeDefined();

    // 应该提取到字段
    const fieldNode = result.nodes.find((n) => n.kind === "property" && n.name === "name");
    expect(fieldNode).toBeDefined();

    // 应该有边（contains 关系）
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it("should extract interface from Java source", () => {
    const source = `
package com.sunshine.procurement.service;

import com.sunshine.procurement.common.response.Result;
import com.sunshine.procurement.dto.AddLogisticsInfoDTO;

public interface LogisticsService {
    Result<Void> addLogisticsInfo(AddLogisticsInfoDTO dto);
}
`;

    const parsed: ParsedSource = {
      filePath: "LogisticsService.java",
      text: source,
      tree: null,
    };

    const result = adapter.extract(parsed);

    const interfaceNode = result.nodes.find((n) => n.kind === "class" && n.name === "LogisticsService");
    expect(interfaceNode).toBeDefined();
    expect(interfaceNode?.id).toBe("com.sunshine.procurement.service.LogisticsService");

    const methodNode = result.nodes.find((n) => n.kind === "function" && n.name === "addLogisticsInfo");
    expect(methodNode).toBeDefined();

    // 应该提取到 imports
    expect(result.importBindings.length).toBeGreaterThan(0);
    const resultImport = result.importBindings.find((imp) => imp.localName === "Result");
    expect(resultImport).toBeDefined();
  });

  it("does not treat 'return null;' as a field in the regex fallback", () => {
    const source = `
package com.example;

public class Result<T> {
    public T get() {
        return null;
    }
}
`;

    const parsed: ParsedSource = {
      filePath: "Result.java",
      text: source,
      tree: null,
    };

    const result = adapter.extract(parsed);

    const nullField = result.nodes.find((n) => n.kind === "property" && n.name === "null");
    expect(nullField).toBeUndefined();
  });

  it("gives overloaded methods distinct node ids via the AST extractor", async () => {
    const source = [
      "package com.example;",
      "",
      "public class Result<T> {",
      "    public T get() {",
      "        return null;",
      "    }",
      "",
      "    public T get(T fallback) {",
      "        return fallback;",
      "    }",
      "}",
      "",
    ].join("\n");

    const result = await extractWithTree(source);
    const methods = result.nodes.filter((n) => n.kind === "function" && n.name === "get");

    expect(methods).toHaveLength(2);
    expect(methods[0].id).not.toBe(methods[1].id);
    expect(new Set(result.nodes.map((n) => n.id)).size).toBe(result.nodes.length);
  });
});
