/**
 * Plays the camera's 8 kHz mono audio through Web Audio with a small jitter
 * buffer. Browsers only allow audio after a user gesture, so enable() must
 * be called from a click handler.
 */
export class PcmPlayer {
  private ctx: AudioContext | undefined;
  private gain: GainNode | undefined;
  private nextTime = 0;
  private volume = 1;

  constructor(private sampleRate = 8000) {}

  get enabled(): boolean {
    return this.ctx !== undefined && this.ctx.state !== 'closed';
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
  }

  async enable(): Promise<void> {
    if (this.enabled) {
      await this.ctx!.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    gain.connect(ctx.destination);
    this.ctx = ctx;
    this.gain = gain;
    this.nextTime = 0;
    await ctx.resume();
  }

  disable(): void {
    void this.ctx?.close();
    this.ctx = undefined;
    this.gain = undefined;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }

  push(samples: Float32Array): void {
    const ctx = this.ctx;
    if (!ctx || !this.gain || ctx.state !== 'running' || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = ctx.currentTime;
    // Too close (underrun) or too far behind live (backlog): restart the buffer.
    if (this.nextTime < now + 0.02 || this.nextTime > now + 0.8) this.nextTime = now + 0.15;
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }
}
