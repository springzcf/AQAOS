/**
 * MCP 工具域与权限矩阵（T-E02-03，DDD §9）。
 *
 * 纯策略数据 + 纯函数：16 角色 × 8 工具域的授权表是领域知识（单一事实源，
 * T-E11-05 RBAC 定稿时统一收口）；工具目录（canonical 名称 + 所需权限）
 * 与 DDD §9 逐条对齐。可执行注册表/调度链在 @aqaos/mcp（T-E02-03）。
 *
 * 权限粒度：`<domain>.<verb>`，verb ∈ read / write / execute：
 * - read：查询类（qa.get_run、evidence.get…）；
 * - write：产出类落库（evidence.save、memory 写入…）；
 * - execute：对外产生副作用（browser.act、api.request、env.provision…）。
 * 服务端按此矩阵校验——客户端 allowedTools 白名单只是第一层。
 */

import { z } from "zod";
import { AGENT_ROLE_IDS, type AgentRoleId } from "./enums.js";

export const MCP_TOOL_DOMAINS = [
    "qa-control",
    "browser",
    "api-testing",
    "environment",
    "evidence",
    "memory",
    "security",
    "performance",
] as const;
export type McpToolDomain = (typeof MCP_TOOL_DOMAINS)[number];

export const MCP_TOOL_VERBS = ["read", "write", "execute"] as const;
export type McpToolVerb = (typeof MCP_TOOL_VERBS)[number];

export type McpToolPermission = `${McpToolDomain}.${McpToolVerb}`;

const domainSchema = z.enum(MCP_TOOL_DOMAINS);
const verbSchema = z.enum(MCP_TOOL_VERBS);
export const McpToolPermissionSchema = z.string().refine(
    (value) => {
        const parts = value.split(".");
        return (
            parts.length === 2 &&
            domainSchema.safeParse(parts[0]).success &&
            verbSchema.safeParse(parts[1]).success
        );
    },
    { message: "permission must be <domain>.<read|write|execute>" },
);
export const McpToolPermissionListSchema = z.array(McpToolPermissionSchema).min(1);

/** 工具目录条目：canonical 名称（点分）+ 域 + 所需权限（全部满足才放行）。 */
export interface McpToolSpec {
    name: string;
    domain: McpToolDomain;
    requiredPermissions: readonly McpToolPermission[];
}

/**
 * DDD §9 工具目录（30 个：memory 域 3 个——知识读写随 T-E02-07 落地
 * 实装、记忆检索随 T-E10-01 实装；security/performance 域的工具集随
 * E09/E03 引擎登记；域与角色授权先就位）。
 */
export const MCP_TOOL_SPECS: readonly McpToolSpec[] = [
    // QA Control
    { name: "qa.create_run", domain: "qa-control", requiredPermissions: ["qa-control.write"] },
    { name: "qa.get_run", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
    { name: "qa.cancel_run", domain: "qa-control", requiredPermissions: ["qa-control.write"] },
    { name: "qa.get_coverage", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
    { name: "qa.list_bugs", domain: "qa-control", requiredPermissions: ["qa-control.read"] },
    // Browser
    { name: "browser.navigate", domain: "browser", requiredPermissions: ["browser.execute"] },
    { name: "browser.snapshot", domain: "browser", requiredPermissions: ["browser.read"] },
    { name: "browser.click", domain: "browser", requiredPermissions: ["browser.execute"] },
    { name: "browser.fill", domain: "browser", requiredPermissions: ["browser.execute"] },
    { name: "browser.observe", domain: "browser", requiredPermissions: ["browser.read"] },
    { name: "browser.act", domain: "browser", requiredPermissions: ["browser.execute"] },
    { name: "browser.screenshot", domain: "browser", requiredPermissions: ["browser.write"] },
    { name: "browser.network_log", domain: "browser", requiredPermissions: ["browser.read"] },
    // API testing
    { name: "api.get_schema", domain: "api-testing", requiredPermissions: ["api-testing.read"] },
    { name: "api.request", domain: "api-testing", requiredPermissions: ["api-testing.execute"] },
    {
        name: "api.run_schema_test",
        domain: "api-testing",
        requiredPermissions: ["api-testing.execute"],
    },
    {
        name: "api.run_fuzz_test",
        domain: "api-testing",
        requiredPermissions: ["api-testing.execute"],
    },
    {
        name: "api.inspect_response",
        domain: "api-testing",
        requiredPermissions: ["api-testing.read"],
    },
    // Environment
    {
        name: "env.list_environments",
        domain: "environment",
        requiredPermissions: ["environment.read"],
    },
    { name: "env.get_status", domain: "environment", requiredPermissions: ["environment.read"] },
    { name: "env.provision", domain: "environment", requiredPermissions: ["environment.execute"] },
    { name: "env.health_check", domain: "environment", requiredPermissions: ["environment.read"] },
    { name: "env.teardown", domain: "environment", requiredPermissions: ["environment.execute"] },
    // Evidence
    { name: "evidence.save", domain: "evidence", requiredPermissions: ["evidence.write"] },
    { name: "evidence.get", domain: "evidence", requiredPermissions: ["evidence.read"] },
    { name: "evidence.search", domain: "evidence", requiredPermissions: ["evidence.read"] },
    {
        name: "evidence.generate_report",
        domain: "evidence",
        requiredPermissions: ["evidence.write"],
    },
    // Memory（T-E02-07 Product Analyst 知识落库；T-E10-01 记忆检索）
    {
        name: "memory.read_knowledge",
        domain: "memory",
        requiredPermissions: ["memory.read"],
    },
    {
        name: "memory.write_knowledge",
        domain: "memory",
        requiredPermissions: ["memory.write"],
    },
    {
        name: "memory.search_memories",
        domain: "memory",
        requiredPermissions: ["memory.read"],
    },
];

/**
 * 16 角色授权表（DDD §9 示例 + §4 职责推导的基线；矩阵收紧随 T-E11-05）。
 * 通配 "<domain>.*" 表示该域全部动词。
 */
export const ROLE_TOOL_GRANTS: Readonly<Record<AgentRoleId, readonly string[]>> = {
    "qa-manager": ["qa-control.*", "*.read", "environment.execute"],
    "product-analyst": ["memory.*", "evidence.read", "api-testing.read", "environment.read"],
    planner: ["qa-control.read", "memory.read", "evidence.read"],
    explorer: [
        "browser.*",
        "evidence.read",
        "evidence.write",
        "memory.read",
        "memory.write",
        "environment.read",
    ],
    "test-architect": ["qa-control.read", "memory.read", "evidence.read", "api-testing.read"],
    "test-generator": ["memory.read", "memory.write", "evidence.read"],
    "web-tester": ["browser.*", "evidence.read", "evidence.write"],
    "api-tester": ["api-testing.*", "evidence.read", "evidence.write"],
    "security-tester": [
        "security.execute",
        "api-testing.read",
        "api-testing.execute",
        "evidence.read",
        "evidence.write",
    ],
    "performance-tester": [
        "performance.execute",
        "api-testing.execute",
        "browser.execute",
        "evidence.read",
        "evidence.write",
    ],
    "triage-agent": ["qa-control.read", "evidence.read", "memory.read"],
    "bug-verifier": [
        "browser.read",
        "browser.execute",
        "api-testing.execute",
        "evidence.read",
        "evidence.write",
        "environment.read",
    ],
    "root-cause-analyst": ["qa-control.read", "evidence.read", "memory.read"],
    "regression-agent": [
        "qa-control.read",
        "qa-control.write",
        "memory.read",
        "memory.write",
        "evidence.read",
    ],
    "self-healing-agent": [
        "browser.read",
        "browser.execute",
        "memory.read",
        "memory.write",
        "evidence.read",
        "evidence.write",
    ],
    reporter: ["qa-control.read", "evidence.read", "memory.read"],
};

const AGENT_ROLE_SET = new Set<string>(AGENT_ROLE_IDS);

/** 角色的具体授权集（展开通配；未知角色 → 空集 = 最低权限）。 */
export function roleToolGrants(role: AgentRoleId): readonly string[] {
    if (!AGENT_ROLE_SET.has(role)) {
        return [];
    }
    const grants: string[] = [];
    for (const pattern of ROLE_TOOL_GRANTS[role]) {
        if (pattern.endsWith(".*")) {
            const domain = pattern.slice(0, -2);
            for (const verb of MCP_TOOL_VERBS) {
                grants.push(`${domain}.${verb}`);
            }
        } else if (pattern === "*.read") {
            for (const domain of MCP_TOOL_DOMAINS) {
                grants.push(`${domain}.read`);
            }
        } else {
            grants.push(pattern as McpToolPermission);
        }
    }
    return grants;
}

/** 授权判定：所需权限全部在授权集内（含 "*" 全权通配，REST 管理员用）。 */
export function grantsAllow(
    grants: readonly string[],
    required: readonly McpToolPermission[],
): boolean {
    if (grants.includes("*")) {
        return true;
    }
    return required.every((permission) => grants.includes(permission));
}

/** 查目录：canonical 工具名 → 规格（未登记返回 null）。 */
export function findToolSpec(name: string): McpToolSpec | null {
    return MCP_TOOL_SPECS.find((spec) => spec.name === name) ?? null;
}

/** 一次工具调用的统一结果契约（对内 SDK / 对外 REST 双消费同构）。 */
export const ToolCallResultSchema = z
    .object({
        tool: z.string().min(1),
        status: z.enum(["succeeded", "denied", "failed"]),
        data: z.record(z.unknown()).optional(),
        error: z
            .object({
                code: z.string().min(1),
                message: z.string().min(1),
            })
            .optional(),
    })
    .strict();
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
