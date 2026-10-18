export function createDemoWav(track, duration, sampleRate = 16000) {
  const samples = Math.round(duration * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const pulse = time % 1;
    const envelope = pulse < 0.65 ? Math.sin(Math.PI * pulse / 0.65) ** 2 : 0;
    const volume = track === 2 ? 0.02 + 0.16 * (0.5 + 0.5 * Math.sin(time * Math.PI / 4)) : 0.12;
    const frequency = track === 1 ? (Math.floor(time) % 2 ? 660 : 330) : 440;
    const sample = Math.sin(2 * Math.PI * frequency * time) * envelope * volume;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}