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
            src="/atlas-bound-logo.png"
            alt="Atlas Bound"
            style={{ width: 120, height: 120, borderRadius: '50%', marginBottom: 12 }}
          />
          <h1 style={styles.title}>ATLAS BOUND</h1>
          <p style={styles.subtitle}>Online D&D Platform</p>
          <div style={styles.divider} />
        </div>

        {/* OAuth Buttons */}
        <div style={styles.oauthSection}>
          <button
            style={styles.discordBtn}
            onClick={() => handleOAuth('discord')}
          >
            Continue with Discord
          </button>
          <button
            style={styles.googleBtn}
            onClick={() => handleOAuth('google')}
          >
            Continue with Google
          </button>
          <button
            style={styles.appleBtn}
            onClick={() => handleOAuth('apple')}
          >
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
          Atlas Bound — Your adventure awaits.
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
    background: theme.purple,
    color: theme.text.primary,
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
