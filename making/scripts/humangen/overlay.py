"""写真に目盛りを重ねた確認用の画像を作る（部位の位置を写真の画素で読み取るため）。
python scripts/humangen/overlay.py <名前> [x0 y0 x1 y1 [倍率 [目盛りの間隔]]]
logs/<名前>_grid[_x0_y0].png に書く。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
REF = os.path.join(ROOT, "refs")
LOG = os.path.join(ROOT, "scripts", "humangen", "logs")


def grid(name, box=None, zoom=1.0, step=50):
    img = Image.open(os.path.join(REF, name + ".png")).convert("RGB")
    x0, y0, x1, y1 = box or (0, 0, img.width, img.height)
    crop = img.crop((x0, y0, x1, y1))
    crop = crop.resize((int(crop.width * zoom), int(crop.height * zoom)), Image.LANCZOS)
    d = ImageDraw.Draw(crop)
    try:
        font = ImageFont.truetype("arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    gx = (x0 // step + (1 if x0 % step else 0)) * step
    while gx < x1:
        px = (gx - x0) * zoom
        major = gx % (step * 2) == 0
        d.line([(px, 0), (px, crop.height)], fill=(255, 255, 0) if major else (255, 255, 255), width=1)
        if major:
            d.text((px + 2, 2), str(gx), fill=(255, 255, 0), font=font)
            d.text((px + 2, crop.height - 16), str(gx), fill=(255, 255, 0), font=font)
        gx += step
    gy = (y0 // step + (1 if y0 % step else 0)) * step
    while gy < y1:
        py = (gy - y0) * zoom
        major = gy % (step * 2) == 0
        d.line([(0, py), (crop.width, py)], fill=(255, 255, 0) if major else (255, 255, 255), width=1)
        if major:
            d.text((2, py + 2), str(gy), fill=(255, 255, 0), font=font)
            d.text((crop.width - 34, py + 2), str(gy), fill=(255, 255, 0), font=font)
        gy += step
    suffix = "" if box is None else "_%d_%d" % (x0, y0)
    out = os.path.join(LOG, name + "_grid" + suffix + ".png")
    crop.save(out)
    print(out, crop.size)


if __name__ == "__main__":
    a = sys.argv[1:]
    name = a[0]
    box = tuple(int(v) for v in a[1:5]) if len(a) >= 5 else None
    zoom = float(a[5]) if len(a) >= 6 else 1.0
    step = int(a[6]) if len(a) >= 7 else 50
    grid(name, box, zoom, step)
