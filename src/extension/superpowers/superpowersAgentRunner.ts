import type { AgentRunner } from "../agentRunner";
import type { WorkflowSupervisor } from "./workflowSupervisor";

export function createSuperpowersAgentRunner(supervisor: WorkflowSupervisor): AgentRunner {
  return supervisor;
}
