/**
 * QA 任务计划契约回归（T-E02-05 纯图函数）。
 *
 * 守护：结构校验四类问题（重复/悬空/环/空）、就绪判定（依赖完成才放行、
 * 失败依赖不放行）、失败传导 skipped 闭包、进度快照与终态判定。
 */

import { describe, expect, it } from "vitest";
import { QaPlanSchema } from "./index.js";
import {
    cascadeQaSkip,
    qaPlanProgress,
    qaPlanSettled,
    readyQaTasks,
    tasksForRole,
    validateQaPlan,
    type QaPlan,
    type QaTask,
} from "./qa-plan.js";

const task = (id: string, role: QaTask["role"], dependsOn: string[] = []): QaTask => ({
    id,
    role,
    objective: `objective of ${id}`,
    dependsOn,
});

const plan = (tasks: QaTask[]): QaPlan => QaPlanSchema.parse({ tasks });

describe("validateQaPlan（结构校验）", () => {
    it("合法计划零问题", () => {
        const valid = plan([
            task("explore", "explorer"),
            task("generate", "test-generator", ["explore"]),
            task("report", "reporter", ["generate"]),
        ]);
        expect(validateQaPlan(valid)).toEqual([]);
    });

    it("重复 id / 悬空依赖 / 环 逐类报告", () => {
        const dup = plan([task("a", "planner"), task("a", "reporter")]);
        expect(validateQaPlan(dup).map((issue) => issue.code)).toEqual(["DUPLICATE_TASK_ID"]);

        const dangling = plan([task("a", "planner", ["ghost"])]);
        expect(validateQaPlan(dangling).map((issue) => issue.code)).toEqual(["UNKNOWN_DEPENDENCY"]);

        const cyclic = plan([task("a", "planner", ["b"]), task("b", "reporter", ["a"])]);
        expect(validateQaPlan(cyclic).map((issue) => issue.code)).toEqual(["CYCLE"]);
    });
});

describe("readyQaTasks（就绪判定）", () => {
    it("依赖全部 completed 才就绪；pending 依赖不放行；failed 依赖也不放行", () => {
        const dag = plan([
            task("explore", "explorer"),
            task("analyze", "root-cause-analyst", ["explore"]),
            task("report", "reporter", ["analyze"]),
        ]);
        expect(readyQaTasks(dag, {}).map((t) => t.id)).toEqual(["explore"]);
        expect(readyQaTasks(dag, { explore: "completed" }).map((t) => t.id)).toEqual(["analyze"]);
        // explore 失败：analyze 不就绪（传导由 cascadeQaSkip 表达）。
        expect(readyQaTasks(dag, { explore: "failed" })).toEqual([]);
        expect(
            readyQaTasks(dag, { explore: "completed", analyze: "completed" }).map((t) => t.id),
        ).toEqual(["report"]);
    });

    it("priority 降序 + 声明序稳定；running/completed 不再就绪", () => {
        const dag = QaPlanSchema.parse({
            tasks: [
                { ...task("low", "reporter"), priority: 1 },
                { ...task("high", "reporter"), priority: 5 },
                { ...task("mid", "reporter"), priority: 3 },
            ],
        });
        expect(readyQaTasks(dag, {}).map((t) => t.id)).toEqual(["high", "mid", "low"]);
        expect(readyQaTasks(dag, { high: "running" }).map((t) => t.id)).toEqual(["mid", "low"]);
    });
});

describe("cascadeQaSkip（失败传导）", () => {
    it("传递依赖闭包全 skipped，独立分支不受影响", () => {
        const dag = plan([
            task("explore", "explorer"),
            task("generate", "test-generator", ["explore"]),
            task("web", "web-tester", ["generate"]),
            task("independent", "reporter"),
        ]);
        const affected = cascadeQaSkip(dag, { explore: "failed" });
        expect(affected).toEqual(["generate", "web"]);
        // 独立分支不受影响：合并后仍就绪。
        const merged = { explore: "failed", generate: "skipped", web: "skipped" } as const;
        expect(readyQaTasks(dag, merged).map((t) => t.id)).toEqual(["independent"]);
    });

    it("killed 同样传导；无失败时零传导", () => {
        const dag = plan([task("a", "explorer"), task("b", "reporter", ["a"])]);
        expect(cascadeQaSkip(dag, { a: "killed" })).toEqual(["b"]);
        expect(cascadeQaSkip(dag, { a: "completed" })).toEqual([]);
        expect(cascadeQaSkip(dag, {})).toEqual([]);
    });
});

describe("qaPlanProgress / qaPlanSettled（进度与终态）", () => {
    it("分状态计数与 done 判定", () => {
        const dag = plan([
            task("a", "explorer"),
            task("b", "triage-agent", ["a"]),
            task("c", "reporter", ["a"]),
            task("d", "planner"),
        ]);
        const statuses = { a: "completed", b: "running", c: "failed", d: "skipped" } as const;
        const progress = qaPlanProgress(dag, statuses);
        expect(progress).toMatchObject({
            total: 4,
            completed: 1,
            running: 1,
            failed: 1,
            skipped: 1,
            pending: 0,
            done: false,
        });
        const settled = qaPlanProgress(dag, {
            a: "completed",
            b: "failed",
            c: "skipped",
            d: "skipped",
        });
        expect(settled.done).toBe(true);
    });

    it("qaPlanSettled：pending/running 任一存在即未终态", () => {
        expect(qaPlanSettled({ a: "completed" }, ["a"])).toBe(true);
        expect(qaPlanSettled({ a: "running" }, ["a"])).toBe(false);
        expect(qaPlanSettled({}, ["a"])).toBe(false);
    });
});

describe("tasksForRole（角色检索）", () => {
    it("按角色过滤", () => {
        const dag = plan([task("r1", "reporter"), task("p1", "planner"), task("r2", "reporter")]);
        expect(tasksForRole(dag, "reporter").map((t) => t.id)).toEqual(["r1", "r2"]);
        expect(tasksForRole(dag, "explorer")).toEqual([]);
    });
});
