/**
 * 统一错误处理器（T-E01-08，DDD §8.1 错误契约 + §16 错误码）：
 * - ApiError → 按 ERROR_HTTP_STATUS 映射；
 * - Fastify schema 校验错误 → 400 VALIDATION_FAILED（details 附校验明细）；
 * - Fastify 框架错误（如 body 超限）→ 按状态码归类；
 * - 未知错误 → 500 INTERNAL_ERROR（日志带堆栈，响应不泄漏内部细节）；
 * - 未匹配路由 → 404 NOT_FOUND。
 * 所有错误响应都携带 requestId 与 x-request-id 头。
 */

import type { FastifyError, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ApiError, type ErrorCode } from "../lib/errors.js";

interface ErrorWithExtras extends Error {
    /** Fastify schema 校验失败时的校验明细数组。 */
    validation?: unknown;
    /** Fastify 框架错误自带的状态码。 */
    statusCode?: number;
}

function firstValidationMessage(validation: unknown): string | undefined {
    if (Array.isArray(validation) && validation.length > 0) {
        const first = validation[0] as { message?: unknown } | undefined;
        if (first && typeof first.message === "string") {
            return first.message;
        }
    }
    return undefined;
}

const plugin: FastifyPluginAsync = async (app) => {
    app.setErrorHandler((error: FastifyError, request, reply) => {
        let code: ErrorCode = "INTERNAL_ERROR";
        let status = 500;
        let message = "Internal server error";
        let details: unknown;

        if (error instanceof ApiError) {
            code = error.code;
            status = error.statusCode;
            message = error.message;
            details = error.details;
        } else {
            const extras = error as ErrorWithExtras;
            if (Array.isArray(extras.validation)) {
                code = "VALIDATION_FAILED";
                status = 400;
                message =
                    firstValidationMessage(extras.validation) ??
                    "Request payload failed schema validation";
                details = extras.validation;
            } else if (typeof extras.statusCode === "number" && extras.statusCode >= 400) {
                status = extras.statusCode;
                code = status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_FAILED";
                message = error.message;
            }
        }

        if (status >= 500) {
            // 5xx 记录完整堆栈；4xx 仅留痕。
            request.log.error({ err: error, requestId: request.id }, "request failed");
        }

        const envelope: {
            error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
        } = { error: { code, message, requestId: request.id } };
        if (details !== undefined) {
            envelope.error.details = details;
        }
        reply.code(status).send(envelope);
    });

    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({
            error: {
                code: "NOT_FOUND",
                message: `Route ${request.method} ${request.url} not found`,
                requestId: request.id,
            },
        });
    });
};

// fp 包装突破封装：错误契约与 404 处理挂到根作用域，覆盖全部路由。
export const errorHandlerPlugin = fp(plugin, { name: "aqaos-error-handler" });
