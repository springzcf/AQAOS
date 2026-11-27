/**
 * @aqaos/mcp —— MCP Tool Server 基座（T-E02-03，DDD §9）。
 *
 * 传输无关的核心（本包零 pg / 零 Agent SDK 依赖，数据经 McpServices 注入）：
 * - context：可信调用上下文构造（agent-session / rest 双源，含 REST 阶梯）；
 * - registry：8 域工具注册表（基座实装 4 个 DB 工具，目录全量在 domain）；
 * - dispatch：调用链中间件（权限→预算→执行→审计，双消费唯一入口）；
 * - services：宿主实现的接口契约（apps/api 提供 pg 版）。
 *
 * 消费方：
 * - workers/agent：src/mcp-server.ts 用 createSdkMcpServer 包装本包注册表
 *   → Options.mcpServers（会话内 mcp__aqaos__<tool>）；
 * - apps/api：POST /api/v1/mcp/tools/:toolName → dispatchToolCall（对外 REST）。
 */

export {
    agentToolCallContext,
    restToolCallContext,
    restToolGrants,
    type AgentToolCallContextParams,
    type RestToolCallContextParams,
    type ToolCallContext,
    type ToolCallSource,
} from "./context.js";
export { dispatchToolCall, type DispatchToolCallParams } from "./dispatch.js";
export {
    defineTool,
    findToolDefinition,
    McpToolError,
    toSdkToolName,
    TOOL_REGISTRY,
    type ToolDefinition,
} from "./registry.js";
export type {
    McpBugSummary,
    McpKnowledgeEdge,
    McpKnowledgeEdgeInput,
    McpKnowledgeNode,
    McpKnowledgeNodeInput,
    McpServices,
    ToolAuditRecord,
} from "./services.js";
