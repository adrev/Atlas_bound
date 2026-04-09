import { useState, useRef } from 'react';
import { Send, MessageSquare, MessageCircle } from 'lucide-react';
import { emitChatMessage, emitWhisper, emitRoll } from '../../socket/emitters';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { theme } from '../../styles/theme';

type ChatMode = 'ic' | 'ooc';

export function ChatInput() {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ChatMode>('ooc');
  const [whisperTarget, setWhisperTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDM = useSessionStore((s) => s.isDM);
  const players = useSessionStore((s) => s.players);
  const character = useCharacterStore((s) => s.myCharacter);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Check for /roll command
    if (trimmed.startsWith('/roll ') || trimmed.startsWith('/r ')) {
      const notation = trimmed.replace(/^\/(roll|r)\s+/, '');
      emitRoll(notation);
      setText('');
      return;
    }

    // Whisper
    if (whisperTarget) {
      emitWhisper(whisperTarget, trimmed);
      setText('');
      setWhisperTarget(null);
      return;
    }

    // Regular message
    emitChatMessage(
      mode,
      trimmed,
      mode === 'ic' ? character?.name : undefined
    );
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={styles.container}>
      {/* Mode toggle + whisper */}
      <div style={styles.controls}>
        <button
          style={{
            ...styles.modeBtn,
            ...(mode === 'ic' ? styles.modeBtnActive : {}),
          }}
          onClick={() => setMode('ic')}
          title="In-Character"
        >
          <MessageSquare size={12} />
          IC
        </button>
        <button
          style={{
            ...styles.modeBtn,
            ...(mode === 'ooc' ? styles.modeBtnActive : {}),
          }}
          onClick={() => setMode('ooc')}
          title="Out-of-Character"
        >
          <MessageCircle size={12} />
          OOC
        </button>
        {/* Whisper toggle */}
        {/* Whisper dropdown - all users can whisper anyone */}
        <select
          style={{
            ...styles.whisperSelect,
            ...(whisperTarget ? styles.whisperActive : {}),
          }}
          value={whisperTarget || ''}
          onChange={(e) => setWhisperTarget(e.target.value || null)}
        >
          <option value="">Whisper...</option>
          {players
            .filter((p) => p.userId !== useSessionStore.getState().userId)
            .sort((a, b) => (a.role === 'dm' ? -1 : b.role === 'dm' ? 1 : 0))
            .map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.role === 'dm' ? `DM (${p.displayName})` : p.displayName}
              </option>
            ))}
        </select>
      </div>

      {/* Whisper indicator */}
      {whisperTarget && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 8px', fontSize: 11, fontWeight: 600,
          background: 'rgba(155, 89, 182, 0.15)', borderRadius: theme.radius.sm,
          color: '${theme.purple}', border: '1px solid rgba(155, 89, 182, 0.3)',
        }}>
          <span>Whispering to: {players.find(p => p.userId === whisperTarget)?.displayName || 'Unknown'}</span>
          <button
            onClick={() => setWhisperTarget(null)}
            style={{ background: 'none', border: 'none', color: '${theme.purple}', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
          >&times;</button>
        </div>
      )}

      {/* Input row */}
      <div style={styles.inputRow}>
        <input
          ref={inputRef}
          style={{
            ...styles.input,
            ...(whisperTarget ? { borderColor: '${theme.purple}', background: 'rgba(155, 89, 182, 0.05)' } : {}),
          }}
          placeholder={
            whisperTarget
              ? `Whisper to ${players.find(p => p.userId === whisperTarget)?.displayName || 'player'}...`
              : mode === 'ic'
              ? `Speak as ${character?.name || 'character'}...`
              : 'Type a message or /roll 1d20...'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          style={styles.sendBtn}
          onClick={handleSend}
          disabled={!text.trim()}
          title="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 12px 12px',
    borderTop: `1px solid ${theme.border.default}`,
    background: theme.bg.base,
  },
  controls: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
  },
  modeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    background: 'transparent',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  modeBtnActive: {
    background: theme.gold.bg,
    borderColor: theme.gold.border,
    color: theme.gold.primary,
  },
  whisperSelect: {
    marginLeft: 'auto',
    padding: '3px 6px',
    fontSize: 11,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    cursor: 'pointer',
    outline: 'none',
    width: 'auto',
  },
  whisperActive: {
    background: 'rgba(155, 89, 182, 0.2)',
    borderColor: '${theme.purple}',
    color: '${theme.purple}',
  },
  whisperActiveBtn: {
    background: 'rgba(155, 89, 182, 0.2)',
    borderColor: '${theme.purple}',
    color: '${theme.purple}',
    marginLeft: 'auto',
  },
  inputRow: {
    display: 'flex',
    gap: 6,
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 13,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    color: theme.text.primary,
    outline: 'none',
  },
  sendBtn: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    color: theme.gold.primary,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    flexShrink: 0,
  },
};
