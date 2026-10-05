const counter = document.querySelector('#counter');
const increment = document.querySelector('#increment');
const status = document.querySelector('#status');
const connection = document.querySelector('#connection');
let apiUrl;
let socket;
let synchronized = false;
let saving = false;
let retryTimer;
let syncTimer;
let failures = 0;
let stopped = false;

function updateButton() {
  increment.disabled = !synchronized || saving;
}

function connect() {
  clearTimeout(retryTimer);
  clearTimeout(syncTimer);
  synchronized = false;
  updateButton();
  connection.textContent = failures ? 'Reconnecting… Last value may be out of date.' : 'Connecting…';
  const url = new URL('/api/counter/ws', apiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(url);
  socket = current;
  // An open transport is only healthy after its authoritative snapshot arrives.
  syncTimer = setTimeout(() => current.close(), 10_000);
  current.addEventListener('message', event => {
    if (socket !== current) return;
    try {
      const { value } = JSON.parse(event.data);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter');
      counter.textContent = String(value);
      synchronized = true;
      failures = 0;
      clearTimeout(syncTimer);
      connection.textContent = 'Connected — live updates';
      updateButton();
    } catch {
      current.close();
    }
  });
  current.addEventListener('error', () => current.close());
  current.addEventListener('close', () => {
    if (socket !== current || stopped) return;
    clearTimeout(syncTimer);
    synchronized = false;
    updateButton();
    failures++;
    connection.textContent = navigator.onLine
      ? 'Reconnecting… Last value may be out of date.'
      : 'Unavailable — offline. Reconnecting when online.';
    // Only reconnect the subscription. Never replay a mutation.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6));
    retryTimer = setTimeout(connect, delay * (1 + Math.random() * 0.2));
  });
}

increment.addEventListener('click', async () => {
  if (!synchronized || saving) return;
  saving = true;
  updateButton();
  status.textContent = 'Saving…';
  try {
    const response = await fetch(`${apiUrl}/api/counter/increment`, {
      method: 'POST', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('Counter request failed');
    const { value } = await response.json();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter');
    // Display values only from the ordered push stream; a POST response could
    // arrive after a newer broadcast and must not overwrite it.
    status.textContent = 'Saved in D1. Updates are pushed to every connected browser.';
  } catch {
    status.textContent = 'Could not confirm the increment. It may have been saved. Reconnecting to check; the increment will not be retried.';
    synchronized = false;
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
    connection.textContent = 'Unavailable — the counter API is not configured yet. Please try again after deployment.';
  } else {
    const url = new URL(config.apiUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    apiUrl = url.origin;
    connect();
  }
} catch {
  connection.textContent = 'Unavailable — could not load the counter configuration. Please reload to try again.';
}
