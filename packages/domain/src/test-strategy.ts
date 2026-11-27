/**
 * Test Architect 策略契约（T-E02-09，DDD §4.5）：产品知识 → 测试策略。
 *
 * TestStrategy 是 Test Architect 会话的**结构化产出**（经 SDK outputFormat
 * json_schema 通道强制形状）：从十二类测试（TestSuiteKind/§11）中选择组合
 * （每类带优先级与理据）、按覆盖维度（page/endpoint/journey/role/risk）
 * 定义覆盖率目标、点出风险与未决问题。
 *
 * "策略可配置"：TestStrategyConfig 由调用方注入（允许集/必选集/选择数上限/
 * 覆盖目标上限）——validateTestStrategy 把策略对照配置与产品模型双重校验，
 * 违约即策略的缺陷（P0 缺席、越权类型、悬空引用）。
 *
 * "与用例生成衔接"（T-E02-10 消费面）：
 * - selections[].focus 以 ProductModel 键（journeys/entities/userRoles）
 *   指向生成目标——校验拒绝悬空键（UNKNOWN_JOURNEY/UNKNOWN_ENTITY/
 *   UNKNOWN_ROLE），策略不脱离产品知识；
 * - orderedSelections 给出生成顺序（p0 → p1 → p2 稳定排序）；
 * - coverageTargets 直接对应 coverage_records.dimension 目标。
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
    CoverageDimensionSchema,
    TestSuiteKindSchema,
    type CoverageDimension,
    type TestSuiteKind,
} from "./enums.js";
import type { ProductModel } from "./product-model.js";

/** 策略优先级档位（P0 最高；生成侧按档位排序消费）。 */
export const StrategyPrioritySchema = z.enum(["p0", "p1", "p2"]);
export type StrategyPriority = z.infer<typeof StrategyPrioritySchema>;

/** 十二类测试的单项选择：为什么选、什么档位、聚焦哪条产品线。 */
export const TestTypeSelectionSchema = z
    .object({
        testType: TestSuiteKindSchema,
        priority: StrategyPrioritySchema,
        /** 选择理据（指向产品特征：高风险旅程/资金路径/权限边界等）。 */
        rationale: z.string().min(1),
        /** 聚焦的产品知识键（须在 ProductModel 对应集合中声明）。 */
        focus: z
            .object({
                journeys: z.array(z.string().min(1)).default([]),
                entities: z.array(z.string().min(1)).default([]),
                roles: z.array(z.string().min(1)).default([]),
            })
            .default({ journeys: [], entities: [], roles: [] }),
    })
    .strict();
export type TestTypeSelection = z.infer<typeof TestTypeSelectionSchema>;

/** 覆盖率目标（dimension 与 coverage_records 对齐；百分比 0-100）。 */
export const CoverageTargetSchema = z
    .object({
        dimension: CoverageDimensionSchema,
        targetPercent: z.number().int().min(0).max(100),
    })
    .strict();
export type CoverageTarget = z.infer<typeof CoverageTargetSchema>;

/** Test Architect 结构化策略（会话最终消息的 JSON 形状）。 */
export const TestStrategySchema = z
    .object({
        summary: z.string().min(1),
        /** 测试类型组合（去重由合同校验保证；至少一项）。 */
        selections: z.array(TestTypeSelectionSchema).min(1),
        /** 覆盖率目标（按维度去重由合同校验保证）。 */
        coverageTargets: z.array(CoverageTargetSchema).default([]),
        /** 关键风险区（供优先级与分诊加权）。 */
        risks: z.array(z.string().min(1)).default([]),
        /** 未决问题（材料不足处显式声明，不静默猜测）。 */
        openQuestions: z.array(z.string().min(1)).default([]),
    })
    .strict();
export type TestStrategy = z.infer<typeof TestStrategySchema>;

/**
 * 策略配置（"策略可配置"半边）：调用方约束会话产出。
 * 允许集缺省为十二类全量；必选集/上限/覆盖目标封顶按需注入。
 */
export const TestStrategyConfigSchema = z
    .object({
        /** 可选类型域（缺省十二类全量）。 */
        allowedTestTypes: z.array(TestSuiteKindSchema).min(1),
        /** 必选类型（策略必须包含）。 */
        requiredTestTypes: z.array(TestSuiteKindSchema).default([]),
        /** 选择数上限（缺省 12 = 不限）。 */
        maxSelections: z.number().int().min(1).default(12),
        /** 各维度覆盖率目标封顶（超出即违约）。 */
        coverageTargetCaps: z.array(CoverageTargetSchema).default([]),
    })
    .strict();
export type TestStrategyConfig = z.infer<typeof TestStrategyConfigSchema>;

/** 缺省策略配置（十二类全量放开、无必选、无封顶）。 */
export function defaultTestStrategyConfig(): TestStrategyConfig {
    return TestStrategyConfigSchema.parse({
        allowedTestTypes: [...TestSuiteKindSchema.options],
    });
}

/**
 * 宽松输入 → 完整配置（默认值回填）：调用方只给增量约束。
 */
export function resolveTestStrategyConfig(
    input?: Partial<TestStrategyConfig> | Record<string, unknown>,
): TestStrategyConfig {
    const merged = {
        allowedTestTypes: [...TestSuiteKindSchema.options],
        requiredTestTypes: [],
        maxSelections: 12,
        coverageTargetCaps: [],
        ...input,
    };
    return TestStrategyConfigSchema.parse(merged);
}

/**
 * TestStrategy 的 JSON Schema（SDK Options.outputFormat json_schema 通道用）。
 * 由 TestStrategySchema 单源生成（zod-to-json-schema），形状与 zod 永不漂移。
 */
// 注意：不传 name 选项——命名会把 schema 包成 {$ref, definitions} 形状，
// SDK outputFormat 需要的是裸顶层 object schema（无自递归引用，内联无 $defs）。
export const TEST_STRATEGY_JSON_SCHEMA: Record<string, unknown> = zodToJsonSchema(
    TestStrategySchema,
) as Record<string, unknown>;

/** 策略合同问题（结构 + 语义；会话侧拒绝采纳的依据）。 */
export interface TestStrategyIssue {
    readonly code:
        | "DUPLICATE_TEST_TYPE"
        | "TEST_TYPE_NOT_ALLOWED"
        | "REQUIRED_TEST_TYPE_MISSING"
        | "SELECTION_LIMIT_EXCEEDED"
        | "DUPLICATE_DIMENSION"
        | "TARGET_EXCEEDS_CAP"
        | "CONFIG_CONFLICT"
        | "UNKNOWN_JOURNEY"
        | "UNKNOWN_ENTITY"
        | "UNKNOWN_ROLE";
    readonly message: string;
    readonly testType?: TestSuiteKind;
    readonly dimension?: CoverageDimension;
}

/**
 * 合同校验：组合去重/允许域/必选集/数量上限/维度去重/目标封顶 + 配置自洽 +
 * 聚焦键对照 ProductModel（无悬空引用）。
 * @param config 策略配置（缺省全量放开）。
 * @param productModel 产品模型（提供时校验 focus 键；缺省跳过对照）。
 */
export function validateTestStrategy(
    strategy: TestStrategy,
    config: TestStrategyConfig = defaultTestStrategyConfig(),
    productModel?: ProductModel,
): readonly TestStrategyIssue[] {
    const issues: TestStrategyIssue[] = [];
    const allowed = new Set<TestSuiteKind>(config.allowedTestTypes);
    const seen = new Set<TestSuiteKind>();

    // 配置自洽：必选类型必须在允许域内（自相矛盾的配置是配置的缺陷）。
    for (const required of config.requiredTestTypes) {
        if (!allowed.has(required)) {
            issues.push({
                code: "CONFIG_CONFLICT",
                message: `required test type "${required}" is not in allowedTestTypes`,
                testType: required,
            });
        }
    }

    for (const selection of strategy.selections) {
        if (seen.has(selection.testType)) {
            issues.push({
                code: "DUPLICATE_TEST_TYPE",
                message: `test type "${selection.testType}" is selected more than once`,
                testType: selection.testType,
            });
            continue;
        }
        seen.add(selection.testType);
        if (!allowed.has(selection.testType)) {
            issues.push({
                code: "TEST_TYPE_NOT_ALLOWED",
                message: `test type "${selection.testType}" is not in the allowed set`,
                testType: selection.testType,
            });
        }
    }

    for (const required of config.requiredTestTypes) {
        if (!seen.has(required)) {
            issues.push({
                code: "REQUIRED_TEST_TYPE_MISSING",
                message: `required test type "${required}" is missing from selections`,
                testType: required,
            });
        }
    }

    if (strategy.selections.length > config.maxSelections) {
        issues.push({
            code: "SELECTION_LIMIT_EXCEEDED",
            message: `strategy selects ${strategy.selections.length} test types; cap is ${config.maxSelections}`,
        });
    }

    const dimensions = new Set<CoverageDimension>();
    for (const target of strategy.coverageTargets) {
        if (dimensions.has(target.dimension)) {
            issues.push({
                code: "DUPLICATE_DIMENSION",
                message: `coverage dimension "${target.dimension}" appears more than once`,
                dimension: target.dimension,
            });
            continue;
        }
        dimensions.add(target.dimension);
        const cap = config.coverageTargetCaps.find((item) => item.dimension === target.dimension);
        if (cap !== undefined && target.targetPercent > cap.targetPercent) {
            issues.push({
                code: "TARGET_EXCEEDS_CAP",
                message: `coverage target ${target.targetPercent}% for "${target.dimension}" exceeds cap ${cap.targetPercent}%`,
                dimension: target.dimension,
            });
        }
    }

    if (productModel !== undefined) {
        const journeys = new Set(productModel.journeys.map((journey) => journey.key));
        const entities = new Set(productModel.businessEntities.map((entity) => entity.key));
        const roles = new Set(productModel.userRoles.map((role) => role.key));
        for (const selection of strategy.selections) {
            for (const key of selection.focus.journeys) {
                if (!journeys.has(key)) {
                    issues.push({
                        code: "UNKNOWN_JOURNEY",
                        message: `focus journey "${key}" is not declared in the product model`,
                    });
                }
            }
            for (const key of selection.focus.entities) {
                if (!entities.has(key)) {
                    issues.push({
                        code: "UNKNOWN_ENTITY",
                        message: `focus entity "${key}" is not declared in the product model`,
                    });
                }
            }
            for (const key of selection.focus.roles) {
                if (!roles.has(key)) {
                    issues.push({
                        code: "UNKNOWN_ROLE",
                        message: `focus role "${key}" is not declared in the product model`,
                    });
                }
            }
        }
    }
    return issues;
}

/**
 * 生成侧消费顺序：p0 → p1 → p2（同档位保持声明序稳定）。
 * T-E02-10 Test Generator 按此顺序生成用例（"与用例生成衔接"）。
 */
export function orderedSelections(strategy: TestStrategy): readonly TestTypeSelection[] {
    const rank: Record<StrategyPriority, number> = { p0: 0, p1: 1, p2: 2 };
    return [...strategy.selections].sort((a, b) => rank[a.priority] - rank[b.priority]);
}
