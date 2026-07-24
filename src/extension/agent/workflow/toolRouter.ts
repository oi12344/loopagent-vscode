import type { ReactAgentTool } from "../reactTypes";

const HIGH_COST_TOOLS = new Set(["explorecode"]);

export function selectTools(
  task: string,
  availableTools: readonly ReactAgentTool[],
  toolHints?: readonly string[],
): ReactAgentTool[] {
  if (availableTools.length === 0) return [];

  const hintedNames = new Set(toolHints?.map((hint) => hint.toLowerCase()));
  if (hintedNames.size > 0) {
    const hintedTools = availableTools.filter((tool) => hintedNames.has(tool.name.toLowerCase()));
    if (hintedTools.length > 0) return hintedTools;
  }

  const taskWords = words(task);
  const matchedTools = availableTools.filter(
    (tool) => !HIGH_COST_TOOLS.has(tool.name.toLowerCase()) && [...words(`${tool.name} ${tool.description}`)].some((word) => taskWords.has(word)),
  );
  if (matchedTools.length > 0) return matchedTools;

  return [availableTools.find((tool) => tool.name === "readFile") ?? availableTools[0]];
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}
