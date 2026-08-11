# 从零看懂 ReAct Agent:一个真实 VS Code 扩展的源码剖析(系列)

> 市面上讲 ReAct 的文章,要么停在论文的 `Thought/Action/Observation` 三行伪代码,要么甩一段 LangChain 调用就收工。这个系列不一样——我们钻进一个**真实、可运行、开源**的 AI 编码 Agent 内核,一行行源码看它怎么"边想边做"。

这些文章的代码全部来自我的开源项目 **[LoopAgent](https://github.com/oi12344/loopagent-vscode)**——一个把 AI Coding Agent 塞进 VS Code 的扩展。它的推理内核就是本系列的主角:一套**函数调用式的 ReAct 循环**,配上工作流编排、本地代码智能索引、视觉分析和长期记忆。

如果你读完觉得有意思,点个 Star 是对我最大的鼓励 → **https://github.com/oi12344/loopagent-vscode** ⭐

---

## 这个系列适合谁

- 想搞懂 AI Agent "自主决策—调用工具—看结果—再决策"到底是怎么转起来的;
- 用过 LangChain / AutoGPT,但对底层黑盒不满足,想看**没有框架糖衣**的裸实现;
- 正在自己造 Agent,想抄一套经过工程加固的循环骨架(熔断、去重、证据门禁……)。

不需要你懂 VS Code 扩展开发,也不需要读过 ReAct 原论文。会一点 TypeScript / JSON 就够。

---

## 系列目录(由浅入深)

| 篇目 | 标题 | 你会学到 |
|------|------|---------|
| **01** | 一个提问,AI 是怎么"边想边做"的? | 用"修一个登录超时 bug"的故事,建立 ReAct 的直觉——为什么 Agent 需要"想一步、做一步、看一眼"的循环 |
| **02** | 经典 ReAct 的"文本标签之痛" | 原论文的 `Thought:/Action:/Observation:` 文本范式为什么在生产里脆弱,函数调用式怎么解决 |
| **03** | 慢放一次完整的 ReAct 循环 | 把 `reactAgentRunner` 主循环拆成 6 帧,逐帧看消息如何在 system/user/assistant/tool 之间流动 |
| **04** | 一步发多个工具:多 tool_call 的格式 | 模型同时调用多个工具时,流式碎片如何靠 `index` 归位、如何并发执行、如何回填历史 |
| **05** | 让 Agent 不翻车的工程护栏 | 重复调用拦截、连续失败熔断、证据门禁、倒计时收尾——把 demo 变成能用的产品 |

建议按顺序读:01、02 是直觉和背景,03 是骨架,04、05 是把骨架变得健壮的血肉。

---

## 主角项目:LoopAgent 是什么

[LoopAgent](https://github.com/oi12344/loopagent-vscode) 是一个 **VS Code 扩展**,在你的编辑器侧边栏里放一个 AI 编码助手。和很多"套壳"不同,它的每一层都是自研、可读的 TypeScript:

- **函数调用式 ReAct 内核**(本系列主角)——推理与行动交替的循环,协议驱动而非文本解析;
- **本地代码智能索引**——SQLite FTS5 全文索引 + 内存降级双路径,10K 符号查询延迟 <10ms,让 Agent 秒级定位代码;
- **工作流编排**——把多个 Agent 步骤编成可复用的工作流,支持动态生成与失败恢复;
- **视觉分析**——能读你贴进来的截图/设计稿;
- **长期记忆**——跨会话记住你的偏好和项目上下文。

技术栈:TypeScript + VS Code Extension API + OpenAI 兼容协议(可接 DeepSeek 等)。

> ⭐ **喜欢就点个 Star:https://github.com/oi12344/loopagent-vscode**
> 欢迎提 Issue / PR,一起把开源的 Coding Agent 打磨得更好。

---

## 阅读约定

文中出现的 `文件路径:行号`(如 `reactAgentRunner.ts:118`)都指向仓库里的真实代码,你可以对照着读。所有源码片段都是从仓库直接摘录的,不是伪代码。

下一篇 → 01 · 一个提问,AI 是怎么"边想边做"的?
