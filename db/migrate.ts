/**
 * Migration CLI（T-E01-07）。用法：
 *   npm run db:migrate            # 应用全部待执行迁移（空库一键建表）
 *   npm run db:rollback           # 回滚最近 1 个迁移
 *   npm run db:rollback -- all    # 回滚全部
 *   npm run db:status             # 查看已应用/待执行
 *   npm run db:reset              # 回滚全部后重新应用（拒绝在生产执行）
 *
 * 连接串取 DATABASE_URL；未设置时回退到 docker-compose.dev.yml 的开发库并告警。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadMigrations, migrationStatus, runDown, runUp } from "./runner.js";

const DEFAULT_DB_URL = "postgres://aqaos:aqaos@localhost:5432/aqaos";
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

function parseDownCount(raw: string | undefined): number {
    if (raw === undefined || raw === "1") {
        return 1;
    }
    if (raw === "all") {
        return Number.POSITIVE_INFINITY;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`无效的回滚数量：${raw}（可选：正整数或 all）`);
    }
    return parsed;
}

async function main(): Promise<void> {
    const [command, arg] = process.argv.slice(2);
    if (!process.env.DATABASE_URL) {
        console.warn(`[db] 未设置 DATABASE_URL，使用开发默认值：${DEFAULT_DB_URL}`);
    }
    const connectionString = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
    const client = new Client({ connectionString });
    await client.connect();
    try {
        const migrations = await loadMigrations(MIGRATIONS_DIR);
        switch (command) {
            case "up": {
                const applied = await runUp(client, migrations);
                console.log(
                    applied.length > 0
                        ? `已应用 ${applied.length} 个迁移：\n  ${applied.join("\n  ")}`
                        : "没有待执行的迁移。",
                );
                break;
            }
            case "down": {
                if (process.env.NODE_ENV === "production") {
                    throw new Error("禁止在生产环境执行回滚（NODE_ENV=production）");
                }
                const reverted = await runDown(client, migrations, parseDownCount(arg));
                console.log(
                    reverted.length > 0
                        ? `已回滚 ${reverted.length} 个迁移（新→旧）：\n  ${reverted.join("\n  ")}`
                        : "没有可回滚的迁移。",
                );
                break;
            }
            case "reset": {
                if (process.env.NODE_ENV === "production") {
                    throw new Error("禁止在生产环境执行 reset（NODE_ENV=production）");
                }
                const reverted = await runDown(client, migrations, Number.POSITIVE_INFINITY);
                const applied = await runUp(client, migrations);
                console.log(
                    `reset 完成：回滚 ${reverted.length} 个，重新应用 ${applied.length} 个。`,
                );
                break;
            }
            case "status": {
                const status = await migrationStatus(client, migrations);
                console.log("已应用：", status.applied.join(", ") || "（无）");
                console.log("待执行：", status.pending.join(", ") || "（无）");
                break;
            }
            default: {
                console.error("用法：npm run db:<migrate|rollback|status|reset> [count|all]");
                process.exitCode = 1;
            }
        }
    } finally {
        await client.end();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
