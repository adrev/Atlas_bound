import { useRef, useState } from 'react';
import { Send, X, Upload } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { getSocket } from '../../socket/client';
import { theme } from '../../styles/theme';
import { Button, showToast } from '../ui';

export function HandoutSender() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [sendToAll, setSendToAll] = useState(true);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const players = useSessionStore((s) => s.players);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Handle file picker: upload the selected image to the handout
   * upload endpoint, then stuff the returned URL into imageUrl so
   * it rides along on the outgoing session:handout payload + the
   * auto-created note row.
   */
  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const resp = await fetch('/api/uploads/handout', { method: 'POST', body: form });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Upload failed' }));
        showToast({ message: `Upload failed: ${err.error || resp.statusText}`, variant: 'danger' });
        return;
      }
      const data = await resp.json() as { url: string };
      setImageUrl(data.url);
      showToast({ message: 'Image attached.', variant: 'success' });
    } catch (err) {
      showToast({ message: `Upload failed: ${err instanceof Error ? err.message : 'unknown'}`, variant: 'danger' });
    } finally {
      setUploading(false);
      // Reset the input so picking the same file again still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

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

        {/* Image — either upload a file or paste a URL. Stored with
            the auto-created note so players see the image when
            browsing past handouts in the Notes tab. */}
        <div style={styles.imageRow}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleFilePicked}
            style={{ display: 'none' }}
          />
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Upload size={12} />}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading…' : imageUrl ? 'Replace image' : 'Upload image'}
          </Button>
          <input
            type="text"
            placeholder="…or paste an image URL"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            style={{ ...styles.input, flex: 1 }}
          />
        </div>
        {imageUrl && (
          <div style={styles.imagePreview}>
            <img
              src={imageUrl}
              alt="Handout preview"
              style={styles.previewImg}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <button
              style={styles.clearImageBtn}
              onClick={() => setImageUrl('')}
              title="Remove image"
            >
              <X size={11} /> Clear
            </button>
          </div>
        )}

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
  imageRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  imagePreview: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    gap: 4,
    padding: 6,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
  },
  previewImg: {
    maxWidth: '100%',
    maxHeight: 160,
    borderRadius: theme.radius.sm,
    objectFit: 'contain' as const,
    display: 'block',
  },
  clearImageBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    fontSize: 10,
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: 4,
    color: theme.text.muted,
    cursor: 'pointer',
  },
};
