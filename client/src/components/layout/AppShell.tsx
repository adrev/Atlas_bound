import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Copy, PanelRightClose, PanelRightOpen, X, LogOut, Home, UserCog, ChevronDown, Menu } from 'lucide-react';
import { useSocket } from '../../hooks/useSocket';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { disconnectSocket } from '../../socket/client';
import { BattleMap } from '../canvas/BattleMap';
import { MapTransition } from '../canvas/MapTransition';
import { PreviewModeBanner } from '../dm/PreviewModeBanner';
import { InitiativeModal } from '../combat/InitiativeModal';
import { OpportunityAttackModal } from '../combat/OpportunityAttackModal';
import { CounterspellModal } from '../combat/CounterspellModal';
import { ShieldModal } from '../combat/ShieldModal';
import { ReadyCheckModal } from '../combat/ReadyCheckModal';
import { MusicEngine } from '../audio/MusicEngine';
// Sidebar is large (DM panels, scene manager, creature library). Lazy-loaded
// so the initial session bundle stays under the 500 kB warning threshold.
const Sidebar = lazy(() => import('./Sidebar').then((m) => ({ default: m.Sidebar })));
import { BottomBar } from './BottomBar';
import { MobileBottomBar } from './MobileBottomBar';
import type { MobileTab } from './MobileBottomBar';
import { ChatPanel } from '../chat/ChatPanel';
import { DiceTray } from '../dice/DiceTray';
import { TokenActionPanel } from '../canvas/TokenActionPanel';
import { theme } from '../../styles/theme';
import { ToastHost } from '../ui/Toast';
import { DialogHost } from '../ui/Dialog';

// Lazy-load the 3D dice overlay so Three.js (~500 KB min+gz) is only
// pulled in on first roll, not during the initial app boot.
const Dice3DOverlay = lazy(() =>
  import('../dice/Dice3DOverlay').then((m) => ({ default: m.Dice3DOverlay })),
);

// Lazy-loaded modals/panels — only fetched when first shown. Each of
// these is either DM-only, modal-only, or infrequently used, so
// keeping them out of the main chunk saves significant initial bytes.
const CombatRecap = lazy(() =>
  import('../combat/CombatRecap').then((m) => ({ default: m.CombatRecap })),
);
const ProfileModal = lazy(() =>
  import('../auth/ProfileModal').then((m) => ({ default: m.ProfileModal })),
);
const HandoutModal = lazy(() =>
  import('../session/HandoutModal').then((m) => ({ default: m.HandoutModal })),
);
const MapBrowser = lazy(() =>
  import('../mapbrowser/MapBrowser').then((m) => ({ default: m.MapBrowser })),
);
const CharacterSheetFull = lazy(() =>
  import('../character/CharacterSheetFull').then((m) => ({ default: m.CharacterSheetFull })),
);

export function AppShell() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const storeDisplayName = useSessionStore((s) => s.displayName);
  const gameMode = useSessionStore((s) => s.gameMode);
  const storedRoomCode = useSessionStore((s) => s.roomCode);
  const authUser = useAuthStore((s) => s.user);
  const authLogout = useAuthStore((s) => s.logout);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<MobileTab>('map');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showMapBrowser, setShowMapBrowser] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
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

  useSocket(roomCode);

  // Show the InitiativeModal whenever combat transitions from
  // inactive → active. We deliberately use a hook subscription +
  // useEffect rather than Zustand's imperative `.subscribe()` here
  // because the imperative version fires its callback synchronously
  // on every store update — including updates that land DURING
  // InitiativeModal's render — which triggered React's
  // "Cannot update a component (AppShell) while rendering a
  // different component (InitiativeModal)" warning. The
  // useEffect runs after commit so the warning goes away.
  const combatActive = useCombatStore((s) => s.active);
  const combatantCount = useCombatStore((s) => s.combatants.length);
  const prevCombatActiveRef = useRef(false);
  useEffect(() => {
    const wasActive = prevCombatActiveRef.current;
    if (combatActive && !wasActive && combatantCount > 0) {
      setShowInitiativeModal(true);
    } else if (!combatActive && wasActive) {
      setShowInitiativeModal(false);
    }
    prevCombatActiveRef.current = combatActive;
  }, [combatActive, combatantCount]);

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

  // QuickActions → Short Rest dispatches this event. We open the
  // full character sheet modal for the current user's character so
  // their existing Short Rest dialog button is available.
  useEffect(() => {
    const handleOpenFullSheet = () => {
      const myChar = useCharacterStore.getState().myCharacter;
      if (myChar?.id) {
        setFullSheetCharId(myChar.id);
      }
    };
    window.addEventListener('open-full-character-sheet', handleOpenFullSheet);
    return () => {
      window.removeEventListener('open-full-character-sheet', handleOpenFullSheet);
    };
  }, []);

  // Listen for token click -> open character sheet.
  //
  // This always routes through AppShell's own `fullSheetCharId` modal
  // path so the sheet opens reliably regardless of which sidebar tab
  // is active. Previously, if the target was the current user's own
  // character, this handler dispatched `open-my-full-sheet` for the
  // CharacterSheet sidebar component to pick up — but CharacterSheet
  // is conditionally mounted (only rendered when the Character tab
  // is active), so clicking Inventory while on the Chat tab silently
  // did nothing. Routing everything through this modal fixes the bug
  // and also ensures `requestedTab` is honored in both cases.
  useEffect(() => {
    const handleOpenCharacterSheet = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const charId = detail?.characterId as string;
      const tab = detail?.tab as string | undefined;
      if (!charId) return;

      // Store the requested tab for when the sheet opens
      if (tab) setRequestedTab(tab);

      // Ensure the character is in the store, then open the modal.
      const currentMyChar = useCharacterStore.getState().myCharacter;
      const currentAllChars = useCharacterStore.getState().allCharacters;
      const inStore =
        (currentMyChar && currentMyChar.id === charId)
          ? currentMyChar
          : currentAllChars[charId];

      if (inStore) {
        // Make sure myCharacter is also mirrored into allCharacters so
        // the modal's `fullSheetCharacter` lookup finds it.
        if (currentMyChar && currentMyChar.id === charId && !currentAllChars[charId]) {
          useCharacterStore.getState().setAllCharacters({
            ...currentAllChars,
            [charId]: currentMyChar,
          });
        }
        setFullSheetCharId(charId);
      } else {
        // Fetch into the store so the live subscription picks it up.
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

  // Close user menu on click outside
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  const handleLogout = async () => {
    setShowUserMenu(false);
    disconnectSocket();
    await authLogout();
    navigate('/');
  };

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
          <img src="/kbrt-logo.svg" alt="KBRT.AI" style={{ width: 80, height: 80, marginBottom: 8 }} />
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

  // Helper: resolve my token ID for the mobile character tab
  const myCharacter = useCharacterStore((s) => s.myCharacter);
  const tokens = useMapStore((s) => s.tokens);
  const myTokenId = myCharacter
    ? Object.values(tokens).find((t) => t.characterId === myCharacter?.id)?.id
    : undefined;

  // -----------------------------------------------------------------------
  // Shared modals (rendered in both layouts)
  // -----------------------------------------------------------------------
  const sharedModals = (
    <>
      {/* Map Browser Modal */}
      <Suspense fallback={null}>
        {(showMapBrowser || (!currentMap && isDM)) && (
          <div style={styles.mapBrowserOverlay}>
            <div style={styles.mapBrowserContainer}>
              <MapBrowser
                onMapLoaded={() => setShowMapBrowser(false)}
                onClose={currentMap ? () => setShowMapBrowser(false) : undefined}
              />
            </div>
          </div>
        )}
      </Suspense>
      {showInitiativeModal && (
        <InitiativeModal onClose={() => setShowInitiativeModal(false)} />
      )}
      <OpportunityAttackModal />
      <CounterspellModal />
      <ShieldModal />
      <ReadyCheckModal />
      <Suspense fallback={null}>
        <CombatRecap />
      </Suspense>
      <MusicEngine />
      <ToastHost />
      <DialogHost />
      <Suspense fallback={null}>
        <HandoutModal />
      </Suspense>
      <Suspense fallback={null}>
        <ProfileModal open={showProfileModal} onClose={() => setShowProfileModal(false)} />
      </Suspense>
      <Suspense fallback={null}>
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
      </Suspense>
    </>
  );

  // -----------------------------------------------------------------------
  // MOBILE LAYOUT
  // -----------------------------------------------------------------------
  if (isMobile) {
    return (
      <div style={styles.container}>
        {/* Simplified top bar */}
        <div style={styles.topBar}>
          <div style={styles.topLeft}>
            <button style={styles.codeButton} onClick={handleCopyCode} title="Copy room code">
              <Copy size={14} />
              <span style={styles.codeText}>
                {storedRoomCode || roomCode || '---'}
              </span>
              {copied && <span style={styles.copiedBadge}>Copied!</span>}
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
            style={styles.mobileMenuBtn}
            onClick={() => setMobileSidebarOpen(true)}
            title="Open menu"
          >
            <Menu size={20} />
          </button>
        </div>

        {/* Mobile main content — single active panel */}
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}>
          {mobileTab === 'map' && (
            <div style={styles.canvasArea}>
              <BattleMap />
              <MapTransition />
              <PreviewModeBanner />
            </div>
          )}
          {mobileTab === 'character' && (
            <div style={styles.mobilePanel}>
              {myTokenId ? (
                <TokenActionPanel embedded embeddedTokenId={myTokenId} />
              ) : myCharacter ? (
                <div style={styles.mobileCharEmpty}>
                  <p style={{ color: theme.text.secondary, fontSize: 14, margin: 0 }}>
                    {myCharacter.name} is not placed on the map yet.
                  </p>
                </div>
              ) : (
                <div style={styles.mobileCharEmpty}>
                  <p style={{ color: theme.text.muted, fontSize: 14, margin: 0 }}>
                    No character loaded. Open the menu to import one.
                  </p>
                </div>
              )}
            </div>
          )}
          {mobileTab === 'chat' && (
            <div style={styles.mobilePanel}>
              <ChatPanel />
            </div>
          )}
          {mobileTab === 'dice' && (
            <div style={styles.mobileDicePanel}>
              <DiceTray />
            </div>
          )}
        </div>

        {/* Mobile bottom tab bar */}
        <MobileBottomBar activeTab={mobileTab} onTabChange={setMobileTab} />

        {/* Mobile sidebar overlay */}
        {mobileSidebarOpen && (
          <div
            style={styles.mobileSidebarOverlay}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setMobileSidebarOpen(false);
            }}
          >
            <div style={styles.mobileSidebarContainer}>
              <div style={styles.mobileSidebarHeader}>
                <span style={{ fontSize: 14, fontWeight: 700, color: theme.gold.primary }}>Menu</span>
                <button
                  style={styles.closeFullSheet}
                  onClick={() => setMobileSidebarOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <Suspense fallback={null}>
                  <Sidebar />
                </Suspense>
              </div>
            </div>
          </div>
        )}

        {sharedModals}
        <Suspense fallback={null}><Dice3DOverlay /></Suspense>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // DESKTOP LAYOUT
  // -----------------------------------------------------------------------
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* User Menu */}
          {authUser && (
            <div ref={userMenuRef} style={{ position: 'relative' }}>
              <button
                style={styles.userMenuButton}
                onClick={() => setShowUserMenu(!showUserMenu)}
              >
                {authUser.avatarUrl ? (
                  <img
                    src={authUser.avatarUrl}
                    alt={authUser.displayName}
                    style={styles.userMenuAvatar}
                  />
                ) : (
                  <div style={styles.userMenuAvatarPlaceholder}>
                    {authUser.displayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <span style={styles.userMenuName}>{authUser.displayName}</span>
                <ChevronDown size={12} style={{
                  color: theme.text.muted,
                  transition: `transform ${theme.motion.fast}`,
                  transform: showUserMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                }} />
              </button>
              {showUserMenu && (
                <div style={styles.userDropdown}>
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { setShowUserMenu(false); setShowProfileModal(true); }}
                  >
                    <UserCog size={14} />
                    Profile
                  </button>
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { setShowUserMenu(false); navigate('/'); }}
                  >
                    <Home size={14} />
                    Back to Lobby
                  </button>
                  <div style={styles.dropdownDivider} />
                  <button
                    style={{ ...styles.dropdownItem, color: theme.danger }}
                    onClick={handleLogout}
                  >
                    <LogOut size={14} />
                    Log Out
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            className="btn-icon"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={styles.main}>
        {/* Canvas area */}
        <div style={styles.canvasArea}>
          <BattleMap />
          <MapTransition />
          <PreviewModeBanner />
        </div>

        {/* Sidebar */}
        {sidebarOpen && (
          <div style={styles.sidebar}>
            <Suspense fallback={null}>
              <Sidebar />
            </Suspense>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={styles.bottomBar}>
        <BottomBar />
      </div>

      {sharedModals}
      <Suspense fallback={null}><Dice3DOverlay /></Suspense>
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
    background: theme.state.infoBg,
    color: theme.blue,
    border: `1px solid rgba(52, 152, 219, 0.3)`,
  },
  modeCombat: {
    background: `linear-gradient(135deg, ${theme.state.dangerBg}, rgba(192,57,43,0.25))`,
    color: theme.state.danger,
    border: `1px solid ${theme.state.danger}`,
    boxShadow: theme.dangerGlow,
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
    height: 64,
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
    background: theme.bg.deep,
    borderRadius: theme.radius.lg,
    border: `1px solid ${theme.border.default}`,
    boxShadow: theme.shadow.lg,
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
  // User menu styles
  userMenuButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    background: 'transparent',
    border: `1px solid transparent`,
    borderRadius: theme.radius.sm,
    color: theme.text.secondary,
    fontSize: 12,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  userMenuAvatar: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    objectFit: 'cover' as const,
  },
  userMenuAvatarPlaceholder: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: theme.gold.bg,
    border: `1px solid ${theme.gold.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    color: theme.gold.primary,
  },
  userMenuName: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.primary,
    maxWidth: 100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  userDropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: 4,
    minWidth: 160,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.lg,
    padding: '4px 0',
    zIndex: 50,
    animation: 'fadeIn 0.12s ease',
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    color: theme.text.secondary,
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: `background ${theme.motion.fast}`,
  },
  dropdownDivider: {
    height: 1,
    background: theme.border.default,
    margin: '4px 0',
  },
  // Mobile-specific styles
  mobileMenuBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    background: 'transparent',
    border: 'none',
    color: theme.text.secondary,
    cursor: 'pointer',
    borderRadius: theme.radius.sm,
  },
  mobilePanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'auto',
    background: theme.bg.deep,
  },
  mobileDicePanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    overflow: 'auto',
    background: theme.bg.deep,
    padding: 24,
    gap: 16,
  },
  mobileCharEmpty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 32,
    textAlign: 'center' as const,
  },
  mobileSidebarOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0, 0, 0, 0.7)',
    zIndex: 300,
    animation: 'fadeIn 0.15s ease',
  },
  mobileSidebarContainer: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: '85%',
    maxWidth: 360,
    background: theme.bg.deep,
    borderLeft: `1px solid ${theme.border.default}`,
    display: 'flex',
    flexDirection: 'column' as const,
    animation: 'fadeIn 0.15s ease',
  },
  mobileSidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: `1px solid ${theme.border.default}`,
    flexShrink: 0,
  },
};
