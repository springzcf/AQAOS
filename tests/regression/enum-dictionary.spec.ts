/**
 * 枚举字典 ↔ DDD §7.3 一致性回归（T-E01-07）。
 * 本文件硬拷贝 docs/03-详细设计说明书.md §7.3 的表格：文档变更须同步改这里与
 * db/enum-dictionary.ts，三方一致才允许合并。
 */

import { describe, expect, it } from "vitest";
import { ENUM_COLUMN_BINDINGS, ENUM_DICTIONARY } from "../../db/enum-dictionary.js";

const DDD_7_3: Record<string, string[]> = {
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
};

describe("enum dictionary (DDD §7.3)", () => {
    it("枚举键与 DDD §7.3 完全一致", () => {
        expect(Object.keys(ENUM_DICTIONARY).sort()).toEqual(Object.keys(DDD_7_3).sort());
    });

    it.each(Object.keys(DDD_7_3))("枚举 %s 值列表逐项一致", (key) => {
        expect([...ENUM_DICTIONARY[key as keyof typeof ENUM_DICTIONARY]]).toEqual(DDD_7_3[key]);
    });

    it("列绑定只引用已知枚举键", () => {
        const keys = new Set(Object.keys(ENUM_DICTIONARY));
        for (const binding of ENUM_COLUMN_BINDINGS) {
            expect(keys.has(binding.enumKey)).toBe(true);
        }
    });

    it("列绑定无重复（表+列唯一）", () => {
        const ids = ENUM_COLUMN_BINDINGS.map((b) => `${b.table}.${b.column}`);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
