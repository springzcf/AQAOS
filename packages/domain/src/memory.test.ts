/**
 * Memory 基座契约回归（T-E10-01，DDD §9.2）。
 *
 * - MemoryRecordSchema：scope 三键 + kind 五类 + 默认 version、strict 拒绝；
 * - MemorySearchQuerySchema：organizationId 必填（租户强制面）、limit 夹逼；
 * - HashEmbedder：确定性（同文本同向量）、维度 1536、无 token 全零向量、
 *   相近文本相似度高 / 无关文本低；
 * - cosineSimilarity：恒等 1、正交 0、维度守卫；
 * - assertEmbeddingDimensions：违约即抛。
 */

import { describe, expect, it } from "vitest";
import {
    EMBEDDING_DIMENSIONS,
    HashEmbedder,
    MemoryRecordSchema,
    MemorySearchQuerySchema,
    assertEmbeddingDimensions,
    cosineSimilarity,
} from "./index.js";

const RECORD = {
    organizationId: "7e2e120d-08a2-4fc4-a04e-efd909c75771",
    projectId: "7e2e120d-08a2-4fc4-a04e-efd909c75772",
    applicationId: "7e2e120d-08a2-4fc4-a04e-efd909c75773",
    kind: "test",
    content: "checkout journey smoke case",
};

describe("MemoryRecordSchema（写入契约）", () => {
    it("默认 version=1；strict 拒绝未知键", () => {
        const parsed = MemoryRecordSchema.parse(RECORD);
        expect(parsed.version).toBe(1);

        expect(() => MemoryRecordSchema.parse({ ...RECORD, extra: 1 })).toThrow();
        expect(() => MemoryRecordSchema.parse({ ...RECORD, kind: "note" })).toThrow();
        expect(() =>
            MemoryRecordSchema.parse({ ...RECORD, organizationId: "not-a-uuid" }),
        ).toThrow();
        expect(() => MemoryRecordSchema.parse({ ...RECORD, confidence: 1.5 })).toThrow();
    });

    it("五类 kind 合法；置信/来源 Run/过期可选", () => {
        for (const kind of ["product", "exploration", "test", "bug", "feedback"]) {
            expect(
                MemoryRecordSchema.parse({
                    ...RECORD,
                    kind,
                    confidence: 0.8,
                    sourceRunId: "7e2e120d-08a2-4fc4-a04e-efd909c75774",
                    expiresAt: "2026-12-31T00:00:00.000Z",
                }).kind,
            ).toBe(kind);
        }
    });
});

describe("MemorySearchQuerySchema（检索契约：租户强制面）", () => {
    it("organizationId 必填；limit 默认 10 且夹逼 1-50", () => {
        expect(() => MemorySearchQuerySchema.parse({ content: "x" })).toThrow();

        const parsed = MemorySearchQuerySchema.parse({
            organizationId: RECORD.organizationId,
            content: "similar tests",
        });
        expect(parsed.limit).toBe(10);

        expect(() =>
            MemorySearchQuerySchema.parse({
                organizationId: RECORD.organizationId,
                content: "x",
                limit: 0,
            }),
        ).toThrow();
        expect(() =>
            MemorySearchQuerySchema.parse({
                organizationId: RECORD.organizationId,
                content: "x",
                limit: 51,
            }),
        ).toThrow();
    });

    it("可选收窄：project/application/kind", () => {
        const parsed = MemorySearchQuerySchema.parse({
            organizationId: RECORD.organizationId,
            projectId: RECORD.projectId,
            applicationId: RECORD.applicationId,
            kind: "test",
            content: "x",
        });
        expect(parsed.kind).toBe("test");
    });
});

describe("HashEmbedder（确定性嵌入）", () => {
    const embedder = new HashEmbedder();

    it("维度 1536；同文本同向量（确定性，去重可重复判定）", async () => {
        const [a, b] = await embedder.embed(["checkout smoke", "checkout smoke"]);
        expect(a?.length).toBe(EMBEDDING_DIMENSIONS);
        expect(b).toEqual(a);

        const again = new HashEmbedder().embedOne("checkout smoke");
        expect(again).toEqual(a);
    });

    it("相近文本相似度高；无关文本接近零；空文本全零向量", () => {
        const a = embedder.embedOne("checkout journey smoke");
        const b = embedder.embedOne("checkout journey smoke case");
        const c = embedder.embedOne("database migration plan");
        // 3 公共 token vs 4 token：无碰撞桶下相似度 = 3/√12 ≈ 0.866。
        expect(cosineSimilarity(a, b)).toBeGreaterThan(0.8);
        expect(cosineSimilarity(a, c)).toBeLessThan(0.2);

        const empty = embedder.embedOne("");
        expect(empty.every((value) => value === 0)).toBe(true);
        expect(cosineSimilarity(empty, a)).toBe(0);
    });

    it("自定义维度构造（小桶测试）；向量已归一化", () => {
        const small = new HashEmbedder(64);
        const vector = small.embedOne("normalized vector check");
        expect(vector.length).toBe(64);
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(magnitude).toBeCloseTo(1, 5);
    });
});

describe("cosineSimilarity / assertEmbeddingDimensions（纯函数）", () => {
    it("恒等 1；正交 0；维度不一致按公共前缀保守计算", () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
        expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 10);
        expect(cosineSimilarity([1, 0, 5], [1, 0])).toBe(1);
        expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("维度违约即抛（1536 契约）", () => {
        expect(() => assertEmbeddingDimensions(new Array(1536).fill(0))).not.toThrow();
        expect(() => assertEmbeddingDimensions(new Array(256).fill(0))).toThrow(
            /embedding dimension mismatch/,
        );
    });
});
