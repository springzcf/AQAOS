/**
 * T-E02-09 验收（Test Architect）：真实 Claude Agent SDK 子进程的策略会话
 * 端到端实证——test-architect v2 prompt（迁移 0010 种子同源
 * testArchitectDefinition()）+ SDK outputFormat json_schema 通道 + 平台侧
 * TestStrategySchema/validateTestStrategy 双校验（验收："策略可配置"——
 * config 约束注入会话且平台侧拒绝违约组合；"与用例生成衔接"——selections
 * 携带优先级与 focus 键、coverageTargets 按维度落目标、focus 键对照
 * ProductModel 零悬空引用）。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 花真实 token——单轮策略设计，成本受 Run 预算上限约束）。产品知识用
 * T-E02-07 会话产出形状的内联 ProductModel（知识抽取链路已由
 * product-analyst-live 验收）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    ProductModelSchema,
    orderedSelections,
    resolveTestStrategyConfig,
    testArchitectDefinition,
    type AgentContext,
    type AgentDefinitionRecord,
    type ProductModel,
    type StrategyPriority,
} from "@aqaos/domain";
import { runTestArchitectSession } from "./test-architect.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const DEFINITION: AgentDefinitionRecord = {
    id: "9e2e120d-08a2-4fc4-a04e-efd909c757a1",
    name: "test-architect",
    version: "2",
    promptVersion: "0.2.0",
    prompt: testArchitectDefinition().prompt,
    config: {},
    enabled: true,
};

const agentContext: AgentContext = {
    runId: "9e2e120d-08a2-4fc4-a04e-efd909c757a2",
    applicationId: "9e2e120d-08a2-4fc4-a04e-efd909c757a3",
    environmentId: "9e2e120d-08a2-4fc4-a04e-efd909c757a4",
    objective: "Design the test strategy for the shop checkout flow",
    budget: { maxTokens: 80_000, maxModelCostUsd: 1, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0209-live-acceptance",
};

/** 产品知识：product-analyst 产出形状的内联模型（键面即 focus 对照域）。 */
const PRODUCT_MODEL: ProductModel = ProductModelSchema.parse({
    summary: "Web shop with authenticated checkout",
    businessEntities: [
        { key: "order", name: "Order", confidence: "confirmed" },
        { key: "cart", name: "Cart", confidence: "confirmed" },
    ],
    userRoles: [
        { key: "shopper", name: "Shopper", confidence: "confirmed" },
        { key: "guest", name: "Guest visitor", confidence: "confirmed" },
    ],
    journeys: [
        {
            key: "checkout-journey",
            name: "Checkout",
            actor: "shopper",
            steps: [
                { name: "Add to cart", action: "Add an item", targetEntity: "cart" },
                { name: "Place order", action: "Submit the order", targetEntity: "order" },
                { name: "Pay", action: "Click pay", targetEntity: "order" },
            ],
            confidence: "confirmed",
        },
        {
            key: "browse-journey",
            name: "Browse as guest",
            actor: "guest",
            steps: [{ name: "View catalog", action: "Open the catalog page" }],
            confidence: "confirmed",
        },
    ],
    apiDependencies: [
        { key: "create-order", method: "post", path: "/orders", confidence: "confirmed" },
        { key: "pay-order", method: "post", path: "/orders/{id}/pay", confidence: "confirmed" },
    ],
    stateTransitions: [
        {
            key: "order-pending-paid",
            entity: "order",
            from: "pending",
            to: "paid",
            trigger: "successful payment",
            confidence: "confirmed",
        },
    ],
    openQuestions: ["Refund policy is not documented"],
});

describe.skipIf(!LIVE)("live Test Architect session (T-E02-09 acceptance)", () => {
    it(
        "真实策略会话产出结构化策略：schema+合同双校验零 issues、优先级有序、focus 键零悬空",
        { timeout: 300_000 },
        async () => {
            // 策略可配置：注入必选 + 封顶 + 建议类型（Planner 意图切片）。
            const config = resolveTestStrategyConfig({
                requiredTestTypes: ["functional"],
                coverageTargetCaps: [{ dimension: "journey", targetPercent: 90 }],
            });
            const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-architect-"));
            const outcome = await runTestArchitectSession({
                definition: DEFINITION,
                context: agentContext,
                productModel: PRODUCT_MODEL,
                plannerIntent: {
                    objective: "Verify checkout end to end on the web platform",
                    testTypes: ["smoke", "functional", "negative"],
                },
                config,
                cwd,
            });

            // 会话终态 + 双校验全过（含配置约束与 focus 键对照）。
            expect(outcome.session.status).toBe("completed");
            expect(outcome.issues).toEqual([]);

            const strategy = outcome.strategy;
            expect(strategy).toBeDefined();
            if (strategy === undefined) {
                return;
            }
            // 组合非空、类型合法、必选 functional 在选（合同已保证，钉死断言）。
            expect(strategy.selections.length).toBeGreaterThanOrEqual(2);
            expect(
                strategy.selections.some((selection) => selection.testType === "functional"),
            ).toBe(true);
            // 每项选择带理据（无凭空选择）。
            for (const selection of strategy.selections) {
                expect(selection.rationale.length).toBeGreaterThan(0);
            }
            // 优先级档位合法且生成侧顺序单调不回退。
            const ordered = orderedSelections(strategy);
            const rank: Record<StrategyPriority, number> = { p0: 0, p1: 1, p2: 2 };
            for (let index = 1; index < ordered.length; index += 1) {
                const previous = ordered[index - 1];
                const current = ordered[index];
                if (previous !== undefined && current !== undefined) {
                    expect(rank[current.priority]).toBeGreaterThanOrEqual(rank[previous.priority]);
                }
            }
            // 覆盖率目标：journey 维度受封顶约束（合同保证），其余维度
            // 0-100 由 schema 保证（封顶只配置了 journey）。
            for (const target of strategy.coverageTargets) {
                if (target.dimension === "journey") {
                    expect(target.targetPercent).toBeLessThanOrEqual(90);
                } else {
                    expect(target.targetPercent).toBeGreaterThanOrEqual(0);
                    expect(target.targetPercent).toBeLessThanOrEqual(100);
                }
            }
            // focus 键对照产品模型零悬空（validateTestStrategy 已保证）。
            const journeys = new Set(PRODUCT_MODEL.journeys.map((journey) => journey.key));
            const entities = new Set(PRODUCT_MODEL.businessEntities.map((entity) => entity.key));
            const roles = new Set(PRODUCT_MODEL.userRoles.map((role) => role.key));
            for (const selection of strategy.selections) {
                for (const key of selection.focus.journeys) {
                    expect(journeys.has(key)).toBe(true);
                }
                for (const key of selection.focus.entities) {
                    expect(entities.has(key)).toBe(true);
                }
                for (const key of selection.focus.roles) {
                    expect(roles.has(key)).toBe(true);
                }
            }
        },
    );
});
