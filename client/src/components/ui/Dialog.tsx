import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { TextInput } from './TextInput';
import { showToast } from './Toast';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: imperative confirm/prompt dialogs.
 *
 * Replaces the handful of `window.confirm(...)` and `window.prompt(...)`
 * calls scattered through the app. The native browser dialogs block
 * the UI, skip the theme, are inaccessible to screen readers, and look
 * like 1995.
 *
 * ### API
 * ```ts
 * const ok    = await askConfirm({ message: 'Delete this zone?', tone: 'danger' });
 * const name  = await askPrompt({ message: 'Zone name?', defaultValue: 'Spawn' });
 * showInfo('Cannot cast here \u2014 previewing a different map.', 'warning');
 * ```
 *
 * Returns:
 *  - `askConfirm` \u2192 `Promise<boolean>` — true on confirm, false on cancel/Esc.
 *  - `askPrompt`  \u2192 `Promise<string | null>` — trimmed string on submit,
 *    `null` on cancel/Esc. Empty-string submits return `null` by default.
 *
 * Call these from any callback — no React context or hooks needed.
 * Requires `<DialogHost />` mounted once (in AppShell).
 */

// --- Types ---------------------------------------------------------------

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'neutral' | 'danger';
}

interface PromptOptions {
  title?: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  maxLength?: number;
  /** Accept empty string as a valid submission (default false). */
  allowEmpty?: boolean;
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

// --- Pub-sub store -------------------------------------------------------

let current: Pending | null = null;
const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }

function queue(p: Pending) {
  // If something is already showing we resolve it as cancelled so the
  // new dialog can take its place. Simpler than a real queue and fine
  // for VTT flows where dialogs come one-at-a-time.
  if (current) {
    if (current.kind === 'confirm') current.resolve(false);
    else current.resolve(null);
  }
  current = p;
  notify();
}

function close(result: boolean | string | null) {
  const p = current;
  current = null;
  notify();
  if (!p) return;
  if (p.kind === 'confirm') p.resolve(typeof result === 'boolean' ? result : false);
  else p.resolve(typeof result === 'string' ? result : null);
}

// --- Public API ----------------------------------------------------------

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => queue({ kind: 'confirm', opts, resolve }));
}

export function askPrompt(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => queue({ kind: 'prompt', opts, resolve }));
}

/** Shortcut for the old `window.alert()` pattern — renders as a toast. */
export function showInfo(message: string, variant: 'info' | 'warning' | 'success' | 'danger' = 'info') {
  showToast({ message, variant, duration: 4500 });
}

// --- Host ----------------------------------------------------------------

export function DialogHost() {
  const [snapshot, setSnapshot] = useState<Pending | null>(current);
  useEffect(() => {
    const l = () => setSnapshot(current);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  if (!snapshot) return null;
  if (snapshot.kind === 'confirm') return <ConfirmDialog pending={snapshot} />;
  return <PromptDialog pending={snapshot} />;
}

// --- Confirm -------------------------------------------------------------

function ConfirmDialog({ pending }: { pending: Extract<Pending, { kind: 'confirm' }> }) {
  const { opts } = pending;
  const tone = opts.tone ?? 'neutral';
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={opts.title ?? 'Confirm'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => close(true)}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, color: theme.text.primary, lineHeight: 1.5 }}>
        {opts.message}
      </p>
    </Modal>
  );
}

// --- Prompt --------------------------------------------------------------

function PromptDialog({ pending }: { pending: Extract<Pending, { kind: 'prompt' }> }) {
  const { opts } = pending;
  const [value, setValue] = useState(opts.defaultValue ?? '');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed && !opts.allowEmpty) return;
    close(trimmed.slice(0, opts.maxLength ?? 256));
  };

  return (
    <Modal
      open
      onClose={() => close(null)}
      title={opts.title ?? 'Input'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!opts.allowEmpty && !value.trim()}
          >
            {opts.submitLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space.md }}>
        <span style={{ color: theme.text.secondary, fontSize: 13 }}>{opts.message}</span>
        <TextInput
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={opts.placeholder}
          maxLength={opts.maxLength ?? 256}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
          }}
        />
      </label>
    </Modal>
  );
}
