/**
 * T-E02-05 验收（QA Manager 统筹）：真实 Claude Agent SDK 子进程的
 * 多子代理并行委派端到端实证——Options.agents 注册的委派面 + Task 工具
 * 后台并行委派 + task_started/task_updated 事件流投影到结构化 QaPlan
 * + 派发闸门放行（预算内委派真实通过 canUseTool 桥）。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 花真实 token——子任务均为一词回复的最小探测，控制成本）。
 * 注意：本测试不带 MCP servers（委派面/事件流/闸门才是被测对象）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QaPlanSchema, type AgentContext, type AgentDefinitionRecord } from "@aqaos/domain";
import { runQaManagerSession } from "./qa-manager.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const QA_MANAGER: AgentDefinitionRecord = {
    id: "8e2e120d-08a2-4fc4-a04e-efd909c7577e",
    name: "qa-manager",
    version: "1",
    promptVersion: "probe-qam-1",
    prompt: [
        "You are a minimal AQAOS QA Manager probe orchestrating two specialist subagents.",
        "Delegate exactly two small tasks as background agents in parallel:",
        "one to the 'reporter' agent and one to the 'triage-agent' agent.",
        "The reporter task: reply with the single word READY-R.",
        "The triage task: reply with the single word READY-T.",
        "When both subagents have finished, reply DONE.",
    ].join(" "),
    config: {},
    enabled: true,
};

const REPORTER_PROBE: AgentDefinitionRecord = {
    id: "8e2e120d-08a2-4fc4-a04e-efd909c7577f",
    name: "reporter",
    version: "1",
    promptVersion: "probe-sub-1",
    prompt: "You are a minimal AQAOS subagent probe. Complete the given task immediately with a one-word reply and nothing else.",
    config: {},
    enabled: true,
};

const TRIAGE_PROBE: AgentDefinitionRecord = {
    ...REPORTER_PROBE,
    id: "8e2e120d-08a2-4fc4-a04e-efd909c7577a",
    name: "triage-agent",
};

const PLAN = QaPlanSchema.parse({
    tasks: [
        { id: "rep", role: "reporter", objective: "Reply READY-R" },
        { id: "tri", role: "triage-agent", objective: "Reply READY-T" },
    ],
});

const agentContext: AgentContext = {
    runId: "8e2e120d-08a2-4fc4-a04e-efd909c7577b",
    applicationId: "8e2e120d-08a2-4fc4-a04e-efd909c7577c",
    environmentId: "8e2e120d-08a2-4fc4-a04e-efd909c7577d",
    objective: "T-E02-05 QA Manager orchestration acceptance",
    budget: { maxTokens: 120_000, maxModelCostUsd: 2, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0205-live-acceptance",
};

describe.skipIf(!LIVE)("live QA Manager orchestration (T-E02-05 acceptance)", () => {
    it(
        "QA Manager 并行委派双子代理：事件流可观测、计划投影落态、预算内派发放行",
        { timeout: 300_000 },
        async () => {
            const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-qam-"));
            const outcome = await runQaManagerSession({
                definition: QA_MANAGER,
                subagentDefinitions: [REPORTER_PROBE, TRIAGE_PROBE],
                context: agentContext,
                prompt: "Orchestrate now: delegate the two tasks to reporter and triage-agent as parallel background agents, then reply DONE.",
                plan: PLAN,
                cwd,
            });

            // 会话成功终态（委派真实发生且闸门放行——预算内）。
            expect(outcome.session.status).toBe("completed");
            expect(outcome.session.resultText.toUpperCase()).toContain("DONE");

            // 多 Agent 并行委派可观测：两角色各至少一条 task_started。
            const started = outcome.events.filter((event) => event.kind === "started");
            const startedRoles = new Set(started.map((event) => event.subagentType));
            expect(started.length).toBeGreaterThanOrEqual(2);
            expect(startedRoles.has("reporter")).toBe(true);
            expect(startedRoles.has("triage-agent")).toBe(true);

            // 计划投影：两任务随子代理完成落 completed。
            expect(outcome.projection.statuses.rep).toBe("completed");
            expect(outcome.projection.statuses.tri).toBe("completed");
            expect(outcome.projection.progress.done).toBe(true);

            // 会话可恢复（多轮/Query 控制面前提）+ 用量含子代理累计。
            expect(outcome.session.sessionId).toBeTruthy();
            expect(
                outcome.session.usage.inputTokens + outcome.session.usage.outputTokens,
            ).toBeGreaterThan(0);
        },
    );
});
