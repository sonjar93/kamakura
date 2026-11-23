#!/usr/bin/env node
/*
 * Claude版プレイ用 CLI（会話中に Claude がこのコマンドで状態を進め、結果を文章で返す）
 *   node cli/play.js new <勢力ID> [save.json] [seed]
 *   node cli/play.js status [save.json]
 *   node cli/play.js run <日数|month> [save.json]
 *   node cli/play.js cmd "<自然言語の命令>" [save.json]
 *   node cli/play.js json '<構造化命令JSON>' [save.json]
 *   node cli/play.js choose <イベントID> <選択肢ID> [save.json]
 *   node cli/play.js log [件数] [save.json]   /  ai [件数]  /  validate
 */
const fs = require('fs'), path = require('path');
const E = require('../engine/engine.js');
const ROOT = path.join(__dirname, '..');
const scenario = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scenario_1180.json'), 'utf8'));
const [, , op, a1, a2, a3] = process.argv;
const defSave = path.join(ROOT, 'saves/current.json');
const load = (p) => E.load(fs.readFileSync(p || defSave, 'utf8'));
const store = (s, p) => fs.writeFileSync(p || defSave, E.save(s));

function pending(s) { return s.pendingStops.filter(e => !e.resolved); }
function showStops(st) {
  st.forEach(e => {
    console.log(`\n■ ${e.title}［${e.date}${e.place ? '／' + e.place : ''}］ id=${e.id}`);
    console.log('  ' + e.text);
    (e.choices || []).forEach(c => console.log(`   - ${c.id}: ${c.label}`));
  });
}
function status(s) {
  const sm = E.summary(s);
  console.log(`=== ${sm.date}（開始から${sm.day}日目）  プレイヤー：${sm.player || '観戦'} ===`);
  const pf = s.playerFaction;
  sm.factions.filter(f => f.alive && (f.status !== '在地' || f.id === pf || f.overlord)).forEach(f =>
    console.log(`${f.id === pf ? '★' : ' '} ${f.name.padEnd(14, '　')} 状態:${f.status} 当主:${f.leader} 本拠:${f.capital || '—'} 資金${f.money} 兵糧${f.food} 動員可${f.troopsAvailable} 野戦${f.field}${f.overlord ? ' 主君:' + s.factions[f.overlord].name : ''}${f.choteki ? ' [朝敵]' : ''}`));
  if (sm.armies.length) { console.log('--- 軍勢'); sm.armies.forEach(a => console.log(`  ${a.label} [${s.factions[a.faction].name}] ${a.province} ${a.status}${a.target ? '→' + a.target : ''} 士気${a.morale} 疲労${a.fatigue} 兵糧${a.food}`)); }
  if (sm.battles.length) console.log('--- 交戦中：' + sm.battles.join('、'));
  console.log(`--- 朝廷：${sm.court.location}／院：${sm.court.cloistered}／主導：${sm.court.controller}`);
  const p = pending(s); if (p.length) { console.log('--- 未解決イベント'); showStops(p); }
}
function recent(s, n, from) { s.log.slice(from != null ? from : -n).forEach(l => console.log(`${l.important ? '◆' : '・'}${l.date} ${l.text}`)); }

switch (op) {
  case 'new': {
    const s = E.createGame(scenario(), { playerFaction: a1 === 'none' ? null : a1, seed: a3 ? +a3 : undefined });
    store(s, a2); status(s); break;
  }
  case 'status': status(load(a1)); break;
  case 'run': {
    const s = load(a2); const from = s.log.length;
    const r = a1 === 'month' ? E.runUntilMonthEnd(s) : E.runDays(s, +a1 || 1);
    recent(s, 0, from); if (r.blocked) console.log('（未解決のイベントがあるため進められない）');
    showStops(r.stops.filter(e => !e.resolved)); store(s, a2); console.log(`\n→ ${E.util.dateStr(s)}（${r.daysRun}日進行）`); break;
  }
  case 'cmd': {
    const s = load(a2); const p = E.parseCommand(s, a1);
    if (p.error) { console.log('✗ ' + p.error); break; }
    const r = E.issueCommand(s, p.cmd); console.log(r.ok ? '✓ ' + r.message : '✗ 不成立：' + r.reason); store(s, a2); break;
  }
  case 'json': { const s = load(a2); const r = E.issueCommand(s, JSON.parse(a1)); console.log(r.ok ? '✓ ' + r.message : '✗ 不成立：' + r.reason); store(s, a2); break; }
  case 'choose': { const s = load(a3); const r = E.resolveEvent(s, a1, a2); console.log(r.ok ? '✓ ' + r.message : '✗ ' + r.reason); store(s, a3); break; }
  case 'log': recent(load(a2), +a1 || 30); break;
  case 'ai': load(a2).aiLog.slice(-(+a1 || 30)).forEach(l => console.log(`${l.date} [${l.faction}] ${l.action} ― ${l.reason}`)); break;
  case 'validate': { const v = E.validate(load(a1)); console.log('矛盾:', v.errors.length); v.errors.forEach(e => console.log(' ✗ ' + e)); console.log('未確認・推定項目:', v.uncertain.length); v.uncertain.forEach(u => console.log(` - [${u.kind}/${u.confidence}] ${u.item}：${u.note}`)); break; }
  default: console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n'));
}
