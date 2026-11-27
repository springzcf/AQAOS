/**
 * 领域通用原语（T-E02-01）：UUID、ISO 8601 时间戳、分页形状。
 * 所有实体字段引用这里，禁止各处自造 id/时间格式。
 */

import { z } from "zod";

export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const IsoDateTimeSchema = z.string().datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** 分页查询（列表 API 通用入参形状）。 */
export const PaginationQuerySchema = z
    .object({
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
    })
    .strict();
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** 分页列表信封（列表 API 通用出参形状）。 */
export interface ListEnvelope<T> {
    items: T[];
    total: number;
}
