/**
 * /api/v1/users/me 与 /api/v1/organizations（T-E01-09：users/memberships 表接入）。
 *
 * /users/me —— 当前认证主体画像 + 全部成员关系（JWT 与 API Token 两种凭据同形）；
 * /organizations —— 管理面：minRole admin（骨架 RBAC 的 403 验收路径）。
 */

import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import type { DbPool } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";

export interface AccountRoutesOptions extends FastifyPluginOptions {
    db?: DbPool;
}

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (app, options) => {
    const { db } = options;

    app.get(
        "/api/v1/users/me",
        { schema: { tags: ["meta"] }, config: { auth: { requireAuth: true } } },
        async (request) => {
            const user = request.user;
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Profile requires database");
            }
            const profile = await db.query<{
                id: string;
                email: string;
                display_name: string | null;
                auth_provider: string;
                created_at: Date;
            }>(
                `SELECT id, email, display_name, auth_provider, created_at
                   FROM users WHERE id = $1`,
                [user.userId],
            );
            const row = profile.rows[0];
            if (!row) {
                // 用户在 Token 生命周期内被删除。
                throw new ApiError("AUTHENTICATION_REQUIRED", "User no longer exists");
            }
            const memberships = await db.query<{
                organization_id: string;
                role: string;
                name: string;
            }>(
                `SELECT m.organization_id, m.role, o.name
                   FROM memberships m
                   JOIN organizations o ON o.id = m.organization_id
                  WHERE m.user_id = $1 ORDER BY m.organization_id`,
                [user.userId],
            );
            return {
                id: row.id,
                email: row.email,
                displayName: row.display_name,
                authProvider: row.auth_provider,
                createdAt: row.created_at,
                activeOrganizationId: user.organizationId,
                activeRole: user.role,
                credentialsVia: user.via,
                memberships: memberships.rows.map((m) => ({
                    organizationId: m.organization_id,
                    organizationName: m.name,
                    role: m.role,
                })),
            };
        },
    );

    app.get(
        "/api/v1/organizations",
        { schema: { tags: ["meta"] }, config: { auth: { requireAuth: true, minRole: "admin" } } },
        async (request) => {
            const user = request.user;
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Organizations require database");
            }
            const result = await db.query<{
                id: string;
                name: string;
                slug: string;
                created_at: Date;
                role: string;
            }>(
                `SELECT o.id, o.name, o.slug, o.created_at, m.role
                   FROM organizations o
                   JOIN memberships m ON m.organization_id = o.id
                  WHERE m.user_id = $1
                    AND m.role IN ('admin', 'owner')
                  ORDER BY o.created_at`,
                [user.userId],
            );
            return {
                items: result.rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    slug: row.slug,
                    createdAt: row.created_at,
                    yourRole: row.role,
                })),
            };
        },
    );
};
