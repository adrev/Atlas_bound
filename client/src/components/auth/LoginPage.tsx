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
          <button
            style={styles.appleBtn}
            onClick={() => handleOAuth('apple')}
          >
            <svg width="20" height="24" viewBox="0 0 170 170" fill="currentColor">
              <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.2-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.28 2.13-9.54 3.24-12.8 3.35-4.92.21-9.84-1.96-14.75-6.52-3.13-2.73-7.04-7.41-11.73-14.04-5.03-7.08-9.17-15.29-12.41-24.65-3.47-10.2-5.21-20.07-5.21-29.59 0-10.95 2.36-20.38 7.09-28.3 3.72-6.35 8.67-11.35 14.86-15.03 6.19-3.67 12.88-5.54 20.1-5.63 3.92 0 9.06 1.21 15.43 3.59 6.36 2.39 10.44 3.6 12.24 3.6 1.34 0 5.87-1.42 13.56-4.25 7.27-2.62 13.41-3.71 18.44-3.28 13.63 1.1 23.87 6.47 30.68 16.14-12.19 7.39-18.22 17.73-18.08 31 .13 10.33 3.86 18.94 11.18 25.79 3.33 3.15 7.04 5.59 11.18 7.33-.9 2.6-1.84 5.09-2.86 7.49zM119.11 7.24c0 8.1-2.96 15.67-8.86 22.67-7.12 8.32-15.73 13.13-25.07 12.37a25.2 25.2 0 01-.19-3.07c0-7.77 3.39-16.09 9.4-22.89 3-3.44 6.82-6.31 11.45-8.6 4.62-2.26 8.99-3.51 13.1-3.72.12 1.1.17 2.2.17 3.24z"/>
            </svg>
            Continue with Apple
          </button>
        </div>

        {/* Separator */}
        <div style={styles.separator}>
          <div style={styles.separatorLine} />
          <span style={styles.separatorText}>or sign in</span>
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
              {mode === 'login' ? 'Login' : 'Register'}
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
          KBRT.AI — Your adventure awaits.
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
  appleBtn: {
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
    background: theme.bg.deepest,
    color: theme.text.primary,
    fontFamily: theme.font.body,
    transition: theme.motion.normal,
    boxShadow: `inset 0 0 0 1px ${theme.border.light}`,
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
    fontSize: 13,
    color: theme.text.muted,
    whiteSpace: 'nowrap' as const,
  },
  formCard: {
    width: '100%',
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.lg,
    padding: 24,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
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
    fontSize: 13,
    color: theme.text.muted,
    fontStyle: 'italic',
    margin: 0,
  },
};
