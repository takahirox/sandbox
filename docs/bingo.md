# Shared Bingo

[Bingo](https://takahirox.github.io/sandbox/projects/bingo/) opens directly into
one global game. No account, name, invitation code, room choice, or external
assets are needed. Cards follow 75-ball rules: B/I/N/G/O use 1–15 / 16–30 /
31–45 / 46–60 / 61–75, with a free center. Each card is distinct in this game.

## Playing and lifecycle

Tap or keyboard-activate a highlighted called square to mark it. Uncalled
numbers cannot be marked. Late arrivals get a new card and may mark **all**
previous calls in the current game. The server confirms a horizontal, vertical,
or diagonal line automatically, celebrates on that card, and shares a verified
Bingo count with everyone. No client-supplied win is accepted.

Play continues after a Bingo. At 75 calls drawing ends, while marking remains
available. Anyone can claim an unoccupied caller role. Only that participant
can start the game, draw, reset, or release the role. New game opens an explicit
confirmation dialog, then clears calls, marks, and results, replaces every
connected player's card, and waits for the caller to press Start game.
Disconnected cards are removed only at that reset; other cards persist for the
whole game. A returning browser whose card was removed receives a fresh card.

A server-generated random 256-bit participant credential restores the card,
marks, and any caller role on reconnect/reload. It is sent privately over the
WebSocket, stored in local storage, and never put in URLs, shared snapshots,
logs, or static files. The public participant UUID conveys no authority. The
caller role is bound to this private credential and the current authenticated
socket, not an editable client flag. Reopening the same identity takes over the
card; the previous tab stops reconnecting until explicitly requested. Blocked
storage still allows play and reconnect in the same page; clearing storage or
reloading with blocked storage loses the card.

A detected caller disconnect reserves the role for **30 seconds**. Its storage
alarm releases the role and pushes the change without polling. Incoming actions
also expire overdue reservations before authorization. Hibernation preserves
socket attachments; if a runtime restart loses sockets, initialization gives a
missing caller a grace period without extending an existing deadline. Reclaim
before the deadline restores the role; after it, the returning participant
keeps the card and may claim the open role normally.

## Architecture and deployment

The existing `workers/persistent-counter/` deployment serves `GET /api/bingo/ws`
through binding `BINGO`, class `Bingo`, and exactly one named Durable Object,
`global-bingo`. Keep this name and the additive SQLite-backed **v3** migration
stable; existing Counter/RockPaperScissors migrations and storage are retained.
Bingo needs no D1 schema or additional service/secrets. Provisioning writes the
same public Worker origin to all three frontends. The Pages workflow runs the
backend/browser suites and deploys all three classes using the existing
Cloudflare credentials on main.

State, caller deadlines, and the daily usage budget persist in a single bounded
Durable Object storage value. Serialized decisions and storage transactions
commit before credentials, successful action acknowledgments, and broadcasts.
Each snapshot deliberately exposes only common game state, anonymous verified
results, and the receiving participant's own card and marks. Regular marking
updates only that player; new calls, roles, resets, and first Bingos push to all
open sockets. Game IDs, per-socket sequence numbers, expected draw counts, and
one-way marks reject stale/duplicate actions. Actions are never replayed on
reconnect; the authoritative snapshot determines what is available.

The frontend uses one WebSocket with exponential reconnect backoff capped at
30 seconds. A 20-second heartbeat receives a hibernation auto-response, avoiding
storage reads/object wakeups; missing responses close the connection after
10 seconds. See Cloudflare's [WebSocket hibernation guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
There is no game-state HTTP polling, application timer running in the object,
or dependency on browser timers for role expiry.

## Resource limits

This is a small shared demo, not an unlimited player service. These controls
help bound ordinary use; they do not guarantee the account stays below its free
allocation under hostile traffic. Other sandbox projects share that allocation.

| Control | Limit |
| --- | --- |
| Concurrent sockets | 128 total; 32 per IP |
| Participant cards | 128 per game, including disconnected cards |
| Handshakes per IP | 1/second, burst 10 |
| Messages per socket | 4/second, burst 12 |
| Messages per IP | 20/second, burst 60 |
| Successful joins/new cards, claims, starts, draws, marks, resets | 5,000/day UTC |
| Client message size | 512 characters; binary messages rejected |

At the card cap, existing participants can still reconnect and the caller can
reset to free disconnected cards; new participants receive an actionable limit
message. At the daily cap, existing identities can reconnect, and caller release
and timeout still work. The persisted midnight alarm pushes restored play
availability. No repeat marks consume the daily allowance. Strict schemas
reject extra fields, malformed credentials, unknown/forged win messages, and
invalid indexes. Origin/method/upgrade checks run at both routing boundaries.
Only a SHA-256 hash of the trusted `CF-Connecting-IP` is used for rate buckets;
IP buckets are temporary, and socket buckets survive hibernation. A runtime
restart may grant a fresh soft rate burst, never a fresh daily allowance.

## Local validation and preview safety

Tracked `projects/bingo/api-config.json` has an empty origin. Localhost pages
also refuse production endpoints, even with a generated production config.
Unconfigured pages render the real unavailable UI with a disabled card, never
invented multiplayer data. Screenshot capture replaces the config only inside
its isolated browser and blocks all WebSockets/external traffic. The gallery
safety test supplies a trap backend to Bingo as well as the existing demos and
verifies zero backend traffic while preserving published config files.

Use Node.js 22+ (CI uses 24), Python 3.9+, and the repository's pinned tools:

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
python3 -m unittest discover -s tests -v
node --test tests/pokemon-coin-flip.test.cjs
python3 scripts/build_site.py --skip-screenshots
npm test --prefix workers/persistent-counter
npm run build --prefix workers/persistent-counter
npm run migrate:local --prefix workers/persistent-counter
npm run migrate:local --prefix workers/persistent-counter
npm run test:browser --prefix workers/persistent-counter
node --test tests/gallery.test.mjs tests/walk-to-hospital.test.mjs
python3 scripts/build_site.py
```

For interactive local play, run `npm run dev --prefix workers/persistent-counter`
and serve `_site/` on `http://localhost:8000`. Set only the ignored built copy
`_site/projects/bingo/api-config.json` to `{"apiUrl":"http://127.0.0.1:8787"}`.
The local Worker and browser origin must match `ALLOWED_ORIGIN` exactly. Rebuilds
overwrite this local config; no tracked production config should be edited.

Backend tests use production code in workerd for simultaneous clients, private
cards, all 75 unique draws/exhaustion, late marking, verified results, stale and
malformed actions, caller authentication/reclaim/release/expiry, daily limits,
heartbeat, and actual persisted runtime recreation. Pure rules tests check all
line directions, column ranges, distinct cards, and rejection-sampling pool
positions. Browser tests cover independent devices, keyboard marking, reload,
automatic reconnect, idle hibernation, takeover, reset confirmation, mobile
sizes/touch targets, reduced motion, blocked storage, gallery discovery, and
safe unavailable/production-config previews. Test-only controls never ship.

Required post-merge checks remain **pending** until deployment: confirm the
Pages workflow deployed v3 and the frontend API config, then open the published
Bingo URL in independent browsers, claim/start/draw, and verify shared calls,
private cards, refresh recovery, confirmed reset, and continued operation of
the counter and rock-paper-scissors demos. This node does not deploy or push.
