#!/usr/bin/env python3
"""Safe isolated SQLite canary for the Phase 2.2 autonomous workflow."""
from __future__ import annotations

import json
import sys
from pathlib import Path

# The script is intentionally runnable from the repository root without an
# installed package; this keeps the canary isolated from user/runtime state.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hermes_cli import kanban_db as kb
from hermes_cli.execution_supervisor import create_autonomous_execution, get_execution, list_execution_steps


def main() -> None:
    path = Path(".phase22-canary.sqlite")
    for candidate in (path, path.with_name(path.name + ".init.lock")):
        candidate.unlink(missing_ok=True)
    conn = kb.connect(path)
    try:
        root = kb.create_task(conn, title="isolated Phase 2.2 canary")
        execution_id = create_autonomous_execution(
            conn,
            root_task_id=root,
            criteria=[{"id": "runtime", "required_evidence": "ISOLATED_RUNTIME"}],
            requires_ops=True,
        )

        def complete(role: str, metadata: dict) -> None:
            step = next(s for s in list_execution_steps(conn, execution_id) if s.role == role and s.status == "ready")
            assert kb.claim_task(conn, step.task_id, claimer="canary")
            run_id = kb.get_task(conn, step.task_id).current_run_id
            assert kb.complete_task(conn, step.task_id, summary="isolated canary evidence", metadata=metadata, expected_run_id=run_id)

        complete("developer", {"evidence_by_criterion": {"runtime": {"result": "PASS", "level": "ISOLATED_RUNTIME"}}})
        complete("reviewer", {"review_verdict": "PASS"})
        complete("ops", {"ops_verdict": "PASS"})
        state = get_execution(conn, execution_id)
        rows = conn.execute("SELECT role, completed_run_id FROM execution_steps WHERE execution_id=? ORDER BY rowid", (execution_id,)).fetchall()
        print(json.dumps({"status": state.status.value, "root_status": kb.get_task(conn, root).status, "role_owned_runs": [dict(row) for row in rows], "events": [row[0] for row in conn.execute("SELECT decision FROM execution_events WHERE execution_id=? ORDER BY id", (execution_id,))]}, sort_keys=True))
    finally:
        conn.close()
        for candidate in (path, path.with_name(path.name + ".init.lock")):
            candidate.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
