"""Codex が作った画像を refs/ へ写す（Codex 側のシェルは動かないので、保存はこちらでする）。fish-kit の recover_refs.py と同じ。
ログ（scripts/humangen/logs/ref_<名前>.log）に書かれた generated_images の PNG の場所から写す。
python scripts/humangen/recover_refs.py
"""
import glob
import os
import re
import shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
LOG = os.path.join(ROOT, "scripts/humangen/logs")
OUT = os.path.join(ROOT, "refs")

for log in sorted(glob.glob(os.path.join(LOG, "ref_*.log"))):
    name = os.path.basename(log)[4:-4]
    dst = os.path.join(OUT, name + ".png")
    if os.path.exists(dst):
        continue
    text = open(log, encoding="utf-8", errors="replace").read()
    found = [p for p in re.findall(r"[A-Za-z]:[\\/][^\s\)\]\"'`]*generated_images[^\s\)\]\"'`]*\.png", text) if os.path.exists(p)]
    # 場所が書かれていなければ、その回（session id）の generated_images の中のいちばん新しい PNG
    sid = re.search(r"session id: ([0-9a-f-]+)", text)
    if not found and sid:
        found = sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".codex/generated_images", sid.group(1), "*.png")), key=os.path.getmtime)
    if found:
        shutil.copy(found[-1], dst)
        print("recovered", dst, "<-", found[-1])
