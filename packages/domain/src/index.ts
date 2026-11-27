/**
 * AQAOS domain layer (skeleton — T-E01-01).
 *
 * Target content (M1): the 33-table domain model of DDD §7.2 as TypeScript
 * entities and value objects — Application, TestRun, RunStep, TestCase,
 * TestScript, Bug, Approval, AgentSession, EnvironmentStack, Schedule,
 * Integration, FeedbackSignal, QualityMetric — plus the state machines of
 * DDD §5.5 (run, environment, test case, bug, approval) as pure transition
 * functions, and the enum dictionary of DDD §7.3 as the single source for
 * `@aqaos/contracts`.
 *
 * Rules (SDD §6.2 dependency direction):
 *  - this package may not import anything above the domain layer;
 *  - no I/O, no framework, no runtime — pure domain logic only.
 */

export const DOMAIN_LAYER_VERSION = "0.1.0-skeleton";

/** Placeholder until T-E07-01 lands the real entity set. */
export interface DomainPlaceholder {
    readonly layer: "domain";
    readonly version: string;
}

export const domainInfo: DomainPlaceholder = {
    layer: "domain",
    version: DOMAIN_LAYER_VERSION,
};
