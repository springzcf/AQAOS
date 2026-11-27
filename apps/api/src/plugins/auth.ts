/**
 * 认证与 RBAC 骨架中间件（T-E01-09，DDD §16.1 AUTHENTICATION_REQUIRED/PERMISSION_DENIED）。
 *
 * - Authorization: Bearer <jwt>（无状态，org/role 签发时固化）或
 *   Bearer aqaos_pat_...（数据库即时校验，撤销/过期立即生效）；
 * - 路由经 config.auth 声明需求：requireAuth（401）与 minRole（403）；
 * - 角色等级/合法值自 @aqaos/domain 唯一来源（T-E02-01）：viewer < member <
 *   admin < owner；完整 RBAC 矩阵在 T-E11-05 定稿（memberships.role 的 DB CHECK
 *   届时一并加）；role 来自 DB TEXT / JWT claims 等不可信边界，进入 AuthUser 前
 *   经 MembershipRoleSchema 归一，非法值降为 null（无成员关系=最低权限）；
 * - API Token 的多租户归属暂取首个成员关系（确定性排序）；组织切换随 T-E11-05 落地。
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import fp from "fastify-plugin";
import { MEMBERSHIP_ROLE_RANK, MembershipRoleSchema, type MembershipRole } from "@aqaos/domain";
import type { DbPool } from "../lib/db.js";
import { verifySession } from "../lib/jwt.js";
import { ApiError } from "../lib/errors.js";

export const API_TOKEN_PREFIX = "aqaos_pat_";
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 8;
/** last_used_at 节流间隔（毫秒）：避免逐请求写放大。 */
const LAST_USED_THROTTLE_MS = 60_000;

export type AuthVia = "jwt" | "api-token";

export interface AuthUser {
    userId: string;
    email: string;
    /** 无成员关系（或 role 非法降级）时为 null——任何 minRole 检查都不通过。 */
    role: MembershipRole | null;
    organizationId: string | null;
    via: AuthVia;
}

/** 不可信边界的 role 归一化：合法 MembershipRole 或 null（最低权限）。 */
function normalizeRole(raw: string | null | undefined): MembershipRole | null {
    const parsed = MembershipRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export interface RouteAuthConfig {
    /** true：未认证（含无效凭据）一律 401。 */
    requireAuth?: boolean;
    /** 最低角色（含）以上放行，低于则 403。 */
    minRole?: MembershipRole;
}

declare module "fastify" {
    interface FastifyRequest {
        /** 当前请求认证主体；未认证/凭据无效为 null。 */
        user: AuthUser | null;
    }

    interface FastifyContextConfig {
        auth?: RouteAuthConfig;
    }
}

export interface AuthPluginOptions extends FastifyPluginOptions {
    jwtSecret?: string;
    db?: DbPool;
}

export interface ApiTokenRecord {
    token: string;
    tokenPrefix: string;
    tokenHash: string;
}

/** 生成 API Token：明文仅此一次可见；库内存 sha256 与展示前缀。 */
export function generateApiToken(): ApiTokenRecord {
    const secret = randomBytes(32).toString("base64url");
    const token = `${API_TOKEN_PREFIX}${secret}`;
    return {
        token,
        tokenPrefix: secret.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
        tokenHash: createHash("sha256").update(token).digest("hex"),
    };
}

export function sha256OfToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function bearerTokenOf(raw: string | string[] | undefined): string | undefined {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") {
        return undefined;
    }
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match?.[1]?.trim() || undefined;
}

interface TokenRow {
    id: string;
    user_id: string;
    email: string;
    organization_id: string | null;
    role: string | null;
    last_used_at: Date | null;
}

async function resolveApiToken(db: DbPool, token: string): Promise<AuthUser | null> {
    const result = await db.query<TokenRow>(
        `SELECT t.id, t.user_id, t.last_used_at, u.email,
                m.organization_id, m.role
           FROM api_tokens t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN LATERAL (
             SELECT organization_id, role FROM memberships
              WHERE user_id = t.user_id
              ORDER BY organization_id
              LIMIT 1
           ) m ON TRUE
          WHERE t.token_hash = $1
            AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())`,
        [sha256OfToken(token)],
    );
    const row = result.rows[0];
    if (!row) {
        return null;
    }
    // 节流更新 last_used_at：fire-and-forget，失败不影响请求。
    const lastUsed = row.last_used_at?.getTime() ?? 0;
    if (Date.now() - lastUsed >= LAST_USED_THROTTLE_MS) {
        void db
            .query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id])
            .catch(() => undefined);
    }
    return {
        userId: row.user_id,
        email: row.email,
        organizationId: row.organization_id,
        role: normalizeRole(row.role),
        via: "api-token",
    };
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
    app.decorateRequest("user", null);

    app.addHook("preHandler", async (request) => {
        request.user = null;
        const token = bearerTokenOf(request.headers.authorization);
        if (token !== undefined) {
            if (token.startsWith(API_TOKEN_PREFIX)) {
                if (!options.db) {
                    throw new ApiError(
                        "NOT_IMPLEMENTED",
                        "API token authentication requires a configured database",
                    );
                }
                request.user = await resolveApiToken(options.db, token);
            } else if (options.jwtSecret) {
                try {
                    const claims = await verifySession(options.jwtSecret, token);
                    // claims 来自签发时的 DB 快照，但仍按不可信边界归一 role。
                    request.user = {
                        userId: claims.userId,
                        email: claims.email,
                        organizationId: claims.organizationId,
                        role: normalizeRole(claims.role),
                        via: "jwt",
                    };
                } catch {
                    // 无效 JWT 落到未认证；requireAuth 时由下方统一 401。
                }
            }
        }

        const authConfig = request.routeOptions.config?.auth;
        if (request.user === null && authConfig?.requireAuth) {
            throw new ApiError(
                "AUTHENTICATION_REQUIRED",
                token === undefined
                    ? "Authentication required: provide Authorization: Bearer <token>"
                    : "Invalid or expired credentials",
            );
        }
        if (authConfig?.minRole !== undefined) {
            const requiredRole = MembershipRoleSchema.safeParse(authConfig.minRole);
            if (!requiredRole.success) {
                // minRole 是代码内常量，非法值是编程错误而非客户端错误。
                throw new ApiError("INTERNAL_ERROR", `Unknown role: ${authConfig.minRole}`);
            }
            const currentRole = request.user?.role;
            const required = MEMBERSHIP_ROLE_RANK[requiredRole.data];
            const current =
                currentRole !== null && currentRole !== undefined
                    ? MEMBERSHIP_ROLE_RANK[currentRole]
                    : undefined;
            if (current === undefined || current < required) {
                throw new ApiError(
                    "PERMISSION_DENIED",
                    `This endpoint requires role ${authConfig.minRole} or above`,
                );
            }
        }
    });
};

// fp 包装突破封装：user 装饰器与认证 preHandler 挂到根作用域（注册顺序先于幂等插件，
// 保证 401/403 不被幂等缓存）。
export const authPlugin = fp(plugin, { name: "aqaos-auth" });
