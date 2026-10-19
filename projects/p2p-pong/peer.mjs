export const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
export const ATTEMPT_MS = 40_000;
const DIRECT_FAILURE = 'Direct connection failed. Try a new match or another network.';
const DROPPED = 'Disconnected. Start a new match to play.';
const candidateType = candidate => {
  const type = /\btyp (host|srflx|prflx|relay)\b/.exec(candidate)?.[1];
  return type ?? 'unknown';
};
const counts = () => ({ host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 });
const ufrags = sdp => [...(sdp ?? '').matchAll(/^a=ice-ufrag:(\S+)/gm)].map(m => m[1]);

// Only two generations, on the original authorized sockets. Gameplay never
// touches signaling. No network identifiers/errors are passed to diagnostics.
export class PongPeer {
  constructor(apiUrl, host, invitation, callbacks = {}) {
    this.invitation = invitation; this.host = host; this.callbacks = callbacks; this.closed = false; this.connected = false;
    this.generation = 0; this.channels = {}; this.chain = Promise.resolve();
    this.started = performance.now(); this.timings = {}; this.stage = 'signaling';
    this.resetAttempt();
    const url = new URL('/api/pong/ws', apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    this.timer = setTimeout(() => this.fail('Connection unavailable. Try a new match.', 'signaling'), 10_000);
    this.socket.onmessage = event => this.enqueue(() => this.receive(JSON.parse(event.data)));
    this.socket.onerror = () => { if (!this.connected) this.fail('Connection unavailable. Try a new match.', 'signaling'); };
    this.socket.onclose = () => {
      if (!this.closed && !this.connected && !this.released) this.fail('Invitation unavailable. It may have expired or been used. Try a new match.', 'signaling/authorization');
    };
    this.diagnostics();
  }
  enqueue(action) {
    this.chain = this.chain.then(() => { if (!this.closed) return action(); }).catch(() => {
      if (!this.closed) this.transient(this.stage === 'signaling' ? 'signaling' : 'negotiation');
    });
  }
  mark(stage) {
    this.stage = stage;
    this.timings[stage] = Math.round(performance.now() - this.started);
    this.diagnostics();
  }
  resetAttempt() {
    this.candidates = []; this.localCandidates = []; this.localSignaled = false;
    this.remoteGeneration = null; this.localUfrags = []; this.remoteUfrags = [];
    this.localCounts = counts(); this.remoteCounts = counts(); this.candidateErrors = 0;
    this.localSeen = new Set(); this.remoteSeen = new Set(); this.pairTypes = null;
    this.gatherErrors = 0; this.localEnd = false; this.remoteEnd = false;
    this.transportReady = false; this.opening = false; this.retryPending = false;
  }
  signal(message) {
    if (this.closed || this.released) return false;
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.fail('Connection unavailable. Try a new match.', 'signaling'); return false;
    }
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.fail('Connection unavailable. Try a new match.', 'signaling'); return false; }
  }
  async receive(m) {
    if (m.type === 'hello') {
      this.signal(this.host ? { type: 'create' } : { type: 'join', ...this.invitation }); this.invitation = null;
    } else if (m.type === 'created' && this.host) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail('Invitation expired. Start a new match.', 'signaling/authorization'), 300_000);
      this.mark('waiting'); this.callbacks.onInvite?.(m); this.callbacks.onStatus?.('Waiting for player…');
    } else if (m.type === 'peer' && this.host || m.type === 'joined' && !this.host) {
      if (this.pc) return;
      this.createConnection(); this.beginAttempt();
      // Independent of the async operation queue: even a hung browser operation
      // cannot keep a peer/socket alive indefinitely.
      this.deadline = setTimeout(() => this.fail(DIRECT_FAILURE, this.classifyTimeout()), 82_000);
      if (this.host) await this.offer();
    } else if (m.type === 'restart' && m.generation === 1 && this.generation === 0 && !this.connected) {
      this.generation = 1; this.resetAttempt(); this.beginAttempt();
      // Replacing a pending local offer preserves its SCTP section/channels.
      // Rolling back the very first host offer can remove SCTP in Chromium.
      if (!this.host && this.pc.signalingState !== 'stable') await this.pc.setRemoteDescription({ type: 'rollback' });
      if (this.closed) return;
      if (this.host) this.retryTimer = setTimeout(() => this.enqueue(() => this.offer()), 1000);
    } else if (['offer', 'answer', 'candidate'].includes(m.type) && this.pc) {
      if (m.generation !== this.generation || this.retryPending) return;
      if (m.type === 'candidate') {
        if (candidateType(m.candidate) === 'relay') { this.fail(DIRECT_FAILURE, 'relay-rejected'); return; }
        if (this.candidates.length >= 100) { this.transient('candidate-exchange'); return; }
        this.candidates.push(m);
        await this.drainCandidates();
      } else if (m.type === (this.host ? 'answer' : 'offer') && this.remoteGeneration !== this.generation) {
        if (/^a=candidate:.*\btyp relay\b/m.test(m.sdp)) { this.fail(DIRECT_FAILURE, 'relay-rejected'); return; }
        const generation = this.generation;
        this.mark('remote-description');
        await this.pc.setRemoteDescription({ type: m.type, sdp: m.sdp });
        if (this.closed || this.retryPending || generation !== this.generation) return;
        this.remoteUfrags = ufrags(m.sdp); this.remoteGeneration = generation;
        for (const line of m.sdp.matchAll(/^a=(candidate:.*)$/gm)) this.observeCandidate(line[1].trim(), false);
        await this.drainCandidates();
        if (!this.host) await this.localDescription(await this.pc.createAnswer());
        await this.opened();
      }
    } else if (m.type === 'released') {
      this.released = true;
      if (!this.transportReady) { this.fail(DIRECT_FAILURE, 'datachannel'); return; }
      this.connected = true; clearTimeout(this.timer); clearTimeout(this.deadline); clearTimeout(this.disconnectTimer);
      this.mark('connected'); this.lastPong = performance.now();
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.lastPong > 15_000) this.fail('Disconnected. Your opponent stopped responding.', 'peer-dropped');
        else this.send('events', { type: 'ping', at: performance.now() });
      }, 2000);
      this.callbacks.onStatus?.('Connected'); this.callbacks.onConnected?.(); this.diagnostics();
    } else if (['expired', 'peer-left'].includes(m.type) && !this.connected) {
      this.fail(DROPPED, m.type === 'expired' ? 'negotiation-timeout' : 'signaling');
    }
  }
  beginAttempt() {
    clearTimeout(this.timer); clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
    this.mark(this.generation ? 'retry' : 'negotiating');
    this.callbacks.onStatus?.(this.generation ? 'Retrying connection…' : 'Connecting…');
    this.timer = setTimeout(() => this.transient(this.classifyTimeout()), ATTEMPT_MS);
  }
  classifyTimeout() {
    if (!this.pc) return 'signaling';
    if (this.pc.iceGatheringState !== 'complete' && !Object.values(this.localCounts).some(Boolean)) return 'ice-gathering';
    if (this.remoteGeneration === null) return 'negotiation-timeout';
    if (!Object.values(this.remoteCounts).some(Boolean) || this.candidateErrors) return 'candidate-exchange';
    if (['connected', 'completed'].includes(this.pc.iceConnectionState)) return 'datachannel';
    return 'ice-connectivity';
  }
  transient(reason) {
    if (this.closed || this.retryPending) return;
    this.failure = reason; this.diagnostics();
    if (this.connected) { this.fail(DROPPED, 'peer-dropped'); return; }
    if (this.pc && this.generation === 0 && this.socket.readyState === WebSocket.OPEN && !this.released) {
      this.retryPending = true; this.mark('retry-requested');
      this.signal({ type: 'retry', generation: this.generation });
    } else this.fail(DIRECT_FAILURE, reason);
  }
  async offer() {
    if (this.closed) return;
    this.mark('offer');
    await this.localDescription(await this.pc.createOffer({ iceRestart: this.generation > 0 }));
  }
  async localDescription(description) {
    if (this.closed || this.retryPending) return;
    const generation = this.generation;
    this.localUfrags = ufrags(description.sdp);
    await this.pc.setLocalDescription(description);
    if (this.closed || this.retryPending || generation !== this.generation) return;
    this.localUfrags = ufrags(this.pc.localDescription.sdp);
    if (/^a=candidate:.*\btyp relay\b/m.test(this.pc.localDescription.sdp)) { this.fail(DIRECT_FAILURE, 'relay-rejected'); return; }
    for (const line of this.pc.localDescription.sdp.matchAll(/^a=(candidate:.*)$/gm)) this.observeCandidate(line[1].trim(), true);
    if (!this.signal({ type: description.type, sdp: this.pc.localDescription.sdp, generation })) return;
    this.localSignaled = true; this.mark(description.type === 'offer' ? 'offer-sent' : 'answer-sent');
    for (const candidate of this.localCandidates.splice(0)) this.sendCandidate(candidate);
  }
  observeCandidate(raw, local) {
    const seen = local ? this.localSeen : this.remoteSeen;
    if (!seen.has(raw) && seen.size < 160) {
      seen.add(raw); (local ? this.localCounts : this.remoteCounts)[candidateType(raw)]++;
    }
  }
  sendCandidate(candidate) {
    if (this.closed || this.retryPending || this.transportReady) return;
    // Old generation events can arrive after restart. Never relabel their ICE
    // credentials as current; retain both address families without filtering.
    if (candidate?.usernameFragment && !this.localUfrags.includes(candidate.usernameFragment)) return;
    const raw = candidate?.candidate ?? '';
    const type = candidateType(raw);
    if (type === 'relay') { this.fail(DIRECT_FAILURE, 'relay-rejected'); return; }
    if (raw) this.observeCandidate(raw, true);
    else { if (this.localEnd) return; this.localEnd = true; }
    this.signal({ type: 'candidate', generation: this.generation, candidate: raw,
      sdpMid: candidate?.sdpMid ?? null, sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
      usernameFragment: candidate?.usernameFragment ?? null });
    this.diagnostics();
  }
  async drainCandidates() {
    if (this.remoteGeneration !== this.generation) return;
    for (const m of this.candidates.splice(0)) {
      if (this.closed || this.retryPending) return;
      if (m.usernameFragment && !this.remoteUfrags.includes(m.usernameFragment)) continue;
      // Empty candidate with no mid means end of all transports. A late valid
      // candidate is still tried, so reordered completion cannot crash setup.
      try {
        await this.pc.addIceCandidate(m.candidate ? { candidate: m.candidate, sdpMid: m.sdpMid,
          sdpMLineIndex: m.sdpMLineIndex, usernameFragment: m.usernameFragment } : null);
        if (this.closed) return;
        if (m.candidate) this.observeCandidate(m.candidate, false);
        else this.remoteEnd = true;
      } catch { if (this.closed) return; this.candidateErrors++; }
    }
    this.diagnostics();
  }
  createConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed || this.retryPending) return;
      if (!candidate && !ufrags(this.pc.localDescription?.sdp).some(value => this.localUfrags.includes(value))) return;
      if (this.localSignaled) this.sendCandidate(candidate);
      else if (this.localCandidates.length < 100) this.localCandidates.push(candidate);
      else this.transient('ice-gathering');
    };
    this.pc.onicecandidateerror = () => { if (!this.closed) { this.gatherErrors++; this.diagnostics(); } };
    this.pc.onicegatheringstatechange = () => this.diagnostics();
    const changed = () => {
      if (this.closed) return;
      this.diagnostics();
      if (this.pc.connectionState === 'failed' || this.pc.iceConnectionState === 'failed') {
        // A delayed failed event from the first attempt must not cancel the
        // coordinated restart before its new local description is applied.
        if (this.generation === 1 && !this.localSignaled) return;
        this.transient('ice-connectivity');
      }
      else if (this.pc.connectionState === 'closed') this.fail(DROPPED, this.connected ? 'peer-dropped' : 'ice-connectivity');
      else if (this.pc.connectionState === 'disconnected' || this.pc.iceConnectionState === 'disconnected') {
        if (!this.disconnectTimer) this.disconnectTimer = setTimeout(() => this.transient('ice-connectivity'), 10_000);
      } else {
        clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
        if (['connected', 'completed'].includes(this.pc.iceConnectionState)) this.enqueue(() => this.opened());
      }
    };
    this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = changed;
    this.pc.ondatachannel = ({ channel }) => this.attach(channel);
    if (this.host) {
      this.attach(this.pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }));
      this.attach(this.pc.createDataChannel('events', { ordered: true }));
    }
  }
  attach(channel) {
    if (!['motion', 'events'].includes(channel.label) || this.channels[channel.label]) { channel.close(); return; }
    this.channels[channel.label] = channel;
    channel.onopen = () => { this.diagnostics(); this.enqueue(() => this.opened()); };
    channel.onclose = channel.onerror = () => { if (!this.closed) this.fail(DROPPED, this.connected ? 'peer-dropped' : 'datachannel'); };
    channel.onmessage = ({ data }) => {
      if (this.closed || typeof data !== 'string' || data.length > 4096) return;
      try {
        const m = JSON.parse(data);
        if (!m || typeof m !== 'object') return;
        if (channel.label === 'events' && m.type === 'ping' && Number.isFinite(m.at)) this.send('events', { type: 'pong', at: m.at });
        else if (channel.label === 'events' && m.type === 'pong' && Number.isFinite(m.at)) {
          this.lastPong = performance.now(); this.rtt = Math.max(0, Math.round(this.lastPong - m.at)); this.diagnostics();
        } else this.callbacks.onMessage?.(m, channel.label === 'events');
      } catch { /* Ignore malformed peer data, without logging IPs or SDP. */ }
    };
  }
  async opened() {
    if (this.closed || this.transportReady || this.opening || this.retryPending || !this.localSignaled
        || this.remoteGeneration !== this.generation || !['motion', 'events'].every(label => this.channels[label]?.readyState === 'open')) return;
    this.opening = true; const generation = this.generation;
    try {
      const stats = await this.pc.getStats();
      if (this.closed || generation !== this.generation || this.retryPending) return;
      const selected = [...stats.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId;
      const pairs = [...stats.values()].filter(s => s.type === 'candidate-pair' && (s.id === selected || s.state === 'succeeded' && s.nominated));
      for (const pair of pairs) {
        // Whitelist types: stats may contain addresses and other private fields.
        const types = [pair.localCandidateId, pair.remoteCandidateId].map(id => {
          const type = stats.get(id)?.candidateType;
          return ['host', 'srflx', 'prflx', 'relay'].includes(type) ? type : 'unknown';
        });
        if (types.includes('relay')) { this.fail(DIRECT_FAILURE, 'relay-rejected'); return; }
        this.pairTypes = types.join(' / ');
      }
      this.transportReady = true; this.mark('datachannels-open');
      this.signal({ type: 'ready', generation });
    } finally { this.opening = false; }
  }
  diagnostics() {
    this.callbacks.onDiagnostics?.({ gathering: this.pc?.iceGatheringState ?? 'new', ice: this.pc?.iceConnectionState ?? 'new',
      connection: this.pc?.connectionState ?? 'new', rtt: this.rtt ?? null, direct: this.connected,
      channels: Object.fromEntries(['motion', 'events'].map(label => [label, this.channels[label]?.readyState ?? 'pending'])),
      local: { ...this.localCounts }, remote: { ...this.remoteCounts }, pair: this.pairTypes ?? 'pending',
      localEnd: this.localEnd, remoteEnd: this.remoteEnd, candidateErrors: this.candidateErrors, gatherErrors: this.gatherErrors,
      stage: this.stage, timings: { ...this.timings }, retries: this.generation, failure: this.failure ?? 'none' });
  }
  send(channel, message) {
    const dc = this.channels[channel];
    if (!this.closed && dc?.readyState === 'open' && dc.bufferedAmount < (channel === 'motion' ? 4096 : 65536)) {
      try { dc.send(JSON.stringify(message)); return true; } catch { this.fail(DROPPED, 'peer-dropped'); }
    }
    return false;
  }
  fail(message, reason = 'negotiation') {
    if (!this.closed) { this.failure = reason; this.mark('failed'); this.close(); this.callbacks.onFailure?.(message); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearTimeout(this.timer); clearTimeout(this.deadline); clearTimeout(this.retryTimer); clearTimeout(this.disconnectTimer); clearInterval(this.heartbeat);
    this.candidates = []; this.localCandidates = []; this.localSeen.clear(); this.remoteSeen.clear();
    this.localUfrags = []; this.remoteUfrags = []; this.invitation = null;
    this.socket.close(); this.pc?.close(); this.diagnostics();
  }
}
