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
let authoritativeValue = null;
const pending = new Map();
const queue = [];
let clientId = crypto.randomUUID();
try {
  const saved = localStorage.getItem('persistent-counter-client');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) clientId = saved;
  else localStorage.setItem('persistent-counter-client', clientId);
} catch { /* A private/storage-disabled page still gets an anonymous identity. */ }
let budget;
let checkpoint;
let checkpointFailures = 0;
let acceptedCount = 0;
let rejectedCount = 0;
let lastRejection = 'None';
let retryAfterMs = 0;
let acknowledgementTimer;
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
    value: authoritativeValue === null ? 'None' : String(authoritativeValue),
    pending: String(pending.size),
    queued: String(queue.length),
    write: pending.size ? 'Awaiting acknowledgement' : 'Idle',
    update: lastUpdate || 'None',
    backend: authoritativeValue === null ? 'Not confirmed' : 'Persisted Durable Object value received',
    client: clientId,
    budget: budget ? `${budget.used} / ${budget.limit} (${budget.day} UTC)` : 'Unknown',
    reset: budget ? new Date(budget.resetAt).toISOString() : 'Unknown',
    checkpoint: checkpoint === undefined ? 'Unknown' : `${checkpoint} (${checkpoint === authoritativeValue ? 'current' : 'pending'}; ${checkpointFailures} failures)`,
    accepted: String(acceptedCount),
    rejected: String(rejectedCount),
    reason: lastRejection,
    throttle: `${retryAfterMs} ms`
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
}

function updateButton() {
  const disabled = !synchronized || budget?.used >= budget?.limit;
  increment.disabled = disabled;
  increment.setAttribute('aria-disabled', String(disabled));
  increment.setAttribute('aria-busy', String(pending.size > 0));
}

function render() {
  showValue(Math.min(Number.MAX_SAFE_INTEGER, authoritativeValue + pending.size));
  updateButton();
  updateDebug();
}

function unconfirmedPush() {
  notice.textContent = 'Couldn’t confirm that push.';
  notice.hidden = false;
}

function awaitAcknowledgements() {
  clearTimeout(acknowledgementTimer);
  const oldest = Array.from(pending.values()).find(intent => intent.sent);
  if (!oldest || !synchronized) return;
  const current = socket;
  acknowledgementTimer = setTimeout(() => {
    if (socket !== current || !synchronized) return;
    recordError('Timed out waiting for a push acknowledgement; no mutation retry.');
    unconfirmedPush();
    synchronized = false;
    updateButton();
    setConnection('reconnecting', 'Reconnecting…');
    current.close();
  }, Math.max(0, oldest.sentAt + 10_000 - Date.now()));
}

function sendNext() {
  if (!synchronized || stopped || socket?.readyState !== WebSocket.OPEN) return;
  while (queue.length) {
    const intent = queue.shift();
    // Once a send is attempted, never replay it, including after a timeout or
    // reconnect. A new authoritative snapshot resolves uncertain optimism.
    intent.sent = true;
    intent.sentAt = Date.now();
    try {
      socket.send(JSON.stringify({ type: 'increment', intentId: intent.id }));
    } catch (error) {
      recordError(`Could not send push: ${error.message}; no mutation retry.`);
      unconfirmedPush();
      synchronized = false;
      socket.close();
      break;
    }
  }
  updateButton();
  updateDebug();
  awaitAcknowledgements();
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
  url.searchParams.set('clientId', clientId);
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
    if (socket !== current || stopped || current.readyState !== WebSocket.OPEN) return;
    try {
      const message = JSON.parse(event.data);
      const { value, intentId, outcome } = message;
      if (!Number.isSafeInteger(value) || value < 0
          || !message.budget || !Number.isSafeInteger(message.budget.used)
          || message.budget.used < 0 || message.budget.used > message.budget.limit
          || !Number.isSafeInteger(message.budget.limit) || message.budget.limit <= 0
          || !Number.isFinite(message.budget.resetAt)
          || !['snapshot', 'incrementResult'].includes(message.type)
          || (message.type === 'incrementResult' && !['accepted', 'rejected'].includes(outcome))) {
        throw new Error('Invalid counter');
      }
      if (!synchronized) {
        for (const [id, intent] of pending) {
          if (intent.sent) {
            recordError('Reconnected with an unconfirmed sent increment; reconciled from Durable Object storage, no mutation retry.');
            unconfirmedPush();
            pending.delete(id);
          }
        }
      }
      const local = pending.get(intentId);
      if (local?.sent) {
        pending.delete(intentId);
        if (outcome === 'accepted') {
          acceptedCount++;
          notice.hidden = true;
        } else {
          rejectedCount++;
          lastRejection = message.reason;
          retryAfterMs = message.retryAfterMs;
          notice.textContent = message.reason === 'daily_limit' ? 'Daily limit reached'
            : message.reason === 'counter_full' ? 'Counter full' : 'Too fast';
          notice.hidden = false;
        }
      }
      budget = message.budget;
      checkpoint = message.checkpoint;
      checkpointFailures = message.checkpointFailures;
      if (budget.used >= budget.limit) {
        notice.textContent = 'Daily limit reached';
        notice.hidden = false;
      } else if (notice.textContent === 'Daily limit reached') notice.hidden = true;
      authoritativeValue = value;
      lastUpdate = new Date().toISOString();
      synchronized = true;
      render();
      failures = 0;
      clearTimeout(syncTimer);
      setConnection('live', 'LIVE');
      sendNext();
      awaitAcknowledgements();
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
    clearTimeout(acknowledgementTimer);
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

increment.addEventListener('click', () => {
  if (!synchronized || stopped || increment.disabled) return;
  animate(increment, [
    { transform: 'translateY(6px)' },
    { transform: 'translateY(0)' }
  ], 160);
  const intent = { id: crypto.randomUUID(), sent: false };
  pending.set(intent.id, intent);
  queue.push(intent);
  notice.hidden = true;
  render();
  sendNext();
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
  clearTimeout(acknowledgementTimer);
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
