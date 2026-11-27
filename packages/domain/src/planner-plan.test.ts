/**
 * PlannerPlan 契约回归（T-E02-06，DDD §4.2）。
 *
 * 覆盖：结构化计划 schema（strict 拒绝未知键/缺必填规划字段）、
 * plannerPlanToQaPlan 提取（risk/acceptance 随任务携带）、合同校验
 * validatePlannerPlan（DAG 结构复用 + 选角一致性 + 预算上限）、
 * PLANNER_PLAN_JSON_SCHEMA 单源生成形状（与 zod 契约不漂移）。
 */

import { describe, expect, it } from "vitest";
import {
    PLANNER_PLAN_JSON_SCHEMA,
    PlannerPlanSchema,
    plannerPlanToQaPlan,
    plannerTasksForRole,
    validatePlannerPlan,
    type PlannerPlan,
} from "./planner-plan.js";
import {
    PLANNER_PLAN_PROMPT,
    ROLE_PROMPT_BASELINES,
    plannerPlanDefinition,
} from "./agent-prompts.js";
import { readyQaTasks } from "./qa-plan.js";

/** 构造样本计划；overrides 为宽松输入（负样本故意的非法值经 parse 拒绝）。 */
const plan = (overrides: Record<string, unknown> = {}): PlannerPlan =>
    PlannerPlanSchema.parse({
        objective: "Verify checkout flow end to end",
        platforms: ["web"],
        testTypes: ["smoke", "functional"],
        agents: ["explorer", "web-tester", "reporter"],
        budget: { maxTokens: 50_000, maxModelCostUsd: 1 },
        tasks: [
            {
                id: "map-site",
                role: "explorer",
                objective: "Observe the site map around checkout",
                dependsOn: [],
                priority: 2,
                risk: "medium",
                acceptance: "Site map contains the checkout entry points",
            },
            {
                id: "checkout-smoke",
                role: "web-tester",
                objective: "Run the checkout happy path",
                dependsOn: ["map-site"],
                priority: 1,
                risk: "high",
                acceptance: "Checkout completes with a confirmation",
            },
            {
                id: "report",
                role: "reporter",
                objective: "Summarize results",
                dependsOn: ["checkout-smoke"],
                priority: 1,
                risk: "low",
                acceptance: "Report contains pass/fail per scenario",
            },
        ],
        assumptions: ["Payment sandbox is available"],
        ...overrides,
    });

describe("PlannerPlanSchema（结构化计划契约）", () => {
    it("合法计划解析（缺省字段回填：testTypes/assumptions）", () => {
        const parsed = PlannerPlanSchema.parse({
            objective: "x",
            platforms: ["api"],
            agents: ["explorer"],
            budget: { maxTokens: 1_000, maxModelCostUsd: 0 },
            tasks: [
                {
                    id: "t-1",
                    role: "explorer",
                    objective: "o",
                    priority: 1,
                    risk: "low",
                    acceptance: "a",
                },
            ],
        });
        expect(parsed.testTypes).toEqual([]);
        expect(parsed.assumptions).toEqual([]);
    });

    it("strict：未知键拒绝；PlannerTask 缺 risk/acceptance/priority 拒绝", () => {
        expect(() => PlannerPlanSchema.parse({ ...plan(), extra: 1 })).toThrow();
        const strip = (field: "risk" | "acceptance" | "priority"): void => {
            const sample = plan();
            delete (sample.tasks[1] as Partial<(typeof sample.tasks)[1]>)[field];
            expect(() => PlannerPlanSchema.parse(sample), `missing ${field}`).toThrow();
        };
        strip("risk");
        strip("acceptance");
        strip("priority");
    });

    it("非法平台/角色/任务空集拒绝", () => {
        expect(() => PlannerPlanSchema.parse(plan({ platforms: ["mobile"] }))).toThrow();
        expect(() => PlannerPlanSchema.parse(plan({ agents: ["not-a-role"] }))).toThrow();
        expect(() => PlannerPlanSchema.parse(plan({ tasks: [] }))).toThrow();
    });
});

describe("plannerPlanToQaPlan（运行侧提取）", () => {
    it("tasks 直接复用（risk/acceptance 元数据随行）；就绪集含优先级排序可用", () => {
        const source = plan();
        const qaPlan = plannerPlanToQaPlan(source);
        expect(qaPlan.tasks).toHaveLength(3);
        expect(qaPlan.tasks[1]?.risk).toBe("high");
        const ready = readyQaTasks(qaPlan, {});
        expect(ready.map((task) => task.id)).toEqual(["map-site"]);
        // 规划元数据不参与就绪计算：statuses 全 completed 时计划结算。
        expect(plannerTasksForRole(source, "web-tester")).toHaveLength(1);
    });
});

describe("validatePlannerPlan（合同校验）", () => {
    it("合法计划 → 无问题", () => {
        expect(validatePlannerPlan(plan())).toEqual([]);
        expect(validatePlannerPlan(plan(), { maxTokens: 100_000, maxModelCostUsd: 2 })).toEqual([]);
    });

    it("DAG 结构问题透传：环 / 悬空依赖", () => {
        const cyclic = plan({
            tasks: [
                {
                    id: "a",
                    role: "explorer",
                    objective: "o",
                    dependsOn: ["b"],
                    priority: 1,
                    risk: "low",
                    acceptance: "a",
                },
                {
                    id: "b",
                    role: "reporter",
                    objective: "o",
                    dependsOn: ["a"],
                    priority: 1,
                    risk: "low",
                    acceptance: "a",
                },
            ],
        });
        expect(validatePlannerPlan(cyclic).map((issue) => issue.code)).toContain("CYCLE");

        const dangling = plan({
            tasks: [
                {
                    id: "a",
                    role: "explorer",
                    objective: "o",
                    dependsOn: ["ghost"],
                    priority: 1,
                    risk: "low",
                    acceptance: "a",
                },
            ],
        });
        expect(validatePlannerPlan(dangling).map((issue) => issue.code)).toContain(
            "UNKNOWN_DEPENDENCY",
        );
    });

    it("选角一致性：任务角色未选 → TASK_ROLE_NOT_SELECTED；选而不用 → AGENT_UNUSED", () => {
        const unselected = plan({ agents: ["explorer", "reporter"] });
        expect(validatePlannerPlan(unselected).map((issue) => issue.code)).toContain(
            "TASK_ROLE_NOT_SELECTED",
        );

        const unused = plan({ agents: ["explorer", "web-tester", "reporter", "triage-agent"] });
        expect(validatePlannerPlan(unused).map((issue) => issue.code)).toContain("AGENT_UNUSED");
    });

    it("预算超上限 → BUDGET_EXCEEDS_LIMIT（token/成本两维；未给上限跳过）", () => {
        const cap = { maxTokens: 100_000, maxModelCostUsd: 2 };
        expect(
            validatePlannerPlan(
                plan({ budget: { maxTokens: 200_000, maxModelCostUsd: 1 } }),
                cap,
            ).map((issue) => issue.code),
        ).toContain("BUDGET_EXCEEDS_LIMIT");
        expect(
            validatePlannerPlan(
                plan({ budget: { maxTokens: 50_000, maxModelCostUsd: 5 } }),
                cap,
            ).map((issue) => issue.code),
        ).toContain("BUDGET_EXCEEDS_LIMIT");
        expect(validatePlannerPlan(plan())).toEqual([]);
    });
});

describe("PLANNER_PLAN_JSON_SCHEMA（SDK outputFormat 单源生成）", () => {
    it("形状自省：object + 核心属性齐 + strict（additionalProperties: false）", () => {
        expect(PLANNER_PLAN_JSON_SCHEMA.type).toBe("object");
        const properties = PLANNER_PLAN_JSON_SCHEMA.properties as Record<string, unknown>;
        for (const key of [
            "objective",
            "platforms",
            "testTypes",
            "agents",
            "budget",
            "tasks",
            "assumptions",
        ]) {
            expect(properties[key], `property ${key}`).toBeDefined();
        }
        expect(PLANNER_PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
        const tasks = properties.tasks as {
            items?: { required?: string[]; additionalProperties?: unknown };
        };
        for (const field of ["id", "role", "objective", "priority", "risk", "acceptance"]) {
            expect(tasks.items?.required, `task required ${field}`).toContain(field);
        }
        expect(tasks.items?.additionalProperties).toBe(false);
    });
});

describe("planner v2 prompt（迁移 0008 种子源）", () => {
    it("plannerPlanDefinition：version=2、标签 0.2.0、五段结构、与 v1 内容不同", () => {
        const definition = plannerPlanDefinition();
        expect(definition.name).toBe("planner");
        expect(definition.version).toBe("2");
        expect(definition.promptVersion).toBe("0.2.0");
        expect(definition.enabled).toBe(true);
        expect(definition.prompt).toBe(PLANNER_PLAN_PROMPT);
        // 五段结构（身份行 + 四个标题段）。
        expect(definition.prompt).toContain("You are the AQAOS Planner (planner)");
        for (const section of ["# Mission", "# Tools", "# Working rules", "# Output"]) {
            expect(definition.prompt).toContain(section);
        }
        // v2 与 v1 骨架内容不同（标签不变量成立的前提）。
        expect(definition.prompt).not.toBe(ROLE_PROMPT_BASELINES.planner);
    });
});
