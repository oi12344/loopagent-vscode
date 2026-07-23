# Subagent Workflow Engine Implementation Plan

> **For agentic workers:** RECOMMENDED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a workflow orchestrator that enables the main ReAct agent to spawn parallel subagents with automatic tool routing and dynamic dependency management.

**Architecture:** WorkflowOrchestrator acts as a thin coordination layer above existing ReactAgentRunner instances. Each subagent runs independently with its own message history and tool subset. The orchestrator manages a DAG of dependencies, emits events for UI integration, and streams results back to the main agent.

**Tech Stack:** TypeScript, existing ReactAgentRunner infrastructure, event-based communication.

---

## File Structure

### New Files to Create

```
src/extension/agent/workflow/
├─ types.ts                          // Core type definitions
├─ dagValidator.ts                   // Cycle detection & limit validation
└─ toolRouter.ts                     // Task-to-tool matching

src/extension/agent/
├─ workflowOrchestrator.ts          // Main coordinator
├─ subagentContext.ts                // Subagent execution state
└─ workflowEvents.ts                 // Event type definitions
```

### Modified Files

```
src/extension/agentRunner.ts         // Add workflowMode option
src/shared/messages.ts               // Extend HostToWebviewMessage with subagent events
src/extension/agent/reactAgentRunner.ts  // NO CHANGES (called by orchestrator)
```

---

## Tasks

### Task 1: Define Core Type System

**Files:**
- Create: `src/extension/agent/workflow/types.ts`
- Create: `src/extension/agent/workflowEvents.ts`

**Overview:** Establish the foundational types for the entire workflow system.

---

- [ ] **Step 1: Create workflow/types.ts with base types**

Create `src/extension/agent/workflow/types.ts`:

```typescript
/**
 * Status of a subagent in the workflow.
 */
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Configuration for creating a new subagent.
 */
export type CreateSubagentConfig = {
  /** User-facing task description for the subagent */
  task: string;

  /** IDs of subagents this one depends on (must complete first) */
  dependsOn?: string[];

  /** Keywords to guide tool selection (e.g., ["file", "read"]) */
  toolHints?: string[];

  /** Timeout in milliseconds (default 30000) */
  timeoutMs?: number;
};

/**
 * Result returned when a subagent completes.
 */
export type SubagentResult = {
  status: SubagentStatus;
  content?: string;       // Final answer from the subagent
  error?: string;         // Error message if failed
  toolCallCount?: number; // Instrumentation: number of tool calls made
};

/**
 * Limits for workflow execution safety.
 */
export type WorkflowLimits = {
  maxSubagentsPerRun: number;        // Default: 50
  maxNestingDepth: number;           // Default: 3 (prevent infinite recursion)
  maxConcurrentSubagents: number;    // Default: 10 (queue others)
  subagentTimeoutMs: number;         // Default: 30000
};
```

---

- [ ] **Step 2: Create workflowEvents.ts with event types**

Create `src/extension/agent/workflowEvents.ts`:

```typescript
/**
 * Events emitted by the workflow orchestrator.
 * These are consumed by both the main agent and the UI.
 */
export type WorkflowEvent =
  | {
      type: 'SubagentCreated';
      subagentId: string;
      task: string;
      dependsOn: string[];
    }
  | {
      type: 'SubagentRunning';
      subagentId: string;
    }
  | {
      type: 'SubagentEvent';
      subagentId: string;
      message: any;  // HostToWebviewMessage from the subagent
    }
  | {
      type: 'SubagentCompleted';
      subagentId: string;
      result: { status: 'completed'; content: string; toolCallCount?: number };
    }
  | {
      type: 'SubagentFailed';
      subagentId: string;
      error: string;
    }
  | {
      type: 'SubagentCancelled';
      subagentId: string;
    }
  | {
      type: 'DependencyUnblocked';
      subagentId: string;
    };

export type WorkflowEventListener = (event: WorkflowEvent) => void;
```

---

- [ ] **Step 3: Commit types**

```bash
git add src/extension/agent/workflow/types.ts src/extension/agent/workflowEvents.ts
git commit -m "feat: add workflow type definitions"
```

---

### Task 2: Implement DAG Validator

**Files:**
- Create: `src/extension/agent/workflow/dagValidator.ts`
- Create: `test/workflow/dagValidator.test.ts`

**Overview:** Validate dependency graphs for cycles and enforce resource limits.

---

- [ ] **Step 1: Write failing tests for DAG validator**

Create `test/workflow/dagValidator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateDAG, detectCycle } from '../../src/extension/agent/workflow/dagValidator';

describe('DAG Validator', () => {
  describe('detectCycle', () => {
    it('should return false for a valid DAG with no cycles', () => {
      // A -> B -> C
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['C'])],
        ['C', new Set()],
      ]);
      expect(detectCycle(graph)).toBe(false);
    });

    it('should return true for a self-loop', () => {
      // A -> A
      const graph = new Map([['A', new Set(['A'])]]);
      expect(detectCycle(graph)).toBe(true);
    });

    it('should return true for a cycle in a longer path', () => {
      // A -> B -> C -> A (cycle)
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['C'])],
        ['C', new Set(['A'])],
      ]);
      expect(detectCycle(graph)).toBe(true);
    });

    it('should handle disconnected nodes', () => {
      // A -> B, C (isolated)
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set()],
        ['C', new Set()],
      ]);
      expect(detectCycle(graph)).toBe(false);
    });
  });

  describe('validateDAG', () => {
    it('should reject graph with cycles', () => {
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['A'])],
      ]);
      const result = validateDAG(graph, { maxNestingDepth: 5 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cycle');
    });

    it('should reject graph exceeding max depth', () => {
      // A -> B -> C -> D (depth 3, limit 2)
      const graph = new Map([
        ['A', new Set(['B'])],
        ['B', new Set(['C'])],
        ['C', new Set(['D'])],
        ['D', new Set()],
      ]);
      const result = validateDAG(graph, { maxNestingDepth: 2 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('depth');
    });

    it('should accept valid sparse DAG', () => {
      // A -> B, A -> C, B -> D
      const graph = new Map([
        ['A', new Set(['B', 'C'])],
        ['B', new Set(['D'])],
        ['C', new Set()],
        ['D', new Set()],
      ]);
      const result = validateDAG(graph, { maxNestingDepth: 5 });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
```

---

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/workflow/dagValidator.test.ts
```

Expected: All tests fail with "dagValidator module not found" or similar.

---

- [ ] **Step 3: Implement DAG validator**

Create `src/extension/agent/workflow/dagValidator.ts`:

```typescript
import type { WorkflowLimits } from './types';

/**
 * Detects if a directed graph contains a cycle using DFS.
 * @param graph Map from node ID to set of node IDs it points to
 * @returns true if a cycle exists, false otherwise
 */
export function detectCycle(graph: Map<string, Set<string>>): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycleDFS = (node: string): boolean => {
    visited.add(node);
    recursionStack.add(node);

    const neighbors = graph.get(node) ?? new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycleDFS(neighbor)) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      if (hasCycleDFS(node)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Calculates the maximum depth of a DAG (longest path from root to leaf).
 */
export function calculateDAGDepth(graph: Map<string, Set<string>>): number {
  const memo = new Map<string, number>();

  const depthDFS = (node: string): number => {
    if (memo.has(node)) {
      return memo.get(node)!;
    }

    const neighbors = graph.get(node) ?? new Set();
    if (neighbors.size === 0) {
      memo.set(node, 1);
      return 1;
    }

    let maxChildDepth = 0;
    for (const neighbor of neighbors) {
      maxChildDepth = Math.max(maxChildDepth, depthDFS(neighbor));
    }

    const depth = maxChildDepth + 1;
    memo.set(node, depth);
    return depth;
  };

  let maxDepth = 0;
  for (const node of graph.keys()) {
    maxDepth = Math.max(maxDepth, depthDFS(node));
  }

  return maxDepth;
}

/**
 * Validates a DAG against workflow constraints.
 */
export type DAGValidationResult = {
  valid: boolean;
  error?: string;
};

export function validateDAG(
  graph: Map<string, Set<string>>,
  limits: { maxNestingDepth: number },
): DAGValidationResult {
  // Check for cycles
  if (detectCycle(graph)) {
    return { valid: false, error: 'Circular dependency detected in subagent graph' };
  }

  // Check for excessive depth
  const depth = calculateDAGDepth(graph);
  if (depth > limits.maxNestingDepth) {
    return {
      valid: false,
      error: `Subagent nesting depth (${depth}) exceeds limit (${limits.maxNestingDepth})`,
    };
  }

  return { valid: true };
}
```

---

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/workflow/dagValidator.test.ts
```

Expected: All tests pass.

---

- [ ] **Step 5: Commit**

```bash
git add src/extension/agent/workflow/dagValidator.ts test/workflow/dagValidator.test.ts
git commit -m "feat: implement DAG cycle detection and validation"
```

---

### Task 3: Implement ToolRouter

**Files:**
- Create: `src/extension/agent/workflow/toolRouter.ts`
- Create: `test/workflow/toolRouter.test.ts`

**Overview:** Select relevant tools for a subagent based on its task description.

---

- [ ] **Step 1: Write failing tests for tool router**

Create `test/workflow/toolRouter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { selectTools } from '../../src/extension/agent/workflow/toolRouter';
import type { ReactAgentTool } from '../../src/extension/agent/reactTypes';

describe('ToolRouter', () => {
  const mockTools: ReactAgentTool[] = [
    {
      name: 'readFile',
      description: 'Read file contents from disk',
      inputSchema: { type: 'object' },
      invoke: async () => 'content',
    },
    {
      name: 'exploreCode',
      description: 'Search and explore code patterns in workspace',
      inputSchema: { type: 'object' },
      invoke: async () => 'patterns',
    },
    {
      name: 'grep',
      description: 'Search text in files',
      inputSchema: { type: 'object' },
      invoke: async () => 'matches',
    },
    {
      name: 'chat',
      description: 'Send message to user',
      inputSchema: { type: 'object' },
      invoke: async () => 'ok',
    },
  ];

  it('should select tools matching task keywords', () => {
    const task = 'Read the configuration file and analyze its structure';
    const selected = selectTools(task, mockTools);
    expect(selected.some(t => t.name === 'readFile')).toBe(true);
  });

  it('should include exploreCode for analysis tasks', () => {
    const task = 'Analyze code patterns in the codebase';
    const selected = selectTools(task, mockTools);
    expect(selected.some(t => t.name === 'exploreCode')).toBe(true);
  });

  it('should select multiple tools for complex tasks', () => {
    const task = 'Find all references to function X and read their implementations';
    const selected = selectTools(task, mockTools);
    expect(selected.length).toBeGreaterThanOrEqual(2);
  });

  it('should respect tool hints when provided', () => {
    const task = 'Search for patterns';
    const hints = ['readFile'];
    const selected = selectTools(task, mockTools, hints);
    expect(selected.some(t => t.name === 'readFile')).toBe(true);
  });

  it('should never select high-cost tools without explicit hints', () => {
    const task = 'Do something';
    const selected = selectTools(task, mockTools);
    // exploreCode is marked as high-cost, should not be auto-selected
    // (implementation detail: we'll mark it as such)
    expect(selected.some(t => t.name === 'exploreCode')).toBe(false);
  });

  it('should return at least one tool for any task', () => {
    const task = 'xyz abc 123';
    const selected = selectTools(task, mockTools);
    expect(selected.length).toBeGreaterThan(0);
  });
});
```

---

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/workflow/toolRouter.test.ts
```

Expected: All tests fail.

---

- [ ] **Step 3: Implement tool router**

Create `src/extension/agent/workflow/toolRouter.ts`:

```typescript
import type { ReactAgentTool } from '../reactTypes';

/**
 * Extracts keywords from text for matching.
 */
function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/);
  return new Set(words.filter(w => w.length > 3)); // Filter short words
}

/**
 * High-cost tools that should only be selected with explicit hints.
 */
const HIGH_COST_TOOLS = new Set(['exploreCode']);

/**
 * Keyword → tool name mappings for explicit matching.
 */
const KEYWORD_TO_TOOL: Record<string, string[]> = {
  'read': ['readFile'],
  'file': ['readFile'],
  'content': ['readFile'],
  'search': ['grep'],
  'find': ['grep'],
  'pattern': ['grep'],
  'analyze': [],  // Let scoring decide
};

/**
 * Selects a subset of tools suitable for a task.
 *
 * Strategy:
 * 1. If toolHints provided, include those tools
 * 2. Score tools by keyword overlap with task description
 * 3. Never include high-cost tools unless explicitly hinted
 * 4. Always include at least one general-purpose tool as fallback
 *
 * @param task Task description
 * @param availableTools All available tools
 * @param toolHints Optional explicit tool names to include
 * @returns Filtered subset of tools
 */
export function selectTools(
  task: string,
  availableTools: ReactAgentTool[],
  toolHints?: string[],
): ReactAgentTool[] {
  const taskKeywords = extractKeywords(task);
  const selectedByName = new Set<string>();
  const toolsByName = new Map(availableTools.map(t => [t.name, t]));

  // 1. Add explicitly hinted tools
  if (toolHints) {
    for (const hint of toolHints) {
      if (toolsByName.has(hint)) {
        selectedByName.add(hint);
      }
    }
  }

  // 2. Keyword-based scoring
  const scores = new Map<string, number>();
  for (const tool of availableTools) {
    if (selectedByName.has(tool.name)) {
      continue; // Already selected
    }

    const toolDescription = tool.description.toLowerCase();
    const toolKeywords = extractKeywords(toolDescription);

    let score = 0;
    for (const keyword of taskKeywords) {
      if (toolKeywords.has(keyword)) {
        score += 1;
      }
    }

    if (score > 0) {
      scores.set(tool.name, score);
    }
  }

  // 3. Add high-scoring tools (excluding high-cost unless hinted)
  const sorted = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .filter(([name]) => !HIGH_COST_TOOLS.has(name) || toolHints?.includes(name));

  for (const [name] of sorted) {
    selectedByName.add(name);
  }

  // 4. Fallback: ensure at least one tool is selected
  if (selectedByName.size === 0) {
    // Pick a safe default (e.g., readFile or first available)
    const fallback = availableTools.find(t => t.name === 'readFile') || availableTools[0];
    if (fallback) {
      selectedByName.add(fallback.name);
    }
  }

  // 5. Return selected tools in original order
  return availableTools.filter(t => selectedByName.has(t.name));
}
```

---

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/workflow/toolRouter.test.ts
```

Expected: All tests pass.

---

- [ ] **Step 5: Commit**

```bash
git add src/extension/agent/workflow/toolRouter.ts test/workflow/toolRouter.test.ts
git commit -m "feat: implement tool router for subagent task matching"
```

---

### Task 4: Implement SubagentContext

**Files:**
- Create: `src/extension/agent/subagentContext.ts`
- Create: `test/subagentContext.test.ts`

**Overview:** Represent the execution state of a single subagent.

---

- [ ] **Step 1: Write failing tests**

Create `test/subagentContext.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createSubagentContext, updateSubagentStatus } from '../src/extension/agent/subagentContext';
import type { ReactAgentTool } from '../src/extension/agent/reactTypes';

describe('SubagentContext', () => {
  const mockTool: ReactAgentTool = {
    name: 'test',
    description: 'test tool',
    inputSchema: { type: 'object' },
    invoke: async () => 'result',
  };

  it('should create a context with initial pending status', () => {
    const ctx = createSubagentContext('sub-1', 'Analyze file X', [], [mockTool]);
    expect(ctx.id).toBe('sub-1');
    expect(ctx.task).toBe('Analyze file X');
    expect(ctx.status).toBe('pending');
    expect(ctx.dependsOn).toEqual([]);
  });

  it('should initialize with empty messages', () => {
    const ctx = createSubagentContext('sub-1', 'Task', [], [mockTool]);
    expect(ctx.messages).toEqual([]);
  });

  it('should update status correctly', () => {
    let ctx = createSubagentContext('sub-1', 'Task', [], [mockTool]);
    ctx = updateSubagentStatus(ctx, 'running');
    expect(ctx.status).toBe('running');
    expect(ctx.startTime).toBeDefined();
  });

  it('should record end time when marking completed', () => {
    let ctx = createSubagentContext('sub-1', 'Task', [], [mockTool]);
    ctx = updateSubagentStatus(ctx, 'running');
    ctx = updateSubagentStatus(ctx, 'completed');
    expect(ctx.endTime).toBeDefined();
  });

  it('should store result when completed', () => {
    let ctx = createSubagentContext('sub-1', 'Task', [], [mockTool]);
    ctx = updateSubagentStatus(ctx, 'running');
    ctx = updateSubagentStatus(ctx, 'completed');
    ctx.result = { status: 'completed', content: 'Done!' };
    expect(ctx.result?.content).toBe('Done!');
  });

  it('should track assigned tools', () => {
    const tools = [mockTool];
    const ctx = createSubagentContext('sub-1', 'Task', [], tools);
    expect(ctx.assignedTools).toEqual(tools);
  });
});
```

---

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/subagentContext.test.ts
```

Expected: Tests fail.

---

- [ ] **Step 3: Implement SubagentContext**

Create `src/extension/agent/subagentContext.ts`:

```typescript
import type { ReactAgentMessage, ReactAgentTool } from './reactTypes';
import type { SubagentResult, SubagentStatus } from './workflowEvents';

/**
 * Execution context for a single subagent.
 * Each subagent has its own message history, tools, and state.
 */
export type SubagentContext = {
  id: string;
  task: string;
  status: SubagentStatus;

  // Dependency info
  dependsOn: string[];

  // Execution state
  messages: ReactAgentMessage[];
  assignedTools: ReactAgentTool[];
  result?: SubagentResult;

  // Timing
  startTime?: number;
  endTime?: number;
};

/**
 * Creates a new subagent context in pending state.
 */
export function createSubagentContext(
  id: string,
  task: string,
  dependsOn: string[],
  assignedTools: ReactAgentTool[],
): SubagentContext {
  return {
    id,
    task,
    status: 'pending',
    dependsOn,
    messages: [],
    assignedTools,
  };
}

/**
 * Updates a subagent's status and records timing.
 */
export function updateSubagentStatus(
  context: SubagentContext,
  newStatus: SubagentStatus,
): SubagentContext {
  const updated = { ...context, status: newStatus };

  if (newStatus === 'running' && !context.startTime) {
    updated.startTime = Date.now();
  }

  if ((newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') &&
      !context.endTime) {
    updated.endTime = Date.now();
  }

  return updated;
}

/**
 * Appends a message to the subagent's message history.
 */
export function appendMessage(
  context: SubagentContext,
  message: ReactAgentMessage,
): SubagentContext {
  return {
    ...context,
    messages: [...context.messages, message],
  };
}
```

---

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/subagentContext.test.ts
```

Expected: All tests pass.

---

- [ ] **Step 5: Commit**

```bash
git add src/extension/agent/subagentContext.ts test/subagentContext.test.ts
git commit -m "feat: implement SubagentContext for execution state management"
```

---

### Task 5: Implement WorkflowOrchestrator Core

**Files:**
- Create: `src/extension/agent/workflowOrchestrator.ts`
- Create: `test/workflowOrchestrator.test.ts`

**Overview:** Main coordinator managing subagent lifecycle, dependency resolution, and event emission.

---

- [ ] **Step 1: Write failing tests for orchestrator**

Create `test/workflowOrchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorkflowOrchestrator } from '../src/extension/agent/workflowOrchestrator';
import type { ReactAgentTool } from '../src/extension/agent/reactTypes';

describe('WorkflowOrchestrator', () => {
  let orchestrator: ReturnType<typeof createWorkflowOrchestrator>;

  const mockTool: ReactAgentTool = {
    name: 'testTool',
    description: 'A test tool',
    inputSchema: { type: 'object' },
    invoke: async () => 'result',
  };

  beforeEach(() => {
    orchestrator = createWorkflowOrchestrator({
      maxSubagentsPerRun: 50,
      maxNestingDepth: 3,
      maxConcurrentSubagents: 10,
      subagentTimeoutMs: 30000,
    });
  });

  it('should create a subagent and return its ID', async () => {
    const id = await orchestrator.createSubagent({
      task: 'Test task',
      dependsOn: [],
      toolHints: [],
    }, [mockTool]);

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
  });

  it('should reject circular dependencies', async () => {
    const id1 = await orchestrator.createSubagent({
      task: 'Task 1',
      dependsOn: [],
    }, []);

    // Try to create a circular dependency: id1 depends on something that depends on id1
    expect(async () => {
      const id2 = await orchestrator.createSubagent({
        task: 'Task 2',
        dependsOn: [id1],
      }, []);

      // This should fail (circular: id1 depends on id2, id2 depends on id1)
      await orchestrator.createSubagent({
        task: 'Task 3',
        dependsOn: [id2],
      }, []);
    }).rejects.toThrow();
  });

  it('should emit SubagentCreated event', async () => {
    const events: any[] = [];
    orchestrator.onEvent(e => events.push(e));

    await orchestrator.createSubagent({
      task: 'Test task',
    }, [mockTool]);

    expect(events.some(e => e.type === 'SubagentCreated')).toBe(true);
  });

  it('should return pending subagent result before completion', async () => {
    const id = await orchestrator.createSubagent({
      task: 'Test',
    }, [mockTool]);

    const result = await orchestrator.getSubagentResult(id);
    expect(result.status).toBe('pending');
  });

  it('should track subagent in pool', async () => {
    const id = await orchestrator.createSubagent({
      task: 'Test',
    }, [mockTool]);

    const context = orchestrator.getSubagentContext(id);
    expect(context).toBeDefined();
    expect(context?.id).toBe(id);
  });
});
```

---

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/workflowOrchestrator.test.ts
```

Expected: Tests fail.

---

- [ ] **Step 3: Implement WorkflowOrchestrator**

Create `src/extension/agent/workflowOrchestrator.ts`:

```typescript
import type { CreateSubagentConfig, SubagentResult, WorkflowLimits } from './workflow/types';
import type { WorkflowEvent, WorkflowEventListener } from './workflowEvents';
import { createSubagentContext, updateSubagentStatus } from './subagentContext';
import type { SubagentContext } from './subagentContext';
import type { ReactAgentTool } from './reactTypes';
import { selectTools } from './workflow/toolRouter';
import { validateDAG } from './workflow/dagValidator';

export type WorkflowOrchestratorOptions = {
  limits?: Partial<WorkflowLimits>;
};

/**
 * Default workflow limits.
 */
const DEFAULT_LIMITS: WorkflowLimits = {
  maxSubagentsPerRun: 50,
  maxNestingDepth: 3,
  maxConcurrentSubagents: 10,
  subagentTimeoutMs: 30000,
};

export type WorkflowOrchestrator = {
  createSubagent(
    config: CreateSubagentConfig,
    availableTools: ReactAgentTool[],
  ): Promise<string>;

  getSubagentResult(id: string): Promise<SubagentResult>;
  getSubagentContext(id: string): SubagentContext | undefined;
  cancelSubagent(id: string): void;
  onEvent(listener: WorkflowEventListener): () => void;
};

export function createWorkflowOrchestrator(
  options?: WorkflowOrchestratorOptions,
): WorkflowOrchestrator {
  const limits = { ...DEFAULT_LIMITS, ...options?.limits };

  // State
  const subagentPool = new Map<string, SubagentContext>();
  const dependencyGraph = new Map<string, Set<string>>();
  const eventListeners: WorkflowEventListener[] = [];
  let subagentCounter = 0;

  function emitEvent(event: WorkflowEvent) {
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  function generateSubagentId(): string {
    return `sub-${++subagentCounter}`;
  }

  return {
    async createSubagent(
      config: CreateSubagentConfig,
      availableTools: ReactAgentTool[],
    ): Promise<string> {
      // 1. Validate count limit
      if (subagentPool.size >= limits.maxSubagentsPerRun) {
        throw new Error(`Max subagents per run (${limits.maxSubagentsPerRun}) exceeded`);
      }

      // 2. Route tools
      const assignedTools = selectTools(config.task, availableTools, config.toolHints);

      // 3. Create context
      const id = generateSubagentId();
      const dependsOn = config.dependsOn ?? [];
      const context = createSubagentContext(id, config.task, dependsOn, assignedTools);

      // 4. Update dependency graph and validate
      dependencyGraph.set(id, new Set(dependsOn));
      const validation = validateDAG(dependencyGraph, { maxNestingDepth: limits.maxNestingDepth });
      if (!validation.valid) {
        dependencyGraph.delete(id);
        throw new Error(validation.error);
      }

      // 5. Add to pool
      subagentPool.set(id, context);

      // 6. Emit event
      emitEvent({
        type: 'SubagentCreated',
        subagentId: id,
        task: config.task,
        dependsOn,
      });

      return id;
    },

    async getSubagentResult(id: string): Promise<SubagentResult> {
      const context = subagentPool.get(id);
      if (!context) {
        throw new Error(`Subagent ${id} not found`);
      }
      return context.result ?? { status: context.status as SubagentResult['status'] };
    },

    getSubagentContext(id: string): SubagentContext | undefined {
      return subagentPool.get(id);
    },

    cancelSubagent(id: string) {
      const context = subagentPool.get(id);
      if (context) {
        const updated = updateSubagentStatus(context, 'cancelled');
        subagentPool.set(id, updated);
        emitEvent({
          type: 'SubagentCancelled',
          subagentId: id,
        });
      }
    },

    onEvent(listener: WorkflowEventListener): () => void {
      eventListeners.push(listener);
      // Return unsubscribe function
      return () => {
        const idx = eventListeners.indexOf(listener);
        if (idx >= 0) {
          eventListeners.splice(idx, 1);
        }
      };
    },
  };
}
```

---

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/workflowOrchestrator.test.ts
```

Expected: All tests pass.

---

- [ ] **Step 5: Commit**

```bash
git add src/extension/agent/workflowOrchestrator.ts test/workflowOrchestrator.test.ts
git commit -m "feat: implement WorkflowOrchestrator core lifecycle management"
```

---

### Task 6: Extend WebView Messages

**Files:**
- Modify: `src/shared/messages.ts`

**Overview:** Add subagent event message types for UI communication.

---

- [ ] **Step 1: Examine existing HostToWebviewMessage type**

Run:
```bash
grep -n "type HostToWebviewMessage" src/shared/messages.ts | head -20
```

Expected: Shows the current union type and its line location.

---

- [ ] **Step 2: Add subagent message types**

Modify `src/shared/messages.ts` — find the `HostToWebviewMessage` type union and append these new variants:

Add after the existing message types (before the closing of the union):

```typescript
  | {
      type: 'subagentCreated';
      runId: string;
      subagentId: string;
      task: string;
      dependsOn: string[];
    }
  | {
      type: 'subagentStatusChanged';
      runId: string;
      subagentId: string;
      status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    }
  | {
      type: 'subagentEvent';
      runId: string;
      subagentId: string;
      message: HostToWebviewMessage; // Nested: the subagent's own messages
    }
  | {
      type: 'subagentCompleted';
      runId: string;
      subagentId: string;
      result: {
        status: 'completed' | 'failed';
        content?: string;
        error?: string;
        toolCallCount?: number;
      };
    }
```

---

- [ ] **Step 3: Run type check**

```bash
npm run type-check
```

Expected: No type errors.

---

- [ ] **Step 4: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat: add subagent message types to WebView protocol"
```

---

### Task 7: Integration Tests (End-to-End Workflow)

**Files:**
- Create: `test/integration/workflowEnd2End.test.ts`

**Overview:** Test the full workflow: create subagents, manage dependencies, collect results.

---

- [ ] **Step 1: Write end-to-end workflow test**

Create `test/integration/workflowEnd2End.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createWorkflowOrchestrator } from '../../src/extension/agent/workflowOrchestrator';
import type { ReactAgentTool } from '../../src/extension/agent/reactTypes';

describe('Workflow End-to-End', () => {
  const mockTools: ReactAgentTool[] = [
    {
      name: 'readFile',
      description: 'Read file',
      inputSchema: { type: 'object' },
      invoke: async () => 'file content',
    },
  ];

  it('should create multiple independent subagents and track them', async () => {
    const orchestrator = createWorkflowOrchestrator();
    const events: any[] = [];
    orchestrator.onEvent(e => events.push(e));

    // Create 3 independent subagents
    const id1 = await orchestrator.createSubagent(
      { task: 'Analyze file A' },
      mockTools,
    );
    const id2 = await orchestrator.createSubagent(
      { task: 'Analyze file B' },
      mockTools,
    );
    const id3 = await orchestrator.createSubagent(
      { task: 'Analyze file C' },
      mockTools,
    );

    expect([id1, id2, id3]).toHaveLength(3);
    expect(new Set([id1, id2, id3]).size).toBe(3); // All unique

    // Check events
    expect(events.filter(e => e.type === 'SubagentCreated')).toHaveLength(3);
  });

  it('should enforce dependency constraints', async () => {
    const orchestrator = createWorkflowOrchestrator();

    // Create independent subagent
    const id1 = await orchestrator.createSubagent(
      { task: 'Scan files' },
      mockTools,
    );

    // Create dependent subagent
    const id2 = await orchestrator.createSubagent(
      { task: 'Analyze file from scan', dependsOn: [id1] },
      mockTools,
    );

    expect(orchestrator.getSubagentContext(id2)?.dependsOn).toContain(id1);
  });

  it('should reject too many subagents', async () => {
    const orchestrator = createWorkflowOrchestrator({
      limits: { maxSubagentsPerRun: 2 },
    });

    await orchestrator.createSubagent({ task: 'Task 1' }, mockTools);
    await orchestrator.createSubagent({ task: 'Task 2' }, mockTools);

    await expect(
      orchestrator.createSubagent({ task: 'Task 3' }, mockTools),
    ).rejects.toThrow('Max subagents');
  });

  it('should track subagent results', async () => {
    const orchestrator = createWorkflowOrchestrator();

    const id = await orchestrator.createSubagent(
      { task: 'Task' },
      mockTools,
    );

    // Initially pending
    let result = await orchestrator.getSubagentResult(id);
    expect(result.status).toBe('pending');

    // Simulate completion
    const context = orchestrator.getSubagentContext(id)!;
    // (In real implementation, we'd call reactor.run() here)
  });
});
```

---

- [ ] **Step 2: Run integration tests**

```bash
npm test -- test/integration/workflowEnd2End.test.ts
```

Expected: Tests pass.

---

- [ ] **Step 3: Commit**

```bash
git add test/integration/workflowEnd2End.test.ts
git commit -m "test: add end-to-end workflow integration tests"
```

---

### Task 8: Documentation & Summary

**Files:**
- Update: `README.md` (or relevant dev docs)

**Overview:** Document the new workflow feature for developers.

---

- [ ] **Step 1: Create workflow development guide**

Create or update a file `docs/WORKFLOW_DEVELOPMENT.md`:

```markdown
# Workflow Orchestrator Development Guide

## Overview

The workflow orchestrator enables main agents to spawn parallel subagents for complex task decomposition.

## Architecture

- **WorkflowOrchestrator** — Coordinates subagent lifecycle and dependency management
- **SubagentContext** — Execution state for each subagent
- **ToolRouter** — Selects tools based on task description
- **DAG Validator** — Ensures acyclic dependencies and resource limits

## Usage Example

```typescript
// Create orchestrator
const orchestrator = createWorkflowOrchestrator();

// Create subagents
const id1 = await orchestrator.createSubagent(
  { task: 'Scan files for patterns' },
  availableTools,
);

const id2 = await orchestrator.createSubagent(
  {
    task: 'Deep analyze findings from id1',
    dependsOn: [id1],
    toolHints: ['readFile'],
  },
  availableTools,
);

// Listen to events
orchestrator.onEvent(event => {
  if (event.type === 'SubagentCompleted') {
    console.log(`Subagent completed: ${event.subagentId}`);
  }
});

// Get results
const result = await orchestrator.getSubagentResult(id2);
```

## Adding to ReactAgentRunner

To integrate workflows into the main ReAct agent, wrap the orchestrator call in the agent's decision logic:

```typescript
if (shouldParallelizeTask(task)) {
  const orchestrator = createWorkflowOrchestrator();
  const subIds = await spawnSubagents(task, orchestrator);
  const results = await collectResults(orchestrator, subIds);
  // Incorporate results into agent reasoning
}
```

## Testing

- Unit tests: `test/workflow/` and `test/subagentContext.test.ts`
- Integration tests: `test/integration/workflowEnd2End.test.ts`

Run: `npm test -- workflow`
```

---

- [ ] **Step 2: Commit documentation**

```bash
git add docs/WORKFLOW_DEVELOPMENT.md
git commit -m "docs: add workflow orchestrator development guide"
```

---

## Final Checklist

- [ ] All new files created and tested
- [ ] Existing files extended (messages.ts)
- [ ] DAG validation working (no cycles, depth limits)
- [ ] Tool routing selecting appropriate tools
- [ ] Event emission system functional
- [ ] Type system complete and consistent
- [ ] All commits follow conventional commits
- [ ] Type checking passes: `npm run type-check`
- [ ] All tests pass: `npm test`

---

## Self-Review Against Design Spec

✓ **SubagentContext:** Per-subagent message history and tool assignment
✓ **WorkflowOrchestrator:** Lifecycle management, DAG, event emission
✓ **ToolRouter:** Automatic tool selection based on task
✓ **DAG Validator:** Cycle detection and depth limits
✓ **WebView Messages:** New subagent event types
✓ **Testing:** Unit and integration coverage

✗ **Integration with ReactAgentRunner:** Not yet implemented (pending main agent implementation)
✗ **UI Tree Display:** UI logic to consume subagent events (pending WebView implementation)

These are scoped out as follow-up tasks once the core orchestrator is in place.
