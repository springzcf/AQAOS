/**
 * GET /api/v1/audit-logs（T-E01-11 查询接口）：组织内审计留痕分页查询。
 * minRole admin——审计是管理面数据；分页 limit/offset + action/resourceType 过滤。
 */

import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import type { DbPool } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";

export interface AuditRoutesOptions extends FastifyPluginOptions {
    db?: DbPool;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const auditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (app, options) => {
    const { db } = options;

    app.get(
        "/api/v1/audit-logs",
        {
            schema: { tags: ["meta"] },
            config: { auth: { requireAuth: true, minRole: "admin" } },
        },
        async (request) => {
            const user = request.user;
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Audit queries require database");
            }
            const organizationId = user.organizationId;
            if (!organizationId) {
                return { items: [], total: 0 };
            }

            const query = request.query as {
                limit?: string;
                offset?: string;
                action?: string;
                resourceType?: string;
            };

            let limit = DEFAULT_LIMIT;
            if (query.limit !== undefined) {
                const parsed = Number(query.limit);
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
                    throw new ApiError(
                        "VALIDATION_FAILED",
                        `limit must be an integer in [1, ${MAX_LIMIT}]`,
                    );
                }
                limit = parsed;
            }
            let offset = 0;
            if (query.offset !== undefined) {
                const parsed = Number(query.offset);
                if (!Number.isInteger(parsed) || parsed < 0) {
                    throw new ApiError(
                        "VALIDATION_FAILED",
                        "offset must be a non-negative integer",
                    );
                }
                offset = parsed;
            }
            if (query.action !== undefined && query.action.length > 64) {
                throw new ApiError("VALIDATION_FAILED", "action filter too long");
            }
            if (query.resourceType !== undefined && query.resourceType.length > 128) {
                throw new ApiError("VALIDATION_FAILED", "resourceType filter too long");
            }

            const conditions: string[] = ["organization_id = $1"];
            const params: unknown[] = [organizationId];
            if (query.action !== undefined) {
                params.push(query.action);
                conditions.push(`action = $${params.length}`);
            }
            if (query.resourceType !== undefined) {
                params.push(query.resourceType);
                conditions.push(`resource_type = $${params.length}`);
            }

            const where = conditions.join(" AND ");
            const rows = await db.query<{
                id: string;
                actor_id: string | null;
                actor_email: string | null;
                action: string;
                resource_type: string;
                resource_id: string | null;
                metadata: unknown;
                created_at: Date;
            }>(
                `SELECT l.id, l.actor_id, u.email AS actor_email, l.action,
                        l.resource_type, l.resource_id, l.metadata, l.created_at
                   FROM audit_logs l
                   LEFT JOIN users u ON u.id = l.actor_id
                  WHERE ${where}
                  ORDER BY l.created_at DESC
                  LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, limit, offset],
            );
            const total = await db.query<{ count: string }>(
                `SELECT count(*) AS count FROM audit_logs WHERE ${where}`,
                params,
            );

            return {
                items: rows.rows.map((row) => ({
                    id: row.id,
                    actorId: row.actor_id,
                    actorEmail: row.actor_email,
                    action: row.action,
                    resourceType: row.resource_type,
                    resourceId: row.resource_id,
                    metadata: row.metadata,
                    createdAt: row.created_at,
                })),
                total: Number(total.rows[0]?.count ?? 0),
            };
        },
    );
};
