/**
 * Planner 会话运行器（T-E02-06，DDD §4.2/§3.5）。
 *
 * 目标解析 → 结构化测试计划：planner 角色（prompt v2，迁移 0008 种子）
 * 经 SDK outputFormat json_schema 通道产出 PlannerPlan JSON——形状由
 * PLANNER_PLAN_JSON_SCHEMA（@aqaos/domain 单源生成）在 SDK 侧强制，
 * 平台侧再过 PlannerPlanSchema + validatePlannerPlan 双校验（验收：
 * "输出结构化计划过 Schema 校验"）。
 *
 * 契约：PlannerOutcome.plan 存在 ⟺ schema 解析与合同校验全通过；
 * 否则 issues 携带阻断原因（会话终态/解析失败/DAG 与选角/预算问题），
 * 调用方以 issues 反馈重规划（Run 编排器 T-E03-01 消费）。
 */

import {
    AGENT_ROLE_IDS,
    PLANNER_PLAN_JSON_SCHEMA,
    PlannerPlanSchema,
    validatePlannerPlan,
    type AgentContext,
    type AgentDefinitionRecord,
    type PlannerPlan,
    type PlannerPlanIssue,
} from "@aqaos/domain";
import { runAgentSession, type AgentSessionOutcome, type SessionQueryFn } from "./agent-session.js";
import { parseStructuredOutput } from "./structured-output.js";

/** 解析/会话层阻断原因（合同问题透传 PlannerPlanIssue 形状）。 */
export type PlannerIssue =
    | PlannerPlanIssue
    | { readonly code: "SESSION_FAILED" | "PARSE_FAILED"; readonly message: string };

export interface PlannerOutcome {
    session: AgentSessionOutcome;
    /** 结构化计划（存在 ⟺ Schema + 合同校验全通过）。 */
    plan?: PlannerPlan;
    /** 阻断原因（plan 缺席时必有；空 ⟺ plan 可直接执行）。 */
    issues: readonly PlannerIssue[];
}

export interface RunPlannerSessionParams {
    /** planner 角色定义（agent_definitions 最新启用版；prompt v2）。 */
    definition: AgentDefinitionRecord;
    context: AgentContext;
    /** 用户目标（Run objective 原文）。 */
    objective: string;
    /** 产品知识摘要（T-E02-07 Product Analyst 产出；可选输入）。 */
    knowledge?: string;
    cwd?: string;
    defaultModel?: string;
    queryFn?: SessionQueryFn;
}

/** 组装规划轮输入（目标 + 预算上限 + 知识 + 角色名单 + 输出契约重申）。 */
export function plannerPrompt(params: RunPlannerSessionParams): string {
    const { context } = params;
    const budgetCap = [
        `max tokens: ${context.budget.maxTokens}`,
        `max model cost (USD): ${context.budget.maxModelCostUsd}`,
        context.budget.maxToolCalls !== undefined
            ? `max tool calls: ${context.budget.maxToolCalls}`
            : null,
        context.budget.maxDurationSeconds !== undefined
            ? `max duration (seconds): ${context.budget.maxDurationSeconds}`
            : null,
    ]
        .filter((line): line is string => line !== null)
        .join("\n");
    return [
        `Objective: ${params.objective}`,
        `Run budget cap (your planned budget must not exceed it):\n${budgetCap}`,
        params.knowledge !== undefined ? `Product knowledge:\n${params.knowledge}` : null,
        `Selectable agent roles: ${AGENT_ROLE_IDS.join(", ")}`,
        "Produce the complete QA plan as the JSON object required by the enforced output schema. Nothing else.",
    ]
        .filter((section): section is string => section !== null)
        .join("\n\n");
}

/** 运行 planner 规划会话（单轮；重规划 = 新会话带 issues 反馈）。 */
export async function runPlannerSession(params: RunPlannerSessionParams): Promise<PlannerOutcome> {
    const session = await runAgentSession({
        definition: params.definition,
        context: params.context,
        prompt: plannerPrompt(params),
        outputJsonSchema: PLANNER_PLAN_JSON_SCHEMA,
        cwd: params.cwd,
        defaultModel: params.defaultModel,
        queryFn: params.queryFn,
    });
    if (session.status !== "completed") {
        return {
            session,
            issues: [
                { code: "SESSION_FAILED", message: `planner session ended as ${session.status}` },
            ],
        };
    }
    const raw = parseStructuredOutput(session);
    if (raw === undefined || raw === null) {
        return {
            session,
            issues: [{ code: "PARSE_FAILED", message: "no structured output in planner result" }],
        };
    }
    const parsed = PlannerPlanSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            session,
            issues: [
                {
                    code: "PARSE_FAILED",
                    message: parsed.error.issues
                        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                        .join("; "),
                },
            ],
        };
    }
    const issues = validatePlannerPlan(parsed.data, params.context.budget);
    if (issues.length > 0) {
        return { session, issues };
    }
    return { session, plan: parsed.data, issues: [] };
}
