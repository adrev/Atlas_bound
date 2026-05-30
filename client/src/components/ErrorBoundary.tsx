import { Component, type ReactNode, type ErrorInfo } from 'react';
import { theme } from '../styles/theme';

interface Props {
  children: ReactNode;
  /**
   * Optional human-readable label for what this boundary is protecting.
   * When provided, the fallback renders in scoped/inline mode instead of
   * the full-page modal — meant for wrapping individual panels (e.g. the
   * battle map, the dice tray) so a crash in one panel doesn't kill the
   * whole session.
   */
  label?: string;
  /**
   * Optional custom fallback. Takes precedence over the built-in modes
   * when provided. The reset callback clears the error state and tries
   * to re-render the children.
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
}

interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const ctx = this.props.label ? `[${this.props.label}]` : '';
    console.error('[ErrorBoundary]', ctx, error, info.componentStack);
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
          label: this.props.label,
          url: typeof window !== 'undefined' ? window.location.href : undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        }),
        keepalive: true,
      }).catch(() => { /* swallow; we already logged to console */ });
    } catch { /* ignore */ }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      const { fallback, label } = this.props;

      // Custom fallback wins.
      if (fallback) {
        return typeof fallback === 'function' ? fallback(this.state.error, this.reset) : fallback;
      }

      // Scoped mode — confined to the parent layout, doesn't take over
      // the whole screen. Used when a `label` is provided.
      if (label) {
        return (
          <div
            role="alert"
            style={{
              width: '100%', height: '100%', minHeight: 120,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 12,
              padding: 24,
              background: theme.bg.deep,
              color: theme.text.primary,
              fontFamily: theme.font.body,
              border: `1px dashed ${theme.danger}`, borderRadius: 6,
            }}
          >
            <p style={{ color: theme.danger, fontFamily: theme.font.display, fontSize: 16, margin: 0 }}>
              {label} crashed
            </p>
            <p style={{ color: theme.text.secondary, fontSize: 13, maxWidth: 360, textAlign: 'center', margin: 0 }}>
              The rest of the session is still running. Try again, or refresh the page if the problem persists.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={this.reset}
                style={{
                  padding: '6px 14px', fontSize: 13,
                  background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
                  borderRadius: 4, color: theme.gold.primary, cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '6px 14px', fontSize: 13,
                  background: 'transparent', border: `1px solid ${theme.text.muted}`,
                  borderRadius: 4, color: theme.text.secondary, cursor: 'pointer',
                }}
              >
                Refresh
              </button>
            </div>
            <details style={{ color: theme.text.muted, fontSize: 11, maxWidth: 400 }}>
              <summary style={{ cursor: 'pointer' }}>Error details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 6 }}>
                {this.state.error.message}
              </pre>
            </details>
          </div>
        );
      }

      // Default — full-screen fallback for the root-level boundary.
      return (
        <div role="alert" style={{
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
          <details style={{ marginTop: 16, color: theme.text.muted, fontSize: 12, maxWidth: 500 }}>
            <summary>Error details</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8 }}>
              {this.state.error.message}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
