/**
 * Test Architect 会话运行器（T-E02-09，DDD §4.5/§3.7）。
 *
 * 产品知识 → 结构化测试策略：test-architect 角色（prompt v2，迁移 0010
 * 种子）经 SDK outputFormat json_schema 通道产出 TestStrategy JSON——形状
 * 由 TEST_STRATEGY_JSON_SCHEMA（@aqaos/domain 单源生成）在 SDK 侧强制，
 * 平台侧再过 TestStrategySchema + validateTestStrategy 双校验。
 *
 * "策略可配置"：TestStrategyConfig 由调用方注入（允许集/必选集/上限/封顶），
 * 会话 prompt 显式呈现约束，平台侧校验拒绝违约组合。
 *
 * "与用例生成衔接"：产出策略的 selections[].focus 键对照 ProductModel
 * （T-E02-07 产出传入）校验——悬空引用即违约；orderedSelections 给出
 * T-E02-10 Test Generator 的消费顺序。
 *
 * 纠偏轮（product-analyst 同款，live 实证产物）：首轮产出违约（schema/
 * 合同）→ 第二轮把违约清单注入 prompt 重跑；有界两轮，仍违约则带 issues
 * 返回（调用方可换知识/配置重试）。契约：strategy 存在 ⟺ 双校验全通过；
 * issues 空 ⟺ 策略可直接交给用例生成。
 */

import {
    TEST_STRATEGY_JSON_SCHEMA,
    TestStrategySchema,
    validateTestStrategy,
    type AgentContext,
    type AgentDefinitionRecord,
    type ProductModel,
    type TestSuiteKind,
    type TestStrategy,
    type TestStrategyConfig,
    type TestStrategyIssue,
} from "@aqaos/domain";
import { runAgentSession, type AgentSessionOutcome, type SessionQueryFn } from "./agent-session.js";
import { parseStructuredOutput } from "./structured-output.js";

/** 解析/会话层阻断原因（合同问题透传 TestStrategyIssue 形状）。 */
export type TestArchitectIssue =
    | TestStrategyIssue
    | { readonly code: "SESSION_FAILED" | "PARSE_FAILED"; readonly message: string };

/** 规划期意图（Planner 计划的可用切片；缺省由架构师自行判断）。 */
export interface PlannerIntent {
    /** 解析后的可测目标（复述，非照抄）。 */
    objective?: string;
    /** Planner 意图覆盖的测试类型（建议集，架构师可扩展/收敛）。 */
    testTypes?: readonly TestSuiteKind[];
}

export interface TestArchitectOutcome {
    session: AgentSessionOutcome;
    /** 结构化测试策略（存在 ⟺ Schema + 合同校验全通过）。 */
    strategy?: TestStrategy;
    /** 阻断原因（strategy 缺席时必有；空 ⟺ 策略可交给用例生成）。 */
    issues: readonly TestArchitectIssue[];
}

export interface RunTestArchitectParams {
    /** test-architect 角色定义（agent_definitions 最新启用版；prompt v2）。 */
    definition: AgentDefinitionRecord;
    context: AgentContext;
    /** 产品知识（T-E02-07 产出；提供时 focus 键对照校验）。 */
    productModel?: ProductModel;
    /** Planner 意图切片（可选；目标与建议测试类型）。 */
    plannerIntent?: PlannerIntent;
    /** 策略配置（"策略可配置"；缺省十二类全量放开）。 */
    config?: TestStrategyConfig;
    cwd?: string;
    defaultModel?: string;
    queryFn?: SessionQueryFn;
}

/** 组装策略轮输入（知识 + 意图 + 配置约束 + 输出契约重申）。 */
export function testArchitectPrompt(params: {
    productModel?: ProductModel;
    plannerIntent?: PlannerIntent;
    config?: TestStrategyConfig;
}): string {
    const sections: string[] = [];
    if (params.plannerIntent?.objective !== undefined) {
        sections.push(`Objective:\n${params.plannerIntent.objective}`);
    }
    if (params.productModel !== undefined) {
        sections.push(
            `Product knowledge (Product Model JSON):\n${JSON.stringify(params.productModel)}`,
        );
    }
    const intent = params.plannerIntent?.testTypes;
    if (intent !== undefined && intent.length > 0) {
        sections.push(
            `Suggested test types (from the plan; you may extend or narrow):\n${intent.join(", ")}`,
        );
    }
    const config = params.config;
    if (config !== undefined) {
        const lines = [
            `allowed test types: ${config.allowedTestTypes.join(", ")}`,
            config.requiredTestTypes.length > 0
                ? `required test types (must be selected): ${config.requiredTestTypes.join(", ")}`
                : null,
            config.maxSelections < 12 ? `max selections: ${config.maxSelections}` : null,
            config.coverageTargetCaps.length > 0
                ? `coverage target caps: ${config.coverageTargetCaps
                      .map((cap) => `${cap.dimension} ≤ ${cap.targetPercent}%`)
                      .join("; ")}`
                : null,
        ].filter((line): line is string => line !== null);
        sections.push(`Strategy constraints:\n${lines.join("\n")}`);
    }
    return [
        "Design the test strategy for the material below: select the test-type combination, set coverage targets, assign priorities.",
        ...sections,
        "Produce the complete Test Strategy as the JSON object required by the enforced output schema. Nothing else.",
    ].join("\n\n");
}

/** 运行 test-architect 策略会话（合同违约带反馈纠偏一轮，有界两轮）。 */
export async function runTestArchitectSession(
    params: RunTestArchitectParams,
): Promise<TestArchitectOutcome> {
    // 有界纠偏：首轮产出违约（schema/合同）→ 第二轮带违约清单重跑。
    let feedback: string[] = [];
    let session: AgentSessionOutcome | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const correction =
            feedback.length > 0
                ? [
                      "",
                      "# Contract feedback (your previous output was rejected)",
                      "Fix the violations below and re-emit the complete corrected Test Strategy:",
                      ...feedback.map((item) => `- ${item}`),
                  ].join("\n")
                : "";
        session = await runAgentSession({
            definition: params.definition,
            context: params.context,
            prompt: `${testArchitectPrompt(params)}${correction}`,
            outputJsonSchema: TEST_STRATEGY_JSON_SCHEMA,
            cwd: params.cwd,
            defaultModel: params.defaultModel,
            queryFn: params.queryFn,
        });
        if (session.status !== "completed") {
            return {
                session,
                issues: [
                    {
                        code: "SESSION_FAILED",
                        message: `test-architect session ended as ${session.status}`,
                    },
                ],
            };
        }
        const raw = parseStructuredOutput(session);
        if (raw === undefined || raw === null) {
            const issues: TestArchitectIssue[] = [
                {
                    code: "PARSE_FAILED",
                    message: "no structured output in test-architect result",
                },
            ];
            if (attempt < 2) {
                feedback = ["the final message contained no parseable Test Strategy JSON"];
                continue;
            }
            return { session, issues };
        }
        const parsed = TestStrategySchema.safeParse(raw);
        if (!parsed.success) {
            const messages = parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ");
            if (attempt < 2) {
                feedback = [messages];
                continue;
            }
            return { session, issues: [{ code: "PARSE_FAILED", message: messages }] };
        }
        const contractIssues = validateTestStrategy(
            parsed.data,
            params.config,
            params.productModel,
        );
        if (contractIssues.length > 0) {
            if (attempt < 2) {
                feedback = contractIssues.map((issue) =>
                    [issue.testType ?? issue.dimension, issue.message].filter(Boolean).join(": "),
                );
                continue;
            }
            return { session, issues: contractIssues };
        }
        return { session, strategy: parsed.data, issues: [] };
    }
    // 循环恒有返回（attempt ≤ 2）；类型收窄守卫。
    throw new Error("unreachable: correction loop exhausted");
}
