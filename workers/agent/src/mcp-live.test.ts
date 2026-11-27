/**
 * T-E02-03 验收（对内消费）：agent 会话经进程内 MCP Server 调用平台工具
 * 的端到端实证——真实 Claude Agent SDK 子进程 + 真实凭据 + mcp__aqaos__
 * 工具调用全链路（zod 输入契约 → dispatch 调度链 → 权限 → 审计 → 服务）。
 *
 * 门控：AQAOS_AGENT_SDK_LIVE=1（CI 无凭据自动跳过；本地验收显式打开，
 * 花真实 token——最小提示词控制成本）。services 用内存假实现（数据层
 * 归 apps/api/pg，SDK 适配与调度链才是本测试对象）。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentToolCallContext, type McpServices, type ToolAuditRecord } from "@aqaos/mcp";
import type { AgentContext, AgentDefinitionRecord } from "@aqaos/domain";
import { runAgentSession } from "./agent-session.js";
import { createAqaosSdkMcpServer } from "./mcp-server.js";

const LIVE = process.env.AQAOS_AGENT_SDK_LIVE === "1";

const ORG = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
const RUN_ID = "9e2e120d-08a2-4fc4-a04e-efd909c7577f";

/** 角色定义：reporter（只读 qa-control/evidence/memory），会用平台工具。 */
const reporterDefinition: AgentDefinitionRecord = {
    id: "7e2e120d-08a2-4fc4-a04e-efd909c7577e",
    name: "reporter",
    version: "0.1.0",
    promptVersion: "probe-mcp-1",
    prompt: [
        "You are a minimal AQAOS Reporter probe agent.",
        "You can query test runs through the platform MCP tool.",
        "Answer with facts from tool results only.",
    ].join(" "),
    config: { allowedTools: ["mcp__aqaos__qa_get_run"] },
    enabled: true,
};

const agentContext: AgentContext = {
    runId: RUN_ID,
    applicationId: ORG,
    environmentId: ORG,
    objective: "T-E02-03 in-process MCP tool server acceptance",
    budget: { maxTokens: 50_000, maxModelCostUsd: 1, maxDurationSeconds: 300 },
    permissions: [],
    traceId: "te0203-live-acceptance",
};

describe.skipIf(!LIVE)("live in-process MCP tool consumption (T-E02-03 acceptance)", () => {
    it(
        "reporter 会话经 mcp__aqaos__qa_get_run 调用工具并返回真实数据",
        { timeout: 240_000 },
        async () => {
            const audits: ToolAuditRecord[] = [];
            let queriedRunId = "";
            const services: McpServices = {
                async getRun({ runId, organizationId }) {
                    queriedRunId = `${runId}@${organizationId}`;
                    return {
                        id: runId,
                        projectId: organizationId,
                        applicationId: organizationId,
                        environmentId: null,
                        objective: "回归登录主链路",
                        status: "running",
                        budget: { maxTokens: 1_000_000, maxModelCostUsd: 5 },
                        coverage: { line: 0.42 },
                        temporalWorkflowId: "wf_te0203",
                        createdAt: "2026-11-27T10:00:00.000Z",
                        startedAt: null,
                        completedAt: null,
                    };
                },
                async listBugs() {
                    return [];
                },
                async getCoverage() {
                    return null;
                },
                async listEnvironments() {
                    return [];
                },
                async readKnowledge() {
                    return { nodes: [], edges: [] };
                },
                async writeKnowledge() {
                    return { writtenNodes: 0, writtenEdges: 0 };
                },
                async searchMemories() {
                    return [];
                },
                async recordToolCall(record) {
                    audits.push(record);
                },
            };

            const toolContext = agentToolCallContext({
                organizationId: ORG,
                agentRole: "reporter",
                runId: RUN_ID,
                agentName: "reporter@0.1.0",
            });

            const cwd = await mkdtemp(path.join(tmpdir(), "aqaos-agent-mcp-"));
            const outcome = await runAgentSession({
                definition: reporterDefinition,
                context: agentContext,
                prompt: [
                    `Call the tool mcp__aqaos__qa_get_run with runId "${RUN_ID}".`,
                    "Then reply with exactly the run's status value, nothing else.",
                ].join(" "),
                mcpServers: {
                    aqaos: createAqaosSdkMcpServer({ context: toolContext, services }),
                },
                cwd,
            });

            // 会话完成且结果来自工具数据（status 值 = running）。
            expect(outcome.status).toBe("completed");
            expect(outcome.resultText).toContain("running");
            // 服务端收到了上下文绑定的调用（Run 绑定 + 组织隔离根传导）。
            expect(queriedRunId).toBe(`${RUN_ID}@${ORG}`);
            // 调度链审计：成功调用落一条 succeeded（agent-session 源）。
            expect(audits).toHaveLength(1);
            expect(audits[0]).toMatchObject({
                toolName: "qa.get_run",
                status: "succeeded",
                source: "agent-session",
                role: "reporter",
                runId: RUN_ID,
            });
            // 工具调用确实发生在会话内（计量到 tool_use）。
            expect(outcome.usage.toolUseCount).toBeGreaterThanOrEqual(1);
        },
    );
});
