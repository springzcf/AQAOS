/**
 * 0001 租户与平台基础（T-E01-07，DDL 对照 docs/03 §7.2，逐列保持一致）。
 * 审计补充（§7.2 注意事项明确授权）：organization_id 租户列、FK 删除策略、枚举 CHECK、辅助索引。
 * 删除策略约定：租户根（organizations）级联清空数据；历史引用（actor 等）置空。
 */

import { enumChecksForTable } from "../enum-dictionary.js";
import type { Migration } from "../runner.js";

export default {
    name: "0001_platform",
    description:
        "organizations/users/memberships/projects/applications/environments/credentials/model_configs/agent_definitions/external_integrations",
    up: [
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
        `CREATE EXTENSION IF NOT EXISTS vector;`,

        `CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE organizations IS '租户根（DDD §7.2）；删除即级联清空该租户全部数据';`,

        `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS '全局用户身份（跨租户，不参与 RLS）';`,

        `CREATE TABLE memberships (
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
COMMENT ON TABLE memberships IS '用户-租户关系；role 合法值待 T-E11-05 RBAC 矩阵定稿后加 CHECK';`,

        `CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE projects IS 'QA 项目（DDD §2.1 Application 的容器）';`,

        `CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE applications IS '被测应用（web/api）';`,
        ...enumChecksForTable("applications"),
        `CREATE INDEX idx_applications_project ON applications(project_id);`,

        `CREATE TABLE environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  environment_type TEXT NOT NULL,
  base_url TEXT,
  credential_ref TEXT,
  policy JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE environments IS '被测环境（DDD §2.2）；credential_ref 指向 credentials.name（引用不落 FK）';`,
        `CREATE INDEX idx_environments_application ON environments(application_id);`,

        `CREATE TABLE credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  cipher_text TEXT NOT NULL,
  rotation_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, name)
);
COMMENT ON TABLE credentials IS '凭据密文（ENCRYPTION_KEY 加密，T-E01-02）';`,

        `CREATE TABLE model_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]',
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE model_configs IS '模型注册表（project_id 为空表示全局配置，暂不参与 RLS）';`,
        `CREATE INDEX idx_model_configs_project ON model_configs(project_id);`,

        `CREATE TABLE agent_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(name, version)
);
COMMENT ON TABLE agent_definitions IS '16 角色 Agent 定义与 prompt 版本（全局，T-E02-04）';`,

        `CREATE TABLE external_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE external_integrations IS '工单/CI 外部集成（jira/github/gitlab/ci）';`,
        ...enumChecksForTable("external_integrations"),
    ],
    down: [
        `DROP TABLE IF EXISTS external_integrations CASCADE;`,
        `DROP TABLE IF EXISTS agent_definitions CASCADE;`,
        `DROP TABLE IF EXISTS model_configs CASCADE;`,
        `DROP TABLE IF EXISTS credentials CASCADE;`,
        `DROP TABLE IF EXISTS environments CASCADE;`,
        `DROP TABLE IF EXISTS applications CASCADE;`,
        `DROP TABLE IF EXISTS projects CASCADE;`,
        `DROP TABLE IF EXISTS memberships CASCADE;`,
        `DROP TABLE IF EXISTS users CASCADE;`,
        `DROP TABLE IF EXISTS organizations CASCADE;`,
        `DROP EXTENSION IF EXISTS vector;`,
        `DROP EXTENSION IF EXISTS pgcrypto;`,
    ],
} satisfies Migration;
