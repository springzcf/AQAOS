/**
 * AQAOS contracts layer (skeleton — T-E01-01).
 *
 * Target content (M1, T-E02-01):
 *  - REST DTOs for every endpoint of DDD §8 (runs, test-cases, bugs,
 *    approvals, schedules, integrations, metrics, webhooks, environment);
 *  - SSE event payloads (DDD §8.2: run.*, step.*, approval.*, issue.*,
 *    schedule.*);
 *  - error code registry (DDD §16) with HTTP status mapping;
 *  - OpenAPI 3.1 document generated from these types as the publishable
 *    contract artifact.
 *
 * Types here derive from `@aqaos/domain` and must stay wire-compatible with
 * the OpenAPI document — never hand-edit both sides independently.
 */

export const CONTRACTS_LAYER_VERSION = "0.1.0-skeleton";

export interface ContractsPlaceholder {
    readonly layer: "contracts";
    readonly version: string;
}

export const contractsInfo: ContractsPlaceholder = {
    layer: "contracts",
    version: CONTRACTS_LAYER_VERSION,
};
