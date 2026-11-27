/**
 * agent_definitions 存取层（T-E02-04，DDD §3.3 append-only 版本流水）。
 *
 * 行不可变：本层只提供"读历史 + 追加新行"两类操作——更新/删除不存在，
 * 回滚由路由层构造"成对复制 (prompt, prompt_version) 的新行"实现。
 * 行序：version 为整数串（API 层分配单调 +1），排序用数值序 CASE 表达式
 * 兜底非数值历史；created_at 仅作并列决胜与展示。
 */

import {
    AgentDefinitionRecordSchema,
    type AgentDefinitionConfig,
    type AgentDefinitionRecord,
} from "@aqaos/domain";
import type { DbPool } from "./db.js";
import { ApiError } from "./errors.js";

/** 原始行投影（snake_case 直读；toRecord 转换 + 契约校验）。 */
interface AgentDefinitionRow {
    id: string;
    name: string;
    version: string;
    prompt_version: string;
    prompt: string;
    config: unknown;
    enabled: boolean;
    created_at: Date;
    created_by: string | null;
}

/** 数值序 version 排序表达式（非数值历史行落 -1 兜底，API 保证整数串）。 */
const VERSION_ORDER = `(CASE WHEN version ~ '^[0-9]+$' THEN version::BIGINT ELSE -1 END)`;

/** 行 → 领域记录（camelCase + 契约校验：坏行宁可 500 也不静默漏列）。 */
function toRecord(row: AgentDefinitionRow): AgentDefinitionRecord {
    const candidate = {
        id: row.id,
        name: row.name,
        version: row.version,
        promptVersion: row.prompt_version,
        prompt: row.prompt,
        config: (row.config ?? {}) as AgentDefinitionConfig,
        enabled: row.enabled,
        createdAt: row.created_at.toISOString(),
        createdBy: row.created_by,
    };
    const parsed = AgentDefinitionRecordSchema.safeParse(candidate);
    if (!parsed.success) {
        throw new ApiError(
            "INTERNAL_ERROR",
            `stored agent definition row ${row.name}@${row.version} is malformed`,
            { details: { issues: parsed.error.issues.map((issue) => issue.path.join(".")) } },
        );
    }
    return parsed.data;
}

/** 每 name 最新版（16 角色清单视图）。 */
export async function listLatestAgentDefinitions(db: DbPool): Promise<AgentDefinitionRecord[]> {
    const result = await db.query<AgentDefinitionRow>(
        `SELECT DISTINCT ON (name) id, name, version, prompt_version, prompt, config, enabled, created_at, created_by
           FROM agent_definitions
          ORDER BY name, ${VERSION_ORDER} DESC, created_at DESC`,
    );
    return result.rows.map(toRecord);
}

/** 某角色的全部版本（旧→新；空数组 = 未知角色或尚无版本）。 */
export async function listAgentDefinitionVersions(
    db: DbPool,
    name: string,
): Promise<AgentDefinitionRecord[]> {
    const result = await db.query<AgentDefinitionRow>(
        `SELECT id, name, version, prompt_version, prompt, config, enabled, created_at, created_by
           FROM agent_definitions
          WHERE name = $1
          ORDER BY ${VERSION_ORDER} ASC, created_at ASC`,
        [name],
    );
    return result.rows.map(toRecord);
}

export interface InsertAgentDefinitionInput {
    name: string;
    version: string;
    promptVersion: string;
    prompt: string;
    config: AgentDefinitionConfig;
    enabled: boolean;
    createdBy: string | null;
}

/** 追加一个版本行（唯一 insert；UNIQUE(name, version) 冲突 → 409 语义化错误）。 */
export async function insertAgentDefinition(
    db: DbPool,
    input: InsertAgentDefinitionInput,
): Promise<AgentDefinitionRecord> {
    let row: AgentDefinitionRow | undefined;
    try {
        const result = await db.query<AgentDefinitionRow>(
            `INSERT INTO agent_definitions (name, version, prompt_version, prompt, config, enabled, created_by)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             RETURNING id, name, version, prompt_version, prompt, config, enabled, created_at, created_by`,
            [
                input.name,
                input.version,
                input.promptVersion,
                input.prompt,
                JSON.stringify(input.config),
                input.enabled,
                input.createdBy,
            ],
        );
        row = result.rows[0];
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505") {
            throw new ApiError(
                "VALIDATION_FAILED",
                "concurrent version creation for this agent; retry the request",
            );
        }
        throw error;
    }
    if (!row) {
        throw new ApiError("INTERNAL_ERROR", "agent definition insert returned no row");
    }
    return toRecord(row);
}

/** 既有版本行集的下一个行序号（整数串单调 +1）。 */
export function nextVersionNumber(versions: readonly AgentDefinitionRecord[]): string {
    let max = 0;
    for (const record of versions) {
        const parsed = Number(record.version);
        if (Number.isInteger(parsed) && parsed > max) {
            max = parsed;
        }
    }
    return String(max + 1);
}
