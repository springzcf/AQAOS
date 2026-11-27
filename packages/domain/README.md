# @aqaos/domain

Domain layer of AQAOS: entities, value objects, state machines, invariants.

- Single source: DDD §7.2 (33-table model), §7.3 (enum dictionary), §5.5 (state machines).
- No I/O, no framework imports — pure domain logic.
- Downstream consumers: `@aqaos/contracts` (API surface), workers, apps.

Status: skeleton (T-E01-01). Real content lands with T-E07-01 (case management
domain) and T-E02-01 (contract derivation) in M1.
