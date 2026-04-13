import { useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { theme } from '../../styles/theme';
import { Modal, Button, TextInput } from '../ui';

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
}

export function ProfileModal({ open, onClose }: ProfileModalProps) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!displayName.trim()) return;
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
            disabled={saving || !displayName.trim()}
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
            placeholder="Your display name"
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
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
