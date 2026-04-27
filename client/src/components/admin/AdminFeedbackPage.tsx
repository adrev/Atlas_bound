import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Filter, MessageSquare, Bug, Sparkles, Wand2, ExternalLink } from 'lucide-react';
import { theme } from '../../styles/theme';
import { useAuthStore } from '../../stores/useAuthStore';
import { Button, Select, Textarea, Badge, Card, Section, FieldGroup } from '../ui';
import { showToast } from '../ui/Toast';

/**
 * /admin/feedback — admin-only review panel for user-submitted feedback.
 *
 * Auth model: server-side `requireAdmin` enforces access (the
 * admin-only routes return 403 to non-admins, which lands the user
 * back at the lobby). The client uses `auth.user.isAdmin` purely as
 * a UI hint to skip the loading flash.
 *
 * Layout: a left list (filterable) + right detail/edit pane. Status
 * dropdown + admin-notes textarea persist through PATCH on save.
 */

type FeedbackCategory = 'bug' | 'feature' | 'ux' | 'other';
type FeedbackStatus = 'open' | 'triaged' | 'planned' | 'shipped' | 'wontfix';

interface FeedbackEntry {
  id: string;
  userId: string | null;
  userDisplayName: string | null;
  userEmail: string | null;
  sessionId: string | null;
  category: FeedbackCategory;
  content: string;
  pageUrl: string | null;
  browser: string | null;
  appVersion: string | null;
  screenshotUrl: string | null;
  anonymous: boolean;
  status: FeedbackStatus;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  open:     'Open',
  triaged:  'Triaged',
  planned:  'Planned',
  shipped:  'Shipped',
  wontfix:  'Won\u2019t Fix',
};

// Map feedback status onto the existing Badge variants. Keep the
// "open" state highlight gold so it's the obvious eye-magnet
// the moment the panel opens.
const STATUS_VARIANT: Record<FeedbackStatus, 'gold' | 'success' | 'info' | 'warning' | 'danger'> = {
  open:    'gold',
  triaged: 'info',
  planned: 'warning',
  shipped: 'success',
  wontfix: 'danger',
};

const CATEGORY_ICON: Record<FeedbackCategory, React.ReactNode> = {
  bug:     <Bug size={12} />,
  feature: <Sparkles size={12} />,
  ux:      <Wand2 size={12} />,
  other:   <MessageSquare size={12} />,
};

export function AdminFeedbackPage() {
  const navigate = useNavigate();
  const authUser = useAuthStore((s) => s.user);

  const [items, setItems] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState<'' | FeedbackStatus>('');
  const [filterCategory, setFilterCategory] = useState<'' | FeedbackCategory>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<FeedbackStatus>('open');
  const [draftNotes, setDraftNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Initial fetch + re-fetch whenever filters change.
  const fetchFeedback = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterCategory) params.set('category', filterCategory);
      params.set('limit', '200');
      const res = await fetch(`/api/admin/feedback?${params.toString()}`, {
        credentials: 'include',
      });
      if (res.status === 403) {
        setError('You do not have admin access.');
        setItems([]);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Failed to load feedback (${res.status})`);
        return;
      }
      const data = await res.json();
      setItems(data.feedback ?? []);
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterCategory]);

  // Whenever the selected entry or list changes, reseed the right-pane
  // editable fields from the canonical record so unsaved drafts don't
  // persist across selection changes.
  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  );

  useEffect(() => {
    if (selected) {
      setDraftStatus(selected.status);
      setDraftNotes(selected.adminNotes ?? '');
    } else {
      setDraftStatus('open');
      setDraftNotes('');
    }
  }, [selected?.id, selected?.status, selected?.adminNotes]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/feedback/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          status: draftStatus,
          adminNotes: draftNotes,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast({
          message: data.error ?? `Save failed (${res.status})`,
          variant: 'danger',
        });
        return;
      }
      // Optimistic local update so the list reflects new status without re-fetching.
      setItems((prev) =>
        prev.map((it) =>
          it.id === selected.id
            ? { ...it, status: draftStatus, adminNotes: draftNotes }
            : it,
        ),
      );
      showToast({ message: 'Feedback updated', variant: 'success' });
    } catch {
      showToast({ message: 'Network error — could not save', variant: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<FeedbackStatus, number> = {
      open: 0, triaged: 0, planned: 0, shipped: 0, wontfix: 0,
    };
    for (const it of items) c[it.status]++;
    return c;
  }, [items]);

  // Optimistic redirect for non-admins. The fetch itself will get a
  // 403 anyway; this is only for cleaner UX so the panel doesn't
  // flash if the user typed /admin/feedback by hand.
  if (authUser && authUser.isAdmin === false) {
    return (
      <div style={styles.notAuthorized}>
        <h2 style={{ ...theme.type.h1, color: theme.gold.primary }}>Admin only</h2>
        <p style={{ color: theme.text.secondary }}>This page is for site administrators.</p>
        <Button variant="primary" onClick={() => navigate('/')}>Back to lobby</Button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button
          type="button"
          onClick={() => navigate('/')}
          style={styles.backBtn}
          title="Back to lobby"
        >
          <ArrowLeft size={14} />
          Lobby
        </button>
        <div style={styles.adminNav}>
          <button
            type="button"
            style={{ ...styles.adminNavBtn, ...styles.adminNavBtnActive }}
            disabled
          >
            Feedback
          </button>
          <button
            type="button"
            onClick={() => navigate('/admin/tidings')}
            style={styles.adminNavBtn}
          >
            Tidings
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ ...theme.type.display, color: theme.gold.primary, margin: 0 }}>
            Feedback
          </h1>
          <span style={{ color: theme.text.muted, fontSize: 12 }}>
            {items.length} entr{items.length === 1 ? 'y' : 'ies'}
            {Object.values(counts).some((c) => c > 0) && (
              <>
                {' \u00b7 '}
                {(Object.entries(counts) as [FeedbackStatus, number][])
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${n} ${STATUS_LABEL[k].toLowerCase()}`)
                  .join(', ')}
              </>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<RefreshCw size={12} />}
          onClick={fetchFeedback}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <Filter size={14} style={{ color: theme.text.muted }} />
        <div style={{ minWidth: 160 }}>
          <Select
            size="sm"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as '' | FeedbackStatus)}
          >
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as FeedbackStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </Select>
        </div>
        <div style={{ minWidth: 160 }}>
          <Select
            size="sm"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as '' | FeedbackCategory)}
          >
            <option value="">All categories</option>
            <option value="bug">🐞 Bug</option>
            <option value="feature">✨ Feature</option>
            <option value="ux">🎨 UX</option>
            <option value="other">💬 Other</option>
          </Select>
        </div>
      </div>

      {error && (
        <div style={styles.error}>{error}</div>
      )}

      {/* Body — list on the left, detail pane on the right */}
      <div style={styles.body}>
        <div style={styles.list}>
          {loading && items.length === 0 ? (
            <div style={styles.empty}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={styles.empty}>No feedback matches the current filters.</div>
          ) : (
            items.map((it) => {
              const isSelected = it.id === selectedId;
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setSelectedId(it.id)}
                  style={{
                    ...styles.row,
                    ...(isSelected ? styles.rowSelected : {}),
                  }}
                >
                  <div style={styles.rowTop}>
                    <span style={styles.rowCategory}>
                      {CATEGORY_ICON[it.category]}
                      <span>{it.category.toUpperCase()}</span>
                    </span>
                    <Badge variant={STATUS_VARIANT[it.status]} size="sm">
                      {STATUS_LABEL[it.status]}
                    </Badge>
                  </div>
                  <div style={styles.rowContent}>
                    {it.content.length > 140 ? `${it.content.slice(0, 140)}…` : it.content}
                  </div>
                  <div style={styles.rowMeta}>
                    <span>
                      {it.anonymous
                        ? '(anonymous)'
                        : (it.userDisplayName ?? it.userEmail ?? 'unknown')}
                    </span>
                    <span>{formatRelative(it.createdAt)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Detail pane */}
        <div style={styles.detail}>
          {selected ? (
            <Card variant="elevated" accentBar="gold">
              <Section title={selected.category.toUpperCase()}>
                <div style={styles.detailHeader}>
                  <Badge variant={STATUS_VARIANT[selected.status]}>{STATUS_LABEL[selected.status]}</Badge>
                  <span style={styles.detailMeta}>
                    {selected.anonymous
                      ? '(anonymous)'
                      : selected.userDisplayName ?? selected.userEmail ?? '—'}
                    <span style={{ marginLeft: 8 }}>· Submitted {formatRelative(selected.createdAt)}</span>
                  </span>
                </div>

                <div style={styles.detailContent}>
                  {selected.content}
                </div>

                {/* Auto-captured context */}
                <div style={styles.contextGrid}>
                  {selected.pageUrl && (
                    <div style={styles.contextRow}>
                      <span style={styles.contextLabel}>Page</span>
                      <span style={styles.contextValue}>
                        {selected.pageUrl}
                        {selected.pageUrl.startsWith('http') && (
                          <a
                            href={selected.pageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={styles.contextLink}
                            title="Open in new tab"
                          >
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </span>
                    </div>
                  )}
                  {selected.appVersion && (
                    <div style={styles.contextRow}>
                      <span style={styles.contextLabel}>App version</span>
                      <span style={styles.contextValue}>{selected.appVersion}</span>
                    </div>
                  )}
                  {selected.browser && (
                    <div style={styles.contextRow}>
                      <span style={styles.contextLabel}>Browser</span>
                      <span style={styles.contextValue}>{selected.browser}</span>
                    </div>
                  )}
                  {selected.sessionId && (
                    <div style={styles.contextRow}>
                      <span style={styles.contextLabel}>Session</span>
                      <span style={styles.contextValue}>{selected.sessionId}</span>
                    </div>
                  )}
                </div>

                {/* Editable fields */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.lg, marginTop: theme.space.lg }}>
                  <FieldGroup label="Status">
                    <Select
                      value={draftStatus}
                      onChange={(e) => setDraftStatus(e.target.value as FeedbackStatus)}
                    >
                      {(Object.keys(STATUS_LABEL) as FeedbackStatus[]).map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </Select>
                  </FieldGroup>

                  <FieldGroup label="Admin notes" helperText="Internal — not shown to the submitter.">
                    <Textarea
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      rows={5}
                      maxLength={5000}
                      placeholder="Triage notes, repro steps, why we shipped or won't ship…"
                    />
                  </FieldGroup>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space.md }}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDraftStatus(selected.status);
                        setDraftNotes(selected.adminNotes ?? '');
                      }}
                      disabled={saving}
                    >
                      Reset
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleSave}
                      loading={saving}
                      disabled={
                        saving ||
                        (draftStatus === selected.status &&
                          (draftNotes ?? '') === (selected.adminNotes ?? ''))
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </Section>
            </Card>
          ) : (
            <div style={styles.emptyDetail}>
              <MessageSquare size={32} style={{ color: theme.text.muted, marginBottom: 8 }} />
              <p style={{ color: theme.text.secondary, fontSize: 13 }}>
                {items.length === 0
                  ? 'No feedback yet — the inbox is clear.'
                  : 'Select an entry on the left to review.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Render a Postgres timestamp as a friendly relative string.
 * "5m", "2h", "3d", "2w" — degrades to a calendar date past two weeks.
 */
function formatRelative(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 60) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 14) return `${day}d ago`;
  return d.toLocaleDateString();
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    background: theme.bg.deepest,
    color: theme.text.primary,
    padding: '24px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  notAuthorized: {
    minHeight: '100vh',
    background: theme.bg.deepest,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    fontSize: 12,
    cursor: 'pointer',
  },
  adminNav: {
    display: 'inline-flex',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    padding: 2,
    gap: 2,
  },
  adminNavBtn: {
    padding: '4px 10px',
    background: 'transparent',
    border: 'none',
    color: theme.text.secondary,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
  },
  adminNavBtnActive: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    cursor: 'default',
  },
  filters: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
  },
  body: {
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) 2fr',
    gap: 16,
    flex: 1,
    minHeight: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflowY: 'auto',
    maxHeight: 'calc(100vh - 200px)',
    paddingRight: 4,
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 14px',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    color: theme.text.primary,
    textAlign: 'left',
    transition: 'border-color 0.12s, background 0.12s',
    width: '100%',
  },
  rowSelected: {
    borderColor: theme.gold.border,
    background: theme.gold.bg,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowCategory: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: theme.gold.dim,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.1em',
  },
  rowContent: {
    fontSize: 13,
    color: theme.text.primary,
    whiteSpace: 'normal',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    lineHeight: 1.4,
  },
  rowMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: theme.text.muted,
  },
  detail: {
    overflowY: 'auto',
    maxHeight: 'calc(100vh - 200px)',
    paddingRight: 4,
  },
  detailHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  detailMeta: {
    fontSize: 12,
    color: theme.text.muted,
  },
  detailContent: {
    fontSize: 14,
    lineHeight: 1.6,
    color: theme.text.primary,
    background: theme.bg.deepest,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    padding: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  contextGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 12,
    fontSize: 12,
    color: theme.text.muted,
  },
  contextRow: {
    display: 'flex',
    gap: 12,
  },
  contextLabel: {
    minWidth: 100,
    color: theme.gold.dim,
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    fontWeight: 700,
  },
  contextValue: {
    flex: 1,
    color: theme.text.secondary,
    wordBreak: 'break-all',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  contextLink: {
    color: theme.gold.primary,
    display: 'inline-flex',
    alignItems: 'center',
    textDecoration: 'none',
  },
  empty: {
    padding: 32,
    textAlign: 'center',
    color: theme.text.muted,
    fontSize: 13,
  },
  emptyDetail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 200,
    textAlign: 'center',
    background: theme.bg.deep,
    border: `1px dashed ${theme.border.default}`,
    borderRadius: theme.radius.md,
    padding: 32,
  },
  error: {
    padding: 12,
    background: theme.state.dangerBg,
    border: `1px solid ${theme.state.danger}`,
    borderRadius: theme.radius.sm,
    color: theme.state.danger,
    fontSize: 13,
  },
};
