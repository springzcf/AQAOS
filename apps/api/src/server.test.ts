/**
 * Control Plane API 骨架回归（T-E01-08 验收证据，T-E01-09 后业务路由需认证）：
 * /health、/api/v1 版本化、DDD §8.1/§16 错误契约、requestId 透传、
 * OpenAPI 文档自动生成、Idempotency-Key 完整语义（重放/冲突/5xx 不缓存/TTL）、
 * 认证骨架（未认证 401 / 无效凭据 401，JWT 离线可验）。
 * 全部经 fastify.inject 进程内驱动，无端口依赖。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Client } from "pg";
import { signSession } from "./lib/jwt.js";
import { ERROR_HTTP_STATUS, type ErrorCode } from "./lib/errors.js";
import { buildApp } from "./server.js";

const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const validRunBody = {
    applicationId: "app-001",
    environmentId: "env-staging",
    objective: "测试登录、订单和支付流程，发现功能和权限缺陷",
    platforms: ["web", "api"],
    modes: ["exploration", "functional", "security", "regression"],
    budget: { maxAgents: 12, maxDurationSeconds: 3600, maxModelCostUsd: 10, maxTokens: 300000 },
    safety: { allowDestructiveActions: false, requireApprovalForPayment: true },
};

interface Envelope {
    error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

describe("control plane api (T-E01-08)", () => {
    let app: FastifyInstance;
    /** 离线 JWT：认证骨架不依赖数据库（claims 签发时固化）。 */
    let authHeader: Record<string, string>;

    beforeAll(async () => {
        app = await buildApp({
            logLevel: "silent",
            databaseUrl: undefined,
            jwtSecret: TEST_JWT_SECRET,
        });
        const session = await signSession(TEST_JWT_SECRET, {
            userId: "00000000-0000-4000-8000-000000000001",
            email: "offline-test@aqaos.dev",
            organizationId: "11111111-1111-4111-8111-111111111111",
            role: "member",
        });
        authHeader = { authorization: `Bearer ${session.token}` };
    });

    afterAll(async () => {
        await app.close();
    });

    it("GET /health 返回存活信息并回写 x-request-id", async () => {
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: "ok", service: "@aqaos/api" });
        expect(response.headers["x-request-id"]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });

    it("GET /health/ready 未配置数据库时报告 skipped（CI 无 DB 也稳定）", async () => {
        const response = await app.inject({ method: "GET", url: "/health/ready" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok", checks: { database: "skipped" } });
    });

    it("GET /api/v1 返回版本化服务索引", async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1" });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
            name: string;
            version: string;
            links: Record<string, string>;
        };
        expect(body.name).toBe("@aqaos/api");
        expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(body.links.runs).toBe("/api/v1/runs");
    });

    it("GET /api/v1/runs 未认证 → 401 AUTHENTICATION_REQUIRED（T-E01-09 验收）", async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1/runs" });
        expect(response.statusCode).toBe(ERROR_HTTP_STATUS.AUTHENTICATION_REQUIRED);
        const body = response.json() as Envelope;
        expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
        expect(body.error.message).toContain("Authentication required");
    });

    it("GET /api/v1/runs 无效 Bearer → 401（签名错误凭据同口径）", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/runs",
            headers: { authorization: "Bearer not-a-real-jwt" },
        });
        expect(response.statusCode).toBe(401);
        expect((response.json() as Envelope).error.message).toContain("Invalid or expired");
    });

    it("GET /api/v1/runs 认证后返回空集合（Run Registry 前的诚实占位）", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/runs",
            headers: authHeader,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ items: [], total: 0 });
    });

    it("未知路由 → 404 NOT_FOUND，错误体与 DDD §8.1 一致", async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
        expect(response.statusCode).toBe(404);
        const body = response.json() as Envelope;
        expect(body.error.code).toBe("NOT_FOUND");
        expect(body.error.message).toContain("/api/v1/nope");
        expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    });

    it("入站 x-request-id 合法则透传到响应头与错误体", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/missing",
            headers: { "x-request-id": "trace-abc-123" },
        });
        expect(response.headers["x-request-id"]).toBe("trace-abc-123");
        expect((response.json() as Envelope).error.requestId).toBe("trace-abc-123");
    });

    it("非法 x-request-id 被忽略并生成 UUID（防日志注入）", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/health",
            headers: { "x-request-id": "bad id\nwith control chars" },
        });
        expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("POST /api/v1/runs 认证但缺 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/runs",
            headers: authHeader,
            payload: validRunBody,
        });
        expect(response.statusCode).toBe(ERROR_HTTP_STATUS.IDEMPOTENCY_KEY_REQUIRED);
        expect((response.json() as Envelope).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("Idempotency-Key 超长 → 400 VALIDATION_FAILED", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/runs",
            headers: { ...authHeader, "idempotency-key": "k".repeat(256) },
            payload: validRunBody,
        });
        expect(response.statusCode).toBe(400);
        expect((response.json() as Envelope).error.message).toContain("255");
    });

    it("body 违反 DDD §8.1 schema → 400 VALIDATION_FAILED 且 details 含校验明细", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/runs",
            headers: { ...authHeader, "idempotency-key": "key-invalid-body" },
            payload: { applicationId: "app-001" },
        });
        expect(response.statusCode).toBe(400);
        const body = response.json() as Envelope;
        expect(body.error.code).toBe("VALIDATION_FAILED");
        expect(body.error.message).toContain("objective");
        expect(Array.isArray(body.error.details)).toBe(true);
    });

    it("POST /api/v1/runs 契约合法 → 501 NOT_IMPLEMENTED（Run Registry 前的固定形状）", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/runs",
            headers: { ...authHeader, "idempotency-key": "key-first" },
            payload: validRunBody,
        });
        expect(response.statusCode).toBe(501);
        const body = response.json() as Envelope;
        expect(body.error.code).toBe("NOT_IMPLEMENTED");
        expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    });

    it("5xx 不进入幂等缓存：同键同载荷重试仍是真实执行", async () => {
        for (const round of [1, 2]) {
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/runs",
                headers: { ...authHeader, "idempotency-key": "retry-5xx" },
                payload: validRunBody,
            });
            expect(response.statusCode).toBe(501);
            expect(response.headers["x-idempotent-replay"]).toBeUndefined();
            expect(round).toBe(round);
        }
    });

    it("OpenAPI 文档自动生成：/openapi.json 含 /api/v1/runs", async () => {
        const response = await app.inject({ method: "GET", url: "/openapi.json" });
        expect(response.statusCode).toBe(200);
        const spec = response.json() as {
            openapi: string;
            info: { title: string; version: string };
            paths: Record<string, Record<string, unknown>>;
        };
        expect(spec.openapi).toMatch(/^3\./);
        expect(spec.info.title).toBe("AQAOS Control Plane API");
        expect(spec.paths["/api/v1/runs"]?.post).toBeDefined();
        expect(spec.paths["/api/v1/runs"]?.get).toBeDefined();
    });

    it("Swagger UI 挂载在 /docs", async () => {
        const response = await app.inject({ method: "GET", url: "/docs" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/html");
    });

    it("根路径返回服务指针文本", async () => {
        const response = await app.inject({ method: "GET", url: "/" });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("AQAOS control plane");
    });
});

describe("idempotency semantics (T-E01-08, via test-scope echo route)", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        app = await buildApp({ logLevel: "silent", idempotencyTtlMs: 40 });
        // 测试专用路由：真实可变端点，用于验证幂等机制（重放/冲突/5xx/TTL/方法过滤）。
        app.post("/api/v1/__echo", async (request) => {
            const body = request.body as { fail?: boolean } | undefined;
            if (body?.fail) {
                throw new Error("boom (intentional)");
            }
            return { ok: true, echo: body ?? null, requestId: request.id };
        });
        app.get("/api/v1/__echo", { schema: { hide: true } }, async () => ({
            ok: true,
            method: "GET",
        }));
    });

    afterAll(async () => {
        await app.close();
    });

    it("同键同载荷 → 逐字节重放缓存响应（x-idempotent-replay: true）", async () => {
        const first = await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-1" },
            payload: { n: 1 },
        });
        expect(first.statusCode).toBe(200);
        expect(first.headers["x-idempotent-replay"]).toBeUndefined();

        const replay = await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-1" },
            payload: { n: 1 },
        });
        expect(replay.statusCode).toBe(200);
        expect(replay.headers["x-idempotent-replay"]).toBe("true");
        // 重放返回原始响应体（含当时的 requestId），但响应头是新请求的 requestId。
        expect(replay.body).toBe(first.body);
        expect(replay.headers["x-request-id"]).not.toBe(
            (JSON.parse(first.body) as { requestId: string }).requestId,
        );
    });

    it("同键不同载荷 → 409 IDEMPOTENCY_KEY_REUSED", async () => {
        await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-2" },
            payload: { n: 1 },
        });
        const conflict = await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-2" },
            payload: { n: 2 },
        });
        expect(conflict.statusCode).toBe(ERROR_HTTP_STATUS.IDEMPOTENCY_KEY_REUSED);
        expect((conflict.json() as Envelope).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("5xx 响应不缓存：同键同载荷仍真实执行", async () => {
        for (const _ of [1, 2]) {
            const response = await app.inject({
                method: "POST",
                url: "/api/v1/__echo",
                headers: { "idempotency-key": "echo-fail" },
                payload: { fail: true },
            });
            expect(response.statusCode).toBe(500);
            expect((response.json() as Envelope).error.code).toBe("INTERNAL_ERROR");
            expect(response.headers["x-idempotent-replay"]).toBeUndefined();
        }
    });

    it("TTL 过期后同键请求重新执行（无重放头）", async () => {
        await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-ttl" },
            payload: { n: 9 },
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/__echo",
            headers: { "idempotency-key": "echo-ttl" },
            payload: { n: 9 },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["x-idempotent-replay"]).toBeUndefined();
    });

    it("GET 请求不参与幂等（即使携带 Idempotency-Key）", async () => {
        for (const _ of [1, 2]) {
            const response = await app.inject({
                method: "GET",
                url: "/api/v1/__echo",
                headers: { "idempotency-key": "echo-get" },
            });
            expect(response.statusCode).toBe(200);
            expect(response.headers["x-idempotent-replay"]).toBeUndefined();
        }
    });
});

describe.skipIf(!TEST_DB_URL)("control plane readiness (live db)", () => {
    // 就绪探针只需 SELECT 1——用独立 scratch 库避免与迁移测试并行重建 aqaos_test 竞争。
    let app: FastifyInstance | undefined;
    let admin: Client | undefined;
    let dbName = "";

    beforeAll(async () => {
        const readyUrl = new URL(TEST_DB_URL as string);
        dbName = `${readyUrl.pathname.replace(/^\//, "")}_ready`;
        const adminUrl = new URL(TEST_DB_URL as string);
        adminUrl.pathname = "/postgres";
        admin = new (await import("pg")).Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);
        readyUrl.pathname = `/${dbName}`;
        app = await buildApp({ logLevel: "silent", databaseUrl: readyUrl.toString() });
    }, 60_000);

    afterAll(async () => {
        if (app) {
            await app.close();
        }
        if (admin) {
            await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
            await admin.end();
        }
    }, 60_000);

    it("GET /health/ready 配置数据库连接串时执行 SELECT 1", async () => {
        const response = await app!.inject({ method: "GET", url: "/health/ready" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok", checks: { database: "ok" } });
    });
});
