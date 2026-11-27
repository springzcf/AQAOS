/**
 * 健康探针（T-E01-08）：
 * - GET /health：进程存活（无外部依赖，供 compose/CI 探活）；
 * - GET /health/ready：就绪检查。配置了 databaseUrl 时对 PostgreSQL 做 SELECT 1
 *   （1.5s 连接超时），失败返回 503；未配置则报告 database: skipped。
 *   探针响应是运维格式，不走 DDD §8.1 错误契约。
 */

import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";
import { Client } from "pg";
import { serviceVersion } from "../version.js";

export interface HealthPluginOptions extends FastifyPluginOptions {
    databaseUrl?: string;
}

const DB_CHECK_TIMEOUT_MS = 1500;

export const healthRoutes: FastifyPluginAsync<HealthPluginOptions> = async (app, options) => {
    app.get("/health", { schema: { hide: true } }, async () => ({
        status: "ok",
        service: "@aqaos/api",
        version: serviceVersion(),
        uptimeSeconds: Math.floor(process.uptime()),
    }));

    app.get("/health/ready", { schema: { hide: true } }, async (_request, reply) => {
        if (!options.databaseUrl) {
            return { status: "ok", checks: { database: "skipped" } };
        }
        const client = new Client({
            connectionString: options.databaseUrl,
            connectionTimeoutMillis: DB_CHECK_TIMEOUT_MS,
        });
        try {
            await client.connect();
            await client.query("SELECT 1");
            return { status: "ok", checks: { database: "ok" } };
        } catch (error) {
            reply.code(503);
            return {
                status: "unavailable",
                checks: { database: (error as Error).message },
            };
        } finally {
            await client.end().catch(() => undefined);
        }
    });
};
