/**
 * 0008 Planner prompt v2（T-E02-06，DDD §3.3/§3.5）。
 *
 * append-only 版本化的首次实战：planner 产出通道从叙述式 AgentResult 升级
 * 为平台强制的 PlannerPlan JSON（SDK outputFormat json_schema）——prompt
 * 变更必须携带新标签，故追加 version=2 行（prompt_version=0.2.0），
 * v1 行原样保留（不可变纪律），latest 视图切到 v2。
 *
 * 单一事实源：packages/domain/src/agent-prompts.ts plannerPlanDefinition()
 * （相对源码导入，同 0007/enum-dictionary 模式）。美元引用防注入。
 */

import { plannerPlanDefinition } from "../../packages/domain/src/agent-prompts.js";
import type { Migration } from "../runner.js";

const PLANNER_V2 = plannerPlanDefinition();

export default {
    name: "0008_planner_prompt_v2",
    description:
        "planner prompt v2 种子（PlannerPlan JSON 结构化产出通道；version=2/prompt_version=0.2.0，v1 行原样保留）",
    up: [
        `INSERT INTO agent_definitions (name, version, prompt_version, prompt, config, enabled)
VALUES ($aqaos$${PLANNER_V2.name}$aqaos$, $aqaos$${PLANNER_V2.version}$aqaos$, $aqaos$${PLANNER_V2.promptVersion}$aqaos$, $aqaos$${PLANNER_V2.prompt}$aqaos$, $aqaos$${JSON.stringify(PLANNER_V2.config)}$aqaos$::jsonb, TRUE)
ON CONFLICT (name, version) DO NOTHING`,
    ],
    down: [
        `DELETE FROM agent_definitions WHERE name = $aqaos$${PLANNER_V2.name}$aqaos$ AND version = $aqaos$${PLANNER_V2.version}$aqaos$ AND prompt_version = $aqaos$${PLANNER_V2.promptVersion}$aqaos$`,
    ],
} satisfies Migration;
