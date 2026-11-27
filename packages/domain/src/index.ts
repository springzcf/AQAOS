/**
 * AQAOS domain layer（T-E02-01 实装：DDD §2/§3 领域契约 + §7.3 枚举字典）。
 *
 * 依赖规则（SDD §6.2）：本包不引入上层（contracts/api/worker）依赖，除 zod 外
 * 零运行时依赖——纯类型与纯函数，无 I/O。zod Schema 与类型经 z.infer 同源导出，
 * 校验器与类型永不漂移；前后端/Worker 以本包为唯一类型来源（T-E02-01 验收）。
 *
 * 后续演进：
 * - T-E02-12：§5.5 状态机转移函数（Run/环境/用例/Bug/审批）；
 * - T-E02-02/T-E02-04 已实装：agent 契约 + 16 角色 prompt 骨架与版本化策略；
 * - db/enum-dictionary.ts re-export 本包 enums（CHECK 约束同源）。
 */

export const DOMAIN_LAYER_VERSION = "0.6.0";

export * from "./common.js";
export * from "./enums.js";
export * from "./application.js";
export * from "./environment.js";
export * from "./run.js";
export * from "./agent.js";
export * from "./agent-prompts.js";
export * from "./planner-plan.js";
export * from "./product-model.js";
export * from "./test-strategy.js";
export * from "./memory.js";
export * from "./qa-plan.js";
export * from "./evidence.js";
export * from "./mcp-tools.js";
export * from "./rules.js";
