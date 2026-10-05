const counter = document.querySelector('#counter');
const increment = document.querySelector('#increment');
const status = document.querySelector('#status');
const connection = document.querySelector('#connection');
const notice = document.querySelector('#notice');
const ripple = document.querySelector('#ripple');
const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
document.querySelector('#debug').hidden = !debugEnabled;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const numberFormat = new Intl.NumberFormat('en-US');
let lastValue = null;
let lastUpdate;
let reconnectAttempts = 0;
let nextRetry = 'None';
let lastClose = 'None';
let apiUrl;
let socket;
let synchronized = false;
let saving = false;
let retryTimer;
let syncTimer;
let failures = 0;
let stopped = false;

function updateDebug() {
  if (!debugEnabled) return;
  const fields = {
    socket: socket ? ['Connecting', 'Open', 'Closing', 'Closed'][socket.readyState] : 'Not started',
    close: lastClose,
    sync: synchronized ? 'Synchronized' : 'Waiting for snapshot',
    retries: String(reconnectAttempts),
    retry: nextRetry,
    api: apiUrl || 'Not configured',
    value: lastValue === null ? 'None' : String(lastValue),
    update: lastUpdate || 'None',
    backend: lastValue === null ? 'Not confirmed' : 'Authoritative D1 value received'
  };
  for (const [key, value] of Object.entries(fields)) {
    document.querySelector(`#debug-${key}`).textContent = value;
  }
}

function setConnection(state, text) {
  connection.dataset.state = state;
  connection.textContent = text;
  updateDebug();
}

function recordError(message) {
  // Technical errors are retained only in the opt-in diagnostic panel.
  if (debugEnabled) status.textContent = message;
}

function animate(element, keyframes, duration) {
  element.getAnimations().forEach(animation => animation.cancel());
  if (!reducedMotion.matches) element.animate(keyframes, { duration, easing: 'ease-out' });
}

reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) {
    for (const element of [counter, increment, ripple]) {
      element.getAnimations().forEach(animation => animation.cancel());
    }
  }
});

function showValue(value) {
  const formatted = numberFormat.format(value);
  counter.textContent = formatted;
  // Keep even the largest safe integer inside a narrow mobile viewport.
  counter.style.setProperty('--count-size', `${Math.min(22, 140 / formatted.length)}vw`);
  counter.style.setProperty('--count-max', `${Math.min(11, 58 / formatted.length)}rem`);
  if (lastValue !== null && lastValue !== value) {
    animate(counter, [
      { transform: 'scale(1)', color: '#222b25' },
      { transform: 'scale(1.025)', color: '#3c7951', offset: .25 },
      { transform: 'scale(1)', color: '#222b25' }
    ], 320);
    animate(ripple, [
      { transform: 'scale(.98)', opacity: .35 },
      { transform: 'scale(1.2)', opacity: 0 }
    ], 450);
  }
  lastValue = value;
  lastUpdate = new Date().toISOString();
}

function updateButton() {
  increment.disabled = !synchronized;
  // Keep keyboard focus while a write is pending; the click guard below and
  // aria-disabled prevent duplicate submissions without removing focus.
  increment.setAttribute('aria-disabled', String(!synchronized || saving));
  increment.setAttribute('aria-busy', String(saving));
}

function connect() {
  clearTimeout(retryTimer);
  clearTimeout(syncTimer);
  synchronized = false;
  updateButton();
  if (failures) reconnectAttempts++;
  nextRetry = 'None';
  const url = new URL('/api/counter/ws', apiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(url);
  socket = current;
  setConnection('connecting', failures ? 'Reconnecting…' : 'Connecting…');
  current.addEventListener('open', () => {
    if (socket === current) updateDebug();
  });
  // An open transport is only healthy after its authoritative snapshot arrives.
  syncTimer = setTimeout(() => {
    recordError('Timed out waiting for an authoritative WebSocket snapshot.');
    current.close();
  }, 10_000);
  current.addEventListener('message', event => {
    if (socket !== current) return;
    try {
      const { value } = JSON.parse(event.data);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter');
      showValue(value);
      synchronized = true;
      failures = 0;
      clearTimeout(syncTimer);
      setConnection('live', 'LIVE');
      updateButton();
    } catch (error) {
      recordError(`Invalid WebSocket update: ${error.message}`);
      synchronized = false;
      updateButton();
      setConnection('reconnecting', 'Reconnecting…');
      current.close();
    }
  });
  current.addEventListener('error', () => {
    if (socket !== current) return;
    recordError('WebSocket connection error.');
    current.close();
  });
  current.addEventListener('close', event => {
    if (socket !== current || stopped) return;
    clearTimeout(syncTimer);
    synchronized = false;
    updateButton();
    failures++;
    lastClose = `${event.code}${event.reason ? `: ${event.reason}` : ''}`;
    // Only reconnect the subscription. Never replay a mutation.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6));
    const retryDelay = delay * (1 + Math.random() * 0.2);
    nextRetry = `${Math.round(retryDelay)} ms`;
    setConnection('reconnecting', navigator.onLine ? 'Reconnecting…' : 'Offline · reconnecting…');
    retryTimer = setTimeout(connect, retryDelay);
  });
}

increment.addEventListener('click', async () => {
  if (!synchronized || saving) return;
  animate(increment, [
    { transform: 'translateY(6px)' },
    { transform: 'translateY(0)' }
  ], 160);
  saving = true;
  updateButton();
  notice.hidden = true;
  try {
    const response = await fetch(`${apiUrl}/api/counter/increment`, {
      method: 'POST', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Counter request failed (HTTP ${response.status})`);
    const { value } = await response.json();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter');
    // Display values only from the ordered push stream; a POST response could
    // arrive after a newer broadcast and must not overwrite it.
  } catch (error) {
    recordError(`Could not confirm the increment: ${error.message}. It may have been saved; no mutation retry.`);
    notice.textContent = 'Couldn’t confirm that push.';
    notice.hidden = false;
    synchronized = false;
    setConnection('reconnecting', 'Reconnecting…');
    socket?.close();
  } finally {
    saving = false;
    updateButton();
  }
});

window.addEventListener('online', () => {
  if (apiUrl && !synchronized && !stopped) {
    // Ignore events from the superseded connection.
    const previous = socket;
    socket = null;
    previous?.close();
    connect();
  }
});
window.addEventListener('offline', () => socket?.close());
window.addEventListener('pagehide', () => {
  stopped = true;
  synchronized = false;
  clearTimeout(retryTimer);
  clearTimeout(syncTimer);
  socket?.close();
  updateButton();
  updateDebug();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && apiUrl) {
    stopped = false;
    connect();
  }
});

try {
  const response = await fetch('./api-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  if (!config.apiUrl) {
    recordError('The counter API is not configured. Set apiUrl in api-config.json.');
    setConnection('unavailable', 'Unavailable');
  } else {
    const url = new URL(config.apiUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    apiUrl = url.origin;
    connect();
  }
} catch (error) {
  recordError(`Could not load counter configuration: ${error.message}`);
  setConnection('unavailable', 'Unavailable · reload to try again');
}
