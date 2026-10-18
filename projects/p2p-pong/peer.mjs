export const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// Signaling has a strict, separate vocabulary. Gameplay never touches socket.
export class PongPeer {
  constructor(apiUrl, host, invitation, callbacks = {}) {
    this.host = host; this.callbacks = callbacks; this.closed = false; this.connected = false;
    this.candidates = []; this.chain = Promise.resolve(); this.channels = {};
    const url = new URL('/api/pong/ws', apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    this.timer = setTimeout(() => this.fail('Connection failed. Try a new match.'), 35_000);
    this.socket.onmessage = event => {
      this.chain = this.chain.then(async () => {
        if (this.closed) return;
        const m = JSON.parse(event.data);
        if (m.type === 'hello') this.signal(host ? { type: 'create' } : { type: 'join', ...invitation });
        else if (m.type === 'created' && host) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail('Invitation expired. Start a new match.'), 300_000);
          callbacks.onInvite?.(m); callbacks.onStatus?.('Waiting for player…');
        } else if (m.type === 'peer' && host || m.type === 'joined' && !host) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail('Direct connection failed. Try a new match or another network.'), 35_000);
          callbacks.onStatus?.('Connecting…');
          this.createConnection();
          if (host) {
            await this.pc.setLocalDescription(await this.pc.createOffer());
            this.signal({ type: 'offer', sdp: this.pc.localDescription.sdp });
          }
        } else if ((m.type === 'offer' && !host || m.type === 'answer' && host) && this.pc) {
          await this.pc.setRemoteDescription({ type: m.type, sdp: m.sdp });
          for (const candidate of this.candidates.splice(0)) await this.pc.addIceCandidate(candidate);
          if (!host) {
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            this.signal({ type: 'answer', sdp: this.pc.localDescription.sdp });
          }
        } else if (m.type === 'candidate' && this.pc) {
          const candidate = { candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex };
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
          else if (this.candidates.length < 100) this.candidates.push(candidate);
          else this.fail('Direct connection failed. Try a new match.');
        } else if (m.type === 'released') this.released = true;
        else if (['expired', 'peer-left'].includes(m.type) && !this.connected) this.fail('Disconnected. Start a new match to play.');
      }).catch(() => this.fail('Connection failed. Try a new match.'));
    };
    this.socket.onerror = () => { if (!this.connected) this.fail('Connection unavailable. Try a new match.'); };
    this.socket.onclose = () => { if (!this.closed && !this.connected) this.fail('Invitation unavailable. It may have expired or been used. Try a new match.'); };
  }
  signal(message) { if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  createConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal({ type: 'candidate', candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex });
    };
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.diagnostics();
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.fail(this.connected
        ? 'Disconnected. Start a new match to play.' : 'Direct connection failed. Try a new match or another network.');
      if (this.pc.connectionState === 'disconnected' && !this.disconnectTimer) {
        this.disconnectTimer = setTimeout(() => this.fail('Disconnected. Start a new match to play.'), 5000);
      } else if (this.pc.connectionState === 'connected') { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    };
    this.pc.oniceconnectionstatechange = () => this.diagnostics();
    this.pc.ondatachannel = ({ channel }) => this.attach(channel);
    if (this.host) {
      this.attach(this.pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 }));
      this.attach(this.pc.createDataChannel('events', { ordered: true }));
    }
  }
  attach(channel) {
    if (!['motion', 'events'].includes(channel.label) || this.channels[channel.label]) { channel.close(); return; }
    this.channels[channel.label] = channel;
    channel.onopen = () => this.opened().catch(() => this.fail('Connection failed. Try a new match.'));
    channel.onclose = channel.onerror = () => { if (!this.closed) this.fail('Disconnected. Start a new match to play.'); };
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
    if (this.closed || this.connected || this.opening || !['motion', 'events'].every(label => this.channels[label]?.readyState === 'open')) return;
    this.opening = true;
    // STUN-only configuration cannot create a relay. Also reject an unexpected
    // selected relay defensively; expose only a boolean route diagnostic.
    const stats = await this.pc.getStats();
    for (const pair of stats.values()) {
      if (pair.type === 'candidate-pair' && pair.state === 'succeeded' && pair.nominated
          && [pair.localCandidateId, pair.remoteCandidateId].some(id => stats.get(id)?.candidateType === 'relay')) {
        this.fail('Direct connection failed. Try a new match.'); return;
      }
    }
    if (this.closed) return;
    this.connected = true; clearTimeout(this.timer); this.lastPong = performance.now();
    this.signal({ type: 'ready' });
    this.heartbeat = setInterval(() => {
      if (performance.now() - this.lastPong > 15_000) this.fail('Disconnected. Your opponent stopped responding.');
      else this.send('events', { type: 'ping', at: performance.now() });
    }, 2000);
    this.callbacks.onStatus?.('Connected'); this.callbacks.onConnected?.(); this.diagnostics();
  }
  diagnostics() {
    this.callbacks.onDiagnostics?.({ ice: this.pc?.iceConnectionState ?? 'new', connection: this.pc?.connectionState ?? 'new', rtt: this.rtt ?? null, direct: this.connected });
  }
  send(channel, message) {
    const dc = this.channels[channel];
    if (!this.closed && dc?.readyState === 'open' && dc.bufferedAmount < (channel === 'motion' ? 4096 : 65536)) {
      try { dc.send(JSON.stringify(message)); return true; } catch { this.fail('Disconnected. Start a new match to play.'); }
    }
    return false;
  }
  fail(message) { if (!this.closed) { this.close(); this.callbacks.onFailure?.(message); } }
  close() {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearTimeout(this.timer); clearTimeout(this.disconnectTimer); clearInterval(this.heartbeat);
    this.socket.close(); this.pc?.close(); this.diagnostics();
  }
}
