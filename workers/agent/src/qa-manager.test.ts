/**
 * QA Manager 统筹引擎回归（T-E02-05）。
 *
 * 离线全链路（queryFn 注入假流，生产/测试同构）：
 * - 派发闸门：预算耗尽拒绝一切工具调用（验收"预算超限停止派发"）、
 *   预算内放行、审批 seam 拒绝传导；
 * - 任务事件投影：task_started/updated/progress 消息 → 事件流 + 计划
 *   状态板（含失败传导 skipped、多任务同角色 FIFO 绑定）；
 * - 编排：子代理注册进 SDK Options.agents + persistSession 强制 true +
 *   agentProgressSummaries 开启；会话用量经 onUsage 回读进闸门快照；
 * - 多轮：resumeQaManagerSession 把 sessionId 传进 Options.resume
 *   （Query 控制面续会原语）。
 */

import { describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { QaPlanSchema, type AgentContext, type AgentDefinitionRecord } from "@aqaos/domain";
import {
    createDispatchGate,
    QaPlanTracker,
    resumeQaManagerSession,
    runQaManagerSession,
    taskEventFromMessage,
    toSdkAgents,
    toSdkSubagent,
    type QaTaskEvent,
} from "./qa-manager.js";
import type { SessionUsageSnapshot } from "./session-meter.js";

const DEFINITION: AgentDefinitionRecord = {
    id: "d1000000-0000-4000-8000-000000000001",
    name: "qa-manager",
    version: "1",
    promptVersion: "0.1.0",
    prompt: "You are the AQAOS QA Manager (qa-manager), the conversational control-plane agent.",
    config: {},
    enabled: true,
};

const REPORTER: AgentDefinitionRecord = {
    id: "d1000000-0000-4000-8000-000000000002",
    name: "reporter",
    version: "1",
    promptVersion: "0.1.0",
    prompt: "You are the AQAOS Reporter (reporter), the results-communication agent.",
    config: { allowedTools: ["mcp__aqaos__qa_get_run"] },
    enabled: true,
};

const TRIAGE: AgentDefinitionRecord = {
    ...REPORTER,
    id: "d1000000-0000-4000-8000-000000000003",
    name: "triage-agent",
    prompt: "You are the AQAOS Triage Agent (triage-agent), the failure-classification agent.",
};

const CONTEXT: AgentContext = {
    runId: "61000000-0000-4000-8000-000000000001",
    applicationId: "41000000-0000-4000-8000-000000000001",
    environmentId: "51000000-0000-4000-8000-000000000001",
    objective: "Summarize run state",
    budget: { maxTokens: 10_000, maxModelCostUsd: 5 },
    permissions: ["qa-control.read"],
    traceId: "trace-1",
};

const usage = (partial: Partial<SessionUsageSnapshot>): SessionUsageSnapshot => ({
    numTurns: 1,
    durationMs: 10,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    perModel: {},
    toolUseCount: 0,
    ...partial,
});

describe("createDispatchGate（派发闸门，验收：预算超限停止派发）", () => {
    /** 调闸门（第三参补齐 SDK 必填的 toolUseID/requestId）。 */
    const call = (
        gate: ReturnType<typeof createDispatchGate>,
        toolName: string,
        input: Record<string, unknown>,
    ) =>
        gate(toolName, input, {
            signal: new AbortController().signal,
            toolUseID: "tu-1",
            requestId: "req-1",
        });

    it("token 预算耗尽 → 拒绝一切工具调用（含 Task 委派），拒绝理由明确", async () => {
        const gate = createDispatchGate({
            budget: { maxTokens: 1_000, maxModelCostUsd: 5 },
            usageSnapshot: () => usage({ inputTokens: 600, outputTokens: 500 }),
        });
        const decision = await call(gate, "Task", { subagent_type: "reporter", prompt: "go" });
        expect(decision).toMatchObject({ behavior: "deny" });
        expect((decision as { message: string }).message).toContain("budget exhausted");
    });

    it("成本预算耗尽 → 拒绝；预算内 → 放行", async () => {
        const overCost = createDispatchGate({
            budget: { maxTokens: 10_000, maxModelCostUsd: 1 },
            usageSnapshot: () => usage({ costUsd: 1.2 }),
        });
        expect(await call(overCost, "mcp__aqaos__qa_get_run", {})).toMatchObject({
            behavior: "deny",
        });
        const healthy = createDispatchGate({
            budget: { maxTokens: 10_000, maxModelCostUsd: 1 },
            usageSnapshot: () => usage({ costUsd: 0.2 }),
        });
        expect(await call(healthy, "mcp__aqaos__qa_get_run", {})).toEqual({ behavior: "allow" });
    });

    it("审批 seam：返回 false 拒绝、true 放行；未设 seam 放行", async () => {
        const approve = vi.fn().mockResolvedValue(false);
        const denied = createDispatchGate({
            budget: CONTEXT.budget,
            usageSnapshot: () => usage({}),
            approval: approve,
        });
        const decision = await call(denied, "Task", { subagent_type: "explorer" });
        expect(decision).toMatchObject({ behavior: "deny" });
        expect((decision as { message: string }).message).toContain("not approved");
        expect(approve).toHaveBeenCalledWith({
            toolName: "Task",
            input: { subagent_type: "explorer" },
        });

        const allowed = createDispatchGate({
            budget: CONTEXT.budget,
            usageSnapshot: () => usage({}),
            approval: vi.fn().mockResolvedValue(true),
        });
        expect(await call(allowed, "Task", {})).toEqual({ behavior: "allow" });
    });
});

describe("toSdkSubagent / toSdkAgents（委派面映射）", () => {
    it("record → SDK AgentDefinition：prompt/工具白名单/模型/omitClaudeMd 隔离", () => {
        const agent = toSdkSubagent(REPORTER);
        expect(agent.prompt).toBe(REPORTER.prompt);
        expect(agent.tools).toEqual(["mcp__aqaos__qa_get_run"]);
        expect(agent.model).toBeUndefined();
        expect(agent.omitClaudeMd).toBe(true);
        expect(agent.description).toContain("Reporter");
    });

    it("集合 → Options.agents 映射（name=角色 id）", () => {
        const agents = toSdkAgents([REPORTER, TRIAGE]);
        expect(Object.keys(agents).sort()).toEqual(["reporter", "triage-agent"]);
        expect(agents.reporter?.prompt).toBe(REPORTER.prompt);
    });
});

describe("taskEventFromMessage / QaPlanTracker（事件投影）", () => {
    const message = (subtype: string, extra: Record<string, unknown>): SDKMessage =>
        ({ type: "system", subtype, ...extra }) as unknown as SDKMessage;

    it("task_* 系统消息 → 事件（usage 字段映射），非任务消息 → null", () => {
        const started = taskEventFromMessage(
            message("task_started", {
                task_id: "t1",
                subagent_type: "reporter",
                description: "Write report",
            }),
        );
        expect(started).toMatchObject({ kind: "started", taskId: "t1", subagentType: "reporter" });
        const progress = taskEventFromMessage(
            message("task_progress", {
                task_id: "t1",
                usage: { total_tokens: 120, tool_uses: 2, duration_ms: 3400 },
                summary: "Drafting report",
            }),
        );
        expect(progress).toMatchObject({
            kind: "progress",
            usage: { totalTokens: 120, toolUses: 2, durationMs: 3400 },
            summary: "Drafting report",
        });
        expect(taskEventFromMessage(message("init", {}))).toBeNull();
        expect(taskEventFromMessage({ type: "assistant" } as unknown as SDKMessage)).toBeNull();
    });

    it("live 实证形状：task_updated 状态在 patch.status；task_notification 观测为 progress", () => {
        // task_updated（后台任务终态）——状态嵌在 patch 里而非顶层。
        const updated = taskEventFromMessage(
            message("task_updated", {
                task_id: "t1",
                patch: { status: "completed", end_time: 1795757087167 },
            }),
        );
        expect(updated).toMatchObject({ kind: "updated", taskId: "t1", status: "completed" });
        // 顶层 status 优先（task_notification 原生形态）。
        const updatedTop = taskEventFromMessage(
            message("task_updated", { task_id: "t2", status: "failed" }),
        );
        expect(updatedTop).toMatchObject({ kind: "updated", taskId: "t2", status: "failed" });

        // task_notification：status/summary/usage 观测事件（不改计划状态）。
        const notification = taskEventFromMessage(
            message("task_notification", {
                task_id: "t1",
                status: "completed",
                summary: "READY-R",
                usage: { total_tokens: 1894, tool_uses: 0, duration_ms: 2277 },
            }),
        );
        expect(notification).toMatchObject({
            kind: "progress",
            taskId: "t1",
            status: "completed",
            summary: "READY-R",
            usage: { totalTokens: 1894, toolUses: 0, durationMs: 2277 },
        });
    });

    it("投影：started 绑定角色 FIFO，completed 落态，failed 传导 skipped 闭包", () => {
        const plan = QaPlanSchema.parse({
            tasks: [
                { id: "tri", role: "triage-agent", objective: "Triage failures", dependsOn: [] },
                { id: "rep", role: "reporter", objective: "Write report", dependsOn: ["tri"] },
                { id: "reg", role: "regression-agent", objective: "Retest", dependsOn: [] },
            ],
        });
        const tracker = new QaPlanTracker(plan);
        const ev = (
            kind: QaTaskEvent["kind"],
            taskId: string,
            extra: Record<string, unknown> = {},
        ): QaTaskEvent =>
            ({ kind, taskId, observedAt: "2026-11-27T00:00:00.000Z", ...extra }) as QaTaskEvent;

        tracker.apply(ev("started", "sdk-1", { subagentType: "triage-agent" }));
        tracker.apply(ev("progress", "sdk-1", {}));
        expect(tracker.snapshot().statuses.tri).toBe("running");

        // triage 失败 → reporter（依赖）传导 skipped；regression 不受影响。
        tracker.apply(ev("updated", "sdk-1", { status: "failed" }));
        const snapshot = tracker.snapshot();
        expect(snapshot.statuses.tri).toBe("failed");
        expect(snapshot.statuses.rep).toBe("skipped");
        expect(snapshot.statuses.reg).toBe("pending");
        expect(snapshot.progress).toMatchObject({ total: 3, failed: 1, skipped: 1, pending: 1 });
        expect(snapshot.taskBinding).toEqual({ "sdk-1": "tri" });
    });

    it("同角色多任务 FIFO 绑定；updated 未绑定且非计划 id 忽略", () => {
        const plan = QaPlanSchema.parse({
            tasks: [
                { id: "r1", role: "reporter", objective: "First report" },
                { id: "r2", role: "reporter", objective: "Second report" },
            ],
        });
        const tracker = new QaPlanTracker(plan);
        tracker.apply({
            kind: "started",
            taskId: "sdk-a",
            subagentType: "reporter",
            observedAt: "t",
        });
        tracker.apply({
            kind: "started",
            taskId: "sdk-b",
            subagentType: "reporter",
            observedAt: "t",
        });
        expect(tracker.snapshot().statuses.r1).toBe("running");
        expect(tracker.snapshot().statuses.r2).toBe("running");
        tracker.apply({ kind: "updated", taskId: "sdk-a", status: "completed", observedAt: "t" });
        tracker.apply({
            kind: "updated",
            taskId: "sdk-ghost",
            status: "completed",
            observedAt: "t",
        });
        const snapshot = tracker.snapshot();
        expect(snapshot.statuses.r1).toBe("completed");
        expect(snapshot.statuses.r2).toBe("running");
    });
});

describe("runQaManagerSession / resumeQaManagerSession（编排）", () => {
    /** 假流：两轮并行委派事件 + 终态 result。 */
    function fakeStream(options?: {
        onOptions?: (options: Options) => void;
    }): (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage> {
        return async function* (params) {
            if (options?.onOptions && params.options) {
                options.onOptions(params.options);
            }
            yield {
                type: "system",
                subtype: "task_started",
                task_id: "sdk-a",
                subagent_type: "reporter",
                description: "Report",
            } as unknown as SDKMessage;
            yield {
                type: "system",
                subtype: "task_started",
                task_id: "sdk-b",
                subagent_type: "triage-agent",
                description: "Triage",
            } as unknown as SDKMessage;
            yield {
                type: "system",
                subtype: "task_progress",
                task_id: "sdk-a",
                usage: { total_tokens: 42, tool_uses: 1, duration_ms: 500 },
            } as unknown as SDKMessage;
            yield {
                type: "system",
                subtype: "task_updated",
                task_id: "sdk-a",
                patch: { status: "completed" },
            } as unknown as SDKMessage;
            yield {
                type: "system",
                subtype: "task_updated",
                task_id: "sdk-b",
                patch: { status: "completed" },
            } as unknown as SDKMessage;
            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "Both agents finished",
                session_id: "sess-1",
                duration_ms: 1000,
                duration_api_ms: 900,
                num_turns: 2,
                total_cost_usd: 0.05,
                usage: { input_tokens: 10, output_tokens: 20 },
                modelUsage: {
                    "claude-opus-5-5": { input_tokens: 10, output_tokens: 20, costUSD: 0.05 },
                },
            } as unknown as SDKMessage;
        };
    }

    const PLAN = QaPlanSchema.parse({
        tasks: [
            { id: "rep", role: "reporter", objective: "Write report" },
            { id: "tri", role: "triage-agent", objective: "Triage failures" },
        ],
    });

    it("委派面注册 + 事件流可观测 + 计划投影落态 + persistSession 强制（验收：并行委派可观测）", async () => {
        let seenOptions: Options | undefined;
        const onTaskEvent = vi.fn();
        const outcome = await runQaManagerSession({
            definition: DEFINITION,
            subagentDefinitions: [REPORTER, TRIAGE],
            context: CONTEXT,
            prompt: "Delegate to reporter and triage in parallel.",
            plan: PLAN,
            queryFn: fakeStream({ onOptions: (options) => (seenOptions = options) }),
            onTaskEvent,
        });

        // 会话成功终态 + sessionId（多轮控制面前提）。
        expect(outcome.session.status).toBe("completed");
        expect(outcome.session.sessionId).toBe("sess-1");

        // 委派面：agents 注册（含角色 key）+ 进度摘要开启 + 持久化强制。
        expect(Object.keys(seenOptions?.agents ?? {}).sort()).toEqual(["reporter", "triage-agent"]);
        expect(seenOptions?.agents?.reporter?.omitClaudeMd).toBe(true);
        expect(seenOptions?.agentProgressSummaries).toBe(true);
        expect(seenOptions?.persistSession).toBe(true);
        // 委派工具单独放开（tools:[] 会清空内建工具含 Agent 委派）。
        expect(seenOptions?.tools).toEqual(["Agent"]);

        // 事件流：两角色并行 started（顺序到达即观测为并行委派）+ 进度 + 终态。
        expect(outcome.events.map((event) => event.kind)).toEqual([
            "started",
            "started",
            "progress",
            "updated",
            "updated",
        ]);
        expect(outcome.events[0]?.subagentType).toBe("reporter");
        expect(outcome.events[1]?.subagentType).toBe("triage-agent");
        expect(onTaskEvent).toHaveBeenCalledTimes(5);

        // 计划投影：两任务 completed。
        expect(outcome.projection.statuses).toEqual({ rep: "completed", tri: "completed" });
        expect(outcome.projection.progress).toMatchObject({ total: 2, completed: 2, done: true });
    });

    it("闸门消费会话用量：onUsage 快照经编排器回读（预算判断数据源）", async () => {
        const snapshots: SessionUsageSnapshot[] = [];
        const outcome = await runQaManagerSession({
            definition: DEFINITION,
            subagentDefinitions: [REPORTER],
            context: CONTEXT,
            prompt: "x",
            queryFn: fakeStream(),
            onUsage: (snapshot) => snapshots.push(snapshot),
        });
        expect(outcome.session.status).toBe("completed");
        expect(snapshots.length).toBeGreaterThanOrEqual(1);
        expect(snapshots.at(-1)?.costUsd).toBe(0.05);
    });

    it("多轮：resumeQaManagerSession 传 resume=sessionId 进 SDK Options（Query 控制面续会）", async () => {
        let seenOptions: Options | undefined;
        const outcome = await resumeQaManagerSession({
            definition: DEFINITION,
            subagentDefinitions: [REPORTER],
            context: CONTEXT,
            prompt: "What is the current progress?",
            sessionId: "sess-42",
            queryFn: fakeStream({ onOptions: (options) => (seenOptions = options) }),
        });
        expect(outcome.session.status).toBe("completed");
        expect(seenOptions?.resume).toBe("sess-42");
        expect(seenOptions?.persistSession).toBe(true);
    });
});
