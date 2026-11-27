/**
 * 16 角色 prompt 骨架与版本化策略（T-E02-04 纯函数回归）。
 *
 * 守护：
 * - 骨架五段结构完整（身份/使命/工具/纪律/产出）且逐角色唯一；
 * - allowedTools 种子 = 角色授权 ∩ 已实现注册表（全 16 角色交叉断言，
 *   杜绝"白名单放了未授权/未实现工具"两类漂移）；
 * - 版本化策略内核：标签不可复用于不同 prompt、空转版本拒绝、
 *   回滚 = 成对复制天然合规（验收"prompt 变更留版本、可回滚"）。
 */

import { describe, expect, it } from "vitest";
import {
    AGENT_ROLE_IDS,
    AgentDefinitionConfigSchema,
    type AgentDefinitionConfig,
    findToolSpec,
    grantsAllow,
    roleToolGrants,
} from "./index.js";
import {
    ROLE_PROMPT_BASELINE_VERSION,
    ROLE_PROMPT_BASELINES,
    baselineAgentDefinitions,
    baselineAllowedTools,
    checkPromptVersionPolicy,
    comparePromptVersions,
    diffAgentDefinition,
} from "./agent-prompts.js";

const SECTIONS = ["# Mission", "# Tools", "# Working rules", "# Output"] as const;

describe("ROLE_PROMPT_BASELINES（16 角色骨架）", () => {
    it("16 角色逐个有非空骨架（≥ 400 字符），含五段结构与角色 id", () => {
        for (const role of AGENT_ROLE_IDS) {
            const prompt = ROLE_PROMPT_BASELINES[role];
            expect(typeof prompt).toBe("string");
            expect(prompt.length).toBeGreaterThanOrEqual(400);
            expect(prompt).toContain(`(${role})`);
            for (const section of SECTIONS) {
                expect(prompt).toContain(section);
            }
        }
    });

    it("骨架逐角色唯一（无复制粘贴串角色）", () => {
        const unique = new Set(Object.values(ROLE_PROMPT_BASELINES));
        expect(unique.size).toBe(AGENT_ROLE_IDS.length);
    });

    it("每份骨架约束结构化产出（AgentResult 字段传导）与工作纪律体量", () => {
        for (const role of AGENT_ROLE_IDS) {
            const prompt: string = ROLE_PROMPT_BASELINES[role];
            expect(prompt).toContain("confidence in [0, 1]");
            const rules = prompt.slice(prompt.indexOf("# Working rules"));
            const bullets = rules.match(/^- /gm) ?? [];
            expect(bullets.length, `${role} needs >= 3 working rules`).toBeGreaterThanOrEqual(3);
        }
    });

    it("会话型角色（qa-manager/product-analyst）声明编排/问答定位，执行角色声明执行定位", () => {
        expect(ROLE_PROMPT_BASELINES["qa-manager"]).toContain("orchestrate");
        expect(ROLE_PROMPT_BASELINES["product-analyst"]).toContain("conversational");
        expect(ROLE_PROMPT_BASELINES["web-tester"]).toContain("Execute");
        expect(ROLE_PROMPT_BASELINES.reporter).toContain("Aggregate");
    });
});

describe("baselineAllowedTools（授权 ∩ 已实现注册表）", () => {
    it("全部 16 角色：名单里的每个工具都已实现且角色确有授权（双向无漂移）", () => {
        const sdkPattern = /^mcp__aqaos__[a-z-]+_[a-z_]+$/;
        for (const role of AGENT_ROLE_IDS) {
            const allowed = baselineAllowedTools(role);
            const grants = roleToolGrants(role);
            for (const sdkName of allowed) {
                expect(sdkName).toMatch(sdkPattern);
                // SDK 名还原 canonical 名（仅首个分隔符转换的逆）。
                const canonical = sdkName
                    .replace(/^mcp__aqaos__/, "")
                    .replace(/^([a-z-]+)_/, "$1.");
                const spec = findToolSpec(canonical);
                expect(
                    spec,
                    `${role}:${sdkName} must be an implemented registry tool`,
                ).not.toBeNull();
                expect(
                    grantsAllow(grants, spec?.requiredPermissions ?? []),
                    `${role}:${sdkName} must be within the role's grants`,
                ).toBe(true);
            }
        }
    });

    it("抽查：memory 域实装后（T-E02-07 读写 + T-E10-01 检索）各角色名单如实扩容", () => {
        expect(baselineAllowedTools("qa-manager")).toEqual([
            "mcp__aqaos__qa_get_run",
            "mcp__aqaos__qa_get_coverage",
            "mcp__aqaos__qa_list_bugs",
            "mcp__aqaos__env_list_environments",
            "mcp__aqaos__memory_read_knowledge",
            // T-E10-01 记忆检索实装后 *.read 命中 memory_search_memories。
            "mcp__aqaos__memory_search_memories",
        ]);
        expect(baselineAllowedTools("reporter")).toHaveLength(5);
        expect(baselineAllowedTools("planner")).toHaveLength(5);
        expect(baselineAllowedTools("regression-agent")).toHaveLength(6);
        expect(baselineAllowedTools("explorer")).toEqual([
            "mcp__aqaos__env_list_environments",
            "mcp__aqaos__memory_read_knowledge",
            "mcp__aqaos__memory_write_knowledge",
            "mcp__aqaos__memory_search_memories",
        ]);
        // test-generator 从空名单变为 memory 读写+检索（其授权本就含 memory.*）。
        expect(baselineAllowedTools("test-generator")).toEqual([
            "mcp__aqaos__memory_read_knowledge",
            "mcp__aqaos__memory_write_knowledge",
            "mcp__aqaos__memory_search_memories",
        ]);
        expect(baselineAllowedTools("web-tester")).toEqual([]); // browser 域工具尚未实现
        expect(baselineAllowedTools("security-tester")).toEqual([]);
    });
});

describe("baselineAgentDefinitions（seed 单一事实源）", () => {
    it("16 行：字段完整、config 合法、prompt 与骨架一致、版本纪律（version=1）", () => {
        const all = baselineAgentDefinitions();
        expect(all).toHaveLength(16);
        for (const definition of all) {
            expect(definition.version).toBe("1");
            expect(definition.promptVersion).toBe(ROLE_PROMPT_BASELINE_VERSION);
            expect(definition.prompt).toBe(ROLE_PROMPT_BASELINES[definition.name]);
            expect(definition.enabled).toBe(true);
            const parsed: AgentDefinitionConfig = AgentDefinitionConfigSchema.parse(
                definition.config,
            );
            expect(parsed).toEqual(definition.config);
            // config.allowedTools 与名单同源。
            expect(definition.config.allowedTools ?? []).toEqual([
                ...baselineAllowedTools(definition.name),
            ]);
        }
    });
});

describe("comparePromptVersions / diffAgentDefinition（版本比对）", () => {
    it("semver 三元组数值序 + 相等 + 非规范回退可比", () => {
        expect(comparePromptVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
        expect(comparePromptVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
        expect(comparePromptVersions("0.1.0", "0.1.0")).toBe(0);
        expect(comparePromptVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
        expect(comparePromptVersions("dev", "dev")).toBe(0);
    });

    it("diff：prompt/config/enabled 变化逐字段报告，键序无关的 config 深比较", () => {
        const prev = {
            prompt: "p1",
            promptVersion: "0.1.0",
            config: { allowedTools: ["a", "b"] },
            enabled: true,
        };
        const sameConfigDiffOrder = {
            prompt: "p1",
            promptVersion: "0.1.0",
            config: { allowedTools: ["b", "a"] },
            enabled: true,
        };
        expect(diffAgentDefinition(prev, sameConfigDiffOrder)).toMatchObject({
            promptChanged: false,
            configChanged: false,
            changedFields: [],
        });
        const changed = diffAgentDefinition(prev, {
            prompt: "p2",
            promptVersion: "0.2.0",
            config: { allowedTools: ["a"] },
            enabled: false,
        });
        expect(changed).toEqual({
            promptChanged: true,
            promptVersionChanged: true,
            configChanged: true,
            enabledChanged: true,
            changedFields: ["prompt", "promptVersion", "config", "enabled"],
        });
    });
});

describe("checkPromptVersionPolicy（版本化策略内核）", () => {
    const row = (prompt: string, promptVersion: string) => ({
        prompt,
        promptVersion,
        config: {} as AgentDefinitionConfig,
        enabled: true,
    });

    it("空历史（首版）放行", () => {
        expect(checkPromptVersionPolicy([], row("p1", "0.1.0"))).toBeNull();
    });

    it("prompt 变更 + 复用旧标签 → PROMPT_VERSION_REUSED（核心不变量）", () => {
        const violation = checkPromptVersionPolicy(
            [row("p1", "0.1.0")],
            row("p1-changed", "0.1.0"),
        );
        expect(violation?.code).toBe("PROMPT_VERSION_REUSED");
    });

    it("prompt 变更 + 新标签放行", () => {
        expect(checkPromptVersionPolicy([row("p1", "0.1.0")], row("p2", "0.2.0"))).toBeNull();
    });

    it("回滚形态：复用旧标签 + 原样 prompt（成对复制）放行，即使非最新版内容", () => {
        const history = [row("p1", "0.1.0"), row("p2", "0.2.0")];
        expect(checkPromptVersionPolicy(history, row("p1", "0.1.0"))).toBeNull();
    });

    it("与最新版内容全等 → NO_CHANGE（空转行拒绝，含回滚到最新版）", () => {
        const history = [row("p1", "0.1.0"), row("p2", "0.2.0")];
        expect(checkPromptVersionPolicy(history, row("p2", "0.2.0"))?.code).toBe("NO_CHANGE");
        expect(checkPromptVersionPolicy(history, row("p2", "0.3.0"))?.code).toBe("NO_CHANGE");
    });

    it("config-only 变更 + 新标签放行；enabled-only 变更放行", () => {
        const base = { prompt: "p1", promptVersion: "0.1.0", config: {}, enabled: true };
        expect(
            checkPromptVersionPolicy([base], {
                ...base,
                promptVersion: "0.2.0",
                config: { allowedTools: ["x"] },
            }),
        ).toBeNull();
        expect(
            checkPromptVersionPolicy([base], { ...base, promptVersion: "0.2.0", enabled: false }),
        ).toBeNull();
    });
});
