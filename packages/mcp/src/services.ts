/**
 * McpServices —— 注册表工具依赖的数据/基础设施接口（T-E02-03）。
 *
 * 本包不依赖 pg：生产实现由宿主注入——
 * - apps/api（REST 消费 + 未来平台服务）：pg 连接池实现，全部查询按
 *   organizationId 过滤（组织隔离根）；
 * - workers/agent（SDK 消费）：注入指向 apps/api 或本地连接的实现；
 * - 测试：内存假实现。
 *
 * 预算钩子（checkToolBudget）是 T-E02-13 的接缝：真实扣减依赖
 * model_invocations 计量上报；基座阶段缺省放行。
 */

import type { MemoryHit, MemorySearchQuery } from "@aqaos/domain";
import type { ToolCallContext, ToolCallSource } from "./context.js";

/**
 * test_runs 的工具投影（只读摘要）：T-E02-03 基座阶段 DB 尚无
 * platforms/modes/trigger 列（T-E02-12 Run Registry 落全量契约），
 * 工具输出显式声明为投影而非完整 domain 契约，避免过度承诺。
 */
export interface McpRunSummary {
    id: string;
    projectId: string;
    applicationId: string;
    environmentId: string | null;
    objective: string;
    status: string;
    budget: Record<string, unknown>;
    coverage: Record<string, number>;
    temporalWorkflowId: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
}

/** environments 的工具投影（无运行态 status 列；环境栈状态随 E06 引擎落地）。 */
export interface McpEnvironmentSummary {
    id: string;
    applicationId: string;
    name: string;
    environmentType: string;
    baseUrl: string | null;
    createdAt: string;
}

/** bugs 表对外只读摘要（DDD §5.4 Bug 实体的工具投影）。 */
export interface McpBugSummary {
    id: string;
    applicationId: string;
    testRunId: string | null;
    title: string;
    severity: string;
    status: string;
    confidence?: number;
    verifiedAt?: string | null;
    createdAt: string;
}

/** 审计留痕记录（宿主实现写入 audit_logs；拒绝与执行都必须落一条）。 */
export interface ToolAuditRecord {
    organizationId: string;
    toolName: string;
    status: "succeeded" | "denied" | "failed";
    errorCode?: string;
    source: ToolCallSource;
    role: string;
    userId?: string;
    agentName?: string;
    runId?: string;
    /** 拒绝原因/失败信息（不含敏感数据）。 */
    message?: string;
}

/**
 * knowledge_nodes 的写入输入（T-E02-07）：externalKey 为应用层稳定标识
 * （productModelToKnowledgeGraph 约定 `<nodeType>:<key>` 形态）；置信标注
 * 约定存 properties.confidence（迁移 0004 表注释）。upsert 语义：同
 * (application_id, external_key) 更新 node_type/properties。
 */
export interface McpKnowledgeNodeInput {
    nodeType: string;
    externalKey: string;
    properties: Record<string, unknown>;
}

/**
 * knowledge_edges 的写入输入：端点用 externalKey 引用同一批次内的节点
 * （工具层已强制自包含——跨批引用属后续演进）；relation 值域由 domain
 * KNOWLEDGE_RELATIONS 定义（performed-by/covers/calls/transition）。
 * 同 (source, target, relation) 已存在则幂等跳过。
 */
export interface McpKnowledgeEdgeInput {
    sourceKey: string;
    targetKey: string;
    relation: string;
    properties: Record<string, unknown>;
}

/**
 * 读回形状：边已解析回 externalKey（source_id/target_id 不外泄）。
 * 边表无 created_at（迁移 0004 设计）；节点带 createdAt。
 */
export interface McpKnowledgeNode extends McpKnowledgeNodeInput {
    createdAt: string;
}

export type McpKnowledgeEdge = McpKnowledgeEdgeInput;

export interface McpServices {
    /** Run 查询（按组织过滤；未命中返回 null → 工具层 NOT_FOUND）。 */
    getRun(params: { runId: string; organizationId: string }): Promise<McpRunSummary | null>;
    /** Bug 列表（按组织过滤；可按 runId 收窄）。 */
    listBugs(params: {
        organizationId: string;
        runId?: string;
        limit: number;
    }): Promise<McpBugSummary[]>;
    /** Run 覆盖率（run 不存在返回 null；空 coverage {} 合法）。 */
    getCoverage(params: {
        runId: string;
        organizationId: string;
    }): Promise<Record<string, number> | null>;
    /** 环境列表（按组织过滤；可按 applicationId 收窄）。 */
    listEnvironments(params: {
        organizationId: string;
        applicationId?: string;
    }): Promise<McpEnvironmentSummary[]>;
    /**
     * 读知识图谱（按组织过滤；可按 nodeTypes/limit 收窄；返回该应用
     * 的节点与关联边）。application 对组织不可见 → null（工具层 NOT_FOUND）。
     */
    readKnowledge(params: {
        organizationId: string;
        applicationId: string;
        nodeTypes?: string[];
        limit: number;
    }): Promise<{ nodes: McpKnowledgeNode[]; edges: McpKnowledgeEdge[] } | null>;
    /**
     * 写知识图谱（节点 upsert + 边幂等去重，单事务；T-E02-07
     * Product Analyst 确定性落库的接缝）。application 对组织不可见 →
     * null（工具层 NOT_FOUND）；边端点不在本批节点 → 抛错（工具层已
     * 预校验，此处为纵深防御）。
     */
    writeKnowledge(params: {
        organizationId: string;
        applicationId: string;
        nodes: McpKnowledgeNodeInput[];
        edges: McpKnowledgeEdgeInput[];
    }): Promise<{ writtenNodes: number; writtenEdges: number } | null>;
    /**
     * 记忆近邻检索（T-E10-01：组织过滤在实现侧强制——query 里的
     * organizationId 来自可信上下文而非用户输入；可选收窄 project/
     * application/kind；content 经宿主 EmbeddingClient 嵌入后 cosine
     * 近邻排序）。空结果合法（记忆未写或未嵌入）。
     */
    searchMemories(query: MemorySearchQuery): Promise<readonly MemoryHit[]>;
    /** 审计钩子：dispatch 每次终态（denied/succeeded/failed）调用一次。 */
    recordToolCall(record: ToolAuditRecord): Promise<void>;
    /**
     * Run 预算校验钩子（T-E02-13 接 model_invocations 扣减）。
     * 缺省放行；宿主可注入真实校验（返回 allowed=false 时以
     * MODEL_BUDGET_EXCEEDED 拒绝并审计）。
     */
    checkToolBudget?(
        context: ToolCallContext,
        toolName: string,
    ): Promise<{ allowed: boolean; reason?: string }>;
}
