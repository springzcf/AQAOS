/**
 * 0002 Run / Agent / 调用与计量（T-E01-07，DDL 对照 docs/03 §7.2）。
 * test_runs 状态机合法值见 DDD §5.5 / §7.3（runStatus CHECK）。
 */

import { enumChecksForTable } from "../enum-dictionary.js";
import type { Migration } from "../runner.js";

export default {
    name: "0002_runs",
    description:
        "test_runs/agent_runs/tool_calls/workflow_events/approval_requests/model_invocations/environment_provisionings/run_schedules/audit_logs/webhook_subscriptions",
    up: [
        `CREATE TABLE test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  budget JSONB NOT NULL DEFAULT '{}',
  coverage JSONB NOT NULL DEFAULT '{}',
  summary JSONB NOT NULL DEFAULT '{}',
  temporal_workflow_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
COMMENT ON TABLE test_runs IS '一次自主 QA 运行（DDD §2.3）；状态机见 DDD §5.5';`,
        ...enumChecksForTable("test_runs"),
        `CREATE INDEX idx_test_runs_application ON test_runs(application_id, created_at DESC);`,
        `CREATE INDEX idx_test_runs_status ON test_runs(status);`,
        `CREATE INDEX idx_test_runs_project ON test_runs(project_id, created_at DESC);`,

        `CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  agent_definition_id UUID REFERENCES agent_definitions(id) ON DELETE SET NULL,
  parent_agent_run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model_used TEXT,
  prompt_version TEXT,
  input JSONB DEFAULT '{}',
  output JSONB DEFAULT '{}',
  token_usage JSONB DEFAULT '{}',
  cost_usd NUMERIC(12,6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE agent_runs IS '单次 Agent 会话执行记录（DDD §2.4）';`,
        `CREATE INDEX idx_agent_runs_test_run ON agent_runs(test_run_id);`,
        `CREATE INDEX idx_agent_runs_status ON agent_runs(status);`,

        `CREATE TABLE tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB DEFAULT '{}',
  output JSONB DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE tool_calls IS 'MCP 工具调用审计（T-E02-03 调用链中间件落库）';`,
        `CREATE INDEX idx_tool_calls_agent_run ON tool_calls(agent_run_id);`,

        `CREATE TABLE workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE workflow_events IS '编排事件流（SSE 源，T-E11-04 PostgreSQL Outbox 骨架）';`,
        `CREATE INDEX idx_workflow_events_test_run ON workflow_events(test_run_id, created_at DESC);`,

        `CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_name TEXT,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  approver_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  timeout_seconds INTEGER NOT NULL DEFAULT 3600,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE approval_requests IS '高危操作审批（DDD §5.4）';`,
        ...enumChecksForTable("approval_requests"),
        `CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);`,
        `CREATE INDEX idx_approval_requests_status ON approval_requests(status);`,

        `CREATE TABLE model_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  gateway_request_id TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  task_type TEXT,
  data_sensitivity TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC(12,6) DEFAULT 0,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE model_invocations IS '模型网关调用计量（T-E04-01；agent_run_id 为空表示网关级流量）';`,
        ...enumChecksForTable("model_invocations"),
        `CREATE INDEX idx_model_invocations_run ON model_invocations(agent_run_id);`,

        `CREATE TABLE environment_provisionings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  test_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
  stack_name TEXT NOT NULL,
  status TEXT NOT NULL,
  diagnostics TEXT,
  started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
COMMENT ON TABLE environment_provisionings IS '环境栈编排实例（DDD §12）';`,
        ...enumChecksForTable("environment_provisionings"),
        `CREATE INDEX idx_environment_provisionings_environment ON environment_provisionings(environment_id);`,

        `CREATE TABLE run_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  cron TEXT NOT NULL,
  objective TEXT,
  budget JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE run_schedules IS '定时触发（last_run_id 按设计不落 FK）';`,
        `CREATE INDEX idx_run_schedules_project ON run_schedules(project_id);`,

        `CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_logs IS '变更类 API 审计留痕（T-E01-11 中间件写入）';`,
        `CREATE INDEX idx_audit_logs_organization ON audit_logs(organization_id, created_at DESC);`,

        `CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE webhook_subscriptions IS 'CI/事件回流出站订阅';`,
    ],
    down: [
        `DROP TABLE IF EXISTS webhook_subscriptions CASCADE;`,
        `DROP TABLE IF EXISTS audit_logs CASCADE;`,
        `DROP TABLE IF EXISTS run_schedules CASCADE;`,
        `DROP TABLE IF EXISTS environment_provisionings CASCADE;`,
        `DROP TABLE IF EXISTS model_invocations CASCADE;`,
        `DROP TABLE IF EXISTS approval_requests CASCADE;`,
        `DROP TABLE IF EXISTS workflow_events CASCADE;`,
        `DROP TABLE IF EXISTS tool_calls CASCADE;`,
        `DROP TABLE IF EXISTS agent_runs CASCADE;`,
        `DROP TABLE IF EXISTS test_runs CASCADE;`,
    ],
} satisfies Migration;
