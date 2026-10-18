# -*- coding: utf-8 -*-
"""
把批量转写结果按 task.json 的 segment 顺序 + offset 拼回一条完整时间轴。

用法:
  python assemble.py --task-json task.json --transcripts <转写结果目录> \
      --outdir <输出目录> [--prefix merged]

输出:
    <outdir>/<prefix>_transcript.md  逐句 + 绝对时间戳（录音内时间）
    <outdir>/<prefix>_segments.md    按切片分块（便于定位原始文件）
  <outdir>/<prefix>_stats.json  统计与缺失清单
"""
import argparse
import json
import re
from pathlib import Path


def output_prefix(value):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value):
                raise argparse.ArgumentTypeError("prefix must use ASCII letters, digits, hyphens or underscores")
        return value


def fmt(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:05.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task-json", required=True)
    ap.add_argument("--transcripts", required=True)
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--prefix", type=output_prefix, default="merged")
    args = ap.parse_args()

    task = json.loads(Path(args.task_json).read_text(encoding="utf-8"))
    segs = task["segments"]
    tdir = Path(args.transcripts)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    merged = []          # (abs_start, abs_end, text, uid)
    missing = []
    total_chars = 0
    for seg in segs:
        uid = seg["file"].split("-")[0]
        offset = float(seg["offset"])
        js = tdir / f"{uid}.json"
        if not js.exists():
            missing.append((uid, seg["file"], seg["duration"]))
            continue
        data = json.loads(js.read_text(encoding="utf-8"))
        for s in data.get("utterances", []):
            if s.get("start") is None or not s.get("text"):
                continue
            merged.append((offset + s["start"], offset + (s.get("end") or s["start"]),
                           s["text"], uid))
            total_chars += len(s["text"])

    merged.sort(key=lambda x: x[0])
    total_end = max((m[1] for m in merged), default=0.0)
    rec_len = float(segs[-1]["offset"]) + float(segs[-1]["duration"])

    lines = [
        "# 整场录音 · 完整逐字稿",
        "",
        f"- 录音总长: {fmt(rec_len)}",
        f"- 切片数: {len(segs)}   已转写: {len(segs) - len(missing)}   缺: {len(missing)}",
        f"- 转写文本总字数: {total_chars}",
        f"- 格式: [HH:MM:SS.cc] 文本（录音内时间）",
        "",
    ]
    for a, b, t, uid in merged:
        lines.append(f"[{fmt(a)}] {t}")
    (outdir / f"{args.prefix}_transcript.md").write_text("\n".join(lines), encoding="utf-8")

    blocks = ["# 整场录音 · 分片整理稿", ""]
    by_uid = {}
    for a, b, t, uid in merged:
        by_uid.setdefault(uid, []).append((a, t))
    for seg in segs:
        uid = seg["file"].split("-")[0]
        if uid not in by_uid:
            continue
        off = float(seg["offset"])
        blocks.append(f"## [{fmt(off)} — {fmt(off + float(seg['duration']))}]  {uid}")
        blocks.append("")
        blocks.append("".join(t for _, t in by_uid[uid]))
        blocks.append("")
    (outdir / f"{args.prefix}_segments.md").write_text("\n".join(blocks), encoding="utf-8")

    (outdir / f"{args.prefix}_stats.json").write_text(json.dumps({
        "segments_total": len(segs),
        "transcribed": len(segs) - len(missing),
        "missing": [{"uid": u, "file": f, "duration": d} for u, f, d in missing],
        "markers": task.get("markers", []),
        "total_chars": total_chars,
        "recording_len_sec": rec_len,
        "merged_end_sec": total_end,
        "merged_utterances": len(merged),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"合并完成: {len(merged)} 句, 覆盖至 {fmt(total_end)}, 字数 {total_chars}")
    print(f"缺转写文件 {len(missing)} 个: {[m[0] for m in missing]}")


if __name__ == "__main__":
    main()
