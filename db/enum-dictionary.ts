/**
 * 数据库枚举字典（T-E01-07）。
 *
 * 单一事实源：docs/03-详细设计说明书.md §7.3 枚举字典。
 * - DB CHECK 约束由各 migration 通过 {@link enumCheckSql} 从本字典生成，禁止手抄值列表；
 * - T-E02-01 Domain Contracts 的 zod 枚举必须从本文件导入；
 * - tests/regression/enum-dictionary.spec.ts 逐值断言本文件与 DDD §7.3 一致（防文档/代码漂移）。
 */

export const ENUM_DICTIONARY = {
    runStatus: ["queued", "running", "paused", "blocked", "completed", "failed", "cancelled"],
    environmentStackStatus: ["unprovisioned", "provisioning", "ready", "failed", "stopped"],
    testCaseStatus: ["draft", "active", "deprecated"],
    reviewStatus: ["pending", "approved", "rejected"],
    bugSeverity: ["critical", "high", "medium", "low"],
    bugStatus: [
        "candidate",
        "triaging",
        "verifying",
        "verified",
        "rejected",
        "open",
        "fixed",
        "regression_passed",
        "reopened",
    ],
    failureClassification: [
        "product-bug",
        "test-bug",
        "environment",
        "network",
        "flaky",
        "model-error",
        "unknown",
    ],
    approvalStatus: ["pending", "approved", "rejected", "expired"],
    approvalRiskLevel: ["medium", "high", "critical"],
    memoryKind: ["product", "exploration", "test", "bug", "feedback"],
    factConfidence: ["confirmed", "inferred", "unknown"],
    dataSensitivity: ["public", "internal", "confidential"],
    platform: ["web", "api"],
    triggerSource: ["manual", "schedule", "event", "ci"],
    integrationKind: ["jira", "github", "gitlab", "ci"],
    externalIssueStatus: ["open", "in_progress", "resolved", "closed"],
} as const satisfies Record<string, readonly string[]>;

export type EnumKey = keyof typeof ENUM_DICTIONARY;
export type EnumValue<K extends EnumKey> = (typeof ENUM_DICTIONARY)[K][number];

/** 表列 → 枚举 绑定清单：DB CHECK 约束只允许出现在此清单里，新增绑定须同步对应 migration。 */
export interface EnumColumnBinding {
    readonly table: string;
    readonly column: string;
    readonly enumKey: EnumKey;
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

export function enumValues(key: EnumKey): readonly string[] {
    return ENUM_DICTIONARY[key];
}

/** 生成 CHECK 约束 SQL（值列表来自字典，杜绝手抄漂移）。 */
export function enumCheckSql(binding: EnumColumnBinding): string {
    const values = ENUM_DICTIONARY[binding.enumKey].map((value) => `'${value}'`).join(", ");
    return `ALTER TABLE ${binding.table} ADD CONSTRAINT ${binding.table}_${binding.column}_check CHECK (${binding.column} IN (${values}));`;
}

/** 生成某张表全部枚举 CHECK 语句（在 CREATE TABLE 之后执行）。 */
export function enumChecksForTable(table: string): string[] {
    return ENUM_COLUMN_BINDINGS.filter((binding) => binding.table === table).map(enumCheckSql);
}
