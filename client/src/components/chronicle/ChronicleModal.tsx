/**
 * Forge a Chronicle — DM-only modal. Three phases:
 *
 *   1. Compose: paste / edit the session transcript, click Forge
 *   2. Generating: show spinner while polling /api/sessions/:id/chronicle/:entryId
 *   3. Review: editable preview of recapShort, recapFull, whereLeftOff,
 *      keyEntities. DM hits Save Draft (keeps in admin-only) or
 *      Publish (visible in lobby Chronicle rail to all players).
 *
 * Mount once in AppShell; open via the `open-chronicle-forge` custom
 * event so buttons in any DM panel can launch it without a prop drill.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollText, X, Sparkles, Send, RotateCw } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { showToast } from '../ui/Toast';

type Phase = 'loading' | 'compose' | 'generating' | 'review' | 'failed';

interface ChronicleEntry {
  id: string;
  campaignId: string;
  sequenceNumber: number;
  autoRecapShort: string | null;
  autoRecapFull: string | null;
  keyEntities: string[];
  whereLeftOff: string | null;
  dmRecapShort: string | null;
  dmRecapFull: string | null;
  effectiveRecapShort: string;
  effectiveRecapFull: string;
  status: 'pending' | 'generating' | 'draft' | 'published' | 'failed';
  generationError: string | null;
  modelUsed: string | null;
  publishedAt: string | null;
}

export function ChronicleModal() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const isDM = useSessionStore((s) => s.isDM);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('compose');
  const [transcript, setTranscript] = useState('');
  /** True when the textarea was prefilled by the auto-build endpoint
   *  rather than typed by the DM. Surfaces a small "auto-filled from
   *  N messages" caption so the DM knows where the text came from. */
  const [autoFilled, setAutoFilled] = useState<{ count: number; truncated: boolean } | null>(null);
  const [entry, setEntry] = useState<ChronicleEntry | null>(null);
  const [draftShort, setDraftShort] = useState('');
  const [draftFull, setDraftFull] = useState('');
  const [draftWhere, setDraftWhere] = useState('');
  const [draftEntities, setDraftEntities] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Listen for the open event. The DM toolbar (or any other panel)
  // dispatches `open-chronicle-forge` to launch the modal — keeps
  // this component decoupled from the toolbar's render tree.
  useEffect(() => {
    const handler = async () => {
      setOpen(true);
      setEntry(null);
      setError(null);
      setAutoFilled(null);
      // Auto-fetch the transcript from this session's chat history.
      // The DM can edit / trim / replace it, but the default is "we
      // already pulled what happened — just review and forge."
      // Falls back to compose-with-empty-textarea on error.
      if (!sessionId) { setPhase('compose'); return; }
      setPhase('loading');
      try {
        const res = await fetch(`/api/sessions/${sessionId}/chronicle/transcript-preview`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json() as {
            transcript: string;
            messageCount: number;
            truncated: boolean;
          };
          if (data.transcript && data.transcript.length >= 20) {
            setTranscript(data.transcript);
            setAutoFilled({ count: data.messageCount, truncated: data.truncated });
          } else {
            // Empty or too-short — likely no chat since the last
            // published chronicle. Don't wipe a draft the DM may
            // have typed before; just leave whatever's there.
            setAutoFilled(null);
          }
        }
      } catch {
        /* fall through to compose */
      } finally {
        setPhase('compose');
      }
    };
    window.addEventListener('open-chronicle-forge', handler);
    return () => window.removeEventListener('open-chronicle-forge', handler);
  }, [sessionId]);

  // Cleanup the poll timer if the modal closes mid-generation.
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const close = () => {
    setOpen(false);
    if (pollRef.current) window.clearInterval(pollRef.current);
  };

  if (!open || !isDM || !sessionId) return null;

  const startPolling = (entryId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/chronicle/${entryId}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json();
        const e = data.entry as ChronicleEntry;
        setEntry(e);
        if (e.status === 'draft') {
          // Seed the editable fields from the auto-generated content.
          setDraftShort(e.dmRecapShort ?? e.autoRecapShort ?? '');
          setDraftFull(e.dmRecapFull ?? e.autoRecapFull ?? '');
          setDraftWhere(e.whereLeftOff ?? '');
          setDraftEntities((e.keyEntities ?? []).join(', '));
          setPhase('review');
          if (pollRef.current) window.clearInterval(pollRef.current);
        } else if (e.status === 'failed') {
          setPhase('failed');
          setError(e.generationError ?? 'Generation failed');
          if (pollRef.current) window.clearInterval(pollRef.current);
        }
      } catch {
        /* keep polling — transient errors recover */
      }
    }, 1500);
  };

  const handleForge = async () => {
    if (transcript.trim().length < 20) {
      setError('Need at least 20 chars of session text. Paste your notes — even a brief summary works.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/chronicle/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: transcript.trim(),
          sessionEndedAt: new Date().toISOString(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Forge failed (${res.status})`);
        return;
      }
      setPhase('generating');
      startPolling(data.entryId);
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/chronicle/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dmRecapShort: draftShort.trim() || null,
          dmRecapFull: draftFull.trim() || null,
          whereLeftOff: draftWhere.trim() || null,
          keyEntities: draftEntities.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast({ message: data.error ?? 'Save failed', variant: 'danger' });
        return;
      }
      showToast({ message: 'Chronicle draft saved', variant: 'success' });
      close();
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      // Save edits first so the published version reflects them.
      await fetch(`/api/chronicle/${entry.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dmRecapShort: draftShort.trim() || null,
          dmRecapFull: draftFull.trim() || null,
          whereLeftOff: draftWhere.trim() || null,
          keyEntities: draftEntities.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      const res = await fetch(`/api/chronicle/${entry.id}/publish`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast({ message: data.error ?? 'Publish failed', variant: 'danger' });
        return;
      }
      showToast({ message: 'Chronicle published — players can see it now.', variant: 'success', emoji: '📜' });
      close();
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/chronicle/${entry.id}/retry`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Retry failed');
        return;
      }
      setError(null);
      setPhase('generating');
      startPolling(entry.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.scrim} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div style={styles.modal}>
        <div style={styles.head}>
          <ScrollText size={20} color="#e0b44f" />
          <h3 style={styles.title}>Forge a Chronicle</h3>
          <button style={styles.closeBtn} onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div style={styles.body}>
          {phase === 'loading' && (
            <div style={styles.generating}>
              <div style={styles.spinner} />
              <p style={styles.generatingText}>
                Gathering this session&rsquo;s log&hellip;
              </p>
            </div>
          )}

          {phase === 'compose' && (
            <>
              {autoFilled ? (
                <p style={styles.tag}>
                  Auto-filled from <strong>{autoFilled.count}</strong> chat message{autoFilled.count === 1 ? '' : 's'} since
                  the last published chronicle{autoFilled.truncated ? ' (older lines trimmed to fit)' : ''}.
                  Edit anything below — when you click Forge, the Chronicler will polish whatever&rsquo;s in the box
                  into a recap.
                </p>
              ) : (
                <p style={styles.tag}>
                  Paste this session&rsquo;s chat log, your DM notes, or a quick summary. The Chronicler will polish
                  it into a 2-4 sentence recap, list the key characters and places, and draft a &ldquo;where you
                  left off&rdquo; line for the lobby.
                </p>
              )}
              <textarea
                style={styles.textarea}
                rows={14}
                value={transcript}
                onChange={(e) => { setTranscript(e.target.value); setAutoFilled(null); }}
                placeholder={`The party crossed the moor under heavy fog. Liraya rolled a natural 20 on Persuasion and turned a goblin captive into an ally. Bren took a critical hit and is at 3hp. Session ended mid-combat — three goblins remain at the Briar Hollow.`}
                autoFocus={!autoFilled}
              />
              <div style={styles.charCount}>
                {transcript.trim().length} chars · need ≥ 20
              </div>
              {error && <div style={styles.error}>{error}</div>}
            </>
          )}

          {phase === 'generating' && (
            <div style={styles.generating}>
              <div style={styles.spinner} />
              <p style={styles.generatingText}>
                The Chronicler is composing your session&rsquo;s tale. This usually takes a few seconds.
              </p>
              {entry?.modelUsed && (
                <p style={styles.generatingMeta}>via {entry.modelUsed}</p>
              )}
            </div>
          )}

          {phase === 'failed' && (
            <div style={styles.failed}>
              <p style={styles.error}>{error ?? 'Generation failed'}</p>
              <p style={styles.tag}>You can retry, or write your own recap by editing the fields directly.</p>
              <button style={styles.retryBtn} onClick={handleRetry} disabled={busy}>
                <RotateCw size={12} /> Retry
              </button>
            </div>
          )}

          {phase === 'review' && entry && (
            <>
              <p style={styles.tag}>
                Review and edit. <strong>Save Draft</strong> keeps it visible only to you;
                <strong> Publish</strong> shows it to every player in the campaign.
              </p>

              <div style={styles.field}>
                <label style={styles.label}>Recap (lobby rail)</label>
                <textarea
                  style={styles.textarea}
                  rows={4}
                  value={draftShort}
                  onChange={(e) => setDraftShort(e.target.value)}
                  maxLength={2000}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Full recap (read-more expand)</label>
                <textarea
                  style={styles.textarea}
                  rows={6}
                  value={draftFull}
                  onChange={(e) => setDraftFull(e.target.value)}
                  maxLength={8000}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Where you left off (Resume card)</label>
                <input
                  style={styles.input}
                  value={draftWhere}
                  onChange={(e) => setDraftWhere(e.target.value)}
                  maxLength={500}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Key entities (comma-separated; italicized in the lobby)</label>
                <input
                  style={styles.input}
                  value={draftEntities}
                  onChange={(e) => setDraftEntities(e.target.value)}
                  placeholder="Liraya, Briar Hollow, Mahadi"
                />
              </div>

              {entry.modelUsed && (
                <p style={styles.metaLine}>Generated by {entry.modelUsed} · Session #{entry.sequenceNumber}</p>
              )}
            </>
          )}
        </div>

        <div style={styles.foot}>
          {phase === 'loading' && (
            <button style={styles.ghostBtn} onClick={close}>Cancel</button>
          )}
          {phase === 'compose' && (
            <>
              <button style={styles.ghostBtn} onClick={close} disabled={busy}>Cancel</button>
              <button
                style={styles.primaryBtn}
                onClick={handleForge}
                disabled={busy || transcript.trim().length < 20}
              >
                <Sparkles size={12} /> Forge Chronicle
              </button>
            </>
          )}
          {phase === 'generating' && (
            <button style={styles.ghostBtn} onClick={close}>Hide</button>
          )}
          {phase === 'failed' && (
            <button style={styles.ghostBtn} onClick={close}>Close</button>
          )}
          {phase === 'review' && (
            <>
              <button style={styles.ghostBtn} onClick={close} disabled={busy}>Discard</button>
              <button style={styles.ghostBtn} onClick={handleSaveDraft} disabled={busy}>Save Draft</button>
              <button style={styles.primaryBtn} onClick={handlePublish} disabled={busy || !draftShort.trim()}>
                <Send size={12} /> Publish
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Inline styles, matched to the AppShell's existing dark palette ──
// Done as inline styles rather than the kbrt-lobby CSS module so this
// component can mount inside AppShell (where the kbrt-lobby class
// scope doesn't apply) without bringing the whole stylesheet along.
const styles: Record<string, React.CSSProperties> = {
  scrim: {
    position: 'fixed', inset: 0, background: 'rgba(4,2,1,.85)',
    backdropFilter: 'blur(4px)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    animation: 'fadeIn .2s ease',
  },
  modal: {
    width: 600, maxWidth: '92vw', maxHeight: '90vh',
    background: '#140e07', border: '1px solid rgba(199,150,50,.55)',
    borderRadius: 5, boxShadow: '0 30px 80px rgba(0,0,0,.8)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    color: '#ead6a8', fontFamily: 'Spectral, serif',
  },
  head: {
    display: 'flex', alignItems: 'center', padding: '18px 22px',
    borderBottom: '1px solid rgba(199,150,50,.30)', gap: 12,
  },
  title: {
    flex: 1, margin: 0,
    fontFamily: 'Cinzel, serif', fontSize: 18, letterSpacing: 3,
    color: '#e0b44f', textTransform: 'uppercase', fontWeight: 700,
  },
  closeBtn: {
    width: 28, height: 28, display: 'grid', placeItems: 'center',
    background: 'transparent', border: '1px solid rgba(199,150,50,.30)',
    color: '#a89271', cursor: 'pointer', borderRadius: 3,
  },
  body: { padding: '20px 22px', overflowY: 'auto', flex: 1 },
  foot: {
    padding: '14px 22px', borderTop: '1px solid rgba(199,150,50,.30)',
    display: 'flex', justifyContent: 'flex-end', gap: 8, background: '#0c0805',
  },
  tag: {
    fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic',
    color: '#a89271', fontSize: 14, lineHeight: 1.5, margin: '0 0 14px',
  },
  textarea: {
    width: '100%', padding: '10px 12px', boxSizing: 'border-box',
    background: '#0a0604', border: '1px solid rgba(199,150,50,.30)',
    borderRadius: 3, color: '#ead6a8',
    fontFamily: 'Spectral, serif', fontSize: 13, lineHeight: 1.5,
    outline: 'none', resize: 'vertical',
  },
  input: {
    width: '100%', padding: '10px 12px', boxSizing: 'border-box',
    background: '#0a0604', border: '1px solid rgba(199,150,50,.30)',
    borderRadius: 3, color: '#ead6a8',
    fontFamily: 'Spectral, serif', fontSize: 13, outline: 'none',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  label: {
    fontFamily: 'Cinzel, serif', fontSize: 9, letterSpacing: 2,
    color: '#6b5a3f', textTransform: 'uppercase',
  },
  charCount: {
    fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#6b5a3f',
    marginTop: 6, textAlign: 'right',
  },
  error: {
    padding: 10, marginTop: 8,
    background: 'rgba(201,66,58,.18)', border: '1px solid #c9423a',
    borderRadius: 3, color: '#c9423a', fontSize: 12,
  },
  generating: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '40px 20px', gap: 16,
  },
  spinner: {
    width: 36, height: 36, borderRadius: '50%',
    border: '3px solid rgba(224,180,79,.2)',
    borderTopColor: '#e0b44f',
    animation: 'spin 1s linear infinite',
  },
  generatingText: {
    fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic',
    color: '#a89271', fontSize: 14, textAlign: 'center', maxWidth: 320,
    margin: 0,
  },
  generatingMeta: {
    fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#6b5a3f',
    margin: 0, letterSpacing: 0.5,
  },
  failed: { display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' },
  retryBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', background: 'transparent',
    border: '1px solid rgba(199,150,50,.30)', borderRadius: 3,
    color: '#a89271', fontFamily: 'Cinzel, serif', fontSize: 10,
    letterSpacing: 2, textTransform: 'uppercase', cursor: 'pointer',
  },
  metaLine: {
    fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#6b5a3f',
    marginTop: 4, letterSpacing: 0.5,
  },
  primaryBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    background: 'linear-gradient(180deg, #e0b44f, #a27519)',
    color: '#0a0604', border: '1px solid #6b4a0f', borderRadius: 2,
    fontFamily: 'Cinzel, serif', fontSize: 10, letterSpacing: 2,
    textTransform: 'uppercase', fontWeight: 600, cursor: 'pointer',
  },
  ghostBtn: {
    padding: '8px 14px', background: 'transparent',
    border: '1px solid rgba(199,150,50,.30)', borderRadius: 2,
    color: '#a89271', fontFamily: 'Cinzel, serif', fontSize: 10,
    letterSpacing: 2, textTransform: 'uppercase', cursor: 'pointer',
  },
};

// Inject the spin keyframe once on module load so the Generating
// spinner has somewhere to animate from. AppShell already injects
// fadeIn elsewhere — duplicating here is harmless.
if (typeof document !== 'undefined' && !document.getElementById('chronicle-modal-keyframes')) {
  const style = document.createElement('style');
  style.id = 'chronicle-modal-keyframes';
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}
