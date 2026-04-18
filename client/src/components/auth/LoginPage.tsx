import { useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

type Mode = 'login' | 'register';

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const { login, register, error, clearError } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) return;
    if (mode === 'register' && !displayName.trim()) return;

    setSubmitting(true);
    if (mode === 'login') {
      await login(email.trim(), password.trim());
    } else {
      await register(email.trim(), password.trim(), displayName.trim());
    }
    setSubmitting(false);
  };

  const toggleMode = () => {
    clearError();
    setMode(mode === 'login' ? 'register' : 'login');
  };

  const handleOAuth = (provider: string) => {
    window.location.href = `/api/auth/${provider}`;
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        {/* Header */}
        <div style={styles.header}>
          <img
            src="/kbrt-logo.svg"
            alt="KBRT.AI"
            style={{ width: 220, height: 220, marginBottom: 4 }}
          />
          <div style={styles.divider} />
        </div>

        {/* OAuth Buttons */}
        <div style={styles.oauthSection}>
          <button
            style={styles.discordBtn}
            onClick={() => handleOAuth('discord')}
          >
            <svg width="24" height="24" viewBox="0 -28.5 256 256" fill="currentColor">
              <path d="M216.856 16.597A208.502 208.502 0 00163.913.703s-2.684 3.04-3.711 6.26a194.23 194.23 0 00-64.404 0c-1.027-3.22-3.711-6.26-3.711-6.26A208.49 208.49 0 0039.145 16.597C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193a161.094 161.094 0 0013.955-22.835 136.447 136.447 0 01-21.846-10.632 108.636 108.636 0 005.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 005.355 4.237 136.07 136.07 0 01-21.886 10.653c4.006 8.02 8.638 15.67 13.995 22.835 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.26-148.36zM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18z"/>
            </svg>
            Continue with Discord
          </button>
          <button
            style={styles.googleBtn}
            onClick={() => handleOAuth('google')}
          >
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continue with Google
          </button>
        </div>

        {/* Separator */}
        <div style={styles.separator}>
          <div style={styles.separatorLine} />
          <span style={styles.separatorText}>or by inked quill</span>
          <div style={styles.separatorLine} />
        </div>

        {/* Email / Password Form */}
        <div style={styles.formCard}>
          <div style={styles.form}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              style={styles.input}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              style={styles.input}
            />
            {mode === 'register' && (
              <input
                type="text"
                placeholder="Display Name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                style={styles.input}
              />
            )}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={handleSubmit}
              disabled={submitting}
              loading={submitting}
            >
              {mode === 'login' ? 'Enter the Tavern' : 'Forge a Character'}
            </Button>
          </div>

          <p style={styles.toggleText}>
            {mode === 'login' ? (
              <>
                Need an account?{' '}
                <span style={styles.toggleLink} onClick={toggleMode}>
                  Register
                </span>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <span style={styles.toggleLink} onClick={toggleMode}>
                  Login
                </span>
              </>
            )}
          </p>

          {error && <div style={styles.error}>{error}</div>}
        </div>

        <p style={styles.footer}>
          KBRT.AI · Your adventure awaits.
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflowY: 'auto',
    overflowX: 'hidden',
    background: `radial-gradient(ellipse at center, ${theme.bg.base} 0%, ${theme.bg.deepest} 70%)`,
    padding: '40px 24px',
  },
  content: {
    maxWidth: 420,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 24,
    margin: 'auto 0',
    animation: 'fadeIn 0.5s ease',
  },
  header: {
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontFamily: theme.font.display,
    fontSize: 48,
    fontWeight: 700,
    color: theme.gold.primary,
    letterSpacing: '6px',
    textShadow: `0 0 30px rgba(212, 168, 67, 0.4)`,
    margin: 0,
  },
  subtitle: {
    fontSize: 16,
    color: theme.text.secondary,
    letterSpacing: '3px',
    textTransform: 'uppercase' as const,
    margin: 0,
  },
  divider: {
    width: 120,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${theme.gold.primary}, transparent)`,
    marginTop: 8,
  },
  oauthSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    width: '100%',
  },
  discordBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '14px 20px',
    fontSize: 16,
    fontWeight: 600,
    borderRadius: theme.radius.md,
    border: 'none',
    cursor: 'pointer',
    background: '#5865F2',
    color: '#ffffff',
    fontFamily: theme.font.body,
    transition: theme.motion.normal,
  },
  googleBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '14px 20px',
    fontSize: 16,
    fontWeight: 600,
    borderRadius: theme.radius.md,
    border: 'none',
    cursor: 'pointer',
    background: theme.text.primary,
    color: theme.bg.deepest,
    fontFamily: theme.font.body,
    transition: theme.motion.normal,
  },
  separator: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
  },
  separatorLine: {
    flex: 1,
    height: 1,
    background: theme.border.default,
  },
  separatorText: {
    fontSize: 11,
    fontFamily: theme.font.display,
    letterSpacing: '3px',
    textTransform: 'uppercase' as const,
    color: theme.gold.dim,
    whiteSpace: 'nowrap' as const,
  },
  formCard: {
    width: '100%',
    background: theme.bg.card,
    border: `1px solid ${theme.border.light}`,
    borderRadius: theme.radius.md,
    padding: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
    position: 'relative' as const,
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    background: theme.bg.deepest,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    fontFamily: theme.font.body,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  toggleText: {
    fontSize: 13,
    color: theme.text.secondary,
    textAlign: 'center' as const,
    margin: 0,
  },
  toggleLink: {
    color: theme.gold.primary,
    cursor: 'pointer',
    fontWeight: 600,
  },
  error: {
    padding: '10px 16px',
    background: theme.state.dangerBg,
    border: `1px solid ${theme.danger}`,
    borderRadius: theme.radius.md,
    color: theme.danger,
    fontSize: 13,
    textAlign: 'center' as const,
  },
  footer: {
    fontSize: 12,
    fontFamily: theme.font.body,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
    letterSpacing: '2px',
  },
};
