/**
 * Claude Agent SDK 进程内 MCP Server 适配器（T-E02-03，DDD §9 对内消费）。
 *
 * 每次 agent 会话创建一个实例：调用上下文在构造时绑定（身份/Run 绑定
 * 来自 worker 已验证的 agent_runs 行，不是客户端声明）——会话内模型经
 * mcp__aqaos__<tool> 调用工具，全部经 @aqaos/mcp dispatchToolCall 同一
 * 调度链（权限/预算/审计），与 REST 消费语义一致。
 *
 * 工具名满足 MCP 约束 ^[a-zA-Z0-9_-]{1,64}$：点分分隔符转下划线
 * （qa.get_run → qa_get_run）；注册表双索引接受两种形态。
 *
 * 本文件是 Agent SDK 的宿主绑定点（packages/mcp 保持传输无关）：
 * put it in the TOP-LEVEL Options.mcpServers（勿放 agent 子代理内——
 * SDK 对子代理内传实例已标记废弃）。
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallResult } from "@aqaos/domain";
import {
    dispatchToolCall,
    TOOL_REGISTRY,
    toSdkToolName,
    type McpServices,
    type ToolCallContext,
} from "@aqaos/mcp";
// SDK 的 AnyZodRawShape 是 zod3/v4 联合——显式锁定 v3 形态，避免联合推断
// 触发 TS2589（zod@3.25.76 自带 ./v3 子路径）。
import type { ZodRawShape } from "zod/v3";

export const SDK_MCP_SERVER_NAME = "aqaos";
export const SDK_MCP_SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = [
    "AQAOS platform QA tools (read-only subset in base milestone).",
    "All calls are permission-checked and audited server-side.",
].join(" ");

/** 统一结果 → MCP CallToolResult：文本块 + structuredContent；denied/failed 置 isError。 */
export function toCallToolResult(result: ToolCallResult): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.status !== "succeeded",
    };
}

export interface CreateAqaosSdkMcpServerParams {
    context: ToolCallContext;
    services: McpServices;
    serverName?: string;
    /** 每次工具调用的硬性墙钟上限（ms；<1000 被 SDK 忽略）。 */
    timeoutMs?: number;
}

/**
 * 创建绑定上下文的进程内 MCP Server 配置（McpSdkServerConfigWithInstance，
 * 含 .instance）。传入 runAgentSession 的 mcpServers 参数：
 *   { aqaos: createAqaosSdkMcpServer({ context, services }) }
 */
export function createAqaosSdkMcpServer(params: CreateAqaosSdkMcpServerParams): McpServerConfig {
    const { context, services } = params;
    return createSdkMcpServer({
        name: params.serverName ?? SDK_MCP_SERVER_NAME,
        version: SDK_MCP_SERVER_VERSION,
        instructions: SERVER_INSTRUCTIONS,
        timeout: params.timeoutMs,
        tools: TOOL_REGISTRY.map((definition) =>
            tool<ZodRawShape>(
                toSdkToolName(definition.spec.name),
                definition.description,
                // 双重断言：SDK 的 ZodRawShape 来自其嵌套 zod4 的 v3 兼容层，
                // 与 root zod3 classic 直接比较会触发 TS2589；运行时兼容性
                // 由 mcp-live.test.ts 实证（SDK 声明同时支持 zod3/zod4 schema）。
                definition.inputShape as unknown as ZodRawShape,
                // SDK 传入的 args 已按 shape 解析；dispatch 仍做 strict 校验
                //（同 REST 路径，单一校验语义）。
                async (args) =>
                    toCallToolResult(
                        await dispatchToolCall({
                            toolName: definition.spec.name,
                            input: args,
                            context,
                            services,
                        }),
                    ),
            ),
        ),
    });
}
