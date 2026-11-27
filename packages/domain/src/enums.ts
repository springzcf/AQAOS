/**
 * 枚举字典（T-E02-01，领域层单一事实源）。
 *
 * - `ENUM_DICTIONARY` 的数据库侧消费方：db/enum-dictionary.ts 经源码相对导入
 *   re-export 本表并生成 CHECK 约束（migrations 0001-0006）；tests/regression/
 *   enum-dictionary.spec.ts 逐值对照 DDD §7.3 硬拷贝（防文档/代码漂移）；
 * - 应用层消费方：本文件导出的 zod Schema 是前后端/Worker 的唯一校验入口；
 * - 应用层枚举（不在 §7.3 的 DB CHECK 清单内）：membershipRole（DB CHECK 待
 *   T-E11-05 RBAC 矩阵定稿）、environmentType/provisioningMethod（§2.2 契约值）、
 *   applicationStatus（§2.1）、agentResultStatus（§2.4）、evidenceType（§2.5）、
 *   testResultStatus/bugVerificationStatus/testSuiteKind/coverageDimension
 *   （0003 迁移注释显式移交 T-E02-01 应用层约束）、agentRole（SRS 3.1 十六角色）、
 *   testMode（DDD §11 Test Architect 十二类测试）。
 */

import { z } from "zod";

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

export function enumValues(key: EnumKey): readonly string[] {
    return ENUM_DICTIONARY[key];
}

// ---- §7.3 枚举的 zod Schema（与字典同源，杜绝手抄漂移） ----

export const RunStatusSchema = z.enum(ENUM_DICTIONARY.runStatus);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const EnvironmentStackStatusSchema = z.enum(ENUM_DICTIONARY.environmentStackStatus);
export type EnvironmentStackStatus = z.infer<typeof EnvironmentStackStatusSchema>;

export const TestCaseStatusSchema = z.enum(ENUM_DICTIONARY.testCaseStatus);
export type TestCaseStatus = z.infer<typeof TestCaseStatusSchema>;

export const ReviewStatusSchema = z.enum(ENUM_DICTIONARY.reviewStatus);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const BugSeveritySchema = z.enum(ENUM_DICTIONARY.bugSeverity);
export type BugSeverity = z.infer<typeof BugSeveritySchema>;

export const BugStatusSchema = z.enum(ENUM_DICTIONARY.bugStatus);
export type BugStatus = z.infer<typeof BugStatusSchema>;

export const FailureClassificationSchema = z.enum(ENUM_DICTIONARY.failureClassification);
export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

export const ApprovalStatusSchema = z.enum(ENUM_DICTIONARY.approvalStatus);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRiskLevelSchema = z.enum(ENUM_DICTIONARY.approvalRiskLevel);
export type ApprovalRiskLevel = z.infer<typeof ApprovalRiskLevelSchema>;

export const MemoryKindSchema = z.enum(ENUM_DICTIONARY.memoryKind);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const FactConfidenceSchema = z.enum(ENUM_DICTIONARY.factConfidence);
export type FactConfidence = z.infer<typeof FactConfidenceSchema>;

export const DataSensitivitySchema = z.enum(ENUM_DICTIONARY.dataSensitivity);
export type DataSensitivity = z.infer<typeof DataSensitivitySchema>;

export const PlatformSchema = z.enum(ENUM_DICTIONARY.platform);
export type Platform = z.infer<typeof PlatformSchema>;

export const TriggerSourceSchema = z.enum(ENUM_DICTIONARY.triggerSource);
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export const IntegrationKindSchema = z.enum(ENUM_DICTIONARY.integrationKind);
export type IntegrationKind = z.infer<typeof IntegrationKindSchema>;

export const ExternalIssueStatusSchema = z.enum(ENUM_DICTIONARY.externalIssueStatus);
export type ExternalIssueStatus = z.infer<typeof ExternalIssueStatusSchema>;

// ---- 应用层枚举（无 DB CHECK，契约/Worker 校验用） ----

/** 成员角色（viewer < member < admin < owner；memberships.role 的 CHECK 待 T-E11-05）。 */
export const MembershipRoleSchema = z.enum(["viewer", "member", "admin", "owner"]);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

/** 角色等级（RBAC minRole 比较；domain 纯逻辑，auth 插件消费）。 */
export const MEMBERSHIP_ROLE_RANK: Readonly<Record<MembershipRole, number>> = Object.freeze({
    viewer: 0,
    member: 1,
    admin: 2,
    owner: 3,
});

/** 环境类型（DDD §2.2）。 */
export const EnvironmentTypeSchema = z.enum([
    "development",
    "testing",
    "staging",
    "preproduction",
    "production",
]);
export type EnvironmentType = z.infer<typeof EnvironmentTypeSchema>;

/** 环境供给方式（DDD §12：external=外部已有服务；docker-compose=平台编排拉起）。 */
export const ProvisioningMethodSchema = z.enum(["external", "docker-compose"]);
export type ProvisioningMethod = z.infer<typeof ProvisioningMethodSchema>;

/** 应用状态（DDD §2.1）。 */
export const ApplicationStatusSchema = z.enum(["active", "inactive"]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/** Agent 结果状态（DDD §2.4）。 */
export const AgentResultStatusSchema = z.enum(["completed", "partial", "blocked", "failed"]);
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

/** 证据类型（DDD §2.5）。 */
export const EvidenceTypeSchema = z.enum([
    "screenshot",
    "video",
    "trace",
    "har",
    "log",
    "api-response",
    "environment-log",
    "report",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** 用例执行结果状态（0003 迁移注释移交 T-E02-01；无 DB CHECK）。 */
export const TestResultStatusSchema = z.enum([
    "passed",
    "failed",
    "flaky",
    "skipped",
    "quarantined",
]);
export type TestResultStatus = z.infer<typeof TestResultStatusSchema>;

/** Bug 独立复现验证结论（0003 迁移注释：verified/rejected/inconclusive）。 */
export const BugVerificationStatusSchema = z.enum(["verified", "rejected", "inconclusive"]);
export type BugVerificationStatus = z.infer<typeof BugVerificationStatusSchema>;

/** 套件类型（test_suites.kind；§11 十二类测试的常用组合）。 */
export const TestSuiteKindSchema = z.enum([
    "smoke",
    "functional",
    "boundary",
    "negative",
    "integration",
    "regression",
    "authorization",
    "security",
    "performance",
    "exploratory",
    "state-transition",
    "compatibility",
]);
export type TestSuiteKind = z.infer<typeof TestSuiteKindSchema>;

/** 测试模式（DDD §11 十二类测试；TestRun.modes 与 Test Architect 策略共用）。 */
export const TestModeSchema = TestSuiteKindSchema;
export type TestMode = TestSuiteKind;

/** 覆盖维度初始值域（coverage_records.dimension；0003 注释"页面/接口/角色/风险…"）。 */
export const CoverageDimensionSchema = z.enum(["page", "endpoint", "journey", "role", "risk"]);
export type CoverageDimension = z.infer<typeof CoverageDimensionSchema>;

/** Agent 角色（SRS 3.1 十六角色契约；agent_definitions.name 的规范 id）。 */
export const AGENT_ROLE_IDS = [
    "qa-manager",
    "product-analyst",
    "planner",
    "explorer",
    "test-architect",
    "test-generator",
    "web-tester",
    "api-tester",
    "security-tester",
    "performance-tester",
    "triage-agent",
    "bug-verifier",
    "root-cause-analyst",
    "regression-agent",
    "self-healing-agent",
    "reporter",
] as const;
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

export const AgentRoleIdSchema = z.enum(AGENT_ROLE_IDS);

/** 角色 id → 展示名（UI/报告用；与 AGENT_ROLE_IDS 一一对应，测试守护）。 */
export const AGENT_ROLE_DISPLAY_NAMES: Readonly<Record<AgentRoleId, string>> = Object.freeze({
    "qa-manager": "QA Manager",
    "product-analyst": "Product Analyst",
    planner: "Planner",
    explorer: "Explorer",
    "test-architect": "Test Architect",
    "test-generator": "Test Generator",
    "web-tester": "Web Tester",
    "api-tester": "API Tester",
    "security-tester": "Security Tester",
    "performance-tester": "Performance Tester",
    "triage-agent": "Triage Agent",
    "bug-verifier": "Bug Verifier",
    "root-cause-analyst": "Root Cause Analyst",
    "regression-agent": "Regression Agent",
    "self-healing-agent": "Self-Healing Agent",
    reporter: "Reporter",
});
