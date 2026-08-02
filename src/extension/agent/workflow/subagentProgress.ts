import type { HostToWebviewMessage } from "../../../shared/messages";

/**
 * 子智能体的推进状态。墙钟到点不再直接判死，而是先看这一段时间里日志有没有变化：
 * - `progressing` 有新消息，模型在往前走，延长观察窗；
 * - `blocked`     没有新消息，但有工具调用尚未回来（长命令、等审批），同样延长；
 * - `stalled`     没有新消息也没有在跑的工具，模型自己挂住了，停止处理；
 * - `looping`     反复发同一个工具调用，消息在涨但没有进展，停止处理。
 *
 * `blocked` 必须和 `stalled` 分开：一个跑 `npm test` 的 executor 在命令返回前不产生任何
 * 消息，按 `stalled` 处理会把正常工作的节点杀掉——那正是把墙钟换成进度判定要避免的事。
 */
export type SubagentProgressState = "progressing" | "blocked" | "stalled" | "looping";

export type SubagentProgressVerdict = {
	state: SubagentProgressState;
	reason: string;
};

/**
 * 同一个 `toolName|input` 出现多少次算循环。取 3 而不是 2：读同一个文件两次可能是
 * 先看结构再看细节，第三次基本没有新信息可拿。
 */
const DEFAULT_LOOP_THRESHOLD = 3;

export type SubagentProgressOptions = {
	loopThreshold?: number;
};

/**
 * 判定推进状态。纯函数，不碰计时器，便于直接测。
 *
 * @param messages             该子智能体到目前为止的全部消息。
 * @param previousMessageCount 上一次检查时的消息条数；`messages.length` 没涨就是没有新消息。
 */
export function evaluateSubagentProgress(
	messages: readonly HostToWebviewMessage[],
	previousMessageCount: number,
	options: SubagentProgressOptions = {},
): SubagentProgressVerdict {
	const loopThreshold = options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
	const pendingToolCalls = collectPendingToolCalls(messages);

	// 循环优先于"有新消息"判定：反复调同一个工具会一直产生新消息，只看条数会误判成推进。
	const repeated = findRepeatedToolCall(messages, loopThreshold);
	if (repeated) {
		return {
			state: "looping",
			reason: `repeated the tool call '${repeated.signature}' ${repeated.count} times without progressing`,
		};
	}

	if (messages.length > previousMessageCount) {
		const added = messages.length - previousMessageCount;
		return {
			state: "progressing",
			reason: `produced ${added} new log ${added === 1 ? "entry" : "entries"}`,
		};
	}

	if (pendingToolCalls.length > 0) {
		return {
			state: "blocked",
			reason: `waiting on ${pendingToolCalls.length} unfinished tool ${pendingToolCalls.length === 1 ? "call" : "calls"}: ${pendingToolCalls.join(", ")}`,
		};
	}

	return {
		state: "stalled",
		reason: messages.length === 0
			? "produced no output at all"
			: "produced no new output and has no tool call in flight",
	};
}

/** 已开始未结束的工具调用名。按 `callId` 配对，不靠出现顺序猜。 */
function collectPendingToolCalls(messages: readonly HostToWebviewMessage[]): string[] {
	const pending = new Map<string, string>();
	for (const message of messages) {
		if (message.type === "toolCallStarted") pending.set(message.callId, message.toolName);
		else if (message.type === "toolCallFinished") pending.delete(message.callId);
	}
	return [...pending.values()];
}

function findRepeatedToolCall(
	messages: readonly HostToWebviewMessage[],
	threshold: number,
): { signature: string; count: number } | undefined {
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.type !== "toolCallStarted") continue;
		const signature = `${message.toolName}(${message.input})`;
		const next = (counts.get(signature) ?? 0) + 1;
		if (next >= threshold) return { signature: truncate(signature), count: next };
		counts.set(signature, next);
	}
	return undefined;
}

function truncate(value: string, limit = 120): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
