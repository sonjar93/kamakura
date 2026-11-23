// 史実イベントの一覧（名称・史実の日付・当事者・発生条件・効果）を Markdown に書き出す
const E = require('../engine/engine.js'), fs = require('fs');
const scn = JSON.parse(fs.readFileSync(__dirname + '/../data/scenario_1180.json', 'utf8'));
const s = E.createGame(scn, { seed: 1, mode: 'historical' });
const EFF = { ryoji: '令旨を発し行家が東国へ', expose: '計画露見・追捕軍', sento: '福原遷都', letter: '康信の書状が伊豆へ', uprising: '挙兵', join: '帰属', kamakura: '鎌倉を本拠に', yoshitsune: '義経が出立', samurai: '武家政権の成立・侍所', kango: '還都', campaign: '遠征軍を出す' };
let md = '# 史実イベント一覧（1180年シナリオ）\n\n条件がすべてそろうと発生する（信長の野望の史実イベントと同じ考え方）。当事者がプレイヤーの家なら「史実どおりにするか」を選べる。\n史実モードでは「期限」を過ぎると起こらない。自由モードでは期限がなく、他家は条件がそろってもすぐには動かない（1日12%）。\n\n';
md += '| # | 名称 | 史実 | 当事者 | 発生条件 | 結果 |\n|---|---|---|---|---|---|\n';
E.histEventStatus(s).forEach((e, i) => {
  const def = s.histEvents[i];
  const eff = (def.effects || []).map(x => x.do === 'schedule' ? (EFF[x.action] || x.action) + (x.troops ? `（${x.troops}）` : '') : ({ legitimacy: '正当性', money: '資金', foodRate: '兵糧の減少', relation: '関係', unflag: '朝敵の解除', kill: '人物の死', absorb: '勢力の吸収', joinPerson: '人物の加入', moveCapital: '本拠の移転', courtShift: '朝廷の主導権の変化', occupy: '拠点の占拠', news: '' }[x.do] || x.do)).filter(Boolean).join('・');
  md += `| ${i + 1} | ${e.name} | ${e.date} | ${e.actor ? s.factions[e.actor].name : '—'} | ${e.conds.map(c => c.label).join('<br>')} | ${e.summary}（${eff}） |\n`;
});
fs.writeFileSync(__dirname + '/../docs/HISTORICAL_EVENTS.md', md);
console.log('written', md.length);
