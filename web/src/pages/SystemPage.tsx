import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  Brain,
  Check,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Globe,
  HardDrive,
  KeyRound,
  Link2,
  Play,
  Plus,
  Power,
  RotateCw,
  Server,
  Share2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { HermesConsoleModal } from "@/components/HermesConsoleModal";
import { cn, themedBody } from "@/lib/utils";
import { api } from "@/lib/api";
import type {
  StatusResponse,
  MemoryStatus,
  MemoryProviderInfo,
  CredentialPoolProvider,
  CheckpointsResponse,
  HooksResponse,
  HookEntry,
  SystemStats,
  UpdateCheckResponse,
  CuratorStatus,
  PortalStatus,
  DebugShareResponse,
} from "@/lib/api";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч ${m} мин`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

type BackupImportTarget =
  | { kind: "upload"; file: File }
  | { kind: "path"; path: string };

function backupImportLabel(target: BackupImportTarget | null): string {
  if (!target) return "архивом";
  return target.kind === "upload" ? target.file.name : target.path;
}

function backupFileName(path: string | null): string {
  if (!path) return "Резервные копии ещё не создавались";
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Live action-log viewer for the spawn-based admin actions (doctor, audit,
 * backup, import, skills update, checkpoints prune, gateway start/stop).
 * Polls /api/actions/<name>/status until the process exits.
 */
function ActionLogViewer({
  action,
  onClose,
  onComplete,
}: {
  action: string;
  onClose: () => void;
  onComplete?: (action: string, exitCode: number | null) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completeRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    completeRef.current = false;
    const poll = async () => {
      try {
        const st = await api.getActionStatus(action, 400);
        if (cancelled) return;
        setLines(st.lines);
        setRunning(st.running);
        setExitCode(st.exit_code);
        if (!st.running && !completeRef.current) {
          completeRef.current = true;
          onComplete?.(action, st.exit_code);
        }
        if (st.running) timer.current = setTimeout(poll, 1200);
      } catch {
        if (!cancelled) setRunning(false);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [action, onComplete]);

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-sm">{action}</span>
            {running ? (
              <Badge tone="warning">выполняется</Badge>
            ) : (
              <Badge tone={exitCode === 0 ? "success" : "destructive"}>
                {exitCode === 0 ? "готово" : `код выхода ${exitCode}`}
              </Badge>
            )}
          </div>
          <Button ghost size="icon" onClick={onClose} aria-label="Закрыть журнал">
            <X />
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-background/50 border border-border p-3 text-xs font-mono text-muted-foreground">
          {lines.length ? lines.join("\n") : "Запуск…"}
        </pre>
      </CardContent>
    </Card>
  );
}

const HOOK_EVENTS_FALLBACK = [
  "pre_tool_call",
  "post_tool_call",
  "pre_llm_call",
  "post_llm_call",
  "on_session_start",
  "on_session_end",
];

const MEMORY_STATUS_LABEL: Record<MemoryProviderInfo["status"], string> = {
  ready: "готов",
  needs_config: "требуется настройка",
  unavailable: "недоступен",
  missing: "не установлен",
};

const MEMORY_STATUS_TONE: Record<
  MemoryProviderInfo["status"],
  "success" | "warning" | "destructive" | "secondary"
> = {
  ready: "success",
  needs_config: "warning",
  unavailable: "destructive",
  missing: "destructive",
};

export default function SystemPage() {
  const { toast, showToast } = useToast();

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [pool, setPool] = useState<CredentialPoolProvider[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointsResponse | null>(
    null,
  );
  const [hooks, setHooks] = useState<HooksResponse | null>(null);
  const [curator, setCurator] = useState<CuratorStatus | null>(null);
  const [portal, setPortal] = useState<PortalStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);

  // Add-credential form.
  const [credProvider, setCredProvider] = useState("openrouter");
  const [credKey, setCredKey] = useState("");
  const [credLabel, setCredLabel] = useState("");
  const [addingCred, setAddingCred] = useState(false);

  const [pendingBackupArchive, setPendingBackupArchive] = useState<string | null>(
    null,
  );
  const [downloadableBackupArchive, setDownloadableBackupArchive] = useState<
    string | null
  >(null);
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const importUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPath, setImportPath] = useState("");
  // Restore-from-backup is destructive (overwrites the live config) and the
  // spawned `hermes import` runs non-interactively (stdin is /dev/null), so
  // its CLI "Continue? [y/N]" prompt would auto-abort. The dashboard owns the
  // consent: confirm here, then call the endpoint with force=true.
  const [importingBackup, setImportingBackup] = useState(false);
  const [importConfirmTarget, setImportConfirmTarget] =
    useState<BackupImportTarget | null>(null);

  // Create-hook modal.
  const [hookModalOpen, setHookModalOpen] = useState(false);
  const closeHookModal = useCallback(() => setHookModalOpen(false), []);
  const hookModalRef = useModalBehavior({
    open: hookModalOpen,
    onClose: closeHookModal,
  });
  const [hookEvent, setHookEvent] = useState("pre_tool_call");
  const [hookCommand, setHookCommand] = useState("");
  const [hookMatcher, setHookMatcher] = useState("");
  const [hookTimeout, setHookTimeout] = useState("");
  const [hookApprove, setHookApprove] = useState(true);
  const [creatingHook, setCreatingHook] = useState(false);

  // ── Update check ───────────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(
    null,
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);

  const loadAll = useCallback(() => {
    Promise.allSettled([
      api.getStatus(),
      api.getSystemStats(),
      api.getMemory(),
      api.getCredentialPool(),
      api.getCheckpoints(),
      api.getHooks(),
      api.getCurator(),
      api.getPortal(),
      // Cached (non-forced) check so the version row shows update status on
      // load without a separate effect / a forced network round-trip.
      api.checkHermesUpdate(false),
    ])
      .then(([s, st, m, p, c, h, cur, prt, upd]) => {
        if (s.status === "fulfilled") setStatus(s.value);
        if (st.status === "fulfilled") setStats(st.value);
        if (m.status === "fulfilled") setMemory(m.value);
        if (p.status === "fulfilled") setPool(p.value.providers);
        if (c.status === "fulfilled") setCheckpoints(c.value);
        if (h.status === "fulfilled") setHooks(h.value);
        if (cur.status === "fulfilled") setCurator(cur.value);
        if (prt.status === "fulfilled") setPortal(prt.value);
        if (upd.status === "fulfilled") setUpdateInfo(upd.value);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ── Gateway lifecycle ──────────────────────────────────────────────
  const runGateway = async (verb: "start" | "stop" | "restart") => {
    try {
      if (verb === "start") {
        await api.startGateway();
        setActiveAction("gateway-start");
      } else if (verb === "stop") {
        await api.stopGateway();
        setActiveAction("gateway-stop");
      } else {
        await api.restartGateway();
        setActiveAction("gateway-restart");
      }
      showToast(`Команда шлюза «${verb}» запущена`, "success");
      setTimeout(loadAll, 3000);
    } catch (e) {
      showToast(`Не удалось выполнить команду шлюза «${verb}»: ${e}`, "error");
    }
  };

  // ── Curator ────────────────────────────────────────────────────────
  const toggleCuratorPaused = async () => {
    if (!curator) return;
    try {
      await api.setCuratorPaused(!curator.paused);
      showToast(curator.paused ? "Куратор возобновлён" : "Куратор приостановлен", "success");
      loadAll();
    } catch (e) {
      showToast(`Не удалось изменить состояние куратора: ${e}`, "error");
    }
  };

  // ── Memory ─────────────────────────────────────────────────────────
  // Memory provider selection lives on the /plugins page now (see the
  // read-only display + link below); the dropdown was intentionally
  // dropped from this card during the admin-panel refresh.
  const memoryReset = useConfirmDelete({
    onDelete: useCallback(
      async (target: string) => {
        try {
          const res = await api.resetMemory(
            target as "all" | "memory" | "user",
          );
          showToast(`Сброшено: ${res.deleted.join(", ") || "ничего"}`, "success");
          loadAll();
        } catch (e) {
          showToast(`Не удалось выполнить сброс: ${e}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  // ── Credential pool ────────────────────────────────────────────────
  const addCredential = async () => {
    if (!credProvider.trim() || !credKey.trim()) {
      showToast("Укажите провайдера и API-ключ", "error");
      return;
    }
    setAddingCred(true);
    try {
      await api.addCredentialPoolEntry(
        credProvider.trim(),
        credKey.trim(),
        credLabel.trim() || undefined,
      );
      showToast("Учётные данные добавлены", "success");
      setCredKey("");
      setCredLabel("");
      loadAll();
    } catch (e) {
      showToast(`Не удалось добавить учётные данные: ${e}`, "error");
    } finally {
      setAddingCred(false);
    }
  };

  const credDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const [provider, idxStr] = key.split("|");
        try {
          await api.removeCredentialPoolEntry(provider, Number(idxStr));
          showToast("Учётные данные удалены", "success");
          loadAll();
        } catch (e) {
          showToast(`Не удалось удалить: ${e}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  // ── Operations ─────────────────────────────────────────────────────
  const runOp = async (fn: () => Promise<{ name: string }>, label: string) => {
    try {
      const res = await fn();
      setActiveAction(res.name);
      showToast(`${label}: запущено`, "success");
    } catch (e) {
      showToast(`${label}: ошибка — ${e}`, "error");
    }
  };

  const runDashboardBackup = async () => {
    try {
      const res = await api.runBackup();
      setActiveAction(res.name);
      setPendingBackupArchive(res.archive ?? null);
      setDownloadableBackupArchive(null);
      showToast("Резервное копирование запущено", "success");
    } catch (e) {
      showToast(`Не удалось создать резервную копию: ${e}`, "error");
    }
  };

  const handleActionComplete = useCallback(
    (action: string, exitCode: number | null) => {
      if (action === "backup" && pendingBackupArchive) {
        if (exitCode === 0) {
          setDownloadableBackupArchive(pendingBackupArchive);
          showToast("Резервная копия готова к скачиванию", "success");
        } else {
          setPendingBackupArchive(null);
        }
      }
    },
    [pendingBackupArchive, showToast],
  );

  const downloadBackup = async () => {
    const archive = downloadableBackupArchive;
    if (!archive) return;
    setDownloadingBackup(true);
    try {
      const res = await api.downloadBackup(archive);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFileName(archive);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(`Не удалось скачать: ${e}`, "error");
    } finally {
      setDownloadingBackup(false);
    }
  };

  const clearImportFile = () => {
    setImportFile(null);
    if (importUploadInputRef.current) importUploadInputRef.current.value = "";
  };

  const runBackupImport = async (target: BackupImportTarget) => {
    setImportingBackup(true);
    try {
      const res =
        target.kind === "upload"
          ? await api.runImportUpload(target.file, true)
          : await api.runImport(target.path, true);
      setActiveAction(res.name);
      showToast("Импорт запущен", "success");
      if (target.kind === "upload") clearImportFile();
    } catch (e) {
      showToast(`Не удалось импортировать: ${e}`, "error");
    } finally {
      setImportingBackup(false);
    }
  };

  // ── Debug share ────────────────────────────────────────────────────
  // Unlike the fire-and-forget ops above, `debug share` produces shareable
  // paste URLs that are the whole point — so we surface them as real,
  // copyable links rather than a log tail.
  const [shareRedact, setShareRedact] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<DebugShareResponse | null>(
    null,
  );
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedLabel(label);
        setTimeout(
          () => setCopiedLabel((cur) => (cur === label ? null : cur)),
          1500,
        );
      } catch {
        showToast("Не удалось скопировать в буфер обмена", "error");
      }
    },
    [showToast],
  );

  const runDebugShare = useCallback(async () => {
    setSharing(true);
    setShareResult(null);
    try {
      const res = await api.runDebugShare({ redact: shareRedact });
      setShareResult(res);
      const n = Object.keys(res.urls).length;
      showToast(
        `Uploaded ${n} paste${n === 1 ? "" : "s"}${
          res.redacted ? " (redacted)" : ""
        }`,
        "success",
      );
    } catch (e) {
      showToast(`Не удалось поделиться отладочными данными: ${e}`, "error");
    } finally {
      setSharing(false);
    }
  }, [shareRedact, showToast]);


  // ── Update check / apply ───────────────────────────────────────────
  const checkForUpdate = useCallback(
    async (force = false) => {
      if (status?.can_update_hermes === false) return;
      setCheckingUpdate(true);
      try {
        const info = await api.checkHermesUpdate(force);
        setUpdateInfo(info);
        if (force) {
          if (info.update_available) {
            showToast(
              info.behind && info.behind > 0
                ? `Доступно обновление — отставание на ${info.behind} комм.`
                : "Доступно обновление",
              "success",
            );
          } else if (info.behind === 0) {
            showToast("Установлена последняя версия", "success");
          } else if (info.message) {
            showToast(info.message, "error");
          }
        }
      } catch (e) {
        showToast(`Не удалось проверить обновления: ${e}`, "error");
      } finally {
        setCheckingUpdate(false);
      }
    },
    [showToast, status?.can_update_hermes],
  );

  // Auto-check (cached) runs inside loadAll on mount; this is the
  // user-triggered forced re-check from the "Check for updates" button.
  const applyUpdate = async () => {
    setUpdateConfirmOpen(false);
    if (status?.can_update_hermes === false) {
      showToast(
        "Обновления Hermes управляются вне этой панели.",
        "success",
      );
      return;
    }
    try {
      const resp = await api.updateHermes();
      if (!resp.ok) {
        showToast(
          resp.message ??
            "Обновления нельзя установить из этой панели.",
          "success",
        );
        return;
      }
      setActiveAction(resp.name ?? "hermes-update");
      showToast("Обновление запущено", "success");
    } catch (e) {
      showToast(`Не удалось обновить: ${e}`, "error");
    }
  };

  const checkpointsPrune = useConfirmDelete({
    onDelete: useCallback(async () => {
      try {
        const res = await api.pruneCheckpoints();
        setActiveAction(res.name);
        showToast("Очистка контрольных точек запущена", "success");
      } catch (e) {
        showToast(`Не удалось очистить: ${e}`, "error");
        throw e;
      }
    }, [showToast]),
  });

  // ── Hooks ──────────────────────────────────────────────────────────
  const createHook = async () => {
    if (!hookCommand.trim()) {
      showToast("Укажите команду", "error");
      return;
    }
    setCreatingHook(true);
    try {
      await api.createHook({
        event: hookEvent,
        command: hookCommand.trim(),
        matcher: hookMatcher.trim() || undefined,
        timeout: hookTimeout.trim() ? Number(hookTimeout) : undefined,
        approve: hookApprove,
      });
      showToast("Хук создан", "success");
      setHookCommand("");
      setHookMatcher("");
      setHookTimeout("");
      setHookModalOpen(false);
      loadAll();
    } catch (e) {
      showToast(`Не удалось создать хук: ${e}`, "error");
    } finally {
      setCreatingHook(false);
    }
  };

  const hookDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const sep = key.indexOf("|");
        const event = key.slice(0, sep);
        const command = key.slice(sep + 1);
        try {
          await api.deleteHook(event, command);
          showToast("Хук удалён", "success");
          loadAll();
        } catch (e) {
          showToast(`Не удалось удалить хук: ${e}`, "error");
          throw e;
        }
      },
      [loadAll, showToast],
    ),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const gatewayRunning = status?.gateway_running;
  const canUpdateHermes = status?.can_update_hermes !== false;
  const activeMemoryProvider = memory?.active
    ? memory.providers.find((provider) => provider.name === memory.active)
    : null;
  const validEvents = hooks?.valid_events?.length
    ? hooks.valid_events
    : HOOK_EVENTS_FALLBACK;

  return (
    <div className="flex flex-col gap-8">
      <Toast toast={toast} />
      <input
        ref={importUploadInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(event) => {
          setImportFile(event.currentTarget.files?.[0] ?? null);
        }}
      />

      <ConfirmDialog
        open={canUpdateHermes && updateConfirmOpen}
        onCancel={() => setUpdateConfirmOpen(false)}
        onConfirm={() => void applyUpdate()}
        title="Обновить Hermes?"
        description={
          updateInfo && updateInfo.behind && updateInfo.behind > 0
            ? `Будет выполнена команда 'hermes update' (${updateInfo.update_command}) и загружено новых коммитов: ${updateInfo.behind}. После обновления шлюз перезапустится; до этого текущая сессия сохранит кеш промпта.`
            : `Будет выполнена команда 'hermes update' (${updateInfo?.update_command ?? "hermes update"}), после чего шлюз перезапустится.`
        }
        confirmLabel="Обновить сейчас"
      />

      <DeleteConfirmDialog
        open={memoryReset.isOpen}
        onCancel={memoryReset.cancel}
        onConfirm={memoryReset.confirm}
        title="Сбросить память"
        description="Выбранные встроенные файлы памяти будут удалены без возможности восстановления."
        loading={memoryReset.isDeleting}
      />
      <DeleteConfirmDialog
        open={credDelete.isOpen}
        onCancel={credDelete.cancel}
        onConfirm={credDelete.confirm}
        title="Удалить учётные данные"
        description="Удалить этот API-ключ из пула? Агент больше не будет использовать его при ротации."
        loading={credDelete.isDeleting}
      />
      <DeleteConfirmDialog
        open={checkpointsPrune.isOpen}
        onCancel={checkpointsPrune.cancel}
        onConfirm={checkpointsPrune.confirm}
        title="Очистить контрольные точки"
        description="Удалить теневое хранилище контрольных точек отката? Существующие точки /rollback будут потеряны."
        loading={checkpointsPrune.isDeleting}
      />
      <DeleteConfirmDialog
        open={hookDelete.isOpen}
        onCancel={hookDelete.cancel}
        onConfirm={hookDelete.confirm}
        title="Удалить shell-хук"
        description="Удалить этот хук из конфигурации и отозвать разрешение? После следующего перезапуска он перестанет срабатывать."
        loading={hookDelete.isDeleting}
      />
      <HermesConsoleModal
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
      />

      {/* Create-hook modal */}
      {hookModalOpen && (
        <div
          ref={hookModalRef}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 p-4"
          onClick={(e) => e.target === e.currentTarget && setHookModalOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className={cn(themedBody, "relative w-full max-w-lg border border-border bg-card shadow-2xl flex flex-col")}>
            <Button
              ghost
              size="icon"
              onClick={() => setHookModalOpen(false)}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="Закрыть"
            >
              <X />
            </Button>
            <header className="p-5 pb-3 border-b border-border">
              <h2 className="font-mondwest text-display text-base tracking-wider">
                Новый shell-хук
              </h2>
            </header>
            <div className="p-5 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="hook-event">Событие</Label>
                <Select
                  id="hook-event"
                  value={hookEvent}
                  onValueChange={(v) => setHookEvent(v)}
                >
                  {validEvents.map((ev) => (
                    <SelectOption key={ev} value={ev}>
                      {ev}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="hook-command">Команда (абсолютный путь)</Label>
                <Input
                  id="hook-command"
                  autoFocus
                  placeholder="/usr/local/bin/my-hook.sh"
                  value={hookCommand}
                  onChange={(e) => setHookCommand(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="hook-matcher">Условие (необязательно)</Label>
                  <Input
                    id="hook-matcher"
                    placeholder="например, terminal"
                    value={hookMatcher}
                    onChange={(e) => setHookMatcher(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="hook-timeout">Тайм-аут (с)</Label>
                  <Input
                    id="hook-timeout"
                    placeholder="10"
                    value={hookTimeout}
                    onChange={(e) => setHookTimeout(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <Checkbox
                  checked={hookApprove}
                  id="hook-approve"
                  onCheckedChange={(checked) => setHookApprove(checked === true)}
                />

                <Label
                  className="cursor-pointer text-sm font-normal normal-case tracking-normal text-muted-foreground"
                  htmlFor="hook-approve"
                >
                  Разрешить сейчас (дать согласие на запуск; иначе хук останется
                  настроенным, но неактивным)
                </Label>
              </div>
              <p className="text-xs text-warning">
                Shell-хуки выполняют произвольные команды на этом хосте.
                Добавляйте только доверенные скрипты. Изменения вступят в силу
                после следующего перезапуска шлюза или сессии.
              </p>
              <div className="flex justify-end">
                <Button
                  className="uppercase"
                  size="sm"
                  onClick={createHook}
                  disabled={creatingHook}
                  prefix={creatingHook ? <Spinner /> : undefined}
                >
                  {creatingHook ? "Создание" : "Создать хук"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live action log */}
      {activeAction && (
        <ActionLogViewer
          action={activeAction}
          onComplete={handleActionComplete}
          onClose={() => setActiveAction(null)}
        />
      )}

      {/* ── Host / system stats ───────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Server className="h-4 w-4" /> Хост
        </H2>
        <Card>
          <CardContent className="py-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-6 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">ОС</div>
                <div>{stats?.os} {stats?.os_release}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Архитектура</div>
                <div>{stats?.arch}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Хост</div>
                <div className="truncate">{stats?.hostname}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Python</div>
                <div>{stats?.python_impl} {stats?.python_version}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Hermes</div>
                <div className="flex items-center gap-2">
                  <span>v{stats?.hermes_version}</span>
                  {canUpdateHermes &&
                    updateInfo &&
                    (updateInfo.update_available ? (
                      <Badge tone="warning">
                        {updateInfo.behind && updateInfo.behind > 0
                          ? `Отставание: ${updateInfo.behind}`
                          : "доступно обновление"}
                      </Badge>
                    ) : updateInfo.behind === 0 ? (
                      <Badge tone="success">последняя</Badge>
                    ) : null)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3" /> ЦП
                </div>
                <div>
                  Ядер: {stats?.cpu_count ?? "—"}
                  {typeof stats?.cpu_percent === "number"
                    ? ` · ${stats.cpu_percent.toFixed(0)}%`
                    : ""}
                </div>
              </div>
              {stats?.memory && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Память</div>
                  <div>
                    {formatBytes(stats.memory.used)} / {formatBytes(stats.memory.total)} ({stats.memory.percent}%)
                  </div>
                </div>
              )}
              {stats?.disk && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <HardDrive className="h-3 w-3" /> Диск
                  </div>
                  <div>
                    {formatBytes(stats.disk.used)} / {formatBytes(stats.disk.total)} ({stats.disk.percent}%)
                  </div>
                </div>
              )}
              {typeof stats?.uptime_seconds === "number" && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Время работы</div>
                  <div>{formatDuration(stats.uptime_seconds)}</div>
                </div>
              )}
              {stats?.load_avg && stats.load_avg.length >= 3 && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Средняя нагрузка</div>
                  <div>{stats.load_avg.map((n) => n.toFixed(2)).join(" / ")}</div>
                </div>
              )}
            </div>
            {stats && !stats.psutil && (
              <p className="mt-3 text-xs text-muted-foreground">
                Установите дополнительный пакет{" "}
                <span className="font-mono">psutil</span>, чтобы видеть метрики
                процессора, памяти и диска.
              </p>
            )}
            {canUpdateHermes && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                <Button
                  size="sm"
                  ghost
                  disabled={checkingUpdate}
                  prefix={
                    checkingUpdate ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={() => void checkForUpdate(true)}
                >
                  Проверить обновления
                </Button>
                {updateInfo?.update_available && updateInfo.can_apply && (
                  <Button
                    size="sm"
                    prefix={<Download className="h-3.5 w-3.5" />}
                    onClick={() => setUpdateConfirmOpen(true)}
                  >
                    Обновить сейчас
                  </Button>
                )}
                {updateInfo &&
                  !updateInfo.can_apply &&
                  updateInfo.update_available && (
                    <span className="text-xs text-muted-foreground">
                      Обновить командой{" "}
                      <span className="font-mono">{updateInfo.update_command}</span>
                    </span>
                  )}
                {updateInfo?.message && !updateInfo.update_available && (
                  <span className="text-xs text-muted-foreground">
                    {updateInfo.message}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Portal ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Globe className="h-4 w-4" /> Nous Portal
        </H2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex items-center gap-3">
              <Badge tone={portal?.logged_in ? "success" : "secondary"}>
                {portal?.logged_in ? "выполнен вход" : "вход не выполнен"}
              </Badge>
              {portal?.provider && (
                <span className="text-sm text-muted-foreground">
                  провайдер инференса: {portal.provider}
                </span>
              )}
              <a
                href={portal?.subscription_url || "https://portal.nousresearch.com/manage-subscription"}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-primary underline"
              >
                Управление подпиской
              </a>
            </div>
            {portal?.features && portal.features.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Маршрутизация Tool Gateway
                </span>
                {portal.features.map((f) => (
                  <div key={f.label} className="flex items-center justify-between text-sm">
                    <span>{f.label}</span>
                    <span className="text-muted-foreground">{f.state}</span>
                  </div>
                ))}
              </div>
            )}
            {!portal?.logged_in && (
              <p className="text-xs text-muted-foreground">
                Войдите с помощью <span className="font-mono">hermes portal</span>.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Curator ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Sparkles className="h-4 w-4" /> Куратор навыков
        </H2>
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Badge tone={curator?.paused ? "warning" : curator?.enabled ? "success" : "secondary"}>
                {curator?.paused ? "приостановлен" : curator?.enabled ? "активен" : "отключён"}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {curator?.interval_hours ? `каждые ${curator.interval_hours} ч` : ""}
                {curator?.last_run_at ? ` · последний запуск ${new Date(curator.last_run_at).toLocaleString()}` : " · ещё не запускался"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" ghost onClick={toggleCuratorPaused}>
                {curator?.paused ? "Возобновить" : "Приостановить"}
              </Button>
              <Button
                size="sm"
                ghost
                prefix={<Play className="h-3.5 w-3.5" />}
                onClick={() => runOp(api.runCurator, "Проверка куратора")}
              >
                Запустить сейчас
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Gateway ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Power className="h-4 w-4" /> Шлюз
        </H2>
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Badge tone={gatewayRunning ? "success" : "secondary"}>
                {gatewayRunning ? "работает" : "остановлен"}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {status?.gateway_state ?? "—"}
                {status?.gateway_pid ? ` · pid ${status.gateway_pid}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="uppercase"
                onClick={() => runGateway("start")}
                disabled={gatewayRunning}
                prefix={<Play className="h-3.5 w-3.5" />}
              >
                Запустить
              </Button>
              <Button
                size="sm"
                className="uppercase"
                onClick={() => runGateway("restart")}
                prefix={<RotateCw className="h-3.5 w-3.5" />}
              >
                Перезапустить
              </Button>
              <Button
                size="sm"
                className="uppercase text-warning"
                ghost
                onClick={() => runGateway("stop")}
                disabled={!gatewayRunning}
                prefix={<Power className="h-3.5 w-3.5" />}
              >
                Остановить
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Memory ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Brain className="h-4 w-4" /> Память
        </H2>
        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                Внешний провайдер:{" "}
                <span className="font-mono text-foreground">
                  {memory?.active || "только встроенная память"}
                </span>
              </span>
              {activeMemoryProvider && (
                <Badge tone={MEMORY_STATUS_TONE[activeMemoryProvider.status]}>
                  {MEMORY_STATUS_LABEL[activeMemoryProvider.status]}
                </Badge>
              )}
              <Link to="/plugins" className="underline">
                Изменить в разделе «Плагины» →
              </Link>
              <span className="ml-auto">
                Настройка провайдера:{" "}
                <Link to="/plugins" className="underline">
                  настроить в разделе «Плагины»
                </Link>
              </span>
            </div>

            {activeMemoryProvider?.status === "missing" && (
              <p className="border border-destructive/50 px-3 py-2 text-xs text-destructive">
                Настроенный провайдер больше не установлен. Переключитесь на
                встроенную память или настройте другой провайдер в разделе
                «Плагины».
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                Встроенные файлы — MEMORY.md:{" "}
                {formatBytes(memory?.builtin_files.memory ?? 0)} · USER.md:{" "}
                {formatBytes(memory?.builtin_files.user ?? 0)}
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button size="sm" ghost className="text-destructive" onClick={() => memoryReset.requestDelete("memory")}>
                  Сбросить MEMORY.md
                </Button>
                <Button size="sm" ghost className="text-destructive" onClick={() => memoryReset.requestDelete("user")}>
                  Сбросить USER.md
                </Button>
                <Button size="sm" ghost className="text-destructive" onClick={() => memoryReset.requestDelete("all")}>
                  Сбросить всё
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Credential pool ───────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <KeyRound className="h-4 w-4" /> Пул учётных данных
        </H2>
        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div className="grid gap-2">
                <Label htmlFor="cred-provider">Провайдер</Label>
                <Input id="cred-provider" value={credProvider} onChange={(e) => setCredProvider(e.target.value)} placeholder="openrouter" />
              </div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="cred-key">API-ключ</Label>
                <Input id="cred-key" type="password" value={credKey} onChange={(e) => setCredKey(e.target.value)} placeholder="sk-…" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cred-label">Метка</Label>
                <Input id="cred-label" value={credLabel} onChange={(e) => setCredLabel(e.target.value)} placeholder="необязательно" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" className="uppercase" onClick={addCredential} disabled={addingCred} prefix={addingCred ? <Spinner /> : undefined}>
                Добавить ключ
              </Button>
            </div>
            {pool.length === 0 && (
              <p className="text-sm text-muted-foreground">
                В пуле нет учётных данных. Добавьте ключ выше, чтобы включить
                ротацию ключей.
              </p>
            )}
            {pool.map((prov) => (
              <div key={prov.provider} className="flex flex-col gap-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  {prov.provider}
                </span>
                {prov.entries.map((entry) => (
                  <div key={`${prov.provider}-${entry.index}`} className="flex items-center gap-3 border border-border bg-background/40 px-3 py-2">
                    <span className="text-sm font-medium">{entry.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{entry.token_preview}</span>
                    <Badge tone="outline">{entry.auth_type}</Badge>
                    {entry.last_status && <Badge tone="secondary">{entry.last_status}</Badge>}
                    <Button ghost size="icon" className="ml-auto text-destructive" aria-label="Удалить учётные данные" onClick={() => credDelete.requestDelete(`${prov.provider}|${entry.index}`)}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      {/* ── Operations ────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Activity className="h-4 w-4" /> Операции
        </H2>
        <Card>
          <CardContent className="flex flex-wrap gap-2 py-4">
            <Button size="sm" ghost prefix={<Terminal className="h-3.5 w-3.5" />} onClick={() => setConsoleOpen(true)}>
              Открыть консоль
            </Button>
            <Button size="sm" ghost prefix={<Stethoscope className="h-3.5 w-3.5" />} onClick={() => runOp(api.runDoctor, "Диагностика")}>
              Запустить диагностику
            </Button>
            <Button size="sm" ghost prefix={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => runOp(api.runSecurityAudit, "Аудит безопасности")}>
              Аудит безопасности
            </Button>
            <Button size="sm" ghost prefix={<RotateCw className="h-3.5 w-3.5" />} onClick={() => runOp(api.updateSkillsFromHub, "Обновление навыков")}>
              Обновить навыки
            </Button>
            <Button size="sm" ghost prefix={<Activity className="h-3.5 w-3.5" />} onClick={() => runOp(api.runPromptSize, "Размер промпта")}>
              Размер промпта
            </Button>
            <Button size="sm" ghost prefix={<Database className="h-3.5 w-3.5" />} onClick={() => runOp(api.runDump, "Диагностический дамп")}>
              Диагностический дамп
            </Button>
            <Button size="sm" ghost prefix={<RotateCw className="h-3.5 w-3.5" />} onClick={() => runOp(api.runConfigMigrate, "Миграция конфигурации")}>
              Перенести конфигурацию
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="grid min-w-0 flex-1 gap-2">
                <Label>Полная резервная копия</Label>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Button
                    size="sm"
                    ghost
                    prefix={<Database className="h-3.5 w-3.5" />}
                    onClick={() => void runDashboardBackup()}
                  >
                    Создать резервную копию
                  </Button>
                  <Button
                    size="sm"
                    ghost
                    disabled={!downloadableBackupArchive || downloadingBackup}
                    prefix={
                      downloadingBackup ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )
                    }
                    onClick={() => void downloadBackup()}
                  >
                    Скачать резервную копию
                  </Button>
                  <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={pendingBackupArchive ?? "Резервные копии ещё не создавались"}
                  >
                    {backupFileName(pendingBackupArchive)}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end">
              <div className="grid min-w-0 flex-1 gap-2">
                <Label>Восстановление из загруженной копии</Label>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    size="sm"
                    ghost
                    disabled={importingBackup}
                    prefix={<Upload className="h-3.5 w-3.5" />}
                    onClick={() => importUploadInputRef.current?.click()}
                  >
                    Выбрать ZIP для восстановления
                  </Button>
                  <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={importFile?.name ?? "Архив резервной копии не выбран"}
                  >
                    {importFile?.name ?? "Архив резервной копии не выбран"}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                ghost
                disabled={!importFile || importingBackup}
                prefix={importingBackup ? <Spinner /> : undefined}
                onClick={() => {
                  if (!importFile) return;
                  setImportConfirmTarget({ kind: "upload", file: importFile });
                }}
              >
                Восстановить из файла
              </Button>
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end">
              <div className="grid min-w-0 flex-1 gap-2">
                <Label htmlFor="import-path">Восстановление по пути к резервной копии</Label>
                <Input
                  id="import-path"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  placeholder="$HERMES_HOME/backups/hermes-backup.zip"
                />
              </div>
              <Button
                size="sm"
                ghost
                disabled={!importPath.trim() || importingBackup}
                prefix={importingBackup ? <Spinner /> : undefined}
                onClick={() => {
                  const path = importPath.trim();
                  if (!path) return;
                  setImportConfirmTarget({ kind: "path", path });
                }}
              >
                Восстановить по пути
              </Button>
            </div>
            <ConfirmDialog
              open={!!importConfirmTarget}
              title="Восстановить полную резервную копию Hermes?"
              description={`Текущая конфигурация Hermes, навыки, сессии и данные будут перезаписаны содержимым ${backupImportLabel(importConfirmTarget)}. Это действие нельзя отменить.`}
              destructive
              confirmLabel="Восстановить"
              cancelLabel="Отмена"
              onCancel={() => setImportConfirmTarget(null)}
              onConfirm={() => {
                const target = importConfirmTarget;
                setImportConfirmTarget(null);
                if (target) void runBackupImport(target);
              }}
            />
          </CardContent>
        </Card>

        {/* Debug share — uploads a redacted report + logs, returns shareable
            links. Separated from the buttons above because its output is
            persistent, copyable URLs, not a fire-and-forget log tail. */}
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-2">
                <Share2 className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">Поделиться отладочным отчётом</span>
                  <span className="text-xs text-muted-foreground max-w-prose">
                    Загружает сведения о системе и журналы в общедоступный
                    сервис вставок и возвращает ссылки для команды Hermes.
                    Вставки автоматически удаляются через 6 часов.
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                disabled={sharing}
                prefix={
                  sharing ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <Share2 className="h-3.5 w-3.5" />
                  )
                }
                onClick={() => void runDebugShare()}
              >
                {sharing ? "Загрузка…" : "Создать ссылку"}
              </Button>
            </div>

            <div className="flex items-center gap-2.5">
              <Checkbox
                checked={shareRedact}
                disabled={sharing}
                id="share-redact"
                onCheckedChange={(checked) => setShareRedact(checked === true)}
              />

              <Label
                className="cursor-pointer select-none text-xs font-normal normal-case tracking-normal text-muted-foreground"
                htmlFor="share-redact"
              >
                Скрыть похожие на учётные данные токены перед загрузкой
                (рекомендуется)
              </Label>
            </div>

            {shareResult && (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge tone="success">загружен</Badge>
                    {shareResult.redacted ? (
                      <Badge tone="outline">скрыты данные</Badge>
                    ) : (
                      <Badge tone="warning">данные не скрыты</Badge>
                    )}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      удалится через{" "}
                      {Math.round(shareResult.auto_delete_seconds / 3600)} ч
                    </span>
                  </div>
                  {Object.keys(shareResult.urls).length > 1 && (
                    <Button
                      size="sm"
                      ghost
                      prefix={
                        copiedLabel === "__all__" ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )
                      }
                      onClick={() =>
                        void copyToClipboard(
                          Object.entries(shareResult.urls)
                            .map(([label, url]) => `${label}: ${url}`)
                            .join("\n"),
                          "__all__",
                        )
                      }
                    >
                      Копировать все
                    </Button>
                  )}
                </div>

                {Object.entries(shareResult.urls).map(([label, url]) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 bg-background/50 border border-border px-3 py-2"
                  >
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-mono text-xs shrink-0 w-24 truncate text-muted-foreground">
                      {label}
                    </span>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs truncate flex-1 text-primary hover:underline"
                    >
                      {url}
                    </a>
                    <Button
                      ghost
                      size="icon"
                      aria-label={`Копировать ссылку ${label}`}
                      onClick={() => void copyToClipboard(url, label)}
                    >
                      {copiedLabel === label ? <Check /> : <Copy />}
                    </Button>
                  </div>
                ))}

                {shareResult.failures.length > 0 && (
                  <span className="text-xs text-destructive">
                    Не удалось загрузить некоторые журналы:{" "}
                    {shareResult.failures.join("; ")}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Checkpoints ───────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
          <Database className="h-4 w-4" /> Контрольные точки
        </H2>
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <span className="text-sm text-muted-foreground">
              Сессий: {checkpoints?.sessions.length ?? 0} ·{" "}
              {formatBytes(checkpoints?.total_bytes ?? 0)}
            </span>
            <Button size="sm" ghost className="text-destructive" disabled={!checkpoints?.sessions.length} prefix={<Trash2 className="h-3.5 w-3.5" />} onClick={() => checkpointsPrune.requestDelete("all")}>
              Очистить
            </Button>
          </CardContent>
        </Card>
      </section>

      {/* ── Shell hooks ───────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <H2 variant="sm" className="flex items-center gap-2 text-muted-foreground">
            <Terminal className="h-4 w-4" /> Shell-хуки
          </H2>
          <Button size="sm" className="uppercase" prefix={<Plus className="h-3.5 w-3.5" />} onClick={() => setHookModalOpen(true)}>
            Новый хук
          </Button>
        </div>
        {(!hooks || hooks.hooks.length === 0) && (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              Shell-хуки не настроены.
            </CardContent>
          </Card>
        )}
        {hooks?.hooks.map((h: HookEntry, i) => (
          <Card key={`${h.event}-${i}`}>
            <CardContent className="flex items-center gap-3 py-3">
              <Badge tone="outline">{h.event}</Badge>
              {h.matcher && (
                <span className="text-xs text-muted-foreground">условие: {h.matcher}</span>
              )}
              <span className="font-mono text-xs truncate flex-1">{h.command}</span>
              {h.executable === false && (
                <Badge tone="destructive">не исполняемый</Badge>
              )}
              <Badge tone={h.allowed ? "success" : "warning"}>
                {h.allowed ? "разрешён" : "не разрешён"}
              </Badge>
              <Button
                ghost
                size="icon"
                className="text-destructive"
                aria-label="Удалить хук"
                onClick={() =>
                  hookDelete.requestDelete(`${h.event}|${h.command ?? ""}`)
                }
              >
                <Trash2 />
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
