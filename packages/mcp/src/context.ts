/**
 * 工具调用上下文（T-E02-03，DDD §9 调用链中间件——身份/Run 绑定）。
 *
 * 上下文只能由「可信构造方」建立，客户端声明一概不可信：
 * - agent-session：workers/agent 从已验证的 agent_runs 行构造（组织/角色/Run
 *   绑定来自数据库，而非会话提示）；
 * - rest：apps/api 路由从已验证 JWT + 组织成员关系构造。
 *
 * dispatch 只消费 context.grants 做权限判定（grantsAllow），授权集的推导
 * （角色矩阵/REST 阶梯）发生在构造方——纯函数，两处实现同源测试。
 */

import { MCP_TOOL_DOMAINS, roleToolGrants, type AgentRoleId } from "@aqaos/domain";

export type ToolCallSource = "agent-session" | "rest";

export interface ToolCallContext {
    source: ToolCallSource;
    /** 组织隔离根：所有服务实现必须按它过滤数据。 */
    organizationId: string;
    /** agent-session = AgentRoleId；rest = MembershipRole（viewer/member/admin/owner）。 */
    role: string;
    /** rest：发起用户；agent-session 无用户主体（actor 为 agent）。 */
    userId?: string;
    /** agent-session：agent 定义名（审计归属）。 */
    agentName?: string;
    /** Run 绑定（agent-session 必有；rest 可选）。 */
    runId?: string;
    /** 已展开的授权集（构造方推导；dispatch 只做 grantsAllow 判定）。 */
    grants: readonly string[];
}

export interface AgentToolCallContextParams {
    organizationId: string;
    agentRole: AgentRoleId;
    runId?: string;
    agentName?: string;
}

/** agent-session 上下文：授权集 = 角色权限矩阵展开（domain mcp-tools）。 */
export function agentToolCallContext(params: AgentToolCallContextParams): ToolCallContext {
    return {
        source: "agent-session",
        organizationId: params.organizationId,
        role: params.agentRole,
        agentName: params.agentName,
        runId: params.runId,
        grants: roleToolGrants(params.agentRole),
    };
}

/**
 * REST 消费阶梯（DDD §9 对外集成）：viewer 无工具；member 全域只读；
 * admin/owner 全权（"*" 通配）。与 Agent 角色矩阵是两套词汇，勿混用。
 */
export function restToolGrants(membershipRole: string): readonly string[] {
    switch (membershipRole) {
        case "admin":
        case "owner":
            return ["*"];
        case "member":
            return MCP_TOOL_DOMAINS.map((domain) => `${domain}.read`);
        default:
            // viewer / 未知 / 无组织 → 零工具（最低权限）。
            return [];
    }
}

export interface RestToolCallContextParams {
    organizationId: string;
    membershipRole: string;
    userId?: string;
    runId?: string;
}

/** REST 上下文：授权集 = REST 阶梯（apps/api 路由构造）。 */
export function restToolCallContext(params: RestToolCallContextParams): ToolCallContext {
    return {
        source: "rest",
        organizationId: params.organizationId,
        role: params.membershipRole,
        userId: params.userId,
        runId: params.runId,
        grants: restToolGrants(params.membershipRole),
    };
}
