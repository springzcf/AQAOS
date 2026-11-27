/**
 * 0005 RLS 租户隔离骨架（T-E01-07）。
 *
 * 契约：会话在执行租户数据查询前 `SET aqaos.organization_id = '<uuid>'`；
 * 未设置时 current_setting(..., true) 返回 NULL → 全部行不可见、写入被拒（fail-closed）。
 *
 * 骨架范围（18 张含租户键的表）。子表（agent_runs/tool_calls/test_results/evidence/
 * workflow_events/approval_requests/environment_provisionings/model_invocations/
 * bug_verifications/test_case_versions/external_issue_links/webhook_subscriptions）与
 * 全局表（users/agent_definitions/model_configs）暂不启用，统一在 M2 租户加固（T-E11-05）
 * 补齐；FORCE ROW LEVEL SECURITY 届时随应用层设置 GUC 一并开启。
 */

import type { Migration } from "../runner.js";

/** RLS 目标表：table + 租户列（organizations 的租户键即 id）。 */
const RLS_TABLES: ReadonlyArray<{ readonly table: string; readonly orgColumn: string }> = [
    { table: "organizations", orgColumn: "id" },
    { table: "memberships", orgColumn: "organization_id" },
    { table: "projects", orgColumn: "organization_id" },
    { table: "applications", orgColumn: "organization_id" },
    { table: "environments", orgColumn: "organization_id" },
    { table: "credentials", orgColumn: "organization_id" },
    { table: "external_integrations", orgColumn: "organization_id" },
    { table: "test_runs", orgColumn: "organization_id" },
    { table: "run_schedules", orgColumn: "organization_id" },
    { table: "audit_logs", orgColumn: "organization_id" },
    { table: "data_sets", orgColumn: "organization_id" },
    { table: "test_suites", orgColumn: "organization_id" },
    { table: "test_cases", orgColumn: "organization_id" },
    { table: "bugs", orgColumn: "organization_id" },
    { table: "coverage_records", orgColumn: "organization_id" },
    { table: "knowledge_nodes", orgColumn: "organization_id" },
    { table: "knowledge_edges", orgColumn: "organization_id" },
    { table: "memories", orgColumn: "organization_id" },
];

function enableSql(entry: { table: string; orgColumn: string }): string {
    const predicate = `${entry.orgColumn} = current_setting('aqaos.organization_id', true)::uuid`;
    return `ALTER TABLE ${entry.table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${entry.table}
  USING (${predicate})
  WITH CHECK (${predicate});`;
}

function disableSql(entry: { table: string }): string {
    return `DROP POLICY IF EXISTS tenant_isolation ON ${entry.table};
ALTER TABLE ${entry.table} DISABLE ROW LEVEL SECURITY;`;
}

export default {
    name: "0005_rls_skeleton",
    description: "18 张租户表启用 RLS + tenant_isolation 策略（GUC：aqaos.organization_id）",
    up: RLS_TABLES.map(enableSql),
    down: RLS_TABLES.map(disableSql),
} satisfies Migration;
