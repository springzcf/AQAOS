/**
 * 0011 Memory 向量索引（T-E10-01，DDD §7.2/§9.2）。
 *
 * ADR-006（Qdrant → pgvector）落地：memories.embedding 建 HNSW 索引
 * （cosine 距离，vector_cosine_ops）——记忆规模（每应用千级）下近邻检索
 * 走索引而非全表扫描。cosine 语义与应用层 cosineSimilarity/去重阈值
 * 判定共用同一基准。
 *
 * pgvector 索引自动跳过 embedding IS NULL 的行（写路径未嵌入的记忆
 * 不入索引、不参与相似检索）。knowledge_nodes.embedding 的索引随
 * T-E10-04（长期记忆体系）按使用面落地，此处不提前。
 */

import type { Migration } from "../runner.js";

export default {
    name: "0011_memory_vector_index",
    description:
        "memories.embedding HNSW cosine 索引（ADR-006 Qdrant→pgvector 决策落地；租户过滤仍在同一条 SQL 强制）",
    up: [
        `CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);`,
        `COMMENT ON INDEX idx_memories_embedding IS 'T-E10-01 记忆近邻检索（cosine；NULL 向量自动跳过）';`,
    ],
    down: [`DROP INDEX IF EXISTS idx_memories_embedding;`],
} satisfies Migration;
