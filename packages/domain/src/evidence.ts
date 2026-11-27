/**
 * 证据契约（DDD §2.5，T-E02-01）。
 *
 * 证据对象本体在 MinIO（storage_key），本契约是对象存储的注册引用：
 * sha256 供完整性校验（上传方计算，消费方核对——报告可追溯性的基石）。
 */

import { z } from "zod";
import { IsoDateTimeSchema, UuidSchema } from "./common.js";
import { EvidenceTypeSchema } from "./enums.js";

export const EvidenceReferenceSchema = z
    .object({
        id: UuidSchema,
        runId: UuidSchema,
        applicationId: UuidSchema,
        type: EvidenceTypeSchema,
        storageKey: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        metadata: z.record(z.unknown()).default({}),
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
