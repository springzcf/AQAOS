/**
 * agent_definitions → Claude Agent SDK 会话选项映射（T-E02-02，DDD §3.1）。
 *
 * 两段纯函数，均可离线测试：
 * - toSessionSpec：AgentDefinitionRecord + AgentContext → AgentSessionSpec
 *   （平台自有会话规格，不依赖 SDK 形状）；
 * - toSdkOptions：AgentSessionSpec + 运行时对象（AbortController/审批桥）→ SDK Options。
 *
 * 安全基线（客户端第一层限制；服务端身份/权限/预算校验仍是最终强制层）：
 * - 内建工具一律清空（tools: []）——AQAOS agents 只经平台 MCP Server 用工具；
 * - strictMcpConfig + settingSources: [] 隔离文件系统配置（.mcp.json/settings/CLAUDE.md）；
 * - 无审批桥时 permissionPrompts: "none" 失闭：任何需要提示的调用立即拒绝；
 * - 会话预算：maxBudgetUsd 由 SDK 原生熔断（error_max_budget_usd），
 *   token/工具调用/时长预算由包装层计量熔断（agent-session.ts）。
 */

import type {
    AgentDefinition as SdkAgentDefinition,
    CanUseTool,
    EffortLevel,
    McpServerConfig,
    Options,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentRoleIdSchema, type AgentContext, type AgentDefinitionRecord } from "@aqaos/domain";

/** 会话缺省模型（E03 Model Gateway 上线前的直传默认）。 */
export const DEFAULT_SESSION_MODEL = "claude-opus-5-5";

/** SDK 子进程向 API 标识宿主应用的 User-Agent 组件。 */
export const SDK_CLIENT_APP_ID = "aqaos-agent-worker/0.1.0";

/**
 * 委派内建工具的规范名（sdk.d.ts BUILTIN_TOOL_NAMES："Agent"；
 * 'Task' 是 LEGACY_TOOL_NAME_ALIASES 仍接受的旧名）。Options.agents 注册的
 * 子代理只有经它委派——tools:[] 清空内建工具时必须为委派面单独放开。
 */
export const SDK_DELEGATION_TOOL = "Agent";

/** agent_definitions.name 非法（不是 16 角色规范 id）时抛出。 */
export class AgentDefinitionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentDefinitionError";
    }
}

/** 平台会话规格：与 SDK 解耦的自有形状（映射、审计、序列化都以它为准）。 */
export interface AgentSessionSpec {
    /** 角色系统提示词（definition.prompt）。 */
    systemPrompt: string;
    model: string;
    /** MCP 工具白名单（auto-allow；会话型角色默认空 = 纯推理）。 */
    allowedTools: string[];
    /** SDK 会话最大轮数（缺省不设）。 */
    maxTurns?: number;
    /** SDK 原生成本上限（AgentContext.budget.maxModelCostUsd）。 */
    maxBudgetUsd?: number;
    /** 包装层超时（maxDurationSeconds → 毫秒）。 */
    timeoutMs?: number;
    effort?: EffortLevel;
    /** headless 一次性会话默认不持久化（QA Manager 多轮控制面强制 true，T-E02-05）。 */
    persistSession: boolean;
    /** 会话工作目录（调用方给隔离目录）。 */
    cwd: string;
    /** 平台 MCP Server 连接配置（T-E02-03 接线）。 */
    mcpServers: Record<string, McpServerConfig>;
    /** 可委派子代理定义（SDK Options.agents，T-E02-05 QA Manager 委派面）。 */
    agents?: Record<string, SdkAgentDefinition>;
    /** 恢复既有会话（SDK Options.resume，T-E02-05 多轮/Query 控制面）。 */
    resume?: string;
    /**
     * 结构化输出契约（T-E02-06 Planner）：JSON Schema → SDK
     * Options.outputFormat json_schema（模型最终消息被强制为该形状，
     * result.structured_output 携带解析结果；SDK 原生结构化输出重试）。
     */
    outputJsonSchema?: Record<string, unknown>;
}

export interface ToSessionSpecParams {
    definition: AgentDefinitionRecord;
    context: AgentContext;
    /** 平台 MCP Servers（由 worker 统一装配，T-E02-03）。 */
    mcpServers?: Record<string, McpServerConfig>;
    /** 可委派子代理（T-E02-05 QA Manager 统筹）。 */
    subagents?: Record<string, SdkAgentDefinition>;
    /** 恢复会话 id（T-E02-05 多轮；定义需 persistSession=true 才可恢复）。 */
    resumeSessionId?: string;
    /** 结构化输出 JSON Schema（T-E02-06 Planner；缺省自由文本产出）。 */
    outputJsonSchema?: Record<string, unknown>;
    /** 隔离工作目录；缺省 process.cwd()。 */
    cwd?: string;
    /** 缺省模型覆盖（测试/网关用）；最终缺省 DEFAULT_SESSION_MODEL。 */
    defaultModel?: string;
}

export function toSessionSpec(params: ToSessionSpecParams): AgentSessionSpec {
    const { definition, context } = params;
    if (!definition.enabled) {
        throw new AgentDefinitionError(
            `agent definition ${definition.name}@${definition.version} is disabled`,
        );
    }
    const role = AgentRoleIdSchema.safeParse(definition.name);
    if (!role.success) {
        throw new AgentDefinitionError(
            `agent definition name "${definition.name}" is not a canonical AgentRoleId`,
        );
    }
    return {
        systemPrompt: definition.prompt,
        model: definition.config.model ?? params.defaultModel ?? DEFAULT_SESSION_MODEL,
        allowedTools: definition.config.allowedTools ?? [],
        maxTurns: definition.config.maxTurns,
        maxBudgetUsd: context.budget.maxModelCostUsd,
        timeoutMs:
            context.budget.maxDurationSeconds !== undefined
                ? context.budget.maxDurationSeconds * 1000
                : undefined,
        effort: definition.config.effort,
        persistSession: definition.config.persistSession ?? false,
        cwd: params.cwd ?? process.cwd(),
        mcpServers: params.mcpServers ?? {},
        agents: params.subagents,
        resume: params.resumeSessionId,
        outputJsonSchema: params.outputJsonSchema,
    };
}

/** 运行时对象（不可序列化）：注入 SDK Options 的部分。 */
export interface SdkRuntime {
    abortController: AbortController;
    /** 审批桥（canUseTool，T-E03-06 接 approval_requests）；缺省失闭。 */
    canUseTool?: CanUseTool;
}

export function toSdkOptions(spec: AgentSessionSpec, runtime: SdkRuntime): Options {
    const options: Options = {
        abortController: runtime.abortController,
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        // AQAOS agents 不使用 CLI 内建文件/bash 工具——工具一律走平台 MCP Server。
        // 例外：委派面（agents）存在时放开 Agent 委派工具，否则子代理不可达
        // （T-E02-05 live 实证：缺失时模型会"叙述"委派而非真实调用）。
        tools: spec.agents !== undefined ? [SDK_DELEGATION_TOOL] : [],
        allowedTools: spec.allowedTools,
        maxTurns: spec.maxTurns,
        maxBudgetUsd: spec.maxBudgetUsd,
        effort: spec.effort,
        thinking: { type: "adaptive" },
        cwd: spec.cwd,
        mcpServers: spec.mcpServers,
        // 委派面与进度观测（T-E02-05）：agents 存在时开启子代理进度摘要。
        agents: spec.agents,
        agentProgressSummaries: spec.agents !== undefined,
        resume: spec.resume,
        // 结构化产出通道（T-E02-06 Planner）：JSON Schema 强制最终消息形状。
        outputFormat:
            spec.outputJsonSchema !== undefined
                ? { type: "json_schema", schema: spec.outputJsonSchema }
                : undefined,
        // 隔离：只认 mcpServers 选项，忽略 .mcp.json / 用户/项目配置与 CLAUDE.md。
        strictMcpConfig: true,
        settingSources: [],
        persistSession: spec.persistSession,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: SDK_CLIENT_APP_ID },
        includePartialMessages: false,
    };
    if (runtime.canUseTool !== undefined) {
        // 有审批面：默认权限模式 + canUseTool 路由（PreToolUse 审批流 T-E03-06）。
        options.permissionMode = "default";
        options.canUseTool = runtime.canUseTool;
    } else {
        // 无审批面（基座/headless）：失闭——需要提示的调用直接拒绝。
        options.permissionPrompts = "none";
    }
    return options;
}
