import { WIDTH, HEIGHT, PADDLE, RADIUS, SPEED, clamp, newGame, movePaddle, step, acceptState } from './rules.mjs';
import { PongPeer } from './peer.mjs';

const $ = id => document.getElementById(id);
const canvas = $('court'), ctx = canvas.getContext('2d');
const debug = new URLSearchParams(location.search).get('debug') === '1';
$('debug').hidden = !debug;
// Capability stays in the fragment (never HTTP/Referer), then leaves the URL.
const fragment = new URLSearchParams(location.hash.slice(1));
const invitation = { session: fragment.get('session'), invite: fragment.get('invite') };
const invited = /^[a-f0-9]{32}$/.test(invitation.session) && /^[a-f0-9]{64}$/.test(invitation.invite);
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let apiUrl = '', peer, host = true, running = false, finished = false;
let state = newGame(), targets = [HEIGHT / 2, HEIGHT / 2], display = structuredClone(state);
let direction = 0, localY = HEIGHT / 2, sequence = 0, lastInput = -1, lastFrame = 0, lastSend = 0, accumulator = 0;
const status = text => { $('status').textContent = text; };
function controls(enabled) { $('up').disabled = $('down').disabled = !enabled; }
function phase(value, focus = false) {
  const active = document.activeElement;
  document.querySelector('main').dataset.phase = value;
  $('create').hidden = !['ready', 'offline', 'finished', 'failure'].includes(value);
  $('create').textContent = value === 'finished' ? 'Play again' : value === 'failure' ? 'Create new match' : 'Create match';
  $('join').hidden = value !== 'invited';
  $('invitation').hidden = value !== 'waiting';
  $('leave').hidden = !['connecting', 'waiting', 'playing'].includes(value);
  $('play-controls').hidden = value !== 'playing';
  $('privacy').hidden = ['loading', 'connecting', 'playing'].includes(value);
  controls(value === 'playing');
  if (value !== 'waiting') {
    $('invite').value = '';
    $('invite-details').open = false;
  }
  // A state change must not leave keyboard focus in a hidden action/control.
  if (focus || active?.closest('[hidden]')) {
    const next = value === 'playing' ? canvas : value === 'waiting' ? $('copy')
      : value === 'connecting' ? $('leave') : value === 'invited' ? $('join') : $('create');
    next.focus({ preventScroll: true });
  }
}
function score() {
  for (const [i, id] of ['left-score', 'right-score'].entries()) {
    // Avoid repeated live-region announcements on every motion snapshot.
    if ($(id).textContent !== String(state.scores[i])) $(id).textContent = state.scores[i];
  }
}
function endMatch() {
  if (finished) return;
  running = false; finished = true; controls(false); direction = 0;
  score(); status(`${state.winner === 0 ? 'Left' : 'Right'} wins · ${state.scores.join(' – ')}`);
  phase('finished', true);
  // Keep reliable channel open until the opponent receives the end event.
}
function start(asHost) {
  peer?.close(); host = asHost; running = false; finished = false;
  state = newGame(); display = structuredClone(state); targets = [HEIGHT / 2, HEIGHT / 2];
  localY = HEIGHT / 2; direction = 0; sequence = 0; lastInput = -1; accumulator = 0; score(); controls(false);
  $('copy').textContent = 'Copy invitation link';
  $('privacy').open = false;
  $('left-label').textContent = host ? 'You · left' : 'Opponent · left';
  $('right-label').textContent = host ? 'Opponent · right' : 'You · right';
  status('Connecting…'); phase('connecting');
  const current = new PongPeer(apiUrl, host, invitation, {
    onInvite: ({ session, invite }) => {
      const url = new URL(location.href); url.hash = new URLSearchParams({ session, invite });
      $('invite').value = url.href; phase('waiting', true);
    },
    onStatus: message => {
      status(message);
      if (['Connecting…', 'Retrying connection…'].includes(message)) phase('connecting');
    },
    onConnected: () => {
      running = true; phase('playing');
      lastFrame = performance.now(); lastSend = 0; canvas.focus({ preventScroll: true });
      if (host) current.send('events', { type: 'start', state });
    },
    onMessage: (m, reliable) => {
      if (m.type === 'input' && !reliable && Number.isSafeInteger(m.seq) && m.seq > lastInput && Number.isFinite(m.y)) {
        lastInput = m.seq; targets[host ? 1 : 0] = clamp(m.y);
      } else if (!host && (reliable ? ['start', 'score', 'end'].includes(m.type) : m.type === 'state') && acceptState(state, m.state, reliable)) {
        state = m.state; score();
        if (reliable) display = structuredClone(state);
        if (state.winner !== null) endMatch();
      }
    },
    onFailure: message => {
      running = false; controls(false); direction = 0;
      if (!finished) status(message);
      phase(finished ? 'finished' : 'failure', true);
    },
    onDiagnostics: data => {
      if (debug) {
        const count = values => Object.entries(values).map(([type, n]) => `${type} ${n}`).join(' · ');
        $('diagnostics').textContent = [
          `Stage: ${data.stage}`, `Retry: ${data.retries} / 1`, `Last failure: ${data.failure}`,
          `ICE gathering: ${data.gathering}`, `ICE: ${data.ice}`, `Connection: ${data.connection}`,
          `Local: ${count(data.local)}`, `Remote: ${count(data.remote)}`,
          `Gathering errors: ${data.gatherErrors}`, `Candidate errors: ${data.candidateErrors}`,
          `End of candidates: local ${data.localEnd ? 'yes' : 'no'} / remote ${data.remoteEnd ? 'yes' : 'no'}`,
          `Selected pair types: ${data.pair}`, `DataChannels: ${count(data.channels)}`,
          `Direct DataChannels: ${data.direct ? 'open' : 'pending'}`,
          `Round-trip time: ${data.rtt === null ? 'pending' : data.rtt + ' ms'}`,
          `Stages (ms): ${Object.entries(data.timings).map(([stage, ms]) => `${stage} ${ms}`).join(' · ')}`,
          'STUN only · no relay'
        ].join('\n');
      }
    }
  });
  peer = current;
}
$('create').onclick = () => start(true);
$('join').onclick = () => start(false);
$('leave').onclick = () => {
  peer?.close(); running = false; controls(false); direction = 0;
  status('Disconnected. Start a new match to play.'); phase('failure', true);
};
$('copy').onclick = async () => {
  const link = $('invite').value;
  try {
    await navigator.clipboard.writeText(link);
    if ($('invite').value === link) { $('copy').textContent = 'Copy again'; status('Link copied · waiting for player…'); }
  } catch {
    if ($('invite').value === link) {
      $('invite-details').open = true; $('invite').focus(); $('invite').select(); status('Copy the selected link to invite a player.');
    }
  }
};
const keyDirection = key => ['ArrowUp', 'w', 'W'].includes(key) ? -1 : ['ArrowDown', 's', 'S'].includes(key) ? 1 : 0;
canvas.addEventListener('keydown', e => { const d = keyDirection(e.key); if (d && running) { e.preventDefault(); direction = d; } });
canvas.addEventListener('keyup', e => { if (keyDirection(e.key)) { e.preventDefault(); direction = 0; } });
canvas.addEventListener('blur', () => { direction = 0; });
window.addEventListener('blur', () => { direction = 0; });
window.addEventListener('pagehide', () => peer?.close());
for (const [id, d] of [['up', -1], ['down', 1]]) {
  const button = $(id);
  button.onpointerdown = e => {
    if (!running) return;
    e.preventDefault(); // Keep court blur from cancelling a newly held button.
    targets[host ? 0 : 1] = clamp(localY + d * 55);
    direction = d; button.setPointerCapture(e.pointerId);
  };
  button.onpointerup = button.onpointercancel = button.onlostpointercapture = () => { direction = 0; };
  button.onclick = e => { if (e.detail === 0 && running) targets[host ? 0 : 1] = clamp(localY + d * 55); };
}
const aim = e => { if (running) targets[host ? 0 : 1] = clamp((e.clientY - canvas.getBoundingClientRect().top) / canvas.getBoundingClientRect().height * HEIGHT); };
canvas.onpointerdown = e => { canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId); aim(e); };
canvas.onpointermove = e => { if (canvas.hasPointerCapture(e.pointerId)) aim(e); };

function draw(now) {
  const dt = Math.min(.1, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
  if (running) {
    const side = host ? 0 : 1;
    if (direction) targets[side] = clamp(targets[side] + direction * SPEED * dt);
    localY = movePaddle(localY, targets[side], dt);
    if (host) {
      accumulator += dt;
      while (accumulator >= 1 / 120 && running) {
        const event = step(state, targets, 1 / 120); accumulator -= 1 / 120;
        if (event) { score(); peer.send('events', { type: event, state }); if (event === 'end') endMatch(); }
      }
      display = structuredClone(state); localY = state.paddles[0];
    } else {
      const blend = 1 - Math.exp(-dt * 24);
      display.ball = display.ball.map((v, i) => v + (state.ball[i] - v) * blend);
      display.paddles[0] += (state.paddles[0] - display.paddles[0]) * blend;
      display.paddles[1] = localY;
    }
    if (now - lastSend >= 1000 / 30) {
      lastSend = now;
      peer.send('motion', { type: 'input', seq: ++sequence, y: targets[side] });
      if (host) peer.send('motion', { type: 'state', state });
    }
  }
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = '#6c8272'; ctx.setLineDash([7, 10]); ctx.beginPath(); ctx.moveTo(WIDTH / 2, 12); ctx.lineTo(WIDTH / 2, HEIGHT - 12); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#f4f1e9'; ctx.fillRect(20, display.paddles[0] - PADDLE / 2, 12, PADDLE);
  ctx.fillStyle = '#f2a080'; ctx.fillRect(WIDTH - 32, display.paddles[1] - PADDLE / 2, 12, PADDLE);
  ctx.fillStyle = '#f4f1e9'; ctx.beginPath(); ctx.arc(display.ball[0], display.ball[1], RADIUS, 0, Math.PI * 2); ctx.fill();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
try {
  const response = await fetch('./api-config.json', { cache: 'no-store' });
  const config = await response.json();
  if (!config.apiUrl) throw new Error('Offline');
  const url = new URL(config.apiUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid endpoint');
  if (!window.RTCPeerConnection) throw new Error('WebRTC unavailable');
  apiUrl = url.origin; $('create').disabled = false;
  if (invited) { phase('invited'); status('Your opponent invited you to play.'); }
  else { phase('ready'); status('Invite a friend to play.'); }
} catch { phase('offline'); status('Offline preview · matches unavailable.'); }
