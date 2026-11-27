/**
 * 应用契约（DDD §2.1，T-E02-01）。
 *
 * 建模规则（DDD §2.1 注）：platform 单值（web/api）；web 型应用可配置 openApiUrl，
 * 此时 Run 的 platforms 可包含 api；api 型应用必须提供 OpenAPI；TestRun.platforms
 * 必须是所选应用能力集合的子集（校验函数见 rules.ts）。
 */

import { z } from "zod";
import { IsoDateTimeSchema, UuidSchema } from "./common.js";
import { ApplicationStatusSchema, PlatformSchema } from "./enums.js";

export const ApplicationConfigSchema = z
    .object({
        baseUrl: z.string().url().optional(),
        openApiUrl: z.string().url().optional(),
        appArtifactId: z.string().min(1).optional(),
        allowedDomains: z.array(z.string().min(1)).default([]),
    })
    .strict();
export type ApplicationConfig = z.infer<typeof ApplicationConfigSchema>;

export const ApplicationSchema = z
    .object({
        id: UuidSchema,
        projectId: UuidSchema,
        name: z.string().min(1).max(200),
        platform: PlatformSchema,
        status: ApplicationStatusSchema,
        config: ApplicationConfigSchema,
        createdAt: IsoDateTimeSchema,
        updatedAt: IsoDateTimeSchema,
    })
    .strict();
export type Application = z.infer<typeof ApplicationSchema>;
