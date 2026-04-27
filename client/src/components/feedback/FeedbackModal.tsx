import { useEffect, useState } from 'react';
import { Lightbulb, Send } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Textarea, Select, FieldGroup } from '../ui/TextInput';
import { showToast } from '../ui/Toast';
import { theme } from '../../styles/theme';
import { useSessionStore } from '../../stores/useSessionStore';
import { APP_VERSION } from '../../constants/app-version';

const CATEGORIES: { value: FeedbackCategory; label: string; emoji: string; helper: string }[] = [
  { value: 'bug',     label: 'Bug',     emoji: '🐞', helper: 'Something is broken or behaving incorrectly.' },
  { value: 'feature', label: 'Feature', emoji: '✨', helper: 'I want a new capability that does not exist yet.' },
  { value: 'ux',      label: 'UX',      emoji: '🎨', helper: 'It works, but the experience could be better.' },
  { value: 'other',   label: 'Other',   emoji: '💬', helper: 'A general note that does not fit elsewhere.' },
];

type FeedbackCategory = 'bug' | 'feature' | 'ux' | 'other';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Free-form feedback modal. Capture: category, free text (5-5000 chars),
 * optional anonymous toggle. Auto-attach: page URL, browser UA, app
 * version, current sessionId. POSTs to /api/feedback. Server rate-
 * limits to 5 submissions per user per 24 h and rejects payloads
 * outside the schema; we surface those errors inline.
 */
export function FeedbackModal({ open, onClose }: Props) {
  const sessionId = useSessionStore((s) => s.sessionId);

  const [category, setCategory] = useState<FeedbackCategory>('feature');
  const [content, setContent] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the modal closes — next open should be blank.
  useEffect(() => {
    if (!open) {
      setCategory('feature');
      setContent('');
      setAnonymous(false);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmedLength = content.trim().length;
  const canSubmit = trimmedLength >= 5 && trimmedLength <= 5000 && !submitting;

  const helper = CATEGORIES.find((c) => c.value === category)?.helper ?? '';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          category,
          content: content.trim(),
          pageUrl: window.location.href.slice(0, 500),
          browser: navigator.userAgent.slice(0, 500),
          appVersion: APP_VERSION,
          sessionId: sessionId || undefined,
          anonymous,
        }),
      });

      if (res.ok) {
        showToast({
          message: 'Thanks — your feedback has been recorded.',
          variant: 'success',
          emoji: '💡',
        });
        onClose();
        return;
      }

      // Specific server errors (rate limit, validation) surface inline.
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setError(data.error ?? 'You have reached today’s feedback limit. Try again tomorrow.');
      } else if (res.status === 400) {
        setError(data.details?.[0]?.message ?? data.error ?? 'Submission rejected — please review your input.');
      } else if (res.status === 401) {
        setError('You must be signed in to send feedback.');
      } else {
        setError(data.error ?? 'Could not send feedback. Try again in a moment.');
      }
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send feedback"
      subtitle="Suggest a feature, flag a bug, or tell us what felt off."
      emoji="💡"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!canSubmit}
            leadingIcon={<Send size={14} />}
          >
            Send
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.lg }}>
        <FieldGroup label="Type" helperText={helper}>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.emoji}  {c.label}
              </option>
            ))}
          </Select>
        </FieldGroup>

        <FieldGroup
          label={`Your message (${trimmedLength}/5000)`}
          helperText={
            trimmedLength < 5
              ? 'At least 5 characters.'
              : trimmedLength > 5000
              ? 'Trim down to 5000 characters or fewer.'
              : 'Be specific — page, action, what you expected, what happened.'
          }
          error={trimmedLength > 0 && (trimmedLength < 5 || trimmedLength > 5000)}
        >
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            placeholder="What did you try? What did you expect? What happened?"
            maxLength={5000}
            autoFocus
            error={trimmedLength > 0 && (trimmedLength < 5 || trimmedLength > 5000)}
          />
        </FieldGroup>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space.sm,
            cursor: 'pointer',
            fontSize: 12,
            color: theme.text.secondary,
          }}
        >
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
            style={{ accentColor: theme.gold.primary }}
          />
          Hide my name from the admin queue (your account is still attached for rate-limiting).
        </label>

        {/* Auto-captured metadata preview — quietly shown so users
            know what is being attached. No PII beyond the URL of
            the page they were on. */}
        <div
          style={{
            ...theme.type.small,
            color: theme.text.muted,
            background: theme.bg.deepest,
            border: `1px dashed ${theme.border.default}`,
            borderRadius: theme.radius.sm,
            padding: theme.space.md,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: theme.gold.dim }}>
            <Lightbulb size={12} />
            <span>Auto-attached for context:</span>
          </div>
          <div>Page: <span style={{ color: theme.text.secondary }}>{window.location.pathname}</span></div>
          <div>App version: <span style={{ color: theme.text.secondary }}>{APP_VERSION}</span></div>
          {sessionId && (
            <div>Session: <span style={{ color: theme.text.secondary }}>{sessionId.slice(0, 8)}…</span></div>
          )}
        </div>

        {error && (
          <div
            style={{
              padding: theme.space.md,
              background: theme.state.dangerBg,
              border: `1px solid ${theme.state.danger}`,
              borderRadius: theme.radius.sm,
              color: theme.state.danger,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
