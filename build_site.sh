#!/bin/sh
# 遊ぶためのファイル一式を、このフォルダの一番上（GitHub Pages の公開場所）と dist/ にそろえる
cd "$(dirname "$0")/.."
for d in . dist; do
  mkdir -p "$d"
  cp web/index.html web/basemap.png web/provinces.png web/provinces_geo.json "$d/" 2>/dev/null
  cp engine/engine.js data/scenario_1180.json "$d/"
done
touch .nojekyll
echo "公開用ファイルを更新しました（index.html / engine.js / scenario_1180.json / provinces_geo.json / basemap.png / provinces.png / .nojekyll）"
