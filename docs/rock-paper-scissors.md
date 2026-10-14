# Online rock-paper-scissors

The [game](https://takahirox.github.io/sandbox/projects/rock-paper-scissors/)
is plain HTML, CSS, and JavaScript on GitHub Pages. It lists exactly five public
rooms. Join an open seat or choose Watch; joining a full room automatically makes
you a spectator. No name, account, or manual room creation is required.

Two occupied seats start a first-to-three match. Each player's choice locks once
submitted. Only the fact that a choice is locked is public until both choose.
The server then reveals both hands, awards a point to the winner (none for a
tie), and opens the next round. The last ten results remain visible, so ties
cannot grow storage indefinitely. A completed match retains its seats and score;
both connected players must request Play again before a fresh match starts.

## Deployment and architecture

The game reuses `workers/persistent-counter/`, its existing workers.dev endpoint,
and the existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` Actions secrets.
There is no additional service, D1 schema, or per-room setup. The Worker routes
`GET /api/rps/ws` to the `RPS` binding's single named object, `five-rooms`.
The new `RockPaperScissors` class is SQLite-backed via the additive `v2` class
migration. Preserve `v1`, the Counter class, and both named object identifiers.
Counter's storage, D1 binding, routes, and frontend remain independent.

The [Pages workflow](../.github/workflows/pages.yml) runs both backend and browser
test suites on pull requests without production secrets. On main it provisions
the existing infrastructure, deploys both Durable Object classes in the same
Worker, and writes the public API origin to both projects' `api-config.json`
before rebuilding Pages. The new project is discovered automatically by the site
builder. The tracked game config has an empty origin: unconfigured static
previews show five disabled rooms and Unavailable, and never call production.
Only public endpoint configuration is published, never deployment secrets.

All lobby and game updates use a single WebSocket per page, without HTTP polling.
The object uses `acceptWebSocket`, socket attachments, and the
[Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
The browser sends ping every 20 seconds; Cloudflare auto-replies with pong without
waking the object. A missing pong closes the browser connection after 10 seconds.
Reconnect uses exponential backoff capped at 30 seconds. Sent hands and rematch
requests are never automatically replayed; a fresh snapshot determines available
actions. Seat reclaim is safe to repeat. Spectators receive the same score and
revealed results as players, with role-specific controls.

## Authority, privacy, and lifecycle

Every seat/turn/score decision is serialized under `blockConcurrencyWhile`.
Room state and the earliest cleanup alarm are saved in one storage transaction,
and durability is awaited before broadcasting results or returning a credential.
Hidden hands are persisted server-side, but public snapshots explicitly project
only availability, connection status, scores, submitted flags, revealed results,
winner, and rematch consent. The private seat message goes only to its owner.

Each seat gets a server-generated random 256-bit credential. It is sent only in
WebSocket messages, never URLs, and is stored in that browser's local storage.
The server authenticates seat reclaim using that credential, not a public room
or connection ID. Opening the same seat in another tab takes it over and stops
retries in the previous tab. If local storage is blocked, the current page can
still play/reconnect, but a reload cannot recover its in-memory credential.
There is no logging of hands, credentials, or socket payloads.

A detected player disconnect reserves its seat for 60 seconds and pauses play.
Its alarm survives hibernation/recreation; messages and joins also expire overdue
seats before acting, even if alarm delivery is late. Reclaim preserves the score
and locked move. A runtime restart that lost a socket starts a reservation for
that seat; existing deadlines are never extended. On expiry or an explicit
Leave room, the seat is released and the abandoned match is reset. Remaining
players wait for an opponent. Empty rooms retain only their bounded initial
state. Spectator close/leave removes presence without persistent per-spectator
records. Socket attachments preserve role routing and message-rate state during
hibernation; a stale socket's close event cannot release a reclaimed seat.

Messages are limited to 512 characters; binary, malformed, extra-field, unknown
type, invalid room/credential/hand messages close with code 1008. The Worker and
object require the configured browser origin, GET, and a WebSocket upgrade.
Spectators cannot choose hands, consent to a rematch, or claim a seat from within
a watched room. They can leave and explicitly join an available seat. Match IDs
and round numbers reject delayed submissions, even after a rematch.

## Resource controls

The demo uses SQLite-backed Durable Objects supported on Cloudflare Free.
Limits apply to all visitors and all projects in the account; the application
does not promise unlimited spectator capacity or guaranteed quota availability.
See Cloudflare's [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

| Control | Limit |
| --- | --- |
| Concurrent connections per IP | 32 across lobby and all rooms |
| Handshakes per IP | 2/second, burst 20 |
| Messages per socket | 4/second, burst 12 |
| Messages per IP | 20/second, burst 60 |
| Successful new seats, hands, rematch consents | 5,000/day (UTC), persisted |

Only a SHA-256 hash of Cloudflare's trusted `CF-Connecting-IP` header is retained
in attachments/in-memory buckets. Client messages cannot supply an IP or role.
IP buckets expire after inactivity; runtime restarts may grant a fresh soft
burst. Socket buckets survive hibernation. The daily mutation budget survives
restarts; exhausted play resumes via a midnight alarm push. Reclaiming seats,
leaving, cleanup, and spectating remain possible when play is capped. There is
no fixed spectator count per room; per-IP protection and Cloudflare's actual
connection, CPU, storage, and request limits still apply. Fan-out counts
spectators once per push and scales linearly with connections. These controls
bound ordinary successful gameplay work, not hostile traffic or total account
spending; the existing counter shares the free allocation.

## Local development and checks

Use Node.js 22+ (CI uses 24) and Python 3.9+. From the repository root:

```sh
python3 -m unittest discover -s tests -v
node --test tests/pokemon-coin-flip.test.cjs
python3 scripts/build_site.py
cd workers/persistent-counter
npm ci
npm test
npm run build
npm run migrate:local
npm run migrate:local
npx playwright install chromium
npm run test:browser
```

Backend tests run production code in workerd and exercise five-room pushes,
simultaneous joins, two seats, spectator permissions, all nine hand combinations,
ties, first-to-three, immutable submissions, stale messages, bilateral rematches,
credential privacy, takeover/reclaim, 60-second expiry, persistent restart with a
hidden move, abrupt loss of active sockets, message/origin limits, heartbeat,
connection limits, and pushed daily reset. A real storage-alarm test waits one
minute with no incoming traffic and verifies a pushed seat release. Other
test-only controls supply deterministic time; no control routes ship.
Browser tests use independent contexts plus a spectator against a local Worker
and the built site under `/sandbox/`. They verify synchronized play, private
frames, reload/reconnect, timeout, rematch, idle sockets, responsive layout,
unconfigured previews, unavailable storage, automatic index discovery, and no
backend HTTP requests. Existing counter and static-project suites run alongside.

For a preview, run `npm run dev` in the Worker directory, then from the root:

```sh
python3 scripts/build_site.py
python3 -c 'import json; from pathlib import Path; Path("_site/projects/rock-paper-scissors/api-config.json").write_text(json.dumps({"apiUrl": "http://localhost:8787"}))'
python3 -m http.server 8000 --directory _site
```

Open `http://localhost:8000/projects/rock-paper-scissors/` in independent browser
profiles/devices for two seats, then a third for spectating. Use localhost,
matching the development origin configuration. The game needs no local D1
migration; running the counter in the same preview does.

## Required post-merge verification (pending)

1. Confirm the main Pages workflow deploys the additive RPS binding/migration
   along with the existing counter and publishes both public endpoint configs.
2. Confirm the published sandbox index links to the game. In two independent
   browsers play a first-to-three match, check ties and two-party rematch consent,
   and watch from a third browser. Verify immediate WebSocket updates and no
   hidden hand/credential disclosure in spectator frames or periodic HTTP reads.
3. Reload/disconnect a player; verify reclaim within 60 seconds and released
   availability after an abandoned seat times out. Leave clients idle to allow
   production hibernation, then resume play. Verify a later deployment preserves
   state and reconnect works. Local idle tests do not prove production eviction.
4. Confirm existing static projects and the persistent counter still work, and
   inspect Cloudflare usage without exhausting production quotas for testing.

These require the authorized main deployment and remain pending until it runs.
