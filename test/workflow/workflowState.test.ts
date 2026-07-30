import { describe, expect, it } from "vitest";
import { createWorkflowState, StateWriteConflictError } from "../../src/extension/agent/workflow/workflowState";

describe("workflow state", () => {
	it("rejects two single-writer updates in one step", () => {
		const state = createWorkflowState({ "outputs.draft": "old" });
		const snapshot = state.readSnapshot();

		expect(() => state.commitWrites(snapshot, [
			{ channel: "outputs.draft", value: "a", mode: "single", nodeId: "a" },
			{ channel: "outputs.draft", value: "b", mode: "single", nodeId: "b" },
		])).toThrow(StateWriteConflictError);
	});

	it("commits append and merge writes atomically", () => {
		const state = createWorkflowState({ history: ["start"], metadata: { a: 1 } });
		const next = state.commitWrites(state.readSnapshot(), [
			{ channel: "history", value: "b", mode: "append", nodeId: "b" },
			{ channel: "metadata", value: { b: 2 }, mode: "merge", nodeId: "b" },
		]);

		expect(next.values.get("history")).toEqual(["start", "b"]);
		expect(next.values.get("metadata")).toEqual({ a: 1, b: 2 });
		expect(next.step).toBe(1);
		expect(next.version).toBe(1);
	});

	it("uses stable node order for append writes", () => {
		const state = createWorkflowState({ history: [] });
		const next = state.commitWrites(state.readSnapshot(), [
			{ channel: "history", value: "z", mode: "append", nodeId: "z" },
			{ channel: "history", value: "a", mode: "append", nodeId: "a" },
		]);

		expect(next.values.get("history")).toEqual(["a", "z"]);
	});

	it("rejects stale snapshots without partial updates", () => {
		const state = createWorkflowState({ value: "old" });
		const snapshot = state.readSnapshot();
		state.commitWrites(snapshot, [{ channel: "value", value: "new", mode: "single", nodeId: "a" }]);

		expect(() => state.commitWrites(snapshot, [{ channel: "other", value: "x", mode: "single", nodeId: "b" }])).toThrow(StateWriteConflictError);
		expect(state.readSnapshot().values.get("other")).toBeUndefined();
	});
});
