import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const issues = [];
const demoAudio = new Set(['demo-pulse.wav', 'demo-frequency.wav', 'demo-dynamics.wav']);
const textExtensions = /\.(?:md|js|mjs|json|css|html|py|txt|ya?ml)$/i;

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const name = relative(root, path).replaceAll('\\', '/');
    if (lstatSync(path).isSymbolicLink()) {
      issues.push(`${name}: symbolic link requires manual review`);
      continue;
    }
    if (entry.isDirectory()) {
      if (/^\d{8}$/.test(entry.name) || ['recordings', 'transcripts', 'private', '__pycache__', '.venv', 'venv'].includes(entry.name)) {
        issues.push(`${name}: private data or environment directory`);
      } else scan(path);
      continue;
    }
    const generatedDemo = demoAudio.has(entry.name) && /^(?:public|dist)\/audio\//.test(name);
    if (/\.(?:m4a|wav|mp3|ogg|flac|aac|mp4|webm)$/i.test(entry.name) && !generatedDemo) issues.push(`${name}: non-demo media file`);
    if ((/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') || /\.(?:pem|key|p12)$/i.test(entry.name)) issues.push(`${name}: potential credential file`);
    if (/^(?:task|recording)\.json$/.test(entry.name) || /(?:_transcript|_segments|_stats|-transcript|_整理稿)\.(?:md|json)$/.test(entry.name) || entry.name === 'recording_summary.md') issues.push(`${name}: recording-derived data`);
    if (textExtensions.test(entry.name)) {
      const text = readFileSync(path, 'utf8');
      if (/\/Users\/[^/\s]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\\s]+\\/.test(text)) issues.push(`${name}: personal absolute path`);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push(`${name}: private key material`);
    }
  }
}

scan(root);
if (issues.length) {
  console.error(`Public-release check failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  process.exitCode = 1;
} else console.log('Public-release check passed: no recording artifacts, credential files or personal absolute paths detected. This is not a complete secret scan.');