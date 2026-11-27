/**
 * 领域契约 zod 回归（T-E02-01，DDD §2/§3）：
 * - 各契约合法样本通过（含 JSON 往返——契约必须可安全序列化跨进程序边界）；
 * - 必填缺失 / 非法枚举 / 非法格式 / 未知字段（strict）被拒；
 * - 建模规则纯函数（§2.1 注，T-E11-06 消费）。
 */

import { describe, expect, it } from "vitest";
import {
    AgentDefinitionRecordSchema,
    AgentInputSchema,
    AgentResultSchema,
    ApplicationSchema,
    EnvironmentSchema,
    EvidenceReferenceSchema,
    SerializableAgentContextSchema,
    TestRunSchema,
    applicationCapabilities,
    validateRunModelingRules,
} from "./index.js";

const UUID = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
const UUID2 = "9e2e120d-08a2-4fc4-a04e-efd909c7577f";
const ISO = "2026-11-27T10:00:00.000Z";

const applicationSample = {
    id: UUID,
    projectId: UUID2,
    name: "Billing Portal",
    platform: "web",
    status: "active",
    config: { baseUrl: "https://billing.example.com", allowedDomains: ["example.com"] },
    createdAt: ISO,
    updatedAt: ISO,
};

const environmentSample = {
    id: UUID2,
    applicationId: UUID,
    name: "staging",
    type: "staging",
    baseUrl: "https://staging.example.com",
    policy: { readOnly: false, allowDestructiveActions: false, requireApproval: true },
    provisioning: {
        method: "docker-compose",
        composeFileRef: "s3://qa/compose/staging.yml",
        variables: { APP_ENV: "staging" },
        healthCheck: { path: "/healthz", timeoutSeconds: 30, intervalSeconds: 5 },
        resourceLimits: { maxCpus: 2, maxMemoryMb: 2048 },
    },
    status: "ready",
    createdAt: ISO,
};

const runSample = {
    id: UUID,
    projectId: UUID2,
    applicationId: UUID2,
    environmentId: UUID,
    objective: "冒烟回归下单主流程",
    platforms: ["web"],
    modes: ["smoke", "functional"],
    trigger: { source: "manual" },
    status: "queued",
    budget: { maxAgents: 4, maxDurationSeconds: 3600, maxModelCostUsd: 5, maxTokens: 200_000 },
    coverage: { page: 0 },
    temporalWorkflowId: "wf-123",
    createdAt: ISO,
};

const agentResultSample = {
    agentRunId: UUID2,
    agentRole: "explorer",
    agentVersion: "1.0.0",
    status: "completed",
    summary: "探索完成，覆盖 12 个页面",
    findings: [{ id: UUID, kind: "bug", fingerprint: "sha1:abc" }],
    evidence: [UUID],
    coverageUpdates: [{ dimension: "page", targetKey: "/", covered: true }],
    nextActions: [{ type: "delegate", target: "test-architect", reason: "产出页面知识" }],
    usage: { inputTokens: 1_000, outputTokens: 2_000, costUsd: 0.03 },
    confidence: 0.8,
};

const evidenceSample = {
    id: UUID,
    runId: UUID2,
    applicationId: UUID2,
    type: "screenshot",
    storageKey: "evidence/run-1/step-2.png",
    sha256: "a".repeat(64),
    metadata: { width: 1280 },
    createdAt: ISO,
};

describe("domain contracts parse & serialize (DDD §2)", () => {
    it("Application：合法样本 + JSON 往返", () => {
        const parsed = ApplicationSchema.parse(applicationSample);
        expect(parsed.config.allowedDomains).toEqual(["example.com"]);
        expect(ApplicationSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });

    it("Environment：合法样本（compose 供给 + 健康检查）", () => {
        const parsed = EnvironmentSchema.parse(environmentSample);
        expect(parsed.provisioning?.method).toBe("docker-compose");
        expect(parsed.provisioning?.healthCheck?.timeoutSeconds).toBe(30);
    });

    it("TestRun：合法样本 + 可选时间戳", () => {
        const parsed = TestRunSchema.parse(runSample);
        expect(parsed.trigger.source).toBe("manual");
        expect(parsed.startedAt).toBeUndefined();
        const started = TestRunSchema.parse({ ...runSample, startedAt: ISO });
        expect(started.startedAt).toBe(ISO);
    });

    it("AgentResult：合法样本（findings/evidence/coverage/nextActions）", () => {
        expect(AgentResultSchema.parse(agentResultSample).agentRole).toBe("explorer");
    });

    it("EvidenceReference：sha256 必须 64 位十六进制", () => {
        expect(EvidenceReferenceSchema.parse(evidenceSample).type).toBe("screenshot");
        expect(
            EvidenceReferenceSchema.safeParse({ ...evidenceSample, sha256: "xyz" }).success,
        ).toBe(false);
    });

    it("拒绝：缺必填 / 非法枚举 / 非法 UUID / 未知字段", () => {
        const { id: _omit, ...noId } = applicationSample;
        expect(ApplicationSchema.safeParse(noId).success).toBe(false);
        expect(
            ApplicationSchema.safeParse({ ...applicationSample, platform: "mobile" }).success,
        ).toBe(false);
        expect(ApplicationSchema.safeParse({ ...applicationSample, id: "not-uuid" }).success).toBe(
            false,
        );
        expect(ApplicationSchema.safeParse({ ...applicationSample, extra: 1 }).success).toBe(false);
        expect(TestRunSchema.safeParse({ ...runSample, status: "exploded" }).success).toBe(false);
        expect(EnvironmentSchema.safeParse({ ...environmentSample, type: "qa" }).success).toBe(
            false,
        );
        expect(AgentResultSchema.safeParse({ ...agentResultSample, confidence: 1.5 }).success).toBe(
            false,
        );
        expect(TestRunSchema.safeParse({ ...runSample, platforms: [] }).success).toBe(false);
    });
});

describe("agent contract (DDD §3)", () => {
    it("AgentInput 与可序列化 AgentContext 通过校验", () => {
        expect(AgentInputSchema.parse({ kind: "explore", payload: { maxPages: 5 } }).kind).toBe(
            "explore",
        );
        const context = SerializableAgentContextSchema.parse({
            runId: UUID,
            applicationId: UUID2,
            environmentId: UUID,
            objective: "冒烟",
            budget: { maxTokens: 100_000, maxModelCostUsd: 1 },
            permissions: ["browser.navigate"],
            traceId: "trace-1",
        });
        expect(context.permissions).toEqual(["browser.navigate"]);
    });

    it("预算非法值被拒（负成本 / 零 token）", () => {
        const badBudget = {
            ...runSample,
            budget: { maxAgents: 1, maxDurationSeconds: 1, maxModelCostUsd: -1, maxTokens: 100 },
        };
        expect(TestRunSchema.safeParse(badBudget).success).toBe(false);
        const zeroTokens = {
            ...runSample,
            budget: { maxAgents: 1, maxDurationSeconds: 1, maxModelCostUsd: 1, maxTokens: 0 },
        };
        expect(TestRunSchema.safeParse(zeroTokens).success).toBe(false);
    });

    it("AgentDefinitionRecord：config 缺省 {}、非法 effort/未知字段被拒（T-E02-02）", () => {
        const record = AgentDefinitionRecordSchema.parse({
            id: UUID2,
            name: "product-analyst",
            version: "1.0.0",
            promptVersion: "1",
            prompt: "You are the AQAOS Product Analyst.",
            enabled: true,
        });
        expect(record.config).toEqual({});
        const configured = AgentDefinitionRecordSchema.parse({
            id: UUID2,
            name: "explorer",
            version: "1.1.0",
            promptVersion: "2",
            prompt: "Explore.",
            config: {
                model: "claude-haiku-5-5",
                allowedTools: ["mcp__aqaos__navigate"],
                maxTurns: 6,
                effort: "medium",
                persistSession: false,
            },
            enabled: true,
        });
        expect(configured.config.effort).toBe("medium");
        expect(
            AgentDefinitionRecordSchema.safeParse({
                id: UUID2,
                name: "explorer",
                version: "1",
                promptVersion: "1",
                prompt: "p",
                config: { effort: "ultra" },
                enabled: true,
            }).success,
        ).toBe(false);
        expect(
            AgentDefinitionRecordSchema.safeParse({
                id: UUID2,
                name: "explorer",
                version: "1",
                promptVersion: "1",
                prompt: "p",
                config: { extra: 1 },
                enabled: true,
            }).success,
        ).toBe(false);
    });
});

describe("modeling rules (DDD §2.1 注，T-E11-06 消费)", () => {
    it("web 应用默认能力 {web}，配置 openApiUrl 后 {web, api}", () => {
        expect(applicationCapabilities(ApplicationSchema.parse(applicationSample))).toEqual([
            "web",
        ]);
        const webWithApi = ApplicationSchema.parse({
            ...applicationSample,
            config: {
                ...applicationSample.config,
                openApiUrl: "https://billing.example.com/openapi.json",
            },
        });
        expect(applicationCapabilities(webWithApi)).toEqual(["web", "api"]);
        expect(
            applicationCapabilities(
                ApplicationSchema.parse({ ...applicationSample, platform: "api" }),
            ),
        ).toEqual(["api"]);
    });

    it("api 应用缺 openApiUrl → 违规；run platforms 超出能力集 → 违规", () => {
        const apiApp = ApplicationSchema.parse({
            ...applicationSample,
            platform: "api",
            config: { allowedDomains: [] },
        });
        expect(validateRunModelingRules(TestRunSchema.parse(runSample), apiApp)).toContain(
            "api application must provide config.openApiUrl",
        );

        const webApp = ApplicationSchema.parse(applicationSample);
        const apiRun = TestRunSchema.parse({ ...runSample, platforms: ["api"] });
        expect(validateRunModelingRules(apiRun, webApp)).toHaveLength(1);

        const webWithApi = ApplicationSchema.parse({
            ...applicationSample,
            config: {
                ...applicationSample.config,
                openApiUrl: "https://billing.example.com/openapi.json",
            },
        });
        expect(validateRunModelingRules(apiRun, webWithApi)).toEqual([]);
    });
});
