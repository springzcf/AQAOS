/**
 * 0003 测试资产与缺陷（T-E01-07，DDL 对照 docs/03 §7.2）。
 * external_issue_links 依赖 bugs（本迁移）与 external_integrations（0001），故置于本迁移末尾。
 * test_results.status / bug_verifications.status 的合法值未收录于 DDD §7.3，由 T-E02-01
 * Domain Contracts（zod）在应用层约束，暂不加 DB CHECK（避免偏离枚举字典单一事实源）。
 */

import { enumChecksForTable } from "../enum-dictionary.js";
import type { Migration } from "../runner.js";

export default {
    name: "0003_testing",
    description:
        "data_sets/test_suites/test_cases/test_case_versions/test_results/bugs/bug_verifications/evidence/coverage_records/external_issue_links",
    up: [
        `CREATE TABLE data_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  records JSONB NOT NULL DEFAULT '[]',
  masking_rules JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE data_sets IS '测试数据集与脱敏规则（PII 红线 L-3）';`,

        `CREATE TABLE test_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  member_case_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE test_suites IS '用例套件（smoke/regression/compatibility…，kind 值域由应用层定义）';`,

        `CREATE TABLE test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  platform TEXT NOT NULL,
  steps JSONB NOT NULL,
  assertions JSONB NOT NULL DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  script_ref TEXT,
  script_fingerprint TEXT,
  data_set_id UUID REFERENCES data_sets(id) ON DELETE SET NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL DEFAULT 'ai',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE test_cases IS '结构化用例（DDD §13）；AI 生成默认 draft，审核后才进执行计划（T-E08-01）';`,
        ...enumChecksForTable("test_cases"),
        `CREATE INDEX idx_test_cases_application ON test_cases(application_id, updated_at DESC);`,
        `CREATE INDEX idx_test_cases_status ON test_cases(status, review_status);`,

        `CREATE TABLE test_case_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  diff JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(test_case_id, version)
);
COMMENT ON TABLE test_case_versions IS '用例版本快照与 diff（T-E08-02）';`,

        `CREATE TABLE test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error JSONB,
  metrics JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE test_results IS '用例执行结果';`,
        `CREATE INDEX idx_test_results_test_run ON test_results(test_run_id);`,
        `CREATE INDEX idx_test_results_test_case ON test_results(test_case_id);`,

        `CREATE TABLE bugs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  test_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT,
  confidence NUMERIC(4,3),
  reproduction_steps JSONB DEFAULT '[]',
  root_cause JSONB DEFAULT '{}',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE bugs IS 'Bug 候选（T-E07-01 指纹去重；Run 删除置空 test_run_id 保留缺陷史）';`,
        ...enumChecksForTable("bugs"),
        `CREATE INDEX idx_bugs_fingerprint ON bugs(application_id, fingerprint);`,
        `CREATE INDEX idx_bugs_application ON bugs(application_id, created_at DESC);`,

        `CREATE TABLE bug_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id UUID NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successful_reproductions INTEGER NOT NULL DEFAULT 0,
  confidence NUMERIC(4,3),
  evidence_ids JSONB DEFAULT '[]',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE bug_verifications IS '独立复现验证（T-E07-02；status 值域 verified/rejected/inconclusive 由应用层约束）';`,
        `CREATE INDEX idx_bug_verifications_bug ON bug_verifications(bug_id);`,

        `CREATE TABLE evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  bug_id UUID REFERENCES bugs(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE evidence IS '证据对象注册表（大文件在 MinIO，本表存 storage_key+sha256，T-E05-03）';`,
        `CREATE INDEX idx_evidence_test_run ON evidence(test_run_id);`,
        `CREATE INDEX idx_evidence_agent_run ON evidence(agent_run_id);`,
        `CREATE INDEX idx_evidence_bug ON evidence(bug_id);`,

        `CREATE TABLE coverage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  target_key TEXT NOT NULL,
  covered BOOLEAN NOT NULL DEFAULT FALSE,
  detail JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(test_run_id, dimension, target_key)
);
COMMENT ON TABLE coverage_records IS '覆盖矩阵（dimension：页面/接口/角色/风险…由应用层定义）';`,
        `CREATE INDEX idx_coverage_records_run ON coverage_records(test_run_id);`,

        `CREATE TABLE external_issue_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id UUID NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES external_integrations(id) ON DELETE CASCADE,
  external_key TEXT NOT NULL,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(bug_id, integration_id, external_key)
);
COMMENT ON TABLE external_issue_links IS '缺陷-工单双向链接（T-E02-13 之后的工单集成域）';`,
        ...enumChecksForTable("external_issue_links"),
    ],
    down: [
        `DROP TABLE IF EXISTS external_issue_links CASCADE;`,
        `DROP TABLE IF EXISTS coverage_records CASCADE;`,
        `DROP TABLE IF EXISTS evidence CASCADE;`,
        `DROP TABLE IF EXISTS bug_verifications CASCADE;`,
        `DROP TABLE IF EXISTS bugs CASCADE;`,
        `DROP TABLE IF EXISTS test_results CASCADE;`,
        `DROP TABLE IF EXISTS test_case_versions CASCADE;`,
        `DROP TABLE IF EXISTS test_cases CASCADE;`,
        `DROP TABLE IF EXISTS test_suites CASCADE;`,
        `DROP TABLE IF EXISTS data_sets CASCADE;`,
    ],
} satisfies Migration;
