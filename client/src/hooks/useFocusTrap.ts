import { useEffect, useRef } from 'react';

/**
 * Focus-trap + Escape-handler for modal dialogs. Pair with
 * `role="dialog"` and `aria-modal="true"` on the returned ref's element
 * (and an `aria-labelledby` pointing at a heading id) for a fully
 * accessible modal.
 *
 * Behaviour:
 *   - On open, focus moves into the container (first focusable child,
 *     or the container itself).
 *   - Tab / Shift+Tab cycle inside the container — focus can't escape
 *     to elements behind the overlay.
 *   - Escape calls `onClose`.
 *   - On close, focus restores to whatever element was focused before
 *     the modal opened.
 *
 * The previously-focused element is captured on mount, NOT on every
 * render — so re-renders during the modal's lifetime don't disturb
 * the restore target.
 */
export function useFocusTrap<T extends HTMLElement>(
  isOpen: boolean,
  onClose: () => void,
) {
  const containerRef = useRef<T | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current =
      (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);

    const container = containerRef.current;
    if (container) {
      const first = getFirstFocusable(container);
      // Defer to the next tick so the container is mounted + layout
      // has settled (helps when the modal animates in).
      const t = setTimeout(() => (first ?? container).focus(), 0);
      // Return cleanup via the outer effect; this nested timer just
      // needs to fire once.
      const cleanupTimer = () => clearTimeout(t);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
          return;
        }
        if (e.key !== 'Tab') return;
        const focusables = getFocusable(container);
        if (focusables.length === 0) {
          e.preventDefault();
          container.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      };

      document.addEventListener('keydown', onKey);
      return () => {
        cleanupTimer();
        document.removeEventListener('keydown', onKey);
        // Restore focus to whatever had it before the modal opened.
        // Guard against the previously-focused node having been
        // removed from the DOM in the meantime.
        const prev = previouslyFocused.current;
        if (prev && document.contains(prev) && typeof prev.focus === 'function') {
          prev.focus();
        }
      };
    }
    return undefined;
  }, [isOpen, onClose]);

  return containerRef;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return all.filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

function getFirstFocusable(root: HTMLElement): HTMLElement | null {
  return getFocusable(root)[0] ?? null;
}
