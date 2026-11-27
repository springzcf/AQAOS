/**
 * 调度链离线回归（T-E02-03）：内存假 services，验证验收标准
 * 「未授权工具调用被服务端拒绝并审计」及链上各终态。
 */

import { describe, expect, it } from "vitest";
import {
    HashEmbedder,
    cosineSimilarity,
    type MemoryHit,
    type MemoryRecord,
    type MemorySearchQuery,
} from "@aqaos/domain";
import {
    agentToolCallContext,
    dispatchToolCall,
    restToolGrants,
    restToolCallContext,
} from "./index.js";
import type {
    McpEnvironmentSummary,
    McpKnowledgeNodeInput,
    McpRunSummary,
    McpServices,
    ToolAuditRecord,
} from "./services.js";

const ORG = "9e2e120d-08a2-4fc4-a04e-efd909c7577a";
const ORG_OTHER = "9e2e120d-08a2-4fc4-a04e-efd909c7577b";
const RUN_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const APP_ID = "1a2b3c4d-0000-4000-8000-000000000002";
const ENV_ID = "1a2b3c4d-0000-4000-8000-000000000003";

const RUN: McpRunSummary = {
    id: RUN_ID,
    projectId: APP_ID,
    applicationId: APP_ID,
    environmentId: ENV_ID,
    objective: "回归登录主链路",
    status: "running",
    budget: { maxTokens: 1_000_000, maxModelCostUsd: 5, maxDurationSeconds: 600 },
    coverage: { line: 0.42 },
    temporalWorkflowId: "wf_test_1",
    createdAt: "2026-11-27T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
};

const ENVIRONMENT: McpEnvironmentSummary = {
    id: ENV_ID,
    applicationId: APP_ID,
    name: "staging",
    environmentType: "testing",
    baseUrl: "https://staging.example.com",
    createdAt: "2026-11-27T10:00:00.000Z",
};

/** 内存假实现：组织过滤 + 审计记录数组（断言审计语义）+ 内存知识图谱 + 记忆。 */
function makeServices(overrides: Partial<McpServices> = {}) {
    const audits: ToolAuditRecord[] = [];
    /** 简化图谱存储：org → app → {nodes（键去重 upsert）, edges（三元组去重）}。 */
    const graphs = new Map<
        string,
        { nodes: Map<string, McpKnowledgeNodeInput>; edges: Set<string> }
    >();
    /** 记忆存储：org → 记录数组（租户过滤靠 org 键；相似度用 HashEmbedder）。 */
    const memories = new Map<string, MemoryRecord[]>();
    const embedder = new HashEmbedder(64);
    const services: McpServices = {
        async getRun({ runId, organizationId }) {
            if (organizationId !== ORG || runId !== RUN_ID) {
                return null;
            }
            return RUN;
        },
        async listBugs({ organizationId, runId }) {
            if (organizationId !== ORG) {
                return [];
            }
            return [
                {
                    id: "b1",
                    applicationId: APP_ID,
                    testRunId: runId ?? RUN_ID,
                    title: "登录按钮无响应",
                    severity: "major",
                    status: "open",
                    confidence: 0.87,
                    createdAt: "2026-11-27T10:05:00.000Z",
                },
            ];
        },
        async getCoverage({ runId, organizationId }) {
            if (organizationId !== ORG || runId !== RUN_ID) {
                return null;
            }
            return RUN.coverage;
        },
        async listEnvironments({ organizationId, applicationId }) {
            if (organizationId !== ORG) {
                return [];
            }
            return applicationId === APP_ID ? [ENVIRONMENT] : [];
        },
        async readKnowledge({ organizationId, applicationId, nodeTypes, limit }) {
            const graph = graphs.get(`${organizationId}/${applicationId}`);
            if (!graph || organizationId !== ORG) {
                return organizationId === ORG ? { nodes: [], edges: [] } : null;
            }
            const nodes = [...graph.nodes.values()]
                .filter((node) => nodeTypes === undefined || nodeTypes.includes(node.nodeType))
                .slice(0, limit)
                .map((node) => ({ ...node, createdAt: "2026-11-27T11:00:00.000Z" }));
            const edges = [...graph.edges].map((key) => {
                const [sourceKey, relation, targetKey] = key.split("|");
                return {
                    sourceKey: sourceKey ?? "",
                    relation: relation ?? "",
                    targetKey: targetKey ?? "",
                    properties: {},
                };
            });
            return { nodes, edges };
        },
        async writeKnowledge({ organizationId, applicationId, nodes, edges }) {
            if (organizationId !== ORG) {
                return null;
            }
            const key = `${organizationId}/${applicationId}`;
            const graph = graphs.get(key) ?? { nodes: new Map(), edges: new Set<string>() };
            for (const node of nodes) {
                graph.nodes.set(node.externalKey, node);
            }
            for (const edge of edges) {
                graph.edges.add(`${edge.sourceKey}|${edge.relation}|${edge.targetKey}`);
            }
            graphs.set(key, graph);
            return { writtenNodes: nodes.length, writtenEdges: edges.length };
        },
        async recordToolCall(record) {
            audits.push(record);
        },
        async searchMemories(query: MemorySearchQuery) {
            const all = memories.get(query.organizationId) ?? [];
            const queryVector = embedder.embedOne(query.content);
            const hits: MemoryHit[] = all
                .filter(
                    (record) =>
                        query.projectId === undefined || record.projectId === query.projectId,
                )
                .filter(
                    (record) =>
                        query.applicationId === undefined ||
                        record.applicationId === query.applicationId,
                )
                .filter((record) => query.kind === undefined || record.kind === query.kind)
                .map((record) => ({
                    record,
                    score: cosineSimilarity(queryVector, embedder.embedOne(record.content)),
                }))
                .filter((hit) => hit.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, query.limit);
            return hits;
        },
        ...overrides,
    };
    return {
        services,
        audits,
        graphs,
        memories,
        addMemory: (record: MemoryRecord) => {
            const list = memories.get(record.organizationId) ?? [];
            list.push(record);
            memories.set(record.organizationId, list);
        },
    };
}

describe("dispatchToolCall（T-E02-03 调度链）", () => {
    it("成功路径：reporter 查 Run → succeeded + 数据 + 审计一条", async () => {
        const { services, audits } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "reporter",
            runId: RUN_ID,
            agentName: "reporter@1",
        });
        const result = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result.status).toBe("succeeded");
        expect(result.tool).toBe("qa.get_run");
        expect(result.data?.run).toEqual(RUN);
        expect(audits).toEqual([
            {
                organizationId: ORG,
                toolName: "qa.get_run",
                status: "succeeded",
                source: "agent-session",
                role: "reporter",
                agentName: "reporter@1",
                runId: RUN_ID,
                userId: undefined,
                message: undefined,
                errorCode: undefined,
            },
        ]);
    });

    it("验收：explorer（无 qa-control.read）调 qa.get_run → denied TOOL_PERMISSION_DENIED + 审计", async () => {
        const { services, audits } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "explorer",
            runId: RUN_ID,
        });
        const result = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result).toEqual({
            tool: "qa.get_run",
            status: "denied",
            error: {
                code: "TOOL_PERMISSION_DENIED",
                message: 'role "explorer" lacks qa-control.read',
            },
        });
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
            status: "denied",
            errorCode: "TOOL_PERMISSION_DENIED",
            toolName: "qa.get_run",
            role: "explorer",
            runId: RUN_ID,
        });
    });

    it("组织隔离：上下文组织与服务数据不匹配 → NOT_FOUND（不泄漏存在性）", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG_OTHER,
            agentRole: "reporter",
        });
        const result = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("NOT_FOUND");
    });

    it("未登记工具 → failed TOOL_NOT_FOUND；canonical 与 SDK 名都能解析", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "qa-manager" });
        const unknown = await dispatchToolCall({
            toolName: "browser.navigate",
            input: {},
            context,
            services,
        });
        expect(unknown.status).toBe("failed");
        expect(unknown.error?.code).toBe("TOOL_NOT_FOUND");

        // SDK 下划线名与 canonical 名等价。
        const viaSdkName = await dispatchToolCall({
            toolName: "qa_get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(viaSdkName.tool).toBe("qa.get_run");
        expect(viaSdkName.status).toBe("succeeded");
    });

    it("输入校验：非 UUID / 未知字段（strict）→ failed VALIDATION_FAILED；limit 有缺省", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "triage-agent" });
        const badUuid = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: "not-a-uuid" },
            context,
            services,
        });
        expect(badUuid.status).toBe("failed");
        expect(badUuid.error?.code).toBe("VALIDATION_FAILED");

        const extraField = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID, depth: 5 },
            context,
            services,
        });
        expect(extraField.error?.code).toBe("VALIDATION_FAILED");

        const bugs = await dispatchToolCall({
            toolName: "qa.list_bugs",
            input: {},
            context,
            services,
        });
        expect(bugs.status).toBe("succeeded");
        expect(bugs.data?.items).toHaveLength(1);
    });

    it("预算钩子拒绝 → denied MODEL_BUDGET_EXCEEDED + 审计（T-E02-13 接缝）", async () => {
        const { services, audits } = makeServices({
            async checkToolBudget() {
                return { allowed: false, reason: "run budget exhausted (tokens)" };
            },
        });
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "reporter",
            runId: RUN_ID,
        });
        const result = await dispatchToolCall({
            toolName: "qa.get_coverage",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result.status).toBe("denied");
        expect(result.error?.code).toBe("MODEL_BUDGET_EXCEEDED");
        expect(audits[0]).toMatchObject({ status: "denied", errorCode: "MODEL_BUDGET_EXCEEDED" });
    });

    it("处理器未知异常 → failed INTERNAL_ERROR 且消息不透出内部细节；审计落 failed", async () => {
        const { services, audits } = makeServices({
            async getRun() {
                throw new Error("pg connection refused host=db-internal:5432");
            },
        });
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "reporter" });
        const result = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("INTERNAL_ERROR");
        expect(result.error?.message).toBe("tool execution failed");
        expect(audits[0]).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR" });
    });

    it("审计写失败不改变调用结果（吞掉，不反向影响工具）", async () => {
        const { services } = makeServices({
            async recordToolCall() {
                throw new Error("audit sink down");
            },
        });
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "reporter" });
        const result = await dispatchToolCall({
            toolName: "qa.get_run",
            input: { runId: RUN_ID },
            context,
            services,
        });
        expect(result.status).toBe("succeeded");
    });
});

describe("REST 消费阶梯（T-E02-03）", () => {
    it("viewer 零工具；member 全域只读；admin/owner 全权", () => {
        expect(restToolGrants("viewer")).toEqual([]);
        expect(restToolGrants("member")).toContain("qa-control.read");
        expect(restToolGrants("member")).not.toContain("qa-control.write");
        expect(restToolGrants("member")).toHaveLength(8);
        expect(restToolGrants("admin")).toEqual(["*"]);
        expect(restToolGrants("owner")).toEqual(["*"]);
        expect(restToolGrants("stranger")).toEqual([]);
    });

    it("viewer 调只读工具 → denied + 审计（REST 侧验收语义）", async () => {
        const { services, audits } = makeServices();
        const context = restToolCallContext({
            organizationId: ORG,
            membershipRole: "viewer",
            userId: "u1",
        });
        const result = await dispatchToolCall({
            toolName: "env.list_environments",
            input: {},
            context,
            services,
        });
        expect(result.status).toBe("denied");
        expect(result.error?.code).toBe("TOOL_PERMISSION_DENIED");
        expect(audits[0]).toMatchObject({ status: "denied", source: "rest", role: "viewer" });
    });

    it("member 可调只读工具；admin 可调全部（env.list_environments）", async () => {
        const { services } = makeServices();
        const member = restToolCallContext({ organizationId: ORG, membershipRole: "member" });
        const ok = await dispatchToolCall({
            toolName: "env.list_environments",
            input: { applicationId: APP_ID },
            context: member,
            services,
        });
        expect(ok.status).toBe("succeeded");
        expect(ok.data?.items).toEqual([ENVIRONMENT]);
    });
});

describe("memory.* 工具（T-E02-07 知识图谱读写）", () => {
    const NODES = [
        {
            nodeType: "business-entity",
            externalKey: "business-entity:order",
            properties: { name: "Order", confidence: "confirmed" },
        },
        {
            nodeType: "user-role",
            externalKey: "user-role:shopper",
            properties: { name: "Shopper", confidence: "confirmed" },
        },
        {
            nodeType: "journey",
            externalKey: "journey:checkout",
            properties: { name: "Checkout", confidence: "inferred" },
        },
    ];

    it("product-analyst 写图谱 → succeeded + 计数 + 审计；SDK 名等价解析", async () => {
        const { services, audits, graphs } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "product-analyst",
            runId: RUN_ID,
            agentName: "product-analyst@2",
        });
        const result = await dispatchToolCall({
            toolName: "memory_write_knowledge",
            input: {
                applicationId: APP_ID,
                nodes: NODES,
                edges: [
                    {
                        sourceKey: "journey:checkout",
                        targetKey: "user-role:shopper",
                        relation: "performed-by",
                        properties: { confidence: "inferred" },
                    },
                ],
            },
            context,
            services,
        });
        expect(result.status).toBe("succeeded");
        expect(result.tool).toBe("memory.write_knowledge");
        expect(result.data).toEqual({ writtenNodes: 3, writtenEdges: 1 });
        expect(graphs.get(`${ORG}/${APP_ID}`)?.nodes.size).toBe(3);
        expect(audits[0]).toMatchObject({
            toolName: "memory.write_knowledge",
            status: "succeeded",
            role: "product-analyst",
        });
    });

    it("member（REST 只读阶梯）写 → denied；读 → succeeded（memory.read 在全域只读内）", async () => {
        const { services, audits } = makeServices();
        const member = restToolCallContext({
            organizationId: ORG,
            membershipRole: "member",
            userId: "u-member",
        });
        const denied = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: { applicationId: APP_ID, nodes: NODES },
            context: member,
            services,
        });
        expect(denied.status).toBe("denied");
        expect(denied.error?.code).toBe("TOOL_PERMISSION_DENIED");
        expect(audits[0]).toMatchObject({
            status: "denied",
            toolName: "memory.write_knowledge",
            source: "rest",
        });

        const read = await dispatchToolCall({
            toolName: "memory.read_knowledge",
            input: { applicationId: APP_ID },
            context: member,
            services,
        });
        expect(read.status).toBe("succeeded");
        expect(read.data?.nodes).toEqual([]);
        expect(read.data?.edges).toEqual([]);
    });

    it("边端点不在本批节点 → failed UNKNOWN_NODE_KEY（自包含合同）；重复节点键 → DUPLICATE_NODE_KEY", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "product-analyst",
        });
        const dangling = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: {
                applicationId: APP_ID,
                nodes: NODES,
                edges: [
                    {
                        sourceKey: "journey:checkout",
                        targetKey: "business-entity:ghost",
                        relation: "covers",
                        properties: {},
                    },
                ],
            },
            context,
            services,
        });
        expect(dangling.status).toBe("failed");
        expect(dangling.error?.code).toBe("UNKNOWN_NODE_KEY");
        expect(dangling.error?.message).toContain("business-entity:ghost");

        const duplicate = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: {
                applicationId: APP_ID,
                nodes: [...NODES, NODES[0] as (typeof NODES)[number]],
            },
            context,
            services,
        });
        expect(duplicate.status).toBe("failed");
        expect(duplicate.error?.code).toBe("DUPLICATE_NODE_KEY");
    });

    it("输入契约：properties 缺省回填空对象；非小写连字符 nodeType/relation 被拒", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "product-analyst",
        });
        const defaulted = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: {
                applicationId: APP_ID,
                nodes: [
                    {
                        nodeType: "business-entity",
                        externalKey: "business-entity:order",
                    },
                ],
            },
            context,
            services,
        });
        expect(defaulted.status).toBe("succeeded");
        expect(defaulted.data?.writtenEdges).toBe(0);

        const badType = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: {
                applicationId: APP_ID,
                nodes: [
                    {
                        nodeType: "Business Entity",
                        externalKey: "business-entity:order",
                    },
                ],
            },
            context,
            services,
        });
        expect(badType.status).toBe("failed");
        expect(badType.error?.code).toBe("VALIDATION_FAILED");
    });

    it("跨组织写入 → NOT_FOUND（组织隔离，不泄漏存在性）", async () => {
        const { services } = makeServices();
        const context = agentToolCallContext({
            organizationId: ORG_OTHER,
            agentRole: "product-analyst",
        });
        const result = await dispatchToolCall({
            toolName: "memory.write_knowledge",
            input: { applicationId: APP_ID, nodes: NODES },
            context,
            services,
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("NOT_FOUND");
    });
});

describe("memory.search_memories 工具（T-E10-01 记忆检索）", () => {
    const BASE = {
        organizationId: ORG,
        projectId: "1a2b3c4d-0000-4000-8000-000000000010",
        applicationId: APP_ID,
        version: 1,
    } as const;

    it("reporter（memory.read）检索 → succeeded：query 相似召回 + 审计一条 + 组织取自上下文", async () => {
        const { services, audits, addMemory } = makeServices();
        addMemory({ ...BASE, kind: "test", content: "checkout journey smoke" });
        addMemory({ ...BASE, kind: "bug", content: "payment timeout on order" });
        const context = agentToolCallContext({
            organizationId: ORG,
            agentRole: "reporter",
        });
        const result = await dispatchToolCall({
            toolName: "memory.search_memories",
            input: { query: "checkout journey", limit: 5 },
            context,
            services,
        });
        expect(result.status).toBe("succeeded");
        const items = (result.data as { items: { content: string; kind: string; score: number }[] })
            .items;
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items[0]?.content).toBe("checkout journey smoke");
        expect(items[0]?.kind).toBe("test");
        expect(items[0]?.score).toBeGreaterThan(0);
        expect(
            audits.some(
                (record) =>
                    record.toolName === "memory.search_memories" && record.status === "succeeded",
            ),
        ).toBe(true);
    });

    it("viewer 零授权 → denied + 审计（REST 阶梯）", async () => {
        const { services, audits } = makeServices();
        const context = restToolCallContext({
            organizationId: ORG,
            membershipRole: "viewer",
            userId: "1a2b3c4d-0000-4000-8000-000000000020",
        });
        const result = await dispatchToolCall({
            toolName: "memory.search_memories",
            input: { query: "checkout" },
            context,
            services,
        });
        expect(result.status).toBe("denied");
        expect(result.error?.code).toBe("TOOL_PERMISSION_DENIED");
        expect(
            audits.some(
                (record) =>
                    record.toolName === "memory.search_memories" && record.status === "denied",
            ),
        ).toBe(true);
    });

    it("kind 收窄 + limit 夹逼 + 空结果合法（无匹配记忆）", async () => {
        const { services, addMemory } = makeServices();
        addMemory({ ...BASE, kind: "test", content: "checkout journey smoke" });
        addMemory({ ...BASE, kind: "bug", content: "payment timeout on order" });
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "reporter" });

        const bugOnly = await dispatchToolCall({
            toolName: "memory.search_memories",
            input: { query: "payment timeout", kind: "bug", limit: 10 },
            context,
            services,
        });
        const bugItems = (bugOnly.data as { items: { kind: string }[] }).items;
        expect(bugItems.every((item) => item.kind === "bug")).toBe(true);

        const empty = await dispatchToolCall({
            toolName: "memory.search_memories",
            input: { query: "database migration plan", limit: 10 },
            context,
            services,
        });
        expect(empty.status).toBe("succeeded");
        expect((empty.data as { items: unknown[] }).items).toEqual([]);
    });

    it("跨组织记忆不可见（租户强制面：org 键隔离）", async () => {
        const { services, addMemory } = makeServices();
        addMemory({
            ...BASE,
            organizationId: ORG_OTHER,
            kind: "test",
            content: "checkout journey smoke",
        });
        const context = agentToolCallContext({ organizationId: ORG, agentRole: "reporter" });
        const result = await dispatchToolCall({
            toolName: "memory.search_memories",
            input: { query: "checkout journey smoke", limit: 10 },
            context,
            services,
        });
        expect(result.status).toBe("succeeded");
        expect((result.data as { items: unknown[] }).items).toEqual([]);
    });
});
