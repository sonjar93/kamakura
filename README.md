# 天下布武以前 ― 平安・鎌倉動乱記（v2.9 / 1180年 源平合戦）

## すぐに遊ぶ（GitHub Pages）
このフォルダの**中身**をリポジトリの一番上に置き、Settings → Pages で Branch を `main`、フォルダを `/ (root)` にする。
一番上にある次の7つが遊ぶためのファイル（`tools/build_site.sh` で web/・engine/・data/ から作り直せる）：
`index.html` `engine.js` `scenario_1180.json` `provinces_geo.json` `basemap.png` `provinces.png` `.nojekyll`

手元では `python3 -m http.server 8000` を実行して http://localhost:8000/ を開く（index.html を直接開くとデータを読めない）。

操作のこつ：**スペースキー**で時間の進行／停止。

平安末〜鎌倉期の朝廷・武家・寺社・地方勢力を日単位でシミュレートする歴史ゲーム。初期シナリオは治承4年（1180）4月1日開始。

## 構成

```
engine/engine.js        ゲームロジック（UI非依存・Node/ブラウザ共通）
engine/types.ts         データ型（Web版 TypeScript 移行用）
data/scenario_1180.json 1180年シナリオ（史実データ・確度つき）
tools/build_scenario_1180.py  シナリオ生成元（人物・勢力・拠点はここを編集）
web/index.html          Web画面（地図・時間操作・命令）
cli/play.js             Claude会話プレイ用CLI
tests/acceptance.test.js 要件定義書の受入条件テスト
docs/DESIGN.md          仕様レビュー・データ設計・日次更新・AI・イベント設計
```

## 操作
- 自軍をクリック → 行き先をクリック（経路・日数・勝算が出る）。右クリック／Esc で取消
- 拠点・国をクリック → 出陣・普請・本拠などの操作
- 自分の拠点をクリック → 出陣・徴兵・守備を増やす・普請・本拠にする
- 下のツールバー：出陣（総大将・部隊・軍奉行の編成）／徴兵／普請／使者／朝廷／幕府／兵糧・寄進／史実
- 史実イベントの一覧と条件：`docs/HISTORICAL_EVENTS.md`（`node tools/export_events.js` で再生成）

## 遊び方

**Web版**：`dist/` を任意の静的サーバで開く（GitHub Pages 可）。
```
cp web/index.html web/basemap.png web/provinces.png web/provinces_geo.json engine/engine.js data/scenario_1180.json dist/
cd dist && python3 -m http.server   # → http://localhost:8000
```

**Claude会話版**：Claude に命令を伝えると、Claude が CLI で状態を進めて結果を報告する。
```
node cli/play.js new yoritomo            # 新規（勢力ID）
node cli/play.js run 10                  # 10日進める（重要イベントで停止）
node cli/play.js run month               # 月送り
node cli/play.js json '{"type":"mobilize","province":"sagami","troops":500}'
node cli/play.js cmd "相模国に城館を築く"     # 文→命令の変換は規則ベース（AIは使わない）
node cli/play.js choose ev12 issue       # イベントの選択
node cli/play.js status | log 30 | ai 30 | validate
```
選択可能な勢力ID：`heike` `yoritomo` `mochihito` `kiso` `kai` `oshu` `miura` `kazusa`

## テスト
```
node tests/acceptance.test.js
node tools/sim.js 365 <seed>     # 観戦モードで1年進めて重要ニュースを表示
```

## モード
- **史実モード**：令旨・挙兵・遷都・鎌倉入り・追討軍などが史実の日付に起こる（条件が崩れていれば起こらない）。主要人物は、自分が関わらない戦いでは史実の没年まで死なない。自勢力の分岐点では「史実どおり／従わない」を選べる。
- **自由モード**：史実は強制されない。状況とAIの判断だけで歴史が動く。

## 地図の作り直し
`python3 tools/build_map.py <白地図PNG>` → `python3 tools/build_province_paths.py` → `python3 tools/build_scenario_1180.py` → `python3 tools/build_roads.py` → `python3 tools/build_scenario_1180.py`（街道の形を反映）
（陸・海の基図、国の領域ラスタとベクトル輪郭、緯度経度→地図座標の変換式、拠点の位置を再生成）
