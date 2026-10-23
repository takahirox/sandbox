import { VirtualAudience } from './audience.mjs';
import { MIN_AUDIO_INTERVAL, VOICES } from './config.mjs';
import { Diagnostics } from './diagnostics.mjs';

const $ = (id) => document.getElementById(id);
const start = $('start'),
  status = $('status'),
  video = $('camera');
const debug = new URLSearchParams(location.search).get('debug') === '1';
const audience = new VirtualAudience();
const manual = { like: false, subscribe: false };
const numbers = new Intl.NumberFormat('en-US');
let active = null;

function renderAudience() {
  const state = audience.snapshot();
  $('viewer-count').hidden = !state.running;
  $('viewer-count').textContent = `${numbers.format(state.viewers)} watching`;
  $('like-label').textContent = manual.like ? '♥ Liked' : '♡ Like';
  $('like-count').textContent = numbers.format(state.likes + Number(manual.like));
  $('subscribe-label').textContent = manual.subscribe ? 'Subscribed' : 'Subscribe';
  $('subscriber-count').textContent = numbers.format(state.subscribers + Number(manual.subscribe));
  $('subscriber-count').hidden = !state.running;
}
renderAudience();

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function clearTimer(session) {
  clearTimeout(session.timer);
  session.timer = null;
}
function deadline(session, delay, message) {
  clearTimer(session);
  session.timer = setTimeout(() => {
    if (active === session) stop(message, true);
  }, delay);
}

function stop(message = 'Camera & mic off.', error = false) {
  const session = active;
  active = null;
  if (session) {
    clearTimer(session);
    clearInterval(session.audienceTimer);
    session.worker?.terminate();
    session.pending = null;
    session.node?.disconnect();
    if (session.node) {
      session.node.port.onmessage = null;
      session.node.port.close();
    }
    session.source?.disconnect();
    session.sink?.disconnect();
    session.stream?.getTracks().forEach((track) => track.stop());
    session.context?.close().catch(() => {});
  }
  video.srcObject = null;
  $('player').classList.remove('has-camera');
  $('session-label').hidden = true;
  start.classList.remove('active');
  start.title = 'Start camera and microphone';
  start.innerHTML = '<span aria-hidden="true">●</span> Go live';
  $('language').disabled = false;
  audience.stop();
  renderAudience();
  $('debug').textContent = '';
  $('debug').hidden = true;
  // User content lives only for the current session, including in the DOM.
  $('messages')
    .querySelectorAll('.comment')
    .forEach((node) => node.remove());
  report(message, error);
}

function addComment(text, voice = 0) {
  if (!text || text.length > 110) return false;
  const log = $('messages');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 64;
  const name = VOICES[Number.isInteger(voice) && voice >= 0 ? voice % VOICES.length : 0].name;
  const row = document.createElement('div');
  row.className = 'comment';
  const avatar = document.createElement('span');
  avatar.className = 'comment-icon';
  avatar.textContent = name[0];
  avatar.setAttribute('aria-hidden', 'true');
  const body = document.createElement('p');
  const author = document.createElement('strong');
  author.textContent = name;
  body.append(author, document.createTextNode(text));
  row.append(avatar, body);
  log.append(row);
  while (log.querySelectorAll('.comment').length > 60)
    log.querySelector('.comment').remove();
  if (follow) log.scrollTop = log.scrollHeight;
  return true;
}

async function begin() {
  const session = { busy: false, ready: false, lastAudio: -Infinity, pending: null,
    diagnostics: debug ? new Diagnostics() : null };
  const record = (event, value) => session.diagnostics?.record(event, value);
  const renderDebug = () => {
    if (!debug || active !== session) return;
    $('debug').hidden = false;
    $('debug').textContent = session.diagnostics.summary();
  };
  const submit = audio => {
    session.lastAudio = performance.now();
    session.busy = true;
    record('audio_submitted');
    deadline(session, 90000, 'This device is taking too long. Try starting again.');
    session.worker.postMessage(
      { type: 'audio', audio, language: $('language').value }, [audio.buffer]);
  };
  active = session;
  start.textContent = 'End';
  start.classList.add('active');
  start.title = 'Stop camera and microphone';
  $('language').disabled = true;
  report('Checking your device…');
  try {
    if (
      !isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.AudioWorkletNode ||
      !window.Worker
    ) {
      stop(
        'This browser can’t start a session. Try a current desktop browser on HTTPS.',
        true,
      );
      return;
    }
    // Check before requesting devices or downloading anything substantial.
    const adapter = await navigator.gpu?.requestAdapter();
    if (active !== session) return;
    if (!adapter?.features.has('shader-f16')) {
      stop(
        'This device can’t run the chat. Try Chrome or Edge on a recent computer.',
        true,
      );
      return;
    }
    report('Allow camera & microphone access.');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    // Permission dialogs can resolve after End or after a subsequent Start.
    if (active !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    for (const track of stream.getTracks())
      track.addEventListener('ended', () => {
        if (active === session)
          stop('Camera or microphone disconnected. Try again.', true);
      });
    video.srcObject = stream;
    $('session-label').hidden = false;
    audience.start(performance.now());
    renderAudience();
    await video.play();
    if (active !== session) return;
    $('player').classList.add('has-camera');
    report('Loading… First download: about 1.1 GB.');
    session.context = new AudioContext({ sampleRate: 16000 });
    await session.context.resume();
    if (active !== session) return;
    await session.context.audioWorklet.addModule('./audio-worklet.js');
    if (active !== session) return;
    session.node = new AudioWorkletNode(session.context, 'speech-window');
    session.source = session.context.createMediaStreamSource(stream);
    session.sink = session.context.createGain();
    session.sink.gain.value = 0;
    session.source.connect(session.node);
    session.node.connect(session.sink);
    session.sink.connect(session.context.destination);
    session.worker = new Worker(new URL('./ai-worker.mjs', import.meta.url), {
      type: 'module',
    });
    session.worker.onerror = () => {
      if (active === session)
        stop('Chat couldn’t load. Check your connection and try again.', true);
    };
    session.worker.onmessage = ({ data }) => {
      if (active !== session) return;
      if (data.type === 'progress') {
        const percent = Number.isFinite(data.progress)
          ? ` ${Math.min(100, Math.round(data.progress))}%`
          : '';
        report(
          `Loading ${data.stage === 'Chat' ? 'chat' : 'listening'}${percent}…`,
        );
      } else if (data.type === 'ready') {
        if (session.ready) return;
        clearTimer(session);
        session.ready = true;
        audience.start(performance.now());
        renderAudience();
        session.audienceTimer = setInterval(() => {
          if (active !== session) return;
          audience.tick(performance.now());
          record('engagement_tick');
          renderAudience();
          renderDebug();
        }, 1000);
        report('');
      } else if (data.type === 'engagement') {
        // The signal belongs to the submitted audio, not to a late model response.
        audience.observe(data.interest, session.lastAudio);
      } else if (data.type === 'diagnostic') {
        record(data.event, data.value);
      } else if (data.type === 'result') {
        clearTimer(session);
        session.busy = false;
        record('worker_result');
        if (data.comment) record(addComment(data.comment, data.voice) ? 'ui_comment' : 'ui_discard');
        if (session.pending) {
          const audio = session.pending;
          session.pending = null;
          submit(audio);
        }
      } else if (data.type === 'error') {
        stop(
          data.code === 'load'
            ? 'Chat couldn’t load. Check your connection or try another device.'
            : 'This device had trouble keeping up. Try starting again.',
          true,
        );
      }
      renderDebug();
    };
    session.node.port.onmessage = ({ data: audio }) => {
      if (active !== session) return;
      if (audio?.type === 'window') {
        record('audio_windows');
        record(audio.reason);
        renderDebug();
        return;
      }
      session.node.port.postMessage('ack');
      if (!session.ready || !(audio instanceof Float32Array)) return;
      if (session.busy) {
        // One replaceable latest window, never a growing queue or catch-up burst.
        session.pending = audio;
        session.worker.postMessage({ type: 'superseded' });
        record('audio_pending');
        return;
      }
      if (performance.now() - session.lastAudio < MIN_AUDIO_INTERVAL) return;
      submit(audio);
    };
    deadline(
      session,
      300000,
      'Loading took too long. Check your connection and try again.',
    );
    session.worker.postMessage({ type: 'init', debug });
  } catch (error) {
    if (active !== session) return;
    const messages = {
      NotAllowedError:
        'Camera or mic permission was denied. Allow access, then try again.',
      NotFoundError:
        'A camera and microphone are needed. Connect them and try again.',
      NotReadableError:
        'Camera or microphone is busy. Close other apps and try again.',
    };
    stop(
      messages[error.name] ||
        'Couldn’t start on this device. Please try again.',
      true,
    );
  }
}

start.addEventListener('click', () => (active ? stop() : begin()));
for (const id of ['like', 'subscribe'])
  $(id).addEventListener('click', () => {
    manual[id] = !manual[id];
    $(id).setAttribute('aria-pressed', String(manual[id]));
    renderAudience();
  });
window.addEventListener('pagehide', () => stop());
window.addEventListener('beforeunload', () => stop());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && active)
    stop('Camera & mic off.');
});
