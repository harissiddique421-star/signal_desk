let ctx: AudioContext | null = null;

/** Must be called from a user gesture (the sound toggle) so browsers allow audio. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

/** Two short tones: rising for CALL, falling for PUT. */
export function playSignalTone(decision: "CALL" | "PUT") {
  if (!ctx) return;
  const freqs = decision === "CALL" ? [660, 880] : [660, 440];
  const t0 = ctx.currentTime;
  freqs.forEach((f, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + i * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.14);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t0 + i * 0.16);
    osc.stop(t0 + i * 0.16 + 0.15);
  });
}
