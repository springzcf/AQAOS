/**
 * Flyway 风格 SQL Migration Runner（T-E01-07）。
 *
 * 设计约定：
 * - migration 文件位于 db/migrations/，命名 `NNNN_领域.ts`，默认导出 `satisfies Migration`；
 * - up/down 均为 SQL 语句数组（每条一个元素，可含多行；不含参数占位符与 BEGIN/COMMIT）；
 * - 每个迁移在单事务内执行并登记到 schema_migrations（含 sha256 checksum）；
 * - 已应用迁移被修改或删除 → MigrationConflictError（禁止篡改历史）；
 * - 并发互斥：session 级 pg_advisory_lock（同一连接加锁/释放）；
 * - 注意：未来若需要 CREATE INDEX CONCURRENTLY 等非事务语句，需引入 per-migration
 *   `transactional: false` 支持，当前 33 表初始 Schema 不需要。
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "pg";

export interface Migration {
    /** 必须与文件名（去掉 .ts）一致，如 "0001_platform"。 */
    readonly name: string;
    /** 一句话说明（用于 status 输出与审计）。 */
    readonly description?: string;
    readonly up: readonly string[];
    readonly down: readonly string[];
}

const MIGRATIONS_TABLE = "schema_migrations";

/** 迁移互斥锁键：任意固定整数，本集群内唯一即可。 */
const ADVISORY_LOCK_KEY = 810_723_446;

export class MigrationConflictError extends Error {}

export interface MigrationStatus {
    readonly applied: readonly string[];
    readonly pending: readonly string[];
}

function checksumOf(migration: Migration): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                description: migration.description ?? null,
                up: migration.up,
                down: migration.down,
            }),
        )
        .digest("hex");
}

async function ensureMigrationsTable(client: Client): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            name TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function appliedChecksums(client: Client): Promise<Map<string, string>> {
    const result = await client.query<{ name: string; checksum: string }>(
        `SELECT name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY name`,
    );
    return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function lockMigrations(client: Client): Promise<void> {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
}

async function unlockMigrations(client: Client): Promise<void> {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
}

async function inTransaction(client: Client, body: () => Promise<void>): Promise<void> {
    await client.query("BEGIN");
    try {
        await body();
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
}

/** 校验已应用迁移未被篡改/删除（返回按文件序排列的已应用清单）。 */
function assertNoDrift(migrations: readonly Migration[], applied: Map<string, string>): void {
    for (const [name, recordedChecksum] of applied) {
        const migration = migrations.find((candidate) => candidate.name === name);
        if (!migration) {
            throw new MigrationConflictError(
                `已应用的迁移 ${name} 在代码库中缺失（禁止删除已应用的迁移文件）`,
            );
        }
        if (checksumOf(migration) !== recordedChecksum) {
            throw new MigrationConflictError(
                `迁移 ${name} 在应用后被修改（checksum 不匹配）——请新增迁移而不是修改历史`,
            );
        }
    }
}

/** 应用全部待执行迁移，返回本次应用的迁移名（顺序执行）。 */
export async function runUp(client: Client, migrations: readonly Migration[]): Promise<string[]> {
    await ensureMigrationsTable(client);
    await lockMigrations(client);
    try {
        const applied = await appliedChecksums(client);
        assertNoDrift(migrations, applied);
        const pending = migrations.filter((migration) => !applied.has(migration.name));
        for (const migration of pending) {
            await inTransaction(client, async () => {
                for (const statement of migration.up) {
                    await client.query(statement);
                }
                await client.query(
                    `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`,
                    [migration.name, checksumOf(migration)],
                );
            });
        }
        return pending.map((migration) => migration.name);
    } finally {
        await unlockMigrations(client);
    }
}

/** 回滚最近 count 个已应用迁移（count 可为 Infinity 表示全部），返回回滚清单（新→旧）。 */
export async function runDown(
    client: Client,
    migrations: readonly Migration[],
    count: number = 1,
): Promise<string[]> {
    await ensureMigrationsTable(client);
    await lockMigrations(client);
    try {
        const applied = await appliedChecksums(client);
        assertNoDrift(migrations, applied);
        const appliedNames = [...applied.keys()].sort().reverse();
        const targets = appliedNames.slice(
            0,
            Number.isFinite(count) ? Math.max(count, 0) : appliedNames.length,
        );
        for (const name of targets) {
            const migration = migrations.find((candidate) => candidate.name === name);
            // assertNoDrift 已确保存在，此断言只为类型收窄。
            if (!migration) {
                throw new MigrationConflictError(`迁移 ${name} 缺失`);
            }
            await inTransaction(client, async () => {
                for (const statement of migration.down) {
                    await client.query(statement);
                }
                await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [name]);
            });
        }
        return targets;
    } finally {
        await unlockMigrations(client);
    }
}

export async function migrationStatus(
    client: Client,
    migrations: readonly Migration[],
): Promise<MigrationStatus> {
    await ensureMigrationsTable(client);
    const applied = await appliedChecksums(client);
    assertNoDrift(migrations, applied);
    return {
        applied: migrations.filter((m) => applied.has(m.name)).map((m) => m.name),
        pending: migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
    };
}

function isMigration(value: unknown): value is Migration {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as Partial<Migration>;
    return (
        typeof candidate.name === "string" &&
        Array.isArray(candidate.up) &&
        Array.isArray(candidate.down) &&
        candidate.up.every((s) => typeof s === "string") &&
        candidate.down.every((s) => typeof s === "string")
    );
}

/** 加载并校验 db/migrations/ 下的全部迁移（按文件名升序）。 */
export async function loadMigrations(dir: string): Promise<Migration[]> {
    const entries = await readdir(dir);
    const files = entries.filter((file) => /^\d{4}_.*\.ts$/.test(file)).sort();
    if (files.length === 0) {
        throw new Error(`迁移目录为空：${dir}`);
    }
    const migrations: Migration[] = [];
    for (const file of files) {
        const module = (await import(pathToFileURL(path.join(dir, file)).href)) as {
            default?: unknown;
        };
        const candidate = module.default;
        if (!isMigration(candidate)) {
            throw new Error(`${file} 必须默认导出 Migration（satisfies Migration）`);
        }
        const expectedName = file.replace(/\.ts$/, "");
        if (candidate.name !== expectedName) {
            throw new Error(`${file} 的 name "${candidate.name}" 与文件名不一致`);
        }
        migrations.push(candidate);
    }
    const names = new Set(migrations.map((migration) => migration.name));
    if (names.size !== migrations.length) {
        throw new Error("存在重名迁移（文件名前缀必须唯一）");
    }
    return migrations;
}
