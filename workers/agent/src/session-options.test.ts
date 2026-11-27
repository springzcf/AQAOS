/**
 * 会话选项映射回归（T-E02-02，DDD §3.1）：
 * - toSessionSpec：agent_definitions + AgentContext → 会话规格（模型/白名单/预算/超时）；
 * - toSdkOptions：隔离基线（无内建工具、strictMcp、settingSources=[]、env 标识）、
 *   审批桥有无的权限失闭/放行二态；
 * - 非法定义（disabled / 非 16 角色 name）拒绝。
 */

import { describe, expect, it } from "vitest";
import type { AgentContext, AgentDefinitionRecord } from "@aqaos/domain";
import {
    AgentDefinitionError,
    DEFAULT_SESSION_MODEL,
    SDK_CLIENT_APP_ID,
    SDK_DELEGATION_TOOL,
    toSdkOptions,
    toSessionSpec,
} from "./session-options.js";

const UUID = "9e2e120d-08a2-4fc4-a04e-efd909c7577e";
const UUID2 = "9e2e120d-08a2-4fc4-a04e-efd909c7577f";

const context: AgentContext = {
    runId: UUID,
    applicationId: UUID2,
    environmentId: UUID,
    objective: "冒烟验证登录主流程",
    budget: { maxTokens: 100_000, maxModelCostUsd: 2.5, maxDurationSeconds: 600, maxToolCalls: 20 },
    permissions: ["browser.navigate"],
    traceId: "trace-1",
};

const definition: AgentDefinitionRecord = {
    id: UUID2,
    name: "product-analyst",
    version: "1.0.0",
    promptVersion: "1",
    prompt: "You are the AQAOS Product Analyst…",
    config: {},
    enabled: true,
};

describe("toSessionSpec：agent_definitions → 会话规格", () => {
    it("缺省映射：默认模型/空白名单/预算与超时换算/不持久化", () => {
        const spec = toSessionSpec({ definition, context });
        expect(spec.systemPrompt).toBe(definition.prompt);
        expect(spec.model).toBe(DEFAULT_SESSION_MODEL);
        expect(spec.allowedTools).toEqual([]);
        expect(spec.maxBudgetUsd).toBe(2.5);
        expect(spec.timeoutMs).toBe(600_000);
        expect(spec.persistSession).toBe(false);
        expect(spec.mcpServers).toEqual({});
        expect(spec.cwd).toBe(process.cwd());
    });

    it("config 覆盖优先：模型/白名单/轮数/effort/持久化 + MCP 透传", () => {
        const spec = toSessionSpec({
            definition: {
                ...definition,
                config: {
                    model: "claude-haiku-5-5",
                    allowedTools: ["mcp__aqaos__navigate", "mcp__aqaos__snapshot"],
                    maxTurns: 8,
                    effort: "medium",
                    persistSession: true,
                },
            },
            context,
            defaultModel: "claude-sonnet-5-5",
            mcpServers: { aqaos: { type: "stdio", command: "node", args: ["server.js"] } },
            cwd: "/tmp/agent-workspace",
        });
        expect(spec.model).toBe("claude-haiku-5-5");
        expect(spec.allowedTools).toEqual(["mcp__aqaos__navigate", "mcp__aqaos__snapshot"]);
        expect(spec.maxTurns).toBe(8);
        expect(spec.effort).toBe("medium");
        expect(spec.persistSession).toBe(true);
        expect(Object.keys(spec.mcpServers)).toEqual(["aqaos"]);
        expect(spec.cwd).toBe("/tmp/agent-workspace");
    });

    it("defaultModel 次于 config、高于内置缺省；无时长预算则无超时", () => {
        const spec = toSessionSpec({
            definition,
            context: { ...context, budget: { ...context.budget, maxDurationSeconds: undefined } },
            defaultModel: "claude-sonnet-5-5",
        });
        expect(spec.model).toBe("claude-sonnet-5-5");
        expect(spec.timeoutMs).toBeUndefined();
    });

    it("disabled 定义与非规范角色名拒绝", () => {
        expect(() =>
            toSessionSpec({ definition: { ...definition, enabled: false }, context }),
        ).toThrow(AgentDefinitionError);
        expect(() =>
            toSessionSpec({ definition: { ...definition, name: "mobile-tester" }, context }),
        ).toThrow(/not a canonical AgentRoleId/);
    });
});

describe("toSdkOptions：SDK 会话选项与隔离基线", () => {
    const spec = toSessionSpec({
        definition: {
            ...definition,
            config: {
                allowedTools: ["mcp__aqaos__navigate"],
                maxTurns: 4,
                effort: "high",
                persistSession: true,
            },
        },
        context,
        mcpServers: { aqaos: { type: "stdio", command: "node", args: ["server.js"] } },
    });
    const abortController = new AbortController();

    it("映射全部会话规格 + headless 隔离基线", () => {
        const options = toSdkOptions(spec, { abortController });
        expect(options.systemPrompt).toBe(spec.systemPrompt);
        expect(options.model).toBe(DEFAULT_SESSION_MODEL);
        expect(options.tools).toEqual([]);
        expect(options.allowedTools).toEqual(["mcp__aqaos__navigate"]);
        expect(options.maxTurns).toBe(4);
        expect(options.maxBudgetUsd).toBe(2.5);
        expect(options.effort).toBe("high");
        expect(options.thinking).toEqual({ type: "adaptive" });
        expect(options.mcpServers).toEqual(spec.mcpServers);
        expect(options.strictMcpConfig).toBe(true);
        expect(options.settingSources).toEqual([]);
        expect(options.persistSession).toBe(true);
        expect(options.abortController).toBe(abortController);
        expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(SDK_CLIENT_APP_ID);
        // env 是整体替换语义：宿主 PATH 必须显式带入（sdk.d.ts 契约）。
        expect(options.env?.PATH).toBe(process.env.PATH);
    });

    it("无审批桥：permissionPrompts=none 失闭；有审批桥：default + canUseTool", () => {
        const closed = toSdkOptions(spec, { abortController });
        expect(closed.permissionPrompts).toBe("none");
        expect(closed.canUseTool).toBeUndefined();

        const canUseTool = async () => ({ behavior: "deny", message: "not approved" }) as const;
        const open = toSdkOptions(spec, { abortController, canUseTool });
        expect(open.permissionMode).toBe("default");
        expect(open.canUseTool).toBe(canUseTool);
        expect(open.permissionPrompts).toBeUndefined();
    });

    it("委派面存在时单独放开 Agent 委派工具（否则子代理不可达）；无委派面仍清空", () => {
        const delegationSpec = toSessionSpec({
            definition,
            context,
            subagents: { reporter: { description: "Reporter", prompt: "You are the reporter." } },
        });
        const options = toSdkOptions(delegationSpec, { abortController });
        expect(options.tools).toEqual([SDK_DELEGATION_TOOL]);
        expect(options.agents?.reporter?.prompt).toBe("You are the reporter.");
        expect(options.agentProgressSummaries).toBe(true);

        const bare = toSdkOptions(toSessionSpec({ definition, context }), { abortController });
        expect(bare.tools).toEqual([]);
        expect(bare.agentProgressSummaries).toBe(false);
    });

    it("结构化输出契约（T-E02-06）：outputJsonSchema → outputFormat json_schema；缺省 undefined", () => {
        const schema = { type: "object", properties: { objective: { type: "string" } } };
        const structured = toSdkOptions(
            toSessionSpec({ definition, context, outputJsonSchema: schema }),
            { abortController },
        );
        expect(structured.outputFormat).toEqual({ type: "json_schema", schema });

        const freeText = toSdkOptions(toSessionSpec({ definition, context }), { abortController });
        expect(freeText.outputFormat).toBeUndefined();
    });
});
