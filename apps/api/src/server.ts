/**
 * AQAOS Control Plane API（T-E01-08 Fastify 重建；T-E01-09 接入认证基座；
 * 原 express 单文件过渡服务退役，过渡期的离线 swarm 能力由 packages/cli 承接）。
 *
 * 组装：requestId → 错误契约 → 认证（先于幂等，401/403 不进幂等缓存）→
 * Idempotency-Key → 审计留痕 → OpenAPI → 探针 → auth/account/audit/
 * mcpTools/agent-definitions/v1 路由。
 * `buildApp()` 为纯组装（测试用 fastify.inject 进程内驱动）；
 * 直接运行（tsx apps/api/src/server.ts / npm run api）时校验环境并监听 4317。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateEnv } from "@aqaos/core";
import Fastify, { type FastifyInstance } from "fastify";
import { createDbPool, type DbPool } from "./lib/db.js";
import { InMemoryIdempotencyStore } from "./lib/idempotency-store.js";
import { auditPlugin } from "./plugins/audit.js";
import { authPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { openapiPlugin } from "./plugins/openapi.js";
import { generateRequestId, requestIdPlugin } from "./plugins/request-id.js";
import { accountRoutes } from "./routes/account.js";
import { agentDefinitionRoutes } from "./routes/agent-definitions.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { mcpToolRoutes } from "./routes/mcp-tools.js";
import { v1Routes } from "./routes/v1.js";
import { serviceVersion } from "./version.js";

export interface BuildAppOptions {
    /** 就绪检查与认证/资源路由共用的数据库连接串（不设则相关能力报 501/skipped）。 */
    databaseUrl?: string;
    /** JWT 签发密钥（缺省回落 process.env.JWT_SECRET；登录与 JWT 校验依赖它）。 */
    jwtSecret?: string;
    /** 幂等缓存 TTL（毫秒），测试用短值验证过期。 */
    idempotencyTtlMs?: number;
    /** pino 日志级别（测试传 silent）。 */
    logLevel?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify({
        genReqId: generateRequestId,
        bodyLimit: 1024 * 1024,
        logger: { level: options.logLevel ?? "info" },
    });

    const db: DbPool | undefined = options.databaseUrl
        ? createDbPool(options.databaseUrl)
        : undefined;
    if (db) {
        app.addHook("onClose", async () => {
            await db.end();
        });
    }
    const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;

    await app.register(requestIdPlugin);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin, { jwtSecret, db });
    await app.register(idempotencyPlugin, {
        store: new InMemoryIdempotencyStore({ ttlMs: options.idempotencyTtlMs }),
    });
    await app.register(auditPlugin, { db });
    await app.register(openapiPlugin, { version: serviceVersion() });
    await app.register(healthRoutes, { databaseUrl: options.databaseUrl });
    await app.register(authRoutes, { db, jwtSecret });
    await app.register(accountRoutes, { db });
    await app.register(auditRoutes, { db });
    await app.register(mcpToolRoutes, { db });
    await app.register(agentDefinitionRoutes, { db });
    await app.register(v1Routes);

    app.get("/", { schema: { hide: true } }, async () => {
        return "AQAOS control plane. Dashboard: http://localhost:3400 | API docs: /docs | OpenAPI: /openapi.json";
    });

    return app;
}

async function main(): Promise<void> {
    // 生产缺密钥拒启（T-E01-05）；测试经 buildApp 组装不受影响。
    validateEnv();
    const app = await buildApp({
        databaseUrl: process.env.DATABASE_URL,
        logLevel: process.env.LOG_LEVEL,
    });
    const port = Number(process.env.PORT ?? 4317);
    const host = process.env.HOST ?? "0.0.0.0";
    await app.listen({ port, host });
    app.log.info(`AQAOS control plane listening on ${host}:${port} (docs: /docs)`);
}

const invokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
    void main();
}
