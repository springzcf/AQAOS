/**
 * 会话契约（T-E01-10，纯函数便于单元回归）。
 *
 * JWT 由 Control Plane API 签发，dashboard 仅以 httpOnly Cookie 承载并转发——
 * token 永不出现在客户端 JS。TTL 与 API 端 JWT_TTL_SECONDS（12h）一致。
 */

export const SESSION_COOKIE = "aqaos_session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export interface SessionCookieOptions {
    httpOnly: true;
    sameSite: "lax";
    path: string;
    maxAge: number;
    secure: boolean;
}

/**
 * Cookie 选项；生产（或显式 AQAOS_COOKIE_SECURE=1）启用 Secure。
 * 测试可传入任意布尔验证形态，无需 Node 运行时。
 */
export function sessionCookieOptions(isProductionLike: boolean): SessionCookieOptions {
    const secure = isProductionLike || process.env.AQAOS_COOKIE_SECURE === "1";
    return {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure,
    };
}

/** 登录请求体的服务端校验（转发前防线，错误统一 400 VALIDATION_FAILED）。 */
export function validateLoginPayload(
    payload: unknown,
): { email: string; password: string; organizationId?: string } | null {
    if (typeof payload !== "object" || payload === null) {
        return null;
    }
    const { email, password, organizationId } = payload as Record<string, unknown>;
    if (typeof email !== "string" || email.length === 0 || email.length > 320) {
        return null;
    }
    if (typeof password !== "string" || password.length === 0 || password.length > 256) {
        return null;
    }
    if (organizationId !== undefined && typeof organizationId !== "string") {
        return null;
    }
    return organizationId === undefined ? { email, password } : { email, password, organizationId };
}
