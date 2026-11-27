/**
 * requestId 中间件（T-E01-08）：信任合法的入站 x-request-id，否则生成 UUID；
 * 所有响应（含错误体）回写 x-request-id 头，错误体内的 requestId 与之相同。
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export const REQUEST_ID_HEADER = "x-request-id";
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Fastify genReqId 实现：入站 x-request-id 合法则沿用，否则生成 UUID。 */
export function generateRequestId(req: IncomingMessage): string {
    const raw = req.headers[REQUEST_ID_HEADER];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    if (
        typeof incoming === "string" &&
        incoming.length > 0 &&
        incoming.length <= MAX_REQUEST_ID_LENGTH &&
        SAFE_REQUEST_ID_PATTERN.test(incoming)
    ) {
        return incoming;
    }
    return randomUUID();
}

const plugin: FastifyPluginAsync = async (app) => {
    app.addHook("onSend", async (request, reply) => {
        reply.header(REQUEST_ID_HEADER, request.id);
    });
};

// fp 包装突破封装：onSend 挂到根作用域，对后续所有路由生效。
export const requestIdPlugin = fp(plugin, { name: "aqaos-request-id" });
