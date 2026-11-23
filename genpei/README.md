# 天下布武以前 ― 平安・鎌倉動乱記（1180 源平合戦）

ブラウザで遊べる歴史シミュレーション。このフォルダの中身をそのままリポジトリの一番上に置けば動く。

- `index.html` … 画面（ここから起動）
- `engine.js` … ゲームエンジン
- `scenario_1180.json` / `provinces_geo.json` / `basemap.png` / `provinces.png` … データと地図

## GitHub Pages で公開する
Settings → Pages → Branch を `main`、フォルダを `/ (root)` にして保存。

## 手元で遊ぶ
`index.html` を直接開くとデータの読み込み（fetch）がブラウザに止められるので、簡易サーバーを使う。

```
python3 -m http.server 8000
```
→ http://localhost:8000/ を開く
