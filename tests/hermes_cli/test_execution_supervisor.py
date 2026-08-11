"""Behavioral Phase 2.2 contracts for the autonomous Kanban workflow."""
from __future__ import annotations

import contextlib
import sqlite3
import threading

import pytest
from hermes_cli import kanban_db as kb
from hermes_cli.execution_supervisor import (
    ExecutionStatus, acquire_execution_lease, block_execution, create_autonomous_execution,
    get_execution, list_execution_steps, record_failure,
    recover_autonomous_executions, _create_system_step,
)


def _new(conn, criteria=("runtime",), ops=False):
    root = kb.create_task(conn, title="Slice")
    return create_autonomous_execution(conn, root_task_id=root,
        criteria=[{"id": item, "required_evidence": "ISOLATED_RUNTIME"} for item in criteria], requires_ops=ops)


def _complete(conn, step, metadata=None):
    assert kb.claim_task(conn, step.task_id, claimer="worker")
    run_id = kb.get_task(conn, step.task_id).current_run_id
    assert kb.complete_task(conn, step.task_id, summary="worker final", metadata=metadata, expected_run_id=run_id)


def _pass_current_developer(conn, execution_id):
    step = next(s for s in list_execution_steps(conn, execution_id) if s.status == "ready" and s.role == "developer")
    _complete(conn, step, {"evidence_by_criterion": {step.criterion_id: {"result": "PASS", "level": "ISOLATED_RUNTIME"}}})


def test_execution_state_is_frozen_and_first_step_is_system_owned(tmp_path):
    conn = kb.connect(tmp_path / "state.db")
    try:
        eid = _new(conn)
        assert get_execution(conn, eid).status is ExecutionStatus.RUNNING
        assert [(s.role, s.status, s.system_created) for s in list_execution_steps(conn, eid)] == [("developer", "ready", True)]
        with pytest.raises(Exception, match="frozen criteria"):
            conn.execute("UPDATE executions SET frozen_criteria='[]' WHERE id=?", (eid,))
    finally: conn.close()


def test_execution_creation_composes_with_outer_transaction(tmp_path):
    conn = kb.connect(tmp_path / "creation-transaction.db")
    try:
        with pytest.raises(RuntimeError, match="abort outer creation"):
            with kb.write_txn(conn):
                root = kb.create_task(conn, title="transactional autonomous root")
                create_autonomous_execution(
                    conn,
                    root_task_id=root,
                    criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
                )
                raise RuntimeError("abort outer creation")

        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM execution_steps").fetchone()[0] == 0
    finally:
        conn.close()


def test_scenario_1_intermediate_final_rejects_termination(tmp_path):
    conn = kb.connect(tmp_path / "s1.db")
    try:
        eid = _new(conn, ("one", "two")); _complete(conn, list_execution_steps(conn, eid)[0])
        assert [s.status for s in list_execution_steps(conn, eid)] == ["done", "ready"]
        assert conn.execute("SELECT decision FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == "TERMINATION_REJECTED"
    finally: conn.close()


def test_concurrent_creation_converges_on_one_execution(tmp_path, monkeypatch):
    """Two connections racing on the same root must share one workflow."""
    path = tmp_path / "creation-contention.db"
    setup = kb.connect(path)
    root = kb.create_task(setup, title="contention root")
    setup.close()

    # Synchronize both callers immediately after their pre-transaction work.
    # This makes the old check-then-insert seam deterministic rather than
    # relying on thread scheduling to produce the race.
    original_write_txn = kb.write_txn
    boundary = threading.Barrier(2)
    boundary_calls = 0
    boundary_lock = threading.Lock()

    @contextlib.contextmanager
    def synchronized_write_txn(conn):
        nonlocal boundary_calls
        with boundary_lock:
            should_wait = boundary_calls < 2
            boundary_calls += 1
        if should_wait:
            boundary.wait(timeout=5)
        with original_write_txn(conn) as transaction:
            yield transaction

    monkeypatch.setattr(kb, "write_txn", synchronized_write_txn)
    results = []
    errors = []

    def create_on_independent_connection():
        conn = kb.connect(path)
        try:
            results.append(create_autonomous_execution(
                conn,
                root_task_id=root,
                criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
            ))
        except BaseException as exc:  # assert worker failures below
            errors.append(exc)
        finally:
            conn.close()

    threads = [threading.Thread(target=create_on_independent_connection) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    assert all(not thread.is_alive() for thread in threads)
    assert not errors
    assert len(results) == 2
    assert results[0] == results[1]

    check = kb.connect(path)
    try:
        assert check.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 1
        assert check.execute("SELECT COUNT(*) FROM execution_criteria").fetchone()[0] == 1
        assert check.execute("SELECT COUNT(*) FROM execution_steps").fetchone()[0] == 1
        assert check.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 2
        assert check.execute("SELECT COUNT(*) FROM execution_events").fetchone()[0] == 0
        assert check.execute("SELECT COUNT(*) FROM execution_attempts").fetchone()[0] == 0
    finally:
        check.close()


def test_creation_does_not_mask_unrelated_execution_id_collision(tmp_path):
    conn = kb.connect(tmp_path / "creation-id-collision.db")
    try:
        first_root = kb.create_task(conn, title="first root")
        create_autonomous_execution(
            conn,
            root_task_id=first_root,
            execution_id="caller-selected-id",
            criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
        )
        second_root = kb.create_task(conn, title="second root")
        with pytest.raises(sqlite3.IntegrityError, match="executions.id"):
            create_autonomous_execution(
                conn,
                root_task_id=second_root,
                execution_id="caller-selected-id",
                criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
            )
        assert conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM execution_steps").fetchone()[0] == 1
    finally:
        conn.close()


def test_scenario_2_red_runtime_invariant_repairs_and_continues(tmp_path):
    conn = kb.connect(tmp_path / "s2.db")
    try:
        eid = _new(conn); step = list_execution_steps(conn, eid)[0]
        _complete(conn, step, {"evidence_by_criterion": {"runtime": {"result": "RED", "level": "ISOLATED_RUNTIME"}}})
        assert conn.execute("SELECT status FROM execution_criteria WHERE execution_id=?", (eid,)).fetchone()[0] == "RED"
        assert conn.execute("SELECT decision FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == "REPAIR"
    finally: conn.close()


def test_scenario_3_passing_current_tests_does_not_complete_slice(tmp_path):
    conn = kb.connect(tmp_path / "s3.db")
    try:
        eid = _new(conn, ("one", "two")); _pass_current_developer(conn, eid)
        assert get_execution(conn, eid).status is ExecutionStatus.RUNNING
        assert kb.get_task(conn, get_execution(conn, eid).root_task_id).status != "done"
    finally: conn.close()


def test_scenario_4_reviewer_changes_create_developer_repair(tmp_path):
    conn = kb.connect(tmp_path / "s4.db")
    try:
        eid = _new(conn); _pass_current_developer(conn, eid)
        reviewer = next(s for s in list_execution_steps(conn, eid) if s.role == "reviewer" and s.status == "ready")
        _complete(conn, reviewer, {"review_verdict": "CHANGES_REQUIRED"})
        assert any(s.role == "developer" and s.status == "ready" for s in list_execution_steps(conn, eid))
    finally: conn.close()


def test_scenario_5_allowlisted_production_gate_blocks_without_action(tmp_path):
    conn = kb.connect(tmp_path / "s5.db")
    try:
        eid = _new(conn)
        assert block_execution(conn, eid, kind="production_destructive_operation_requires_owner_approval", evidence="migration drops data", required_user_action="owner approval")
        assert get_execution(conn, eid).status is ExecutionStatus.BLOCKED
    finally: conn.close()


def test_scenario_6_five_failures_escalate_not_stop(tmp_path):
    conn = kb.connect(tmp_path / "s6.db")
    try:
        eid = _new(conn)
        decisions = [record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature=f"f{i}") for i in range(5)]
        assert decisions[-1] == "ESCALATE_MODEL" and get_execution(conn, eid).status is ExecutionStatus.RUNNING
    finally: conn.close()


def test_scenario_7_restart_recovery_creates_missing_continuation(tmp_path):
    path = tmp_path / "s7.db"; conn = kb.connect(path); eid = _new(conn)
    step = list_execution_steps(conn, eid)[0]; conn.execute("UPDATE tasks SET status='done' WHERE id=?", (step.task_id,)); conn.execute("UPDATE execution_steps SET status='done' WHERE id=?", (step.id,)); conn.commit(); conn.close()
    restarted = kb.connect(path)
    try:
        assert recover_autonomous_executions(restarted) == 1
        assert get_execution(restarted, eid).version == 1
        assert recover_autonomous_executions(restarted) == 0
    finally: restarted.close()


def test_scenario_8_duplicate_completion_event_creates_one_continuation(tmp_path):
    conn = kb.connect(tmp_path / "s8.db")
    try:
        eid = _new(conn); _complete(conn, list_execution_steps(conn, eid)[0])
        assert recover_autonomous_executions(conn) == 0
        assert len(list_execution_steps(conn, eid)) == 2
    finally: conn.close()


def test_completion_observation_race_does_not_create_recovery_sibling(tmp_path, monkeypatch):
    """Recovery between task commit and observation must be exactly-once."""
    conn = kb.connect(tmp_path / "completion-observation-race.db")
    try:
        eid = _new(conn)
        original_observer = __import__(
            "hermes_cli.execution_supervisor", fromlist=["observe_completed_task_run"]
        ).observe_completed_task_run
        interleaving = []
        supervisor = __import__(
            "hermes_cli.execution_supervisor", fromlist=["observe_completed_task_run"]
        )

        def observe_after_restart(conn, task_id, run_id):
            supervisor.observe_completed_task_run = original_observer
            try:
                interleaving.append(recover_autonomous_executions(conn))
            finally:
                supervisor.observe_completed_task_run = observe_after_restart
            return original_observer(conn, task_id, run_id)

        monkeypatch.setattr(
            "hermes_cli.execution_supervisor.observe_completed_task_run",
            observe_after_restart,
        )
        _complete(
            conn,
            list_execution_steps(conn, eid)[0],
            {"evidence_by_criterion": {"runtime": {"result": "PASS", "level": "ISOLATED_RUNTIME"}}},
        )

        assert interleaving == [1]
        steps = list_execution_steps(conn, eid)
        assert [(step.role, step.continuation_key) for step in steps] == [
            ("developer", "developer:0:normal"),
            ("reviewer", "reviewer:1"),
        ]
        assert conn.execute(
            "SELECT COUNT(*) FROM execution_steps WHERE execution_id=? AND continuation_key LIKE 'recovery:%'",
            (eid,),
        ).fetchone()[0] == 0
        event = conn.execute(
            "SELECT decision,idempotency_key FROM execution_events WHERE execution_id=? ORDER BY version",
            (eid,),
        ).fetchall()[0]
        assert (event["decision"], event["idempotency_key"]) == (
            "READY_FOR_REVIEW", "completed-run:1"
        )
    finally:
        conn.close()


def test_scenario_9_planning_only_response_is_recorded_and_reinvoked(tmp_path):
    conn = kb.connect(tmp_path / "s9.db")
    try:
        eid = _new(conn); _complete(conn, list_execution_steps(conn, eid)[0], {"progress_only": True})
        assert conn.execute("SELECT decision FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == "NO_EXECUTION_PROGRESS"
        assert len(list_execution_steps(conn, eid)) == 2
    finally: conn.close()


def test_scenario_10_full_path_developer_reviewer_ops_completes(tmp_path):
    conn = kb.connect(tmp_path / "s10.db")
    try:
        eid = _new(conn, ops=True); _pass_current_developer(conn, eid)
        _complete(conn, next(s for s in list_execution_steps(conn, eid) if s.role == "reviewer" and s.status == "ready"), {"review_verdict": "PASS"})
        _complete(conn, next(s for s in list_execution_steps(conn, eid) if s.role == "ops" and s.status == "ready"), {"ops_verdict": "PASS"})
        assert get_execution(conn, eid).status is ExecutionStatus.COMPLETE
    finally: conn.close()


def test_scenario_11_two_runtime_failures_select_strong(tmp_path):
    conn = kb.connect(tmp_path / "s11.db")
    try:
        eid = _new(conn); record_failure(conn, eid, criterion_id="runtime", category="runtime", failure_signature="r1", evidence_level="ISOLATED_RUNTIME")
        assert record_failure(conn, eid, criterion_id="runtime", category="runtime", failure_signature="r2", evidence_level="ISOLATED_RUNTIME") == "ESCALATE_MODEL"
        assert any(s.logical_model_tier == "strong" for s in list_execution_steps(conn, eid))
    finally: conn.close()


def test_scenario_12_two_local_green_runtime_red_mismatches_select_strong(tmp_path):
    conn = kb.connect(tmp_path / "s12.db")
    try:
        eid = _new(conn); record_failure(conn, eid, criterion_id="runtime", category="runtime", failure_signature="green-red", evidence_level="ISOLATED_RUNTIME")
        assert record_failure(conn, eid, criterion_id="runtime", category="runtime", failure_signature="green-red", evidence_level="ISOLATED_RUNTIME") == "ESCALATE_MODEL"
    finally: conn.close()


def test_scenario_13_repeated_failure_signature_selects_strong(tmp_path):
    conn = kb.connect(tmp_path / "s13.db")
    try:
        eid = _new(conn); record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="same")
        assert record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="same") == "ESCALATE_MODEL"
    finally: conn.close()


def test_scenario_14_simple_unit_repair_stays_normal(tmp_path):
    conn = kb.connect(tmp_path / "s14.db")
    try:
        eid = _new(conn); assert record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="assertion") == "CONTINUE"
        assert list_execution_steps(conn, eid)[-1].logical_model_tier == "normal"
    finally: conn.close()


def test_scenario_15_two_reviewer_category_failures_escalate_model(tmp_path):
    conn = kb.connect(tmp_path / "s15.db")
    try:
        eid = _new(conn); record_failure(conn, eid, criterion_id="runtime", category="review", failure_signature="style1")
        assert record_failure(conn, eid, criterion_id="runtime", category="review", failure_signature="style2") == "ESCALATE_MODEL"
    finally: conn.close()


def test_scenario_16_architecture_ambiguity_routes_architect_not_developer(tmp_path):
    conn = kb.connect(tmp_path / "s16.db")
    try:
        eid = _new(conn); assert record_failure(conn, eid, criterion_id="runtime", category="architecture", failure_signature="adr-gap") == "ESCALATE_ARCHITECT"
        assert list_execution_steps(conn, eid)[-1].role == "architect"
    finally: conn.close()


def test_scenario_17_partial_worker_completion_continues_next_pass(tmp_path):
    conn = kb.connect(tmp_path / "s17.db")
    try:
        eid = _new(conn, ("one", "two")); _pass_current_developer(conn, eid)
        assert next(s for s in list_execution_steps(conn, eid) if s.status == "ready").criterion_id == "two"
        _pass_current_developer(conn, eid)
        assert [(s.role, s.status) for s in list_execution_steps(conn, eid)][-1] == ("reviewer", "ready")
    finally: conn.close()


def test_scenario_18_strong_owns_unresolved_criterion(tmp_path):
    conn = kb.connect(tmp_path / "s18.db")
    try:
        eid = _new(conn); record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="same")
        record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="same")
        assert record_failure(conn, eid, criterion_id="runtime", category="unit", failure_signature="new") == "ESCALATE_MODEL"
        assert list_execution_steps(conn, eid)[-1].logical_model_tier == "strong"
    finally: conn.close()


@pytest.mark.parametrize(
    ("status", "expected_role"),
    [
        (ExecutionStatus.READY_FOR_REVIEW.value, "reviewer"),
        (ExecutionStatus.READY_FOR_OPS.value, "ops"),
    ],
)
def test_recovery_preserves_role_owned_gate(status, expected_role, tmp_path):
    conn = kb.connect(tmp_path / f"recovery-{expected_role}.db")
    try:
        eid = _new(conn, ops=True)
        conn.execute("UPDATE executions SET status=? WHERE id=?", (status, eid))
        conn.execute("UPDATE execution_steps SET status='done' WHERE execution_id=?", (eid,))
        conn.execute("UPDATE tasks SET status='done' WHERE id IN (SELECT task_id FROM execution_steps WHERE execution_id=?)", (eid,))
        conn.commit()
        assert recover_autonomous_executions(conn) == 1
        assert list_execution_steps(conn, eid)[-1].role == expected_role
    finally:
        conn.close()


def test_failed_system_execution_is_terminal_for_recovery_and_blocking(tmp_path):
    conn = kb.connect(tmp_path / "failed-system-terminal.db")
    try:
        eid = _new(conn)
        conn.execute("UPDATE executions SET status='failed_system' WHERE id=?", (eid,))
        conn.execute("UPDATE execution_steps SET status='done' WHERE execution_id=?", (eid,))
        conn.execute("UPDATE tasks SET status='done' WHERE id IN (SELECT task_id FROM execution_steps WHERE execution_id=?)", (eid,))
        conn.commit()
        assert recover_autonomous_executions(conn) == 0
        assert not block_execution(
            conn,
            eid,
            kind="production_destructive_operation_requires_owner_approval",
            evidence="terminal system failure",
            required_user_action="owner approval",
        )
        assert get_execution(conn, eid).status is ExecutionStatus.FAILED_SYSTEM
    finally:
        conn.close()


def test_record_failure_requires_authoritative_lease_and_cas(tmp_path):
    conn = kb.connect(tmp_path / "failure-lease.db")
    try:
        eid = _new(conn)
        assert acquire_execution_lease(conn, eid, "other-owner")
        assert record_failure(
            conn,
            eid,
            criterion_id="runtime",
            category="unit",
            failure_signature="assertion",
        ) is None
        assert conn.execute("SELECT COUNT(*) FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == 0
        assert len(list_execution_steps(conn, eid)) == 1
    finally:
        conn.close()


def test_architect_resolution_returns_to_developer_continuation(tmp_path):
    conn = kb.connect(tmp_path / "architect-resolution.db")
    try:
        eid = _new(conn)
        assert record_failure(conn, eid, criterion_id="runtime", category="architecture", failure_signature="adr-gap") == "ESCALATE_ARCHITECT"
        architect = next(s for s in list_execution_steps(conn, eid) if s.role == "architect" and s.status == "ready")
        _complete(conn, architect, {"architect_decision": "RESUME"})
        steps = list_execution_steps(conn, eid)
        assert len([s for s in steps if s.role == "developer"]) == 2
        assert conn.execute("SELECT decision FROM execution_events WHERE execution_id=? ORDER BY id DESC", (eid,)).fetchone()[0] == "ARCHITECT_RESOLVED"
    finally:
        conn.close()


def test_cancelled_execution_ignores_late_system_step_completion(tmp_path):
    conn = kb.connect(tmp_path / "cancelled-late-step.db")
    try:
        eid = _new(conn)
        step = list_execution_steps(conn, eid)[0]
        conn.execute("UPDATE executions SET status='cancelled' WHERE id=?", (eid,))
        conn.commit()
        _complete(conn, step, {"evidence_by_criterion": {"runtime": {"result": "PASS", "level": "ISOLATED_RUNTIME"}}})
        assert get_execution(conn, eid).status is ExecutionStatus.CANCELLED
        assert len(list_execution_steps(conn, eid)) == 1
        assert conn.execute("SELECT COUNT(*) FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == 0
    finally:
        conn.close()


def test_system_created_steps_route_to_their_role_profile(tmp_path, monkeypatch):
    conn = kb.connect(tmp_path / "role-routing.db")
    try:
        eid = _new(conn)
        step = list_execution_steps(conn, eid)[0]
        task = kb.get_task(conn, step.task_id)
        assert task is not None
        assert task.status == "ready"
        assert task.assignee == "developer"
        monkeypatch.setattr("hermes_cli.profiles.profile_exists", lambda name: name == "developer")
        result = kb.dispatch_once(conn, spawn_fn=lambda *_: None, max_spawn=1)
        assert any(task_id == step.task_id and assignee == "developer" for task_id, assignee, _ in result.spawned)
    finally:
        conn.close()


def test_recovery_respects_existing_execution_lease(tmp_path):
    conn = kb.connect(tmp_path / "recovery-lease.db")
    try:
        eid = _new(conn)
        step = list_execution_steps(conn, eid)[0]
        conn.execute("UPDATE tasks SET status='done' WHERE id=?", (step.task_id,))
        conn.execute("UPDATE execution_steps SET status='done' WHERE id=?", (step.id,))
        conn.commit()
        assert acquire_execution_lease(conn, eid, "another-recovery-owner")
        assert recover_autonomous_executions(conn) == 0
        assert len(list_execution_steps(conn, eid)) == 1
    finally:
        conn.close()


def test_root_task_cannot_bypass_autonomous_terminal_gate(tmp_path):
    conn = kb.connect(tmp_path / "root-bypass.db")
    try:
        root = kb.create_task(conn, title="autonomous root")
        create_autonomous_execution(
            conn,
            root_task_id=root,
            criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
            requires_ops=True,
        )
        assert kb.claim_task(conn, root, claimer="root-worker")
        root_run = kb.get_task(conn, root).current_run_id
        assert not kb.complete_task(conn, root, summary="premature final", expected_run_id=root_run)
        assert kb.get_task(conn, root).status != "done"
        assert get_execution(conn, conn.execute("SELECT id FROM executions WHERE root_task_id=?", (root,)).fetchone()[0]).status is ExecutionStatus.RUNNING
    finally:
        conn.close()


def test_block_execution_requires_authoritative_lease(tmp_path):
    conn = kb.connect(tmp_path / "block-lease.db")
    try:
        eid = _new(conn)
        assert acquire_execution_lease(conn, eid, "other-owner")
        assert not block_execution(
            conn,
            eid,
            kind="production_destructive_operation_requires_owner_approval",
            evidence="destructive action",
            required_user_action="owner approval",
        )
        assert get_execution(conn, eid).status is ExecutionStatus.RUNNING
        assert conn.execute("SELECT COUNT(*) FROM execution_events WHERE execution_id=?", (eid,)).fetchone()[0] == 0
    finally:
        conn.close()


def test_blocked_root_cannot_bypass_autonomous_terminal_gate(tmp_path):
    conn = kb.connect(tmp_path / "blocked-root-bypass.db")
    try:
        root = kb.create_task(conn, title="blocked autonomous root")
        eid = create_autonomous_execution(
            conn,
            root_task_id=root,
            criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
        )
        assert block_execution(
            conn,
            eid,
            kind="production_destructive_operation_requires_owner_approval",
            evidence="destructive action",
            required_user_action="owner approval",
        )
        assert kb.claim_task(conn, root, claimer="root-worker")
        assert not kb.complete_task(conn, root, expected_run_id=kb.get_task(conn, root).current_run_id)
        assert kb.get_task(conn, root).status != "done"
    finally:
        conn.close()


def test_leases_guard_authoritative_transition_and_normal_tasks_are_unchanged(tmp_path):
    conn = kb.connect(tmp_path / "lease.db")
    try:
        eid = _new(conn); assert acquire_execution_lease(conn, eid, "a") and not acquire_execution_lease(conn, eid, "b")
        normal = kb.create_task(conn, title="ordinary"); assert kb.claim_task(conn, normal, claimer="ordinary")
        assert kb.complete_task(conn, normal, summary="done", expected_run_id=kb.get_task(conn, normal).current_run_id)
        assert conn.execute("SELECT COUNT(*) FROM executions WHERE root_task_id=?", (normal,)).fetchone()[0] == 0
    finally: conn.close()


def test_dispatcher_tick_invokes_restart_recovery(tmp_path):
    conn = kb.connect(tmp_path / "dispatch-recovery.db")
    try:
        eid = _new(conn)
        step = list_execution_steps(conn, eid)[0]
        conn.execute("UPDATE tasks SET status='done' WHERE id=?", (step.task_id,))
        conn.execute("UPDATE execution_steps SET status='done' WHERE id=?", (step.id,))
        conn.commit()
        kb.dispatch_once(conn, dry_run=True)
        assert any(s.status == "ready" for s in list_execution_steps(conn, eid))
    finally: conn.close()


def test_system_task_is_never_ready_without_its_execution_binding(tmp_path):
    path = tmp_path / "step-publication.db"
    conn = kb.connect(path)
    observer = kb.connect(path)
    seen_orphan = []
    try:
        eid = _new(conn)
        seen_orphan.clear()

        def trace(sql):
            if sql.lstrip().upper().startswith("INSERT INTO EXECUTION_STEPS"):
                rows = observer.execute(
                    "SELECT id FROM tasks WHERE metadata LIKE ? AND status='ready'",
                    ('%"continuation_key": "test:atomic"%',),
                ).fetchall()
                seen_orphan.extend(
                    observer.execute(
                        "SELECT 1 FROM execution_steps WHERE task_id=?",
                        (row["id"],),
                    ).fetchone() is not None
                    for row in rows
                )

        conn.set_trace_callback(trace)
        _create_system_step(
            conn, execution_id=eid, root_task_id=get_execution(conn, eid).root_task_id,
            role="developer", continuation_key="test:atomic", criterion_id="runtime",
            logical_model_tier="normal",
        )
        assert not any(seen_orphan)
    finally:
        conn.set_trace_callback(None)
        observer.close()
        conn.close()


def test_completion_transition_rolls_back_if_continuation_cannot_be_materialized(tmp_path, monkeypatch):
    conn = kb.connect(tmp_path / "completion-crash-window.db")
    try:
        eid = _new(conn)
        step = list_execution_steps(conn, eid)[0]
        monkeypatch.setattr(
            "hermes_cli.execution_supervisor._create_system_step",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("simulated crash")),
        )
        with pytest.raises(RuntimeError, match="simulated crash"):
            _complete(conn, step, {"progress_only": True})
        assert get_execution(conn, eid).status is ExecutionStatus.RUNNING
        assert conn.execute(
            "SELECT COUNT(*) FROM execution_events WHERE execution_id=?", (eid,)
        ).fetchone()[0] == 0
        assert list_execution_steps(conn, eid)[0].status == "ready"
    finally:
        conn.close()


def test_failure_transition_rolls_back_with_continuation_creation(tmp_path, monkeypatch):
    conn = kb.connect(tmp_path / "failure-crash-window.db")
    try:
        eid = _new(conn)
        monkeypatch.setattr(
            "hermes_cli.execution_supervisor._create_system_step",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("simulated crash")),
        )
        with pytest.raises(RuntimeError, match="simulated crash"):
            record_failure(
                conn, eid, criterion_id="runtime", category="unit",
                failure_signature="crash-before-continuation",
            )
        assert get_execution(conn, eid).version == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM execution_attempts WHERE execution_id=?", (eid,)
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM execution_events WHERE execution_id=?", (eid,)
        ).fetchone()[0] == 0
        assert get_execution(conn, eid).lease_owner is None
    finally:
        conn.close()
