/**
 * Test Strategy 契约回归（T-E02-09，DDD §4.5）。
 *
 * - Schema：默认值回填（focus/coverageTargets/risks/openQuestions）、strict
 *   拒绝未知键、非法枚举拒绝（十二类/优先级档位/覆盖维度）；
 * - validateTestStrategy 合同九分支：组合去重/允许域/必选缺席/数量上限/
 *   维度去重/目标封顶/配置自洽/悬空 focus 三类引用；
 * - resolveTestStrategyConfig 增量约束合并；orderedSelections 生成侧顺序；
 * - TEST_STRATEGY_JSON_SCHEMA 形状自省（裸顶层 object）；
 * - testArchitectDefinition v2 种子形状（迁移 0010 单一事实源）。
 */

import { describe, expect, it } from "vitest";
import {
    ProductModelSchema,
    ROLE_PROMPT_BASELINES,
    baselineAllowedTools,
    testArchitectDefinition,
    TEST_ARCHITECT_PROMPT,
    TEST_ARCHITECT_PROMPT_VERSION,
    TestStrategySchema,
    validateTestStrategy,
    orderedSelections,
    resolveTestStrategyConfig,
    defaultTestStrategyConfig,
    TEST_STRATEGY_JSON_SCHEMA,
    type TestStrategy,
} from "./index.js";

const MODEL = ProductModelSchema.parse({
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
});

/** 构造样本策略（overrides 为宽松输入；负样本故意非法值经 parse 拒绝）。 */
const strategy = (overrides: Record<string, unknown> = {}): TestStrategy =>
    TestStrategySchema.parse({
        summary: "Checkout-first strategy",
        selections: [
            {
                testType: "functional",
                priority: "p0",
                rationale: "checkout journey is the money path",
                focus: { journeys: ["checkout-journey"], entities: ["order"], roles: ["shopper"] },
            },
            {
                testType: "smoke",
                priority: "p1",
                rationale: "landing must render before anything else",
            },
        ],
        coverageTargets: [{ dimension: "journey", targetPercent: 80 }],
        risks: ["payment failure handling is undocumented"],
        openQuestions: ["refund policy"],
        ...overrides,
    });

describe("TestStrategySchema（解析与默认值）", () => {
    it("focus/coverageTargets/risks/openQuestions 默认回填；strict 拒绝未知键", () => {
        const parsed = TestStrategySchema.parse({
            summary: "s",
            selections: [{ testType: "smoke", priority: "p0", rationale: "r" }],
        });
        expect(parsed.selections[0]?.focus).toEqual({ journeys: [], entities: [], roles: [] });
        expect(parsed.coverageTargets).toEqual([]);
        expect(parsed.risks).toEqual([]);
        expect(parsed.openQuestions).toEqual([]);

        expect(() => TestStrategySchema.parse({ ...strategy(), extra: 1 })).toThrow();
        expect(() => TestStrategySchema.parse({ ...strategy(), selections: [] })).toThrow();
    });

    it("非法枚举拒绝：testType/priority/dimension 越界", () => {
        expect(() =>
            TestStrategySchema.parse({
                ...strategy(),
                selections: [{ testType: "unit", priority: "p0", rationale: "r" }],
            }),
        ).toThrow();
        expect(() =>
            TestStrategySchema.parse({
                ...strategy(),
                selections: [{ testType: "smoke", priority: "p3", rationale: "r" }],
            }),
        ).toThrow();
        expect(() =>
            TestStrategySchema.parse({
                ...strategy(),
                coverageTargets: [{ dimension: "module", targetPercent: 50 }],
            }),
        ).toThrow();
        expect(() =>
            TestStrategySchema.parse({
                ...strategy(),
                coverageTargets: [{ dimension: "risk", targetPercent: 101 }],
            }),
        ).toThrow();
    });
});

describe("resolveTestStrategyConfig（策略可配置）", () => {
    it("缺省 = 十二类全量放开、无必选、无封顶", () => {
        const config = defaultTestStrategyConfig();
        expect(config.allowedTestTypes).toHaveLength(12);
        expect(config.requiredTestTypes).toEqual([]);
        expect(config.coverageTargetCaps).toEqual([]);
        expect(resolveTestStrategyConfig()).toEqual(config);
    });

    it("增量约束合并：必选集 + 类型域收窄 + 覆盖封顶", () => {
        const config = resolveTestStrategyConfig({
            allowedTestTypes: ["smoke", "functional", "negative"],
            requiredTestTypes: ["smoke"],
            coverageTargetCaps: [{ dimension: "journey", targetPercent: 60 }],
        });
        expect(config.allowedTestTypes).toEqual(["smoke", "functional", "negative"]);
        expect(config.requiredTestTypes).toEqual(["smoke"]);
        expect(config.maxSelections).toBe(12);
        expect(config.coverageTargetCaps).toEqual([{ dimension: "journey", targetPercent: 60 }]);
    });
});

describe("validateTestStrategy（合同校验）", () => {
    it("合法策略（对照产品模型）零 issues", () => {
        expect(validateTestStrategy(strategy(), resolveTestStrategyConfig(), MODEL)).toEqual([]);
    });

    it("组合重复 → DUPLICATE_TEST_TYPE", () => {
        const broken = strategy({
            selections: [
                { testType: "smoke", priority: "p0", rationale: "a" },
                { testType: "smoke", priority: "p1", rationale: "b" },
            ],
        });
        const issues = validateTestStrategy(broken);
        expect(issues.map((issue) => issue.code)).toEqual(["DUPLICATE_TEST_TYPE"]);
    });

    it("允许域外选择 → TEST_TYPE_NOT_ALLOWED；必选缺席 → REQUIRED_TEST_TYPE_MISSING", () => {
        // 样本策略选了 functional+smoke；allowed 只放 smoke → functional 越权；
        // 必选 negative 不在 allowed（CONFIG_CONFLICT）且未选（缺席）。
        const config = resolveTestStrategyConfig({
            allowedTestTypes: ["smoke"],
            requiredTestTypes: ["negative"],
        });
        const issues = validateTestStrategy(strategy(), config);
        expect(issues.map((issue) => issue.code)).toContain("TEST_TYPE_NOT_ALLOWED");
        expect(issues.map((issue) => issue.code)).toContain("REQUIRED_TEST_TYPE_MISSING");
        expect(issues.map((issue) => issue.code)).toContain("CONFIG_CONFLICT");
    });

    it("选择数超上限 → SELECTION_LIMIT_EXCEEDED", () => {
        const config = resolveTestStrategyConfig({ maxSelections: 1 });
        const issues = validateTestStrategy(strategy(), config);
        expect(issues.map((issue) => issue.code)).toEqual(["SELECTION_LIMIT_EXCEEDED"]);
    });

    it("维度重复 → DUPLICATE_DIMENSION；目标超封顶 → TARGET_EXCEEDS_CAP", () => {
        const dup = strategy({
            coverageTargets: [
                { dimension: "journey", targetPercent: 50 },
                { dimension: "journey", targetPercent: 60 },
            ],
        });
        expect(validateTestStrategy(dup).map((issue) => issue.code)).toEqual([
            "DUPLICATE_DIMENSION",
        ]);

        const config = resolveTestStrategyConfig({
            coverageTargetCaps: [{ dimension: "journey", targetPercent: 50 }],
        });
        const issues = validateTestStrategy(strategy(), config);
        expect(issues.map((issue) => issue.code)).toEqual(["TARGET_EXCEEDS_CAP"]);
    });

    it("配置自洽：必选类型不在允许域 → CONFIG_CONFLICT", () => {
        const config = resolveTestStrategyConfig({
            allowedTestTypes: ["smoke"],
            requiredTestTypes: ["performance"],
        });
        const issues = validateTestStrategy(strategy(), config);
        expect(issues.map((issue) => issue.code)).toContain("CONFIG_CONFLICT");
    });

    it("悬空 focus 引用 → UNKNOWN_JOURNEY/UNKNOWN_ENTITY/UNKNOWN_ROLE", () => {
        const broken = strategy({
            selections: [
                {
                    testType: "functional",
                    priority: "p0",
                    rationale: "r",
                    focus: {
                        journeys: ["ghost-journey"],
                        entities: ["ghost-entity"],
                        roles: ["ghost-role"],
                    },
                },
            ],
        });
        const codes = validateTestStrategy(broken, defaultTestStrategyConfig(), MODEL).map(
            (issue) => issue.code,
        );
        expect(codes).toEqual(["UNKNOWN_JOURNEY", "UNKNOWN_ENTITY", "UNKNOWN_ROLE"]);
    });

    it("未提供产品模型 → 跳过 focus 对照（探索期策略合法）", () => {
        const thin = strategy({
            selections: [
                {
                    testType: "exploratory",
                    priority: "p2",
                    rationale: "no model yet",
                    focus: { journeys: ["anything"] },
                },
            ],
        });
        expect(validateTestStrategy(thin)).toEqual([]);
    });
});

describe("orderedSelections（生成侧消费顺序）", () => {
    it("p0 → p1 → p2；同档位保持声明序", () => {
        const shuffled = strategy({
            selections: [
                { testType: "compatibility", priority: "p2", rationale: "r" },
                { testType: "smoke", priority: "p1", rationale: "r" },
                { testType: "negative", priority: "p0", rationale: "r" },
                { testType: "functional", priority: "p0", rationale: "r" },
            ],
        });
        expect(orderedSelections(shuffled).map((item) => item.testType)).toEqual([
            "negative",
            "functional",
            "smoke",
            "compatibility",
        ]);
    });
});

describe("TEST_STRATEGY_JSON_SCHEMA（outputFormat 单源）", () => {
    it("裸顶层 object：required 含 selections、无 $ref/$defs 包装", () => {
        const schema = TEST_STRATEGY_JSON_SCHEMA as Record<string, unknown>;
        expect(schema.type).toBe("object");
        expect(schema.$ref).toBeUndefined();
        expect(schema.definitions).toBeUndefined();
        const required = schema.required as string[];
        expect(required).toContain("summary");
        expect(required).toContain("selections");
        const properties = schema.properties as Record<string, unknown>;
        expect(properties.selections).toBeDefined();
        expect(properties.coverageTargets).toBeDefined();
    });
});

describe("testArchitectDefinition（迁移 0010 种子单一事实源）", () => {
    it("version=2、标签 0.2.0、prompt ≠ v1 骨架、白名单含 memory 读工具", () => {
        const definition = testArchitectDefinition();
        expect(definition.name).toBe("test-architect");
        expect(definition.version).toBe("2");
        expect(definition.promptVersion).toBe(TEST_ARCHITECT_PROMPT_VERSION);
        expect(definition.prompt).toBe(TEST_ARCHITECT_PROMPT);
        expect(definition.enabled).toBe(true);
        // 与 v1 骨架内容不同（append-only：v1 行原样保留）。
        expect(definition.prompt).not.toBe(ROLE_PROMPT_BASELINES["test-architect"]);
        // 白名单与基线同源；memory 域实装（T-E02-07）后 test-architect
        // 的 memory.read 授权命中 memory_read_knowledge。
        expect(definition.config.allowedTools ?? []).toEqual([
            ...baselineAllowedTools("test-architect"),
        ]);
        expect(definition.config.allowedTools).toContain("mcp__aqaos__memory_read_knowledge");
    });
});
