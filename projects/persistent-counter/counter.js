const counter = document.querySelector('#counter');
const increment = document.querySelector('#increment');
const status = document.querySelector('#status');
let apiUrl;

async function update(path, method = 'GET') {
  const response = await fetch(`${apiUrl}${path}`, { method, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error('Counter request failed');
  const { value } = await response.json();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter response');
  counter.textContent = String(value);
  status.textContent = 'Saved in D1. Everyone shares this value.';
}

increment.addEventListener('click', async () => {
  increment.disabled = true;
  status.textContent = 'Saving…';
  try {
    await update('/api/counter/increment', 'POST');
  } catch {
    // A lost response may still mean a committed write. Do not retry automatically.
    status.textContent = 'Could not confirm the increment. Reload to check the saved value.';
  } finally {
    increment.disabled = false;
  }
});

try {
  const response = await fetch('./api-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  if (!config.apiUrl) {
    status.textContent = 'The counter API is not configured yet. Please try again after deployment.';
  } else {
    apiUrl = new URL(config.apiUrl).origin;
    await update('/api/counter');
    increment.disabled = false;
  }
} catch {
  status.textContent = 'Could not load the counter. Please reload to try again.';
}
