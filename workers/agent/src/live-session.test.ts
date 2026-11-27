/**
 * T-E02-02 验收：一个最小角色会话在 agent-worker 内 headless 跑通并计量。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 走真实 Claude Agent SDK 子进程与真实凭据，花真实 token——最小提示词控制成本）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentContext, AgentDefinitionRecord } from "@aqaos/domain";
import { runAgentSession } from "./agent-session.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const UUID = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
const UUID2 = "9e2e120d-08a2-4fc4-a04e-efd909c7577f";

/** 最小角色定义：会话型（product-analyst 形态，零工具纯推理）。 */
const minimalDefinition: AgentDefinitionRecord = {
    id: UUID2,
    name: "product-analyst",
    version: "0.1.0",
    promptVersion: "probe-1",
    prompt: [
        "You are a minimal AQAOS probe agent (Product Analyst seat).",
        "Reply with exactly the single word: OK",
    ].join(" "),
    config: {},
    enabled: true,
};

const context: AgentContext = {
    runId: UUID,
    applicationId: UUID2,
    environmentId: UUID,
    objective: "T-E02-02 headless session acceptance",
    budget: { maxTokens: 50_000, maxModelCostUsd: 1, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0202-live-acceptance",
};

describe.skipIf(!LIVE)("live minimal agent session (T-E02-02 acceptance)", () => {
    it("最小角色会话 headless 跑通并计量", { timeout: 180_000 }, async () => {
        const usageReports: Array<{ inputTokens: number; outputTokens: number }> = [];
        const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-session-"));
        const outcome = await runAgentSession({
            definition: minimalDefinition,
            context,
            prompt: "Reply now.",
            cwd,
            onUsage: (snapshot) =>
                usageReports.push({
                    inputTokens: snapshot.inputTokens,
                    outputTokens: snapshot.outputTokens,
                }),
        });
        // 跑通：success 终态 + 非空输出。
        expect(outcome.status).toBe("completed");
        expect(outcome.resultText.trim()).toBe("OK");
        expect(outcome.sessionId).toBeDefined();
        // 计量：token/成本/轮次/时长全部落表，且与 onUsage 回报一致。
        expect(outcome.usage.inputTokens).toBeGreaterThan(0);
        expect(outcome.usage.outputTokens).toBeGreaterThan(0);
        expect(outcome.usage.costUsd).toBeGreaterThanOrEqual(0);
        expect(outcome.usage.numTurns).toBeGreaterThanOrEqual(1);
        expect(outcome.usage.durationMs).toBeGreaterThanOrEqual(0);
        expect(usageReports.length).toBeGreaterThanOrEqual(1);
        expect(usageReports[0]?.inputTokens).toBe(outcome.usage.inputTokens);
        // 预算传导：SDK 原生成本上限 = AgentContext.budget.maxModelCostUsd。
        // （无需触发，此处只验证映射不报错——上面 completed 已隐含。）
    });
});
