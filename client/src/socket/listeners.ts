import type { Socket } from 'socket.io-client';
import type { Combatant } from '@dnd-vtt/shared';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useChatStore } from '../stores/useChatStore';
import { useDiceStore } from '../stores/useDiceStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useDrawStore } from '../stores/useDrawStore';
import { useSceneStore } from '../stores/useSceneStore';
import { pushHandout } from '../components/session/HandoutModal';
import { pushOpportunityAttack } from '../components/combat/OpportunityAttackModal';
import { pushCounterspellOpportunity } from '../components/combat/CounterspellModal';
import { pushShieldOpportunity } from '../components/combat/ShieldModal';
import { PREBUILT_THUMBNAIL as PREBUILT_IMAGE_MAP } from '../data/prebuiltMaps';

export function registerListeners(socket: Socket): () => void {
  const sessionStore = useSessionStore.getState;

  // --- Session ---
  socket.on('session:state-sync', (data) => {
    useSessionStore.getState().setSession({
      sessionId: data.sessionId,
      roomCode: data.roomCode,
      userId: data.userId,
      isDM: data.isDM,
      players: data.players,
      settings: data.settings,
      currentMapId: data.currentMapId,
      gameMode: data.gameMode,
      visibility: data.visibility,
      hasPassword: data.hasPassword,
      inviteCode: data.inviteCode,
      ownerUserId: data.ownerUserId,
      bans: data.bans,
    });
  });

  socket.on('session:player-joined', (player) => {
    useSessionStore.getState().addPlayer(player);
  });

  socket.on('session:player-left', ({ userId }) => {
    useSessionStore.getState().removePlayer(userId);
  });

  socket.on('session:kicked', ({ userId }) => {
    const state = sessionStore();
    if (state.userId === userId) {
      useSessionStore.getState().reset();
      window.location.href = '/';
    } else {
      useSessionStore.getState().removePlayer(userId);
    }
  });

  socket.on('session:settings-updated', (settings) => {
    useSessionStore.getState().updateSettings(settings);
  });

  socket.on('session:error', ({ message }) => {
    console.error('[Session Error]', message);
    // Surface the problem to the user \u2014 previously swallowed, which
    // left people staring at a blank loading screen when they tried to
    // rejoin a session they'd been kicked/banned from.
    const state = sessionStore();
    const inSession = !!state.sessionId;
    import('../components/ui/Toast').then(({ showToast }) => {
      showToast({ message, variant: 'danger', duration: 5000 });
    });
    // Common fatal error: they're no longer a member. Reset + redirect
    // so they can try to rejoin fresh.
    if (/not a member|not found/i.test(message)) {
      useSessionStore.getState().reset();
      if (inSession) setTimeout(() => { window.location.href = '/'; }, 800);
    }
  });

  socket.on('session:deleted', () => {
    import('../components/ui/Toast').then(({ showToast }) => {
      showToast({
        message: 'This session was deleted by the owner.',
        variant: 'warning',
        duration: 5000,
      });
    });
    useSessionStore.getState().reset();
    setTimeout(() => { window.location.href = '/'; }, 800);
  });

  // --- Privacy + bans (public/private sessions + role hierarchy) ---
  socket.on('session:settings-changed', ({ visibility, hasPassword, inviteCode }) => {
    useSessionStore.getState().updatePrivacy({ visibility, hasPassword, inviteCode });
  });

  socket.on('session:bans-updated', ({ bans }) => {
    useSessionStore.getState().setBans(bans);
  });

  socket.on('session:player-banned', ({ userId, reason }) => {
    const state = sessionStore();
    if (state.userId === userId) {
      // Banned: lazy-import the toast so we don't pull the UI bundle
      // into the socket layer. Reset state + navigate home after a
      // brief window so the toast lands on the lobby too.
      import('../components/ui/Toast').then(({ showToast }) => {
        showToast({
          variant: 'danger',
          emoji: '\u26D4',
          message: reason
            ? `You were banned from this session: "${reason}"`
            : 'You were banned from this session.',
          duration: 8000,
        });
      });
      useSessionStore.getState().reset();
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } else {
      useSessionStore.getState().removePlayer(userId);
    }
  });

  socket.on('session:role-changed', ({ userId, role }) => {
    useSessionStore.getState().setPlayerRole(userId, role);
  });

  socket.on('session:owner-changed', ({ newOwnerId }) => {
    useSessionStore.getState().setOwner(newOwnerId);
  });

  socket.on('session:music-changed', (data: { track: string | null; fileIndex?: number | null }) => {
    useSessionStore.getState().setCurrentTrack(data.track);
    useSessionStore.getState().setCurrentTrackFileIndex(data.fileIndex ?? null);
  });

  socket.on('session:music-action-broadcast', (data: { action: string }) => {
    window.dispatchEvent(new CustomEvent('music-action', { detail: data.action }));
  });

  // --- Map ---
  socket.on('map:loaded', ({ map, tokens, drawings, isPreview }) => {
    // Preserve locally-set imageUrl (e.g. from prebuilt maps) if server returns null
    // The server stores null for prebuilt maps since the image is a client-side asset
    const currentMap = useMapStore.getState().currentMap;

    // Only preserve the current local imageUrl if we're reloading the SAME map
    // (not switching to a different map, which would carry over the old image)
    let preservedImageUrl = map.imageUrl
      ?? (currentMap?.id === map.id ? currentMap?.imageUrl : null)
      ?? null;

    // For prebuilt maps, look up the image by name (handles players joining
    // a session or DM switching to a prebuilt map mid-session)
    if (!preservedImageUrl && map.name) {
      preservedImageUrl = PREBUILT_IMAGE_MAP[map.name] ?? null;
    }

    // Fire cinematic transition overlay when switching to a DIFFERENT
    // map for players (non-preview only). Skip if this is a preview
    // load or if reloading the same map the client already has.
    if (!isPreview && currentMap && currentMap.id !== map.id) {
      window.dispatchEvent(new CustomEvent('map-transition-start', {
        detail: { mapName: map.name || 'Unknown' },
      }));
    }

    // Use the new applyMapLoad action which handles the preview flag
    // and keeps playerMapId in sync. A preview payload does NOT move
    // the ribbon; a normal (ribbon) payload DOES.
    useMapStore.getState().applyMapLoad({
      map: {
        id: map.id,
        name: map.name,
        imageUrl: preservedImageUrl,
        width: map.width,
        height: map.height,
        gridSize: map.gridSize,
        gridType: map.gridType,
        gridOffsetX: map.gridOffsetX,
        gridOffsetY: map.gridOffsetY,
        walls: map.walls,
        fogState: map.fogState,
        zones: map.zones,
      },
      tokens,
      isPreview,
    });
    // Keep session store's currentMapId in sync with whatever this
    // client is looking at (preview or ribbon). Everything outside
    // the map/scene stores (e.g. API fetch helpers) still reads it.
    useSessionStore.getState().setCurrentMapId(map.id);
    // Rehydrate any drawings the server included for this map. The
    // server pre-filters by visibility, so we can load this as-is.
    useDrawStore.getState().loadDrawings(drawings ?? []);

    // Bump the scene manager's ribbon indicator if this was a normal
    // (non-preview) load. Preview loads leave the ribbon unchanged.
    if (!isPreview) {
      useSceneStore.getState().updatePlayerMap(map.id);
    }
  });

  // Scene Manager: full list of maps in this session arrived.
  socket.on('map:list-result', ({ maps, playerMapId }) => {
    useSceneStore.getState().setMaps(maps, playerMapId);
    // Also sync the map store's playerMapId so the preview banner
    // derives correctly on the very first list fetch.
    useMapStore.getState().setPlayerMapId(playerMapId);
  });

  // Scene Manager: lightweight ribbon-moved ping. Another DM moved
  // the ribbon, or we ourselves did — update sidebars.
  socket.on('map:player-map-changed', ({ mapId }) => {
    useSceneStore.getState().updatePlayerMap(mapId);
    useMapStore.getState().setPlayerMapId(mapId);
  });

  // Helper: does this incoming event belong to the map we're currently
  // rendering? When the server-side filter is doing its job these should
  // all match, but the mapId hint lets us drop stragglers silently rather
  // than render a token that doesn't live on our current view.
  const isForCurrentMap = (mapId?: string): boolean => {
    if (!mapId) return true; // legacy events with no mapId — trust them
    const currentId = useMapStore.getState().currentMap?.id;
    return !currentId || currentId === mapId;
  };

  socket.on('map:token-moved', ({ tokenId, x, y, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().moveToken(tokenId, x, y);
  });

  socket.on('map:token-added', (token) => {
    // `token.mapId` is on the Token type itself; use it for filtering.
    if (!isForCurrentMap(token.mapId)) return;
    useMapStore.getState().addToken(token);
  });

  socket.on('map:token-removed', ({ tokenId, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().removeToken(tokenId);
  });

  socket.on('map:token-updated', ({ tokenId, changes, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().updateToken(tokenId, changes);
  });

  socket.on('map:fog-updated', ({ fogState, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().updateFog(fogState);
  });

  socket.on('map:walls-updated', ({ walls, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().updateWalls(walls);
  });

  socket.on('map:zones-updated', ({ zones, mapId }) => {
    if (!isForCurrentMap(mapId)) return;
    useMapStore.getState().updateZones(zones);
  });

  socket.on('map:pinged', (ping) => {
    useMapStore.getState().addPing(ping);
  });

  // --- Combat ---
  socket.on('combat:started', ({ combatants, roundNumber }) => {
    console.log('[COMBAT] combat:started received',
      combatants.map((c: Combatant) => `${c.name}${c.isNPC ? '' : ' (PC)'}=${c.initiative}(bonus ${c.initiativeBonus})`).join(', '),
    );
    useCombatStore.getState().startCombat(combatants, roundNumber);
    useSessionStore.getState().setGameMode('combat');
  });

  // Sent once per session:join when combat is already active. Restores
  // the combatants list, current turn index, and action economy so a
  // page refresh mid-combat rehydrates the initiative tracker UI
  // without starting combat from scratch.
  socket.on('combat:state-sync', ({ combatants, roundNumber, currentTurnIndex, actionEconomy }) => {
    useCombatStore.getState().syncCombatState({
      combatants,
      roundNumber,
      currentTurnIndex,
      actionEconomy,
    });
    useSessionStore.getState().setGameMode('combat');
  });

  socket.on('combat:ended', () => {
    useCombatStore.getState().endCombat();
    useSessionStore.getState().setGameMode('free-roam');
  });

  socket.on('combat:initiative-prompt', ({ tokenId, bonus }) => {
    useCombatStore.getState().addInitiativePrompt(tokenId, bonus);
  });

  socket.on('combat:initiative-set', ({ tokenId, total }) => {
    console.log('[COMBAT] initiative-set', tokenId, '→', total);
    useCombatStore.getState().setInitiative(tokenId, total);
  });

  socket.on('combat:all-initiatives-ready', ({ combatants }) => {
    console.log('[COMBAT] all-initiatives-ready',
      combatants.map((c: Combatant) => `${c.name}${c.isNPC ? '' : ' (PC)'}=${c.initiative}`).join(', '),
    );
    useCombatStore.getState().setCombatants(combatants);
  });

  socket.on('combat:turn-advanced', ({ currentTurnIndex, roundNumber, actionEconomy }) => {
    useCombatStore.getState().nextTurn(currentTurnIndex, roundNumber, actionEconomy);

    // Pan the camera to whoever's turn it is now. BattleMap listens
    // for `canvas-center-on` and adjusts the viewport at the current
    // zoom. We look up the combatant AFTER nextTurn() has written the
    // new index so we're following the combatant who's actually up.
    const combat = useCombatStore.getState();
    const current = combat.combatants[combat.currentTurnIndex];
    if (current?.tokenId) {
      window.dispatchEvent(new CustomEvent('canvas-center-on', {
        detail: { tokenId: current.tokenId },
      }));
      // Also select them so the TokenActionPanel and InitiativeTracker
      // highlight match the camera focus.
      useMapStore.getState().selectToken(current.tokenId);
    }
  });

  socket.on('combat:hp-changed', ({ tokenId, hp, tempHp }) => {
    const combatState = useCombatStore.getState();
    // Record damage in the damage log when HP decreases during combat
    if (combatState.active) {
      const target = combatState.combatants.find((c) => c.tokenId === tokenId);
      if (target) {
        const oldHp = target.hp + target.tempHp;
        const newHp = hp + (tempHp ?? 0);
        const damage = oldHp - newHp;
        if (damage > 0) {
          const attacker = combatState.combatants[combatState.currentTurnIndex];
          combatState.addDamageLog({
            round: combatState.roundNumber,
            attackerName: attacker?.name ?? 'Unknown',
            targetName: target.name,
            damage,
            damageType: 'untyped',
            source: 'Attack',
            timestamp: Date.now(),
          });
        }
      }
    }
    combatState.updateHP(tokenId, hp, tempHp);
  });

  socket.on('combat:condition-changed', ({ tokenId, conditions }) => {
    useCombatStore.getState().addCondition(tokenId, conditions);
  });

  socket.on('combat:death-save-updated', ({ tokenId, deathSaves }) => {
    useCombatStore.getState().setDeathSaves(tokenId, deathSaves);
  });

  socket.on('combat:action-used', ({ economy }) => {
    useCombatStore.getState().updateActionEconomy(economy);
  });

  // Opportunity Attack prompt — the server sends this to the
  // attacker's owner (or DM for NPC attackers). We push it onto the
  // OA queue which the OpportunityAttackModal renders.
  socket.on('combat:oa-opportunity', (data) => {
    pushOpportunityAttack(data);
  });

  // Spell cast attempt — broadcast when a leveled spell is being
  // cast. Every other client checks if their character is eligible
  // to counterspell and shows a prompt.
  socket.on('combat:spell-cast-attempt', (data) => {
    pushCounterspellOpportunity(data);
  });

  // Counterspell confirmation — fired by a counterspeller's client.
  // The original caster's resolver listens via the window event so
  // it can abort the cast mid-resolve.
  socket.on('combat:spell-counterspelled', (data) => {
    window.dispatchEvent(new CustomEvent('spell-counterspelled', { detail: data }));
  });

  // Attack-would-hit broadcast — push a Shield prompt onto the
  // queue if the target's owner is this client.
  socket.on('combat:attack-hit-attempt', (data) => {
    pushShieldOpportunity(data);
  });

  // Shield confirmation — broadcast so the attacker's resolver
  // recomputes the hit with +5 AC.
  socket.on('combat:shield-cast', (data) => {
    window.dispatchEvent(new CustomEvent('shield-cast', { detail: data }));
  });

  socket.on('combat:movement-used', ({ tokenId, remaining }) => {
    useCombatStore.getState().updateMovement(tokenId, remaining);
  });

  socket.on('combat:spell-cast', (_event) => {
    // Spell animation handling could go here
  });

  // --- Ready Check ---
  socket.on('combat:ready-check-started', (data: { playerIds: string[]; deadline: number }) => {
    console.log('[READY CHECK] ready-check-started received', {
      playerIds: data.playerIds,
      deadline: data.deadline,
      myUserId: useSessionStore.getState().userId,
      isDM: useSessionStore.getState().isDM,
    });
    useCombatStore.getState().setReadyCheck({
      active: true,
      playerIds: data.playerIds,
      responses: {},
      deadline: data.deadline,
    });
  });

  socket.on('combat:ready-update', (data: { responses: Record<string, boolean> }) => {
    console.log('[READY CHECK] ready-update received', data.responses);
    useCombatStore.getState().updateReadyResponses(data.responses);
  });

  socket.on('combat:ready-check-complete', () => {
    console.log('[READY CHECK] ready-check-complete received');
    useCombatStore.getState().clearReadyCheck();
  });

  // --- Character ---
  socket.on('character:updated', ({ characterId, changes }) => {
    useCharacterStore.getState().applyRemoteUpdate(characterId, changes);
  });

  socket.on('character:synced', ({ character }) => {
    useCharacterStore.getState().applyRemoteSync(character as Record<string, unknown>);
  });

  // --- Chat ---
  socket.on('chat:new-message', (message) => {
    const chat = useChatStore.getState();
    chat.addMessage(message);
    if (!chat.chatTabActive) chat.incrementUnread();
  });

  socket.on('chat:roll-result', (message) => {
    const chat = useChatStore.getState();
    chat.addMessage(message);
    if (!chat.chatTabActive) chat.incrementUnread();
    if (message.rollData) {
      useDiceStore.getState().setResult(message.rollData);
      // NOTE: 3D dice animation is NOT fired here. Physical rolls
      // (dice tray + /r) animate locally BEFORE emitting, so by the
      // time chat:roll-result echoes back the roll is done. Attack /
      // spell / initiative rolls never animate in 3D by design — the
      // chat card is enough for non-physical rolls.
    }
  });

  socket.on('chat:history', (messages) => {
    useChatStore.getState().setHistory(messages);
  });

  // --- Drawings ---
  // Server now tags every broadcast with `mapId`; drop events for
  // maps the local client isn't looking at so DM preview drawings
  // can't corrupt the player ribbon's draw store (and vice-versa).
  const currentMapId = () => useMapStore.getState().currentMap?.id;

  socket.on('drawing:created', (drawing) => {
    if (drawing.mapId && drawing.mapId !== currentMapId()) return;
    useDrawStore.getState().addDrawing(drawing);
  });

  socket.on('drawing:deleted', (payload: { drawingId: string; mapId?: string }) => {
    if (payload.mapId && payload.mapId !== currentMapId()) return;
    useDrawStore.getState().removeDrawing(payload.drawingId);
  });

  socket.on('drawing:cleared', (payload: { scope: 'all' | 'mine'; userId?: string; mapId?: string }) => {
    if (payload.mapId && payload.mapId !== currentMapId()) return;
    const currentUserId = useSessionStore.getState().userId ?? undefined;
    useDrawStore.getState().clearAllLocal(payload.scope, payload.userId, currentUserId);
  });

  socket.on('drawing:streamed', (payload) => {
    const p = payload as typeof payload & { mapId?: string };
    if (p.mapId && p.mapId !== currentMapId()) return;
    useDrawStore.getState().setPreview(payload);
  });

  socket.on('drawing:stream-end', (payload: { tempId: string; mapId?: string }) => {
    if (payload.mapId && payload.mapId !== currentMapId()) return;
    useDrawStore.getState().clearPreview(payload.tempId);
  });

  // --- Handouts ---
  socket.on('session:handout-received', (payload) => {
    pushHandout(payload);
  });

  // Return cleanup function
  return () => {
    socket.off('session:state-sync');
    socket.off('session:player-joined');
    socket.off('session:player-left');
    socket.off('session:kicked');
    socket.off('session:settings-changed');
    socket.off('session:bans-updated');
    socket.off('session:player-banned');
    socket.off('session:role-changed');
    socket.off('session:owner-changed');
    socket.off('session:settings-updated');
    socket.off('session:error');
    socket.off('session:deleted');
    socket.off('session:music-changed');
    socket.off('session:music-action-broadcast');
    socket.off('map:loaded');
    socket.off('map:list-result');
    socket.off('map:player-map-changed');
    socket.off('map:token-moved');
    socket.off('map:token-added');
    socket.off('map:token-removed');
    socket.off('map:token-updated');
    socket.off('map:fog-updated');
    socket.off('map:walls-updated');
    socket.off('map:zones-updated');
    socket.off('map:pinged');
    socket.off('combat:started');
    socket.off('combat:state-sync');
    socket.off('combat:ended');
    socket.off('combat:initiative-prompt');
    socket.off('combat:initiative-set');
    socket.off('combat:all-initiatives-ready');
    socket.off('combat:turn-advanced');
    socket.off('combat:hp-changed');
    socket.off('combat:condition-changed');
    socket.off('combat:death-save-updated');
    socket.off('combat:action-used');
    socket.off('combat:oa-opportunity');
    socket.off('combat:spell-cast-attempt');
    socket.off('combat:spell-counterspelled');
    socket.off('combat:attack-hit-attempt');
    socket.off('combat:shield-cast');
    socket.off('combat:movement-used');
    socket.off('combat:spell-cast');
    socket.off('combat:ready-check-started');
    socket.off('combat:ready-update');
    socket.off('combat:ready-check-complete');
    socket.off('character:updated');
    socket.off('character:synced');
    socket.off('chat:new-message');
    socket.off('chat:roll-result');
    socket.off('chat:history');
    socket.off('drawing:created');
    socket.off('drawing:deleted');
    socket.off('drawing:cleared');
    socket.off('drawing:streamed');
    socket.off('drawing:stream-end');
    socket.off('session:handout-received');
  };
}
