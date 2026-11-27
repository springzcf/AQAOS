<div align="center">

# 🐝 QA-Swarm

**开源版"QA 界的 Devin"——一个 AI 智能体蜂群:探索你的应用、编写测试、执行测试、分诊失败、提交缺陷、构建回归测试集,全程几乎无需人工介入。**

给它一个 URL 或一份 OpenAPI 规范,它会还你一堆测试、缺陷和证据。

[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg)](https://www.typescriptlang.org/)
[![playwright](https://img.shields.io/badge/Playwright-1.49-2EAD33.svg)](https://playwright.dev)
[![langgraph](https://img.shields.io/badge/LangGraph-0.2-1C3C3C.svg)](https://github.com/langchain-ai/langgraph)

</div>

---

## 📋 目录

- [它能做什么](#-它能做什么)
- [为什么选择 QA-Swarm](#-为什么选择-qa-swarm)
- [架构](#-架构)
- [快速开始](#-快速开始)
- [智能体](#-智能体)
- [控制面板](#-控制面板)
- [CLI 参考](#-cli-参考)
- [HTTP API](#-http-api)
- [配置](#-配置)
- [Docker(Qdrant + Postgres)](#-docker-qdrant--postgres)
- [自愈与隔离](#-自愈与隔离)
- [平台自身的测试](#-平台自身的测试)
- [项目结构](#-项目结构)
- [路线图](#-路线图)
- [参与贡献](#-参与贡献)
- [许可证](#-许可证)

---

## 🎯 它能做什么

```
$ qa-swarm run https://staging.example.com --both

  ┌─────────────────────────────────────────────────────┐
  │  QA-SWARM  ·  Devin for QA                          │
  └─────────────────────────────────────────────────────┘
  • [explorer]       visited 7 page(s), 12 endpoint(s)
  • [test-generator] generated 41 test(s) from the exploration map
  • [executor]       executed 41 test(s): 36 passed, 5 failed, 2 healed
  • [triage]         ui_login_…: product-bug (0.82 confidence)
  • [triage]         triaged 5 failure(s), 3 bug(s) filed
  • [security]       found 6 security finding(s) (2 high)
  • [performance]    9 metric(s), 2 over budget (p95 > 800ms)
  • [reporter]       report ready → ./qa-swarm-out/report.md
                    + regression suite → ./tests/regression/

  ── run summary ──────────────────────────────────────
  tests generated   41
  passed            36
  failed            5
  bugs filed        3
  security findings 6
  coverage gaps     4
  llm calls        118
```

QA-Swarm 是一个构建在 [LangGraph](https://github.com/langchain-ai/langgraph) 之上的**多智能体系统**,将完整的 QA 闭环全自动化:

1. **探索** — 一个智能体爬取你的 Web 应用和/或读取你的 OpenAPI 规范,构建出页面、流程和端点的地图。
2. **生成** — 测试生成智能体(由 GPT-4o / Claude / 任意 OpenAI 兼容的 LLM 驱动)根据探索结果编写 Playwright 测试用例。
3. **执行** — 执行器智能体在真实浏览器中运行这些测试,并配备可在运行中自动修复失效选择器的**自愈定位器**。
4. **分诊** — 分诊智能体将每个失败归类为 `product-bug`(产品缺陷)、`test-bug`(测试缺陷)、`flaky`(不稳定)或 `environment`(环境问题),让你不再把时间浪费在不稳定测试上。
5. **安全与性能** — 并行智能体执行 OWASP 风格的安全响应头检查以及 p95/p99 预算门禁。
6. **报告** — 报告智能体输出 markdown 报告和 JUnit XML,向你的缺陷跟踪系统提单,并把通过的测试**晋升进回归测试集**。

整个系统是一个状态机:各智能体通过共享的 `SwarmState` 交接工作,向量记忆(Qdrant)负责语义去重,Postgres 负责持久的运行历史。

---

## 🤔 为什么选择 QA-Swarm

| 传统 QA                 | QA-Swarm                                     |
| ----------------------- | -------------------------------------------- |
| 每个测试都由人来写      | 智能体根据探索结果生成测试                   |
| 不稳定测试浪费 CI 时间  | 分诊器对每个失败分类;不稳定的被隔离,而非阻塞 |
| 选择器一坏,构建就红     | 自愈定位器自动修复 + 提 PR                   |
| 安全/性能要靠另外的工具 | 一个蜂群、并行智能体、一份报告               |
| 回归测试集逐渐腐烂      | 通过的测试自动晋升进测试集                   |
| 人工提单、复现步骤含糊  | 提单自带 trace、截图和置信度分数             |

它并非要取代你的 QA 工程师——它是一个**战力倍增器**,把样板工作从他们的盘子里拿走,让他们专注于高难度的探索性工作。

---

## 🏗 架构

```
                          ┌─────────────────┐
                          │   SwarmGraph    │  (LangGraph state machine)
                          └────────┬────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
  ┌──────────┐  ┌────────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
  │ Explorer │─▶│ TestGen    │─▶│Executor │─▶│ Triage   │  │ Security │
  └────┬─────┘  └────────────┘  └────┬────┘  └────┬─────┘  └──────────┘
       │              ▲                │            │              │
       │              │            (self-heal)      │              │
       │              │                │            ▼              ▼
       │         ┌────────┐        ┌─────────┐  ┌──────────┐  ┌──────────┐
       │         │Qdrant  │        │Quarantn │  │ Issue    │  │ Perf     │
       │         │(memory)│        └─────────┘  │ Tracker  │  │ budgets  │
       │         └────────┘                     └──────────┘  └──────────┘
       │
       ▼
  ┌──────────┐
  │ Reporter │ ──▶ markdown report + JUnit + regression suite
  └──────────┘
```

**共享状态**(`SwarmState`)流经整张图:每个智能体读取自己所需,写回自己的产出。图负责编排执行顺序、重试和并行分支(安全与性能与分诊并发运行)。

**工具层**:每个智能体都可以使用一套工具箱(`packages/core/src/tools/`):无头浏览器、HTTP 客户端、OpenAPI 解析器、数据库客户端和缺陷跟踪系统适配器。

**记忆**:Qdrant 存储已探索页面与已生成测试的语义向量,让蜂群在多次运行之间不重复探索、不重复生成。Postgres 存储持久的运行历史。

---

## 🚀 快速开始

### 前置条件

- **Node.js ≥ 20**
- 一个 **LLM API 密钥** — `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY` 二选一(配置在 `.env` 或环境变量中)。没有密钥时,蜂群会以降级的"mock LLM"模式运行,依然能跑通整张图和全部工具,适合演示。
- (可选,用于完整记忆)运行 Qdrant + Postgres 所需的 **Docker** — 见 [Docker(Qdrant + Postgres)](#-docker-qdrant--postgres)。

### 安装并运行

```bash
git clone https://github.com/springzcf/AQAOS.git
cd AQAOS
npm install            # 安装所有 workspace(core、cli、api、web)
npm run build          # tsc -b packages/core packages/cli

# 1. 启动控制面板 + API
npm run api            # → http://localhost:4317(在浏览器中打开)

# 2.(另开一个终端)用 CLI 对目标发起蜂群
npm run swarm -- run https://example.com --both --offline
```

打开 **http://localhost:4317** 查看实时控制面板,或在终端中观察 CLI 的流式输出。

### 通过 API 一次性运行

```bash
# 发起一次运行
curl -X POST http://localhost:4317/runs \
  -H 'content-type: application/json' \
  -d '{"target":"https://example.com","targetKind":"both","dryRun":true}'

# → {"id":"run-lz0f3k","status":"running","poll":"/runs/run-lz0f3k"}

# 轮询进度
curl http://localhost:4317/runs/run-lz0f3k
```

---

## 🐝 智能体

| 智能体                            | 文件                                         | 职责                                                                                              |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 🧭 **Explorer(探索器)**           | `packages/core/src/agents/explorer.ts`       | 爬取网页(Playwright)+ 读取 OpenAPI 规范,构建探索地图(页面、流程、端点)。                          |
| ✨ **Test Generator(测试生成器)** | `packages/core/src/agents/test-generator.ts` | 使用 LLM 根据地图编写 Playwright 测试;借助 Qdrant 去重,避免重复生成已知测试。                     |
| ▶ **Executor(执行器)**            | `packages/core/src/agents/executor.ts`       | 在真实浏览器中运行生成的测试;定位器失效时调用**自愈器**。                                         |
| 🔬 **Triage(分诊器)**             | `packages/core/src/agents/triage.ts`         | 为每个失败分类(`product-bug` / `test-bug` / `flaky` / `environment`),并给出置信度分数和简要理由。 |
| 🔒 **Security(安全)**             | `packages/core/src/agents/security.ts`       | OWASP 风格检查:安全响应头、Cookie 标志、TLS、信息泄露。                                           |
| ⚡ **Performance(性能)**          | `packages/core/src/agents/performance.ts`    | 采集 p50/p95/p99 与 LCP/CLS,并按你的预算门禁判定。                                                |
| 📋 **Reporter(报告器)**           | `packages/core/src/agents/reporter.ts`       | 输出 markdown 报告 + JUnit XML、提交缺陷、把通过的测试晋升进回归测试集。                          |

每个智能体都继承自 `BaseAgent`(`packages/core/src/agents/base.ts`),由它提供:共享的 `SwarmState`、LLM 提供器、工具注册表、结构化日志,以及重试/退避包装。

---

## 🖥 控制面板

一个位于 `apps/web/index.html` 的单页控制平面,由 API 通过 `http://localhost:4317/` 提供服务。它展示:

- **API 健康徽章**(实时,绿色/红色闪烁)
- **7 智能体状态条** — 随着蜂群推进,每个智能体亮起 `active`(蓝色)或 `done`(绿色)
- **新建运行表单** — 目标 URL/规范 + 类型(web / openapi / both)
- **实时指标网格** — 页面数、端点数、测试数、通过、失败、缺陷、安全、性能、覆盖缺口、LLM 调用数
- **智能体日志** — 终端风格的智能体消息流
- **缺陷表** — 严重级别标签 + 标题 + 提单位置
- **测试结果表** — 状态标签(通过/失败/不稳定/已隔离)+ 耗时 + 错误信息
- **运行历史** — 点击任意历史运行即可重新查看其结果

运行进行期间,控制面板每 1.5 秒轮询一次 `/runs/:id` — 无需 WebSocket。

---

## 🖥 CLI 参考

```bash
qa-swarm <command> [options]

命令:
  run <target>            对一个 URL 或 OpenAPI 规范运行完整蜂群
  inspect <spec>          解析 OpenAPI 规范并打印端点地图
  report <run-id>         为一次历史运行重新渲染报告
  list                    列出最近的运行(来自 API)

`run` 的选项:
  --kind <web|openapi|both>   探索什么(默认:both)
  --offline                   使用 mock LLM(无需 API 密钥)
  --dry-run                   只生成测试但不执行(默认:true)
  --budget-p95 <ms>           性能 p95 预算(默认:800)
  --max-pages <n>             爬虫页面数上限(默认:50)
  --no-security               跳过安全智能体
  --no-performance            跳过性能智能体
```

运行 `qa-swarm run --help` 查看完整列表。

---

## 🌐 HTTP API

| 方法   | 路径        | Body / Query                                | 返回                                       |
| ------ | ----------- | ------------------------------------------- | ------------------------------------------ |
| `GET`  | `/health`   | —                                           | `{ ok, runs, version, uptime }`            |
| `GET`  | `/`         | —                                           | 控制面板 HTML                              |
| `GET`  | `/ui`       | —                                           | `/` 的别名                                 |
| `POST` | `/runs`     | `{ target, targetKind, baseUrl?, dryRun? }` | `{ id, status, poll }`(202)                |
| `GET`  | `/runs`     | —                                           | `[{ id, status, startedAt, tests, bugs }]` |
| `GET`  | `/runs/:id` | —                                           | 完整运行状态(摘要、缺陷、结果、日志)       |

这套 API 是一个轻量的控制平面——运行即发即忘,并保存在内存中。如需多节点持久化,可把 `runs` Map 换成 Redis 或 Postgres。

---

## ⚙ 配置

配置类型为 `SwarmConfig`(`packages/core/src/types.ts`),默认值定义在 `DEFAULT_CONFIG` 中。可通过 CLI 旗标、API 请求体或环境变量覆盖:

| 环境变量            | 默认值                          | 用途                              |
| ------------------- | ------------------------------- | --------------------------------- |
| `OPENAI_API_KEY`    | —                               | LLM 提供器(OpenAI / GPT-4o)       |
| `ANTHROPIC_API_KEY` | —                               | LLM 提供器(Anthropic / Claude)    |
| `QA_LLM_PROVIDER`   | `openai`                        | `openai` \| `anthropic` \| `mock` |
| `QA_QDRANT_URL`     | `http://localhost:6333`         | 用于语义记忆的 Qdrant             |
| `QA_PG_URL`         | `postgres://localhost/qa-swarm` | 用于运行历史的 Postgres           |
| `PORT`              | `4317`                          | API + 控制面板端口                |
| `QA_BUDGET_P95`     | `800`                           | 性能 p95 预算(毫秒)               |
| `QA_MAX_PAGES`      | `50`                            | 爬虫页面数上限                    |

将 `.env.example` 复制为 `.env` 并填入你的密钥。

---

## 🐳 Docker (Qdrant + Postgres)

完整的记忆栈运行在 Docker 中:

```bash
npm run docker:up    # docker compose -f docker/docker-compose.yml up -d
npm run docker:down # 停止并清理
```

这会启动 Qdrant(向量记忆)+ Postgres(运行历史)+ Grafana + Prometheus(可选的可观测性组件)。没有 Docker 时,蜂群会退回到内存存储——演示够用,但不适合多节点部署。

---

## 🔄 自愈与隔离

两项特性让蜂群对 UI 频繁变更保持健壮:

- **自愈定位器**(`packages/core/src/selfheal/locator-healer.ts`)— 当 Playwright 选择器失效时,自愈器让 LLM 根据页面的实时 DOM 提议一个新选择器,重新运行测试,成功后打开 diff 供你提交修复。
- **隔离**(`packages/core/src/selfheal/quarantine.ts`)— 连续 N 次被判定为 `flaky` 失败的测试会被隔离:它们仍然运行,但不再使 CI 失败。它们在控制面板中显示为紫色标签,并在测试文件中带上 `@quarantine` 标记。

---

## 🧪 平台自身的测试

QA-Swarm 自己吃自己的狗粮——平台本身用 Playwright 测试:

```bash
npm test                # 全部测试
npm run test:e2e        # 端到端(演示应用)
npm run test:regression # 回归(记忆、自愈器、隔离、安全响应头)
```

回归测试集覆盖:记忆 API、定位器自愈器、隔离流程和安全响应头检查。

---

## 📁 项目结构

```
AQAOS/
├── apps/
│   ├── api/                 # Express API + 控制面板服务(端口 4317)
│   └── web/                 # 控制面板(单个 index.html)
├── packages/
│   ├── core/                # 蜂群引擎
│   │   └── src/
│   │       ├── agents/      # 7 个智能体 + base
│   │       ├── graph/       # swarm-graph + langgraph 适配器
│   │       ├── llm/         # 提供器 + 提示词
│   │       ├── memory/      # qdrant + store
│   │       ├── report/      # markdown、playwright、writer
│   │       ├── selfheal/    # locator-healer + quarantine
│   │       ├── tools/       # browser、api、db、issue-tracker、openapi
│   │       └── types.ts
│   └── cli/                 # qa-swarm CLI
├── docker/                  # qdrant + postgres 的 docker-compose
├── docs/                    # ARCHITECTURE.md、AGENTS.md
├── examples/demo-app/       # 供蜂群测试的示例应用
├── openapi/                 # 示例 OpenAPI 规范
└── tests/                   # e2e + 回归测试集
```

---

## 🗺 路线图

- [ ] **GitHub PR 集成** — 以 PR 评论形式提单,自愈修复以 PR 形式提交
- [ ] **视觉回归** — 截图对比智能体
- [ ] **无障碍智能体** — axe-core + LLM 修复建议
- [ ] **多模型路由** — 探索用便宜模型,测试生成用强模型
- [ ] **运行对比** — "距上一次绿色运行以来发生了什么变化"
- [ ] **Slack/Teams 通知** — 运行完成 + 提单 webhook

---

## 🤝 参与贡献

欢迎提交 PR。智能体层是扩展性最强的部分——一个新智能体就是一个继承 `BaseAgent` 的类 + `SwarmGraph` 中的一个节点。编写指南见 `docs/AGENTS.md`,状态流转契约见 `docs/ARCHITECTURE.md`。

```bash
npm install
npm run build
npm run lint
npm test
```

---

## 📄 许可证

Apache-2.0 — 见 [LICENSE](LICENSE)。用它做点酷东西吧。

<div align="center">

**[快速开始](#-快速开始) · [架构](#-架构) · [控制面板](#-控制面板) · [API](#-http-api)**

由 QA-Swarm 社区用 🐝 打造。

</div>
