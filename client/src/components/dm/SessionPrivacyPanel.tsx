import { useState } from 'react';
import type { CSSProperties } from 'react';
import { patchSession, deleteSession } from '../../services/api';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitUpdateSettings } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import { Button, FieldGroup, TextInput, showToast, askConfirm } from '../ui';

export function SessionPrivacyPanel() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const visibility = useSessionStore((s) => s.visibility);
  const hasPassword = useSessionStore((s) => s.hasPassword);
  const inviteCode = useSessionStore((s) => s.inviteCode);
  const isOwner = useSessionStore((s) => s.isOwner);
  const updatePrivacy = useSessionStore((s) => s.updatePrivacy);
  const settings = useSessionStore((s) => s.settings);
  const allowPlayerRest = settings.allowPlayerRest ?? true;
  const showCreatureStatsToPlayers = settings.showCreatureStatsToPlayers ?? true;
  const showPlayersToPlayers = settings.showPlayersToPlayers ?? true;
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleDelete() {
    if (!sessionId) return;
    const ok = await askConfirm({
      title: 'Delete session',
      message: 'This removes the session, every map, token, drawing, and loot bag. Anyone currently connected will be kicked to the lobby. This cannot be undone.',
      confirmLabel: 'Delete forever',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await deleteSession(sessionId);
      // The `session:deleted` socket event drives the redirect; if
      // somehow we don't receive it (network hiccup), push anyway.
      setTimeout(() => { window.location.href = '/'; }, 500);
    } catch (err) {
      showToast({
        variant: 'danger',
        message: err instanceof Error ? err.message : 'Could not delete session.',
      });
    }
  }

  const inviteUrl = inviteCode && typeof window !== 'undefined'
    ? `${window.location.origin}/join/${inviteCode}`
    : null;

  async function savePrivacy(patch: Parameters<typeof patchSession>[1], successMessage: string): Promise<boolean> {
    if (!sessionId || saving) return false;
    setSaving(true);
    try {
      const next = await patchSession(sessionId, patch);
      updatePrivacy(next);
      showToast({ variant: 'success', message: successMessage });
      return true;
    } catch (err) {
      showToast({
        variant: 'danger',
        message: err instanceof Error ? err.message : 'Could not update session privacy.',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showToast({ variant: 'success', message: 'Invite link copied.' });
    } catch {
      showToast({ variant: 'warning', message: 'Could not copy invite link.' });
    }
  }

  const canSetPassword = password.trim().length >= 4;

  return (
    <div style={styles.panel}>
      <p style={styles.hint}>
        Private sessions require either a password or this DM-only invite link.
      </p>

      <div style={styles.toggleRow} role="radiogroup" aria-label="Session visibility">
        <button
          type="button"
          onClick={() => savePrivacy({ visibility: 'public' }, 'Session is now public.')}
          disabled={saving || visibility === 'public'}
          style={{
            ...styles.toggleButton,
            ...(visibility === 'public' ? styles.toggleButtonActive : {}),
          }}
        >
          Public
        </button>
        <button
          type="button"
          onClick={() => savePrivacy({ visibility: 'private' }, 'Session is now private.')}
          disabled={saving || visibility === 'private'}
          style={{
            ...styles.toggleButton,
            ...(visibility === 'private' ? styles.toggleButtonActive : {}),
          }}
        >
          Private
        </button>
      </div>

      <FieldGroup
        label="Invite Link"
        helperText={inviteUrl ? 'Anyone with this link can join without the password.' : 'Generate a link when you are ready to invite players.'}
      >
        <div style={styles.inlineRow}>
          <TextInput
            value={inviteUrl ?? ''}
            readOnly
            placeholder="No invite link yet"
            size="sm"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={copyInvite}
            disabled={!inviteUrl || saving}
          >
            Copy
          </Button>
        </div>
      </FieldGroup>

      <Button
        variant="ghost"
        size="sm"
        fullWidth
        loading={saving}
        onClick={() => savePrivacy({ regenerateInvite: true }, 'Invite link regenerated.')}
      >
        Regenerate Invite Link
      </Button>

      <FieldGroup
        label="Password"
        helperText={hasPassword ? 'A password is currently set.' : 'No password is set.'}
      >
        <div style={styles.inlineRow}>
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password, 4+ chars"
            size="sm"
          />
          <Button
            variant="ghost"
            size="sm"
            loading={saving}
            disabled={!canSetPassword}
            onClick={async () => {
              const saved = await savePrivacy({ visibility: 'private', password: password.trim() }, 'Password updated.');
              if (saved) setPassword('');
            }}
          >
            Set
          </Button>
        </div>
      </FieldGroup>

      {hasPassword && (
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          loading={saving}
          onClick={() => savePrivacy({ password: '' }, 'Password removed.')}
        >
          Remove Password
        </Button>
      )}

      <div style={styles.permissionsGroup}>
        <div style={styles.permissionsHeader}>Player Permissions</div>
        <PermissionToggle
          label="Allow player rests"
          helper="Players can trigger Short / Long Rest from the bottom bar."
          checked={allowPlayerRest}
          onChange={(v) => emitUpdateSettings({ allowPlayerRest: v })}
        />
        <PermissionToggle
          label="Show creature stats to players"
          helper="Players can open NPC character sheets to inspect attacks and spells."
          checked={showCreatureStatsToPlayers}
          onChange={(v) => emitUpdateSettings({ showCreatureStatsToPlayers: v })}
        />
        <PermissionToggle
          label="Show player sheets to other players"
          helper="Party members can open each other's character sheets."
          checked={showPlayersToPlayers}
          onChange={(v) => emitUpdateSettings({ showPlayersToPlayers: v })}
        />
      </div>

      {isOwner && (
        <div style={styles.dangerZone}>
          <p style={styles.dangerHint}>
            Deleting the session removes every map, token, and note. Transfer
            ownership instead if you want to step away.
          </p>
          <Button
            variant="danger"
            size="sm"
            fullWidth
            onClick={handleDelete}
          >
            Delete Session
          </Button>
        </div>
      )}
    </div>
  );
}

function PermissionToggle({
  label,
  helper,
  checked,
  onChange,
}: {
  label: string;
  helper: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={styles.permissionRow}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={styles.permissionCheckbox}
      />
      <span style={styles.permissionText}>
        <span style={styles.permissionLabel}>{label}</span>
        <span style={styles.permissionHelper}>{helper}</span>
      </span>
    </label>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.md,
  },
  hint: {
    margin: 0,
    color: theme.text.secondary,
    fontSize: 12,
    lineHeight: 1.4,
  },
  toggleRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: theme.space.sm,
  },
  toggleButton: {
    padding: `${theme.space.sm}px ${theme.space.md}px`,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.deep,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontFamily: theme.font.body,
    fontSize: 12,
    fontWeight: 700,
  },
  toggleButtonActive: {
    borderColor: theme.gold.primary,
    background: theme.gold.bg,
    color: theme.gold.bright,
    boxShadow: theme.goldGlow.soft,
  },
  inlineRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: theme.space.sm,
    alignItems: 'center',
  },
  permissionsGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: theme.space.sm,
    padding: `${theme.space.sm}px 0`,
    borderTop: `1px solid ${theme.border.default}`,
    borderBottom: `1px solid ${theme.border.default}`,
  },
  permissionsHeader: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: theme.gold.primary,
    marginBottom: theme.space.xs,
  },
  permissionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.space.sm,
    padding: `${theme.space.xs}px ${theme.space.sm}px`,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    cursor: 'pointer',
  },
  permissionCheckbox: {
    width: 16,
    height: 16,
    marginTop: 2,
    accentColor: theme.gold.primary,
    cursor: 'pointer',
    flexShrink: 0,
  },
  permissionText: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  permissionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.primary,
  },
  permissionHelper: {
    fontSize: 10,
    color: theme.text.muted,
    lineHeight: 1.4,
  },
  dangerZone: {
    marginTop: theme.space.md,
    paddingTop: theme.space.md,
    borderTop: `1px solid ${theme.state.danger}`,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: theme.space.sm,
  },
  dangerHint: {
    margin: 0,
    color: theme.text.muted,
    fontSize: 11,
    lineHeight: 1.4,
  },
};
