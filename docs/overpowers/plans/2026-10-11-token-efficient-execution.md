# Token-Efficient Execution Amendment

**Owner priority:** Total controller and worker token consumption is a P0 acceptance constraint. Preserve prior design intent unless an explicit, evidence-backed decision changes it.

## History and correction

- `21dd8b8` introduced long bounded waits to reduce controller wake-ups.
- `8fc9548` added capability-gated MCP Tasks so supported hosts can observe jobs outside model turns.
- `2a965d4` changed fallback `wait_task` to one terminal wait with the compact result.
- `b05cbba` correctly hardened process cleanup, timeout recovery, and telemetry, but its fixed 55-second heartbeat fallback regressed the single-wakeup/token objective.

This amendment retains the hardening and restores the single terminal fallback wait.

## Measured baseline

A persisted real review job on 2026-10-11 was incorrectly dispatched to an implementer worker. It ran for 173.6 seconds, emitted 92 step events, consumed 85,814 Antigravity tokens plus 749,044 cache-read tokens, tried several unavailable validation tools serially, and ended with an empty response. The bridge transport was not the dominant runtime cost; routing and repeated model/tool cycles were.

## Decisions

1. Prefer negotiated MCP Tasks. A non-Tasks caller makes one abortable terminal `wait_task` call; no fixed heartbeat polling.
2. Default absolute turn duration is 600 seconds, with a 300-second inactivity timeout.
3. Amended 2026-10-13: step/token budgets are opt-in pending matched useful-result benchmarks. Stream guards observe already-emitted events and cannot guarantee upstream token prevention.
4. A compact budget preamble tells the worker to use one repository-native verification path, stop probing missing tools serially, and reserve a concise final response.
5. Amended 2026-10-13: preserve CLI effort defaults and explicit overrides until comparative quality/cost evidence supports new routing defaults.
6. Process-tree fail-closed behavior, conversation recovery, MCP Tasks capability gating, and compact terminal inspection remain unchanged.

## Acceptance evidence

- Public MCP contract test: legacy short-poll arguments cannot force a heartbeat; one call waits for and returns the terminal compact result.
- Worker tests: a 10-step synthetic loop stops before step 4 with a three-step budget; streamed token usage reaching five stops before another step begins.
- Persistence test: budget kind and limits survive bridge restart.
- Final gate: focused tests, typecheck, full suite, smoke test, independent read-only review, and controller diff review.

## Claim boundary

The deterministic tests prove fewer controller wake-ups and enforced execution ceilings. They do not prove that every real Antigravity task will finish faster or produce a useful answer. A representative live comparison is required before claiming a real-task latency or token-reduction percentage.
