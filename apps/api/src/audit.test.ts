/**
 * 审计留痕回归（T-E01-11 验收证据）：
 * - 离线：deriveAuditEvent 纯函数（方法映射/2xx 与 403 留痕/其他跳过/资源与
 *   UUID 参数推导/模板清洗）；
 * - live-DB（AQAOS_TEST_DATABASE_URL）：真实 Token 生命周期产生的留痕
 *   （create/delete/denied）+ 查询接口分页/过滤/RBAC 403。走独立 scratch 库。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { deriveAuditEvent } from "./lib/audit.js";
import { buildApp } from "./server.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);
const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe("audit event derivation (offline)", () => {
    it("变更类方法 2xx → create/update/delete；GET 不留痕", () => {
        expect(deriveAuditEvent("POST", "/api/v1/auth/tokens", undefined, 201)).toEqual({
            action: "create",
            resourceType: "auth/tokens",
            resourceId: null,
        });
        expect(deriveAuditEvent("PATCH", "/api/v1/runs/:id", { id: "x" }, 200)?.action).toBe(
            "update",
        );
        expect(deriveAuditEvent("DELETE", "/api/v1/auth/tokens/:id", undefined, 204)).toEqual({
            action: "delete",
            resourceType: "auth/tokens",
            resourceId: null,
        });
        expect(deriveAuditEvent("GET", "/api/v1/runs", undefined, 200)).toBeNull();
    });

    it("403 → denied 留痕；其他非 2xx 不留痕", () => {
        const denied = deriveAuditEvent("POST", "/api/v1/organizations", undefined, 403);
        expect(denied).toEqual({
            action: "denied",
            resourceType: "organizations",
            resourceId: null,
        });
        expect(deriveAuditEvent("POST", "/api/v1/runs", undefined, 400)).toBeNull();
        expect(deriveAuditEvent("POST", "/api/v1/runs", undefined, 401)).toBeNull();
        expect(deriveAuditEvent("POST", "/api/v1/runs", undefined, 500)).toBeNull();
    });

    it("UUID 路径参数进 resourceId；非 UUID 参数忽略；:id 段从 resourceType 剔除", () => {
        const id = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
        expect(deriveAuditEvent("DELETE", "/api/v1/auth/tokens/:id", { id }, 204)?.resourceId).toBe(
            id,
        );
        expect(
            deriveAuditEvent("DELETE", "/api/v1/auth/tokens/:id", { id: "junk" }, 204)?.resourceId,
        ).toBeNull();
        expect(
            deriveAuditEvent("POST", "/api/v1/applications/:id/environments", { id: "junk" }, 201)
                ?.resourceType,
        ).toBe("applications/environments");
    });

    it("非 /api/v1 路由与根路径不留痕（探针/文档不属于变更类 API）", () => {
        expect(deriveAuditEvent("POST", "/health", undefined, 200)).toBeNull();
        expect(deriveAuditEvent("POST", "/openapi.json", undefined, 200)).toBeNull();
        expect(deriveAuditEvent("POST", "/", undefined, 200)).toBeNull();
        expect(deriveAuditEvent("POST", "/api/v1/", undefined, 200)).toBeNull();
    });
});

describe.skipIf(!TEST_DB_URL)("audit flows (live db, T-E01-11)", () => {
    let app: FastifyInstance;
    let db: Client;
    let admin: Client;
    let dbName = "";

    const ORG_A = "11111111-1111-4111-8111-111111111111";
    const USER_ADMIN = "aaaa0000-0000-4000-8000-000000000001";
    const USER_VIEWER = "aaaa0000-0000-4000-8000-000000000002";
    const PASSWORD = "correct-horse-battery-staple";

    beforeAll(async () => {
        const authDbUrl = new URL(TEST_DB_URL as string);
        dbName = `${authDbUrl.pathname.replace(/^\//, "")}_audit`;
        authDbUrl.pathname = `/${dbName}`;

        const adminUrl = new URL(TEST_DB_URL as string);
        adminUrl.pathname = "/postgres";
        admin = new Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);

        db = new Client({ connectionString: authDbUrl.toString() });
        await db.connect();
        await execFileAsync("npx", ["tsx", "db/migrate.ts", "up"], {
            cwd: REPO_ROOT,
            env: { ...process.env, DATABASE_URL: authDbUrl.toString() },
        });

        const hash = (await import("./lib/passwords.js")).hashPassword;
        await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Org A', 'org-a')`, [
            ORG_A,
        ]);
        await db.query(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES
             ($1, 'admin@aqaos.dev', 'Admin', $3),
             ($2, 'viewer@aqaos.dev', 'Viewer', $3)`,
            [USER_ADMIN, USER_VIEWER, await hash(PASSWORD)],
        );
        await db.query(
            `INSERT INTO memberships (organization_id, user_id, role) VALUES
             ($1, $2, 'owner'), ($1, $3, 'viewer')`,
            [ORG_A, USER_ADMIN, USER_VIEWER],
        );

        app = await buildApp({
            databaseUrl: authDbUrl.toString(),
            jwtSecret: TEST_JWT_SECRET,
            logLevel: "silent",
        });

        // 探针路由（test-only）：T-E02 落地真实 admin 级变更路由之前，现有生产面
        // 尚无 mutation-403 场景（token 删除对他人返回 404 防枚举）。用它走完整的
        // 真实链路：auth preHandler 拒绝 → onSend 留痕 denied，而非 mock。
        app.post(
            "/api/v1/audit-probe",
            { config: { auth: { requireAuth: true, minRole: "admin" } } },
            async () => ({ ok: true }),
        );
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

    /** 审计写入是异步旁路：轮询直至条件满足（2s 上限）。 */
    async function waitForAudit(
        predicate: (count: number) => boolean,
        timeoutMs = 2_000,
    ): Promise<number> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const result = await db.query<{ count: string }>(
                `SELECT count(*) AS count FROM audit_logs`,
            );
            const count = Number(result.rows[0]?.count ?? 0);
            if (predicate(count) || Date.now() > deadline) {
                return count;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    async function login(email: string): Promise<string> {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email, password: PASSWORD },
        });
        expect(response.statusCode).toBe(200);
        return (response.json() as { token: string }).token;
    }

    it("变更类请求自动留痕：Token 创建/撤销均入 audit_logs（验收）", async () => {
        const adminToken = await login("admin@aqaos.dev");
        const auth = { authorization: `Bearer ${adminToken}` };

        const created = await app.inject({
            method: "POST",
            url: "/api/v1/auth/tokens",
            headers: auth,
            payload: { name: "audit-probe" },
        });
        expect(created.statusCode).toBe(201);
        const { id } = created.json() as { id: string };

        const revoked = await app.inject({
            method: "DELETE",
            url: `/api/v1/auth/tokens/${id}`,
            headers: auth,
        });
        expect(revoked.statusCode).toBe(204);

        const total = await waitForAudit((count) => count >= 2);
        expect(total).toBeGreaterThanOrEqual(2);

        const rows = await db.query<{
            actor_id: string;
            action: string;
            resource_type: string;
            resource_id: string | null;
            metadata: { requestId?: string; statusCode?: number; route?: string };
        }>(`SELECT actor_id, action, resource_type, resource_id, metadata
               FROM audit_logs ORDER BY created_at`);
        const create = rows.rows[0];
        const del = rows.rows[1];
        expect(create).toMatchObject({
            actor_id: USER_ADMIN,
            action: "create",
            resource_type: "auth/tokens",
            resource_id: null,
        });
        expect(create?.metadata.statusCode).toBe(201);
        expect(typeof create?.metadata.requestId).toBe("string");
        expect(del).toMatchObject({
            actor_id: USER_ADMIN,
            action: "delete",
            resource_type: "auth/tokens",
            resource_id: id,
        });
        expect(del?.metadata.statusCode).toBe(204);
    });

    it("RBAC 拒绝（403）也留痕：denied 事件", async () => {
        const viewerToken = await login("viewer@aqaos.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/audit-probe",
            headers: { authorization: `Bearer ${viewerToken}` },
            payload: { name: "nope" },
        });
        expect(response.statusCode).toBe(403);
        await waitForAudit((count) => count >= 3);
        const denied = await db.query(
            `SELECT actor_id, action, resource_type FROM audit_logs WHERE action = 'denied'`,
        );
        expect(denied.rows).toHaveLength(1);
        expect(denied.rows[0]).toMatchObject({
            actor_id: USER_VIEWER,
            action: "denied",
            resource_type: "audit-probe",
        });
    });

    it("查询接口：admin 分页/过滤/actor 邮箱回填；viewer → 403", async () => {
        const adminToken = await login("admin@aqaos.dev");
        const auth = { authorization: `Bearer ${adminToken}` };

        const all = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs",
            headers: auth,
        });
        expect(all.statusCode).toBe(200);
        const body = all.json() as {
            items: Array<{ action: string; actorEmail: string | null }>;
            total: number;
        };
        expect(body.total).toBe(3);
        // DESC：最新是 denied（viewer），随后是 delete/create（admin）——两类 actor 的
        // 邮箱都经 LEFT JOIN 回填。
        expect(body.items[0]?.actorEmail).toBe("viewer@aqaos.dev");
        expect(body.items[0]?.action).toBe("denied");
        expect(body.items[2]?.actorEmail).toBe("admin@aqaos.dev");

        const filtered = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs?action=denied",
            headers: auth,
        });
        expect(filtered.statusCode).toBe(200);
        expect((filtered.json() as { total: number }).total).toBe(1);

        const byType = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs?resourceType=auth/tokens",
            headers: auth,
        });
        expect((byType.json() as { total: number }).total).toBe(2);

        const paged = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs?limit=1&offset=1",
            headers: auth,
        });
        const pagedBody = paged.json() as { items: unknown[]; total: number };
        expect(pagedBody.items).toHaveLength(1);
        expect(pagedBody.total).toBe(body.total);

        const badLimit = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs?limit=0",
            headers: auth,
        });
        expect(badLimit.statusCode).toBe(400);

        const viewerToken = await login("viewer@aqaos.dev");
        const forbidden = await app.inject({
            method: "GET",
            url: "/api/v1/audit-logs",
            headers: { authorization: `Bearer ${viewerToken}` },
        });
        expect(forbidden.statusCode).toBe(403);
    });

    it("读操作不留痕：GET /runs 与 GET /audit-logs 不产生新事件", async () => {
        const adminToken = await login("admin@aqaos.dev");
        const auth = { authorization: `Bearer ${adminToken}` };
        await app.inject({ method: "GET", url: "/api/v1/runs", headers: auth });
        await app.inject({ method: "GET", url: "/api/v1/audit-logs", headers: auth });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = await db.query<{ count: string }>(
            `SELECT count(*) AS count FROM audit_logs WHERE action <> 'denied'
              AND resource_type NOT IN ('auth/tokens')`,
        );
        expect(Number(result.rows[0]?.count ?? 0)).toBe(0);
    });
});
