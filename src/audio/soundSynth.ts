// Procedural Sound Synthesizer via Web Audio API
// Gentle reminder tones; their frequencies have no claimed therapeutic effect.

class SoundSynthesizer {
  private ctx: AudioContext | null = null;
  public enabled: boolean = true;
  public volume: number = 0.8;

  private initCtx() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  private getEffectiveVolume(): number {
    return Math.max(0, Math.min(1, this.volume));
  }

  // Bowl-like reminder tone with harmonics and exponential decay.
  playZenBowl() {
    if (!this.enabled) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const vol = this.getEffectiveVolume();
      const fundamental = 528; // Timbre choice, not a medical intervention.
      const harmonics = [
        { mult: 1, gain: 0.25, decay: 3.5 },
        { mult: 2.76, gain: 0.12, decay: 2.8 },
        { mult: 5.4, gain: 0.05, decay: 1.9 },
      ];

      harmonics.forEach(h => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(fundamental * h.mult, now);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(h.gain * vol, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + h.decay);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch {}
        };

        osc.start(now);
        osc.stop(now + h.decay);
      });
    } catch {
      // Audio autoplay policy fallback
    }
  }

  // Soft rhythmic water droplet chime for countdown / blink cues
  playSoftBeep(frequency = 660) {
    if (!this.enabled) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const vol = this.getEffectiveVolume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, now);
      osc.frequency.exponentialRampToValueAtTime(frequency * 0.85, now + 0.12);

      gain.gain.setValueAtTime(0.1 * vol, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {}
      };

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {
      // Audio fallback
    }
  }

  // Harmonic chord celebration on break completion (Major 9th chord)
  playCompletionChime() {
    if (!this.enabled) return;
    try {
      this.initCtx();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const vol = this.getEffectiveVolume();
      const notes = [523.25, 659.25, 783.99, 987.77, 1046.50]; // C5, E5, G5, B5, C6

      notes.forEach((freq, idx) => {
        if (!this.ctx) return;
        const noteStart = now + idx * 0.09;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, noteStart);

        gain.gain.setValueAtTime(0, noteStart);
        gain.gain.linearRampToValueAtTime(0.15 * vol, noteStart + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 1.8);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch {}
        };

        osc.start(noteStart);
        osc.stop(noteStart + 1.8);
      });
    } catch {
      // Audio fallback
    }
  }
}

export const soundSynth = new SoundSynthesizer();
