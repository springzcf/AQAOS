/**
 * MCP 工具权限矩阵回归（T-E02-03，DDD §9）：
 * - 目录与 DDD §9 逐条对齐（30 工具、5 域枚举、名称唯一、canonical 形态）；
 * - 角色授权展开与判定（通配、DDD 示例语义、未知角色零权限）；
 * - ToolCallResult 契约 strict 校验。
 */

import { describe, expect, it } from "vitest";
import {
    AGENT_ROLE_IDS,
    MCP_TOOL_DOMAINS,
    MCP_TOOL_SPECS,
    McpToolPermissionSchema,
    ROLE_TOOL_GRANTS,
    ToolCallResultSchema,
    findToolSpec,
    grantsAllow,
    roleToolGrants,
} from "./index.js";

const SPEC_NAMES = new Set(MCP_TOOL_SPECS.map((spec) => spec.name));

describe("MCP_TOOL_SPECS（T-E02-03）", () => {
    it("与 DDD §9 枚举的 30 个工具逐条对齐（memory 域 3 个：T-E02-07 读写 + T-E10-01 检索）", () => {
        const expected = [
            "qa.create_run",
            "qa.get_run",
            "qa.cancel_run",
            "qa.get_coverage",
            "qa.list_bugs",
            "browser.navigate",
            "browser.snapshot",
            "browser.click",
            "browser.fill",
            "browser.observe",
            "browser.act",
            "browser.screenshot",
            "browser.network_log",
            "api.get_schema",
            "api.request",
            "api.run_schema_test",
            "api.run_fuzz_test",
            "api.inspect_response",
            "env.list_environments",
            "env.get_status",
            "env.provision",
            "env.health_check",
            "env.teardown",
            "evidence.save",
            "evidence.get",
            "evidence.search",
            "evidence.generate_report",
            "memory.read_knowledge",
            "memory.write_knowledge",
            "memory.search_memories",
        ];
        expect([...MCP_TOOL_SPECS.map((spec) => spec.name)].sort()).toEqual([...expected].sort());
    });

    it("名称全局唯一且为点分 canonical 形态", () => {
        expect(SPEC_NAMES.size).toBe(MCP_TOOL_SPECS.length);
        for (const spec of MCP_TOOL_SPECS) {
            expect(spec.name).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/);
        }
    });

    it("每个工具的域合法且与名称前缀域一致、至少 1 个权限", () => {
        for (const spec of MCP_TOOL_SPECS) {
            expect(MCP_TOOL_DOMAINS).toContain(spec.domain);
            expect(spec.requiredPermissions.length).toBeGreaterThanOrEqual(1);
            for (const permission of spec.requiredPermissions) {
                expect(permission.startsWith(`${spec.domain}.`)).toBe(true);
                expect(McpToolPermissionSchema.safeParse(permission).success).toBe(true);
            }
        }
    });

    it("findToolSpec 查目录命中与未命中", () => {
        expect(findToolSpec("qa.get_run")?.domain).toBe("qa-control");
        expect(findToolSpec("qa.get_run")?.requiredPermissions).toEqual(["qa-control.read"]);
        expect(findToolSpec("memory.write_knowledge")?.requiredPermissions).toEqual([
            "memory.write",
        ]);
        expect(findToolSpec("memory.search_memories")?.requiredPermissions).toEqual([
            "memory.read",
        ]);
        expect(findToolSpec("no.such_tool")).toBeNull();
    });
});

describe("ROLE_TOOL_GRANTS / roleToolGrants（T-E02-03）", () => {
    it("16 角色全部登记", () => {
        expect(Object.keys(ROLE_TOOL_GRANTS).sort()).toEqual([...AGENT_ROLE_IDS].sort());
    });

    it("通配展开：qa-manager 拥有 qa-control 全动词 + 全域只读（DDD §9 监控职责）", () => {
        const grants = roleToolGrants("qa-manager");
        expect(grants).toContain("qa-control.read");
        expect(grants).toContain("qa-control.write");
        expect(grants).toContain("evidence.read");
        expect(grants).not.toContain("browser.execute");
    });

    it("DDD §9 示例语义：explorer 浏览器读写并写证据；reporter 只读结果与证据；bug-verifier 获批环境执行复现", () => {
        const explorer = roleToolGrants("explorer");
        expect(explorer).toContain("browser.read");
        expect(explorer).toContain("browser.write");
        expect(explorer).toContain("browser.execute");
        expect(explorer).toContain("evidence.write");

        const reporter = roleToolGrants("reporter");
        expect(reporter).toContain("qa-control.read");
        expect(reporter).toContain("evidence.read");
        expect(reporter).not.toContain("qa-control.write");
        expect(reporter).not.toContain("evidence.write");

        const verifier = roleToolGrants("bug-verifier");
        expect(verifier).toContain("browser.execute");
        expect(verifier).toContain("environment.read");
        expect(verifier).not.toContain("qa-control.write");
    });

    it("目录内每个工具至少有一个角色可用（无死工具）", () => {
        for (const spec of MCP_TOOL_SPECS) {
            const callable = AGENT_ROLE_IDS.some((role) =>
                grantsAllow(roleToolGrants(role), spec.requiredPermissions),
            );
            expect(callable, `tool ${spec.name} granted to no role`).toBe(true);
        }
    });

    it("未知角色 → 空授权集（最低权限）", () => {
        expect(roleToolGrants("hacker" as never)).toEqual([]);
    });
});

describe("grantsAllow / ToolCallResultSchema（T-E02-03）", () => {
    it("所需权限须全部满足；* 全权通配放行", () => {
        expect(grantsAllow(["qa-control.read"], ["qa-control.read"])).toBe(true);
        expect(grantsAllow(["qa-control.read"], ["qa-control.read", "qa-control.write"])).toBe(
            false,
        );
        expect(grantsAllow(["*"], ["browser.execute", "environment.execute"])).toBe(true);
    });

    it("ToolCallResult strict：合法三态；未知字段/缺 tool 被拒", () => {
        for (const status of ["succeeded", "denied", "failed"] as const) {
            const result = { tool: "qa.get_run", status };
            expect(ToolCallResultSchema.safeParse(result).success).toBe(true);
        }
        expect(
            ToolCallResultSchema.safeParse({ tool: "qa.get_run", status: "denied", extra: 1 })
                .success,
        ).toBe(false);
        expect(ToolCallResultSchema.safeParse({ status: "failed" }).success).toBe(false);
        expect(
            ToolCallResultSchema.safeParse({
                tool: "qa.get_run",
                status: "failed",
                error: { code: "NOT_FOUND", message: "run not found" },
            }).success,
        ).toBe(true);
    });
});
