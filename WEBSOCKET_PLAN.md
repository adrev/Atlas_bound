# Websocket Architecture Plan

## Why this matters

Today's healing bug is a perfect microcosm of the bigger problem:

> "When I heal the bandit I see the full health while I click the button but
> when I close the view and open it again it goes back to its old state until
> I refresh the page."

The HP update DID get sent to the server (socket), the server DID persist it,
the broadcast to OTHER clients DID fire. But the **sender's own local store**
was never updated, because the server uses `socket.to(room).emit(...)` which
intentionally excludes the originating socket. So the panel showed stale data
the moment React unmounted the local `localHp` override.

Fixed today by making `emitCharacterUpdate` apply locally + emit. But the
exact same shape of bug is hiding in **every REST-only mutation**:

| Action | Currently | Bug surface |
|---|---|---|
| Heal HP | socket | ✓ fixed |
| Equip an item | REST only | DM doesn't see it; refresh required |
| Drop an item to map | REST + manual broadcast | races, inconsistent |
| DM gives loot to player | REST | Player doesn't see it |
| Take from a loot bag | REST | Other players still see the loot |
| DM creates a homebrew item | REST | Players can't add it to characters until refresh |
| Spell slot expended | socket | ✓ works |
| Concentration drop on damage | socket | ✓ works |

The pattern is consistent: **anything that changes during play and another
player would care about needs to be a socket event, not a REST call**.

---

## The architectural rule

> **REST = "read once, on load."**
> **Sockets = "tell everyone, right now."**

Concrete decision tree for any new feature:

```
Is it a one-shot operation that runs in isolation? (DDB import, file upload,
initial session join)
   → REST

Is it a read-only lookup that's cacheable? (compendium search, monster details)
   → REST

Does it change game state mid-session and another player would notice?
   → SOCKET (with optional REST GET for the initial fetch)
```

The cardinal sin is using REST for a mutation and then hand-broadcasting via
a separate socket event after — that's two round trips, two failure modes,
and two places to forget the broadcast.

---

## Today's coverage

### Already on sockets ✓

- **Session lifecycle** (`sessionEvents.ts`): join, leave, settings
- **Map state** (`mapEvents.ts`): tokens (add/update/remove), walls, fog,
  preset map load
- **Combat state** (`combatEvents.ts`): start/end, initiative, turn advance,
  HP, conditions, action economy, death saves
- **Chat** (`chatEvents.ts`): messages, whispers, dice rolls
- **Character state** (`characterEvents.ts`): the `character:update` event,
  which broadcasts ANY field change. We just need to USE it more.

### REST-only that should also live on sockets

These are the gaps that cause "refresh to see changes" bugs:

#### Priority 1 — actively biting us

1. **Inventory changes** (`PUT /api/characters/:id` with new inventory)
   - Equip / unequip → other players & DM don't see armor or weapons update
   - Add / remove item → loot transfers feel one-sided
   - Quantity / charges (potions, ammo) → consumption invisible to party
   - **Fix**: route through `character:update` with `{ inventory }`. The
     existing `character:updated` listener will pick it up.

2. **Loot bag contents** (`POST /api/characters/:id/loot/take`,
   `POST /api/characters/:id/loot`, `DELETE`, `PATCH`)
   - DM adds gold to a goblin → players hovering the body don't know
   - Player A takes the magic sword → Player B still sees it offered
   - **Fix**: new `loot:updated` socket event broadcast on every loot
     mutation. Server already authorizes via session role.

3. **Drop-on-map** (`POST /api/characters/:id/loot/drop`)
   - The new lootable token is created via REST then a separate token-add
     socket event. Two failure points.
   - **Fix**: turn the whole drop into one socket event `loot:drop` that
     creates the token AND the loot bag in a single transaction.

4. **Hit dice / Hit dice spending** (already via socket as part of
   `character:update`, but worth confirming after the new field landed)

#### Priority 2 — soon to bite us

5. **Custom content (homebrew)** (`customContent.ts` REST)
   - DM creates a custom weapon → players can't see it in their
     inventory dropdown
   - **Fix**: new `homebrew:item-created` / `homebrew:spell-created` /
     `homebrew:monster-created` events. Each session keeps a homebrew
     library and broadcasts on add/edit/delete.

6. **Character creation** (currently `POST /api/characters` REST)
   - When the DM spawns an NPC, the player session never learns about
     the new character record until they click the token AND fetch it.
     This is exactly why Thunderwave didn't damage the bandit — see the
     `castSelfSpell` pre-fetch hack.
   - **Fix**: emit `character:created` on the room when a character is
     created during session. Clients pre-populate their store. Removes
     the need for the per-cast pre-fetch hack.

7. **Map switch** (`POST /api/maps`, `POST /api/sessions/:id/map`)
   - Already partially socket-driven for the broadcast, but the upload +
     metadata creation is REST. Race condition visible as the "preset
     map sync bug" in the development status doc.
   - **Fix**: post-upload, immediately emit `map:loaded` to the whole
     room from the server side. Don't make the client request a refresh.

#### Priority 3 — quality of life

8. **Player presence / typing indicators** — purely socket, brand new
9. **Ping marker on map** — already socket, just expose UI
10. **Cursor position broadcast** ("see what your friends are looking at")
11. **Token highlight on hover** (DM can see what player is pointing at)

### REST-only that should STAY REST

These are fine where they are:

- **Compendium read endpoints** (`GET /api/compendium/...`) — read-only,
  cacheable, don't change during play
- **DDB import** (`POST /api/characters/import-json`) — single-user,
  one-shot, no other player needs to know
- **File uploads** (`POST /api/uploads/...`) — multipart, large body,
  doesn't fit the socket message model. The CONFIRMATION that an upload
  succeeded should be a socket event, but the bytes themselves go via REST.
- **Initial state fetches on join** — REST is the right primitive for
  "give me the current state"; sockets are for "tell me when it changes."
- **Health checks, OAuth callbacks, anything outside a session room**

---

## Server-side implementation pattern

For every mutation we want on sockets, the same shape works:

```ts
// server/src/socket/<feature>Events.ts

socket.on('inventory:update', (data) => {
  const parsed = inventoryUpdateSchema.safeParse(data);
  if (!parsed.success) return;

  const ctx = getPlayerBySocketId(socket.id);
  if (!ctx) return;

  const { characterId, changes } = parsed.data;

  // 1. Authorize
  const char = db.prepare('SELECT user_id FROM characters WHERE id = ?').get(characterId);
  const isDM = ctx.player.role === 'dm';
  const isOwner = char?.user_id === ctx.player.userId || char?.user_id === 'npc';
  if (!isDM && !isOwner) return;

  // 2. Apply to DB in a transaction
  db.transaction(() => {
    // ...write the new inventory...
  })();

  // 3. Broadcast to the entire room (INCLUDING the sender — see below)
  io.to(ctx.room.sessionId).emit('inventory:updated', { characterId, changes });
});
```

### `socket.to(...).emit` vs `io.to(...).emit`

**Use `io.to(room).emit(event)` (includes sender) for game state updates.**

The current `character:updated` uses `socket.to(...)` which excludes the
sender, and we work around it in `emitCharacterUpdate` by also calling
`applyRemoteUpdate` locally. That's fragile — easy to forget, breaks when
multiple tabs are open with the same user, doesn't survive a hot-reload.

The cleaner pattern is "the server is the source of truth, every state
change comes from the server, even for the originator". Use `io.to(...)`
and let every client (including the sender) receive the event. The
sender's local optimistic update can still happen, but the authoritative
update lands on the same code path as remote players.

---

## Client-side implementation pattern

```ts
// client/src/socket/listeners.ts
socket.on('inventory:updated', ({ characterId, changes }) => {
  useCharacterStore.getState().applyRemoteUpdate(characterId, changes);
});

// client/src/socket/emitters.ts
export function emitInventoryUpdate(characterId: string, changes: Partial<Inventory>) {
  getSocket().emit('inventory:update', { characterId, changes });
  // Optimistic local apply — server will confirm via inventory:updated
  useCharacterStore.getState().applyRemoteUpdate(characterId, changes);
}
```

Three rules for emitters:

1. **Always update the local store optimistically** so the UI feels instant.
2. **Always broadcast** so other players see it.
3. **Trust the server's broadcast** as the source of truth — if it
   contradicts the optimistic update (e.g. permission denied), the server
   wins on the next event.

---

## Migration strategy (incremental, no big bang)

We don't need a giant refactor. Add socket events for the bleeding parts
first, leave the rest as REST until they bite us.

### Phase 1 — Inventory (1-2 days)
- Add `inventory:update` socket event with `{ characterId, changes }`
- Add server handler that authorizes, persists, broadcasts via `io.to(...)`
- Replace every `PUT /api/characters/:id { inventory }` call site in the
  client with `emitInventoryUpdate`
- Verify equip / unequip / drop / pickup all sync between two browser tabs
- Keep the REST `PUT` route for now as a fallback for tools

### Phase 2 — Loot bags (1 day)
- Add `loot:add`, `loot:remove`, `loot:take`, `loot:drop` socket events
- Add server handlers + the corresponding `loot:updated` broadcast
- Replace REST loot calls in `LootEditor`, `LootBagPanel`, drop handlers
- Test: player A takes the magic sword → player B's loot panel updates

### Phase 3 — Character creation (½ day)
- Emit `character:created` whenever a new character record is INSERT'd
  during a session (creature spawn, character import, manual create)
- Client listener pre-populates the store
- Remove the per-cast pre-fetch hack from `castSelfSpell`

### Phase 4 — Homebrew sync (1 day)
- Add `homebrew:item-created`, `homebrew:spell-created`, `homebrew:monster-created`
- Each session keeps a list in the room state
- Refresh CompendiumPanel "Homebrew" tab on every event

### Phase 5 — Cleanup
- Audit `'character:updated': socket.to(...).emit(...)` and switch to
  `io.to(...).emit(...)`
- Remove the `applyRemoteUpdate` workaround in `emitCharacterUpdate`
  (the listener will handle it for everyone now)
- Add a single `useSessionSync` hook that owns ALL listener registration
  so we can verify nothing's missed

---

## Server room state

Right now `roomState.ts` keeps an in-memory `Room` per session with:
- players, dmUserId, currentMapId
- tokens map

We should expand this to also track:
- **characters** in the session (so we can broadcast character:created)
- **homebrew** library (so we can broadcast homebrew:created)
- **lootBags** by characterId (so loot updates don't need a DB read for
  the broadcast payload)

This means the server has an authoritative in-memory snapshot of session
state. DB writes still happen on every mutation, but reads for broadcast
come from memory — which lets us:
- Do conflict-free optimistic UI on the client
- Survive a brief DB hiccup without dropping a broadcast
- Add server-side validation (e.g. can't equip an item you don't own)
  without an extra round-trip

---

## What this fixes

| Bug | Today | After Phase 1-3 |
|---|---|---|
| Healing the bandit reverts on close+reopen | ✓ fixed by emitter local-apply | Same fix, less surface |
| Equipping a weapon doesn't update the DM's view | broken | ✓ live |
| Player A takes the magic sword, B still sees it | broken | ✓ live |
| Drop-on-map sometimes leaves a phantom item | broken | ✓ atomic |
| Bandit not in player's character store → Thunderwave skips it | hacked around | ✓ fixed at the source |
| DM creates a homebrew item, players can't see it | broken | ✓ live |
| Character sheet shows stale spells after DDB re-import | broken | ✓ live (character:updated) |

---

## Open questions

1. **Should `character:updated` switch to `io.to(...)` (everyone) now**, or
   wait for Phase 5? Voting now — it's two characters of code change and
   removes the need for the local-apply workaround.

2. **Optimistic updates: full or none?** Right now we optimistically update
   the store on emit. The downside: if the server rejects (permission, race,
   validation), the client thinks it succeeded until the server's broadcast
   contradicts it (or doesn't arrive). For high-stakes ops (deleting a magic
   item), should we wait for server confirmation? Probably yes — those
   should NOT optimistically update.

3. **Rate limiting?** A misbehaving client could flood
   `inventory:update`. The current sockets have no throttling. Add a per-
   socket rate limiter as part of Phase 5.

4. **Audit log?** Once everything goes through sockets, we can record every
   game-state change in a `session_events` table for replay / undo. Future
   work but worth keeping the events normalized so it's possible.
