export type WorkflowDiagnosticLog = {
  kind: "assistant" | "tool" | "error";
  name?: string;
  message: string;
  succeeded?: boolean;
};
