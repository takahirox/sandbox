import assert from 'node:assert/strict';
import test from 'node:test';
import { PongPeer, ATTEMPT_MS } from '../../../projects/p2p-pong/peer.mjs';

const sdp = generation => `v=0\r\na=ice-ufrag:ice${generation}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;
const candidate = (generation = 0, address = '2001:db8::1') => ({ type: 'candidate', generation,
  candidate: `candidate:1 1 UDP 1 ${address} 1234 typ host`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: `ice${generation}` });
async function fixture(t, host = true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  class Socket {
    static OPEN = 1;
    readyState = 1; sent = [];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  class PC {
    signalingState = 'stable'; iceConnectionState = 'new'; connectionState = 'new'; iceGatheringState = 'new';
    added = []; offers = []; channels = []; stats = new Map();
    async createOffer(options) { this.offers.push(options); return { type: 'offer', sdp: sdp(options.iceRestart ? 1 : 0) }; }
    async createAnswer() { return { type: 'answer', sdp: this.remoteDescription.sdp }; }
    async setLocalDescription(d) {
      if (d.type === 'rollback') { this.signalingState = 'stable'; return; }
      this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d; this.signalingState = d.type === 'answer' ? 'stable' : 'have-remote-offer';
    }
    async addIceCandidate(c) { this.added.push(c); if (c?.candidate.includes('invalid')) throw new Error('private address must not escape'); }
    createDataChannel(label) {
      const dc = { label, readyState: 'connecting', bufferedAmount: 0, send() {}, close() { this.readyState = 'closed'; } };
      this.channels.push(dc); return dc;
    }
    async getStats() { return this.stats; }
    close() { this.connectionState = 'closed'; this.channels.forEach(c => c.close()); }
  }
  const nativeSocket = globalThis.WebSocket, nativePC = globalThis.RTCPeerConnection;
  globalThis.WebSocket = Socket; globalThis.RTCPeerConnection = PC;
  t.after(() => { globalThis.WebSocket = nativeSocket; globalThis.RTCPeerConnection = nativePC; });
  const failures = [], diagnostics = []; let connected = 0;
  const peer = new PongPeer('https://signal.example', host, { session: 'private-session', invite: 'private-token' }, {
    onFailure: message => failures.push(message), onDiagnostics: d => diagnostics.push(d), onConnected: () => connected++
  });
  t.after(() => peer.close());
  const receive = async message => { peer.socket.onmessage({ data: JSON.stringify(message) }); await peer.chain; };
  await receive({ type: 'hello' });
  await receive({ type: host ? 'peer' : 'joined' });
  return { peer, failures, diagnostics, receive, connected: () => connected };
}

test('candidate-before-description, reordered completion, invalid and IPv4/IPv6 candidates drain safely', async t => {
  const { peer, receive, failures } = await fixture(t, false);
  await receive(candidate());
  await receive({ ...candidate(), candidate: '', usernameFragment: null });
  await receive(candidate(0, '192.0.2.1'));
  await receive({ ...candidate(), candidate: 'invalid' });
  assert.equal(peer.pc.added.length, 0);
  await receive({ type: 'offer', generation: 0, sdp: sdp(0) + `a=${candidate().candidate}\r\n` });
  assert.equal(peer.pc.added.length, 4);
  assert.equal(peer.pc.added[1], null);
  assert.equal(peer.remoteCounts.host, 2); assert.equal(peer.candidateErrors, 1);
  assert.equal(peer.remoteEnd, true); assert.deepEqual(failures, []);
});

test('local candidates and end marker wait for SDP; stale ICE credentials are discarded', async t => {
  const { peer, receive } = await fixture(t, false);
  const setLocal = peer.pc.setLocalDescription.bind(peer.pc);
  peer.pc.setLocalDescription = async d => {
    await setLocal(d);
    peer.pc.onicecandidate({ candidate: candidate() });
    peer.pc.onicecandidate({ candidate: null });
  };
  assert.equal(peer.socket.sent.filter(m => m.type === 'candidate').length, 0);
  await receive({ type: 'offer', generation: 0, sdp: sdp(0) });
  assert.deepEqual(peer.socket.sent.slice(1).map(m => m.type), ['answer', 'candidate', 'candidate']);
  assert.equal(peer.socket.sent.at(-1).candidate, '');
  const before = peer.socket.sent.length;
  peer.pc.onicecandidate({ candidate: candidate(1) });
  assert.equal(peer.socket.sent.length, before);
});

test('one timed retry performs ICE restart, discards stale/future generation data and closes at the bound', async t => {
  const { peer, receive, failures } = await fixture(t);
  t.mock.timers.tick(ATTEMPT_MS);
  assert.equal(peer.socket.sent.at(-1).type, 'retry');
  peer.transient('ice-connectivity');
  assert.equal(peer.socket.sent.filter(m => m.type === 'retry').length, 1);
  await receive({ type: 'restart', generation: 1 });
  // Completion from the old local description must not end the new generation.
  peer.pc.onicecandidate({ candidate: null });
  assert.equal(peer.localCandidates.length, 0);
  peer.pc.iceConnectionState = 'failed'; peer.pc.oniceconnectionstatechange();
  assert.equal(peer.closed, false, 'Delayed previous-attempt failure must not cancel restart');
  peer.pc.iceConnectionState = 'new';
  t.mock.timers.tick(1000); await peer.chain;
  assert.deepEqual(peer.pc.offers, [{ iceRestart: false }, { iceRestart: true }]);
  await receive(candidate(0)); await receive({ type: 'answer', generation: 0, sdp: sdp(0) });
  await receive(candidate(2));
  await receive({ ...candidate(1), usernameFragment: 'ice0' });
  await receive(candidate(1));
  await receive({ type: 'answer', generation: 1, sdp: sdp(1) });
  assert.equal(peer.pc.added.length, 1); assert.equal(peer.remoteCounts.host, 1);
  const sent = peer.socket.sent.length;
  peer.pc.onicecandidate({ candidate: candidate(0) });
  assert.equal(peer.socket.sent.length, sent);
  t.mock.timers.tick(ATTEMPT_MS);
  assert.equal(failures.length, 1); assert.equal(peer.closed, true);
  assert.equal(peer.pc.connectionState, 'closed'); assert.equal(peer.socket.readyState, 3);
  assert.equal(peer.candidates.length, 0);
  t.mock.timers.tick(300_000); assert.equal(failures.length, 1);
});

test('hung async SDP cannot bypass absolute deadline or emit SDP after close', async t => {
  const { peer, failures, receive } = await fixture(t);
  let finish;
  peer.pc.setRemoteDescription = () => new Promise(resolve => { finish = resolve; });
  const pending = receive({ type: 'answer', generation: 0, sdp: sdp(0) });
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(83_000);
  assert.equal(peer.closed, true); assert.equal(failures.length, 1);
  const sent = peer.socket.sent.length; finish(); await pending;
  assert.equal(peer.socket.sent.length, sent);
});

test('signaling send failure is explicit; authorization close never retries', async t => {
  const { peer, failures } = await fixture(t);
  peer.socket.readyState = 3; peer.signal({ type: 'ready', generation: 0 });
  assert.equal(peer.failure, 'signaling'); assert.equal(failures.length, 1);
  assert.equal(peer.socket.sent.some(m => m.type === 'retry'), false);
});

test('relay candidates are rejected and never passed to the browser', async t => {
  const { peer, receive } = await fixture(t, false);
  await receive({ ...candidate(), candidate: candidate().candidate.replace('typ host', 'typ relay') });
  assert.equal(peer.failure, 'relay-rejected'); assert.equal(peer.pc.added.length, 0);
});

test('selected relay pair is rejected; only candidate types enter diagnostics', async t => {
  const { peer, receive, diagnostics } = await fixture(t);
  await receive({ type: 'answer', generation: 0, sdp: sdp(0) });
  peer.pc.stats = new Map([
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { candidateType: 'host', address: '2001:db8::1' }], ['r', { candidateType: 'relay', address: '192.0.2.1' }]
  ]);
  Object.values(peer.channels).forEach(c => c.readyState = 'open');
  await peer.opened(); assert.equal(peer.failure, 'relay-rejected');
  assert.ok(!/2001:|192\.0|candidate:|v=0|ice0|private-token|private-session/.test(JSON.stringify(diagnostics)));
});

test('play starts only on release; post-connect loss does not attempt unauthorized restart', async t => {
  const { peer, receive, connected } = await fixture(t);
  await receive({ type: 'answer', generation: 0, sdp: sdp(0) });
  Object.values(peer.channels).forEach(c => c.readyState = 'open');
  await peer.opened(); assert.equal(connected(), 0); assert.equal(peer.transportReady, true);
  await receive({ type: 'released' }); assert.equal(connected(), 1);
  peer.pc.iceConnectionState = 'disconnected'; peer.pc.oniceconnectionstatechange();
  t.mock.timers.tick(9000); assert.equal(peer.closed, false);
  peer.pc.iceConnectionState = 'connected'; peer.pc.oniceconnectionstatechange();
  t.mock.timers.tick(2000); assert.equal(peer.closed, false);
  peer.pc.iceConnectionState = 'failed'; peer.pc.oniceconnectionstatechange();
  assert.equal(peer.failure, 'peer-dropped'); assert.equal(peer.closed, true);
  assert.equal(peer.socket.sent.filter(m => m.type === 'retry').length, 0);
});

test('timeout categories distinguish gathering, exchange, connectivity and DataChannel startup', async t => {
  const { peer } = await fixture(t);
  assert.equal(peer.classifyTimeout(), 'ice-gathering');
  peer.pc.iceGatheringState = 'complete'; assert.equal(peer.classifyTimeout(), 'negotiation-timeout');
  peer.remoteGeneration = 0; assert.equal(peer.classifyTimeout(), 'candidate-exchange');
  peer.remoteCounts.host = 1; assert.equal(peer.classifyTimeout(), 'ice-connectivity');
  peer.pc.iceConnectionState = 'connected'; assert.equal(peer.classifyTimeout(), 'datachannel');
});

test('an in-flight candidate completing after cancellation cannot retain candidate data or send signals', async t => {
  const { peer, receive } = await fixture(t, false);
  await receive({ type: 'offer', generation: 0, sdp: sdp(0) });
  let finish;
  peer.pc.addIceCandidate = () => new Promise(resolve => { finish = resolve; });
  const pending = receive(candidate());
  await Promise.resolve(); await Promise.resolve();
  peer.close(); const sent = peer.socket.sent.length;
  finish(); await pending;
  assert.equal(peer.remoteSeen.size, 0); assert.equal(peer.remoteCounts.host, 0);
  assert.equal(peer.socket.sent.length, sent);
});
