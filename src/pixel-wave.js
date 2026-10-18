import SiriWave from 'siriwave';

export function createPixelWave(container) {
  const width = 192;
  const height = 76;
  const source = document.createElement('div');
  const makeWave = (amplitude) => new SiriWave({
    container: source,
    style: 'ios9',
    width,
    height,
    ratio: 1,
    amplitude,
    speed: 0.12,
    lerpSpeed: 0.12,
    autostart: true,
    curveDefinition: [
      { color: '255,255,255', supportLine: true },
      { color: '255,255,255' },
      { color: '255,255,255' },
      { color: '255,255,255' },
    ],
  });
  let wave = makeWave(0);
  let sourceContext = source.querySelector('canvas').getContext('2d', { willReadFrequently: true });
  let active = false;
  wave.stop();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const output = canvas.getContext('2d');
  const pixels = output.createImageData(width, height);
  const threshold = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  return {
    setAmplitude(amplitude) {
      if (amplitude > 0.001 && !active) {
        wave.dispose();
        wave = makeWave(amplitude);
        sourceContext = source.querySelector('canvas').getContext('2d', { willReadFrequently: true });
      } else if (amplitude <= 0.001) wave.stop();
      active = amplitude > 0.001;
      wave.setAmplitude(amplitude);
    },
    render() {
      if (!active) { output.clearRect(0, 0, width, height); return; }
      const input = sourceContext.getImageData(0, 0, width, height).data;
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const offset = (row * width + column) * 4;
          const visible = input[offset + 3] > (threshold[(row % 4) * 4 + column % 4] + 0.5) * 16;
          pixels.data[offset] = 255;
          pixels.data[offset + 1] = 255;
          pixels.data[offset + 2] = 255;
          pixels.data[offset + 3] = visible ? 255 : 0;
        }
      }
      output.putImageData(pixels, 0, 0);
    },
    dispose: () => wave.dispose(),
  };
}