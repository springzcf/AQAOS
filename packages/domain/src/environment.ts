/**
 * 环境契约（DDD §2.2 / §12，T-E02-01）。
 *
 * 生命周期状态机（DDD §5.5）：unprovisioned → provisioning → ready → stopped；
 * 任一步失败 → failed 并保留诊断。状态转移函数属 T-E02-12 Run Registry 范畴。
 * policy 是测试防线：readOnly/allowDestructiveActions/requireApproval 三闸门
 * （PII 红线与破坏性操作的执行期强制点在 Worker 调用链中间件）。
 */

import { z } from "zod";
import { IsoDateTimeSchema, UuidSchema } from "./common.js";
import {
    EnvironmentStackStatusSchema,
    EnvironmentTypeSchema,
    ProvisioningMethodSchema,
} from "./enums.js";

export const EnvironmentPolicySchema = z
    .object({
        readOnly: z.boolean(),
        allowDestructiveActions: z.boolean(),
        requireApproval: z.boolean(),
    })
    .strict();
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;

export const HealthCheckConfigSchema = z
    .object({
        path: z.string().min(1).optional(),
        timeoutSeconds: z.number().int().min(1),
        intervalSeconds: z.number().int().min(1),
    })
    .strict();
export type HealthCheckConfig = z.infer<typeof HealthCheckConfigSchema>;

export const ResourceLimitsSchema = z
    .object({
        maxCpus: z.number().positive().optional(),
        maxMemoryMb: z.number().int().positive().optional(),
    })
    .strict();
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

export const ProvisioningConfigSchema = z
    .object({
        method: ProvisioningMethodSchema,
        composeFileRef: z.string().min(1).optional(),
        variables: z.record(z.string()).optional(),
        healthCheck: HealthCheckConfigSchema.optional(),
        resourceLimits: ResourceLimitsSchema.optional(),
    })
    .strict();
export type ProvisioningConfig = z.infer<typeof ProvisioningConfigSchema>;

export const EnvironmentSchema = z
    .object({
        id: UuidSchema,
        applicationId: UuidSchema,
        name: z.string().min(1).max(200),
        type: EnvironmentTypeSchema,
        baseUrl: z.string().url().optional(),
        credentialRef: z.string().min(1).optional(),
        policy: EnvironmentPolicySchema,
        provisioning: ProvisioningConfigSchema.optional(),
        status: EnvironmentStackStatusSchema,
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type Environment = z.infer<typeof EnvironmentSchema>;
