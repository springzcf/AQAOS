/**
 * 认证基座回归（T-E01-09 验收证据）：
 * - 离线：scrypt 密码哈希（PHC/随机盐/恒定时间比对）与 JWT（claims 往返/
 *   错误密钥/过期/issuer 不符拒绝）；
 * - live-DB（AQAOS_TEST_DATABASE_URL）：登录（错误口径统一防枚举/SSO NULL 拒绝/
 *   多组织消歧）、角色 403、API Token 创建/使用/列表/撤销（立即失效）/过期/
 *   last_used_at 节流更新。走独立 scratch 库（自动迁移+销毁），与迁移测试并行不冲突。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { SignJWT } from "jose";
import { JWT_AUDIENCE, JWT_ISSUER, signSession, verifySession } from "./lib/jwt.js";
import { hashPassword, verifyPassword } from "./lib/passwords.js";
import { buildApp } from "./server.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);
const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_C = "33333333-3333-4333-8333-333333333333";
const USER_ADMIN = "aaaa0000-0000-4000-8000-000000000001";
const USER_VIEWER = "aaaa0000-0000-4000-8000-000000000002";
const USER_SSO = "aaaa0000-0000-4000-8000-000000000003";
const USER_MULTI = "aaaa0000-0000-4000-8000-000000000004";
const PASSWORD = "correct-horse-battery-staple";

interface LoginResponse {
    token: string;
    tokenType: string;
    expiresIn: number;
    user: { id: string; email: string; displayName: string | null };
    organizationId: string | null;
    role: string;
    memberships: Array<{ organizationId: string; role: string }>;
}

interface Envelope {
    error: { code: string; message: string; requestId: string };
}

describe("password hashing (offline)", () => {
    it("hash → verify 往返；错误密码/损坏存储恒 false", async () => {
        const stored = await hashPassword(PASSWORD);
        expect(stored.startsWith("scrypt$")).toBe(true);
        await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
        await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
        await expect(verifyPassword(PASSWORD, "not-a-phc-string")).resolves.toBe(false);
        await expect(verifyPassword(PASSWORD, "scrypt$1$2$3")).resolves.toBe(false);
    });

    it("随机盐：同密码两次哈希不同，但都可验", async () => {
        const a = await hashPassword(PASSWORD);
        const b = await hashPassword(PASSWORD);
        expect(a).not.toBe(b);
        await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
        await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
    });
});

describe("jwt session (offline)", () => {
    it("签发/校验往返：claims 完整保留（org 可空）", async () => {
        const { token, expiresIn } = await signSession(TEST_JWT_SECRET, {
            userId: "u-1",
            email: "t@aqaos.dev",
            organizationId: null,
            role: "viewer",
        });
        expect(expiresIn).toBeGreaterThan(0);
        const claims = await verifySession(TEST_JWT_SECRET, token);
        expect(claims).toEqual({
            userId: "u-1",
            email: "t@aqaos.dev",
            organizationId: null,
            role: "viewer",
        });
    });

    it("错误密钥校验拒绝", async () => {
        const { token } = await signSession("another-secret", {
            userId: "u-1",
            email: "t@aqaos.dev",
            organizationId: ORG_A,
            role: "member",
        });
        await expect(verifySession(TEST_JWT_SECRET, token)).rejects.toThrow();
    });

    it("过期 token 拒绝（exp 过去时点）", async () => {
        const token = await new SignJWT({ email: "t@aqaos.dev", org: null, role: "member" })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject("u-1")
            .setIssuedAt()
            .setIssuer(JWT_ISSUER)
            .setAudience(JWT_AUDIENCE)
            .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
            .sign(new TextEncoder().encode(TEST_JWT_SECRET));
        await expect(verifySession(TEST_JWT_SECRET, token)).rejects.toThrow();
    });

    it("issuer 不符拒绝（跨服务 token 不通用）", async () => {
        const token = await new SignJWT({ email: "t@aqaos.dev", org: null, role: "member" })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject("u-1")
            .setIssuedAt()
            .setIssuer("evil-service")
            .setAudience(JWT_AUDIENCE)
            .setExpirationTime("1h")
            .sign(new TextEncoder().encode(TEST_JWT_SECRET));
        await expect(verifySession(TEST_JWT_SECRET, token)).rejects.toThrow();
    });
});

describe.skipIf(!TEST_DB_URL)("auth flows (live db, T-E01-09)", () => {
    let app: FastifyInstance;
    let db: Client;
    let admin: Client;
    let dbName = "";

    beforeAll(async () => {
        const testUrl = new URL(TEST_DB_URL as string);
        dbName = `${testUrl.pathname.replace(/^\//, "")}_auth`;
        const authDbUrl = new URL(TEST_DB_URL as string);
        authDbUrl.pathname = `/${dbName}`;

        // 管理连接固定走 postgres 系统库（建/删 scratch 库），不依赖测试库存活。
        const adminUrl = new URL(TEST_DB_URL as string);
        adminUrl.pathname = "/postgres";
        admin = new Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);

        db = new Client({ connectionString: authDbUrl.toString() });
        await db.connect();
        // 经真实 migrate CLI 建表（跨项目 import db/runner 会破坏 apps/api build 的
        // rootDir；顺带覆盖 db:migrate 生产入口路径）。
        await execFileAsync("npx", ["tsx", "db/migrate.ts", "up"], {
            cwd: REPO_ROOT,
            env: { ...process.env, DATABASE_URL: authDbUrl.toString() },
        });

        const adminHash = await hashPassword(PASSWORD);
        await db.query(
            `INSERT INTO organizations (id, name, slug) VALUES
             ($1, 'Org A', 'org-a'), ($2, 'Org B', 'org-b'), ($3, 'Org C', 'org-c')`,
            [ORG_A, ORG_B, ORG_C],
        );
        await db.query(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES
             ($1, 'admin@aqaos.dev', 'Admin', $5),
             ($2, 'viewer@aqaos.dev', 'Viewer', $5),
             ($3, 'sso@aqaos.dev', 'SSO User', NULL),
             ($4, 'multi@aqaos.dev', 'Multi Org', $5)`,
            [USER_ADMIN, USER_VIEWER, USER_SSO, USER_MULTI, adminHash],
        );
        await db.query(
            `INSERT INTO memberships (organization_id, user_id, role) VALUES
             ($1, $2, 'owner'),
             ($1, $3, 'viewer'),
             ($1, $4, 'member'),
             ($1, $5, 'member'),
             ($6, $5, 'admin')`,
            [ORG_A, USER_ADMIN, USER_VIEWER, USER_SSO, USER_MULTI, ORG_B],
        );

        app = await buildApp({
            databaseUrl: authDbUrl.toString(),
            jwtSecret: TEST_JWT_SECRET,
            logLevel: "silent",
        });
    }, 120_000);

    afterAll(async () => {
        if (app) {
            await app.close();
        }
        if (db) {
            await db.end().catch(() => undefined);
        }
        if (admin) {
            await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
            await admin.end();
        }
    }, 60_000);

    async function loginExpect(
        email: string,
        password: string,
        organizationId?: string,
    ): Promise<LoginResponse> {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload:
                organizationId === undefined
                    ? { email, password }
                    : { email, password, organizationId },
        });
        expect(response.statusCode).toBe(200);
        return response.json() as LoginResponse;
    }

    it("错误密码/未知邮箱/SSO NULL 统一 401 且口径一致（防用户枚举）", async () => {
        const bodies = await Promise.all([
            app.inject({
                method: "POST",
                url: "/api/v1/auth/login",
                payload: { email: "admin@aqaos.dev", password: "totally-wrong" },
            }),
            app.inject({
                method: "POST",
                url: "/api/v1/auth/login",
                payload: { email: "ghost@aqaos.dev", password: "totally-wrong" },
            }),
            app.inject({
                method: "POST",
                url: "/api/v1/auth/login",
                payload: { email: "sso@aqaos.dev", password: "anything" },
            }),
        ]);
        for (const response of bodies) {
            expect(response.statusCode).toBe(401);
            expect((response.json() as Envelope).error.code).toBe("AUTHENTICATION_REQUIRED");
        }
        const messages = bodies.map((r) => (r.json() as Envelope).error.message);
        expect(new Set(messages).size).toBe(1);
        expect(messages[0]).toBe("Invalid email or password");
    });

    it("登录成功：JWT + 用户画像 + 单组织自动绑定 owner 角色", async () => {
        const session = await loginExpect("admin@aqaos.dev", PASSWORD);
        expect(session.tokenType).toBe("Bearer");
        expect(session.expiresIn).toBe(12 * 60 * 60);
        expect(session.user.id).toBe(USER_ADMIN);
        expect(session.user.email).toBe("admin@aqaos.dev");
        expect(session.organizationId).toBe(ORG_A);
        expect(session.role).toBe("owner");
        expect(session.memberships).toEqual([{ organizationId: ORG_A, role: "owner" }]);
    });

    it("多组织成员：缺 organizationId → 400；非成员组织 → 403；正确组织 → 角色绑定", async () => {
        const ambiguous = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email: "multi@aqaos.dev", password: PASSWORD },
        });
        expect(ambiguous.statusCode).toBe(400);
        expect((ambiguous.json() as Envelope).error.message).toContain("organizationId");

        const foreign = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email: "multi@aqaos.dev", password: PASSWORD, organizationId: ORG_C },
        });
        expect(foreign.statusCode).toBe(403);

        const bound = await loginExpect("multi@aqaos.dev", PASSWORD, ORG_B);
        expect(bound.organizationId).toBe(ORG_B);
        expect(bound.role).toBe("admin");
        expect(bound.memberships).toHaveLength(2);
    });

    it("JWT 访问业务路由：GET /runs 200；/users/me 画像与成员关系（via jwt）", async () => {
        const session = await loginExpect("admin@aqaos.dev", PASSWORD);
        const auth = { authorization: `Bearer ${session.token}` };

        const runs = await app.inject({ method: "GET", url: "/api/v1/runs", headers: auth });
        expect(runs.statusCode).toBe(200);
        expect(runs.json()).toEqual({ items: [], total: 0 });

        const me = await app.inject({ method: "GET", url: "/api/v1/users/me", headers: auth });
        expect(me.statusCode).toBe(200);
        const profile = me.json() as {
            id: string;
            email: string;
            activeOrganizationId: string | null;
            activeRole: string;
            credentialsVia: string;
            memberships: unknown[];
        };
        expect(profile.id).toBe(USER_ADMIN);
        expect(profile.email).toBe("admin@aqaos.dev");
        expect(profile.activeOrganizationId).toBe(ORG_A);
        expect(profile.activeRole).toBe("owner");
        expect(profile.credentialsVia).toBe("jwt");
        expect(profile.memberships).toHaveLength(1);
    });

    it("RBAC 骨架：viewer 访问 /organizations → 403 PERMISSION_DENIED（验收）", async () => {
        const session = await loginExpect("viewer@aqaos.dev", PASSWORD);
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/organizations",
            headers: { authorization: `Bearer ${session.token}` },
        });
        expect(response.statusCode).toBe(403);
        expect((response.json() as Envelope).error.code).toBe("PERMISSION_DENIED");
    });

    it("owner 访问 /organizations → 200 列出所属管理组织", async () => {
        const session = await loginExpect("admin@aqaos.dev", PASSWORD);
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/organizations",
            headers: { authorization: `Bearer ${session.token}` },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { items: Array<{ id: string; yourRole: string }> };
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({ id: ORG_A, yourRole: "owner" });
    });

    it("API Token 全生命周期：创建（明文仅一次）→ 使用 → 列表 → 撤销即失效", async () => {
        const session = await loginExpect("viewer@aqaos.dev", PASSWORD);
        const auth = { authorization: `Bearer ${session.token}` };

        const created = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: auth,
            payload: { name: "ci-runner" },
        });
        expect(created.statusCode).toBe(201);
        const token = created.json() as {
            id: string;
            token: string;
            tokenPrefix: string;
            name: string;
        };
        expect(token.token.startsWith("aqaos_pat_")).toBe(true);
        expect(token.name).toBe("ci-runner");
        expect(token.tokenPrefix.length).toBe(8);

        // 使用 API Token 访问业务路由（数据库即时校验路径）。
        const viaToken = await app.inject({
            method: "GET",
            url: "/api/v1/users/me",
            headers: { authorization: `Bearer ${token.token}` },
        });
        expect(viaToken.statusCode).toBe(200);
        const profile = viaToken.json() as { credentialsVia: string; activeRole: string };
        expect(profile.credentialsVia).toBe("api-token");
        expect(profile.activeRole).toBe("viewer");

        // 列表不回传哈希/明文，仅前缀。
        const list = await app.inject({
            method: "GET",
            url: "/api/v1/auth/tokens",
            headers: auth,
        });
        expect(list.statusCode).toBe(200);
        const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
        const stored = items.find((item) => item.id === token.id);
        expect(stored).toBeDefined();
        expect(stored?.tokenPrefix).toBe(token.tokenPrefix);
        expect(stored?.token).toBeUndefined();
        expect(stored?.tokenHash).toBeUndefined();

        // last_used_at 已节流写入（首次使用必写）。
        const used = await db.query<{ last_used_at: Date | null }>(
            `SELECT last_used_at FROM api_tokens WHERE id = $1`,
            [token.id],
        );
        expect(used.rows[0]?.last_used_at).not.toBeNull();

        // 撤销 → 立即失效（Token 可撤销验收）。
        const revoked = await app.inject({
            method: "DELETE",
            url: `/api/v1/auth/tokens/${token.id}`,
            headers: auth,
        });
        expect(revoked.statusCode).toBe(204);
        const afterRevoke = await app.inject({
            method: "GET",
            url: "/api/v1/runs",
            headers: { authorization: `Bearer ${token.token}` },
        });
        expect(afterRevoke.statusCode).toBe(401);
        expect((afterRevoke.json() as Envelope).error.code).toBe("AUTHENTICATION_REQUIRED");
    });

    it("过期 API Token 拒绝（expires_at 过去）", async () => {
        const session = await loginExpect("viewer@aqaos.dev", PASSWORD);
        const created = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: { authorization: `Bearer ${session.token}` },
            payload: { name: "short-lived" },
        });
        expect(created.statusCode).toBe(201);
        const { id, token } = created.json() as { id: string; token: string };
        await db.query(
            `UPDATE api_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`,
            [id],
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/v1/runs",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
    });

    it("Token 创建参数校验：缺 name → 400；expiresAt 非法/过去 → 400", async () => {
        const session = await loginExpect("admin@aqaos.dev", PASSWORD);
        const auth = { authorization: `Bearer ${session.token}` };

        const noName = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: auth,
            payload: {},
        });
        expect(noName.statusCode).toBe(400);

        const badDate = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: auth,
            payload: { name: "x", expiresAt: "not-a-date" },
        });
        expect(badDate.statusCode).toBe(400);

        const pastDate = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: auth,
            payload: { name: "x", expiresAt: "2020-01-01T00:00:00Z" },
        });
        expect(pastDate.statusCode).toBe(400);
    });

    it("未认证访问 Token 管理与业务路由 → 401", async () => {
        const tokens = await app.inject({ method: "GET", url: "/api/v1/auth/tokens" });
        expect(tokens.statusCode).toBe(401);
        const me = await app.inject({ method: "GET", url: "/api/v1/users/me" });
        expect(me.statusCode).toBe(401);
    });
});
