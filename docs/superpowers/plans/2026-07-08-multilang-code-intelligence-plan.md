# 多语言代码智能索引实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 LoopAgent 第一条多语言代码智能链路：从 workspace 源码解析出统一语义图，并把 `exploreCode(task)` 结果注入模型上下文，减少依赖 `grep`/整文件读取。

**Architecture:** 新增 `src/extension/intelligence/`，内部按 parser、languages、graph、resolution、context 分层。第一轮交付使用内存图索引和可测试的轻量语言抽取器，接入 `modelRunner` 的 `systemPromptProvider(request)`，并在索引不可用时回退到现有 VS Code runtime context。

**Tech Stack:** TypeScript、Vitest、VS Code Extension Host、内存语义图索引、现有 `CodeRuntimeContext`；本轮只预留 `ParserRuntime` 抽象，不接入真实 `web-tree-sitter` 和 grammar wasm。

---

## 本轮边界

- 第一轮实现统一图模型、内存索引、TS/JS 与 Python 基础抽取、引用解析、图查询、prompt 渲染和模型链路注入。
- 第一轮不实现框架专用补边，例如 React render、NestJS route、Spring controller 这类依赖框架约定推断出的关系边。
- 第一轮不接入真实 Tree-sitter runtime，不修改 `package.json` 增加 grammar 依赖，不修改 `esbuild.js` 打包 wasm。
- 第一轮不接入完整 VS Code workspace 文件扫描，只落地路径过滤基础和可注入空实现，真实扫描单独排期。
- 第一轮内存索引必须受预算保护，不保存完整源码正文、完整 AST/CST、embedding 或全文倒排索引。
- 默认保护线：单文件 `512KB`、最多 `3000` 个文件、`50000` 个节点、`150000` 条边、`100000` 条未解析引用、单次 prompt 片段 `8000` 字符。
- 任一保护线触发时必须降级为 partial/failed 语义增强，模型链路继续使用现有 `CodeRuntimeContext`，不得因为语义索引构建失败阻塞普通聊天。

---

## 内存预算实现要求

后续执行任务 8 和任务 11 时必须遵守以下实现约束：

- `WorkspaceIntelligence` 不常驻保存源码正文；`readSourceRange` 只在查询命中后读取片段。
- parser 或 language adapter 之前必须先完成路径过滤、文件大小过滤和总量预算判断。
- 超过单文件大小、文件数、节点数、边数或未解析引用数时，停止继续扩张索引并记录 diagnostic。
- prompt 渲染必须按 `maxChars` 裁剪，并在结果中保留 `truncated` 标记。
- 本轮不引入 SQLite；如果默认保护线不足以覆盖大仓库，记录为后续持久化任务，不在第一阶段临时扩大内存预算。

---

## 文件结构

- 新建：`src/extension/intelligence/graph/graphTypes.ts`
  - 定义 `CodeNode`、`CodeEdge`、`UnresolvedReference`、`ImportBinding`、`CodeIntelligenceResult` 等共享类型。
- 新建：`src/extension/intelligence/graph/semanticGraph.ts`
  - 提供内存图存储、节点/边去重、incoming/outgoing 查询。
- 新建：`src/extension/intelligence/graph/searchIndex.ts`
  - 提供名称索引、segment 索引和 query 命中排序。
- 新建：`src/extension/intelligence/graph/graphTraverser.ts`
  - 提供 1 到 2 跳图扩展。
- 新建：`src/extension/intelligence/parser/parserRuntime.ts`
  - 定义 parser runtime 和 parsed source 抽象。
- 新建：`src/extension/intelligence/languages/languageAdapter.ts`
  - 定义语言 adapter 接口。
- 新建：`src/extension/intelligence/languages/typescriptAdapter.ts`
  - 第一版 TS/JS adapter；使用可测试的轻量抽取逻辑，后续接入 Tree-sitter query。
- 新建：`src/extension/intelligence/languages/pythonAdapter.ts`
  - 第一版 Python adapter；覆盖 module/class/function/import/call 的基础抽取。
- 新建：`src/extension/intelligence/resolution/referenceResolver.ts`
  - 把 `UnresolvedReference` 转成 `CodeEdge`。
- 新建：`src/extension/intelligence/context/codeIntelligencePrompt.ts`
  - 渲染语义图查询结果。
- 新建：`src/extension/intelligence/workspaceIntelligence.ts`
  - 扫描 workspace、构建索引、执行 `exploreCode`。
- 修改：`src/extension/model/modelRunner.ts`
  - 让 `systemPromptProvider` 接收 `AgentRunRequest`。
- 修改：`src/extension/model/providerRegistry.ts`
  - 组合现有 VS Code runtime context 和 code intelligence prompt。
- 测试：`test/intelligence/*.test.ts`
  - 分层覆盖图、搜索、adapter、resolver、prompt、模型注入。

---

### 任务 1: 建立语义图类型与内存图

**文件：**
- 新建：`src/extension/intelligence/graph/graphTypes.ts`
- 新建：`src/extension/intelligence/graph/semanticGraph.ts`
- 测试：`test/intelligence/semanticGraph.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/semanticGraph.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";
import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const fileNode: CodeNode = {
  id: "file:src/a.ts",
  kind: "file",
  name: "a.ts",
  qualifiedName: "src/a.ts",
  filePath: "src/a.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
};

const functionNode: CodeNode = {
  id: "symbol:src/a.ts:function:run:1",
  kind: "function",
  name: "run",
  qualifiedName: "src/a.ts::run",
  filePath: "src/a.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
};

const containsEdge: CodeEdge = {
  id: "edge:file:src/a.ts:contains:symbol:src/a.ts:function:run:1:1",
  source: fileNode.id,
  target: functionNode.id,
  kind: "contains",
  filePath: "src/a.ts",
  line: 1,
  confidence: "exact",
};

describe("SemanticGraph", () => {
  it("stores nodes, deduplicates edges, and exposes incoming/outgoing edges", () => {
    const graph = createSemanticGraph();

    graph.upsertNode(fileNode);
    graph.upsertNode(functionNode);
    graph.upsertEdge(containsEdge);
    graph.upsertEdge(containsEdge);

    expect(graph.getNode(functionNode.id)).toEqual(functionNode);
    expect(graph.getNodesByName("run")).toEqual([functionNode]);
    expect(graph.getOutgoingEdges(fileNode.id)).toEqual([containsEdge]);
    expect(graph.getIncomingEdges(functionNode.id)).toEqual([containsEdge]);
    expect(graph.getAllNodes()).toHaveLength(2);
    expect(graph.getAllEdges()).toHaveLength(1);
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/semanticGraph.test.ts`

预期：FAIL，错误包含无法解析 `semanticGraph` 或 `graphTypes`。

- [ ] **步骤 3: 实现共享类型**

创建 `src/extension/intelligence/graph/graphTypes.ts`：

```ts
export type CodeNodeKind =
  | "file"
  | "module"
  | "package"
  | "namespace"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "type"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "import"
  | "export";

export type CodeEdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "type_of"
  | "returns"
  | "instantiates";

export type CodeNode = {
  id: string;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  signature?: string;
  isExported?: boolean;
  metadata?: Record<string, unknown>;
};

export type CodeEdge = {
  id: string;
  source: string;
  target: string;
  kind: CodeEdgeKind;
  filePath?: string;
  line?: number;
  column?: number;
  confidence: "exact" | "probable" | "heuristic";
  metadata?: Record<string, unknown>;
};

export type ImportBinding = {
  filePath: string;
  localName: string;
  importedName: string;
  source: string;
  resolvedFilePath?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
  languageId: string;
};

export type UnresolvedReference = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: "calls" | "references" | "type_of" | "extends" | "implements";
  filePath: string;
  line: number;
  column?: number;
  localScope?: string;
  importSource?: string;
  languageId: string;
  metadata?: Record<string, unknown>;
};

export type IndexDiagnostic = {
  filePath: string;
  severity: "error" | "warning";
  message: string;
};
```

- [ ] **步骤 4: 实现内存图**

创建 `src/extension/intelligence/graph/semanticGraph.ts`：

```ts
import type { CodeEdge, CodeNode } from "./graphTypes";

export type SemanticGraph = {
  upsertNode(node: CodeNode): void;
  upsertEdge(edge: CodeEdge): void;
  getNode(id: string): CodeNode | undefined;
  getNodesByName(name: string): CodeNode[];
  getOutgoingEdges(nodeId: string): CodeEdge[];
  getIncomingEdges(nodeId: string): CodeEdge[];
  getAllNodes(): CodeNode[];
  getAllEdges(): CodeEdge[];
};

export function createSemanticGraph(): SemanticGraph {
  const nodesById = new Map<string, CodeNode>();
  const nodeIdsByName = new Map<string, Set<string>>();
  const edgesById = new Map<string, CodeEdge>();
  const outgoingBySource = new Map<string, Set<string>>();
  const incomingByTarget = new Map<string, Set<string>>();

  function addNodeNameIndex(node: CodeNode): void {
    const bucket = nodeIdsByName.get(node.name) ?? new Set<string>();
    bucket.add(node.id);
    nodeIdsByName.set(node.name, bucket);
  }

  return {
    upsertNode(node) {
      nodesById.set(node.id, node);
      addNodeNameIndex(node);
    },
    upsertEdge(edge) {
      if (edgesById.has(edge.id)) {
        return;
      }

      edgesById.set(edge.id, edge);
      const outgoing = outgoingBySource.get(edge.source) ?? new Set<string>();
      outgoing.add(edge.id);
      outgoingBySource.set(edge.source, outgoing);

      const incoming = incomingByTarget.get(edge.target) ?? new Set<string>();
      incoming.add(edge.id);
      incomingByTarget.set(edge.target, incoming);
    },
    getNode(id) {
      return nodesById.get(id);
    },
    getNodesByName(name) {
      return [...(nodeIdsByName.get(name) ?? [])]
        .map((id) => nodesById.get(id))
        .filter((node): node is CodeNode => Boolean(node));
    },
    getOutgoingEdges(nodeId) {
      return [...(outgoingBySource.get(nodeId) ?? [])]
        .map((id) => edgesById.get(id))
        .filter((edge): edge is CodeEdge => Boolean(edge));
    },
    getIncomingEdges(nodeId) {
      return [...(incomingByTarget.get(nodeId) ?? [])]
        .map((id) => edgesById.get(id))
        .filter((edge): edge is CodeEdge => Boolean(edge));
    },
    getAllNodes() {
      return [...nodesById.values()];
    },
    getAllEdges() {
      return [...edgesById.values()];
    },
  };
}
```

- [ ] **步骤 5: 运行测试确认通过**

运行：`npm test -- test/intelligence/semanticGraph.test.ts`

预期：PASS。

- [ ] **步骤 6: 提交**

```powershell
git add src/extension/intelligence/graph/graphTypes.ts src/extension/intelligence/graph/semanticGraph.ts test/intelligence/semanticGraph.test.ts
git commit -m "feat(intelligence): add semantic graph core"
```

---

### 任务 2: 建立符号搜索索引

**文件：**
- 新建：`src/extension/intelligence/graph/searchIndex.ts`
- 测试：`test/intelligence/searchIndex.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/searchIndex.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createSearchIndex } from "../../src/extension/intelligence/graph/searchIndex";
import type { CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const node: CodeNode = {
  id: "symbol:src/extension/model/providerRegistry.ts:function:createConfiguredAgentRunner:12",
  kind: "function",
  name: "createConfiguredAgentRunner",
  qualifiedName: "src/extension/model/providerRegistry.ts::createConfiguredAgentRunner",
  filePath: "src/extension/model/providerRegistry.ts",
  languageId: "typescript",
  startLine: 12,
  endLine: 30,
};

describe("SearchIndex", () => {
  it("finds symbols by exact name, file path, and name segments", () => {
    const index = createSearchIndex();
    index.addNode(node);

    expect(index.search("createConfiguredAgentRunner")).toEqual([node.id]);
    expect(index.search("configured runner")).toEqual([node.id]);
    expect(index.search("providerRegistry")).toEqual([node.id]);
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/searchIndex.test.ts`

预期：FAIL，错误包含无法解析 `searchIndex`。

- [ ] **步骤 3: 实现搜索索引**

创建 `src/extension/intelligence/graph/searchIndex.ts`：

```ts
import type { CodeNode } from "./graphTypes";

export type SearchIndex = {
  addNode(node: CodeNode): void;
  search(query: string, limit?: number): string[];
};

export function createSearchIndex(): SearchIndex {
  const nodeIdsByToken = new Map<string, Set<string>>();
  const knownNodeIds: string[] = [];

  function addToken(token: string, nodeId: string): void {
    const normalized = normalizeToken(token);
    if (!normalized) {
      return;
    }

    const bucket = nodeIdsByToken.get(normalized) ?? new Set<string>();
    bucket.add(nodeId);
    nodeIdsByToken.set(normalized, bucket);
  }

  return {
    addNode(node) {
      if (!knownNodeIds.includes(node.id)) {
        knownNodeIds.push(node.id);
      }

      addToken(node.name, node.id);
      for (const segment of splitIdentifier(node.name)) {
        addToken(segment, node.id);
      }
      for (const part of node.filePath.split(/[\\/._-]+/)) {
        addToken(part, node.id);
      }
    },
    search(query, limit = 12) {
      const scores = new Map<string, number>();
      const queryTokens = splitQuery(query);

      for (const token of queryTokens) {
        const matches = nodeIdsByToken.get(token);
        if (!matches) {
          continue;
        }

        for (const nodeId of matches) {
          scores.set(nodeId, (scores.get(nodeId) ?? 0) + 1);
        }
      }

      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || knownNodeIds.indexOf(a[0]) - knownNodeIds.indexOf(b[0]))
        .slice(0, limit)
        .map(([nodeId]) => nodeId);
    },
  };
}

function splitQuery(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap(splitIdentifier)
    .map(normalizeToken)
    .filter((token) => token.length >= 2);
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/searchIndex.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/graph/searchIndex.ts test/intelligence/searchIndex.test.ts
git commit -m "feat(intelligence): add symbol search index"
```

---

### 任务 3: 建立语言 adapter 接口和 TS/JS 抽取器

**文件：**
- 新建：`src/extension/intelligence/languages/languageAdapter.ts`
- 新建：`src/extension/intelligence/languages/typescriptAdapter.ts`
- 测试：`test/intelligence/typescriptAdapter.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/typescriptAdapter.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../../src/extension/intelligence/languages/typescriptAdapter";

describe("TypeScript adapter", () => {
  it("extracts imports, exported functions, classes, methods, and call references", () => {
    const adapter = createTypeScriptAdapter();
    const result = adapter.extract({
      filePath: "src/extension/model/providerRegistry.ts",
      languageId: "typescript",
      text: [
        'import { createModelRunner } from "./modelRunner";',
        "export async function createConfiguredAgentRunner() {",
        "  return createModelRunner();",
        "}",
        "class Registry {",
        "  run() {",
        "    createConfiguredAgentRunner();",
        "  }",
        "}",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.importBindings).toContainEqual({
      filePath: "src/extension/model/providerRegistry.ts",
      localName: "createModelRunner",
      importedName: "createModelRunner",
      source: "./modelRunner",
      languageId: "typescript",
    });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "createConfiguredAgentRunner", isExported: true }),
        expect.objectContaining({ kind: "class", name: "Registry" }),
        expect.objectContaining({ kind: "method", name: "run" }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: "calls", referenceName: "createModelRunner" }),
        expect.objectContaining({ referenceKind: "calls", referenceName: "createConfiguredAgentRunner" }),
      ]),
    );
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/typescriptAdapter.test.ts`

预期：FAIL，错误包含无法解析 `typescriptAdapter`。

- [ ] **步骤 3: 实现 adapter 接口**

创建 `src/extension/intelligence/languages/languageAdapter.ts`：

```ts
import type { CodeEdge, CodeNode, ImportBinding, IndexDiagnostic, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";

export type ExtractionResult = {
  nodes: CodeNode[];
  edges: CodeEdge[];
  importBindings: ImportBinding[];
  unresolvedReferences: UnresolvedReference[];
  diagnostics: IndexDiagnostic[];
};

export type LanguageAdapter = {
  id: string;
  languageIds: string[];
  extensions: string[];
  extract(parsed: ParsedSource): ExtractionResult;
};
```

- [ ] **步骤 4: 建立 parser 抽象以满足类型依赖**

创建 `src/extension/intelligence/parser/parserRuntime.ts`：

```ts
import type { IndexDiagnostic } from "../graph/graphTypes";

export type ParsedSource = {
  filePath: string;
  languageId: string;
  text: string;
  tree: unknown;
  diagnostics: IndexDiagnostic[];
};

export type ParserRuntime = {
  parse(filePath: string, languageId: string, text: string): Promise<ParsedSource>;
};
```

- [ ] **步骤 5: 实现 TS/JS 轻量抽取器**

创建 `src/extension/intelligence/languages/typescriptAdapter.ts`：

```ts
import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";

export function createTypeScriptAdapter(): LanguageAdapter {
  return {
    id: "typescript",
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extract(parsed) {
      return extractTypeScriptLike(parsed);
    },
  };
}

function extractTypeScriptLike(parsed: ParsedSource): ExtractionResult {
  const nodes: CodeNode[] = [createFileNode(parsed)];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);
  let currentContainerId = nodes[0]!.id;
  let currentClassId: string | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const importMatch = line.match(/^\s*import\s+\{\s*([^}]+)\s*\}\s+from\s+["']([^"']+)["']/);
    if (importMatch) {
      for (const rawName of importMatch[1]!.split(",")) {
        const importedName = rawName.trim().split(/\s+as\s+/i);
        const localName = importedName[1] ?? importedName[0]!;
        importBindings.push({
          filePath: parsed.filePath,
          localName: localName.trim(),
          importedName: importedName[0]!.trim(),
          source: importMatch[2]!,
          languageId: parsed.languageId,
        });
      }
    }

    const functionMatch = line.match(/^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (functionMatch) {
      const node = createSymbolNode(parsed, "function", functionMatch[2]!, lineNumber, Boolean(functionMatch[1]));
      nodes.push(node);
      edges.push(createEdge(nodes[0]!.id, node.id, "contains", parsed.filePath, lineNumber));
      currentContainerId = node.id;
      return;
    }

    const classMatch = line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const node = createSymbolNode(parsed, "class", classMatch[2]!, lineNumber, Boolean(classMatch[1]));
      nodes.push(node);
      edges.push(createEdge(nodes[0]!.id, node.id, "contains", parsed.filePath, lineNumber));
      currentClassId = node.id;
      currentContainerId = node.id;
      return;
    }

    const methodMatch = line.match(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (methodMatch && currentClassId) {
      const node = createSymbolNode(parsed, "method", methodMatch[1]!, lineNumber, false);
      nodes.push(node);
      edges.push(createEdge(currentClassId, node.id, "contains", parsed.filePath, lineNumber));
      currentContainerId = node.id;
    }

    for (const callMatch of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = callMatch[1]!;
      if (["if", "for", "while", "switch", "function"].includes(name)) {
        continue;
      }
      unresolvedReferences.push({
        fromNodeId: currentContainerId,
        referenceName: name,
        referenceKind: "calls",
        filePath: parsed.filePath,
        line: lineNumber,
        column: callMatch.index,
        languageId: parsed.languageId,
      });
    }
  });

  return { nodes, edges, importBindings, unresolvedReferences, diagnostics: [] };
}

function createFileNode(parsed: ParsedSource): CodeNode {
  return {
    id: `file:${parsed.filePath}`,
    kind: "file",
    name: parsed.filePath.split(/[\\/]/).at(-1) ?? parsed.filePath,
    qualifiedName: parsed.filePath,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: 1,
    endLine: Math.max(1, parsed.text.split(/\r?\n/).length),
  };
}

function createSymbolNode(
  parsed: ParsedSource,
  kind: CodeNode["kind"],
  name: string,
  line: number,
  isExported: boolean,
): CodeNode {
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${line}`,
    kind,
    name,
    qualifiedName: `${parsed.filePath}::${name}`,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: line,
    endLine: line,
    isExported,
  };
}

function createEdge(
  source: string,
  target: string,
  kind: CodeEdge["kind"],
  filePath: string,
  line: number,
): CodeEdge {
  return {
    id: `edge:${source}:${kind}:${target}:${line}`,
    source,
    target,
    kind,
    filePath,
    line,
    confidence: "exact",
  };
}
```

- [ ] **步骤 6: 运行测试确认通过**

运行：`npm test -- test/intelligence/typescriptAdapter.test.ts`

预期：PASS。

- [ ] **步骤 7: 提交**

```powershell
git add src/extension/intelligence/languages/languageAdapter.ts src/extension/intelligence/languages/typescriptAdapter.ts src/extension/intelligence/parser/parserRuntime.ts test/intelligence/typescriptAdapter.test.ts
git commit -m "feat(intelligence): extract typescript symbols"
```

---

### 任务 4: 建立 Python 基础抽取器

**文件：**
- 新建：`src/extension/intelligence/languages/pythonAdapter.ts`
- 测试：`test/intelligence/pythonAdapter.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/pythonAdapter.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "../../src/extension/intelligence/languages/pythonAdapter";

describe("Python adapter", () => {
  it("extracts imports, classes, functions, methods, and calls", () => {
    const adapter = createPythonAdapter();
    const result = adapter.extract({
      filePath: "app/service.py",
      languageId: "python",
      text: [
        "from app.repo import load_user",
        "def build_user():",
        "    return load_user()",
        "class UserService:",
        "    def run(self):",
        "        build_user()",
      ].join("\n"),
      tree: undefined,
      diagnostics: [],
    });

    expect(result.importBindings).toContainEqual({
      filePath: "app/service.py",
      localName: "load_user",
      importedName: "load_user",
      source: "app.repo",
      languageId: "python",
    });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "build_user" }),
        expect.objectContaining({ kind: "class", name: "UserService" }),
        expect.objectContaining({ kind: "method", name: "run" }),
      ]),
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceKind: "calls", referenceName: "load_user" }),
        expect.objectContaining({ referenceKind: "calls", referenceName: "build_user" }),
      ]),
    );
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/pythonAdapter.test.ts`

预期：FAIL，错误包含无法解析 `pythonAdapter`。

- [ ] **步骤 3: 实现 Python adapter**

创建 `src/extension/intelligence/languages/pythonAdapter.ts`：

```ts
import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { ParsedSource } from "../parser/parserRuntime";
import type { ExtractionResult, LanguageAdapter } from "./languageAdapter";

export function createPythonAdapter(): LanguageAdapter {
  return {
    id: "python",
    languageIds: ["python"],
    extensions: [".py"],
    extract(parsed) {
      return extractPython(parsed);
    },
  };
}

function extractPython(parsed: ParsedSource): ExtractionResult {
  const nodes: CodeNode[] = [createFileNode(parsed)];
  const edges: CodeEdge[] = [];
  const importBindings: ImportBinding[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const lines = parsed.text.split(/\r?\n/);
  let currentContainerId = nodes[0]!.id;
  let currentClassId: string | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const fromImport = line.match(/^\s*from\s+([A-Za-z_][\w.]+)\s+import\s+(.+)$/);
    if (fromImport) {
      for (const rawName of fromImport[2]!.split(",")) {
        const name = rawName.trim().split(/\s+as\s+/i);
        importBindings.push({
          filePath: parsed.filePath,
          localName: (name[1] ?? name[0]!).trim(),
          importedName: name[0]!.trim(),
          source: fromImport[1]!,
          languageId: parsed.languageId,
        });
      }
    }

    const classMatch = line.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      const node = createSymbolNode(parsed, "class", classMatch[1]!, lineNumber);
      nodes.push(node);
      edges.push(createEdge(nodes[0]!.id, node.id, "contains", parsed.filePath, lineNumber));
      currentClassId = node.id;
      currentContainerId = node.id;
      return;
    }

    const functionMatch = line.match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      const kind: CodeNode["kind"] = functionMatch[1]!.length > 0 && currentClassId ? "method" : "function";
      const node = createSymbolNode(parsed, kind, functionMatch[2]!, lineNumber);
      nodes.push(node);
      edges.push(createEdge(kind === "method" && currentClassId ? currentClassId : nodes[0]!.id, node.id, "contains", parsed.filePath, lineNumber));
      currentContainerId = node.id;
      return;
    }

    for (const callMatch of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const name = callMatch[1]!;
      if (["if", "for", "while", "return", "def", "class"].includes(name)) {
        continue;
      }
      unresolvedReferences.push({
        fromNodeId: currentContainerId,
        referenceName: name,
        referenceKind: "calls",
        filePath: parsed.filePath,
        line: lineNumber,
        column: callMatch.index,
        languageId: parsed.languageId,
      });
    }
  });

  return { nodes, edges, importBindings, unresolvedReferences, diagnostics: [] };
}

function createFileNode(parsed: ParsedSource): CodeNode {
  return {
    id: `file:${parsed.filePath}`,
    kind: "file",
    name: parsed.filePath.split(/[\\/]/).at(-1) ?? parsed.filePath,
    qualifiedName: parsed.filePath,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: 1,
    endLine: Math.max(1, parsed.text.split(/\r?\n/).length),
  };
}

function createSymbolNode(parsed: ParsedSource, kind: CodeNode["kind"], name: string, line: number): CodeNode {
  return {
    id: `symbol:${parsed.filePath}:${kind}:${name}:${line}`,
    kind,
    name,
    qualifiedName: `${parsed.filePath}::${name}`,
    filePath: parsed.filePath,
    languageId: parsed.languageId,
    startLine: line,
    endLine: line,
  };
}

function createEdge(source: string, target: string, kind: CodeEdge["kind"], filePath: string, line: number): CodeEdge {
  return {
    id: `edge:${source}:${kind}:${target}:${line}`,
    source,
    target,
    kind,
    filePath,
    line,
    confidence: "exact",
  };
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/pythonAdapter.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/languages/pythonAdapter.ts test/intelligence/pythonAdapter.test.ts
git commit -m "feat(intelligence): extract python symbols"
```

---

### 任务 5: 实现引用解析

**文件：**
- 新建：`src/extension/intelligence/resolution/referenceResolver.ts`
- 测试：`test/intelligence/referenceResolver.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/referenceResolver.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";
import { resolveReferences } from "../../src/extension/intelligence/resolution/referenceResolver";
import type { CodeNode, ImportBinding, UnresolvedReference } from "../../src/extension/intelligence/graph/graphTypes";

const caller: CodeNode = {
  id: "symbol:src/a.ts:function:run:1",
  kind: "function",
  name: "run",
  qualifiedName: "src/a.ts::run",
  filePath: "src/a.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
};

const callee: CodeNode = {
  id: "symbol:src/b.ts:function:createModelRunner:1",
  kind: "function",
  name: "createModelRunner",
  qualifiedName: "src/b.ts::createModelRunner",
  filePath: "src/b.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 3,
  isExported: true,
};

describe("resolveReferences", () => {
  it("resolves imported call references into call edges", () => {
    const graph = createSemanticGraph();
    graph.upsertNode(caller);
    graph.upsertNode(callee);

    const refs: UnresolvedReference[] = [{
      fromNodeId: caller.id,
      referenceName: "createModelRunner",
      referenceKind: "calls",
      filePath: "src/a.ts",
      line: 2,
      languageId: "typescript",
    }];
    const imports: ImportBinding[] = [{
      filePath: "src/a.ts",
      localName: "createModelRunner",
      importedName: "createModelRunner",
      source: "./b",
      resolvedFilePath: "src/b.ts",
      languageId: "typescript",
    }];

    const edges = resolveReferences({ graph, references: refs, importBindings: imports });

    expect(edges).toEqual([
      expect.objectContaining({
        source: caller.id,
        target: callee.id,
        kind: "calls",
        confidence: "exact",
      }),
    ]);
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/referenceResolver.test.ts`

预期：FAIL，错误包含无法解析 `referenceResolver`。

- [ ] **步骤 3: 实现引用解析器**

创建 `src/extension/intelligence/resolution/referenceResolver.ts`：

```ts
import type { CodeEdge, CodeNode, ImportBinding, UnresolvedReference } from "../graph/graphTypes";
import type { SemanticGraph } from "../graph/semanticGraph";

export type ResolveReferencesOptions = {
  graph: SemanticGraph;
  references: UnresolvedReference[];
  importBindings: ImportBinding[];
};

export function resolveReferences({ graph, references, importBindings }: ResolveReferencesOptions): CodeEdge[] {
  const resolvedEdges: CodeEdge[] = [];

  for (const reference of references) {
    const target = findTargetNode(graph, reference, importBindings);
    if (!target) {
      continue;
    }

    resolvedEdges.push({
      id: `edge:${reference.fromNodeId}:${reference.referenceKind}:${target.id}:${reference.line}`,
      source: reference.fromNodeId,
      target: target.id,
      kind: reference.referenceKind === "calls" ? "calls" : "references",
      filePath: reference.filePath,
      line: reference.line,
      column: reference.column,
      confidence: "exact",
    });
  }

  return resolvedEdges;
}

function findTargetNode(
  graph: SemanticGraph,
  reference: UnresolvedReference,
  importBindings: ImportBinding[],
): CodeNode | undefined {
  const imported = importBindings.find(
    (binding) => binding.filePath === reference.filePath && binding.localName === reference.referenceName,
  );

  if (imported?.resolvedFilePath) {
    return graph
      .getAllNodes()
      .find((node) => node.filePath === imported.resolvedFilePath && node.name === imported.importedName);
  }

  const sameFile = graph
    .getNodesByName(reference.referenceName)
    .find((node) => node.filePath === reference.filePath);
  if (sameFile) {
    return sameFile;
  }

  const candidates = graph.getNodesByName(reference.referenceName);
  return candidates.length === 1 ? candidates[0] : undefined;
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/referenceResolver.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/resolution/referenceResolver.ts test/intelligence/referenceResolver.test.ts
git commit -m "feat(intelligence): resolve semantic references"
```

---

### 任务 6: 实现图遍历与 `exploreCode` 结果模型

**文件：**
- 新建：`src/extension/intelligence/graph/graphTraverser.ts`
- 新建：`src/extension/intelligence/context/codeIntelligenceContext.ts`
- 测试：`test/intelligence/codeIntelligenceContext.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/codeIntelligenceContext.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createCodeIntelligenceContext } from "../../src/extension/intelligence/context/codeIntelligenceContext";
import { createSemanticGraph } from "../../src/extension/intelligence/graph/semanticGraph";
import { createSearchIndex } from "../../src/extension/intelligence/graph/searchIndex";
import type { CodeEdge, CodeNode } from "../../src/extension/intelligence/graph/graphTypes";

const providerNode: CodeNode = {
  id: "symbol:src/providerRegistry.ts:function:createConfiguredAgentRunner:1",
  kind: "function",
  name: "createConfiguredAgentRunner",
  qualifiedName: "src/providerRegistry.ts::createConfiguredAgentRunner",
  filePath: "src/providerRegistry.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 4,
};

const modelRunnerNode: CodeNode = {
  id: "symbol:src/modelRunner.ts:function:createModelRunner:1",
  kind: "function",
  name: "createModelRunner",
  qualifiedName: "src/modelRunner.ts::createModelRunner",
  filePath: "src/modelRunner.ts",
  languageId: "typescript",
  startLine: 1,
  endLine: 4,
};

const callEdge: CodeEdge = {
  id: "edge:provider:calls:runner:2",
  source: providerNode.id,
  target: modelRunnerNode.id,
  kind: "calls",
  filePath: "src/providerRegistry.ts",
  line: 2,
  confidence: "exact",
};

describe("createCodeIntelligenceContext", () => {
  it("finds entry nodes and expands related call edges", () => {
    const graph = createSemanticGraph();
    const searchIndex = createSearchIndex();
    for (const node of [providerNode, modelRunnerNode]) {
      graph.upsertNode(node);
      searchIndex.addNode(node);
    }
    graph.upsertEdge(callEdge);

    const result = createCodeIntelligenceContext({
      query: "configured runner",
      graph,
      searchIndex,
      sourceProvider: (filePath, startLine, endLine) => `${filePath}:${startLine}-${endLine}`,
    });

    expect(result.entryNodes).toEqual([providerNode]);
    expect(result.relatedNodes).toContainEqual(modelRunnerNode);
    expect(result.edges).toContainEqual(callEdge);
    expect(result.snippets).toContainEqual(
      expect.objectContaining({
        filePath: "src/providerRegistry.ts",
        text: "src/providerRegistry.ts:1-4",
      }),
    );
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/codeIntelligenceContext.test.ts`

预期：FAIL，错误包含无法解析 `codeIntelligenceContext`。

- [ ] **步骤 3: 实现图遍历**

创建 `src/extension/intelligence/graph/graphTraverser.ts`：

```ts
import type { CodeEdge, CodeNode } from "./graphTypes";
import type { SemanticGraph } from "./semanticGraph";

export type ExpandedSubgraph = {
  nodes: CodeNode[];
  edges: CodeEdge[];
};

export function expandFromNodes(graph: SemanticGraph, roots: CodeNode[], depth = 1): ExpandedSubgraph {
  const nodes = new Map<string, CodeNode>();
  const edges = new Map<string, CodeEdge>();
  const queue: Array<{ node: CodeNode; depth: number }> = roots.map((node) => ({ node, depth: 0 }));

  for (const root of roots) {
    nodes.set(root.id, root);
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= depth) {
      continue;
    }

    for (const edge of graph.getOutgoingEdges(item.node.id)) {
      const target = graph.getNode(edge.target);
      if (!target) {
        continue;
      }

      edges.set(edge.id, edge);
      if (!nodes.has(target.id)) {
        nodes.set(target.id, target);
        queue.push({ node: target, depth: item.depth + 1 });
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
```

- [ ] **步骤 4: 实现 context builder**

创建 `src/extension/intelligence/context/codeIntelligenceContext.ts`：

```ts
import type { CodeEdge, CodeNode } from "../graph/graphTypes";
import { expandFromNodes } from "../graph/graphTraverser";
import type { SearchIndex } from "../graph/searchIndex";
import type { SemanticGraph } from "../graph/semanticGraph";

export type CodeIntelligenceSnippet = {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type CodeIntelligenceResult = {
  query: string;
  entryNodes: CodeNode[];
  relatedNodes: CodeNode[];
  edges: CodeEdge[];
  snippets: CodeIntelligenceSnippet[];
  budget: {
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
};

export type CreateCodeIntelligenceContextOptions = {
  query: string;
  graph: SemanticGraph;
  searchIndex: SearchIndex;
  sourceProvider: (filePath: string, startLine: number, endLine: number) => string;
  maxChars?: number;
};

export function createCodeIntelligenceContext({
  query,
  graph,
  searchIndex,
  sourceProvider,
  maxChars = 8_000,
}: CreateCodeIntelligenceContextOptions): CodeIntelligenceResult {
  const entryNodes = searchIndex.search(query, 6).map((nodeId) => graph.getNode(nodeId)).filter((node): node is CodeNode => Boolean(node));
  const expanded = expandFromNodes(graph, entryNodes, 1);
  const relatedNodes = expanded.nodes.filter((node) => !entryNodes.some((entry) => entry.id === node.id));
  let usedChars = 0;
  let truncated = false;
  const snippets: CodeIntelligenceSnippet[] = [];

  for (const node of expanded.nodes) {
    const text = sourceProvider(node.filePath, node.startLine, node.endLine);
    const remaining = Math.max(0, maxChars - usedChars);
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const clipped = text.slice(0, remaining);
    usedChars += clipped.length;
    truncated = truncated || clipped.length < text.length;
    snippets.push({
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      text: clipped,
    });
  }

  return {
    query,
    entryNodes,
    relatedNodes,
    edges: expanded.edges,
    snippets,
    budget: { maxChars, usedChars, truncated },
  };
}
```

- [ ] **步骤 5: 运行测试确认通过**

运行：`npm test -- test/intelligence/codeIntelligenceContext.test.ts`

预期：PASS。

- [ ] **步骤 6: 提交**

```powershell
git add src/extension/intelligence/graph/graphTraverser.ts src/extension/intelligence/context/codeIntelligenceContext.ts test/intelligence/codeIntelligenceContext.test.ts
git commit -m "feat(intelligence): build code exploration context"
```

---

### 任务 7: 实现 prompt 渲染

**文件：**
- 新建：`src/extension/intelligence/context/codeIntelligencePrompt.ts`
- 测试：`test/intelligence/codeIntelligencePrompt.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/codeIntelligencePrompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { renderCodeIntelligencePrompt } from "../../src/extension/intelligence/context/codeIntelligencePrompt";
import type { CodeIntelligenceResult } from "../../src/extension/intelligence/context/codeIntelligenceContext";

describe("renderCodeIntelligencePrompt", () => {
  it("renders entries, relations, snippets, and budget", () => {
    const prompt = renderCodeIntelligencePrompt({
      query: "configured runner",
      entryNodes: [{
        id: "a",
        kind: "function",
        name: "createConfiguredAgentRunner",
        qualifiedName: "providerRegistry::createConfiguredAgentRunner",
        filePath: "src/providerRegistry.ts",
        languageId: "typescript",
        startLine: 1,
        endLine: 4,
      }],
      relatedNodes: [],
      edges: [{
        id: "e",
        source: "a",
        target: "b",
        kind: "calls",
        filePath: "src/providerRegistry.ts",
        line: 2,
        confidence: "exact",
      }],
      snippets: [{
        filePath: "src/providerRegistry.ts",
        startLine: 1,
        endLine: 4,
        text: "export function createConfiguredAgentRunner() {}",
      }],
      budget: { maxChars: 8_000, usedChars: 48, truncated: false },
    } satisfies CodeIntelligenceResult);

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createConfiguredAgentRunner");
    expect(prompt).toContain("calls");
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("是否截断: 否");
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/codeIntelligencePrompt.test.ts`

预期：FAIL，错误包含无法解析 `codeIntelligencePrompt`。

- [ ] **步骤 3: 实现 prompt 渲染**

创建 `src/extension/intelligence/context/codeIntelligencePrompt.ts`：

```ts
import type { CodeIntelligenceResult } from "./codeIntelligenceContext";

export function renderCodeIntelligencePrompt(result: CodeIntelligenceResult): string {
  if (result.entryNodes.length === 0 && result.snippets.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## 代码语义索引上下文",
    "",
    `查询: ${result.query}`,
    "",
    "### 入口符号",
  ];

  for (const node of result.entryNodes) {
    lines.push(`- ${node.kind} ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
  }

  if (result.relatedNodes.length > 0) {
    lines.push("", "### 相关符号");
    for (const node of result.relatedNodes) {
      lines.push(`- ${node.kind} ${node.qualifiedName} (${node.filePath}:${node.startLine}-${node.endLine})`);
    }
  }

  if (result.edges.length > 0) {
    lines.push("", "### 关系");
    for (const edge of result.edges) {
      lines.push(`- ${edge.source} --${edge.kind}/${edge.confidence}--> ${edge.target}${edge.line ? ` @${edge.filePath}:${edge.line}` : ""}`);
    }
  }

  if (result.snippets.length > 0) {
    lines.push("", "### 源码片段");
    for (const snippet of result.snippets) {
      lines.push(`#### ${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`);
      lines.push(`\`\`\`${languageFromPath(snippet.filePath)}`);
      lines.push(snippet.text.replace(/```/g, "``\\`"));
      lines.push("```");
    }
  }

  lines.push("", "### 语义索引预算");
  lines.push(`- 使用字符: ${result.budget.usedChars}/${result.budget.maxChars}`);
  lines.push(`- 是否截断: ${result.budget.truncated ? "是" : "否"}`);

  return lines.join("\n").trim();
}

function languageFromPath(filePath: string): string {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".ts")) return "typescript";
  if (filePath.endsWith(".jsx") || filePath.endsWith(".js")) return "javascript";
  return "text";
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/codeIntelligencePrompt.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/context/codeIntelligencePrompt.ts test/intelligence/codeIntelligencePrompt.test.ts
git commit -m "feat(intelligence): render code intelligence prompt"
```

---

### 任务 8: 实现 workspace intelligence 编排

**文件：**
- 新建：`src/extension/intelligence/workspaceIntelligence.ts`
- 测试：`test/intelligence/workspaceIntelligence.test.ts`

- [ ] **步骤 1: 写失败测试**

创建 `test/intelligence/workspaceIntelligence.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createWorkspaceIntelligence } from "../../src/extension/intelligence/workspaceIntelligence";

describe("createWorkspaceIntelligence", () => {
  it("indexes source files and returns a code intelligence prompt", async () => {
    const intelligence = createWorkspaceIntelligence({
      readWorkspaceFiles: async () => [
        {
          path: "src/providerRegistry.ts",
          languageId: "typescript",
          text: [
            'import { createModelRunner } from "./modelRunner";',
            "export function createConfiguredAgentRunner() {",
            "  return createModelRunner();",
            "}",
          ].join("\n"),
        },
        {
          path: "src/modelRunner.ts",
          languageId: "typescript",
          text: "export function createModelRunner() { return {}; }",
        },
      ],
      readSourceRange: (filePath, startLine, endLine) => `${filePath}:${startLine}-${endLine}`,
    });

    const prompt = await intelligence.buildCodeIntelligencePrompt("configured runner");

    expect(prompt).toContain("代码语义索引上下文");
    expect(prompt).toContain("createConfiguredAgentRunner");
    expect(prompt).toContain("src/providerRegistry.ts");
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/workspaceIntelligence.test.ts`

预期：FAIL，错误包含无法解析 `workspaceIntelligence`。

- [ ] **步骤 3: 实现 workspace intelligence**

创建 `src/extension/intelligence/workspaceIntelligence.ts`：

```ts
import { renderCodeIntelligencePrompt } from "./context/codeIntelligencePrompt";
import { createCodeIntelligenceContext } from "./context/codeIntelligenceContext";
import { createSemanticGraph } from "./graph/semanticGraph";
import { createSearchIndex } from "./graph/searchIndex";
import type { ImportBinding, UnresolvedReference } from "./graph/graphTypes";
import { createTypeScriptAdapter } from "./languages/typescriptAdapter";
import { createPythonAdapter } from "./languages/pythonAdapter";
import { resolveReferences } from "./resolution/referenceResolver";

export type WorkspaceSourceFile = {
  path: string;
  languageId: string;
  text: string;
};

export type WorkspaceIntelligenceDeps = {
  readWorkspaceFiles(): Promise<WorkspaceSourceFile[]>;
  readSourceRange(filePath: string, startLine: number, endLine: number): string;
};

export type WorkspaceIntelligence = {
  buildCodeIntelligencePrompt(query: string): Promise<string>;
};

export function createWorkspaceIntelligence(deps: WorkspaceIntelligenceDeps): WorkspaceIntelligence {
  const adapters = [createTypeScriptAdapter(), createPythonAdapter()];

  return {
    async buildCodeIntelligencePrompt(query) {
      const graph = createSemanticGraph();
      const searchIndex = createSearchIndex();
      const importBindings: ImportBinding[] = [];
      const unresolvedReferences: UnresolvedReference[] = [];
      const files = await deps.readWorkspaceFiles();

      for (const file of files) {
        const adapter = adapters.find((candidate) => candidate.languageIds.includes(file.languageId));
        if (!adapter) {
          continue;
        }

        const result = adapter.extract({
          filePath: file.path,
          languageId: file.languageId,
          text: file.text,
          tree: undefined,
          diagnostics: [],
        });

        for (const node of result.nodes) {
          graph.upsertNode(node);
          searchIndex.addNode(node);
        }
        for (const edge of result.edges) {
          graph.upsertEdge(edge);
        }
        importBindings.push(...result.importBindings);
        unresolvedReferences.push(...result.unresolvedReferences);
      }

      for (const edge of resolveReferences({ graph, references: unresolvedReferences, importBindings })) {
        graph.upsertEdge(edge);
      }

      const result = createCodeIntelligenceContext({
        query,
        graph,
        searchIndex,
        sourceProvider: deps.readSourceRange,
      });

      return renderCodeIntelligencePrompt(result);
    },
  };
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/workspaceIntelligence.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/workspaceIntelligence.ts test/intelligence/workspaceIntelligence.test.ts
git commit -m "feat(intelligence): orchestrate workspace code intelligence"
```

---

### 任务 9: 接入模型运行链路

**文件：**
- 修改：`src/extension/model/modelRunner.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 测试：`test/modelRunnerContext.test.ts`
- 测试：`test/modelProvider.test.ts`

- [ ] **步骤 1: 写失败测试**

修改 `test/modelRunnerContext.test.ts` 中 “adds a dynamic runtime context system message for each run” 的 runner 创建代码：

```ts
const runner = createModelRunner({
  provider,
  systemPrompt: "Base system prompt.",
  systemPromptProvider: async ({ task }) => `Runtime context for: ${task}`,
});
```

并把期望里的 runtime context 改成：

```ts
{ role: "system", content: "Runtime context for: Inspect workspace" },
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/modelRunnerContext.test.ts`

预期：FAIL，错误显示 `systemPromptProvider` 签名不匹配或没有传入 request。

- [ ] **步骤 3: 修改 modelRunner 签名**

修改 `src/extension/model/modelRunner.ts`：

```ts
export type CreateModelRunnerOptions = {
  provider: ModelProvider;
  systemPrompt?: string;
  systemPromptProvider?: (request: AgentRunRequest) => string | Promise<string>;
};
```

并将：

```ts
systemPrompts.push(await systemPromptProvider());
```

改成：

```ts
systemPrompts.push(await systemPromptProvider({ runId, task, signal }));
```

- [ ] **步骤 4: 修改 providerRegistry 组合 prompt**

修改 `src/extension/model/providerRegistry.ts`，保留现有 VS Code runtime context，并预留 code intelligence：

```ts
systemPromptProvider: async (request) => {
  const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
  return runtimePrompt;
},
```

本任务先只改签名，不接真实 workspace intelligence，避免 VS Code API 文件扫描和单元测试一次性扩大。

- [ ] **步骤 5: 运行相关测试**

运行：`npm test -- test/modelRunnerContext.test.ts test/modelProvider.test.ts`

预期：PASS。

- [ ] **步骤 6: 提交**

```powershell
git add src/extension/model/modelRunner.ts src/extension/model/providerRegistry.ts test/modelRunnerContext.test.ts test/modelProvider.test.ts
git commit -m "feat(model): pass run request to system prompt provider"
```

---

### 任务 10: 预留 code intelligence prompt 注入点

**文件：**
- 修改：`src/extension/intelligence/workspaceIntelligence.ts`
- 修改：`src/extension/model/providerRegistry.ts`
- 测试：`test/modelRunnerContext.test.ts`

- [ ] **步骤 1: 扩展 workspaceIntelligence 导出默认创建函数**

在 `src/extension/intelligence/workspaceIntelligence.ts` 追加：

```ts
export function createEmptyWorkspaceIntelligence(): WorkspaceIntelligence {
  return {
    async buildCodeIntelligencePrompt() {
      return "";
    },
  };
}
```

此步骤先提供可注入空实现，便于测试 provider 组合行为。

- [ ] **步骤 2: 修改 providerRegistry 使用空语义索引实现**

修改 `src/extension/model/providerRegistry.ts`：

```ts
import { createEmptyWorkspaceIntelligence } from "../intelligence/workspaceIntelligence";
```

在 `createConfiguredAgentRunner` 内创建：

```ts
const workspaceIntelligence = createEmptyWorkspaceIntelligence();
```

然后改为：

```ts
systemPromptProvider: async (request) => {
  const runtimePrompt = renderCodeRuntimeContextPrompt(await collectVsCodeRuntimeContext());
  const codePrompt = await workspaceIntelligence.buildCodeIntelligencePrompt(request.task);
  return [runtimePrompt, codePrompt].filter((part) => part.trim().length > 0).join("\n\n");
},
```

- [ ] **步骤 3: 运行测试**

运行：`npm test -- test/modelRunnerContext.test.ts test/modelProvider.test.ts`

预期：PASS。

- [ ] **步骤 4: 提交**

```powershell
git add src/extension/intelligence/workspaceIntelligence.ts src/extension/model/providerRegistry.ts
git commit -m "feat(model): prepare code intelligence prompt injection"
```

---

### 任务 11: 增加 VS Code workspace 路径过滤基础

**文件：**
- 新建：`src/extension/intelligence/vscodeWorkspaceIntelligence.ts`
- 测试：`test/intelligence/vscodeWorkspaceIntelligence.test.ts`

- [ ] **步骤 1: 写纯函数测试**

创建 `test/intelligence/vscodeWorkspaceIntelligence.test.ts`，先测试路径过滤函数，不直接 mock VS Code：

```ts
import { describe, expect, it } from "vitest";

import { isIndexableWorkspacePath } from "../../src/extension/intelligence/vscodeWorkspaceIntelligence";

describe("isIndexableWorkspacePath", () => {
  it("excludes generated, dependency, local debug, and sensitive paths", () => {
    expect(isIndexableWorkspacePath("src/extension.ts")).toBe(true);
    expect(isIndexableWorkspacePath("node_modules/react/index.js")).toBe(false);
    expect(isIndexableWorkspacePath("dist/extension.js")).toBe(false);
    expect(isIndexableWorkspacePath(".git/config")).toBe(false);
    expect(isIndexableWorkspacePath(".local-vscode-user-data/User/settings.json")).toBe(false);
    expect(isIndexableWorkspacePath(".env")).toBe(false);
    expect(isIndexableWorkspacePath("secrets/api-token.txt")).toBe(false);
  });
});
```

- [ ] **步骤 2: 运行测试确认失败**

运行：`npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts`

预期：FAIL，错误包含无法解析 `vscodeWorkspaceIntelligence`。

- [ ] **步骤 3: 实现 VS Code adapter 基础过滤**

创建 `src/extension/intelligence/vscodeWorkspaceIntelligence.ts`：

```ts
export function isIndexableWorkspacePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.at(-1) ?? "";

  if (parts.some((part) => part === ".git" || part === "node_modules" || part === "dist" || part.startsWith(".local-vscode-"))) {
    return false;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return false;
  }

  return !/(^|[._-])(secret|secrets|token|tokens|api[_-]?key|apikey|key)([._-]|$)/i.test(fileName);
}
```

- [ ] **步骤 4: 运行测试确认通过**

运行：`npm test -- test/intelligence/vscodeWorkspaceIntelligence.test.ts`

预期：PASS。

- [ ] **步骤 5: 提交**

```powershell
git add src/extension/intelligence/vscodeWorkspaceIntelligence.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts
git commit -m "feat(intelligence): add workspace indexing path filter"
```

---

### 任务 12: 全量验证和文档更新

**文件：**
- 修改：`docs/superpowers/specs/2026-07-08-multilang-code-intelligence-design.md`
- 新建：`docs/superpowers/plans/2026-07-08-multilang-code-intelligence-verification.md`

- [ ] **步骤 1: 运行单元测试**

运行：`npm test`

预期：PASS，所有 Vitest 测试通过。

- [ ] **步骤 2: 运行类型检查**

运行：`npm run typecheck`

预期：PASS，无 TypeScript 错误。

- [ ] **步骤 3: 运行编译**

运行：`npm run compile`

预期：PASS，生成 `dist/extension.js` 和 `dist/webview.js`。

- [ ] **步骤 4: 写验证记录**

创建 `docs/superpowers/plans/2026-07-08-multilang-code-intelligence-verification.md`：

```md
# 多语言代码智能索引验证记录

## 验证范围

- 内存语义图
- 符号搜索索引
- TS/JS 基础抽取
- Python 基础抽取
- 引用解析
- `exploreCode` 上下文构建
- prompt 渲染
- 模型 prompt provider 签名变更

## 验证命令

```powershell
npm test
npm run typecheck
npm run compile
```

## 结果

- `npm test`：通过
- `npm run typecheck`：通过
- `npm run compile`：通过

## 已知限制

- 当前 adapter 只覆盖基础语法形态。
- Tree-sitter runtime 和 grammar wasm 打包仍需在下一轮实施。
- VS Code workspace 文件读取只先落路径过滤，真实文件扫描需要单独任务接入。
- 语义图仍为内存索引，尚未持久化。
```

- [ ] **步骤 5: 更新设计文档实施状态**

在 `docs/superpowers/specs/2026-07-08-multilang-code-intelligence-design.md` 末尾追加：

```md
## 实施记录

第一轮实施完成内存语义图、基础搜索、TS/JS 与 Python 基础抽取、引用解析、上下文渲染，以及模型 prompt provider 签名调整。Tree-sitter runtime、真实 VS Code workspace 文件扫描、SQLite 持久化和更多语言 adapter 保留为后续工作。
```

- [ ] **步骤 6: 提交验证文档**

```powershell
git add docs/superpowers/specs/2026-07-08-multilang-code-intelligence-design.md docs/superpowers/plans/2026-07-08-multilang-code-intelligence-verification.md
git commit -m "docs: record code intelligence verification"
```

---

## 自检结果

- 设计覆盖：计划覆盖了统一图模型、内存存储、搜索索引、TS/JS adapter、Python adapter、引用解析、图查询、prompt 渲染、模型接入、路径安全过滤和验证记录。
- 有意延后：框架专用补边、Tree-sitter runtime 真实接入、grammar wasm 打包、真实 VS Code workspace 文件扫描、Go/Java/Rust adapter、SQLite 持久化和 agent tool calling 不进入第一轮实现，避免单次变更过大。
- 类型一致性：计划统一使用 `CodeNode`、`CodeEdge`、`UnresolvedReference`、`ImportBinding`、`SemanticGraph`、`SearchIndex`、`WorkspaceIntelligence` 命名。
- 占位扫描：计划不包含待补内容；所有任务都有明确文件、测试、实现片段和验证命令。


