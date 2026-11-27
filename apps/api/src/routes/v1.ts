/**
 * /api/v1 版本化路由（T-E01-08；T-E01-09 起业务路由要求认证）。
 *
 * 一阶段骨架：GET /runs 返回空集合（需认证）；POST /runs 完成认证 +
 * DDD §8.1 契约校验（body schema + 强制 Idempotency-Key）后返回 501
 * NOT_IMPLEMENTED，真实创建随 Run Registry（T-E02-12）落地——骨架阶段即固定错误契约形状。
 */

import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../lib/errors.js";
import { serviceVersion } from "../version.js";

/** DDD §8.1 创建 Run 请求体（additionalProperties=false 拒绝未知字段）。 */
const createRunBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["applicationId", "objective"],
    properties: {
        applicationId: { type: "string", minLength: 1, description: "被测应用 ID" },
        environmentId: { type: "string", description: "目标环境 ID（可选）" },
        objective: { type: "string", minLength: 1, description: "测试目标（自然语言）" },
        platforms: {
            type: "array",
            items: { type: "string", enum: ["web", "api"] },
            description: "平台（§7.3 platform 枚举）",
        },
        modes: {
            type: "array",
            items: { type: "string" },
            description: "测试模式（exploration/functional/security/regression…）",
        },
        budget: {
            type: "object",
            additionalProperties: false,
            properties: {
                maxAgents: { type: "integer", minimum: 1 },
                maxDurationSeconds: { type: "integer", minimum: 1 },
                maxModelCostUsd: { type: "number", minimum: 0 },
                maxTokens: { type: "integer", minimum: 1 },
            },
        },
        safety: {
            type: "object",
            additionalProperties: false,
            properties: {
                allowDestructiveActions: { type: "boolean" },
                requireApprovalForPayment: { type: "boolean" },
            },
        },
    },
} as const;

const listRunsResponseSchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    status: { type: "string" },
                    createdAt: { type: "string" },
                },
            },
        },
        total: { type: "integer" },
    },
} as const;

const serviceIndexResponseSchema = {
    type: "object",
    properties: {
        name: { type: "string" },
        version: { type: "string" },
        links: { type: "object", additionalProperties: { type: "string" } },
    },
} as const;

export const v1Routes: FastifyPluginAsync = async (app) => {
    app.get(
        "/api/v1",
        { schema: { tags: ["meta"], response: { 200: serviceIndexResponseSchema } } },
        async () => ({
            name: "@aqaos/api",
            version: serviceVersion(),
            links: {
                self: "/api/v1",
                runs: "/api/v1/runs",
                docs: "/docs",
                openapi: "/openapi.json",
            },
        }),
    );

    app.get(
        "/api/v1/runs",
        {
            schema: { tags: ["runs"], response: { 200: listRunsResponseSchema } },
            config: { auth: { requireAuth: true } },
        },
        async () => ({ items: [], total: 0 }),
    );

    app.post(
        "/api/v1/runs",
        {
            schema: { tags: ["runs"], body: createRunBodySchema },
            config: { requireIdempotencyKey: true, auth: { requireAuth: true } },
        },
        async () => {
            throw new ApiError(
                "NOT_IMPLEMENTED",
                "Run creation lands with the Run Registry (T-E02-12); this skeleton validates the request contract only",
            );
        },
    );
};
