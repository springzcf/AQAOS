/**
 * Test Architect 会话回归（T-E02-09，DDD §4.5/§3.7）。
 *
 * 离线全链路（queryFn 注入假流）：
 * - outputFormat 通道：SDK Options.outputFormat = json_schema + 域层单源
 *   TEST_STRATEGY_JSON_SCHEMA；
 * - 合法 structured_output → strategy 零 issues；配置约束注入 prompt
 *   （"策略可配置"）；focus 键对照 ProductModel（"与用例生成衔接" +
 *   无悬空引用）；
 * - 合同违约（越权类型/悬空 focus 键）→ 有界纠偏轮（第二轮带反馈清单）；
 *   仍违约 → issues 返回；
 * - SESSION_FAILED / PARSE_FAILED + resultText 回退。
 */

import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
    TEST_STRATEGY_JSON_SCHEMA,
    TestStrategySchema,
    resolveTestStrategyConfig,
    type AgentContext,
    type AgentDefinitionRecord,
    type ProductModel,
} from "@aqaos/domain";
import { testArchitectPrompt, runTestArchitectSession } from "./test-architect.js";

const DEFINITION: AgentDefinitionRecord = {
    id: "e2000000-0000-4000-8000-00000000000a",
    name: "test-architect",
    version: "2",
    promptVersion: "0.2.0",
    prompt: "You are the AQAOS Test Architect (test-architect), the scenario-design agent.",
    config: {},
    enabled: true,
};

const CONTEXT: AgentContext = {
    runId: "7e2e120d-08a2-4fc4-a04e-efd909c75783",
    applicationId: "7e2e120d-08a2-4fc4-a04e-efd909c75772",
    environmentId: "7e2e120d-08a2-4fc4-a04e-efd909c75774",
    objective: "保障结账主链路质量",
    budget: { maxTokens: 100_000, maxModelCostUsd: 2, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "trace-ta-1",
};

const PRODUCT_MODEL = {
    summary: "Minimal web shop with checkout",
    businessEntities: [{ key: "order", name: "Order", confidence: "confirmed" }],
    userRoles: [{ key: "shopper", name: "Shopper", confidence: "confirmed" }],
    journeys: [
        {
            key: "checkout-journey",
            name: "Checkout",
            actor: "shopper",
            steps: [{ name: "Pay", action: "Click pay", targetEntity: "order" }],
            confidence: "confirmed",
        },
    ],
    apiDependencies: [
        { key: "create-order", method: "post", path: "/orders", confidence: "confirmed" },
    ],
    stateTransitions: [],
    openQuestions: [],
} as unknown as ProductModel;

const VALID_STRATEGY = TestStrategySchema.parse({
    summary: "Checkout-first strategy",
    selections: [
        {
            testType: "functional",
            priority: "p0",
            rationale: "checkout journey is the money path",
            focus: { journeys: ["checkout-journey"], entities: ["order"], roles: ["shopper"] },
        },
        {
            testType: "negative",
            priority: "p1",
            rationale: "payment failure handling around the order entity",
            focus: { entities: ["order"] },
        },
    ],
    coverageTargets: [{ dimension: "journey", targetPercent: 80 }],
    risks: ["payment failure handling is undocumented"],
    openQuestions: ["refund policy"],
});

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
            result: options.resultText ?? "designed",
            structured_output: options.structuredOutput,
            session_id: "sess-ta-1",
            duration_ms: 900,
            duration_api_ms: 800,
            num_turns: 1,
            total_cost_usd: 0.005,
            usage: { input_tokens: 70, output_tokens: 50 },
            modelUsage: {
                "claude-opus-5-5": { input_tokens: 70, output_tokens: 50, costUSD: 0.005 },
            },
        } as unknown as SDKMessage;
    };
}

const PARAMS = {
    definition: DEFINITION,
    context: CONTEXT,
};

describe("testArchitectPrompt（策略轮输入组装）", () => {
    it("知识/意图/配置约束分段呈现", () => {
        const text = testArchitectPrompt({
            productModel: PRODUCT_MODEL,
            plannerIntent: {
                objective: "Verify checkout end to end",
                testTypes: ["smoke", "functional"],
            },
            config: resolveTestStrategyConfig({
                allowedTestTypes: ["smoke", "functional", "negative"],
                requiredTestTypes: ["functional"],
                maxSelections: 5,
                coverageTargetCaps: [{ dimension: "journey", targetPercent: 70 }],
            }),
        });
        expect(text).toContain("Objective:\nVerify checkout end to end");
        expect(text).toContain("Product knowledge (Product Model JSON):");
        expect(text).toContain("checkout-journey");
        expect(text).toContain("Suggested test types");
        expect(text).toContain("Strategy constraints:");
        expect(text).toContain("allowed test types: smoke, functional, negative");
        expect(text).toContain("required test types (must be selected): functional");
        expect(text).toContain("max selections: 5");
        expect(text).toContain("journey ≤ 70%");
    });

    it("缺省（无知识/意图/配置）只剩指令与契约行", () => {
        const text = testArchitectPrompt({});
        expect(text).not.toContain("Objective:");
        expect(text).not.toContain("Product knowledge");
        expect(text).not.toContain("Strategy constraints");
        expect(text).toContain("JSON object");
    });
});

describe("runTestArchitectSession（结构化策略产出）", () => {
    it("合法 structured_output → strategy 零 issues（对照产品模型）", async () => {
        const outcome = await runTestArchitectSession({
            ...PARAMS,
            productModel: PRODUCT_MODEL,
            plannerIntent: { objective: "Verify checkout", testTypes: ["functional"] },
            config: resolveTestStrategyConfig({ requiredTestTypes: ["functional"] }),
            queryFn: fakeStream({ structuredOutput: VALID_STRATEGY }),
        });
        expect(outcome.session.status).toBe("completed");
        expect(outcome.issues).toEqual([]);
        expect(outcome.strategy?.selections).toHaveLength(2);
        expect(outcome.strategy?.selections[0]?.focus.journeys).toEqual(["checkout-journey"]);
    });

    it("outputFormat 通道：Options.outputFormat = json_schema + 域层单源 schema", async () => {
        let seen: Options | undefined;
        await runTestArchitectSession({
            ...PARAMS,
            productModel: PRODUCT_MODEL,
            queryFn: fakeStream({ structuredOutput: VALID_STRATEGY, onOptions: (o) => (seen = o) }),
        });
        expect(seen?.outputFormat).toEqual({
            type: "json_schema",
            schema: TEST_STRATEGY_JSON_SCHEMA,
        });
    });

    it("悬空 focus 键 → 有界纠偏轮（第二次合法）→ 成功", async () => {
        const broken = {
            ...VALID_STRATEGY,
            selections: [
                {
                    testType: "functional",
                    priority: "p0",
                    rationale: "r",
                    focus: { journeys: ["ghost-journey"] },
                },
                VALID_STRATEGY.selections[1],
            ],
        } as Record<string, unknown>;
        const prompts: string[] = [];
        let call = 0;
        const outputs = [broken, VALID_STRATEGY];
        const stream = async function* (params: { prompt: string; options?: Options }) {
            prompts.push(params.prompt);
            yield* fakeStream({ structuredOutput: outputs[call] ?? VALID_STRATEGY })(params);
            call += 1;
        };
        const outcome = await runTestArchitectSession({
            ...PARAMS,
            productModel: PRODUCT_MODEL,
            queryFn: stream,
        });
        expect(outcome.issues).toEqual([]);
        expect(outcome.strategy).toBeDefined();
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("Contract feedback");
        expect(prompts[1]).toContain("ghost-journey");
    });

    it("纠偏轮仍违约 → 第二轮 issues 返回（有界两轮）", async () => {
        const alwaysBroken = {
            ...VALID_STRATEGY,
            selections: [
                {
                    testType: "functional",
                    priority: "p0",
                    rationale: "r",
                    focus: { entities: ["ghost-entity"] },
                },
                VALID_STRATEGY.selections[1],
            ],
        };
        let attempts = 0;
        const outcome = await runTestArchitectSession({
            ...PARAMS,
            productModel: PRODUCT_MODEL,
            queryFn: async function* (params) {
                attempts += 1;
                yield* fakeStream({ structuredOutput: alwaysBroken })(params);
            },
        });
        expect(attempts).toBe(2);
        expect(outcome.strategy).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("UNKNOWN_ENTITY");
    });

    it("配置违约（越权类型 + 必选缺席）→ 纠偏轮注入约束反馈", async () => {
        const config = resolveTestStrategyConfig({
            allowedTestTypes: ["smoke"],
            requiredTestTypes: ["smoke"],
        });
        const prompts: string[] = [];
        let call = 0;
        const outputs = [
            VALID_STRATEGY,
            {
                ...VALID_STRATEGY,
                selections: [{ testType: "smoke", priority: "p0", rationale: "r" }],
            },
        ];
        const outcome = await runTestArchitectSession({
            ...PARAMS,
            config,
            queryFn: async function* (params) {
                prompts.push(params.prompt);
                yield* fakeStream({ structuredOutput: outputs[call] })(params);
                call += 1;
            },
        });
        // 第二轮选择 smoke（合法且满足必选）→ 成功。反馈注入的是可读违约
        // 清单（含越权类型与必选缺席的语义），非原始码。
        expect(outcome.issues).toEqual([]);
        expect(prompts[1]).toContain("not in the allowed set");
        expect(prompts[1]).toContain("missing from selections");
    });

    it("schema 违约 → PARSE_FAILED；structured_output 缺席回退 resultText", async () => {
        const missing = await runTestArchitectSession({
            ...PARAMS,
            queryFn: fakeStream({
                structuredOutput: { summary: "x", selections: [{ testType: "smoke" }] },
            }),
        });
        expect(missing.issues[0]?.code).toBe("PARSE_FAILED");

        const fallback = await runTestArchitectSession({
            ...PARAMS,
            queryFn: fakeStream({
                structuredOutput: undefined,
                resultText: JSON.stringify(VALID_STRATEGY),
            }),
        });
        expect(fallback.strategy?.selections).toHaveLength(2);
    });

    it("会话非 completed 终态 → SESSION_FAILED，不解析", async () => {
        const outcome = await runTestArchitectSession({
            ...PARAMS,
            queryFn: fakeStream({ isError: true }),
        });
        expect(outcome.session.status).toBe("failed");
        expect(outcome.issues[0]?.code).toBe("SESSION_FAILED");
        expect(outcome.strategy).toBeUndefined();
    });
});
