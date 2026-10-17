const $ = id => document.getElementById(id);
const storageKey = 'sandbox-bingo-credential';
let credential;
try { credential = localStorage.getItem(storageKey); } catch { /* Keep an in-memory identity if storage is blocked. */ }
if (!/^[a-f0-9]{64}$/.test(credential ?? '')) credential = null;
let socket, endpoint, snapshot, live = false, pending = false, seq = 0, retry = 0;
let timer, heartbeat, pongTimer, suspended = false, stopped = false, previousCall = null;
const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
const label = n => `${'BINGO'[Math.floor((n - 1) / 15)]} ${n}`;
const cells = Array.from({ length: 25 }, (_, index) => {
  const button = document.createElement('button');
  button.disabled = true;
  button.onclick = () => {
    if (button.getAttribute('aria-disabled') !== 'true') act('mark', { index });
  };
  $('card').append(button); return button;
});
function render() {
  const focused = document.activeElement?.id;
  const you = snapshot?.you, called = snapshot?.called ?? [], available = live && !pending && snapshot?.playAvailable;
  cells.forEach((button, index) => {
    const free = index === 12, n = you?.card[index], marked = free || you?.marks.includes(index);
    const eligible = !free && called.includes(n) && !marked;
    button.textContent = free ? 'FREE' : n ?? '—';
    button.className = `${marked ? 'marked' : eligible ? 'eligible' : ''}${free ? ' free' : ''}`;
    // Keep called squares focusable while acknowledging a mark; native disabling
    // would drop keyboard focus to the page on every successful mark.
    button.disabled = !live || !snapshot?.playAvailable || free || (!eligible && !marked);
    button.setAttribute('aria-disabled', String(!available || !eligible));
    button.setAttribute('aria-pressed', String(!!marked));
    button.setAttribute('aria-label', free ? 'Free center, marked' : n ? `${label(n)}, ${marked ? 'marked' : eligible ? 'called, tap to mark' : 'not called'}` : 'Waiting for your card');
  });
  const latest = called.at(-1);
  text('latest', latest ? label(latest) : '—');
  const callKey = `${snapshot?.game}:${called.length}`;
  if (latest && callKey !== previousCall) {
    $('latest').classList.remove('drawn'); void $('latest').offsetWidth; $('latest').classList.add('drawn');
  }
  previousCall = callKey;
  text('count', `${called.length} / 75`);
  text('progress', !you ? 'Waiting for the session' : snapshot.phase === 'waiting' ? 'Ready when the caller is'
    : snapshot.phase === 'complete' ? 'All 75 called. Keep marking!' : `${75 - called.length} numbers to go`);
  if ($('history').dataset.calls !== called.join(',')) {
    $('history').dataset.calls = called.join(',');
    $('history').replaceChildren(...called.map(n => { const li = document.createElement('li'); li.textContent = label(n); return li; }));
  }
  $('celebration').hidden = !you?.bingo;
  text('wins', snapshot?.wins.length ? `${snapshot.wins.length} verified Bingo${snapshot.wins.length === 1 ? '' : 's'}! Everyone can keep playing.` : '');
  text('session', !you ? '' : `${snapshot.connected} connected · ${snapshot.caller ? snapshot.caller.reconnectUntil ? 'Caller reconnecting (30-second grace).' : you.caller ? 'You hold the caller role.' : 'A caller is here.' : 'The caller role is open.'}`);
  if (snapshot?.playAvailable === false) text('notice', 'Daily play limit reached. Play resumes tomorrow (UTC).');
  $('claim').hidden = !you || !!snapshot.caller;
  $('claim').disabled = !live || !snapshot?.playAvailable;
  $('claim').setAttribute('aria-disabled', String(!available));
  $('caller-controls').hidden = !you?.caller;
  $('start').hidden = snapshot?.phase !== 'waiting';
  $('draw').hidden = snapshot?.phase === 'waiting';
  $('start').disabled = $('reset').disabled = !live || !snapshot?.playAvailable;
  $('draw').disabled = !live || !snapshot?.playAvailable || snapshot?.phase !== 'playing';
  $('release').disabled = !live;
  for (const id of ['start', 'reset', 'draw', 'release']) $(id).setAttribute('aria-disabled', String(pending || $(id).disabled));
  $('reconnect').hidden = live || !endpoint;
  if (live && !pending && (focused === 'claim' || focused === 'start') && $(focused).hidden) {
    (snapshot?.phase === 'waiting' ? $('start') : $('draw')).focus();
  }
  if ($('reset-dialog').open && (!live || !you?.caller)) $('reset-dialog').close();
}
function act(type, extra = {}) {
  if (!live || pending || socket?.readyState !== WebSocket.OPEN) return;
  pending = true; text('notice', '');
  socket.send(JSON.stringify({ type, game: snapshot.game, seq: ++seq, ...extra })); render();
}
$('claim').onclick = () => act('claim');
$('release').onclick = () => act('release');
$('start').onclick = () => act('start');
$('draw').onclick = () => act('draw', { expected: snapshot.called.length });
$('reset').onclick = () => $('reset-dialog').showModal();
$('reset-dialog').addEventListener('close', () => {
  if ($('reset-dialog').returnValue === 'reset') act('reset', { confirm: true });
  $('reset-dialog').returnValue = '';
});
$('reconnect').onclick = () => { stopped = false; socket?.close(1000, 'Reconnect'); clearTimeout(timer); connect(); };
function connect() {
  clearTimeout(timer); clearInterval(heartbeat); clearTimeout(pongTimer); pongTimer = null;
  const ws = new WebSocket(endpoint); socket = ws;
  seq = 0; live = false; pending = false;
  text('connection', retry ? 'Reconnecting…' : 'Connecting…'); render();
  const initialTimeout = setTimeout(() => ws.close(1000, 'Reconnect'), 10_000);
  heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || pongTimer) return;
    ws.send('ping'); pongTimer = setTimeout(() => ws.close(1000, 'Reconnect'), 10_000);
  }, 20_000);
  ws.onmessage = event => {
    if (ws !== socket) return;
    if (event.data === 'pong') { clearTimeout(pongTimer); pongTimer = null; return; }
    let m;
    try { m = JSON.parse(event.data); } catch { ws.close(1000, 'Reconnect'); return; }
    if (m.type === 'ready') {
      ws.send(JSON.stringify({ type: 'join', ...(credential ? { credential } : {}) })); return;
    }
    if (m.type === 'identity') {
      credential = m.credential;
      try { localStorage.setItem(storageKey, credential); }
      catch { text('notice', 'Device storage is unavailable. Keep this tab open to retain your card.'); }
      return;
    }
    if (m.type === 'error') {
      pending = false; text('notice', m.reason);
      if (!live) { stopped = true; clearTimeout(initialTimeout); ws.close(1000, 'Reconnect'); }
      render(); return;
    }
    if (m.type !== 'snapshot' || !m.you) return;
    snapshot = m; pending = false; live = true; retry = 0;
    clearTimeout(initialTimeout); text('connection', 'Live'); render();
  };
  ws.onclose = event => {
    clearTimeout(initialTimeout);
    if (ws !== socket) return;
    clearInterval(heartbeat); clearTimeout(pongTimer); pongTimer = null; clearTimeout(initialTimeout);
    live = false; pending = false;
    if (event.code === 4001 || event.code === 1008) {
      stopped = true;
      text('connection', event.code === 4001 ? 'Card opened in another tab. Continue there, or reconnect here.' : 'Connection paused. Reconnect to continue.');
    } else if (!suspended && !stopped) {
      text('connection', navigator.onLine ? 'Disconnected · reconnecting…' : 'Offline · reconnecting…');
      timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(retry++, 6)) + Math.random() * 250);
    } else text('connection', 'Disconnected');
    render();
  };
  ws.onerror = () => ws.close(1000, 'Reconnect');
}
render();
try {
  const response = await fetch('./api-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Configuration unavailable');
  const { apiUrl } = await response.json(), url = new URL(apiUrl);
  const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  // Local previews must never consume the production game's quota or change it.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (local(location.hostname) && !local(url.hostname))) throw new Error('Preview');
  url.pathname = '/api/bingo/ws'; url.search = ''; url.hash = '';
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint = url; connect();
} catch {
  stopped = true; text('connection', 'Unavailable');
  text('notice', 'This preview has no local game server configured.'); render();
}
window.addEventListener('pagehide', () => {
  suspended = true; clearTimeout(timer); clearInterval(heartbeat); socket?.close(1000, 'Reconnect');
});
window.addEventListener('pageshow', event => {
  if (event.persisted && endpoint && !stopped) { suspended = false; connect(); }
});
