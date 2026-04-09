import { useState, useRef, useLayoutEffect, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { theme } from '../../styles/theme';

/**
 * Rich hover-triggered tooltip component. Unlike native `title`
 * attributes, it:
 *   • Appears quickly (120 ms delay)
 *   • Supports markdown-style line breaks and bold labels
 *   • Stays within the viewport (auto-flips above/below)
 *   • Uses the game theme (gold border, dark background)
 *
 * Usage:
 *   <InfoTooltip title="Dash" body="Double your movement for this turn.">
 *     <button>DASH</button>
 *   </InfoTooltip>
 */
interface InfoTooltipProps {
  /** Bold title rendered at the top of the tooltip. */
  title: string;
  /** Plain-text body. Use \n for line breaks. */
  body: string;
  /** Optional extra metadata shown below the body in muted text (e.g. "Action cost: 1 Action"). */
  footer?: string;
  /** Accent color for the title + left border. Defaults to gold. */
  accent?: string;
  /** The element(s) that trigger the tooltip on hover/focus. */
  children: ReactNode;
  /** Max tooltip width in px. Defaults to 280. */
  maxWidth?: number;
  /** Inline style for the wrapper span. */
  wrapperStyle?: CSSProperties;
}

const DEFAULT_ACCENT = '#d4a843';

export function InfoTooltip({
  title,
  body,
  footer,
  accent = DEFAULT_ACCENT,
  children,
  maxWidth = 280,
  wrapperStyle,
}: InfoTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placeAbove: boolean } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(true), 120);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  };

  useLayoutEffect(() => {
    if (!visible || !wrapperRef.current || !tooltipRef.current) return;
    const wrapperRect = wrapperRef.current.getBoundingClientRect();
    const tipRect = tooltipRef.current.getBoundingClientRect();
    const gap = 8;

    // Decide above vs below based on available space
    const spaceBelow = window.innerHeight - wrapperRect.bottom - gap;
    const spaceAbove = wrapperRect.top - gap;
    const placeAbove = spaceBelow < tipRect.height && spaceAbove > tipRect.height;

    let top = placeAbove
      ? wrapperRect.top - tipRect.height - gap
      : wrapperRect.bottom + gap;
    let left = wrapperRect.left + wrapperRect.width / 2 - tipRect.width / 2;

    // Clamp within viewport horizontally
    const padding = 8;
    if (left < padding) left = padding;
    if (left + tipRect.width > window.innerWidth - padding) {
      left = window.innerWidth - tipRect.width - padding;
    }

    setPos({ top, left, placeAbove });
  }, [visible]);

  return (
    <>
      <span
        ref={wrapperRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{ display: 'inline-block', ...wrapperStyle }}
      >
        {children}
      </span>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            maxWidth,
            background: theme.bg.deep,
            color: theme.text.primary,
            border: `1px solid ${accent}`,
            borderLeft: `3px solid ${accent}`,
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            boxShadow: '0 6px 20px rgba(0,0,0,0.7), 0 0 12px rgba(212,168,67,0.2)',
            pointerEvents: 'none',
            zIndex: 100000,
            opacity: pos ? 1 : 0,
            transition: 'opacity 0.12s ease',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: accent,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.5px',
              marginBottom: 4,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 11, color: theme.text.primary, whiteSpace: 'pre-wrap' }}>
            {body}
          </div>
          {footer && (
            <div
              style={{
                marginTop: 6,
                paddingTop: 6,
                borderTop: `1px solid ${theme.border.default}`,
                fontSize: 10,
                color: theme.text.muted,
                fontStyle: 'italic' as const,
              }}
            >
              {footer}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
