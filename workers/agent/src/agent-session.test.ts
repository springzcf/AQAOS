/**
 * runAgentSession 全管线回归（T-E02-02）：用注入 queryFn 的假 SDK 消息流
 * 驱动——不触网、可在 CI 复跑。
 *
 * 假消息只携带包装层实际读取的字段（sdk.d.ts 权威形状的最小子集），
 * 经 `as unknown as SDKMessage` 收窄进联合类型；字段名以 0.3.332 为准。
 * 真 SDK 路径由 live-session.test.ts（AQAOS_AGENT_SDK_LIVE=1 门控）验收。
 */

import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext, AgentDefinitionRecord } from "@aqaos/domain";
import { runAgentSession, type SessionQueryFn } from "./agent-session.js";

const UUID = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
const UUID2 = "9e2e120d-08a2-4fc4-a04e-efd909c7577f";
const SESSION_ID = "6f1d2c34-0a91-4f0b-9d3e-2a7c8e5b1d01";

const definition: AgentDefinitionRecord = {
    id: UUID2,
    name: "product-analyst",
    version: "1.0.0",
    promptVersion: "1",
    prompt: "You are the AQAOS Product Analyst.",
    config: {},
    enabled: true,
};

function makeContext(overrides?: Partial<AgentContext["budget"]>): AgentContext {
    return {
        runId: UUID,
        applicationId: UUID2,
        environmentId: UUID,
        objective: "冒烟验证登录主流程",
        budget: {
            maxTokens: 1_000_000,
            maxModelCostUsd: 5,
            maxDurationSeconds: 600,
            ...overrides,
        },
        permissions: [],
        traceId: "trace-1",
    };
}

function assistantMessage(toolUses: number): SDKMessage {
    const content = Array.from({ length: toolUses }, () => ({
        type: "tool_use",
        id: "toolu_1",
        name: "mcp__aqaos__navigate",
        input: {},
    }));
    return {
        type: "assistant",
        message: { role: "assistant", content, stop_reason: null, usage: {} },
        parent_tool_use_id: null,
        uuid: UUID,
        session_id: SESSION_ID,
    } as unknown as SDKMessage;
}

interface ResultOverrides {
    subtype?: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
    isError?: boolean;
    resultText?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    errors?: string[];
    structuredOutput?: unknown;
}

function resultMessage(overrides: ResultOverrides = {}): SDKMessage {
    const {
        subtype = "success",
        isError = false,
        resultText = "done",
        inputTokens = 500,
        outputTokens = 300,
        costUsd = 0.01,
        errors = [],
        structuredOutput,
    } = overrides;
    return {
        type: "result",
        subtype,
        is_error: isError,
        result: resultText,
        structured_output: structuredOutput,
        duration_ms: 1200,
        duration_api_ms: 900,
        num_turns: 1,
        total_cost_usd: costUsd,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        modelUsage: {
            "claude-opus-5-5": {
                inputTokens,
                outputTokens,
                cacheReadInputTokens: 100,
                cacheCreationInputTokens: 50,
                webSearchRequests: 0,
                costUSD: costUsd,
                contextWindow: 1_000_000,
                maxOutputTokens: 128_000,
            },
        },
        permission_denials: [],
        errors,
        uuid: UUID,
        session_id: SESSION_ID,
    } as unknown as SDKMessage;
}

/** 收集 queryFn 收到的 options（断言映射贯通）。 */
function recordingQueryFn(messages: SDKMessage[]): {
    queryFn: SessionQueryFn;
    prompt: () => string;
    model: () => string | undefined;
} {
    let lastPrompt = "";
    let lastModel: string | undefined;
    const queryFn: SessionQueryFn = ({ prompt, options }) => {
        lastPrompt = prompt;
        lastModel = options?.model;
        return (async function* () {
            for (const message of messages) {
                yield message;
            }
        })();
    };
    return { queryFn, prompt: () => lastPrompt, model: () => lastModel };
}

describe("runAgentSession：完成与计量", () => {
    it("success 流：completed + usage 计量（modelUsage 口径）+ onUsage/onMessage 回报", async () => {
        const usageCallbacks: number[] = [];
        const seen: SDKMessage[] = [];
        const messages = [
            assistantMessage(2),
            resultMessage({
                inputTokens: 500,
                outputTokens: 300,
                costUsd: 0.01,
                structuredOutput: { pages: 3 },
            }),
        ];
        const { queryFn, prompt, model } = recordingQueryFn(messages);
        const outcome = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "探索 https://example.com 的登录流程",
            queryFn,
            onUsage: (snapshot) => usageCallbacks.push(snapshot.inputTokens),
            onMessage: (message) => seen.push(message),
        });
        expect(outcome.status).toBe("completed");
        expect(outcome.resultText).toBe("done");
        expect(outcome.structuredOutput).toEqual({ pages: 3 });
        expect(outcome.sessionId).toBe(SESSION_ID);
        expect(outcome.usage).toMatchObject({
            inputTokens: 500,
            outputTokens: 300,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
            costUsd: 0.01,
            numTurns: 1,
            durationMs: 1200,
            toolUseCount: 2,
        });
        expect(outcome.usage.perModel["claude-opus-5-5"]?.inputTokens).toBe(500);
        expect(usageCallbacks).toEqual([500]);
        expect(seen).toHaveLength(2);
        // 映射贯通：prompt 原样进入 query；definition 未配模型 → 默认模型。
        expect(prompt()).toBe("探索 https://example.com 的登录流程");
        expect(model()).toBe("claude-opus-5-5");
    });

    it("result.is_error → failed；error_max_turns → max-turns；error_max_budget_usd → budget-exceeded", async () => {
        const errored = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "p",
            queryFn: recordingQueryFn([
                resultMessage({ isError: true, resultText: "api down", errors: ["api_error"] }),
            ]).queryFn,
        });
        expect(errored.status).toBe("failed");
        // is_error 的 success 变体：错误文本在 result 字段；errors 数组仅在 error 变体。
        expect(errored.resultText).toBe("api down");
        expect(errored.errors).toEqual([]);

        const maxTurns = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "p",
            queryFn: recordingQueryFn([resultMessage({ subtype: "error_max_turns" })]).queryFn,
        });
        expect(maxTurns.status).toBe("max-turns");

        const overBudget = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "p",
            queryFn: recordingQueryFn([
                resultMessage({ subtype: "error_max_budget_usd", errors: ["budget"] }),
            ]).queryFn,
        });
        expect(overBudget.status).toBe("budget-exceeded");
        expect(overBudget.errors).toEqual(["budget"]);
    });

    it("流异常/空流 → failed（不抛出）", async () => {
        const boom: SessionQueryFn = () =>
            (async function* () {
                throw new Error("spawn failed");
            })();
        const outcome = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "p",
            queryFn: boom,
        });
        expect(outcome.status).toBe("failed");
        expect(outcome.errors).toContain("spawn failed");

        const empty: SessionQueryFn = () => (async function* () {})();
        const emptyOutcome = await runAgentSession({
            definition,
            context: makeContext(),
            prompt: "p",
            queryFn: empty,
        });
        expect(emptyOutcome.status).toBe("failed");
        expect(emptyOutcome.errors[0]).toContain("without a result message");
    });
});

describe("runAgentSession：取消与包装层预算熔断", () => {
    it("外部 AbortSignal → aborted（reason=external）", async () => {
        const external = new AbortController();
        const hang: SessionQueryFn = ({ options }) =>
            (async function* () {
                yield assistantMessage(0);
                await new Promise<never>((_resolve, reject) => {
                    const guard = setTimeout(() => reject(new Error("test runaway")), 5_000);
                    options?.abortController?.signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(guard);
                            const error = new Error("aborted");
                            error.name = "AbortError";
                            reject(error);
                        },
                        { once: true },
                    );
                });
            })();
        setTimeout(() => external.abort(), 20);
        const outcome = await runAgentSession({
            definition,
            context: { ...makeContext(), signal: external.signal },
            prompt: "p",
            queryFn: hang,
        });
        expect(outcome.status).toBe("aborted");
        expect(outcome.abortReason).toBe("external");
    });

    it("token 预算：result 后超限 → budget-exceeded（reason=token-budget）", async () => {
        const outcome = await runAgentSession({
            definition,
            context: makeContext({ maxTokens: 600 }), // result 报 500+300=800
            prompt: "p",
            queryFn: recordingQueryFn([resultMessage({ inputTokens: 500, outputTokens: 300 })])
                .queryFn,
        });
        expect(outcome.status).toBe("budget-exceeded");
        expect(outcome.abortReason).toBe("token-budget");
        expect(outcome.errors.join(" ")).toContain("token-budget");
    });

    it("工具调用预算：assistant 帧即熔断（无需等 result）", async () => {
        const abortedStream: SessionQueryFn = () =>
            (async function* () {
                yield assistantMessage(2); // maxToolCalls=1 → 立即超
            })();
        const outcome = await runAgentSession({
            definition,
            context: makeContext({ maxToolCalls: 1 }),
            prompt: "p",
            queryFn: abortedStream,
        });
        expect(outcome.status).toBe("budget-exceeded");
        expect(outcome.abortReason).toBe("tool-call-budget");
        expect(outcome.usage.toolUseCount).toBe(2);
    });

    it("时长预算：超时 abort → budget-exceeded（reason=timeout）", { timeout: 8_000 }, async () => {
        const hang: SessionQueryFn = ({ options }) =>
            (async function* () {
                yield assistantMessage(0);
                await new Promise<never>((_resolve, reject) => {
                    const guard = setTimeout(() => reject(new Error("test runaway")), 5_000);
                    options?.abortController?.signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(guard);
                            const error = new Error("aborted");
                            error.name = "AbortError";
                            reject(error);
                        },
                        { once: true },
                    );
                });
            })();
        const outcome = await runAgentSession({
            definition,
            context: makeContext({ maxDurationSeconds: 1 }), // 1s 超时
            prompt: "p",
            queryFn: hang,
        });
        expect(outcome.status).toBe("budget-exceeded");
        expect(outcome.abortReason).toBe("timeout");
    });
});
