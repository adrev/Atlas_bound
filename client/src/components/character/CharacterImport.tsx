import { useState } from 'react';
import { X, Upload, Globe, AlertTriangle, RefreshCw } from 'lucide-react';
import { importDndBeyondJSON } from '../../services/api';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import type { Character } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

interface CharacterImportProps {
  onClose: () => void;
}

type ImportTab = 'json' | 'api';

/**
 * Extract numeric character ID from a full D&D Beyond URL or plain ID.
 * Accepts:
 *   - "163807652"
 *   - "https://www.dndbeyond.com/characters/163807652"
 *   - "https://dndbeyond.com/characters/163807652"
 *   - "dndbeyond.com/characters/163807652"
 *   - "www.dndbeyond.com/characters/163807652/anything"
 */
function extractCharacterId(input: string): string | null {
  const trimmed = input.trim();
  // Plain numeric ID
  if (/^\d+$/.test(trimmed)) return trimmed;
  // URL pattern
  const match = trimmed.match(/dndbeyond\.com\/characters\/(\d+)/);
  if (match) return match[1];
  return null;
}

export function CharacterImport({ onClose }: CharacterImportProps) {
  const [activeTab, setActiveTab] = useState<ImportTab>('api');
  const [jsonText, setJsonText] = useState('');
  const [apiInput, setApiInput] = useState('');
  const [preview, setPreview] = useState<Partial<Character> & { _rawJson?: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const setCharacter = useCharacterStore((s) => s.setCharacter);
  const userId = useSessionStore((s) => s.userId);

  const handleParseJSON = () => {
    setError(null);
    setPreview(null);
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed.name && !parsed.data?.name) {
        throw new Error('Invalid character JSON: missing name field');
      }
      const data = parsed.data ?? parsed;
      setPreview({
        name: data.name || 'Unknown',
        race: data.race?.fullName || data.race || 'Unknown',
        class: data.classes?.[0]?.definition?.name || data.class || 'Unknown',
        level: data.classes?.reduce((sum: number, c: { level: number }) => sum + c.level, 0) || data.level || 1,
        _rawJson: parsed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse JSON');
    }
  };

  const handleFetchFromDDB = async () => {
    setError(null);
    setPreview(null);
    const charId = extractCharacterId(apiInput);
    if (!charId) {
      setError('Invalid input. Paste a D&D Beyond character URL (e.g. https://www.dndbeyond.com/characters/163807652) or just the numeric ID.');
      return;
    }
    setFetching(true);
    try {
      const resp = await fetch(`/api/dndbeyond/character/${charId}`);
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch character (${resp.status})`);
      }
      const json = await resp.json();
      const data = json.data ?? json;
      const classes = data.classes as Array<{ definition: { name: string }; level: number }> | undefined;
      const className = classes?.map((c) => `${c.definition.name} ${c.level}`).join(' / ') || 'Unknown';
      const totalLevel = classes?.reduce((sum, c) => sum + c.level, 0) || 1;
      const raceName = data.race?.fullName || data.race?.baseName || 'Unknown';
      setPreview({
        name: data.name || 'Unknown',
        race: raceName,
        class: className,
        level: totalLevel,
        _rawJson: json,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch from D&D Beyond');
    } finally {
      setFetching(false);
    }
  };

  const handleImport = async () => {
    setLoading(true);
    setError(null);
    try {
      const characterJson = activeTab === 'json'
        ? JSON.parse(jsonText)
        : preview?._rawJson;
      if (!characterJson) {
        throw new Error('No character data. Fetch the character first.');
      }
      const resp = await fetch('/api/dndbeyond/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterJson, userId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || 'Import failed');
      }
      const result = await resp.json();
      // Fetch the full character to populate the store
      const charResp = await fetch(`/api/characters/${result.id}`);
      if (charResp.ok) {
        const fullChar = await charResp.json();
        setCharacter(fullChar as Character);
        localStorage.setItem('dnd-vtt-characterId', result.id);
        // Newly imported character — pull snapshot so the server's
        // view of everything else (tokens, combat, other chars)
        // rehydrates with this character properly linked.
        const { triggerSnapshot } = await import('../../socket/stateSnapshot');
        triggerSnapshot('character:import');

        // Link this character to the player's session so it auto-loads on rejoin
        const sessionId = useSessionStore.getState().sessionId;
        const myUserId = useSessionStore.getState().userId;
        if (sessionId && myUserId) {
          fetch(`/api/sessions/${sessionId}/link-character`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: myUserId, characterId: result.id }),
          }).catch(() => {});
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === 'string') {
        setJsonText(text);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h3 style={styles.title}>Import Character</h3>
          <button className="btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'json' ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab('json')}
          >
            <Upload size={14} />
            Import JSON
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeTab === 'api' ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab('api')}
          >
            <Globe size={14} />
            API Sync
          </button>
        </div>

        {/* Content */}
        <div style={styles.content}>
          {activeTab === 'json' && (
            <>
              <textarea
                style={styles.textarea}
                placeholder="Paste your D&D Beyond character JSON here..."
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                rows={10}
              />
              <div style={styles.row}>
                <label style={styles.fileLabel}>
                  <Upload size={14} />
                  Upload File
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </label>
                <button
                  className="btn-secondary"
                  onClick={handleParseJSON}
                  disabled={!jsonText.trim()}
                >
                  Parse
                </button>
              </div>
            </>
          )}

          {activeTab === 'api' && (
            <>
              <p style={{ fontSize: 13, color: theme.text.secondary, margin: '0 0 4px' }}>
                Paste your D&D Beyond character URL or ID:
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="https://www.dndbeyond.com/characters/163807652"
                  value={apiInput}
                  onChange={(e) => setApiInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleFetchFromDDB()}
                />
                <button
                  className="btn-primary"
                  onClick={handleFetchFromDDB}
                  disabled={fetching || !apiInput.trim()}
                  style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <RefreshCw size={14} style={fetching ? { animation: 'spin 1s linear infinite' } : undefined} />
                  {fetching ? 'Fetching...' : 'Fetch'}
                </button>
              </div>
              <div style={styles.warning}>
                <AlertTriangle size={16} color={theme.hp.half} />
                <p style={styles.warningText}>
                  Character must be set to <strong>public</strong> on D&D Beyond for this to work.
                  Go to your character sheet on D&D Beyond, click the share icon, and enable public sharing.
                </p>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div style={styles.error}>{error}</div>
          )}

          {/* Preview */}
          {preview && (
            <div style={styles.preview}>
              <h4 style={styles.previewTitle}>Preview</h4>
              <p style={styles.previewLine}>
                <strong>{preview.name}</strong>
              </p>
              <p style={styles.previewLine}>
                Lv.{preview.level} {preview.race} {preview.class}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={
              loading ||
              (activeTab === 'json' && !jsonText.trim()) ||
              (activeTab === 'api' && !preview)
            }
          >
            {loading ? 'Importing...' : 'Import Character'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    animation: 'fadeIn 0.15s ease',
  },
  modal: {
    width: '90%',
    maxWidth: 520,
    maxHeight: '80vh',
    background: theme.bg.card,
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.border.default}`,
    boxShadow: theme.shadow.lg,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    animation: 'scaleIn 0.2s ease',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: `1px solid ${theme.border.default}`,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.text.primary,
    fontFamily: theme.font.display,
    margin: 0,
  },
  tabs: {
    display: 'flex',
    borderBottom: `1px solid ${theme.border.default}`,
  },
  tab: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: theme.text.muted,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  tabActive: {
    color: theme.gold.primary,
    borderBottomColor: theme.gold.primary,
  },
  content: {
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'auto',
    flex: 1,
  },
  textarea: {
    width: '100%',
    minHeight: 120,
    padding: 12,
    fontSize: 12,
    fontFamily: 'monospace',
    background: theme.bg.deep,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    color: theme.text.primary,
    resize: 'vertical' as const,
    outline: 'none',
  },
  row: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  fileLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    color: theme.text.secondary,
    fontSize: 13,
    cursor: 'pointer',
    transition: 'border-color 0.15s ease',
  },
  warning: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    background: 'rgba(243, 156, 18, 0.1)',
    border: `1px solid rgba(243, 156, 18, 0.25)`,
    borderRadius: theme.radius.md,
  },
  warningText: {
    fontSize: 13,
    color: theme.text.secondary,
    margin: 0,
    lineHeight: 1.4,
  },
  error: {
    padding: '10px 14px',
    background: 'rgba(192, 57, 43, 0.15)',
    border: `1px solid rgba(192, 57, 43, 0.3)`,
    borderRadius: theme.radius.md,
    color: theme.danger,
    fontSize: 13,
  },
  preview: {
    padding: 12,
    background: theme.bg.elevated,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.light}`,
  },
  previewTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: theme.text.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    margin: '0 0 6px',
  },
  previewLine: {
    fontSize: 13,
    color: theme.text.primary,
    margin: '2px 0',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 20px',
    borderTop: `1px solid ${theme.border.default}`,
  },
};
