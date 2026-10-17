// Rejection sampling avoids modulo bias, including when the remaining pool is small.
export function randomInt(size, sample = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  const ceiling = Math.floor(0x100000000 / size) * size;
  let value;
  do { value = sample(); } while (value >= ceiling);
  return value % size;
}

export function createCard(pick = randomInt) {
  const card = Array(25).fill(null);
  for (let col = 0; col < 5; col++) {
    const pool = Array.from({ length: 15 }, (_, i) => col * 15 + i + 1);
    for (let row = 0; row < 5; row++) {
      if (row === 2 && col === 2) continue;
      card[row * 5 + col] = pool.splice(pick(pool.length), 1)[0];
    }
  }
  return card;
}

export function drawNumber(called, pick = randomInt) {
  const pool = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !called.includes(n));
  return pool.length ? pool[pick(pool.length)] : null;
}

export function hasBingo(marks) {
  const marked = i => i === 12 || marks.includes(i);
  for (let i = 0; i < 5; i++) {
    if (Array.from({ length: 5 }, (_, j) => i * 5 + j).every(marked)
        || Array.from({ length: 5 }, (_, j) => j * 5 + i).every(marked)) return true;
  }
  return [0, 6, 12, 18, 24].every(marked) || [4, 8, 12, 16, 20].every(marked);
}
