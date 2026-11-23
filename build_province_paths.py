# 国の領域（高解像度で再計算したラスタ）を輪郭追跡し、SVGパス（地図座標）にする → web/provinces_geo.json
import json, os, numpy as np, cv2
from PIL import Image
ROOT = os.path.join(os.path.dirname(__file__), '..')
ids = json.load(open(os.path.join(ROOT, 'data/map_meta.json')))['provinceOrder']
pr = np.array(Image.open(os.path.join(ROOT, 'web/provinces_hi.png')))
S = 1402 / pr.shape[1]
out = {}
for i, pid in enumerate(ids):
    m = (pr == i + 1).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    parts = []
    for c in cs:
        if cv2.contourArea(c) < 30: continue
        c = cv2.approxPolyDP(c, 1.6, True).reshape(-1, 2) * S
        if len(c) < 3: continue
        parts.append('M' + ' L'.join('%.1f %.1f' % (x, y) for x, y in c) + 'Z')
    out[pid] = ''.join(parts)
land = np.load(os.path.join(ROOT, 'tools/.cache/landmask.npy')).astype(np.uint8)
land = cv2.morphologyEx(land, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
cs, _ = cv2.findContours(land, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
parts = []
for c in cs:
    if cv2.contourArea(c) < 20: continue
    c = cv2.approxPolyDP(c, 1.3, True).reshape(-1, 2) * S
    if len(c) >= 3: parts.append('M' + ' L'.join('%.1f %.1f' % (x, y) for x, y in c) + 'Z')
out['_coast'] = ''.join(parts)
json.dump(out, open(os.path.join(ROOT, 'web/provinces_geo.json'), 'w'), separators=(',', ':'))
print('size', os.path.getsize(os.path.join(ROOT, 'web/provinces_geo.json')))
