/**
 * 0010 Test Architect prompt v2（T-E02-09，DDD §3.7/§4.5）。
 *
 * 0008/0009 同模式的版本化实战（第三战）：test-architect 产出通道从场景
 * 矩阵叙述升级为平台强制的 TestStrategy JSON（SDK outputFormat
 * json_schema）——十二类测试组合选择 + 覆盖率目标 + 优先级策略 + focus
 * 键产品知识对照。迁移 0010 追加 version=2 行（prompt_version=0.2.0），
 * v1 行原样保留，latest 视图切到 v2。
 *
 * 单一事实源：packages/domain/src/agent-prompts.ts testArchitectDefinition()
 * （相对源码导入，同 0007/0008/0009 模式）。美元引用防注入。
 */

import { testArchitectDefinition } from "../../packages/domain/src/agent-prompts.js";
import type { Migration } from "../runner.js";

const TEST_ARCHITECT_V2 = testArchitectDefinition();

export default {
    name: "0010_test_architect_prompt_v2",
    description:
        "test-architect prompt v2 种子（TestStrategy JSON 结构化产出：测试类型组合/覆盖率目标/优先级；version=2/prompt_version=0.2.0，v1 行原样保留）",
    up: [
        `INSERT INTO agent_definitions (name, version, prompt_version, prompt, config, enabled)
VALUES ($aqaos$${TEST_ARCHITECT_V2.name}$aqaos$, $aqaos$${TEST_ARCHITECT_V2.version}$aqaos$, $aqaos$${TEST_ARCHITECT_V2.promptVersion}$aqaos$, $aqaos$${TEST_ARCHITECT_V2.prompt}$aqaos$, $aqaos$${JSON.stringify(TEST_ARCHITECT_V2.config)}$aqaos$::jsonb, TRUE)
ON CONFLICT (name, version) DO NOTHING`,
    ],
    down: [
        `DELETE FROM agent_definitions WHERE name = $aqaos$${TEST_ARCHITECT_V2.name}$aqaos$ AND version = $aqaos$${TEST_ARCHITECT_V2.version}$aqaos$ AND prompt_version = $aqaos$${TEST_ARCHITECT_V2.promptVersion}$aqaos$`,
    ],
} satisfies Migration;
