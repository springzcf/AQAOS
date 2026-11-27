/**
 * AQAOS agent worker — Claude Agent SDK 会话宿主。
 *
 * T-E02-02（Agent Runtime 基座）落地：
 *  - toSessionSpec / toSdkOptions：agent_definitions → SDK 会话选项映射
 *    （系统提示词、allowedTools、model、会话预算、AbortSignal）；
 *  - runAgentSession：headless 会话运行器 + 包装层预算熔断 + usage 回报；
 *  - SessionMeter：modelUsage 累计计量（T-E02-13 model_invocations 数据源）。
 *
 * T-E02-03（MCP Tool Server 基座）落地：
 *  - createAqaosSdkMcpServer：@aqaos/mcp 注册表的进程内 SDK 适配器
 *    （调用上下文构造时绑定，权限/预算/审计与 REST 同一调度链）；
 *  - 消费方式：runAgentSession 的 mcpServers 参数传入
 *    { aqaos: createAqaosSdkMcpServer({ context, services }) }。
 *
 * T-E02-05（QA Manager 统筹）落地：
 *  - runQaManagerSession / resumeQaManagerSession：统筹会话（子代理委派面
 *    SDK Options.agents + 派发闸门 createDispatchGate + 任务事件投影
 *    QaPlanTracker；persistSession 强制 true 支撑多轮/Query 控制面）；
 *  - QaPlan 契约（任务 DAG）在 @aqaos/domain qa-plan.ts。
 *
 * T-E02-06（Planner）落地：
 *  - runPlannerSession：目标 → PlannerPlan 结构化计划（SDK outputFormat
 *    json_schema 通道 + PlannerPlanSchema/validatePlannerPlan 双校验）；
 *  - prompt v2（迁移 0008 种子）与 PlannerPlan 契约在 @aqaos/domain。
 *
 * T-E02-07（Product Analyst）落地：
 *  - runProductAnalystSession：产品材料 → ProductModel 结构化模型（同
 *    outputFormat 通道 + ProductModelSchema/validateProductModel 双校验）+
 *    确定性落库（productModelToKnowledgeGraph → dispatch
 *    memory.write_knowledge，权限/审计同一调度链）；
 *  - prompt v2（迁移 0009 种子）、ProductModel 契约与图谱映射在 @aqaos/domain。
 *
 * T-E02-09（Test Architect）落地：
 *  - runTestArchitectSession：产品知识 → TestStrategy 结构化策略（同
 *    outputFormat 通道 + TestStrategySchema/validateTestStrategy 双校验；
 *    策略配置约束注入 + focus 键产品模型对照 + 有界纠偏轮）；
 *  - prompt v2（迁移 0010 种子）、TestStrategy 契约在 @aqaos/domain。
 *
 * 后续接线：
 *  - T-E02-10：Test Generator 消费 TestStrategy.orderedSelections 生成用例；
 *  - T-E02-12：Run Registry 消费 QaPlan/QaPlanProgress 落库展示；
 *  - T-E03-06：审批桥（canUseTool → approval_requests，DispatchApproval seam）。
 *  会话型 agents（QA Manager/Planner/Product Analyst/Test Architect/Triage/
 *  Root Cause Analyst）与混合型 agents（Explorer/Test Generator/Bug Verifier/
 *  Self-Healing/Regression/Reporter）都以 runAgentSession 为统一入口。
 */

export const WORKER_KIND = "agent" as const;

export function workerBanner(): string {
    return "[aqaos/worker-agent] kind=agent status=ready (T-E02-02 runtime + T-E02-03 MCP + T-E02-05 QA Manager orchestration + T-E02-06 Planner + T-E02-07 Product Analyst + T-E02-09 Test Architect)";
}

export {
    runAgentSession,
    type AgentSessionOutcome,
    type AgentSessionStatus,
    type RunAgentSessionParams,
    type SessionAbortReason,
    type SessionQueryFn,
} from "./agent-session.js";
export {
    createAqaosSdkMcpServer,
    type CreateAqaosSdkMcpServerParams,
    SDK_MCP_SERVER_NAME,
    SDK_MCP_SERVER_VERSION,
    toCallToolResult,
} from "./mcp-server.js";
export { SessionMeter, type SessionUsageSnapshot } from "./session-meter.js";
export {
    plannerPrompt,
    runPlannerSession,
    type PlannerIssue,
    type PlannerOutcome,
    type RunPlannerSessionParams,
} from "./planner.js";
export { parseStructuredOutput } from "./structured-output.js";
export {
    productAnalystPrompt,
    runProductAnalystSession,
    type ProductAnalystIssue,
    type ProductAnalystOutcome,
    type ProductAnalystSources,
    type RunProductAnalystParams,
} from "./product-analyst.js";
export {
    runTestArchitectSession,
    testArchitectPrompt,
    type PlannerIntent,
    type RunTestArchitectParams,
    type TestArchitectIssue,
    type TestArchitectOutcome,
} from "./test-architect.js";
export {
    createDispatchGate,
    QaPlanTracker,
    resumeQaManagerSession,
    runQaManagerSession,
    taskEventFromMessage,
    toSdkAgents,
    toSdkSubagent,
    type CreateDispatchGateParams,
    type DispatchApproval,
    type QaManagerOutcome,
    type QaPlanProjection,
    type QaTaskEvent,
    type RunQaManagerSessionParams,
} from "./qa-manager.js";
export {
    AgentDefinitionError,
    DEFAULT_SESSION_MODEL,
    SDK_CLIENT_APP_ID,
    SDK_DELEGATION_TOOL,
    type AgentSessionSpec,
    type SdkRuntime,
    type ToSessionSpecParams,
    toSdkOptions,
    toSessionSpec,
} from "./session-options.js";

if (process.env.AQAOS_RUN_WORKER === "1") {
    console.log(workerBanner());
}
