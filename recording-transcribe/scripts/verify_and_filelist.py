# -*- coding: utf-8 -*-
"""
体检并生成转写清单：校验完整性、还原切片顺序、剔除空文件。

切片文件名是随机 UUID，字母序 ≠ 录音顺序。顺序来源优先级：
  1. task.json 的 segments（含官方 offset + sha256，最可靠）
  2. m4a 头部 mvhd 的创建时间戳（无 task.json 时的兜底）

用法:
  python verify_and_filelist.py --dir <音频目录> [--task-json <task.json>] \
      [--out filelist.txt] [--uids-file <仅包含这些uid的文件>]

输出 filelist: 每行 <uid>\t<绝对路径>，按录音顺序排列。
同时打印体检报告（sha256 校验、空文件、缺失文件、时间轴覆盖情况）。
"""
import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

EPOCH_1904 = 2082844800  # MP4 时间基准 1904-01-01


def mvhd_info(path):
    """解析 m4a 头部，返回 (创建时间 epoch 秒, 时长秒)；失败返回 None。"""
    try:
        with open(path, "rb") as f:
            data = f.read(4096)
        i = data.find(b"mvhd")
        if i < 0:
            return None
        ver = data[i + 4]
        if ver == 0:
            ct = struct.unpack(">I", data[i + 8:i + 12])[0]
            ts, d = struct.unpack(">II", data[i + 16:i + 24])
        else:
            ct = struct.unpack(">Q", data[i + 8:i + 16])[0]
            ts, d = struct.unpack(">IQ", data[i + 24:i + 36])
        return (ct - EPOCH_1904 if ct else 0, d / ts if ts else 0.0)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="音频文件目录")
    ap.add_argument("--task-json", default=None, help="App 导出的 task.json（推荐提供）")
    ap.add_argument("--out", default="filelist.txt")
    ap.add_argument("--uids-file", default=None,
                    help="可选：仅处理这些 uid（每行一个或空格分隔），用于只处理用户附上的子集")
    args = ap.parse_args()

    only_uids = None
    if args.uids_file:
        raw = Path(args.uids_file).read_text(encoding="utf-8")
        only_uids = set(raw.split())

    seg_map = {}       # uid -> (offset, duration, sha256)
    task = None
    if args.task_json and Path(args.task_json).exists():
        task = json.loads(Path(args.task_json).read_text(encoding="utf-8"))
        for s in task.get("segments", []):
            uid = s["file"].split("-")[0]
            seg_map[uid] = (float(s["offset"]), float(s["duration"]),
                            s.get("sha256"), s["file"])

    rows = []
    for p in sorted(Path(args.dir).glob("*.m4a")):
        uid = p.name.split("-")[0]
        if only_uids and uid not in only_uids:
            continue
        info = mvhd_info(str(p))
        if uid in seg_map:
            off, dur_tj, sha, fname = seg_map[uid]
            if not p.name == fname:
                p2 = p.parent / fname
                if p2.exists():
                    p = p2
            rows.append((off, dur_tj, sha, uid, str(p)))
        elif info:
            ct, dur = info
            rows.append((ct, dur, None, uid, str(p)))

    rows.sort(key=lambda r: r[0])
    print(f"共发现 {len(rows)} 个切片" + (f"（task.json 共 {len(seg_map)} 段）" if seg_map else ""))

    good, empty, bad_sha = [], [], []
    for off, dur, sha, uid, p in rows:
        if dur < 1.0:
            empty.append((uid, round(dur, 2)))
            continue
        if sha:
            h = hashlib.sha256(Path(p).read_bytes()).hexdigest()
            if h != sha:
                bad_sha.append(uid)
                continue
        good.append((uid, p))

    lines = [f"{uid}\t{p}" for uid, p in good]
    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"有效切片 {len(good)} 个 → 已写入 {args.out}")
    if empty:
        print(f"空文件（时长<1s，已跳过）{len(empty)} 个: {[e[0] for e in empty]}")
    if bad_sha:
        print(f"⚠️ sha256 不匹配 {len(bad_sha)} 个: {bad_sha}（已排除，请重新导出）")
    if task:
        if task.get("markers"):
            print(f"书签 markers: {[round(m, 1) for m in task['markers']]}（秒，录音内时间）")
        on_disk = {p.name.split("-")[0] for p in Path(args.dir).glob("*.m4a")}
        missing = [u for u in seg_map if u not in on_disk]
        if missing:
            print(f"⚠️ task.json 中 {len(missing)} 段在目录里不存在（若非用户有意裁剪，检查附件上限）: {missing[:8]}")
    if good:
        import datetime
        t0 = rows[0][0] if task is None else None
        if t0:
            print(f"录制开始(墙钟): {datetime.datetime.fromtimestamp(t0).strftime('%Y-%m-%d %H:%M:%S')}")


if __name__ == "__main__":
    main()
