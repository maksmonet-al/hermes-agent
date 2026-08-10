import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Confirm + full-page reload after a model change.
 *
 * Changing the main model persists to config.yaml, but the RUNNING chat keeps
 * its model until its session is rebuilt. A full reload (fresh PTY session that
 * boots its agent from the just-saved config) is the reliable way to apply it —
 * the in-place hot-swap and partial remount both proved unreliable. We confirm
 * first because the reload starts a fresh chat (the current one stays resumable
 * in Sessions and the agent's memory is kept).
 *
 * Shared by the chat sidebar picker and the Models page so both behave
 * identically. `model` is the short model name awaiting confirmation, or null
 * when the dialog is closed.
 */
export function ModelReloadConfirm({
  model,
  description,
  onCancel,
}: {
  model: string | null;
  /** Override the default body copy (e.g. the Models-page phrasing). */
  description?: string;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={model !== null}
      title="Сменить модель?"
      description={
        description ??
        `При переключении на ${model ?? ""} начнётся новый чат. Текущий чат останется в списке сессий, а память агента сохранится. Перезагрузить сейчас, чтобы применить модель?`
      }
      confirmLabel="Перезагрузить"
      onConfirm={() => window.location.reload()}
      onCancel={onCancel}
    />
  );
}
