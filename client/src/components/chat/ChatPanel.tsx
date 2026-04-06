import { useEffect, useRef } from 'react';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { ChatInput } from './ChatInput';
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
      borderLeft: `3px solid ${theme.gold.primary}`,
      paddingLeft: 10,
      background: theme.gold.bg,
    },
    system: {
      textAlign: 'center' as const,
      fontStyle: 'italic',
      color: theme.text.muted,
      fontSize: 12,
    },
  };

  const nameColor =
    message.type === 'whisper'
      ? theme.purple
      : message.type === 'ic'
      ? theme.gold.primary
      : message.type === 'roll'
      ? theme.gold.primary
      : theme.text.secondary;

  return (
    <div style={{ ...styles.message, ...typeStyles[message.type] }}>
      {message.type !== 'system' && (
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
          <span style={styles.messageTime}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      )}

      {message.type === 'roll' && message.rollData ? (
        <div style={styles.rollContent}>
          <span style={styles.rollTotal}>{message.rollData.total}</span>
          <span style={styles.rollNotation}>{message.rollData.notation}</span>
          <span style={styles.rollBreakdown}>
            [{message.rollData.dice.map((d) => d.value).join(', ')}]
            {message.rollData.modifier !== 0 &&
              ` ${message.rollData.modifier > 0 ? '+' : ''}${message.rollData.modifier}`}
          </span>
          {message.rollData.reason && (
            <span style={styles.rollReason}>{message.rollData.reason}</span>
          )}
        </div>
      ) : (
        <p style={styles.messageContent}>{message.content}</p>
      )}
    </div>
  );
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div style={styles.container}>
      <div ref={scrollRef} style={styles.messageList}>
        {messages.length === 0 && (
          <p style={styles.empty}>
            No messages yet. Say something!
          </p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </div>
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
    flex: 1,
    overflow: 'auto',
    padding: '12px 12px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
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
  rollContent: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
  },
  rollTotal: {
    fontSize: 20,
    fontWeight: 700,
    color: theme.gold.primary,
    fontFamily: theme.font.display,
  },
  rollNotation: {
    fontSize: 12,
    color: theme.text.secondary,
    fontFamily: 'monospace',
  },
  rollBreakdown: {
    fontSize: 11,
    color: theme.text.muted,
    fontFamily: 'monospace',
  },
  rollReason: {
    fontSize: 11,
    color: theme.text.secondary,
    fontStyle: 'italic',
    width: '100%',
  },
};
