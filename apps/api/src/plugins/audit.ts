/**
 * 审计中间件（T-E01-11，验收：所有变更类 API 自动留痕）。
 *
 * onSend 钩子（fp 包装挂根作用域）：变更类请求按 lib/audit.ts 规则推导事件后
 * 异步写入 audit_logs——留痕失败仅记录日志，绝不影响响应（审计是旁路，不是关卡）。
 * organization_id 缺失（如登录，无组织上下文）时不留痕；完整登录审计随 T-E11-05
 * 引入用户级审计目标（actor-only 行）补齐。
 */

import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { DbPool } from "../lib/db.js";
import { deriveAuditEvent } from "../lib/audit.js";

export interface AuditPluginOptions extends FastifyPluginOptions {
    db?: DbPool;
}

/** 单请求只留痕一次（防错误替换/重复发送管线造成的 onSend 重放）。 */
const auditedRequests = new WeakSet<FastifyRequest>();

const plugin: FastifyPluginAsync<AuditPluginOptions> = async (app, options) => {
    const db = options.db;
    if (!db) {
        return;
    }

    app.addHook("onSend", async (request, reply, payload) => {
        const user = request.user;
        if (!user?.organizationId) {
            return payload;
        }
        const routeUrl = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
        const event = deriveAuditEvent(
            request.method,
            routeUrl,
            request.params as Record<string, string> | undefined,
            reply.statusCode,
        );
        if (!event || auditedRequests.has(request)) {
            return payload;
        }
        auditedRequests.add(request);

        void db
            .query(
                `INSERT INTO audit_logs
                   (organization_id, actor_id, action, resource_type, resource_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    user.organizationId,
                    user.userId,
                    event.action,
                    event.resourceType,
                    event.resourceId,
                    JSON.stringify({
                        requestId: request.id,
                        method: request.method,
                        route: routeUrl,
                        statusCode: reply.statusCode,
                    }),
                ],
            )
            .catch((err: unknown) => {
                request.log.error({ err }, "audit log write failed");
            });
        return payload;
    });
};

// fp 包装突破封装：onSend 挂根作用域，覆盖全部变更类路由（无需逐路由登记）。
export const auditPlugin = fp(plugin, { name: "aqaos-audit" });
