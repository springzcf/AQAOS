/**
 * Planner 会话回归（T-E02-06，DDD §4.2/§3.5）。
 *
 * 离线全链路（queryFn 注入假流，生产/测试同构）：
 * - outputFormat 通道：SDK Options.outputFormat = json_schema + 域层单源
 *   PLANNER_PLAN_JSON_SCHEMA（形状强制由 SDK 承担）；
 * - 验收"输出结构化计划过 Schema 校验"：合法 structured_output → plan
 *   返回（schema + 合同双校验）；结构非法/合同违约（环、选角、预算）→
 *   issues 阻断且 plan 缺席；
 * - 会话终态失败 → SESSION_FAILED；structured_output 缺席回退 resultText
 *   JSON 解析（容错）。
 */

import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
    PLANNER_PLAN_JSON_SCHEMA,
    type AgentContext,
    type AgentDefinitionRecord,
    type PlannerPlan,
} from "@aqaos/domain";
import { plannerPrompt, runPlannerSession } from "./planner.js";

const DEFINITION: AgentDefinitionRecord = {
    id: "d2000000-0000-4000-8000-000000000001",
    name: "planner",
    version: "2",
    promptVersion: "0.2.0",
    prompt: "You are the AQAOS Planner (planner), the test-planning agent.",
    config: {},
    enabled: true,
};

const CONTEXT: AgentContext = {
    runId: "62000000-0000-4000-8000-000000000001",
    applicationId: "42000000-0000-4000-8000-000000000001",
    environmentId: "52000000-0000-4000-8000-000000000001",
    objective: "冒烟验证结账主流程",
    budget: { maxTokens: 100_000, maxModelCostUsd: 2, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "trace-1",
};

const VALID_PLAN = {
    objective: "Smoke-verify the checkout happy path on web",
    platforms: ["web"],
    testTypes: ["smoke"],
    agents: ["explorer", "web-tester", "reporter"],
    budget: { maxTokens: 60_000, maxModelCostUsd: 1 },
    tasks: [
        {
            id: "map-site",
            role: "explorer",
            objective: "Observe site map around checkout",
            dependsOn: [],
            priority: 2,
            risk: "medium",
            acceptance: "Map contains checkout entry points",
        },
        {
            id: "checkout-smoke",
            role: "web-tester",
            objective: "Run checkout happy path",
            dependsOn: ["map-site"],
            priority: 1,
            risk: "high",
            acceptance: "Checkout completes with confirmation",
        },
        {
            id: "report",
            role: "reporter",
            objective: "Summarize results",
            dependsOn: ["checkout-smoke"],
            priority: 1,
            risk: "low",
            acceptance: "Report has pass/fail per scenario",
        },
    ],
    assumptions: ["Payment sandbox is available"],
} satisfies Record<string, unknown>;

/** 假流：携带 structured_output 的成功 result（outputFormat 通道语义）。 */
function fakeStream(options: {
    structuredOutput?: unknown;
    resultText?: string;
    isError?: boolean;
    onOptions?: (options: Options) => void;
}): (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage> {
    return async function* (params) {
        if (options.onOptions && params.options) {
            options.onOptions(params.options);
        }
        yield {
            type: "result",
            subtype: "success",
            is_error: options.isError ?? false,
            result: options.resultText ?? "planned",
            structured_output: options.structuredOutput,
            session_id: "sess-plan-1",
            duration_ms: 1500,
            duration_api_ms: 1400,
            num_turns: 1,
            total_cost_usd: 0.02,
            usage: { input_tokens: 100, output_tokens: 50 },
            modelUsage: {
                "claude-opus-5-5": { input_tokens: 100, output_tokens: 50, costUSD: 0.02 },
            },
        } as unknown as SDKMessage;
    };
}

describe("plannerPrompt（规划轮输入组装）", () => {
    it("含目标、预算上限、角色名单与输出契约；知识摘要可选", () => {
        const text = plannerPrompt({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "Verify login",
        });
        expect(text).toContain("Objective: Verify login");
        expect(text).toContain("max tokens: 100000");
        expect(text).toContain("max model cost (USD): 2");
        expect(text).toContain("max duration (seconds): 300");
        expect(text).toContain("explorer");
        expect(text).toContain("JSON object");
        expect(text).not.toContain("Product knowledge");

        const withKnowledge = plannerPrompt({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "Verify login",
            knowledge: "Checkout has 3 steps",
        });
        expect(withKnowledge).toContain("Product knowledge:\nCheckout has 3 steps");
    });
});

describe("runPlannerSession（结构化计划产出）", () => {
    it("合法 structured_output → plan 返回（schema + 合同双校验通过）", async () => {
        const outcome = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "Smoke checkout",
            queryFn: fakeStream({ structuredOutput: VALID_PLAN }),
        });
        expect(outcome.session.status).toBe("completed");
        expect(outcome.plan?.tasks).toHaveLength(3);
        expect(outcome.plan?.budget.maxTokens).toBe(60_000);
        expect(outcome.issues).toEqual([]);
    });

    it("outputFormat 通道：Options.outputFormat = json_schema + 域层单源 schema", async () => {
        let seen: Options | undefined;
        await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ structuredOutput: VALID_PLAN, onOptions: (o) => (seen = o) }),
        });
        expect(seen?.outputFormat).toEqual({
            type: "json_schema",
            schema: PLANNER_PLAN_JSON_SCHEMA,
        });
    });

    it("合同违约（任务环）→ issues 含 CYCLE，plan 缺席", async () => {
        const cyclic = {
            ...VALID_PLAN,
            tasks: [
                { ...VALID_PLAN.tasks[0], dependsOn: ["report"] },
                VALID_PLAN.tasks[1],
                { ...VALID_PLAN.tasks[2], dependsOn: ["map-site", "checkout-smoke"] },
            ],
        };
        const outcome = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ structuredOutput: cyclic }),
        });
        expect(outcome.plan).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("CYCLE");
    });

    it("预算超 Run 上限 → BUDGET_EXCEEDS_LIMIT 阻断", async () => {
        const overBudget = { ...VALID_PLAN, budget: { maxTokens: 999_999, maxModelCostUsd: 1 } };
        const outcome = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ structuredOutput: overBudget }),
        });
        expect(outcome.plan).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("BUDGET_EXCEEDS_LIMIT");
    });

    it("structured_output 非 JSON 兼容形状 → PARSE_FAILED；缺席回退 resultText 解析", async () => {
        const bad = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ structuredOutput: { nope: true } }),
        });
        expect(bad.plan).toBeUndefined();
        expect(bad.issues[0]?.code).toBe("PARSE_FAILED");

        // structured_output 缺席 + resultText 是 JSON → 兜底解析成功。
        const fallback = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({
                structuredOutput: undefined,
                resultText: JSON.stringify(VALID_PLAN),
            }),
        });
        expect(fallback.plan?.tasks).toHaveLength(3);
    });

    it("会话非 completed 终态 → SESSION_FAILED，不做解析", async () => {
        const outcome = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ isError: true }),
        });
        // is_error=true 折叠为 failed 终态。
        expect(outcome.session.status).toBe("failed");
        expect(outcome.plan).toBeUndefined();
        expect(outcome.issues[0]?.code).toBe("SESSION_FAILED");
    });
});

describe("PlannerPlan 类型协作（编译期契约）", () => {
    it("plan 任务可直接构造运行侧 QaPlan 投影输入", async () => {
        const outcome = await runPlannerSession({
            definition: DEFINITION,
            context: CONTEXT,
            objective: "x",
            queryFn: fakeStream({ structuredOutput: VALID_PLAN }),
        });
        const plan = outcome.plan as PlannerPlan;
        // QA Manager 统筹消费同一 tasks（plannerPlanToQaPlan 同构）。
        expect(plan.tasks.every((task) => task.priority >= 1 && task.acceptance.length > 0)).toBe(
            true,
        );
    });
});
