/**
 * MCP Tool REST 消费回归（T-E02-03 验收证据）：
 * live-DB（AQAOS_TEST_DATABASE_URL）走独立 scratch 库 + 真实登录 JWT，
 * 经 POST /api/v1/mcp/tools/:toolName 全链路（鉴权 → 上下文构造 →
 * dispatch 调度链 → pg services → audit_logs 留痕）：
 * - member 只读工具放行（qa.get_run / env.list_environments）；
 * - viewer 零工具：403 TOOL_PERMISSION_DENIED **且审计落一条 denied**（验收）；
 * - 未知工具 404；非法入参 400；跨组织 Run 不可见（404 防枚举）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { HashEmbedder } from "@aqaos/domain";
import { buildApp } from "./server.js";
import { insertMemory } from "./lib/mcp-services.js";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);
const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe.skipIf(!TEST_DB_URL)("mcp tool REST consumption (live db, T-E02-03)", () => {
    let app: FastifyInstance;
    let db: Client;
    let admin: Client;
    let dbName = "";
    let pool: Pool | undefined;

    const ORG_A = "21111111-1111-4111-8111-111111111111";
    const ORG_B = "22222222-2222-4222-8222-222222222222";
    const PROJECT = "31111111-1111-4111-8111-111111111111";
    const APPLICATION = "41111111-1111-4111-8111-111111111111";
    const ENVIRONMENT = "51111111-1111-4111-8111-111111111111";
    const RUN_A = "61111111-1111-4111-8111-111111111111";
    const RUN_B = "62222222-2222-4222-8222-222222222222";
    const USER_OWNER = "baaa0000-0000-4000-8000-000000000001";
    const USER_MEMBER = "baaa0000-0000-4000-8000-000000000002";
    const USER_VIEWER = "baaa0000-0000-4000-8000-000000000003";
    const PASSWORD = "correct-horse-battery-staple";

    beforeAll(async () => {
        const dbUrl = new URL(TEST_DB_URL as string);
        dbName = `${dbUrl.pathname.replace(/^\//, "")}_mcp`;
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
            `INSERT INTO organizations (id, name, slug) VALUES
             ($1, 'Org A', 'org-a-mcp'), ($2, 'Org B', 'org-b-mcp')`,
            [ORG_A, ORG_B],
        );
        await db.query(
            `INSERT INTO users (id, email, display_name, password_hash) VALUES
             ($1, 'owner@mcp.dev', 'Owner', $4),
             ($2, 'member@mcp.dev', 'Member', $4),
             ($3, 'viewer@mcp.dev', 'Viewer', $4)`,
            [USER_OWNER, USER_MEMBER, USER_VIEWER, await hash(PASSWORD)],
        );
        await db.query(
            `INSERT INTO memberships (organization_id, user_id, role) VALUES
             ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
            [ORG_A, USER_OWNER, USER_MEMBER, USER_VIEWER],
        );
        await db.query(`INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Proj')`, [
            PROJECT,
            ORG_A,
        ]);
        await db.query(
            `INSERT INTO applications (id, organization_id, project_id, name, platform)
             VALUES ($1, $2, $3, 'Billing', 'web')`,
            [APPLICATION, ORG_A, PROJECT],
        );
        await db.query(
            `INSERT INTO environments (id, organization_id, application_id, name, environment_type, base_url)
             VALUES ($1, $2, $3, 'staging', 'testing', 'https://staging.example.com')`,
            [ENVIRONMENT, ORG_A, APPLICATION],
        );
        await db.query(
            `INSERT INTO test_runs (id, organization_id, project_id, application_id,
                 environment_id, objective, status, budget, coverage, temporal_workflow_id)
             VALUES ($1, $2, $3, $4, $5, '回归登录主链路', 'running',
                 '{"maxTokens": 1000000, "maxModelCostUsd": 5, "maxDurationSeconds": 600}',
                 '{"line": 0.42}', 'wf_mcp_1')`,
            [RUN_A, ORG_A, PROJECT, APPLICATION, ENVIRONMENT],
        );
        // Org B 的 Run：跨组织不可见（防枚举由 404 表达）。
        await db.query(
            `INSERT INTO test_runs (id, organization_id, project_id, application_id,
                 objective, status, budget, coverage, temporal_workflow_id)
             VALUES ($1, $2, $3, $4, 'Org B own run', 'completed', '{}', '{}', 'wf_mcp_2')`,
            [RUN_B, ORG_B, PROJECT, APPLICATION],
        );

        app = await buildApp({
            databaseUrl: dbUrl.toString(),
            jwtSecret: TEST_JWT_SECRET,
            logLevel: "silent",
        });
        // insertMemory 直测用 Pool（服务签名按 DbPool）。
        pool = new Pool({ connectionString: dbUrl.toString(), max: 2 });
    }, 120_000);

    afterAll(async () => {
        if (app) {
            await app.close();
        }
        if (pool) {
            await pool.end().catch(() => undefined);
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

    function auth(token: string) {
        return { authorization: `Bearer ${token}` };
    }

    it("member 只读工具放行：qa.get_run 返回 Run 投影（验收）", async () => {
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.get_run",
            headers: auth(memberToken),
            payload: { input: { runId: RUN_A } },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
            result: { status: string; tool: string; data: { run: Record<string, unknown> } };
        };
        expect(body.result.status).toBe("succeeded");
        expect(body.result.tool).toBe("qa.get_run");
        expect(body.result.data.run.id).toBe(RUN_A);
        expect(body.result.data.run.objective).toBe("回归登录主链路");
    });

    it("viewer 零工具：403 TOOL_PERMISSION_DENIED 且审计落一条 denied（验收）", async () => {
        const viewerToken = await login("viewer@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.get_run",
            headers: auth(viewerToken),
            payload: { input: { runId: RUN_A } },
        });
        expect(response.statusCode).toBe(403);
        const body = response.json() as { error: { code: string } };
        expect(body.error.code).toBe("TOOL_PERMISSION_DENIED");

        // 审计断言：调度链（非 HTTP 中间件）写入，同请求内已落库。
        const audits = await db.query<{
            action: string;
            resource_type: string;
            metadata: Record<string, unknown>;
        }>(
            `SELECT action, resource_type, metadata FROM audit_logs
              WHERE resource_type = 'mcp-tool' AND metadata->>'role' = 'viewer'`,
        );
        expect(audits.rows).toHaveLength(1);
        expect(audits.rows[0]?.action).toBe("denied");
        expect(audits.rows[0]?.metadata).toMatchObject({
            tool: "qa.get_run",
            source: "rest",
            status: "denied",
            errorCode: "TOOL_PERMISSION_DENIED",
        });
    });

    it("组织隔离：Org A member 查 Org B 的 Run → 404（不泄漏存在性）", async () => {
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.get_run",
            headers: auth(memberToken),
            payload: { input: { runId: RUN_B } },
        });
        expect(response.statusCode).toBe(404);
        expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    });

    it("未知工具 404；非法 runId 400 VALIDATION_FAILED", async () => {
        const memberToken = await login("member@mcp.dev");
        const unknown = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/browser.navigate",
            headers: auth(memberToken),
            payload: { input: {} },
        });
        expect(unknown.statusCode).toBe(404);
        expect((unknown.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

        const badInput = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.get_run",
            headers: auth(memberToken),
            payload: { input: { runId: "not-a-uuid" } },
        });
        expect(badInput.statusCode).toBe(400);
        expect((badInput.json() as { error: { code: string } }).error.code).toBe(
            "VALIDATION_FAILED",
        );
    });

    it("env.list_environments：member 可列环境并按 application 过滤", async () => {
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/env.list_environments",
            headers: auth(memberToken),
            payload: { input: { applicationId: APPLICATION } },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
            result: { status: string; data: { items: Record<string, unknown>[] } };
        };
        expect(body.result.status).toBe("succeeded");
        expect(body.result.data.items).toHaveLength(1);
        expect(body.result.data.items[0]).toMatchObject({
            id: ENVIRONMENT,
            name: "staging",
            environmentType: "testing",
        });
    });

    it("成功调用同样留痕：action=execute、metadata 含工具名与角色", async () => {
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.get_coverage",
            headers: auth(memberToken),
            payload: { input: { runId: RUN_A } },
        });
        expect(response.statusCode).toBe(200);

        const audits = await db.query<{ action: string; metadata: Record<string, unknown> }>(
            `SELECT action, metadata FROM audit_logs
              WHERE resource_type = 'mcp-tool' AND metadata->>'tool' = 'qa.get_coverage'
                AND metadata->>'role' = 'member'`,
        );
        expect(audits.rows).toHaveLength(1);
        expect(audits.rows[0]?.action).toBe("execute");
        expect(audits.rows[0]?.metadata).toMatchObject({
            status: "succeeded",
            source: "rest",
        });
    });

    it("owner 全权：admin/owner 阶梯可调用全部注册工具", async () => {
        const ownerToken = await login("owner@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/qa.list_bugs",
            headers: auth(ownerToken),
            payload: { input: {} },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { result: { status: string; data: { items: unknown[] } } };
        expect(body.result.status).toBe("succeeded");
        expect(body.result.data.items).toEqual([]);
    });

    it("memory.write_knowledge：owner 写图谱落库（验收：产出写入 knowledge_nodes）", async () => {
        const ownerToken = await login("owner@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.write_knowledge",
            headers: auth(ownerToken),
            payload: {
                input: {
                    applicationId: APPLICATION,
                    nodes: [
                        {
                            nodeType: "business-entity",
                            externalKey: "business-entity:order",
                            properties: { name: "Order", confidence: "confirmed" },
                        },
                        {
                            nodeType: "user-role",
                            externalKey: "user-role:shopper",
                            properties: { name: "Shopper", confidence: "confirmed" },
                        },
                        {
                            nodeType: "journey",
                            externalKey: "journey:checkout",
                            properties: {
                                name: "Checkout",
                                actor: "shopper",
                                confidence: "inferred",
                                inferredFrom: "landing page copy",
                            },
                        },
                    ],
                    edges: [
                        {
                            sourceKey: "journey:checkout",
                            targetKey: "user-role:shopper",
                            relation: "performed-by",
                            properties: { confidence: "inferred" },
                        },
                    ],
                },
            },
        });
        expect(response.statusCode).toBe(200);
        const written = response.json() as {
            result: { status: string; data: { writtenNodes: number; writtenEdges: number } };
        };
        expect(written.result.status).toBe("succeeded");
        expect(written.result.data).toEqual({ writtenNodes: 3, writtenEdges: 1 });

        // 直查 DB：节点带置信标注（properties.confidence 表注释约定）。
        const nodes = await db.query<{
            node_type: string;
            external_key: string;
            properties: Record<string, unknown>;
        }>(
            `SELECT node_type, external_key, properties FROM knowledge_nodes
              WHERE application_id = $1 ORDER BY external_key`,
            [APPLICATION],
        );
        expect(nodes.rows).toHaveLength(3);
        expect(nodes.rows.map((row) => row.external_key)).toEqual([
            "business-entity:order",
            "journey:checkout",
            "user-role:shopper",
        ]);
        expect(nodes.rows[0]?.properties.confidence).toBe("confirmed");
        const edges = await db.query<{ relation: string }>(
            `SELECT ke.relation FROM knowledge_edges ke
               JOIN knowledge_nodes s ON s.id = ke.source_id
              WHERE s.application_id = $1`,
            [APPLICATION],
        );
        expect(edges.rows).toHaveLength(1);
        expect(edges.rows[0]?.relation).toBe("performed-by");
    });

    it("memory.write_knowledge 幂等：重写同图谱节点 upsert、边去重", async () => {
        const ownerToken = await login("owner@mcp.dev");
        const payload = {
            input: {
                applicationId: APPLICATION,
                nodes: [
                    {
                        nodeType: "business-entity",
                        externalKey: "business-entity:order",
                        properties: { name: "Order", confidence: "confirmed" },
                    },
                    {
                        nodeType: "user-role",
                        externalKey: "user-role:shopper",
                        properties: { name: "Shopper", confidence: "confirmed" },
                    },
                    {
                        nodeType: "journey",
                        externalKey: "journey:checkout",
                        properties: { name: "Checkout", actor: "shopper", confidence: "confirmed" },
                    },
                ],
                edges: [
                    {
                        sourceKey: "journey:checkout",
                        targetKey: "user-role:shopper",
                        relation: "performed-by",
                        properties: { confidence: "confirmed" },
                    },
                ],
            },
        };
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.write_knowledge",
            headers: auth(ownerToken),
            payload,
        });
        expect(response.statusCode).toBe(200);
        const written = response.json() as {
            result: { data: { writtenNodes: number; writtenEdges: number } };
        };
        // 节点全部 upsert 接受；既有边幂等跳过。
        expect(written.result.data).toEqual({ writtenNodes: 3, writtenEdges: 0 });
        // 节点数不变（不产生重复行）+ 置信被 upsert 更新为 confirmed。
        const nodes = await db.query<{
            external_key: string;
            properties: Record<string, unknown>;
        }>(`SELECT external_key, properties FROM knowledge_nodes WHERE application_id = $1`, [
            APPLICATION,
        ]);
        expect(nodes.rows).toHaveLength(3);
        const checkout = nodes.rows.find((row) => row.external_key === "journey:checkout");
        expect(checkout?.properties.confidence).toBe("confirmed");
    });

    it("member 写知识图谱 → 403；member 可读（memory.read 在全域只读阶梯内）", async () => {
        const memberToken = await login("member@mcp.dev");
        const denied = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.write_knowledge",
            headers: auth(memberToken),
            payload: {
                input: {
                    applicationId: APPLICATION,
                    nodes: [
                        {
                            nodeType: "business-entity",
                            externalKey: "business-entity:cart",
                            properties: { confidence: "confirmed" },
                        },
                    ],
                },
            },
        });
        expect(denied.statusCode).toBe(403);
        expect((denied.json() as { error: { code: string } }).error.code).toBe(
            "TOOL_PERMISSION_DENIED",
        );

        const read = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.read_knowledge",
            headers: auth(memberToken),
            payload: { input: { applicationId: APPLICATION, nodeTypes: ["journey"] } },
        });
        expect(read.statusCode).toBe(200);
        const body = read.json() as {
            result: {
                status: string;
                data: {
                    nodes: {
                        nodeType: string;
                        externalKey: string;
                        properties: Record<string, unknown>;
                    }[];
                    edges: unknown[];
                };
            };
        };
        expect(body.result.status).toBe("succeeded");
        expect(body.result.data.nodes).toHaveLength(1);
        expect(body.result.data.nodes[0]?.nodeType).toBe("journey");
        expect(body.result.data.nodes[0]?.properties.confidence).toBeDefined();
        // nodeTypes 收窄跟随"以命中节点为源"：journey 的 performed-by 边一并返回。
        expect(body.result.data.edges).toHaveLength(1);
        expect(body.result.data.edges[0]).toMatchObject({ relation: "performed-by" });
    });

    it("悬空边 → 400 UNKNOWN_NODE_KEY 收敛为 VALIDATION_FAILED", async () => {
        const ownerToken = await login("owner@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.write_knowledge",
            headers: auth(ownerToken),
            payload: {
                input: {
                    applicationId: APPLICATION,
                    nodes: [
                        {
                            nodeType: "journey",
                            externalKey: "journey:ghost-walk",
                            properties: { confidence: "unknown" },
                        },
                    ],
                    edges: [
                        {
                            sourceKey: "journey:ghost-walk",
                            targetKey: "business-entity:nowhere",
                            relation: "covers",
                            properties: {},
                        },
                    ],
                },
            },
        });
        expect(response.statusCode).toBe(400);
        expect((response.json() as { error: { code: string } }).error.code).toBe(
            "VALIDATION_FAILED",
        );
        // 失败批次不留半截数据（节点亦未落库——事务回滚语义由失败前置校验保证）。
        const nodes = await db.query(
            `SELECT 1 FROM knowledge_nodes WHERE external_key = 'journey:ghost-walk'`,
        );
        expect(nodes.rowCount).toBe(0);
    });

    it("memory.search_memories：member 检索命中相似记忆（验收：记忆查询强制租户过滤）", async () => {
        // 种子记忆：Org A 两条（test/bug）+ Org B 一条同文（跨组织隔离面）。
        const embedder = new HashEmbedder();
        const seed = async (organizationId: string, kind: string, content: string) => {
            const vector = embedder.embedOne(content);
            await db.query(
                `INSERT INTO memories (organization_id, project_id, application_id, kind, content, embedding, confidence, version)
                 VALUES ($1, $2, $3, $4, $5, $6::vector, 0.8, 1)`,
                [organizationId, PROJECT, APPLICATION, kind, content, JSON.stringify(vector)],
            );
        };
        await seed(ORG_A, "test", "checkout journey smoke case");
        await seed(ORG_A, "bug", "payment timeout on order detail");
        await seed(ORG_B, "test", "checkout journey smoke case");

        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.search_memories",
            headers: auth(memberToken),
            payload: { input: { query: "checkout journey smoke", limit: 10 } },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
            result: {
                status: string;
                data: {
                    items: {
                        kind: string;
                        content: string;
                        score: number;
                        applicationId: string;
                    }[];
                };
            };
        };
        expect(body.result.status).toBe("succeeded");
        const items = body.result.data.items;
        // 命中 Org A 的 test 记忆且排在最前（语义最近邻）。3 公共 token
        // vs 4 token：cosine = 3/√12 ≈ 0.866（与域层 cosineSimilarity
        // 纯函数同值——pgvector 距离与应用层语义对齐的实证）。
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items[0]?.content).toBe("checkout journey smoke case");
        expect(items[0]?.kind).toBe("test");
        expect(items[0]?.score).toBeGreaterThan(0.8);
        expect(items[0]?.applicationId).toBe(APPLICATION);
        // Org B 的同文记忆不可见（组织过滤在 SQL 强制）。
        expect(items.filter((item) => item.content === "checkout journey smoke case")).toHaveLength(
            1,
        );
    });

    it("memory.search_memories：kind 收窄 + 无嵌入记忆不参与检索", async () => {
        // 未嵌入记忆（embedding NULL——HNSW 索引自动跳过）。
        await db.query(
            `INSERT INTO memories (organization_id, project_id, application_id, kind, content, version)
             VALUES ($1, $2, $3, 'product', 'unembedded product note', 1)`,
            [ORG_A, PROJECT, APPLICATION],
        );
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.search_memories",
            headers: auth(memberToken),
            payload: {
                input: { query: "payment timeout", kind: "bug", limit: 10 },
            },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
            result: { status: string; data: { items: { kind: string }[] } };
        };
        expect(body.result.status).toBe("succeeded");
        expect(body.result.data.items.length).toBeGreaterThanOrEqual(1);
        expect(body.result.data.items.every((item) => item.kind === "bug")).toBe(true);
    });

    it("memory.search_memories：viewer 403（REST 阶梯零工具）", async () => {
        const viewerToken = await login("viewer@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.search_memories",
            headers: auth(viewerToken),
            payload: { input: { query: "anything" } },
        });
        expect(response.statusCode).toBe(403);
        expect((response.json() as { error: { code: string } }).error.code).toBe(
            "TOOL_PERMISSION_DENIED",
        );
    });

    it("insertMemory（平台确定性写 API）：嵌入落库 + 过期过滤 + 检索侧排除", async () => {
        expect(pool).toBeDefined();
        if (pool === undefined) {
            return;
        }
        const embedder = new HashEmbedder();
        // 已过期记忆：检索侧过滤（不物理删除）。
        const expiredId = await insertMemory(
            pool,
            {
                organizationId: ORG_A,
                projectId: PROJECT,
                applicationId: APPLICATION,
                kind: "test",
                content: "expired checkout journey note",
                version: 1,
                expiresAt: "2026-01-01T00:00:00.000Z",
            },
            embedder,
        );
        const liveId = await insertMemory(
            pool,
            {
                organizationId: ORG_A,
                projectId: PROJECT,
                applicationId: APPLICATION,
                kind: "test",
                content: "fresh regression checkout note",
                confidence: 0.9,
                sourceRunId: RUN_A,
                version: 2,
            },
            embedder,
        );
        for (const id of [expiredId, liveId]) {
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
        // 嵌入确实落库（1536 维非空向量）。
        const stored = await db.query<{ embedding: string | null }>(
            `SELECT embedding::text AS embedding FROM memories WHERE id = $1`,
            [liveId],
        );
        expect(stored.rows[0]?.embedding).toMatch(/^\\?\[/);
        // 过期记忆不进检索结果。
        const memberToken = await login("member@mcp.dev");
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/mcp/tools/memory.search_memories",
            headers: auth(memberToken),
            payload: { input: { query: "expired checkout journey note", limit: 10 } },
        });
        expect(response.statusCode).toBe(200);
        const items = (response.json() as { result: { data: { items: { content: string }[] } } })
            .result.data.items;
        expect(items.some((item) => item.content === "expired checkout journey note")).toBe(false);
    });
});
