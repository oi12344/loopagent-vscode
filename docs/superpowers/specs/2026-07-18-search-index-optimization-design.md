# SuperPowers 代码搜索索引优化设计

> 状态：设计阶段
>
> 前置规格：
> - `2026-07-13-production-react-code-search-tool-design.md` — ReAct + exploreCode 工具架构
> - `2026-07-15-react-search-convergence-design.md` — 搜索证据充分性判断
>
> 本规格处理：SearchIndex 从内存实现 → 持久化 SQLite FTS，对标 CodeGraph 设计

## 背景

现有搜索索引实现的问题：

1. **内存重建**：SearchIndex 和 SemanticGraph 都是动态构建的内存 Map，工作区重启后丢失
2. **无差异计分**：所有 token 权重相同，无法区分"完全名称匹配"vs"路径碎片"
3. **分词过度**：camelCase 过度分割导致通用词（如"create"）太常见，混淆精确匹配
4. **缺少容错**：纯 token match，无模糊/前缀匹配降级，中文查询或拼写错误易失效
5. **串行扫描**：查询时遍历所有 Map，O(nodes) 复杂度，大型工作区卡顿

现状对比 CodeGraph：
| 特性 | 当前 | CodeGraph |
|------|------|-----------|
| 索引位置 | 内存 Map | SQLite 预构建 |
| 查询速度 | O(nodes) 遍历 | O(log N) 数据库查询 |
| 工作区重启 | 重新解析 | 直接加载 |
| 精度 | 无权重区分 | 多维度权重 |
| 容错能力 | 无 | FTS 模糊匹配 |

## 目标

1. **持久化搜索索引**：在 `.codegraph/` 中存储预构建的倒排索引，避免重启后重建
2. **精度改进**：区分"定义名称"、"路径"、"片段"的权重，提升精确匹配命中率
3. **容错能力**：支持前缀/模糊匹配，应对拼写错误和中文混合查询
4. **性能优化**：SQLite FTS5 查询替代内存遍历，O(log N) 而非 O(nodes)
5. **增量维护**：文件变化时只更新对应索引，而不重建全部 SearchIndex
6. **exploreCode 工具增强**：利用优化后的索引提升 ReAct 中的代码搜索精度

## 非目标

1. 不恢复向量搜索、embedding 或语义相似度计算
2. 不实现 IDE 级全局符号搜索（与 VS Code 内置功能无竞争）
3. 不增加模型调用次数或改变 ReAct maxSteps 限制
4. 不分支维护两套搜索路径（内存 vs SQLite）

## 架构

### 三层索引系统

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: 内存快速路径（可选，仅在需要时）                │
├─────────────────────────────────────────────────────────┤
│ SemanticGraph (内存 Map)                                 │
│  用途：图遍历、调用链追踪（buildCodeIntelligencePrompt） │
└─────────────────────────────────────────────────────────┘
                           ↓ 同步更新
┌─────────────────────────────────────────────────────────┐
│ Layer 2: SQLite 持久化索引（主查询路径）                 │
├─────────────────────────────────────────────────────────┤
│ .codegraph/code-index.sqlite                            │
│                                                          │
│ 表1: search_index_fts (FTS5 虚拟表)                     │
│  ├─ token: 搜索词（如"config", "builder", "run")       │
│  ├─ node_id: 符号唯一 ID                               │
│  ├─ node_name: 符号完整名称                            │
│  ├─ qualified_name: 带模块前缀的名称                    │
│  ├─ file_path: 文件相对路径                            │
│  ├─ node_kind: function|class|interface|variable       │
│  └─ weight: 权重分数（定义名=3, 路径=1, segment=0.5）  │
│                                                          │
│ 表2: search_node_metadata                              │
│  ├─ node_id: 符号 ID                                   │
│  ├─ kind: 符号类型                                     │
│  ├─ scope: global|local|parameter|import               │
│  ├─ file_priority: 项目内=1, node_modules=-1           │
│  └─ definition_match: 0|1 是否精确定义                 │
│                                                          │
│ 表3: file_metadata                                     │
│  ├─ file_uri: 文件唯一标识                             │
│  ├─ content_hash: SHA256 哈希                          │
│  └─ indexed_at: 最后索引时间                           │
│                                                          │
│ 索引：                                                   │
│  ├─ idx_token: (token) 主查询索引                      │
│  ├─ idx_node_id: (node_id) 反向查询                   │
│  └─ idx_file_path: (file_path) 文件级清理              │
└─────────────────────────────────────────────────────────┘
                           ↓ daemon 增量更新
┌─────────────────────────────────────────────────────────┐
│ Layer 3: 源数据持久化（已有）                           │
├─────────────────────────────────────────────────────────┤
│ code_chunks, nodes, edges (SQLite)                      │
│ 用途：全量数据备份，rebuild 时重新索引                 │
└─────────────────────────────────────────────────────────┘
```

### 查询流程

```
exploreCode(query)
  ↓
parse query tokens & normalize
  ├─ 中文检测 → 翻译或关键词提取
  └─ camelCase 处理 → 保留全名 + 分割片段
  ↓
SQL FTS 查询（三阶段）
  ├─ Stage 1: 精确名称匹配 (weight * 3)
  ├─ Stage 2: 前缀匹配降级 (weight * 1.5)
  └─ Stage 3: 模糊匹配降级 (weight * 0.5)
  ↓
返回前 12 结果，调用 buildCodeIntelligencePrompt 补充源码
```

## 模块职责

### 1. 索引存储层 — `src/extension/intelligence/storage/indexSchema.ts`

新增 FTS5 虚拟表和元数据表：

```typescript
// indexSchema.ts
export const SEARCH_INDEX_SCHEMA = `
  -- FTS5 虚拟表：快速全文搜索
  CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
    token,           -- 搜索词（已分词、小写）
    node_id UNINDEXED,
    node_name UNINDEXED,
    qualified_name UNINDEXED,
    file_path UNINDEXED,
    node_kind UNINDEXED,  -- function|class|interface|variable|...
    weight UNINDEXED      -- 权重：定义名=3, 路径=1, 段=0.5
  );

  -- 节点元数据：用于排序和过滤
  CREATE TABLE IF NOT EXISTS search_node_metadata(
    node_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT,           -- global|local|parameter
    file_priority INT,    -- 1=项目内, -1=dependencies
    definition_match INT, -- 0|1 是否为精确定义
    indexed_at INTEGER
  );

  -- 文件级别的索引状态
  CREATE TABLE IF NOT EXISTS search_file_metadata(
    file_uri TEXT PRIMARY KEY,
    content_hash TEXT,
    indexed_at INTEGER
  );

  -- 索引
  CREATE INDEX IF NOT EXISTS idx_search_token ON search_index_fts(token);
  CREATE INDEX IF NOT EXISTS idx_search_node_id ON search_index_fts(node_id);
`;
```

### 2. 索引构建层 — `src/extension/intelligence/storage/sqliteIndexStore.ts`

新增方法：

```typescript
export type SqliteIndexStore = {
  // 现有方法...
  
  // 新增：索引单个节点的 token
  indexNodeSearchTokens(
    node: SnapshotNode,
    fileUri: string,
    filePriority: number
  ): Promise<void>;

  // 新增：清理文件的所有索引
  clearFileSearchIndex(fileUri: string): Promise<void>;

  // 新增：执行搜索查询
  searchNodes(
    query: string,
    limit?: number
  ): Promise<SearchResult[]>;
};

export type SearchResult = {
  nodeId: string;
  nodeName: string;
  filePath: string;
  nodeKind: string;
  score: number;
};

// 实现
export class SqliteIndexStore {
  // ...现有代码...

  async indexNodeSearchTokens(
    node: SnapshotNode,
    fileUri: string,
    filePriority: number
  ): Promise<void> {
    const db = this.requireDatabase();
    const tokens = this.generateSearchTokens(node, fileUri);
    
    db.transaction(() => {
      // 清理旧索引
      db.prepare("DELETE FROM search_index_fts WHERE node_id = ?")
        .run(node.id);
      
      // 插入新 token
      for (const { token, weight } of tokens) {
        db.prepare(`
          INSERT INTO search_index_fts 
          (token, node_id, node_name, qualified_name, file_path, node_kind, weight)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          token,
          node.id,
          node.name,
          node.qualifiedName,
          node.filePath,
          node.kind,
          weight
        );
      }
      
      // 更新元数据
      db.prepare(`
        INSERT OR REPLACE INTO search_node_metadata
        (node_id, kind, scope, file_priority, indexed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        node.id,
        node.kind,
        "global",  // TODO: 从 AST 判断 scope
        filePriority,
        Date.now()
      );
    })();
  }

  private generateSearchTokens(
    node: SnapshotNode,
    fileUri: string
  ): Array<{ token: string; weight: number }> {
    const tokens: Array<{ token: string; weight: number }> = [];
    const seen = new Set<string>();

    // 1. 完整名称（权重=3）
    this.addToken(tokens, seen, node.name, 3, true);

    // 2. 名称分词（权重=0.5）
    for (const segment of createSearchTokens(node.name)) {
      this.addToken(tokens, seen, segment, 0.5, false);
    }

    // 3. 限定名分词（权重=1）
    for (const segment of createSearchTokens(node.qualifiedName)) {
      this.addToken(tokens, seen, segment, 1, false);
    }

    // 4. 文件路径分词（权重=0.3）
    for (const part of fileUri.split(/[\\/._-]+/)) {
      this.addToken(tokens, seen, part, 0.3, false);
    }

    return tokens;
  }

  private addToken(
    tokens: Array<{ token: string; weight: number }>,
    seen: Set<string>,
    text: string,
    baseWeight: number,
    isDefinition: boolean
  ): void {
    const normalized = text.toLowerCase().trim();
    if (normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    
    // 定义名称额外加权
    const weight = isDefinition ? baseWeight * 1.5 : baseWeight;
    tokens.push({ token: normalized, weight });
  }

  async searchNodes(query: string, limit = 12): Promise<SearchResult[]> {
    const db = this.requireDatabase();
    const queryTokens = createSearchTokens(query);
    
    if (queryTokens.length === 0) return [];

    // 构建 FTS WHERE 子句：token MATCH "word1 word2 ..."
    const matchClause = queryTokens.map(t => `token:${t}`).join(" OR ");
    
    const results = db.prepare(`
      SELECT 
        node_id,
        node_name,
        file_path,
        node_kind,
        SUM(weight) as score,
        file_priority,
        definition_match
      FROM search_index_fts
      LEFT JOIN search_node_metadata ON node_id = node_id
      WHERE token MATCH ?
      GROUP BY node_id
      ORDER BY score DESC, file_priority DESC
      LIMIT ?
    `).all(matchClause, limit) as SearchResult[];

    return results;
  }
}
```

### 3. 索引维护层 — `src/extension/intelligence/indexing/workspaceIndexer.ts`

在 `processFile` 中调用索引：

```typescript
async function processFile(fileUri: string): Promise<void> {
  // ...现有解析逻辑...

  const snapshot = buildExtractionSnapshot({...});
  
  // 应用快照到存储
  await deps.store.applyFileSnapshot(snapshot);
  
  // 🆕 更新搜索索引
  const filePriority = isNodeModulesPath(file.path) ? -1 : 1;
  for (const node of snapshot.nodes) {
    await deps.store.indexNodeSearchTokens(node, fileUri, filePriority);
  }
  
  // 更新文件元数据
  await deps.store.updateFileMetadata(metadata);
}
```

### 4. 查询适配层 — 修改 `WorkspaceIntelligence.buildCodeIntelligencePrompt`

现有逻辑保持，但改用 SQLite 搜索：

```typescript
// workspaceIntelligence.ts
export async function buildCodeIntelligencePrompt(query: string): Promise<string> {
  // 尝试 SQLite 持久化搜索
  if (persistentClient) {
    try {
      const searchResults = await persistentClient.searchNodes(query, 12);
      
      if (searchResults.length > 0) {
        // 从搜索结果获取完整节点，构建 Prompt
        return renderCodeIntelligencePrompt(searchResults);
      }
    } catch (error) {
      recordPersistentError(error);
    }
  }

  // 降级：内存搜索（兼容无 SQLite 的环境）
  return memoryIntelligence.buildCodeIntelligencePrompt(query);
}
```

### 5. 项目级目录结构 — 新增 `.codegraph/`

修改 `vscodeWorkspaceIntelligence.ts`：

```typescript
export function createVsCodeWorkspaceIntelligence(
  vscodeApi: VsCodeWorkspaceApi,
  options: CreateVsCodeWorkspaceIntelligenceOptions = {},
): WorkspaceIntelligence & { dispose(): Promise<void> } {
  // 改：从 storageUri（全局）→ projectRoot（项目级）
  const projectRoot = getWorkspaceRoot(vscodeApi.workspace.workspaceFolders);
  const indexDirectory = join(projectRoot, ".codegraph");
  
  // 确保 .gitignore 存在
  await initCodeGraphDirectory(indexDirectory);
  
  // 初始化 SQLite Worker Client
  persistentClient = createIndexClient?.() ?? createDefaultIndexClient();
  await persistentClient.initialize(
    join(indexDirectory, "code-index.sqlite"),
    ownerId
  );
  
  // ...其他代码...
}

async function initCodeGraphDirectory(codegraphDir: string): Promise<void> {
  await mkdir(codegraphDir, { recursive: true });
  
  const gitignorePath = join(codegraphDir, ".gitignore");
  const gitignoreContent = `# CodeGraph data files — local to each machine, not for committing.
# Ignore everything except this file itself.
*
!.gitignore
`;
  
  try {
    await writeFile(gitignorePath, gitignoreContent);
  } catch {
    // 文件可能已存在，忽略错误
  }
}
```

## ReAct 中的 exploreCode 工具增强

现有 `exploreCode` 工具（2026-07-13 设计）的调用链保持不变：

```
exploreCode(query)
  → WorkspaceIntelligence.buildCodeIntelligencePrompt(query)
    → [优化后] SQLite searchNodes()
    → [降级] memoryIntelligence (原有逻辑)
    → renderPersistedCodeIntelligencePrompt()
  → 返回 observation
```

**优化效果**：
- 精确搜索命中率 ↑（权重区分）
- 查询延迟 ↓（O(log N) vs O(nodes)）
- 大型工作区稳定性 ↑（不依赖内存）
- ReAct 收敛更快（第一轮搜索就找到关键符号）

## 测试与验证

### 单元测试

```typescript
// test/intelligence/searchIndexFts.test.ts

describe("SQLite FTS Search Index", () => {
  it("ranks definition names higher than segments", () => {
    // 搜索 "createConfiguredAgentRunner"
    // 预期：完整名称匹配权重最高
    expect(results[0].nodeName).toBe("createConfiguredAgentRunner");
  });

  it("supports prefix matching with weight penalty", () => {
    // 搜索 "createCon"
    // 预期：能找到 "createConfiguredAgentRunner"（前缀匹配）
    // 但排在完全匹配后面
    expect(results.some(r => r.nodeName === "createConfiguredAgentRunner")).toBe(true);
  });

  it("differentiates project code from node_modules", () => {
    // 搜索 "path" 可能在项目代码和依赖中都存在
    // 预期：项目代码优先
    expect(results[0].filePath).not.toMatch(/node_modules/);
  });

  it("handles Chinese query with fallback to pinyin/keyword", () => {
    // 搜索 "创建配置" (Chinese)
    // 预期：能找到 "createConfigured..." 相关符号
    // （或至少不返回空结果）
    expect(results.length).toBeGreaterThan(0);
  });

  it("persists across workspace reload", () => {
    // 索引建立后，关闭并重开工作区
    // 预期：SQLite 中的索引无损
    expect(reloadedIndex.search("test")).toEqual(originalIndex.search("test"));
  });
});
```

### 真实路径验证

在 Extension Development Host 中：

```
用户问题（中文）：
  "谁负责把代码上下文加入模型请求？"

模型第一轮搜索：
  exploreCode({ query: "providerRegistry buildCodeIntelligencePrompt system prompt" })
  
优化前结果：
  ❌ 因为 "build" 和 "prompt" 权重相同，可能混入无关结果
  
优化后结果：
  ✅ "buildCodeIntelligencePrompt" (完整名称匹配)
  ✅ "providerRegistry" (路径精确)
  ✅ 相关的 createConfiguredAgentRunner
  
模型基于 observation 立即给出答案，不需要第二轮搜索
```

## 性能基准（预期）

| 场景 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| 小项目 (<1K symbols) | 50ms 内存遍历 | 5ms SQL 查询 | **10x** |
| 中型项目 (10K symbols) | 500ms | 10ms | **50x** |
| 大型单体 (50K+ symbols) | 2000ms+ OOM 风险 | 20ms 稳定 | **100x+** |
| 工作区重启索引加载 | 1000ms 重建 | 100ms 直接加载 | **10x** |

## 交付边界

完成本规格后：

✅ SearchIndex 从内存动态构建 → SQLite 预构建持久化
✅ 搜索精度从无差异权重 → 三层权重区分  
✅ 项目索引从全局缓存 → `.codegraph/` 项目级隔离
✅ exploreCode 工具从 O(nodes) → O(log N) 查询
✅ 大型工作区从卡顿/OOM → 稳定快速

不承诺：
❌ 模型侧的智能（那是 2026-07-15 搜索收敛的职责）
❌ 向量相似度或语义搜索
❌ 全局符号索引（vs VS Code 内置）
❌ 超过 50K 符号的工作区支持（可后续扩展）

## 实施与原设计的差异

### 字段扩展（非破坏性）

`searchNodes()` 返回类型 `SearchNodeResult` 实际新增字段：
- `qualifiedName` — 带模块前缀的符号名称
- `kind` — 符号类型（function/class/interface/variable）
- `startLine`, `endLine` — 符号在源文件中的行号范围

原设计在 "索引存储层" 表描述中已列出这些字段，但返回类型定义中未记录。实现时为支持"精确符号匹配"渲染段（见下）而补充。

### 渲染层实际改动位置

原设计假定 `WorkspaceIntelligence.buildCodeIntelligencePrompt` 即可修改；实际改动位置是：
- `src/extension/intelligence/vscodeWorkspaceIntelligence.ts` — 双路径协调，SQLite + 降级
- `src/extension/intelligence/context/codeIntelligencePrompt.ts` — 新增"### 精确符号匹配"渲染段
- `src/extension/intelligence/workspaceIntelligence.ts` — **保持未改动**，纯内存降级路径

这是因为 `workspaceIntelligence.ts` 是内存降级专用、不涉及持久化的模块。修改点在包装层（vscodeWorkspaceIntelligence），保持隔离。

### P3.2 集成测试发现的 bug

集成测试过程中发现并修复：测试夹具 `createAsyncStore()` 缺失 `indexNodeSearchTokens()` 方法实现，导致文件元数据永不更新、文件被误判为"内容变化"而重复解析。修复见：
- `test/intelligence/testSupport/asyncSqliteStore.ts` — 完整的测试夹具实现
- `test/intelligence/workspaceIndexer.test.ts` — 改用共享夹具
- 连带修复 2 个既有测试失败（"reindexes unchanged files"、"keeps SQLite synchronized"）

### P4.1 性能基准实测 vs 预期

原设计"性能基准（预期）"表格预期 10K 符号 <10ms；实测 **~7ms**（标准差内）。

| 工作区规模 | 原设计预期 | P4.1 实测 | 改进幅度 |
|---------|--------|--------|--------|
| 1K 符号 | <5ms | ~2ms | 2.5x |
| 10K 符号 | <10ms | ~7ms | 1.4x |

SQLite FTS5 BM25 排序的有效性好于预期，精确匹配和前缀匹配定位迅速。

### P4.2 决策：保留内存降级

原设计 P4.2 列出两个选项（保留 vs 删除），最终决策：**保留内存降级，仅补充注释说明**。

理由：
1. 内存路径在实际工作中被活跃使用（非 writer、SQLite 失败、初始化延迟）
2. `getStatus()`/`getDiagnostics()` 始终由内存路径提供，与 SQLite 成功否无关
3. 风险表中两条缓解策略明确依赖"降级到内存路径"
4. 删除需要重写 4 个测试文件（>1000 行），收益不足

详见 `docs/superpowers/plans/2026-07-18-search-index-optimization-plan.md` 的 P4.2 节。

## 后续优化机会

1. **分布式索引**：大型单体仓库可按目录分片索引
2. **增量持久化**：只在退出时写 SQLite，内存中积累变化
3. **缓存预热**：CI 阶段预构建 `.codegraph/code-index.sqlite`，commit 到 git
4. **Query 优化器**：学习用户查询模式，重新排序 FTS 权重
