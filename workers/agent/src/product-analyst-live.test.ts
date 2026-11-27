/**
 * T-E02-07 验收（Product Analyst）：真实 Claude Agent SDK 子进程的分析会话
 * 端到端实证——product-analyst v2 prompt（迁移 0009 种子同源
 * productAnalystDefinition()）+ SDK outputFormat json_schema 通道 +
 * 平台侧 ProductModelSchema/validateProductModel 双校验 + 确定性落库
 * （productModelToKnowledgeGraph → dispatch memory.write_knowledge；
 * 验收："产出写入 knowledge_nodes；无凭空事实"——逐事实 confidence 标注）。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 花真实 token——单轮分析，成本受 Run 预算上限约束）。services 用内存假
 * 实现（数据层归 apps/api/pg，mcp-tools.test.ts 已做 live-DB 落库验收）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    KNOWLEDGE_NODE_TYPES,
    productAnalystDefinition,
    type AgentContext,
    type AgentDefinitionRecord,
} from "@aqaos/domain";
import {
    agentToolCallContext,
    type McpKnowledgeEdgeInput,
    type McpKnowledgeNodeInput,
    type McpServices,
    type ToolAuditRecord,
} from "@aqaos/mcp";
import { runProductAnalystSession } from "./product-analyst.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const DEFINITION: AgentDefinitionRecord = {
    id: "8e2e120d-08a2-4fc4-a04e-efd909c75795",
    name: "product-analyst",
    version: "2",
    promptVersion: "0.2.0",
    prompt: productAnalystDefinition().prompt,
    config: {},
    enabled: true,
};

const ORG = "8e2e120d-08a2-4fc4-a04e-efd909c75796";
const RUN_ID = "8e2e120d-08a2-4fc4-a04e-efd909c75797";

const agentContext: AgentContext = {
    runId: RUN_ID,
    applicationId: "8e2e120d-08a2-4fc4-a04e-efd909c75798",
    environmentId: "8e2e120d-08a2-4fc4-a04e-efd909c75799",
    objective: "Extract product knowledge for a small web shop",
    budget: { maxTokens: 80_000, maxModelCostUsd: 1, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0207-live-acceptance",
};

/** 材料：内联 OpenAPI 片段 + 文档文本（真实场景由调用方抓取/组装）。 */
const SOURCES = {
    openapi: [
        "openapi: 3.0.0",
        "paths:",
        "  /orders:",
        "    post: { summary: Create a new order }",
        "  /orders/{id}/pay:",
        "    post: { summary: Pay an existing order }",
    ].join("\n"),
    documents: [
        [
            "Shoppers browse the catalog, add items to a cart, and pay.",
            "An order starts as pending; after successful payment it becomes paid.",
            "Shoppers must be authenticated to place an order.",
        ].join(" "),
    ],
};

describe.skipIf(!LIVE)("live Product Analyst session (T-E02-07 acceptance)", () => {
    it(
        "真实分析会话产出结构化模型：schema 校验通过、逐事实置信标注、图谱经 dispatch 落库",
        { timeout: 300_000 },
        async () => {
            const audits: ToolAuditRecord[] = [];
            let writtenNodes: McpKnowledgeNodeInput[] = [];
            let writtenEdges: McpKnowledgeEdgeInput[] = [];
            let writeOrg = "";
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
                    writeOrg = input.organizationId;
                    writtenNodes = input.nodes;
                    writtenEdges = input.edges;
                    return {
                        writtenNodes: input.nodes.length,
                        writtenEdges: input.edges.length,
                    };
                },
                async recordToolCall(record) {
                    audits.push(record);
                },
            };

            const toolContext = agentToolCallContext({
                organizationId: ORG,
                agentRole: "product-analyst",
                runId: RUN_ID,
                agentName: "product-analyst@2",
            });

            const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-analyst-"));
            const outcome = await runProductAnalystSession({
                definition: DEFINITION,
                context: agentContext,
                sources: SOURCES,
                toolContext,
                services,
                cwd,
            });

            // 会话终态 + 双校验全过（验收："输出结构化产品知识"）。
            expect(outcome.session.status).toBe("completed");
            expect(outcome.issues).toEqual([]);

            const model = outcome.model;
            expect(model).toBeDefined();
            if (model === undefined) {
                return;
            }
            // 材料可支撑的最小模型：至少一条旅程 + 至少一个角色/实体。
            expect(model.journeys.length).toBeGreaterThanOrEqual(1);
            expect(model.userRoles.length).toBeGreaterThanOrEqual(1);
            expect(model.businessEntities.length).toBeGreaterThanOrEqual(1);

            // 确定性落库：dispatch memory.write_knowledge 收到图谱负载
            //（验收："产出写入 knowledge_nodes"）+ 上下文组织正确 + 审计。
            expect(writtenNodes.length).toBeGreaterThanOrEqual(3);
            expect(writtenEdges.length).toBeGreaterThanOrEqual(1);
            expect(writeOrg).toBe(ORG);
            for (const node of writtenNodes) {
                expect(KNOWLEDGE_NODE_TYPES).toContain(node.nodeType);
            }
            // 事实节点逐个携带置信标注（验收："无凭空事实"；实体状态节点
            // 是结构性派生，无 confidence 属预期）。
            const factNodes = writtenNodes.filter((node) => node.nodeType !== "entity-state");
            expect(factNodes.length).toBeGreaterThanOrEqual(3);
            for (const node of factNodes) {
                expect(["confirmed", "inferred", "unknown"]).toContain(
                    node.properties.confidence as string,
                );
            }
            expect(audits.some((record) => record.toolName === "memory.write_knowledge")).toBe(
                true,
            );
        },
    );
});
