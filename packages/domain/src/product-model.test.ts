/**
 * Product Model 域契约回归（T-E02-07，DDD §4.3 / SRS FR-006）：
 * - schema：默认回填（apiDependencies/stateTransitions/openQuestions）、
 *   strict 拒绝未知字段、置信标注必填（"无凭空事实"）；
 * - validateProductModel：键唯一 + 交叉引用完整性（actor/实体/API/迁移实体）；
 * - productModelToKnowledgeGraph：五类节点 + 四类边、置信入
 *   properties.confidence、边去重、状态节点共享；
 * - PRODUCT_MODEL_JSON_SCHEMA：outputFormat 单源派生（顶层 object 全属性）；
 * - productAnalystDefinition：v2 prompt 与迁移 0009 种子同源。
 */

import { describe, expect, it } from "vitest";
import {
    PRODUCT_MODEL_JSON_SCHEMA,
    ProductModelSchema,
    KNOWLEDGE_RELATIONS,
    ROLE_PROMPT_BASELINES,
    productAnalystDefinition,
    productModelToKnowledgeGraph,
    validateProductModel,
    type ProductModel,
} from "./index.js";

/** 去掉 strict 之外的可选字段的最小合法输入（构造违约用例的基座）。 */
function modelInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        summary: "Minimal shop model for checkout",
        businessEntities: [{ key: "order", name: "Order", confidence: "confirmed" }],
        userRoles: [{ key: "shopper", name: "Shopper", confidence: "confirmed" }],
        journeys: [
            {
                key: "checkout-journey",
                name: "Checkout",
                actor: "shopper",
                steps: [{ name: "Pay", action: "Click pay", targetEntity: "order" }],
                confidence: "inferred",
                inferredFrom: "docs describe the checkout flow",
            },
        ],
        ...overrides,
    };
}

describe("ProductModelSchema（解析与默认回填）", () => {
    it("最小输入合法：apiDependencies/stateTransitions/openQuestions 回填空数组", () => {
        const parsed = ProductModelSchema.parse(modelInput());
        expect(parsed.apiDependencies).toEqual([]);
        expect(parsed.stateTransitions).toEqual([]);
        expect(parsed.openQuestions).toEqual([]);
        expect(parsed.journeys[0]?.steps).toHaveLength(1);
    });

    it("strict：未知字段被拒；置信标注必填（无凭空事实）", () => {
        expect(ProductModelSchema.safeParse(modelInput({ extra: 1 })).success).toBe(false);
        const noConfidence = modelInput({
            businessEntities: [{ key: "order", name: "Order" }],
        });
        expect(ProductModelSchema.safeParse(noConfidence).success).toBe(false);
        const badConfidence = modelInput({
            businessEntities: [{ key: "order", name: "Order", confidence: "definitely" }],
        });
        expect(ProductModelSchema.safeParse(badConfidence).success).toBe(false);
    });

    it("key 约定：小写连字符；非约定形态被拒", () => {
        expect(
            ProductModelSchema.safeParse(
                modelInput({
                    businessEntities: [{ key: "Order!", name: "O", confidence: "confirmed" }],
                }),
            ).success,
        ).toBe(false);
    });
});

describe("validateProductModel（引用完整性合同）", () => {
    it("合法模型 → 空问题列表", () => {
        const model = ProductModelSchema.parse(modelInput());
        expect(validateProductModel(model)).toEqual([]);
    });

    it("旅程 actor 未声明 → UNKNOWN_ACTOR；步骤实体/API 未声明 → UNKNOWN_ENTITY/UNKNOWN_API", () => {
        const model = ProductModelSchema.parse(
            modelInput({
                journeys: [
                    {
                        key: "j1",
                        name: "J1",
                        actor: "ghost-role",
                        steps: [
                            {
                                name: "s",
                                action: "a",
                                targetEntity: "ghost-entity",
                                apiDependency: "ghost-api",
                            },
                        ],
                        confidence: "inferred",
                    },
                ],
                apiDependencies: [
                    { key: "real-api", method: "post", path: "/orders", confidence: "confirmed" },
                ],
            }),
        );
        const issues = validateProductModel(model);
        expect(issues.map((issue) => issue.code)).toEqual([
            "UNKNOWN_ACTOR",
            "UNKNOWN_ENTITY",
            "UNKNOWN_API",
        ]);
        expect(issues[0]?.path).toBe("journeys.j1.actor");
    });

    it("状态迁移实体未声明 → UNKNOWN_TRANSITION_ENTITY；键重复 → DUPLICATE_KEY", () => {
        const model = ProductModelSchema.parse(
            modelInput({
                stateTransitions: [
                    {
                        key: "t1",
                        entity: "ghost",
                        from: "pending",
                        to: "paid",
                        confidence: "unknown",
                    },
                ],
                userRoles: [
                    { key: "shopper", name: "S", confidence: "confirmed" },
                    { key: "shopper", name: "S2", confidence: "confirmed" },
                ],
            }),
        );
        const codes = validateProductModel(model).map((issue) => issue.code);
        expect(codes).toContain("DUPLICATE_KEY");
        expect(codes).toContain("UNKNOWN_TRANSITION_ENTITY");
    });
});

describe("productModelToKnowledgeGraph（迁移 0004 落库映射）", () => {
    const model = ProductModelSchema.parse(
        modelInput({
            apiDependencies: [
                {
                    key: "create-order",
                    method: "post",
                    path: "/orders",
                    summary: "Create an order",
                    confidence: "confirmed",
                },
            ],
            stateTransitions: [
                {
                    key: "order-paid",
                    entity: "order",
                    from: "pending",
                    to: "paid",
                    trigger: "payment success",
                    confidence: "confirmed",
                },
            ],
            journeys: [
                {
                    key: "checkout-journey",
                    name: "Checkout",
                    actor: "shopper",
                    steps: [
                        {
                            name: "Create order",
                            action: "POST /orders",
                            targetEntity: "order",
                            apiDependency: "create-order",
                        },
                        // 第二步触达同一实体：covers 边必须去重。
                        { name: "Pay", action: "Click pay", targetEntity: "order" },
                    ],
                    confidence: "inferred",
                    inferredFrom: "docs",
                },
            ],
        }),
    ) as ProductModel;

    it("五类节点 + 四类边；置信标注存 properties.confidence", () => {
        const graph = productModelToKnowledgeGraph(model);
        const nodeTypes = new Set(graph.nodes.map((node) => node.nodeType));
        expect([...nodeTypes].sort()).toEqual([
            "api-endpoint",
            "business-entity",
            "entity-state",
            "journey",
            "user-role",
        ]);
        // 每个事实节点的置信标注落 properties.confidence（表注释约定）。
        const factNodes = graph.nodes.filter((node) => node.nodeType !== "entity-state");
        expect(factNodes.length).toBeGreaterThan(0);
        for (const node of factNodes) {
            expect(["confirmed", "inferred", "unknown"]).toContain(
                node.properties.confidence as string,
            );
        }
        const relations = new Set(graph.edges.map((edge) => edge.relation));
        expect([...relations].sort()).toEqual([...KNOWLEDGE_RELATIONS].sort());
    });

    it("边按 (source, target, relation) 去重；externalKey 形态稳定", () => {
        const graph = productModelToKnowledgeGraph(model);
        const covers = graph.edges.filter((edge) => edge.relation === "covers");
        expect(covers).toHaveLength(1);
        expect(covers[0]).toEqual({
            sourceKey: "journey:checkout-journey",
            targetKey: "business-entity:order",
            relation: "covers",
            properties: { confidence: "inferred" },
        });
        const keys = new Set(graph.nodes.map((node) => node.externalKey));
        expect(keys.has("journey:checkout-journey")).toBe(true);
        expect(keys.has("api-endpoint:create-order")).toBe(true);
        expect(keys.has("entity-state:order:pending")).toBe(true);
        expect(keys.has("entity-state:order:paid")).toBe(true);
        // API 节点带 method/path（供 API 测试域消费）。
        const apiNode = graph.nodes.find(
            (node) => node.externalKey === "api-endpoint:create-order",
        );
        expect(apiNode?.properties.method).toBe("post");
        expect(apiNode?.properties.path).toBe("/orders");
    });

    it("状态迁移边带 trigger 与置信；共享状态跨迁移只落一节点", () => {
        const twoTransitions = ProductModelSchema.parse(
            modelInput({
                stateTransitions: [
                    {
                        key: "t-paid",
                        entity: "order",
                        from: "pending",
                        to: "paid",
                        trigger: "payment",
                        confidence: "confirmed",
                    },
                    {
                        key: "t-shipped",
                        entity: "order",
                        from: "paid",
                        to: "shipped",
                        trigger: "fulfillment",
                        confidence: "inferred",
                        inferredFrom: "ops doc",
                    },
                ],
            }),
        );
        const graph = productModelToKnowledgeGraph(twoTransitions);
        const stateNodes = graph.nodes.filter((node) => node.nodeType === "entity-state");
        expect(stateNodes).toHaveLength(3); // pending/paid/shipped（paid 共享）
        const transitionEdges = graph.edges.filter((edge) => edge.relation === "transition");
        expect(transitionEdges).toHaveLength(2);
        expect(transitionEdges[0]?.properties.trigger).toBe("payment");
    });
});

describe("PRODUCT_MODEL_JSON_SCHEMA（outputFormat 单源）", () => {
    it("顶层 object、七个属性、strict 派生 additionalProperties=false", () => {
        expect(PRODUCT_MODEL_JSON_SCHEMA.type).toBe("object");
        const properties = PRODUCT_MODEL_JSON_SCHEMA.properties as Record<string, unknown>;
        expect(Object.keys(properties).sort()).toEqual([
            "apiDependencies",
            "businessEntities",
            "journeys",
            "openQuestions",
            "stateTransitions",
            "summary",
            "userRoles",
        ]);
        expect(PRODUCT_MODEL_JSON_SCHEMA.additionalProperties).toBe(false);
        const entities = properties.businessEntities as { items: { required?: string[] } };
        expect(entities.items.required).toContain("confidence");
    });
});

describe("productAnalystDefinition（迁移 0009 种子单一事实源）", () => {
    it("v2 行：结构化产出 + 置信纪律 prompt；allowedTools 含 memory 双工具", () => {
        const definition = productAnalystDefinition();
        expect(definition.name).toBe("product-analyst");
        expect(definition.version).toBe("2");
        expect(definition.promptVersion).toBe("0.2.0");
        expect(definition.enabled).toBe(true);
        expect(definition.prompt).toContain("# Output");
        expect(definition.prompt).toContain("single JSON object");
        expect(definition.prompt).toContain("confirmed");
        expect(definition.prompt).toContain("openQuestions");
        expect(definition.config.allowedTools).toContain("mcp__aqaos__memory_read_knowledge");
        expect(definition.config.allowedTools).toContain("mcp__aqaos__memory_write_knowledge");
        // v2 是新通道（结构化产出），不是 v1 会话骨架的修补。
        expect(definition.prompt).not.toBe(ROLE_PROMPT_BASELINES["product-analyst"]);
    });
});
