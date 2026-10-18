# -*- coding: utf-8 -*-
"""
批量云端转写（火山引擎 · 豆包大模型录音文件识别 · 极速版 flash 通道）

音频以 base64 直接 POST，一次请求返回结果，无需对象存储 / 公网 URL / ffmpeg。
单个 5 分钟 m4a 切片约 1.2MB，远低于接口上限（≤100MB / ≤2h）。

用法:
  python batch_cloud_asr.py --filelist filelist.txt --outdir transcripts \
      [--workers 6] [--lang zh-CN] [--force]

filelist.txt 每行: <uid>\t<音频文件绝对路径>（# 开头为注释）

输出 <outdir>/<uid>.json:
  { "uid":..., "file":..., "text":..., "utterances":[{start,end,text}], "raw": {...} }
  - start/end 已统一换算为秒（接口返回毫秒，见 pitfalls.md）
  - 静音切片（接口返回 20000003）输出 text="" / utterances=[]，不算错误

API Key 读取顺序（不回显明文）:
  1. 环境变量 DOUBAO_API_KEY
  2. 本技能目录 scripts/.env（DOUBAO_API_KEY=...）
"""
import argparse
import base64
import json
import os
import sys
import time
import uuid
from pathlib import Path

import requests

FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
RESOURCE_ID = "volc.seedasr.auc"   # 录音文件识别 2.0 / Seed-ASR
ENV_FILES = [
    Path(__file__).parent / ".env",
]

FMT_MAP = {".m4a": "m4a", ".mp3": "mp3", ".wav": "wav", ".aac": "aac",
           ".ogg": "ogg", ".flac": "flac", ".amr": "amr"}


def load_env_key():
    if os.environ.get("DOUBAO_API_KEY"):
        return os.environ["DOUBAO_API_KEY"]
    for f in ENV_FILES:
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("DOUBAO_API_KEY="):
                    return line.split("=", 1)[1].strip()
    return None


def call_flash(audio_bytes, api_key, fmt, language="zh-CN", timeout=300):
    """调用豆包极速版，返回 (text, utterances_normalized, raw_json)"""
    b64 = base64.b64encode(audio_bytes).decode("ascii")
    headers = {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Api-Sequence": "-1",
        "Content-Type": "application/json",
    }
    audio = {"data": b64}
    if fmt:
        audio["format"] = fmt
    body = {
        "user": {"uid": "workbuddy"},
        "audio": audio,
        "request": {"model_name": "bigmodel", "language": language},
    }
    r = requests.post(FLASH_URL, headers=headers, json=body, timeout=timeout)
    status = r.headers.get("X-Api-Status-Code", "")
    if status == "20000003":          # 无有效语音（静音/纯噪声），视为空结果
        return "", [], r.json() if r.content else {}
    if status != "20000000":
        msg = r.headers.get("X-Api-Message", "") or r.text[:300]
        raise RuntimeError(f"status={status} msg={msg}")
    j = r.json()
    res = j.get("result", {}) or {}
    text = res.get("text", "") or ""
    norm = []
    for u in res.get("utterances", []) or []:
        # 接口返回的 start_time/end_time 一律是毫秒，无条件除 1000
        st = u.get("start_time", u.get("start"))
        et = u.get("end_time", u.get("end"))
        norm.append({
            "start": round(float(st) / 1000.0, 3) if st is not None else None,
            "end": round(float(et) / 1000.0, 3) if et is not None else None,
            "text": (u.get("text") or "").strip(),
        })
    return text, norm, j


def transcode_to_mp3(src_bytes):
    """用 PyAV 把任意音频转 16kHz mp3（接口不接受原格式时的兜底）。"""
    import av
    import io
    inp = av.open(io.BytesIO(src_bytes))
    out_buf = io.BytesIO()
    out = av.open(out_buf, mode="w", format="mp3")
    stream = out.add_stream("mp3", rate=16000)
    stream.bit_rate = 64000
    for frame in inp.decode(inp.streams.audio[0]):
        for pkt in stream.encode(frame):
            out.mux(pkt)
    for pkt in stream.encode(None):
        out.mux(pkt)
    out.close()
    inp.close()
    return out_buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--filelist", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--key", default=None)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--format", default="auto")
    ap.add_argument("--lang", default="zh-CN")
    ap.add_argument("--force", action="store_true", help="重转已有结果（默认跳过）")
    args = ap.parse_args()
    if not args.key:
        args.key = load_env_key()
    if not args.key:
        sys.exit("缺少 API Key：--key 参数 / 环境变量 DOUBAO_API_KEY / 技能 scripts/.env")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    items = []
    for line in Path(args.filelist).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        p = line.split("\t")
        if len(p) >= 2:
            items.append((p[0], p[1]))

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def work(item):
        uid, path = item
        js = outdir / f"{uid}.json"
        if js.exists() and not args.force:
            return (uid, "skip", 0, 0.0)
        t0 = time.time()
        try:
            src = Path(path).read_bytes()
            fmt = None if args.format == "auto" else args.format
            if fmt is None:
                fmt = FMT_MAP.get(Path(path).suffix.lower())
            try:
                text, utts, raw = call_flash(src, args.key, fmt, args.lang)
            except RuntimeError as e:
                if "format" in str(e).lower() or "audio" in str(e).lower():
                    print(f"  [{uid}] 直传失败({e})，转 mp3 重试", flush=True)
                    text, utts, raw = call_flash(transcode_to_mp3(src), args.key, "mp3", args.lang)
                else:
                    raise
            out = {"uid": uid, "file": path, "text": text,
                   "utterances": utts, "raw": raw}
            tmp = js.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(js)
            return (uid, "ok", len(text), time.time() - t0)
        except Exception as e:
            (outdir / f"{uid}.ERROR.txt").write_text(
                f"{type(e).__name__}: {e}", encoding="utf-8")
            return (uid, f"ERR:{type(e).__name__}:{str(e)[:120]}", 0, time.time() - t0)

    print(f"待转写 {len(items)} 个, 并发 {args.workers}", flush=True)
    t0 = time.time()
    done = ok = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, it): it for it in items}
        for f in as_completed(futs):
            uid, status, nchar, el = f.result()
            done += 1
            mark = "✓" if status == "ok" else ("·" if status == "skip" else "✗")
            print(f"[{done}/{len(items)}] {mark} {uid}  "
                  f"{status if status != 'ok' else f'{nchar}字'} {el:.1f}s", flush=True)
            if status == "ok":
                ok += 1
    print(f"\n完成: 成功 {ok}/{len(items)}, 总耗时 {(time.time()-t0)/60:.1f} 分钟", flush=True)


if __name__ == "__main__":
    main()
