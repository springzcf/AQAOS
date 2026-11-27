/**
 * JWT 签发/校验（T-E01-09）：jose HS256，12h 会话。
 *
 * Claims：sub=userId、email、org=organizationId（可空）、role（memberships.role，
 * 无成员关系为 "none"）。角色/组织在签发时固化——权限矩阵变更后需重新登录生效
 * （T-E11-05 完整 RBAC 引入 token 版本号/吊销列表时收紧）。
 * API Token 走数据库即时校验（见 plugins/auth.ts），不受此 TTL 约束。
 */

import { SignJWT, jwtVerify } from "jose";

export const JWT_ISSUER = "aqaos-api";
export const JWT_AUDIENCE = "aqaos-clients";
export const JWT_TTL_SECONDS = 12 * 60 * 60;

export interface SessionClaims {
    userId: string;
    email: string;
    organizationId: string | null;
    role: string;
}

export function secretKeyOf(jwtSecret: string): Uint8Array {
    return new TextEncoder().encode(jwtSecret);
}

export async function signSession(
    jwtSecret: string,
    claims: SessionClaims,
): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({
        email: claims.email,
        org: claims.organizationId,
        role: claims.role,
    })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.userId)
        .setIssuedAt()
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setExpirationTime(`${JWT_TTL_SECONDS}s`)
        .sign(secretKeyOf(jwtSecret));
    return { token, expiresIn: JWT_TTL_SECONDS };
}

/** 校验失败（签名/过期/issuer/audience）抛 jose 异常，由调用方归一为 401。 */
export async function verifySession(jwtSecret: string, token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, secretKeyOf(jwtSecret), {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    });
    const organizationId =
        typeof payload.org === "string" && payload.org.length > 0 ? payload.org : null;
    return {
        userId: String(payload.sub),
        email: typeof payload.email === "string" ? payload.email : "",
        organizationId,
        role: typeof payload.role === "string" ? payload.role : "none",
    };
}
