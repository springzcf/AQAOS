/**
 * 工具调用调度链（T-E02-03，DDD §9 调用链中间件）。
 *
 * 顺序（每一步都产生可审计的终态，绝不向上抛异常）：
 *   1. 注册表解析（canonical / SDK 名双索引）→ 未登记 failed TOOL_NOT_FOUND；
 *   2. 输入契约校验（zod strict）→ failed VALIDATION_FAILED；
 *   3. 权限判定（context.grants × spec.requiredPermissions，服务端强制层）
 *      → **denied TOOL_PERMISSION_DENIED + 审计**（T-E02-03 验收）；
 *   4. 预算钩子（T-E02-13 接缝，缺省放行）→ denied MODEL_BUDGET_EXCEEDED + 审计；
 *   5. 执行处理器（McpToolError → failed 其错误码；未知异常 → failed
 *      INTERNAL_ERROR，消息不透出堆栈）；
 *   6. 终态审计（succeeded/failed 均落一条；审计写失败不阻断结果返回）。
 *
 * 双消费同构：SDK 适配器（sdk-server.ts）与 REST 路由（apps/api）都调用
 * 本函数——权限/审计/预算语义在两个入口完全一致。
 */

import { grantsAllow, type ToolCallResult } from "@aqaos/domain";
import type { z } from "zod";
import type { ToolCallContext } from "./context.js";
import { findToolDefinition, McpToolError } from "./registry.js";
import type { McpServices, ToolAuditRecord } from "./services.js";

export interface DispatchToolCallParams {
    /** canonical 点分名（REST）或 SDK 下划线名（会话内 mcp__aqaos__qa_get_run 的工具段）。 */
    toolName: string;
    /** 原始输入（未经信任；步骤 2 强制校验）。 */
    input: unknown;
    /** 可信构造的调用上下文（context.ts）。 */
    context: ToolCallContext;
    services: McpServices;
}

function failed(toolName: string, code: string, message: string): ToolCallResult {
    return { tool: toolName, status: "failed", error: { code, message } };
}

function denied(toolName: string, code: string, message: string): ToolCallResult {
    return { tool: toolName, status: "denied", error: { code, message } };
}

/** 审计写失败绝不改变调用结果（与 apps/api 审计中间件同语义）。 */
async function auditSafe(services: McpServices, record: ToolAuditRecord): Promise<void> {
    try {
        await services.recordToolCall(record);
    } catch {
        // 宿主实现负责审计可靠性（pg 失败率极低；此处吞掉避免反向影响工具结果）。
    }
}

function firstIssueMessage(error: z.ZodError): string {
    const issue = error.issues[0];
    return issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input";
}

export async function dispatchToolCall(params: DispatchToolCallParams): Promise<ToolCallResult> {
    const { toolName, input, context, services } = params;

    // 1. 注册表解析。
    const definition = findToolDefinition(toolName);
    if (!definition) {
        return failed(toolName, "TOOL_NOT_FOUND", `tool "${toolName}" is not registered`);
    }
    const canonicalName = definition.spec.name;

    // 2. 输入契约校验。
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
        return failed(canonicalName, "VALIDATION_FAILED", firstIssueMessage(parsed.error));
    }

    // 3. 权限判定（服务端强制层；客户端白名单只是第一层）。
    if (!grantsAllow(context.grants, definition.spec.requiredPermissions)) {
        const missing = definition.spec.requiredPermissions.filter(
            (permission) => !context.grants.includes(permission),
        );
        const message = `role "${context.role}" lacks ${missing.join(", ")}`;
        await auditSafe(services, {
            organizationId: context.organizationId,
            toolName: canonicalName,
            status: "denied",
            errorCode: "TOOL_PERMISSION_DENIED",
            source: context.source,
            role: context.role,
            userId: context.userId,
            agentName: context.agentName,
            runId: context.runId,
            message,
        });
        return denied(canonicalName, "TOOL_PERMISSION_DENIED", message);
    }

    // 4. 预算钩子（T-E02-13 接缝；缺省放行）。
    if (services.checkToolBudget) {
        const budget = await services.checkToolBudget(context, canonicalName);
        if (!budget.allowed) {
            const message = budget.reason ?? "run budget exhausted";
            await auditSafe(services, {
                organizationId: context.organizationId,
                toolName: canonicalName,
                status: "denied",
                errorCode: "MODEL_BUDGET_EXCEEDED",
                source: context.source,
                role: context.role,
                userId: context.userId,
                agentName: context.agentName,
                runId: context.runId,
                message,
            });
            return denied(canonicalName, "MODEL_BUDGET_EXCEEDED", message);
        }
    }

    // 5. 执行（处理器异常 → 结构化 failed，不向上抛）。
    try {
        const data = await definition.handler(parsed.data, services, context);
        const result: ToolCallResult = { tool: canonicalName, status: "succeeded", data };
        await auditSafe(services, {
            organizationId: context.organizationId,
            toolName: canonicalName,
            status: "succeeded",
            source: context.source,
            role: context.role,
            userId: context.userId,
            agentName: context.agentName,
            runId: context.runId,
        });
        return result;
    } catch (error) {
        const code = error instanceof McpToolError ? error.code : "INTERNAL_ERROR";
        // 内部异常只透出稳定消息，不泄漏堆栈/驱动细节。
        const message = error instanceof Error ? error.message : "tool execution failed";
        const safeMessage = code === "INTERNAL_ERROR" ? "tool execution failed" : message;
        await auditSafe(services, {
            organizationId: context.organizationId,
            toolName: canonicalName,
            status: "failed",
            errorCode: code,
            source: context.source,
            role: context.role,
            userId: context.userId,
            agentName: context.agentName,
            runId: context.runId,
            message: safeMessage,
        });
        return failed(canonicalName, code, safeMessage);
    }
}
