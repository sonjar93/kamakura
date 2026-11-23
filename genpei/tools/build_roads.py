# -*- coding: utf-8 -*-
"""
街道の経路形状を作る → data/road_geo.json
・各国の拠点（軍勢の集結点）を国府の推定位置に置く
・街道は 関・峠・渡し・宿など史料に見える通過点（緯度経度の概略）を順に通り、
  通過点の間は陸地だけを通る最短経路（海路は海だけを通る）で結ぶ
・標高データは使っていないため、通過点のない区間は山地を直進することがある（推定）
"""
import json, os, math
import numpy as np
from skimage.graph import route_through_array
from scipy import ndimage as ndi
import cv2

ROOT = os.path.join(os.path.dirname(__file__), '..')
MM = json.load(open(os.path.join(ROOT, 'data/map_meta.json'), encoding='utf-8'))['ll2xy']
def ll2xy(la, lo):
    v = [1, lo, la, lo * lo, la * la, lo * la]
    return sum(a * b for a, b in zip(v, MM['bx'])), sum(a * b for a, b in zip(v, MM['by']))

# 陸地マスク（地図座標 1402x1292 に縮小）
hi = np.load(os.path.join(ROOT, 'tools/.cache/landmask.npy'))
G = 1.0  # 格子の大きさ（地図座標）
H, W = 1292, 1402
from PIL import Image
land = np.array(Image.fromarray(hi.astype(np.uint8) * 255).resize((W, H), Image.BILINEAR)) > 100
sea = ~land
# 海岸に近い陸地はやや通りやすく（海沿いの道）、内陸は1、海は通れない
dist_coast = ndi.distance_transform_edt(land)
cost_land = np.where(land, 1.0 + np.clip(dist_coast, 0, 12) * 0.02, 60.0)  # 細い水路は高コストで渡れる
dist_land = ndi.distance_transform_edt(sea)
cost_sea = np.where(sea, 1.0 + np.clip(6 - dist_land, 0, 6) * 0.3, 1e6)  # 岸から少し離れた海を通る

# 国府（推定）の緯度経度
KOKUFU = {
 'yamashiro': (34.99, 135.75), 'yamato': (34.55, 135.80), 'kawachi': (34.57, 135.62), 'izumi': (34.48, 135.42), 'settsu': (34.70, 135.50),
 'iga': (34.78, 136.13), 'ise': (34.88, 136.53), 'shima': (34.30, 136.81), 'owari': (35.25, 136.80), 'mikawa': (34.83, 137.33),
 'totomi': (34.72, 137.85), 'suruga': (34.97, 138.38), 'izu': (35.12, 138.92), 'kai': (35.66, 138.65), 'sagami': (35.31, 139.31),
 'musashi': (35.67, 139.48), 'awa_t': (34.98, 139.85), 'kazusa': (35.50, 140.12), 'shimosa': (35.73, 139.92), 'hitachi': (36.19, 140.29),
 'omi': (34.98, 135.92), 'mino': (35.36, 136.56), 'hida': (36.15, 137.25), 'shinano': (36.24, 137.97), 'kozuke': (36.39, 139.03),
 'shimotsuke': (36.37, 139.73), 'mutsu': (38.31, 140.99), 'dewa': (38.90, 139.95), 'wakasa': (35.48, 135.75), 'echizen': (35.90, 136.17),
 'kaga': (36.40, 136.49), 'noto': (37.04, 136.96), 'etchu': (36.78, 137.03), 'echigo': (37.17, 138.24), 'sado': (38.02, 138.37),
 'tamba': (35.01, 135.58), 'tango': (35.56, 135.18), 'tajima': (35.47, 134.86), 'inaba': (35.48, 134.27), 'hoki': (35.42, 133.80),
 'izumo': (35.43, 133.10), 'iwami': (34.89, 132.08), 'oki': (36.20, 133.32), 'harima': (34.83, 134.69), 'mimasaka': (35.07, 134.00),
 'bizen': (34.69, 133.98), 'bitchu': (34.67, 133.75), 'bingo': (34.57, 133.24), 'aki': (34.40, 132.50), 'suo': (34.06, 131.57),
 'nagato': (34.02, 130.99), 'kii': (34.22, 135.20), 'awaji': (34.32, 134.82), 'awa_n': (34.06, 134.48), 'sanuki': (34.29, 133.88),
 'iyo': (34.04, 132.99), 'tosa': (33.58, 133.65), 'chikuzen': (33.52, 130.52), 'chikugo': (33.32, 130.52), 'buzen': (33.70, 130.98),
 'bungo': (33.23, 131.60), 'hizen': (33.26, 130.30), 'higo': (32.80, 130.72), 'hyuga': (32.09, 131.40), 'osumi': (31.72, 130.76),
 'satsuma': (31.83, 130.30), 'iki': (33.78, 129.72), 'tsushima': (34.20, 129.29),
}
# 街道の通過点（関・峠・渡・宿など）。キーは「国A|国B」（A→B の順）
WP = {
 'yamashiro|omi': [('逢坂関', 35.00, 135.86), ('勢多橋', 34.97, 135.91)],
 'yamashiro|settsu': [('山崎', 34.89, 135.68), ('芥川', 34.85, 135.60)],
 'yamashiro|yamato': [('宇治', 34.89, 135.80), ('木津', 34.74, 135.82), ('奈良坂', 34.70, 135.83)],
 'yamashiro|tamba': [('老ノ坂', 34.98, 135.65)],
 'omi|ise': [('野洲', 35.07, 136.03), ('甲賀', 34.96, 136.17), ('鈴鹿峠', 34.89, 136.36), ('関', 34.85, 136.39)],
 'omi|mino': [('愛知川', 35.17, 136.21), ('醒井', 35.32, 136.38), ('不破関', 35.37, 136.45)],
 'omi|echizen': [('塩津', 35.52, 136.17), ('愛発関', 35.58, 136.10), ('敦賀', 35.65, 136.07)],
 'omi|wakasa': [('今津', 35.40, 136.02), ('熊川', 35.45, 135.88)],
 'ise|owari': [('桑名', 35.07, 136.69)],
 'owari|mikawa': [('鳴海', 35.08, 136.95), ('矢作', 34.95, 137.16)],
 'mikawa|totomi': [('赤坂', 34.85, 137.30), ('浜名橋', 34.70, 137.57)],
 'totomi|suruga': [('池田（天竜川）', 34.76, 137.80), ('菊川', 34.75, 138.08), ('大井川', 34.83, 138.15), ('宇津ノ谷', 34.94, 138.33)],
 'suruga|izu': [('蒲原', 35.12, 138.60), ('富士川', 35.15, 138.63), ('黄瀬川', 35.12, 138.88)],
 'suruga|sagami': [('蒲原', 35.12, 138.60), ('黄瀬川', 35.14, 138.88), ('足柄峠', 35.32, 138.99), ('関本', 35.31, 139.07)],
 'izu|sagami': [('箱根', 35.19, 139.02), ('湯本', 35.23, 139.11)],
 'suruga|kai': [('岩淵', 35.18, 138.62), ('甲斐府中への中道', 35.48, 138.60)],
 'sagami|kai': [('御坂峠', 35.53, 138.74)],
 'sagami|musashi': [('海老名', 35.44, 139.39)],
 'sagami|kazusa': [('走水', 35.25, 139.73), ('富津', 35.30, 139.83)],
 'musashi|shimosa': [('隅田渡', 35.72, 139.80)],
 'shimosa|hitachi': [('香取の海', 35.88, 140.20)],
 'mino|owari': [('墨俣', 35.37, 136.68)],
 'mino|shinano': [('坂本', 35.42, 137.47), ('神坂峠', 35.48, 137.62), ('伊那', 35.83, 137.96)],
 'shinano|kozuke': [('小県', 36.40, 138.30), ('碓氷峠', 36.35, 138.67)],
 'shinano|echigo': [('善光寺', 36.66, 138.19), ('関山', 36.87, 138.17)],
 'shinano|kai': [('諏訪', 36.03, 138.11)],
 'kozuke|shimotsuke': [('新田', 36.30, 139.33), ('足利', 36.34, 139.45)],
 'kozuke|echigo': [('沼田', 36.65, 139.04), ('三国峠', 36.78, 138.81), ('湯沢', 36.93, 138.81)],
 'shimotsuke|mutsu': [('那須', 36.98, 140.05), ('白河関', 37.05, 140.24), ('郡山', 37.40, 140.38), ('信夫', 37.76, 140.47), ('名取', 38.17, 140.88)],
 'hitachi|mutsu': [('勿来関', 36.87, 140.79), ('磐城', 37.05, 140.89), ('相馬', 37.80, 140.92)],
 'echizen|kaga': [('細呂木', 36.22, 136.28)],
 'kaga|etchu': [('倶利伽羅峠', 36.68, 136.80)],
 'etchu|echigo': [('親不知', 36.98, 137.75), ('糸魚川', 37.04, 137.86)],
 'echigo|dewa': [('瀬波', 38.22, 139.48), ('念珠関', 38.55, 139.58)],
 'tamba|tajima': [('福知山', 35.30, 135.12), ('夜久野', 35.33, 134.97)],
 'tajima|inaba': [('蒲生峠', 35.52, 134.50)],
 'settsu|harima': [('生田', 34.69, 135.19), ('須磨', 34.64, 135.11), ('明石', 34.65, 134.99)],
 'harima|bizen': [('有年', 34.85, 134.42), ('船坂峠', 34.83, 134.33)],
 'bingo|aki': [('尾道', 34.41, 133.20), ('西条', 34.43, 132.74)],
 'aki|suo': [('大竹', 34.24, 132.22), ('玖珂', 34.09, 132.07)],
 'suo|nagato': [('小郡', 34.06, 131.40)],
 'nagato|buzen': [('赤間関', 33.96, 130.95), ('門司', 33.94, 130.96)],
 'izumi|kii': [('雄ノ山峠', 34.28, 135.26)],
 'ise|kii': [('熊野古道（伊勢路）', 34.00, 136.10), ('新宮', 33.72, 135.99)],
}

def snap(xy, mask):
    x, y = int(round(xy[0])), int(round(xy[1]))
    x = min(max(x, 0), W - 1); y = min(max(y, 0), H - 1)
    if mask[y, x]: return (x, y)
    d, idx = ndi.distance_transform_edt(~mask, return_indices=True)
    return (int(idx[1][y, x]), int(idx[0][y, x]))

def route(p, q, cost):
    path, c = route_through_array(cost, (p[1], p[0]), (q[1], q[0]), fully_connected=True, geometric=True)
    if c >= 1e6: return None
    return [(x, y) for y, x in path]

def chaikin(pts, n=2):
    for _ in range(n):
        out = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            out += [(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]), (0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1])]
        out.append(pts[-1]); pts = out
    return pts

def build(roads, provinces):
    hubs = {pid: snap(ll2xy(*KOKUFU[pid]), land) for pid in KOKUFU}
    # 島の国（佐渡・隠岐・壱岐・対馬・淡路）は陸の格子で国府に寄せる
    out = {}
    for r in roads:
        a, b, kind = r['a'], r['b'], r['kind']
        key, rev = (a + '|' + b, False) if (a + '|' + b) in WP else ((b + '|' + a, True) if (b + '|' + a) in WP else (a + '|' + b, False))
        wps = WP.get(key, [])
        if rev: wps = list(reversed(wps))
        pts_named = [('国府', hubs[a])] + [(n, ll2xy(la, lo)) for n, la, lo in wps] + [('国府', hubs[b])]
        poly = []
        if kind == 'sea':
            # 海路：出発港（岸の近く）→海→到着港
            seq = [snap(p, sea) if i not in (0, len(pts_named) - 1) else p for i, (_, p) in enumerate(pts_named)]
            p0, p1 = snap(hubs[a], sea), snap(hubs[b], sea)
            mid = [snap(ll2xy(la, lo), sea) for n, la, lo in wps]
            chain = [p0] + mid + [p1]
            poly = [hubs[a]]
            ok = True
            for u, v in zip(chain[:-1], chain[1:]):
                seg = route(u, v, cost_sea)
                if seg is None: ok = False; break
                poly += seg
            poly.append(hubs[b])
            if not ok: poly = [hubs[a], hubs[b]]
        else:
            chain = [hubs[a]] + [snap(ll2xy(la, lo), land) for n, la, lo in wps] + [hubs[b]]
            ok = True
            for u, v in zip(chain[:-1], chain[1:]):
                seg = route(u, v, cost_land)
                if seg is None: ok = False; break
                poly += seg if not poly else seg[1:]
            if not ok: poly = [hubs[a], hubs[b]]
        arr = np.array(poly, np.float32).reshape(-1, 1, 2)
        simp = cv2.approxPolyDP(arr, 0.9, False).reshape(-1, 2).tolist()
        sm = chaikin([tuple(p) for p in simp], 2) if len(simp) > 2 else [tuple(p) for p in simp]
        length = sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(sm[:-1], sm[1:]))
        out[r['id']] = {'path': [[round(x, 1), round(y, 1)] for x, y in sm], 'lengthPx': round(length, 1),
                        'stations': [n for n, *_ in wps]}
    return {'hubs': {k: [float(v[0]), float(v[1])] for k, v in hubs.items()}, 'roads': out}

if __name__ == '__main__':
    import sys
    scn = json.load(open(os.path.join(ROOT, 'data/scenario_1180.json'), encoding='utf-8'))
    geo = build(scn['roads'], scn['provinces'])
    json.dump(geo, open(os.path.join(ROOT, 'data/road_geo.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    n_straight = sum(1 for v in geo['roads'].values() if len(v['path']) <= 2)
    print('roads', len(geo['roads']), 'straight fallback', n_straight, 'size', os.path.getsize(os.path.join(ROOT, 'data/road_geo.json')))
