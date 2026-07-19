import { createExploreCodeTool } from "./src/extension/agent/exploreCodeTool";
import { createVsCodeWorkspaceIntelligence } from "./src/extension/intelligence/vscodeWorkspaceIntelligence";

// 简单测试：看 exploreCode 工具返回什么格式
const vscodeApi = require("vscode");
const intelligence = createVsCodeWorkspaceIntelligence(vscodeApi);
const tool = createExploreCodeTool(intelligence);

const controller = new AbortController();
tool
  .invoke({
    request: { id: "test-1", name: "exploreCode", rawArguments: "", input: { query: "SemanticGraph getOutgoingEdges" } },
    input: { query: "SemanticGraph getOutgoingEdges" },
    signal: controller.signal,
  })
  .then((result) => {
    console.log("=== 工具返回的格式 ===");
    console.log("前 200 字符:");
    console.log(result.slice(0, 200));
    console.log("\n是否包含 DSML 标签?", result.includes("<invoke"));
    console.log("是否包含 Markdown?", result.includes("## ") || result.includes("```"));
    console.log("\n完整返回长度:", result.length);
  })
  .catch((err) => console.error("错误:", err));
