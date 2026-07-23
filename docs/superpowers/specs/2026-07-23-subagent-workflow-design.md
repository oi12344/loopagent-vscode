# Subagent Workflow Engine Design

**Date:** 2026-07-23
**Status:** Design Phase
**Author:** Claude Code

## Overview

Enable the ReAct agent to dynamically decompose complex tasks into subtasks and spawn parallel subagents with automatic tool routing and dynamic dependency management. Subagents operate independently with their own execution context and message history, coordinated through a centralized workflow orchestrator.

## Requirements

### Functional
1. **Task Decomposition** — Main agent can decide to split a task and request subagent creation
2. **Automatic Tool Routing** — Each subagent receives a subset of tools matched to its task
3. **Dynamic Dependencies** — Subagent dependencies can be adjusted at runtime based on results
4. **Result Collection** — Main agent receives subagent results both in real-time (streaming) and complete (final collection)
5. **Tree-Structured UI Display** — Show hierarchical main → sub relationships with expand/collapse

### Non-Functional
- **Isolation** — Each subagent has independent message history and execution state
- **Backward Compatibility** — Existing `ReactAgentRunner` unchanged; workflow mode is opt-in
- **Performance** — Subagents run in parallel when dependencies allow
- **Observability** — All subagent events visible through event system

## Architecture

### High-Level Flow

```
Main Agent (ReAct)
    ↓ (detects need for parallelization)
    ↓ calls orchestrator.createSubagent()
WorkflowOrchestrator
    ├─ Manages DAG of dependencies
    ├─ Pools subagent instances
    ├─ Routes tools via ToolRouter
    └─ Emits WorkflowEvent stream
         ↓
    SubagentContext instances
    (each runs ReactAgentRunner independently)
         ↓
    Event: SubagentCompleted
         ↓
    Main agent receives result
    (decides next steps: spawn more, cancel, finalize)
```

### Core Components

#### 1. WorkflowOrchestrator

**Responsibility:** Coordinate subagent lifecycle, manage dependencies, emit events.

**State:**
- `subagentPool: Map<string, SubagentContext>` — Active subagents
- `dependencyGraph: Map<string, Set<string>>` — DAG: subagentId → IDs it depends on
- `readyQueue: Set<string>` — Subagents ready to run (all dependencies complete)
- `runningSubagents: Set<string>` — Currently executing

**Public API:**
```typescript
type WorkflowOrchestrator = {
  createSubagent(config: CreateSubagentConfig): Promise<string>;
  waitForSubagent(id: string): Promise<SubagentResult>;
  getResults(ids: string[]): Promise<Map<string, SubagentResult>>;
  cancelSubagent(id: string): void;
  onEvent(listener: (event: WorkflowEvent) => void): () => void;
};

type CreateSubagentConfig = {
  task: string;
  dependsOn?: string[];           // List of subagent IDs this depends on
  toolHints?: string[];           // Keywords to guide tool selection
  timeoutMs?: number;             // Default: 30000
};

type SubagentResult = {
  status: 'completed' | 'failed' | 'cancelled';
  content?: string;
  error?: string;
  toolCallCount?: number;         // Instrumentation
};
```

**Execution Algorithm:**
1. On `createSubagent()`: Add to pool, validate DAG (cycle detection), check if ready
2. On subagent ready: Start `ReactAgentRunner` in parallel
3. On `SubagentCompleted` event:
   - Update pool status
   - Notify waiting dependents
   - Emit event to main agent
4. On `getResults()`: Return completed results, buffer incomplete ones

#### 2. SubagentContext

**Stores per-subagent state:**
```typescript
type SubagentContext = {
  id: string;
  parentRunId: string;            // Trace back to main run
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  dependsOn: string[];
  assignedTools: ReactAgentTool[];
  messages: ReactAgentMessage[];
  result?: SubagentResult;
  startTime?: number;
  endTime?: number;
};
```

- Independent message history per subagent
- Passed to `ReactAgentRunner` as-is; runner doesn't know it's a subagent

#### 3. ToolRouter

**Input:** Task description + available tools
**Output:** Filtered tool subset

**Strategy:**
- Keyword-based heuristic: match tool description against task keywords
- Fallback: simple keyword overlap (e.g., if task contains "file" and tool is "readFile", include it)
- Reserve high-cost tools (e.g., `exploreCode` with large queries) for specific tool hints only

**Implementation:**
```typescript
type ToolRouter = {
  selectTools(task: string, availableTools: ReactAgentTool[], hints?: string[]): ReactAgentTool[];
};
```

#### 4. WorkflowEvent System

**Event Types:**
```typescript
type WorkflowEvent =
  | { type: 'SubagentCreated'; subagentId: string; task: string; dependsOn: string[] }
  | { type: 'SubagentRunning'; subagentId: string }
  | { type: 'SubagentEvent'; subagentId: string; message: HostToWebviewMessage }
  | { type: 'SubagentCompleted'; subagentId: string; result: SubagentResult }
  | { type: 'SubagentFailed'; subagentId: string; error: string }
  | { type: 'DependencyUnblocked'; subagentId: string };
```

- **Main → UI:** Events flow through `HostToWebviewMessage` stream (backward compatible)
- **Nesting:** `SubagentEvent` wraps the subagent's internal messages with subagent metadata

#### 5. DAG Validator

**On DAG creation/modification:**
- **Cycle Detection:** DFS before adding edges; throw if cycle detected
- **Max Depth:** Limit subagent nesting depth (e.g., 3) to prevent runaway spawning
- **Max Width:** Limit concurrent subagents (e.g., 10) to avoid resource exhaustion

---

## Data Flow

### Scenario: Main Agent Spawns Subagents

```
1. Main Agent step 20: "I need to analyze 5 files in parallel"
   → Calls: orchestrator.createSubagent({task: 'Analyze file A', toolHints: ['readFile', 'exploreCode']})
   → Returns: subagentId = "sub-1"

2. Orchestrator:
   - Create SubagentContext for sub-1
   - ToolRouter.selectTools('Analyze file A', ...) → [readFile, exploreCode]
   - Emit: WorkflowEvent { type: 'SubagentCreated', subagentId: 'sub-1', ... }
   - Start ReactAgentRunner for sub-1

3. UI updates: Show sub-1 node under main agent, status: "running"

4. Sub-1 runs: Calls readFile, exploreCode, reasoning happens
   → Emits: SubagentEvent messages (tool calls, etc.)
   → Orchestrator wraps them as WorkflowEvent and forwards

5. UI updates: Show sub-1's tool calls and reasoning in tree

6. Sub-1 completes: "Found 3 issues in file A"
   → Emit: WorkflowEvent { type: 'SubagentCompleted', subagentId: 'sub-1', result: {...} }

7. Main agent receives event, decides: "Create sub-2, sub-3, sub-4, sub-5 similarly"
   → Loop back to step 1 for each

8. After all 5 complete: Main agent calls orchestrator.getResults(['sub-1', ..., 'sub-5'])
   → Synthesize final answer
```

### Scenario: Dynamic Dependencies

```
Main agent: "Analyze code architecture"
├─ sub-A: Scan all files (no dependencies)
   ├─ Complete: Found 10 source files
├─ Main agent receives result
├─ Decides to analyze each file in parallel
├─ sub-B1 ~ sub-B10: Analyze file i (all depend on sub-A)
│  └─ Orchestrator queues them, waits for sub-A
├─ sub-A completes first
├─ Orchestrator unblocks sub-B1 ~ sub-B10, all start in parallel
└─ All B's complete in parallel → Main agent synthesizes
```

---

## UI Integration

### WebView Message Extension

**New message types** (existing types unchanged):
```typescript
type SubagentMessage =
  | { type: 'subagentCreated'; runId: string; subagentId: string; task: string; dependsOn: string[] }
  | { type: 'subagentStatusChanged'; runId: string; subagentId: string; status: string }
  | { type: 'subagentEvent'; runId: string; subagentId: string; message: HostToWebviewMessage }
  | { type: 'subagentCompleted'; runId: string; subagentId: string; result: SubagentResult };
```

### Tree Display

```
Main Agent [running] runId=run-123
├─ Sub-Agent-1 [completed] ✓
│  └─ Tool: exploreCode (...)
│  └─ Tool: readFile (...)
│  └─ Result: "Found 3 patterns"
├─ Sub-Agent-2 [running] ⟳
│  └─ Tool: exploreCode (executing)
└─ Sub-Agent-3 [waiting] ⏸
   └─ Depends on: Sub-Agent-1, Sub-Agent-2
```

- Click node to expand/collapse
- Dependencies shown as labels or subtle lines
- Right-click → Cancel subagent
- Virtual scrolling for many subagents

---

## Compatibility & Integration Points

### Changes to Existing Code

**`src/extension/agent/reactAgentRunner.ts`**
- No changes (it's called by orchestrator, unaware of workflow)

**`src/extension/agentRunner.ts`**
- Extend `StartAgentRunOptions` with optional `workflowMode?: boolean`
- If `workflowMode: true`, wrap `runner` with orchestrator

**`shared/messages.ts`**
- Add new `HostToWebviewMessage` union members for subagent events

**Webview UI**
- Extend message handler to support tree rendering
- Add node expand/collapse logic

### Backward Compatibility

- Default: `workflowMode: false` → existing behavior unchanged
- Existing tests pass without modification
- Opt-in feature flag

---

## Error Handling

### Failures

- **Subagent Timeout:** Emit `SubagentFailed`, main agent decides whether to retry/cancel
- **Circular Dependency:** Throw at `createSubagent()` time
- **Canceled Dependents:** If sub-A is canceled and sub-B depends on it, cancel sub-B immediately
- **Tool Routing Failure:** Fall back to empty tool set; subagent will report "no tools available"

### Limits

- Max subagents per run: 50
- Max nesting depth: 3
- Max concurrent subagents: 10 (others queue)
- Individual subagent timeout: 30s (configurable)

---

## Testing Strategy

### Unit Tests

- **WorkflowOrchestrator:**
  - Create subagent, verify pool entry
  - Dependency validation (cycle detection)
  - Ready queue progression
  - Event emission correctness

- **ToolRouter:**
  - Task → tool subset matching
  - Fallback behavior

- **DAG Validator:**
  - Cycle detection
  - Depth/width limits

### Integration Tests

- **End-to-End Workflow:**
  - Spawn subagents with dependencies
  - Verify parallel execution
  - Check result collection
  - Event stream integrity

### UI Tests (if applicable)

- Tree rendering with mock orchestrator
- Expand/collapse interaction
- Dependency line display

---

## Future Extensions

1. **Load Balancing:** Throttle subagent creation based on system load
2. **Adaptive Tool Selection:** Use LLM to pick tools instead of keyword matching
3. **Caching:** Memoize subagent results to avoid duplicate analysis
4. **Monitoring:** Export metrics (subagent duration, tool call counts, error rates)
5. **Subagent-to-Subagent Communication:** Allow direct message passing, not just through main agent

---

## Summary

The workflow engine is a thin coordination layer that:
- Spawns isolated `ReactAgentRunner` instances for each subagent
- Manages task dependencies as a DAG
- Routes tools based on task hints
- Emits events that both main agent and UI consume
- Requires minimal changes to existing code

The main agent controls when and how many subagents to spawn; the orchestrator handles the rest.
