/**
 * AQAOS agent worker (skeleton — T-E01-01).
 *
 * Target (M1, T-E02-04): the process that hosts Claude Agent SDK sessions.
 *  - 会话型 agents (QA Manager, Planner, Product Analyst, Test Architect,
 *    Triage, Root Cause Analyst) run as SDK sessions with role system
 *    prompts and MCP tool whitelists (DDD §3.1).
 *  - 混合型 agents (Explorer, Test Generator, Bug Verifier, Self-Healing,
 *    Regression, Reporter) call deterministic MCP tools from this worker.
 *  - PreToolUse hooks forward sensitive tool calls to the approval flow
 *    (DDD §5.4); the client-side whitelist here is the first layer, the
 *    server-side identity/permission/budget check is the final one.
 *
 * This skeleton only reports readiness; session bootstrapping arrives with
 * T-E02-04.
 */

export const WORKER_KIND = "agent" as const;

export function workerBanner(): string {
    return `[aqaos/worker-agent] kind=${WORKER_KIND} status=skeleton (T-E02-04 pending)`;
}

if (process.env.AQAOS_RUN_WORKER === "1") {
    console.log(workerBanner());
}
