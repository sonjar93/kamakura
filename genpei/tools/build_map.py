# -*- coding: utf-8 -*-
"""
白地図から (1) 陸=緑・海=青の基図、(2) 令制国の領域ラスタ（勢力範囲の塗り分け用）、
(3) 緯度経度→地図座標の変換式 を作る。
入力：つなぐ白地図「旧国名日本地図」（境界線のみ版） 3368x4768
出力：web/basemap.png（高解像度）, web/provinces.png（国番号ラスタ）, data/map_meta.json
地図座標系（シナリオの x,y）は 元画像を (100,1650) で切り抜き 0.55 倍した 1402x1292。
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/9bf471b0-image.png'
OX, OY, S = 100, 1650, 0.55
W0, H0 = 2550, 2350               # 切り抜き（元解像度）
scn = json.load(open(os.path.join(ROOT, 'data/scenario_1180.json'), encoding='utf-8'))

g = np.array(Image.open(SRC).convert('L'))[OY:OY + H0, OX:OX + W0].astype(np.int16)
coast = g < 110                     # 海岸線・大陸の線（黒〜濃灰）
dashed = (g >= 110) & (g < 200)     # 国境の破線（中間灰）
# 挿入図の枠など（地図座標で右上・右下）を消す
yy, xx = np.mgrid[0:H0, 0:W0]
frame = ((xx * S > 1372) & (yy * S < 400)) | ((yy * S) > (1292 - (xx * S - 1100) * (307 / 302)) )
coast &= ~frame; dashed &= ~frame

# ---- 海：海岸線で囲まれていない白地を外側から塗る
GAP = int(os.environ.get('GAP', '3'))
free = ~ndi.binary_dilation(coast, iterations=GAP)
lab, n = ndi.label(free)
sea_ids = set()
for sx, sy in [(1300, 2200), (300, 1600), (2400, 2300), (1200, 300), (2500, 1200), (900, 1300)]:
    sea_ids.add(lab[sy, sx])
sea_ids.discard(0)
sea = np.isin(lab, list(sea_ids))
sea = (ndi.binary_dilation(sea, iterations=GAP + 1) & ~coast) | sea
sea &= ~((~sea) & False)
land = ~sea

# ---- 緯度経度→地図座標（岬の位置から多項式を当てはめる）
def extreme(win, mode):
    x0, y0, x1, y1 = [int(v / S) for v in win]
    sub = land[y0:y1, x0:x1] & ~coast[y0:y1, x0:x1] | coast[y0:y1, x0:x1]
    ys, xs = np.nonzero(sub & land[y0:y1, x0:x1])
    if not len(xs): return None
    i = {'S': np.argmax(ys), 'N': np.argmin(ys), 'E': np.argmax(xs), 'W': np.argmin(xs)}[mode]
    return ((xs[i] + x0) * S, (ys[i] + y0) * S)
CAPES = [  # (名称, 緯度, 経度, 探索窓[地図座標], 方向)
 ('潮岬', 33.43, 135.76, (680, 950, 760, 1010), 'S'), ('室戸岬', 33.25, 134.18, (520, 960, 590, 1030), 'S'),
 ('佐多岬', 30.99, 130.66, (200, 1220, 260, 1292), 'S'),
 ('野島崎', 34.90, 139.89, (1080, 790, 1130, 850), 'S'), ('犬吠埼', 35.70, 140.87, (1150, 690, 1230, 760), 'E'),
 ('石廊崎', 34.60, 138.84, (980, 830, 1030, 880), 'S'), ('御前崎', 34.60, 138.22, (920, 800, 980, 860), 'S'),
 ('禄剛埼', 37.53, 137.33, (830, 500, 880, 560), 'N'), ('魹ヶ埼', 39.55, 142.07, (1260, 240, 1320, 330), 'E'),
 ('大王崎', 34.28, 136.90, (790, 870, 840, 920), 'S'), ('野母崎', 32.58, 129.75, (110, 1090, 170, 1160), 'S'),
 ('龍飛崎', 41.25, 140.35, (1100, 25, 1150, 120), 'N'),
]
pts = []
for nm, la, lo, win, md in CAPES:
    p = extreme(win, md)
    if p: pts.append((nm, la, lo, p[0], p[1]))
A = np.array([[1, lo, la, lo * lo, la * la, lo * la] for _, la, lo, _, _ in pts])
bx = np.linalg.lstsq(A, np.array([p[3] for p in pts]), rcond=None)[0]
by = np.linalg.lstsq(A, np.array([p[4] for p in pts]), rcond=None)[0]
def ll2xy(la, lo):
    v = np.array([1, lo, la, lo * lo, la * la, lo * la]); return float(v @ bx), float(v @ by)
res = [np.hypot(*(np.array(ll2xy(la, lo)) - np.array([x, y]))) for _, la, lo, x, y in pts]
for (nm, *_), r in zip(pts, res): print('  %s %.1f' % (nm, r))
print('capes', len(pts), 'residual px mean %.1f max %.1f' % (np.mean(res), np.max(res)))

# 湖を水面に
for la, lo, r in [(35.25, 136.08, 2), (36.03, 140.40, 1), (34.75, 137.60, 1), (35.45, 132.95, 1), (37.48, 140.10, 1), (40.46, 140.88, 1)]:
    x, y = ll2xy(la, lo); px, py = int(x / S), int(y / S)
    if 0 <= px < W0 and 0 <= py < H0 and land[py, px] and not coast[py, px]:
        l2, _ = ndi.label(~(coast | ndi.binary_dilation(dashed, iterations=0) & False))
        comp = l2 == l2[py, px]
        if comp.sum() < 40000: land &= ~comp; sea |= comp

# ---- 国の領域：海岸線＋太らせた破線を壁として連結成分に分け、国の代表点で名付ける
walls = coast | ndi.binary_dilation(dashed, iterations=4)
cells, nc = ndi.label(land & ~walls)
# 代表点：1180年の国＋明治の分割国（陸奥・出羽の細分）を 1180年の国に対応づけ
RAW = {p['id']: (p['x'] / S, p['y'] / S) for p in scn['provinces']}
HELP = {'mutsu': [(2355, 2141), (2304, 2369), (2242, 2670), (2076, 2636), (2274, 1900)], 'dewa': [(2192, 2134), (2150, 2408)]}
seeds = []
for pid, (x, y) in RAW.items(): seeds.append((pid, x, y))
for pid, lst in HELP.items():
    for (x, y) in lst: seeds.append((pid, x - OX, y - OY))
ids = [p['id'] for p in scn['provinces']]
cell_owner = {}
for pid, x, y in seeds:
    xi, yi = int(x), int(y)
    # 代表点が線上にあれば近くのセルを探す
    best = None
    for r in range(0, 30, 2):
        win = cells[max(0, yi - r):yi + r + 1, max(0, xi - r):xi + r + 1]
        v = win[win > 0]
        if len(v): best = np.bincount(v).argmax(); break
    if best: cell_owner.setdefault(best, set()).add(pid)
# セルごとに：代表点を含むならその国（複数なら最近点で分割）、含まないなら最寄りの代表点
sx = np.array([s[1] for s in seeds]); sy = np.array([s[2] for s in seeds]); sp = [s[0] for s in seeds]
prov = np.zeros((H0, W0), np.uint8)
excluded = np.zeros((H0, W0), bool)
objs = ndi.find_objects(cells)
for ci, sl in enumerate(objs, start=1):
    if sl is None: continue
    m = cells[sl] == ci
    ys, xs = np.nonzero(m); ys = ys + sl[0].start; xs = xs + sl[1].start
    touches = sl[0].start == 0 or sl[1].start == 0 or sl[1].stop >= W0 - 1
    owners = cell_owner.get(ci)
    if touches and owners is None: excluded[ys, xs] = True; continue   # 大陸・北海道（1180年の国外）
    cand = [i for i, p in enumerate(sp) if (owners is None or p in owners)]
    cx, cy = sx[cand], sy[cand]
    if owners is None:  # 島など：重心から最寄り（遠すぎれば国外）
        mx, my = xs.mean(), ys.mean(); d = np.hypot(cx - mx, cy - my); k = cand[int(np.argmin(d))]
        if d.min() * S > 160: excluded[ys, xs] = True; continue
        prov[ys, xs] = ids.index(sp[k]) + 1
    elif len(owners) == 1:
        prov[ys, xs] = ids.index(next(iter(owners))) + 1
    else:
        d = (xs[:, None] - cx[None, :]) ** 2 + (ys[:, None] - cy[None, :]) ** 2
        k = np.array(cand)[np.argmin(d, axis=1)]
        prov[ys, xs] = np.array([ids.index(sp[j]) + 1 for j in k])
# 壁（線）上の画素は隣接する国で埋める
idx = ndi.distance_transform_edt(prov == 0, return_distances=False, return_indices=True)
filled = prov[idx[0], idx[1]]
filled[~land] = 0
ex = ndi.binary_dilation(excluded, iterations=4) & land
# 国外セルに接する線の画素も国外に
idx2 = ndi.distance_transform_edt(~excluded, return_distances=True)
filled[(idx2 < 6) & ~(prov > 0)] = 0
filled[excluded] = 0
prov = filled

# ---- 出力：基図（陸=緑、海=青、線は濃い色）
col = np.zeros((H0, W0, 3), np.uint8)
col[sea] = (157, 197, 224)
col[land] = (196, 220, 164)
outside = land & (prov == 0)
col[outside] = (205, 214, 190)                    # 国外の陸（大陸・北海道）はくすんだ緑
# 線はベクトルで描くため、基図は陸と海の色だけにする（海岸線・明治の国境破線は描かない）
col[coast & land] = (196, 220, 164)
np.save(os.path.join(ROOT, 'tools/.cache/landmask.npy'), land & ~excluded | outside)
Image.fromarray(col).quantize(32, method=Image.Quantize.MEDIANCUT).save(os.path.join(ROOT, 'web/basemap.png'), optimize=True)
# 国番号ラスタ（地図座標 1402x1292、R=国番号+1）
Image.fromarray(prov).save(os.path.join(ROOT, 'web/provinces_hi.png'), optimize=True)   # 輪郭追跡用（高解像度）
pr = Image.fromarray(prov).resize((1402, 1292), Image.NEAREST)
pr.save(os.path.join(ROOT, 'web/provinces.png'), optimize=True)
json.dump({'provinceOrder': ids, 'll2xy': {'bx': bx.tolist(), 'by': by.tolist(), 'terms': '1,lon,lat,lon^2,lat^2,lon*lat'},
           'capes': [{'name': n, 'lat': la, 'lon': lo, 'x': round(x, 1), 'y': round(y, 1)} for n, la, lo, x, y in pts]},
          open(os.path.join(ROOT, 'data/map_meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
cnt = np.bincount(prov.ravel(), minlength=len(ids) + 1)
missing = [ids[i] for i in range(len(ids)) if cnt[i + 1] == 0]
print('provinces covered', len(ids) - len(missing), 'missing', missing)
