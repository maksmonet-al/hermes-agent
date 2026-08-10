import type { SessionImportResponse } from "@/lib/api";

export type ImportableSession = Record<string, unknown>;

function normalizeImportSessions(value: unknown): ImportableSession[] {
  const candidate =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : Array.isArray(value)
        ? value
        : [value];

  const sessions = candidate.filter(
    (item): item is ImportableSession =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  if (sessions.length !== candidate.length) {
    throw new Error("Ожидался экспорт сессии в формате JSON или JSONL");
  }
  return sessions;
}

export function parseImportSessions(text: string): ImportableSession[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Файл пуст");

  try {
    return normalizeImportSessions(JSON.parse(trimmed));
  } catch (jsonError) {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length <= 1) throw jsonError;
    return normalizeImportSessions(lines.map((line) => JSON.parse(line)));
  }
}

export function importSummary(result: SessionImportResponse): string {
  const parts = [`импортировано: ${result.imported}`];
  if (result.skipped > 0) parts.push(`пропущено: ${result.skipped}`);
  if (result.detached > 0) {
    parts.push(`отсоединено из-за отсутствующих родительских сессий: ${result.detached}`);
  }
  return parts.join("; ");
}
