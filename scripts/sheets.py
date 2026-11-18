"""Puts the pictures of output/capture/ side by side, one sheet per group (output/sheet-<group>.png).
python scripts/sheets.py [group ...] [--cols N] [--scale S]
A group is the file name up to the last '-': shape-rest-000.png .. shape-rest-315.png -> sheet-shape-rest.png"""
import glob
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CAP = os.path.join(ROOT, "output", "capture")
args = sys.argv[1:]
cols, scale = 4, 0.6
if "--cols" in args:
    i = args.index("--cols"); cols = int(args[i + 1]); del args[i:i + 2]
if "--scale" in args:
    i = args.index("--scale"); scale = float(args[i + 1]); del args[i:i + 2]
groups = {}
for f in sorted(glob.glob(os.path.join(CAP, "*.png"))):
    name = os.path.basename(f)[:-4]
    g = name.rsplit("-", 1)[0] if "-" in name else name
    groups.setdefault(g, []).append(f)
for g, files in groups.items():
    if args and not any(g == a or g.startswith(a + "-") for a in args):
        continue
    ims = [Image.open(f).convert("RGB") for f in files]
    w, h = int(ims[0].width * scale), int(ims[0].height * scale)
    n = len(ims)
    c = min(cols, n)
    rows = (n + c - 1) // c
    sheet = Image.new("RGB", (c * w, rows * h), (30, 30, 30))
    for k, im in enumerate(ims):
        sheet.paste(im.resize((w, h), Image.LANCZOS), ((k % c) * w, (k // c) * h))
    out = os.path.join(ROOT, "output", "sheet-" + g + ".png")
    sheet.save(out)
    print(out, sheet.size)
