import { createCodeIntelligenceContext } from "./context/codeIntelligenceContext";
import { renderCodeIntelligencePrompt } from "./context/codeIntelligencePrompt";
import type { CodeEdge, ImportBinding, IndexDiagnostic, UnresolvedReference } from "./graph/graphTypes";
import { createSearchIndex } from "./graph/searchIndex";
import { createSemanticGraph } from "./graph/semanticGraph";
import { createPythonAdapter } from "./languages/pythonAdapter";
import { createTypeScriptAdapter } from "./languages/typescriptAdapter";
import type { ExtractionResult, LanguageAdapter } from "./languages/languageAdapter";
import type { ParsedSource, ParserRuntime } from "./parser/parserRuntime";
import { resolveImportBindings } from "./resolution/modulePathResolver";
import { resolveReferences } from "./resolution/referenceResolver";

export type CodeIndexStatus = "idle" | "indexing" | "ready" | "partial" | "failed";

export type WorkspaceSourceFile = {
  path: string;
  languageId: string;
  text: string;
};

export type WorkspaceIntelligenceBudgets = {
  maxFileBytes: number;
  maxFiles: number;
  maxNodes: number;
  maxEdges: number;
  maxUnresolvedReferences: number;
  maxPromptChars: number;
};

export type WorkspaceIntelligenceDeps = {
  readWorkspaceFiles(): Promise<WorkspaceSourceFile[]>;
  readSourceRange(filePath: string, startLine: number, endLine: number): string;
  budgets?: Partial<WorkspaceIntelligenceBudgets>;
  parserRuntime?: ParserRuntime;
};

export type WorkspaceIntelligence = {
  buildCodeIntelligencePrompt(query: string): Promise<string>;
  getStatus(): CodeIndexStatus;
  getDiagnostics(): IndexDiagnostic[];
};

const DEFAULT_BUDGETS: WorkspaceIntelligenceBudgets = {
  maxFileBytes: 512 * 1024,
  maxFiles: 3_000,
  maxNodes: 50_000,
  maxEdges: 150_000,
  maxUnresolvedReferences: 100_000,
  maxPromptChars: 8_000,
};

type CachedExtraction = {
  languageId: string;
  contentHash: string;
  result: ExtractionResult;
};

export function createWorkspaceIntelligence(deps: WorkspaceIntelligenceDeps): WorkspaceIntelligence {
  const adapters = [createTypeScriptAdapter(), createPythonAdapter()];
  const budgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  const extractionCacheByFile = new Map<string, CachedExtraction>();
  let status: CodeIndexStatus = "idle";
  let diagnostics: IndexDiagnostic[] = [];

  function markPartial(filePath: string, message: string): void {
    if (status !== "failed") {
      status = "partial";
    }
    diagnostics.push({ filePath, severity: "warning", message });
  }

  return {
    async buildCodeIntelligencePrompt(query) {
      const graph = createSemanticGraph();
      const searchIndex = createSearchIndex();
      const importBindings: ImportBinding[] = [];
      const unresolvedReferences: UnresolvedReference[] = [];
      diagnostics = [];
      status = "indexing";
      let indexedFiles = 0;
      let nodeCount = 0;
      let edgeCount = 0;
      let unresolvedReferenceCount = 0;
      let stopIndexing = false;
      let edgeBudgetExceeded = false;
      let unresolvedReferenceBudgetExceeded = false;

      try {
        const files = await deps.readWorkspaceFiles();
        const currentFilePaths = new Set(files.map((file) => file.path));
        for (const cachedFilePath of extractionCacheByFile.keys()) {
          if (!currentFilePaths.has(cachedFilePath)) {
            extractionCacheByFile.delete(cachedFilePath);
          }
        }

        for (const file of files) {
          if (stopIndexing) {
            break;
          }

          const adapter = adapters.find((candidate) => candidate.languageIds.includes(file.languageId));
          if (!adapter) {
            extractionCacheByFile.delete(file.path);
            continue;
          }

          if (indexedFiles >= budgets.maxFiles) {
            markPartial(file.path, `达到索引文件数上限 ${budgets.maxFiles}，停止继续索引。`);
            break;
          }

          if (Buffer.byteLength(file.text, "utf8") > budgets.maxFileBytes) {
            extractionCacheByFile.delete(file.path);
            markPartial(file.path, `文件超过 ${budgets.maxFileBytes} 字节上限，已跳过解析。`);
            continue;
          }

          indexedFiles += 1;
          const result = await extractWorkspaceFile(file, adapter);
          diagnostics.push(...result.diagnostics);

          for (const node of result.nodes) {
            if (nodeCount >= budgets.maxNodes) {
              markPartial(file.path, `达到节点数上限 ${budgets.maxNodes}，停止继续索引。`);
              stopIndexing = true;
              break;
            }
            graph.upsertNode(node);
            searchIndex.addNode(node);
            nodeCount += 1;
          }

          if (stopIndexing) {
            break;
          }

          for (const edge of result.edges) {
            if (!addEdgeWithinBudget(edge, file.path)) {
              break;
            }
          }

          importBindings.push(...result.importBindings);
          for (const reference of result.unresolvedReferences) {
            if (unresolvedReferenceBudgetExceeded) {
              break;
            }
            if (unresolvedReferenceCount >= budgets.maxUnresolvedReferences) {
              markPartial(file.path, `达到未解析引用数上限 ${budgets.maxUnresolvedReferences}，停止记录新引用。`);
              unresolvedReferenceBudgetExceeded = true;
              break;
            }
            unresolvedReferences.push(reference);
            unresolvedReferenceCount += 1;
          }
        }

        const resolvedImportBindings = resolveImportBindings(
          importBindings,
          files.map((file) => file.path),
        );
        for (const edge of resolveReferences({
          graph,
          references: unresolvedReferences,
          importBindings: resolvedImportBindings,
        })) {
          if (!addEdgeWithinBudget(edge, edge.filePath ?? "<workspace>")) {
            break;
          }
        }

        const result = createCodeIntelligenceContext({
          query,
          graph,
          searchIndex,
          sourceProvider: deps.readSourceRange,
          maxChars: budgets.maxPromptChars,
        });

        if (status === "indexing") {
          status = "ready";
        }
        return renderCodeIntelligencePrompt(result);
      } catch (error) {
        status = "failed";
        diagnostics.push({
          filePath: "<workspace>",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return "";
      }

      function addEdgeWithinBudget(edge: CodeEdge, filePath: string): boolean {
        if (edgeBudgetExceeded) {
          return false;
        }
        if (edgeCount >= budgets.maxEdges) {
          markPartial(filePath, `达到边数上限 ${budgets.maxEdges}，停止新增边。`);
          edgeBudgetExceeded = true;
          return false;
        }
        graph.upsertEdge(edge);
        edgeCount += 1;
        return true;
      }
    },
    getStatus() {
      return status;
    },
    getDiagnostics() {
      return diagnostics.map((diagnostic) => ({ ...diagnostic }));
    },
  };

  async function extractWorkspaceFile(file: WorkspaceSourceFile, adapter: LanguageAdapter): Promise<ExtractionResult> {
    const contentHash = createContentHash(file.text);
    const cached = extractionCacheByFile.get(file.path);
    if (cached?.languageId === file.languageId && cached.contentHash === contentHash) {
      return cached.result;
    }

    const parsed = deps.parserRuntime
      ? await deps.parserRuntime.parse(file.path, file.languageId, file.text)
      : createParsedSource(file.path, file.languageId, file.text);
    try {
      const extracted = adapter.extract(parsed);
      const result = {
        ...extracted,
        diagnostics: [...parsed.diagnostics, ...extracted.diagnostics],
      };
      extractionCacheByFile.set(file.path, { languageId: file.languageId, contentHash, result });
      return result;
    } finally {
      parsed.tree?.delete();
    }
  }
}

function createParsedSource(filePath: string, languageId: string, text: string): ParsedSource {
  return {
    filePath,
    languageId,
    text,
    tree: undefined,
    diagnostics: [],
  };
}

function createContentHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `${text.length}:${hash}`;
}

export function createEmptyWorkspaceIntelligence(): WorkspaceIntelligence {
  return {
    async buildCodeIntelligencePrompt() {
      return "";
    },
    getStatus() {
      return "ready";
    },
    getDiagnostics() {
      return [];
    },
  };
}
