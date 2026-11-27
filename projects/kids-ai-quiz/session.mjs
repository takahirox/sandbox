// Keep only recent content identifiers on the device. A request concerns one
// round and the worker lives at most as long as the active page.
export const modelHistoryKey = 'kids-ai-quiz:model-history:v1';
const limit = 160;
const identifier = /^[a-zぁ-ゖー0-9:-]{1,56}$/u;

function readHistory(storage) {
  try {
    const value = storage?.getItem(modelHistoryKey);
    if (!value || value.length > limit * 190) return [];
    const rows = JSON.parse(value);
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => Array.isArray(row) && row.length === 3
      && row.every(part => typeof part === 'string' && identifier.test(part)))
      .slice(-limit).map(([key, group, topic]) => ({ key, group, topic }));
  } catch {
    return [];
  }
}

export function modelSession({ random = Math.random, storage, timeout = 1500 } = {}) {
  const recent = readHistory(storage);
  let worker, pending, unavailable = false;

  function stop() {
    worker?.terminate();
    worker = undefined;
    pending?.finish(null);
  }

  function disable() {
    unavailable = true;
    stop();
  }

  return {
    stop,
    generate() {
      if (pending) return pending.promise;
      if (unavailable || typeof Worker !== 'function') return Promise.resolve(null);
      try {
        if (!worker) {
          const active = new Worker(new URL('./model-worker.mjs', import.meta.url), { type: 'module' });
          worker = active;
          active.onmessage = ({ data }) => {
            if (worker !== active || !pending) return;
            if (data?.failed) disable();
            else pending.finish(data?.item ?? null);
          };
          active.onerror = event => {
            event.preventDefault();
            if (worker === active) disable();
          };
          active.onmessageerror = () => {
            if (worker === active) disable();
          };
        }
        let finish;
        const promise = new Promise(resolve => { finish = resolve; });
        const timer = setTimeout(disable, timeout);
        pending = {
          promise,
          finish(item) {
            clearTimeout(timer);
            pending = undefined;
            finish(item);
          },
        };
        worker.postMessage({ seed: Math.floor(random() * 2 ** 32), recent });
        return promise;
      } catch {
        disable();
        return Promise.resolve(null);
      }
    },
    remember({ key, group, topic }) {
      const previous = recent.findIndex(item => item.key === key);
      if (previous !== -1) recent.splice(previous, 1);
      recent.push({ key, group, topic });
      if (recent.length > limit) recent.shift();
      try {
        storage?.setItem(modelHistoryKey, JSON.stringify(recent.map(row => [row.key, row.group, row.topic])));
      } catch {
        // Continue with this tab's bounded history.
      }
    },
  };
}
