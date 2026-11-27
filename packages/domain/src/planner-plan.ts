/**
 * Planner 计划契约（T-E02-06，DDD §4.2）：目标解析 → 结构化测试计划。
 *
 * PlannerPlan 是 Planner 会话的**结构化产出**（经 SDK outputFormat json_schema
 * 通道强制形状）：目标、平台与测试类型选择、参与角色、预算估算、任务 DAG
 * （依赖/优先级/风险/验收）与假设清单。
 *
 * 与 QaPlan 的关系：plannerPlanToQaPlan 提取 tasks 即得运行侧 QaPlan（QA
 * Manager 统筹消费）；PlannerTask = QaTask + 必填 risk/acceptance/priority
 * ——"计划是合同"（DDD §4.2），规划期字段在运行期降级为可选元数据。
 *
 * 语义校验（validatePlannerPlan，结构合法性之外的合同条款）：
 * - 任务角色必须出现在 agents 选择集（选角与委派一致）；
 * - agents 不得空选（选了不委派 = 规划浪费）；
 * - 任务 DAG 复用 validateQaPlan（重复 id/悬空依赖/环）；
 * - 预算估算不得超过 Run 预算上限（DDD §4.2："超预算的计划是计划的缺陷"）。
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
    AgentRoleIdSchema,
    PlatformSchema,
    TestSuiteKindSchema,
    type AgentRoleId,
} from "./enums.js";
import { AgentBudgetSchema, type AgentBudget } from "./agent.js";
import {
    QaPlanSchema,
    QaTaskSchema,
    validateQaPlan,
    type QaPlan,
    type QaPlanIssue,
    type QaTask,
} from "./qa-plan.js";

/**
 * Planner 任务：QaTask + 必填规划字段（priority 覆盖为必填、risk 分级、
 * acceptance 验收条件）。id 规范：短小、小写、连字符（prompt v2 约定）。
 */
export const PlannerTaskSchema = QaTaskSchema.extend({
    priority: z.number().int().min(1),
    risk: z.enum(["low", "medium", "high"]),
    acceptance: z.string().min(1),
}).strict();
export type PlannerTask = z.infer<typeof PlannerTaskSchema>;

/** Planner 结构化计划（会话最终消息的 JSON 形状）。 */
export const PlannerPlanSchema = z
    .object({
        /** 解析后的可测目标（复述用户目标并明确边界，非照抄）。 */
        objective: z.string().min(1),
        platforms: z.array(PlatformSchema).min(1),
        /** 意图覆盖的测试类型（十二类；可空 = 由 Test Architect 细化）。 */
        testTypes: z.array(TestSuiteKindSchema).default([]),
        /** 参与角色（16 角色 id；任务角色必须 ⊆ 此集合）。 */
        agents: z.array(AgentRoleIdSchema).min(1),
        /** 计划预算估算（不得超过 Run 预算上限）。 */
        budget: AgentBudgetSchema,
        tasks: z.array(PlannerTaskSchema).min(1),
        /** 显式假设（每条都是给 Product Analyst 的问题，非静默猜测）。 */
        assumptions: z.array(z.string().min(1)).default([]),
    })
    .strict();
export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;

/**
 * PlannerPlan 的 JSON Schema（SDK Options.outputFormat json_schema 通道用）。
 * 由 PlannerPlanSchema 单源生成（zod-to-json-schema），形状与 zod 永不漂移。
 */
// 注意：不传 name 选项——命名会把 schema 包成 {$ref, definitions} 形状，
// SDK outputFormat 需要的是裸顶层 object schema（无自递归引用，内联无 $defs）。
export const PLANNER_PLAN_JSON_SCHEMA: Record<string, unknown> = zodToJsonSchema(
    PlannerPlanSchema,
) as Record<string, unknown>;

/** 计划合同问题（结构 + 语义；构建侧拒绝落库/直接执行的依据）。 */
export interface PlannerPlanIssue {
    readonly code:
        QaPlanIssue["code"] | "AGENT_UNUSED" | "TASK_ROLE_NOT_SELECTED" | "BUDGET_EXCEEDS_LIMIT";
    readonly message: string;
    readonly taskId?: string;
}

/** 提取运行侧 QaPlan（risk/acceptance 作为元数据随任务携带）。 */
export function plannerPlanToQaPlan(plan: PlannerPlan): QaPlan {
    return QaPlanSchema.parse({ tasks: plan.tasks });
}

/**
 * 合同校验：DAG 结构（复用 validateQaPlan）+ 选角一致性 + 预算上限。
 * @param limits Run 预算上限（AgentContext.budget）；缺省跳过预算比对。
 */
export function validatePlannerPlan(
    plan: PlannerPlan,
    limits?: AgentBudget,
): readonly PlannerPlanIssue[] {
    const issues: PlannerPlanIssue[] = [];
    issues.push(...validateQaPlan(plannerPlanToQaPlan(plan)));

    const usedRoles = new Set<AgentRoleId>(plan.tasks.map((task) => task.role));
    for (const task of plan.tasks) {
        if (!plan.agents.includes(task.role)) {
            issues.push({
                code: "TASK_ROLE_NOT_SELECTED",
                message: `task "${task.id}" uses role "${task.role}" not present in agents selection`,
                taskId: task.id,
            });
        }
    }
    for (const agent of plan.agents) {
        if (!usedRoles.has(agent)) {
            issues.push({
                code: "AGENT_UNUSED",
                message: `agent "${agent}" is selected but no task uses it`,
            });
        }
    }

    if (limits !== undefined) {
        const over =
            plan.budget.maxTokens > limits.maxTokens ||
            plan.budget.maxModelCostUsd > limits.maxModelCostUsd ||
            (limits.maxToolCalls !== undefined &&
                plan.budget.maxToolCalls !== undefined &&
                plan.budget.maxToolCalls > limits.maxToolCalls) ||
            (limits.maxDurationSeconds !== undefined &&
                plan.budget.maxDurationSeconds !== undefined &&
                plan.budget.maxDurationSeconds > limits.maxDurationSeconds);
        if (over) {
            issues.push({
                code: "BUDGET_EXCEEDS_LIMIT",
                message: `planned budget exceeds run budget cap (plan: ${JSON.stringify(
                    plan.budget,
                )} > cap: ${JSON.stringify(limits)})`,
            });
        }
    }
    return issues;
}

/** 角色便捷检索：计划中某角色的全部任务（Planner 展示/分诊用）。 */
export function plannerTasksForRole(plan: PlannerPlan, role: AgentRoleId): readonly QaTask[] {
    return plan.tasks.filter((task) => task.role === role);
}
