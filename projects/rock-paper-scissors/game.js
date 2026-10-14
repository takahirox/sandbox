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
let selectedRoom = null, visibleRoom = null, resultKey = null;
const setText = (id, text) => {
  if ($(id).textContent !== String(text)) $(id).textContent = text;
};
const roomName = room => `Room ${String(room).padStart(2, '0')}`;
const roomState = room => room?.players === 2 ? 'In progress · watch' : room?.status;
const rows = Array.from({ length: 5 }, (_, i) => {
  const row = document.createElement('button'); row.className = 'room-row'; row.disabled = true;
  const number = document.createElement('span'); number.className = 'room-number'; number.textContent = String(i + 1).padStart(2, '0');
  const state = document.createElement('span'); state.className = 'room-state'; state.textContent = 'Connecting…';
  const count = document.createElement('span'); count.className = 'room-count'; count.textContent = '– / 2';
  const arrow = document.createElement('span'); arrow.className = 'room-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
  row.onclick = () => {
    if (!live || joining || snapshot?.room) return;
    if (snapshot.rooms[i].players === 2) { join(i + 1, 'spectate'); return; }
    selectedRoom = i + 1; renderChoice(); $('room-choice').showModal();
  };
  row.append(number, state, count, arrow); $('rooms').append(row);
  return { row, state, count };
});
function renderChoice() {
  if (!selectedRoom) return;
  const room = snapshot?.rooms[selectedRoom - 1];
  setText('choice-title', roomName(selectedRoom));
  const playHadFocus = document.activeElement === $('play');
  setText('choice-state', !live ? stopped ? 'Connection closed. Cancel and reload to reconnect.' : 'Reconnecting…' : room.players === 2 ? 'Room full · watch the match.'
    : !snapshot.playAvailable ? 'Play unavailable · watching is available.'
    : room.players === 0 ? 'Take a seat or watch.' : 'An opponent is waiting. Play or watch.');
  $('play').hidden = room?.players === 2 || !snapshot?.playAvailable;
  $('play').disabled = $('watch').disabled = !live || joining;
  if ($('play').hidden && playHadFocus) $('watch').focus();
}
$('room-choice').addEventListener('close', () => { selectedRoom = null; });
for (const [id, mode] of [['play', 'play'], ['watch', 'spectate']]) $(id).onclick = () => {
  const room = selectedRoom; $('room-choice').close(); join(room, mode);
};

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
  if (!live || joining) return;
  target = { room, mode }; joining = true; setText('notice', '');
  send({ type: 'join', room, mode,
    ...(mode === 'play' && saved?.room === room ? { credential: saved.credential } : {}) });
  render();
}
function render() {
  const room = snapshot?.room, you = snapshot?.you;
  rows.forEach((c, i) => {
    const summary = snapshot?.rooms[i];
    const state = roomState(summary) ?? (stopped ? 'Unavailable' : 'Connecting…');
    const count = summary ? `${summary.players} / 2` : '– / 2';
    if (c.state.textContent !== state) c.state.textContent = state;
    if (c.count.textContent !== count) c.count.textContent = count;
    c.row.setAttribute('aria-label', `${roomName(i + 1)}, ${state}, ${count} players`);
    c.row.disabled = !live || !!room || joining;
  });
  if (!room && snapshot) setText('lobby-update', snapshot.rooms.map(r => `${roomName(r.id)}: ${roomState(r)}, ${r.players} of 2 players`).join('. '));
  renderChoice();
  $('connection').className = live ? 'sr-only' : '';
  setText('availability', snapshot?.playAvailable === false
    ? 'Play limit reached. Try tomorrow (UTC), or watch a match.' : '');
  $('game').hidden = !room;
  $('lobby').hidden = !!room;
  const previousRoom = visibleRoom;
  visibleRoom = room?.id ?? null;
  if (visibleRoom !== previousRoom) {
    if ($('room-choice').open) $('room-choice').close();
    if (room) $('leave').focus();
    else if (previousRoom) rows[previousRoom - 1].row.focus();
  }
  if (!room) { resultKey = null; return; }
  const m = room.match, player = you.role === 'player';
  const order = player ? [you.seat, 1 - you.seat] : [0, 1];
  const name = i => player ? i === you.seat ? 'You' : 'Opponent' : `Player ${i + 1}`;
  setText('room-title', roomName(room.id));
  setText('role', player ? `You are Player ${you.seat + 1}` : 'You are watching');
  $('spectator-label').hidden = player;
  $('leave').disabled = !live || joining;
  // Keep the score nodes stable, including during spectator/lobby pushes.
  if ($('score').dataset.order !== order.join()) {
    $('score').dataset.order = order.join();
    $('score').replaceChildren(...order.map(() => {
      const div = document.createElement('div'); div.append(document.createElement('span'), document.createElement('strong')); return div;
    }));
  }
  order.forEach((seat, index) => {
    const div = $('score').children[index];
    if (div.children[0].textContent !== name(seat)) div.children[0].textContent = name(seat);
    if (div.children[1].textContent !== String(m.score[seat])) div.children[1].textContent = m.score[seat];
  });
  const connected = room.players.every(p => p?.connected);
  const locked = player && (m.submitted[you.seat] || pending === `${m.id}:${m.round}`);
  setText('phase', m.phase === 'complete' ? player ? m.winner === you.seat ? 'You win the match!' : 'Opponent wins the match!'
    : `Player ${m.winner + 1} wins the match!`
    : m.phase === 'waiting' ? room.players.some(Boolean) ? 'Waiting for an opponent…' : 'Waiting for players…'
    : !connected ? 'Match paused · waiting for reconnect…'
    : locked ? 'Waiting for opponent’s hand…' : player ? 'Choose your hand' : 'Players are choosing…');
  setText('submission', m.phase === 'playing' ? m.submitted.map((chosen, i) => `${name(i)}: ${chosen || (player && i === you.seat && locked) ? 'choice locked' : 'still choosing'}`).join('. ') : '');
  setText('round', m.phase === 'playing' ? `Round ${m.round} · First to 3` : 'First to 3');
  $('hands').hidden = !player || m.phase === 'complete';
  document.querySelectorAll('[data-hand]').forEach(b => {
    b.disabled = !live || !snapshot.playAvailable || !player || !connected || m.phase !== 'playing' || locked || joining;
  });
  $('rematch').hidden = !player || m.phase !== 'complete';
  const consented = player && (m.rematch[you.seat] || pending === `${m.id}:rematch`);
  $('rematch').disabled = !live || !connected || !snapshot.playAvailable || consented || joining;
  setText('consent', m.phase !== 'complete' ? '' : !connected ? 'Rematch paused · waiting for reconnect…'
    : consented ? 'Rematch requested · waiting for opponent.'
    : m.rematch.some(Boolean) ? player ? 'Opponent wants to play again.' : 'Waiting for both players to agree.'
    : player ? 'Both players must agree.' : 'Waiting for a rematch.');
  // Only public, resolved hands are rendered. Never show a pending local choice.
  const result = m.results.at(-1), nextKey = result ? `${m.id}:${result.round}` : null;
  if (resultKey !== nextKey) {
    resultKey = nextKey;
    $('result').replaceChildren();
    if (result) {
      order.forEach(seat => {
        const div = document.createElement('div'), symbol = document.createElement('span'), caption = document.createElement('small');
        symbol.className = 'hand-symbol'; symbol.textContent = labels[result.hands[seat]].split(' ')[0]; symbol.setAttribute('aria-hidden', 'true');
        caption.textContent = `${name(seat)} · ${result.hands[seat]}`;
        div.append(symbol, caption); $('result').append(div);
      });
      const outcome = document.createElement('p');
      outcome.textContent = `Round ${result.round} · ${result.winner === null ? 'Tie' : player ? result.winner === you.seat ? 'You win' : 'You lose' : `Player ${result.winner + 1} wins`}`;
      $('result').append(outcome);
      $('result').classList.remove('reveal'); void $('result').offsetWidth; $('result').classList.add('reveal');
    }
  }
}
$('leave').onclick = () => {
  if (!live || joining) return;
  target = null; pending = null; joining = true; leaving = true;
  store(null); send({ type: 'leave' }); render();
};
document.querySelectorAll('[data-hand]').forEach(button => button.onclick = () => {
  if (button.disabled || snapshot?.you.role !== 'player') return;
  const m = snapshot.room.match;
  pending = `${m.id}:${m.round}`;
  send({ type: 'move', match: m.id, round: m.round, hand: button.dataset.hand }); render();
});
$('rematch').onclick = () => {
  if ($('rematch').disabled || snapshot?.you.role !== 'player') return;
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
        $('notice').textContent = 'Your previous seat expired. Watching now; return to the room list to play.';
      }
      render(); return;
    }
    if (message.type !== 'snapshot' || !Array.isArray(message.rooms) || message.rooms.length !== 5) { ws.close(); return; }
    snapshot = message; live = true; retry = 0;
    const m = message.room?.match, you = message.you;
    if (pending && (!m || you.role !== 'player' || !pending.startsWith(`${m.id}:`)
        || (pending.endsWith(':rematch') ? m.rematch[you.seat]
          : pending !== `${m.id}:${m.round}` || m.submitted[you.seat] || m.phase !== 'playing'))) pending = null;
    setText('connection', 'Live');
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
      $('connection').textContent = event.code === 4001 ? 'Seat opened in another tab. Continue there, or reload to reclaim it.' : 'Connection closed. Reload to reconnect.';
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
