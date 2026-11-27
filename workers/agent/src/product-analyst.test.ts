/**
 * Product Analyst 会话回归（T-E02-07，DDD §4.3）。
 *
 * 离线全链路（queryFn 注入假流 + 内存假 McpServices）：
 * - outputFormat 通道：SDK Options.outputFormat = json_schema + 域层单源
 *   PRODUCT_MODEL_JSON_SCHEMA；
 * - 验收"产出写入 knowledge_nodes"：合法 structured_output → model + graph
 *   + persisted（dispatch memory.write_knowledge 携带 product-analyst 上下文
 *   与图谱负载）；写库失败/拒绝 → issue 且 model 保留（分析不白做）；
 * - 验收"无凭空事实"：schema 强制逐事实 confidence；引用完整性违约
 *   （悬空 actor/实体）→ issues 阻断落库；
 * - 会话终态失败 → SESSION_FAILED；structured_output 缺席回退 resultText。
 */

import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
    PRODUCT_MODEL_JSON_SCHEMA,
    type AgentContext,
    type AgentDefinitionRecord,
} from "@aqaos/domain";
import { agentToolCallContext, type McpServices, type ToolAuditRecord } from "@aqaos/mcp";
import { productAnalystPrompt, runProductAnalystSession } from "./product-analyst.js";

const DEFINITION: AgentDefinitionRecord = {
    id: "e2000000-0000-4000-8000-000000000001",
    name: "product-analyst",
    version: "2",
    promptVersion: "0.2.0",
    prompt: "You are the AQAOS Product Analyst (product-analyst), the domain-knowledge agent.",
    config: {},
    enabled: true,
};

const ORG = "7e2e120d-08a2-4fc4-a04e-efd909c75771";
const APP = "7e2e120d-08a2-4fc4-a04e-efd909c75772";

const CONTEXT: AgentContext = {
    runId: "7e2e120d-08a2-4fc4-a04e-efd909c75773",
    applicationId: APP,
    environmentId: "7e2e120d-08a2-4fc4-a04e-efd909c75774",
    objective: "提取结账主链路的产品知识",
    budget: { maxTokens: 100_000, maxModelCostUsd: 2, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "trace-pa-1",
};

const TOOL_CONTEXT = agentToolCallContext({
    organizationId: ORG,
    agentRole: "product-analyst",
    runId: CONTEXT.runId,
    agentName: "product-analyst@2",
});

const VALID_MODEL = {
    summary: "Minimal web shop with checkout",
    businessEntities: [{ key: "order", name: "Order", confidence: "confirmed" }],
    userRoles: [{ key: "shopper", name: "Shopper", confidence: "confirmed" }],
    journeys: [
        {
            key: "checkout-journey",
            name: "Checkout",
            actor: "shopper",
            steps: [
                {
                    name: "Pay order",
                    action: "Click pay on the order page",
                    targetEntity: "order",
                },
            ],
            confidence: "inferred",
            inferredFrom: "landing page describes checkout flow",
        },
    ],
    apiDependencies: [
        {
            key: "create-order",
            method: "post",
            path: "/orders",
            confidence: "confirmed",
        },
    ],
    stateTransitions: [],
    openQuestions: ["Refund policy is not documented"],
} satisfies Record<string, unknown>;

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
            result: options.resultText ?? "analyzed",
            structured_output: options.structuredOutput,
            session_id: "sess-pa-1",
            duration_ms: 1200,
            duration_api_ms: 1100,
            num_turns: 1,
            total_cost_usd: 0.01,
            usage: { input_tokens: 90, output_tokens: 60 },
            modelUsage: {
                "claude-opus-5-5": { input_tokens: 90, output_tokens: 60, costUSD: 0.01 },
            },
        } as unknown as SDKMessage;
    };
}

function fakeServices() {
    const audits: ToolAuditRecord[] = [];
    let written: { nodes: unknown[]; edges: unknown[]; org: string; app: string } | undefined;
    const services: McpServices = {
        async getRun() {
            return null;
        },
        async listBugs() {
            return [];
        },
        async getCoverage() {
            return null;
        },
        async listEnvironments() {
            return [];
        },
        async readKnowledge() {
            return { nodes: [], edges: [] };
        },
        async searchMemories() {
            return [];
        },
        async writeKnowledge(input) {
            written = {
                nodes: input.nodes,
                edges: input.edges,
                org: input.organizationId,
                app: input.applicationId,
            };
            return { writtenNodes: input.nodes.length, writtenEdges: input.edges.length };
        },
        async recordToolCall(record) {
            audits.push(record);
        },
    };
    return { services, audits, getWritten: () => written };
}

const PARAMS = {
    definition: DEFINITION,
    context: CONTEXT,
    sources: { url: "A shop landing page. Shoppers can browse, add to cart, and pay." },
    toolContext: TOOL_CONTEXT,
};

describe("productAnalystPrompt（分析轮输入组装）", () => {
    it("材料分段呈现（URL/OpenAPI/文档）+ 契约重申行", () => {
        const text = productAnalystPrompt({
            ...PARAMS,
            sources: {
                url: "Landing text",
                openapi: "openapi: 3.0.0\npaths: /orders",
                documents: ["Doc A", "Doc B"],
            },
        });
        expect(text).toContain("Product URL / landing page text:\nLanding text");
        expect(text).toContain("API contract (OpenAPI):\nopenapi: 3.0.0");
        expect(text).toContain("Product document 1:\nDoc A");
        expect(text).toContain("Product document 2:\nDoc B");
        expect(text).toContain("JSON object");
    });
});

describe("runProductAnalystSession（结构化模型产出 + 确定性落库）", () => {
    it("合法 structured_output → model + graph + persisted（dispatch 携带 product-analyst 上下文与图谱负载）", async () => {
        const { services, getWritten } = fakeServices();
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            sources: {
                documents: ["Checkout: shopper pays the order, order becomes paid."],
            },
            queryFn: fakeStream({ structuredOutput: VALID_MODEL }),
            services,
        });
        expect(outcome.session.status).toBe("completed");
        expect(outcome.issues).toEqual([]);
        expect(outcome.model?.businessEntities[0]?.key).toBe("order");
        expect(outcome.graph?.nodes.length).toBeGreaterThanOrEqual(3);

        // 确定性落库：payload 按 (applicationId, org) 送达，节点带置信标注。
        const written = getWritten();
        expect(written).toBeDefined();
        expect(written?.app).toBe(APP);
        expect(written?.org).toBe(ORG);
        const nodes = written?.nodes as {
            externalKey: string;
            properties: Record<string, unknown>;
        }[];
        expect(nodes.some((node) => node.externalKey === "business-entity:order")).toBe(true);
        for (const node of nodes) {
            expect(["confirmed", "inferred", "unknown"]).toContain(node.properties.confidence);
        }
        expect(outcome.persisted).toEqual({ writtenNodes: 4, writtenEdges: 2 });
    });

    it("outputFormat 通道：Options.outputFormat = json_schema + 域层单源 schema", async () => {
        let seen: Options | undefined;
        const { services } = fakeServices();
        await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({ structuredOutput: VALID_MODEL, onOptions: (o) => (seen = o) }),
            services,
        });
        expect(seen?.outputFormat).toEqual({
            type: "json_schema",
            schema: PRODUCT_MODEL_JSON_SCHEMA,
        });
    });

    it("引用违约（旅程 actor 未声明）→ issues 含 UNKNOWN_ACTOR，不落库", async () => {
        const { services, getWritten } = fakeServices();
        const broken = {
            ...VALID_MODEL,
            journeys: [
                {
                    key: "checkout-journey",
                    name: "Checkout",
                    actor: "ghost-role",
                    steps: [{ name: "Pay", action: "Click pay" }],
                    confidence: "inferred",
                },
            ],
        };
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({ structuredOutput: broken }),
            services,
        });
        expect(outcome.model).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("UNKNOWN_ACTOR");
        expect(getWritten()).toBeUndefined();
    });

    it("schema 违约（缺 confidence）→ PARSE_FAILED；structured_output 缺席回退 resultText", async () => {
        const { services } = fakeServices();
        const missing = await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({
                structuredOutput: {
                    summary: "x",
                    businessEntities: [{ key: "order", name: "Order" }],
                    userRoles: VALID_MODEL.userRoles,
                    journeys: VALID_MODEL.journeys,
                },
            }),
            services,
        });
        expect(missing.issues[0]?.code).toBe("PARSE_FAILED");

        const fallback = await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({
                structuredOutput: undefined,
                resultText: JSON.stringify(VALID_MODEL),
            }),
            services,
        });
        expect(fallback.model?.businessEntities).toHaveLength(1);
    });

    it("写库失败 → KNOWLEDGE_WRITE_FAILED，model/graph 保留（分析不丢弃，调用方可重试写库）", async () => {
        const failingServices: McpServices = {
            ...fakeServices().services,
            async writeKnowledge() {
                throw new Error("pg down");
            },
        };
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({ structuredOutput: VALID_MODEL }),
            services: failingServices,
        });
        expect(outcome.model).toBeDefined();
        expect(outcome.persisted).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("KNOWLEDGE_WRITE_FAILED");
    });

    it("无授权上下文（reporter）→ dispatch denied → KNOWLEDGE_WRITE_DENIED", async () => {
        const { services } = fakeServices();
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            toolContext: agentToolCallContext({
                organizationId: ORG,
                agentRole: "reporter",
                runId: CONTEXT.runId,
            }),
            queryFn: fakeStream({ structuredOutput: VALID_MODEL }),
            services,
        });
        expect(outcome.model).toBeDefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("KNOWLEDGE_WRITE_DENIED");
    });

    it("合同违约首轮 → 反馈纠偏轮（第二次合法）→ 成功落库（live 首验场景）", async () => {
        const { services } = fakeServices();
        const missingApi = {
            ...VALID_MODEL,
            // live 首验场景复刻：步骤引用 create-order 但 apiDependencies 留空。
            apiDependencies: [],
            journeys: [
                {
                    key: "checkout-journey",
                    name: "Checkout",
                    actor: "shopper",
                    steps: [
                        {
                            name: "Pay",
                            action: "Click pay",
                            targetEntity: "order",
                            apiDependency: "create-order",
                        },
                    ],
                    confidence: "inferred",
                },
            ],
        } as Record<string, unknown>;
        const prompts: string[] = [];
        let call = 0;
        const outputs = [missingApi, VALID_MODEL];
        const stream = async function* (params: { prompt: string; options?: Options }) {
            prompts.push(params.prompt);
            yield* fakeStream({ structuredOutput: outputs[call] ?? VALID_MODEL })(params);
            call += 1;
        };
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            queryFn: stream,
            services,
        });
        expect(outcome.issues).toEqual([]);
        expect(outcome.persisted).toEqual({ writtenNodes: 4, writtenEdges: 2 });
        // 第二轮 prompt 携带违约清单（UNKNOWN_API 指向漏声明的依赖）。
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("Contract feedback");
        expect(prompts[1]).toContain("create-order");
    });

    it("纠偏轮仍违约 → 第二轮 issues 返回（有界纠偏，恰好两轮）", async () => {
        const { services } = fakeServices();
        const alwaysBroken = {
            ...VALID_MODEL,
            journeys: [
                {
                    key: "checkout-journey",
                    name: "Checkout",
                    actor: "ghost-role",
                    steps: [{ name: "Pay", action: "Click pay" }],
                    confidence: "inferred",
                },
            ],
        };
        let attempts = 0;
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            queryFn: async function* (params) {
                attempts += 1;
                yield* fakeStream({ structuredOutput: alwaysBroken })(params);
            },
            services,
        });
        expect(attempts).toBe(2);
        expect(outcome.model).toBeUndefined();
        expect(outcome.issues.map((issue) => issue.code)).toContain("UNKNOWN_ACTOR");
    });

    it("会话非 completed 终态 → SESSION_FAILED，不解析不落库", async () => {
        const { services, getWritten } = fakeServices();
        const outcome = await runProductAnalystSession({
            ...PARAMS,
            queryFn: fakeStream({ isError: true }),
            services,
        });
        expect(outcome.session.status).toBe("failed");
        expect(outcome.issues[0]?.code).toBe("SESSION_FAILED");
        expect(getWritten()).toBeUndefined();
    });
});
