"""Owner-lifecycle regression tests for terminal sandbox teardown."""

from tools import terminal_tool


def test_cleanup_all_waits_for_async_backend_before_registry_is_lost(
    monkeypatch, tmp_path
):
    """Process shutdown must wait for backend stop/remove to finish.

    ``cleanup_vm`` removes the environment from the global registry before it
    starts Docker's asynchronous cleanup.  The process-wide owner therefore
    has to retain the object and join that cleanup itself; a later atexit hook
    can no longer rediscover it in the registry.
    """

    events = []

    class AsyncEnvironment:
        def cleanup(self):
            events.append("cleanup-started")

        def wait_for_cleanup(self, timeout):
            events.append(("cleanup-finished", timeout))
            return True

    env = AsyncEnvironment()
    monkeypatch.setattr(terminal_tool, "_active_environments", {"task-red": env})
    monkeypatch.setattr(terminal_tool, "_last_activity", {"task-red": 0.0})
    monkeypatch.setattr(terminal_tool, "_get_scratch_dir", lambda: tmp_path)

    terminal_tool.cleanup_all_environments()

    assert events == ["cleanup-started", ("cleanup-finished", 15.0)]
    assert terminal_tool._active_environments == {}


def test_cleanup_vm_only_targets_requested_environment(monkeypatch):
    """Targeted cleanup must leave a concurrently active task untouched."""
    events = []

    class Environment:
        def __init__(self, name):
            self.name = name

        def cleanup(self):
            events.append(self.name)

    target = Environment("target")
    active = Environment("active")
    monkeypatch.setattr(
        terminal_tool,
        "_active_environments",
        {"target-task": target, "active-task": active},
    )
    monkeypatch.setattr(
        terminal_tool,
        "_last_activity",
        {"target-task": 0.0, "active-task": 0.0},
    )

    terminal_tool.cleanup_vm("target-task")

    assert events == ["target"]
    assert terminal_tool._active_environments == {"active-task": active}


def test_kanban_hard_exit_path_runs_terminal_owner_cleanup(monkeypatch):
    """Kanban's os._exit path must clean task terminals before hard exit."""
    import cli

    calls = []
    monkeypatch.setattr(cli, "_cleanup_all_terminals", lambda: calls.append("cleanup"))

    cli._cleanup_kanban_worker_terminals_before_hard_exit()

    assert calls == ["cleanup"]
