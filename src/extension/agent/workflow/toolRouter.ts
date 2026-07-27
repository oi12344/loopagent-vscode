import type { ReactAgentTool } from "../reactTypes";

const HIGH_COST_TOOLS = new Set(["explorecode"]);

export function selectTools(
  task: string,
  availableTools: readonly ReactAgentTool[],
  toolHints?: readonly string[],
  allowedTools?: readonly string[],
): ReactAgentTool[] {
  const scopedTools = scopeToAllowedTools(availableTools, allowedTools);
  if (scopedTools.length === 0) return [];

  const hintedNames = new Set(toolHints?.map((hint) => hint.toLowerCase()));
  if (hintedNames.size > 0) {
    const hintedTools = scopedTools.filter((tool) => hintedNames.has(tool.name.toLowerCase()));
    if (hintedTools.length > 0) return hintedTools;
  }

  if (allowedTools) return scopedTools;

  const taskWords = words(task);
  const matchedTools = scopedTools.filter(
    (tool) => !HIGH_COST_TOOLS.has(tool.name.toLowerCase()) && [...words(`${tool.name} ${tool.description}`)].some((word) => taskWords.has(word)),
  );
  if (matchedTools.length > 0) return matchedTools;

  return [scopedTools.find((tool) => tool.name === "readFile") ?? scopedTools[0]];
}

function scopeToAllowedTools(
  availableTools: readonly ReactAgentTool[],
  allowedTools?: readonly string[],
): ReactAgentTool[] {
  if (!allowedTools) return [...availableTools];
  const allowedNames = new Set(allowedTools.map((name) => name.toLowerCase()));
  return availableTools.filter((tool) => allowedNames.has(tool.name.toLowerCase()));
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}
