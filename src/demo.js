export const chapters = [
  { id: 'pulse', start: 0, end: 20, title: '脉冲序列', tag: 'PULSE SEQUENCE', icon: 'audio-lines', location: 'SYNTHETIC / 01', description: '规律的音符与短暂的留白。', bullets: ['440 Hz 合成音', '每次脉冲后留出静音间隔'] },
  { id: 'frequency', start: 20, end: 40, title: '频率切换', tag: 'FREQUENCY SHIFT', icon: 'headphones', location: 'SYNTHETIC / 02', description: '两个频率交替，组成简单的声音序列。', bullets: ['330 Hz 与 660 Hz 交替', '所有声音均由程序生成'] },
  { id: 'dynamics', start: 40, end: 60, title: '强弱对照', tag: 'DYNAMIC RANGE', icon: 'volume-2', location: 'SYNTHETIC / 03', description: '轻响与强音之间，声纹逐渐起伏。', bullets: ['音量周期性变化', '本示例不包含真实人声或录音'] },
];

export const demo = {
  id: 'synthetic-demo',
  title: '演示档案',
  duration: 60,
  markers: [2, 12, 24, 44, 54],
  segments: [
    { file: 'demo-pulse.wav', offset: 0, duration: 20 },
    { file: 'demo-frequency.wav', offset: 20, duration: 20 },
    { file: 'demo-dynamics.wav', offset: 40, duration: 20 },
  ],
  transcript: [
    { time: 0, text: '[示例文本] 规律的合成音开始。' },
    { time: 8, text: '[示例文本] 音符之间保留短暂静音。' },
    { time: 20, text: '[示例文本] 两个不同频率开始交替。' },
    { time: 30, text: '[示例文本] 频率序列继续。' },
    { time: 40, text: '[示例文本] 声音由轻到响，再逐渐回落。' },
    { time: 52, text: '[示例文本] 所有音频和文字均为虚构演示内容。' },
  ],
};