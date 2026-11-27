/**
 * 工具注册表（T-E02-03，DDD §9）。
 *
 * 每个工具 = domain 目录规格（名称/域/所需权限，单一事实源）+ zod 输入
 * 契约 + 处理器。处理器只依赖 McpServices 接口（宿主注入实现），注册表
 * 本身零 I/O、可离线测试。
 *
 * 基座阶段实装 7 个 DB 支撑工具（qa.get_run / qa.list_bugs / qa.get_coverage
 * / env.list_environments / memory.read_knowledge / memory.write_knowledge
 * / memory.search_memories——T-E02-07 知识图谱读写 + T-E10-01 记忆检索）；
 * 其余 23 个目录工具随引擎任务（E04 浏览器、E05 API、E06 环境、E07 证据）
 * 逐个登记——findTool 未命中即 failed TOOL_NOT_FOUND，权限矩阵已先行覆盖
 * 全目录。
 */

import { MemoryKindSchema, UuidSchema, type McpToolSpec, type MemoryKind } from "@aqaos/domain";
import { z } from "zod";
import type { ToolCallContext } from "./context.js";
import type { McpServices } from "./services.js";

/** 处理器可抛的结构化错误：dispatch 捕获 → failed 结果（不泄漏堆栈）。 */
export class McpToolError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "McpToolError";
        this.code = code;
    }
}

/**
 * 类型擦除的工具定义形态：dispatch / SDK tool() / REST 消费统一使用。
 * Args 字面量类型只在 defineTool 的作者侧存在（处理器入参在闭包内收窄）。
 */
export interface ToolDefinition {
    /** domain 工具目录规格（canonical 点分名 + 所需权限）。 */
    spec: McpToolSpec;
    description: string;
    /** zod 原始 shape：SDK tool() 输入契约与严格对象校验同源。 */
    inputShape: z.ZodRawShape;
    /** 派生的严格对象 schema（dispatch 入口校验用）。 */
    inputSchema: z.ZodType<unknown>;
    handler: (
        input: unknown,
        services: McpServices,
        context: ToolCallContext,
    ) => Promise<Record<string, unknown>>;
}

export function defineTool<Args extends Record<string, unknown>>(
    spec: McpToolSpec,
    description: string,
    inputShape: z.ZodRawShape,
    handler: (
        input: Args,
        services: McpServices,
        context: ToolCallContext,
    ) => Promise<Record<string, unknown>>,
): ToolDefinition {
    return {
        spec,
        description,
        inputShape,
        // zod 无法从 RawShape 反推 Args 字面量类型——集中在此一处收窄。
        inputSchema: z.object(inputShape).strict() as unknown as z.ZodType<unknown>,
        handler: (input, services, context) => handler(input as Args, services, context),
    };
}

/** 知识节点类型值域（domain KNOWLEDGE_NODE_TYPES 同律：小写连字符）。 */
const KnowledgeNodeTypeSchema = z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9-]*$/, "nodeType must be lowercase-hyphenated");

/**
 * externalKey 值域：与 domain productModelToKnowledgeGraph 约定一致
 * （`business-entity:order` / `entity-state:order:pending` 形态，冒号分段）。
 */
const KnowledgeExternalKeySchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9.:-]*$/, "externalKey must be lowercase, colon/dot/hyphen separated");

/** 边关系值域（domain KNOWLEDGE_RELATIONS 同律）。 */
const KnowledgeRelationSchema = z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9-]*$/, "relation must be lowercase-hyphenated");

const KnowledgePropertiesSchema = z.record(z.unknown()).default({});

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
    defineTool<{ runId: string }>(
        { name: "qa.get_run", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
        "查询一次测试 Run 的状态、目标、平台/模式与预算（只读）。",
        { runId: UuidSchema },
        async (input, services, context) => {
            const run = await services.getRun({
                runId: input.runId,
                organizationId: context.organizationId,
            });
            if (!run) {
                throw new McpToolError("NOT_FOUND", `run ${input.runId} not found`);
            }
            return { run };
        },
    ),
    defineTool<{ runId?: string; limit: number }>(
        { name: "qa.list_bugs", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
        "列出组织内已发现的 Bug（可按 runId 过滤，只读）。",
        {
            runId: UuidSchema.optional(),
            limit: z.number().int().min(1).max(200).default(50),
        },
        async (input, services, context) => {
            const items = await services.listBugs({
                organizationId: context.organizationId,
                runId: input.runId,
                limit: input.limit,
            });
            return { items };
        },
    ),
    defineTool<{ runId: string }>(
        { name: "qa.get_coverage", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
        "查询一次 Run 的覆盖率汇总（只读；空 coverage 合法）。",
        { runId: UuidSchema },
        async (input, services, context) => {
            const coverage = await services.getCoverage({
                runId: input.runId,
                organizationId: context.organizationId,
            });
            if (coverage === null) {
                throw new McpToolError("NOT_FOUND", `run ${input.runId} not found`);
            }
            return { runId: input.runId, coverage };
        },
    ),
    defineTool<{ applicationId?: string }>(
        {
            name: "env.list_environments",
            domain: "environment",
            requiredPermissions: ["environment.read"],
        },
        "列出组织的测试环境及其状态（可按 applicationId 过滤，只读）。",
        { applicationId: UuidSchema.optional() },
        async (input, services, context) => {
            const items = await services.listEnvironments({
                organizationId: context.organizationId,
                applicationId: input.applicationId,
            });
            return { items };
        },
    ),
    defineTool<{ applicationId: string; nodeTypes?: string[]; limit: number }>(
        {
            name: "memory.read_knowledge",
            domain: "memory",
            requiredPermissions: ["memory.read"],
        },
        "读取应用的产品知识图谱（节点与边；可按 nodeTypes 过滤，只读）。",
        {
            applicationId: UuidSchema,
            nodeTypes: z.array(KnowledgeNodeTypeSchema).min(1).max(20).optional(),
            limit: z.number().int().min(1).max(500).default(100),
        },
        async (input, services, context) => {
            const graph = await services.readKnowledge({
                organizationId: context.organizationId,
                applicationId: input.applicationId,
                nodeTypes: input.nodeTypes,
                limit: input.limit,
            });
            if (graph === null) {
                throw new McpToolError("NOT_FOUND", `application ${input.applicationId} not found`);
            }
            return { nodes: graph.nodes, edges: graph.edges };
        },
    ),
    defineTool<{
        applicationId: string;
        nodes: {
            nodeType: string;
            externalKey: string;
            properties: Record<string, unknown>;
        }[];
        edges: {
            sourceKey: string;
            targetKey: string;
            relation: string;
            properties: Record<string, unknown>;
        }[];
    }>(
        {
            name: "memory.write_knowledge",
            domain: "memory",
            requiredPermissions: ["memory.write"],
        },
        "写入产品知识图谱（节点 upsert；边端点必须在本批节点内，幂等去重）。",
        {
            applicationId: UuidSchema,
            nodes: z
                .array(
                    z
                        .object({
                            nodeType: KnowledgeNodeTypeSchema,
                            externalKey: KnowledgeExternalKeySchema,
                            properties: KnowledgePropertiesSchema,
                        })
                        .strict(),
                )
                .min(1)
                .max(500),
            edges: z
                .array(
                    z
                        .object({
                            sourceKey: KnowledgeExternalKeySchema,
                            targetKey: KnowledgeExternalKeySchema,
                            relation: KnowledgeRelationSchema,
                            properties: KnowledgePropertiesSchema,
                        })
                        .strict(),
                )
                .max(500)
                .default([]),
        },
        async (input, services, context) => {
            // 自包含合同：边端点必须落在本批节点内（v1 语义——跨批引用属
            // 后续演进；显式拒绝优于悬空边）。节点 externalKey 批内亦须唯一。
            const keySet = new Set<string>();
            for (const node of input.nodes) {
                if (keySet.has(node.externalKey)) {
                    throw new McpToolError(
                        "DUPLICATE_NODE_KEY",
                        `node externalKey "${node.externalKey}" appears more than once in this batch`,
                    );
                }
                keySet.add(node.externalKey);
            }
            for (const edge of input.edges) {
                if (!keySet.has(edge.sourceKey)) {
                    throw new McpToolError(
                        "UNKNOWN_NODE_KEY",
                        `edge source "${edge.sourceKey}" is not a node in this write batch`,
                    );
                }
                if (!keySet.has(edge.targetKey)) {
                    throw new McpToolError(
                        "UNKNOWN_NODE_KEY",
                        `edge target "${edge.targetKey}" is not a node in this write batch`,
                    );
                }
            }
            const written = await services.writeKnowledge({
                organizationId: context.organizationId,
                applicationId: input.applicationId,
                nodes: input.nodes,
                edges: input.edges,
            });
            if (written === null) {
                throw new McpToolError("NOT_FOUND", `application ${input.applicationId} not found`);
            }
            return {
                writtenNodes: written.writtenNodes,
                writtenEdges: written.writtenEdges,
            };
        },
    ),
    defineTool<{
        query: string;
        kind?: MemoryKind;
        projectId?: string;
        applicationId?: string;
        limit: number;
    }>(
        {
            name: "memory.search_memories",
            domain: "memory",
            requiredPermissions: ["memory.read"],
        },
        "跨 Run 记忆近邻检索（按语义相似召回；组织范围固定为调用方，可按 project/application/kind 收窄）。",
        {
            query: z.string().min(1).max(2000),
            kind: MemoryKindSchema.optional(),
            projectId: UuidSchema.optional(),
            applicationId: UuidSchema.optional(),
            limit: z.number().int().min(1).max(50).default(10),
        },
        async (input, services, context) => {
            // 租户强制面：organizationId 取自可信上下文（调用方组织），
            // 用户输入只提供收窄键——跨组织检索在构造上不可能。
            const hits = await services.searchMemories({
                organizationId: context.organizationId,
                projectId: input.projectId,
                applicationId: input.applicationId,
                kind: input.kind,
                content: input.query,
                limit: input.limit,
            });
            const items = hits.map((hit) => ({
                kind: hit.record.kind,
                content: hit.record.content,
                score: hit.score,
                projectId: hit.record.projectId,
                applicationId: hit.record.applicationId,
                confidence: hit.record.confidence,
                version: hit.record.version,
                expiresAt: hit.record.expiresAt,
            }));
            return { items };
        },
    ),
];

/** canonical 点分名与 SDK 下划线名（qa.get_run ↔ qa_get_run）双索引。 */
const BY_CANONICAL = new Map<string, ToolDefinition>(
    TOOL_REGISTRY.map((definition) => [definition.spec.name, definition]),
);

/** SDK 工具名约束 ^[a-zA-Z0-9_-]{1,64}$：点分分隔符转下划线。 */
export function toSdkToolName(canonicalName: string): string {
    return canonicalName.replace(".", "_");
}

const BY_SDK_NAME = new Map<string, ToolDefinition>(
    TOOL_REGISTRY.map((definition) => [toSdkToolName(definition.spec.name), definition]),
);

/** 查注册表：接受 canonical（qa.get_run，REST 路径）与 SDK 名（qa_get_run）。 */
export function findToolDefinition(name: string): ToolDefinition | null {
    return BY_CANONICAL.get(name) ?? BY_SDK_NAME.get(name) ?? null;
}
