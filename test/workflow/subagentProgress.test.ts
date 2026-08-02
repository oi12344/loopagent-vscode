import { describe, expect, it } from "vitest";

import { evaluateSubagentProgress } from "../../src/extension/agent/workflow/subagentProgress";
import type { HostToWebviewMessage } from "../../src/shared/messages";

const runId = "subagent-1";

function toolStarted(callId: string, toolName: string, input: string): HostToWebviewMessage {
	return { type: "toolCallStarted", runId, callId, toolName, input };
}

function toolFinished(callId: string, succeeded = true): HostToWebviewMessage {
	return { type: "toolCallFinished", runId, callId, succeeded, output: "done" };
}

function assistant(content: string): HostToWebviewMessage {
	return { type: "assistantDelta", runId, content };
}

describe("evaluateSubagentProgress", () => {
	it("reports stalled when nothing was ever produced", () => {
		const verdict = evaluateSubagentProgress([], 0);

		expect(verdict.state).toBe("stalled");
		expect(verdict.reason).toContain("no output at all");
	});

	it("reports progressing when new log entries arrived since the last check", () => {
		const messages = [assistant("reading"), assistant("editing")];

		const verdict = evaluateSubagentProgress(messages, 0);

		expect(verdict.state).toBe("progressing");
		expect(verdict.reason).toContain("2 new log entries");
	});

	it("reports blocked while a tool call is still in flight", () => {
		const messages = [assistant("running tests"), toolStarted("c1", "runCommand", "npm test")];

		// 上一轮已经看到这两条，这一轮没有新消息，但 runCommand 还没回来。
		const verdict = evaluateSubagentProgress(messages, messages.length);

		expect(verdict.state).toBe("blocked");
		expect(verdict.reason).toContain("runCommand");
	});

	it("reports stalled once the in-flight tool call has returned and nothing follows", () => {
		const messages = [toolStarted("c1", "runCommand", "npm test"), toolFinished("c1")];

		const verdict = evaluateSubagentProgress(messages, messages.length);

		expect(verdict.state).toBe("stalled");
		expect(verdict.reason).toContain("no tool call in flight");
	});

	it("matches started and finished calls by callId, not by ordering", () => {
		const messages = [
			toolStarted("c1", "readFile", "a.ts"),
			toolStarted("c2", "readFile", "b.ts"),
			toolFinished("c1"),
		];

		const verdict = evaluateSubagentProgress(messages, messages.length);

		expect(verdict.state).toBe("blocked");
		// c1 已结束，只剩 c2 未回。
		expect(verdict.reason).toContain("1 unfinished tool call");
	});

	it("reports looping when the same tool call repeats, even though messages keep growing", () => {
		const messages = [
			toolStarted("c1", "exploreCode", "auth"),
			toolFinished("c1"),
			toolStarted("c2", "exploreCode", "auth"),
			toolFinished("c2"),
			toolStarted("c3", "exploreCode", "auth"),
		];

		const verdict = evaluateSubagentProgress(messages, 0);

		expect(verdict.state).toBe("looping");
		expect(verdict.reason).toContain("exploreCode");
		expect(verdict.reason).toContain("3 times");
	});

	it("does not treat two identical calls as a loop", () => {
		const messages = [
			toolStarted("c1", "readFile", "a.ts"),
			toolFinished("c1"),
			toolStarted("c2", "readFile", "a.ts"),
		];

		const verdict = evaluateSubagentProgress(messages, 0);

		expect(verdict.state).toBe("progressing");
	});

	it("distinguishes calls to the same tool with different inputs", () => {
		const messages = [
			toolStarted("c1", "readFile", "a.ts"),
			toolStarted("c2", "readFile", "b.ts"),
			toolStarted("c3", "readFile", "c.ts"),
		];

		const verdict = evaluateSubagentProgress(messages, 0);

		expect(verdict.state).toBe("progressing");
	});

	it("honours a custom loop threshold", () => {
		const messages = [
			toolStarted("c1", "readFile", "a.ts"),
			toolStarted("c2", "readFile", "a.ts"),
		];

		expect(evaluateSubagentProgress(messages, 0, { loopThreshold: 2 }).state).toBe("looping");
	});
});
