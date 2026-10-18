export const WIDTH = 800, HEIGHT = 450, PADDLE = 84, SPEED = 420, RADIUS = 8;
export const clamp = y => Math.max(PADDLE / 2, Math.min(HEIGHT - PADDLE / 2, y));
export function newGame() {
  return { tick: 0, revision: 0, paddles: [HEIGHT / 2, HEIGHT / 2], ball: [WIDTH / 2, HEIGHT / 2, 330, 110], scores: [0, 0], winner: null, pause: 0.8 };
}
export function movePaddle(y, target, dt) {
  return clamp(y + Math.sign(target - y) * Math.min(Math.abs(target - y), SPEED * dt));
}
// Run only on the creator, at a fixed 120 Hz. Inputs are targets, never scores
// or client-supplied ball positions. Small steps prevent paddle tunneling.
export function step(s, targets, dt) {
  if (s.winner !== null) return null;
  s.tick++;
  s.paddles = s.paddles.map((y, i) => movePaddle(y, targets[i], dt));
  if (s.pause > 0) { s.pause -= dt; return null; }
  const b = s.ball;
  b[0] += b[2] * dt; b[1] += b[3] * dt;
  if (b[1] < RADIUS || b[1] > HEIGHT - RADIUS) {
    b[1] = Math.max(RADIUS, Math.min(HEIGHT - RADIUS, b[1])); b[3] *= -1;
  }
  const side = b[2] < 0 ? 0 : 1, face = side === 0 ? 32 : WIDTH - 32;
  if ((side === 0 ? b[0] - RADIUS <= face && b[0] >= face - 12 : b[0] + RADIUS >= face && b[0] <= face + 12)
      && Math.abs(b[1] - s.paddles[side]) <= PADDLE / 2 + RADIUS) {
    b[0] = face + (side === 0 ? RADIUS : -RADIUS);
    b[2] = (side === 0 ? 1 : -1) * Math.min(650, Math.abs(b[2]) * 1.04);
    b[3] = (b[1] - s.paddles[side]) / (PADDLE / 2) * 290;
  }
  if (b[0] < -RADIUS || b[0] > WIDTH + RADIUS) {
    const scorer = b[0] < 0 ? 1 : 0;
    s.scores[scorer]++; s.revision++;
    s.ball = [WIDTH / 2, HEIGHT / 2, scorer === 0 ? -330 : 330, 110]; s.pause = 0.8;
    if (s.scores[scorer] === 5) s.winner = scorer;
    return s.winner === null ? 'score' : 'end';
  }
  return null;
}
export function validState(s) {
  return s && Number.isSafeInteger(s.tick) && s.tick >= 0 && Number.isSafeInteger(s.revision) && s.revision >= 0
    && Array.isArray(s.paddles) && s.paddles.length === 2 && s.paddles.every(y => Number.isFinite(y) && y >= PADDLE / 2 && y <= HEIGHT - PADDLE / 2)
    && Array.isArray(s.ball) && s.ball.length === 4 && s.ball.every(v => Number.isFinite(v) && Math.abs(v) <= 2000)
    && Array.isArray(s.scores) && s.scores.length === 2 && s.scores.every(v => Number.isInteger(v) && v >= 0 && v <= 5)
    && (s.winner === null || [0, 1].includes(s.winner) && s.scores[s.winner] === 5);
}
// Unreliable motion can arrive after a reliable score/end. Never let it roll
// back an essential event, and wait for the reliable event on a new revision.
export function acceptState(current, next, reliable) {
  return validState(next) && (reliable
    ? next.revision >= current.revision && next.tick >= current.tick
    : next.revision === current.revision && next.tick > current.tick);
}
