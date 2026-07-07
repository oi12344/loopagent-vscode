import type { HostToWebviewMessage } from "../shared/messages";
import type { AgentRunner } from "./agentRunner";

export function createFakeRunMessages(runId: string, task: string): HostToWebviewMessage[] {
  return [
    { type: "runStarted", runId, task },
    { type: "agentEvent", runId, message: "Building context" },
    { type: "agentEvent", runId, message: "Calling model placeholder" },
    { type: "runFinished", runId },
  ];
}

export const fakeAgentRunner: AgentRunner = {
  run: async function* ({ runId, task, signal }) {
    for (const message of createFakeRunMessages(runId, task)) {
      if (signal.aborted) {
        return;
      }

      yield message;
    }
  },
};
