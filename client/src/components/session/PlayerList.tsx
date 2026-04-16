import { useEffect, useMemo, useState } from 'react';
import { Crown, Eye, EyeOff, User, Wifi, WifiOff, Ban, UserX, ArrowUpCircle, ArrowDownCircle, RotateCcw, KeyRound } from 'lucide-react';
import type { Player } from '@dnd-vtt/shared';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useMapStore } from '../../stores/useMapStore';
import { getSocket } from '../../socket/client';
import { emitKickPlayer } from '../../socket/emitters';
import {
  banUser, unbanUser, promoteToDM, demoteFromDM, transferOwnership,
} from '../../services/api';
import { theme } from '../../styles/theme';
import { HPBar, askConfirm, askPrompt, showInfo } from '../ui';

/**
 * Players panel with explicit role hierarchy:
 *
 *   Owner   \u2014 session creator. Can promote/demote DMs, transfer
 *             ownership, and use every DM power. Untouchable by others.
 *   DMs     \u2014 co-DMs. Kick/ban players, edit settings. Cannot target
 *             each other (owner must demote first).
 *   Players \u2014 kickable + bannable by any DM.
 *   Banned  \u2014 separate section. All members see it with reasons;
 *             DMs see an Unban button.
 */
export function PlayerList() {
  const players = useSessionStore((s) => s.players);
  const isDM = useSessionStore((s) => s.isDM);
  const isOwner = useSessionStore((s) => s.isOwner);
  const ownerUserId = useSessionStore((s) => s.ownerUserId);
  const myUserId = useSessionStore((s) => s.userId);
  const sessionId = useSessionStore((s) => s.sessionId);
  const bans = useSessionStore((s) => s.bans);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const fogPreviewCharacterId = useMapStore((s) => s.fogPreviewCharacterId);
  const setFogPreview = useMapStore((s) => s.setFogPreview);
  const [viewingTabs, setViewingTabs] = useState<Record<string, string>>({});

  useEffect(() => {
    const socket = getSocket();
    const handler = (data: { userId: string; tab: string }) => {
      setViewingTabs((prev) => ({ ...prev, [data.userId]: data.tab }));
    };
    socket.on('session:player-viewing', handler);
    return () => { socket.off('session:player-viewing', handler); };
  }, []);

  const { ownerRow, coDMs, playerRows } = useMemo(() => {
    const owner = players.find((p) => p.userId === ownerUserId) ?? null;
    const dmRows = players.filter((p) => p.role === 'dm' && p.userId !== ownerUserId);
    const rest = players.filter((p) => p.role !== 'dm');
    return { ownerRow: owner, coDMs: dmRows, playerRows: rest };
  }, [players, ownerUserId]);

  const doKick = async (target: Player) => {
    const ok = await askConfirm({
      title: 'Kick player',
      message: `Kick ${target.displayName}? They'll be removed from the session but can rejoin with the room code (and password if private).`,
      tone: 'danger',
      confirmLabel: 'Kick',
    });
    if (ok) emitKickPlayer(target.userId);
  };

  const doBan = async (target: Player) => {
    if (!sessionId) return;
    const reason = await askPrompt({
      title: `Ban ${target.displayName}?`,
      message: 'Optional reason \u2014 shown publicly in the Banned section.',
      placeholder: 'e.g. griefing the party',
      maxLength: 200,
      allowEmpty: true,
      submitLabel: 'Ban',
    });
    if (reason === null) return;
    try {
      await banUser(sessionId, target.userId, reason || undefined);
    } catch (err) {
      showInfo(err instanceof Error ? err.message : 'Ban failed', 'danger');
    }
  };

  const doPromote = async (target: Player) => {
    if (!sessionId) return;
    try {
      await promoteToDM(sessionId, target.userId);
    } catch (err) {
      showInfo(err instanceof Error ? err.message : 'Promote failed', 'danger');
    }
  };

  const doDemote = async (target: Player) => {
    if (!sessionId) return;
    const ok = await askConfirm({
      title: 'Demote DM',
      message: `Demote ${target.displayName} back to player?`,
      tone: 'danger',
      confirmLabel: 'Demote',
    });
    if (!ok) return;
    try {
      await demoteFromDM(sessionId, target.userId);
    } catch (err) {
      showInfo(err instanceof Error ? err.message : 'Demote failed', 'danger');
    }
  };

  const doTransfer = async (target: Player) => {
    if (!sessionId) return;
    const ok = await askConfirm({
      title: 'Transfer ownership',
      message: `Hand ownership of this session to ${target.displayName}? You'll stay as a co-DM but lose the ability to promote/demote or transfer again.`,
      tone: 'danger',
      confirmLabel: 'Transfer',
    });
    if (!ok) return;
    try {
      await transferOwnership(sessionId, target.userId);
    } catch (err) {
      showInfo(err instanceof Error ? err.message : 'Transfer failed', 'danger');
    }
  };

  const doUnban = async (userId: string, name: string) => {
    if (!sessionId) return;
    const ok = await askConfirm({
      title: 'Unban player',
      message: `Let ${name} rejoin the session? (They'll still need the password if it's private.)`,
      confirmLabel: 'Unban',
    });
    if (!ok) return;
    try {
      await unbanUser(sessionId, userId);
    } catch (err) {
      showInfo(err instanceof Error ? err.message : 'Unban failed', 'danger');
    }
  };

  const renderRow = (player: Player, role: 'owner' | 'dm' | 'player') => {
    const char = player.characterId ? allCharacters[player.characterId] : null;
    const isSelf = player.userId === myUserId;
    return (
      <div key={player.userId} style={styles.player}>
        <div style={styles.avatar}>
          {char?.portraitUrl ? (
            <img src={char.portraitUrl} alt={char.name} style={styles.avatarImg} />
          ) : player.avatarUrl ? (
            <img src={player.avatarUrl} alt={player.displayName} style={styles.avatarImg} />
          ) : (
            <User size={18} color={theme.text.secondary} />
          )}
        </div>
        <div style={styles.info}>
          <div style={styles.nameRow}>
            <span style={styles.name}>{char?.name ?? player.displayName}</span>
            {role === 'owner' && (
              <span style={{ ...styles.roleBadge, ...styles.ownerBadge }}>
                <Crown size={10} /> Owner
              </span>
            )}
            {role === 'dm' && (
              <span style={{ ...styles.roleBadge, ...styles.dmBadge }}>
                <Crown size={10} /> Co-DM
              </span>
            )}
            {isDM && player.characterId && role === 'player' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFogPreview(
                    fogPreviewCharacterId === player.characterId ? null : player.characterId,
                  );
                }}
                title={fogPreviewCharacterId === player.characterId ? 'Hide vision preview' : 'Preview player vision'}
                aria-label={fogPreviewCharacterId === player.characterId ? 'Hide vision preview' : 'Preview player vision'}
                style={{
                  ...styles.iconBtn,
                  ...(fogPreviewCharacterId === player.characterId ? styles.iconBtnActive : {}),
                }}
              >
                {fogPreviewCharacterId === player.characterId ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
          </div>

          {char && (
            <div style={styles.charInfo}>
              {char.race} {char.class} &bull; Lv {char.level}
            </div>
          )}
          {char && (
            <div style={styles.hpRow}>
              <HPBar current={char.hitPoints} max={char.maxHitPoints} size="compact" showNumeric={false} />
              <span style={styles.hpLabel}>{char.hitPoints}/{char.maxHitPoints}</span>
            </div>
          )}

          <div style={styles.status}>
            {player.connected ? (
              <Wifi size={11} color={theme.state.success} />
            ) : (
              <WifiOff size={11} color={theme.text.muted} />
            )}
            <span style={styles.statusLabel}>{player.connected ? 'Online' : 'Offline'}</span>
            {viewingTabs[player.userId] && player.connected && (
              <span style={styles.viewingBadge}>
                {viewingTabs[player.userId].charAt(0).toUpperCase() + viewingTabs[player.userId].slice(1)}
              </span>
            )}
          </div>

          {/* DM actions. Hierarchy rules are mirrored from server-side checks. */}
          {!isSelf && (
            <div style={styles.actions}>
              {isOwner && role === 'player' && (
                <>
                  <ActionBtn label="Promote" tone="gold" icon={<ArrowUpCircle size={11} />} onClick={() => doPromote(player)} />
                </>
              )}
              {isOwner && role === 'dm' && (
                <>
                  <ActionBtn label="Demote" tone="neutral" icon={<ArrowDownCircle size={11} />} onClick={() => doDemote(player)} />
                  <ActionBtn label="Transfer" tone="gold" icon={<RotateCcw size={11} />} onClick={() => doTransfer(player)} />
                </>
              )}
              {isDM && role === 'player' && (
                <>
                  <ActionBtn label="Kick" tone="neutral" icon={<UserX size={11} />} onClick={() => doKick(player)} />
                  <ActionBtn label="Ban" tone="danger" icon={<Ban size={11} />} onClick={() => doBan(player)} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>Owner</h3>
      <div style={styles.list}>
        {ownerRow ? renderRow(ownerRow, 'owner') : (
          <p style={styles.hint}>Owner is not currently in the session.</p>
        )}
      </div>

      {coDMs.length > 0 && (
        <>
          <h3 style={styles.heading}>Co-DMs ({coDMs.length})</h3>
          <div style={styles.list}>
            {coDMs.map((p) => renderRow(p, 'dm'))}
          </div>
        </>
      )}

      <h3 style={styles.heading}>Players ({playerRows.length})</h3>
      <div style={styles.list}>
        {playerRows.map((p) => renderRow(p, 'player'))}
      </div>

      {bans.length > 0 && (
        <>
          <h3 style={{ ...styles.heading, color: theme.state.danger }}>
            Banned ({bans.length})
          </h3>
          <div style={styles.list}>
            {bans.map((b) => (
              <div key={b.userId} style={{ ...styles.player, opacity: 0.85 }}>
                <div style={styles.avatar}>
                  {b.avatarUrl
                    ? <img src={b.avatarUrl} alt={b.displayName} style={styles.avatarImg} />
                    : <User size={18} color={theme.text.muted} />}
                </div>
                <div style={styles.info}>
                  <div style={styles.nameRow}>
                    <span style={{ ...styles.name, color: theme.text.muted, textDecoration: 'line-through' }}>
                      {b.displayName}
                    </span>
                    <span style={{ ...styles.roleBadge, background: 'rgba(231,76,60,0.1)', color: theme.state.danger, borderColor: theme.state.danger }}>
                      <Ban size={10} /> Banned
                    </span>
                  </div>
                  <div style={styles.charInfo}>
                    Banned {b.bannedBy ? `by ${b.bannedBy}` : ''} &middot; {formatWhen(b.bannedAt)}
                  </div>
                  {b.reason && (
                    <div style={styles.banReason}>&ldquo;{b.reason}&rdquo;</div>
                  )}
                  {isDM && (
                    <div style={styles.actions}>
                      <ActionBtn
                        label="Unban"
                        tone="neutral"
                        icon={<KeyRound size={11} />}
                        onClick={() => doUnban(b.userId, b.displayName)}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {isDM && players.length <= 1 && bans.length === 0 && (
        <p style={styles.hint}>Share the room code with your players to invite them.</p>
      )}
    </div>
  );
}

function ActionBtn({
  label, icon, tone, onClick,
}: {
  label: string;
  icon: React.ReactNode;
  tone: 'gold' | 'neutral' | 'danger';
  onClick: () => void;
}) {
  const toneStyle = tone === 'gold'
    ? { background: theme.gold.bg, color: theme.gold.primary, borderColor: theme.gold.border }
    : tone === 'danger'
      ? { background: 'rgba(231,76,60,0.12)', color: theme.state.danger, borderColor: theme.state.danger }
      : { background: theme.bg.deep, color: theme.text.secondary, borderColor: theme.border.default };
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', fontSize: 10, fontWeight: 600,
        borderRadius: theme.radius.sm, cursor: 'pointer',
        fontFamily: theme.font.body,
        ...toneStyle,
      }}
    >
      {icon}{label}
    </button>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const hrs = Math.floor(diffMs / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 16,
  },
  heading: {
    fontSize: 11, fontWeight: 700, color: theme.text.secondary,
    textTransform: 'uppercase', letterSpacing: '1px', margin: '4px 0 0',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  player: {
    display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px',
    borderRadius: theme.radius.md, background: theme.bg.card,
    border: `1px solid ${theme.border.default}`, transition: 'background 0.15s ease',
  },
  avatar: {
    width: 42, height: 42, borderRadius: '50%', background: theme.bg.elevated,
    border: `2px solid ${theme.gold.border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' as const },
  info: {
    display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0,
  },
  nameRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  name: {
    fontSize: 13, fontWeight: 600, color: theme.text.primary,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  roleBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 6px', fontSize: 9, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.5px',
    borderRadius: theme.radius.sm,
    border: '1px solid transparent',
  },
  ownerBadge: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    borderColor: theme.gold.border,
  },
  dmBadge: {
    background: 'rgba(155,89,182,0.15)',
    color: theme.purple,
    borderColor: theme.purple,
  },
  charInfo: { fontSize: 10, color: theme.text.muted },
  hpRow: { display: 'flex', alignItems: 'center', gap: 8 },
  hpLabel: {
    fontSize: 9, fontWeight: 700, color: theme.text.muted,
    fontFamily: 'monospace', whiteSpace: 'nowrap', flexShrink: 0,
  },
  status: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 },
  statusLabel: { fontSize: 10, color: theme.text.muted },
  viewingBadge: {
    fontSize: 9, fontWeight: 600, color: theme.text.muted,
    background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm, padding: '1px 5px', marginLeft: 4,
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, padding: 0, marginLeft: 'auto',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm, background: 'transparent',
    color: theme.text.muted, cursor: 'pointer', flexShrink: 0,
    transition: `all ${theme.motion.fast}`,
  },
  iconBtnActive: {
    background: theme.gold.bg, borderColor: theme.gold.border,
    color: theme.gold.primary, boxShadow: theme.goldGlow.soft,
  },
  actions: { display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 4 },
  banReason: {
    fontSize: 11, color: theme.text.secondary, fontStyle: 'italic' as const,
    marginTop: 2,
  },
  hint: { fontSize: 12, color: theme.text.muted, fontStyle: 'italic', margin: 0, padding: '8px 12px' },
};
