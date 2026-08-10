import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Trash2, Eye, EyeOff } from "lucide-react";
import type { Translations } from "@/i18n/types";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type {
  HubAgentPluginRow,
  MemoryProviderConfig,
  MemoryProviderField,
  MemoryProviderInfo,
  MemoryProviderSetupInfo,
  MemoryProviderSetupResult,
  PluginsHubResponse,
} from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { CommandBlock, CopyButton } from "@nous-research/ui/ui/components/command-block";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { ConfirmDialog } from "@nous-research/ui/ui/components/confirm-dialog";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useI18n } from "@/i18n";
import { PluginSlot } from "@/plugins";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";

/** Select value for built-in memory (`config` uses empty string). Never use `""` — UI Select maps empty value to an empty label. */
const MEMORY_PROVIDER_BUILTIN = "__hermes_memory_builtin__";

type MemoryFormValue = string | boolean;

const MEMORY_STATUS_LABEL: Record<MemoryProviderInfo["status"], string> = {
  ready: "готов",
  needs_config: "требуется настройка",
  unavailable: "недоступен",
  missing: "не установлен",
};

const MEMORY_STATUS_TONE: Record<MemoryProviderInfo["status"], "success" | "warning" | "destructive" | "secondary"> = {
  ready: "success",
  needs_config: "warning",
  unavailable: "destructive",
  missing: "destructive",
};

function fieldInitialValue(field: MemoryProviderField): MemoryFormValue {
  if (field.kind === "secret") return "";
  if (field.kind === "boolean") return Boolean(field.value);
  return String(field.value ?? "");
}

function fieldIsVisible(field: MemoryProviderField, values: Record<string, MemoryFormValue>) {
  if (!field.when) return true;
  return Object.entries(field.when).every(([key, expected]) => {
    const current = values[key];
    return String(current ?? "") === String(expected);
  });
}

function setupHasDetails(setup?: MemoryProviderSetupInfo) {
  if (!setup) return false;
  return Boolean(
    setup.external_dependencies?.length ||
      setup.pip_dependencies?.length ||
      setup.required_env?.length,
  );
}

function setupHasInstallableSteps(setup?: MemoryProviderSetupInfo) {
  if (!setup) return false;
  return Boolean(
    setup.external_dependencies?.some((dep) => dep.install) ||
      setup.pip_dependencies?.length,
  );
}

function SetupCommandBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] text-muted-foreground">{label}</span>
        <CopyButton text={code} />
      </div>
      <div className="border border-border bg-background/40 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
        <code className="break-all">{code}</code>
      </div>
    </div>
  );
}

function setupResultLabel(status: string) {
  if (status === "already_installed") return "уже установлено";
  if (status === "no_declared_steps") return "настройка не предусмотрена";
  return status.replace(/_/g, " ");
}

function setupResultClass(status: string) {
  if (status === "failed") return "border-destructive/50 text-destructive";
  if (status === "installed" || status === "verified" || status === "already_installed") {
    return "border-success/50 text-success";
  }
  if (status === "missing") return "border-warning/50 text-warning";
  return "border-border text-muted-foreground";
}

function MemoryProviderSetupResults({ results }: { results: MemoryProviderSetupResult[] }) {
  if (!results.length) return null;

  return (
    <div className="grid gap-2 border border-border bg-background/20 p-3">
      <p className="text-muted-foreground">Результаты настройки</p>
      {results.map((result, index) => {
        const detail = result.stderr || result.stdout;
        return (
          <div key={`${result.kind}-${result.name}-${index}`} className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "border px-2 py-0.5 font-mono text-[0.6875rem]",
                  setupResultClass(result.status),
                )}
              >
                {setupResultLabel(result.status)}
              </span>
              <span className="text-muted-foreground">
                {result.name}
                {result.kind ? ` (${result.kind.replace(/_/g, " ")})` : ""}
              </span>
            </div>
            {result.command ? (
              <code className="block break-all border border-border bg-background/40 px-2 py-1 font-mono text-[0.6875rem]">
                {result.command}
              </code>
            ) : null}
            {detail ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words border border-border bg-background/40 px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground">
                {detail}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MemoryProviderSetupHint({
  installing,
  onInstall,
  provider,
  results,
}: {
  installing: boolean;
  onInstall: () => void;
  provider: MemoryProviderInfo;
  results: MemoryProviderSetupResult[] | null;
}) {
  const setup = provider.setup;
  const hasDetails = setupHasDetails(setup);
  const hasInstallableSteps = setupHasInstallableSteps(setup);
  const dependenciesInstalled = setup?.dependencies_installed ?? !hasInstallableSteps;
  const hasResults = Boolean(results?.length);
  const needsDependencySetup = hasInstallableSteps && !dependenciesInstalled;
  const isBlocked = provider.status === "unavailable" && needsDependencySetup;
  const shouldShow =
    hasResults ||
    needsDependencySetup ||
    (provider.status === "unavailable" && hasDetails && !dependenciesInstalled);

  if (!shouldShow) return null;

  if (!hasDetails || !setup) {
    return (
      <p className="border border-destructive/50 px-3 py-2 text-xs text-destructive">
        Этот провайдер установлен, но недоступен. Возможно, Hermes сможет
        активировать его только после установки локальных зависимостей или
        ручной настройки.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-3 border px-3 py-3 text-xs text-foreground",
        isBlocked ? "border-destructive/50" : "border-border",
      )}
    >
      <p className={isBlocked ? "text-destructive" : "text-muted-foreground"}>
        {needsDependencySetup
          ? "Выполните эти шаги настройки, прежде чем Hermes сможет активировать провайдер."
          : "Настройка зависимостей провайдера завершена."}
      </p>

      {needsDependencySetup ? (
        <Button
          className="w-fit uppercase"
          disabled={installing}
          onClick={onInstall}
          size="sm"
        >
          <span className="inline-flex items-center gap-2">
            {installing ? <Spinner /> : null}
            {installing ? "Установка зависимостей провайдера" : "Установить зависимости провайдера"}
          </span>
        </Button>
      ) : null}

      {installing ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Выполняется настройка провайдера. Это может занять минуту…
        </div>
      ) : null}

      {results ? <MemoryProviderSetupResults results={results} /> : null}

      {needsDependencySetup ? (
        <>
          {setup.external_dependencies.map((dep, index) => (
            <div key={`${dep.name || "dependency"}-${index}`} className="grid gap-2">
              <p className="text-muted-foreground">
                Внешняя зависимость{dep.name ? `: ${dep.name}` : ""}
              </p>
              {dep.install ? (
                <SetupCommandBlock
                  label={dep.name ? `Установить ${dep.name}` : "Установить зависимость"}
                  code={dep.install}
                />
              ) : null}
              {dep.check ? (
                <SetupCommandBlock
                  label={dep.name ? `Проверить ${dep.name}` : "Проверить зависимость"}
                  code={dep.check}
                />
              ) : null}
            </div>
          ))}

          {setup.pip_dependencies.length ? (
            <div className="grid gap-2">
              <p className="text-muted-foreground">Зависимости Python</p>
              <div className="flex flex-wrap gap-2">
                {setup.pip_dependencies.map((dep) => (
                  <code
                    key={dep}
                    className="border border-border bg-background/40 px-2 py-1 font-mono text-[0.6875rem]"
                  >
                    {dep}
                  </code>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {setup.required_env.length && needsDependencySetup ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground">
            Обязательные значения окружения. Заполните соответствующие поля
            ниже или задайте их в окружении Hermes.
          </p>
          <div className="flex flex-wrap gap-2">
            {setup.required_env.map((envKey) => (
              <code
                key={envKey}
                className="border border-border bg-background/40 px-2 py-1 font-mono text-[0.6875rem]"
              >
                {envKey}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function PluginsPage() {
  const [hub, setHub] = useState<PluginsHubResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [installId, setInstallId] = useState("");
  const [installForce, setInstallForce] = useState(false);
  const [installEnable, setInstallEnable] = useState(true);
  const [installBusy, setInstallBusy] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [memorySel, setMemorySel] = useState(MEMORY_PROVIDER_BUILTIN);
  const [memoryConfig, setMemoryConfig] = useState<MemoryProviderConfig | null>(null);
  const [memoryValues, setMemoryValues] = useState<Record<string, MemoryFormValue>>({});
  const [memoryConfigBusy, setMemoryConfigBusy] = useState(false);
  const [secretVisible, setSecretVisible] = useState<Record<string, boolean>>({});
  const [contextSel, setContextSel] = useState("compressor");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memorySetupBusy, setMemorySetupBusy] = useState(false);
  const [memorySetupResults, setMemorySetupResults] = useState<MemoryProviderSetupResult[] | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { setAfterTitle } = usePageHeader();

  const loadHub = useCallback((memorySelection?: string) => {
    return api
      .getPluginsHub()
      .then((h) => {
        setHub(h);
        const p = h.providers;
        setMemorySel(
          memorySelection ?? (p.memory_provider ? p.memory_provider : MEMORY_PROVIDER_BUILTIN),
        );
        setContextSel(p.context_engine || "compressor");
      })
      .catch(() => showToast(t.common.loading, "error"));
  }, [showToast, t.common.loading]);

  useEffect(() => {
    void loadHub().finally(() => setLoading(false));
  }, [loadHub]);

  useEffect(() => {
    const provider = memorySel === MEMORY_PROVIDER_BUILTIN ? "" : memorySel;
    let cancelled = false;

    void Promise.resolve().then(() => {
      if (cancelled) return;
      setSecretVisible({});
      setMemorySetupResults(null);

      if (!provider) {
        setMemoryConfig(null);
        setMemoryValues({});
        setMemoryConfigBusy(false);
        return;
      }

      setMemoryConfigBusy(true);
      api
        .getMemoryProviderConfig(provider)
        .then((config) => {
          if (cancelled) return;
          setMemoryConfig(config);
          setMemoryValues(
            Object.fromEntries(
              config.fields.map((field) => [field.key, fieldInitialValue(field)]),
            ),
          );
        })
        .catch((e) => {
          if (!cancelled) {
            setMemoryConfig(null);
            setMemoryValues({});
            showToast(e instanceof Error ? e.message : "Не удалось загрузить конфигурацию провайдера", "error");
          }
        })
        .finally(() => {
          if (!cancelled) setMemoryConfigBusy(false);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [memorySel, showToast]);

  const onInstall = async () => {
    const id = installId.trim();
    if (!id) {
      showToast(t.pluginsPage.installHint, "error");
      return;
    }
    setInstallBusy(true);
    try {
      const r = await api.installAgentPlugin({
        identifier: id,
        force: installForce,
        enable: installEnable,
      });
      showToast(`${r.plugin_name ?? id}: установлено`, "success");
      if ((r.warnings?.length ?? 0) > 0) showToast(r.warnings!.join(" "), "error");
      if ((r.missing_env?.length ?? 0) > 0)
        showToast(`${t.pluginsPage.missingEnvWarn} ${r.missing_env!.join(", ")}`, "error");
      setInstallId("");
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Ошибка установки", "error");
    } finally {
      setInstallBusy(false);
    }
  };

  const onRescan = useCallback(async () => {
    setRescanBusy(true);
    try {
      const rc = await api.rescanPlugins();
      showToast(
        `${t.pluginsPage.refreshDashboard} (${rc.count})`,
        "success",
      );
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось повторно просканировать", "error");
    } finally {
      setRescanBusy(false);
    }
  }, [loadHub, showToast, t.pluginsPage.refreshDashboard]);

  useEffect(() => {
    setAfterTitle(
      <Button
        ghost
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        disabled={loading || rescanBusy}
        onClick={() => void onRescan()}
        aria-label={t.pluginsPage.refreshDashboard}
      >
        {rescanBusy ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    return () => setAfterTitle(null);
  }, [loading, onRescan, rescanBusy, setAfterTitle, t.pluginsPage.refreshDashboard]);

  const onSaveMemoryProvider = async () => {
    const provider = memorySel === MEMORY_PROVIDER_BUILTIN ? "" : memorySel;
    setMemoryBusy(true);
    try {
      if (!provider) {
        await api.setMemoryProvider("");
      } else {
        const visibleValues = Object.fromEntries(
          Object.entries(memoryValues).filter(([key]) => {
            const field = memoryConfig?.fields.find((candidate) => candidate.key === key);
            return field ? fieldIsVisible(field, memoryValues) : true;
          }),
        );
        await api.updateMemoryProviderConfig(provider, visibleValues);
      }
      showToast(t.pluginsPage.savedProviders, "success");
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Ошибка сохранения", "error");
    } finally {
      setMemoryBusy(false);
    }
  };

  const currentVisibleMemoryValues = () =>
    Object.fromEntries(
      Object.entries(memoryValues).filter(([key]) => {
        const field = memoryConfig?.fields.find((candidate) => candidate.key === key);
        return field ? fieldIsVisible(field, memoryValues) : true;
      }),
    );

  const onSetupMemoryProvider = async () => {
    const provider = memorySel === MEMORY_PROVIDER_BUILTIN ? "" : memorySel;
    if (!provider) return;

    setMemorySetupBusy(true);
    setMemorySetupResults(null);
    try {
      const result = await api.setupMemoryProvider(provider, currentVisibleMemoryValues());
      setMemorySetupResults(result.results);
      const failed = result.results.filter((row) => row.status === "failed");
      if (failed.length) {
        const names = Array.from(new Set(failed.map((row) => row.name))).join(", ");
        showToast(`Не удалось настроить провайдер: ${names || provider}. Подробности приведены ниже.`, "error");
      } else {
        showToast("Настройка провайдера завершена", "success");
      }
      await loadHub(provider);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось настроить провайдер", "error");
    } finally {
      setMemorySetupBusy(false);
    }
  };

  const onSaveContextEngine = async () => {
    setContextBusy(true);
    try {
      await api.savePluginProviders({ context_engine: contextSel });
      showToast(t.pluginsPage.savedProviders, "success");
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Ошибка сохранения", "error");
    } finally {
      setContextBusy(false);
    }
  };

  const setRuntimeLoading = async (name: string, fn: () => Promise<unknown>) => {
    setRowBusy(name);
    try {
      await fn();
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Сбой", "error");
    } finally {
      setRowBusy(null);
    }
  };

  const rows = hub?.plugins ?? [];
  const providers = hub?.providers;
  const selectedMemoryName = memorySel === MEMORY_PROVIDER_BUILTIN ? "" : memorySel;
  const selectedMemoryInfo = selectedMemoryName
    ? providers?.memory_options.find((provider) => provider.name === selectedMemoryName)
    : null;
  const activeMemoryInfo = providers?.memory_provider
    ? providers.memory_options.find((provider) => provider.name === providers.memory_provider)
    : null;
  const visibleMemoryFields =
    memoryConfig?.fields.filter((field) => fieldIsVisible(field, memoryValues)) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PluginSlot name="plugins:top" />

      <div className={cn("flex w-full flex-col gap-8")}>

        {providers && (
          <Card>
            <CardHeader>
              <CardTitle>{t.pluginsPage.providersHeading}</CardTitle>
              <p className="text-xs tracking-[0.08em] text-text-tertiary">
                Настройте провайдеры памяти и выбор движка контекста во время работы.
              </p>
            </CardHeader>

            <CardContent className="flex flex-col gap-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
                <div className="flex flex-col gap-4 min-w-0">
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor="mem-provider">{t.pluginsPage.memoryProviderLabel}</Label>
                      {selectedMemoryName && selectedMemoryInfo && (
                        <Badge tone={MEMORY_STATUS_TONE[selectedMemoryInfo.status]}>
                          {MEMORY_STATUS_LABEL[selectedMemoryInfo.status]}
                        </Badge>
                      )}
                      {selectedMemoryName && selectedMemoryName === providers.memory_provider && (
                        <Badge tone="outline">активен</Badge>
                      )}
                      {!selectedMemoryName && !providers.memory_provider && (
                        <Badge tone="success">активен</Badge>
                      )}
                    </div>

                    <Select
                      id="mem-provider"
                      className="w-full"
                      value={memorySel}
                      onValueChange={setMemorySel}
                    >
                      <SelectOption value={MEMORY_PROVIDER_BUILTIN}>
                        {`(${t.pluginsPage.providerDefaults})`}
                      </SelectOption>

                      {providers.memory_options.map((o) => (
                        <SelectOption key={o.name} value={o.name}>
                          {o.name}
                        </SelectOption>
                      ))}
                    </Select>
                  </div>

                  {!selectedMemoryName && (
                    <p className="text-xs text-muted-foreground">
                      Hermes будет использовать встроенные файлы MEMORY.md и USER.md.
                    </p>
                  )}

                  {activeMemoryInfo?.status === "missing" && (
                    <p className="border border-destructive/50 px-3 py-2 text-xs text-destructive">
                      Активный провайдер {providers.memory_provider} больше не
                      установлен. Выберите другой провайдер и сохраните.
                    </p>
                  )}

                  {selectedMemoryName && selectedMemoryInfo?.description && (
                    <p className="text-xs text-muted-foreground">
                      {selectedMemoryInfo.description}
                    </p>
                  )}

                  {selectedMemoryName && selectedMemoryInfo && (
                    <MemoryProviderSetupHint
                      installing={memorySetupBusy}
                      onInstall={() => void onSetupMemoryProvider()}
                      provider={selectedMemoryInfo}
                      results={memorySetupResults}
                    />
                  )}

                  {selectedMemoryName && selectedMemoryInfo?.status === "needs_config" && (
                    <p className="border border-warning/50 px-3 py-2 text-xs text-warning">
                    Зависимости провайдера установлены. Добавьте ниже
                    необходимые учётные данные или URL собственного сервера,
                    затем сохраните провайдер.
                    </p>
                  )}

                  {selectedMemoryName && memoryConfigBusy && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner /> Загрузка настроек провайдера…
                    </div>
                  )}

                  {selectedMemoryName && !memoryConfigBusy && visibleMemoryFields.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Этот провайдер не предоставляет настроек в панели.
                    </p>
                  )}

                  {selectedMemoryName && !memoryConfigBusy && visibleMemoryFields.length > 0 && (
                    <div className="grid gap-4 border border-border p-4">
                      {visibleMemoryFields.map((field) => {
                        const value = memoryValues[field.key];
                        const secretIsVisible = !!secretVisible[field.key];
                        return (
                          <div key={field.key} className="grid gap-2 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Label htmlFor={`memory-${field.key}`}>{field.label}</Label>
                              {field.required && <Badge tone="outline">обязательно</Badge>}
                              {field.kind === "secret" && field.is_set && !value && (
                                <Badge tone="success">задано</Badge>
                              )}
                              {field.url && (
                                <a
                                  href={field.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-xs underline"
                                >
                                  Открыть <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>

                            {field.kind === "select" ? (
                              <Select
                                id={`memory-${field.key}`}
                                className="w-full"
                                value={String(value ?? "")}
                                onValueChange={(next) =>
                                  setMemoryValues((current) => ({ ...current, [field.key]: next }))
                                }
                              >
                                {field.options.map((option) => (
                                  <SelectOption key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectOption>
                                ))}
                              </Select>
                            ) : field.kind === "boolean" ? (
                              <Switch
                                checked={Boolean(value)}
                                onCheckedChange={(next) =>
                                  setMemoryValues((current) => ({ ...current, [field.key]: next }))
                                }
                              />
                            ) : (
                              <div className="flex items-center gap-2">
                                <Input
                                  id={`memory-${field.key}`}
                                  type={field.kind === "secret" && !secretIsVisible ? "password" : "text"}
                                  value={String(value ?? "")}
                                  placeholder={
                                    field.kind === "secret" && field.is_set
                                      ? "Оставьте пустым, чтобы сохранить текущее значение"
                                      : field.placeholder
                                  }
                                  onChange={(event) =>
                                    setMemoryValues((current) => ({
                                      ...current,
                                      [field.key]: event.target.value,
                                    }))
                                  }
                                />
                                {field.kind === "secret" && (
                                  <Button
                                    ghost
                                    size="icon"
                                    aria-label={secretIsVisible ? "Скрыть секрет" : "Показать секрет"}
                                    onClick={() =>
                                      setSecretVisible((current) => ({
                                        ...current,
                                        [field.key]: !current[field.key],
                                      }))
                                    }
                                  >
                                    {secretIsVisible ? (
                                      <EyeOff className="h-3.5 w-3.5" />
                                    ) : (
                                      <Eye className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                )}
                              </div>
                            )}

                            {field.description && (
                              <p className="text-xs text-muted-foreground">{field.description}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <Button
                    className="w-fit uppercase"
                    size="sm"
                    disabled={memoryBusy || memoryConfigBusy || memorySetupBusy}
                    onClick={() => void onSaveMemoryProvider()}
                    prefix={memoryBusy ? <Spinner /> : undefined}
                  >
                    Сохранить провайдер памяти
                  </Button>
                </div>

                <div className="grid content-start gap-3 min-w-0">
                  <Label htmlFor="ctx-engine">{t.pluginsPage.contextEngineLabel}</Label>

                  <Select
                    id="ctx-engine"
                    className="w-full"
                    value={contextSel}
                    onValueChange={setContextSel}
                  >
                    <SelectOption value="compressor">compressor</SelectOption>

                    {providers.context_options
                      .filter((o) => o.name !== "compressor")
                      .map((o) => (
                        <SelectOption key={o.name} value={o.name}>
                          {o.name}
                        </SelectOption>
                      ))}
                  </Select>

                  <Button
                    className="w-fit uppercase"
                    size="sm"
                    disabled={contextBusy}
                    onClick={() => void onSaveContextEngine()}
                    prefix={contextBusy ? <Spinner /> : undefined}
                  >
                    Сохранить движок контекста
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t.pluginsPage.installHeading}</CardTitle>
            <p className="text-xs tracking-[0.08em] text-text-tertiary">
              {t.pluginsPage.installHint}
            </p>
          </CardHeader>


          <CardContent className="flex flex-col gap-4">

            <div className="flex flex-col gap-2">

              <Label htmlFor="install-url">{t.pluginsPage.identifierLabel}</Label>

              <Input
                className="font-mono-ui lowercase"
                id="install-url"
                placeholder="владелец/репозиторий, владелец/репозиторий/каталог или https://..."
                spellCheck={false}
                value={installId}
                onChange={(e) => setInstallId(e.target.value)}
              />
            </div>


            <div className="flex flex-wrap items-center gap-8">

              <div className="flex items-center gap-3">

                <Switch checked={installForce} onCheckedChange={setInstallForce} />

                <span className="text-xs tracking-[0.06em] text-text-secondary">
                  {t.pluginsPage.forceReinstall}
                </span>
              </div>

              <div className="flex items-center gap-3">

                <Switch checked={installEnable} onCheckedChange={setInstallEnable} />

                <span className="text-xs tracking-[0.06em] text-text-secondary">
                  {t.pluginsPage.enableAfterInstall}
                </span>
              </div>
            </div>

            <Button
              className="w-fit uppercase"
              size="sm"
              disabled={installBusy}
              onClick={() => void onInstall()}
              prefix={installBusy ? <Spinner /> : undefined}
            >
              {t.pluginsPage.installBtn}
            </Button>

            <p className="text-xs tracking-[0.06em] text-text-tertiary">
              {t.pluginsPage.rescanHint}
            </p>

            <p className="text-xs tracking-[0.06em] text-text-tertiary">
              {t.pluginsPage.removeHint}
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3">

          <h3 className="font-mondwest text-display text-xs tracking-[0.12em] text-text-secondary">
            {t.pluginsPage.pluginListHeading}
          </h3>

          {loading ? (

            <div className="flex items-center gap-2 py-8 text-xs text-text-tertiary">

              <Spinner />
              <span>{t.common.loading}</span>
            </div>
          ) : rows.length === 0 ? (

            <p className="text-xs text-text-tertiary">{t.common.noResults}</p>
          ) : (

            <ul className="flex flex-col gap-3">

              {rows.map((row: HubAgentPluginRow) => (

                <li key={row.name}>


                  <PluginRowCard
                    {...{ row, rowBusy, setRuntimeLoading, showToast, t }}
                  />

                </li>
              ))}
            </ul>
          )}
        </div>

        {(hub?.orphan_dashboard_plugins?.length ?? 0) > 0 ? (


          <div className="flex flex-col gap-3 opacity-95">

            <h3 className="font-mondwest text-display text-xs tracking-[0.12em] text-text-secondary">
              {t.pluginsPage.orphanHeading}
            </h3>

            <ul className="flex flex-col gap-2 rounded border border-current/15 p-4">

              {hub!.orphan_dashboard_plugins.map((m) => (

                <li className="text-xs text-text-secondary" key={m.name}>


                  {m.label ?? m.name} — {m.description || m.tab?.path}


                  {!m.tab?.hidden ? (


                    <Link className="ml-3 inline-flex items-center gap-1 underline" to={m.tab.path}>


                      <ExternalLink className="h-3 w-3 opacity-65" />

                      {t.pluginsPage.openTab}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Toast toast={toast} />
      <PluginSlot name="plugins:bottom" />
    </div>
  );
}

interface PluginRowCardProps {

  row: HubAgentPluginRow;
  rowBusy: string | null;
  setRuntimeLoading: (
    name: string,
    fn: () => Promise<unknown>,
  ) => Promise<void>;

  showToast: (msg: string, variant: "success" | "error") => void;
  t: Translations;
}

function PluginRowCard(props: PluginRowCardProps) {
  const {
    row,
    rowBusy,
    setRuntimeLoading,
    showToast,
    t,
  } = props;

  const dm = row.dashboard_manifest;

  const tabPath = dm?.tab && !dm.tab.hidden ? dm.tab.override ?? dm.tab.path : null;

  const busy = rowBusy === row.name;
  const [confirmRemove, setConfirmRemove] = useState(false);

  const badgeTone =
    row.runtime_status === "enabled"
      ? "success"
      : row.runtime_status === "disabled"
        ? "destructive"
        : "outline";

  return (

    <Card className={cn(busy ? "opacity-70" : undefined)}>


      <CardContent className="flex flex-col gap-4 px-6 py-4">


        <div className="flex flex-wrap items-start justify-between gap-4">

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">

            <span className="truncate font-semibold">{row.name}</span>

            <Badge tone="outline">
              {t.pluginsPage.sourceBadge}: {row.source}
            </Badge>

            <Badge tone="outline">v{row.version || "—"}</Badge>

            <Badge tone={badgeTone}>{row.runtime_status}</Badge>

            {row.auth_required ? (
              <Badge tone="destructive">{t.pluginsPage.authRequired}</Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {row.runtime_status === "enabled" ? (
              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.disableAgentPlugin(row.name);
                    showToast(t.pluginsPage.disableRuntime, "success");
                  });
                }}
              >
                {t.pluginsPage.disableRuntime}
              </Button>
            ) : (
              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.enableAgentPlugin(row.name);
                    showToast(t.pluginsPage.enableRuntime, "success");
                  });
                }}
              >
                {t.pluginsPage.enableRuntime}
              </Button>
            )}

            {tabPath ? (

              <Link
                className={cn(
                  "inline-flex items-center rounded-none px-3 py-1.5",
                  "border border-current/25 hover:bg-current/10",
                  "font-mondwest text-display text-xs tracking-[0.1em]",
                )}
                to={tabPath}
              >
                {t.pluginsPage.openTab}
              </Link>
            ) : null}

            {row.can_update_git ? (

              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.updateAgentPlugin(row.name);
                    showToast(t.pluginsPage.updateGit, "success");
                  });
                }}
              >
                {busy ? <Spinner /> : null}
                {t.pluginsPage.updateGit}
              </Button>
            ) : null}

            {row.has_dashboard_manifest ? (
              <Button
                disabled={busy}
                ghost
                size="sm"
                title={row.user_hidden ? t.pluginsPage.showInSidebar : t.pluginsPage.hideFromSidebar}
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.setPluginVisibility(row.name, !row.user_hidden);
                  });
                }}
              >
                {row.user_hidden ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                {row.user_hidden ? t.pluginsPage.showInSidebar : t.pluginsPage.hideFromSidebar}
              </Button>
            ) : null}

            {row.can_remove ? (


              <Button
                destructive
                disabled={busy}
                ghost
                size="sm"
                onClick={() => setConfirmRemove(true)}
              >

                {busy ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            ) : null}
          </div>
        </div>

        {row.description ? (
          <p className="min-w-0 w-full text-xs tracking-[0.06em] text-text-secondary break-words">
            {row.description}
          </p>
        ) : null}

        {dm?.slots?.length ? (

          <p className="text-xs tracking-[0.05em] text-text-tertiary">
            {t.pluginsPage.dashboardSlots}: {dm.slots.join(", ")}
          </p>
        ) : null}

        {row.auth_required ? (
          <CommandBlock
            label={t.pluginsPage.authRequiredHint}
            code={row.auth_command}
          />
        ) : null}

        {!row.has_dashboard_manifest && !dm ? (


          <p className="text-xs italic text-text-disabled">
            {t.pluginsPage.noDashboardTab}
          </p>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmRemove}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void setRuntimeLoading(row.name, async () => {
            await api.removeAgentPlugin(row.name);
            showToast(`${row.name}: удалено`, "success");
          });
        }}
        title={t.pluginsPage.removeConfirm}
        description={`Плагин «${row.name}» будет удалён из вашего агента.`}
        destructive
        confirmLabel={t.common.delete}
      />
    </Card>
  );
}
