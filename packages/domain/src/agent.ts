/**
 * Agent 契约（DDD §2.4 AgentResult / §3 Agent Contract，T-E02-01）。
 *
 * DDD 引用但未内联定义的支撑类型（FindingReference/CoverageUpdate/AgentAction/
 * AgentBudget/AgentInput）在此补全并回写 DDD（V1.7 登记设计缺口修复）：
 * - FindingReference：Agent 产出物的轻引用（Bug/安全/性能发现入各自实体表后回指）；
 * - CoverageUpdate：与 coverage_records 行形状一致的增量更新；
 * - AgentAction：nextActions 的最小结构（Planner/QA Manager 委派提示）；
 * - AgentContext.signal（AbortSignal）是运行时对象，不可序列化——zod 只约束
 *   可序列化字段，类型经交叉补上 signal。
 */

import { z } from "zod";
import { UuidSchema } from "./common.js";
import {
    AgentResultStatusSchema,
    AgentRoleIdSchema,
    CoverageDimensionSchema,
    type AgentRoleId,
} from "./enums.js";

export const TokenUsageSchema = z
    .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
    })
    .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const FindingKindSchema = z.enum(["bug", "security", "performance", "coverage-gap"]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

export const FindingReferenceSchema = z
    .object({
        id: UuidSchema,
        kind: FindingKindSchema,
        fingerprint: z.string().min(1).optional(),
    })
    .strict();
export type FindingReference = z.infer<typeof FindingReferenceSchema>;

export const CoverageUpdateSchema = z
    .object({
        dimension: CoverageDimensionSchema,
        targetKey: z.string().min(1),
        covered: z.boolean(),
        detail: z.record(z.unknown()).optional(),
    })
    .strict();
export type CoverageUpdate = z.infer<typeof CoverageUpdateSchema>;

export const AgentActionSchema = z
    .object({
        type: z.enum(["delegate", "tool-call", "wait", "report"]),
        target: z.string().min(1),
        reason: z.string().min(1).optional(),
    })
    .strict();
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentResultSchema = z
    .object({
        agentRunId: UuidSchema,
        agentRole: AgentRoleIdSchema,
        agentVersion: z.string().min(1),
        status: AgentResultStatusSchema,
        summary: z.string().min(1),
        findings: z.array(FindingReferenceSchema),
        evidence: z.array(UuidSchema),
        coverageUpdates: z.array(CoverageUpdateSchema),
        nextActions: z.array(AgentActionSchema),
        usage: TokenUsageSchema,
        confidence: z.number().min(0).max(1),
    })
    .strict();
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const AgentBudgetSchema = z
    .object({
        maxTokens: z.number().int().min(1),
        maxModelCostUsd: z.number().nonnegative(),
        maxToolCalls: z.number().int().min(1).optional(),
        maxDurationSeconds: z.number().int().min(1).optional(),
    })
    .strict();
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const AgentInputSchema = z
    .object({
        kind: z.string().min(1),
        payload: z.unknown(),
    })
    .strict();
export type AgentInput = z.infer<typeof AgentInputSchema>;

/**
 * agent_definitions.config JSONB 契约（T-E02-02：agent_definitions → SDK 会话选项映射）。
 * 仅承载非提示词的会话配置；prompt 本体随 prompt_version 走版本化存储（T-E02-04）。
 */
export const AgentDefinitionConfigSchema = z
    .object({
        /** 模型 id（E03 Model Gateway 上线前直传 SDK；缺省用 worker 默认模型）。 */
        model: z.string().min(1).optional(),
        /** MCP 工具白名单（DDD §3.1 allowedTools，客户端第一层限制）。 */
        allowedTools: z.array(z.string().min(1)).optional(),
        /** 会话最大轮数（SDK maxTurns 原生熔断）。 */
        maxTurns: z.number().int().min(1).optional(),
        /** 思考投入档位（与自适应思考配合控制成本）。 */
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        /** 是否持久化会话（缺省 false：headless 一次性运行；QA Manager 多轮随 T-E02-05 打开）。 */
        persistSession: z.boolean().optional(),
    })
    .strict();
export type AgentDefinitionConfig = z.infer<typeof AgentDefinitionConfigSchema>;

/**
 * agent_definitions 行形状（+ prompt 本体，由 prompt 存储解析后随行携带）。
 * name 即 AgentRoleId（16 角色规范 id）；合法性在会话选项映射层校验。
 * createdAt/createdBy：行元数据（T-E02-04 版本化追加列；管理 API 返回，
 * 运行侧会话映射不消费，可选）。
 */
export const AgentDefinitionRecordSchema = z
    .object({
        id: UuidSchema,
        name: z.string().min(1),
        version: z.string().min(1),
        promptVersion: z.string().min(1),
        prompt: z.string().min(1),
        config: AgentDefinitionConfigSchema.default({}),
        enabled: z.boolean(),
        createdAt: z.string().datetime().optional(),
        createdBy: UuidSchema.nullable().optional(),
    })
    .strict();
export type AgentDefinitionRecord = z.infer<typeof AgentDefinitionRecordSchema>;

/** 可序列化字段（zod 约束）；signal 是运行时 AbortSignal，运行侧注入。 */
export const SerializableAgentContextSchema = z
    .object({
        runId: UuidSchema,
        applicationId: UuidSchema,
        environmentId: UuidSchema,
        objective: z.string().min(1),
        budget: AgentBudgetSchema,
        permissions: z.array(z.string().min(1)),
        traceId: z.string().min(1),
    })
    .strict();

export interface AgentContext extends z.infer<typeof SerializableAgentContextSchema> {
    /** 取消信号（暂停/恢复/终止传导；运行时对象，不进 wire 契约）。 */
    signal?: AbortSignal;
}

/** Agent 实现契约（DDD §3）：方法是行为，不可 zod，仅类型约束。 */
export interface Agent {
    readonly role: AgentRoleId;
    readonly version: string;
    execute(context: AgentContext, input: AgentInput): Promise<AgentResult>;
}
