import { useEffect, useState, useCallback } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../styles/theme';

/**
 * Atlas Bound primitive: <Toast> + <ToastHost /> + useToast().
 *
 * Replaces the ~6 places in the codebase that dynamically call
 * `document.createElement('div')` to build ad-hoc toast notifications.
 * Now every toast flows through the same host, with the same styling,
 * positioning, and dismiss behavior.
 *
 * ### Architecture
 * 1. `<ToastHost />` is mounted ONCE in AppShell. It subscribes to the
 *    toast store and renders the stack of active toasts.
 * 2. `useToast()` returns `(opts) => void` — call it from any component
 *    to show a toast. No hooks needed on the calling side if you just
 *    import `showToast` directly.
 * 3. Toasts auto-dismiss after `duration` ms (default 3000).
 *
 * ### Variants
 * - `info`    — neutral blue accent
 * - `success` — green (✓ saved, loot picked up, heal)
 * - `danger`  — red (critical miss, action denied, error)
 * - `warning` — orange (warning, missing dependency)
 * - `roll`    — gold with glow (dice roll result)
 *
 * ### Usage
 * ```tsx
 * import { showToast } from '@/components/ui/Toast';
 * showToast({ message: 'Character saved', variant: 'success' });
 * showToast({ message: '🎲 d20 = 17', variant: 'roll', duration: 5000 });
 * ```
 */

export type ToastVariant = 'info' | 'success' | 'danger' | 'warning' | 'roll';

export interface ToastOptions {
  message: string | ReactNode;
  variant?: ToastVariant;
  duration?: number;
  /** Optional leading emoji (takes precedence over variant default). */
  emoji?: string;
}

interface ActiveToast extends ToastOptions {
  id: number;
}

// ── Simple pub-sub store (no zustand needed for this tiny state) ──
let nextId = 1;
let toasts: ActiveToast[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/**
 * Show a toast. Can be called from anywhere — no React context needed.
 */
export function showToast(opts: ToastOptions): number {
  const id = nextId++;
  toasts = [...toasts, { ...opts, id }];
  notify();
  const duration = opts.duration ?? 3000;
  if (duration > 0) {
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

/** Hook form — use when you want the same API via a hook. */
export function useToast() {
  return showToast;
}

// ── ToastHost ────────────────────────────────────────────────
export function ToastHost() {
  const [snapshot, setSnapshot] = useState<ActiveToast[]>(toasts);
  useEffect(() => {
    const listener = () => setSnapshot([...toasts]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (snapshot.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space.md,
        zIndex: 99999,
        pointerEvents: 'none',
      }}
    >
      {snapshot.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

// ── Variant color mapping ────────────────────────────────────
function variantStyle(variant: ToastVariant): CSSProperties {
  switch (variant) {
    case 'success':
      return {
        background: 'rgba(30, 50, 35, 0.96)',
        border: `1px solid ${theme.state.success}`,
        color: theme.text.primary,
        boxShadow: `0 0 16px rgba(39, 174, 96, 0.35)`,
      };
    case 'danger':
      return {
        background: 'rgba(50, 20, 20, 0.96)',
        border: `1px solid ${theme.state.danger}`,
        color: theme.text.primary,
        boxShadow: theme.dangerGlow,
      };
    case 'warning':
      return {
        background: 'rgba(50, 40, 20, 0.96)',
        border: `1px solid ${theme.state.warning}`,
        color: theme.text.primary,
        boxShadow: `0 0 16px rgba(243, 156, 18, 0.35)`,
      };
    case 'roll':
      return {
        background: 'rgba(40, 35, 20, 0.96)',
        border: `1px solid ${theme.gold.border}`,
        color: theme.gold.bright,
        boxShadow: theme.goldGlow.medium,
      };
    case 'info':
    default:
      return {
        background: 'rgba(20, 25, 40, 0.96)',
        border: `1px solid ${theme.state.info}`,
        color: theme.text.primary,
        boxShadow: `0 0 16px rgba(52, 152, 219, 0.3)`,
      };
  }
}

function ToastItem({ toast }: { toast: ActiveToast }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // Slide-in on mount
    const timer = window.setTimeout(() => setVisible(true), 16);
    return () => window.clearTimeout(timer);
  }, []);

  const dismiss = useCallback(() => dismissToast(toast.id), [toast.id]);

  return (
    <div
      onClick={dismiss}
      style={{
        ...variantStyle(toast.variant ?? 'info'),
        padding: `${theme.space.md}px ${theme.space.xl}px`,
        borderRadius: theme.radius.md,
        fontFamily: theme.font.body,
        fontSize: 13,
        fontWeight: 500,
        minWidth: 240,
        maxWidth: 480,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space.md,
        cursor: 'pointer',
        pointerEvents: 'auto',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-8px)',
        transition: `opacity ${theme.motion.normal}, transform ${theme.motion.normal}`,
      }}
    >
      {toast.emoji && <span style={{ fontSize: 18 }}>{toast.emoji}</span>}
      <span style={{ flex: 1 }}>{toast.message}</span>
    </div>
  );
}
