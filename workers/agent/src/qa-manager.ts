/**
 * QA Manager 统筹引擎（T-E02-05，DDD §4.1）。
 *
 * 会话型控制面：QA Manager 会话（SDK Options.agents 注册可委派子代理）
 * + 平台侧统筹语义，三层各自可观测：
 * - **委派面**：toSdkSubagents 把 16 角色 AgentDefinitionRecord 映射为 SDK
 *   子代理（prompt/工具白名单/模型/omitClaudeMd 隔离）——模型经 Task 工具
 *   委派，前台串行/后台并行由模型决策；
 * - **派发闸门**（createDispatchGate，验收"预算超限停止派发"）：canUseTool
 *   桥——预算耗尽时拒绝一切工具调用（含委派）并给出停止理由，模型收尾
 *   而非硬杀；审批 seam（T-E03-06 approval_requests）在闸门内路由；
 * - **可观测投影**（QaPlanTracker）：SDK task_started/task_updated/
 *   task_progress 系统消息 → QaTaskEvent 流（kind/状态/用量/摘要），
 *   按 subagent_type 投影到结构化 QaPlan 任务 DAG（多 Agent 并行委派
 *   可观测）；会话用量（modelUsage 含子代理累计）持续闸门回读。
 *
 * 多轮/Query 控制面：runQaManagerSession 强制 persistSession=true（可恢复
 * 是控制面前提）；resumeQaManagerSession 以 sessionId 续会（进度查询/
 * 计划调整/取消指令作为后续轮次输入）。暂停/终止 = 外部 signal；
 * 恢复 = resume 续会——DAG 状态由调用方持有，跨轮不丢。
 */

import type {
    AgentDefinition as SdkAgentDefinition,
    CanUseTool,
    McpServerConfig,
    SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
    AGENT_ROLE_DISPLAY_NAMES,
    cascadeQaSkip,
    qaPlanProgress,
    type AgentBudget,
    type AgentContext,
    type AgentDefinitionRecord,
    type QaPlan,
    type QaPlanProgress,
    type QaTask,
    type QaTaskStatus,
    type QaTaskStatuses,
} from "@aqaos/domain";
import { runAgentSession, type AgentSessionOutcome, type SessionQueryFn } from "./agent-session.js";
import type { SessionUsageSnapshot } from "./session-meter.js";

/** SDK 任务生命周期事件（system/task_* 消息的领域投影）。 */
export interface QaTaskEvent {
    /** started=委派实例诞生；updated=状态迁移；progress=用量/摘要观测（不改状态）。 */
    readonly kind: "started" | "updated" | "progress";
    /** SDK task_id（委派实例标识，与计划任务 id 不同源）。 */
    readonly taskId: string;
    /** 子代理类型（= 计划/定义角色 id；started/progress 携带）。 */
    readonly subagentType?: string;
    /** task_updated 携带：pending/running/completed/failed/killed/paused。 */
    readonly status?: string;
    readonly description?: string;
    /** AI 进度摘要（agentProgressSummaries 开启时周期产出）。 */
    readonly summary?: string;
    readonly lastToolName?: string;
    readonly usage?: {
        readonly totalTokens: number;
        readonly toolUses: number;
        readonly durationMs: number;
    };
    readonly observedAt: string;
}

/** 计划投影状态（sdkTaskId ↔ 计划任务的双向绑定）。 */
export interface QaPlanProjection {
    readonly statuses: QaTaskStatuses;
    /** sdkTaskId → 计划任务 id。 */
    readonly taskBinding: Readonly<Record<string, string>>;
    readonly progress: QaPlanProgress;
}

/** 派发闸门审批 seam（T-E03-06 接 approval_requests；返回 false = 拒绝）。 */
export type DispatchApproval = (request: {
    toolName: string;
    input: Record<string, unknown>;
}) => Promise<boolean>;

export interface CreateDispatchGateParams {
    readonly budget: AgentBudget;
    /** 最新用量快照（含子代理累计；由编排器持有并回读）。 */
    readonly usageSnapshot: () => SessionUsageSnapshot;
    /** 审批 seam：预算内且需审批的调用路由于此；缺省放行（服务端权限仍强制）。 */
    readonly approval?: DispatchApproval;
}

const BUDGET_DENY_MESSAGE =
    "run budget exhausted: stop dispatching new work and wrap up with what you have";

/**
 * 派发闸门（canUseTool 桥）：预算耗尽 → 拒绝一切工具调用（含 Task 委派），
 * 模型以拒绝理由收尾——"停止派发"而非硬杀会话；预算内 → 审批 seam 路由
 * （缺省放行；服务端 MCP 权限矩阵仍是最终强制层）。
 */
export function createDispatchGate(params: CreateDispatchGateParams): CanUseTool {
    return async (toolName, input) => {
        const snapshot = params.usageSnapshot();
        const tokens = snapshot.inputTokens + snapshot.outputTokens;
        if (
            tokens >= params.budget.maxTokens ||
            snapshot.costUsd >= params.budget.maxModelCostUsd
        ) {
            return { behavior: "deny", message: BUDGET_DENY_MESSAGE };
        }
        if (params.approval !== undefined) {
            const allowed = await params.approval({ toolName, input });
            if (!allowed) {
                return {
                    behavior: "deny",
                    message: `tool "${toolName}" was not approved (approval required)`,
                };
            }
        }
        return { behavior: "allow" };
    };
}

/** AgentDefinitionRecord → SDK 子代理定义（name = 角色 id）。 */
export function toSdkSubagent(definition: AgentDefinitionRecord): SdkAgentDefinition {
    const displayName =
        AGENT_ROLE_DISPLAY_NAMES[definition.name as keyof typeof AGENT_ROLE_DISPLAY_NAMES] ??
        definition.name;
    return {
        description: `AQAOS ${displayName} specialist — delegate QA work of this discipline by role id`,
        prompt: definition.prompt,
        tools: definition.config.allowedTools,
        model: definition.config.model,
        maxTurns: definition.config.maxTurns,
        // 隔离：子代理自持上下文（委派 prompt 自含），不读宿主 CLAUDE.md。
        omitClaudeMd: true,
    };
}

/** 子代理集合 → SDK Options.agents 映射（重复角色后者覆盖，调用方去重）。 */
export function toSdkAgents(
    definitions: readonly AgentDefinitionRecord[],
): Record<string, SdkAgentDefinition> {
    const agents: Record<string, SdkAgentDefinition> = {};
    for (const definition of definitions) {
        agents[definition.name] = toSdkSubagent(definition);
    }
    return agents;
}

/**
 * 从 SDK system 消息提取任务事件（非任务消息 → null）。
 * live 实证的消息形状（T-E02-05）：
 * - task_started：顶层 subagent_type/description，标志委派实例；
 * - task_updated：状态在 `patch.status`（非顶层）——completed/failed/killed；
 * - task_progress：顶层 usage/summary/last_tool_name（agentProgressSummaries）；
 * - task_notification：后台任务输出就绪信号，顶层 status/summary/usage——
 *   观测为 progress 类事件（状态由先行的 task_updated 落，此事件供用量/摘要）。
 */
export function taskEventFromMessage(
    message: SDKMessage,
    observedAt = new Date().toISOString(),
): QaTaskEvent | null {
    if (message.type !== "system") {
        return null;
    }
    const subtype = (message as { subtype?: string }).subtype;
    if (
        subtype !== "task_started" &&
        subtype !== "task_updated" &&
        subtype !== "task_progress" &&
        subtype !== "task_notification"
    ) {
        return null;
    }
    const payload = message as unknown as {
        task_id: string;
        subagent_type?: string;
        status?: string;
        patch?: { status?: string };
        description?: string;
        summary?: string;
        last_tool_name?: string;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    };
    return {
        kind:
            subtype === "task_started"
                ? "started"
                : subtype === "task_updated"
                  ? "updated"
                  : "progress",
        taskId: payload.task_id,
        subagentType: payload.subagent_type,
        status: payload.status ?? payload.patch?.status,
        description: payload.description,
        summary: payload.summary,
        lastToolName: payload.last_tool_name,
        usage:
            payload.usage === undefined
                ? undefined
                : {
                      totalTokens: payload.usage.total_tokens,
                      toolUses: payload.usage.tool_uses,
                      durationMs: payload.usage.duration_ms,
                  },
        observedAt,
    };
}

/**
 * 计划投影器：把 SDK 任务事件流落到结构化 QaPlan 状态板。
 * 绑定策略：started 按角色（subagent_type）取该角色最早的 pending 任务
 * （FIFO）；completed/failed/killed 落到已绑定任务；失败传导 skipped 闭包。
 */
export class QaPlanTracker {
    private readonly plan: QaPlan;
    private readonly statuses = new Map<string, QaTaskStatus>();
    private readonly binding = new Map<string, string>();

    constructor(plan: QaPlan) {
        this.plan = plan;
        for (const task of plan.tasks) {
            this.statuses.set(task.id, "pending");
        }
    }

    /** 应用一个任务事件（幂等：未知 taskId 的 updated/progress 忽略）。 */
    apply(event: QaTaskEvent): void {
        if (event.kind === "started") {
            const bound = this.binding.get(event.taskId);
            if (bound !== undefined) {
                this.statuses.set(bound, "running");
                return;
            }
            const role = event.subagentType;
            const candidate: QaTask | undefined =
                role === undefined
                    ? undefined
                    : this.plan.tasks.find(
                          (task) => task.role === role && this.statuses.get(task.id) === "pending",
                      );
            if (candidate !== undefined) {
                this.binding.set(event.taskId, candidate.id);
                this.statuses.set(candidate.id, "running");
            }
            return;
        }
        if (event.kind === "progress") {
            // 进度不改变状态（用量/摘要供观测流）。
            return;
        }
        // updated：终态映射（paused → running 维持；pending → pending）。
        const bound = this.binding.get(event.taskId) ?? event.taskId;
        if (!this.statuses.has(bound)) {
            return;
        }
        switch (event.status) {
            case "completed":
                this.statuses.set(bound, "completed");
                break;
            case "failed":
                this.statuses.set(bound, "failed");
                this.skipDependents();
                break;
            case "killed":
                this.statuses.set(bound, "killed");
                this.skipDependents();
                break;
            default:
                break;
        }
    }

    private skipDependents(): void {
        for (const id of cascadeQaSkip(this.plan, this.snapshot().statuses)) {
            this.statuses.set(id, "skipped");
        }
    }

    snapshot(): QaPlanProjection {
        const statuses: Record<string, QaTaskStatus> = {};
        for (const [id, status] of this.statuses) {
            statuses[id] = status;
        }
        const binding: Record<string, string> = {};
        for (const [sdkId, planId] of this.binding) {
            binding[sdkId] = planId;
        }
        return { statuses, taskBinding: binding, progress: qaPlanProgress(this.plan, statuses) };
    }
}

export interface RunQaManagerSessionParams {
    /** QA Manager 角色定义（agent_definitions 最新启用版）。 */
    definition: AgentDefinitionRecord;
    /** 可委派子代理定义（其余角色；至少 1 个才有委派面）。 */
    subagentDefinitions: readonly AgentDefinitionRecord[];
    context: AgentContext;
    /** 首轮输入（Run 目标 + 计划简报/Query 指令）。 */
    prompt: string;
    /** 结构化计划（可选；提供则启用投影，事件流始终可用）。 */
    plan?: QaPlan;
    mcpServers?: Record<string, McpServerConfig>;
    /** 派发审批 seam（进闸门；缺省放行）。 */
    approval?: DispatchApproval;
    /** 任务事件流回调（多 Agent 并行委派可观测）。 */
    onTaskEvent?: (event: QaTaskEvent) => void;
    onUsage?: (snapshot: SessionUsageSnapshot) => void;
    onMessage?: (message: SDKMessage) => void;
    cwd?: string;
    defaultModel?: string;
    queryFn?: SessionQueryFn;
}

export interface QaManagerOutcome {
    session: AgentSessionOutcome;
    /** 本轮全部任务事件（时间序）。 */
    events: readonly QaTaskEvent[];
    /** 计划投影（无 plan 时 statuses 恒空、progress 全零）。 */
    projection: QaPlanProjection;
}

/** 运行 QA Manager 统领会话（首启轮）。 */
export async function runQaManagerSession(
    params: RunQaManagerSessionParams,
): Promise<QaManagerOutcome> {
    return orchestrate(params);
}

/** 续会轮（Query 控制面：进度查询/计划调整/取消指令作为 prompt 输入）。 */
export async function resumeQaManagerSession(
    params: RunQaManagerSessionParams & { sessionId: string },
): Promise<QaManagerOutcome> {
    return orchestrate({ ...params, resumeSessionId: params.sessionId });
}

interface OrchestrateParams extends RunQaManagerSessionParams {
    resumeSessionId?: string;
}

async function orchestrate(params: OrchestrateParams): Promise<QaManagerOutcome> {
    // 控制面前提：会话可恢复（多轮/Query）；编排器强制覆盖定义缺省。
    const definition: AgentDefinitionRecord = {
        ...params.definition,
        config: { ...params.definition.config, persistSession: true },
    };

    // 用量回读：onUsage 转发 + 闸门快照源（预算判断用含子代理的累计值）。
    let latestUsage: SessionUsageSnapshot = {
        numTurns: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
        perModel: {},
        toolUseCount: 0,
    };
    const onUsage = (snapshot: SessionUsageSnapshot): void => {
        latestUsage = snapshot;
        params.onUsage?.(snapshot);
    };

    const gate = createDispatchGate({
        budget: params.context.budget,
        usageSnapshot: () => latestUsage,
        approval: params.approval,
    });

    const events: QaTaskEvent[] = [];
    const emptyPlan: QaPlan = { tasks: [] };
    const tracker = new QaPlanTracker(params.plan ?? emptyPlan);
    const onMessage = (message: SDKMessage): void => {
        params.onMessage?.(message);
        const event = taskEventFromMessage(message);
        if (event !== null) {
            events.push(event);
            tracker.apply(event);
            params.onTaskEvent?.(event);
        }
    };

    const session = await runAgentSession({
        definition,
        context: params.context,
        prompt: params.prompt,
        mcpServers: params.mcpServers,
        subagents: toSdkAgents(params.subagentDefinitions),
        resumeSessionId: params.resumeSessionId,
        approval: gate,
        onUsage,
        onMessage,
        cwd: params.cwd,
        defaultModel: params.defaultModel,
        queryFn: params.queryFn,
    });

    return { session, events, projection: tracker.snapshot() };
}
