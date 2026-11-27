/**
 * 迁移全生命周期回归（T-E01-07 验收证据）：
 * 空库一键建表（33 表）→ RLS 骨架（18 表）→ 枚举 CHECK 拒绝非法值 →
 * 非属主角色受 RLS 约束 → down 清空 → 再 up 可重放。
 *
 * 需要 PostgreSQL（pgvector 镜像）：AQAOS_TEST_DATABASE_URL 指向 scratch 库
 * （自动创建/销毁），CI migrate job 与 `npm run test:db` 提供；未设置时跳过。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { loadMigrations, runDown, runUp, type Migration } from "../../db/runner.js";

const TEST_DB_URL = process.env.AQAOS_TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL("../../db/migrations", import.meta.url)));
const RLS_PROBE_ROLE = "aqaos_rls_probe";

/** DDD §7.1 的 33 张核心表（与文档一对一，migration 漂移即失败）。 */
const EXPECTED_TABLES = [
    "agent_definitions",
    "agent_runs",
    "applications",
    "approval_requests",
    "audit_logs",
    "bug_verifications",
    "bugs",
    "coverage_records",
    "credentials",
    "data_sets",
    "environment_provisionings",
    "environments",
    "evidence",
    "external_integrations",
    "external_issue_links",
    "knowledge_edges",
    "knowledge_nodes",
    "memberships",
    "memories",
    "model_configs",
    "model_invocations",
    "organizations",
    "projects",
    "run_schedules",
    "test_case_versions",
    "test_cases",
    "test_results",
    "test_runs",
    "test_suites",
    "tool_calls",
    "users",
    "webhook_subscriptions",
    "workflow_events",
];

/** 0005 RLS 骨架目标表（18 张）。 */
const EXPECTED_RLS_TABLES = [
    "applications",
    "audit_logs",
    "bugs",
    "coverage_records",
    "credentials",
    "data_sets",
    "environments",
    "external_integrations",
    "knowledge_edges",
    "knowledge_nodes",
    "memberships",
    "memories",
    "organizations",
    "projects",
    "run_schedules",
    "test_cases",
    "test_runs",
    "test_suites",
];

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const APP_A = "55555555-5555-4555-8555-555555555555";

async function listTables(client: Client): Promise<string[]> {
    const result = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'schema_migrations'
    `);
    // JS 排序（UTF-16 码元序）避免数据库 collation 差异导致顺序断言抖动。
    return result.rows.map((row) => row.table_name).sort();
}

describe.skipIf(!TEST_DB_URL)("db migrations (T-E01-07)", () => {
    let db: Client;
    let admin: Client;
    let migrations: Migration[];
    // 模块级求值会在 skip 时也执行（URL(undefined) 抛错），故在钩子内解析。
    let dbName = "";

    beforeAll(async () => {
        dbName = new URL(TEST_DB_URL as string).pathname.replace(/^\//, "");
        const adminUrl = new URL(TEST_DB_URL as string);
        adminUrl.pathname = "/postgres";
        admin = new Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${RLS_PROBE_ROLE}`);
        await admin.query(`CREATE DATABASE "${dbName}"`);

        db = new Client({ connectionString: TEST_DB_URL });
        await db.connect();
        migrations = await loadMigrations(MIGRATIONS_DIR);
        await runUp(db, migrations);
    }, 120_000);

    afterAll(async () => {
        // beforeAll 中途失败时钩子对象可能不完整，逐个防御性清理。
        if (db) {
            await db.end().catch(() => undefined);
        }
        if (admin) {
            await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
            await admin.query(`DROP ROLE IF EXISTS ${RLS_PROBE_ROLE}`);
            await admin.end();
        }
    }, 60_000);

    it("空库一键建表：33 张核心表与 DDD §7.1 一致", async () => {
        expect(await listTables(db)).toEqual(EXPECTED_TABLES);
    });

    it("RLS 骨架：18 张租户表启用行级安全并挂 tenant_isolation 策略", async () => {
        const rls = await db.query<{ tablename: string }>(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND rowsecurity = TRUE
        `);
        expect(rls.rows.map((row) => row.tablename).sort()).toEqual(EXPECTED_RLS_TABLES);

        const policies = await db.query<{ count: string }>(`
            SELECT count(*) AS count FROM pg_policies
            WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
        `);
        expect(Number(policies.rows[0]?.count)).toBe(EXPECTED_RLS_TABLES.length);
    });

    it("枚举 CHECK：字典外取值被数据库拒绝，字典内取值可写入", async () => {
        await db.query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'Org A', 'org-a')", [
            ORG_A,
        ]);
        await db.query(
            "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Project A')",
            [PROJECT_A, ORG_A],
        );
        await db.query(
            "INSERT INTO applications (id, organization_id, project_id, name, platform) VALUES ($1, $2, $3, 'App A', 'web')",
            [APP_A, ORG_A, PROJECT_A],
        );

        await expect(
            db.query(
                "INSERT INTO test_runs (organization_id, project_id, application_id, objective, status) VALUES ($1, $2, $3, 'o', 'flying')",
                [ORG_A, PROJECT_A, APP_A],
            ),
        ).rejects.toThrow(/check/i);
        await expect(
            db.query(
                "INSERT INTO bugs (organization_id, application_id, title, severity, status) VALUES ($1, $2, 't', 'catastrophic', 'candidate')",
                [ORG_A, APP_A],
            ),
        ).rejects.toThrow(/check/i);
        await expect(
            db.query(
                "INSERT INTO test_cases (organization_id, application_id, title, platform, steps, status) VALUES ($1, $2, 't', 'ios', '[]', 'draft')",
                [ORG_A, APP_A],
            ),
        ).rejects.toThrow(/check/i);

        const valid = await db.query(
            "INSERT INTO test_runs (organization_id, project_id, application_id, objective, status) VALUES ($1, $2, $3, 'objective', 'queued') RETURNING id",
            [ORG_A, PROJECT_A, APP_A],
        );
        expect(valid.rowCount).toBe(1);
    });

    it("RLS 生效：非属主角色只能看到/写入会话租户的数据", async () => {
        // 作为属主（超级用户，RLS 不生效）准备第二个租户的数据。
        await db.query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'Org B', 'org-b')", [
            ORG_B,
        ]);
        await db.query(
            "INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, 'Project B')",
            [PROJECT_B, ORG_B],
        );
        await db.query(`CREATE ROLE ${RLS_PROBE_ROLE}`);
        await db.query(`GRANT USAGE ON SCHEMA public TO ${RLS_PROBE_ROLE}`);
        await db.query(`GRANT SELECT, INSERT ON projects TO ${RLS_PROBE_ROLE}`);

        await db.query(`SET ROLE ${RLS_PROBE_ROLE}`);
        try {
            // 未设置租户上下文 → fail-closed，两租户均不可见。
            const noContext = await db.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM projects",
            );
            expect(noContext.rows[0]?.n).toBe(0);

            // 设置 Org A 上下文 → 只见 Org A。
            // 注：SET 语法不接受绑定参数，用 set_config 等价设置会话级 GUC。
            await db.query("SELECT set_config('aqaos.organization_id', $1, false)", [ORG_A]);
            const scoped = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM projects");
            expect(scoped.rows[0]?.n).toBe(1);

            // 写入本租户允许，写入他租户被策略拒绝。
            const ownInsert = await db.query(
                "INSERT INTO projects (organization_id, name) VALUES ($1, 'allowed') RETURNING id",
                [ORG_A],
            );
            expect(ownInsert.rowCount).toBe(1);
            await expect(
                db.query("INSERT INTO projects (organization_id, name) VALUES ($1, 'x')", [ORG_B]),
            ).rejects.toThrow(/row-level security/i);
        } finally {
            await db.query("RESET ROLE");
            await db.query("SELECT set_config('aqaos.organization_id', '', false)");
        }
    });

    it("回滚与重放：down 清空业务表，up 可再次一键建表", async () => {
        const reverted = await runDown(db, migrations, Number.POSITIVE_INFINITY);
        expect(reverted).toHaveLength(migrations.length);
        expect(await listTables(db)).toEqual([]);

        const reapplied = await runUp(db, migrations);
        expect(reapplied).toHaveLength(migrations.length);
        expect(await listTables(db)).toEqual(EXPECTED_TABLES);
    }, 120_000);
});
