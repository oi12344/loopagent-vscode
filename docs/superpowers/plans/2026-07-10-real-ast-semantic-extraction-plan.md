# 真实 AST 语义抽取实施计划

> **面向智能体执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。所有执行步骤使用复选框跟踪。

**目标：** 将 TypeScript 系与 Python 的正常索引路径从逐行正则升级为真实 Tree-sitter AST 抽取，并修复资源生命周期、模块路径解析、调用边置信度和重复诊断问题。

**架构：** `TreeSitterParserRuntime` 返回受约束的 `SyntaxTree`，语言 adapter 在 Tree 可用时调用各自 AST extractor，无 Tree 时保留现有 fallback。AST extractor 统一输出 `CodeNode`、`ImportBinding` 和带 callee 形态的 `UnresolvedReference`，模块解析器补全工作区文件路径，引用解析器只为可证明的关系建立高置信度边。

**技术栈：** TypeScript 5.7、`web-tree-sitter` 0.26、`@vscode/tree-sitter-wasm`、Vitest 4、esbuild、VS Code Extension Host。

**设计规格：** `docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md`

---

## 文件边界

### 新增文件

- `src/extension/intelligence/languages/treeSitterAst.ts`：与语言无关的 AST 遍历、字段读取、范围转换和字符串值处理。
- `src/extension/intelligence/languages/typescriptAstExtractor.ts`：TypeScript、TSX、JavaScript、JSX 的 AST 语义抽取。
- `src/extension/intelligence/languages/pythonAstExtractor.ts`：Python 的 AST 语义抽取。
- `src/extension/intelligence/resolution/modulePathResolver.ts`：工作区内 TypeScript 系与 Python 模块路径解析。
- `test/intelligence/treeSitterAst.test.ts`：共享 AST 工具单元测试。
- `test/intelligence/treeSitterRuntimeLifecycle.test.ts`：Parser 生命周期隔离测试。
- `test/intelligence/modulePathResolver.test.ts`：模块路径解析测试。

### 修改文件

- `src/extension/intelligence/parser/parserRuntime.ts`：定义 `SyntaxNode`、`SyntaxTree` 和受约束的 `ParsedSource.tree`。
- `src/extension/intelligence/parser/treeSitterRuntime.ts`：处理空 Tree，并在所有路径释放 `Parser`。
- `src/extension/intelligence/graph/graphTypes.ts`：为未解析调用增加 callee 形态和置信度提示，允许 `instantiates`。
- `src/extension/intelligence/languages/typescriptAdapter.ts`：选择 AST 主路径或现有 fallback。
- `src/extension/intelligence/languages/pythonAdapter.ts`：选择 AST 主路径或现有 fallback。
- `src/extension/intelligence/resolution/referenceResolver.ts`：按调用形态与解析证据设置边置信度。
- `src/extension/intelligence/workspaceIntelligence.ts`：释放 Tree、解析模块路径并只合并一次诊断。
- `test/intelligence/typescriptAdapter.test.ts`：增加真实 grammar 的 TypeScript AST 行为测试。
- `test/intelligence/pythonAdapter.test.ts`：增加真实 grammar 的 Python AST 行为测试。
- `test/intelligence/referenceResolver.test.ts`：增加成员调用防误连和置信度测试。
- `test/intelligence/workspaceIntelligence.test.ts`：增加 Tree 释放、模块解析和诊断去重测试。
- `test/intelligence/codeIntelligencePrompt.test.ts`：补齐当前缺失的预算 profile 测试夹具，恢复全量测试基线。
- `docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md`：关联真实 AST 后续规格和最终验证状态。
- `docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md`：记录实现结果与剩余限制。

## Task 1：恢复当前测试基线

**文件：**

- 修改：`test/intelligence/codeIntelligencePrompt.test.ts:6`
- 验证：`src/extension/intelligence/context/codeIntelligencePrompt.ts:43`

- [x] **Step 1：复现当前全量测试失败**

运行：

```powershell
npm test -- test/intelligence/codeIntelligencePrompt.test.ts
```

预期：两个测试在 `result.profile.mode` 处失败，错误包含 `Cannot read properties of undefined`。

- [x] **Step 2：补齐测试夹具中的真实预算 profile**

在 `baseResult` 的 `query` 后增加完整字段：

```ts
profile: {
  mode: "focused-source",
  reason: "test-fixture",
  maxEntryNodes: 5,
  expandDepth: 2,
  maxRelatedNodes: 14,
  maxEdges: 28,
  maxSnippetNodes: 5,
  maxSnippetChars: 6_000,
  maxSnippetLines: 90,
},
```

- [x] **Step 3：验证提示词测试与全量基线**

运行：

```powershell
npm test -- test/intelligence/codeIntelligencePrompt.test.ts
npm test
```

预期：提示词文件 3 个测试通过；全量测试无失败。

- [x] **Step 4：提交测试基线修复**

```powershell
git add test/intelligence/codeIntelligencePrompt.test.ts
git commit -m "test: restore code intelligence prompt baseline"
```

## Task 2：收紧语法树类型并管理资源生命周期

**文件：**

- 修改：`src/extension/intelligence/parser/parserRuntime.ts`
- 修改：`src/extension/intelligence/parser/treeSitterRuntime.ts`
- 修改：`src/extension/intelligence/graph/graphTypes.ts`
- 修改：`src/extension/intelligence/workspaceIntelligence.ts`
- 新增：`test/intelligence/treeSitterRuntimeLifecycle.test.ts`
- 修改：`test/intelligence/workspaceIntelligence.test.ts`

- [x] **Step 1：为 Parser 和 Tree 释放编写失败测试**

在 `treeSitterRuntimeLifecycle.test.ts` 使用 `vi.hoisted` 和 `vi.mock("web-tree-sitter")` 构造可观察对象：

```ts
import type { SyntaxNode } from "../../src/extension/intelligence/parser/parserRuntime";

function createSyntaxNode(type: string): SyntaxNode {
  return {
    type,
    text: "",
    isNamed: true,
    hasError: false,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    namedChildren: [],
    childForFieldName: () => null,
  };
}

const mocks = vi.hoisted(() => ({
  parserDelete: vi.fn(),
  treeDelete: vi.fn(),
}));

vi.mock("web-tree-sitter", () => ({
  Language: { load: vi.fn(async () => ({})) },
  Parser: class FakeParser {
    static init = vi.fn(async () => undefined);
    setLanguage(): void {}
    parse() {
      return {
        rootNode: createSyntaxNode("program"),
        delete: mocks.treeDelete,
      };
    }
    delete = mocks.parserDelete;
  },
}));

it("releases the parser after returning ownership of the tree", async () => {
  const runtime = createTreeSitterParserRuntime({
    parserWasmPath: "parser.wasm",
    grammarWasmDirectory: "grammars",
  });

  const parsed = await runtime.parse("src/a.ts", "typescript", "function run() {} ");

  expect(parsed.tree).toBeDefined();
  expect(mocks.parserDelete).toHaveBeenCalledOnce();
  expect(mocks.treeDelete).not.toHaveBeenCalled();
});
```

在 `workspaceIntelligence.test.ts` 增加 Tree 所有权测试：

```ts
function createSyntaxNode(type: string): SyntaxNode {
  return {
    type,
    text: "",
    isNamed: true,
    hasError: false,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    namedChildren: [],
    childForFieldName: () => null,
  };
}

it("releases a parsed tree after extraction", async () => {
  const deleteTree = vi.fn();
  const intelligence = createWorkspaceIntelligence({
    readWorkspaceFiles: async () => [
      { path: "src/a.ts", languageId: "typescript", text: "function run() {}" },
    ],
    readSourceRange: () => "",
    parserRuntime: {
      parse: async (filePath, languageId, text) => ({
        filePath,
        languageId,
        text,
        tree: { rootNode: createSyntaxNode("program"), delete: deleteTree },
        diagnostics: [],
      }),
    },
  });

  await intelligence.buildCodeIntelligencePrompt("run");

  expect(deleteTree).toHaveBeenCalledOnce();
});
```

- [x] **Step 2：运行生命周期测试并确认红灯**

运行：

```powershell
npm test -- test/intelligence/treeSitterRuntimeLifecycle.test.ts test/intelligence/workspaceIntelligence.test.ts
```

预期：Parser 和 Tree 的 `delete()` 断言失败，因为当前生产代码没有释放资源。

- [x] **Step 3：定义最小语法树接口和调用元数据**

在 `parserRuntime.ts` 定义：

```ts
export type SyntaxPoint = {
  row: number;
  column: number;
};

export type SyntaxNode = {
  type: string;
  text: string;
  isNamed: boolean;
  hasError: boolean;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  namedChildren: readonly SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
};

export type SyntaxTree = {
  rootNode: SyntaxNode;
  delete(): void;
};

export type ParsedSource = {
  filePath: string;
  languageId: string;
  text: string;
  tree: SyntaxTree | undefined;
  diagnostics: IndexDiagnostic[];
};
```

在 `graphTypes.ts` 扩展未解析引用：

```ts
export type CallCalleeKind = "identifier" | "member" | "dynamic";

export type UnresolvedReference = {
  fromNodeId: string;
  referenceName: string;
  referenceKind: "calls" | "references" | "type_of" | "extends" | "implements" | "instantiates";
  filePath: string;
  line: number;
  column?: number;
  localScope?: string;
  importSource?: string;
  languageId: string;
  calleeKind?: CallCalleeKind;
  receiverName?: string;
  confidenceHint?: CodeEdge["confidence"];
  metadata?: Record<string, unknown>;
};
```

- [x] **Step 4：在正确边界释放 Parser 和 Tree**

`treeSitterRuntime.ts` 使用 `try/finally`：

```ts
let parser: Parser | undefined;
try {
  await initializeParser(parserWasmPath);
  const language = await loadLanguage(normalizedLanguageId);
  parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  if (!tree) {
    return createParsedSource(filePath, languageId, text, undefined, [
      createWarning(filePath, "Tree-sitter 未返回语法树，已降级为轻量抽取。"),
    ]);
  }
  return createParsedSource(filePath, languageId, text, tree, []);
} catch (error) {
  return createParsedSource(filePath, languageId, text, undefined, [
    createWarning(
      filePath,
      `Tree-sitter 解析失败，已降级为轻量抽取：${error instanceof Error ? error.message : String(error)}`,
    ),
  ]);
} finally {
  parser?.delete();
}
```

`workspaceIntelligence.ts` 在 adapter 返回后释放 Tree：

```ts
let extracted: ExtractionResult;
try {
  extracted = adapter.extract(parsed);
} finally {
  parsed.tree?.delete();
}
```

- [x] **Step 5：运行生命周期和现有 parser 测试**

运行：

```powershell
npm test -- test/intelligence/treeSitterRuntimeLifecycle.test.ts test/intelligence/treeSitterRuntime.test.ts test/intelligence/workspaceIntelligence.test.ts
npm run typecheck
```

预期：全部通过；Parser 由 runtime 释放，Tree 由 workspace 释放。

- [x] **Step 6：提交生命周期变更**

```powershell
git add src/extension/intelligence/parser/parserRuntime.ts src/extension/intelligence/parser/treeSitterRuntime.ts src/extension/intelligence/graph/graphTypes.ts src/extension/intelligence/workspaceIntelligence.ts test/intelligence/treeSitterRuntimeLifecycle.test.ts test/intelligence/workspaceIntelligence.test.ts
git commit -m "fix(intelligence): manage tree-sitter resource lifecycles"
```

## Task 3：实现共享 AST 工具

**文件：**

- 新增：`src/extension/intelligence/languages/treeSitterAst.ts`
- 新增：`test/intelligence/treeSitterAst.test.ts`

- [x] **Step 1：编写遍历、字段和范围的失败测试**

测试使用纯对象，不加载 grammar：

```ts
type SyntaxNodeOptions = {
  text?: string;
  hasError?: boolean;
  startPosition?: { row: number; column: number };
  endPosition?: { row: number; column: number };
  fields?: Record<string, SyntaxNode>;
};

function createSyntaxNode(
  type: string,
  namedChildren: readonly SyntaxNode[] = [],
  options: SyntaxNodeOptions = {},
): SyntaxNode {
  const fields = options.fields ?? {};
  return {
    type,
    text: options.text ?? "",
    isNamed: true,
    hasError: options.hasError ?? false,
    startPosition: options.startPosition ?? { row: 0, column: 0 },
    endPosition: options.endPosition ?? { row: 0, column: 0 },
    namedChildren,
    childForFieldName: (name) => fields[name] ?? null,
  };
}

it("visits named nodes with their ancestor chain", () => {
  const method = createSyntaxNode("method_definition");
  const classBody = createSyntaxNode("class_body", [method]);
  const root = createSyntaxNode("program", [classBody]);
  const visited: string[] = [];

  visitNamedNodes(root, (node, ancestors) => {
    visited.push(`${ancestors.map((ancestor) => ancestor.type).join("/")}->${node.type}`);
  });

  expect(visited).toContain("program/class_body->method_definition");
});

it("converts zero-based syntax positions into code ranges", () => {
  const node = createSyntaxNode("function_declaration", [], {
    startPosition: { row: 2, column: 4 },
    endPosition: { row: 7, column: 1 },
  });

  expect(toCodeRange(node)).toEqual({
    startLine: 3,
    endLine: 8,
    startColumn: 4,
    endColumn: 1,
  });
});
```

- [x] **Step 2：运行测试并确认模块缺失红灯**

运行：

```powershell
npm test -- test/intelligence/treeSitterAst.test.ts
```

预期：测试因 `treeSitterAst.ts` 或导出函数不存在而失败。

- [x] **Step 3：实现完整公共工具 API**

`treeSitterAst.ts` 提供：

```ts
import type { SyntaxNode } from "../parser/parserRuntime";

export type SyntaxVisitor = (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => void;

export function visitNamedNodes(
  node: SyntaxNode,
  visitor: SyntaxVisitor,
  ancestors: readonly SyntaxNode[] = [],
): void {
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const child of node.namedChildren) {
    visitNamedNodes(child, visitor, nextAncestors);
  }
}

export function toCodeRange(node: SyntaxNode) {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

export function getField(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return node.childForFieldName(name) ?? undefined;
}

export function getNearestAncestor(
  ancestors: readonly SyntaxNode[],
  predicate: (node: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  return [...ancestors].reverse().find(predicate);
}

export function readStringLiteral(node: SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  const value = node.text.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
```

- [x] **Step 4：验证公共工具**

运行：

```powershell
npm test -- test/intelligence/treeSitterAst.test.ts
npm run typecheck
```

预期：公共工具测试和类型检查通过。

- [x] **Step 5：提交公共工具**

```powershell
git add src/extension/intelligence/languages/treeSitterAst.ts test/intelligence/treeSitterAst.test.ts
git commit -m "feat(intelligence): add shared tree-sitter AST helpers"
```

## Task 4：实现 TypeScript 系 AST 主路径

**文件：**

- 新增：`src/extension/intelligence/languages/typescriptAstExtractor.ts`
- 修改：`src/extension/intelligence/languages/typescriptAdapter.ts`
- 修改：`test/intelligence/typescriptAdapter.test.ts`

- [x] **Step 1：增加真实 grammar 的符号和范围失败测试**

在测试文件建立一次 runtime，并确保测试释放 Tree：

```ts
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

async function extractWithTree(text: string, languageId = "typescript") {
  const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
  const parsed = await runtime.parse("src/sample.ts", languageId, text);
  try {
    return createTypeScriptAdapter().extract(parsed);
  } finally {
    parsed.tree?.delete();
  }
}

it("extracts AST-backed declarations and exact ranges", async () => {
  const result = await extractWithTree([
    'export const run = async () => { const marker = "}"; helper(); };',
    "export class Service { constructor() {} start() { this.run(); } }",
    "export interface Config { name: string }",
    'export type Mode = "fast" | "safe";',
    "export enum State { Ready }",
  ].join("\n"));

  expect(result.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "function", name: "run", startLine: 1, endLine: 1, isExported: true }),
    expect.objectContaining({ kind: "class", name: "Service" }),
    expect.objectContaining({ kind: "constructor", name: "constructor" }),
    expect.objectContaining({ kind: "method", name: "start", qualifiedName: "src/sample.ts::Service.start" }),
    expect.objectContaining({ kind: "interface", name: "Config" }),
    expect.objectContaining({ kind: "type", name: "Mode" }),
    expect.objectContaining({ kind: "enum", name: "State" }),
  ]));
});
```

- [x] **Step 2：增加导入和 callee 形态失败测试**

```ts
it("extracts multiline imports and preserves callee shape", async () => {
  const result = await extractWithTree([
    "import DefaultRunner, {",
    "  createRunner as makeRunner,",
    '} from "./runner";',
    'import * as api from "./api";',
    "function run() { makeRunner(); api.send(); new DefaultRunner(); }",
  ].join("\n"));

  expect(result.importBindings).toEqual(expect.arrayContaining([
    expect.objectContaining({ localName: "DefaultRunner", importedName: "default", source: "./runner", isDefault: true }),
    expect.objectContaining({ localName: "makeRunner", importedName: "createRunner", source: "./runner" }),
    expect.objectContaining({ localName: "api", importedName: "*", source: "./api", isNamespace: true }),
  ]));
  expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
    expect.objectContaining({ referenceName: "makeRunner", calleeKind: "identifier", referenceKind: "calls" }),
    expect.objectContaining({ referenceName: "send", receiverName: "api", calleeKind: "member" }),
    expect.objectContaining({ referenceName: "DefaultRunner", calleeKind: "identifier", referenceKind: "instantiates" }),
  ]));
});
```

- [x] **Step 3：运行 TypeScript 测试并确认红灯**

运行：

```powershell
npm test -- test/intelligence/typescriptAdapter.test.ts
```

预期：箭头函数、constructor、interface、type、enum、多行导入和 callee 元数据断言失败。

- [x] **Step 4：实现 TypeScript AST extractor**

`typescriptAstExtractor.ts` 使用一次 `visitNamedNodes` 遍历，并维护 `Map<SyntaxNode, CodeNode>`。节点分派必须覆盖：

```ts
switch (node.type) {
  case "function_declaration":
  case "generator_function_declaration":
    addNamedFunction(node, ancestors);
    break;
  case "arrow_function":
  case "function_expression":
    addVariableFunction(node, ancestors);
    break;
  case "class_declaration":
    addDeclaration(node, "class", ancestors);
    break;
  case "method_definition":
    addMethod(node, ancestors);
    break;
  case "interface_declaration":
    addDeclaration(node, "interface", ancestors);
    break;
  case "type_alias_declaration":
    addDeclaration(node, "type", ancestors);
    break;
  case "enum_declaration":
    addDeclaration(node, "enum", ancestors);
    break;
  case "import_statement":
    addImportBindings(node);
    break;
  case "call_expression":
    addCallReference(node, ancestors);
    break;
  case "new_expression":
    addInstantiationReference(node, ancestors);
    break;
}
```

所有 `CodeNode` 必须使用 `toCodeRange(node)`；`method_definition` 从最近类节点生成 `Class.method` qualified name；调用 owner 从最近已映射的 function/method AST 节点获得。`member_expression` 只记录成员元数据，不转换成裸 identifier。

- [x] **Step 5：将 adapter 切换为 AST 主路径和 fallback**

保留现有正则函数并重命名：

```ts
export function createTypeScriptAdapter(): LanguageAdapter {
  return {
    id: "typescript",
    languageIds: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extract(parsed) {
      return parsed.tree ? extractTypeScriptAst(parsed) : extractTypeScriptFallback(parsed);
    },
  };
}
```

fallback 的诊断所有权在 Task 7 与 ERROR Tree 行为一起修改，确保诊断去重经过独立红灯验证。

- [x] **Step 6：验证 AST 主路径和 fallback**

运行：

```powershell
npm test -- test/intelligence/typescriptAdapter.test.ts test/intelligence/treeSitterRuntime.test.ts test/intelligence/workspaceIntelligence.test.ts
npm run typecheck
```

预期：真实 AST 新测试通过；现有 `tree: undefined` 测试继续通过。

- [x] **Step 7：提交 TypeScript AST 抽取**

```powershell
git add src/extension/intelligence/languages/typescriptAstExtractor.ts src/extension/intelligence/languages/typescriptAdapter.ts test/intelligence/typescriptAdapter.test.ts
git commit -m "feat(intelligence): extract TypeScript semantics from AST"
```

## Task 5：实现 Python AST 主路径

**文件：**

- 新增：`src/extension/intelligence/languages/pythonAstExtractor.ts`
- 修改：`src/extension/intelligence/languages/pythonAdapter.ts`
- 修改：`test/intelligence/pythonAdapter.test.ts`

- [x] **Step 1：增加真实 Python grammar 的失败测试**

```ts
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const parserWasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarWasmDirectory = path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm");

async function extractPythonWithTree(text: string) {
  const runtime = createTreeSitterParserRuntime({ parserWasmPath, grammarWasmDirectory });
  const parsed = await runtime.parse("app/sample.py", "python", text);
  try {
    return createPythonAdapter().extract(parsed);
  } finally {
    parsed.tree?.delete();
  }
}

it("extracts async decorated functions and method ranges from AST", async () => {
  const result = await extractPythonWithTree([
    "@trace",
    "async def run():",
    "    helper()",
    "class Service:",
    "    def start(self):",
    "        return run()",
  ].join("\n"));

  expect(result.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "function", name: "run", startLine: 2, endLine: 3 }),
    expect.objectContaining({ kind: "class", name: "Service", startLine: 4, endLine: 6 }),
    expect.objectContaining({ kind: "method", name: "start", qualifiedName: "app/sample.py::Service.start", startLine: 5, endLine: 6 }),
  ]));
});

it("extracts Python imports and keeps member calls unresolved", async () => {
  const result = await extractPythonWithTree([
    "from .repo import load_user as load",
    "import app.client as client",
    "async def run():",
    "    load()",
    "    client.send()",
  ].join("\n"));

  expect(result.importBindings).toEqual(expect.arrayContaining([
    expect.objectContaining({ localName: "load", importedName: "load_user", source: ".repo" }),
    expect.objectContaining({ localName: "client", importedName: "app.client", source: "app.client" }),
  ]));
  expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
    expect.objectContaining({ referenceName: "load", calleeKind: "identifier" }),
    expect.objectContaining({ referenceName: "send", receiverName: "client", calleeKind: "member" }),
  ]));
});
```

- [x] **Step 2：运行 Python 测试并确认红灯**

运行：

```powershell
npm test -- test/intelligence/pythonAdapter.test.ts
```

预期：`async def`、完整范围、qualified name、模块导入和成员调用元数据断言失败。

- [x] **Step 3：实现 Python AST extractor**

`pythonAstExtractor.ts` 使用一次遍历并处理：

```ts
switch (node.type) {
  case "class_definition":
    addClass(node, ancestors);
    break;
  case "function_definition":
    addFunctionOrMethod(node, ancestors);
    break;
  case "import_from_statement":
    addFromImports(node);
    break;
  case "import_statement":
    addModuleImports(node);
    break;
  case "call":
    addCallReference(node, ancestors);
    break;
}
```

最近容器若为 `class_definition` 则生成 method；若最近容器为另一个 `function_definition`，跳过局部函数节点，并且局部函数中的调用不得回挂到外层函数。`decorated_definition` 通过 `definition` 字段进入内部声明，节点 metadata 记录装饰器起始行。

- [x] **Step 4：切换 Python adapter 主路径并保留 fallback**

```ts
export function createPythonAdapter(): LanguageAdapter {
  return {
    id: "python",
    languageIds: ["python"],
    extensions: [".py"],
    extract(parsed) {
      return parsed.tree ? extractPythonAst(parsed) : extractPythonFallback(parsed);
    },
  };
}
```

fallback 的诊断所有权在 Task 7 与 ERROR Tree 行为一起修改，确保诊断去重经过独立红灯验证。

- [x] **Step 5：验证 Python AST 与 fallback**

运行：

```powershell
npm test -- test/intelligence/pythonAdapter.test.ts test/intelligence/workspaceIntelligence.test.ts
npm run typecheck
```

预期：真实 AST 和原有 fallback 测试全部通过。

- [x] **Step 6：提交 Python AST 抽取**

```powershell
git add src/extension/intelligence/languages/pythonAstExtractor.ts src/extension/intelligence/languages/pythonAdapter.ts test/intelligence/pythonAdapter.test.ts
git commit -m "feat(intelligence): extract Python semantics from AST"
```

## Task 6：解析模块路径并校正调用边置信度

**文件：**

- 新增：`src/extension/intelligence/resolution/modulePathResolver.ts`
- 新增：`test/intelligence/modulePathResolver.test.ts`
- 修改：`src/extension/intelligence/resolution/referenceResolver.ts`
- 修改：`src/extension/intelligence/workspaceIntelligence.ts`
- 修改：`test/intelligence/referenceResolver.test.ts`
- 修改：`test/intelligence/workspaceIntelligence.test.ts`

- [x] **Step 1：增加 TypeScript 和 Python 模块解析失败测试**

```ts
function binding(
  filePath: string,
  source: string,
  importedName: string,
  languageId = "typescript",
): ImportBinding {
  return {
    filePath,
    source,
    importedName,
    localName: importedName,
    languageId,
  };
}

it("resolves TypeScript relative files and index modules", () => {
  const resolved = resolveImportBindings([
    binding("src/model/provider.ts", "./runner", "createRunner"),
    binding("src/feature/useApi.ts", "../api", "request"),
  ], [
    "src/model/provider.ts",
    "src/model/runner.ts",
    "src/api/index.ts",
  ]);

  expect(resolved[0]?.resolvedFilePath).toBe("src/model/runner.ts");
  expect(resolved[1]?.resolvedFilePath).toBe("src/api/index.ts");
});

it("resolves Python modules and package initializers", () => {
  const resolved = resolveImportBindings([
    binding("app/service.py", ".repo", "load_user", "python"),
    binding("app/service.py", "app.client", "Client", "python"),
  ], ["app/service.py", "app/repo.py", "app/client/__init__.py"]);

  expect(resolved[0]?.resolvedFilePath).toBe("app/repo.py");
  expect(resolved[1]?.resolvedFilePath).toBe("app/client/__init__.py");
});
```

- [x] **Step 2：增加引用置信度与成员防误连失败测试**

```ts
function reference(overrides: Partial<UnresolvedReference> = {}): UnresolvedReference {
  return {
    fromNodeId: "symbol:src/a.ts:function:run:1",
    referenceName: "helper",
    referenceKind: "calls",
    calleeKind: "identifier",
    filePath: "src/a.ts",
    line: 2,
    languageId: "typescript",
    ...overrides,
  };
}

it("does not resolve a member call to a bare same-file function", () => {
  const graph = createSemanticGraph();
  graph.upsertNode(createFunctionNode("src/a.ts", "run"));
  graph.upsertNode(createFunctionNode("src/a.ts", "helper", 10));
  const edges = resolveReferences({
    graph,
    importBindings: [],
    references: [reference({
      referenceName: "helper",
      calleeKind: "member",
      receiverName: "service",
    })],
  });

  expect(edges).toEqual([]);
});

it("uses evidence-based confidence levels", () => {
  const importedGraph = createSemanticGraph();
  importedGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
  importedGraph.upsertNode(createFunctionNode("src/b.ts", "helper"));
  const [importedEdge] = resolveReferences({
    graph: importedGraph,
    references: [reference()],
    importBindings: [{
      filePath: "src/a.ts",
      localName: "helper",
      importedName: "helper",
      source: "./b",
      resolvedFilePath: "src/b.ts",
      languageId: "typescript",
    }],
  });

  const sameFileGraph = createSemanticGraph();
  sameFileGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
  sameFileGraph.upsertNode(createFunctionNode("src/a.ts", "helper", 10));
  const [sameFileEdge] = resolveReferences({
    graph: sameFileGraph,
    references: [reference()],
    importBindings: [],
  });

  const globalGraph = createSemanticGraph();
  globalGraph.upsertNode(createFunctionNode("src/a.ts", "run"));
  globalGraph.upsertNode(createFunctionNode("src/c.ts", "helper"));
  const [globalEdge] = resolveReferences({
    graph: globalGraph,
    references: [reference()],
    importBindings: [],
  });

  expect(importedEdge?.confidence).toBe("exact");
  expect(sameFileEdge?.confidence).toBe("probable");
  expect(globalEdge?.confidence).toBe("heuristic");
});
```

- [x] **Step 3：运行 resolver 测试并确认红灯**

运行：

```powershell
npm test -- test/intelligence/modulePathResolver.test.ts test/intelligence/referenceResolver.test.ts
```

预期：模块 resolver 尚不存在；成员调用仍可能产生边；现有 resolver 将所有边标记为 `exact`。

- [x] **Step 4：实现模块路径解析**

导出稳定接口：

```ts
export function resolveImportBindings(
  bindings: readonly ImportBinding[],
  workspaceFilePaths: readonly string[],
): ImportBinding[];
```

内部统一使用 `/`，TypeScript 系候选顺序为精确路径、`.ts/.tsx/.js/.jsx`、`/index.*`；Python 候选为模块 `.py` 和 `/__init__.py`。只返回复制后的 binding，不修改 adapter 缓存对象。

- [x] **Step 5：重构引用解析结果以携带证据等级**

`findTargetNode` 改为返回：

```ts
type ResolvedTarget = {
  node: CodeNode;
  confidence: CodeEdge["confidence"];
};
```

在入口先拒绝非 identifier 调用：

```ts
if (reference.calleeKind && reference.calleeKind !== "identifier") {
  return undefined;
}
```

已解析导入返回 `exact`，同文件唯一候选返回 `probable`，全工作区唯一候选返回 `heuristic`。创建边时使用 `target.confidence`，不再硬编码 `exact`。

- [x] **Step 6：在 workspace 中接入模块 resolver**

在引用解析前执行：

```ts
const resolvedImportBindings = resolveImportBindings(
  importBindings,
  files.map((file) => file.path),
);
const resolvedEdges = resolveReferences({
  graph,
  references: unresolvedReferences,
  importBindings: resolvedImportBindings,
});
```

- [x] **Step 7：验证模块与引用解析**

运行：

```powershell
npm test -- test/intelligence/modulePathResolver.test.ts test/intelligence/referenceResolver.test.ts test/intelligence/workspaceIntelligence.test.ts
npm run typecheck
```

预期：模块路径、别名导入、置信度和成员防误连测试全部通过。

- [x] **Step 8：提交模块与引用解析**

```powershell
git add src/extension/intelligence/resolution/modulePathResolver.ts src/extension/intelligence/resolution/referenceResolver.ts src/extension/intelligence/workspaceIntelligence.ts test/intelligence/modulePathResolver.test.ts test/intelligence/referenceResolver.test.ts test/intelligence/workspaceIntelligence.test.ts
git commit -m "feat(intelligence): resolve module paths with evidence confidence"
```

## Task 7：修复诊断合并与异常 AST 降级

**文件：**

- 修改：`src/extension/intelligence/languages/typescriptAstExtractor.ts`
- 修改：`src/extension/intelligence/languages/pythonAstExtractor.ts`
- 修改：`src/extension/intelligence/languages/typescriptAdapter.ts`
- 修改：`src/extension/intelligence/languages/pythonAdapter.ts`
- 修改：`src/extension/intelligence/workspaceIntelligence.ts`
- 修改：`test/intelligence/typescriptAdapter.test.ts`
- 修改：`test/intelligence/pythonAdapter.test.ts`
- 修改：`test/intelligence/workspaceIntelligence.test.ts`

- [x] **Step 1：增加重复诊断和 ERROR Tree 失败测试**

```ts
it("records each parser diagnostic exactly once", async () => {
  await intelligence.buildCodeIntelligencePrompt("run");

  expect(intelligence.getDiagnostics()).toEqual([
    expect.objectContaining({ message: "fixture warning" }),
  ]);
});

it("extracts valid declarations from a tree containing errors", async () => {
  const result = await extractWithTree("function valid() {}\nfunction broken(");

  expect(result.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "function", name: "valid" }),
  ]));
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ severity: "warning", message: expect.stringContaining("ERROR") }),
  ]);
});
```

- [x] **Step 2：运行诊断测试并确认红灯**

运行：

```powershell
npm test -- test/intelligence/typescriptAdapter.test.ts test/intelligence/pythonAdapter.test.ts test/intelligence/workspaceIntelligence.test.ts
```

预期：parser warning 当前重复；ERROR Tree 没有语义抽取 warning。

- [x] **Step 3：统一诊断所有权**

adapter fallback 与 AST extractor 都只返回自己产生的诊断：

```ts
const diagnostics: IndexDiagnostic[] = [];
if (parsed.tree?.rootNode.hasError) {
  diagnostics.push({
    filePath: parsed.filePath,
    severity: "warning",
    message: "Tree-sitter 语法树包含 ERROR 节点，已抽取其中可识别的声明。",
  });
}
```

workspace 保留唯一合并点：

```ts
const result: ExtractionResult = {
  ...extracted,
  diagnostics: [...parsed.diagnostics, ...extracted.diagnostics],
};
```

- [x] **Step 4：验证诊断、fallback 和缓存行为**

运行：

```powershell
npm test -- test/intelligence/typescriptAdapter.test.ts test/intelligence/pythonAdapter.test.ts test/intelligence/workspaceIntelligence.test.ts test/intelligence/vscodeWorkspaceIntelligence.test.ts
```

预期：每条 parser warning 只出现一次；ERROR Tree 保留有效节点；同内容文件仍命中 extraction cache。

- [x] **Step 5：提交诊断修复**

```powershell
git add src/extension/intelligence/languages/typescriptAstExtractor.ts src/extension/intelligence/languages/pythonAstExtractor.ts src/extension/intelligence/languages/typescriptAdapter.ts src/extension/intelligence/languages/pythonAdapter.ts src/extension/intelligence/workspaceIntelligence.ts test/intelligence/typescriptAdapter.test.ts test/intelligence/pythonAdapter.test.ts test/intelligence/workspaceIntelligence.test.ts
git commit -m "fix(intelligence): keep AST diagnostics consistent"
```

## Task 8：完整回归、Extension Host 验证与文档收口

**文件：**

- 修改：`docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md`
- 修改：`docs/superpowers/plans/2026-07-10-real-ast-semantic-extraction-plan.md`

执行调整：`docs/superpowers/specs/2026-07-09-incremental-index-tree-sitter-design.md` 在本阶段开始前已有其他未提交修改。为避免混入无关内容，本阶段只在新的真实 AST 规格和本计划中记录实施结果，旧规格由其所属变更单独收口。

- [x] **Step 1：运行全部自动化验证**

```powershell
npm test
npm run typecheck
npm run compile
git diff --check
```

预期：所有测试通过；TypeScript 无错误；`dist/tree-sitter/` 包含 parser、TypeScript、TSX、JavaScript 和 Python WASM；无空白错误。

实际结果（2026-07-10）：`npm test` 通过 30 个测试文件、109 个测试；`npm run typecheck` 与 `npm run compile` 均通过；`dist/tree-sitter/` 包含 5 个预期 WASM 文件。最终文档修改后的 `git diff --check` 在 Step 5 再执行一次。

- [x] **Step 2：执行对抗样例回归**

使用现有测试或一次性只读脚本验证以下事实：

```text
"}" 字符串不会截断函数范围
箭头函数形成 function 节点
Python async def 形成完整范围节点
service.helper() 不连接同文件 helper()
import alias 连接 resolvedFilePath 中的真实符号
同一 parser warning 只记录一次
```

预期：六项全部成立。

实际结果（2026-07-10）：单独运行 TypeScript adapter、Python adapter、reference resolver 与 workspace AST 集成测试，共 4 个测试文件、22 个测试通过，六项事实均有自动化断言覆盖。

- [x] **Step 3：在唯一调试窗口中验证 Extension Host**

运行：

```powershell
npm run debug:vscode
```

复用唯一的 LoopAgent Extension Development Host，刷新窗口后执行 `LoopAgent: Open Panel`。触发两次同工作区代码提问，确认第二次使用 extraction cache；检查诊断中没有重复 Tree-sitter warning。测试结束后不启动第二个调试窗口。

实际结果（2026-07-10）：通过 `npm run debug:vscode` 启动并持续复用唯一调试窗口，远程调试端口为 `9333`。`local-dev.loopagent-vscode` 已激活，LoopAgent webview 正常显示；在 `Fake local` 下连续发送两次同工作区代码提问，两次流程均完成。最新 Extension Host 日志没有 Tree-sitter/WASM 错误或重复诊断；`safeStorage`、Git ref 和 CSP warning 属于既有调试环境问题。

- [x] **Step 4：更新中文设计与计划状态**

在新的真实 AST 设计文档中记录：

```markdown
## 实施结果

- TypeScript 系与 Python 已使用真实 Tree-sitter AST 作为正常抽取路径。
- 正则抽取仅在 Tree-sitter 不可用时降级使用。
- Parser 与 Tree 生命周期已显式释放。
- 模块路径、成员调用防误连和边置信度已通过自动化测试。
- SQLite 与向量索引仍按独立规格实施，不属于本阶段。
```

将本计划已完成步骤勾选，并记录实际验证命令与结果；不得填写未实际执行的验证。

实际结果（2026-07-10）：实施范围、剩余限制、自动化结果和 Extension Host 结果已写入 `docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md` 与本计划。

- [x] **Step 5：清理检查**

运行：

```powershell
rg -n "console\.log|debugger|TEMP_DEBUG|FIXME_AST" src/extension/intelligence test/intelligence docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md
git status --short
```

预期：没有本阶段新增的临时日志、临时标记、测试脚手架或意外文件；原有无关脏文件保持不变。

实际结果（2026-07-10）：临时调试标记扫描无匹配，新增代码清理标记扫描无匹配，`git diff --check` 退出码为 0；工作树中的原有无关修改和未跟踪文件均保留且不纳入本阶段提交。

- [x] **Step 6：提交验证文档**

```powershell
git add docs/superpowers/specs/2026-07-10-real-ast-semantic-extraction-design.md docs/superpowers/plans/2026-07-10-real-ast-semantic-extraction-plan.md
git commit -m "docs: record real AST extraction verification"
```

## 验收标准

1. 传入真实 Tree 时，两种 adapter 的结果必须区别于无 Tree fallback，并覆盖规格列出的核心语法。
2. 所有符号范围来自 AST，字符串、注释、模板字符串和对象字面量不影响容器范围。
3. 成员调用不会按裸名称建立错误精确边。
4. 工作区内可解析的别名导入能连接真实目标文件。
5. Parser 与 Tree 在成功、空结果和异常路径都有明确所有者并被释放。
6. Tree-sitter warning 不重复，ERROR Tree 不清空全部有效声明。
7. 全量测试、类型检查和编译通过。
8. SQLite、FTS 和向量实现没有混入本阶段代码。
