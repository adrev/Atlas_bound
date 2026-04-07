import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Copy, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { useSocket } from '../../hooks/useSocket';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { BattleMap } from '../canvas/BattleMap';
import { InitiativeModal } from '../combat/InitiativeModal';
import { Sidebar } from './Sidebar';
import { BottomBar } from './BottomBar';
import { MapBrowser } from '../mapbrowser/MapBrowser';
import { CharacterSheetFull } from '../character/CharacterSheetFull';
import { theme } from '../../styles/theme';

export function AppShell() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const storeDisplayName = useSessionStore((s) => s.displayName);
  const gameMode = useSessionStore((s) => s.gameMode);
  const storedRoomCode = useSessionStore((s) => s.roomCode);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showMapBrowser, setShowMapBrowser] = useState(false);
  // Hold only the character ID — the actual character object is read live
  // from useCharacterStore so updates (e.g. adding a spell, healing) appear
  // immediately without needing to re-open the sheet.
  const [fullSheetCharId, setFullSheetCharId] = useState<string | null>(null);
  const fullSheetCharacter = useCharacterStore(
    (s) => fullSheetCharId ? (s.allCharacters[fullSheetCharId] ?? null) : null,
  );
  const [requestedTab, setRequestedTab] = useState<string | null>(null);
  const currentMap = useMapStore((s) => s.currentMap);
  const isDM = useSessionStore((s) => s.isDM);
  const [showInitiativeModal, setShowInitiativeModal] = useState(false);

  // Persist displayName to localStorage so reconnects/refreshes work
  const [localName, setLocalName] = useState<string | null>(() => {
    return storeDisplayName || localStorage.getItem('dnd-vtt-displayName');
  });

  // If we have a store name, save it
  useEffect(() => {
    if (storeDisplayName) {
      localStorage.setItem('dnd-vtt-displayName', storeDisplayName);
      setLocalName(storeDisplayName);
    }
  }, [storeDisplayName]);

  // Prompt for name if navigating directly to a session URL
  const displayName = localName;
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameInput, setNameInput] = useState(localStorage.getItem('dnd-vtt-displayName') || '');

  useEffect(() => {
    if (!displayName && roomCode) {
      setShowNamePrompt(true);
    }
  }, [displayName, roomCode]);

  const handleNameSubmit = async () => {
    if (!nameInput.trim() || !roomCode) return;
    const name = nameInput.trim();
    try {
      await fetch('/api/sessions/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode, displayName: name }),
      });
    } catch { /* session might already have this user */ }
    localStorage.setItem('dnd-vtt-displayName', name);
    setLocalName(name);
    setShowNamePrompt(false);
  };

  useSocket(roomCode, displayName);

  // Show initiative modal when combat starts - use subscribe to avoid re-render loops
  useEffect(() => {
    const unsub = useCombatStore.subscribe((state, prev) => {
      if (state.active && !prev.active && state.combatants.length > 0) {
        setShowInitiativeModal(true);
      }
      if (!state.active && prev.active) {
        setShowInitiativeModal(false);
      }
    });
    return unsub;
  }, []);

  // Listen for custom events from DMToolbar
  useEffect(() => {
    const handleOpenMapBrowser = () => setShowMapBrowser(true);
    const handleOpenMapUpload = () => setShowMapBrowser(true);
    window.addEventListener('open-map-browser', handleOpenMapBrowser);
    window.addEventListener('open-map-upload', handleOpenMapUpload);
    return () => {
      window.removeEventListener('open-map-browser', handleOpenMapBrowser);
      window.removeEventListener('open-map-upload', handleOpenMapUpload);
    };
  }, []);

  // Listen for token click -> open character sheet
  useEffect(() => {
    const handleOpenCharacterSheet = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const charId = detail?.characterId as string;
      const tab = detail?.tab as string | undefined;
      if (!charId) return;

      const currentMyChar = useCharacterStore.getState().myCharacter;
      const currentAllChars = useCharacterStore.getState().allCharacters;

      // Store the requested tab for when the sheet opens
      if (tab) setRequestedTab(tab);

      if (currentMyChar && currentMyChar.id === charId) {
        window.dispatchEvent(new Event('open-my-full-sheet'));
        return;
      }

      const char = currentAllChars[charId];
      if (char) {
        setFullSheetCharId(charId);
      } else {
        // Fetch into the store so the live subscription picks it up
        fetch(`/api/characters/${charId}`)
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (data) {
              useCharacterStore.getState().setAllCharacters({
                ...useCharacterStore.getState().allCharacters,
                [charId]: data,
              });
              setFullSheetCharId(charId);
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener('open-character-sheet', handleOpenCharacterSheet);
    return () => window.removeEventListener('open-character-sheet', handleOpenCharacterSheet);
  }, []);

  const handleCopyCode = () => {
    const code = storedRoomCode || roomCode || '';
    // Copy just the room code, not the full URL
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } else {
      // Old browser fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Show name prompt if navigating directly to session URL without a name
  if (showNamePrompt) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: theme.bg.deepest, fontFamily: theme.font.body,
      }}>
        <div style={{
          background: theme.bg.card, border: `1px solid ${theme.border.default}`,
          borderRadius: theme.radius.lg, padding: '32px 40px', maxWidth: 400,
          textAlign: 'center',
        }}>
          <img src="/atlas-bound-logo.png" alt="Atlas Bound" style={{ width: 64, height: 64, borderRadius: '50%', marginBottom: 8 }} />
          <h2 style={{ color: theme.gold.primary, fontFamily: theme.font.display, margin: '0 0 8px' }}>
            Join Session
          </h2>
          <p style={{ color: theme.text.secondary, fontSize: 13, margin: '0 0 20px' }}>
            Enter your display name to join room <strong style={{ color: theme.text.primary }}>{roomCode}</strong>
          </p>
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
            placeholder="Your Display Name"
            autoFocus
            style={{
              width: '100%', padding: '10px 14px', fontSize: 14,
              background: theme.bg.deep, border: `1px solid ${theme.border.default}`,
              borderRadius: theme.radius.md, color: theme.text.primary,
              outline: 'none', marginBottom: 12, boxSizing: 'border-box',
            }}
          />
          <button
            onClick={handleNameSubmit}
            disabled={!nameInput.trim()}
            style={{
              width: '100%', padding: '10px', fontSize: 14, fontWeight: 600,
              background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
              borderRadius: theme.radius.md, color: theme.gold.primary,
              cursor: nameInput.trim() ? 'pointer' : 'not-allowed',
              opacity: nameInput.trim() ? 1 : 0.5,
            }}
          >
            Join Game
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.topLeft}>
          <button style={styles.codeButton} onClick={handleCopyCode} title="Copy invite link for players">
            <Copy size={14} />
            <span style={styles.codeText}>
              {storedRoomCode || roomCode || '---'}
            </span>
            <span style={{ fontSize: 10, color: theme.text.muted, marginLeft: 4 }}>Invite</span>
            {copied && <span style={styles.copiedBadge}>Room code copied!</span>}
          </button>
          <div
            style={{
              ...styles.modeBadge,
              ...(gameMode === 'combat' ? styles.modeCombat : styles.modeFreeRoam),
            }}
          >
            {gameMode === 'combat' ? 'Combat' : 'Free Roam'}
          </div>
        </div>
        <button
          className="btn-icon"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        >
          {sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
      </div>

      {/* Main content */}
      <div style={styles.main}>
        {/* Canvas area */}
        <div style={styles.canvasArea}>
          <BattleMap />
        </div>

        {/* Sidebar */}
        {sidebarOpen && (
          <div style={styles.sidebar}>
            <Sidebar />
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={styles.bottomBar}>
        <BottomBar />
      </div>

      {/* Map Browser Modal - shown when DM clicks Load Map or no map is loaded */}
      {(showMapBrowser || (!currentMap && isDM)) && (
        <div style={styles.mapBrowserOverlay}>
          <div style={styles.mapBrowserContainer}>
            {currentMap && (
              <button
                style={styles.closeMapBrowser}
                onClick={() => setShowMapBrowser(false)}
              >
                X Close
              </button>
            )}
            <MapBrowser onMapLoaded={() => setShowMapBrowser(false)} />
          </div>
        </div>
      )}
      {/* Initiative Modal */}
      {showInitiativeModal && (
        <InitiativeModal onClose={() => setShowInitiativeModal(false)} />
      )}
      {/* Character Sheet Full overlay - from token click */}
      {fullSheetCharacter && (
        <div style={styles.fullSheetOverlay}>
          <div style={styles.fullSheetContainer}>
            <button
              style={styles.closeFullSheet}
              onClick={() => setFullSheetCharId(null)}
            >
              <X size={16} />
            </button>
            <CharacterSheetFull
              character={fullSheetCharacter}
              onClose={() => { setFullSheetCharId(null); setRequestedTab(null); }}
              initialTab={requestedTab || undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: theme.bg.deepest,
    overflow: 'hidden',
  },
  topBar: {
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    background: theme.bg.deep,
    borderBottom: `1px solid ${theme.border.default}`,
    flexShrink: 0,
    zIndex: 10,
  },
  topLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  codeButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    fontSize: 13,
    cursor: 'pointer',
    position: 'relative' as const,
    transition: 'border-color 0.15s ease',
  },
  codeText: {
    fontFamily: 'monospace',
    letterSpacing: '2px',
    fontWeight: 600,
    color: theme.text.primary,
  },
  copiedBadge: {
    position: 'absolute' as const,
    top: -28,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '2px 8px',
    background: theme.heal,
    color: '#fff',
    fontSize: 11,
    borderRadius: theme.radius.sm,
    whiteSpace: 'nowrap' as const,
    animation: 'fadeIn 0.15s ease',
  },
  modeBadge: {
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '1px',
    borderRadius: theme.radius.sm,
  },
  modeFreeRoam: {
    background: 'rgba(52, 152, 219, 0.15)',
    color: theme.blue,
    border: `1px solid rgba(52, 152, 219, 0.3)`,
  },
  modeCombat: {
    background: 'rgba(192, 57, 43, 0.15)',
    color: theme.danger,
    border: `1px solid rgba(192, 57, 43, 0.3)`,
    animation: 'pulse 2s ease-in-out infinite',
  },
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
    minHeight: 0,
  },
  canvasArea: {
    flex: 1,
    position: 'relative' as const,
    overflow: 'hidden',
    minWidth: 0,
  },
  sidebar: {
    width: 360,
    flexShrink: 0,
    borderLeft: `1px solid ${theme.border.default}`,
    background: theme.bg.deep,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    animation: 'fadeIn 0.2s ease',
  },
  bottomBar: {
    height: 80,
    flexShrink: 0,
    borderTop: `1px solid ${theme.border.default}`,
    background: theme.bg.deep,
  },
  mapBrowserOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.2s ease',
  },
  mapBrowserContainer: {
    width: '90%',
    maxWidth: 900,
    maxHeight: '85vh',
    overflow: 'auto',
    background: theme.bg.deep,
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.border.default}`,
    boxShadow: theme.shadow.lg,
    position: 'relative' as const,
  },
  closeMapBrowser: {
    position: 'sticky' as const,
    bottom: 0,
    zIndex: 20,
    display: 'block',
    width: '100%',
    padding: '10px 16px',
    background: theme.bg.deep,
    borderTop: `1px solid ${theme.border.default}`,
    color: theme.text.secondary,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  fullSheetOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0, 0, 0, 0.85)',
    zIndex: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'fadeIn 0.2s ease',
  },
  fullSheetContainer: {
    width: '90%',
    maxWidth: 1000,
    maxHeight: '90vh',
    overflow: 'auto',
    background: '#1a1a1a',
    borderRadius: 12,
    border: `1px solid ${theme.border.default}`,
    boxShadow: '0 16px 64px rgba(0,0,0,0.6)',
    position: 'relative' as const,
  },
  closeFullSheet: {
    position: 'absolute' as const,
    top: 12,
    right: 12,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    color: theme.text.secondary,
    cursor: 'pointer',
  },
};
