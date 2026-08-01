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

export type WorkflowCheckpointRole = "explorer" | "reviewer" | "planner" | "executor";

export type WorkflowCheckpointOutputContract = {
  exactText?: string;
  requiredText?: string;
  requiredFields?: string[];
  minLength?: number;
};

export type WorkflowCheckpointCondition = {
  type: "always" | "onSuccess" | "onFailure" | "custom";
  expression?: string;
};

export type WorkflowNodeCheckpointDefinition = {
  task: string;
  role?: WorkflowCheckpointRole;
  toolHints?: string[];
  dependsOn: string[];
  timeoutMs?: number;
  sideEffect: WorkflowSideEffect;
  exportTo?: string;
  inputMapping?: Record<string, string>;
  condition?: WorkflowCheckpointCondition;
  retry?: { maxAttempts: number; backoffMs?: number };
  outputContract?: WorkflowCheckpointOutputContract;
};

export type WorkflowRecoveryDiagnostic = {
  nodeId: string;
  category: string;
  action?: string;
  reason?: string;
  timeoutMs?: number;
  error?: string;
};

export type WorkflowRecoveryAction =
  | "retry"
  | "replan"
  | "replace_node"
  | "replace_tool"
  | "switch_provider"
  | "reconcile_side_effect"
  | "compensate"
  | "request_input"
  | "wait_external";

export type WorkflowPendingRecovery = {
  action: WorkflowRecoveryAction;
  targetNodeId: string;
  reason: string;
  task?: string;
  role?: WorkflowCheckpointRole;
  contextFrom?: string[];
  timeoutMs?: number;
};

export type WorkflowDiagnosticLog = {
  kind: "assistant" | "tool" | "error";
  name?: string;
  message: string;
  succeeded?: boolean;
};

export type WorkflowFailureEvidence = {
  nodeId: string;
  task: string;
  input: Record<string, unknown>;
	outputContract?: WorkflowCheckpointOutputContract;
	error: string;
	attempt: number;
	recoveryAttempt: number;
	maxAttempts: number;
	timeoutMs?: number;
	logs: WorkflowDiagnosticLog[];
  sideEffect: WorkflowSideEffect;
};

export type WorkflowNodeCheckpoint = {
  nodeId: string;
  status: WorkflowNodeCheckpointStatus;
  inputHash: string;
  attempts: number;
  recoveryAttempts?: number;
  pendingRecovery?: WorkflowPendingRecovery;
  definition?: WorkflowNodeCheckpointDefinition;
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
	attempt?: number;
	timeoutMs?: number;
	logs?: WorkflowDiagnosticLog[];
  input?: Record<string, unknown>;
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
  recoveryDiagnostics?: WorkflowRecoveryDiagnostic[];
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
  "recoveryDiagnostics",
  "updatedAt",
]);
const NODE_KEYS = new Set(["nodeId", "status", "inputHash", "attempts", "recoveryAttempts", "pendingRecovery", "definition", "result", "error", "sideEffect"]);
const DEFINITION_KEYS = new Set(["task", "role", "toolHints", "dependsOn", "timeoutMs", "sideEffect", "exportTo", "inputMapping", "condition", "retry", "outputContract"]);
const DEFINITION_ROLES = new Set<WorkflowCheckpointRole>(["explorer", "reviewer", "planner", "executor"]);
const CONDITION_KEYS = new Set(["type", "expression"]);
const CONDITION_TYPES = new Set<WorkflowCheckpointCondition["type"]>(["always", "onSuccess", "onFailure", "custom"]);
const OUTPUT_CONTRACT_KEYS = new Set(["exactText", "requiredText", "requiredFields", "minLength"]);
const RETRY_KEYS = new Set(["maxAttempts", "backoffMs"]);
const RESULT_KEYS = new Set(["status", "content", "error"]);
const ERROR_KEYS = new Set(["code", "message", "retryable"]);
const STATE_KEYS = new Set(["step", "version", "values"]);
const FAILURE_KEYS = new Set(["nodeId", "code", "message", "attempt", "timeoutMs", "logs", "input"]);
const DIAGNOSTIC_LOG_KEYS = new Set(["kind", "name", "message", "succeeded"]);
const DIAGNOSTIC_LOG_KINDS = new Set<WorkflowDiagnosticLog["kind"]>(["assistant", "tool", "error"]);
const RECOVERY_DIAGNOSTIC_KEYS = new Set(["nodeId", "category", "action", "reason", "timeoutMs", "error"]);
const PENDING_RECOVERY_KEYS = new Set(["action", "targetNodeId", "reason", "task", "role", "contextFrom", "timeoutMs"]);
const RECOVERY_ACTIONS = new Set<WorkflowRecoveryAction>([
  "retry", "replan", "replace_node", "replace_tool", "switch_provider",
  "reconcile_side_effect", "compensate", "request_input", "wait_external",
]);
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
    if (node.recoveryAttempts !== undefined) {
      normalized.recoveryAttempts = nonNegativeInteger(node.recoveryAttempts, `checkpoint.nodes.${nodeKey}.recoveryAttempts`);
    }
    if (node.pendingRecovery !== undefined) normalized.pendingRecovery = normalizePendingRecovery(node.pendingRecovery, `checkpoint.nodes.${nodeKey}.pendingRecovery`);
    if (node.definition !== undefined) normalized.definition = normalizeNodeDefinition(node.definition, `checkpoint.nodes.${nodeKey}.definition`);
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
  const recoveryDiagnostics = checkpoint.recoveryDiagnostics === undefined
    ? undefined
    : Array.isArray(checkpoint.recoveryDiagnostics)
      ? checkpoint.recoveryDiagnostics.map((value, index) => normalizeRecoveryDiagnostic(value, `checkpoint.recoveryDiagnostics[${index}]`))
      : (() => {
          throw new Error("checkpoint.recoveryDiagnostics must be an array");
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
    ...(recoveryDiagnostics !== undefined && { recoveryDiagnostics }),
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

function normalizeNodeDefinition(value: unknown, path: string): WorkflowNodeCheckpointDefinition {
  const definition = record(value, path);
  assertKeys(definition, DEFINITION_KEYS, path);
  const normalized: WorkflowNodeCheckpointDefinition = {
    task: nonEmptyString(definition.task, `${path}.task`),
    dependsOn: stringArray(definition.dependsOn, `${path}.dependsOn`),
    sideEffect: enumValue(definition.sideEffect, SIDE_EFFECTS, `${path}.sideEffect`),
  };
  if (definition.role !== undefined) normalized.role = enumValue(definition.role, DEFINITION_ROLES, `${path}.role`);
  if (definition.toolHints !== undefined) normalized.toolHints = stringArray(definition.toolHints, `${path}.toolHints`);
  if (definition.timeoutMs !== undefined) normalized.timeoutMs = positiveInteger(definition.timeoutMs, `${path}.timeoutMs`);
  if (definition.exportTo !== undefined) normalized.exportTo = nonEmptyString(definition.exportTo, `${path}.exportTo`);
  if (definition.inputMapping !== undefined) normalized.inputMapping = stringRecord(definition.inputMapping, `${path}.inputMapping`);
  if (definition.condition !== undefined) {
    const condition = record(definition.condition, `${path}.condition`);
    assertKeys(condition, CONDITION_KEYS, `${path}.condition`);
    const type = enumValue(condition.type, CONDITION_TYPES, `${path}.condition.type`);
    const expression = condition.expression === undefined ? undefined : nonEmptyString(condition.expression, `${path}.condition.expression`);
    if (type === "custom" && expression === undefined) throw new Error(`${path}.condition.expression is required for custom conditions`);
    normalized.condition = { type, ...(expression !== undefined && { expression }) };
  }
  if (definition.retry !== undefined) {
    const retry = record(definition.retry, `${path}.retry`);
    assertKeys(retry, RETRY_KEYS, `${path}.retry`);
    normalized.retry = {
      maxAttempts: positiveInteger(retry.maxAttempts, `${path}.retry.maxAttempts`),
      ...(retry.backoffMs !== undefined && { backoffMs: nonNegativeInteger(retry.backoffMs, `${path}.retry.backoffMs`) }),
    };
  }
  if (definition.outputContract !== undefined) normalized.outputContract = normalizeOutputContract(definition.outputContract, `${path}.outputContract`);
  return normalized;
}

function normalizeOutputContract(value: unknown, path: string): WorkflowCheckpointOutputContract {
  const contract = record(value, path);
  assertKeys(contract, OUTPUT_CONTRACT_KEYS, path);
  const normalized: WorkflowCheckpointOutputContract = {};
  if (contract.exactText !== undefined) normalized.exactText = nonEmptyString(contract.exactText, `${path}.exactText`);
  if (contract.requiredText !== undefined) normalized.requiredText = nonEmptyString(contract.requiredText, `${path}.requiredText`);
  if (contract.requiredFields !== undefined) normalized.requiredFields = stringArray(contract.requiredFields, `${path}.requiredFields`);
  if (contract.minLength !== undefined) normalized.minLength = nonNegativeInteger(contract.minLength, `${path}.minLength`);
  if (normalized.exactText === undefined && normalized.requiredText === undefined && normalized.requiredFields === undefined && normalized.minLength === undefined) {
    throw new Error(`${path} must define exactText, requiredText, requiredFields, or minLength`);
  }
  return normalized;
}

function normalizeRecoveryDiagnostic(value: unknown, path: string): WorkflowRecoveryDiagnostic {
  const diagnostic = record(value, path);
  assertKeys(diagnostic, RECOVERY_DIAGNOSTIC_KEYS, path);
  const normalized: WorkflowRecoveryDiagnostic = {
    nodeId: nonEmptyString(diagnostic.nodeId, `${path}.nodeId`),
    category: nonEmptyString(diagnostic.category, `${path}.category`),
  };
  if (diagnostic.action !== undefined) normalized.action = nonEmptyString(diagnostic.action, `${path}.action`);
  if (diagnostic.reason !== undefined) normalized.reason = stringValue(diagnostic.reason, `${path}.reason`);
  if (diagnostic.timeoutMs !== undefined) normalized.timeoutMs = positiveInteger(diagnostic.timeoutMs, `${path}.timeoutMs`);
  if (diagnostic.error !== undefined) normalized.error = stringValue(diagnostic.error, `${path}.error`);
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
	if (failure.attempt !== undefined) normalized.attempt = nonNegativeInteger(failure.attempt, `${path}.attempt`);
	if (failure.timeoutMs !== undefined) normalized.timeoutMs = positiveInteger(failure.timeoutMs, `${path}.timeoutMs`);
  if (failure.logs !== undefined) {
    if (!Array.isArray(failure.logs)) throw new Error(`${path}.logs must be an array`);
    normalized.logs = failure.logs.map((log, index) => normalizeDiagnosticLog(log, `${path}.logs[${index}]`));
  }
  if (failure.input !== undefined) normalized.input = record(failure.input, `${path}.input`);
  return normalized;
}

function normalizeDiagnosticLog(value: unknown, path: string): WorkflowDiagnosticLog {
  const log = record(value, path);
  assertKeys(log, DIAGNOSTIC_LOG_KEYS, path);
  const kind = enumValue(log.kind, DIAGNOSTIC_LOG_KINDS, `${path}.kind`);
  const normalized: WorkflowDiagnosticLog = {
    kind,
    message: stringValue(log.message, `${path}.message`),
  };
  if (log.name !== undefined) normalized.name = nonEmptyString(log.name, `${path}.name`);
  if (log.succeeded !== undefined) normalized.succeeded = booleanValue(log.succeeded, `${path}.succeeded`);
  return normalized;
}

function normalizePendingRecovery(value: unknown, path: string): WorkflowPendingRecovery {
  const plan = record(value, path);
  assertKeys(plan, PENDING_RECOVERY_KEYS, path);
  const normalized: WorkflowPendingRecovery = {
    action: enumValue(plan.action, RECOVERY_ACTIONS, `${path}.action`),
    targetNodeId: nonEmptyString(plan.targetNodeId, `${path}.targetNodeId`),
    reason: stringValue(plan.reason, `${path}.reason`),
  };
  if (plan.task !== undefined) normalized.task = stringValue(plan.task, `${path}.task`);
  if (plan.role !== undefined) normalized.role = enumValue(plan.role, DEFINITION_ROLES, `${path}.role`);
  if (plan.contextFrom !== undefined) normalized.contextFrom = stringArray(plan.contextFrom, `${path}.contextFrom`);
  if (plan.timeoutMs !== undefined) normalized.timeoutMs = positiveInteger(plan.timeoutMs, `${path}.timeoutMs`);
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

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const recordValue = record(value, path);
  return Object.fromEntries(Object.entries(recordValue).map(([key, child]) => [key, stringValue(child, `${path}.${key}`)]));
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`${path} contains an unsupported value`);
  return value as T;
}
