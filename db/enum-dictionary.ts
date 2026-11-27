/**
 * 数据库枚举字典（T-E01-07 建立；T-E02-01 起字典本体移驻领域层单一事实源）。
 *
 * - 字典真身：packages/domain/src/enums.ts（ENUM_DICTIONARY 与 zod Schema 同源导出，
 *   前后端/Worker 唯一校验入口）；本文件经相对源码导入 re-export——db 是仓库内
 *   脚本目录（非 workspace 包），走 dist 会给 migration-check CI 引入构建依赖，
 *   源码直连 + tsx 按需编译是零耦合的等价通道；
 * - DB CHECK 约束由各 migration 通过 {@link enumCheckSql} 从字典生成，禁止手抄值列表；
 * - tests/regression/enum-dictionary.spec.ts 逐值断言字典与 DDD §7.3 一致（防文档/代码漂移）。
 */

export { ENUM_DICTIONARY, enumValues } from "../packages/domain/src/enums.js";
export type { EnumKey, EnumValue } from "../packages/domain/src/enums.js";

import { ENUM_DICTIONARY } from "../packages/domain/src/enums.js";

/** 表列 → 枚举 绑定清单：DB CHECK 约束只允许出现在此清单里，新增绑定须同步对应 migration。 */
export interface EnumColumnBinding {
    readonly table: string;
    readonly column: string;
    readonly enumKey: keyof typeof ENUM_DICTIONARY;
}

export const ENUM_COLUMN_BINDINGS: readonly EnumColumnBinding[] = [
    { table: "applications", column: "platform", enumKey: "platform" },
    { table: "test_cases", column: "platform", enumKey: "platform" },
    { table: "test_runs", column: "status", enumKey: "runStatus" },
    { table: "test_cases", column: "status", enumKey: "testCaseStatus" },
    { table: "test_cases", column: "review_status", enumKey: "reviewStatus" },
    { table: "bugs", column: "severity", enumKey: "bugSeverity" },
    { table: "bugs", column: "status", enumKey: "bugStatus" },
    { table: "approval_requests", column: "status", enumKey: "approvalStatus" },
    { table: "approval_requests", column: "risk_level", enumKey: "approvalRiskLevel" },
    {
        table: "environment_provisionings",
        column: "status",
        enumKey: "environmentStackStatus",
    },
    { table: "memories", column: "kind", enumKey: "memoryKind" },
    { table: "model_invocations", column: "data_sensitivity", enumKey: "dataSensitivity" },
    { table: "external_integrations", column: "kind", enumKey: "integrationKind" },
    { table: "external_issue_links", column: "status", enumKey: "externalIssueStatus" },
];

/** 生成 CHECK 约束 SQL（值列表来自字典，杜绝手抄漂移）。 */
export function enumCheckSql(binding: EnumColumnBinding): string {
    const values = ENUM_DICTIONARY[binding.enumKey].map((value) => `'${value}'`).join(", ");
    return `ALTER TABLE ${binding.table} ADD CONSTRAINT ${binding.table}_${binding.column}_check CHECK (${binding.column} IN (${values}));`;
}

/** 生成某张表全部枚举 CHECK 语句（在 CREATE TABLE 之后执行）。 */
export function enumChecksForTable(table: string): string[] {
    return ENUM_COLUMN_BINDINGS.filter((binding) => binding.table === table).map(enumCheckSql);
}
