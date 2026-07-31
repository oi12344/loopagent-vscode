import { describe, it, expect } from "vitest";
import { createJavaAdapter } from "../src/extension/intelligence/languages/javaAdapter";
import type { ParsedSource } from "../src/extension/intelligence/parser/parserRuntime";

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
});
