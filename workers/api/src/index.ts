/**
 * AQAOS API runner worker (skeleton — T-E01-01).
 *
 * Target (M1, T-E04-02): the 程序型 API execution core, evolved from
 * QA-Swarm's HttpApiTool + OpenAPI parser (audit report §3.15/§3.16).
 *  - Generates contract tests from OpenAPI specs (zero LLM, audit §3.7);
 *  - Executes requests with timeouts, retries, and evidence capture;
 *  - Bridges to Schemathesis in a separate process boundary (risk R7:
 *    no in-process Python mixing);
 *  - Schema drift validation with the lightweight fallback validator
 *    retained from QA-Swarm.
 *
 * Known bug to fix on migration: openapi.ts uses require() inside ESM for
 * YAML specs (audit D-01) — switch to dynamic import.
 *
 * Skeleton only; execution lands with T-E04-02.
 */

export const WORKER_KIND = "api" as const;

export function workerBanner(): string {
    return `[aqaos/worker-api] kind=${WORKER_KIND} status=skeleton (T-E04-02 pending)`;
}

if (process.env.AQAOS_RUN_WORKER === "1") {
    console.log(workerBanner());
}
