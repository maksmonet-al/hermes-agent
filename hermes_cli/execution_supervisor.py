"""Canonical durable autonomous-execution workflow over Kanban.

This module owns the Phase 2.2 state machine.  Kanban remains the sole task
and task-run executor; an execution only creates system-owned workflow steps.
No concrete model identifier is stored here: steps carry logical tiers only.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable


class ExecutionStatus(str, Enum):
    RUNNING = "running"
    READY_FOR_REVIEW = "ready_for_review"
    READY_FOR_OPS = "ready_for_ops"
    BLOCKED = "blocked"
    COMPLETE = "complete"
    CANCELLED = "cancelled"
    FAILED_SYSTEM = "failed_system"


@dataclass(frozen=True)
class ExecutionState:
    execution_id: str
    root_task_id: str
    status: ExecutionStatus
    criteria: tuple[dict[str, Any], ...]
    requires_ops: bool
    version: int
    lease_owner: str | None
    lease_expires: int | None


@dataclass(frozen=True)
class ExecutionStep:
    id: str
    execution_id: str
    task_id: str
    role: str
    status: str
    criterion_id: str | None
    logical_model_tier: str | None
    system_created: bool
    continuation_key: str
    completed_run_id: int | None


EXECUTION_SCHEMA = """
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL UNIQUE,
    workflow_type TEXT NOT NULL CHECK(workflow_type='autonomous_execution'),
    status TEXT NOT NULL,
    frozen_criteria TEXT NOT NULL,
    requires_ops INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_criteria (
    execution_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    required_evidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    evidence_run_id INTEGER,
    PRIMARY KEY(execution_id, criterion_id),
    UNIQUE(execution_id, ordinal)
);
CREATE TABLE IF NOT EXISTS execution_steps (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('developer', 'reviewer', 'ops', 'architect')),
    status TEXT NOT NULL CHECK(status IN ('ready', 'running', 'done', 'changes_required', 'failed')),
    criterion_id TEXT,
    logical_model_tier TEXT,
    system_created INTEGER NOT NULL CHECK(system_created=1),
    continuation_key TEXT NOT NULL,
    completed_run_id INTEGER,
    evidence TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(execution_id, continuation_key)
);
CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    decision TEXT NOT NULL,
    step_id TEXT,
    evidence TEXT,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(execution_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS execution_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    criterion_id TEXT,
    role TEXT NOT NULL,
    logical_model_tier TEXT NOT NULL,
    category TEXT,
    failure_signature TEXT,
    evidence_level TEXT,
    outcome TEXT NOT NULL,
    task_run_id INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_scope
ON execution_attempts(execution_id, criterion_id, role, category, failure_signature);
CREATE TRIGGER IF NOT EXISTS execution_frozen_criteria_no_update
BEFORE UPDATE OF frozen_criteria ON executions
BEGIN SELECT RAISE(ABORT, 'frozen criteria cannot be mutated'); END;
CREATE TRIGGER IF NOT EXISTS execution_criteria_no_delete
BEFORE DELETE ON execution_criteria
BEGIN SELECT RAISE(ABORT, 'frozen criteria cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS execution_criteria_scope_no_update
BEFORE UPDATE OF execution_id, criterion_id, ordinal, required_evidence ON execution_criteria
BEGIN SELECT RAISE(ABORT, 'frozen criteria cannot be mutated'); END;
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(EXECUTION_SCHEMA)


def _normalize_criteria(criteria: Iterable[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in criteria:
        if not isinstance(raw, dict):
            raise ValueError("each acceptance criterion must be an object")
        criterion_id = str(raw.get("id") or "").strip()
        required_evidence = str(raw.get("required_evidence") or "").strip()
        if not criterion_id or not required_evidence or criterion_id in seen:
            raise ValueError("criteria require unique id and required_evidence")
        seen.add(criterion_id)
        normalized.append({"id": criterion_id, "required_evidence": required_evidence})
    if not normalized:
        raise ValueError("at least one frozen acceptance criterion is required")
    return tuple(normalized)


def _state(row: sqlite3.Row) -> ExecutionState:
    return ExecutionState(
        execution_id=row["id"],
        root_task_id=row["root_task_id"],
        status=ExecutionStatus(row["status"]),
        criteria=tuple(json.loads(row["frozen_criteria"])),
        requires_ops=bool(row["requires_ops"]),
        version=int(row["version"]),
        lease_owner=row["lease_owner"],
        lease_expires=row["lease_expires"],
    )


def get_execution(conn: sqlite3.Connection, execution_id: str) -> ExecutionState:
    row = conn.execute("SELECT * FROM executions WHERE id=?", (execution_id,)).fetchone()
    if row is None:
        raise KeyError(execution_id)
    return _state(row)


def list_execution_steps(conn: sqlite3.Connection, execution_id: str) -> list[ExecutionStep]:
    rows = conn.execute(
        "SELECT * FROM execution_steps WHERE execution_id=? ORDER BY rowid",
        (execution_id,),
    ).fetchall()
    return [ExecutionStep(
        id=row["id"], execution_id=row["execution_id"], task_id=row["task_id"],
        role=row["role"], status=row["status"], criterion_id=row["criterion_id"],
        logical_model_tier=row["logical_model_tier"], system_created=bool(row["system_created"]),
        continuation_key=row["continuation_key"], completed_run_id=row["completed_run_id"],
    ) for row in rows]


def _create_system_step(
    conn: sqlite3.Connection, *, execution_id: str, root_task_id: str,
    role: str, continuation_key: str, criterion_id: str | None = None,
    logical_model_tier: str | None = None,
) -> str:
    """Create one dispatcher-visible task and bind it to a system workflow step."""
    from hermes_cli import kanban_db as kb
    # The task and its supervisor binding must become visible together.  The
    # re-entrant write_txn keeps this atomic when the caller already owns the
    # execution transition transaction, while still making standalone calls
    # safe.  In particular, never commit a ready task before execution_steps.
    with kb.write_txn(conn):
        existing = conn.execute(
            "SELECT task_id FROM execution_steps WHERE execution_id=? AND continuation_key=?",
            (execution_id, continuation_key),
        ).fetchone()
        if existing:
            return str(existing["task_id"])
        task_id = kb.create_task(
            conn,
            title=f"[autonomous_execution:{role}] {root_task_id}",
            body="System-created autonomous execution step. Complete the assigned role and record task-run evidence.",
            created_by="execution_supervisor",
            assignee=role,
            initial_status="running",
            idempotency_key=f"execution-step:{execution_id}:{continuation_key}",
            metadata={
                "autonomous_execution_id": execution_id,
                "autonomous_execution_role": role,
                "autonomous_execution_criterion": criterion_id,
                "logical_model_tier": logical_model_tier,
                "continuation_key": continuation_key,
                "system_created": True,
            },
        )
        now = int(time.time())
        conn.execute(
            "INSERT INTO execution_steps (id,execution_id,task_id,role,status,criterion_id,logical_model_tier,system_created,continuation_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uuid.uuid4().hex, execution_id, task_id, role, "ready", criterion_id,
             logical_model_tier, 1, continuation_key, now, now),
        )
        # Publish ready only after the binding exists, in the same txn.
        conn.execute(
            "UPDATE tasks SET status='ready' WHERE id=? AND status='running' "
            "AND current_run_id IS NULL",
            (task_id,),
        )
        return task_id


def create_autonomous_execution(
    conn: sqlite3.Connection, *, root_task_id: str,
    criteria: Iterable[dict[str, Any]], requires_ops: bool = False,
    execution_id: str | None = None,
) -> str:
    """Create the explicit workflow template and its first Developer task."""
    frozen = _normalize_criteria(criteria)
    root = conn.execute("SELECT id FROM tasks WHERE id=?", (root_task_id,)).fetchone()
    if root is None:
        raise KeyError(root_task_id)
    execution_id = execution_id or uuid.uuid4().hex
    now = int(time.time())
    from hermes_cli import kanban_db as kb

    # Keep the template, frozen criteria, root task, and first dispatcher task
    # in one composable transaction.  ``write_txn`` joins an existing caller
    # transaction, while still providing the standalone transaction boundary.
    with kb.write_txn(conn):
        # The lookup and insert must share the writer transaction.  The
        # conflict target is deliberately only root_task_id: a caller-supplied
        # execution-id collision remains an IntegrityError instead of being
        # mistaken for this idempotent race.
        inserted = conn.execute(
            "INSERT INTO executions (id,root_task_id,workflow_type,status,frozen_criteria,requires_ops,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(root_task_id) DO NOTHING",
            (execution_id, root_task_id, "autonomous_execution", ExecutionStatus.RUNNING.value,
             json.dumps(frozen, sort_keys=True), int(requires_ops), now, now),
        ).rowcount
        if inserted != 1:
            existing = conn.execute(
                "SELECT id FROM executions WHERE root_task_id=?", (root_task_id,)
            ).fetchone()
            if existing is None:
                raise RuntimeError("execution create conflict had no existing root binding")
            return str(existing["id"])
        conn.executemany(
            "INSERT INTO execution_criteria (execution_id,criterion_id,ordinal,required_evidence) VALUES (?,?,?,?)",
            [(execution_id, item["id"], index, item["required_evidence"]) for index, item in enumerate(frozen)],
        )
        _create_system_step(
            conn, execution_id=execution_id, root_task_id=root_task_id,
            role="developer", criterion_id=frozen[0]["id"], logical_model_tier="normal",
            continuation_key="developer:0:normal",
        )
    return execution_id


def observe_completed_task_run(conn: sqlite3.Connection, task_id: str, run_id: int | None) -> bool:
    """Advance a system-owned step from its completed Kanban task-run.

    This is intentionally invoked only after ``complete_task`` has written the
    immutable worker result.  It never accepts a role or review/ops pass from a
    different worker's metadata: the task id and completed task-run are bound by
    ``execution_steps`` first.
    """
    from hermes_cli import kanban_db as kb

    step_row = conn.execute(
        "SELECT * FROM execution_steps WHERE task_id=? AND system_created=1", (task_id,)
    ).fetchone()
    if step_row is None:
        return False
    if run_id is None:
        raise ValueError("autonomous execution step requires a real task run")
    run = conn.execute(
        "SELECT * FROM task_runs WHERE id=? AND task_id=? AND outcome='completed' AND ended_at IS NOT NULL",
        (run_id, task_id),
    ).fetchone()
    if run is None:
        raise ValueError("autonomous execution step requires its completed task-run")

    execution_id = str(step_row["execution_id"])
    continuation: tuple[str, str, str | None, str | None, str] | None = None
    with kb.write_txn(conn):
        step = conn.execute("SELECT * FROM execution_steps WHERE id=?", (step_row["id"],)).fetchone()
        if step is None or step["completed_run_id"] is not None:
            return True
        execution = conn.execute("SELECT * FROM executions WHERE id=?", (execution_id,)).fetchone()
        if execution is None or execution["status"] in {
            ExecutionStatus.COMPLETE.value,
            ExecutionStatus.BLOCKED.value,
            ExecutionStatus.CANCELLED.value,
            ExecutionStatus.FAILED_SYSTEM.value,
        }:
            return False
        now = int(time.time())
        lease_owner = f"execution-step:{step['id']}"
        leased = conn.execute(
            "UPDATE executions SET lease_owner=?,lease_expires=? WHERE id=? AND (lease_owner IS NULL OR lease_expires<? OR lease_owner=?)",
            (lease_owner, now + 60, execution_id, now, lease_owner),
        )
        if leased.rowcount != 1:
            raise RuntimeError("execution lease is owned by another authoritative transition")
        try:
            evidence_data = json.loads(run["metadata"] or "{}")
        except (TypeError, json.JSONDecodeError):
            evidence_data = {}
        evidence = json.dumps(evidence_data, sort_keys=True)
        now = int(time.time())
        conn.execute(
            "UPDATE execution_steps SET status='done',completed_run_id=?,evidence=?,updated_at=? WHERE id=? AND completed_run_id IS NULL",
            (run_id, evidence, now, step["id"]),
        )
        if step["role"] == "developer" and step["criterion_id"]:
            proof = (evidence_data.get("evidence_by_criterion") or {}).get(step["criterion_id"], {})
            required = conn.execute(
                "SELECT required_evidence FROM execution_criteria WHERE execution_id=? AND criterion_id=?",
                (execution_id, step["criterion_id"]),
            ).fetchone()
            if proof.get("result") == "PASS" and required and proof.get("level") == required["required_evidence"]:
                conn.execute(
                    "UPDATE execution_criteria SET status='PASS',evidence_run_id=? WHERE execution_id=? AND criterion_id=?",
                    (run_id, execution_id, step["criterion_id"]),
                )
            elif proof.get("result") == "RED":
                conn.execute(
                    "UPDATE execution_criteria SET status='RED',evidence_run_id=? WHERE execution_id=? AND criterion_id=?",
                    (run_id, execution_id, step["criterion_id"]),
                )
        criteria = conn.execute(
            "SELECT criterion_id,status FROM execution_criteria WHERE execution_id=? ORDER BY ordinal", (execution_id,)
        ).fetchall()
        pending = next((row["criterion_id"] for row in criteria if row["status"] != "PASS"), None)
        decision = "CONTINUE"
        next_status = ExecutionStatus.RUNNING.value
        if step["role"] == "developer":
            if pending:
                if evidence_data.get("progress_only"):
                    decision = "NO_EXECUTION_PROGRESS"
                else:
                    decision = "REPAIR" if any(row["status"] == "RED" for row in criteria) else "TERMINATION_REJECTED"
                continuation = ("developer", f"developer:{int(execution['version']) + 1}:normal", pending, "normal", decision)
            else:
                decision = "READY_FOR_REVIEW"
                next_status = ExecutionStatus.READY_FOR_REVIEW.value
                continuation = ("reviewer", f"reviewer:{int(execution['version']) + 1}", None, None, decision)
        elif step["role"] == "reviewer":
            verdict = str(evidence_data.get("review_verdict") or "").upper()
            if verdict == "PASS":
                if bool(execution["requires_ops"]):
                    decision = "READY_FOR_OPS"
                    next_status = ExecutionStatus.READY_FOR_OPS.value
                    continuation = ("ops", f"ops:{int(execution['version']) + 1}", None, None, decision)
                else:
                    decision = "COMPLETE"
                    next_status = ExecutionStatus.COMPLETE.value
            else:
                decision = "REVIEW_CHANGES_REQUIRED"
                next_status = ExecutionStatus.RUNNING.value
                first = criteria[0]["criterion_id"] if criteria else None
                continuation = ("developer", f"developer:review-repair:{int(execution['version']) + 1}:normal", first, "normal", decision)
        elif step["role"] == "architect":
            architect_decision = str(evidence_data.get("architect_decision") or "").upper()
            next_status = ExecutionStatus.RUNNING.value
            first = next((row["criterion_id"] for row in criteria if row["status"] != "PASS"), None)
            if architect_decision == "RESUME":
                decision = "ARCHITECT_RESOLVED"
                continuation = (
                    "developer",
                    f"developer:architect:{int(execution['version']) + 1}:normal",
                    first,
                    "normal",
                    decision,
                )
            else:
                decision = "ARCHITECT_DECISION_REQUIRED"
                continuation = (
                    "architect",
                    f"architect:decision:{int(execution['version']) + 1}",
                    first,
                    None,
                    decision,
                )
        elif step["role"] == "ops":
            if str(evidence_data.get("ops_verdict") or "").upper() == "PASS":
                decision = "COMPLETE"
                next_status = ExecutionStatus.COMPLETE.value
            else:
                decision = "OPS_REPAIR"
                next_status = ExecutionStatus.READY_FOR_OPS.value
                continuation = ("ops", f"ops:repair:{int(execution['version']) + 1}", None, None, decision)
        if continuation is not None:
            role, key, criterion_id, tier, _ = continuation
            # Materialise the next dispatcher task while the authoritative
            # execution lease is still held and before publishing the CAS
            # transition.  The nested transaction is part of this outer
            # transaction, so a crash cannot leave a committed transition
            # with no continuation (or a ready task with no binding).
            _create_system_step(
                conn, execution_id=execution_id, root_task_id=execution["root_task_id"],
                role=role, continuation_key=key, criterion_id=criterion_id,
                logical_model_tier=tier,
            )
        version = int(execution["version"]) + 1
        cur = conn.execute(
            "UPDATE executions SET status=?,version=?,updated_at=?,lease_owner=NULL,lease_expires=NULL WHERE id=? AND version=? AND lease_owner=?",
            (next_status, version, now, execution_id, int(execution["version"]), lease_owner),
        )
        if cur.rowcount != 1:
            raise RuntimeError("stale execution transition")
        conn.execute(
            "INSERT INTO execution_events (execution_id,version,decision,step_id,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)",
            (execution_id, version, decision, step["id"], evidence, f"completed-run:{run_id}", now),
        )
        if decision == "COMPLETE":
            # The root card is closed only by this orchestration-level terminal
            # gate, never by the Developer's worker final.
            conn.execute(
                "UPDATE tasks SET status='done',completed_at=?,claim_lock=NULL,claim_expires=NULL WHERE id=? AND status NOT IN ('done','archived')",
                (now, execution["root_task_id"]),
            )
    return True


VALID_STOP_GATES = frozenset({
    "unresolved_business_requirement", "adr_or_scope_decision_required", "production_destructive_operation_requires_owner_approval", "missing_required_credentials_or_secret", "external_dependency_unavailable", "required_upstream_core_change", "production_safety_boundary_uncertain", "security_boundary_uncertain", "rollback_path_cannot_be_proven", "confirmed_technical_dead_end_after_escalation", "user_explicitly_paused_or_cancelled_execution",
})


def acquire_execution_lease(conn: sqlite3.Connection, execution_id: str, owner: str, *, ttl_seconds: int = 60) -> bool:
    now = int(time.time())
    cur = conn.execute("UPDATE executions SET lease_owner=?,lease_expires=? WHERE id=? AND (lease_owner IS NULL OR lease_expires<? OR lease_owner=?)", (owner, now + ttl_seconds, execution_id, now, owner))
    return cur.rowcount == 1


def block_execution(conn: sqlite3.Connection, execution_id: str, *, kind: str, evidence: str, required_user_action: str) -> bool:
    if kind not in VALID_STOP_GATES or not str(evidence).strip() or not str(required_user_action).strip():
        return False
    from hermes_cli import kanban_db as kb

    owner = f"block:{uuid.uuid4().hex}"
    now = int(time.time())
    with kb.write_txn(conn):
        state = get_execution(conn, execution_id)
        if state.status in {ExecutionStatus.COMPLETE, ExecutionStatus.BLOCKED, ExecutionStatus.CANCELLED, ExecutionStatus.FAILED_SYSTEM}:
            return False
        lease = conn.execute(
            "UPDATE executions SET lease_owner=?,lease_expires=? WHERE id=? "
            "AND (lease_owner IS NULL OR lease_expires<? OR lease_owner=?)",
            (owner, now + 60, execution_id, now, owner),
        )
        if lease.rowcount != 1:
            return False
        version = state.version + 1
        transitioned = conn.execute(
            "UPDATE executions SET status=?,version=?,updated_at=?,lease_owner=NULL,lease_expires=NULL "
            "WHERE id=? AND version=? AND lease_owner=?",
            (ExecutionStatus.BLOCKED.value, version, now, execution_id, state.version, owner),
        )
        if transitioned.rowcount != 1:
            return False
        conn.execute(
            "INSERT INTO execution_events "
            "(execution_id,version,decision,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?)",
            (
                execution_id,
                version,
                "BLOCKED",
                json.dumps({"kind": kind, "evidence": evidence, "required_user_action": required_user_action}, sort_keys=True),
                f"block:{version}",
                now,
            ),
        )
    return True


def record_failure(conn: sqlite3.Connection, execution_id: str, *, criterion_id: str, category: str, failure_signature: str, evidence_level: str = "UNIT") -> str | None:
    """Persist a leased/CAS failure transition and materialise its next role step."""
    from hermes_cli import kanban_db as kb

    category = category.lower().replace("-", "_")
    now = int(time.time())
    owner = f"failure:{uuid.uuid4().hex}"
    decision: str
    role: str
    tier: str | None
    version: int
    root_task_id: str
    with kb.write_txn(conn):
        state = get_execution(conn, execution_id)
        if state.status in {
            ExecutionStatus.COMPLETE,
            ExecutionStatus.BLOCKED,
            ExecutionStatus.CANCELLED,
            ExecutionStatus.FAILED_SYSTEM,
        }:
            return None
        lease = conn.execute(
            "UPDATE executions SET lease_owner=?,lease_expires=? WHERE id=? "
            "AND (lease_owner IS NULL OR lease_expires<? OR lease_owner=?)",
            (owner, now + 60, execution_id, now, owner),
        )
        if lease.rowcount != 1:
            return None
        rows = conn.execute(
            "SELECT category,failure_signature,evidence_level FROM execution_attempts "
            "WHERE execution_id=? AND criterion_id=?",
            (execution_id, criterion_id),
        ).fetchall()
        same_category = 1 + sum(row["category"] == category for row in rows)
        same_signature = 1 + sum(row["failure_signature"] == failure_signature for row in rows)
        runtime_failures = 1 + sum(row["evidence_level"] == "ISOLATED_RUNTIME" for row in rows if evidence_level == "ISOLATED_RUNTIME")
        strong_owned = conn.execute(
            "SELECT 1 FROM execution_steps WHERE execution_id=? AND criterion_id=? "
            "AND logical_model_tier='strong' AND status IN ('ready','running')",
            (execution_id, criterion_id),
        ).fetchone() is not None
        if category in {"scope", "adr", "architecture"}:
            decision, role, tier = "ESCALATE_ARCHITECT", "architect", None
        elif category in {"rbac", "security", "cross_tenant", "migration", "install", "persistence_runtime_semantics"} or runtime_failures >= 2 or same_signature >= 2 or (category == "review" and same_category >= 2):
            decision, role, tier = "ESCALATE_MODEL", "developer", "strong"
        elif same_category >= 5:
            decision, role, tier = "ESCALATE_MODEL", "developer", "expert"
        elif strong_owned:
            decision, role, tier = "ESCALATE_MODEL", "developer", "strong"
        else:
            decision, role, tier = "CONTINUE", "developer", "normal"
        version = state.version + 1
        transitioned = conn.execute(
            "UPDATE executions SET version=?,updated_at=? WHERE id=? AND version=? AND lease_owner=?",
            (version, now, execution_id, state.version, owner),
        )
        if transitioned.rowcount != 1:
            return None
        conn.execute(
            "INSERT INTO execution_attempts "
            "(execution_id,criterion_id,role,logical_model_tier,category,failure_signature,evidence_level,outcome,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (execution_id, criterion_id, "developer", tier or "normal", category, failure_signature, evidence_level, "failed", now),
        )
        conn.execute(
            "INSERT INTO execution_events "
            "(execution_id,version,decision,evidence,idempotency_key,created_at) VALUES (?,?,?,?,?,?)",
            (execution_id, version, decision, json.dumps({"criterion_id": criterion_id, "category": category, "failure_signature": failure_signature}), f"failure:{version}", now),
        )
        root_task_id = state.root_task_id
        _create_system_step(
            conn,
            execution_id=execution_id,
            root_task_id=root_task_id,
            role=role,
            criterion_id=criterion_id,
            logical_model_tier=tier,
            continuation_key=f"{role}:failure:{version}:{tier or 'architect'}",
        )
        conn.execute(
            "UPDATE executions SET lease_owner=NULL,lease_expires=NULL WHERE id=? AND lease_owner=?",
            (execution_id, owner),
        )
    return decision


def recover_autonomous_executions(conn: sqlite3.Connection) -> int:
    """Restart recovery materialises any persisted non-terminal continuation once.

    Recovery is an authoritative transition: a short execution lease serializes
    concurrent dispatcher ticks, and the existing continuation key makes a
    replay return the same system task rather than create a sibling.
    """
    recovered = 0
    rows = conn.execute(
        "SELECT id FROM executions WHERE status NOT IN (?,?,?,?)",
        (
            ExecutionStatus.COMPLETE.value,
            ExecutionStatus.BLOCKED.value,
            ExecutionStatus.CANCELLED.value,
            ExecutionStatus.FAILED_SYSTEM.value,
        ),
    ).fetchall()
    for row in rows:
        execution_id = str(row["id"])
        owner = f"recovery:{uuid.uuid4().hex}"
        caller_owned_transaction = conn.in_transaction

        # A task/run may already be durably complete while its supervisor
        # binding is still awaiting observation (for example, a process died
        # in an older completion/observation gap).  Replay the bound observer
        # first.  Generic recovery must never compete with this authoritative
        # completed-run transition and create a sibling continuation.
        pending_run = conn.execute(
            "SELECT s.task_id,r.id AS run_id "
            "FROM execution_steps s "
            "JOIN tasks t ON t.id=s.task_id AND t.status='done' "
            "JOIN task_runs r ON r.task_id=t.id "
            "WHERE s.execution_id=? AND s.system_created=1 "
            "AND s.status IN ('ready','running') AND s.completed_run_id IS NULL "
            "AND r.outcome='completed' AND r.ended_at IS NOT NULL "
            "ORDER BY r.id DESC LIMIT 1",
            (execution_id,),
        ).fetchone()
        if pending_run is not None:
            if observe_completed_task_run(
                conn, str(pending_run["task_id"]), int(pending_run["run_id"])
            ):
                recovered += 1
            continue

        if not acquire_execution_lease(conn, execution_id, owner):
            continue
        try:
            current = conn.execute("SELECT * FROM executions WHERE id=?", (execution_id,)).fetchone()
            if current is None or current["status"] in {
                ExecutionStatus.COMPLETE.value,
                ExecutionStatus.BLOCKED.value,
                ExecutionStatus.CANCELLED.value,
                ExecutionStatus.FAILED_SYSTEM.value,
            }:
                continue
            active = conn.execute(
                "SELECT 1 FROM execution_steps s JOIN tasks t ON t.id=s.task_id "
                "WHERE s.execution_id=? AND s.status IN ('ready','running') "
                "AND t.status IN ('ready','running')",
                (execution_id,),
            ).fetchone()
            if active:
                continue
            criterion = conn.execute(
                "SELECT criterion_id FROM execution_criteria WHERE execution_id=? "
                "AND status!='PASS' ORDER BY ordinal LIMIT 1",
                (execution_id,),
            ).fetchone()
            version = int(current["version"]) + 1
            now = int(time.time())
            transitioned = conn.execute(
                "UPDATE executions SET version=?,updated_at=? WHERE id=? "
                "AND version=? AND lease_owner=?",
                (version, now, execution_id, int(current["version"]), owner),
            )
            if transitioned.rowcount != 1:
                continue
            if current["status"] == ExecutionStatus.READY_FOR_REVIEW.value:
                role, tier, decision = "reviewer", None, "RECOVER_READY_FOR_REVIEW"
            elif current["status"] == ExecutionStatus.READY_FOR_OPS.value:
                role, tier, decision = "ops", None, "RECOVER_READY_FOR_OPS"
            else:
                role, tier, decision = "developer", "normal", "CONTINUE"
            # Publish the dispatcher-visible continuation before advancing the
            # version.  The recovery lease remains held across this operation;
            # if the process dies after task creation, a later recovery sees
            # the active system step and cannot create a sibling.
            continuation_key = f"recovery:{version}"
            _create_system_step(
                conn,
                execution_id=execution_id,
                root_task_id=current["root_task_id"],
                role=role,
                criterion_id=criterion["criterion_id"] if role == "developer" and criterion else None,
                logical_model_tier=tier,
                continuation_key=continuation_key,
            )
            conn.execute(
                "INSERT INTO execution_events "
                "(execution_id,version,decision,evidence,idempotency_key,created_at) "
                "VALUES (?,?,?,?,?,?)",
                (execution_id, version, decision, "recovery continuation", f"recovery:{version}", now),
            )
            recovered += 1
        finally:
            conn.execute(
                "UPDATE executions SET lease_owner=NULL,lease_expires=NULL "
                "WHERE id=? AND lease_owner=?",
                (execution_id, owner),
            )
            # A completion observer may invoke recovery while it owns the
            # enclosing Kanban completion transaction.  Do not commit that
            # outer transaction here; task/run completion and observation
            # must remain atomic.  Standalone dispatcher recovery still owns
            # and commits its implicit transaction as before.
            if not caller_owned_transaction and conn.in_transaction:
                conn.commit()
    return recovered
