import { useState } from 'react';
import { Send, X } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { getSocket } from '../../socket/client';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

export function HandoutSender() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [sendToAll, setSendToAll] = useState(true);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const players = useSessionStore((s) => s.players);

  const connectedPlayers = players.filter((p) => p.role !== 'dm' && p.connected);

  const handleSend = () => {
    if (!title.trim()) return;
    const data: Record<string, unknown> = {
      title: title.trim(),
      content: content.trim() || undefined,
      imageUrl: imageUrl.trim() || undefined,
    };
    if (!sendToAll && selectedPlayers.size > 0) {
      data.targetUserIds = Array.from(selectedPlayers);
    }
    getSocket().emit('session:handout' as any, data);

    // Reset form
    setTitle('');
    setContent('');
    setImageUrl('');
    setSelectedPlayers(new Set());
    setSendToAll(true);
    setOpen(false);
  };

  const togglePlayer = (userId: string) => {
    setSelectedPlayers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  if (!open) {
    return (
      <Button
        variant="primary"
        size="md"
        fullWidth
        leadingIcon={<Send size={14} />}
        onClick={() => setOpen(true)}
      >
        Send Handout
      </Button>
    );
  }

  return (
    <div style={styles.modal}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Send Handout</span>
        <button style={styles.closeBtn} onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </div>

      <div style={styles.body}>
        <input
          type="text"
          placeholder="Handout title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={styles.input}
          autoFocus
        />

        <textarea
          placeholder="Content (optional)..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={styles.textarea}
          rows={4}
        />

        <input
          type="text"
          placeholder="Image URL (optional)..."
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          style={styles.input}
        />

        {/* Player selector */}
        <div style={styles.playerSection}>
          <label style={styles.checkLabel}>
            <input
              type="checkbox"
              checked={sendToAll}
              onChange={() => setSendToAll(!sendToAll)}
              style={{ accentColor: theme.gold.primary }}
            />
            <span>Send to all players</span>
          </label>

          <div style={styles.playerList}>
            {connectedPlayers.map((p) => (
              <label key={p.userId} style={{
                ...styles.checkLabel,
                opacity: sendToAll ? 0.5 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={sendToAll || selectedPlayers.has(p.userId)}
                  onChange={() => togglePlayer(p.userId)}
                  disabled={sendToAll}
                  style={{ accentColor: theme.gold.primary }}
                />
                <span>{p.displayName}</span>
              </label>
            ))}
            {connectedPlayers.length === 0 && (
              <span style={{ fontSize: 11, color: theme.text.muted }}>
                No players connected
              </span>
            )}
          </div>
        </div>

        <Button
          variant="primary"
          size="md"
          fullWidth
          leadingIcon={<Send size={13} />}
          onClick={handleSend}
          disabled={!title.trim()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  modal: {
    background: theme.bg.card,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: `1px solid ${theme.border.default}`,
    background: theme.gold.bg,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: theme.gold.primary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    background: 'none',
    border: 'none',
    color: theme.text.muted,
    cursor: 'pointer',
  },
  body: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: 12,
  },
  input: {
    width: '100%',
    padding: '6px 10px',
    fontSize: 13,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  textarea: {
    width: '100%',
    padding: '6px 10px',
    fontSize: 12,
    lineHeight: 1.5,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    outline: 'none',
    resize: 'vertical' as const,
    fontFamily: theme.font.body,
    boxSizing: 'border-box' as const,
  },
  playerSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  checkLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: theme.text.secondary,
    cursor: 'pointer',
  },
  playerList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    paddingLeft: 16,
  },
};
