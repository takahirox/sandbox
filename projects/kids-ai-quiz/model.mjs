// A single autoregressive GRU layer, exported from torch.nn.GRU in r/z/n
// order. Expand int8 rows once for fast scalar CPU inference in a worker.
export const modelURL = new URL('./quiz-gru-v1.bin', import.meta.url);
export const modelByteLimit = 256 * 1024;
const tokenLimit = 56;

export function loadModel(buffer) {
  const data = new DataView(buffer);
  if (buffer.byteLength > modelByteLimit || data.getUint32(0) !== 0x51475231) throw new Error('Unrecognized quiz model');
  const metaSize = data.getUint32(4, true);
  const width = data.getUint16(8, true);
  const hidden = data.getUint16(10, true);
  const vocab = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 12, metaSize)));
  if (!Array.isArray(vocab) || vocab[0] !== '<pad>' || vocab[1] !== '<start>' || vocab[2] !== '<end>'
    || vocab[3] !== '\n' || vocab.some(word => typeof word !== 'string')
    || vocab.length > 768 || width < 1 || width > 64 || hidden < 1 || hidden > 128) {
    throw new Error('Invalid quiz model dimensions');
  }

  let offset = 12 + metaSize;
  let numericBytes = 0;
  function floats(size) {
    const values = new Float32Array(size);
    for (let i = 0; i < size; i++, offset += 4) values[i] = data.getFloat32(offset, true);
    numericBytes += values.byteLength;
    return values;
  }

  function matrix(rows, columns) {
    const scales = floats(rows);
    numericBytes -= scales.byteLength; // Only the expanded weights are retained.
    const weights = new Float32Array(rows * columns);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++, offset++) {
        weights[row * columns + col] = scales[row] * data.getInt8(offset);
      }
    }
    numericBytes += weights.byteLength;
    return weights;
  }

  const gates = 3 * hidden;
  const embedding = matrix(vocab.length, width);
  const inputWeights = matrix(gates, width);
  const recurrentWeights = matrix(gates, hidden);
  const inputBias = floats(gates);
  const recurrentBias = floats(gates);
  const outputWeights = matrix(vocab.length, hidden);
  const outputBias = floats(vocab.length);
  if (offset !== data.byteLength) throw new Error('Unexpected quiz model length');

  const state = new Float32Array(hidden);
  const input = new Float32Array(gates);
  const recurrent = new Float32Array(gates);
  const logits = new Float32Array(vocab.length);
  numericBytes += state.byteLength + input.byteLength + recurrent.byteLength + logits.byteLength;

  function project(out, weights, bias, vector, start, columns) {
    for (let row = 0; row < out.length; row++) {
      let sum = bias[row];
      const offset = row * columns;
      for (let i = 0; i < columns; i++) sum += weights[offset + i] * vector[start + i];
      out[row] = sum;
    }
  }

  function step(token) {
    project(input, inputWeights, inputBias, embedding, token * width, width);
    project(recurrent, recurrentWeights, recurrentBias, state, 0, hidden);
    for (let i = 0; i < hidden; i++) {
      const r = 1 / (1 + Math.exp(-input[i] - recurrent[i]));
      const z = 1 / (1 + Math.exp(-input[hidden + i] - recurrent[hidden + i]));
      const candidate = Math.tanh(input[2 * hidden + i] + r * recurrent[2 * hidden + i]);
      state[i] = (1 - z) * candidate + z * state[i];
    }
    project(logits, outputWeights, outputBias, state, 0, hidden);
  }

  function sample(random) {
    let max = -Infinity;
    for (let i = 2; i < logits.length; i++) max = Math.max(max, logits[i]);
    let total = 0;
    for (let i = 2; i < logits.length; i++) {
      // Temperature 0.85, dropping tokens below 3% of the most probable token.
      const weight = Math.exp((logits[i] - max) / 0.85);
      total += logits[i] = weight >= 0.03 ? weight : 0;
    }
    let target = random() * total;
    for (let i = 2; i < logits.length; i++) {
      target -= logits[i];
      if (target < 0) return i;
    }
    return 2;
  }

  return {
    numericBytes,
    generate(random) {
      state.fill(0);
      let token = 1;
      let words = [];
      const fields = [];
      for (let i = 0; i < tokenLimit; i++) {
        step(token);
        token = sample(random);
        if (token === 2) return [...fields, words.join(' ')];
        if (token === 3) {
          fields.push(words.join(' '));
          if (fields.length >= 6) return [];
          words = [];
        } else words.push(vocab[token]);
      }
      return [];
    },
  };
}
