/**
 * 用例去重契约（T-E10-02，DDD §13.1）。
 *
 * Generator 重复生成的两道防线（判定可重复是合同前提）：
 * - **指纹精确去重**：用例身份承载子集（title/platform/steps/assertions）
 *   规范化（标题折叠空白+小写、对象键序无关、数组序保持——步骤序列是
 *   身份、字符串叶子 trim）后 sha256——同内容恒同指纹；DB 唯一索引
 *   (org, app, fingerprint) 结构性兜底（迁移 0012）；
 * - **向量相似去重**：嵌入文本（标题+步骤/断言的**值叶子**串流——对象
 *   键名不参与，结构词汇会让结构相同内容不同的用例虚高相似）经
 *   EmbeddingClient 嵌入，与库内用例做 cosine 近邻，≥ 阈值判近似重复
 *   （改写复述型重复：指纹不同但语义相同）。
 *
 * 嵌入与阈值基准：HashEmbedder（T-E10-01 过渡实现）确定性 token 袋——
 * 阈值 0.85 面向其 token 重叠量级调校（评测集见 apps/api 去重验收）；
 * T-E04 网关换真实嵌入后需复校（真实嵌入的无关文本相似度更低，0.85
 * 偏保守但方向安全——宁可漏判不可误杀新用例）。
 *
 * tags/version/status 等元数据不参与判定（元数据相同的两条用例若内容
 * 不同仍是两条用例；反之亦然）。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformSchema } from "./enums.js";

/** 指纹规范形态版本（规范化规则变更时必须升版本防新旧指纹碰撞）。 */
const FINGERPRINT_PREFIX = "aqaos.test-case.v1";

/**
 * 去重输入：用例的身份承载内容子集。steps/assertions 为任意 JSON 对象
 * 数组（结构随 T-E02-10 生成契约演进；去重只消费规范化序列与值叶子，
 * 不绑定具体步骤 schema——结构演进不破坏指纹语义，仅规范形态版本负责
 * 兼容边界）。
 */
export const TestCaseContentSchema = z
    .object({
        title: z.string().min(1).max(500),
        platform: PlatformSchema,
        steps: z.array(z.record(z.unknown())).min(1).max(200),
        assertions: z.array(z.record(z.unknown())).max(200).default([]),
    })
    .strict();
export type TestCaseContent = z.infer<typeof TestCaseContentSchema>;

/** 去重配置（Generator 调用侧可按应用调优；缺省 0.85/5）。 */
export const DedupConfigSchema = z
    .object({
        /** cosine 相似阈值：≥ 判近似重复。 */
        similarityThreshold: z.number().min(0.5).max(1).default(0.85),
        /** 近邻检索上限（top-k）。 */
        nearLimit: z.number().int().min(1).max(50).default(5),
    })
    .strict();
export type DedupConfig = z.infer<typeof DedupConfigSchema>;

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
    similarityThreshold: 0.85,
    nearLimit: 5,
};

/** 标题规范化：trim + 折叠内部空白 + 小写（大小写/空白差异不是身份差异）。 */
function normalizeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * canonical JSON（fingerprint 专用语义）：对象键排序（键序无关）、数组
 * **保持原序**（步骤序列是身份）、字符串叶子 trim。
 *
 * 与 agent-prompts 的 canonicalJson（config 白名单数组按集合归一）语义
 * 不同，不可共用：那里的数组序无意义，这里的序就是身份。
 */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return typeof value === "string" ? JSON.stringify(value.trim()) : JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** 用例指纹：同内容恒同值（去重可重复判定的基准）；含平台与断言。 */
export function testCaseFingerprint(content: TestCaseContent): string {
    const canonical = [
        `title=${normalizeTitle(content.title)}`,
        `platform=${content.platform}`,
        `steps=${canonicalJson(content.steps)}`,
        `assertions=${canonicalJson(content.assertions)}`,
    ].join("\n");
    return createHash("sha256").update(`${FINGERPRINT_PREFIX}\n${canonical}`).digest("hex");
}

/** 收集 JSON 标量叶子（对象键名不参与——见文件头注释）。 */
function scalarLeaves(value: unknown, sink: string[]): void {
    if (value === null || value === undefined) {
        return;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            sink.push(trimmed);
        }
        return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        sink.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            scalarLeaves(item, sink);
        }
        return;
    }
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        scalarLeaves((value as Record<string, unknown>)[key], sink);
    }
}

/** 嵌入文本（EmbeddingClient 输入）：标题 + 步骤/断言值叶子串流。 */
export function testCaseEmbeddingText(content: TestCaseContent): string {
    const leaves: string[] = [];
    scalarLeaves(content.steps, leaves);
    scalarLeaves(content.assertions, leaves);
    return `${content.title.trim()}\n${leaves.join(" ")}`;
}

/** 近邻命中（cosine 相似度 0-1，降序）。 */
export interface DuplicateNearHit {
    readonly caseId: string;
    readonly title: string;
    readonly similarity: number;
}

/** 精确命中（指纹一致）。 */
export interface DuplicateExactHit {
    readonly caseId: string;
    readonly title: string;
}

/** 去重判定结果：exact 或 near 非空 ⟺ isDuplicate。 */
export interface DuplicateCheckResult {
    readonly fingerprint: string;
    readonly exact: DuplicateExactHit | null;
    readonly near: readonly DuplicateNearHit[];
    readonly isDuplicate: boolean;
}

/**
 * 纯函数判定（离线评测与 pg 实现共用同一语义）：
 * 近邻按阈值过滤、剔除精确命中自身（指纹命中行同时会以相似度 1.0 出现
 * 在近邻里）、降序排序、截断 nearLimit。
 */
export function classifyDuplicate(
    fingerprint: string,
    exact: DuplicateExactHit | null,
    near: readonly { caseId: string; title: string; similarity: number }[],
    config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): DuplicateCheckResult {
    const thresholded = near
        .filter((hit) => hit.similarity >= config.similarityThreshold)
        .filter((hit) => exact === null || hit.caseId !== exact.caseId)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, config.nearLimit);
    return {
        fingerprint,
        exact,
        near: thresholded,
        isDuplicate: exact !== null || thresholded.length > 0,
    };
}

/** 去重范围（租户强制面：组织+应用双键，与 test_cases 隔离列一致）。 */
export interface DedupScope {
    readonly organizationId: string;
    readonly applicationId: string;
}

/**
 * 去重服务接缝（供 Generator 注入；pg 实现在 apps/api lib/test-case-store，
 * 评测与测试用内存/假实现）。organizationId 永远来自可信调用方上下文
 * （与 memory.search_memories 同律：跨组织去重在构造上不可能）。
 */
export interface TestCaseDedupService {
    check(
        contents: readonly TestCaseContent[],
        scope: DedupScope,
        config?: DedupConfig,
    ): Promise<readonly DuplicateCheckResult[]>;
}
