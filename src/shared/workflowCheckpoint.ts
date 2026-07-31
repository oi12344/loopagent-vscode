import { createHash } from "node:crypto";

export const WORKFLOW_CHECKPOINT_VERSION = 1 as const;
export const MAX_WORKFLOW_CHECKPOINT_BYTES = 256 * 1024;

export type WorkflowCheckpointStatus =
  | "running"
  | "recovering"
  | "waiting_input"
  | "waiting_external"
  | "failed"
  | "completed"
  | "cancelled"
  | "recovery_required";

export type WorkflowNodeCheckpointStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type WorkflowSideEffect = "none" | "applied" | "unknown";

export type WorkflowNodeCheckpoint = {
  nodeId: string;
  status: WorkflowNodeCheckpointStatus;
  inputHash: string;
  attempts: number;
  result?: {
    status: string;
    content?: string;
    error?: string;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  sideEffect: WorkflowSideEffect;
};

export type WorkflowCheckpointFailure = {
  nodeId?: string;
  code: string;
  message: string;
};

export type WorkflowCheckpoint = {
  version: typeof WORKFLOW_CHECKPOINT_VERSION;
  conversationId: string;
  runId: string;
  planHash: string;
  revision: number;
  status: WorkflowCheckpointStatus;
  frontier: string[];
  executionOrder: string[];
  nodes: Record<string, WorkflowNodeCheckpoint>;
  state: {
    step: number;
    version: number;
    values: Record<string, unknown>;
  };
  unresolvedFailures: WorkflowCheckpointFailure[];
  updatedAt: number;
};

const CHECKPOINT_KEYS = new Set([
  "version",
  "conversationId",
  "runId",
  "planHash",
  "revision",
  "status",
  "frontier",
  "executionOrder",
  "nodes",
  "state",
  "unresolvedFailures",
  "updatedAt",
]);
const NODE_KEYS = new Set(["nodeId", "status", "inputHash", "attempts", "result", "error", "sideEffect"]);
const RESULT_KEYS = new Set(["status", "content", "error"]);
const ERROR_KEYS = new Set(["code", "message", "retryable"]);
const STATE_KEYS = new Set(["step", "version", "values"]);
const FAILURE_KEYS = new Set(["nodeId", "code", "message"]);
const CHECKPOINT_STATUSES = new Set<WorkflowCheckpointStatus>([
  "running",
  "recovering",
  "waiting_input",
  "waiting_external",
  "failed",
  "completed",
  "cancelled",
  "recovery_required",
]);
const NODE_STATUSES = new Set<WorkflowNodeCheckpointStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
const SIDE_EFFECTS = new Set<WorkflowSideEffect>(["none", "applied", "unknown"]);

export function sanitizeWorkflowCheckpoint(input: unknown): WorkflowCheckpoint {
  const checkpoint = record(input, "checkpoint");
  assertKeys(checkpoint, CHECKPOINT_KEYS, "checkpoint");
  if (checkpoint.version !== WORKFLOW_CHECKPOINT_VERSION) {
    throw new Error("checkpoint.version must be 1");
  }

  const conversationId = nonEmptyString(checkpoint.conversationId, "checkpoint.conversationId");
  const runId = nonEmptyString(checkpoint.runId, "checkpoint.runId");
  const planHash = nonEmptyString(checkpoint.planHash, "checkpoint.planHash");
  const revision = nonNegativeInteger(checkpoint.revision, "checkpoint.revision");
  const status = enumValue(checkpoint.status, CHECKPOINT_STATUSES, "checkpoint.status");
  const frontier = stringArray(checkpoint.frontier, "checkpoint.frontier");
  const executionOrder = stringArray(checkpoint.executionOrder, "checkpoint.executionOrder");
  const nodes = record(checkpoint.nodes, "checkpoint.nodes");
  const normalizedNodes: Record<string, WorkflowNodeCheckpoint> = {};
  for (const [nodeKey, rawNode] of Object.entries(nodes)) {
    const node = record(rawNode, `checkpoint.nodes.${nodeKey}`);
    assertKeys(node, NODE_KEYS, `checkpoint.nodes.${nodeKey}`);
    const normalized: WorkflowNodeCheckpoint = {
      nodeId: nonEmptyString(node.nodeId, `checkpoint.nodes.${nodeKey}.nodeId`),
      status: enumValue(node.status, NODE_STATUSES, `checkpoint.nodes.${nodeKey}.status`),
      inputHash: nonEmptyString(node.inputHash, `checkpoint.nodes.${nodeKey}.inputHash`),
      attempts: nonNegativeInteger(node.attempts, `checkpoint.nodes.${nodeKey}.attempts`),
      sideEffect: enumValue(node.sideEffect, SIDE_EFFECTS, `checkpoint.nodes.${nodeKey}.sideEffect`),
    };
    if (node.result !== undefined) normalized.result = normalizeResult(node.result, `checkpoint.nodes.${nodeKey}.result`);
    if (node.error !== undefined) normalized.error = normalizeError(node.error, `checkpoint.nodes.${nodeKey}.error`);
    normalizedNodes[nodeKey] = normalized;
  }

  const state = record(checkpoint.state, "checkpoint.state");
  assertKeys(state, STATE_KEYS, "checkpoint.state");
  const normalizedState = {
    step: nonNegativeInteger(state.step, "checkpoint.state.step"),
    version: nonNegativeInteger(state.version, "checkpoint.state.version"),
    values: record(state.values, "checkpoint.state.values"),
  };
  const unresolvedFailures = Array.isArray(checkpoint.unresolvedFailures)
    ? checkpoint.unresolvedFailures.map((value, index) => normalizeFailure(value, `checkpoint.unresolvedFailures[${index}]`))
    : (() => {
        throw new Error("checkpoint.unresolvedFailures must be an array");
      })();
  const updatedAt = nonNegativeInteger(checkpoint.updatedAt, "checkpoint.updatedAt");

  const normalized: WorkflowCheckpoint = {
    version: WORKFLOW_CHECKPOINT_VERSION,
    conversationId,
    runId,
    planHash,
    revision,
    status,
    frontier,
    executionOrder,
    nodes: normalizedNodes,
    state: normalizedState,
    unresolvedFailures,
    updatedAt,
  };
  assertJsonValue(normalized, "checkpoint");
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_WORKFLOW_CHECKPOINT_BYTES) {
    throw new Error(`checkpoint exceeds ${MAX_WORKFLOW_CHECKPOINT_BYTES} bytes`);
  }
  return JSON.parse(serialized) as WorkflowCheckpoint;
}

export function createPlanHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}

function normalizeResult(value: unknown, path: string): NonNullable<WorkflowNodeCheckpoint["result"]> {
  const result = record(value, path);
  assertKeys(result, RESULT_KEYS, path);
  const normalized: NonNullable<WorkflowNodeCheckpoint["result"]> = {
    status: nonEmptyString(result.status, `${path}.status`),
  };
  if (result.content !== undefined) normalized.content = stringValue(result.content, `${path}.content`);
  if (result.error !== undefined) normalized.error = stringValue(result.error, `${path}.error`);
  return normalized;
}

function normalizeError(value: unknown, path: string): NonNullable<WorkflowNodeCheckpoint["error"]> {
  const error = record(value, path);
  assertKeys(error, ERROR_KEYS, path);
  return {
    code: nonEmptyString(error.code, `${path}.code`),
    message: stringValue(error.message, `${path}.message`),
    retryable: booleanValue(error.retryable, `${path}.retryable`),
  };
}

function normalizeFailure(value: unknown, path: string): WorkflowCheckpointFailure {
  const failure = record(value, path);
  assertKeys(failure, FAILURE_KEYS, path);
  const normalized: WorkflowCheckpointFailure = {
    code: nonEmptyString(failure.code, `${path}.code`),
    message: stringValue(failure.message, `${path}.message`),
  };
  if (failure.nodeId !== undefined) normalized.nodeId = nonEmptyString(failure.nodeId, `${path}.nodeId`);
  return normalized;
}

function stableSerialize(value: unknown): string {
  assertJsonValue(value, "value");
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`)
    .join(",")}}`;
}

function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain finite JSON numbers`);
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a circular reference`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error(`${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error(`${path} contains a non-JSON key`);
      assertJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (result.length === 0) throw new Error(`${path} must not be empty`);
  return result;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`${path} contains an unsupported value`);
  return value as T;
}
