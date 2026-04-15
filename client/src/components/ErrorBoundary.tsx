import { Component, type ReactNode, type ErrorInfo } from 'react';
import { theme } from '../styles/theme';

interface Props { children: ReactNode; }
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

  render() {
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
