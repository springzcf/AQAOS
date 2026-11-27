/**
 * 0004 知识图谱与记忆（T-E01-07，DDL 对照 docs/03 §7.2）。
 * embedding 维度固定 1536（DDD §7.2；HashEmbedder 过渡期由应用层保证维度一致，
 * 网关 embedding 接入后按 T-E10-01 复核是否需要迁移维度）。
 */

import { enumChecksForTable } from "../enum-dictionary.js";
import type { Migration } from "../runner.js";

export default {
    name: "0004_knowledge",
    description: "knowledge_nodes/knowledge_edges/memories",
    up: [
        `CREATE TABLE knowledge_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  external_key TEXT,
  properties JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE knowledge_nodes IS '产品知识节点（DDD §2；事实置信标注存 properties.confidence）';`,
        `CREATE INDEX idx_knowledge_nodes_application ON knowledge_nodes(application_id, node_type);`,
        `CREATE INDEX idx_knowledge_nodes_external_key ON knowledge_nodes(application_id, external_key);`,

        `CREATE TABLE knowledge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  properties JSONB DEFAULT '{}'
);
COMMENT ON TABLE knowledge_edges IS '知识关系边（depends_on/transition/covers…值域由应用层定义）';`,
        `CREATE INDEX idx_knowledge_edges_source ON knowledge_edges(source_id);`,
        `CREATE INDEX idx_knowledge_edges_target ON knowledge_edges(target_id);`,

        `-- memories.organization/project/application 按 DDD §7.2 为裸 UUID（有意不建 FK，跨域软引用）。
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  project_id UUID NOT NULL,
  application_id UUID NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  confidence NUMERIC(4,3),
  source_run_id UUID,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE memories IS '跨 Run 记忆（T-E10-01；查询强制租户过滤）';`,
        ...enumChecksForTable("memories"),
        `CREATE INDEX idx_memories_scope ON memories(application_id, kind);`,
    ],
    down: [
        `DROP TABLE IF EXISTS memories CASCADE;`,
        `DROP TABLE IF EXISTS knowledge_edges CASCADE;`,
        `DROP TABLE IF EXISTS knowledge_nodes CASCADE;`,
    ],
} satisfies Migration;
