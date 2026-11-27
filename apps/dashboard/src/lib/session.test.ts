/**
 * 会话契约单元回归（T-E01-10）：Cookie 选项形态（httpOnly/secure 生产开关）与
 * 登录载荷服务端校验（类型/长度/多组织字段）。
 */

import { describe, expect, it } from "vitest";
import {
    SESSION_COOKIE,
    SESSION_MAX_AGE_SECONDS,
    sessionCookieOptions,
    validateLoginPayload,
} from "./session.js";

describe("session cookie contract", () => {
    it("Cookie 常量与 API 端 JWT TTL 对齐（12h）", () => {
        expect(SESSION_COOKIE).toBe("aqaos_session");
        expect(SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    });

    it("开发环境（非生产）不启用 Secure，便于本地 http 联调", () => {
        const options = sessionCookieOptions(false);
        expect(options).toEqual({
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            maxAge: SESSION_MAX_AGE_SECONDS,
            secure: false,
        });
    });

    it("生产环境强制 httpOnly + Secure", () => {
        const options = sessionCookieOptions(true);
        expect(options.httpOnly).toBe(true);
        expect(options.secure).toBe(true);
        expect(options.sameSite).toBe("lax");
    });

    it("AQAOS_COOKIE_SECURE=1 显式启用（HTTPS 部署但 NODE_ENV 非 production）", () => {
        process.env.AQAOS_COOKIE_SECURE = "1";
        try {
            expect(sessionCookieOptions(false).secure).toBe(true);
        } finally {
            delete process.env.AQAOS_COOKIE_SECURE;
        }
    });
});

describe("login payload validation", () => {
    it("合法载荷通过；organizationId 可选透传", () => {
        expect(validateLoginPayload({ email: "a@b.dev", password: "p" })).toEqual({
            email: "a@b.dev",
            password: "p",
        });
        expect(
            validateLoginPayload({ email: "a@b.dev", password: "p", organizationId: "org-1" }),
        ).toEqual({ email: "a@b.dev", password: "p", organizationId: "org-1" });
    });

    it("非对象/缺字段/类型错误/超长 → null（BFF 侧 400）", () => {
        expect(validateLoginPayload(null)).toBeNull();
        expect(validateLoginPayload("str")).toBeNull();
        expect(validateLoginPayload({ email: "a@b.dev" })).toBeNull();
        expect(validateLoginPayload({ password: "p" })).toBeNull();
        expect(validateLoginPayload({ email: "", password: "p" })).toBeNull();
        expect(validateLoginPayload({ email: "a@b.dev", password: "" })).toBeNull();
        expect(
            validateLoginPayload({ email: "a@b.dev", password: "p", organizationId: 42 }),
        ).toBeNull();
        expect(validateLoginPayload({ email: "a".repeat(321), password: "p" })).toBeNull();
        expect(validateLoginPayload({ email: "a@b.dev", password: "p".repeat(257) })).toBeNull();
    });
});
