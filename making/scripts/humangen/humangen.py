"""Light real-time person from three photos (the human counterpart of fish-kit's fishgen.py and the bird's birdgen.py).
python scripts/humangen/humangen.py <id> [<id> ...]

Input (refs/): full-length photos of one person standing in an A-pose (arms away from the body, palms forward, feet
apart) on a flat chroma-green backdrop (gen_refs.sh):
  front   facing the camera            -> the outline, the width of everything, the texture of the front half
  back    facing away                  -> the texture of the back half (warped row by row onto the front's outline)
  side    left profile, facing LEFT    -> how deep every part is (front edge and back edge at each height), the
                                          profile of the face, and the texture of the sides of the head and the legs
  head_front / head_side (optional)    -> close-ups; they replace the head's texture at a finer scale

How the shape is made (fish-kit's way, with the depth taken from the profile instead of a single gain):
- outline       = chroma key of the front photo
- thickness     = t = sqrt(h), h solves laplace(h) = -4 inside the outline (a disc becomes a sphere, a strip a rod)
- trunk, legs   = at each height the row is scaled so that its thickest point reaches the profile of the side photo:
                  z = centre(y) +- half_depth(y) * (t / t_max(y)) ^ p
- nose          = the part of the profile that sticks out past a line from the brow to the upper lip is laid on as a
                  narrow ridge instead of across the whole row; eye sockets are small dents
- arms          = round (their own gain), hands flatter, on a centre line read off the side photo
- normals       = from the shape's own formula (F^2 is smooth up to the outline), not from the triangles
- one sheet for the front, one for the back, sharing the outline's vertices

Per vertex (the viewer's vertex shader bends the body with these; no bones, no clips):
  _W0 = (spine, head, arm, elbow)      _W1 = (forearm twist, hand, leg, which leg: 1 = the person's left)
  _W2 = (knee, foot, side-photo weight, jaw)
Node extras 'human': joints and texture maps in model space.
Model space (glTF, metres): +Z = the way the person faces, +Y = up, +X = the person's left. Origin on the floor
between the ankles.
Writes public/<file>.glb and logs/<id>_*.png, prints stats as JSON."""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve
from scipy.spatial import Delaunay

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
REF = os.path.join(ROOT, "refs")
LOG = os.path.join(HERE, "logs")
OUT = os.path.abspath(os.path.join(ROOT, "..", "public"))
os.makedirs(LOG, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
ATLAS = 2048

# Landmarks are photo pixels (x right, y down), read off logs/<photo>_grid*.png (overlay.py).
# In the front photo the image's left is the person's RIGHT.
PEOPLE = {
    "villager_a": dict(
        file="villager_a", name="村人A", height=1.72,
        front="front_c", back="back", side="side", head_front="head_front", head_side="head_side",
        cx=507,
        # head: weight 0 at y0 (collar) .. 1 at y1 (under the jaw); the neck turns about pivot
        neck=dict(y0=303, y1=264, pivot=(508, 284)),
        # arms, image-left first. cut = armpit -> top of the shoulder (the arm is everything outside it);
        # S E W tip = shoulder joint, elbow, wrist, tip of the middle finger
        arms=[dict(cut=((346, 527), (372, 330)), S=(370, 372), E=(280, 566), W=(200, 738), tip=(165, 862)),
              dict(cut=((668, 527), (642, 330)), S=(644, 372), E=(734, 566), W=(814, 738), tip=(849, 862))],
        # spine: weight 0 at y0 (hips) .. 1 at y1 (lower ribs)
        spine=dict(y0=775, y1=600, pivot=(507, 705)),
        # legs: weight 0 at y0 .. 1 at y1 (just above where the legs part); joints image-left, image-right
        hips=dict(y0=735, y1=868, joints=((440, 765), (572, 765)), split=18),
        knees=dict(y=1090, blend=26, x=(403, 600)),
        ankles=dict(y=1395, blend=14, x=(390, 601)),
        face=dict(eyes=((485, 177), (535, 177)), eye_r=(9.5, 4.2), nose=(508, 205), nose_half=12, detail_half=25,
                  mouth=((487, 231), (530, 231)), chin=(508, 268), box=(446, 146, 570, 276),
                  # each ear: a line down the side of the head, from the hair above the ear to the jaw below it.
                  # What is outside the line is the ear: a thin flap, not part of the head's width
                  ears=[((432, 168), (455, 237)), ((585, 168), (562, 237))]),
        # side photo (the person faces LEFT). axis_x = the ankle (model z = 0). arm = the arm's centre line as
        # (y, x) at the shoulder, elbow, wrist and finger tip. nasion / subnasale = where the nose starts and ends
        # on the profile (y). ear = centre of the ear
        # the same height in the two photos: (front y, side y) for the eyes, the tip of the nose, the line of the
        # mouth, under the chin and the top of the collar. The top of the head and the floor are matched by themselves
        match_y=[(177, 180), (206, 207), (231, 233), (268, 268), (298, 300)],
        side_marks=dict(axis_x=523, arm=[(372, 522), (566, 520), (735, 505), (852, 488)],
                        nasion_y=181, subnasale_y=217, ear=(521, 199),
                        # rows of the profile whose detail is kept (brow .. under the chin)
                        face_y=(150, 292),
                        # rows whose fine detail is laid on the middle of the face only (brow .. chin)
                        detail_y=(152, 266)),
        # where the side photo may be used as texture (front-photo y): above head_y1 fully, fading out by head_y0
        # (below that the arm hides the body in the side photo), and again from legs_y0 to legs_y1 downward
        side_use=dict(head_y0=346, head_y1=322, legs_y0=878, legs_y1=908),
        # how square the cross-section is (1 = ellipse, smaller = boxier): head, torso, legs, shoes
        power=dict(head=0.86, torso=0.72, legs=0.95, feet=0.62),
        gain=dict(arm=0.66, hand=0.3),
        # close-ups: the same landmarks in those photos. front: the two eyes, the mouth's middle, top of the hair,
        # bottom of the chin. side: the corner of the eye, the ear's centre, top of the hair, bottom of the chin
        head_marks=dict(front=dict(eyes=((537, 492), (733, 492)), mouth=(634, 712), top=74, chin=852),
                        side=dict(nose_tip=(251, 593), ear=(687, 560), top=56, chin=833, chin_body=268)),
    ),
}


# ---------------- helpers ----------------

def ss(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def to_lin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def bilinear(a, x, y):
    h, w = a.shape[:2]
    x = np.clip(x, 0, w - 1.001); y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = x - x0; fy = y - y0
    if a.ndim == 3:
        fx = fx[..., None]; fy = fy[..., None]
    return ((a[y0, x0] * (1 - fx) + a[y0, x0 + 1] * fx) * (1 - fy)
            + (a[y0 + 1, x0] * (1 - fx) + a[y0 + 1, x0 + 1] * fx) * fy)


def seg_dist(px, py, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / max(dx * dx + dy * dy, 1e-9), 0, 1)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


def fill_from(img, valid):
    """Push colours outward from the valid pixels (fish-kit's skin fill): each pass blurs wider and fills what is
    still empty."""
    out = img * valid[..., None]
    wgt = valid.astype(np.float32)
    for r in (2, 4, 8, 16, 32, 64, 128):
        fb = ndimage.uniform_filter(out, size=(2 * r + 1, 2 * r + 1, 1), mode="nearest")
        wb = ndimage.uniform_filter(wgt, size=2 * r + 1, mode="nearest")
        need = wgt < 0.5
        out = np.where(need[..., None], fb / np.maximum(wb, 1e-5)[..., None], out)
        wgt = np.where(need, (wb > 1e-3).astype(np.float32), wgt)
    return out.astype(np.float32)


def hex_points(x0, y0, x1, y1, s):
    ys = np.arange(y0, y1, s * 0.8660254)
    pts = []
    for j, y in enumerate(ys):
        xs = np.arange(x0 + (s / 2 if j % 2 else 0), x1, s)
        pts.append(np.stack([xs, np.full_like(xs, y)], -1))
    return np.concatenate(pts)


def thin(points, s):
    """keep points at least s apart (first come, first kept)"""
    kept = []
    grid = {}
    for p in points:
        cx, cy = int(p[0] // s), int(p[1] // s)
        ok = True
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for q in grid.get((i, j), ()):
                    if (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < s * s:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                break
        if ok:
            grid.setdefault((cx, cy), []).append(p)
            kept.append(p)
    return np.array(kept)


def load(name):
    return np.asarray(Image.open(os.path.join(REF, name + ".png")).convert("RGB"), np.float32) / 255


def largest(m):
    lab, n = ndimage.label(m)
    if n == 0:
        return m
    return lab == (1 + int(np.argmax(ndimage.sum(m, lab, range(1, n + 1)))))


def figure_mask(src, open_gaps=True):
    """the person against the green backdrop: (mask, key) with key 1 = backdrop"""
    green = src[..., 1] - np.maximum(src[..., 0], src[..., 2])
    border = np.concatenate([green[:12].ravel(), green[-12:].ravel(), green[:, :12].ravel(), green[:, -12:].ravel()])
    key = np.clip(green / float(np.median(border)), 0, 1)
    m = largest(ndimage.gaussian_filter(1 - key, 1.2) > 0.5)
    # small holes are noise; big ones (between an arm and the body) are real
    holes = ndimage.binary_fill_holes(m) & ~m
    lab, n = ndimage.label(holes)
    if n:
        size = ndimage.sum(holes, lab, range(1, n + 1))
        m = m | np.isin(lab, 1 + np.flatnonzero(size < 200))
    if open_gaps:
        # a gap narrower than a few pixels (between the thighs, between fingers) is widened a little, so that the
        # outline's points on its two sides do not crowd each other
        bg = ~m
        disc = ndimage.generate_binary_structure(2, 1)
        narrow = bg & ~ndimage.binary_opening(bg, structure=disc, iterations=4)
        m = m & ~ndimage.binary_dilation(narrow, iterations=2)
    m = largest(ndimage.gaussian_filter(m.astype(np.float32), 1.3) > 0.5)
    return m, key


def clean_rgb(src, mask, key, inset=3):
    """the photo with the green taken out of its edges and its colours pushed outward past the outline"""
    rgb = src.copy()
    rgb[..., 1] = np.where(key > 0.02, np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2])), rgb[..., 1])
    return fill_from(rgb, ndimage.binary_erosion(mask, iterations=inset))


def row_spans(row):
    d = np.diff(np.r_[0, row.astype(np.int8), 0])
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def span_warp(dst, src, min_len=3):
    """For every pixel of the outline dst, the x to read from in a picture whose outline is src (same rows):
    each run of dst in a row is stretched onto the matching run of src. Returns float x per pixel."""
    H, W = dst.shape
    xs = np.arange(W, dtype=np.float32)
    mapx = np.tile(xs, (H, 1))
    for y in range(H):
        ds = [s for s in row_spans(dst[y]) if s[1] - s[0] >= min_len]
        if not ds:
            continue
        sr = [s for s in row_spans(src[y]) if s[1] - s[0] >= min_len]
        if not sr:
            continue
        if len(ds) == len(sr):
            pairs = list(zip(ds, sr))
        else:
            # runs that overlap one another are matched as one group, end to end (one run of trousers in one
            # photo against two legs in the other); a run with nothing over it is left where it is
            pairs = []
            used = set()
            for i, d in enumerate(ds):
                if i in used:
                    continue
                gd, gs = {i}, set()
                grew = True
                while grew:
                    grew = False
                    for j, s_ in enumerate(sr):
                        if j not in gs and any(min(ds[k][1], s_[1]) > max(ds[k][0], s_[0]) for k in gd):
                            gs.add(j); grew = True
                    for k, d_ in enumerate(ds):
                        if k not in gd and any(min(d_[1], sr[j][1]) > max(d_[0], sr[j][0]) for j in gs):
                            gd.add(k); grew = True
                used |= gd
                if gs:
                    pairs.append(((min(ds[k][0] for k in gd), max(ds[k][1] for k in gd)),
                                  (min(sr[j][0] for j in gs), max(sr[j][1] for j in gs))))
        for (d0, d1), (s0, s1) in pairs:
            x = np.arange(d0, d1)
            mapx[y, d0:d1] = s0 + (x - d0 + 0.5) * (s1 - s0) / (d1 - d0) - 0.5
    disp = (mapx - xs) * dst
    wgt = dst.astype(np.float32)
    disp = ndimage.gaussian_filter(disp, (2.5, 0.8)) / np.maximum(ndimage.gaussian_filter(wgt, (2.5, 0.8)), 1e-3)
    return xs + disp * dst


def edge_warp(dst, src, smooth=5.0):
    """Like span_warp, but gentler, for two outlines that nearly agree (a close-up of the head against the same
    head in the full-length photo): each row is stretched as a whole, from its outermost edges only, and how far
    the edges are moved changes smoothly from row to row."""
    H, W = dst.shape
    xs = np.arange(W, dtype=np.float32)

    def edges(m):
        any_ = m.any(1)
        left = np.where(any_, m.argmax(1), 0).astype(float)
        right = np.where(any_, W - m[:, ::-1].argmax(1), 0).astype(float)
        return any_, left, right
    da, dl, dr = edges(dst)
    sa, sl, sr = edges(src)
    both = da & sa
    rows = np.arange(H)
    if not both.any():
        return np.tile(xs, (H, 1))
    shift_l = np.interp(rows, rows[both], (sl - dl)[both])
    shift_r = np.interp(rows, rows[both], (sr - dr)[both])
    shift_l = ndimage.gaussian_filter1d(shift_l, smooth, mode="nearest")
    shift_r = ndimage.gaussian_filter1d(shift_r, smooth, mode="nearest")
    dl = np.where(da, dl, 0.0); dr = np.where(da, dr, float(W))
    t = np.clip((xs[None, :] - dl[:, None]) / np.maximum((dr - dl)[:, None], 1.0), 0, 1)
    return xs[None, :] + shift_l[:, None] * (1 - t) + shift_r[:, None] * t


def affine_image(img, size, a, b, c, d, e, f, resample=Image.BICUBIC):
    """out(x, y) = img(a x + b y + c, d x + e y + f); img is float HxWx3 or HxW"""
    if img.ndim == 2:
        return np.asarray(Image.fromarray(img.astype(np.float32), "F").transform(size, Image.AFFINE, (a, b, c, d, e, f), resample))
    chans = [np.asarray(Image.fromarray(np.ascontiguousarray(img[..., k]), "F").transform(size, Image.AFFINE, (a, b, c, d, e, f), resample)) for k in range(3)]
    return np.stack(chans, -1)


# ---------------- the side photo ----------------

class Side:
    """Left profile: the front and back edge of the body at each height.
    The two photos never agree exactly on heights (the nose a few pixels lower in one than in the other), and a
    profile laid on a face a centimetre too low is plainly wrong. So this photo is first resampled row by row onto
    the front photo's rows, going by the pairs in match_y (and the top of the head and the floor). After that a
    row means the same height in both photos. Across, the photo keeps its own scale."""
    def __init__(self, cfg, height, front_top, front_floor):
        self.cfg = cfg
        raw = load(cfg["side"])
        self.H, self.W = raw.shape[:2]
        mask, _ = figure_mask(raw, open_gaps=False)
        rows = np.flatnonzero(mask.any(1))
        top_r, floor_r = int(rows[0]), int(rows[-1]) + 1
        self.S = height / float(floor_r - top_r)                    # metres per pixel across (z)
        self.SY = height / float(front_floor - front_top)           # metres per row (the front photo's)
        fy = np.array([front_top] + [a for a, _ in cfg["match_y"]] + [front_floor], float)
        sy = np.array([top_r] + [b for _, b in cfg["match_y"]] + [floor_r], float)
        self.to_front = lambda y: np.interp(np.asarray(y, float), sy, fy)
        r = np.interp(np.arange(self.H) + 0.5, fy, sy) - 0.5
        r += np.minimum(np.arange(self.H) + 0.5 - fy[0], 0) + np.maximum(np.arange(self.H) + 0.5 - fy[-1], 0)   # past the ends: row for row
        r = np.clip(r, 0, self.H - 1.001)
        r0 = np.floor(r).astype(int); fr = (r - r0)[:, None, None]
        self.src = (raw[r0] * (1 - fr) + raw[r0 + 1] * fr).astype(np.float32)
        self.mask, self.key = figure_mask(self.src, open_gaps=False)
        self.top, self.floor = int(front_top), int(front_floor)
        # the landmarks, moved onto the new rows
        m = dict(cfg["side_marks"])
        for k in ("nasion_y", "subnasale_y"):
            m[k] = float(self.to_front(m[k]))
        for k in ("face_y", "detail_y"):
            m[k] = tuple(float(v) for v in self.to_front(m[k]))
        m["ear"] = (m["ear"][0], float(self.to_front(m["ear"][1])))
        m["arm"] = [(float(self.to_front(y)), x) for y, x in m["arm"]]
        self.marks = m
        self.axis = float(m["axis_x"])
        any_ = self.mask.any(1)
        front = np.where(any_, self.mask.argmax(1), self.axis).astype(float)                 # leftmost = the front
        back = np.where(any_, self.W - 1 - self.mask[:, ::-1].argmax(1), self.axis).astype(float)
        # the edges of cloth and hair are ragged from row to row, which would show as ribs across the body: they
        # are smoothed well. The face (brow to under the chin) keeps its detail
        rows = np.arange(self.H, dtype=float)
        face = ss(m["face_y"][0] - 8, m["face_y"][0] + 8, rows) * (1 - ss(m["face_y"][1] - 8, m["face_y"][1] + 8, rows))
        soft = ndimage.gaussian_filter1d(front, 11.0)
        self.front_x = soft + (ndimage.gaussian_filter1d(front, 1.3) - soft) * face
        self.back_x = ndimage.gaussian_filter1d(back, 11.0)
        self.rgb = clean_rgb(self.src, self.mask, self.key)
        xs = np.flatnonzero(self.mask.any(0))
        ys = np.flatnonzero(any_)
        self.box = (max(0, int(xs[0]) - 12), max(0, int(ys[0]) - 12), min(self.W, int(xs[-1]) + 13), min(self.H, int(ys[-1]) + 13))

    def y_of(self, Y):
        """model height (m) -> row"""
        return self.floor - np.asarray(Y, float) / self.SY

    def profile(self, Y):
        """(front z, back z) in metres at model heights Y"""
        y = np.clip(self.y_of(Y), self.top, self.floor - 1)
        rows = np.arange(self.H)
        f = np.interp(y, rows, self.front_x); b = np.interp(y, rows, self.back_x)
        return (self.axis - f) * self.S, (self.axis - b) * self.S

    def nose(self, Y):
        """How far the nose sticks out (m) past a straight line from where it starts to where it ends."""
        m = self.marks
        y = self.y_of(Y)
        y0, y1 = m["nasion_y"], m["subnasale_y"]
        rows = np.arange(self.H)
        f = np.interp(y, rows, self.front_x)
        f0, f1 = np.interp(y0, rows, self.front_x), np.interp(y1, rows, self.front_x)
        line = f0 + (f1 - f0) * np.clip((y - y0) / (y1 - y0), 0, 1)
        inside = (y > y0) & (y < y1)
        return np.where(inside, np.maximum(line - f, 0), 0) * self.S

    def arm_z(self, Y):
        m = self.marks["arm"]
        ys = np.array([p[0] for p in m], float); xs = np.array([p[1] for p in m], float)
        return (self.axis - np.interp(self.y_of(Y), ys, xs)) * self.S


# ---------------- the front photo ----------------

class Person:
    def __init__(self, pid):
        self.pid = pid
        self.cfg = c = PEOPLE[pid]
        self.src = load(c["front"])
        self.H, self.W = self.src.shape[:2]
        self.mask, self.key = figure_mask(self.src)
        rows = np.flatnonzero(self.mask.any(1))
        self.top, self.floor = int(rows[0]), int(rows[-1]) + 1
        self.S = c["height"] / float(self.floor - self.top)
        self.cx = float(c["cx"])
        self.dist = ndimage.distance_transform_edt(self.mask)
        # the same, negative outside the outline
        self.sdist = (self.dist - ndimage.distance_transform_edt(~self.mask)).astype(np.float32)
        xs = np.flatnonzero(self.mask.any(0))
        self.box = (max(0, int(xs[0]) - 12), max(0, self.top - 12), min(self.W, int(xs[-1]) + 13), min(self.H, self.floor + 12))
        self.side = Side(c, c["height"], self.top, self.floor)
        # the ears are thin flaps: they are left out of the outline that is blown up into the head
        yy, xx = np.mgrid[0:self.H, 0:self.W]
        ears = np.zeros_like(self.mask)
        for (ax, ay), (bx, by) in c["face"].get("ears", []):
            t = np.clip((yy - ay) / float(by - ay), 0, 1)
            line = ax + (bx - ax) * t
            out = (xx < line) if ax < self.cx else (xx > line)
            ears |= out & (yy >= ay) & (yy <= by)
        self.ears = ears & self.mask
        self.core = largest(self.mask & ~self.ears)
        self.ears = self.mask & ~self.core
        self.dist_core = ndimage.distance_transform_edt(self.core)
        self._inflate()
        self._weights()
        self._depth()
        self._textures()

    # ---- coordinates ----
    def X(self, px):
        return (np.asarray(px, float) - self.cx) * self.S

    def Y(self, py):
        return (self.floor - np.asarray(py, float)) * self.S

    # ---- thickness ----
    def _inflate(self):
        """h with laplace(h) = -4 inside the outline, 0 outside (solved at half resolution)"""
        x0, y0, x1, y1 = self.box
        sub = self.core[y0:y1, x0:x1]
        hh, ww = sub.shape[0] // 2, sub.shape[1] // 2
        small = sub[:hh * 2, :ww * 2].reshape(hh, 2, ww, 2).mean((1, 3)) > 0.5
        idx = -np.ones(small.shape, np.int64)
        n = int(small.sum())
        idx[small] = np.arange(n)
        ys, xs = np.nonzero(small)
        rows, cols, vals = [np.arange(n)], [np.arange(n)], [np.full(n, 4.0)]
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = ys + dy, xs + dx
            ok = (yy >= 0) & (yy < hh) & (xx >= 0) & (xx < ww)
            j = np.where(ok, idx[np.clip(yy, 0, hh - 1), np.clip(xx, 0, ww - 1)], -1)
            keep = j >= 0
            rows.append(np.arange(n)[keep]); cols.append(j[keep]); vals.append(np.full(int(keep.sum()), -1.0))
        A = sparse.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n))
        h = np.zeros(small.shape)
        h[small] = spsolve(A.tocsc(), np.full(n, 4.0)) * 4.0        # x4: half-resolution pixels -> photo pixels squared
        # the same at every photo pixel
        yy, xx = np.mgrid[0:self.H, 0:self.W]
        full = bilinear(h, (xx - x0) / 2 - 0.25, (yy - y0) / 2 - 0.25)
        inside = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
        self.T = (np.sqrt(np.maximum(full, 0)) * inside * (self.dist_core > 0)).astype(np.float32)

    # ---- which part each pixel belongs to ----
    def _weights(self):
        c = self.cfg
        yy, xx = np.mgrid[0:self.H, 0:self.W].astype(np.float32)
        self.yy, self.xx = yy, xx
        m = self.mask
        # arms: cut the outline from the armpit to the top of the shoulder; what falls off is the arm
        cut = Image.fromarray((m * 255).astype(np.uint8))
        d = ImageDraw.Draw(cut)
        segs = []
        for arm in c["arms"]:
            a = np.array(arm["cut"][0], float); b = np.array(arm["cut"][1], float)
            # the armpit itself: the highest backdrop pixel near the mark
            wx0, wx1 = int(a[0] - 30), int(a[0] + 30)
            wy0, wy1 = int(a[1] - 45), int(a[1] + 60)
            bg = ~m[wy0:wy1, wx0:wx1]
            if bg.any():
                r = int(np.flatnonzero(bg.any(1))[0])
                col = np.flatnonzero(bg[r])
                a = np.array([wx0 + col.mean(), wy0 + r], float)
            u = (b - a) / np.hypot(*(b - a))
            a2, b2 = a - u * 4, b + u * 60
            d.line([tuple(a2), tuple(b2)], fill=0, width=3)
            segs.append((a, b + u * 60))
        cutm = np.asarray(cut) > 127
        lab, _ = ndimage.label(cutm)
        sp = c["spine"]["pivot"]
        trunk_id = lab[int(sp[1]), int(sp[0])]
        self.wa = np.zeros((self.H, self.W), np.float32)
        self.arm_of = np.zeros((self.H, self.W), np.int8)               # 1 = image-left arm, 2 = image-right
        self.elbow = np.zeros_like(self.wa); self.twist = np.zeros_like(self.wa); self.hand = np.zeros_like(self.wa)
        for i, (arm, (a, b)) in enumerate(zip(c["arms"], segs)):
            E = np.array(arm["E"], float); S_ = np.array(arm["S"], float); W_ = np.array(arm["W"], float); tip = np.array(arm["tip"], float)
            aid = lab[int(E[1]), int(E[0])]
            if aid == trunk_id or aid == 0:
                raise RuntimeError("arm %d is not cut off from the body: check its 'cut' line" % i)
            A = lab == aid
            dc = seg_dist(xx, yy, a, b)
            w = ss(-34, 34, np.where(A, dc, -dc))
            self.wa = np.maximum(self.wa, w.astype(np.float32))
            self.arm_of[A] = i + 1
            du = (E - S_) / np.hypot(*(E - S_)); df = (W_ - E) / np.hypot(*(W_ - E)); dh = (tip - W_) / np.hypot(*(tip - W_))
            be = du + df; be /= np.hypot(*be)
            self.elbow += (ss(-26, 26, (xx - E[0]) * be[0] + (yy - E[1]) * be[1]) * A).astype(np.float32)
            self.twist += (np.clip(((xx - E[0]) * df[0] + (yy - E[1]) * df[1]) / np.hypot(*(W_ - E)), 0, 1) * A).astype(np.float32)
            bh = df + dh; bh /= np.hypot(*bh)
            self.hand += (ss(-12, 12, (xx - W_[0]) * bh[0] + (yy - W_[1]) * bh[1]) * A).astype(np.float32)
        self.arm_cuts = segs
        nk, sp_, hp, kn, an = c["neck"], c["spine"], c["hips"], c["knees"], c["ankles"]
        body = 1 - self.wa
        self.head = (ss(0, 1, (nk["y0"] - yy) / (nk["y0"] - nk["y1"])) * (self.arm_of == 0)).astype(np.float32)
        self.spine = np.maximum(ss(0, 1, (sp_["y0"] - yy) / (sp_["y0"] - sp_["y1"])), self.wa).astype(np.float32)
        self.leg = (ss(0, 1, (yy - hp["y0"]) / (hp["y1"] - hp["y0"])) * body).astype(np.float32)
        self.leg_side = ss(-hp["split"], hp["split"], xx - self.cx).astype(np.float32)
        self.knee = (ss(-kn["blend"], kn["blend"], yy - kn["y"]) * body).astype(np.float32)
        self.foot = (ss(-an["blend"], an["blend"], yy - an["y"]) * body).astype(np.float32)
        su = c["side_use"]
        self.side_w = (np.maximum(ss(0, 1, (su["head_y0"] - yy) / (su["head_y0"] - su["head_y1"])),
                                  ss(0, 1, (yy - su["legs_y0"]) / (su["legs_y1"] - su["legs_y0"]))) * (self.arm_of == 0)).astype(np.float32)
        # jaw: below the line of the mouth, fading out into the cheeks and the neck
        f = c["face"]
        (mx0, my0), (mx1, my1) = f["mouth"]
        mcx = (mx0 + mx1) / 2
        my = my0 + (my1 - my0) * np.clip((xx - mx0) / (mx1 - mx0), 0, 1)
        half = (mx1 - mx0) / 2
        self.jaw = (ss(1.0, 6.0, yy - my) * (1 - ss(f["chin"][1] - 2, f["chin"][1] + 14, yy))
                    * (1 - ss(half + 6, half + 26, np.abs(xx - mcx))) * self.head).astype(np.float32)

    # ---- how deep it is ----
    def _depth(self):
        c, sd = self.cfg, self.side
        k = 1 / self.S                                             # metres -> front-photo pixels
        rowsY = self.Y(np.arange(self.H) + 0.5)
        zf, zb = sd.profile(rowsY)
        zf, zb = zf * k, zb * k
        nose = sd.nose(rowsY) * k
        # under its tip the nose cuts back almost straight in; the photo has only a line or two of pixels for that
        # face, which would be stretched right across it. Let it slope back instead
        for d_ in range(1, 26):
            nose = np.maximum(nose, np.maximum(np.r_[np.zeros(d_), nose[:-d_]], np.r_[nose[d_:], np.zeros(d_)]) - 1.6 * d_)
        # The face. A row is as deep as the profile says, right across the head, so every bump of the profile
        # (brow, lips, chin) would run round the head as a ridge. Only the broad shape is carried across; the fine
        # detail of the profile is laid on near the middle of the face, like the nose.
        m = sd.marks
        y_s = np.arange(self.H) + 0.5                                # (the side photo is on our rows)
        fw = ss(m["detail_y"][0] - 10, m["detail_y"][0] + 10, y_s) * (1 - ss(m["detail_y"][1] - 6, m["detail_y"][1] + 6, y_s))
        zf0 = zf - nose
        detail = (zf0 - ndimage.gaussian_filter1d(zf0, 13.0)) * fw
        zf_base = zf0 - detail
        centre = (zf_base + zb) / 2
        half = np.maximum((zf_base - zb) / 2, 0)
        trunk = (self.arm_of == 0) & self.mask
        tmax = np.where(trunk.any(1), (self.T * trunk).max(1), 0)
        tmax = np.maximum(ndimage.gaussian_filter1d(tmax, 5.0), 1e-3)
        s = np.clip(self.T / tmax[:, None], 0, 1)
        # how square the cross-section is, by height
        p, nk, hp, an = c["power"], c["neck"], c["hips"], c["ankles"]
        y = np.arange(self.H, dtype=float)
        pw = p["head"] + (p["torso"] - p["head"]) * ss(nk["y1"], nk["y0"] + 30, y)
        pw = pw + (p["legs"] - pw) * ss(hp["y0"], hp["y1"] + 40, y)
        pw = pw + (p["feet"] - pw) * ss(an["y"] - 25, an["y"] + 5, y)
        sp = np.power(np.maximum(s, 1e-6), pw[:, None]) * (s > 0)
        Ft = half[:, None] * sp
        # the nose: a ridge down the middle, narrow at the top and wider at the nostrils
        f = c["face"]
        tn = np.clip((y_s - m["nasion_y"]) / (m["subnasale_y"] - m["nasion_y"]), 0, 1)
        sig = (0.42 + 0.58 * tn ** 1.5) * f["nose_half"]
        dxn = np.abs(self.xx - f["nose"][0])
        relief = nose[:, None] * np.exp(-(dxn / np.maximum(sig[:, None], 1e-3)) ** 2.3)
        # what sticks out (lips, chin, brow) is broad; what is set back (under the nose, under the lip) is only a
        # narrow dip down the middle, or it reads as a groove right across the face
        relief = relief + np.maximum(detail, 0)[:, None] * np.exp(-(dxn / f["detail_half"]) ** 2.2)
        relief = relief + 0.7 * np.minimum(detail, 0)[:, None] * np.exp(-(dxn / (0.45 * f["detail_half"])) ** 2.2)
        # eye sockets
        ea, eb = f["eye_r"]
        for ex, ey in f["eyes"]:
            relief = relief - (0.0045 * k) * np.exp(-((self.xx - ex) / (ea * 1.25)) ** 2 - ((self.yy - ey) / (eb * 2.4)) ** 2)
        relief = relief * self.head * (self.dist > 3)
        # arms and hands: round, on their own centre line
        g = c["gain"]
        Fa = self.T * (g["arm"] + (g["hand"] - g["arm"]) * self.hand)
        Ca = sd.arm_z(rowsY) * k
        wa = self.wa
        inside = self.dist > 0
        # the ears (and the very edge of the head beside them): a flap about a centimetre thick
        flap = np.minimum(self.dist * 0.85, 4.4) * ndimage.gaussian_filter(self.ears.astype(np.float32), 5.0) * 2
        flap = np.minimum(flap, np.minimum(self.dist * 0.85, 4.4))
        self.C = ((1 - wa) * centre[:, None] + wa * Ca[:, None]).astype(np.float32)
        self.Ff = (np.maximum(np.maximum((1 - wa) * (Ft + relief) + wa * Fa, flap), 0) * inside).astype(np.float32)
        self.Fb = (np.maximum((1 - wa) * Ft + wa * Fa, flap) * inside).astype(np.float32)
        self.centre, self.half_depth, self.zf, self.zb = centre, half, zf, zb
        # gradients for the normals (see build)
        Cs = ndimage.gaussian_filter(self.C, 2.0)
        self.Cy, self.Cx = np.gradient(Cs)
        self.Gfy, self.Gfx = np.gradient(ndimage.gaussian_filter(self.Ff ** 2, 1.0))
        self.Gby, self.Gbx = np.gradient(ndimage.gaussian_filter(self.Fb ** 2, 1.0))

    def centre_z(self, py):
        """the middle of the body's depth at a front-photo row (m)"""
        return float(np.interp(py, np.arange(self.H), self.centre) * self.S)

    # ---- textures ----
    def _textures(self):
        c = self.cfg
        self.rgb = clean_rgb(self.src, self.mask, self.key)
        # the back photo, mirrored and brought onto the front photo's outline
        bsrc = load(c["back"])[:, ::-1]
        bmask, bkey = figure_mask(bsrc)
        rows = np.flatnonzero(bmask.any(1))
        top_b, floor_b = int(rows[0]), int(rows[-1]) + 1
        scale = (floor_b - top_b) / float(self.floor - self.top)

        def neck_centre(mask, top, floor):
            ys = np.arange(int(top + 0.12 * (floor - top)), int(top + 0.15 * (floor - top)))
            cs = [np.flatnonzero(mask[y]).mean() for y in ys if mask[y].any()]
            return float(np.mean(cs))
        cxb = neck_centre(bmask, top_b, floor_b)
        cxf = neck_centre(self.mask, self.top, self.floor)
        size = (self.W, self.H)
        # out(x, y) = back(scale (x - cxf) + cxb, scale (y - top) + top_b)
        args = (scale, 0, cxb - scale * cxf, 0, scale, top_b - scale * self.top)
        brgb = clean_rgb(bsrc, bmask, bkey)
        brgb = affine_image(brgb, size, *args)
        bm = affine_image(bmask.astype(np.float32), size, *args, resample=Image.BILINEAR) > 0.5
        mapx = span_warp(self.mask, bm)
        self.back_rgb = bilinear(brgb, mapx, self.yy).astype(np.float32)
        self.back_rgb = fill_from(self.back_rgb, ndimage.binary_erosion(self.mask, iterations=2))
        self.back_mask_aligned = bm
        # eyelid colour: the skin just above the eyes
        f = c["face"]
        lids = []
        for ex, ey in f["eyes"]:
            y0 = int(ey - f["eye_r"][1] * 2.6); y1 = int(ey - f["eye_r"][1] * 1.5)
            lids.append(self.src[y0:y1, int(ex - 6):int(ex + 7)].reshape(-1, 3))
        self.lid = np.median(np.concatenate(lids), 0)
        self._head_closeups()

    def _head_closeups(self):
        """Close-up photos of the head, brought onto the body photos' outlines at a finer scale."""
        c = self.cfg
        hm = c.get("head_marks") or {}
        f = c["face"]
        self.head_front = None
        self.head_side = None
        name = c.get("head_front")
        if name and hm.get("front") and os.path.exists(os.path.join(REF, name + ".png")):
            m = hm["front"]
            src = load(name)
            mask, key = figure_mask(src, open_gaps=False)
            rgb = clean_rgb(src, mask, key)
            # similarity from the two eyes (no rotation: both photos are level)
            (ax, ay), (bx, by) = f["eyes"]
            (px, py), (qx, qy) = m["eyes"]
            s = (qx - px) / float(bx - ax)                          # close-up pixels per body-photo pixel
            ox = (px + qx) / 2 - s * (ax + bx) / 2
            eye_h, eye_b = (py + qy) / 2, (ay + by) / 2
            # heights: the top of the hair, the eyes, the mouth and the chin are made to agree
            body_y = np.array([self.top, eye_b, (f["mouth"][0][1] + f["mouth"][1][1]) / 2, f["chin"][1], f["chin"][1] + 60], float)
            shot_y = np.array([m["top"], eye_h, m["mouth"][1], m["chin"], m["chin"] + 60 * s], float)
            x0, y0 = int(self.cx - 110), self.top - 10
            x1, y1 = int(self.cx + 110), int(c["neck"]["y0"] + 14)
            self.head_front = self._closeup_tile(rgb, mask, (x0, y0, x1, y1), self.mask,
                                                 lambda x: s * x + ox, lambda y: np.interp(y, body_y, shot_y))
        name = c.get("head_side")
        if name and hm.get("side") and os.path.exists(os.path.join(REF, name + ".png")):
            m = hm["side"]
            sd = self.side
            sm = sd.marks
            src = load(name)
            mask, key = figure_mask(src, open_gaps=False)
            rgb = clean_rgb(src, mask, key)
            # similarity from the nose tip and the ear
            rows = np.arange(sd.H)
            ny = (sm["nasion_y"] + sm["subnasale_y"]) / 2
            n0, n1 = int(sm["nasion_y"]), int(sm["subnasale_y"])
            body_tip = (float(sd.front_x[n0:n1].min()), float(n0 + np.argmin(sd.front_x[n0:n1])))
            del rows, ny
            (px, py), (qx, qy) = m["nose_tip"], m["ear"]
            (ax, ay), (bx, by) = body_tip, sm["ear"]
            s = (qx - px) / float(bx - ax)
            ox = px - s * ax
            chin_b = float(sd.to_front(m["chin_body"]))
            body_y = np.array([sd.top, ay, chin_b, chin_b + 60], float)
            shot_y = np.array([m["top"], py, m["chin"], m["chin"] + 60 * s], float)
            y0 = sd.top - 10
            y1 = int(sd.y_of(self.Y(c["neck"]["y0"] + 14)))
            cols = np.flatnonzero(sd.mask[sd.top:y1].any(0))
            x0, x1 = int(cols[0]) - 12, int(cols[-1]) + 13
            self.head_side = self._closeup_tile(rgb, mask, (x0, y0, x1, y1), sd.mask,
                                                lambda x: s * x + ox, lambda y: np.interp(y, body_y, shot_y))

    def _closeup_tile(self, rgb, mask, box, body_mask, fx, fy, K=2.4):
        """rgb (a close-up) resampled over box (body-photo pixels) at K times the body photo's scale, its outline
        stretched row by row onto the body photo's. fx, fy: body-photo x, y -> close-up x, y."""
        x0, y0, x1, y1 = box
        w, h = int((x1 - x0) * K), int((y1 - y0) * K)
        u = x0 + (np.arange(w) + 0.5) / K
        v = y0 + (np.arange(h) + 0.5) / K
        sx = np.tile(fx(u)[None, :], (h, 1)); sy = np.tile(fy(v)[:, None], (1, w))
        shot_m = bilinear(mask.astype(np.float32), sx, sy) > 0.5
        uu = np.tile(u[None, :], (h, 1)); vv = np.tile(v[:, None], (1, w))
        body_m = bilinear(body_mask.astype(np.float32), uu - 0.5, vv - 0.5) > 0.5
        mapx = edge_warp(body_m, shot_m, smooth=5.0 * K)
        # mapx is in tile columns: turn it into close-up x
        cols = np.arange(w)
        sxw = np.interp(mapx.ravel(), cols, fx(u)).reshape(h, w)
        out = bilinear(rgb, sxw, sy).astype(np.float32)
        out = fill_from(out, ndimage.binary_erosion(body_m, iterations=3))
        return dict(rgb=out, box=box, K=K)


# ---------------- atlas ----------------

def make_atlas(P):
    """front | back | side strip on top, the head close-ups below. Returns (image, maps): each map says where a
    body-photo pixel lands in the atlas: u = (x - x0) * k + u0, v = (y - y0) * k + v0 (atlas pixels)."""
    x0, y0, x1, y1 = P.box
    w, h = x1 - x0, y1 - y0
    sx0, sy0, sx1, sy1 = P.side.box
    sw, sh = sx1 - sx0, sy1 - sy0
    img = np.zeros((ATLAS, ATLAS, 3), np.float32)
    if 2 * w + sw > ATLAS or max(h, sh) > ATLAS:
        raise RuntimeError("the photos do not fit the atlas")
    img[0:h, 0:w] = P.rgb[y0:y1, x0:x1]
    img[0:h, w:2 * w] = P.back_rgb[y0:y1, x0:x1]
    img[0:sh, 2 * w:2 * w + sw] = P.side.rgb[sy0:sy1, sx0:sx1]
    maps = dict(front=(x0, y0, 1.0, 0, 0), back=(x0, y0, 1.0, w, 0), side=(sx0, sy0, 1.0, 2 * w, 0))
    row = max(h, sh) + 8
    u = 0
    for key, tile in (("headFront", P.head_front), ("headSide", P.head_side)):
        if tile is None:
            continue
        th, tw = tile["rgb"].shape[:2]
        if row + th > ATLAS or u + tw > ATLAS:
            raise RuntimeError("the head close-ups do not fit the atlas")
        img[row:row + th, u:u + tw] = tile["rgb"]
        bx = tile["box"]
        maps[key] = (bx[0], bx[1], tile["K"], u, row)
        u += tw + 8
    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)), maps


# ---------------- geometry ----------------

def body_points(P):
    """mesh points in photo pixels: the outline, then denser near it (the surface turns fastest there) and on the face"""
    x0, y0, x1, y1 = P.box
    d = P.dist
    m = P.mask
    edge = m & ~ndimage.binary_erosion(m)
    ey, ex = np.nonzero(edge)
    order = np.lexsort((ex, ey // 6))
    rim = thin(np.stack([ex[order], ey[order]], -1).astype(float), 6.5)
    fb = P.cfg["face"]["box"]
    in_face = lambda p: (p[:, 0] > fb[0]) & (p[:, 0] < fb[2]) & (p[:, 1] > fb[1]) & (p[:, 1] < fb[3])
    dd = lambda p: bilinear(d, p[:, 0], p[:, 1])
    hands = lambda p: bilinear(P.hand, p[:, 0], p[:, 1]) > 0.5
    feet = lambda p: bilinear(P.foot, p[:, 0], p[:, 1]) > 0.3
    pts = [rim]
    p = hex_points(x0, y0, x1, y1, 6.5); k = dd(p); pts.append(p[(k >= 2.6) & ((k < 13) | (hands(p) & (k < 30)) | feet(p)) & ~in_face(p)])
    p = hex_points(x0, y0, x1, y1, 13.0); k = dd(p); pts.append(p[(k >= 13) & (k < 39) & ~hands(p) & ~feet(p) & ~in_face(p)])
    p = hex_points(x0, y0, x1, y1, 26.0); k = dd(p); pts.append(p[(k >= 39) & ~in_face(p) & ~feet(p)])
    p = hex_points(fb[0], fb[1], fb[2], fb[3], 3.7); k = dd(p); pts.append(p[k >= 2.6])
    return np.concatenate(pts), len(rim)


def triangulate(points, sdist):
    """Delaunay, keeping the triangles inside the outline. sdist(x, y) = distance to the outline, negative outside.
    A triangle must not bridge a gap between two limbs, so the middle of each edge has to be inside too; but only
    just: where the outline turns a sharp inward corner, an edge between two of its points runs a pixel or two
    outside, and dropping those triangles would leave holes in the skin."""
    tri = Delaunay(points).simplices
    cen = points[tri].mean(1)
    ok = sdist(cen[:, 0], cen[:, 1]) > 0.15
    for i in range(3):
        mid = (points[tri[:, i]] + points[tri[:, (i + 1) % 3]]) / 2
        ok &= sdist(mid[:, 0], mid[:, 1]) > -2.6
    e = points[tri]
    longest = np.max([np.hypot(*(e[:, i] - e[:, (i + 1) % 3]).T) for i in range(3)], 0)
    return tri[ok & (longest < 70)]


def uncovered(P, pts, tri):
    """how many pixels well inside the outline no triangle covers (holes in the skin)"""
    img = Image.new("L", (P.W, P.H), 0)
    d = ImageDraw.Draw(img)
    for f in tri:
        d.polygon([(float(pts[i, 0]), float(pts[i, 1])) for i in f], fill=255)
    cover = np.asarray(img) > 0
    return int((ndimage.binary_erosion(P.mask, iterations=3) & ~cover).sum())


def build(P, maps):
    c = P.cfg
    S = P.S
    pts, n_rim = body_points(P)
    tri = triangulate(pts, lambda x, y: bilinear(P.sdist, x, y))
    used = np.zeros(len(pts), bool); used[tri.ravel()] = True
    remap = -np.ones(len(pts), np.int64); remap[used] = np.arange(int(used.sum()))
    pts, tri = pts[used], remap[tri]
    # The front and back sheets are joined along the edge of the triangulation, wherever that is: a vertex on an
    # edge that only one triangle uses is on the rim (thickness 0, shared by both sheets). Going by which points
    # were sampled from the outline is not enough: where a triangle at an inward corner is dropped, a point from
    # inside ends up on the edge, and the two sheets would gape there.
    e = np.sort(np.vstack([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]), 1)
    ue, cnt = np.unique(e, axis=0, return_counts=True)
    rim = np.zeros(len(pts), bool)
    rim[np.unique(ue[cnt == 1])] = True
    n_inner_on_rim = int((rim & ~(np.arange(len(used))[used] < n_rim)).sum())
    px, py = pts[:, 0], pts[:, 1]
    n = len(pts)
    smp = lambda a: bilinear(a, px, py)
    C = smp(P.C)
    Ff = np.where(rim, 0.0, smp(P.Ff)); Fb = np.where(rim, 0.0, smp(P.Fb))
    X = P.X(px); Y = P.Y(py)
    front = np.stack([X, Y, (C + Ff) * S], -1)
    back = np.stack([X, Y, (C - Fb) * S], -1)
    # Normals from the shape itself: z = C +- F, and F^2 is smooth up to the outline, so the normal is taken along
    # (-(2 F dC/dx + dF^2/dx), 2 F dC/dy + dF^2/dy, 2 F) (photo y runs down). Normals averaged from the triangles
    # show the rows of the mesh as ribs wherever the surface turns away from the camera.
    Cx, Cy = smp(P.Cx), smp(P.Cy)
    nf = np.stack([-(2 * Ff * Cx + smp(P.Gfx)), 2 * Ff * Cy + smp(P.Gfy), 2 * Ff], -1)
    nb = np.stack([2 * Fb * Cx - smp(P.Gbx), -(2 * Fb * Cy - smp(P.Gby)), -2 * Fb], -1)
    nf /= np.maximum(np.linalg.norm(nf, axis=1, keepdims=True), 1e-9)
    nb /= np.maximum(np.linalg.norm(nb, axis=1, keepdims=True), 1e-9)
    inner = np.flatnonzero(~rim)
    mirror = np.arange(n); mirror[inner] = n + np.arange(len(inner))
    pos = np.vstack([front, back[inner]])
    nrm = np.vstack([nf, nb[inner]])
    # winding: the front sheet faces +Z
    fn = np.cross(front[tri[:, 1]] - front[tri[:, 0]], front[tri[:, 2]] - front[tri[:, 0]])
    tri = np.where((fn[:, 2] < 0)[:, None], tri[:, ::-1], tri)
    faces = np.vstack([tri, mirror[tri][:, ::-1]])
    src = np.r_[np.arange(n), inner]
    is_back = np.r_[np.zeros(n), np.ones(len(inner))]
    fx0, fy0, fk, fu, fv = maps["front"]
    uv = np.stack([((px - fx0) * fk + fu) / ATLAS, ((py - fy0) * fk + fv) / ATLAS], -1)[src]
    w0 = np.stack([smp(P.spine), smp(P.head), smp(P.wa), smp(P.elbow)], -1)[src]
    w1 = np.stack([smp(P.twist), smp(P.hand), smp(P.leg), smp(P.leg_side)], -1)[src]
    w2 = np.stack([smp(P.knee), smp(P.foot), smp(P.side_w), smp(P.jaw)], -1)[src]
    w2[:, 3] *= 1 - is_back

    sd = P.side
    def m3(p, z=None):
        x, y = P.X(p[0]), P.Y(p[1])
        return [round(float(x), 5), round(float(y), 5), round(float(P.centre_z(p[1]) if z is None else z), 5)]

    def arm(a):
        out = {}
        for key, name in (("S", "shoulder"), ("E", "elbow"), ("W", "wrist"), ("tip", "tip")):
            out[name] = m3(a[key], float(sd.arm_z(P.Y(a[key][1]))))
        return out

    f = c["face"]
    hp, kn, an, nk, sp = c["hips"], c["knees"], c["ankles"], c["neck"], c["spine"]
    toe_z, heel_z = sd.profile(np.array([0.03]))
    zc = lambda py_: P.centre_z(py_)
    A = float(ATLAS)

    def tex_xy(key):
        """atlas uv = (model x, y) * (su, sv) + (u0, v0) for a tile laid out in front-photo pixels"""
        x0, y0, k, u, v = maps[key]
        return [round(k / S / A, 6), round(-k / S / A, 6), round(((P.cx - x0) * k + u) / A, 6), round(((P.floor - y0) * k + v) / A, 6)]

    def tex_zy(key):
        """atlas uv = (model z, y) * (su, sv) + (u0, v0) for a tile laid out in side-photo pixels"""
        x0, y0, k, u, v = maps[key]
        return [round(-k / sd.S / A, 6), round(-k / sd.SY / A, 6), round(((sd.axis - x0) * k + u) / A, 6), round(((sd.floor - y0) * k + v) / A, 6)]

    ea, eb = f["eye_r"]
    mouth = [(f["mouth"][0][0] + f["mouth"][1][0]) / 2, (f["mouth"][0][1] + f["mouth"][1][1]) / 2]
    ear_z, ear_y = (sd.axis - sd.marks["ear"][0]) * sd.S, (sd.floor - sd.marks["ear"][1]) * sd.SY
    extras = dict(
        id=P.pid, name=c["name"], height=c["height"], scale=round(S, 9),
        neck=m3(nk["pivot"]), spine=m3(sp["pivot"]),
        # the person's right arm is the image-left one
        armR=arm(c["arms"][0]), armL=arm(c["arms"][1]),
        hipR=m3(hp["joints"][0]), hipL=m3(hp["joints"][1]),
        kneeR=m3((kn["x"][0], kn["y"])), kneeL=m3((kn["x"][1], kn["y"])),
        ankleR=m3((an["x"][0], an["y"])), ankleL=m3((an["x"][1], an["y"])),
        toeZ=round(float(toe_z[0]), 5), heelZ=round(float(heel_z[0]), 5),
        eyes=[[round(float(P.X(ex)), 5), round(float(P.Y(ey)), 5)] for ex, ey in f["eyes"]],
        eyeR=[round(ea * S, 5), round(eb * S, 5)],
        lid=[round(float(v), 4) for v in to_lin(P.lid)],
        mouth=[round(float(P.X(mouth[0])), 5), round(float(P.Y(mouth[1])), 5)],
        mouthHalf=round(float((f["mouth"][1][0] - f["mouth"][0][0]) / 2 * S), 5),
        jaw=[0.0, round(float(ear_y) - 0.012, 5), round(float(ear_z) + 0.012, 5)],
        chin=round(float(P.Y(f["chin"][1])), 5),
        crown=round(float(pos[:, 1].max()), 5),
        neckY=[round(float(P.Y(nk["y0"])), 5), round(float(P.Y(nk["y1"])), 5)],
        tex=dict(front=tex_xy("front"), back=tex_xy("back"), side=tex_zy("side"),
                 headFront=tex_xy("headFront") if "headFront" in maps else None,
                 headSide=tex_zy("headSide") if "headSide" in maps else None),
    )
    zc_ = zc
    del zc_
    return dict(pos=pos, nrm=nrm, uv=uv, w0=w0, w1=w1, w2=w2, faces=faces, extras=extras, pts=pts, tri=tri,
                stats=dict(verts=len(pos), tris=len(faces), uncovered_px=uncovered(P, pts, tri), inner_on_rim=n_inner_on_rim))


# ---------------- glb ----------------

def write_glb(path, M, atlas, name, quality=88):
    buf = bytearray()
    views, accessors = [], []

    def add(data, target=None):
        while len(buf) % 4:
            buf.append(0)
        v = dict(buffer=0, byteOffset=len(buf), byteLength=len(data))
        if target:
            v["target"] = target
        buf.extend(data)
        views.append(v)
        return len(views) - 1

    def acc(arr, kind, comp=5126, target=34962, minmax=False):
        a = np.ascontiguousarray(arr, {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[comp])
        d = dict(bufferView=add(a.tobytes(), target), componentType=comp, count=int(a.shape[0]), type=kind)
        if minmax:
            d["min"] = [float(v) for v in a.min(0)]; d["max"] = [float(v) for v in a.max(0)]
        accessors.append(d)
        return len(accessors) - 1

    attrs = dict(POSITION=acc(M["pos"], "VEC3", minmax=True), NORMAL=acc(M["nrm"], "VEC3"), TEXCOORD_0=acc(M["uv"], "VEC2"),
                 _W0=acc(M["w0"], "VEC4"), _W1=acc(M["w1"], "VEC4"), _W2=acc(M["w2"], "VEC4"))
    idx = M["faces"].reshape(-1)
    comp = 5123 if len(M["pos"]) < 65536 else 5125
    ind = acc(idx, "SCALAR", comp, 34963)
    web = io.BytesIO()
    atlas.save(web, "WEBP", quality=quality, method=6)
    img_view = add(web.getvalue())
    gltf = dict(
        asset=dict(version="2.0", generator="humangen.py"),
        extensionsUsed=["EXT_texture_webp"], extensionsRequired=["EXT_texture_webp"],
        scene=0, scenes=[dict(nodes=[0])],
        nodes=[dict(name=name, mesh=0, extras=dict(human=M["extras"]))],
        meshes=[dict(name=name, primitives=[dict(attributes=attrs, indices=ind, material=0)])],
        materials=[dict(name=name, doubleSided=False,
                        pbrMetallicRoughness=dict(baseColorTexture=dict(index=0), roughnessFactor=0.9, metallicFactor=0.0))],
        textures=[dict(sampler=0, extensions=dict(EXT_texture_webp=dict(source=0)))],
        samplers=[dict(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071)],
        images=[dict(bufferView=img_view, mimeType="image/webp")],
        accessors=accessors, bufferViews=views, buffers=[dict(byteLength=0)],
    )
    while len(buf) % 4:
        buf.append(0)
    gltf["buffers"][0]["byteLength"] = len(buf)
    js = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(bytes(buf))


# ---------------- pictures of what the generator understood ----------------

def debug(P, M):
    c = P.cfg
    arr = (P.src * 255).astype(np.uint8).copy()
    edge = P.mask & ~ndimage.binary_erosion(P.mask, iterations=2)
    arr[edge] = (0, 255, 255)
    for w, col in ((P.head, (255, 255, 0)), (P.spine, (255, 0, 255)), (P.leg, (0, 0, 255)), (P.knee, (255, 128, 0)),
                   (P.foot, (255, 128, 0)), (P.wa, (255, 0, 0)), (P.elbow, (255, 255, 255)), (P.hand, (255, 255, 255)),
                   (P.side_w, (0, 255, 0))):
        arr[(np.abs(w - 0.5) < 0.04) & P.mask] = col
    arr[(P.jaw > 0.5)] = (arr[(P.jaw > 0.5)] * 0.5 + np.array([0, 0, 255]) * 0.5).astype(np.uint8)
    img = Image.fromarray(arr)
    d = ImageDraw.Draw(img)
    marks = [("neck", c["neck"]["pivot"]), ("spine", c["spine"]["pivot"])]
    for i, a in enumerate(c["arms"]):
        marks += [("S", a["S"]), ("E", a["E"]), ("W", a["W"]), ("tip", a["tip"])]
        d.line([tuple(a["S"]), tuple(a["E"]), tuple(a["W"]), tuple(a["tip"])], fill=(255, 0, 0), width=2)
        d.line([tuple(P.arm_cuts[i][0]), tuple(P.arm_cuts[i][1])], fill=(255, 255, 255), width=1)
    marks += [("hip", p) for p in c["hips"]["joints"]]
    marks += [("knee", (x, c["knees"]["y"])) for x in c["knees"]["x"]]
    marks += [("ankle", (x, c["ankles"]["y"])) for x in c["ankles"]["x"]]
    for key, p in marks:
        d.ellipse([p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5], outline=(255, 0, 0), width=2)
        d.text((p[0] + 8, p[1] - 6), key, fill=(255, 0, 0))
    f = c["face"]
    for ex, ey in f["eyes"]:
        d.ellipse([ex - f["eye_r"][0], ey - f["eye_r"][1], ex + f["eye_r"][0], ey + f["eye_r"][1]], outline=(0, 255, 0))
    d.line([tuple(f["mouth"][0]), tuple(f["mouth"][1])], fill=(0, 255, 0))
    d.rectangle(f["box"], outline=(0, 128, 255))
    for a_, b_ in f.get("ears", []):
        d.line([tuple(a_), tuple(b_)], fill=(255, 0, 255))
    img.save(os.path.join(LOG, P.pid + "_analysis.png"))
    # the side photo: what was read off it
    sd = P.side
    arr = (sd.src * 255).astype(np.uint8).copy()
    ys = np.arange(sd.box[1] + 12, sd.box[3] - 12)
    arr[ys, np.clip(np.round(sd.front_x[ys]).astype(int), 0, sd.W - 1)] = (255, 0, 0)
    arr[ys, np.clip(np.round(sd.back_x[ys]).astype(int), 0, sd.W - 1)] = (255, 0, 255)
    arr[:, int(sd.axis)] = (255, 255, 255)
    img = Image.fromarray(arr)
    d = ImageDraw.Draw(img)
    m = sd.marks
    d.line([(x, y) for y, x in m["arm"]], fill=(255, 255, 0), width=2)
    for y in (m["nasion_y"], m["subnasale_y"]):
        d.line([(sd.box[0], y), (sd.box[0] + 80, y)], fill=(0, 255, 255))
    img.save(os.path.join(LOG, P.pid + "_side.png"))
    # the back photo on the front's outline (the outline in cyan, the back photo's own outline in red)
    arr = (np.clip(P.back_rgb, 0, 1) * 255).astype(np.uint8).copy()
    arr[edge] = (0, 255, 255)
    be = P.back_mask_aligned & ~ndimage.binary_erosion(P.back_mask_aligned, iterations=1)
    arr[be] = (255, 0, 0)
    Image.fromarray(arr).save(os.path.join(LOG, P.pid + "_back.png"))
    # the shape as a lit relief (front and back), and seen from the side
    x0, y0, x1, y1 = P.box
    lit = []
    light = np.array([-0.45, 0.5, 0.74])
    for G_x, G_y, F, sign in ((P.Gfx, P.Gfy, P.Ff, 1), (P.Gbx, P.Gby, P.Fb, -1)):
        nx = -(2 * F * P.Cx * sign + G_x); ny = (2 * F * P.Cy * sign + G_y); nz = 2 * F
        ln = np.maximum(np.sqrt(nx * nx + ny * ny + nz * nz), 1e-6)
        sh = np.clip((nx * light[0] + ny * light[1] + nz * light[2]) / ln, 0, 1) * 0.85 + 0.15
        lit.append((sh * P.mask * 255).astype(np.uint8)[y0:y1, x0:x1])
    Image.fromarray(np.hstack(lit)).save(os.path.join(LOG, P.pid + "_relief.png"))
    wire = Image.new("RGB", (int(0.7 / P.S), y1 - y0), (20, 20, 24))
    wd = ImageDraw.Draw(wire)
    pos = M["pos"]
    ox = wire.width * 0.55
    for f_ in M["faces"][::2]:
        q = [(ox - pos[i, 2] / P.S, (P.floor - y0) - pos[i, 1] / P.S) for i in f_]
        wd.polygon(q, outline=(120, 200, 255))
    wire.save(os.path.join(LOG, P.pid + "_mesh_side.png"))
    wire = Image.new("RGB", (x1 - x0, y1 - y0), (20, 20, 24))
    wd = ImageDraw.Draw(wire)
    for f_ in M["tri"]:
        wd.polygon([(M["pts"][i, 0] - x0, M["pts"][i, 1] - y0) for i in f_], outline=(120, 200, 255))
    wire.save(os.path.join(LOG, P.pid + "_mesh.png"))


def make(pid):
    P = Person(pid)
    atlas, maps = make_atlas(P)
    M = build(P, maps)
    atlas.save(os.path.join(LOG, pid + "_atlas.png"))
    path = os.path.join(OUT, P.cfg["file"] + ".glb")
    write_glb(path, M, atlas, P.cfg["file"])
    debug(P, M)
    pos = M["pos"]
    stats = dict(id=pid, **M["stats"], atlas=list(atlas.size), glb_kb=round(os.path.getsize(path) / 1024),
                 size_m=[round(float(pos[:, i].max() - pos[:, i].min()), 3) for i in range(3)],
                 rows=dict(front=[P.top, P.floor], side=[P.side.top, P.side.floor]),
                 extras=M["extras"])
    sys.stdout.reconfigure(encoding="utf-8")
    print("HUMANSTATS " + json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    for pid in (sys.argv[1:] or list(PEOPLE)):
        make(pid)
