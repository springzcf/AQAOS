/**
 * PostgreSQL 连接池（T-E01-09 起为认证/资源路由的数据访问入口）。
 *
 * 生产角色连接（RLS GUC 由应用层按请求设置，M2 租户加固 T-E11-05 开启 FORCE）；
 * /health/ready 探针仍按次建连（独立于本池，见 routes/health.ts）。
 */

import pg from "pg";

export type DbPool = pg.Pool;

export function createDbPool(databaseUrl: string): DbPool {
    return new pg.Pool({
        connectionString: databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    });
}
