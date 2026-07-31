import { randomUUID } from "node:crypto";
import type { CodeReviewConfig, CodeReviewIssue, CodeReviewReport } from "../../shared/chatTypes";
import type { ReactAgentTool, ReactAgentToolResult } from "./reactTypes";

// ---------------------------------------------------------------------------
// 简单的 glob 模式匹配（不依赖外部包）
// ---------------------------------------------------------------------------

function patternToRegex(pattern: string): RegExp {
  // 转义除 * 和 ? 之外的特殊正则字符
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      // ** 匹配任意层级，* 匹配单层
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        regexStr += ".*";
        i++; // 跳过第二个 *
        // 跳过后面的 /
        if (i + 1 < pattern.length && pattern[i + 1] === "/") {
          i++;
        }
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += "\\" + ch;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

function matchesGlob(filePath: string, pattern: string): boolean {
  // 标准化路径分隔符
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const regex = patternToRegex(normalizedPattern);
  return regex.test(normalizedPath);
}

// ---------------------------------------------------------------------------
// 代码分析规则
// ---------------------------------------------------------------------------

type Analyzer = {
  ruleId: string;
  category: CodeReviewIssue["category"];
  severity: CodeReviewIssue["severity"];
  analyze(filePath: string, lines: string[]): CodeReviewIssue[];
};

const analyzers: Analyzer[] = [
  {
    ruleId: "long-line",
    category: "style",
    severity: "warning",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 120) {
          issues.push({
            severity: "warning",
            category: "style",
            filePath,
            line: i + 1,
            message: `行过长 (${lines[i].length} 字符)，建议不超过 120 字符`,
            suggestion: "考虑换行或简化该行代码",
          });
        }
      }
      return issues;
    },
  },
  {
    ruleId: "console-log",
    category: "maintainability",
    severity: "warning",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.includes("console.log") || trimmed.includes("console.warn") || trimmed.includes("console.error")) {
          // 忽略注释行
          if (trimmed.startsWith("//")) continue;
          issues.push({
            severity: "warning",
            category: "maintainability",
            filePath,
            line: i + 1,
            message: "发现 console 调用，可能是调试遗留代码",
            suggestion: "考虑移除或替换为适当的日志框架",
          });
        }
      }
      return issues;
    },
  },
  {
    ruleId: "todo-comment",
    category: "maintainability",
    severity: "info",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      const patterns = [/\bTODO\b/i, /\bFIXME\b/i, /\bHACK\b/i, /\bXXX\b/i];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            issues.push({
              severity: "info",
              category: "maintainability",
              filePath,
              line: i + 1,
              message: `发现待办标记: ${line.trim()}`,
              suggestion: "在发布前处理该标记",
            });
            break;
          }
        }
      }
      return issues;
    },
  },
  {
    ruleId: "empty-catch",
    category: "bug",
    severity: "error",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // 匹配空 catch 块: catch (...) {}
        if (/^catch\s*\([^)]*\)\s*\{\s*\}\s*$/.test(trimmed)) {
          issues.push({
            severity: "error",
            category: "bug",
            filePath,
            line: i + 1,
            message: "空的 catch 块会静默忽略异常",
            suggestion: "至少记录错误日志，或者处理特定异常",
          });
        }
      }
      return issues;
    },
  },
  {
    ruleId: "file-too-long",
    category: "maintainability",
    severity: "warning",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      if (lines.length > 500) {
        issues.push({
          severity: "warning",
          category: "maintainability",
          filePath,
          line: 1,
          message: `文件过长 (${lines.length} 行)，建议拆分为更小的模块`,
          suggestion: "考虑将文件拆分为多个模块，每个模块聚焦单一职责",
        });
      }
      return issues;
    },
  },
  {
    ruleId: "duplicate-import",
    category: "style",
    severity: "info",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      const importMap = new Map<string, number[]>();
      const importRe = /^import\s+.*\bfrom\s+['"]([^'"]+)['"]/;
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(importRe);
        if (match) {
          const source = match[1];
          if (!importMap.has(source)) {
            importMap.set(source, []);
          }
          importMap.get(source)!.push(i + 1);
        }
      }
      for (const [source, lineNumbers] of importMap) {
        if (lineNumbers.length > 1) {
          issues.push({
            severity: "info",
            category: "style",
            filePath,
            line: lineNumbers[0],
            message: `重复导入 "${source}" (出现在 ${lineNumbers.length} 处: ${lineNumbers.join(", ")})`,
            suggestion: "合并同一模块的导入语句",
          });
        }
      }
      return issues;
    },
  },
  {
    ruleId: "hardcoded-path",
    category: "security",
    severity: "warning",
    analyze(filePath, lines): CodeReviewIssue[] {
      const issues: CodeReviewIssue[] = [];
      // 检查硬编码的 API Key 或密码模式
      const sensitivePatterns = [
        /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
        /(?:access[_-]?key|accesskey|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
      ];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const pattern of sensitivePatterns) {
          if (pattern.test(trimmed)) {
            issues.push({
              severity: "warning",
              category: "security",
              filePath,
              line: i + 1,
              message: "可能硬编码了敏感凭据",
              suggestion: "使用环境变量或安全的密钥管理服务",
            });
            break;
          }
        }
      }
      return issues;
    },
  },
];

// ---------------------------------------------------------------------------
// 输入 schema
// ---------------------------------------------------------------------------

const inputSchema = {
  type: "object",
  properties: {
    targetPath: {
      type: "string",
      description: "要审查的目标文件或目录路径（相对于工作区根目录）",
    },
    includePatterns: {
      type: "array",
      items: { type: "string" },
      description: "包含文件的 glob 模式列表，默认为 ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']",
    },
    excludePatterns: {
      type: "array",
      items: { type: "string" },
      description: "排除文件的 glob 模式列表，默认为 ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.spec.ts']",
    },
  },
  required: ["targetPath"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// 主要工具实现
// ---------------------------------------------------------------------------

const DEFAULT_INCLUDE_PATTERNS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const DEFAULT_EXCLUDE_PATTERNS = ["**/node_modules/**", "**/dist/**", "**/*.test.ts", "**/*.spec.ts"];

export type CodeReviewToolOptions = {
  /** 用于读取文件的函数 */
  readFile: (path: string) => Promise<string>;
  /** 用于列出目录下文件的函数 */
  listFiles: (dirPath: string) => Promise<string[]>;
  /** 用于检查路径是否为目录的函数 */
  isDirectory: (path: string) => Promise<boolean>;
  /** 工作区根目录路径 */
  workspaceRoot: string;
};

/**
 * 创建代码审查工具
 *
 * 对指定文件或目录进行静态代码审查，返回结构化审查报告。
 */
export function createCodeReviewTool(options: CodeReviewToolOptions): ReactAgentTool {
  return {
    name: "codeReview",
    description: "对指定文件或目录进行代码审查，发现潜在问题并生成结构化审查报告",
    isConcurrencySafe: () => true,
    inputSchema,
    async invoke({ input, signal }): Promise<ReactAgentToolResult> {
      const { targetPath, includePatterns, excludePatterns } = parseInput(input);
      signal.throwIfAborted();

      const patterns = includePatterns ?? DEFAULT_INCLUDE_PATTERNS;
      const exclude = excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;

      const startTime = Date.now();

      // 收集所有需要审查的文件
      const filePaths = await collectFiles(
        options,
        targetPath,
        patterns,
        exclude,
        signal,
      );

      if (filePaths.length === 0) {
        const emptyReport: CodeReviewReport = {
          id: randomUUID(),
          timestamp: Date.now(),
          targetPath,
          assessment: 10,
          summary: "No files to review",
          totalIssues: 0,
          issuesBySeverity: { error: 0, warning: 0, info: 0 },
          issuesByCategory: { bug: 0, style: 0, performance: 0, security: 0, maintainability: 0 },
          issues: [],
        };
        return {
          content: JSON.stringify(emptyReport, null, 2),
          evidence: [],
          productive: false,
        };
      }

      // 并行读取并分析所有文件
      const filesAnalysis = await Promise.all(
        filePaths.map(async (filePath) => {
          try {
            signal.throwIfAborted();
            const content = await options.readFile(filePath);
            const lines = content.split(/\r?\n/);
            return lines;
          } catch {
            signal.throwIfAborted();
            return null; // 读取失败跳过
          }
        }),
      );

      signal.throwIfAborted();

      // 收集所有发现的问题
      const allIssues: CodeReviewIssue[] = [];

      for (let i = 0; i < filePaths.length; i++) {
        const lines = filesAnalysis[i];
        if (lines === null) continue;
        const filePath = filePaths[i];

        for (const analyzer of analyzers) {
          try {
            const issues = analyzer.analyze(filePath, lines);
            allIssues.push(...issues);
          } catch {
            // 分析器失败不阻塞整体审查
          }
        }
      }

      signal.throwIfAborted();

      // 构建统计摘要
      const issuesBySeverity: Record<"error" | "warning" | "info", number> = { error: 0, warning: 0, info: 0 };
      const issuesByCategory: Record<CodeReviewIssue["category"], number> = {
        bug: 0, style: 0, performance: 0, security: 0, maintainability: 0,
      };

      for (const issue of allIssues) {
        issuesBySeverity[issue.severity] += 1;
        issuesByCategory[issue.category] += 1;
      }

      // Compute assessment score (10 minus penalties)
      const errorCount = issuesBySeverity.error;
      const warningCount = issuesBySeverity.warning;
      const infoCount = issuesBySeverity.info;
      let assessment = 10;
      assessment -= errorCount * 2;
      assessment -= warningCount * 1;
      assessment -= infoCount * 0.2;
      assessment = Math.max(0, Math.min(10, Math.round(assessment * 10) / 10));

      const summary = [
        `Reviewed ${filePaths.length} file(s)`,
        `Found ${allIssues.length} issue(s)`,
        errorCount > 0 ? `${errorCount} error(s)` : "",
        warningCount > 0 ? `${warningCount} warning(s)` : "",
        infoCount > 0 ? `${infoCount} info` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const report: CodeReviewReport = {
        id: randomUUID(),
        timestamp: Date.now(),
        targetPath,
        assessment,
        summary,
        totalIssues: allIssues.length,
        issuesBySeverity,
        issuesByCategory,
        issues: allIssues,
      };

      const duration = Date.now() - startTime;

      const summaryParts: string[] = [
        `## 代码审查报告`,
        ``, 
        `**审查目标**: \`${targetPath}\``,
        `**审查文件数**: ${filePaths.length}`,
        `**发现问题**: ${allIssues.length} 个`,
        `**耗时**: ${duration}ms`,
        ``, 
      ];

      if (issuesBySeverity.error) {
        summaryParts.push(`- ❌ **错误**: ${issuesBySeverity.error} 个`);
      }
      if (issuesBySeverity.warning) {
        summaryParts.push(`- ⚠️ **警告**: ${issuesBySeverity.warning} 个`);
      }
      if (issuesBySeverity.info) {
        summaryParts.push(`- ℹ️ **信息**: ${issuesBySeverity.info} 个`);
      }

      summaryParts.push(``);

      return {
        content: JSON.stringify(report, null, 2),
        evidence: [],
        productive: allIssues.length > 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 文件收集
// ---------------------------------------------------------------------------

async function collectFiles(
  options: CodeReviewToolOptions,
  targetPath: string,
  includePatterns: string[],
  excludePatterns: string[],
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();

  const isDir = await options.isDirectory(targetPath);
  const allFiles: string[] = [];

  if (isDir) {
    // 如果是目录，递归收集文件
    await collectFilesRecursive(options, targetPath, allFiles, signal);
  } else {
    allFiles.push(targetPath);
  }

  signal.throwIfAborted();

  // 应用 include/exclude 过滤
  return allFiles.filter((filePath) => {
    const normalizedPath = filePath.replace(/\\/g, "/");

    // 必须匹配至少一个 include 模式
    const matchesInclude = includePatterns.length === 0 ||
      includePatterns.some((pattern) => matchesGlob(normalizedPath, pattern));
    if (!matchesInclude) return false;

    // 不能匹配任何 exclude 模式
    const matchesExclude = excludePatterns.some((pattern) => matchesGlob(normalizedPath, pattern));
    return !matchesExclude;
  });
}

async function collectFilesRecursive(
  options: CodeReviewToolOptions,
  dirPath: string,
  results: string[],
  signal: AbortSignal,
): Promise<void> {
  let entries: string[];
  try {
    entries = await options.listFiles(dirPath);
  } catch {
    return; // 跳过无法读取的目录
  }

  for (const entry of entries) {
    signal.throwIfAborted();
    const fullPath = dirPath ? `${dirPath}/${entry}` : entry;

    try {
      const isDir = await options.isDirectory(fullPath);
      if (isDir) {
        // 跳过 node_modules 和隐藏目录
        const baseName = entry.split("/").pop() ?? entry;
        if (baseName === "node_modules" || baseName.startsWith(".")) continue;
        await collectFilesRecursive(options, fullPath, results, signal);
      } else {
        results.push(fullPath);
      }
    } catch {
      // 跳过无法访问的条目
    }
  }
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

function parseInput(input: unknown): {
  targetPath: string;
  includePatterns?: string[];
  excludePatterns?: string[];
} {
  if (!isRecord(input) || typeof input.targetPath !== "string") {
    throw new Error("Invalid codeReview input: expected targetPath as string");
  }

  const keys = Object.keys(input);
  const allowed = ["targetPath", "includePatterns", "excludePatterns"];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid codeReview input: unknown property "${key}"`);
    }
  }

  const targetPath = input.targetPath.trim();
  if (targetPath.length === 0) {
    throw new Error("Invalid codeReview input: targetPath must not be empty");
  }

  if (input.includePatterns !== undefined) {
    if (!Array.isArray(input.includePatterns) || !input.includePatterns.every((p): p is string => typeof p === "string")) {
      throw new Error("Invalid codeReview input: includePatterns must be an array of strings");
    }
  }

  if (input.excludePatterns !== undefined) {
    if (!Array.isArray(input.excludePatterns) || !input.excludePatterns.every((p): p is string => typeof p === "string")) {
      throw new Error("Invalid codeReview input: excludePatterns must be an array of strings");
    }
  }

  return {
    targetPath,
    includePatterns: input.includePatterns,
    excludePatterns: input.excludePatterns,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 独立的 runCodeReview 函数（非 ReactAgentTool 场景使用）
// ---------------------------------------------------------------------------

/**
 * 对单文件源代码执行代码审查，返回结构化报告。
 *
 * @param targetPath - 文件路径（用于报告元数据）
 * @param content    - 源代码文本
 * @param config     - 可选的审查配置
 * @returns 代码审查报告
 */
export function runCodeReview(
  targetPath: string,
  content: string,
  config?: Partial<CodeReviewConfig>,
): CodeReviewReport {
  const lines = content.split(/\r?\n/);
  const maxIssues = config?.maxIssues ?? 0;
  const severityFilter = config?.severityFilter ?? ["error", "warning", "info"];
  const allowedSeverities = new Set(severityFilter);

  const allIssues: CodeReviewIssue[] = [];

  for (const analyzer of analyzers) {
    try {
      const issues = analyzer.analyze(targetPath, lines);
      for (const issue of issues) {
        if (allowedSeverities.has(issue.severity)) {
          allIssues.push(issue);
          if (maxIssues > 0 && allIssues.length >= maxIssues) break;
        }
      }
    } catch {
      // 分析器失败不阻塞整体审查
    }
    if (maxIssues > 0 && allIssues.length >= maxIssues) break;
  }

  const issuesBySeverity: Record<"error" | "warning" | "info", number> = { error: 0, warning: 0, info: 0 };
  const issuesByCategory: Record<CodeReviewIssue["category"], number> = {
    bug: 0, style: 0, performance: 0, security: 0, maintainability: 0,
  };
  for (const issue of allIssues) {
    issuesBySeverity[issue.severity] += 1;
    issuesByCategory[issue.category] += 1;
  }

  const errorCount = issuesBySeverity.error;
  const warningCount = issuesBySeverity.warning;
  const infoCount = issuesBySeverity.info;
  let assessment = 10;
  assessment -= errorCount * 2;
  assessment -= warningCount * 1;
  assessment -= infoCount * 0.2;
  assessment = Math.max(0, Math.min(10, Math.round(assessment * 10) / 10));

  const summary = [
    `Reviewed ${targetPath}`,
    `Found ${allIssues.length} issue(s)`,
    errorCount > 0 ? `${errorCount} error(s)` : "",
    warningCount > 0 ? `${warningCount} warning(s)` : "",
    infoCount > 0 ? `${infoCount} info` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    targetPath,
    assessment,
    summary,
    totalIssues: allIssues.length,
    issuesBySeverity,
    issuesByCategory,
    issues: allIssues,
  };
}

/**
 * 批量对多个文件执行代码审查。
 */
export function runBatchCodeReview(
  files: Array<{ path: string; content: string }>,
  config?: Partial<CodeReviewConfig>,
): CodeReviewReport[] {
  return files.map((file) => runCodeReview(file.path, file.content, config));
}

