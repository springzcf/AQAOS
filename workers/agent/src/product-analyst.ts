/**
 * Product Analyst 会话运行器（T-E02-07，DDD §4.3 / SRS FR-006）。
 *
 * 产品材料（URL/OpenAPI/文档文本）→ 结构化 Product Model：
 * - product-analyst 角色（prompt v2，迁移 0009 种子）经 SDK outputFormat
 *   json_schema 通道产出 ProductModel JSON——形状由 PRODUCT_MODEL_JSON_SCHEMA
 *   （@aqaos/domain 单源生成）在 SDK 侧强制；
 * - 平台侧再过 ProductModelSchema + validateProductModel 双校验（引用完整
 *   性合同：旅程 actor/步骤实体/API 引用、状态迁移实体都指向已声明集合）；
 * - **确定性落库**：图谱写入不走模型的多轮工具调用（那会是概率性写），而
 *   是平台侧把校验通过的模型经 productModelToKnowledgeGraph 映射后，以
 *   product-analyst 角色上下文 dispatch memory.write_knowledge（同一调度
 *   链：权限/预算/审计；"产出写入 knowledge_nodes；无凭空事实"）。
 *
 * 契约：model 存在 ⟺ Schema 解析与合同校验通过（分析成立，即使写库失败
 * 也不丢弃——调用方可重试写库）；issues 空 ⟺ 模型已落库（全成功）。
 *
 * 纠偏轮（live 实证产物）：首轮产出违约（引用完整性/形状）→ 第二轮把违约
 * 清单注入 prompt 重跑（live 首验：模型引用了步骤 API 依赖但漏声明
 * apiDependencies 数组——合同校验按设计拦截，纠偏轮让单轮遗漏可自愈）；
 * 有界两轮，第二轮仍违约则带 issues 返回（Run 编排器可换材料重试）。
 */

import {
    PRODUCT_MODEL_JSON_SCHEMA,
    ProductModelSchema,
    productModelToKnowledgeGraph,
    validateProductModel,
    type AgentContext,
    type AgentDefinitionRecord,
    type KnowledgeGraphPayload,
    type ProductModel,
    type ProductModelIssue,
} from "@aqaos/domain";
import { dispatchToolCall, type McpServices, type ToolCallContext } from "@aqaos/mcp";
import { runAgentSession, type AgentSessionOutcome, type SessionQueryFn } from "./agent-session.js";
import { parseStructuredOutput } from "./structured-output.js";

/** 解析/合同/落库阻断原因（合同问题透传 ProductModelIssue 形状）。 */
export type ProductAnalystIssue =
    | ProductModelIssue
    | {
          readonly code:
              | "SESSION_FAILED"
              | "PARSE_FAILED"
              | "KNOWLEDGE_WRITE_FAILED"
              | "KNOWLEDGE_WRITE_DENIED";
          readonly message: string;
      };

export interface ProductAnalystSources {
    /** 被测应用入口（落地页文案/产品主页；可选）。 */
    url?: string;
    /** OpenAPI/接口契约文档原文（可选）。 */
    openapi?: string;
    /** 产品文档片段（PRD 摘录/帮助中心/领域说明；可选多条）。 */
    documents?: readonly string[];
}

export interface ProductAnalystOutcome {
    session: AgentSessionOutcome;
    /** 结构化产品模型（存在 ⟺ Schema + 合同校验通过；写库失败不影响其存在）。 */
    model?: ProductModel;
    /** 模型的知识图谱映射（与 model 同步存在）。 */
    graph?: KnowledgeGraphPayload;
    /** 落库结果（issues 空 ⟺ 已写入 knowledge_nodes）。 */
    persisted?: { writtenNodes: number; writtenEdges: number };
    issues: readonly ProductAnalystIssue[];
}

export interface RunProductAnalystParams {
    /** product-analyst 角色定义（agent_definitions 最新启用版；prompt v2）。 */
    definition: AgentDefinitionRecord;
    context: AgentContext;
    /** 产品材料（至少一项非空；调用方负责抓取/组装原文）。 */
    sources: ProductAnalystSources;
    /**
     * 可信调用上下文（dispatch 用；由调用方从已验证行构造——
     * agentToolCallContext({ organizationId, agentRole: "product-analyst", ... })）。
     */
    toolContext: ToolCallContext;
    services: McpServices;
    cwd?: string;
    defaultModel?: string;
    queryFn?: SessionQueryFn;
}

/** 组装分析轮输入（材料分段 + 输出契约重申；材料至少一项）。 */
export function productAnalystPrompt(params: { sources: ProductAnalystSources }): string {
    const { sources } = params;
    const sections: string[] = [];
    if (sources.url !== undefined) {
        sections.push(`Product URL / landing page text:\n${sources.url}`);
    }
    if (sources.openapi !== undefined) {
        sections.push(`API contract (OpenAPI):\n${sources.openapi}`);
    }
    for (const [index, document] of (sources.documents ?? []).entries()) {
        sections.push(`Product document ${index + 1}:\n${document}`);
    }
    return [
        "Extract the Product Model from the material below. Tag every fact with its evidence level; put what the material does not answer in openQuestions.",
        ...sections,
        "Produce the complete Product Model as the JSON object required by the enforced output schema. Nothing else.",
    ].join("\n\n");
}

/** 运行 product-analyst 分析会话（合同违约带反馈纠偏一轮；落库确定性完成）。 */
export async function runProductAnalystSession(
    params: RunProductAnalystParams,
): Promise<ProductAnalystOutcome> {
    // 有界纠偏：首轮产出违约（schema/合同）→ 第二轮带违约清单重跑。
    // 每轮各自计预算（Run 级扣减由 T-E02-13 计量面承担）。注意：model 存在
    // ⟺ 校验通过——分析成立但写库失败不丢模型（调用方可重试写库）。
    let feedback: string[] = [];
    let session: AgentSessionOutcome | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const correction =
            feedback.length > 0
                ? [
                      "",
                      "# Contract feedback (your previous output was rejected)",
                      "Fix the violations below and re-emit the complete corrected Product Model:",
                      ...feedback.map((item) => `- ${item}`),
                  ].join("\n")
                : "";
        session = await runAgentSession({
            definition: params.definition,
            context: params.context,
            prompt: `${productAnalystPrompt(params)}${correction}`,
            outputJsonSchema: PRODUCT_MODEL_JSON_SCHEMA,
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
                        message: `product-analyst session ended as ${session.status}`,
                    },
                ],
            };
        }
        const raw = parseStructuredOutput(session);
        if (raw === undefined || raw === null) {
            const issues: ProductAnalystIssue[] = [
                { code: "PARSE_FAILED", message: "no structured output in product-analyst result" },
            ];
            if (attempt < 2) {
                feedback = ["the final message contained no parseable Product Model JSON"];
                continue;
            }
            return { session, issues };
        }
        const parsed = ProductModelSchema.safeParse(raw);
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
        const contractIssues = validateProductModel(parsed.data);
        if (contractIssues.length > 0) {
            if (attempt < 2) {
                feedback = contractIssues.map((issue) =>
                    [issue.path, issue.message].filter(Boolean).join(": "),
                );
                continue;
            }
            return { session, issues: contractIssues };
        }
        const model = parsed.data;
        const graph = productModelToKnowledgeGraph(model);
        const write = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: {
                applicationId: params.context.applicationId,
                nodes: graph.nodes,
                edges: graph.edges,
            },
            context: params.toolContext,
            services: params.services,
        });
        if (write.status === "succeeded") {
            const data = write.data as { writtenNodes?: number; writtenEdges?: number } | undefined;
            return {
                session,
                model,
                graph,
                persisted: {
                    writtenNodes: data?.writtenNodes ?? 0,
                    writtenEdges: data?.writtenEdges ?? 0,
                },
                issues: [],
            };
        }
        const code =
            write.status === "denied" ? "KNOWLEDGE_WRITE_DENIED" : "KNOWLEDGE_WRITE_FAILED";
        return {
            session,
            model,
            graph,
            issues: [
                {
                    code,
                    message: write.error?.message ?? `knowledge write ${write.status}`,
                },
            ],
        };
    }
    // 循环恒有返回（attempt ≤ 2）；类型收窄守卫。
    throw new Error("unreachable: correction loop exhausted");
}
