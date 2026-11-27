/**
 * T-E02-06 验收（Planner）：真实 Claude Agent SDK 子进程的规划会话端到端
 * 实证——planner v2 prompt（迁移 0008 种子同源 plannerPlanDefinition()）+
 * SDK outputFormat json_schema 通道 + 平台侧 PlannerPlanSchema/
 * validatePlannerPlan 双校验（验收："输出结构化计划过 Schema 校验"）。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 花真实 token——单轮规划，成本受 Run 预算上限约束）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    AGENT_ROLE_IDS,
    plannerPlanDefinition,
    plannerPlanToQaPlan,
    type AgentContext,
    type AgentDefinitionRecord,
} from "@aqaos/domain";
import { runPlannerSession } from "./planner.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const DEFINITION: AgentDefinitionRecord = {
    id: "8e2e120d-08a2-4fc4-a04e-efd909c75790",
    name: "planner",
    version: "2",
    promptVersion: "0.2.0",
    prompt: plannerPlanDefinition().prompt,
    config: {},
    enabled: true,
};

const agentContext: AgentContext = {
    runId: "8e2e120d-08a2-4fc4-a04e-efd909c75791",
    applicationId: "8e2e120d-08a2-4fc4-a04e-efd909c75792",
    environmentId: "8e2e120d-08a2-4fc4-a04e-efd909c75793",
    objective: "Smoke-verify the checkout happy path",
    budget: { maxTokens: 80_000, maxModelCostUsd: 1, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0206-live-acceptance",
};

const OBJECTIVE = [
    "Smoke-test the checkout happy path of a web shop:",
    "landing page → product → cart → checkout with sandbox payment → confirmation.",
    "Login is out of scope. Keep the plan small (3-5 tasks).",
].join(" ");

describe.skipIf(!LIVE)("live Planner session (T-E02-06 acceptance)", () => {
    it(
        "真实规划会话产出结构化计划：schema 校验通过、DAG 合法、角色规范、预算在上限内",
        { timeout: 300_000 },
        async () => {
            const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-planner-"));
            const outcome = await runPlannerSession({
                definition: DEFINITION,
                context: agentContext,
                objective: OBJECTIVE,
                cwd,
            });

            // 会话终态 + 阻断原因为空（schema + 合同双校验全过）。
            expect(outcome.session.status).toBe("completed");
            expect(outcome.issues).toEqual([]);

            const plan = outcome.plan;
            expect(plan).toBeDefined();
            if (plan === undefined) {
                return;
            }

            // 结构化计划核心形状（验收原文："输出结构化计划过 Schema 校验"）。
            expect(plan.platforms).toContain("web");
            expect(plan.tasks.length).toBeGreaterThanOrEqual(3);
            expect(plan.tasks.length).toBeLessThanOrEqual(5);
            for (const task of plan.tasks) {
                expect(AGENT_ROLE_IDS).toContain(task.role);
                expect(task.priority).toBeGreaterThanOrEqual(1);
                expect(["low", "medium", "high"]).toContain(task.risk);
                expect(task.acceptance.length).toBeGreaterThan(0);
            }

            // 运行侧提取同构（QA Manager 统筹可直接消费）。
            const qaPlan = plannerPlanToQaPlan(plan);
            expect(qaPlan.tasks).toHaveLength(plan.tasks.length);

            // 预算估算在 Run 上限内（planner v2 prompt 的合同条款）。
            expect(plan.budget.maxTokens).toBeLessThanOrEqual(agentContext.budget.maxTokens);
            expect(plan.budget.maxModelCostUsd).toBeLessThanOrEqual(
                agentContext.budget.maxModelCostUsd,
            );
        },
    );
});
