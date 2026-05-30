import { Component, type ReactNode, type ErrorInfo } from 'react';
import { theme } from '../styles/theme';

interface Props {
  children: ReactNode;
  /**
   * 'fullscreen' (default) takes over the viewport — used by the top-level
   * app boundary in main.tsx. 'inline' renders a contained fallback that
   * fills its positioned parent, so a crash in one panel — e.g. the Konva
   * battle map — shows a local error with a Retry while the rest of the
   * session (chat, sidebar, combat tracker) keeps running.
   */
  variant?: 'fullscreen' | 'inline';
  /** Short label for what failed, shown in the inline fallback. */
  label?: string;
}
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    // Best-effort crash report. Server rate-limits per IP (20/min)
    // and the fetch is fire-and-forget so a failing endpoint won't
    // stack-loop the boundary.
    try {
      fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: error.message,
          stack: error.stack?.slice(0, 8000),
          componentStack: info.componentStack?.slice(0, 8000),
          url: typeof window !== 'undefined' ? window.location.href : undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        }),
        keepalive: true,
      }).catch(() => { /* swallow; we already logged to console */ });
    } catch { /* ignore */ }
  }

  private handleRetry = () => this.setState({ hasError: false, error: null });

  render() {
    // Inline variant: a contained fallback that keeps the rest of the
    // session alive when a single panel (e.g. the battle map) crashes.
    if (this.state.hasError && this.props.variant === 'inline') {
      const label = this.props.label ?? 'This panel';
      return (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
          background: theme.bg.deepest, color: theme.text.primary,
          fontFamily: theme.font.body, textAlign: 'center', zIndex: 5,
        }}>
          <h2 style={{ color: theme.danger, fontFamily: theme.font.display, fontSize: 18, margin: 0 }}>
            {label} hit a snag
          </h2>
          <p style={{ color: theme.text.secondary, fontSize: 13, maxWidth: 360, margin: 0 }}>
            The rest of your session is still live. Retry this panel, or refresh
            the page if it keeps happening.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={this.handleRetry}
              style={{
                padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
                borderRadius: 6, color: theme.gold.primary,
              }}
            >
              Retry
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: 'transparent', border: `1px solid ${theme.gold.border}`,
                borderRadius: 6, color: theme.text.secondary,
              }}
            >
              Refresh page
            </button>
          </div>
          {this.state.error && (
            <details style={{ marginTop: 8, color: theme.text.muted, fontSize: 11, maxWidth: 420 }}>
              <summary style={{ cursor: 'pointer' }}>Error details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 6 }}>
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          background: theme.bg.deepest, color: theme.text.primary,
          fontFamily: theme.font.body,
        }}>
          <h1 style={{ color: theme.danger, fontFamily: theme.font.display, fontSize: 24 }}>
            Something went wrong
          </h1>
          <p style={{ color: theme.text.secondary, fontSize: 14, maxWidth: 400, textAlign: 'center' }}>
            An unexpected error occurred. Try refreshing the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', fontSize: 14, fontWeight: 600,
              background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
              borderRadius: 8, color: theme.gold.primary, cursor: 'pointer',
            }}
          >
            Refresh Page
          </button>
          {this.state.error && (
            <details style={{ marginTop: 16, color: theme.text.muted, fontSize: 12, maxWidth: 500 }}>
              <summary>Error details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8 }}>
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
