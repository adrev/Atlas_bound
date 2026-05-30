import { useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { theme } from '../../styles/theme';
import { Modal, Button, TextInput } from '../ui';

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Pure validator for the display name field. Returning a string here
 * (the user-visible error) keeps the rule next to the input so it's
 * easy to update; null means valid.
 */
function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Display name is required';
  if (trimmed.length < 2) return 'Display name must be at least 2 characters';
  if (trimmed.length > 32) return 'Display name must be 32 characters or fewer';
  return null;
}

export function ProfileModal({ open, onClose }: ProfileModalProps) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldError = validateDisplayName(displayName);
  const showFieldError = displayNameTouched && fieldError !== null;

  const handleSave = async () => {
    if (fieldError) {
      // Surface the validation error and mark the field touched so the
      // user sees what's wrong without having to blur first.
      setDisplayNameTouched(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ displayName: displayName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user ?? { ...user!, displayName: displayName.trim() });
        onClose();
      } else {
        const err = await res.json().catch(() => ({ message: 'Failed to update profile' }));
        setError(err.message || 'Failed to update profile');
      }
    } catch {
      setError('Network error — could not reach server');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Profile"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving || fieldError !== null}
            title={fieldError ?? undefined}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.lg }}>
        <div>
          <label style={{
            ...theme.type.small,
            color: theme.text.secondary,
            display: 'block',
            marginBottom: theme.space.xs,
          }}>
            Display Name
          </label>
          <TextInput
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => setDisplayNameTouched(true)}
            placeholder="Your display name"
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            aria-invalid={showFieldError || undefined}
            aria-describedby={showFieldError ? 'display-name-error' : undefined}
            autoFocus
          />
          {showFieldError && (
            <div
              id="display-name-error"
              role="alert"
              style={{
                marginTop: theme.space.xs,
                color: theme.danger,
                fontSize: 12,
              }}
            >
              {fieldError}
            </div>
          )}
        </div>
        {error && (
          <div style={{
            padding: '8px 12px',
            background: theme.state.dangerBg,
            border: `1px solid rgba(192, 57, 43, 0.3)`,
            borderRadius: theme.radius.sm,
            color: theme.danger,
            fontSize: 13,
          }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
