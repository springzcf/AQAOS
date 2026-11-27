/**
 * 会话计量器（T-E02-02 usage 回报 / T-E02-13 model_invocations 上报的数据源）。
 *
 * SDK 语义（sdk.d.ts 权威注释）：
 * - result.modelUsage / total_cost_usd 对一次 query() 调用是**累计值**
 *   （"read the latest result rather than summing across results"），
 *   计量器只取最新 result 快照，绝不对 result 做加法；
 * - result.usage 仅主循环（不含子代理/边链），计量一律用 modelUsage；
 * - 工具调用数从 assistant 消息的 tool_use 内容块计数（主循环粒度）。
 */

import type {
    ModelUsage,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** 一次会话（query 调用）的用量快照；每轮 result 到达时刷新并回报。 */
export interface SessionUsageSnapshot {
    sessionId?: string;
    numTurns: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    /** SDK 估算成本（美元；累计口径，取最新 result.total_cost_usd）。 */
    costUsd: number;
    /** 逐模型累计（modelUsage 原样透传，供 model_invocations 细分落库）。 */
    perModel: Record<string, ModelUsage>;
    /** 主循环 tool_use 块计数（预算 maxToolCalls 的计量口径）。 */
    toolUseCount: number;
}

const EMPTY_SNAPSHOT: SessionUsageSnapshot = {
    numTurns: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    perModel: {},
    toolUseCount: 0,
};

interface ToolUseLikeBlock {
    type: string;
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
    return message.type === "result";
}

function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
    return message.type === "assistant";
}

export class SessionMeter {
    private current: SessionUsageSnapshot = { ...EMPTY_SNAPSHOT, perModel: {} };
    private sawResult = false;

    constructor(private readonly onUsage?: (snapshot: SessionUsageSnapshot) => void) {}

    /**
     * 喂入一条 SDK 消息。result 消息刷新累计快照并触发 onUsage 回报；
     * assistant 消息累计 tool_use 块数。
     */
    observe(message: SDKMessage): void {
        if (isAssistantMessage(message)) {
            const content = message.message.content;
            if (Array.isArray(content)) {
                const toolUses = content.filter(
                    (block: ToolUseLikeBlock) => block.type === "tool_use",
                ).length;
                this.current.toolUseCount += toolUses;
            }
            return;
        }
        if (!isResultMessage(message)) {
            return;
        }
        const result = message;
        this.sawResult = true;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        let cacheCreation = 0;
        for (const usage of Object.values(result.modelUsage)) {
            inputTokens += usage.inputTokens;
            outputTokens += usage.outputTokens;
            cacheRead += usage.cacheReadInputTokens;
            cacheCreation += usage.cacheCreationInputTokens;
        }
        this.current = {
            sessionId: result.session_id,
            numTurns: result.num_turns,
            durationMs: result.duration_ms,
            inputTokens,
            outputTokens,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheCreation,
            costUsd: result.total_cost_usd,
            perModel: result.modelUsage,
            toolUseCount: this.current.toolUseCount,
        };
        this.onUsage?.(this.snapshot());
    }

    /** 当前快照（防御性拷贝，避免调用方改写计量状态）。 */
    snapshot(): SessionUsageSnapshot {
        return { ...this.current, perModel: { ...this.current.perModel } };
    }

    /** 会话是否已收到 result（判别被中断未出 result 的会话）。 */
    hasResult(): boolean {
        return this.sawResult;
    }
}
