/**
 * SDK MCP 适配器离线回归（T-E02-03）：工具名映射与 CallToolResult 形状。
 * 会话内端到端（真实 SDK 子进程调用 mcp__aqaos__*）见 mcp-live.test.ts。
 */

import { describe, expect, it } from "vitest";
import { toSdkToolName } from "@aqaos/mcp";
import { toCallToolResult } from "./mcp-server.js";

describe("mcp SDK 适配器（T-E02-03 离线）", () => {
    it("点分名 → SDK 名（仅首个分隔符转换；目录双索引可逆）", () => {
        expect(toSdkToolName("qa.get_run")).toBe("qa_get_run");
        // 段内下划线不受影响（browser.network_log → browser_network_log）。
        expect(toSdkToolName("browser.network_log")).toBe("browser_network_log");
        expect(toSdkToolName("env.list_environments")).toBe("env_list_environments");
    });

    it("toCallToolResult：succeeded 不置错；denied/failed 置 isError + JSON 文本块", () => {
        const ok = toCallToolResult({
            tool: "qa.get_run",
            status: "succeeded",
            data: { run: { id: "r1" } },
        });
        expect(ok.isError).toBeFalsy();
        expect(ok.structuredContent).toEqual({
            tool: "qa.get_run",
            status: "succeeded",
            data: { run: { id: "r1" } },
        });
        expect(JSON.parse((ok.content as { text: string }[])[0]?.text ?? "{}")).toEqual(
            ok.structuredContent,
        );

        const denied = toCallToolResult({
            tool: "qa.get_run",
            status: "denied",
            error: { code: "TOOL_PERMISSION_DENIED", message: "role lacks qa-control.read" },
        });
        expect(denied.isError).toBe(true);
    });
});
