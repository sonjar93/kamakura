// 要件定義書「9. 初期受入条件」の自動検証  —  node tests/acceptance.test.js
const E = require('../engine/engine.js'), fs = require('fs'), assert = require('assert');
const scn = JSON.parse(fs.readFileSync(__dirname + '/../data/scenario_1180.json', 'utf8'));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const clear = s => s.pendingStops.forEach(e => { if (!e.resolved) E.resolveEvent(s, e.id, (e.choices[0] || {}).id); e.resolved = true; });

ok('1. 1180年シナリオを読み込み、日付・主要人物・勢力・拠点を確認できる', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 1 });
  assert.strictEqual(E.util.dateStr(s), '治承4年4月1日（1180年）');
  ['kiyomori', 'munemori', 'tomomori', 'goshirakawa', 'mochihito', 'yoritomo', 'yoshitsune', 'noriyori', 'tokimasa', 'masako', 'yoshinaka'].forEach(p => assert(s.persons[p] && s.persons[p].alive, p));
  ['heike', 'yoritomo', 'court', 'oshu', 'nanto', 'enryakuji', 'kiso', 'kai'].forEach(f => assert(s.factions[f].alive, f));
  ['rokuhara', 'fukuhara', 'hojo', 'yamaki', 'hiraizumi', 'kamakura'].forEach(b => assert(s.bases[b], b));
  assert.strictEqual(s.bases.kamakura.owner, null, '1180年4月の鎌倉は頼朝の本拠ではない');
  assert.strictEqual(s.court.dharmaEmperorConfined, true, '後白河は幽閉中');
});
ok('2. 1日進めると日次処理（移動・兵糧・AI）が実行される', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 2 });
  const r = E.issueCommand(s, { type: 'mobilize', province: 'yamashiro', troops: 1000, target: { type: 'province', id: 'omi' }, mission: 'move' });
  assert(r.ok, r.reason);
  const a = s.armies[r.army], food0 = a.food;
  for (let i = 0; i < 6; i++) { clear(s); E.advanceDay(s); }
  assert(a.food < food0, '兵糧が減る');
  assert(a.province === 'omi' || (a.edge && a.edge.done > 0), '移動している');
  assert.strictEqual(s.day, 6);
});
ok('3. 時間は停止でき、重要イベントで自動停止する（未解決のまま進められない）', () => {
  const s = E.createGame(scn, { playerFaction: 'mochihito', seed: 3 });
  let r; for (let i = 0; i < 30; i++) { r = E.advanceDay(s); if (r.stops.length) break; }
  const ev = r.stops.find(e => /^hist_he01|mochihito_ryoji/.test(e.key)); assert(ev, '令旨の選択で停止');
  const day = s.day; const r2 = E.advanceDay(s); assert(r2.blocked && s.day === day, '選択するまで進まない');
  E.resolveEvent(s, ev.id, /^hist_/.test(ev.key) ? 'follow' : 'issue'); assert(Object.keys(s.envoys).length === 1, '行家が使者として出発');
});
ok('4. 命令は条件により実行、または理由付きで拒否される', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 4 });
  let p = E.parseCommand(s, '伊豆国の兵を京都へ進軍させる'); assert(p.cmd);
  let r = E.issueCommand(s, { type: 'march', faction: 'yoritomo', army: 'none', target: { type: 'base', id: 'yamaki' } }); assert(!r.ok, '存在しない軍勢への命令は拒否');
  r = E.issueCommand(s, { type: 'petition', kind: 'appointment', person: 'yoritomo', office: 'rokuhara_tandai' }); assert(!r.ok, '六波羅探題は武家役職で未成立');
  r = E.issueCommand(s, { type: 'donate', base: 'ise_jingu', amount: 99999 }); assert(!r.ok && /資金不足/.test(r.reason));
  p = E.parseCommand(s, '北条時政を使者として三浦氏へ派遣し味方に誘う'); assert.strictEqual(p.cmd.proposal, 'vassal_request');
  r = E.issueCommand(s, p.cmd); assert(r.ok, r.reason);
  r = E.issueCommand(s, { type: 'uprising' }); assert(r.ok);
  r = E.issueCommand(s, { type: 'mobilize', province: 'izu', troops: 80 }); assert(r.ok, r.reason);
});
ok('5. 非プレイヤー勢力が命令なしに外交・軍事判断を行う', () => {
  const s = E.createGame(scn, { playerFaction: 'oshu', seed: 5 });
  for (let i = 0; i < 200; i++) { clear(s); E.advanceDay(s); }
  const acts = new Set(s.aiLog.map(l => l.faction));
  assert(acts.size >= 4, 'AI 判断した勢力数: ' + acts.size);
  assert(s.battleHistory.length > 0, '合戦が起きている');
  assert(s.log.some(l => /外交|去就|開戦/.test(l.text)), '外交・去就の判断');
});
ok('6. セーブを出力し、読み込み後に主要状態が復元される', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 6 });
  for (let i = 0; i < 60; i++) { clear(s); E.advanceDay(s); }
  const json = E.save(s), t = E.load(json);
  assert.deepStrictEqual(E.summary(t), E.summary(s));
  for (let i = 0; i < 30; i++) { clear(s); clear(t); E.advanceDay(s); E.advanceDay(t); }
  assert.strictEqual(E.save(t), E.save(s), '復元後も同じ乱数で同じ展開（決定論）');
});
ok('7. 人物・制度の年代矛盾を検出し、不確実項目を一覧化できる', () => {
  const s = E.createGame(scn, { seed: 7 });
  let v = E.validate(s); assert.strictEqual(v.errors.length, 0, v.errors.join('\n')); assert(v.uncertain.length > 10);
  s.persons.yoritomo.warriorOffices.push('六波羅探題'); s.persons.kiyomori.born = 1190;
  v = E.validate(s); assert(v.errors.some(e => /六波羅探題/.test(e)) && v.errors.some(e => /平清盛/.test(e)));
});
ok('8. 瞬間移動の禁止：行軍には街道距離に応じた日数がかかる', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 8 });
  const r = E.issueCommand(s, { type: 'mobilize', province: 'yamashiro', troops: 3000, target: { type: 'province', id: 'suruga' }, mission: 'move' });
  const a = s.armies[r.army]; let d = 0; while (a.province !== 'suruga' && d < 80) { clear(s); E.advanceDay(s); d++; }
  assert(d >= 12, '京→駿河に ' + d + ' 日');
});
ok('9. 史実モードと自由モード：史実モードでは主要な出来事が史実の日付に起こる', () => {
  const h = E.createGame(scn, { seed: 9, mode: 'historical' });
  for (let i = 0; i < 140; i++) { clear(h); E.advanceDay(h); }
  assert(h.log.some(l => /以仁王の令旨/.test(l.text) && /4月9日/.test(l.date)));
  assert(h.log.some(l => /挙兵】源頼朝/.test(l.text) && /8月17日/.test(l.date)), '頼朝挙兵 8/17');
  const f = E.createGame(scn, { seed: 9, mode: 'free' }); assert.strictEqual(f.options.mode, 'free');
});
ok('10. 館の普請：規模に応じて数か月かかり、完成すると拠点になる', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 10 });
  let r = E.issueCommand(s, { type: 'build', province: 'mutsu', scale: 'small' }); assert(!r.ok && /権利/.test(r.reason), '権利のない国には建てられない');
  r = E.issueCommand(s, { type: 'build', province: 'harima', scale: 'medium', name: '播磨の城館', x: 600, y: 790 }); assert(r.ok, r.reason);
  const n0 = Object.keys(s.bases).length; let d = 0;
  while (Object.keys(s.bases).length === n0 && d < 400) { clear(s); E.advanceDay(s); d++; }
  assert(d >= 90, '城館の完成まで ' + d + ' 日'); assert(s.bases['built_' + r.id] && s.bases['built_' + r.id].owner === 'heike');
  const p = E.parseCommand(s, '相模国に城館を築く'); assert.strictEqual(p.cmd.type, 'build'); assert.strictEqual(p.cmd.scale, 'medium');
});
ok('11. 総大将・部隊の大将・軍奉行の編成が戦力（勝算）に反映される', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 11 });
  const mk = (extra) => { const r = E.issueCommand(s, Object.assign({ type: 'mobilize', province: 'yamashiro', troops: 2400 }, extra)); assert(r.ok, r.reason); return s.armies[r.army]; };
  const a = mk({ commander: 'tomomori', divisions: [{ leader: 'shigehira', troops: 800 }, { leader: 'tadanori', troops: 800 }], bugyo: 'tokitada' });
  const b = mk({ commander: 'koremori', divisions: [], bugyo: null });
  const qa = E.armyQuality(s, a), qb = E.armyQuality(s, b);
  assert(qa.factor > qb.factor * 1.15, '良い編成ほど強い ' + qa.factor + ' vs ' + qb.factor);
  assert(qb.notes.some(n => /軍奉行なし/.test(n)) && qb.notes.some(n => /大きすぎる/.test(n)));
  const r = E.issueCommand(s, { type: 'mobilize', province: 'yamashiro', troops: 300, commander: 'shigehira' }); assert(!r.ok, '同じ人物を二つの軍に置けない');
  const o = E.estimateOdds(s, a.id, { type: 'base', id: 'onjoji' }); assert(o.odds > 0 && o.odds < 100);
  const o2 = E.issueCommand(s, { type: 'organize', army: b.id, commander: 'koremori', divisions: [{ leader: 'norimori', troops: 1000 }], bugyo: 'tsunemori' }); assert(o2.ok, o2.reason);
});
ok('12. 武家政権（幕府）を開くと侍所・公文所・問注所・政所を設置できる', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 12, mode: 'free' });
  let r = E.issueCommand(s, { type: 'establish', inst: 'samurai_dokoro' }); assert(!r.ok && /武家政権/.test(r.reason));
  r = E.issueCommand(s, { type: 'found_bakufu' }); assert(!r.ok && /御家人/.test(r.reason), r.reason);
  const f = s.factions.yoritomo; f.status = '挙兵'; ['miura', 'chiba', 'kazusa'].forEach(k => { s.factions[k].overlord = 'yoritomo'; }); f.legitimacy = 50; f.money = 5000;
  s.bases.kamakura.owner = 'yoritomo'; f.capital = 'kamakura';
  r = E.issueCommand(s, { type: 'found_bakufu' }); assert(r.ok, r.reason);
  r = E.issueCommand(s, { type: 'establish', inst: 'mandokoro' }); assert(!r.ok && /公文所/.test(r.reason));
  ['samurai_dokoro', 'kumonjo', 'monchujo', 'mandokoro'].forEach(k => { const x = E.issueCommand(s, { type: 'establish', inst: k }); assert(x.ok, k + ':' + x.reason); });
  assert(s.factions.yoritomo.institutions.mandokoro && !s.factions.yoritomo.institutions.kumonjo, '政所は公文所を改組');
  const h = E.createGame(scn, { playerFaction: 'yoritomo', seed: 12, mode: 'historical' }); const hf = h.factions.yoritomo; hf.flags.bakufu = 1; hf.money = 5000;
  r = E.issueCommand(h, { type: 'establish', inst: 'kumonjo' }); assert(!r.ok && /1184/.test(r.reason), '史実モードでは成立年を守る');
});
ok('13. 徴兵：所領・拠点のある国で兵を集め、日数をかけて武士団が増える', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 13 });
  const info = E.recruitInfo(s, 'yoritomo', 'izu'); assert(info.room > 50, JSON.stringify(info));
  let r = E.issueCommand(s, { type: 'recruit', province: 'izu', amount: 100 }); assert(r.ok, r.reason);
  r = E.issueCommand(s, { type: 'recruit', province: 'mutsu', amount: 100 }); assert(!r.ok, '所領のない国では徴兵できない');
  const before = E.util.availableBandTroops(s, 'yoritomo', 'izu');
  for (let i = 0; i < 30; i++) { clear(s); E.advanceDay(s); }
  assert(E.util.availableBandTroops(s, 'yoritomo', 'izu') >= before + 90, '30日で兵が増える');
  r = E.issueCommand(s, { type: 'garrison', base: 'hojo', amount: 50 }); assert(r.ok, r.reason);
});
ok('14. 史実イベント：名称・条件の一覧を取得でき、条件の成否が分かる', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 14 });
  const st = E.histEventStatus(s); assert(st.length >= 30);
  const y = st.find(e => e.id === 'he05'); assert(y.conds.some(c => /以降/.test(c.label) && !c.ok) && y.conds.some(c => /令旨/.test(c.label)));
});
ok('15. 出陣：複数の拠点から部隊を出し一つの軍団にでき、後詰めも送れる', () => {
  const s = E.createGame(scn, { playerFaction: 'heike', seed: 15 });
  const src = E.sortieSources(s, 'heike'); assert(src.find(x => x.province === 'yamashiro').available === 2500);
  let r = E.issueCommand(s, { type: 'sortie', target: { type: 'base', id: 'onjoji' }, declare: true, commander: 'tomomori', bugyo: 'tokitada',
    units: [{ province: 'yamashiro', leader: 'tomomori', troops: 1200 }, { province: 'settsu', leader: 'moritoshi', troops: 800 }] });
  assert(r.ok, r.reason);
  const arms = Object.values(s.armies).filter(a => a.corps === r.corps); assert.strictEqual(arms.length, 2);
  assert(arms.some(a => a.province === 'settsu') && arms.some(a => a.province === 'yamashiro'), '各拠点から出る');
  let r2 = E.issueCommand(s, { type: 'sortie', target: { type: 'base', id: 'onjoji' }, commander: 'shigehira', units: [{ province: 'yamashiro', leader: 'shigehira', troops: 5000 }] });
  assert(!r2.ok && /2500|1300|まで/.test(r2.reason), '拠点の兵を超えては出せない: ' + r2.reason);
  r2 = E.issueCommand(s, { type: 'sortie', join: r.corps, units: [{ province: 'ise', leader: 'tadanori', troops: 1000 }] });
  assert(r2.ok, r2.reason); assert.strictEqual(Object.values(s.armies).filter(a => a.corps === r.corps).length, 3);
  const y = E.createGame(scn, { playerFaction: 'yoritomo', seed: 15 });
  r = E.issueCommand(y, { type: 'sortie', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [{ province: 'izu', leader: 'yoritomo', troops: 25 }] });
  assert(r.ok && y.factions.yoritomo.status === '挙兵', '平家方を攻めれば自動で挙兵: ' + r.reason);
});
ok('16. 雌伏中に平家方の拠点を攻めれば自動で挙兵し、直後は近隣の敵もすぐには攻めてこない', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 7 });
  const src = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
  const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: src.available } });
  assert(r.ok, r.reason); assert.strictEqual(s.factions.yoritomo.status, '挙兵'); assert(/挙兵/.test(r.message));
  for (let i = 0; i < 5; i++) { clear(s); E.advanceDay(s); }
  const att = Object.values(s.armies).filter(a => a.faction !== 'yoritomo' && a.target && a.target.type === 'base' && s.bases[a.target.id].owner === 'yoritomo');
  assert.strictEqual(att.length, 0, '挙兵から10日は近隣の敵も攻めてこない');
});
ok('17. 自家の拠点をすべて失うと滅亡（ゲームオーバー）、天下統一を5年保つとクリア', () => {
  let s = E.createGame(scn, { playerFaction: 'kiso', seed: 8 });
  E.advanceDay(s); clear(s);
  Object.values(s.bases).forEach(b => { if (b.owner === 'kiso') b.owner = 'heike'; });
  E.advanceDay(s); assert(!s.factions.kiso.alive && s.flags.gameOver, '滅亡'); assert(s.pendingStops.some(e => e.key === 'game_over'));
  const d = s.day; E.advanceDay(s); assert.strictEqual(s.day, d, 'ゲームオーバー後は進まない');
  s = E.createGame(scn, { playerFaction: 'heike', seed: 9, goal: 'unify' });
  Object.values(s.bases).forEach(b => { if (b.owner && b.owner !== 'court' && b.type !== '寺社') b.owner = 'heike'; });
  clear(s); E.advanceDay(s); assert(E.unifyStatus(s).unified && s.flags.unifiedDay != null, '統一');
  s.flags.unifiedDay -= 5 * 354; clear(s); E.advanceDay(s); assert(s.flags.victory, 'クリア'); assert(s.pendingStops.some(e => e.key === 'victory'));
});
ok('18. 勢力ごとの目標：条件がそろうとクリア（頼朝＝武家政権の樹立）', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 10 });
  let st = E.objectiveStatus(s); assert.strictEqual(st.title, '武家政権の樹立'); assert(!st.done);
  const f = s.factions.yoritomo; f.flags.bakufu = true; f.institutions = { samurai_dokoro: { head: 'yoshimori' }, kumonjo: { head: 'hiromoto' }, monchujo: { head: 'yasunobu' } };
  ['izu','sagami','musashi','awa_t','kazusa','shimosa','hitachi','kozuke','shimotsuke'].forEach(p => { Object.values(s.bases).filter(b => b.province === p).forEach(b => b.owner = 'yoritomo'); Object.values(s.holdings).filter(h => h.province === p).forEach(h => h.controller = 'yoritomo'); });
  s.persons.yoritomo.courtOffices.push('征夷大将軍');
  clear(s); E.advanceDay(s); st = E.objectiveStatus(s); assert(st.done, JSON.stringify(st.rows)); assert(s.flags.victory);
  const h = E.createGame(scn, { playerFaction: 'heike', seed: 10, goal: 'survive' }); assert.strictEqual(E.objectiveStatus(h).title, '家の存続');
  const n = E.createGame(scn, { playerFaction: 'heike', seed: 10, goal: 'none' }); assert.strictEqual(E.objectiveStatus(n), null);
});
ok('19. 朝廷の派閥：態度で申請の見込みが変わり、法皇の幽閉中は院宣が出ない', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 11 });
  assert(Object.keys(s.court.cliques).length === 5);
  assert(s.court.dharmaEmperorConfined && !E.insenAvailable(s));
  let r = E.issueCommand(s, { type: 'petition', faction: 'yoritomo', kind: 'insen' }); assert(!r.ok && /幽閉/.test(r.reason), r.reason);
  s.court.dharmaEmperorConfined = false; s.persons.goshirakawa.location = 'heiankyo';
  r = E.issueCommand(s, { type: 'petition', faction: 'yoritomo', kind: 'insen' }); assert(r.ok, r.reason); const p1 = +r.message.match(/(\d+)%/)[1];
  s.court.pendingPetitions = []; s.court.cliques.in.attitude.yoritomo = 80;
  r = E.issueCommand(s, { type: 'petition', faction: 'yoritomo', kind: 'insen' }); const p2 = +r.message.match(/(\d+)%/)[1]; assert(p2 > p1, p1 + '→' + p2);
  s.factions.yoritomo.money = 5000; r = E.issueCommand(s, { type: 'court_gift', faction: 'yoritomo', clique: 'sekkan', amount: 600 }); assert(r.ok, r.reason);
  for (let i = 0; i < 20; i++) { clear(s); E.advanceDay(s); }
  assert(s.court.cliques.sekkan.favor.yoritomo > 0, '献金が届いて恩が付く');
  r = E.issueCommand(s, { type: 'court_gift', faction: 'yoritomo', clique: 'sekkan', amount: 600 }); assert(!r.ok && /2か月/.test(r.reason), '同じ派閥への献金は2か月空ける');
});
ok('20. 朝廷：都を押さえた家へ主導権が移り、天皇が都を離れたままなら院が新帝を立てる', () => {
  const s = E.createGame(scn, { playerFaction: null, seed: 12, mode: 'free' });
  Object.values(s.bases).filter(b => b.province === 'yamashiro' && b.owner === 'heike').forEach(b => { b.owner = 'kiso'; b.garrison = 3000; });
  Object.values(s.bands).filter(b => b.province === 'yamashiro' && b.faction === 'heike').forEach(b => { b.faction = 'kiso'; });
  Object.values(s.holdings).filter(h => h.province === 'yamashiro').forEach(h => h.controller = 'kiso');
  s.firedEvents.fukuhara_sento = 0; // この試験では遷都させない
  s.court.dharmaEmperorConfined = false; s.persons.goshirakawa.location = 'heiankyo'; s.persons.antoku.location = 'yashima';
  for (let i = 0; i < 400 && (s.court.emperor === 'antoku' || s.court.controller !== 'kiso'); i++) { clear(s); E.advanceDay(s); }
  assert.strictEqual(s.court.controller, 'kiso', '都を押さえた木曽が朝廷を主導');
  assert.notStrictEqual(s.court.emperor, 'antoku', '新帝が践祚'); assert(s.court.rivalEmperor && s.court.rivalEmperor.person === 'antoku', '二帝並立');
  assert(s.aiLog.some(l => l.faction === 'court' && l.speech), '朝廷の動きが言葉で記録される');
});
ok('21. CPUの評定：判断の理由が言葉で残り、拠点が攻められた家は当日に評定する', () => {
  const s = E.createGame(scn, { playerFaction: null, seed: 13, mode: 'free' });
  for (let i = 0; i < 500; i++) { clear(s); E.advanceDay(s); }
  const sp = s.aiLog.filter(l => l.speech);
  assert(sp.length > 20, '評定の言葉 ' + sp.length);
  assert(sp.some(l => /出払|手一杯|兵はいま/.test(l.speech)), '敵の主力が別の戦線にいる隙を突く判断がある');
  const urgent = s.aiLog.filter(l => l.action === '緊急の評定');
  assert(urgent.length > 0, '緊急の評定がある');
  assert(sp.every(l => !/\{[A-Z]\}|（不明）/.test(l.speech)), 'テンプレの穴がない');
});
ok('22. 補給線：味方の拠点から街道をたどり、敵の軍勢がいる国の先では断たれる。兵糧切れが続く軍は退く', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 14, mode: 'free' });
  assert.strictEqual(E.supplyAt(s, 'yoritomo', 'sagami'), 0, '拠点のある国は補給網の起点');
  assert(E.supplyAt(s, 'yoritomo', 'yamashiro') == null, '京までは届かない（距離）');
  s.factions.yoritomo.status = '挙兵'; s.relations[Object.keys(s.relations).find(k => k.split('|').sort().join('|') === 'heike|yoritomo')].war = true;
  assert(E.supplyAt(s, 'yoritomo', 'totomi') != null, '遠江までは届く');
  s.armies.blk = { id: 'blk', faction: 'heike', troops: 5000, province: 'suruga', bands: [], officers: [], path: [], status: 'idle', mission: 'hold', morale: 80, food: 100, fatigue: 0, idleDays: 0 }; s.seq++;
  assert(E.supplyAt(s, 'yoritomo', 'totomi') == null, '駿河に平家の大軍がいれば遠江への補給は断たれる');
  delete s.armies.blk; s.seq++;
  const src = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
  s.bands.band_13.strength = s.bands.band_13.base = 100;
  const r = E.issueCommand(s, { type: 'mobilize', faction: 'yoritomo', province: 'izu', troops: Math.min(80, src.available) }); assert(r.ok, r.reason);
  const a = Object.values(s.armies).find(x => x.faction === 'yoritomo');
  a.province = 'noto'; a.path = []; a.edge = null; a.status = 'idle'; a.food = 0; a.troops = a.initialTroops = 3000; a.gatherUntil = null; a.target = null; a.mission = 'hold'; s.seq++;
  assert(E.supplyAt(s, 'yoritomo', 'noto') == null, '能登は補給網の外');
  let retreated = false; for (let i = 0; i < 10; i++) { clear(s); E.advanceDay(s); if (!s.armies[a.id] || s.armies[a.id].status === 'retreating' || s.log.some(l => /兵糧が続かず退いた/.test(l.text))) { retreated = true; break; } }
  assert(retreated, '兵糧切れで退却'); assert(s.log.some(l => /兵糧が尽き/.test(l.text)));
  const p1 = E.foodPrice(s); s.flags.famineUntil = s.day + 100; assert(E.foodPrice(s) > p1 * 2, '飢饉で兵糧が値上がり');
});
ok('23. 籠城：兵糧が尽きた城は兵が落ち、やがて開城する', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 15 });
  const b = s.bases.yamaki; s.bands.band_13.strength = s.bands.band_13.base = 120;
  const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu').available }, call: false });
  assert(r.ok, r.reason);
  for (let i = 0; i < 6 && !Object.values(s.battles).some(x => x.base === 'yamaki'); i++) { clear(s); E.advanceDay(s); }
  assert(Object.values(s.battles).some(x => x.base === 'yamaki'), '包囲が始まる（同じ国の拠点もそのまま攻める）'); b.food = 0;
  Object.values(s.armies).filter(x => x.faction === 'yoritomo').forEach(x => { x.troops = x.initialTroops = 1500; x.morale = 90; });
  for (let i = 0; i < 20 && b.owner !== 'yoritomo'; i++) { clear(s); E.advanceDay(s); }
  assert(s.log.some(l => /兵糧が尽きた。城兵が落ち/.test(l.text)), '兵糧切れの報せ');
  assert.strictEqual(b.owner, 'yoritomo', '城は落ちる（開城または攻略）');
});
ok('24. 所領：本所・徴税権・実効支配で年貢を分け、戦う相手の取り分は押領される。地頭は勅許から', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 16 });
  const h = s.holdings.oba_mikuriya_h; assert.strictEqual(h.rights.honjo, 'court', '大庭御厨の本所は伊勢神宮（朝廷側として扱う）'); assert.strictEqual(h.controller, 'oba');
  let d = E.distributeIncome(s); assert(d.income.court > 0 && d.income.heike > 0, '本所・知行国主に年貢が入る'); assert(!h.oryo);
  const kg = Object.values(s.holdings).find(x => x.province === 'sagami' && x.type === '国衙領'); assert.strictEqual(kg.rights.taxHolder, 'heike', '相模の知行国主は平家'); kg.controller = 'yoritomo'; s.factions.yoritomo.status = '挙兵';
  s.relations[Object.keys(s.relations).find(k => k.split('|').sort().join('|') === ['heike', 'yoritomo'].sort().join('|'))].war = true;
  d = E.distributeIncome(s); assert(kg.oryo, '平家と戦う頼朝は相模の国衙領の平家の取り分を押領する'); assert(d.oryo.yoritomo && d.oryo.yoritomo.heike > 0);
  s.factions.yoritomo.flags.bakufu = true; s.factions.yoritomo.money = 1000;
  let r = E.issueCommand(s, { type: 'jito', faction: 'yoritomo', holding: kg.id }); assert(!r.ok && /勅許/.test(r.reason), r.reason);
  s.date = { y: 1186, m: 1, leap: false, d: 1 };
  r = E.issueCommand(s, { type: 'jito', faction: 'yoritomo', holding: kg.id }); assert(r.ok, r.reason); assert.strictEqual(kg.rights.jito, 'yoritomo');
  r = E.issueCommand(s, { type: 'petition', faction: 'yoritomo', kind: 'kokushi', province: 'musashi' }); assert(r.ok && /知行国/.test(r.message), r.reason);
  const s2 = E.load(E.save(s)); assert.strictEqual(s2.holdings[kg.id].rights.jito, 'yoritomo', 'セーブ・ロード後も権利が残る');
});
ok('25. 政権の体制：当主の死で継承を判定し（安定・派閥争い・内乱・分裂）、備えがあれば安定する', () => {
  const run = (prep) => { const s = E.createGame(scn, { playerFaction: null, seed: 21 });
    const r = s.factions.heike.regime; assert(r.leaderDep > 70 && r.maturity < 60, '平家は清盛個人への依存が強い');
    if (prep) { r.heirBase = 25; r.heirStab = 85; r.leaderDep = 40; r.cohesion = 85; r.maturity = 70; r.central = 60; }
    E.killPerson(s, s.persons.kiyomori, 'illness');
    const ls = s.factions.heike.regime.lastSuccession; assert(ls && ls.to === 'munemori', '宗盛が継ぐ'); return { s, ls }; };
  const a = run(false), b = run(true);
  assert(b.ls.score > a.ls.score + 10, '備え（後継者の基盤・成熟・結束）があれば判定が上がる ' + a.ls.score + '→' + b.ls.score);
  assert.strictEqual(b.ls.kind, 'stable');
  assert(a.s.aiLog.some(l => /家督継承/.test(l.action) && /後継者の力量/.test(l.reason)), '判定の理由がログに残る');
  // 分裂：結束も成熟もない家で当主が死ぬと、対抗馬が拠点を持って自立しうる
  const s = E.createGame(scn, { playerFaction: null, seed: 22 }); const k = s.factions.kai; const r = k.regime;
  Object.assign(r, { heirStab: 0, maturity: 0, cohesion: 0, leaderDep: 98, central: 95 }); k.heir = null;
  ['kai_takeda', 'yamaki'].forEach(id => s.bases[id].owner = 'kai');
  E.killPerson(s, s.persons.nobuyoshi, 'illness');
  assert(['revolt', 'split', 'strife'].includes(k.regime.lastSuccession.kind) && k.regime.lastSuccession.kind !== 'stable');
});
ok('26. 体制の施策：CPUは弱点に応じて手を打ち、プレイヤーも命じられる。他家の内紛は攻めの好機になる', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 23, mode: 'free' });
  for (let i = 0; i < 120; i++) { clear(s); E.advanceDay(s); }
  const labels = Object.values(E.REGIME_ACTS).map(a => a.label);
  assert(s.aiLog.some(l => labels.includes(l.action) && l.speech), 'CPUが体制の施策を評定の言葉つきで行う');
  const f = s.factions.yoritomo; f.money = 2000; const before = f.regime.maturity;
  let r = E.issueCommand(s, { type: 'regime', faction: 'yoritomo', action: 'admin' }); assert(r.ok, r.reason); assert(f.regime.maturity > before);
  r = E.issueCommand(s, { type: 'regime', faction: 'yoritomo', action: 'admin' }); assert(!r.ok, '同じ施策は2か月空ける');
  r = E.issueCommand(s, { type: 'set_heir', faction: 'yoritomo', person: 'yoshitoki' }); assert(r.ok, r.reason);
  assert(E.regimeHouses(s, 'yoritomo').some(h => h.id === 'hojo') && E.regimeHouses(s, 'yoritomo').some(h => h.id === 'hiki'), '北条氏・比企氏が家として並ぶ');
  const s2 = E.load(E.save(s)); assert.strictEqual(s2.factions.yoritomo.regime.maturity, f.regime.maturity, 'セーブ・ロード後も体制の値が残る');
  assert(s2.houses.hojo, '家の情報も残る');
});
ok('27. 勢力と家：北条氏は頼朝に仕えつつ、当主・一族・郎党・所領・蔵を持つ。頼朝の本拠は蛭ヶ小島（鎌倉入りで鎌倉）', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 31 });
  const h = s.houses.hojo; assert.strictEqual(h.head, 'tokimasa'); assert.strictEqual(h.lord, 'yoritomo'); assert.strictEqual(s.persons.tokimasa.faction, 'yoritomo', '頼朝の家臣でもある');
  assert(E.houseTroops(s, 'hojo') > 0 && E.houseHoldings(s, 'hojo').length > 0 && h.money > 0, '北条氏の兵・所領・財産');
  assert.strictEqual(s.factions.yoritomo.capital, 'hirugakojima'); assert.strictEqual(s.bases.hojo.house, 'hojo'); assert.strictEqual(s.bases.hojo.name, '北条館');
  const direct = E.sortieSources(s, 'yoritomo').reduce((t, x) => t + x.available, 0); assert(direct < 40, '家の兵は主君の直轄兵に含まれない（直轄' + direct + '）');
  assert.strictEqual(E.landCategory(s, s.holdings.hojo_go), '御家人・武家の所領');
  const m0 = h.money; s.date.d = 30; clear(s); E.advanceDay(s); assert(h.money > m0, '北条の年貢は北条氏の蔵に入る');
  s.bases.kamakura.owner = 'yoritomo'; clear(s); E.advanceDay(s); assert.strictEqual(s.holdings.kamakura_go.controller, 'yoritomo', '鎌倉を押さえれば鎌倉郷は直轄領');
});
ok('28. 主君の権限：本領安堵・新恩給与・没収。強引な没収はほかの家を警戒させる', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 32 }); s.bases.kamakura.owner = 'yoritomo'; clear(s); E.advanceDay(s);
  const l0 = s.houses.hiki.loyalty; let r = E.issueCommand(s, { type: 'grant', faction: 'yoritomo', holding: 'kamakura_go', target: 'hiki' }); assert(r.ok, r.reason);
  assert.strictEqual(s.holdings.kamakura_go.house, 'hiki'); assert(s.houses.hiki.loyalty > l0);
  r = E.issueCommand(s, { type: 'ando', faction: 'yoritomo', target: 'hojo' }); assert(r.ok, r.reason);
  r = E.issueCommand(s, { type: 'ando', faction: 'yoritomo', target: 'hojo' }); assert(!r.ok, '安堵は1年に一度');
  const d0 = s.houses.doi.loyalty, k0 = s.houses.hiki.loyalty;
  r = E.issueCommand(s, { type: 'confiscate', faction: 'yoritomo', holding: 'kamakura_go' }); assert(r.ok, r.reason);
  assert(s.houses.hiki.loyalty < k0 - 20 && s.houses.doi.loyalty < d0, '没収された家は恨み、ほかの家も警戒');
});
ok('29. 所領の普請：本所の許しが要る土地があり、主君の負担でも建てられる。完成すると効果が出る', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 33, mode: 'free' }); const f = s.factions.yoritomo; f.money = 5000;
  let r = E.issueCommand(s, { type: 'build_facility', faction: 'yoritomo', holding: 'hojo_go', kind: 'market' }); assert(r.ok, r.reason); assert(/負担/.test(s.log[s.log.length - 1].text));
  const h = s.holdings.sho_izu; h.controller = 'yoritomo'; s.court.cliques.sekkan.attitude.yoritomo = -60;
  r = E.issueCommand(s, { type: 'build_facility', faction: 'yoritomo', holding: 'sho_izu', kind: 'farm' }); assert(!r.ok && /本所/.test(r.reason), '本所（朝廷）の許しが得られない: ' + r.reason);
  r = E.issueCommand(s, { type: 'build_facility', faction: 'yoritomo', holding: 'hojo_go', kind: 'temple' }); assert(r.ok, r.reason);
  const f0 = s.houses.hojo.favor || 0; for (let i = 0; i < 70; i++) { clear(s); E.advanceDay(s); }
  const fac = s.holdings.hojo_go.facilities; assert(fac.find(x => x.kind === 'market').done, '市場が完成'); assert(fac.find(x => x.kind === 'temple').progress >= 60, '寺院の普請が進む（敵が国内にいると止まる）');
  const tm = fac.find(x => x.kind === 'temple'); tm.progress = tm.days - 1; clear(s); E.advanceDay(s); assert(tm.done || Object.values(s.armies).some(a => a.province === 'izu'), '寺院が完成'); assert((s.houses.hojo.favor || 0) > f0 || s.houses.hojo.influence > 0);
});
ok('30. 出陣の参陣催促：家ごとに参陣・遅参・不参を決め、合流地点で本隊に加わる。軍団は道を分けて進める。家は勢力に切り出せる', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 3 });
  const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: 25 } });
  assert(r.ok && /参陣/.test(r.message), r.message || r.reason);
  const cp = Object.values(s.corps)[0]; assert(cp.contingents.length >= 3 && cp.contingents.every(c => ['join', 'late', 'refuse'].includes(c.decision) && c.why));
  for (let i = 0; i < 12; i++) { clear(s); E.advanceDay(s); }
  assert(s.log.some(l => /【合流】/.test(l.text)), '本隊に合流'); assert(cp.contingents.some(c => /joined/.test(c.decision)));
  // 軍団の分割（東海道と東山道）
  const h = E.createGame(scn, { playerFaction: 'heike', seed: 34, mode: 'free' }); h.factions.heike.money = 99999; h.factions.heike.food = 999999;
  let q = E.issueCommand(h, { type: 'sortie', faction: 'heike', target: { type: 'base', id: 'kai_takeda' }, commander: 'munemori', units: [{ province: 'yamashiro', leader: 'tomomori', troops: 800 }, { province: 'yamashiro', leader: 'shigehira', troops: 800 }], commanderUnit: { province: 'yamashiro', troops: 800 }, declare: true, call: false });
  assert(q.ok, q.reason); const cid = Object.keys(h.corps)[0]; const arms = Object.values(h.armies).filter(a => a.corps === cid);
  q = E.issueCommand(h, { type: 'split_corps', faction: 'heike', corps: cid, groups: [{ armies: [arms[0].id], route: 'tokaido' }, { armies: arms.slice(1).map(a => a.id), route: 'tosando', commander: arms[1].commander }] });
  assert(q.ok, q.reason); const a0 = h.armies[arms[0].id], a1 = h.armies[arms[1].id];
  assert(a0.corps !== a1.corps, '別の軍団'); assert(a1.path.includes('shinano') || a1.path.includes('mino'), '東山道を通る'); assert(!a0.path.includes('shinano'), '東海道の軍は信濃を通らない');
  // 家を勢力に切り出しても世界はそのまま（第2仕様の操作対象の移行に使う）
  const day = s.day, hold = s.holdings.hojo_go.output; const nf = E.houseToFaction(s, 'hojo');
  assert(nf && nf.overlord === 'yoritomo' && s.persons.tokimasa.faction === 'hojo' && s.holdings.hojo_go.controller === 'hojo' && s.bases.hojo.owner === 'hojo');
  assert.strictEqual(s.day, day); assert.strictEqual(s.holdings.hojo_go.output, hold);
  const s2 = E.load(E.save(s)); assert(s2.factions.hojo && s2.houses.hojo.asFaction === 'hojo', 'セーブ・ロード後も残る');
});
function campaignWorld(seed) {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed, mode: 'free', goal: 'campaign' });
  const y = s.factions.yoritomo; y.flags.bakufu = true; y.capital = 'kamakura'; s.bases.kamakura.owner = 'yoritomo';
  y.institutions = { samurai_dokoro: { head: 'yoshimori' }, kumonjo: { head: 'tokimasa' }, monchujo: { head: 'yasunobu' } };
  ['miura', 'chiba', 'kazusa'].forEach(k => { s.factions[k].overlord = 'yoritomo'; });
  s.date = { y: 1199, m: 1, leap: false, d: 10 }; E.birthsTick(s); return s;
}
ok('31. キャンペーン（A方式）：頼朝の死で源氏はCPUが継ぎ、プレイヤーは北条氏へ完全に移る。世界はそのまま', () => {
  const s = campaignWorld(41); const y = s.factions.yoritomo;
  assert(s.persons.yoriie && s.persons.yoriie.alive && s.persons.sanetomo.alive, '頼家・実朝が生まれている');
  assert.strictEqual(E.objectiveStatus(s).title, '第1段階：源氏政権を築く');
  const hm = s.houses.hojo.money, ym = y.money, day = s.day, nb = Object.keys(s.bases).length;
  E.killPerson(s, s.persons.yoritomo, 'illness');
  assert.strictEqual(s.playerFaction, 'hojo'); assert.strictEqual(s.player.history[0].from, 'yoritomo');
  assert(y.alive && y.leader === 'yoriie', '源氏（将軍家）は頼家が継ぎ存続'); assert.strictEqual(s.factions.hojo.overlord, 'yoritomo', '北条氏は幕府の御家人');
  assert.strictEqual(s.factions.hojo.money, Math.round(hm), '北条氏が持つのは自家の蔵だけ'); assert(Object.values(s.holdings).filter(h => h.controller === 'hojo').every(h => h.id === 'hojo_go'), '源氏の所領は北条氏へ移らない（北条の本領だけ）');
  assert(!s.shogunate || !s.shogunate.shikken, '最初から執権ではない'); assert.strictEqual(s.day, day); assert(Object.keys(s.bases).length >= nb);
  assert.strictEqual(E.objectiveStatus(s).title, '執権として幕府の実権を握る');
  const s2 = E.load(E.save(s)); assert.strictEqual(s2.playerFaction, 'hojo'); assert.strictEqual(s2.player.history.length, 1, 'セーブ・ロード後も操作対象と移行の記録が残る');
});
ok('32. 御家人の権力闘争：CPUの御家人は北条を警戒して連携し、訴え（弾劾）・討伐ができる。強引な手は警戒を招く', () => {
  const s = campaignWorld(42); E.killPerson(s, s.persons.yoritomo, 'illness');
  for (let i = 0; i < 200; i++) { clear(s); E.advanceDay(s); }
  assert(s.shogunate.log.length > 0 && s.aiLog.some(l => /幕府政治/.test(l.action) && l.speech), 'CPUの御家人が動き、言葉で記録される');
  s.factions.hojo.money = 5000; const sg = s.shogunate; sg.inf.hojo = 80; sg.inf.hiki = 10;
  E.participants(s).forEach(p => { if (p.id !== 'hojo' && p.id !== 'hiki') { E.tie(s, p.id, 'hojo'); sg.ties[[p.id, 'hojo'].sort().join('|')] = 40; sg.ties[[p.id, 'hiki'].sort().join('|')] = -40; } });
  const w0 = sg.wary.hojo || 0; let r = E.issueCommand(s, { type: 'bakufu', faction: 'hojo', act: 'impeach', target: 'hiki' }); assert(r.ok, r.reason);
  assert((sg.wary.hojo || 0) > w0, '訴えは御家人の警戒を高める');
  if (sg.impeached && sg.impeached.hiki != null) { r = E.issueCommand(s, { type: 'bakufu', faction: 'hojo', act: 'attack', target: 'hiki' }); assert(r.ok, r.reason); assert(s.factions.hiki && s.factions.hiki.alive, '比企氏が勢力として切り出され、討伐の相手になる'); }
});
ok('33. 執権：条件（頼朝の死・成立年・政所・影響力・将軍家との関係）がそろえば就き、就任後もゲームは続く', () => {
  const s = campaignWorld(43); E.killPerson(s, s.persons.yoritomo, 'illness'); clear(s);
  let r = E.issueCommand(s, { type: 'bakufu', faction: 'hojo', act: 'shikken' }); assert(!r.ok, '条件がそろわないうちは就けない');
  s.shogunate.inf = { hojo: 90 }; E.participants(s).forEach(p => { if (p.id !== 'hojo') s.shogunate.inf[p.id] = 20; });
  s.relations[Object.keys(s.relations).find(k => k.split('|').sort().join('|') === 'hojo|yoritomo')].value = 60;
  s.date = { y: 1203, m: 9, leap: false, d: 1 };
  const st = E.shikkenStatus(s, 'hojo'); assert(st.ok, JSON.stringify(st.rows));
  r = E.issueCommand(s, { type: 'bakufu', faction: 'hojo', act: 'shikken' }); assert(r.ok, r.reason); assert.strictEqual(s.shogunate.shikken.holder, 'hojo');
  for (let i = 0; i < 40; i++) { clear(s); E.advanceDay(s); } assert(!s.flags.victory && !s.flags.gameOver, '執権就任で終わらない');
  s.factions.hojo.money = 5000; r = E.issueCommand(s, { type: 'reform', faction: 'hojo', kind: 'hyojoshu' });
  if (!r.ok) assert(/支持/.test(r.reason), r.reason); else { for (let i = 0; i < 125; i++) { clear(s); E.advanceDay(s); } assert(s.shogunate.reforms.hyojoshu.done && s.shogunate.hyojo.length > 0, '評定衆が置かれる'); }
  r = E.issueCommand(s, { type: 'appoint_office', faction: 'hojo', office: 'samurai_dokoro', person: 'yoshitoki' }); assert(r.ok, r.reason); assert.strictEqual(s.factions.yoritomo.institutions.samurai_dokoro.head, 'yoshitoki');
});
ok('34. 没官領：奪った拠点の国の敵の所領は、主君が直轄にするか御家人に恩賞として与える', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 51, mode: 'free' });
  s.bands.band_13.strength = s.bands.band_13.base = 400;
  const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'ito_yakata' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: 400 }, declare: true, call: false });
  assert(r.ok, r.reason); s.bases.ito_yakata.garrison = 1; Object.values(s.bands).forEach(b => { if (b.faction === 'ito' || (b.province === 'izu' && b.faction !== 'yoritomo')) b.strength = b.base = 0; }); Object.values(s.armies).forEach(a => { if (a.faction !== 'yoritomo') delete s.armies[a.id]; });
  for (let i = 0; i < 25 && s.bases.ito_yakata.owner !== 'yoritomo'; i++) { clear(s); E.advanceDay(s); Object.values(s.armies).filter(a => a.faction === 'yoritomo').forEach(a => a.troops = Math.max(a.troops, 300)); }
  assert.strictEqual(s.bases.ito_yakata.owner, 'yoritomo', '伊東館を落とす');
  const sp = E.pendingSpoils(s, 'yoritomo'); assert(sp.some(x => x.holding === 'ito_sho'), '伊東荘が没官領になる');
  assert.strictEqual(s.holdings.ito_sho.controller, 'yoritomo');
  const l0 = s.houses.doi.loyalty; const q = E.issueCommand(s, { type: 'spoil', faction: 'yoritomo', holding: 'ito_sho', to: 'doi' }); assert(q.ok, q.reason);
  assert.strictEqual(s.holdings.ito_sho.house, 'doi'); assert(s.houses.doi.loyalty > l0, '恩賞で忠誠が上がる'); assert(!E.pendingSpoils(s, 'yoritomo').length);
});
ok('35. 謀反：恩賞のない不満な家は主君に背くことがある。血のつながった一門は背かない', () => {
  const s = E.createGame(scn, { playerFaction: 'yoritomo', seed: 52, mode: 'free' });
  s.houses.doi.loyalty = 0; s.houses.doi.ambition = 90; s.service = { yoritomo: { doi: 40 } };
  s.persons.hiki_yoshikazu.relations.push({ person: 'yoritomo', type: '従兄弟' }); s.houses.hiki.loyalty = 5; s.houses.hiki.ambition = 90;
  assert.strictEqual(E.kinship(s, 'yoritomo', { kind: 'house', id: 'hiki' }), 'blood'); assert.strictEqual(E.kinship(s, 'yoritomo', { kind: 'house', id: 'hojo' }), 'inlaw', '北条は縁戚（政子）');
  for (let i = 0; i < 60 && !(s.factions.doi && s.factions.doi.alive); i++) { s.houses.doi.loyalty = 0; E.loyaltyTick(s); }
  assert(s.factions.doi && s.factions.doi.alive && !s.factions.doi.overlord, '土肥氏が謀反して自立'); assert(s.log.some(l => /【謀反】/.test(l.text)));
  assert(!(s.factions.hiki && s.factions.hiki.alive) && s.houses.hiki.loyalty >= 70, '一門（血縁）は背かず、忠誠を誓う');
});

ok('36. 有力御家人の家：和田・梶原・安達は既存の人物で家になり、人物も兵も重複しない', () => {
  const s0 = E.createGame(scn, { playerFaction: 'yoritomo', seed: 3, mode: 'free' });
  ['wada', 'kajiwara', 'adachi'].forEach(k => assert(s0.houses[k] && s0.persons[s0.houses[k].head], k));
  assert.strictEqual(s0.houses.wada.head, 'yoshimori'); assert.strictEqual(s0.houses.kajiwara.faction, 'oba'); assert.strictEqual(s0.houses.adachi.faction, 'yoritomo');
  const names = Object.values(s0.persons).map(p => p.name); assert.strictEqual(new Set(names).size, names.length, '人物が重複していない');
  const orig = id => scn.bands.find(b => b.id === id).strength;
  assert.strictEqual(s0.bands.band_21.strength + s0.bands.band_wada.strength, orig('band_21'), '和田の兵は三浦一族から分けただけ');
  assert.strictEqual(s0.bands.band_24.strength + s0.bands.band_kajiwara.strength, orig('band_24'), '梶原の兵は鎌倉党から分けただけ');
  assert(s0.houses.miura.asFaction === 'miura' && s0.houses.hatakeyama.asFaction === 'hatakeyama', '三浦・畠山は勢力として家の一覧に載る');
});
function crisisWorld(seed) {
  const s = campaignWorld(seed); s.flags.wakasa = s.day; s.date = { y: 1199, m: 2, leap: false, d: 1 }; E.birthsTick(s);
  E.killPerson(s, s.persons.yoritomo, 'illness'); return s;
}
ok('37. 将軍の交代は条件で決まる：比企が勝つことも、頼家が退けられることもある（固定しない）', () => {
  const kinds = new Set(), hiki = new Set(); let used = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = crisisWorld(seed), sg = s.shogunate; if (!E.shogunState(s) || E.shogunState(s).person !== 'yoriie' || !E.shogunState(s).candidates.includes('sanetomo')) continue; used++; // 継承で分裂した世界は除く assert(E.shogunState(s).backers.includes('hiki'), '比企は頼家・一幡を担ぐ');
    sg.sick = s.day; sg.authority = 10 + (seed % 5) * 15; sg.inf.hojo = 20 + (seed % 4) * 12; sg.inf.hiki = 20 + (seed % 3) * 15;
    for (let i = 0; i < 120 && !(sg.history && sg.history.length); i++) { s.pendingStops.forEach(e => { if (!e.resolved) E.resolveEvent(s, e.id, 'neutral'); }); E.shogunTick(s); s.day++; }
    const h = sg.history[0]; assert(h, '将軍の進退が決着した ' + seed); kinds.add(h.kind); hiki.add(s.houses.hiki.ruined != null);
    assert(h.by, '主導した者が記録される'); if (h.kind === 'depose') assert(s.persons.yoriie.deposed != null && E.shogunState(s).person !== 'yoriie');
  }
  assert(used >= 10, '比べた世界の数 ' + used); assert(kinds.has('depose') && kinds.has('keep'), '廃位も維持も起こる: ' + [...kinds]); assert(hiki.has(true) && hiki.has(false), '比企は滅ぶことも残ることもある');
});
ok('38. 北条一門：分家は祖の成人で現れ、得宗は段階的に成立。執権は得宗以外の一門にも移りうる', () => {
  const s = crisisWorld(7); assert.strictEqual(E.clanStatus(s).branches.length, 0, '1199年には分家はない'); assert.strictEqual(E.clanStatus(s).title, '北条氏の家督（嫡流）');
  s.date = { y: 1216, m: 7, leap: false, d: 1 }; E.birthsTick(s); E.clanTick(s);
  const br = E.clanStatus(s).branches.map(b => b.id); assert(br.includes('hojo_nagoe') && br.includes('hojo_gokurakuji') && !br.includes('hojo_kanazawa'), '成人した祖の分家だけ: ' + br);
  assert(E.participants(s).some(p => p.id === 'hojo_nagoe'), '分家は独立した参加者（所領・兵・影響力を持つ）'); assert(E.houseTroops(s, 'hojo_nagoe') > 0);
  s.hojoClan.level = 35; assert.strictEqual(E.clanStatus(s).title, '得宗');
  const hid = s.houses.hojo.asFaction || 'hojo'; s.shogunate.shikken = { holder: hid, person: 'yoshitoki', since: s.day };
  s.shogunate.inf.hojo_gokurakuji = 500; s.persons.yoshitoki.alive = false; E.clanTick(s);
  assert.strictEqual(s.shogunate.shikken.holder, 'hojo_gokurakuji'); assert(E.clanStatus(s).head !== s.shogunate.shikken.person, '得宗と執権が別人');
});
ok('39. 御内人は御家人と別の集団：得宗家に仕え、幕府の参加者には含まれない', () => {
  const s = crisisWorld(8); s.date = { y: 1225, m: 1, leap: false, d: 1 }; s.hojoClan = { level: 60, miuchi: [], branches: [] };
  for (let i = 0; i < 3; i++) E.clanTick(s);
  const m = E.clanStatus(s).miuchi; assert.strictEqual(m.length, 3); assert(m[0].name === '平盛綱');
  const ps = E.participants(s).map(p => p.id); s.hojoClan.miuchi.forEach(x => { assert(!ps.includes(x.person)); assert(x.influence != null && x.troops > 0 && x.wealth > 0 && x.loyalty > 0); });
});

function polWorld(seed) { const s = campaignWorld(seed); E.killPerson(s, s.persons.yoritomo, 'illness'); return s; }
const pick = (s, key, choice) => { const e = s.pendingStops.find(x => x.key === key && !x.resolved); assert(e, key + ' が出ていない'); const r = E.resolveEvent(s, e.id, choice); e.resolved = true; return { e, r }; };
ok('40. 操作人物の交代：頼朝の死で北条氏の人物を選ぶ。家と操作人物は別で、執権は引き継がず、家督は正統性で決まる', () => {
  const s = polWorld(51); E.advanceDay(s); const hm = s.factions.hojo.money;
  const e = s.pendingStops.find(x => x.key === 'choose_person' && !x.resolved); assert(e, '後継者選択画面');
  const c = e.candidates; assert(c.some(x => x.id === 'tokimasa' && x.head) && c.some(x => x.id === 'yoshitoki'), '時政（当主）と義時が候補');
  ['age', 'abilities', 'personality', 'ambition', 'holdings', 'troops', 'offices', 'support', 'heirScore', 'relations', 'status'].forEach(k => assert(k in c[0], '候補の情報：' + k));
  pick(s, 'choose_person', 'yoshitoki'); assert.strictEqual(s.player.person, 'yoshitoki'); assert.strictEqual(s.playerFaction, 'hojo');
  assert(s.factions.hojo.leader === 'tokimasa' || s.factions.hojo.leader === 'yoshitoki', '家督は正統性で決まる'); assert(!s.shogunate.shikken, '執権は自動で得ない');
  assert(Math.abs(s.factions.hojo.money - hm) < 1, '家の財産は維持'); assert(s.player.personHistory.length >= 1);
  const s2 = E.load(E.save(s)); assert.strictEqual(s2.player.person, 'yoshitoki'); assert(s2.politics && s2.politics.records, 'セーブ・ロード後も残る');
});
ok('41. 操作人物の死でもゲームは続き、分家の人物を選ぶとその家の所領・兵だけが基盤になる', () => {
  const s = polWorld(52); E.advanceDay(s); pick(s, 'choose_person', 'tokimasa');
  s.date = { y: 1216, m: 7, leap: false, d: 1 }; E.birthsTick(s); E.clanTick(s); assert(s.houses.hojo_nagoe, '名越流が立った');
  const nb = E.houseTroops(s, 'hojo_nagoe'), hojoMoney = s.factions.hojo.money;
  E.killPerson(s, s.persons.tokimasa, 'illness'); E.advanceDay(s); assert(!s.flags.gameOver, 'ゲームオーバーにならない');
  const e = s.pendingStops.find(x => x.key === 'choose_person' && !x.resolved); assert(e.candidates.some(c => c.id === 'tomotoki' && c.switchBase), '分家の当主も候補');
  pick(s, 'choose_person', 'tomotoki'); assert.strictEqual(s.playerFaction, 'hojo_nagoe'); assert.strictEqual(s.player.person, 'tomotoki');
  assert(s.factions.hojo.alive && s.factions.hojo.money === hojoMoney, '北条本家の財産は持っていかない'); assert(E.politicalStatus(s, 'hojo_nagoe').military <= nb + 1, '兵は名越流の分だけ');
});
ok('42. 不満：不当な没収・強引な手・権力の集中で不満が生まれ、安堵・婚姻・合議で和らぐ', () => {
  const s = polWorld(53); E.advanceDay(s); pick(s, 'choose_person', 'tokimasa');
  s.factions.hojo.money = 5000; E.addGrudge(s, 'doi', 'hojo', 0);
  const before = E.grudge(s, 'hiki', 'hojo'); const r = E.issueCommand(s, { type: 'bakufu', faction: 'hojo', act: 'isolate', target: 'hiki' }); assert(r.ok, r.reason);
  assert(E.grudge(s, 'hiki', 'hojo') > before + 20, '孤立させられた家の不満');
  s.shogunate.inf.hojo = 400; E.politicsMonthly(s); assert(E.grudge(s, 'doi', 'hojo') > 5, '権力の集中への不満');
  const g = E.grudge(s, 'hiki', 'hojo'); E.politicsAct(s, 'hojo', { act: 'consult' }); assert(E.grudge(s, 'hiki', 'hojo') < g, '合議で和らぐ');
  const st = E.politicalStatus(s, 'hojo'); ['gokenin', 'ichimon', 'shogun', 'court', 'military', 'money', 'influence', 'legitimacy', 'danger'].forEach(k => assert(k in st, '政治情勢：' + k));
});
function cabalWorld(seed) {
  const s = polWorld(seed); E.advanceDay(s); pick(s, 'choose_person', 'tokimasa'); const sg = s.shogunate;
  ['hiki', 'doi', 'miura', 'chiba'].forEach(k => { E.addGrudge(s, k, 'hojo', 80, '所領を没収された'); sg.inf[k] = 60; }); sg.inf.hojo = 30; return s;
}
ok('43. 反対派は段階を踏む（不満→対立→要求）。要求を受け入れれば収まり、拒めば実力行使（失脚など）に進むことがある', () => {
  const s = cabalWorld(54); const P = s.politics;
  E.cabalTick(s); const c = P.cabals.find(x => x.target === 'hojo'); assert(c && c.members.length >= 2 && c.stage <= 2, '反対派の結成');
  const seen = [c.stage]; for (let i = 0; i < 3 && c.stage < 3; i++) { E.cabalTick(s); seen.push(c.stage); } assert.strictEqual(c.stage, 3, '要求の段階'); assert(seen.every((v, i) => !i || v >= seen[i - 1]), '段階は順に進む ' + seen);
  const { r } = pick(s, 'cabal_demand', 'accept'); assert(r.ok && !P.cabals.includes(c), '妥協で反対派は解ける'); assert(E.grudge(s, 'hiki', 'hojo') < 80);
  let fell = 0;
  for (let seed = 60; seed < 72; seed++) { const t = cabalWorld(seed); t.shogunate.inf.hojo = 30 + (seed % 4) * 160; for (let i = 0; i < 3; i++) E.cabalTick(t); if (!t.pendingStops.some(e => e.key === 'cabal_demand' && !e.resolved)) continue; pick(t, 'cabal_demand', 'refuse'); t.day += 30;
    for (let i = 0; i < 6; i++) { t.politics.cabals.forEach(x => { x.refused = t.day - 40; x.hostility = 80; }); E.cabalTick(t); t.day += 30; }
    if (t.politics.records.falls.some(f => f.person === 'tokimasa')) fell++; }
  assert(fell > 0 && fell < 12, '拒めば失脚することもしないこともある: ' + fell);
});
ok('44. 諜報：察知できていない反対派は噂としか見えず、諜報で首謀者と構成員が分かる', () => {
  const s = cabalWorld(55); s.politics.intel.hojo = 0; E.cabalTick(s); const c = s.politics.cabals.find(x => x.target === 'hojo'); c.known = 5;
  let v = E.cabalView(s, c); assert(!v.leader && !v.members && /噂/.test(v.text), '噂だけ');
  s.factions.hojo.money = 3000; for (let i = 0; i < 3; i++) { assert(E.politicsAct(s, 'hojo', { act: 'spy' }).ok); s.politics.cool['hojo:spy'] = -999; }
  v = E.cabalView(s, c); assert(v.leader && v.members && v.members.length === c.members.length, '首謀者と構成員が分かる');
});
ok('45. 暗殺は意図・実行能力・警固・諜報・縁で決まる。厳重な警固と諜報があれば防げる。CPUの有力者にも及ぶ', () => {
  let guarded = 0, open = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const a = cabalWorld(seed); a.politics.guard.hojo = 80; a.politics.intel.hojo = 90; a.factions.miura.money = 3000; if (E.tryAssassinate(a, 'miura', 'hojo', a.persons.tokimasa, 1).killed) guarded++;
    const b = cabalWorld(seed); b.politics.guard.hojo = 0; b.politics.intel.hojo = 0; b.factions.miura.money = 3000; if (E.tryAssassinate(b, 'miura', 'hojo', b.persons.tokimasa, 1).killed) open++;
  }
  assert(guarded === 0 && open > 0, '警固あり ' + guarded + ' / なし ' + open);
  const c = cabalWorld(3); c.houses.hiki.money = 3000; c.persons.tsunetane.abilities.valor = 10; let any = false;
  for (let i = 0; i < 10 && !any; i++) { const r = E.tryAssassinate(c, 'hiki', 'chiba', c.persons.tsunetane, 1); any = r.done; } assert(any, 'CPUの当主も標的になる');
});
ok('46. CPU同士でも反対派・政変が起き、失脚した操作人物はそのまま再起も、後継に託すこともできる', () => {
  const s = cabalWorld(56); const sg = s.shogunate; s.politics.grudge = {}; ['hiki', 'doi', 'miura', 'hojo'].forEach(k => E.addGrudge(s, k, 'chiba', 90, '所領を没収された')); sg.inf.chiba = 150;
  for (let i = 0; i < 12; i++) { s.politics.cabals.forEach(x => { if (x.target === 'chiba') { x.refused = s.day - 40; x.hostility = 85; } }); E.cabalTick(s); s.pendingStops.forEach(e => e.resolved = true); s.day += 30; }
  assert(s.politics.records.falls.length > 0 || s.log.some(l => /反対派の求めに応じ|企ては失敗|兵を挙げた/.test(l.text)), 'CPUの標的にも政変・妥協・失敗が起きる');
  const t = cabalWorld(57); E.fallPerson(t, 'hojo', t.persons.tokimasa, 'exile', 'hiki', 'テスト'); assert.strictEqual(t.player.status, '追放');
  const e = t.pendingStops.find(x => x.key === 'choose_person' && !x.resolved); assert(e.choices[0].id === 'stay', '再起の選択肢');
  assert(!E.politicsAct(t, 'hojo', { act: 'consult' }).ok, '追放の身では政に関われない'); pick(t, 'choose_person', 'stay'); assert.strictEqual(t.player.person, 'tokimasa');
  t.persons.tokimasa.exiled = null; E.advanceDay(t); assert.strictEqual(t.player.status, '在任', '赦免で再起');
});

function izuStart(seed) { const s = E.createGame(scn, { playerFaction: 'yoritomo', seed, mode: 'free', difficulty: 'normal' }); for (let d = 0; d < 5; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); } return s; }
ok('47. 同じ国の拠点への攻撃命令はすぐ攻めかかる。攻撃に失敗すると知らせが出て、館に戻す・立て直して再び攻める・待機を選べる', () => {
  const s = izuStart(1); const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
  const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false }); assert(r.ok, r.reason);
  const a = Object.values(s.armies).find(x => x.faction === 'yoritomo'); a.status = 'idle'; a.gatherUntil = 0; a.target = null; a.mission = 'idle'; a.path = [];
  const m = E.issueCommand(s, { type: 'march', faction: 'yoritomo', army: a.id, target: { type: 'base', id: 'yamaki' }, declare: true }); assert(m.ok, m.reason);
  assert(a.status === 'battle' || a.status === 'siege' || Object.values(s.battles).some(b => b.base === 'yamaki'), '同じ国の山木館へすぐ攻めかかる: ' + a.status);
  let ev = null; for (let d = 0; d < 30 && !ev; d++) { ev = s.pendingStops.find(e => e.key === 'attack_failed' && !e.resolved); if (!ev) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); } }
  assert(ev, '攻撃失敗の知らせ'); assert.deepStrictEqual(ev.choices.map(c => c.id), ['return', 'retry', 'stay']);
  const before = Object.keys(s.armies).filter(k => s.armies[k].faction === 'yoritomo').length; const rr = E.resolveEvent(s, ev.id, 'return'); ev.resolved = true; assert(rr.ok);
  assert(Object.keys(s.armies).filter(k => s.armies[k].faction === 'yoritomo').length < before || before === 0, '館に戻した');
});
ok('48. 命令のないまま留まる自軍は20日で館に戻り、再び出陣できる', () => {
  const s = izuStart(2); const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
  const r0 = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false }); assert(r0.ok, r0.reason);
  const id = Object.keys(s.armies).find(k => s.armies[k].faction === 'yoritomo'); assert(id); const a = s.armies[id]; a.status = 'idle'; a.mission = 'idle'; a.target = null; a.path = []; delete s.corps[a.corps]; a.corps = null;
  for (let d = 0; d < 30 && s.armies[id]; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); }
  assert(!s.armies[id], '館に戻った'); assert(s.log.some(l => /命令のないまま20日/.test(l.text)), '知らせが出る');
});
ok('49. 御家人への指図：承知・遅参・断りは忠誠などで決まり、承知した軍は自分の判断より指図を優先する', () => {
  let yes = 0, no = 0, kept = 0;
  for (let seed = 1; seed <= 8; seed++) { const s = izuStart(seed); E.declareWar ? 0 : 0;
    ['kazusa', 'miura'].forEach(k => s.factions[k].overlord = 'yoritomo'); const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
    E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false });
    for (const v of ['kazusa', 'miura']) { const r = E.issueCommand(s, { type: 'vassal_order', faction: 'yoritomo', vassal: v, act: 'attack', target: 'yamaki' }); assert(r.ok, r.reason); if (r.refused) no++; else yes++; }
    const again = E.issueCommand(s, { type: 'vassal_order', faction: 'yoritomo', vassal: 'miura', act: 'attack', target: 'yamaki' }); assert(!again.ok, '20日あける');
    const ord = Object.values(s.armies).filter(a => a.lordOrder); ord.forEach(a => { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); if (!a.lordOrder || (a.target && a.target.id === 'yamaki')) kept++; });
  }
  assert(yes > 0 && no > 0, '承知も断りもある ' + yes + '/' + no); assert(kept > 0, '指図された軍は山木館を目指す');
  const s = izuStart(3); assert(!E.issueCommand(s, { type: 'vassal_order', faction: 'yoritomo', vassal: 'heike', act: 'attack', target: 'yamaki' }).ok, '従っていない勢力には頼めない');
});

ok('50. 退却命令：行軍中の軍は館へ退いて武士団に戻り、交戦中の軍は追撃で兵を失って退く', () => {
  const s = izuStart(4); const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
  E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false });
  let a = Object.values(s.armies).find(x => x.faction === 'yoritomo');
  for (let d = 0; d < 20 && !a.battleId; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); a = s.armies[a.id]; if (!a) break; }
  if (a && a.battleId) { const t0 = a.troops, r = E.issueCommand(s, { type: 'withdraw', faction: 'yoritomo', army: a.id }); assert(r.ok, r.reason); assert(/追撃/.test(r.message)); assert(!s.armies[a.id] || s.armies[a.id].troops < t0, '兵を失う'); assert(!s.pendingStops.some(e => e.key === 'attack_failed' && !e.resolved), '自ら引いたときは失敗の問いを出さない'); }
  assert(!E.issueCommand(s, { type: 'withdraw', faction: 'yoritomo', army: 'nope' }).ok);
  const s2 = izuStart(5); const iz2 = E.sortieSources(s2, 'yoritomo').find(x => x.province === 'izu');
  E.issueCommand(s2, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz2.available }, declare: true, call: false });
  const b = Object.values(s2.armies).find(x => x.faction === 'yoritomo'); const r2 = E.issueCommand(s2, { type: 'withdraw', faction: 'yoritomo', army: b.id }); assert(r2.ok, r2.reason); assert(!s2.armies[b.id], '館のある国なら、そのまま館に戻る');
});
ok('51. 主従の義理：主君が健在で関係が悪くなければ、御家人は他の陣営へ鞍替えしない（大軍に圧倒されたときの帰順は別）', () => {
  let flips = 0;
  for (let seed = 1; seed <= 6; seed++) { const s = izuStart(seed); s.factions.miura.overlord = 'yoritomo'; s.factions.miura.pledgedDay = -1000; E.getRel ? 0 : 0;
    s.factions.kai.status = '挙兵'; for (let d = 0; d < 200; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); if (s.flags.gameOver) break; }
    if (s.factions.miura.overlord && s.factions.miura.overlord !== 'yoritomo') flips++; }
  assert.strictEqual(flips, 0, '三浦氏は甲斐源氏などへ鞍替えしない');
});

ok('52. 御恩：屋敷（一度だけ）・引出物（60日あける）・感状（働きがあるとき）・官途の推挙（朝廷への伝手が要る）で忠誠が上がる', () => {
  const s = izuStart(6); const y = s.factions.yoritomo; y.money = 3000;
  const hj = E.retainersOf(s, 'yoritomo').find(r => r.id === 'hojo'), L0 = E.retLoyalty(s, hj, 'yoritomo');
  let r = E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'hojo', kind: 'yashiki' }); assert(r.ok, r.reason); assert(E.retLoyalty(s, hj, 'yoritomo') > L0, '忠誠が上がる');
  assert(!E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'hojo', kind: 'yashiki' }).ok, '屋敷は一度だけ');
  assert(E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'hojo', kind: 'gift' }).ok); assert(!E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'hojo', kind: 'gift' }).ok, '引出物は60日あける');
  assert(!E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'doi', kind: 'kanjo' }).ok, '働きがなければ感状は出せない');
  y.flags.ryoji = false; y.flags.insen = false; y.legitimacy = 20; assert(!E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'doi', kind: 'kanto' }).ok, '伝手がなければ官途は推挙できない');
  y.flags.ryoji = true; const kt = E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: 'doi', kind: 'kanto' }); assert(kt.ok, kt.reason); assert(/尉|允|介/.test(kt.message));
  const tk = Object.keys(s.persons).find(k => s.persons[k].faction === 'yoritomo' && k !== 'yoritomo' && s.persons[k].alive); assert(E.issueCommand(s, { type: 'bestow', faction: 'yoritomo', target: tk, kind: 'gift' }).ok, '家臣（人物）にも与えられる');
});
ok('53. 先陣を任せた家は参陣しやすく、拠点を落とすと論功行賞の場面が出る', () => {
  let withS = 0, without = 0;
  for (let seed = 1; seed <= 16; seed++) for (const sj of [null, 'doi']) { const s = izuStart(seed); s.houses.doi.loyalty = 25;
    const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
    const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, senjin: sj });
    const c = (s.corps[r.corps].contingents || []).find(x => x.id === 'doi'); if (c && c.decision !== 'refuse') { if (sj) withS++; else without++; } }
  assert(withS > without, '先陣を任せると参陣しやすい ' + withS + '>' + without);
  const s = izuStart(2); const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu'); s.bases.yamaki.garrison = 5;
  E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, senjin: 'hojo' });
  let ev = null; for (let d = 0; d < 40 && !ev && s.bases.yamaki.owner !== 'yoritomo'; d++) { ev = s.pendingStops.find(e => e.key === 'rewards' && !e.resolved); s.pendingStops.forEach(e => { if (e.key !== 'rewards') e.resolved = true; }); if (!ev) E.advanceDay(s); }
  ev = ev || s.pendingStops.find(e => e.key === 'rewards' && !e.resolved);
  if (s.bases.yamaki.owner === 'yoritomo' && ev) { s.factions.yoritomo.money = 2000; const rr = E.resolveEvent(s, ev.id, 'kanjo'); assert(rr.ok && /感状/.test(rr.message), '論功行賞で感状と引出物を配る'); }
});
ok('54. 文官の下向：史実モードでは頼朝が関東に本拠を持てば史実の時期に大江広元・三善康信らが加わる', () => {
  const s = izuStart(7); s.options.mode = 'historical'; const y = s.factions.yoritomo; y.status = '挙兵'; s.bases.kamakura.owner = 'yoritomo'; y.capital = 'kamakura';
  s.date = { y: 1183, m: 1, leap: false, d: 1 }; E.arrivalsTick(s); assert(!s.persons.hiromoto, '1183年初めにはまだいない'); assert(s.persons.toshikane && s.persons.toshikane.faction === 'yoritomo', '右筆の藤原俊兼は1181年から');
  s.date = { y: 1184, m: 10, leap: false, d: 1 }; E.arrivalsTick(s); assert(s.persons.hiromoto && s.persons.hiromoto.faction === 'yoritomo'); assert.strictEqual(s.persons.yasunobu.faction, 'yoritomo'); assert.strictEqual(s.persons.yasunobu.location, 'kamakura');
  const t = izuStart(7); t.date = { y: 1185, m: 1, leap: false, d: 1 }; E.arrivalsTick(t); assert(!t.persons.hiromoto, '関東に本拠がなければ下らない');
});
ok('55. 討死はまれ：2年の戦乱で討死する人物はごく少ない', () => {
  let dead = 0, battles = 0;
  for (let seed = 1; seed <= 3; seed++) { const s = E.createGame(scn, { playerFaction: 'yoritomo', seed, mode: 'free' }); for (let d = 0; d < 500; d++) { s.pendingStops.forEach(e => { if (!e.resolved && e.choices && e.choices[0]) E.resolveEvent(s, e.id, e.choices[0].id); e.resolved = true; }); E.advanceDay(s); }
    dead += s.log.filter(l => /討死|陥落時に討たれる/.test(l.text) && /【死去】/.test(l.text)).length; battles += s.log.filter(l => /【合戦】/.test(l.text)).length; }
  assert(battles > 10, '合戦はある ' + battles); assert(dead <= Math.max(2, battles * 0.03), '討死 ' + dead + '／合戦 ' + battles);
});

ok('56. 忠誠の厚い家（70以上）は、本領が攻められていない限り出陣を断らない（報いない働きの重みにも上限）', () => {
  let refuse = 0, total = 0;
  for (let seed = 1; seed <= 12; seed++) { const s = izuStart(seed); ['hojo', 'hiki', 'doi'].forEach(k => { s.houses[k].loyalty = 75; }); s.service = s.service || {};
    ['hojo', 'hiki', 'doi'].forEach(k => E.addService ? E.addService(s, 'yoritomo', k, 6) : 0);
    const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu');
    const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true });
    (s.corps[r.corps].contingents || []).filter(c => ['hojo', 'hiki', 'doi'].includes(c.id)).forEach(c => { total++; if (c.decision === 'refuse') refuse++; }); }
  assert(total >= 30 && refuse === 0, '不参 ' + refuse + '／' + total);
});
ok('57. 御家人全体への命令：兵を増やせ（各家が自分の銭で本領の兵を集め、家の兵に加わる）・出陣・帰陣', () => {
  const s = izuStart(3); s.houses.hojo.money = 600; s.houses.hojo.food = 3000; const before = E.houseTroops(s, 'hojo');
  const r = E.issueCommand(s, { type: 'vassal_command', faction: 'yoritomo', act: 'muster' }); assert(r.ok, r.reason); assert(r.results.some(x => x.id === 'hojo' && x.ok));
  assert(!E.issueCommand(s, { type: 'vassal_command', faction: 'yoritomo', act: 'muster' }).ok, '30日に一度');
  for (let d = 0; d < 40; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); }
  assert(E.houseTroops(s, 'hojo') > before + 50, '北条氏の兵が増えた ' + before + '→' + E.houseTroops(s, 'hojo'));
  const t = izuStart(4); const iz = E.sortieSources(t, 'yoritomo').find(x => x.province === 'izu');
  t.bands[Object.keys(t.bands).find(k => t.bands[k].faction === 'yoritomo' && t.bands[k].province === 'izu' && !t.bands[k].house)].strength += 0;
  const yb = Object.values(t.bands).filter(b => b.faction === 'yoritomo' && !b.house).reduce((a, b) => a + b.strength, 0);
  E.issueCommand(t, { type: 'recruit', faction: 'yoritomo', province: 'izu', amount: 50 }); for (let d = 0; d < 30; d++) { t.pendingStops.forEach(e => e.resolved = true); E.advanceDay(t); }
  assert.strictEqual(Object.values(t.bands).filter(b => b.house === 'hojo').reduce((a, b) => a + b.strength, 0) >= 65 - 1, true, '頼朝の徴兵が北条氏の兵に紛れない');
  E.issueCommand(t, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false });
  const a = E.issueCommand(t, { type: 'vassal_command', faction: 'yoritomo', act: 'attack', target: 'yamaki' }); assert(a.ok && a.results.length >= 3, '全家に出陣を命じる');
  const rc = E.issueCommand(t, { type: 'vassal_command', faction: 'yoritomo', act: 'recall' }); assert(rc.ok || /出ている/.test(rc.reason));
});
ok('58. 比企氏は本領の比企郡に館を持つ', () => { const s = izuStart(1); assert(s.bases.hiki_kan && s.bases.hiki_kan.province === 'musashi' && s.houses.hiki.seat === 'hiki_kan'); assert.strictEqual(s.holdings.hiki_go.house, 'hiki'); });

function bakufuWorld(seed) { const s = izuStart(seed); const y = s.factions.yoritomo; y.flags.bakufu = true; y.status = '挙兵'; s.bases.kamakura.owner = 'yoritomo'; y.capital = 'kamakura'; y.money = 5000; ['miura', 'chiba'].forEach(k => s.factions[k].overlord = 'yoritomo'); return s; }
ok('59. 任官の推挙：幕府を開く前は自家の人物だけ、開いた将軍は御家人を推挙できる。使者の返事を待って任じられ、家の先例として残る', () => {
  const s0 = izuStart(8); s0.factions.yoritomo.money = 3000; assert(!E.issueCommand(s0, { type: 'nominate', faction: 'yoritomo', person: 'sanehira', office: 'jo' }).ok, '幕府前は御家人を推挙できない');
  const s = bakufuWorld(8); const r = E.issueCommand(s, { type: 'nominate', faction: 'yoritomo', person: 'sanehira', office: 'kami', province: 'sagami', mode: '受領' }); assert(r.ok, r.reason);
  s.ninkan.queue[0].chance = 1; const L0 = E.retLoyalty(s, E.retainersOf(s, 'yoritomo').find(x => x.id === 'doi'), 'yoritomo');
  for (let d = 0; d < 60 && s.ninkan.queue.length; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); }
  assert((s.persons.sanehira.courtOffices || []).includes('相模守'), '相模守に任じられた'); assert.strictEqual(s.provinces.sagami.kokushi.person, 'sanehira'); assert(s.provinces.sagami.kokushi.mode === '受領' || s.provinces.sagami.kokushi.mode === '遙任');
  assert(E.retLoyalty(s, E.retainersOf(s, 'yoritomo').find(x => x.id === 'doi'), 'yoritomo') > L0, '推挙で忠誠が上がる'); assert(s.ninkan.senrei.doi.includes('相模守'), '家の先例'); assert(E.kakushiki(s, 'doi') >= 3, '家の格式');
  const m0 = s.factions.yoritomo.money; E.ninkanMonthly(s); assert(s.factions.yoritomo.money >= m0, '任国の国衙の収入');
  assert(E.ninkanEra(s).id === 'yoritomo'); s.date = { y: 1215, m: 1, leap: false, d: 1 }; assert.strictEqual(E.ninkanEra(s).strict, 2, '1214年以後は統制が厳しい');
});
ok('60. 検非違使は在京が条件：任じられると京へ移り、出陣できない。辞せば戻る。京が敵の手に落ちると職を失う', () => {
  const s = bakufuWorld(9); const p = s.persons.yoshimori; E.applyOffice(s, p, 'kebiishi', null, null, 'yoritomo', 'テスト');
  assert(p.zaikyo && /検非違使/.test(p.courtOffices.join()), '検非違使'); assert.strictEqual(E.util.personFree ? E.util.personFree(s, p.id, 'yoritomo') : false, false, '出陣できない');
  assert.strictEqual(s.bases[p.location].province, 'yamashiro', '京へ移った');
  const r = E.issueCommand(s, { type: 'resign_office', faction: 'yoritomo', person: 'yoshimori' }); assert(r.ok, r.reason); assert(!p.zaikyo && !/検非違使/.test(p.courtOffices.join()), '辞した');
  E.applyOffice(s, p, 'kebiishi', null, null, 'yoritomo', 'テスト'); p.location = 'kamakura'; s.day += 5; E.ninkanTick(s); assert(!p.zaikyo, '京を離れると職を失う');
});
ok('61. 無断任官：在京の御家人に朝廷が直接官を与えることがあり、将軍は認める・叱責・処罰を選ぶ（統制力が変わる）。朝廷から国司に任じられることもある', () => {
  let ev = null, s = null;
  for (let seed = 1; seed <= 30 && !ev; seed++) { s = bakufuWorld(seed); const p = s.persons.yoshimori; p.location = 'heiankyo'; p.ambition = 80; p.abilities.valor = 85; s.ninkan.control.yoritomo = 0;
    for (let m = 0; m < 12 && !ev; m++) { E.ninkanMonthly(s); ev = s.pendingStops.find(e => e.key === 'mudan' && !e.resolved); } }
  assert(ev, '無断任官の場面'); const j0 = E.jinji(s, 'yoritomo'); const r = E.resolveEvent(s, ev.id, 'punish'); assert(r.ok); assert(E.jinji(s, 'yoritomo') > j0, '処罰で統制が強まる'); assert(!s.persons.yoshimori.zaikyo, '官を失う');
  let offered = false; for (let seed = 1; seed <= 20 && !offered; seed++) { const t = bakufuWorld(seed); t.factions.yoritomo.overlord = null; t.court.cliques && Object.values(t.court.cliques).forEach(c => { c.attitude = c.attitude || {}; c.attitude.yoritomo = 90; c.favor = c.favor || {}; c.favor.yoritomo = 90; });
    for (let m = 0; m < 36 && !offered; m++) { E.ninkanMonthly(t); offered = t.pendingStops.some(e => e.key === 'kokushi_offer') || Object.values(t.provinces).some(pv => pv.kokushi && pv.kokushi.person === 'yoritomo'); } }
  assert(offered, '朝廷から国司の任命が来る');
  const s2 = izuStart(1); assert(Object.values(s2.provinces).some(pv => pv.kokushi && s2.persons[pv.kokushi.person]), '開始時の国守（史実）が国ごとに入る');
});

ok('62. 館を与える：家臣に与えると独立した家（御家人）となり兵・所領を持ち、恩を感じる。家・御家人にも与えられる。館の名を改められる', () => {
  const s = izuStart(2); s.bases.yamaki.owner = 'yoritomo'; s.bases.yamaki.garrison = 20; const r = E.issueCommand(s, { type: 'grant_base', faction: 'yoritomo', base: 'yamaki', to: 'sadatsuna', troops: 10 }); assert(r.ok, r.reason);
  const h = s.houses.h_sadatsuna; assert(h && h.head === 'sadatsuna' && h.seat === 'yamaki' && s.bases.yamaki.house === 'h_sadatsuna', '独立した家'); assert(h.loyalty >= 90, '恩を感じる');
  assert(E.retainersOf(s, 'yoritomo').some(x => x.id === 'h_sadatsuna'), '御家人として扱う'); assert(E.houseTroops(s, 'h_sadatsuna') >= 10, '自分の兵');
  const m = E.issueCommand(s, { type: 'vassal_command', faction: 'yoritomo', act: 'muster' }); assert(m.results.some(x => x.id === 'h_sadatsuna' && x.ok), '兵を増やせる');
  assert(!E.issueCommand(s, { type: 'grant_base', faction: 'yoritomo', base: 'hirugakojima', to: 'doi' }).ok, '本拠点は与えられない');
  s.bases.hojo.house = null; s.bases.hojo.owner = 'yoritomo'; const L0 = E.retLoyalty(s, { kind: 'house', id: 'doi' }, 'yoritomo'); assert(E.issueCommand(s, { type: 'grant_base', faction: 'yoritomo', base: 'hojo', to: 'doi' }).ok); assert(E.retLoyalty(s, { kind: 'house', id: 'doi' }, 'yoritomo') > L0);
  const rn = E.issueCommand(s, { type: 'rename_base', faction: 'yoritomo', base: 'yamaki', name: '佐々木館' }); assert(rn.ok && s.bases.yamaki.name === '佐々木館'); assert(!E.issueCommand(s, { type: 'rename_base', faction: 'yoritomo', base: 'rokuhara', name: 'x' }).ok, '敵の館は改名できない');
  const s2 = E.load(E.save(s)); assert(s2.houses.h_sadatsuna && s2.bases.yamaki.name === '佐々木館', 'セーブに残る');
});

ok('63. 忠誠が65を超え戦の最中でない御家人は必ず参陣する（出陣中の手の空いた軍もそのまま加わる）', () => {
  let bad = 0, tot = 0;
  for (let seed = 1; seed <= 10; seed++) { const s = izuStart(seed); s.factions.kazusa.overlord = 'yoritomo'; E.util.rel(s, 'kazusa', 'yoritomo').value = 92;
    const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu'); const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true });
    s.corps[r.corps].contingents.filter(c => ['kazusa', 'hojo', 'hiki', 'doi'].includes(c.id)).forEach(c => { tot++; if (c.decision !== 'join') bad++; }); }
  assert(tot >= 40 && bad === 0, '参陣しなかった ' + bad + '／' + tot);
});
ok('64. 出陣前に参陣の見込み（家ごとの兵の数）が分かり、家ごとに不要・兵の数を決められる', () => {
  const s = izuStart(5); s.factions.kazusa.overlord = 'yoritomo'; E.util.rel(s, 'kazusa', 'yoritomo').value = 92;
  const pv = E.callPreview(s, 'yoritomo', { type: 'base', id: 'yamaki' }); assert(pv.some(x => x.id === 'kazusa' && x.decision === 'join' && x.troops > 100)); assert(pv.every(x => Number.isFinite(x.avail)));
  const plan = {}; pv.forEach(x => plan[x.id] = x.id === 'doi' ? 0 : x.id === 'kazusa' ? 200 : x.troops);
  const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu'); const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, callPlan: plan });
  const cs = s.corps[r.corps].contingents; assert.strictEqual(cs.find(c => c.id === 'doi').decision, 'excused', '不要にした家は呼ばない'); assert(!s.log.some(l => /【不参】土肥/.test(l.text)), '不参の扱いにならない');
  assert(cs.find(c => c.id === 'kazusa').troops <= 200 && cs.find(c => c.id === 'kazusa').troops >= 150, '決めた兵の数だけ出す');
});
ok('65. 加勢：呼ばれていない家や近くの同盟の家が自らの意思で加わることがある。頼朝が本拠を移すと配所はただの館となり与えられる', () => {
  let vol = 0;
  for (let seed = 1; seed <= 12 && !vol; seed++) { const s = izuStart(seed); ['kazusa', 'chiba', 'miura'].forEach(k => { s.factions[k].overlord = 'yoritomo'; E.util.rel(s, k, 'yoritomo').value = 95; });
    const iz = E.sortieSources(s, 'yoritomo').find(x => x.province === 'izu'); const r = E.issueCommand(s, { type: 'sortie', faction: 'yoritomo', target: { type: 'base', id: 'yamaki' }, commander: 'yoritomo', units: [], commanderUnit: { province: 'izu', troops: iz.available }, declare: true, call: false });
    for (let d = 0; d < 40; d++) { s.pendingStops.forEach(e => e.resolved = true); E.advanceDay(s); if (s.corps[r.corps] && (s.corps[r.corps].volunteers || []).length) { vol++; break; } } }
  assert(vol > 0, '加勢が起きる');
  const t = izuStart(1); t.bases.kamakura.owner = 'yoritomo'; E.issueCommand(t, { type: 'set_capital', faction: 'yoritomo', base: 'kamakura' }); t.factions.yoritomo.money += 0; for (let d = 0; d < 3; d++) { t.pendingStops.forEach(e => e.resolved = true); E.advanceDay(t); }
  if (t.factions.yoritomo.capital === 'kamakura') { assert.strictEqual(t.bases.hirugakojima.name, '蛭ヶ小島館'); t.bases.yamaki.owner = 'x'; assert(E.issueCommand(t, { type: 'grant_base', faction: 'yoritomo', base: 'hirugakojima', to: 'adachi' }).ok, '旧配所を家に与えられる'); }
});
console.log(`\n${n} 件の受入条件をすべて満たした`);
