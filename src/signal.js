export function createSignalEnvelope() {
  let peak = 0.025;
  let amplitude = 0;
  let previousTime;

  return (rms, playing, now) => {
    const elapsed = previousTime === undefined ? 1 / 60 : Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    if (!playing) {
      peak = 0.025;
      amplitude = 0;
      return 0;
    }
    peak = Math.max(0.025, rms, peak * Math.exp(-elapsed / 2));
    const gated = Math.max(0, rms - 0.002);
    const normalized = Math.min(1, gated / peak);
    const target = normalized ** 0.65 * 1.8;
    const response = target > amplitude ? 0.035 : 0.16;
    amplitude += (target - amplitude) * (1 - Math.exp(-elapsed / response));
    return amplitude;
  };
}