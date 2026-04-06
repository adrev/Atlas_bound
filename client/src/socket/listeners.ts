import type { Socket } from 'socket.io-client';
import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useChatStore } from '../stores/useChatStore';
import { useDiceStore } from '../stores/useDiceStore';
import { useCharacterStore } from '../stores/useCharacterStore';

const PREBUILT_IMAGE_MAP: Record<string, string> = {
  'Goblin Camp': '/maps/goblin-camp.png',
  'Underdark Cavern': '/maps/underdark-cavern.png',
  'Druid Grove': '/maps/druid-grove.png',
  'Moonrise Towers': '/maps/moonrise-towers.png',
  'Nautiloid Wreck': '/maps/nautiloid-wreck.png',
  'Grymforge': '/maps/grymforge.png',
  'Forest Road Ambush': '/maps/forest-road-ambush.png',
  'Zhentarim Hideout': '/maps/zhentarim-hideout.png',
  'The Elfsong Tavern': '/maps/elfsong-tavern.png',
  'Last Light Inn': '/maps/last-light-inn.png',
  'Cathedral of Lathander': '/maps/cathedral-lathander.png',
  'Wine Cellar': '/maps/wine-cellar.png',
  'Apothecary Shop': '/maps/apothecary-shop.png',
  'Camp / Long Rest': '/maps/camp-long-rest.png',
  'Merchant Quarter': '/maps/merchant-quarter.png',
  'Dense Forest': '/maps/dense-forest.png',
  'Long Road': '/maps/long-road.png',
};

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
  });

  // --- Map ---
  socket.on('map:loaded', ({ map, tokens }) => {
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

    useMapStore.getState().setMap({
      id: map.id,
      name: map.name,
      imageUrl: preservedImageUrl,
      width: map.width,
      height: map.height,
      gridSize: map.gridSize,
      gridType: map.gridType,
      gridOffsetX: map.gridOffsetX,
      gridOffsetY: map.gridOffsetY,
    });
    useMapStore.getState().setTokens(tokens);
    useMapStore.getState().updateWalls(map.walls);
    useMapStore.getState().updateFog(map.fogState);
    useSessionStore.getState().setCurrentMapId(map.id);
  });

  socket.on('map:token-moved', ({ tokenId, x, y }) => {
    useMapStore.getState().moveToken(tokenId, x, y);
  });

  socket.on('map:token-added', (token) => {
    useMapStore.getState().addToken(token);
  });

  socket.on('map:token-removed', ({ tokenId }) => {
    useMapStore.getState().removeToken(tokenId);
  });

  socket.on('map:token-updated', ({ tokenId, changes }) => {
    useMapStore.getState().updateToken(tokenId, changes);
  });

  socket.on('map:fog-updated', ({ fogState }) => {
    useMapStore.getState().updateFog(fogState);
  });

  socket.on('map:walls-updated', ({ walls }) => {
    useMapStore.getState().updateWalls(walls);
  });

  socket.on('map:pinged', (ping) => {
    useMapStore.getState().addPing(ping);
  });

  // --- Combat ---
  socket.on('combat:started', ({ combatants, roundNumber }) => {
    useCombatStore.getState().startCombat(combatants, roundNumber);
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
    useCombatStore.getState().setInitiative(tokenId, total);
  });

  socket.on('combat:all-initiatives-ready', ({ combatants }) => {
    useCombatStore.getState().setCombatants(combatants);
  });

  socket.on('combat:turn-advanced', ({ currentTurnIndex, roundNumber, actionEconomy }) => {
    useCombatStore.getState().nextTurn(currentTurnIndex, roundNumber, actionEconomy);
  });

  socket.on('combat:hp-changed', ({ tokenId, hp, tempHp }) => {
    useCombatStore.getState().updateHP(tokenId, hp, tempHp);
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

  socket.on('combat:movement-used', ({ tokenId, remaining }) => {
    useCombatStore.getState().updateMovement(tokenId, remaining);
  });

  socket.on('combat:spell-cast', (_event) => {
    // Spell animation handling could go here
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
    useChatStore.getState().addMessage(message);
  });

  socket.on('chat:roll-result', (message) => {
    useChatStore.getState().addMessage(message);
    if (message.rollData) {
      useDiceStore.getState().setResult(message.rollData);
    }
  });

  socket.on('chat:history', (messages) => {
    useChatStore.getState().setHistory(messages);
  });

  // Return cleanup function
  return () => {
    socket.off('session:state-sync');
    socket.off('session:player-joined');
    socket.off('session:player-left');
    socket.off('session:kicked');
    socket.off('session:settings-updated');
    socket.off('session:error');
    socket.off('map:loaded');
    socket.off('map:token-moved');
    socket.off('map:token-added');
    socket.off('map:token-removed');
    socket.off('map:token-updated');
    socket.off('map:fog-updated');
    socket.off('map:walls-updated');
    socket.off('map:pinged');
    socket.off('combat:started');
    socket.off('combat:ended');
    socket.off('combat:initiative-prompt');
    socket.off('combat:initiative-set');
    socket.off('combat:all-initiatives-ready');
    socket.off('combat:turn-advanced');
    socket.off('combat:hp-changed');
    socket.off('combat:condition-changed');
    socket.off('combat:death-save-updated');
    socket.off('combat:action-used');
    socket.off('combat:movement-used');
    socket.off('combat:spell-cast');
    socket.off('character:updated');
    socket.off('character:synced');
    socket.off('chat:new-message');
    socket.off('chat:roll-result');
    socket.off('chat:history');
  };
}
