/**
 * Idempotency-Key 中间件（T-E01-08，DDD §8.1 创建 Run 示例要求的幂等语义）：
 *
 * - 仅作用于携带 Idempotency-Key 头的 POST/PUT/PATCH；
 * - 键作用域 = 方法 + 路由模板 + 键值；同键同载荷 → 重放缓存响应（x-idempotent-replay: true）；
 * - 同键不同载荷 → 409 IDEMPOTENCY_KEY_REUSED（键是一次性的，Stripe 语义）；
 * - 5xx 响应不缓存，客户端可安全重试；
 * - 路由可通过 config.requireIdempotencyKey 强制要求该头（如 POST /api/v1/runs）；
 * - 一阶段为进程内存储；并发 in-flight 同键去重随 M2 Redis 实现补齐（见 idempotency-store.ts）。
 */

import { createHash } from "node:crypto";
import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../lib/errors.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "../lib/idempotency-store.js";

declare module "fastify" {
    interface FastifyRequest {
        /** 本请求生效的幂等键（未参与幂等的请求为 null）。 */
        idempotencyKey: string | null;
    }
}

export interface IdempotencyPluginOptions extends FastifyPluginOptions {
    store?: IdempotencyStore;
}

interface RouteLevelConfig {
    requireIdempotencyKey?: boolean;
}

const MAX_KEY_LENGTH = 255;

function headerValue(raw: string | string[] | undefined): string | undefined {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
    }
    return value.trim();
}

/** 语义载荷哈希：对解析后的 body 规范化（undefined/null 归一为空）。 */
function payloadHashOf(body: unknown): string {
    const serialized = body === undefined || body === null ? "" : JSON.stringify(body);
    return createHash("sha256").update(serialized).digest("hex");
}

function routeScopeOf(request: FastifyRequest): string {
    const routeUrl = request.routeOptions.url ?? request.url.split("?")[0];
    return `${request.method} ${routeUrl}`;
}

const plugin: FastifyPluginAsync<IdempotencyPluginOptions> = async (app, options) => {
    const store = options.store ?? new InMemoryIdempotencyStore();
    app.decorateRequest("idempotencyKey", null);

    app.addHook("preHandler", async (request, reply) => {
        request.idempotencyKey = null;
        if (!["POST", "PUT", "PATCH"].includes(request.method)) {
            return;
        }
        const key = headerValue(request.headers["idempotency-key"]);
        const routeConfig = (request.routeOptions.config ?? {}) as RouteLevelConfig;

        if (!key) {
            if (routeConfig.requireIdempotencyKey) {
                throw new ApiError(
                    "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key header is required for this endpoint",
                );
            }
            return;
        }
        if (key.length > MAX_KEY_LENGTH) {
            throw new ApiError(
                "VALIDATION_FAILED",
                `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
            );
        }

        const scopedKey = `${routeScopeOf(request)} ${key}`;
        const payloadHash = payloadHashOf(request.body);
        const cached = store.get(scopedKey);
        if (cached) {
            if (cached.requestPayloadHash !== payloadHash) {
                throw new ApiError(
                    "IDEMPOTENCY_KEY_REUSED",
                    "Idempotency-Key was already used with a different request payload",
                );
            }
            request.idempotencyKey = null;
            reply.header("x-idempotent-replay", "true");
            reply.code(cached.status);
            reply.header("content-type", cached.contentType);
            reply.send(cached.body);
            return;
        }
        request.idempotencyKey = key;
    });

    app.addHook("onSend", async (request, reply, payload) => {
        const key = request.idempotencyKey;
        if (!key) {
            return payload;
        }
        const status = reply.statusCode;
        if (status >= 500) {
            return payload;
        }
        const contentTypeRaw = reply.getHeader("content-type");
        const contentType = (
            Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw
        )?.toString();
        store.set(`${routeScopeOf(request)} ${key}`, {
            status,
            contentType: contentType ?? "application/json",
            body: typeof payload === "string" ? payload : "",
            requestPayloadHash: payloadHashOf(request.body),
        });
        return payload;
    });
};

// fp 包装突破封装：幂等 preHandler/onSend 与 idempotencyKey 装饰器挂到根作用域。
export const idempotencyPlugin = fp(plugin, { name: "aqaos-idempotency" });
