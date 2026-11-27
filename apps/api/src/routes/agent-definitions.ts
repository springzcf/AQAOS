/**
 * /api/v1/agent-definitions 管理 API（T-E02-04，DDD §3.3）。
 *
 * 16 角色 Agent 定义与 prompt 的版本化管理面（append-only 流水）：
 * - GET  /api/v1/agent-definitions            每角色最新版（member 读）
 * - GET  /api/v1/agent-definitions/:name/versions  全版本历史（member 读）
 * - POST /api/v1/agent-definitions            追加新版本（admin 写；
 *   prompt 变更必须携带新 prompt_version；空转版本拒绝）
 * - POST /api/v1/agent-definitions/:name/rollback 回滚（admin 写；
 *   复制旧行 (prompt, prompt_version) 成对落新行——历史永不改删）
 *
 * 策略内核在 @aqaos/domain checkPromptVersionPolicy（纯函数，域测试守护）；
 * 行分配 version = 既有最大整数 +1（UNIQUE(name, version) 兜底并发）。
 * 审计中间件自动留痕（POST → create / agent-definitions，403 → denied）。
 */

import {
    AGENT_ROLE_IDS,
    AgentDefinitionConfigSchema,
    checkPromptVersionPolicy,
    type AgentDefinitionConfig,
} from "@aqaos/domain";
import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import type { DbPool } from "../lib/db.js";
import {
    insertAgentDefinition,
    listAgentDefinitionVersions,
    listLatestAgentDefinitions,
    nextVersionNumber,
} from "../lib/agent-definition-store.js";
import { ApiError } from "../lib/errors.js";

export interface AgentDefinitionRoutesOptions extends FastifyPluginOptions {
    db?: DbPool;
}

/** 管理面返回的版本行投影（OpenAPI 文档用；字段即 AgentDefinitionRecord）。 */
const definitionItemSchema = {
    type: "object",
    properties: {
        id: { type: "string" },
        name: { type: "string" },
        version: { type: "string" },
        promptVersion: { type: "string" },
        prompt: { type: "string" },
        // additionalProperties 放行会话配置子字段——响应序列化对未声明字段会丢弃。
        config: { type: "object", additionalProperties: true },
        enabled: { type: "boolean" },
        createdAt: { type: "string" },
        createdBy: { type: ["string", "null"] },
    },
} as const;

const listResponseSchema = {
    type: "object",
    properties: {
        items: { type: "array", items: definitionItemSchema },
        total: { type: "integer" },
    },
} as const;

const createResponseSchema = {
    type: "object",
    properties: {
        definition: definitionItemSchema,
    },
} as const;

/** POST 新版本请求体（JSON Schema 先验，zod 契约二验）。 */
const createBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "prompt", "promptVersion"],
    properties: {
        name: { type: "string", enum: [...AGENT_ROLE_IDS], description: "角色规范 id（16 角色）" },
        prompt: {
            type: "string",
            minLength: 1,
            maxLength: 20000,
            description: "新版本角色系统提示词本体",
        },
        promptVersion: {
            type: "string",
            pattern: "^\\d+\\.\\d+\\.\\d+$",
            description: "prompt 语义标签（semver；prompt 变更必须换新标签）",
        },
        config: {
            type: "object",
            additionalProperties: false,
            description: "会话配置（模型/allowedTools/maxTurns/effort/persistSession）",
            properties: {
                model: { type: "string", minLength: 1 },
                allowedTools: { type: "array", items: { type: "string", minLength: 1 } },
                maxTurns: { type: "integer", minimum: 1 },
                effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
                persistSession: { type: "boolean" },
            },
        },
        enabled: { type: "boolean", description: "缺省 true" },
    },
} as const;

const rollbackBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["toVersion"],
    properties: {
        toVersion: {
            type: "string",
            minLength: 1,
            maxLength: 32,
            description: "回滚目标行序号（version 列值，非 prompt_version）",
        },
    },
} as const;

/** 角色 id 规范性校验（路径与请求体双入口共用）。 */
function assertCanonicalRole(name: string): void {
    if (!(AGENT_ROLE_IDS as readonly string[]).includes(name)) {
        throw new ApiError("VALIDATION_FAILED", `"${name}" is not a canonical agent role id`);
    }
}

/** 策略违背 → 400（策略语义见 domain checkPromptVersionPolicy 文档）。 */
function throwPolicyViolation(code: string, message: string): never {
    throw new ApiError("VALIDATION_FAILED", message, { details: { policy: code } });
}

export const agentDefinitionRoutes: FastifyPluginAsync<AgentDefinitionRoutesOptions> = async (
    app,
    options,
) => {
    const { db } = options;

    app.get(
        "/api/v1/agent-definitions",
        {
            schema: { tags: ["agents"], response: { 200: listResponseSchema } },
            config: { auth: { requireAuth: true, minRole: "member" } },
        },
        async () => {
            if (!db) {
                throw new ApiError("NOT_IMPLEMENTED", "Agent definitions require database");
            }
            const items = await listLatestAgentDefinitions(db);
            return { items, total: items.length };
        },
    );

    app.get(
        "/api/v1/agent-definitions/:name/versions",
        {
            schema: { tags: ["agents"], response: { 200: listResponseSchema } },
            config: { auth: { requireAuth: true, minRole: "member" } },
        },
        async (request) => {
            if (!db) {
                throw new ApiError("NOT_IMPLEMENTED", "Agent definitions require database");
            }
            const { name } = request.params as { name: string };
            assertCanonicalRole(name);
            const history = await listAgentDefinitionVersions(db, name);
            if (history.length === 0) {
                throw new ApiError("NOT_FOUND", `agent "${name}" has no versions`);
            }
            // 展示序：新→旧（存储层返回旧→新，策略内核依赖该序）。
            return { items: [...history].reverse(), total: history.length };
        },
    );

    app.post(
        "/api/v1/agent-definitions",
        {
            schema: {
                tags: ["agents"],
                body: createBodySchema,
                response: { 201: createResponseSchema },
            },
            config: { requireIdempotencyKey: true, auth: { requireAuth: true, minRole: "admin" } },
        },
        async (request, reply) => {
            if (!db || !request.user) {
                throw new ApiError("NOT_IMPLEMENTED", "Agent definitions require database");
            }
            const body = request.body as {
                name: string;
                prompt: string;
                promptVersion: string;
                config?: unknown;
                enabled?: boolean;
            };
            assertCanonicalRole(body.name);

            const configResult = AgentDefinitionConfigSchema.safeParse(body.config ?? {});
            if (!configResult.success) {
                throw new ApiError("VALIDATION_FAILED", "invalid agent definition config", {
                    details: {
                        issues: configResult.error.issues.map((issue) => issue.path.join(".")),
                    },
                });
            }
            const config: AgentDefinitionConfig = configResult.data;
            const enabled = body.enabled ?? true;

            const history = await listAgentDefinitionVersions(db, body.name);
            const violation = checkPromptVersionPolicy(
                history.map((record) => ({
                    prompt: record.prompt,
                    promptVersion: record.promptVersion,
                    config: record.config,
                    enabled: record.enabled,
                })),
                { prompt: body.prompt, promptVersion: body.promptVersion, config, enabled },
            );
            if (violation !== null) {
                throwPolicyViolation(violation.code, violation.message);
            }

            const definition = await insertAgentDefinition(db, {
                name: body.name,
                version: nextVersionNumber(history),
                promptVersion: body.promptVersion,
                prompt: body.prompt,
                config,
                enabled,
                createdBy: request.user.userId,
            });
            return reply.code(201).send({ definition });
        },
    );

    app.post(
        "/api/v1/agent-definitions/:name/rollback",
        {
            schema: {
                tags: ["agents"],
                body: rollbackBodySchema,
                response: { 201: createResponseSchema },
            },
            config: { requireIdempotencyKey: true, auth: { requireAuth: true, minRole: "admin" } },
        },
        async (request, reply) => {
            if (!db || !request.user) {
                throw new ApiError("NOT_IMPLEMENTED", "Agent definitions require database");
            }
            const { name } = request.params as { name: string };
            const body = request.body as { toVersion: string };
            assertCanonicalRole(name);

            const history = await listAgentDefinitionVersions(db, name);
            const target = history.find((record) => record.version === body.toVersion);
            if (!target) {
                throw new ApiError(
                    "NOT_FOUND",
                    `agent "${name}" has no version ${body.toVersion} to roll back to`,
                );
            }

            // 回滚 = 成对复制旧行 (prompt, prompt_version)，enabled 置 true（回滚即启用）。
            const candidate = {
                prompt: target.prompt,
                promptVersion: target.promptVersion,
                config: target.config,
                enabled: true,
            };
            const violation = checkPromptVersionPolicy(
                history.map((record) => ({
                    prompt: record.prompt,
                    promptVersion: record.promptVersion,
                    config: record.config,
                    enabled: record.enabled,
                })),
                candidate,
            );
            if (violation !== null) {
                throwPolicyViolation(violation.code, violation.message);
            }

            const definition = await insertAgentDefinition(db, {
                name,
                version: nextVersionNumber(history),
                promptVersion: candidate.promptVersion,
                prompt: candidate.prompt,
                config: candidate.config,
                enabled: candidate.enabled,
                createdBy: request.user.userId,
            });
            return reply.code(201).send({ definition });
        },
    );
};
