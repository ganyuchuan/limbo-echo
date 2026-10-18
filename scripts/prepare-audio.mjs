import { mkdirSync, writeFileSync } from 'node:fs';
import { demo } from '../src/demo.js';
import { createDemoWav } from './demo-audio.mjs';

const outputDirectory = new URL('../public/audio/', import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
demo.segments.forEach((segment, index) => {
  writeFileSync(new URL(segment.file, outputDirectory), createDemoWav(index, segment.duration));
});
console.log(`Synthetic demo ready: ${demo.segments.length} generated WAV files. No recordings used.`);