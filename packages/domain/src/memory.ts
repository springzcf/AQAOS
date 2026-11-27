/**
 * Memory 基座契约（T-E10-01，DDD §7.2 memories 表 / §9.2）。
 *
 * 跨 Run 记忆的读写契约与嵌入接缝：
 * - MemoryRecord：写入形状（scope 三键 organization/project/application +
 *   kind 五类 + content + 置信 + 来源 Run + 版本 + 过期）——隔离字段是
 *   **查询强制租户过滤**的合同面：任何检索都按 organization_id 收窄；
 * - EmbeddingClient：嵌入接缝（网关 T-E04 接真实模型；过渡期
 *   HashEmbedder 确定性实现——与 QA-Swarm 同款 sha1 分桶符号哈希，
 *   维度 1536 对齐 DDL VECTOR(1536)）；
 * - cosineSimilarity：余弦相似纯函数（HNSW cosine 排序的语义基准，
 *   去重阈值判定共用）。
 *
 * ADR-006（Qdrant → pgvector）：向量检索与业务数据同库——租户过滤在
 * 同一条 SQL 里强制（WHERE organization_id = $1），没有跨库同步窗口；
 * HNSW 索引（0011）满足记忆规模（每应用千级）检索延迟。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryKindSchema } from "./enums.js";

/** 嵌入维度（DDL VECTOR(1536)；网关接入后如需换维走迁移复核）。 */
export const EMBEDDING_DIMENSIONS = 1536;

/** 记忆写入输入（scope 三键隔离；kind 五类）。 */
export const MemoryRecordSchema = z
    .object({
        organizationId: z.string().uuid(),
        projectId: z.string().uuid(),
        applicationId: z.string().uuid(),
        kind: MemoryKindSchema,
        content: z.string().min(1),
        /** 置信（0-1；来源信号强度，供检索侧加权）。 */
        confidence: z.number().min(0).max(1).optional(),
        /** 产生本条记忆的 Run（跨 Run 复用溯源）。 */
        sourceRunId: z.string().uuid().optional(),
        version: z.number().int().min(1).default(1),
        /** 过期时间（过期记忆检索侧过滤，不物理删除）。 */
        expiresAt: z.string().datetime().optional(),
    })
    .strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/** 检索命中（相似度 0-1，cosine）。 */
export interface MemoryHit {
    readonly record: MemoryRecord;
    readonly score: number;
}

/**
 * 检索输入（租户强制面）：organizationId 必填——所有检索路径都以此为
 * 第一过滤键；可选收窄 project/application/kind；content 经嵌入后做
 * cosine 近邻排序。
 */
export const MemorySearchQuerySchema = z
    .object({
        organizationId: z.string().uuid(),
        projectId: z.string().uuid().optional(),
        applicationId: z.string().uuid().optional(),
        kind: MemoryKindSchema.optional(),
        content: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
    })
    .strict();
export type MemorySearchQuery = z.infer<typeof MemorySearchQuerySchema>;

/** 嵌入接缝：真实实现由模型网关（T-E04）提供；测试与过渡期用 HashEmbedder。 */
export interface EmbeddingClient {
    embed(texts: readonly string[]): Promise<readonly number[][]>;
}

/** 维度契约校验（写库前防御：长度 ≠ 1536 即契约违约）。 */
export function assertEmbeddingDimensions(vector: readonly number[]): void {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
            `embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${vector.length}`,
        );
    }
}

/**
 * 确定性哈希嵌入（过渡期实现，QA-Swarm 同款方案）：
 * token → sha1 → 桶索引 + 符号 → 归一化。无网络、跨 Run 稳定——去重
 * 相似度的可重复判定依赖这一点（同文本永远同向量）。
 */
export class HashEmbedder implements EmbeddingClient {
    constructor(private readonly dims: number = EMBEDDING_DIMENSIONS) {}

    get dimensions(): number {
        return this.dims;
    }

    async embed(texts: readonly string[]): Promise<readonly number[][]> {
        return texts.map((text) => this.embedOne(text));
    }

    embedOne(text: string): number[] {
        const vec = new Array<number>(this.dims).fill(0);
        // ASCII 词 + CJK 逐字 token（T-E10-02：用例/记忆含中文文本时逐字
        // 分桶——按整词分会让"结算按钮"与"结算按钮提交"零重叠，近似去重
        // 失效；逐字粒度近重复共享度高，无关文本仅共享助词）。
        const tokens =
            text.toLowerCase().match(/[a-z0-9_]+|[㐀-鿿豈-﫿]/g) ?? [];
        for (const token of tokens) {
            const digest = createHash("sha1").update(token).digest();
            const index = digest.readUInt32BE(0) % this.dims;
            const sign = digest[4]! % 2 === 0 ? 1 : -1;
            vec[index] = (vec[index] ?? 0) + sign;
        }
        return normalize(vec);
    }
}

/** 余弦相似（归一化向量即点积；未归一化输入按定义计算）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const x = a[index] ?? 0;
        const y = b[index] ?? 0;
        dot += x * y;
        magA += x * x;
        magB += y * y;
    }
    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    return magnitude === 0 ? 0 : dot / magnitude;
}

function normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / magnitude);
}
