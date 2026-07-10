# Embedding 与向量召回设计

> 状态：设计和实施计划已批准，等待执行。
>
> 父规格：`docs/superpowers/specs/2026-07-10-sqlite-vector-code-index-design.md`
>
> 实施计划：`docs/superpowers/plans/2026-07-11-sqlite-index-embedding-vector-plan.md`
>
> 前置规格：SQLite 检索与模型上下文。该规格已经定义可选 `VectorCandidateSource`。

## 目标

通过可配置 OpenAI-compatible provider 为稳定 card chunk 生成内容寻址 embedding，在 SQLite worker 中执行有界余弦扫描，并通过既有可选接口增强自然语言查询召回。

## 范围

1. provider-neutral `EmbeddingProvider`。
2. 显式配置、SecretStorage 密钥和 OpenAI-compatible HTTP provider。
3. pending/retry、内容寻址 cache 和模型切换协调。
4. worker 内批量余弦扫描和 top-k。
5. vector candidate 注入及 RRF 融合验证。

本规格不修改基础 exact/FTS/graph 语义，不加载 native vector 扩展，也不 embed 整文件。

## Provider 契约

```ts
type EmbeddingProvider = {
  readonly id: string;
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
};
```

provider 保持输入顺序，验证结果数量、连续 index、数值有限性和所有向量维度一致。错误不得包含 Authorization header、API key 或请求中的源码文本。

## 配置与密钥

workspace 配置：

```json
{
  "loopagent.codeIndex.embedding.enabled": false,
  "loopagent.codeIndex.embedding.baseUrl": "",
  "loopagent.codeIndex.embedding.model": ""
}
```

API key 只存 `SecretStorage` 的 `loopagent.codeIndex.embedding.apiKey`。enabled 为 false，或 baseUrl/model/key 任一缺失时，不创建 provider，并返回明确 disabled/diagnostic 状态。

不得复用聊天模型 API key，也不得把 embedding key 写入 settings、SQLite、普通日志或验证报告。

## OpenAI-Compatible 请求

endpoint 为规范化 `baseUrl + /embeddings`。请求包含 model 和批量 input，支持 `AbortSignal`。provider 必须处理：

- HTTP 非 2xx。
- 非 JSON 或 data 缺失。
- index 缺失、重复或不连续。
- 向量数量或维度不一致。
- timeout 和 abort。

错误信息只保留 endpoint host、HTTP status 和安全摘要。

## 内容寻址缓存

`embedding_cache` 的 key 是 `(provider, model, embedding_hash)`。相同 `embedding_text` 在代码移动、文件重命名或不同 chunk 间共享一个 vector blob。

`chunk_embeddings` 把 `(chunk_id, provider, model)` 映射到 embedding hash 和状态。状态至少包括 pending、ready、failed；claim/retry 语义必须能在崩溃后重新处理，不允许永久卡在内存状态。

chunk 的 embedding hash 变化时：

1. 当前模型映射改为 pending。
2. 旧 cache 保留供其他 chunk 使用。
3. 旧映射不参与召回。

未变化 hash 的 ready 映射保持 `updated_at` 和 cache 创建时间不变。

## Embedding Coordinator

coordinator 运行在 Extension Host，远程 HTTP 不占用 SQLite worker。每批流程：

1. 通过 RPC claim 有界数量 pending 映射。
2. 按 `(provider, model, embedding_hash)` 去重并取得 embedding text。
3. 批量调用 provider。
4. 通过单个 worker RPC 写 cache 并绑定所有 chunk。
5. 失败时增加 attempts、记录安全错误和下一次 retry 信息。

只有有效 writer lease 可以 claim 或提交 embedding。lease 丢失、dispose 或 abort 时停止新批次；已完成的 provider 结果若无法通过 lease 校验提交则丢弃并等待新 writer 重试。

模型变化只创建新模型的 pending 映射，不重新解析文件、不重写 snapshot，也不删除旧模型 cache。provider disabled 时不创建 pending 工作。

## 向量存储

vector 使用确定的 Float32 binary 编码并记录 dim。解码时验证 blob 长度等于 `dim * 4`，非有限值或维度不匹配视为损坏记录并跳过，同时记录诊断。

第一版不加载 `sqlite-vec`。对 native vector 扩展的评估属于后续独立决策，不能阻塞当前实现。

## Worker 内有界扫描

`VectorIndex` 只在数据库 worker 中运行：

```ts
type VectorSearchOptions = {
  limit: number;
  batchSize: number;
  maxCards: number;
};

type VectorSearchResult = {
  hits: RetrievalHit[];
  skippedReason?: "card_limit_exceeded";
  diagnostics: RetrievalDiagnostic[];
};
```

默认 batchSize 为 256，maxCards 为 20,000。扫描只覆盖当前 provider/model 下 ready 的 card chunk，不默认扫描 `source_body`。

worker 每批解码最多 batchSize 个向量，维护大小为 limit 的 top-k，不把向量传回 Extension Host。card 数超过 maxCards 时跳过扫描并返回 `skippedReason`，基础检索继续工作。

query vector 维度与存储 dim 不同的记录全部跳过并记录一次聚合诊断，不能在循环中刷日志。

## 注入 HybridRetriever

向量实现适配为检索规格定义的 `VectorCandidateSource`。融合仍使用检索规格的稳定 RRF；本规格只增加 vector rank，不改变 exact/FTS/graph 权重和 tie-break。

向量是候选入口，不是事实源。最终上下文仍来自持久化 node、edge 和 chunk source text。

## 失败与降级

- provider 未配置：不运行 coordinator，基础检索保持 ready。
- provider 暂时失败：映射保留 retry 信息，查询跳过向量。
- card 数超限：返回 skipped reason，不执行全量扫描。
- blob 损坏或 dim 不一致：跳过记录并诊断。
- lease 丢失：停止 claim/commit，不影响查询。
- vector 查询无命中：不添加 vector trace 来源。

任何向量失败都不得阻塞 exact、FTS、graph 或模型上下文生成。

## 验证

1. 重复 embedding hash 每批只调用 provider 一次并绑定多个 chunk。
2. 未变化映射保持 ready；只使 embedding hash 变化的 chunk pending。
3. provider/model 切换只创建新映射，不产生 snapshot 写入。
4. OpenAI-compatible provider 覆盖成功、HTTP 错误、协议错误、维度错误和 abort，错误不泄露 key。
5. 1,000 个向量按 256 批次扫描，内存中同时加载不超过 256 个并返回有界 top-k。
6. 超过 20,000 card 时跳过向量但基础检索仍通过。
7. 没有 provider 时检索阶段全部测试继续通过。
8. 注入 vector source 后 RRF 包含真实 vector hit，明确标识符 exact 优先级不被破坏。
9. lease 丢失后的 provider 结果不能由旧 writer 提交。

## 完成门禁

本规格完成后，中文和抽象自然语言查询可以获得可选语义候选；关闭或移除 embedding 配置不会破坏持久化基础检索。
