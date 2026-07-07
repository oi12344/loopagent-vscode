import type { CodeRuntimeContext, CodeRuntimeTextExcerpt } from "./codeRuntimeContext";

export type { CodeRuntimeContext } from "./codeRuntimeContext";

export function renderCodeRuntimeContextPrompt(context: CodeRuntimeContext): string {
  if (!hasUsefulContext(context)) {
    return "";
  }

  const lines: string[] = [
    "当前 VS Code 工作区只读上下文如下。该上下文不是完整仓库；回答时优先结合用户请求、活动文件和选区。",
    "",
  ];

  lines.push("## 工作区");
  if (context.workspace.name) {
    lines.push(`- 名称: ${context.workspace.name}`);
  }
  if (context.workspace.roots.length > 0) {
    lines.push(`- 根目录: ${context.workspace.roots.join(", ")}`);
  }

  if (context.activeEditor) {
    lines.push("", "## 活动文件");
    lines.push(`- 路径: ${context.activeEditor.path}`);
    lines.push(`- 语言: ${context.activeEditor.languageId}`);
    lines.push(`- 行数: ${context.activeEditor.lineCount}`);
    if (context.activeEditor.cursor) {
      lines.push(`- 光标: ${context.activeEditor.cursor.line}:${context.activeEditor.cursor.character}`);
    }
    if (context.activeEditor.isDirty) {
      lines.push("- 状态: 未保存");
    }

    appendExcerpt(lines, context.activeEditor.selection, context.activeEditor.languageId, "选区");
    appendExcerpt(lines, context.activeEditor.snippet, context.activeEditor.languageId, "光标附近代码");
  }

  if (context.visibleEditors.length > 0) {
    lines.push("", "## 可见编辑器");
    for (const editor of context.visibleEditors) {
      lines.push(`- ${editor.path} (${editor.languageId}${editor.isDirty ? ", 未保存" : ""})`);
    }
  }

  if (context.openTabs.length > 0) {
    lines.push("", "## 打开的文件");
    for (const tab of context.openTabs) {
      const metadata = [tab.languageId, tab.isDirty ? "未保存" : undefined, tab.isPinned ? "固定" : undefined]
        .filter(Boolean)
        .join(", ");
      lines.push(metadata ? `- ${tab.path} (${metadata})` : `- ${tab.path}`);
    }
  }

  if (context.projectFiles.length > 0) {
    lines.push("", "## 项目文件摘要");
    for (const projectFile of context.projectFiles) {
      lines.push(`### ${projectFile.path} (${projectFile.kind}${projectFile.truncated ? ", 已截断" : ""})`);
      lines.push("```text", sanitizeCodeBlock(projectFile.summary), "```");
    }
  }

  if (context.diagnostics.length > 0) {
    lines.push("", "## 诊断");
    for (const diagnostic of context.diagnostics) {
      lines.push(
        `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.severity}: ${diagnostic.message}`,
      );
    }
  }

  lines.push("", "## 上下文预算");
  lines.push(`- 使用字符: ${context.budget.usedChars}/${context.budget.maxChars}`);
  lines.push(`- 是否截断: ${context.budget.truncated ? "是" : "否"}`);

  return lines.join("\n").trim();
}

function appendExcerpt(
  lines: string[],
  excerpt: CodeRuntimeTextExcerpt | undefined,
  languageId: string,
  title: string,
): void {
  if (!excerpt || excerpt.text.length === 0) {
    return;
  }

  lines.push("");
  lines.push(`### ${title} (${excerpt.startLine}-${excerpt.endLine}${excerpt.truncated ? ", 已截断" : ""})`);
  lines.push(`\`\`\`${languageId}`);
  lines.push(sanitizeCodeBlock(excerpt.text));
  lines.push("```");
}

function hasUsefulContext(context: CodeRuntimeContext): boolean {
  return Boolean(
    context.workspace.name ||
      context.workspace.roots.length > 0 ||
      context.activeEditor ||
      context.visibleEditors.length > 0 ||
      context.openTabs.length > 0 ||
      context.projectFiles.length > 0 ||
      context.diagnostics.length > 0,
  );
}

function sanitizeCodeBlock(text: string): string {
  return text.replace(/```/g, "``\\`");
}
