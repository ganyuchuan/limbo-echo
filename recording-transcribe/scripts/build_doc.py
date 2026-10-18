# -*- coding: utf-8 -*-
"""
把逐字稿（[HH:MM:SS.cc] 文本 格式）合并成可读的自然段。

分段规则（三条件满足其一即断段，适配通话/现场两类录音）:
  1. 相邻句间隔超过 --gap 秒（默认 45）→ 新段，并标注静音时长
  2. 跨越切片边界（需提供 --task-json 获得切片 offset）
  3. 段内字数超过 --max-chars（默认 700）

用法:
    python build_doc.py --transcript merged_transcript.md [--task-json task.json] \
      [--gap 45] [--max-chars 700] [--out body.md]
"""
import argparse
import json
import re
from pathlib import Path


def fmt(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:04.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--task-json", default=None)
    ap.add_argument("--gap", type=float, default=45.0)
    ap.add_argument("--max-chars", type=int, default=700)
    ap.add_argument("--out", default="body.md")
    args = ap.parse_args()

    bounds = {}
    if args.task_json:
        task = json.loads(Path(args.task_json).read_text(encoding="utf-8"))
        bounds = {s["file"].split("-")[0]: float(s["offset"]) for s in task["segments"]}

    rows = []
    for line in Path(args.transcript).read_text(encoding="utf-8").splitlines():
        m = re.match(r"\[(\d+):(\d+):(\d+(?:\.\d+)?)\]\s+(.*)", line.strip())
        if m:
            t = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
            text = m[4].strip()
            uid = None
            for u, off in bounds.items():
                if t >= off - 0.5 and (uid is None or off > bounds[uid]):
                    uid = u
            rows.append((t, uid, text))

    blocks = []
    prev_t, prev_uid = None, None
    buf, buf_start, buf_chars = [], None, 0

    def flush():
        nonlocal buf, buf_start, buf_chars
        if buf:
            blocks.append((buf_start, "p", "".join(buf)))
        buf, buf_start, buf_chars = [], None, 0

    for t, uid, text in rows:
        if prev_t is not None and t - prev_t > args.gap:
            flush()
            blocks.append((None, "gap", f"*（此处静音约 {round(t - prev_t)} 秒）*"))
        elif prev_uid is not None and uid != prev_uid:
            flush()
        elif buf_chars >= args.max_chars:
            flush()
        if buf_start is None:
            buf_start = t
        buf.append(text)
        buf_chars += len(text)
        prev_t, prev_uid = t, uid
    flush()

    out = []
    for start, kind, content in blocks:
        if kind == "gap":
            out.append(content)
            out.append("")
        else:
            out.append(f"**[{fmt(start)}]** {content}")
            out.append("")
    Path(args.out).write_text("\n".join(out), encoding="utf-8")
    n = len([b for b in blocks if b[1] == "p"])
    print(f"分段完成: {n} 个自然段 → {args.out}")


if __name__ == "__main__":
    main()
