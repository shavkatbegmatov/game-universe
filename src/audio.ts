export class SpaceAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private enabled = false;

  // Kosmik fon musiqasi oscillator'lari
  private ambientOscs: OscillatorNode[] = [];

  constructor() {
    // AudioContext faqat foydalanuvchi birinchi marta bosganida yaratiladi (autoplay siyosati tufayli)
  }

  private init(): void {
    if (this.ctx) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
      
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.5; // Boshlang'ich ovoz balandligi
      this.masterGain.connect(this.ctx.destination);

      this.ambientGain = this.ctx.createGain();
      this.ambientGain.gain.value = 0.15; // Ambient fon ovozi pastroq bo'ladi
      this.ambientGain.connect(this.masterGain);

      if (this.enabled) {
        this.startAmbient();
      }
    } catch (e) {
      console.warn("Web Audio API yuklanishida xatolik:", e);
    }
  }

  toggle(enable: boolean): void {
    this.enabled = enable;
    if (enable) {
      this.init();
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume();
      }
      this.startAmbient();
    } else {
      this.stopAmbient();
    }
  }

  private startAmbient(): void {
    if (!this.ctx || !this.ambientGain || this.ambientOscs.length > 0) return;

    // Chuqur kosmik ambient tovushini yaratish (3 ta past chastotali oscillator)
    const freqs = [55, 82.4, 110]; // Low A, E, A notes
    freqs.forEach((freq, idx) => {
      if (!this.ctx || !this.ambientGain) return;
      
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = freq;

      // Filter orqali yumshatish
      filter.type = "lowpass";
      filter.frequency.value = 180 + idx * 40;

      // LFO bilan ovozni ohista tebratish (slow drift)
      lfo.frequency.value = 0.05 + idx * 0.03;
      lfoGain.gain.value = 0.08;

      osc.connect(filter);
      filter.connect(this.ambientGain);

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency); // chastotani siljitish

      osc.start();
      lfo.start();

      this.ambientOscs.push(osc);
      // LFO oscillatorlarini ham saqlab qo'yamiz o'chirish uchun
      this.ambientOscs.push(lfo);
    });
  }

  private stopAmbient(): void {
    this.ambientOscs.forEach(osc => {
      try { osc.stop(); } catch (e) {}
    });
    this.ambientOscs = [];
  }

  playCreation(mass: number): void {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    if (this.ctx.state === "suspended") this.ctx.resume();

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "triangle";
    
    // Massa qanchalik katta bo'lsa, chastota shunchalik past bo'ladi
    const startFreq = Math.max(100, 800 - mass * 1.5);
    const endFreq = startFreq * 1.5;

    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.3);

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.5);
  }

  playMerge(): void {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    if (this.ctx.state === "suspended") this.ctx.resume();

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const noise = this.createNoiseBufferNode();
    const noiseFilter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    // Chuqur gumburlash (sine oscillator)
    osc.type = "sine";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.6);

    // To'qnashuv shovqini
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(300, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(50, now + 0.5);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc.connect(gain);
    if (noise) {
      noise.connect(noiseFilter);
      noiseFilter.connect(gain);
      noise.start(now);
      noise.stop(now + 0.8);
    }

    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.8);
  }

  playShatter(): void {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || !this.masterGain) return;
    if (this.ctx.state === "suspended") this.ctx.resume();

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Metalik, parchalanuvchi tovush (FM sintezi analogi)
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(450, now);
    osc.frequency.linearRampToValueAtTime(120, now + 0.4);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(600, now);
    osc2.frequency.linearRampToValueAtTime(1000, now + 0.35);

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc2.start(now);
    osc.stop(now + 0.55);
    osc2.stop(now + 0.55);
  }

  private createNoiseBufferNode(): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    const bufferSize = this.ctx.sampleRate * 1.0;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }
}
