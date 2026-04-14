import { useState, useEffect, useCallback } from 'react';
import { Plus, Eye, EyeOff, Trash2 } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { theme } from '../../styles/theme';
import { Button } from '../ui';

interface Note {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  category: string;
  isShared: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

type CategoryFilter = 'all' | 'npc' | 'location' | 'quest' | 'session-recap';

const CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  npc: 'NPC',
  location: 'Location',
  quest: 'Quest',
  loot: 'Loot',
  'session-recap': 'Recap',
};

const CATEGORY_COLORS: Record<string, string> = {
  general: theme.text.muted,
  npc: theme.purple,
  location: theme.blue,
  quest: theme.gold.primary,
  loot: theme.state.success,
  'session-recap': theme.state.warning,
};

const FILTER_TABS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'npc', label: 'NPCs' },
  { id: 'location', label: 'Locations' },
  { id: 'quest', label: 'Quests' },
  { id: 'session-recap', label: 'Recaps' },
];

export function NotesPanel() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const isDM = useSessionStore((s) => s.isDM);
  const [notes, setNotes] = useState<Note[]>([]);
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('general');

  const fetchNotes = useCallback(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/notes`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Note[]) => setNotes(data))
      .catch(() => setNotes([]));
  }, [sessionId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  const handleCreate = async () => {
    if (!sessionId || !newTitle.trim()) return;
    const resp = await fetch(`/api/sessions/${sessionId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), category: newCategory }),
    });
    if (resp.ok) {
      const note = await resp.json();
      setNotes((prev) => [note, ...prev]);
      setNewTitle('');
      setNewCategory('general');
      setCreating(false);
      setExpandedId(note.id);
      setEditContent('');
    }
  };

  const handleSave = async (noteId: string) => {
    await fetch(`/api/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editContent }),
    });
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, content: editContent } : n)),
    );
  };

  const handleDelete = async (noteId: string) => {
    await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (expandedId === noteId) setExpandedId(null);
  };

  const handleToggleShare = async (noteId: string) => {
    const resp = await fetch(`/api/notes/${noteId}/share`, { method: 'PATCH' });
    if (resp.ok) {
      const { isShared } = await resp.json();
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, isShared } : n)),
      );
    }
  };

  const handleExpand = (note: Note) => {
    if (expandedId === note.id) {
      setExpandedId(null);
    } else {
      setExpandedId(note.id);
      setEditContent(note.content);
    }
  };

  const filtered =
    filter === 'all'
      ? notes
      : notes.filter((n) => n.category === filter);

  return (
    <div style={styles.container}>
      {/* Category filter tabs */}
      <div style={styles.filterBar}>
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            style={{
              ...styles.filterTab,
              ...(filter === tab.id ? styles.filterTabActive : {}),
            }}
            onClick={() => setFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* New Note button (DM only) */}
      {isDM && !creating && (
        <div style={{ padding: '8px 12px 0' }}>
          <Button
            variant="primary"
            size="sm"
            fullWidth
            leadingIcon={<Plus size={13} />}
            onClick={() => setCreating(true)}
          >
            New Note
          </Button>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div style={styles.createForm}>
          <input
            type="text"
            placeholder="Note title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
            style={styles.input}
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            style={styles.select}
          >
            {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
              <option key={val} value={val}>
                {label}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" size="sm" onClick={handleCreate} disabled={!newTitle.trim()}>
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Notes list */}
      <div style={styles.notesList}>
        {filtered.length === 0 && (
          <div style={styles.empty}>
            <p style={{ color: theme.text.muted, fontSize: 12, margin: 0 }}>
              {isDM ? 'No notes yet. Create one to get started.' : 'No shared notes from the DM yet.'}
            </p>
          </div>
        )}
        {filtered.map((note) => {
          const isExpanded = expandedId === note.id;
          return (
            <div key={note.id} style={styles.noteCard}>
              {/* Header row */}
              <div
                style={styles.noteHeader}
                onClick={() => handleExpand(note)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.noteTitle}>{note.title}</div>
                  <div style={styles.noteMeta}>
                    <span
                      style={{
                        ...styles.badge,
                        color: CATEGORY_COLORS[note.category] || theme.text.muted,
                        borderColor: CATEGORY_COLORS[note.category] || theme.border.default,
                      }}
                    >
                      {CATEGORY_LABELS[note.category] || note.category}
                    </span>
                    {isDM && (
                      <span
                        style={{
                          ...styles.badge,
                          color: note.isShared ? theme.state.success : theme.text.muted,
                          borderColor: note.isShared
                            ? 'rgba(46,204,113,0.3)'
                            : theme.border.default,
                        }}
                      >
                        {note.isShared ? 'Shared' : 'Private'}
                      </span>
                    )}
                  </div>
                </div>
                {isDM && (
                  <div style={styles.noteActions} onClick={(e) => e.stopPropagation()}>
                    <button
                      style={styles.iconBtn}
                      title={note.isShared ? 'Make private' : 'Share with players'}
                      onClick={() => handleToggleShare(note.id)}
                    >
                      {note.isShared ? <Eye size={14} color={theme.state.success} /> : <EyeOff size={14} color={theme.text.muted} />}
                    </button>
                    <button
                      style={styles.iconBtn}
                      title="Delete note"
                      onClick={() => handleDelete(note.id)}
                    >
                      <Trash2 size={14} color={theme.danger} />
                    </button>
                  </div>
                )}
              </div>

              {/* Preview (collapsed) */}
              {!isExpanded && note.content && (
                <div
                  style={styles.preview}
                  onClick={() => handleExpand(note)}
                >
                  {note.content.slice(0, 120)}
                  {note.content.length > 120 ? '...' : ''}
                </div>
              )}

              {/* Expanded editor / viewer */}
              {isExpanded && (
                <div style={styles.expandedContent}>
                  {isDM ? (
                    <>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        style={styles.textarea}
                        rows={6}
                        placeholder="Write your notes here..."
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleSave(note.id)}
                        style={{ alignSelf: 'flex-end' }}
                      >
                        Save
                      </Button>
                    </>
                  ) : (
                    <div style={styles.readOnlyContent}>
                      {note.content || 'No content yet.'}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  filterBar: {
    display: 'flex',
    gap: 2,
    padding: '8px 8px 4px',
    borderBottom: `1px solid ${theme.border.default}`,
    flexShrink: 0,
    overflowX: 'auto',
  },
  filterTab: {
    padding: '4px 8px',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    background: 'transparent',
    border: `1px solid transparent`,
    borderRadius: theme.radius.sm,
    color: theme.text.muted,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    transition: `all ${theme.motion.fast}`,
  },
  filterTabActive: {
    color: theme.gold.primary,
    background: theme.gold.bg,
    borderColor: theme.gold.border,
  },
  createForm: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: '10px 12px',
    borderBottom: `1px solid ${theme.border.default}`,
    background: theme.bg.card,
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
  select: {
    width: '100%',
    padding: '6px 10px',
    fontSize: 12,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  notesList: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '8px 8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    textAlign: 'center' as const,
  },
  noteCard: {
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  noteHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    cursor: 'pointer',
    transition: `background ${theme.motion.fast}`,
  },
  noteTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.text.primary,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  noteMeta: {
    display: 'flex',
    gap: 4,
    marginTop: 2,
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    border: '1px solid',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  noteActions: {
    display: 'flex',
    gap: 4,
    flexShrink: 0,
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  preview: {
    padding: '0 10px 8px',
    fontSize: 11,
    color: theme.text.muted,
    lineHeight: 1.5,
    cursor: 'pointer',
  },
  expandedContent: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '0 10px 10px',
  },
  textarea: {
    width: '100%',
    padding: '8px 10px',
    fontSize: 12,
    lineHeight: 1.6,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.primary,
    outline: 'none',
    resize: 'vertical' as const,
    fontFamily: theme.font.body,
    boxSizing: 'border-box' as const,
  },
  readOnlyContent: {
    fontSize: 12,
    lineHeight: 1.6,
    color: theme.text.secondary,
    whiteSpace: 'pre-wrap' as const,
    padding: '4px 0',
  },
};
