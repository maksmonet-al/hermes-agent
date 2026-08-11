# Hermes Phase 2.2 — Implementation Report

Status: independent-review-ready; no independent-review verdict has been requested or claimed.

## Scope and safety

- Worktree: `/home/claude/.hermes/hermes-agent-phase2.2-execution-supervisor`
- Branch: `feature/phase-2.2-execution-supervisor`
- No commit, push, profile/config change, gateway restart, runtime gateway/database access, or files outside this worktree were used.
- The supplied experimental diff was removed before implementation. The implementation was rebuilt around the selected Option A design.

## Implemented design

`hermes_cli/execution_supervisor.py` adds the canonical `autonomous_execution` workflow:

- One persistent `executions` record per root task, with frozen structured acceptance criteria, criterion evidence requirements, version, and execution lease fields.
- SQLite guards prevent mutation/deletion of frozen criteria and criterion identity/evidence requirements.
- System-created, dispatcher-visible Kanban task steps are persisted in `execution_steps` for `developer`, `reviewer`, and optional `ops` roles. Each is assigned to its role profile and bound to its actual completed `task_runs` row.
- `complete_task()` observes system-owned workflow runs inside the same write transaction that persists the task/run completion. Ordinary Kanban completion remains a no-op to the supervisor. Recovery also replays a durable completed run bound to a nonterminal step before considering a generic continuation, preventing recovery/observer siblings.
- A Developer final cannot complete an execution. Pending or RED frozen criteria produce a system-created continuation and `TERMINATION_REJECTED`/`REPAIR`; planning-only results produce `NO_EXECUTION_PROGRESS` and a continuation.
- Reviewer and Ops gates are satisfied only by their own bound completed task-run records. Developer metadata cannot satisfy either gate.
- Root-task generic completion is rejected whenever it is governed by an `autonomous_execution`; only the supervisor's terminal transition can set it to `done`, including after `BLOCKED`/`CANCELLED` states.
- Authoritative completion transitions acquire a short execution-step lease and use a version-and-lease conditional update. Continuation task + `execution_steps` publication occurs while that lease is held and inside the same transaction as the execution CAS/event. Duplicate completed-run observations are idempotent through `completed_run_id` and event keys.
- Recovery preserves transaction ownership when called from an enclosing completion transaction; it never commits the caller's task/run transition.
- `write_txn()` supports safe composition of the supervisor and Kanban writers, so a system task is inserted, bound to its role-owned step, and only then exposed as `ready`; failure before binding rolls back the supervisor transition and event.
- The dispatcher calls `recover_autonomous_executions()` inside its existing dispatch lock. A non-terminal execution with no active system step receives one persisted, dispatcher-visible recovery continuation.
- `execution_attempts` records logical tiers and failure evidence. Threshold selection uses only `normal`, `strong`, and `expert`; core logic stores no concrete provider/model ID. Runtime/same-signature/reviewer-category thresholds are two; generic repair escalation is five. Architecture/ADR categories route to `architect`, not a stronger Developer tier. A strong tier retains ownership for the unresolved criterion.

## Changed files

- `hermes_cli/execution_supervisor.py` — new supervisor state, schema, workflow, gates, escalation, recovery.
- `hermes_cli/kanban_db.py` — additive metadata migration, supervisor schema initialization, completion observation, dispatcher recovery hook.
- `tests/hermes_cli/test_execution_supervisor.py` — 18 named behavioral acceptance scenarios plus state/lease/normal-task/dispatcher recovery contracts.

## Test evidence

Focused acceptance suite (including transaction/crash-window regressions):

```text
env -u HERMES_DELEGATED_CHILD_CONTEXT pytest -q tests/hermes_cli/test_execution_supervisor.py
36 passed in 0.6s

```

The deterministic completion/observation interleaving regression was observed RED before the repair: recovery returned `1` in the committed-task/unobserved-step gap. After the repair it is GREEN with one reviewer continuation and one `completed-run:1` event, with no `recovery:*` sibling.

Focused plus requested Kanban regression suite:

```text
env -u HERMES_DELEGATED_CHILD_CONTEXT pytest -q tests/hermes_cli/test_execution_supervisor.py tests/agent/test_kanban_stop.py tests/hermes_cli/test_kanban_db.py tests/hermes_cli/test_kanban_core_functionality.py tests/hermes_cli/test_kanban_goal_mode.py
466 passed in 44.02s
```

## Safe isolated SQLite canary

No gateway or persistent runtime board was opened. Exact command executed from the worktree:

```text
env -u HERMES_DELEGATED_CHILD_CONTEXT python scripts/phase22_sqlite_canary.py && test ! -e .phase22-canary.sqlite && test ! -e .phase22-canary.sqlite.init.lock && printf 'canary_artifacts_cleaned=yes\n'
```

The script creates and deletes only `.phase22-canary.sqlite` and its init lock inside this worktree. Actual output:

```text
{"events": ["READY_FOR_REVIEW", "READY_FOR_OPS", "COMPLETE"], "role_owned_runs": [{"completed_run_id": 1, "role": "developer"}, {"completed_run_id": 2, "role": "reviewer"}, {"completed_run_id": 3, "role": "ops"}], "root_status": "done", "status": "complete"}
canary_artifacts_cleaned=yes
```

This is isolated SQLite evidence only. It does not constitute a gateway/runtime deployment proof or an independent review PASS.

Additional final checks:

```text
env -u HERMES_DELEGATED_CHILD_CONTEXT python scripts/phase22_sqlite_canary.py && test ! -e .phase22-canary.sqlite && test ! -e .phase22-canary.sqlite.init.lock
git diff --check
python -m py_compile hermes_cli/execution_supervisor.py hermes_cli/kanban_db.py scripts/phase22_sqlite_canary.py tests/hermes_cli/test_execution_supervisor.py
```

All three commands passed. No independent-review PASS is claimed.

## Independent-review handoff

Review the current uncommitted worktree, not this report. The reviewer should verify the exact current diff and the test/canary evidence above, particularly: task-run role ownership, terminal gating, lease/version predicate, recovery idempotency, normal-task non-interference, and logical-tier routing without concrete model IDs.
