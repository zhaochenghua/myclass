// WebRTC 推流端：创建 offer -> 交给信令 -> 接收 answer -> 交换 ICE。
// 与 Android 端 CameraWebRtcClient 的角色一致：只发送视频，不接收。

export class LivePublisher {
  constructor(options = {}) {
    this.iceServers = options.iceServers || [];
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onError = options.onError || (() => {});

    this.pc = null;
    this.sender = null;
    this.stream = null;
    this.track = null;
    this.maxBitrate = options.maxBitrate || 6000000;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.answerWaitTimer = null;
  }

  get active() {
    return this.pc !== null;
  }

  get connectionState() {
    return this.pc?.connectionState || 'closed';
  }

  get iceConnectionState() {
    return this.pc?.iceConnectionState || 'closed';
  }

  /**
   * 发布视频轨并生成 offer。
   * @param {MediaStreamTrack} track canvas 捕获轨
   * @returns {Promise<string>} offer SDP
   */
  async publish(track) {
    this.stop();

    const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!RTCPC) {
      throw new Error('当前浏览器不支持 WebRTC');
    }

    const pc = new RTCPC({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle'
    });
    this.pc = pc;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate.toJSON());
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      this.onStateChange(this.iceConnectionState, this.connectionState);
    });

    pc.addEventListener('connectionstatechange', () => {
      this.onStateChange(this.iceConnectionState, this.connectionState);
    });

    const stream = new MediaStream([track]);
    this.stream = stream;
    this.track = track;
    const sender = pc.addTrack(track, stream);
    this.sender = sender;
    this.#tuneSender(sender);

    // iOS Safari 只支持 H.264，显式提升优先级可避免协商到不支持的编码。
    this.#preferH264(pc);

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    return pc.localDescription.sdp;
  }

  async acceptAnswer(sdp) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteDescriptionSet = true;
    for (const candidate of this.pendingCandidates) {
      await this.addIceCandidate(candidate).catch(() => {});
    }
    this.pendingCandidates = [];
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // 远端在 answer 之前到达的候选会被缓存，重复添加时忽略
      if (this.pc && this.remoteDescriptionSet) {
        this.pendingCandidates.push(candidate);
      }
    }
  }

  /** 旋转/切换镜头导致分辨率变化时替换轨道，无需重新协商 */
  async replaceTrack(track) {
    this.track = track;
    if (!this.sender) return false;
    try {
      await this.sender.replaceTrack(track);
      this.#tuneSender(this.sender);
      return true;
    } catch (error) {
      return false;
    }
  }

  stop() {
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.close();
      this.pc = null;
    }
    this.sender = null;
    this.stream = null;
    this.track = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
  }

  #tuneSender(sender) {
    if (!sender || typeof sender.getParameters !== 'function') return;
    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }
    parameters.encodings[0].active = true;
    parameters.encodings[0].maxBitrate = this.maxBitrate;
    parameters.encodings[0].scaleResolutionDownBy = 1;
    try {
      parameters.degradationPreference = 'maintain-resolution';
      sender.setParameters(parameters).catch(() => {});
    } catch {
      /* iOS 不支持 setParameters 时忽略 */
    }
  }

  #preferH264(pc) {
    try {
      const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
      for (const transceiver of transceivers) {
        if (transceiver.receiver?.track?.kind !== 'video') continue;
        const capabilities = RTCRtpReceiver.getCapabilities?.('video');
        if (!capabilities?.codecs) continue;
        const preferred = capabilities.codecs.filter((codec) =>
          /h264/i.test(codec.mimeType || '')
        );
        if (preferred.length > 0 && typeof transceiver.setCodecPreferences === 'function') {
          transceiver.setCodecPreferences(preferred);
        }
      }
    } catch {
      /* 不支持时保持浏览器默认协商 */
    }
  }
}
