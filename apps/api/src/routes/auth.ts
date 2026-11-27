/**
 * /api/v1/auth 路由（T-E01-09，DDD V1.5 增补）：登录签发 JWT、API Token 自服务。
 *
 * - 登录失败统一 401 "Invalid email or password"（不区分未知邮箱/密码错误/SSO 无密码，
 *   防用户枚举）；多组织成员需显式 organizationId 消歧；
 * - Token 明文仅在创建响应出现一次（库内 sha256）；DELETE 为软撤销立即生效。
 */

import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import type { DbPool } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";
import { signSession } from "../lib/jwt.js";
import { verifyPassword } from "../lib/passwords.js";
import { generateApiToken } from "../plugins/auth.js";

export interface AuthRoutesOptions extends FastifyPluginOptions {
    db?: DbPool;
    jwtSecret?: string;
}

interface MembershipRow {
    organization_id: string;
    role: string;
}

interface LoginBody {
    email: string;
    password: string;
    organizationId?: string;
}

const loginBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: {
        email: { type: "string", minLength: 3, maxLength: 320, description: "登录邮箱" },
        password: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "密码（本地认证）",
        },
        organizationId: {
            type: "string",
            description: "目标组织（多组织成员必填，单组织可省）",
        },
    },
} as const;

const createTokenBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
        name: { type: "string", minLength: 1, maxLength: 128, description: "Token 名称" },
        expiresAt: {
            type: ["string", "null"],
            description: "过期时间（ISO 8601，可空=永不过期）",
        },
    },
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
    const { db, jwtSecret } = options;

    app.post(
        "/api/v1/auth/login",
        { schema: { tags: ["auth"], body: loginBodySchema } },
        async (request) => {
            if (!db || !jwtSecret) {
                throw new ApiError(
                    "NOT_IMPLEMENTED",
                    "Login requires a configured database and JWT_SECRET",
                );
            }
            const body = request.body as LoginBody;

            const userResult = await db.query<{
                id: string;
                email: string;
                display_name: string | null;
                password_hash: string | null;
            }>(`SELECT id, email, display_name, password_hash FROM users WHERE email = $1`, [
                body.email.toLowerCase(),
            ]);
            const user = userResult.rows[0];
            // 未知邮箱 / SSO 无密码 / 密码错误 统一口径，防用户枚举。
            if (
                !user ||
                user.password_hash === null ||
                !(await verifyPassword(body.password, user.password_hash))
            ) {
                throw new ApiError("AUTHENTICATION_REQUIRED", "Invalid email or password");
            }

            const memberships = await db.query<MembershipRow>(
                `SELECT organization_id, role FROM memberships
                  WHERE user_id = $1 ORDER BY organization_id`,
                [user.id],
            );
            const rows = memberships.rows;

            let organizationId: string | null = null;
            if (body.organizationId !== undefined) {
                const match = rows.find((row) => row.organization_id === body.organizationId);
                if (!match) {
                    throw new ApiError(
                        "PERMISSION_DENIED",
                        "User is not a member of the requested organization",
                    );
                }
                organizationId = match.organization_id;
            } else if (rows.length === 1 && rows[0] !== undefined) {
                organizationId = rows[0].organization_id;
            } else if (rows.length > 1) {
                throw new ApiError(
                    "VALIDATION_FAILED",
                    "User belongs to multiple organizations; organizationId is required",
                );
            }
            const role = rows.find((row) => row.organization_id === organizationId)?.role ?? "none";

            const session = await signSession(jwtSecret, {
                userId: user.id,
                email: user.email,
                organizationId,
                role,
            });

            return {
                token: session.token,
                tokenType: "Bearer",
                expiresIn: session.expiresIn,
                user: {
                    id: user.id,
                    email: user.email,
                    displayName: user.display_name,
                },
                organizationId,
                role,
                memberships: rows.map((row) => ({
                    organizationId: row.organization_id,
                    role: row.role,
                })),
            };
        },
    );

    app.post(
        "/api/v1/auth/tokens",
        {
            schema: { tags: ["auth"], body: createTokenBodySchema },
            config: { auth: { requireAuth: true } },
        },
        async (request, reply) => {
            const user = request.user;
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Token management requires database");
            }
            const body = request.body as { name: string; expiresAt?: string | null };
            let expiresAt: Date | null = null;
            if (typeof body.expiresAt === "string" && body.expiresAt.length > 0) {
                const parsed = new Date(body.expiresAt);
                if (Number.isNaN(parsed.getTime())) {
                    throw new ApiError(
                        "VALIDATION_FAILED",
                        "expiresAt must be an ISO 8601 date-time",
                    );
                }
                if (parsed.getTime() <= Date.now()) {
                    throw new ApiError("VALIDATION_FAILED", "expiresAt must be in the future");
                }
                expiresAt = parsed;
            }

            const generated = generateApiToken();
            const inserted = await db.query<{
                id: string;
                created_at: Date;
                expires_at: Date | null;
            }>(
                `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, expires_at)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, created_at, expires_at`,
                [user.userId, body.name, generated.tokenPrefix, generated.tokenHash, expiresAt],
            );
            const row = inserted.rows[0];
            if (!row) {
                throw new ApiError("INTERNAL_ERROR", "Token insert returned no row");
            }
            reply.code(201);
            // 明文 token 仅此一次返回。
            return {
                id: row.id,
                token: generated.token,
                name: body.name,
                tokenPrefix: generated.tokenPrefix,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
            };
        },
    );

    app.get(
        "/api/v1/auth/tokens",
        { schema: { tags: ["auth"] }, config: { auth: { requireAuth: true } } },
        async (request) => {
            const user = request.user;
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Token management requires database");
            }
            const result = await db.query<{
                id: string;
                name: string;
                token_prefix: string;
                created_at: Date;
                last_used_at: Date | null;
                expires_at: Date | null;
                revoked_at: Date | null;
            }>(
                `SELECT id, name, token_prefix, created_at, last_used_at, expires_at, revoked_at
                   FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
                [user.userId],
            );
            return {
                items: result.rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    tokenPrefix: row.token_prefix,
                    createdAt: row.created_at,
                    lastUsedAt: row.last_used_at,
                    expiresAt: row.expires_at,
                    revokedAt: row.revoked_at,
                })),
            };
        },
    );

    app.delete(
        "/api/v1/auth/tokens/:id",
        { schema: { tags: ["auth"] }, config: { auth: { requireAuth: true } } },
        async (request, reply) => {
            const user = request.user;
            const { id } = request.params as { id: string };
            if (!UUID_PATTERN.test(id)) {
                throw new ApiError("VALIDATION_FAILED", "Token id must be a UUID");
            }
            if (!db || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "Token management requires database");
            }
            const revoked = await db.query(
                `UPDATE api_tokens SET revoked_at = now()
                  WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
                  RETURNING id`,
                [id, user.userId],
            );
            if (revoked.rowCount === 0) {
                throw new ApiError("NOT_FOUND", "Token not found or already revoked");
            }
            // 204 无载荷的 Fastify 5 正确写法是只设状态码、返回 null 载荷，让
            // wrapThenable 的处理器返回值管线驱动唯一一次 onSend：
            // - `reply.send(); return undefined` 会与 wrapThenable 竞态——多个 async
            //   onSend 钩子（requestId/幂等/审计）时触发第二条发送管线，产生
            //   ERR_HTTP_HEADERS_SENT、错误处理器误入与重复审计留痕；
            // - `return reply`（return-reply 快捷路径）对无载荷 204 直接死锁。
            reply.code(204);
            return null;
        },
    );
};
