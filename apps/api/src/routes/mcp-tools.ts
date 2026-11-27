/**
 * POST /api/v1/mcp/tools/:toolName（T-E02-03，DDD §9 对外 REST 消费）。
 *
 * 平台 MCP Tool Server 的 REST 适配器：上下文从已验证 JWT/API Token +
 * 组织成员关系构造（restToolCallContext），调度链与 agent 会话内消费
 * 完全同构（dispatchToolCall：权限→预算→执行→审计）。
 *
 * REST 阶梯：viewer 零工具（403 + 审计）、member 全域只读、admin/owner
 * 全权。denied → 403 TOOL_PERMISSION_DENIED / 429 MODEL_BUDGET_EXCEEDED；
 * failed → 400 VALIDATION_FAILED / 404 NOT_FOUND / 500 INTERNAL_ERROR。
 */

import { dispatchToolCall, restToolCallContext, type McpServices } from "@aqaos/mcp";
import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import { createPgMcpServices } from "../lib/mcp-services.js";
import type { DbPool } from "../lib/db.js";
import { ApiError, type ErrorCode } from "../lib/errors.js";

export interface McpToolRoutesOptions extends FastifyPluginOptions {
    db?: DbPool;
}

/** 工具层错误码 → 统一错误模型（TOOL_NOT_FOUND 收敛为 NOT_FOUND）。 */
function toApiErrorCode(code: string): ErrorCode {
    switch (code) {
        case "VALIDATION_FAILED":
            return "VALIDATION_FAILED";
        case "UNKNOWN_NODE_KEY":
        case "DUPLICATE_NODE_KEY":
            // 写入批次合同违约（悬空边/重复键）属入参错误，非内部故障。
            return "VALIDATION_FAILED";
        case "NOT_FOUND":
        case "TOOL_NOT_FOUND":
            return "NOT_FOUND";
        case "TOOL_PERMISSION_DENIED":
            return "TOOL_PERMISSION_DENIED";
        case "MODEL_BUDGET_EXCEEDED":
            return "MODEL_BUDGET_EXCEEDED";
        default:
            return "INTERNAL_ERROR";
    }
}

const bodySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        runId: { type: "string", description: "Run 绑定（可选，写入审计上下文）" },
        input: {
            type: "object",
            description: "工具入参（各工具契约由 MCP 注册表 zod 校验）",
        },
    },
} as const;

export const mcpToolRoutes: FastifyPluginAsync<McpToolRoutesOptions> = async (app, options) => {
    const services: McpServices | undefined = options.db
        ? createPgMcpServices(options.db)
        : undefined;

    app.post(
        "/api/v1/mcp/tools/:toolName",
        {
            schema: { tags: ["mcp"], body: bodySchema },
            config: { auth: { requireAuth: true } },
        },
        async (request) => {
            const user = request.user;
            if (!services || !user) {
                throw new ApiError("NOT_IMPLEMENTED", "MCP tool calls require database");
            }
            if (!user.organizationId) {
                throw new ApiError(
                    "PERMISSION_DENIED",
                    "MCP tool calls require an organization membership",
                );
            }

            const { toolName } = request.params as { toolName: string };
            const body = (request.body ?? {}) as { runId?: string; input?: unknown };

            // 角色为 null（无成员关系/非法降级）→ viewer 阶梯 → 零工具。
            const context = restToolCallContext({
                organizationId: user.organizationId,
                membershipRole: user.role ?? "viewer",
                userId: user.userId,
                runId: body.runId,
            });

            const result = await dispatchToolCall({
                toolName,
                input: body.input ?? {},
                context,
                services,
            });

            if (result.status !== "succeeded" && result.error) {
                throw new ApiError(toApiErrorCode(result.error.code), result.error.message, {
                    details: { tool: result.tool },
                });
            }
            return { result };
        },
    );
};
