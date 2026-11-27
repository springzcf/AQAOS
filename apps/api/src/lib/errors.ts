/**
 * 统一错误模型（T-E01-08，对照 DDD §16 错误码与 §8.1 错误契约）。
 *
 * - 领域错误码 = DDD §16 全量（语义：环境/预算类可恢复，安全类立即拒绝并审计）；
 * - 传输层错误码为实现补充（已回写 DDD §16 V1.4，保持单一事实源）；
 * - 错误体统一为：{ "error": { "code", "message", "requestId", "details"? } }。
 */

export const DOMAIN_ERROR_CODES = [
    "APPLICATION_NOT_FOUND",
    "ENVIRONMENT_UNAVAILABLE",
    "ENVIRONMENT_PROVISION_FAILED",
    "MODEL_UNAVAILABLE",
    "MODEL_BUDGET_EXCEEDED",
    "AGENT_TIMEOUT",
    "TOOL_PERMISSION_DENIED",
    "BROWSER_CRASHED",
    "NETWORK_POLICY_BLOCKED",
    "EVIDENCE_UPLOAD_FAILED",
    "WORKFLOW_FAILED",
    "APPROVAL_REQUIRED",
    "APPROVAL_EXPIRED",
    "WEBHOOK_DELIVERY_FAILED",
    "ISSUE_SYNC_FAILED",
    "CI_EVENT_REJECTED",
] as const;

export const TRANSPORT_ERROR_CODES = [
    "VALIDATION_FAILED",
    "NOT_FOUND",
    "AUTHENTICATION_REQUIRED",
    "PERMISSION_DENIED",
    "IDEMPOTENCY_KEY_REQUIRED",
    "IDEMPOTENCY_KEY_REUSED",
    "PAYLOAD_TOO_LARGE",
    "NOT_IMPLEMENTED",
    "INTERNAL_ERROR",
] as const;

export type ErrorCode =
    (typeof DOMAIN_ERROR_CODES)[number] | (typeof TRANSPORT_ERROR_CODES)[number];

/** 错误码 → HTTP 状态码固定映射（5xx 响应不进入幂等缓存，允许客户端重试）。 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
    APPLICATION_NOT_FOUND: 404,
    ENVIRONMENT_UNAVAILABLE: 409,
    ENVIRONMENT_PROVISION_FAILED: 500,
    MODEL_UNAVAILABLE: 503,
    MODEL_BUDGET_EXCEEDED: 429,
    AGENT_TIMEOUT: 504,
    TOOL_PERMISSION_DENIED: 403,
    BROWSER_CRASHED: 500,
    NETWORK_POLICY_BLOCKED: 403,
    EVIDENCE_UPLOAD_FAILED: 502,
    WORKFLOW_FAILED: 500,
    APPROVAL_REQUIRED: 403,
    APPROVAL_EXPIRED: 410,
    WEBHOOK_DELIVERY_FAILED: 502,
    ISSUE_SYNC_FAILED: 502,
    CI_EVENT_REJECTED: 400,
    VALIDATION_FAILED: 400,
    NOT_FOUND: 404,
    AUTHENTICATION_REQUIRED: 401,
    PERMISSION_DENIED: 403,
    IDEMPOTENCY_KEY_REQUIRED: 400,
    IDEMPOTENCY_KEY_REUSED: 409,
    PAYLOAD_TOO_LARGE: 413,
    NOT_IMPLEMENTED: 501,
    INTERNAL_ERROR: 500,
};

export interface ApiErrorOptions {
    /** 附加细节（须可 JSON 序列化，进入错误体的 error.details）。 */
    readonly details?: unknown;
    readonly cause?: unknown;
}

export class ApiError extends Error {
    readonly code: ErrorCode;
    readonly statusCode: number;
    readonly details?: unknown;

    constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = "ApiError";
        this.code = code;
        this.statusCode = ERROR_HTTP_STATUS[code];
        this.details = options.details;
    }
}

/** DDD §8.1 统一错误体结构（供序列化与测试共用）。 */
export interface ErrorEnvelope {
    readonly error: {
        readonly code: ErrorCode;
        readonly message: string;
        readonly requestId: string;
        readonly details?: unknown;
    };
}
