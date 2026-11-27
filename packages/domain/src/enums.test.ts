/**
 * 枚举字典与 zod Schema 一致性回归（T-E02-01）：
 * - 字典↔Schema 一一对应（每个 §7.3 键都有导出 Schema，值域逐值相等）；
 * - 非法值被拒（应用层枚举的"应用层约束"职责，0003 迁移注释移交项）；
 * - 角色字典完整性（十六角色、id↔展示名一一对应、等级单调）。
 * 字典↔DDD §7.3 的逐值对照由 tests/regression/enum-dictionary.spec.ts（经
 * db/enum-dictionary.ts re-export 本包）守护，此处不重复。
 */

import { describe, expect, it } from "vitest";
import {
    AGENT_ROLE_DISPLAY_NAMES,
    AGENT_ROLE_IDS,
    ENUM_DICTIONARY,
    MEMBERSHIP_ROLE_RANK,
    MembershipRoleSchema,
    RunStatusSchema,
    type EnumKey,
} from "./enums.js";

/** 字典键 → 本包导出的 zod Schema（补新字典键时必须同步补 Schema 与此表）。 */
import * as enums from "./enums.js";

const SCHEMA_BY_ENUM_KEY: Partial<Record<EnumKey, { options: readonly string[] }>> = {
    runStatus: RunStatusSchema,
    environmentStackStatus: enums.EnvironmentStackStatusSchema,
    testCaseStatus: enums.TestCaseStatusSchema,
    reviewStatus: enums.ReviewStatusSchema,
    bugSeverity: enums.BugSeveritySchema,
    bugStatus: enums.BugStatusSchema,
    failureClassification: enums.FailureClassificationSchema,
    approvalStatus: enums.ApprovalStatusSchema,
    approvalRiskLevel: enums.ApprovalRiskLevelSchema,
    memoryKind: enums.MemoryKindSchema,
    factConfidence: enums.FactConfidenceSchema,
    dataSensitivity: enums.DataSensitivitySchema,
    platform: enums.PlatformSchema,
    triggerSource: enums.TriggerSourceSchema,
    integrationKind: enums.IntegrationKindSchema,
    externalIssueStatus: enums.ExternalIssueStatusSchema,
};

describe("enum dictionary ↔ zod schemas (T-E02-01)", () => {
    it("每个 §7.3 字典键都有导出 Schema 且值域逐值一致", () => {
        for (const key of Object.keys(ENUM_DICTIONARY) as EnumKey[]) {
            const schema = SCHEMA_BY_ENUM_KEY[key];
            expect(schema, `enum key ${key} missing exported schema`).toBeDefined();
            expect([...(schema?.options ?? [])]).toEqual([...ENUM_DICTIONARY[key]]);
        }
    });

    it("Schema 接受全部字典值，拒绝非法值", () => {
        for (const value of ENUM_DICTIONARY.runStatus) {
            expect(RunStatusSchema.safeParse(value).success).toBe(true);
        }
        expect(RunStatusSchema.safeParse("exploded").success).toBe(false);
        expect(RunStatusSchema.safeParse("").success).toBe(false);
        expect(enums.PlatformSchema.safeParse("mobile").success).toBe(false);
        expect(enums.BugStatusSchema.safeParse("closed").success).toBe(false);
    });

    it("应用层枚举：非法值被拒（0003 迁移注释移交的约束职责）", () => {
        expect(MembershipRoleSchema.safeParse("guest").success).toBe(false);
        expect(enums.TestResultStatusSchema.safeParse("errored").success).toBe(false);
        expect(enums.BugVerificationStatusSchema.safeParse("maybe").success).toBe(false);
        expect(enums.TestSuiteKindSchema.safeParse("mobile").success).toBe(false);
        expect(enums.EvidenceTypeSchema.safeParse("photo").success).toBe(false);
        expect(enums.ProvisioningMethodSchema.safeParse("k8s").success).toBe(false);
        expect(enums.EnvironmentTypeSchema.safeParse("qa").success).toBe(false);
    });
});

describe("membership role ladder (T-E02-01)", () => {
    it("viewer < member < admin < owner 单调且覆盖全部角色", () => {
        const roles = MembershipRoleSchema.options;
        expect(roles).toEqual(["viewer", "member", "admin", "owner"]);
        const ranks = roles.map((role) => MEMBERSHIP_ROLE_RANK[role]);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
        expect(new Set(ranks).size).toBe(roles.length);
    });
});

describe("agent role registry (SRS 3.1 十六角色)", () => {
    it("16 个唯一 id，展示名一一对应", () => {
        expect(AGENT_ROLE_IDS).toHaveLength(16);
        expect(new Set(AGENT_ROLE_IDS).size).toBe(16);
        for (const id of AGENT_ROLE_IDS) {
            expect(AGENT_ROLE_DISPLAY_NAMES[id]?.length ?? 0).toBeGreaterThan(0);
        }
        expect(Object.keys(AGENT_ROLE_DISPLAY_NAMES)).toHaveLength(16);
        expect(enums.AgentRoleIdSchema.safeParse("qa-manager").success).toBe(true);
        expect(enums.AgentRoleIdSchema.safeParse("mobile-tester").success).toBe(false);
    });
});
