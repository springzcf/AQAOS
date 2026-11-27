/**
 * 审计事件推导（T-E01-11，纯函数离线可测）。
 *
 * 留痕范围（验收：所有变更类 API 自动留痕）：
 * - 仅 /api/v1/ 下的 API 面（探针/文档/静态路径不入审计）；
 * - 变更类方法（POST/PUT/PATCH/DELETE）且响应 2xx → create/update/delete；
 * - 变更类请求被 RBAC 拒绝（403）→ denied（安全留痕，DDD "未授权操作立即拒绝并审计"）；
 * - GET 等读操作、401/400/404/5xx 不留痕（401 未认证无主体可归属，5xx 有结构化日志）。
 *
 * metadata 不记录请求体（密码/凭据类载荷绝不入审计）；身份/路由/状态足够追责。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTION_BY_METHOD: Readonly<Record<string, string>> = Object.freeze({
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
});

export interface AuditEvent {
    /** create / update / delete / denied。 */
    action: string;
    /** 路由模板去 /api/v1/ 前缀与 :id 段，如 "auth/tokens"。 */
    resourceType: string;
    /** 路径参数中的 UUID（无则 null）。 */
    resourceId: string | null;
}

export interface AuditActor {
    userId: string;
    organizationId: string | null;
}

/**
 * 由请求要素推导审计事件；不属于留痕范围返回 null。
 * routeUrl 用路由模板（/api/v1/auth/tokens/:id）；params 为实际路径参数。
 */
export function deriveAuditEvent(
    method: string,
    routeUrl: string,
    params: Record<string, string> | undefined,
    statusCode: number,
): AuditEvent | null {
    // 仅审计 API 面：/health、/openapi.json、/ 等基础设施路径不属于变更类 API。
    if (!routeUrl.startsWith("/api/v1/")) {
        return null;
    }
    const baseAction = ACTION_BY_METHOD[method];
    if (baseAction === undefined) {
        return null;
    }
    const isDenied = statusCode === 403;
    if (!(statusCode >= 200 && statusCode < 300) && !isDenied) {
        return null;
    }

    const path = routeUrl.replace(/^\/api\/v1\//, "");
    const segments = path.split("/").filter((segment) => !segment.startsWith(":"));
    if (segments.length === 0 || segments[0] === "") {
        return null;
    }

    const paramId =
        params !== undefined && typeof params.id === "string" && UUID_PATTERN.test(params.id)
            ? params.id
            : null;

    return {
        action: isDenied ? "denied" : baseAction,
        resourceType: segments.join("/"),
        resourceId: paramId,
    };
}
