# -*- coding: utf-8 -*-
"""计算音频的音量分布，判断哪些片段是静音。"""
import sys
from pathlib import Path

import av
import numpy as np

TARGET_SR = 16000


def decode(path):
    container = av.open(path)
    stream = container.streams.audio[0]
    from av.audio.resampler import AudioResampler
    rs = AudioResampler(format="s16", layout="mono", rate=TARGET_SR)
    chunks = []
    for frame in container.decode(stream):
        for of in rs.resample(frame):
            arr = of.to_ndarray()
            if arr.ndim == 2:
                arr = arr.mean(axis=0)
            chunks.append(arr.reshape(-1).astype(np.float32) / 32768.0)
    for of in rs.resample(None):
        arr = of.to_ndarray()
        if arr.ndim == 2:
            arr = arr.mean(axis=0)
        chunks.append(arr.reshape(-1).astype(np.float32) / 32768.0)
    container.close()
    return np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)


for p in sys.argv[1:]:
    y = decode(p)
    dur = len(y) / TARGET_SR
    win = TARGET_SR  # 1 秒
    n = len(y) // win
    rms = np.array([np.sqrt(np.mean(y[i * win:(i + 1) * win] ** 2)) for i in range(n)])
    rms_db = 20 * np.log10(np.maximum(rms, 1e-6))
    # 语音活跃占比：阈值 -45 dBFS
    active = (rms_db > -45).mean() * 100
    print(f"\n== {Path(p).name}  时长 {dur:.1f}s")
    print(f"   整体 RMS: {20*np.log10(max(float(np.sqrt(np.mean(y**2))),1e-6)):.1f} dBFS")
    print(f"   峰值:     {20*np.log10(max(float(np.abs(y).max()),1e-6)):.1f} dBFS")
    print(f"   有声占比(>-45dBFS): {active:.1f}%")
    print(f"   逐秒 RMS 概览(每 10 秒一个点):")
    step = 10
    line = []
    for i in range(0, n, step):
        seg = rms_db[i:i + step]
        line.append(f"{i//60:02d}:{i%60:02d}={seg.mean():5.1f}")
    for i in range(0, len(line), 6):
        print("     " + "  ".join(line[i:i + 6]))
