/**
 * Agent 定义与 Prompt 版本化 REST 回归（T-E02-04 验收证据）：
 * live-DB（AQAOS_TEST_DATABASE_URL）独立 scratch 库 + 真实登录 JWT，
 * 覆盖种子 → 查询 → 追加新版本 → 不可变历史 → 策略拒绝 → 回滚全链路：
 * - 迁移 0007 种子 16 角色基线（prompt 非空 + allowedTools 白名单）；
 * - prompt 变更留版本（v1 原样不动、历史可查）**且可回滚**（新行复制旧
 *   (prompt, prompt_version) 成对内容，append-only 不改不删）；
 * - 策略拒绝：prompt 变更不换标签 400、空转版本 400、回滚到最新 400；
 * - RBAC：member 只读、admin 写（403 由 authPlugin 阶梯给出并审计）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { ROLE_PROMPT_BASELINES } from "@aqaos/domain";
import { buildApp } from "./server.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);
const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

interface DefinitionItem {
    id: string;
    name: string;
    version: string;
    promptVersion: string;
    prompt: string;
    config: { allowedTools?: string[] };
    enabled: boolean;
    createdAt: string;
    createdBy: string | null;
}

describe.skipIf(!TEST_DB_URL)("agent definitions REST (live db, T-E02-04)", () => {
    let app: FastifyInstance;
    let db: Client;
    let admin: Client;
    let dbName = "";

    const ORG = "21111111-1111-4111-8111-111111111111";
    const USER_ADMIN = "baaa0000-0000-4000-8000-000000000011";
    const USER_MEMBER = "baaa0000-0000-4000-8000-000000000012";
    const USER_VIEWER = "baaa0000-0000-4000-8000-000000000013";
    const PASSWORD = "correct-horse-battery-staple";

    beforeAll(async () => {
        const dbUrl = new URL(TEST_DB_URL as string);
        dbName = `${dbUrl.pathname.replace(/^\//, "")}_agentdef`;
        dbUrl.pathname = `/${dbName}`;

        const adminUrl = new URL(TEST_DB_URL as string);
        adminUrl.pathname = "/postgres";
        admin = new Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);

        db = new Client({ connectionString: dbUrl.toString() });
        await db.connect();
        await execFileAsync("npx", ["tsx", "db/migrate.ts", "up"], {
            cwd: REPO_ROOT,
            env: { ...process.env, DATABASE_URL: dbUrl.toString() },
        });

        const hash = (await import("./lib/passwords.js")).hashPassword;
        await db.query(
            `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Org', 'org-agentdef')`,
            [ORG],
        );
        await db.query(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES
             ($1, 'admin@agentdef.dev', 'Admin', $4),
             ($2, 'member@agentdef.dev', 'Member', $4),
             ($3, 'viewer@agentdef.dev', 'Viewer', $4)`,
            [USER_ADMIN, USER_MEMBER, USER_VIEWER, await hash(PASSWORD)],
        );
        await db.query(
            `INSERT INTO memberships (organization_id, user_id, role) VALUES
             ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
            [ORG, USER_ADMIN, USER_MEMBER, USER_VIEWER],
        );

        app = await buildApp({
            databaseUrl: dbUrl.toString(),
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

    async function login(email: string): Promise<string> {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email, password: PASSWORD },
        });
        expect(response.statusCode).toBe(200);
        return (response.json() as { token: string }).token;
    }

    function auth(token: string, key = `idem-${Math.random().toString(36).slice(2)}`) {
        return { authorization: `Bearer ${token}`, "idempotency-key": key };
    }

    async function listLatest(token: string): Promise<DefinitionItem[]> {
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        return (response.json() as { items: DefinitionItem[] }).items;
    }

    it("迁移 0007 种子 16 角色基线：prompt 非空、version=1、白名单与授权一致（member 可读）", async () => {
        const memberToken = await login("member@agentdef.dev");
        const items = await listLatest(memberToken);
        expect(items).toHaveLength(16);

        const reporter = items.find((item) => item.name === "reporter");
        expect(reporter).toBeDefined();
        expect(reporter?.version).toBe("1");
        expect(reporter?.promptVersion).toBe("0.1.0");
        expect(reporter?.prompt).toContain("AQAOS Reporter");
        expect(reporter?.config.allowedTools).toContain("mcp__aqaos__qa_get_run");
        expect(reporter?.enabled).toBe(true);

        const webTester = items.find((item) => item.name === "web-tester");
        expect(webTester?.config.allowedTools ?? []).toEqual([]);

        const qaManager = items.find((item) => item.name === "qa-manager");
        // memory 域实装（T-E02-07 读写 + T-E10-01 检索）后 *.read 命中
        // memory_read_knowledge + memory_search_memories → 6 项。
        expect(qaManager?.config.allowedTools).toHaveLength(6);
    });

    it("迁移 0008 种子 planner v2：latest=结构化计划 prompt，v1 行原样保留（append-only 首战）", async () => {
        const memberToken = await login("member@agentdef.dev");
        const latest = (await listLatest(memberToken)).find((item) => item.name === "planner");
        expect(latest?.version).toBe("2");
        expect(latest?.promptVersion).toBe("0.2.0");
        expect(latest?.prompt).toContain("# Output");
        expect(latest?.prompt).toContain("JSON object");
        expect(latest?.prompt).not.toBe(ROLE_PROMPT_BASELINES.planner);

        const history = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions/planner/versions",
            headers: { authorization: `Bearer ${memberToken}` },
        });
        expect(history.statusCode).toBe(200);
        const versions = (history.json() as { items: DefinitionItem[] }).items;
        expect(versions.map((item) => item.version)).toEqual(["2", "1"]);
        // v1 骨架行原样不可变（版本化纪律）。
        expect(versions[1]?.promptVersion).toBe("0.1.0");
        expect(versions[1]?.prompt).toBe(ROLE_PROMPT_BASELINES.planner);
    });

    it("迁移 0009 种子 product-analyst v2：latest=ProductModel 置信标注 prompt（T-E02-07）", async () => {
        const memberToken = await login("member@agentdef.dev");
        const latest = (await listLatest(memberToken)).find(
            (item) => item.name === "product-analyst",
        );
        expect(latest?.version).toBe("2");
        expect(latest?.promptVersion).toBe("0.2.0");
        expect(latest?.prompt).toContain("Product Model");
        expect(latest?.prompt).toContain("confirmed");
        expect(latest?.prompt).toContain("openQuestions");
        expect(latest?.prompt).not.toBe(ROLE_PROMPT_BASELINES["product-analyst"]);
        // v2 种子的 allowedTools 随注册表扩容携带 memory 双工具。
        expect(latest?.config.allowedTools).toContain("mcp__aqaos__memory_read_knowledge");
        expect(latest?.config.allowedTools).toContain("mcp__aqaos__memory_write_knowledge");

        const history = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions/product-analyst/versions",
            headers: { authorization: `Bearer ${memberToken}` },
        });
        expect(history.statusCode).toBe(200);
        const versions = (history.json() as { items: DefinitionItem[] }).items;
        expect(versions.map((item) => item.version)).toEqual(["2", "1"]);
        expect(versions[1]?.prompt).toBe(ROLE_PROMPT_BASELINES["product-analyst"]);
    });

    it("viewer 无权读管理面：403 PERMISSION_DENIED（RBAC 阶梯）", async () => {
        const viewerToken = await login("viewer@agentdef.dev");
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions",
            headers: { authorization: `Bearer ${viewerToken}` },
        });
        expect(response.statusCode).toBe(403);
        expect((response.json() as { error: { code: string } }).error.code).toBe(
            "PERMISSION_DENIED",
        );
    });

    it("迁移 0010 种子 test-architect v2：latest=TestStrategy 结构化 prompt（T-E02-09）", async () => {
        const memberToken = await login("member@agentdef.dev");
        const latest = (await listLatest(memberToken)).find(
            (item) => item.name === "test-architect",
        );
        expect(latest?.version).toBe("2");
        expect(latest?.promptVersion).toBe("0.2.0");
        expect(latest?.prompt).toContain("test strategy");
        expect(latest?.prompt).toContain("selections");
        expect(latest?.prompt).toContain("coverageTargets");
        expect(latest?.prompt).not.toBe(ROLE_PROMPT_BASELINES["test-architect"]);
        // memory 域实装（T-E02-07）后 test-architect 的 memory.read 授权
        // 命中 memory_read_knowledge。
        expect(latest?.config.allowedTools ?? []).toContain("mcp__aqaos__memory_read_knowledge");

        const history = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions/test-architect/versions",
            headers: { authorization: `Bearer ${memberToken}` },
        });
        expect(history.statusCode).toBe(200);
        const versions = (history.json() as { items: DefinitionItem[] }).items;
        expect(versions.map((item) => item.version)).toEqual(["2", "1"]);
        expect(versions[1]?.prompt).toBe(ROLE_PROMPT_BASELINES["test-architect"]);
    });

    it("prompt 变更新版本：v2 落库成为最新，v1 行原样不可变（验收：变更留版本）", async () => {
        const adminToken = await login("admin@agentdef.dev");
        const before = (await listLatest(adminToken)).find((item) => item.name === "reporter");
        expect(before?.version).toBe("1");

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: {
                name: "reporter",
                prompt: "You are the AQAOS Reporter (reporter), v2 skeleton with tighter evidence rules.",
                promptVersion: "0.2.0",
                config: { allowedTools: ["mcp__aqaos__qa_get_run", "mcp__aqaos__qa_list_bugs"] },
            },
        });
        expect(response.statusCode).toBe(201);
        const created = (response.json() as { definition: DefinitionItem }).definition;
        expect(created.version).toBe("2");
        expect(created.promptVersion).toBe("0.2.0");
        expect(created.createdBy).toBe(USER_ADMIN);
        expect(created.createdAt).toBeTruthy();

        // 最新版视图切到 v2。
        const after = (await listLatest(adminToken)).find((item) => item.name === "reporter");
        expect(after?.version).toBe("2");
        expect(after?.prompt).toContain("v2 skeleton");

        // v1 行逐字段原样（append-only：不改不删）。
        const history = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions/reporter/versions",
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(history.statusCode).toBe(200);
        const versions = (history.json() as { items: DefinitionItem[]; total: number }).items;
        expect(versions).toHaveLength(2);
        expect(versions[0]?.version).toBe("2"); // 展示序：新→旧
        const v1 = versions[1];
        expect(v1?.prompt).toBe(before?.prompt);
        expect(v1?.promptVersion).toBe("0.1.0");
        expect(v1?.config).toEqual(before?.config);
    });

    it("member 只读：POST 403（审计 denied 由中间件留痕）", async () => {
        const memberToken = await login("member@agentdef.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(memberToken),
            payload: { name: "planner", prompt: "x".repeat(64), promptVersion: "0.2.0" },
        });
        expect(response.statusCode).toBe(403);
        expect((response.json() as { error: { code: string } }).error.code).toBe(
            "PERMISSION_DENIED",
        );
    });

    it("策略拒绝：prompt 变更不换 prompt_version 标签 → 400", async () => {
        const adminToken = await login("admin@agentdef.dev");
        // planner 最新版 = 迁移 0008 种子的 v2@0.2.0：复用其标签 + 不同内容。
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: { name: "planner", prompt: "changed prompt body", promptVersion: "0.2.0" },
        });
        expect(response.statusCode).toBe(400);
        const error = (
            response.json() as { error: { code: string; details?: { policy?: string } } }
        ).error;
        expect(error.code).toBe("VALIDATION_FAILED");
        expect(error.details?.policy).toBe("PROMPT_VERSION_REUSED");
    });

    it("策略拒绝：与最新版内容全等（空转版本）→ 400；非法角色/格式 → 400", async () => {
        const adminToken = await login("admin@agentdef.dev");
        const noop = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: { name: "planner", prompt: "no-op".repeat(20), promptVersion: "0.3.0" },
        });
        // 修改 prompt 使内容变化 → 合法；再原样重发一次 → 空转拒绝。
        expect(noop.statusCode).toBe(201);
        const again = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: { name: "planner", prompt: "no-op".repeat(20), promptVersion: "0.4.0" },
        });
        expect(again.statusCode).toBe(400);
        expect(
            (again.json() as { error: { details?: { policy?: string } } }).error.details?.policy,
        ).toBe("NO_CHANGE");

        const badRole = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: { name: "not-a-role", prompt: "x".repeat(64), promptVersion: "0.2.0" },
        });
        expect(badRole.statusCode).toBe(400);

        const badVersion = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions",
            headers: auth(adminToken),
            payload: { name: "planner", prompt: "y".repeat(64), promptVersion: "v2" },
        });
        expect(badVersion.statusCode).toBe(400);
    });

    it("回滚：复制 v1 (prompt, prompt_version) 成新行 v3，历史不动（验收：可回滚）", async () => {
        const adminToken = await login("admin@agentdef.dev");
        // reporter 现状：v1(0.1.0) + v2(0.2.0)。回滚到 v1。
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions/reporter/rollback",
            headers: auth(adminToken),
            payload: { toVersion: "1" },
        });
        expect(response.statusCode).toBe(201);
        const rolled = (response.json() as { definition: DefinitionItem }).definition;
        expect(rolled.version).toBe("3");
        expect(rolled.promptVersion).toBe("0.1.0");
        expect(rolled.prompt).toContain("AQAOS Reporter");
        expect(rolled.enabled).toBe(true);

        // 最新版视图 = 回滚后的 v3（prompt 回到基线）。
        const latest = (await listLatest(adminToken)).find((item) => item.name === "reporter");
        expect(latest?.version).toBe("3");
        expect(latest?.promptVersion).toBe("0.1.0");

        // 历史全量 3 行，v1/v2 原样。
        const history = await app.inject({
            method: "GET",
            url: "/api/v1/agent-definitions/reporter/versions",
            headers: { authorization: `Bearer ${adminToken}` },
        });
        const versions = (history.json() as { items: DefinitionItem[]; total: number }).items;
        expect(versions).toHaveLength(3);
        expect(versions.map((item) => item.version)).toEqual(["3", "2", "1"]);
        expect(versions[2]?.promptVersion).toBe("0.1.0");
        expect(versions[1]?.promptVersion).toBe("0.2.0");
    });

    it("回滚目标不存在 → 404；回滚到最新版（空转）→ 400；未知角色 → 400", async () => {
        const adminToken = await login("admin@agentdef.dev");
        const missing = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions/reporter/rollback",
            headers: auth(adminToken),
            payload: { toVersion: "99" },
        });
        expect(missing.statusCode).toBe(404);

        const toLatest = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions/reporter/rollback",
            headers: auth(adminToken),
            payload: { toVersion: "3" },
        });
        expect(toLatest.statusCode).toBe(400);

        const unknown = await app.inject({
            method: "POST",
            url: "/api/v1/agent-definitions/whoever/rollback",
            headers: auth(adminToken),
            payload: { toVersion: "1" },
        });
        expect(unknown.statusCode).toBe(400);
    });

    it("审计留痕：版本创建/回滚落 create 行，denied 落 denied 行（中间件自动）", async () => {
        // 回滚路由模板去参后为 agent-definitions/rollback（字面段保留）。
        const audits = await db.query<{ action: string; resource_type: string }>(
            `SELECT action, resource_type FROM audit_logs
              WHERE resource_type LIKE 'agent-definitions%' ORDER BY created_at ASC, id ASC`,
        );
        const actions = audits.rows.map((row) => row.action);
        // 1 次 member 403 → denied；≥ 3 次 201 创建（reporter v2/v3 + planner v3；0008/0009 种子不产生审计行）。
        expect(actions.filter((action) => action === "create").length).toBeGreaterThanOrEqual(3);
        expect(actions).toContain("denied");
    });
});
