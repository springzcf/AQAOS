/**
 * 结构化输出兜底解析（T-E02-06/07 共用）。
 *
 * SDK outputFormat json_schema 通道下 result.structured_output 是正道；
 * structured_output 缺席时尝试 resultText JSON 解析（容错 SDK 版本差异）。
 * planner.ts（T-E02-06）与 product-analyst.ts（T-E02-07）同源消费。
 */

import type { AgentSessionOutcome } from "./agent-session.js";

/** 兜底解析：structured_output 缺席时尝试 resultText JSON（容错 SDK 版本差异）。 */
export function parseStructuredOutput(session: AgentSessionOutcome): unknown {
    if (session.structuredOutput !== undefined) {
        return session.structuredOutput;
    }
    const text = session.resultText.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            return undefined;
        }
    }
    return undefined;
}
