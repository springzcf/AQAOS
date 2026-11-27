/**
 * TestRun 契约（DDD §2.3，T-E02-01）。
 *
 * 状态机（DDD §5.5）：queued → running ⇄ paused / blocked → completed / failed /
 * cancelled；转移合法性校验属 T-E02-12 Run Registry。
 * platforms ⊆ 所属应用能力集合的规则校验见 rules.ts（T-E11-06 消费）。
 */

import { z } from "zod";
import { IsoDateTimeSchema, UuidSchema } from "./common.js";
import { PlatformSchema, RunStatusSchema, TestModeSchema, TriggerSourceSchema } from "./enums.js";

export const RunTriggerSchema = z
    .object({
        source: TriggerSourceSchema,
        ref: z.string().min(1).optional(),
    })
    .strict();
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunBudgetSchema = z
    .object({
        maxAgents: z.number().int().min(1),
        maxDurationSeconds: z.number().int().min(1),
        maxModelCostUsd: z.number().nonnegative(),
        maxTokens: z.number().int().min(1),
    })
    .strict();
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const TestRunSchema = z
    .object({
        id: UuidSchema,
        projectId: UuidSchema,
        applicationId: UuidSchema,
        environmentId: UuidSchema,
        objective: z.string().min(1).max(2_000),
        platforms: z.array(PlatformSchema).min(1),
        modes: z.array(TestModeSchema).min(1),
        trigger: RunTriggerSchema,
        status: RunStatusSchema,
        budget: RunBudgetSchema,
        coverage: z.record(z.number()),
        temporalWorkflowId: z.string().min(1),
        createdAt: IsoDateTimeSchema,
        startedAt: IsoDateTimeSchema.optional(),
        completedAt: IsoDateTimeSchema.optional(),
    })
    .strict();
export type TestRun = z.infer<typeof TestRunSchema>;
