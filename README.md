# CodeMap · 代码地图

> 看清一个工程的结构 —— 每个功能的脉络，画成图。

**状态：方案阶段，尚无代码。**

## 这是什么

CodeMap 计划做成一个 MCP server + CLI，回答关于任意代码工程的三个问题，并且**画成图**：

1. 这个工程由哪些部分组成，怎么连起来的？（拓扑）
2. 每个功能的脉络是什么？入口在哪，经过哪些层，落到哪张表？（功能切片）
3. 哪些地方**没看清**？（诚实的覆盖度）

第 3 点是设计核心。任何代码分析都有盲区——反射、DI 容器、动态 import、字符串拼接的路由、预编译二进制依赖。不标注盲区的图是在误导使用者，尤其是 agent，它会基于不完整的图下错结论。

## 它不自己做解析

CodeMap 站在两个已有工具之上，自身是**编排 + 投影 + 渲染**层：

```
                     ┌──────────────────────────────┐
   agent ───MCP────► │          CodeMap             │
                     │  功能切片 / 运行时拓扑         │
                     │  聚合折叠 / 渲染 / 边界缝合    │
                     └──┬─────────────────────┬─────┘
                        │ 只读 SQLite          │ 子进程 --json
                   ┌────▼──────┐        ┌──────▼─────┐
                   │ codegraph │        │    rea     │
                   │  有源码侧  │        │  无源码侧   │
                   └───────────┘        └────────────┘
```

| 上游 | 角色 | 必需性 |
| --- | --- | --- |
| [codegraph](https://www.npmjs.com/package/@colbymchenry/codegraph) | 符号图、调用图、模块图（有源码） | **硬依赖** |
| [rea](https://github.com/morluto/rea) | 二进制、ASAR、wasm、.NET、APK 逆向（无源码） | 软依赖，按需 |

**一句话定位**：codegraph 给源码内的脉络，rea 跨过源码的边界，CodeMap 把两边缝成一张图并画出来。

单用 codegraph 画不出完整拓扑（边界会断且不告知），单用 rea 看不懂源码意图（本就不为源码设计）。两者的交集才是 CodeMap 的净增量。

## 规划中的净增量

| 能力 | 说明 |
| --- | --- |
| `codemap map` | 分层聚合 + 自动折叠，输出 Mermaid / Graphviz DOT / JSON。codegraph 目前完全不产出图形 |
| `codemap feature` | 功能切片：入口点 → 可达子图 → 分层脉络（路由→服务→仓储→表） |
| `codemap edges` | 外部边界清单：HTTP 出口 / DB / 原生插件 / wasm / 预编译包，并标注 rea 可否穿透 |
| `codemap pierce` | 对单个边界调 rea 穿透，结果并入图 |
| `codemap unknowns` | 聚合 codegraph 的未解析引用，诚实列出盲区分布 |

## 为什么盲区这件事值得单独做

在一个约 5,900 源文件的真实 Electron 工程上实测 codegraph 的索引：

```
nodes             109,456
edges             423,920
unresolved_refs   595,593     ← 未解析引用比已解析的边还多
```

`unresolved_refs` 本质上是上游自己记录的「我没解析出来的东西」，但目前没有任何工具把它暴露给使用者。不暴露，使用者就会默认图是完整的。

## 完整方案

→ [docs/CodeMap方案-v1.md](docs/CodeMap方案-v1.md)

13 节，含五层模型、边界缝合矩阵、依赖自举策略、功能切片算法、工具面定义、P0–P5 路线图、风险清单。

## 现状与下一步

当前仓库只有方案文档。路线图首个里程碑：

- **P0** 依赖自举（doctor / setup）+ SQLite 只读通道 + schema 版本护栏
- **P1** `codemap map` 出图 —— 这一步结束即有可交付价值

## 设计原则

- **绝不静默全局安装**。任何 `npm i -g` 都必须明示包名、版本、来源，等待用户确认。
- **绝不写上游数据**。只读打开 codegraph 的库，派生数据进自己的 `.codemap/`。
- **绝不在 MCP 内硬编码 LLM 调用**。只返回事实与证据，语义概括交给调用方 agent。
- **响应有 token 预算**。图不回灌上下文，一律先投影成有界视图。

## 致谢

- [codegraph](https://github.com/colbymchenry/codegraph) — 符号级知识图谱
- [REA](https://github.com/morluto/rea) — 逆向工程 MCP；其证据承载图模型与投影视图层设计是 CodeMap 的主要借鉴来源

## License

MIT
