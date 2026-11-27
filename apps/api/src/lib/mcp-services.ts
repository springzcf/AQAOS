/**
 * McpServices 的 PostgreSQL 实现（T-E02-03，DDD §9 对外 REST 消费）。
 *
 * 全部查询按 organization_id 过滤（组织隔离根）——上下文组织与数据
 * 不匹配时表现为 NOT_FOUND/空集，不泄漏存在性。审计写入 audit_logs
 * （action: denied / execute；resource_type: mcp-tool；工具名/角色/
 * Run 绑定等非敏感上下文进 metadata）。
 *
 * checkToolBudget 缺省不注入（T-E02-13 接 model_invocations 扣减）。
 */

import type { EmbeddingClient, MemoryHit, MemoryRecord, MemorySearchQuery } from "@aqaos/domain";
import { HashEmbedder, MemoryRecordSchema } from "@aqaos/domain";
import type { McpServices, ToolAuditRecord } from "@aqaos/mcp";
import type { DbPool } from "./db.js";

interface RunRow {
    id: string;
    project_id: string;
    application_id: string;
    environment_id: string | null;
    objective: string;
    status: string;
    budget: Record<string, unknown> | null;
    coverage: Record<string, number> | null;
    temporal_workflow_id: string | null;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
}

interface BugRow {
    id: string;
    application_id: string;
    test_run_id: string | null;
    title: string;
    severity: string;
    status: string;
    confidence: string | null;
    verified_at: Date | null;
    created_at: Date;
}

interface EnvironmentRow {
    id: string;
    application_id: string;
    name: string;
    environment_type: string;
    base_url: string | null;
    created_at: Date;
}

interface KnowledgeNodeRow {
    id: string;
    node_type: string;
    external_key: string;
    properties: Record<string, unknown> | null;
    created_at: Date;
}

interface KnowledgeEdgeRow {
    relation: string;
    properties: Record<string, unknown> | null;
    source_key: string;
    target_key: string;
}

interface MemoryRow {
    organization_id: string;
    project_id: string;
    application_id: string;
    kind: string;
    content: string;
    confidence: string | null;
    source_run_id: string | null;
    version: number;
    expires_at: Date | null;
    score: number | null;
}

/** memories 行 → MemoryRecord（confidence NUMERIC → number）。 */
function memoryRowToRecord(row: MemoryRow): MemoryRecord {
    return MemoryRecordSchema.parse({
        organizationId: row.organization_id,
        projectId: row.project_id,
        applicationId: row.application_id,
        kind: row.kind,
        content: row.content,
        confidence: row.confidence === null ? undefined : Number(row.confidence),
        sourceRunId: row.source_run_id ?? undefined,
        version: row.version,
        expiresAt: row.expires_at === null ? undefined : row.expires_at.toISOString(),
    });
}

/**
 * 记忆写入（T-E10-01）：嵌入经注入的 EmbeddingClient 计算（过渡期
 * HashEmbedder，网关 T-E04 接真实模型）。**内部服务面**——平台侧确定性
 * 写（如 T-E10-02 去重基线、T-E10-05 反馈闭环），不经 MCP 工具暴露。
 * @returns 写入行 id。
 */
export async function insertMemory(
    db: DbPool,
    record: MemoryRecord,
    embedder: EmbeddingClient = new HashEmbedder(),
): Promise<string> {
    const [vector] = await embedder.embed([record.content]);
    const { rows } = await db.query<{ id: string }>(
        `INSERT INTO memories
             (organization_id, project_id, application_id, kind, content,
              embedding, confidence, source_run_id, version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10)
         RETURNING id`,
        [
            record.organizationId,
            record.projectId,
            record.applicationId,
            record.kind,
            record.content,
            vector === undefined ? null : JSON.stringify(vector),
            record.confidence ?? null,
            record.sourceRunId ?? null,
            record.version,
            record.expiresAt ?? null,
        ],
    );
    const row = rows[0];
    if (row === undefined) {
        throw new Error("memory insert returned no id");
    }
    return row.id;
}

/** 工具调用审计 → audit_logs 行（列命名与 T-E01-11 审计中间件同构）。 */
export function toolAuditToColumns(record: ToolAuditRecord): {
    organizationId: string;
    actorId: string | null;
    action: "denied" | "execute";
    resourceType: string;
    metadata: Record<string, unknown>;
} {
    return {
        organizationId: record.organizationId,
        actorId: record.userId ?? null,
        action: record.status === "denied" ? "denied" : "execute",
        resourceType: "mcp-tool",
        metadata: {
            tool: record.toolName,
            source: record.source,
            role: record.role,
            agentName: record.agentName,
            runId: record.runId,
            status: record.status,
            errorCode: record.errorCode,
            message: record.message,
        },
    };
}

export function createPgMcpServices(
    db: DbPool,
    embedder: EmbeddingClient = new HashEmbedder(),
): McpServices {
    return {
        async getRun({ runId, organizationId }) {
            const { rows } = await db.query<RunRow>(
                `SELECT id, project_id, application_id, environment_id, objective,
                        status, budget, coverage, temporal_workflow_id,
                        created_at, started_at, completed_at
                   FROM test_runs
                  WHERE id = $1 AND organization_id = $2`,
                [runId, organizationId],
            );
            const row = rows[0];
            if (!row) {
                return null;
            }
            return {
                id: row.id,
                projectId: row.project_id,
                applicationId: row.application_id,
                environmentId: row.environment_id,
                objective: row.objective,
                status: row.status,
                budget: row.budget ?? {},
                coverage: row.coverage ?? {},
                temporalWorkflowId: row.temporal_workflow_id,
                createdAt: row.created_at.toISOString(),
                startedAt: row.started_at?.toISOString() ?? null,
                completedAt: row.completed_at?.toISOString() ?? null,
            };
        },

        async listBugs({ organizationId, runId, limit }) {
            const conditions = ["organization_id = $1"];
            const params: unknown[] = [organizationId];
            if (runId !== undefined) {
                params.push(runId);
                conditions.push(`test_run_id = $${params.length}`);
            }
            params.push(limit);
            const { rows } = await db.query<BugRow>(
                `SELECT id, application_id, test_run_id, title, severity, status,
                        confidence, verified_at, created_at
                   FROM bugs
                  WHERE ${conditions.join(" AND ")}
                  ORDER BY created_at DESC
                  LIMIT $${params.length}`,
                params,
            );
            return rows.map((row) => ({
                id: row.id,
                applicationId: row.application_id,
                testRunId: row.test_run_id,
                title: row.title,
                severity: row.severity,
                status: row.status,
                confidence: row.confidence !== null ? Number(row.confidence) : undefined,
                verifiedAt: row.verified_at?.toISOString() ?? null,
                createdAt: row.created_at.toISOString(),
            }));
        },

        async getCoverage({ runId, organizationId }) {
            const { rows } = await db.query<{ coverage: Record<string, number> | null }>(
                `SELECT coverage FROM test_runs WHERE id = $1 AND organization_id = $2`,
                [runId, organizationId],
            );
            const row = rows[0];
            // run 不存在 → null（NOT_FOUND）；空 coverage {} 合法。
            return row ? (row.coverage ?? {}) : null;
        },

        async listEnvironments({ organizationId, applicationId }) {
            const conditions = ["organization_id = $1"];
            const params: unknown[] = [organizationId];
            if (applicationId !== undefined) {
                params.push(applicationId);
                conditions.push(`application_id = $${params.length}`);
            }
            const { rows } = await db.query<EnvironmentRow>(
                `SELECT id, application_id, name, environment_type, base_url, created_at
                   FROM environments
                  WHERE ${conditions.join(" AND ")}
                  ORDER BY created_at DESC`,
                params,
            );
            return rows.map((row) => ({
                id: row.id,
                applicationId: row.application_id,
                name: row.name,
                environmentType: row.environment_type,
                baseUrl: row.base_url,
                createdAt: row.created_at.toISOString(),
            }));
        },

        async readKnowledge({ organizationId, applicationId, nodeTypes, limit }) {
            // 应用对组织不可见 → null（工具层 NOT_FOUND；不泄漏存在性）。
            const visible = await db.query(
                `SELECT 1 FROM applications WHERE id = $1 AND organization_id = $2`,
                [applicationId, organizationId],
            );
            if (visible.rowCount === 0) {
                return null;
            }
            const nodeConditions = ["organization_id = $1", "application_id = $2"];
            const nodeParams: unknown[] = [organizationId, applicationId];
            if (nodeTypes !== undefined) {
                nodeParams.push(nodeTypes);
                nodeConditions.push(`node_type = ANY($${nodeParams.length})`);
            }
            nodeParams.push(limit);
            const { rows: nodeRows } = await db.query<KnowledgeNodeRow>(
                `SELECT id, node_type, external_key, properties, created_at
                   FROM knowledge_nodes
                  WHERE ${nodeConditions.join(" AND ")}
                  ORDER BY created_at
                  LIMIT $${nodeParams.length}`,
                nodeParams,
            );
            // 边跟随"以命中节点为源"的语义：nodeTypes 收窄时，以命中节点为
            // 源的边一并返回（收窄视图不丢图谱连接）；JOIN 仅为解析回
            // externalKey（source_id/target_id 不外泄）。边表无 created_at。
            const edgeConditions = ["ke.organization_id = $1", "ke.application_id = $2"];
            const edgeParams: unknown[] = [organizationId, applicationId];
            if (nodeTypes !== undefined) {
                edgeParams.push(nodeTypes);
                edgeConditions.push(`s.node_type = ANY($${edgeParams.length})`);
            }
            const { rows: edgeRows } = await db.query<KnowledgeEdgeRow>(
                `SELECT ke.relation, ke.properties,
                        s.external_key AS source_key, t.external_key AS target_key
                   FROM knowledge_edges ke
                   JOIN knowledge_nodes s ON s.id = ke.source_id
                   JOIN knowledge_nodes t ON t.id = ke.target_id
                  WHERE ${edgeConditions.join(" AND ")}`,
                edgeParams,
            );
            return {
                nodes: nodeRows.map((row) => ({
                    nodeType: row.node_type,
                    externalKey: row.external_key,
                    properties: row.properties ?? {},
                    createdAt: row.created_at.toISOString(),
                })),
                edges: edgeRows.map((row) => ({
                    sourceKey: row.source_key,
                    targetKey: row.target_key,
                    relation: row.relation,
                    properties: row.properties ?? {},
                })),
            };
        },

        async writeKnowledge({ organizationId, applicationId, nodes, edges }) {
            const visible = await db.query(
                `SELECT 1 FROM applications WHERE id = $1 AND organization_id = $2`,
                [applicationId, organizationId],
            );
            if (visible.rowCount === 0) {
                return null;
            }
            // pg Pool 的 query 每次可能落到不同连接——事务必须独占一个 client。
            const client = await db.connect();
            try {
                await client.query("BEGIN");
                // 节点 upsert（迁移 0004 无唯一约束 → UPDATE 回填，未中则 INSERT）。
                const nodeIdByKey = new Map<string, string>();
                for (const node of nodes) {
                    const updated = await client.query<{ id: string }>(
                        `UPDATE knowledge_nodes
                            SET node_type = $3, properties = $4::jsonb
                          WHERE organization_id = $1 AND application_id = $2
                            AND external_key = $5
                          RETURNING id`,
                        [
                            organizationId,
                            applicationId,
                            node.nodeType,
                            JSON.stringify(node.properties),
                            node.externalKey,
                        ],
                    );
                    const updatedRow = updated.rows[0];
                    if (updatedRow !== undefined) {
                        nodeIdByKey.set(node.externalKey, updatedRow.id);
                        continue;
                    }
                    const inserted = await client.query<{ id: string }>(
                        `INSERT INTO knowledge_nodes
                             (organization_id, application_id, node_type, external_key, properties)
                         VALUES ($1, $2, $3, $4, $5::jsonb)
                         RETURNING id`,
                        [
                            organizationId,
                            applicationId,
                            node.nodeType,
                            node.externalKey,
                            JSON.stringify(node.properties),
                        ],
                    );
                    const insertedRow = inserted.rows[0];
                    if (insertedRow === undefined) {
                        // INSERT ... RETURNING 恒返回行；缺行属驱动异常（回滚）。
                        throw new Error(
                            `knowledge node upsert returned no id for "${node.externalKey}"`,
                        );
                    }
                    nodeIdByKey.set(node.externalKey, insertedRow.id);
                }
                // 边幂等：(source, target, relation) 已存在则跳过（单写者语义
                // 够用；唯一约束化随后续迁移收紧）。边表 organization_id/
                // application_id 为 NOT NULL——必须显式落列。端点缺引用 →
                // 回滚抛错（工具层已预校验自包含，纵深防御）。
                let writtenEdges = 0;
                for (const edge of edges) {
                    const sourceId = nodeIdByKey.get(edge.sourceKey);
                    const targetId = nodeIdByKey.get(edge.targetKey);
                    if (sourceId === undefined || targetId === undefined) {
                        throw new Error(
                            `knowledge edge references unknown node key "${edge.sourceKey}" → "${edge.targetKey}"`,
                        );
                    }
                    const existing = await client.query(
                        `SELECT 1 FROM knowledge_edges
                          WHERE application_id = $1 AND source_id = $2
                            AND target_id = $3 AND relation = $4`,
                        [applicationId, sourceId, targetId, edge.relation],
                    );
                    if (existing.rowCount !== null && existing.rowCount > 0) {
                        continue;
                    }
                    await client.query(
                        `INSERT INTO knowledge_edges
                             (organization_id, application_id, source_id, target_id, relation, properties)
                         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
                        [
                            organizationId,
                            applicationId,
                            sourceId,
                            targetId,
                            edge.relation,
                            JSON.stringify(edge.properties),
                        ],
                    );
                    writtenEdges += 1;
                }
                await client.query("COMMIT");
                return { writtenNodes: nodes.length, writtenEdges };
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        },

        async searchMemories(query: MemorySearchQuery): Promise<readonly MemoryHit[]> {
            // 租户强制面：organizationId 是唯一必需过滤键（来自可信上下文），
            // 收窄键可选；过期记忆检索侧过滤（不物理删除）。
            const conditions = ["organization_id = $1"];
            const params: unknown[] = [query.organizationId];
            if (query.projectId !== undefined) {
                params.push(query.projectId);
                conditions.push(`project_id = $${params.length}`);
            }
            if (query.applicationId !== undefined) {
                params.push(query.applicationId);
                conditions.push(`application_id = $${params.length}`);
            }
            if (query.kind !== undefined) {
                params.push(query.kind);
                conditions.push(`kind = $${params.length}`);
            }
            conditions.push(`(expires_at IS NULL OR expires_at > now())`);
            const [queryVector] = await embedder.embed([query.content]);
            if (queryVector === undefined) {
                return [];
            }
            // pg 参数须为文本 '[...]' 形态（JSON.stringify）；直接传 JS 数组
            // 会被驱动序列化成 Postgres 数组 '{...}'，::vector 转换失败。
            params.push(JSON.stringify(queryVector));
            const vectorIndex = params.length;
            params.push(query.limit);
            const { rows } = await db.query<MemoryRow>(
                `SELECT organization_id, project_id, application_id, kind, content,
                        confidence, source_run_id, version, expires_at,
                        1 - (embedding <=> $${vectorIndex}::vector) AS score
                   FROM memories
                  WHERE embedding IS NOT NULL AND ${conditions.join(" AND ")}
                  ORDER BY embedding <=> $${vectorIndex}::vector
                  LIMIT $${params.length}`,
                params,
            );
            // score 收窄需显式（filter 不传播到 map 的行类型）。
            const hits: MemoryHit[] = [];
            for (const row of rows) {
                if (row.score === null || row.score <= 0) {
                    continue;
                }
                hits.push({ record: memoryRowToRecord(row), score: row.score });
            }
            return hits;
        },

        async recordToolCall(record) {
            const columns = toolAuditToColumns(record);
            await db.query(
                `INSERT INTO audit_logs
                    (organization_id, actor_id, action, resource_type, resource_id, metadata)
                 VALUES ($1, $2, $3, $4, NULL, $5)`,
                [
                    columns.organizationId,
                    columns.actorId,
                    columns.action,
                    columns.resourceType,
                    JSON.stringify(columns.metadata),
                ],
            );
        },
    };
}
