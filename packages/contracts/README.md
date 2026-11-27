# @aqaos/contracts

API contract layer of AQAOS: DTOs, SSE payloads, error codes, OpenAPI document.

- Single source: DDD §8 (REST), §8.2 (SSE), §16 (error codes).
- Derives types from `@aqaos/domain`; publishes the OpenAPI 3.1 artifact.
- Consumed by `apps/api`, workers, and the CLI client.

Status: skeleton (T-E01-01). Real content lands with T-E02-01 in M1.
