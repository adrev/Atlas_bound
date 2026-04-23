import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { getSocket } from '../../socket/client';
import { ChatInput } from './ChatInput';
import { DiceRollCard } from './DiceRollCard';
import { AttackResultCard } from './AttackResultCard';
import { SpellCastCard } from './SpellCastCard';
import type { ChatMessage } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

function MessageBubble({ message }: { message: ChatMessage }) {
  const userId = useSessionStore((s) => s.userId);
  const isMine = message.userId === userId;

  const typeStyles: Record<string, React.CSSProperties> = {
    ic: {
      fontStyle: 'italic',
      borderLeft: `3px solid ${theme.gold.primary}`,
      paddingLeft: 10,
    },
    ooc: {},
    whisper: {
      borderLeft: `3px solid ${theme.purple}`,
      paddingLeft: 10,
      background: 'rgba(155, 89, 182, 0.08)',
    },
    roll: {
      // Styling is handled by DiceRollCard
      padding: 0,
      background: 'transparent',
    },
    system: {
      // Gold-bordered card for spell results / system events. Distinct
      // from the purple "hidden DM roll" styling so users don't confuse
      // public spell math with secret rolls.
      borderLeft: `3px solid ${theme.gold.primary}`,
      paddingLeft: 10,
      paddingRight: 8,
      paddingTop: 6,
      paddingBottom: 6,
      background: theme.gold.bg,
      borderRadius: 4,
      color: theme.text.primary,
      fontSize: 12,
      whiteSpace: 'pre-wrap' as const,
      lineHeight: 1.5,
    },
  };

  const isHidden = !!(message as any).hidden;
  const nameColor =
    isHidden
      ? theme.purple
      : message.type === 'whisper'
      ? theme.purple
      : message.type === 'ic'
      ? theme.gold.primary
      : message.type === 'roll'
      ? theme.gold.primary
      : theme.text.secondary;

  return (
    <div style={{
      ...styles.message, ...typeStyles[message.type],
      ...(isHidden ? { background: 'rgba(155,89,182,0.08)', borderLeft: '2px solid #9b59b6' } : {}),
    }}>
      {message.type !== 'system' && message.type !== 'roll' && (
        <div style={styles.messageHeader}>
          <span style={{ ...styles.messageName, color: nameColor }}>
            {message.type === 'ic' && message.characterName
              ? message.characterName
              : message.displayName}
          </span>
          {message.type === 'whisper' && (
            <span style={styles.whisperLabel}>
              {message.whisperTo ? `whisper` : 'whisper'}
            </span>
          )}
          {isHidden && (
            <span style={{
              fontSize: 9, fontWeight: 700, color: theme.purple,
              background: 'rgba(155,89,182,0.15)', padding: '1px 6px',
              borderRadius: 3, border: '1px solid rgba(155,89,182,0.3)',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>Hidden</span>
          )}
          <span style={styles.messageTime}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      )}

      {message.type === 'roll' && message.rollData ? (
        <DiceRollCard
          rollData={message.rollData}
          content={message.content}
          displayName={message.characterName ?? message.displayName}
          isHidden={isHidden}
        />
      ) : message.type === 'system' && message.attackResult ? (
        // Structured attack breakdown — renders every modifier source,
        // per-source damage, resistances, and HP delta as a card so the
        // DM can verify the math. Falls through to the plain-text
        // renderer below when attackResult is absent (older messages,
        // non-attack system events like !xp, etc.).
        <AttackResultCard result={message.attackResult} />
      ) : message.type === 'system' && message.spellResult ? (
        // Structured spell-cast breakdown — per-target attack/save/heal
        // rows with every modifier and damage source itemised. Used for
        // Fireball, Cure Wounds, Eldritch Blast, Hypnotic Pattern, etc.
        <SpellCastCard result={message.spellResult} />
      ) : message.type === 'system' ? (
        // System messages support multi-line content with explicit \n
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{message.content}</div>
      ) : (
        <p style={styles.messageContent}>{message.content}</p>
      )}
    </div>
  );
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, { displayName: string; timeout: ReturnType<typeof setTimeout> }>>(new Map());
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** Whether the user is currently near the bottom of the chat. */
  const isAtBottomRef = useRef(true);

  const checkScrollPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 100;
    isAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    setShowScrollBtn(false);
  }, []);

  // Auto-scroll on new message only if user is already at the bottom
  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    } else {
      // New message arrived while scrolled up — make sure the button is visible
      setShowScrollBtn(true);
    }
  }, [messages.length]);

  // Listen for typing indicators
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: { userId: string; displayName: string }) => {
      setTypingUsers((prev) => {
        const next = new Map(prev);
        // Clear existing timeout for this user
        const existing = next.get(data.userId);
        if (existing) clearTimeout(existing.timeout);
        // Set new timeout to auto-clear after 3s
        const timeout = setTimeout(() => {
          setTypingUsers((p) => {
            const updated = new Map(p);
            updated.delete(data.userId);
            return updated;
          });
        }, 3000);
        next.set(data.userId, { displayName: data.displayName, timeout });
        return next;
      });
    };
    socket.on('chat:typing', handler);
    return () => {
      socket.off('chat:typing', handler);
      // Clean up all timeouts
      typingUsers.forEach((v) => clearTimeout(v.timeout));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typingNames = Array.from(typingUsers.values()).map((v) => v.displayName);

  return (
    <div style={styles.container}>
      <div style={{ position: 'relative' as const, flex: 1, minHeight: 0 }}>
        <div ref={scrollRef} style={styles.messageList} onScroll={checkScrollPosition}>
          {messages.length === 0 && (
            <p style={styles.empty}>
              No messages yet. Say something!
            </p>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
        {showScrollBtn && (
          <button onClick={scrollToBottom} style={styles.scrollToBottom}>
            &#8595; New messages
          </button>
        )}
      </div>
      {typingNames.length > 0 && (
        <div style={styles.typingIndicator}>
          {typingNames.length === 1
            ? `${typingNames[0]} is typing...`
            : `${typingNames.join(', ')} are typing...`}
        </div>
      )}
      <ChatInput />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  messageList: {
    position: 'absolute' as const,
    inset: 0,
    overflow: 'auto',
    padding: '12px 12px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  typingIndicator: {
    padding: '4px 12px',
    fontSize: 11,
    color: theme.text.muted,
    fontStyle: 'italic',
  },
  empty: {
    color: theme.text.muted,
    fontSize: 13,
    textAlign: 'center',
    padding: 20,
    margin: 0,
  },
  message: {
    padding: '6px 8px',
    borderRadius: theme.radius.sm,
    animation: 'slideUp 0.15s ease',
  },
  messageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  messageName: {
    fontSize: 12,
    fontWeight: 700,
  },
  whisperLabel: {
    fontSize: 10,
    color: theme.purple,
    fontStyle: 'italic',
  },
  messageTime: {
    fontSize: 10,
    color: theme.text.muted,
    marginLeft: 'auto',
  },
  messageContent: {
    fontSize: 13,
    color: theme.text.primary,
    margin: 0,
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  scrollToBottom: {
    position: 'absolute' as const,
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '4px 14px',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: theme.gold.primary,
    background: theme.bg.card,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: 16,
    cursor: 'pointer',
    boxShadow: theme.shadow.md,
    zIndex: 5,
    whiteSpace: 'nowrap' as const,
    transition: `opacity ${theme.motion.fast}`,
  },
};
