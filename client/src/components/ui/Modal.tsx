import { useEffect } from 'react';
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { X } from 'lucide-react';
import { theme } from '../../styles/theme';
import { IconButton } from './IconButton';

/**
 * Atlas Bound primitive: <Modal>
 *
 * Unified modal overlay wrapper. Before this, every combat modal
 * (InitiativeModal, OpportunityAttackModal, CounterspellModal,
 * ShieldModal) reinvented its own overlay, close button, and header.
 *
 * ### Features
 * - Backdrop at `rgba(0, 0, 0, 0.85)` (constant opacity across modals)
 * - ESC key closes (handled globally while open)
 * - Backdrop click closes (unless `disableBackdropClose` is set)
 * - Header slot: title + optional subtitle + optional emoji + close button
 * - Body slot: scrollable, default `xl` padding
 * - Footer slot: right-aligned button row
 * - Size variants: `sm`/`md`/`lg`/`full`
 *
 * ### Usage
 * ```tsx
 * <Modal
 *   open={showInitiative}
 *   onClose={() => setShowInitiative(false)}
 *   title="Roll Initiative"
 *   emoji="🎲"
 *   size="md"
 *   footer={<Button variant="primary">Start Combat</Button>}
 * >
 *   <InitiativeList combatants={combatants} />
 * </Modal>
 * ```
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  emoji?: string;
  size?: ModalSize;
  footer?: ReactNode;
  children: ReactNode;
  /** Disable backdrop click to close (e.g. for forced-choice modals like OA). */
  disableBackdropClose?: boolean;
  /** Disable ESC key close. */
  disableEscapeClose?: boolean;
  /** Extra style for the modal container (not the backdrop). */
  containerStyle?: CSSProperties;
  /** Z-index override (default 1000). */
  zIndex?: number;
}

const WIDTH: Record<ModalSize, string> = {
  sm: '420px',
  md: '600px',
  lg: '900px',
  full: '95vw',
};

const MAX_HEIGHT: Record<ModalSize, string> = {
  sm: '80vh',
  md: '85vh',
  lg: '90vh',
  full: '95vh',
};

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  emoji,
  size = 'md',
  footer,
  children,
  disableBackdropClose = false,
  disableEscapeClose = false,
  containerStyle,
  zIndex = 1000,
}: ModalProps) {
  // Global ESC key listener while open
  useEffect(() => {
    if (!open || disableEscapeClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, disableEscapeClose, onClose]);

  if (!open) return null;

  const handleBackdropClick = (e: ReactMouseEvent) => {
    if (disableBackdropClose) return;
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      onMouseDown={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex,
        padding: theme.space.xl,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: WIDTH[size],
          maxWidth: '100%',
          maxHeight: MAX_HEIGHT[size],
          background: theme.bg.deep,
          border: `1px solid ${theme.border.default}`,
          borderRadius: theme.radius.lg,
          boxShadow: theme.shadow.lg,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          ...containerStyle,
        }}
      >
        {(title || emoji) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: theme.space.md,
              padding: `${theme.space.lg}px ${theme.space.xl}px ${theme.space.md}px`,
              borderBottom: `1px solid ${theme.border.default}`,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div
                style={{
                  ...theme.type.h1,
                  color: theme.gold.primary,
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space.md,
                }}
              >
                {emoji && <span style={{ fontSize: 22 }}>{emoji}</span>}
                {title}
              </div>
              {subtitle && (
                <span style={{ ...theme.type.small, color: theme.text.secondary }}>
                  {subtitle}
                </span>
              )}
            </div>
            <IconButton
              aria-label="Close"
              onClick={onClose}
              size="md"
              icon={<X size={16} />}
            />
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: theme.space.xl,
          }}
        >
          {children}
        </div>

        {footer && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: theme.space.md,
              padding: `${theme.space.md}px ${theme.space.xl}px ${theme.space.lg}px`,
              borderTop: `1px solid ${theme.border.default}`,
              background: theme.bg.deepest,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
