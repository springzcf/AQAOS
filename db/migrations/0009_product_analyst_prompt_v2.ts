/**
 * 0009 Product Analyst prompt v2（T-E02-07，DDD §3.3/§4.3）。
 *
 * planner v2（0008）同模式的版本化实战：product-analyst 产出通道从对话式
 * 回答升级为平台强制的 ProductModel JSON（SDK outputFormat json_schema）+
 * 逐事实置信标注纪律（confirmed/inferred/unknown）——迁移 0009 追加
 * version=2 行（prompt_version=0.2.0），v1 行原样保留，latest 视图切到 v2。
 *
 * 单一事实源：packages/domain/src/agent-prompts.ts productAnalystDefinition()
 * （相对源码导入，同 0007/0008 模式）。美元引用防注入。
 */

import { productAnalystDefinition } from "../../packages/domain/src/agent-prompts.js";
import type { Migration } from "../runner.js";

const PRODUCT_ANALYST_V2 = productAnalystDefinition();

export default {
    name: "0009_product_analyst_prompt_v2",
    description:
        "product-analyst prompt v2 种子（ProductModel JSON 结构化产出 + 事实置信标注；version=2/prompt_version=0.2.0，v1 行原样保留）",
    up: [
        `INSERT INTO agent_definitions (name, version, prompt_version, prompt, config, enabled)
VALUES ($aqaos$${PRODUCT_ANALYST_V2.name}$aqaos$, $aqaos$${PRODUCT_ANALYST_V2.version}$aqaos$, $aqaos$${PRODUCT_ANALYST_V2.promptVersion}$aqaos$, $aqaos$${PRODUCT_ANALYST_V2.prompt}$aqaos$, $aqaos$${JSON.stringify(PRODUCT_ANALYST_V2.config)}$aqaos$::jsonb, TRUE)
ON CONFLICT (name, version) DO NOTHING`,
    ],
    down: [
        `DELETE FROM agent_definitions WHERE name = $aqaos$${PRODUCT_ANALYST_V2.name}$aqaos$ AND version = $aqaos$${PRODUCT_ANALYST_V2.version}$aqaos$ AND prompt_version = $aqaos$${PRODUCT_ANALYST_V2.promptVersion}$aqaos$`,
    ],
} satisfies Migration;
