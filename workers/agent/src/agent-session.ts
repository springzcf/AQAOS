/**
 * Agent 会话运行器（T-E02-02 验收核心）：在 agent-worker 内 headless 跑通
 * 一次 Claude Agent SDK 会话并全程计量。
 *
 * 职责边界：
 * - 会话选项来自 toSessionSpec/toSdkOptions（agent_definitions 映射）；
 * - 取消：外部 AbortSignal（AgentContext.signal，暂停/恢复/终止传导）+
 *   时长预算超时，汇入一个 AbortController 传给 SDK；
 * - 预算熔断：成本走 SDK 原生 maxBudgetUsd（error_max_budget_usd）；
 *   token/工具调用数由包装层在每帧计量后检查并 abort
 *   （token 口径 = input + output，与 AgentBudget.maxTokens 对齐）；
 * - 计量：SessionMeter 聚合 result.modelUsage，每轮 result 触发 onUsage 回报，
 *   结束时随 AgentSessionOutcome 返回最终快照（T-E02-13 落 model_invocations）；
 * - queryFn 是注入 seam：单测/回归注入假流，生产用 SDK query()。
 *
 * 本运行器承载单次 query 调用；多轮续会（resumeSessionId）与子代理委派
 * （subagents → SDK Options.agents）随 T-E02-05 QA Manager 落地——
 * 会话级"暂停/终止"= 外部 signal 中断 query，"恢复"= 以 sessionId 续会。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    AgentDefinition as SdkAgentDefinition,
    CanUseTool,
    McpServerConfig,
    Options,
    SDKMessage,
    SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext, AgentDefinitionRecord } from "@aqaos/domain";
import { SessionMeter, type SessionUsageSnapshot } from "./session-meter.js";
import { toSdkOptions, toSessionSpec } from "./session-options.js";

/** 会话终态（与 AgentResultStatus 解耦：会话层先有终态，AgentResult 解析随角色任务落地）。 */
export type AgentSessionStatus =
    | "completed" // result.subtype=success 且 is_error=false
    | "failed" // error_during_execution / is_error / 运行期异常
    | "max-turns" // error_max_turns
    | "budget-exceeded" // error_max_budget_usd 或包装层 token/工具调用/时长熔断
    | "aborted"; // 外部 AbortSignal（人工终止/Run 取消）

/** 包装层熔断来源（status=budget-exceeded/aborted 时区分维度）。 */
export type SessionAbortReason = "external" | "timeout" | "token-budget" | "tool-call-budget";

export interface AgentSessionOutcome {
    status: AgentSessionStatus;
    /** result.result 文本（失败/熔断时为错误文本）；中断无 result 时为空串。 */
    resultText: string;
    structuredOutput?: unknown;
    usage: SessionUsageSnapshot;
    sessionId?: string;
    errors: string[];
    abortReason?: SessionAbortReason;
}

/** SDK query() 的注入 seam（生产默认真 SDK；测试注入假消息流）。 */
export type SessionQueryFn = (params: {
    prompt: string;
    options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface RunAgentSessionParams {
    definition: AgentDefinitionRecord;
    context: AgentContext;
    /** 任务输入文本（AgentInput 的会话形态；结构化解析随角色任务落地）。 */
    prompt: string;
    /** 平台 MCP Servers（T-E02-03 接线）。 */
    mcpServers?: Record<string, McpServerConfig>;
    /** 可委派子代理（T-E02-05 QA Manager；presence 开启进度摘要事件）。 */
    subagents?: Record<string, SdkAgentDefinition>;
    /** 恢复既有会话（T-E02-05 多轮/Query 控制面；需 persistSession=true）。 */
    resumeSessionId?: string;
    /** 结构化输出 JSON Schema（T-E02-06 Planner；result.structured_output 承载）。 */
    outputJsonSchema?: Record<string, unknown>;
    /** 审批桥（canUseTool → T-E03-06 approval_requests）；缺省失闭。 */
    approval?: CanUseTool;
    /** 每轮 usage 快照回报（T-E02-13 实时上报挂点）。 */
    onUsage?: (snapshot: SessionUsageSnapshot) => void;
    /** 原始 SDK 消息旁路（会话留痕/工具调用落库随 T-E02-13）。 */
    onMessage?: (message: SDKMessage) => void;
    cwd?: string;
    defaultModel?: string;
    queryFn?: SessionQueryFn;
}

function outcomeFromResult(
    result: SDKResultMessage,
    usage: SessionUsageSnapshot,
): AgentSessionOutcome {
    // errors 只在 error 变体上（SDKResultSuccess 无此字段）。
    const base = {
        usage,
        sessionId: result.session_id,
        errors: result.subtype === "success" ? [] : [...result.errors],
    };
    if (result.subtype === "success") {
        if (result.is_error) {
            return { ...base, status: "failed", resultText: result.result };
        }
        return {
            ...base,
            status: "completed",
            resultText: result.result,
            structuredOutput: result.structured_output,
        };
    }
    switch (result.subtype) {
        case "error_max_turns":
            return { ...base, status: "max-turns", resultText: "" };
        case "error_max_budget_usd":
            return { ...base, status: "budget-exceeded", resultText: "" };
        default:
            return { ...base, status: "failed", resultText: "" };
    }
}

/**
 * 跑一次 headless agent 会话。永不抛出（运行期异常折叠为 status=failed），
 * 调用方以 AgentSessionOutcome 决定重试/熔断/记账。
 */
export async function runAgentSession(params: RunAgentSessionParams): Promise<AgentSessionOutcome> {
    const spec = toSessionSpec({
        definition: params.definition,
        context: params.context,
        mcpServers: params.mcpServers,
        subagents: params.subagents,
        resumeSessionId: params.resumeSessionId,
        outputJsonSchema: params.outputJsonSchema,
        cwd: params.cwd,
        defaultModel: params.defaultModel,
    });

    const controller = new AbortController();
    let abortReason: SessionAbortReason | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const detachExternal: (() => void) | undefined = params.context.signal
        ? (() => {
              const forward = () => {
                  abortReason = "external";
                  controller.abort("external");
              };
              params.context.signal?.addEventListener("abort", forward, { once: true });
              return () => params.context.signal?.removeEventListener("abort", forward);
          })()
        : undefined;
    if (spec.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
            abortReason = "timeout";
            controller.abort("timeout");
        }, spec.timeoutMs);
    }

    const meter = new SessionMeter(params.onUsage);
    /** 每帧计量后检查包装层预算（token/工具调用）；计量回调先于预算检查。 */
    const checkBudgets = () => {
        if (abortReason !== undefined) {
            return;
        }
        const snapshot = meter.snapshot();
        const { budget } = params.context;
        if (budget.maxTokens <= snapshot.inputTokens + snapshot.outputTokens) {
            abortReason = "token-budget";
            controller.abort("token-budget");
        } else if (
            budget.maxToolCalls !== undefined &&
            snapshot.toolUseCount >= budget.maxToolCalls
        ) {
            abortReason = "tool-call-budget";
            controller.abort("tool-call-budget");
        }
    };

    const queryFn = params.queryFn ?? query;
    const options = toSdkOptions(spec, {
        abortController: controller,
        canUseTool: params.approval,
    });

    let lastResult: SDKResultMessage | undefined;
    let failure: string | undefined;
    let wasAborted = false;

    try {
        const stream = queryFn({ prompt: params.prompt, options });
        for await (const message of stream) {
            params.onMessage?.(message);
            meter.observe(message);
            checkBudgets();
            if (message.type === "result") {
                lastResult = message;
            }
        }
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            wasAborted = true;
        } else {
            failure = error instanceof Error ? error.message : String(error);
        }
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
        detachExternal?.();
    }

    const usage = meter.snapshot();

    // 有 result：终态以 result 为准；包装层熔断（token/工具/时长）即使 SDK 已
    // 优雅给出 result 也要升格为 budget-exceeded，否则预算形同虚设。
    if (lastResult !== undefined) {
        const outcome = outcomeFromResult(lastResult, usage);
        if (
            outcome.status === "completed" &&
            (abortReason === "token-budget" ||
                abortReason === "tool-call-budget" ||
                abortReason === "timeout")
        ) {
            return {
                ...outcome,
                status: "budget-exceeded",
                abortReason,
                errors: [...outcome.errors, `session aborted: ${abortReason} guard tripped`],
            };
        }
        return outcome;
    }
    // 无 result：外部终止 → aborted；时长/token/工具熔断 → budget-exceeded；
    // SDK AbortError 无来源 → aborted；其余 → failed。
    if (abortReason !== undefined) {
        return {
            status: abortReason === "external" ? "aborted" : "budget-exceeded",
            resultText: "",
            usage,
            errors: failure !== undefined ? [failure] : [`session aborted: ${abortReason}`],
            abortReason,
        };
    }
    if (wasAborted) {
        return {
            status: "aborted",
            resultText: "",
            usage,
            errors: failure !== undefined ? [failure] : [],
        };
    }
    return {
        status: "failed",
        resultText: "",
        usage,
        errors: failure !== undefined ? [failure] : ["session ended without a result message"],
    };
}
