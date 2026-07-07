import { describe, expect, it } from "vitest";
import { createFakeRunMessages } from "../src/extension/fakeRun";

describe("createFakeRunMessages", () => {
  it("creates one finished marker without duplicating Done", () => {
    const messages = createFakeRunMessages("run-1", "Inspect the current page");

    expect(messages).toEqual([
      { type: "runStarted", runId: "run-1", task: "Inspect the current page" },
      { type: "agentEvent", runId: "run-1", message: "Building context" },
      { type: "agentEvent", runId: "run-1", message: "Calling model placeholder" },
      { type: "runFinished", runId: "run-1" },
    ]);
  });
});