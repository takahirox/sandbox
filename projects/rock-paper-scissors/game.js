const $ = id => document.getElementById(id);
const key = 'sandbox-rps-seat';
let saved;
try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* Storage can be unavailable. */ }
if (!saved || !Number.isInteger(saved.room) || saved.room < 1 || saved.room > 5
    || !/^[a-f0-9]{64}$/.test(saved.credential)) saved = null;
let target = saved ? { room: saved.room, mode: 'play' } : null;
let socket, snapshot, live = false, retry = 0, timer, heartbeat, pongTimer;
let pending = null, joining = false, leaving = false, stopped = false, suspended = false, endpoint;
const labels = { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' };
const cards = Array.from({ length: 5 }, (_, i) => {
  const card = document.createElement('article'); card.className = 'room-card';
  const title = document.createElement('h3'); title.textContent = `Room ${i + 1}`;
  const state = document.createElement('p'); state.className = 'room-state'; state.textContent = 'Connecting…';
  const play = document.createElement('button'); play.textContent = 'Join'; play.disabled = true;
  play.setAttribute('aria-label', `Join room ${i + 1}`);
  const watch = document.createElement('button'); watch.textContent = 'Watch'; watch.className = 'quiet'; watch.disabled = true;
  watch.setAttribute('aria-label', `Watch room ${i + 1}`);
  play.onclick = () => join(i + 1, 'play'); watch.onclick = () => join(i + 1, 'spectate');
  card.append(title, state, play, watch); $('rooms').append(card);
  return { card, state, play, watch };
});

function store(value) {
  saved = value;
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key);
  } catch {
    if (value) $('notice').textContent = 'Device storage is unavailable. Keep this tab open to retain your seat.';
  }
}
function send(message) {
  if (!live || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message)); return true;
}
function join(room, mode) {
  target = { room, mode }; joining = true; $('notice').textContent = '';
  send({ type: 'join', room, mode,
    ...(mode === 'play' && saved?.room === room ? { credential: saved.credential } : {}) });
  render();
}
function render() {
  const room = snapshot?.room, you = snapshot?.you;
  cards.forEach((c, i) => {
    c.state.textContent = snapshot?.rooms[i]?.status ?? (stopped ? 'Unavailable' : 'Connecting…');
    c.play.textContent = snapshot?.rooms[i]?.players === 2 ? 'Watch' : 'Join';
    c.play.disabled = c.watch.disabled = !live || !!room || joining;
    c.card.classList.toggle('selected', room?.id === i + 1);
  });
  $('game').hidden = !room;
  if (!room) return;
  const m = room.match, player = you.role === 'player';
  $('room-title').textContent = `Room ${room.id}`;
  $('role').textContent = player ? `You are Player ${you.seat + 1}` : 'You are watching';
  $('leave').disabled = !live;
  $('score').replaceChildren(...m.score.map((score, i) => {
    const div = document.createElement('div'), name = document.createElement('span');
    name.textContent = `Player ${i + 1}${player && you.seat === i ? ' · You' : ''}`;
    const strong = document.createElement('strong'); strong.textContent = score;
    const status = document.createElement('small');
    status.textContent = !room.players[i] ? 'Open seat' : room.players[i].connected ? 'Connected'
      : 'Disconnected · seat held for 60s';
    div.append(name, strong, status); return div;
  }));
  const connected = room.players.every(p => p?.connected);
  $('phase').textContent = m.phase === 'complete' ? `Player ${m.winner + 1} wins the match!`
    : m.phase === 'waiting' ? 'Waiting for an opponent…'
    : !connected ? 'Match paused · waiting for a reconnect…' : `Round ${m.round} · choose your hand`;
  $('hands').hidden = !player;
  document.querySelectorAll('[data-hand]').forEach(b => {
    b.disabled = !live || !snapshot.playAvailable || !player || !connected || m.phase !== 'playing'
      || m.submitted[you.seat] || pending === `${m.id}:${m.round}`;
  });
  $('pending').textContent = m.phase === 'playing'
    ? m.submitted.map((chosen, i) => `Player ${i + 1}: ${chosen ? 'choice locked' : 'still choosing'}`).join(' · ') : '';
  $('rematch').hidden = !player || m.phase !== 'complete';
  $('rematch').disabled = !live || !connected || !snapshot.playAvailable || m.rematch[you.seat] || pending === `${m.id}:rematch`;
  $('consent').textContent = m.phase === 'complete'
    ? m.rematch.some(Boolean) ? `Waiting for ${m.rematch[0] ? 'Player 2' : 'Player 1'} to agree to a rematch.`
      : 'Both players must agree to play again.' : '';
  $('results').replaceChildren(...[...m.results].reverse().map(r => {
    const li = document.createElement('li'); li.value = r.round;
    li.textContent = `${labels[r.hands[0]]} / ${labels[r.hands[1]]} — ${r.winner === null ? 'Tie' : `Player ${r.winner + 1} wins`}`;
    return li;
  }));
  $('spectators').textContent = `${room.spectators} watching`;
  if (!snapshot.playAvailable) $('notice').textContent = 'Daily play limit reached. Play resumes tomorrow (UTC). Watching remains available.';
}
$('leave').onclick = () => {
  target = null; pending = null; joining = true; leaving = true;
  store(null); send({ type: 'leave' }); render();
};
document.querySelectorAll('[data-hand]').forEach(button => button.onclick = () => {
  const m = snapshot.room.match;
  pending = `${m.id}:${m.round}`;
  send({ type: 'move', match: m.id, round: m.round, hand: button.dataset.hand }); render();
});
$('rematch').onclick = () => {
  const m = snapshot.room.match; pending = `${m.id}:rematch`;
  send({ type: 'rematch', match: m.id }); render();
};

function connect(url) {
  clearTimeout(timer);
  socket = new WebSocket(url);
  const ws = socket;
  let received = false;
  // Heartbeat uses the runtime's hibernation auto-response, not backend reads.
  heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || pongTimer) return;
    ws.send('ping'); pongTimer = setTimeout(() => ws.close(), 10_000);
  }, 20_000);
  const initialTimeout = setTimeout(() => { if (!received) ws.close(); }, 10_000);
  ws.onmessage = event => {
    if (event.data === 'pong') { clearTimeout(pongTimer); pongTimer = null; return; }
    let message;
    try { message = JSON.parse(event.data); } catch { ws.close(); return; }
    if (message.type === 'seat') { store({ room: message.room, credential: message.credential }); return; }
    if (message.type === 'left') { target = null; joining = false; leaving = false; store(null); return; }
    if (message.type === 'error') {
      $('notice').textContent = message.reason; pending = null; joining = false;
      if (message.reason.startsWith('Seat expired')) {
        store(null); if (target) join(target.room, 'spectate');
        $('notice').textContent = 'Your previous seat expired. You are now watching; leave and join to claim an open seat.';
      }
      render(); return;
    }
    if (message.type !== 'snapshot' || !Array.isArray(message.rooms) || message.rooms.length !== 5) { ws.close(); return; }
    snapshot = message; live = true; retry = 0;
    const m = message.room?.match, you = message.you;
    if (pending && (!m || you.role !== 'player' || !pending.startsWith(`${m.id}:`)
        || (pending.endsWith(':rematch') ? m.rematch[you.seat]
          : pending !== `${m.id}:${m.round}` || m.submitted[you.seat] || m.phase !== 'playing'))) pending = null;
    $('connection').textContent = 'Live'; $('connection').className = 'live';
    if (!received) {
      received = true; clearTimeout(initialTimeout);
      if (target) join(target.room, target.mode);
    }
    if (message.room && !leaving) { joining = false; target = { room: message.room.id, mode: message.you.role === 'player' ? 'play' : 'spectate' }; }
    if (!message.room) leaving = false;
    render();
  };
  ws.onclose = event => {
    clearInterval(heartbeat); clearTimeout(pongTimer); pongTimer = null; clearTimeout(initialTimeout);
    live = false; joining = false; pending = null;
    $('connection').className = '';
    if (event.code === 4001 || event.code === 1008) {
      stopped = true;
      $('connection').textContent = event.code === 4001 ? 'Seat opened in another tab' : 'Connection closed. Reload to reconnect.';
    } else if (!suspended) {
      $('connection').textContent = navigator.onLine ? 'Reconnecting…' : 'Offline · reconnecting…';
      const delay = Math.min(30_000, 500 * 2 ** Math.min(retry++, 6)) + Math.random() * 250;
      timer = setTimeout(() => connect(url), delay);
    }
    render();
  };
  ws.onerror = () => ws.close();
}
try {
  const response = await fetch('./api-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Configuration unavailable');
  const { apiUrl } = await response.json();
  const url = new URL(apiUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid configuration');
  url.pathname = '/api/rps/ws'; url.search = ''; url.hash = '';
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint = url; connect(url);
} catch {
  stopped = true; $('connection').textContent = 'Unavailable';
  $('notice').textContent = 'This preview has no game server configured.'; render();
}
window.addEventListener('pagehide', () => {
  suspended = true; clearTimeout(timer); clearInterval(heartbeat); socket?.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && endpoint && !stopped) { suspended = false; connect(endpoint); }
});
