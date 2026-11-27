/**
 * QA Manager 任务计划契约（T-E02-05，DDD §4.1 任务 DAG）。
 *
 * 纯契约 + 纯图函数：QaPlan 是"统筹者视角"的结构化委派计划（Planner 产出
 * 或 QA Manager 会话内维护），供 workers/agent 编排器投影 SDK 任务事件、
 * apps/api 展示进度（T-E02-12 Run Registry 消费）。
 *
 * 语义：
 * - 任务节点带角色（16 角色 AgentRoleId）与目标文本，依赖闭包内引用；
 * - ready = pending 且全部依赖 completed（失败/跳过的依赖不放行——
 *   依赖失败由 cascadeQaSkip 传导为 skipped，DAG 上不留"半就绪"状态）；
 * - 环/重复 id/悬空依赖在 validateQaPlan 报告，构建侧拒绝落库。
 */

import { z } from "zod";
import { AgentRoleIdSchema, type AgentRoleId } from "./enums.js";

/** 任务状态（与 SDK task_updated.status 对齐 + skipped 为平台传导态）。 */
export const QaTaskStatusSchema = z.enum([
    "pending",
    "running",
    "completed",
    "failed",
    "killed",
    "skipped",
]);
export type QaTaskStatus = z.infer<typeof QaTaskStatusSchema>;

/**
 * 任务节点：id（计划内唯一）+ 角色 + 目标 + 依赖闭包。
 * risk/acceptance 为规划元数据（T-E02-06 Planner 产出，DDD §4.2）：
 * 运行侧不消费（投影只看 id/role），随任务携带供展示/审计层读取。
 */
export const QaTaskSchema = z
    .object({
        id: z.string().min(1),
        role: AgentRoleIdSchema,
        objective: z.string().min(1),
        dependsOn: z.array(z.string().min(1)).default([]),
        priority: z.number().int().min(1).optional(),
        risk: z.enum(["low", "medium", "high"]).optional(),
        acceptance: z.string().min(1).optional(),
    })
    .strict();
export type QaTask = z.infer<typeof QaTaskSchema>;

/** 计划 = 任务集（非空；结构合法性由 validateQaPlan 判定）。 */
export const QaPlanSchema = z
    .object({
        tasks: z.array(QaTaskSchema).min(1),
    })
    .strict();
export type QaPlan = z.infer<typeof QaPlanSchema>;

/** 计划结构问题（构建侧拒绝落库的依据，逐任务可定位）。 */
export interface QaPlanIssue {
    readonly code: "EMPTY" | "DUPLICATE_TASK_ID" | "UNKNOWN_DEPENDENCY" | "CYCLE";
    readonly message: string;
    readonly taskId?: string;
}

/** 结构校验：重复 id、悬空依赖、循环依赖（Kahn 拓扑检测）。 */
export function validateQaPlan(plan: QaPlan): readonly QaPlanIssue[] {
    const issues: QaPlanIssue[] = [];
    const tasks = plan.tasks;
    if (tasks.length === 0) {
        return [{ code: "EMPTY", message: "plan has no tasks" }];
    }
    const byId = new Map<string, QaTask>();
    for (const task of tasks) {
        if (byId.has(task.id)) {
            issues.push({
                code: "DUPLICATE_TASK_ID",
                message: `duplicate task id "${task.id}"`,
                taskId: task.id,
            });
        }
        byId.set(task.id, task);
    }
    for (const task of tasks) {
        for (const dep of task.dependsOn) {
            if (!byId.has(dep)) {
                issues.push({
                    code: "UNKNOWN_DEPENDENCY",
                    message: `task "${task.id}" depends on unknown task "${dep}"`,
                    taskId: task.id,
                });
            }
        }
    }
    // Kahn：入度消元，残留即环。
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const task of tasks) {
        indegree.set(task.id, task.dependsOn.filter((dep) => byId.has(dep)).length);
        for (const dep of task.dependsOn) {
            if (byId.has(dep)) {
                dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
            }
        }
    }
    const queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
    let resolved = 0;
    while (queue.length > 0) {
        const id = queue.pop() as string;
        resolved += 1;
        for (const next of dependents.get(id) ?? []) {
            const remaining = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, remaining);
            if (remaining === 0) {
                queue.push(next);
            }
        }
    }
    if (resolved < tasks.length) {
        const cyclic = tasks
            .filter((task) => (indegree.get(task.id) ?? 0) > 0)
            .map((task) => task.id);
        issues.push({
            code: "CYCLE",
            message: `dependency cycle among tasks: ${cyclic.join(", ")}`,
        });
    }
    return issues;
}

/** 状态板：任务 id → 当前状态（运行侧维护，纯函数消费）。 */
export type QaTaskStatuses = Readonly<Record<string, QaTaskStatus>>;

/** 就绪任务：pending 且依赖全部 completed（按 priority 降序、声明序稳定）。 */
export function readyQaTasks(plan: QaPlan, statuses: QaTaskStatuses): readonly QaTask[] {
    return plan.tasks
        .filter((task) => (statuses[task.id] ?? "pending") === "pending")
        .filter((task) => task.dependsOn.every((dep) => statuses[dep] === "completed"))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
}

/**
 * 失败传导：terminal 任务（failed/killed/skipped）的传递依赖闭包 → 待跳过
 * 任务 id 列表（不含失败源自身）。调用方将结果合并为 skipped。
 */
export function cascadeQaSkip(plan: QaPlan, statuses: QaTaskStatuses): readonly string[] {
    const blocked = new Set<string>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of plan.tasks) {
            if (blocked.has(task.id)) {
                continue;
            }
            const status = statuses[task.id] ?? "pending";
            if (status !== "pending") {
                continue;
            }
            const hasBadDep = task.dependsOn.some(
                (dep) =>
                    blocked.has(dep) ||
                    statuses[dep] === "failed" ||
                    statuses[dep] === "killed" ||
                    statuses[dep] === "skipped",
            );
            if (hasBadDep) {
                blocked.add(task.id);
                changed = true;
            }
        }
    }
    return [...blocked].sort();
}

/** 计划进度快照（分状态计数，供控制面/展示层消费）。 */
export interface QaPlanProgress {
    readonly total: number;
    readonly pending: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly killed: number;
    readonly skipped: number;
    readonly done: boolean;
}

export function qaPlanProgress(plan: QaPlan, statuses: QaTaskStatuses): QaPlanProgress {
    const counts: Record<QaTaskStatus, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        killed: 0,
        skipped: 0,
    };
    for (const task of plan.tasks) {
        counts[statuses[task.id] ?? "pending"] += 1;
    }
    return {
        total: plan.tasks.length,
        ...counts,
        done: counts.pending === 0 && counts.running === 0,
    };
}

/** 终态判定辅助：全部任务非 pending/running（含失败/跳过路径）。 */
export function qaPlanSettled(statuses: QaTaskStatuses, taskIds: readonly string[]): boolean {
    return taskIds.every((id) => {
        const status = statuses[id];
        return status !== undefined && status !== "pending" && status !== "running";
    });
}

/** 角色便捷检索：某角色的全部任务（投影匹配用）。 */
export function tasksForRole(plan: QaPlan, role: AgentRoleId): readonly QaTask[] {
    return plan.tasks.filter((task) => task.role === role);
}
