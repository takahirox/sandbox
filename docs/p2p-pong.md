# P2P Pong

`projects/p2p-pong/` is an account-free, two-player, first-to-five Pong
experiment. Create a match, share its private invitation URL, and have the other
player press **Join match**. The creator controls the left paddle and hosts the
simulation. Focus the court for arrow/W/S controls, drag on touch screens, or use
the large up/down buttons. Leaving or losing the host ends the match. Retry by
creating a new match and sharing its fresh link; invitations cannot be reused.

The court and score stay visible throughout. The landing screen offers **Create
match**; invitation links offer **Join match**. Hosts get **Copy invitation link**
while waiting, with the raw link and five-minute expiry in a collapsed disclosure
(automatically opened and selected if clipboard access fails). Setup actions and
disclosures disappear during play, leaving the score, court, compact controls,
and a quiet leave action. Results offer **Play again**, which creates a fresh
invitation. Keyboard focus follows actions as they are replaced, and score/status
updates are announced without repeating every animation frame.

The **Before you play** disclosure is available before creating or joining and
explains network-information exposure and connection limitations. Normal status
messages are brief; technical troubleshooting stays in the opt-in diagnostics.
The static offline preview uses the same court without creating a live match.

Only share with someone you trust. Direct WebRTC reveals network information
(potentially public/local addresses) to the other participant. STUN-only
connections can fail across strict NATs, firewalls, VPNs, and mobile networks.
There is deliberately **no TURN**, paid relay credential, or relay fallback:
this experiment measures direct connectivity without relay bandwidth charges.
The peer host can cheat; this is a sandbox demonstration, not a competitive or
cheat-proof service.

## Transport and synchronization

The existing Cloudflare Worker adds `/api/pong/ws`, routed to an independent
SQLite-backed `PongSignaling` Durable Object. The browser connects only after an
explicit Create/Join action. WebSockets exchange create/join, SDP offer/answer,
ICE candidates, and readiness messages. They accept no gameplay message types.
After both DataChannels open, the lobby deletes the invitation/session, sends
`released`, and closes both signaling sockets. Gameplay continues with no
Cloudflare connection, HTTP polling, or server forwarding of inputs/state.

`RTCPeerConnection` uses only `stun:stun.cloudflare.com:3478`. Both channels must
open before the UI reports connected; selected relay candidates are rejected
defensively. Initial negotiation permits two 40-second attempts with one
coordinated ICE restart and a one-second host backoff within the second attempt. The client has an independent 82-second
absolute deadline; the server expires the paired session after 90 seconds. A
failed connection, a ten-second disconnected ICE/connection state, a closed
DataChannel, or 15 seconds without a peer heartbeat ends play with a retry action.
Background tab suspension can therefore end a match; keep both game tabs active.

The creator runs fixed-step physics at 120 Hz. Both clients send paddle targets
at up to 30 Hz on `motion` (`ordered: false, maxRetransmits: 0`); the creator
also sends small authoritative snapshots there at up to 30 Hz. The host clamps
movement speed and owns collisions, scoring, and victory. The opponent predicts
its own paddle immediately and interpolates the host's paddle/ball. The ordered,
reliable `events` channel carries start, score, end, and two-second heartbeat
messages. Score revisions and monotonic ticks prevent late/lost/reordered motion
snapshots from reverting reliable score/end events. Queues and message sizes are
bounded; old motion is skipped under congestion.

Add `?debug=1` before the invitation fragment to opt into gathering/ICE/connection
states, per-generation unique candidate counts by type (including SDP candidates),
selected pair types only, end-of-candidates flags, gathering/candidate error counts,
handshake stages and elapsed timings, retry count, failure classification,
DataChannel readiness, and application round-trip time. Debug text never includes
raw SDP, candidate addresses, invitation capabilities, or credentials. There is
no application logging of these values.

## Initial handshake recovery and diagnosis (#42)

A transient setup error, failed ICE, ten seconds of disconnected state, or an
attempt timeout can request **one** retry through the original authorized
signaling sockets. The lobby serializes simultaneous requests, advances generation
0 to 1, resets both readiness flags and SDP roles, and tells both peers to restart.
The host waits one second, replaces any unfinished local offer, then uses
[`createOffer({ iceRestart: true })`](https://www.w3.org/TR/webrtc/#dom-rtcofferoptions-icerestart); the guest rolls back an unfinished
remote-offer exchange and returns a fresh answer. Only the creator offers, avoiding glare.
No new invitation, socket, peer connection, rejoin credential, or room is created.
The one-use capability stays consumed and neither seat can be replaced.

SDP, readiness and ICE messages carry the generation. Old in-flight messages are
discarded; future generations and additional retries are rejected. Local trickle
messages wait until their SDP has been sent. Remote candidates wait for the
matching remote description; ICE username fragments additionally reject stale
credentials even if a message has the current generation. Completion markers are
forwarded explicitly and late/reordered candidates are tried safely. Individual
candidate errors are counted without aborting other viable routes. Candidate
queues, observed-candidate sets, socket messages, retry timers and absolute
session lifetime remain bounded. Cancellation/failure closes the socket and peer
and clears timers and candidate state, even if an asynchronous browser SDP
operation never completes.

Both peers must have two open DataChannels, complete the non-relay stats check
where the browser exposes the selected pair, and report readiness for the current
generation. Gameplay starts only after the lobby sends `released`, deletes the
session and closes signaling. This prevents an asymmetric startup from starting
play during the other peer's retry. **There is no post-connect ICE restart**:
signaling authorization no longer exists. Brief disconnects have a ten-second
grace period (previously five); terminal failure, channel loss or heartbeat
expiry requires a fresh match. Restarting ICE alone cannot recover a deleted
signaling session. No idle signaling sockets or long-lived recovery credentials
are retained.

The previous single 35-second timeout was a blunt limit: browser STUN gathering
and connectivity checks may still be progressing then. Forty seconds per attempt
is a modest additional allowance rather than a measured universal optimum. One
restart provides a second chance for transient loss; the independent 82-second
client and 90-second server bounds prevent indefinite waiting, including when a
browser operation hangs. Retry never extends the server deadline. Socket/day,
seat, rate, message-size and 160-message limits remain unchanged, so unusually
large candidate sets can still exhaust the signaling budget and fail honestly.

The default browser policy permits both IPv4 and IPv6 host/server-reflexive routes;
no address family is forced. Cloudflare remains the only STUN endpoint. Adding
another public STUN operator without established terms/privacy/reliability would
increase disclosure and dependencies, and cannot solve symmetric NAT or blocked
UDP. No additional endpoint, TURN credential, relay infrastructure or gameplay
WebSocket fallback is introduced.

Diagnostics are local and opt-in; no new telemetry or backend logging exists.
Only fixed stages/categories, numeric counts/timings, and whitelisted candidate
types leave the negotiation code. Browser exception text, STUN error URLs,
addresses (including IPv6), ICE credentials, SDP and invitation secrets are never
included. A STUN gathering error alone is not fatal: a host route may still work.
Failure categories indicate the observed stage, not a definitive NAT diagnosis:

| Debug category | Observed failure / action |
| --- | --- |
| `signaling`, `signaling/authorization` | Socket unavailable, expired/used invitation, authorization close or peer departure; create a fresh match. No reconnect using a consumed link. |
| `ice-gathering` | No observed local candidate and gathering incomplete at timeout; one initial retry. |
| `candidate-exchange` | No usable remote candidates after SDP, candidate queue overflow or add-candidate errors at timeout; one initial retry. |
| `ice-connectivity` | ICE/connection failed, prolonged disconnect, or candidates available but no working pair by timeout; one initial retry, then change network/new match. |
| `datachannel` | ICE connected but both channels did not open by timeout, or a channel closed during setup. |
| `negotiation`, `negotiation-timeout` | SDP operation failed or no remote description by the deadline; one retry where possible. The independent deadline also bounds hung operations. |
| `peer-dropped` | An established match lost transport, channel or heartbeat; start a fresh match. |
| `relay-rejected` | A relay candidate/SDP/selected route was encountered; end setup, preserving the direct-only constraint. |

Normal UI remains brief: “Connecting…”, “Retrying connection…”, and an actionable
new-match/change-network failure. The debug panel retains the last transient
failure even when recovery succeeds.

## Signaling limits and privacy

- Each invitation uses a random 128-bit session ID and separate random 256-bit
  one-use join capability. The capability lives in the URL fragment, is removed
  on page load, and is sent in the first WebSocket message rather than the URL.
  A no-referrer policy also prevents link leakage. Nothing is put in browser
  persistent storage. Possession of a link authorizes its first joining browser;
  keep it private. A third browser cannot acquire or replace either seat.
- Only the configured frontend Origin may upgrade. Methods, upgrades, exact
  message fields, sender roles, SDP sizes, and ICE fields are validated. Game
  payloads, duplicate SDP within a generation, malformed, binary, and oversized
  messages are rejected. Relayed candidates in trickle messages or SDP are rejected.
- The lobby allows 24 pending sessions, 64 signaling sockets, and 3,000 accepted
  connections per UTC day. The daily counter persists across runtime restarts.
  Soft per-IP buckets allow 20 connection attempts, refilling at one per three
  seconds, and 200 signaling messages, refilling at 10/second. Each socket has
  an absolute 160-message limit and 20,000-character message limit. A shared IP
  may hit limits even with legitimate users.
- Unauthenticated sockets expire after 10 seconds, waiting invitations after
  five minutes, and paired negotiations after 90 seconds (including the single
  retry). Storage alarms clean up without requiring incoming traffic. Either peer leaving signaling removes
  the pending match. Successful connections release all session state. Only the
  bounded daily counter remains; no match history or gameplay is stored.

These are application resource controls, not protection against arbitrary edge
request floods. Rejected HTTP requests still consume Workers request quota, and
the other projects share account quotas. When capacity/quotas are exhausted,
the game reports signaling unavailable instead of purchasing allowance.

## Build and deployment

The existing main-branch Actions deployment reuses `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, writes Pong's public `api-config.json` alongside the other
projects, and deploys the additive `v4` SQLite Durable Object migration. No new
secret, D1 schema, paid Cloudflare service, or provider is required. SQLite
Durable Objects are available on Workers Free; this implementation uses that
supported configuration and hibernating WebSockets. Quotas are shared and zero
cost depends on remaining within the Free plan, not on a guarantee of unlimited
traffic. See Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and
[public STUN documentation](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/).

As checked in, `api-config.json` has an empty endpoint for a harmless static
preview. No WebSocket or WebRTC peer is created on load. The gallery's existing
capture sandbox replaces even a generated production endpoint with an empty
one and blocks external traffic/WebSockets. Pong automatically appears in the
gallery and gets a real local offline-preview cover.

For live local play, install tools as described in the repository README, run
`npm run dev --prefix workers/persistent-counter`, and temporarily set Pong's
`api-config.json` to `{"apiUrl":"http://localhost:8787"}`. Build the site and serve
`_site` on `http://localhost:8000` (the dev Worker's allowed Origin). Open
`http://localhost:8000/projects/p2p-pong/` in two browsers and share the invite.
Restore the empty source config before committing. WebRTC requires HTTPS or
localhost; two physical devices need an HTTPS-served frontend and an allowed
Origin/backend reachable from both devices.

## Validation

Pre-merge checks:

```sh
npm ci --prefix workers/persistent-counter
npm exec --prefix workers/persistent-counter -- playwright install chromium
npm test --prefix workers/persistent-counter
npm run build --prefix workers/persistent-counter
npm run migrate:local --prefix workers/persistent-counter
python3 -m unittest discover -s tests -v
node --test tests/pokemon-coin-flip.test.cjs
python3 scripts/build_site.py --skip-screenshots
npm run test:browser --prefix workers/persistent-counter
node --test tests/gallery.test.mjs tests/walk-to-hospital.test.mjs
python3 scripts/build_site.py
```

Pong's Miniflare tests cover authorization, two seats, private capabilities,
role-checked signaling, no game relay, expiry/cleanup, durable budgets, and
rate/size limits. Rules tests cover collision, movement, score, victory, and stale
state rejection. Browser tests run real WebRTC between isolated Chromium browser
contexts against a local Cloudflare runtime: direct non-relay candidate pairs,
closed signaling during live play, touch/keyboard, a complete first-to-five match,
consistent outcomes, host loss, invitation reuse denial, timeout/retry, safe
diagnostics, and a static preview. Gallery tests exercise production-configured
preview capture with a network trap and preserve the published API config.
An additional native-browser test waits for an actual storage alarm to close an
unused signaling socket without incoming traffic.

Issue #42 validation on 2026-10-20 used Node.js 24.12.0, Playwright 1.63.0
and Chromium 153.0.8010.12 against local Miniflare/workerd. Two isolated browser
contexts on one device selected `host / host` (no relay), connected in 32–126 ms
elapsed from each local Create/Join action in the final integration run, and
completed a matching first-to-five game in about 19 seconds with signaling
closed throughout play. These are same-host observations, not cross-network
latency or a general connection-time guarantee.

The final full backend/rules suite passed all 62 tests. The full browser suite
passed all 27 integrations. After final cleanup/debug
refinements, all eight Pong browser tests and 20 Pong signaling/peer/rules tests
passed again. Coverage includes loss of every first-generation candidate and
SDP candidate line, a real restart with changed ICE credentials on the same peer
and socket, delayed/reordered candidates and obsolete credentials, transient
answer failure with guest rollback and host pending-offer replacement, hung SDP
with bounded failure, release/readiness races, relay rejection, cancellation
while adding a candidate, and stale completion/failure events across restart.
Failure/timeout closes both peers' sockets and removes the session/alarm. Unit
fixtures verify both IPv4 and IPv6 candidate handling without exposing addresses
in diagnostics. No physical UDP-blocked network was available; simulated candidate
loss/hung setup verifies honest bounded failure, not universal NAT traversal.

The 11 Python build tests, five coin-flip tests, six gallery/walking tests,
Worker dry-run, and two idempotent local migration runs passed. The normal
screenshot build captured all seven projects, with zero blocked requests and
zero attempted WebSockets for Pong. Workflow configuration, production endpoints,
physics and other projects are unchanged. Physical two-device LAN and separate
network/mobile checks remain unavailable for lack of a second device and an
independent network; record browser versions, network types, success/failure and
timing without addresses when performed. Main-branch deployment/production
verification remains pending; nothing was pushed, deployed, merged or commented.

Issue #40 adds browser coverage for the contextual landing/invitation/play/result
actions, hidden setup details during play, clipboard copy and manual fallback,
cancel/expiry/retry, fresh invitations after a result, keyboard focus and privacy
disclosure access, touch target sizes, 320/390/1280-pixel layouts, and reduced
motion. The real first-to-five integration continues to exercise actual physics
and DataChannels rather than a simulated connection.

UI refinement validation on 2026-10-18 passed all 50 backend/rules tests, 24 browser
integration tests, 11 Python build tests, five coin-flip tests, and six
gallery/walking tests. Worker dry-run and both local migration runs passed. The
normal build captured all seven projects; Pong reported zero blocked requests
and zero attempted WebSockets. Desktop waiting and 320-pixel live-play screens
were also inspected using a local signaling runtime. No shared Worker code,
production config, transport settings, or game rules changed. Physical-device,
cross-network, and post-merge deployment checks remain pending as described
below.

Implementation validation on 2026-10-18 used Node.js 24.12.0, the pinned
Playwright 1.63.0 Chromium, and the local workerd/Miniflare runtime. Two isolated
browser contexts selected direct `host` candidate routes (no relay), played a
complete first-to-five match with matching outcomes, and kept playing after
both signaling sockets closed. All 50 backend tests, 23 browser integration
tests, 11 Python build tests, five coin-flip tests, and six gallery/walking
browser tests passed. Wrangler's Worker dry-run and idempotent local D1
migrations passed. The normal screenshot build captured all seven projects;
Pong's capture reported zero blocked requests and zero attempted WebSockets.

The available automated environment tests two browser contexts on the same host,
not two physical devices on distinct networks. Same-LAN two-device and
separate-network/mobile NAT outcomes remain unverified because a second device
and independently routed network are unavailable here. For each feasible manual
check, record the date, browser versions, network types (without IPs), direct
connect success/failure, diagnostic RTT, and whether a complete game agrees on
both screens. An honest connection-failed result on a restrictive network is
expected; never add a TURN fallback to make this test pass.

Required post-merge verification (pending): check the main-branch Actions Worker
and Pages deployment, confirm the account remains on Free with the new SQLite
binding, open Pong from the public gallery, complete a direct game across
available devices/networks, and verify Counter, Bingo, and rock-paper-scissors
still operate. The implementation node does not deploy, push, open a PR, merge,
or claim these production checks passed.
