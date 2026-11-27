/**
 * 0007 Agent 定义 prompt 版本化（T-E02-04，DDD §3.3）。
 *
 * agent_definitions 补齐 DDD §3.2 遗留列：
 * - prompt：角色系统提示词本体（NOT NULL；历史行缺省空串不存在——本表
 *   在 0007 之前从未被写入）；
 * - created_at / created_by：append-only 版本流水的行元数据
 *   （创建时间戳与创建者；种子行 created_by 为 NULL）。
 *
 * 种子：16 角色初始 prompt 骨架 + 基线 allowedTools（SDK 名单形态），
 * 单一事实源为 packages/domain/src/agent-prompts.ts（相对源码导入，
 * 与 db/enum-dictionary.ts 同模式——migration CI 不依赖 workspace dist）。
 *
 * 版本化纪律（管理 API 强制，DB 以 UNIQUE(name, version) 兜底）：
 * 行不可变（append-only）；prompt 变更必须携带新 prompt_version 标签；
 * 回滚 = 复制旧行 (prompt, prompt_version) 成对落新行，不删不改历史。
 *
 * 值一律美元引用（$aqaos$...$aqaos$）——prompt 文本含引号/换行均安全。
 */

import { baselineAgentDefinitions } from "../../packages/domain/src/agent-prompts.js";
import type { Migration } from "../runner.js";

function dollarQuote(value: string): string {
    return `$aqaos$${value}$aqaos$`;
}

const BASELINES = baselineAgentDefinitions();

const SEED_INSERTS = BASELINES.map(
    (definition) =>
        `INSERT INTO agent_definitions (name, version, prompt_version, prompt, config, enabled)
VALUES (${dollarQuote(definition.name)}, ${dollarQuote(definition.version)}, ${dollarQuote(definition.promptVersion)}, ${dollarQuote(definition.prompt)}, ${dollarQuote(JSON.stringify(definition.config))}::jsonb, TRUE)
ON CONFLICT (name, version) DO NOTHING;`,
);

const SEED_NAMES = BASELINES.map((definition) => dollarQuote(definition.name)).join(", ");

export default {
    name: "0007_agent_prompts",
    description:
        "agent_definitions 补 prompt/created_at/created_by 列（append-only 版本流水）+ 16 角色 prompt 骨架种子",
    up: [
        `ALTER TABLE agent_definitions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE agent_definitions ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
        `ALTER TABLE agent_definitions ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL`,
        `CREATE INDEX idx_agent_definitions_name_created ON agent_definitions(name, created_at DESC)`,
        `COMMENT ON COLUMN agent_definitions.prompt IS '角色系统提示词本体（行不可变：变更走新版本行，回滚复制成对新行）'`,
        `COMMENT ON COLUMN agent_definitions.created_by IS '版本创建者 users.id（种子行为 NULL）'`,
        ...SEED_INSERTS,
    ],
    down: [
        `DELETE FROM agent_definitions WHERE version = '1' AND name IN (${SEED_NAMES})`,
        `DROP INDEX IF EXISTS idx_agent_definitions_name_created`,
        `ALTER TABLE agent_definitions DROP COLUMN IF EXISTS created_by`,
        `ALTER TABLE agent_definitions DROP COLUMN IF EXISTS created_at`,
        `ALTER TABLE agent_definitions DROP COLUMN IF EXISTS prompt`,
    ],
} satisfies Migration;
