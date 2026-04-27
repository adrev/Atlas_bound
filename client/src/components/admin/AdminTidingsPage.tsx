import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Filter, MessageSquare, Bug, Sparkles, Wand2,
  ExternalLink, Plus, Pencil, Trash2, Check, Pin, Search, BellRing, Hash,
  Megaphone, Calendar, AlertTriangle,
} from 'lucide-react';
import { theme } from '../../styles/theme';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  Button, Select, Textarea, Badge, Card, Section, FieldGroup, TextInput, Modal,
} from '../ui';
import { showToast } from '../ui/Toast';
import { askConfirm } from '../ui/Dialog';

/**
 * /admin/tidings — admin-only authoring surface for patch notes,
 * content drops, and announcements that show up in the lobby
 * "What's New" rail.
 *
 * Tidings of kind=patch additionally fan out to the Discord Releases
 * forum via a server-side webhook on first publish — the UI surfaces
 * that capability through the "Skip Discord" toggle and an
 * "Announced to Discord" banner once it has fired.
 *
 * Auth model mirrors AdminFeedbackPage: server-side `requireAdmin`
 * enforces access; the client only checks `auth.user.isAdmin` to skip
 * the loading flash.
 */

type TidingKind = 'patch' | 'content' | 'announcement';
type TidingAudience = 'all' | 'dm' | 'player';
type FeedbackCategory = 'bug' | 'feature' | 'ux' | 'other';
type FeedbackStatus = 'open' | 'triaged' | 'planned' | 'shipped' | 'wontfix';

interface Tiding {
  id: string;
  kind: TidingKind;
  title: string;
  body: string;
  expandedBody: string | null;
  audience: TidingAudience;
  versionTag: string | null;
  publishedAt: string;
  expiresAt: string | null;
  pinned: boolean;
  linkedFeedbackIds: string[];
  discordAnnouncedAt: string | null;
  discordThreadUrl: string | null;
  createdBy: string | null;
  authorDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FeedbackPickerRow {
  id: string;
  category: FeedbackCategory;
  content: string;
  anonymous: boolean;
  status: FeedbackStatus;
  discordThreadUrl: string | null;
  userDisplayName: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<TidingKind, string> = {
  patch: 'Patch',
  content: 'Content',
  announcement: 'Announcement',
};

const KIND_VARIANT: Record<TidingKind, 'gold' | 'success' | 'info'> = {
  patch: 'gold',
  content: 'success',
  announcement: 'info',
};

const KIND_ICON: Record<TidingKind, React.ReactNode> = {
  patch: <Hash size={11} />,
  content: <Sparkles size={11} />,
  announcement: <Megaphone size={11} />,
};

const AUDIENCE_LABEL: Record<TidingAudience, string> = {
  all: 'All',
  dm: 'DMs',
  player: 'Players',
};

const FEEDBACK_CATEGORY_ICON: Record<FeedbackCategory, React.ReactNode> = {
  bug: <Bug size={11} />,
  feature: <Sparkles size={11} />,
  ux: <Wand2 size={11} />,
  other: <MessageSquare size={11} />,
};

const FEEDBACK_CATEGORY_EMOJI: Record<FeedbackCategory, string> = {
  bug: '🐞',
  feature: '✨',
  ux: '🎨',
  other: '💬',
};

const FEEDBACK_STATUS_VARIANT: Record<FeedbackStatus, 'gold' | 'success' | 'info' | 'warning' | 'danger'> = {
  open: 'gold',
  triaged: 'info',
  planned: 'warning',
  shipped: 'success',
  wontfix: 'danger',
};

const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: 'Open',
  triaged: 'Triaged',
  planned: 'Planned',
  shipped: 'Shipped',
  wontfix: 'Won\u2019t Fix',
};

// Maximum lengths we enforce client-side (server is the source of
// truth, but matching the docstring spec keeps UX consistent).
const MAX_TITLE = 200;
const MAX_BODY = 2000;
const MAX_EXPANDED = 10000;
const MAX_VERSION = 32;

interface DraftState {
  id: string | null;          // null = creating, string = editing
  kind: TidingKind;
  title: string;
  body: string;
  expandedBody: string;
  audience: TidingAudience;
  versionTag: string;
  publishedAt: string;        // datetime-local format (YYYY-MM-DDTHH:mm)
  expiresAt: string;          // datetime-local format or empty
  pinned: boolean;
  linkedFeedbackIds: string[];
  skipDiscord: boolean;
  discordAnnouncedAt: string | null;
  discordThreadUrl: string | null;
}

function emptyDraft(): DraftState {
  // Default publishedAt = now (rounded to the minute) so the
  // datetime-local input shows a sensible value when the dialog opens.
  const now = new Date();
  now.setSeconds(0, 0);
  return {
    id: null,
    kind: 'patch',
    title: '',
    body: '',
    expandedBody: '',
    audience: 'all',
    versionTag: '',
    publishedAt: toLocalInputValue(now.toISOString()),
    expiresAt: '',
    pinned: false,
    linkedFeedbackIds: [],
    skipDiscord: false,
    discordAnnouncedAt: null,
    discordThreadUrl: null,
  };
}

function tidingToDraft(t: Tiding): DraftState {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    body: t.body,
    expandedBody: t.expandedBody ?? '',
    audience: t.audience,
    versionTag: t.versionTag ?? '',
    publishedAt: toLocalInputValue(t.publishedAt),
    expiresAt: t.expiresAt ? toLocalInputValue(t.expiresAt) : '',
    pinned: t.pinned,
    linkedFeedbackIds: [...t.linkedFeedbackIds],
    skipDiscord: false,
    discordAnnouncedAt: t.discordAnnouncedAt,
    discordThreadUrl: t.discordThreadUrl,
  };
}

export function AdminTidingsPage() {
  const navigate = useNavigate();
  const authUser = useAuthStore((s) => s.user);

  const [items, setItems] = useState<Tiding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterKind, setFilterKind] = useState<'' | TidingKind>('');
  const [search, setSearch] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [feedbackOptions, setFeedbackOptions] = useState<FeedbackPickerRow[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackSearch, setFeedbackSearch] = useState('');

  const fetchTidings = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/tidings', { credentials: 'include' });
      if (res.status === 403) {
        setError('You do not have admin access.');
        setItems([]);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Failed to load tidings (${res.status})`);
        return;
      }
      const data = await res.json();
      setItems(data.tidings ?? []);
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTidings();
  }, []);

  // Lazy-load the recent feedback list the first time the dialog opens
  // with kind=patch. Re-fetched on each open so freshly-triaged items
  // don't go stale, but cheap enough to not need a refresh button.
  const fetchRecentFeedback = async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch('/api/admin/tidings/recent-feedback', {
        credentials: 'include',
      });
      if (!res.ok) {
        setFeedbackOptions([]);
        return;
      }
      const data = await res.json();
      setFeedbackOptions(data.feedback ?? []);
    } catch {
      setFeedbackOptions([]);
    } finally {
      setFeedbackLoading(false);
    }
  };

  useEffect(() => {
    if (dialogOpen && draft.kind === 'patch' && feedbackOptions.length === 0 && !feedbackLoading) {
      fetchRecentFeedback();
    }
    // We intentionally only retrigger when the dialog opens or the
    // kind changes to patch — re-fetching on every keystroke would be
    // wasteful, and the picker handles its own filter-by-text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, draft.kind]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((t) => {
      if (filterKind && t.kind !== filterKind) return false;
      if (!needle) return true;
      const hay =
        `${t.title} ${t.body} ${t.versionTag ?? ''} ${t.expandedBody ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [items, filterKind, search]);

  const openCreate = () => {
    setDraft(emptyDraft());
    setFeedbackSearch('');
    setDialogOpen(true);
  };

  const openEdit = (t: Tiding) => {
    setDraft(tidingToDraft(t));
    setFeedbackSearch('');
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
  };

  // POST or PATCH depending on whether we're editing. Server expects
  // ISO timestamps for publishedAt/expiresAt, so we convert from the
  // datetime-local string before sending.
  const handleSave = async () => {
    if (saving) return;
    const trimmedTitle = draft.title.trim();
    const trimmedBody = draft.body.trim();
    if (!trimmedTitle) {
      showToast({ message: 'Title is required.', variant: 'danger' });
      return;
    }
    if (trimmedTitle.length > MAX_TITLE) {
      showToast({ message: `Title is too long (${MAX_TITLE} max).`, variant: 'danger' });
      return;
    }
    if (!trimmedBody) {
      showToast({ message: 'Body is required.', variant: 'danger' });
      return;
    }
    if (trimmedBody.length > MAX_BODY) {
      showToast({ message: `Body is too long (${MAX_BODY} max).`, variant: 'danger' });
      return;
    }

    setSaving(true);
    try {
      const publishedAtIso = fromLocalInputValue(draft.publishedAt);
      if (!publishedAtIso) {
        showToast({ message: 'Published-at is required.', variant: 'danger' });
        setSaving(false);
        return;
      }
      const expiresAtIso = draft.expiresAt ? fromLocalInputValue(draft.expiresAt) : null;

      const payload: Record<string, unknown> = {
        kind: draft.kind,
        title: trimmedTitle,
        body: trimmedBody,
        expandedBody: draft.expandedBody.trim() || null,
        audience: draft.audience,
        versionTag: draft.versionTag.trim() || null,
        publishedAt: publishedAtIso,
        expiresAt: expiresAtIso,
        pinned: draft.pinned,
        linkedFeedbackIds: draft.kind === 'patch' ? draft.linkedFeedbackIds : [],
      };

      // Only include skipDiscord on first save of a patch — once
      // announced the server ignores it anyway, so omitting it
      // keeps the request body honest.
      if (draft.kind === 'patch' && !draft.discordAnnouncedAt && draft.skipDiscord) {
        payload.skipDiscord = true;
      }

      const isEdit = !!draft.id;
      const url = isEdit ? `/api/admin/tidings/${draft.id}` : '/api/admin/tidings';
      const method = isEdit ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast({
          message: data.error ?? `Save failed (${res.status})`,
          variant: 'danger',
        });
        return;
      }

      const data = await res.json();
      const saved: Tiding | null = data.tiding ?? null;

      // If this save was the moment the Releases webhook fired, the
      // server flips discordAnnouncedAt from null to non-null —
      // surface that as a distinct toast so the admin knows it went
      // out without re-checking the row.
      const wasAnnouncedNow =
        saved?.kind === 'patch' &&
        !draft.discordAnnouncedAt &&
        !!saved.discordAnnouncedAt;

      showToast({
        message: wasAnnouncedNow ? 'Released to Discord' : 'Tiding saved',
        variant: 'success',
        emoji: wasAnnouncedNow ? '📣' : undefined,
      });
      setDialogOpen(false);
      await fetchTidings();
    } catch {
      showToast({ message: 'Network error — could not save', variant: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t: Tiding) => {
    const ok = await askConfirm({
      title: 'Delete tiding?',
      message: `"${t.title}" will be permanently removed. ${
        t.discordAnnouncedAt
          ? 'The associated Discord post will remain — only the lobby entry is deleted.'
          : ''
      }`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/tidings/${t.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast({
          message: data.error ?? `Delete failed (${res.status})`,
          variant: 'danger',
        });
        return;
      }
      showToast({ message: 'Tiding deleted', variant: 'success' });
      setItems((prev) => prev.filter((it) => it.id !== t.id));
    } catch {
      showToast({ message: 'Network error — could not delete', variant: 'danger' });
    }
  };

  // Optimistic redirect for non-admins. The server returns 403 anyway;
  // this is just to avoid a brief flash of the panel.
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
            onClick={() => navigate('/admin/feedback')}
            style={styles.adminNavBtn}
          >
            Feedback
          </button>
          <button
            type="button"
            style={{ ...styles.adminNavBtn, ...styles.adminNavBtnActive }}
            disabled
          >
            Tidings
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
          <h1 style={{ ...theme.type.display, color: theme.gold.primary, margin: 0 }}>
            Tidings
          </h1>
          <span style={{ color: theme.text.muted, fontSize: 12 }}>
            {items.length} entr{items.length === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<RefreshCw size={12} />}
          onClick={fetchTidings}
          disabled={loading}
        >
          Refresh
        </Button>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Plus size={12} />}
          onClick={openCreate}
        >
          New Tiding
        </Button>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <Filter size={14} style={{ color: theme.text.muted, flexShrink: 0 }} />
        <div style={{ minWidth: 160 }}>
          <Select
            size="sm"
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value as '' | TidingKind)}
          >
            <option value="">All kinds</option>
            <option value="patch">Patch</option>
            <option value="content">Content</option>
            <option value="announcement">Announcement</option>
          </Select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <TextInput
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, body, version…"
            leadingIcon={<Search size={12} />}
          />
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Body — list of tidings */}
      <div style={styles.body}>
        {loading && items.length === 0 ? (
          <div style={styles.empty}>Loading…</div>
        ) : filtered.length === 0 && items.length === 0 ? (
          <div style={styles.emptyState}>
            <BellRing size={32} style={{ color: theme.text.muted, marginBottom: 12 }} />
            <h2 style={{ ...theme.type.h1, color: theme.gold.primary, margin: '0 0 8px' }}>
              No tidings yet
            </h2>
            <p style={{ color: theme.text.secondary, fontSize: 13, margin: '0 0 20px', maxWidth: 360 }}>
              Patch notes, content drops, and announcements show up here. The lobby
              "What's New" rail surfaces them to players.
            </p>
            <Button
              variant="primary"
              size="md"
              leadingIcon={<Plus size={14} />}
              onClick={openCreate}
            >
              Forge First Tiding
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={styles.empty}>No tidings match the current filters.</div>
        ) : (
          <div style={styles.list}>
            {filtered.map((t) => (
              <TidingRow
                key={t.id}
                tiding={t}
                onEdit={() => openEdit(t)}
                onDelete={() => handleDelete(t)}
              />
            ))}
          </div>
        )}
      </div>

      {dialogOpen && (
        <TidingDialog
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          onClose={closeDialog}
          onSave={handleSave}
          feedbackOptions={feedbackOptions}
          feedbackLoading={feedbackLoading}
          feedbackSearch={feedbackSearch}
          setFeedbackSearch={setFeedbackSearch}
        />
      )}
    </div>
  );
}

// ── List Row ─────────────────────────────────────────────────────

function TidingRow({
  tiding,
  onEdit,
  onDelete,
}: {
  tiding: Tiding;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = tiding;
  const isFuture = new Date(t.publishedAt).getTime() > Date.now();
  return (
    <Card variant="elevated" accentBar={t.pinned ? 'gold' : 'none'} padding="md">
      <div style={styles.rowGrid}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={styles.rowTop}>
            <Badge variant={KIND_VARIANT[t.kind]} size="sm">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {KIND_ICON[t.kind]}
                {KIND_LABEL[t.kind]}
              </span>
            </Badge>
            {t.versionTag && (
              <Badge variant="muted" size="sm">v{t.versionTag}</Badge>
            )}
            <Badge variant="muted" size="sm">
              {AUDIENCE_LABEL[t.audience]}
            </Badge>
            {t.pinned && (
              <span style={styles.pinChip} title="Pinned to the top">
                <Pin size={10} />
                Pinned
              </span>
            )}
            {isFuture && (
              <span style={styles.scheduledChip} title="Will publish later">
                <Calendar size={10} />
                Scheduled
              </span>
            )}
          </div>
          <div style={styles.rowTitle}>{t.title}</div>
          <div style={styles.rowBody}>
            {t.body.length > 200 ? `${t.body.slice(0, 200)}…` : t.body}
          </div>
          <div style={styles.rowMeta}>
            <span>{formatRelative(t.publishedAt)}</span>
            {t.authorDisplayName && <span>· by {t.authorDisplayName}</span>}
            {t.linkedFeedbackIds.length > 0 && (
              <span>· {t.linkedFeedbackIds.length} linked</span>
            )}
            <span style={{ marginLeft: 'auto' }}>
              {t.kind === 'patch' && (
                t.discordAnnouncedAt && t.discordThreadUrl ? (
                  <a
                    href={t.discordThreadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.discordLinkOk}
                    title={`Announced ${formatRelative(t.discordAnnouncedAt)}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Check size={11} />
                    Discord
                    <ExternalLink size={10} />
                  </a>
                ) : t.discordAnnouncedAt ? (
                  <span style={styles.discordLinkOk}>
                    <Check size={11} />
                    Announced
                  </span>
                ) : (
                  <span style={styles.discordLinkMuted}>not announced</span>
                )
              )}
            </span>
          </div>
        </div>

        <div style={styles.rowActions}>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Pencil size={12} />}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Trash2 size={12} />}
            onClick={onDelete}
            style={{ color: theme.state.danger }}
            aria-label="Delete tiding"
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Create / Edit Dialog ─────────────────────────────────────────

interface DialogProps {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  feedbackOptions: FeedbackPickerRow[];
  feedbackLoading: boolean;
  feedbackSearch: string;
  setFeedbackSearch: (s: string) => void;
}

function TidingDialog({
  draft, setDraft, saving, onClose, onSave,
  feedbackOptions, feedbackLoading, feedbackSearch, setFeedbackSearch,
}: DialogProps) {
  const isEdit = !!draft.id;
  const isPatch = draft.kind === 'patch';
  const alreadyAnnounced = !!draft.discordAnnouncedAt;
  const trimmedTitle = draft.title.trim();
  const trimmedBody = draft.body.trim();
  const titleTooLong = trimmedTitle.length > MAX_TITLE;
  const bodyTooLong = trimmedBody.length > MAX_BODY;
  const expandedTooLong = draft.expandedBody.length > MAX_EXPANDED;
  const versionTooLong = draft.versionTag.length > MAX_VERSION;

  const canSubmit =
    !!trimmedTitle &&
    !!trimmedBody &&
    !titleTooLong &&
    !bodyTooLong &&
    !expandedTooLong &&
    !versionTooLong &&
    !!draft.publishedAt;

  const filteredFeedback = useMemo(() => {
    const needle = feedbackSearch.trim().toLowerCase();
    if (!needle) return feedbackOptions;
    return feedbackOptions.filter((f) =>
      f.content.toLowerCase().includes(needle) ||
      (f.userDisplayName ?? '').toLowerCase().includes(needle),
    );
  }, [feedbackOptions, feedbackSearch]);

  const toggleFeedback = (id: string) => {
    setDraft((d) => {
      const has = d.linkedFeedbackIds.includes(id);
      return {
        ...d,
        linkedFeedbackIds: has
          ? d.linkedFeedbackIds.filter((x) => x !== id)
          : [...d.linkedFeedbackIds, id],
      };
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Edit Tiding' : 'New Tiding'}
      subtitle={
        isPatch
          ? 'Patches auto-fire the Discord Releases webhook on first publish.'
          : undefined
      }
      emoji={isPatch ? '📣' : draft.kind === 'content' ? '✨' : '📰'}
      size="lg"
      disableBackdropClose={saving}
      disableEscapeClose={saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            loading={saving}
            disabled={!canSubmit || saving}
          >
            {isEdit ? 'Save Changes' : 'Publish'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.lg }}>
        {alreadyAnnounced && (
          <div style={styles.announcedBanner}>
            <BellRing size={14} style={{ color: theme.gold.primary, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: theme.text.primary }}>
                Announced to Discord {formatRelative(draft.discordAnnouncedAt!)}
              </div>
              <div style={{ fontSize: 11, color: theme.text.muted }}>
                Re-saves will not re-announce — Discord posts are one-shot.
              </div>
            </div>
            {draft.discordThreadUrl && (
              <a
                href={draft.discordThreadUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.bannerLink}
              >
                Open thread
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}

        {/* Kind segmented control */}
        <FieldGroup label="Kind">
          <SegmentedControl
            value={draft.kind}
            options={[
              { value: 'patch', label: 'Patch', icon: <Hash size={11} /> },
              { value: 'content', label: 'Content', icon: <Sparkles size={11} /> },
              { value: 'announcement', label: 'Announcement', icon: <Megaphone size={11} /> },
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, kind: v as TidingKind }))}
            disabled={saving}
          />
        </FieldGroup>

        {/* Title */}
        <FieldGroup
          label={`Title (${trimmedTitle.length}/${MAX_TITLE})`}
          error={titleTooLong}
          helperText={titleTooLong ? `Trim down to ${MAX_TITLE} characters or fewer.` : undefined}
        >
          <TextInput
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder="A short, lobby-friendly headline"
            maxLength={MAX_TITLE + 50}
            error={titleTooLong}
            autoFocus
          />
        </FieldGroup>

        {/* Version tag */}
        <FieldGroup
          label="Version tag (optional)"
          helperText={
            isPatch
              ? 'Patches typically include a version like 0.7.4 — used as the Discord post heading.'
              : 'Optional — leave blank for non-versioned tidings.'
          }
          error={versionTooLong}
        >
          <TextInput
            value={draft.versionTag}
            onChange={(e) => setDraft((d) => ({ ...d, versionTag: e.target.value }))}
            placeholder={isPatch ? 'e.g. 0.7.4' : 'e.g. event-1'}
            maxLength={MAX_VERSION + 20}
            error={versionTooLong}
          />
        </FieldGroup>

        {/* Body */}
        <FieldGroup
          label={`Body (${trimmedBody.length}/${MAX_BODY})`}
          helperText="The lobby renders this verbatim. The first *emphasized* phrase shows in gold."
          error={bodyTooLong}
        >
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            rows={5}
            placeholder="What changed? Keep it punchy — players read this in the lobby rail."
            maxLength={MAX_BODY + 200}
            error={bodyTooLong}
          />
        </FieldGroup>

        {/* Expanded body */}
        <FieldGroup
          label={`Read more (${draft.expandedBody.length}/${MAX_EXPANDED}, optional)`}
          helperText="Shown when a reader clicks 'Read more' on the lobby card."
          error={expandedTooLong}
        >
          <Textarea
            value={draft.expandedBody}
            onChange={(e) => setDraft((d) => ({ ...d, expandedBody: e.target.value }))}
            rows={6}
            placeholder="Patch notes, full bullet list, screenshots-via-link, etc."
            maxLength={MAX_EXPANDED + 500}
            error={expandedTooLong}
          />
        </FieldGroup>

        {/* Audience */}
        <FieldGroup label="Audience">
          <SegmentedControl
            value={draft.audience}
            options={[
              { value: 'all', label: 'All' },
              { value: 'dm', label: 'DMs' },
              { value: 'player', label: 'Players' },
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, audience: v as TidingAudience }))}
            disabled={saving}
          />
        </FieldGroup>

        {/* Pinned + dates row */}
        <div style={styles.metaRow}>
          <FieldGroup label="Published at" helperText="Future = scheduled (won't show until then).">
            <input
              type="datetime-local"
              value={draft.publishedAt}
              onChange={(e) => setDraft((d) => ({ ...d, publishedAt: e.target.value }))}
              style={styles.datetimeInput}
            />
          </FieldGroup>
          <FieldGroup label="Expires at (optional)" helperText="After this, hidden from the lobby.">
            <input
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(e) => setDraft((d) => ({ ...d, expiresAt: e.target.value }))}
              style={styles.datetimeInput}
            />
          </FieldGroup>
          <FieldGroup label="Pinned">
            <label style={styles.toggleRow}>
              <input
                type="checkbox"
                checked={draft.pinned}
                onChange={(e) => setDraft((d) => ({ ...d, pinned: e.target.checked }))}
                style={{ accentColor: theme.gold.primary }}
                disabled={saving}
              />
              <span style={{ fontSize: 12, color: theme.text.secondary }}>
                Show first in the rail
              </span>
            </label>
          </FieldGroup>
        </div>

        {/* Patch-only: linked feedback + skip discord */}
        {isPatch && (
          <>
            <Section
              title={`Linked Feedback (${draft.linkedFeedbackIds.length} selected)`}
              spacing="compact"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space.sm }}>
                <TextInput
                  size="sm"
                  value={feedbackSearch}
                  onChange={(e) => setFeedbackSearch(e.target.value)}
                  placeholder="Filter recent feedback…"
                  leadingIcon={<Search size={12} />}
                />
                <div style={styles.feedbackList}>
                  {feedbackLoading ? (
                    <div style={styles.feedbackEmpty}>Loading recent feedback…</div>
                  ) : filteredFeedback.length === 0 ? (
                    <div style={styles.feedbackEmpty}>
                      {feedbackOptions.length === 0
                        ? 'No recent feedback to link.'
                        : 'No matches for that filter.'}
                    </div>
                  ) : (
                    filteredFeedback.map((f) => {
                      const checked = draft.linkedFeedbackIds.includes(f.id);
                      return (
                        <label
                          key={f.id}
                          style={{
                            ...styles.feedbackRow,
                            ...(checked ? styles.feedbackRowSelected : {}),
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleFeedback(f.id)}
                            style={{
                              accentColor: theme.gold.primary,
                              marginTop: 2,
                              flexShrink: 0,
                            }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={styles.feedbackRowTop}>
                              <span style={styles.feedbackCategory}>
                                <span aria-hidden>{FEEDBACK_CATEGORY_EMOJI[f.category]}</span>
                                {FEEDBACK_CATEGORY_ICON[f.category]}
                                <span>{f.category.toUpperCase()}</span>
                              </span>
                              <Badge variant={FEEDBACK_STATUS_VARIANT[f.status]} size="sm">
                                {FEEDBACK_STATUS_LABEL[f.status]}
                              </Badge>
                              {f.discordThreadUrl && (
                                <a
                                  href={f.discordThreadUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  style={styles.feedbackThreadLink}
                                  title="Open Discord thread"
                                >
                                  <ExternalLink size={11} />
                                </a>
                              )}
                            </div>
                            <div style={styles.feedbackContent}>
                              {f.content.length > 120 ? `${f.content.slice(0, 120)}…` : f.content}
                            </div>
                            <div style={styles.feedbackMeta}>
                              {f.anonymous
                                ? '(anonymous)'
                                : (f.userDisplayName ?? 'unknown')}
                              <span style={{ marginLeft: 8 }}>
                                · {formatRelative(f.createdAt)}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </Section>

            {!alreadyAnnounced && (
              <label style={styles.skipDiscordRow}>
                <input
                  type="checkbox"
                  checked={draft.skipDiscord}
                  onChange={(e) => setDraft((d) => ({ ...d, skipDiscord: e.target.checked }))}
                  style={{ accentColor: theme.gold.primary, flexShrink: 0 }}
                  disabled={saving}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle
                      size={12}
                      style={{ color: theme.state.warning, flexShrink: 0 }}
                    />
                    <span style={{ fontWeight: 700, fontSize: 12, color: theme.text.primary }}>
                      Skip Discord announcement
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: theme.text.muted, marginTop: 2 }}>
                    Save this patch without firing the Releases webhook. Use for hotfixes
                    or stealth-published changes that don't merit a public post.
                  </div>
                </div>
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Segmented control ────────────────────────────────────────────

interface SegmentOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

function SegmentedControl({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: SegmentOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={styles.segmented}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            type="button"
            key={opt.value}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            style={{
              ...styles.segmentBtn,
              ...(selected ? styles.segmentBtnActive : {}),
            }}
          >
            {opt.icon && <span style={{ display: 'inline-flex' }}>{opt.icon}</span>}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/** ISO timestamp → "YYYY-MM-DDTHH:mm" (datetime-local input format). */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // Pad each component to 2 digits and use the local TZ — datetime-local
  // is local-time by spec.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** datetime-local string → ISO. Returns null if the input is empty/invalid. */
function fromLocalInputValue(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatRelative(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const sec = Math.round(Math.abs(diffMs) / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const suffix = future ? 'from now' : 'ago';
  if (sec < 60) return future ? 'imminent' : 'just now';
  if (min < 60) return `${min}m ${suffix}`;
  if (hr < 24) return `${hr}h ${suffix}`;
  if (day < 14) return `${day}d ${suffix}`;
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
    gap: 12,
    flexWrap: 'wrap',
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
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  rowGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 12,
    alignItems: 'flex-start',
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.text.primary,
    fontFamily: theme.font.display,
    letterSpacing: '0.04em',
  },
  rowBody: {
    fontSize: 12,
    color: theme.text.secondary,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: theme.text.muted,
    flexWrap: 'wrap',
  },
  rowActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    flexShrink: 0,
  },
  pinChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    color: theme.gold.bright,
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: 20,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  scheduledChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '1px 6px',
    fontSize: 9,
    fontWeight: 700,
    color: theme.state.info,
    background: theme.state.infoBg,
    border: `1px solid rgba(106, 169, 209, 0.4)`,
    borderRadius: 20,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  discordLinkOk: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: theme.state.success,
    textDecoration: 'none',
    fontWeight: 700,
    fontSize: 11,
  },
  discordLinkMuted: {
    color: theme.text.muted,
    fontStyle: 'italic',
    fontSize: 11,
  },
  empty: {
    padding: 32,
    textAlign: 'center',
    color: theme.text.muted,
    fontSize: 13,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minHeight: 360,
    padding: 32,
    textAlign: 'center',
    background: theme.bg.deep,
    border: `1px dashed ${theme.border.default}`,
    borderRadius: theme.radius.md,
  },
  error: {
    padding: 12,
    background: theme.state.dangerBg,
    border: `1px solid ${theme.state.danger}`,
    borderRadius: theme.radius.sm,
    color: theme.state.danger,
    fontSize: 13,
  },
  // Dialog internals
  metaRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: theme.space.lg,
  },
  datetimeInput: {
    padding: '6px 10px',
    fontSize: 13,
    fontFamily: theme.font.body,
    color: theme.text.primary,
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    colorScheme: 'dark',
  },
  toggleRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    cursor: 'pointer',
  },
  segmented: {
    display: 'inline-flex',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    padding: 2,
    gap: 2,
  },
  segmentBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'transparent',
    border: 'none',
    color: theme.text.secondary,
    fontSize: 12,
    fontWeight: 600,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  segmentBtnActive: {
    background: theme.gold.bg,
    color: theme.gold.primary,
    border: `1px solid ${theme.gold.border}`,
  },
  announcedBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    fontSize: 12,
  },
  bannerLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: theme.gold.primary,
    textDecoration: 'none',
    fontWeight: 700,
    fontSize: 11,
    flexShrink: 0,
  },
  feedbackList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    maxHeight: 280,
    overflowY: 'auto',
    padding: 4,
    background: theme.bg.deepest,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
  },
  feedbackEmpty: {
    padding: 16,
    textAlign: 'center',
    color: theme.text.muted,
    fontSize: 12,
  },
  feedbackRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '8px 10px',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
  },
  feedbackRowSelected: {
    borderColor: theme.gold.border,
    background: theme.gold.bg,
  },
  feedbackRowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
    flexWrap: 'wrap',
  },
  feedbackCategory: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    color: theme.gold.dim,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
  },
  feedbackContent: {
    fontSize: 12,
    color: theme.text.primary,
    lineHeight: 1.4,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
  feedbackMeta: {
    fontSize: 10,
    color: theme.text.muted,
    marginTop: 2,
  },
  feedbackThreadLink: {
    display: 'inline-flex',
    alignItems: 'center',
    color: theme.gold.primary,
    textDecoration: 'none',
  },
  skipDiscordRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    background: theme.state.warningBg,
    border: `1px solid ${theme.state.warning}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
  },
};
