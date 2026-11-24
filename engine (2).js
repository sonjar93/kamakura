/*
 * 天下布武以前 ― 平安・鎌倉動乱記  ゲームエンジン v0.1
 * 表示処理から独立したゲームロジック（Node / ブラウザ共通, UMD）。
 * 状態はすべて JSON 化可能なプレーンオブジェクトで保持する（関数・循環参照を持たない）。
 *
 *   createGame(scenario, {playerFaction, seed})  新規ゲーム
 *   advanceDay(state)                            1日進める（停止イベントの配列を返す）
 *   runDays(state, n)                            n日進める（停止イベントで中断）
 *   issueCommand(state, cmd)                     構造化命令の実行/予約（不成立なら理由）
 *   parseCommand(state, text)                    自然言語 → 構造化命令
 *   resolveEvent(state, eventId, choiceId)       イベントの選択肢を確定
 *   save(state) / load(json)                     セーブ・ロード
 *   validate(state)                              年代矛盾・未確認項目の検出
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GenpeiEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var ENGINE_VERSION = '0.22.0';

  // ================================================================ 乱数（シード固定・状態に保存）
  function rand(s) {
    var t = (s.rng = (s.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function rr(s, a, b) { return a + (b - a) * rand(s); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function nid(s, p) { s.seq += 1; return p + s.seq; }

  // ================================================================ 暦（和暦・近似）
  function monthLen(s, y, m, leap) { return ((y + m + (leap ? 1 : 0)) % 2 === 0) ? 30 : 29; }
  function nextDate(s, d) {
    var n = { y: d.y, m: d.m, leap: d.leap, d: d.d + 1 };
    if (n.d > monthLen(s, d.y, d.m, d.leap)) {
      n.d = 1;
      var lm = s.calendar.leapMonths[String(d.y)];
      if (!d.leap && lm === d.m) n.leap = true;
      else { n.leap = false; n.m += 1; if (n.m > 12) { n.m = 1; n.y += 1; } }
    }
    return n;
  }
  function cmpDate(a, b) { // a,b: {y,m,leap,d}
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    var al = a.leap ? 1 : 0, bl = b.leap ? 1 : 0;
    if (al !== bl) return al - bl;
    return a.d - b.d;
  }
  function eraOf(s, d) {
    var name = s.calendar.eras[0].name;
    s.calendar.eras.forEach(function (e) { if (cmpDate(d, { y: e.from[0], m: e.from[1], leap: false, d: e.from[2] }) >= 0) name = e.name; });
    return { name: name, year: d.y - s.calendar.eraStartYear[name] + 1 };
  }
  function kanjiNum(n) { return n === 1 ? '元' : String(n); }
  function dateStr(s, d) {
    d = d || s.date; var e = eraOf(s, d);
    return e.name + kanjiNum(e.year) + '年' + (d.leap ? '閏' : '') + d.m + '月' + d.d + '日（' + d.y + '年）';
  }
  function season(d) { return d.m <= 3 ? 'spring' : d.m <= 6 ? 'summer' : d.m <= 9 ? 'autumn' : 'winter'; }

  // ================================================================ 参照ヘルパ
  function F(s, id) { return s.factions[id]; }
  function Pn(s, id) { return s.persons[id]; }
  function B(s, id) { return s.bases[id]; }
  function PV(s, id) { return s.provinces[id]; }
  function pname(s, id) { var p = s.persons[id]; return p ? p.name : '（不明）'; }
  function fname(s, id) { var f = s.factions[id]; return f ? f.name : '（なし）'; }
  function relKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function rel(s, a, b) {
    var k = relKey(a, b);
    if (!s.relations[k]) s.relations[k] = { a: a < b ? a : b, b: a < b ? b : a, value: 0, status: '中立', war: false };
    return s.relations[k];
  }
  function topLord(s, fid) { var f = F(s, fid), guard = 0; while (f && f.overlord && guard++ < 5) f = F(s, f.overlord); return f ? f.id : fid; }
  function sameCamp(s, a, b) { if (!a || !b) return false; return a === b || topLord(s, a) === topLord(s, b) || rel(s, a, b).status === '同盟'; }
  function atWar(s, a, b) {
    if (!a || !b || a === b) return false;
    if (sameCamp(s, a, b)) return false;
    if (rel(s, a, b).war) return true;
    var la = topLord(s, a), lb = topLord(s, b);
    if (la !== a || lb !== b) return rel(s, la, lb).war;
    return false;
  }
  function alive(s, pid) { var p = Pn(s, pid); return !!(p && p.alive); }
  function ageOf(s, p) { return p.born ? s.date.y - p.born : null; }
  function factionPersons(s, fid) { return Object.keys(s.persons).map(function (k) { return s.persons[k]; }).filter(function (p) { return p.alive && p.faction === fid; }); }
  function factionBases(s, fid) { return Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.owner === fid; }); }
  function factionArmies(s, fid) { return Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.faction === fid; }); }
  function provinceArmies(s, pid) { return Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.province === pid && !a.edge; }); }

  // ================================================================ ログ（可観測性 NFR-07）
  function news(s, text, o) {
    o = o || {};
    var e = { day: s.day, date: dateStr(s), text: text, type: o.type || 'news', factions: o.factions || [], important: !!o.important, province: o.province || null };
    s.log.push(e); if (s.log.length > 2000) s.log.splice(0, s.log.length - 2000);
    return e;
  }
  function aiLog(s, fid, action, reason, speech) {
    s.aiLog.push({ day: s.day, date: dateStr(s), faction: fid, action: action, reason: reason, speech: speech || null });
    if (s.aiLog.length > 2000) s.aiLog.splice(0, s.aiLog.length - 2000);
  }
  function stop(s, ev) { // 自動停止イベント
    ev.id = nid(s, 'ev'); ev.day = s.day; ev.date = dateStr(s); ev.resolved = !ev.choices || !ev.choices.length;
    s.pendingStops.push(ev); s.eventHistory.push({ id: ev.id, key: ev.key, title: ev.title, date: ev.date, place: ev.place || '', persons: ev.persons || [] });
    return ev;
  }

  // ================================================================ 経路探索
  function edgeCost(s, e, fid) {
    var f = { land: 1, mountain: 1.6, sea: 1.25 }[e.kind] || 1;
    if (e.kind === 'sea' && fid && !F(s, fid).navy) f = 2.2;
    return e.km * f;
  }
  function neighbors(s, pid) { return s.adj[pid] || []; }
  function findPath(s, from, to, fid, avoid) {
    if (from === to) return [from];
    var dist = {}, prev = {}, done = {}, q = [from]; dist[from] = 0;
    while (q.length) {
      q.sort(function (a, b) { return dist[a] - dist[b]; });
      var u = q.shift(); if (done[u]) continue; done[u] = 1; if (u === to) break;
      neighbors(s, u).forEach(function (rid) {
        var e = s.roads[rid], v = e.a === u ? e.b : e.a;
        var c = edgeCost(s, e, fid) * (avoid && avoid[v] ? 6 : 1);
        if (dist[v] === undefined || dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; q.push(v); }
      });
    }
    if (dist[to] === undefined) return null;
    var path = [to]; while (path[0] !== from) path.unshift(prev[path[0]]);
    return path;
  }
  function roadBetween(s, a, b) {
    var ids = neighbors(s, a); for (var i = 0; i < ids.length; i++) { var e = s.roads[ids[i]]; if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e; }
    return null;
  }
  function pathKm(s, path) { var t = 0; for (var i = 0; i + 1 < path.length; i++) t += roadBetween(s, path[i], path[i + 1]).km; return t; }
  function travelDays(s, from, to, kmPerDay) { var p = findPath(s, from, to, null); return p ? Math.max(1, Math.ceil(pathKm(s, p) / kmPerDay)) : 99; }

  // ================================================================ ゲーム生成
  // 難易度：敵がプレイヤーに向ける兵の量・挙兵後の猶予・呼応する兵・収入
  var DIFFICULTY = {
    easy:   { label: 'やさしい', enemy: 0.5, grace: 2.5, rally: 1.8, income: 1.4 },
    normal: { label: 'ふつう',   enemy: 0.6, grace: 1.9, rally: 1.45, income: 1.2 },
    hard:   { label: 'むずかしい', enemy: 1, grace: 1, rally: 1, income: 1 },
  };
  var GOALS = { campaign: 'キャンペーン（源氏→北条執権）', objective: '勢力の目標', survive: '家の存続', unify: '天下統一', none: '勝利条件なし（自由・観戦）' };
  function diff(s) { var d = DIFFICULTY[(s.options && s.options.difficulty) || 'normal'] || DIFFICULTY.normal;
    if (s.options && s.options.mode === 'free') d = { label: d.label, enemy: d.enemy * 0.75, grace: d.grace * 1.4, rally: d.rally * 1.15, income: d.income * 1.1 }; // 自由モードは史実の援軍（三浦・千葉・上総の参陣など）が保証されないぶん、さらにやさしく
    return d; }
  function createGame(scn, opt) {
    // opt.mode: 'historical'（史実モード） | 'free'（自由モード）
    opt = opt || {};
    var s = {
      engineVersion: ENGINE_VERSION, scenarioId: scn.meta.id, meta: scn.meta,
      calendar: { eras: scn.eras, eraStartYear: scn.eraStartYear, leapMonths: scn.leapMonths },
      date: { y: scn.meta.startDate.western, m: scn.meta.startDate.month, leap: false, d: scn.meta.startDate.day },
      day: 0, rng: (opt.seed >>> 0) || 11804, seq: 0,
      playerFaction: opt.playerFaction || null,
      options: { mode: opt.mode === 'free' ? 'free' : 'historical', mortality: opt.mode === 'free' ? 'random' : 'historical', aiInterval: 4, difficulty: DIFFICULTY[opt.difficulty] ? opt.difficulty : 'normal', goal: GOALS[opt.goal] ? opt.goal : 'objective' },
      constructions: {}, schedule: [], recruits: [], corps: {},
      objectives: JSON.parse(JSON.stringify(scn.objectives || {})),
      histEvents: JSON.parse(JSON.stringify(scn.historicalEvents || [])).map(function (e) { e.status = 'pending'; return e; }),
      provinces: {}, roads: {}, adj: {}, factions: {}, persons: {}, bases: {}, bands: {}, holdings: {}, relations: {},
      court: JSON.parse(JSON.stringify(scn.court)), offices: scn.offices, ranks: scn.ranks, battlefields: scn.battlefields,
      eventDefs: scn.events, armies: {}, envoys: {}, battles: {}, battleHistory: [], orders: [], intel: [],
      flags: {}, firedEvents: {}, pendingStops: [], eventHistory: [], commandHistory: [], log: [], aiLog: [],
    };
    scn.provinces.forEach(function (p) { s.provinces[p.id] = JSON.parse(JSON.stringify(p)); s.provinces[p.id].unrest = 10; s.provinces[p.id].devastation = 0; s.adj[p.id] = []; });
    scn.roads.forEach(function (r) { s.roads[r.id] = r; s.adj[r.a].push(r.id); s.adj[r.b].push(r.id); });
    scn.factions.forEach(function (f) {
      var g = JSON.parse(JSON.stringify(f)); g.alive = true; g.navy = (f.id === 'heike' || f.id === 'kumano' || f.id === 'kono');
      g.ai = { lastEval: -99, posture: 'normal', target: null, memo: '' }; s.factions[f.id] = g;
    });
    scn.persons.forEach(function (p) { s.persons[p.id] = JSON.parse(JSON.stringify(p)); s.persons[p.id].captiveOf = null; });
    scn.bases.forEach(function (b) { s.bases[b.id] = JSON.parse(JSON.stringify(b)); s.bases[b.id].maxDefense = b.defense; });
    scn.bands.forEach(function (b) { s.bands[b.id] = JSON.parse(JSON.stringify(b)); s.bands[b.id].base = b.strength; });
    scn.holdings.forEach(function (h) { s.holdings[h.id] = JSON.parse(JSON.stringify(h)); });
    scn.relations.forEach(function (r) { var x = rel(s, r.a, r.b); x.value = r.value; x.status = r.status; x.war = false; });
    if (s.playerFaction && (!s.factions[s.playerFaction] || !s.factions[s.playerFaction].playable)) throw new Error('選択できない勢力です: ' + s.playerFaction);
    if (s.playerFaction && factionBases(s, s.playerFaction).length) s.flags.playerHadBase = true;
    ensureCourt(s); ensureHoldings(s); ensureRegime(s); migrateHouses(s); migrateHouses3(s); migrateHouses4(s); ensurePlayer(s); ensurePolitics(s); ensureNinkan(s);
    news(s, scn.meta.title + ' 開始（' + (s.options.mode === 'historical' ? '史実モード：主要な出来事は史実の日付に起こる' : '自由モード：史実は強制されない') + '）。' + (s.playerFaction ? 'プレイヤー勢力：' + fname(s, s.playerFaction) : '観戦モード'), { important: true, type: 'system' });
    var v = validate(s); if (v.errors.length) news(s, '年代検証で ' + v.errors.length + ' 件の矛盾を検出', { type: 'system' });
    return s;
  }

  // ================================================================ 勢力の集計
  function availableBandTroops(s, fid, pid, withHouses) {
    return Object.keys(s.bands).map(function (k) { return s.bands[k]; })
      .filter(function (b) { return b.faction === fid && (!pid || b.province === pid) && (withHouses || !b.house); })
      .reduce(function (t, b) { return t + Math.max(0, Math.floor(b.strength - b.mobilized)); }, 0);
  }
  function factionPower(s, fid) {
    var bands = Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (b) { return b.faction === fid; });
    var total = bands.reduce(function (t, b) { return t + b.strength; }, 0);
    var field = factionArmies(s, fid).reduce(function (t, a) { return t + a.troops; }, 0);
    var garrison = factionBases(s, fid).reduce(function (t, b) { return t + b.garrison; }, 0);
    return { bandTotal: Math.round(total), field: Math.round(field), garrison: Math.round(garrison), available: availableBandTroops(s, fid) };
  }
  function campPower(s, fid) { // 主従を含む陣営の兵力
    var lord = topLord(s, fid), t = 0;
    Object.keys(s.factions).forEach(function (k) { var f = s.factions[k]; if (f.alive && topLord(s, k) === lord) { var p = factionPower(s, k); t += p.available + p.field + p.garrison; } });
    return t;
  }
  function holdingsOf(s, fid) { return Object.keys(s.holdings).map(function (k) { return s.holdings[k]; }).filter(function (h) { return h.controller === fid; }); }
  function provinceInfluence(s, pid) {
    var by = {};
    Object.keys(s.holdings).forEach(function (k) { var h = s.holdings[k]; if (h.province === pid && h.controller) by[h.controller] = (by[h.controller] || 0) + h.output * (h.controller === 'court' ? 0.35 : 1); }); // 京の本所の荘園は現地への実力が弱い
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (b.province === pid && b.owner) by[b.owner] = (by[b.owner] || 0) + 4000 + b.garrison * 10; });
    var tot = 0; Object.keys(by).forEach(function (k) { tot += by[k]; });
    var arr = Object.keys(by).map(function (k) { return { faction: k, share: tot ? by[k] / tot : 0 }; }).sort(function (a, b) { return b.share - a.share; });
    return arr;
  }

  // ================================================================ 軍勢
  function armySpeedKm(s, a, edge) {
    var base = 30 - 3 * Math.log10(Math.max(100, a.troops) / 100);          // 大軍ほど遅い
    var terr = edge ? ({ land: 1, mountain: 0.65, sea: F(s, a.faction).navy ? 1.1 : 0.6 }[edge.kind] || 1) : 1;
    var sea = season(s.date), pv = PV(s, a.province);
    var w = 1;
    if (sea === 'winter' && pv && pv.snowyWinter) w = 0.45;
    else if (s.date.m === 5) w = 0.85; // 梅雨（旧暦5月）
    var fat = 1 - a.fatigue / 250;
    var hunger = a.food <= 0 ? 0.7 : 1;
    return Math.max(4, base * terr * w * fat * hunger);
  }
  // 編成：総大将（commander）＋部隊（divisions：各部隊の大将と兵数）＋軍奉行（bugyo）
  function personFree(s, pid, fid, armyId) {
    var p = Pn(s, pid); if (!p || !p.alive || p.captiveOf) return false;
    if (p.faction !== fid && topLord(s, p.faction) !== topLord(s, fid)) return false;   // 自勢力か御家人（主従下の勢力）
    var loc = String(p.location || '');
    if (/^envoy:/.test(loc)) return false;
    if (p.zaikyo) return false; // 検非違使など在京の官は京を離れられない
    if (/^army:/.test(loc) && loc !== 'army:' + armyId) return false;
    return true;
  }
  // 編成に加われるのは、出陣する国から約5日以内の場所にいる者
  function personNear(s, pid, prov) {
    var p = Pn(s, pid); if (!p) return false;
    var lp = personLocationProvince(s, p) || ((B(s, F(s, p.faction).capital) || {}).province);
    if (!lp) return false;
    return lp === prov || travelDays(s, lp, prov, 40) <= 5;
  }
  function autoOrganize(s, fid, troops, commander, exclude) {
    // 兵1200ごとに部隊を一つ、兵1000超なら軍奉行を置く（知略の高い者）
    var pool = factionPersons(s, fid).filter(function (p) { return p.id !== commander && (exclude || []).indexOf(p.id) < 0 && !nonCombatant(p) && personFree(s, p.id, fid) && p.id !== F(s, fid).leader && (ageOf(s, p) == null || ageOf(s, p) >= 15); });
    pool.sort(function (a, b) { return (b.abilities.command + b.abilities.valor) - (a.abilities.command + a.abilities.valor); });
    var nDiv = Math.min(pool.length, Math.max(0, Math.floor(troops / 1200)));
    var divs = [], per = nDiv ? Math.floor(troops / (nDiv + 1)) : 0;
    for (var i = 0; i < nDiv; i++) divs.push({ leader: pool[i].id, troops: per });
    var rest = pool.slice(nDiv).sort(function (a, b) { return b.abilities.intellect - a.abilities.intellect; });
    var bugyo = troops > 1000 && rest.length ? rest[0].id : null;
    return { divisions: divs, bugyo: bugyo };
  }
  function normalizeDivisions(a) {
    // 本隊（総大将の直率）＝ 全兵数 − 各部隊
    var sub = (a.divisions || []).filter(function (d) { return d.leader !== a.commander; });
    var sum = sub.reduce(function (t, d) { return t + d.troops; }, 0);
    if (sum > a.troops) { var k = a.troops / sum; sub.forEach(function (d) { d.troops = Math.floor(d.troops * k * 0.9); }); sum = sub.reduce(function (t, d) { return t + d.troops; }, 0); }
    a.divisions = [{ leader: a.commander, troops: Math.max(0, a.troops - sum), main: true }].concat(sub);
    a.officers = sub.map(function (d) { return d.leader; }).concat(a.bugyo ? [a.bugyo] : []);
  }
  function createArmy(s, fid, pid, troops, commander, opts) {
    opts = opts || {};
    var id = nid(s, 'army');
    var a = {
      id: id, faction: fid, commander: commander || null, officers: opts.officers || [], troops: troops, initialTroops: troops,
      morale: opts.morale || 70, fatigue: 0, food: opts.food != null ? opts.food : Math.round(troops * 0.005 * 30),
      province: pid, base: opts.base || null, edge: null, path: [], target: null, mission: opts.mission || 'idle',
      status: opts.gather ? 'gathering' : 'idle', gatherUntil: opts.gather ? s.day + opts.gather : null,
      bands: opts.bands || [], createdDay: s.day, idleDays: 0, name: opts.name || null, retreatTo: null,
      composition: opts.composition || { cavalry: 0.3, infantry: 0.7 }, battleId: null,
      divisions: opts.divisions || [], bugyo: opts.bugyo || null,
    };
    if (!opts.divisions && !opts.noAuto && commander) { var ao = autoOrganize(s, fid, troops, commander, opts.officers); a.divisions = ao.divisions; a.bugyo = opts.bugyo || ao.bugyo; }
    (opts.officers || []).forEach(function (o) { if (o !== a.bugyo && !a.divisions.some(function (d) { return d.leader === o; })) a.divisions.push({ leader: o, troops: Math.floor(troops / 6) }); });
    normalizeDivisions(a);
    s.armies[id] = a;
    if (commander && s.persons[commander]) s.persons[commander].location = 'army:' + id;
    a.officers.forEach(function (o) { if (s.persons[o]) s.persons[o].location = 'army:' + id; });
    return a;
  }
  function armyLabel(s, a) { return (a.name || (a.commander ? pname(s, a.commander) + '勢' : fname(s, a.faction) + 'の軍')) + '（' + Math.round(a.troops) + '）'; }
  function disbandArmy(s, a, why) {
    // 兵を武士団へ戻す（損耗分は失われる）
    var ret = a.troops;
    a.bands.forEach(function (bb) {
      var band = s.bands[bb.band]; if (!band) return;
      var share = a.initialTroops ? bb.n / a.initialTroops : 0;
      var back = Math.round(ret * share); var lost = bb.n - back;
      band.mobilized = Math.max(0, band.mobilized - bb.n);
      band.strength = Math.max(0, band.strength - Math.max(0, lost) * 0.6);
    });
    var ownerBase = a.base && B(s, a.base) && B(s, a.base).owner === a.faction ? B(s, a.base) : null;
    if (ownerBase && why === 'garrison') { ownerBase.garrison += Math.round(a.troops * 0.3); var bf = Math.min(Math.max(0, a.food), Math.max(0, baseFoodCap(s, ownerBase) - (ownerBase.food || 0))); ownerBase.food = (ownerBase.food || 0) + bf; a.food -= bf; } // 持っていた兵糧は城の蔵へ
    F(s, a.faction).food += Math.max(0, a.food);
    releaseArmyPersons(s, a);
    delete s.armies[a.id];
  }
  function releaseArmyPersons(s, a) {
    var cap = F(s, a.faction) ? F(s, a.faction).capital : null;
    [a.commander].concat(a.officers).forEach(function (pid) { var p = s.persons[pid]; if (p && p.alive && p.location === 'army:' + a.id) p.location = a.base || cap || null; });
  }
  function setArmyTarget(s, a, target, mission) {
    // target: {type:'province'|'base', id}
    var dest = target.type === 'base' ? B(s, target.id).province : target.id;
    var path = findPath(s, a.province, dest, a.faction);
    if (!path) return '経路が見つからない';
    a.target = target; a.mission = mission || 'move'; a.path = path.slice(1); a.edge = null; a.base = null;
    if (a.status !== 'gathering' && a.status !== 'battle') a.status = a.path.length ? 'marching' : 'arrived';
    if (a.status === 'arrived' && a.mission === 'attack' && target.type === 'base') arrive(s, a); // 同じ国の拠点はそのまま攻めかかる
    return null;
  }
  function mobilize(s, fid, pid, troops, commander, opts) {
    opts = opts || {};
    var f = F(s, fid); if (!f || !f.alive) return { error: '勢力が存在しない' };
    var hsel = opts.house || null; // 家の兵は家の命令でしか出ない（主君の直轄兵と分ける）
    var cands = Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (b) { return b.faction === fid && b.province === pid && (b.house || null) === hsel; });
    var near = [];
    if (opts.wide) Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction === fid && (b.house || null) === hsel && b.province !== pid && distProv(s, pid, b.province) < opts.wide) near.push(b); });
    else if (opts.allowNeighbors !== false) neighbors(s, pid).forEach(function (rid) { var e = s.roads[rid]; var v = e.a === pid ? e.b : e.a; Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction === fid && (b.house || null) === hsel && b.province === v) near.push(b); }); });
    var pool = cands.concat(near), avail = pool.reduce(function (t, b) { return t + Math.max(0, b.strength - b.mobilized); }, 0);
    if (avail < 30) return { error: PV(s, pid).name + 'とその周辺に動員できる' + f.name + 'の武士団がない（動員可能 ' + Math.floor(avail) + '）' };
    troops = Math.min(troops || avail, Math.floor(avail));
    var cost = Math.round(troops * 0.08), food = Math.round(troops * 0.005 * (opts.foodDays || 30));
    if (opts.force) { cost = Math.min(cost, Math.max(0, f.money)); }
    if (!opts.force && f.money < cost) return { error: '資金不足（必要 ' + cost + '貫、所持 ' + Math.floor(f.money) + '貫）' };
    if (!opts.force && f.food < food * 0.5) return { error: '兵糧不足（必要 ' + food + '石、所持 ' + Math.floor(f.food) + '石）' };
    food = Math.min(food, f.food);
    f.money -= cost; f.food -= food;
    var need = troops, used = [];
    pool.forEach(function (b) { if (need <= 0) return; var n = Math.min(need, Math.floor(b.strength - b.mobilized)); if (n <= 0) return; b.mobilized += n; need -= n; used.push({ band: b.id, n: n }); });
    if (!commander) commander = pickCommander(s, fid, pid, null, opts.defensive);
    var gather = Math.max(1, Math.round(1 + troops / 700 + (near.length && used.some(function (u) { return s.bands[u.band].province !== pid; }) ? 2 : 0)));
    var base = opts.base || (factionBases(s, fid).filter(function (b) { return b.province === pid; })[0] || {}).id || null;
    var a = createArmy(s, fid, pid, troops, commander, { food: food, bands: used, gather: gather, base: base, officers: opts.officers, mission: 'idle', divisions: opts.divisions, bugyo: opts.bugyo });
    return { army: a, gather: gather, cost: cost, food: food };
  }
  function nonCombatant(p) { return p.abilities.command < 30 || /天皇|上皇|法皇|女院|国母|妻|摂関家|皇族/.test(p.status); }
  function pickCommander(s, fid, pid, exclude, defensive) {
    var f = F(s, fid);
    var ps = factionPersons(s, fid).filter(function (p) {
      return !p.captiveOf && (exclude || []).indexOf(p.id) < 0 && !/^(army|envoy):/.test(String(p.location || '')) &&
        !nonCombatant(p) && (ageOf(s, p) == null || (ageOf(s, p) >= 15 && (defensive || ageOf(s, p) < 63)));
    });
    // 当主は他に指揮官がいれば出陣しない（小勢力・防衛時を除く）
    if (!defensive && ps.filter(function (p) { return p.id !== f.leader && p.abilities.command >= 45; }).length) ps = ps.filter(function (p) { return p.id !== f.leader; });
    ps.sort(function (a, b) {
      var la = a.location && B(s, a.location) && B(s, a.location).province === pid ? 25 : 0;
      var lb = b.location && B(s, b.location) && B(s, b.location).province === pid ? 25 : 0;
      var ha = a.id === f.leader ? -10 : 0, hb = b.id === f.leader ? -10 : 0; // 当主は温存しがち
      return (b.abilities.command + lb + hb) - (a.abilities.command + la + ha);
    });
    return ps.length ? ps[0].id : null;
  }

  // ================================================================ 日次更新
  function advanceDay(s) {
    if (s.flags.gameOver) return { stops: [], blocked: true, ended: true };
    if (s.pendingStops.some(function (e) { return !e.resolved; })) return { stops: s.pendingStops.filter(function (e) { return !e.resolved; }), blocked: true };
    var before = s.pendingStops.length;
    s.day += 1; s.date = nextDate(s, s.date);
    processOrders(s);          // 予約命令（伝達遅延）
    processIntel(s);           // 情報伝達
    moveArmies(s);             // 行軍
    moveEnvoys(s);             // 使者
    supplyAndFatigue(s);       // 兵糧・疲労・士気（補給線）
    siegeSupply(s);            // 籠城の兵糧・開城
    detectBattles(s);          // 遭遇判定
    resolveBattles(s);         // 戦闘・包囲
    if (s.date.d === 1) { monthly(s); courtPolitics(s); regimeTick(s); shogunateTick(s); if (shogunId(s)) shogunTick(s); houseDrift(s); clanTick(s); politicsMonthly(s); arrivalsTick(s); ninkanMonthly(s); loyaltyTick(s); Object.keys(s.factions).forEach(function (k) { if (k !== s.playerFaction && s.factions[k].alive) aiSpoils(s, k); }); }
    birthsTick(s); reformsTick(s); // 経済（月次集計）・朝廷の派閥政治
    progressConstruction(s);   // 普請（築城）
    mortality(s);              // 人物の死亡判定
    progressRecruits(s);       // 徴兵（新しい兵が少しずつ集まる）
    runHistEvents(s);          // 史実イベント（条件を満たせば発生）
    runAI(s);                  // AI勢力
    checkEvents(s);            // 歴史イベント
    cleanup(s);
    syncSeatHoldings(s); facilitiesTick(s); contingentsTick(s); lordOrderTick(s); volunteerTick(s); haishoTick(s);
    politicsDaily(s); ninkanTick(s);
    checkVictory(s);           // 天下統一と5年の維持
    var newStops = s.pendingStops.slice(before);
    return { stops: newStops, blocked: false };
  }
  function runDays(s, n) {
    var all = [];
    for (var i = 0; i < n; i++) {
      var r = advanceDay(s); if (r.blocked) return { daysRun: i, stops: r.stops, blocked: true };
      all = all.concat(r.stops);
      if (r.stops.length) return { daysRun: i + 1, stops: all };
    }
    return { daysRun: n, stops: all };
  }
  function runUntilMonthEnd(s) {
    var m = s.date.m, l = s.date.leap, i = 0, res = { daysRun: 0, stops: [] };
    while (i < 32) { var r = runDays(s, 1); res.daysRun += r.daysRun; if (r.stops.length || r.blocked) { res.stops = r.stops; return res; } i++; if (s.date.m !== m || s.date.leap !== l) break; }
    return res;
  }

  function processOrders(s) {
    var due = s.orders.filter(function (o) { return o.executeDay <= s.day; });
    s.orders = s.orders.filter(function (o) { return o.executeDay > s.day; });
    due.forEach(function (o) { var r = executeCommand(s, o.cmd, true); news(s, '命令到着：' + o.label + (r.ok ? '' : '（不成立：' + r.reason + '）'), { type: 'order', factions: [o.cmd.faction] }); });
  }
  function processIntel(s) {
    var due = s.intel.filter(function (i) { return i.day <= s.day; });
    s.intel = s.intel.filter(function (i) { return i.day > s.day; });
    due.forEach(function (i) { var f = F(s, i.faction); if (!f || !f.alive) return; f.flags[i.key] = i.value === undefined ? true : i.value; if (i.text && i.faction === s.playerFaction) news(s, '【報せ】' + i.text, { type: 'intel', factions: [i.faction] }); });
  }
  // 情報を各勢力へ距離に応じた遅延で伝える
  function broadcast(s, key, originProv, text, opts) {
    opts = opts || {};
    Object.keys(s.factions).forEach(function (fid) {
      var f = s.factions[fid]; if (!f.alive) return;
      if (opts.only && opts.only.indexOf(fid) < 0) return;
      var cap = B(s, f.capital); var pv = cap ? cap.province : originProv;
      var d = originProv ? travelDays(s, originProv, pv, 55) : 1;
      s.intel.push({ faction: fid, key: key, day: s.day + d, text: text, value: opts.value });
    });
  }

  function moveArmies(s) {
    Object.keys(s.armies).forEach(function (k) {
      var a = s.armies[k];
      if (a.faction === s.playerFaction) { // 命令のないまま留まる自軍は、しばらくすると館に戻る（出陣したまま放置されるのを防ぐ）
        if (a.regroup && (a.status === 'idle' || a.status === 'arrived') && a.morale >= 55) { var rb = B(s, a.regroup); a.regroup = null; a.holdUntil = null; if (rb && rb.owner && !sameCamp(s, rb.owner, a.faction)) { news(s, armyLabel(s, a) + 'は士気を取り戻し、' + rb.name + 'へ再び攻めかかる', { type: 'military', factions: [a.faction] }); setArmyTarget(s, a, { type: 'base', id: rb.id }, 'attack'); return; } }
        if (a.withdrawHome && (a.status === 'idle' || a.status === 'arrived') && Object.keys(s.bases).some(function (b) { return s.bases[b].province === a.province && sameCamp(s, s.bases[b].owner, a.faction); })) { news(s, armyLabel(s, a) + 'は退いて館に戻り、兵を休ませた', { type: 'military', factions: [a.faction] }); disbandArmy(s, a, 'garrison'); return; }
        if ((a.status === 'idle' || a.status === 'arrived') && !(a.holdUntil > s.day)) a.idleDays = (a.idleDays || 0) + 1; else a.idleDays = 0;
        var ownB = Object.keys(s.bases).some(function (b) { return s.bases[b].province === a.province && sameCamp(s, s.bases[b].owner, a.faction); });
        if (a.idleDays >= 20 && ownB && !(a.corps && s.corps[a.corps] && s.corps[a.corps].target && s.corps[a.corps].target.type === 'base' && !sameCamp(s, B(s, s.corps[a.corps].target.id).owner, a.faction) && Object.keys(s.armies).some(function (o) { var x = s.armies[o]; return x.corps === a.corps && x.status !== 'idle' && x.status !== 'arrived'; }))) {
          news(s, armyLabel(s, a) + 'は命令のないまま20日が過ぎたため、' + PV(s, a.province).name + 'の館に戻って兵を休ませた（武士団に戻り、再び出陣できる）', { type: 'military', important: true, factions: [a.faction], province: a.province });
          disbandArmy(s, a, 'garrison'); return; }
      }
      if (a.status === 'gathering') { if (s.day >= a.gatherUntil) { a.status = a.path.length ? 'marching' : 'idle'; if (!a.path.length && a.target && a.target.type === 'base' && B(s, a.target.id) && B(s, a.target.id).province === a.province) arrive(s, a); /* 同じ国の拠点はそのまま攻める */ news(s, armyLabel(s, a) + 'の動員が完了（' + PV(s, a.province).name + '）', { type: 'military', factions: [a.faction], province: a.province }); } return; }
      if (a.status !== 'marching' && a.status !== 'retreating') { a.fatigue = Math.max(0, a.fatigue - 6); a.idleDays += 1; return; }
      a.idleDays = 0;
      if (!a.edge) {
        if (!a.path.length) { arrive(s, a); return; }
        var nxt = a.path[0], e = roadBetween(s, a.province, nxt);
        if (!e) { a.path = []; a.status = 'idle'; return; }
        a.edge = { road: e.id, from: a.province, to: nxt, km: e.km, done: 0 };
      }
      var ed = s.roads[a.edge.road];
      a.edge.done += armySpeedKm(s, a, ed);
      a.fatigue = clamp(a.fatigue + (ed.kind === 'mountain' ? 6 : 4) * (a.bugyo ? 0.8 : 1), 0, 100);
      if (a.edge.done >= a.edge.km) {
        a.province = a.edge.to; a.path.shift(); a.edge = null;
        if (!a.path.length) arrive(s, a);
      }
    });
  }
  function arrive(s, a) {
    a.status = 'idle'; a.edge = null;
    if (a.retreatTo) { a.base = a.retreatTo; a.retreatTo = null; a.mission = 'idle'; return; }
    if (a.target && a.target.type === 'base') {
      var b = B(s, a.target.id);
      if (b.owner === a.faction || sameCamp(s, b.owner, a.faction) || !b.owner) {
        a.base = b.id; a.mission = a.mission === 'attack' ? 'idle' : a.mission;
        if (!b.owner && a.mission !== 'move') { /* 無主の拠点を確保 */ }
        if (!b.owner) { b.owner = a.faction; news(s, fname(s, a.faction) + 'が' + b.name + 'を押さえた', { type: 'military', factions: [a.faction], province: b.province }); }
      } else if (atWar(s, a.faction, b.owner)) {
        a.status = 'siege'; a.mission = 'attack';
        startBaseBattle(s, a, b);
      } else { a.base = null; news(s, armyLabel(s, a) + 'は' + b.name + 'に到着したが、交戦状態にないため攻撃しない', { factions: [a.faction] }); }
    }
    if (a.target && a.target.type === 'province') a.mission = a.mission === 'attack' ? 'hold' : a.mission;
  }

  function moveEnvoys(s) {
    Object.keys(s.envoys).forEach(function (k) {
      var v = s.envoys[k];
      if (!v.edge) {
        if (!v.path.length) { envoyArrive(s, v); return; }
        var e = roadBetween(s, v.province, v.path[0]); v.edge = { road: e.id, from: v.province, to: v.path[0], km: e.km, done: 0 };
      }
      v.edge.done += v.speed;
      // 敵地での捕捉（敵軍がいる国を通過）
      if (v.edge.done >= v.edge.km) {
        v.province = v.edge.to; v.path.shift(); v.edge = null;
        var hostile = provinceArmies(s, v.province).filter(function (a) { return atWar(s, a.faction, v.faction); });
        if (hostile.length && rand(s) < 0.1) {
          news(s, '使者' + (v.person ? pname(s, v.person) : '') + 'が' + PV(s, v.province).name + 'で敵に捕らえられた', { type: 'diplomacy', factions: [v.faction], important: true });
          if (v.person) { s.persons[v.person].captiveOf = hostile[0].faction; s.persons[v.person].location = null; }
          delete s.envoys[k]; return;
        }
        if (!v.path.length) envoyArrive(s, v);
      }
    });
  }
  function sendEnvoy(s, fid, personId, fromProv, destBaseId, payload) {
    var dest = B(s, destBaseId); var path = findPath(s, fromProv, dest.province, fid);
    if (!path) return null;
    var id = nid(s, 'envoy');
    s.envoys[id] = { id: id, faction: fid, person: personId, province: fromProv, path: path.slice(1), edge: null, speed: 45, dest: destBaseId, payload: payload, departed: s.day };
    if (personId && s.persons[personId]) s.persons[personId].location = 'envoy:' + id;
    return s.envoys[id];
  }
  function envoyArrive(s, v) {
    delete s.envoys[v.id];
    var dest = B(s, v.dest), to = dest ? dest.owner : null, p = v.payload;
    var person = v.person ? s.persons[v.person] : null;
    if (person) person.location = v.dest;
    if (p.kind === 'ryoji') {
      p.recipients.forEach(function (fid) { var f = F(s, fid); if (f && f.alive) { f.flags.ryoji = true; f.flags.ryojiDay = s.day; } });
      news(s, (person ? person.name : '使者') + 'が' + dest.name + 'に到着し、以仁王の令旨を伝えた', { type: 'event', important: true, factions: p.recipients, province: dest.province });
      if (p.recipients.indexOf(s.playerFaction) >= 0) stop(s, { key: 'ryoji_arrival', title: '以仁王の令旨が届く', place: dest.name, persons: [v.person].filter(Boolean),
        text: '源行家が以仁王の令旨を携えて到着した。「平家を追討せよ」との内容である。挙兵の大義名分を得たが、平家に知られれば追捕の対象となる。', choices: [{ id: 'accept', label: '令旨を受け取り、時機を待つ' }, { id: 'rise', label: 'ただちに挙兵の準備に入る（挙兵命令を出す）' }] });
      if (p.next && p.next.length) { var nx = p.next.shift(); var nb = B(s, nx.base); if (nb && v.person && alive(s, v.person)) sendEnvoy(s, v.faction, v.person, dest.province, nx.base, { kind: 'ryoji', recipients: nx.recipients, next: p.next }); }
      return;
    }
    if (p.kind === 'letter') {
      var f = F(s, p.to); if (f) { f.flags[p.flag] = true; }
      news(s, p.text, { type: 'intel', factions: [p.to], important: p.to === s.playerFaction });
      if (p.to === s.playerFaction && p.stopTitle) stop(s, { key: p.flag, title: p.stopTitle, place: dest.name, text: p.text, choices: [] });
      return;
    }
    if (p.kind === 'diplomacy') return diplomacyArrive(s, v, dest, to, p);
    if (p.kind === 'join') { // 人物の合流（義経など）
      if (person) { person.faction = p.to; person.location = v.dest; }
      news(s, (person ? person.name : '') + 'が' + dest.name + 'に到着し、' + fname(s, p.to) + 'に合流した', { type: 'event', important: true, factions: [p.to] });
      if (p.to === s.playerFaction || v.faction === s.playerFaction) stop(s, { key: 'join', title: (person ? person.name : '') + '参陣', place: dest.name, persons: [v.person], text: p.text || '', choices: [] });
    }
  }

  // ---------------------------------------------------------------- 兵糧・疲労
  // ================================================================ 兵站（v0.9）
  // 陣営ごとの補給網：味方の拠点がある国から街道をたどり、敵の拠点・軍勢がいる国で断たれる。海路は水軍がある陣営だけ。
  var SUP_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null, SUP_RANGE = 260;
  function supplyNet(s, fid) {
    var lord = topLord(s, fid), ent = SUP_CACHE && SUP_CACHE.get(s);
    if (!ent || ent.day !== s.day || ent.seq !== s.seq) { ent = { day: s.day, seq: s.seq, nets: {} }; if (SUP_CACHE) SUP_CACHE.set(s, ent); }
    if (ent.nets[lord]) return ent.nets[lord];
    var own = {}, block = {}, navy = Object.keys(s.factions).some(function (k) { var x = s.factions[k]; return x.alive && x.navy && topLord(s, k) === lord; });
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (!b.owner) return; if (topLord(s, b.owner) === lord) own[b.province] = true; else if (atWar(s, lord, b.owner) && b.garrison > 30) block[b.province] = (block[b.province] || 0) + b.garrison; });
    Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (atWar(s, lord, a.faction) && a.troops >= 100) block[a.province] = (block[a.province] || 0) + a.troops; });
    var dist = {}, q = [];
    Object.keys(own).forEach(function (p) { dist[p] = 0; q.push(p); });
    while (q.length) { // 小さな国数なので素朴なダイクストラで足りる
      q.sort(function (a, b) { return dist[a] - dist[b]; }); var u = q.shift();
      if (block[u] && !own[u]) continue; // 敵が押さえる国の先へは運べない
      neighbors(s, u).forEach(function (rid) { var e = s.roads[rid], v = e.a === u ? e.b : e.a;
        if (e.kind === 'sea' && !navy) return;
        var w = e.km * (e.kind === 'mountain' ? 1.4 : e.kind === 'sea' ? 1.2 : 1), nd = dist[u] + w;
        if (nd > SUP_RANGE) return; if (dist[v] == null || nd < dist[v]) { if (dist[v] == null) q.push(v); dist[v] = nd; } });
    }
    ent.nets[lord] = dist; return dist;
  }
  function supplyAt(s, fid, pid) { var d = supplyNet(s, fid)[pid]; return d == null ? null : d; }
  function forageRate(s, pid) { // 現地調達できる量の係数：季節・荒廃・飢饉
    var m = s.date.m, season = (m >= 11 || m <= 2) ? 0.35 : (m === 9 || m === 10) ? 1.4 : (m >= 4 && m <= 7) ? 0.7 : 1;
    var pv = PV(s, pid); return season * (1 - pv.devastation / 110) * (famine(s) ? 0.4 : 1);
  }
  function famine(s) { return s.flags.famineUntil != null && s.day < s.flags.famineUntil; }
  function foodPrice(s) { // 兵糧の相場（1＝平年の銭1貫で1石）：収穫期は安く、端境期と飢饉は高い
    var m = s.date.m; return Math.round(((m >= 9 && m <= 11) ? 0.8 : (m >= 4 && m <= 7) ? 1.3 : 1) * (famine(s) ? 2.2 : 1) * 100) / 100;
  }
  // 籠城の兵糧：拠点ごとの蔵。包囲されていなければ持ち主の蔵から少しずつ補う
  function baseFoodCap(s, b) { return Math.round(Math.max(b.garrison, 50) * 0.005 * ({ '城': 150, '館': 90, '寺社': 120, '都': 60, '御所': 60, '国府': 90, '港': 70 }[b.type] || 90)); }
  function siegeSupply(s) {
    var sieged = {}; Object.keys(s.battles).forEach(function (k) { var bt = s.battles[k]; if (bt.base) sieged[bt.base] = bt; });
    Object.keys(s.bases).forEach(function (k) {
      var b = s.bases[k]; if (!b.owner || b.garrison <= 0) return;
      if (b.food == null) b.food = baseFoodCap(s, b);
      var need = b.garrison * 0.005, bt = sieged[k], f = F(s, b.owner);
      b.food = Math.max(0, b.food - need);
      if (!bt) { b.hunger = 0; var miss = baseFoodCap(s, b) - b.food;
        if (miss > 0) { var local = Math.min(miss, need * 2 * (1 - PV(s, b.province).devastation / 120)); b.food += local; miss -= local; } // 包囲されていなければ近在の村から米が入る
        if (miss > 0 && f && f.food > 0) { var t = Math.min(miss, Math.max(need * 5, f.food * 0.02)); f.food -= t; b.food += t; } return; }
      if (b.food > 0) { b.hunger = 0; return; }
      b.hunger = (b.hunger || 0) + 1;
      var lost = Math.max(1, Math.round(b.garrison * 0.04)); b.garrison = Math.max(0, b.garrison - lost);
      bt.sides.def.forEach(function (id) { var a = s.armies[id]; if (a) a.morale = clamp(a.morale - 3, 0, 100); });
      if (b.hunger === 1) news(s, b.name + 'の兵糧が尽きた。城兵が落ちはじめている', { type: 'military', important: b.owner === s.playerFaction, factions: [b.owner, bt.attFaction], province: b.province });
      if (b.hunger >= 12 || b.garrison < 10) { // 開城
        news(s, '【開城】' + b.name + 'は兵糧が尽き、' + fname(s, bt.attFaction) + 'に城を明け渡した', { type: 'military', important: true, factions: [b.owner, bt.attFaction], province: b.province });
        if (b.owner !== s.playerFaction) aiLog(s, b.owner, b.name + 'を開城', '籠城' + bt.days + '日・兵糧切れ' + b.hunger + '日');
        b.food = 0; endBattle(s, bt, 'att');
      }
    });
  }
  function supplyAndFatigue(s) {
    Object.keys(s.armies).forEach(function (k) {
      var a = s.armies[k], f = F(s, a.faction);
      var need = a.troops * 0.005;
      a.food -= need * (a.bugyo ? 0.9 : 1);
      // 補給：補給網（拠点から街道をたどる）に入っていれば蔵から運ぶ。遠いほど途中で目減りする
      var sd = supplyAt(s, a.faction, a.province), supplied = sd != null; a.supply = supplied ? Math.round(sd) : null;
      if (supplied && a.food < need * 10) { var eff = 1 - sd / 600, t = Math.min(need * 15, f.food * eff); if (t > 0) { f.food -= t / eff; a.food += t; } }
      if (!supplied && a.food < need * 5 && a.status !== 'battle') { // 現地調達：季節・荒廃・飢饉で量が変わり、国が荒れる
        var pv = PV(s, a.province); var got = Math.min(need * 1.2, pv.output * 0.00012 * forageRate(s, a.province));
        a.food += got; pv.unrest = clamp(pv.unrest + 1, 0, 100); pv.devastation = clamp(pv.devastation + 0.4 + a.troops / 5000, 0, 100);
      }
      if (a.food <= 0) {
        a.food = 0; a.morale = clamp(a.morale - 4, 0, 100); a.starve = (a.starve || 0) + 1;
        var desert = Math.round(a.troops * 0.03); a.troops -= desert;
        if (a.starve === 1 || s.day % 5 === 0) news(s, armyLabel(s, a) + 'は兵糧が尽き、逃亡者が出ている' + (supplied ? '' : '（補給が届かない）'), { type: 'military', factions: [a.faction], important: a.faction === s.playerFaction && a.starve === 1 });
        if (a.starve >= 6 && a.status !== 'battle' && a.status !== 'retreating' && a.mission !== 'flight') { // 兵糧切れが続けば退く
          news(s, '【退却】' + armyLabel(s, a) + 'は兵糧が続かず退いた', { type: 'military', important: true, factions: [a.faction], province: a.province });
          if (a.faction !== s.playerFaction) aiLog(s, a.faction, armyLabel(s, a) + 'が兵糧切れで退却', '兵糧切れ' + a.starve + '日');
          retreat(s, a); a.starve = 0;
        }
      } else if (a.starve) a.starve = 0;
      if (a.food > 0 && (a.status === 'idle' || a.status === 'gathering')) { // 味方の拠点のある国で休めば士気は早く戻る
        var rest = Object.keys(s.bases).some(function (bk) { var b = s.bases[bk]; return b.province === a.province && sameCamp(s, b.owner, a.faction); });
        a.morale = clamp(a.morale + (rest ? 2 : 0.5), 0, 90); }
      if (a.fatigue > 70) a.morale = clamp(a.morale - 1, 0, 100);
    });
  }

  // ---------------------------------------------------------------- 戦闘
  function detectBattles(s) {
    Object.keys(s.provinces).forEach(function (pid) {
      var as = provinceArmies(s, pid).filter(function (a) { return !(a.base && a.status === 'idle' && B(s, a.base) && sameCamp(s, B(s, a.base).owner, a.faction) && a.mission !== 'attack'); });
      if (as.length < 2) return;
      for (var i = 0; i < as.length; i++) for (var j = i + 1; j < as.length; j++) {
        var a = as[i], b = as[j];
        if (a.battleId || b.battleId) continue;
        if (!atWar(s, a.faction, b.faction)) continue;
        // 攻勢側：行軍中・攻撃任務の側
        var att = (a.mission === 'attack' || a.status === 'marching') ? a : b, def = att === a ? b : a;
        startFieldBattle(s, att, def, pid);
      }
    });
  }
  function battleName(s, pid, base) {
    if (base) return base.name + 'の戦い';
    var bf = s.battlefields[pid];
    return (bf || PV(s, pid).name) + 'の戦い';
  }
  function joinAllies(s, bt) {
    provinceArmies(s, bt.province).forEach(function (x) {
      if (x.battleId) return;
      if (bt.sides.att.some(function (id) { return s.armies[id] && sameCamp(s, s.armies[id].faction, x.faction); })) { bt.sides.att.push(x.id); x.battleId = bt.id; x.status = 'battle'; }
      else if (bt.sides.def.some(function (id) { return s.armies[id] && sameCamp(s, s.armies[id].faction, x.faction); })) { bt.sides.def.push(x.id); x.battleId = bt.id; x.status = 'battle'; }
    });
  }
  function startFieldBattle(s, att, def, pid) {
    var id = nid(s, 'battle');
    var bt = { id: id, name: battleName(s, pid), province: pid, base: null, sides: { att: [att.id], def: [def.id] }, startDay: s.day, days: 0,
      start: { att: att.troops, def: def.troops }, losses: { att: 0, def: 0 }, attFaction: att.faction, defFaction: def.faction, log: [] };
    s.battles[id] = bt; att.battleId = id; def.battleId = id; att.status = 'battle'; def.status = 'battle';
    joinAllies(s, bt);
    // 奇襲判定（知略差・夜襲）
    var ai = att.commander ? Pn(s, att.commander).abilities.intellect : 40, di = def.commander ? Pn(s, def.commander).abilities.intellect : 40;
    bt.surprise = rand(s) < clamp(0.1 + (ai - di) / 150, 0.03, 0.4) ? 'att' : null;
    var ev = news(s, '【合戦】' + bt.name + '：' + armyLabel(s, att) + ' と ' + armyLabel(s, def) + ' が激突' + (bt.surprise ? '（奇襲）' : ''), { type: 'battle', important: true, factions: [att.faction, def.faction], province: pid });
    if (involvesPlayer(s, att.faction) || involvesPlayer(s, def.faction))
      stop(s, { key: 'battle_start', title: bt.name, place: PV(s, pid).name, persons: [att.commander, def.commander].filter(Boolean), battle: id,
        text: fname(s, att.faction) + '（' + pname(s, att.commander) + '・' + Math.round(att.troops) + '）と' + fname(s, def.faction) + '（' + pname(s, def.commander) + '・' + Math.round(def.troops) + '）が' + PV(s, pid).name + 'で交戦を開始した。戦闘は自動で解決される。' + (bt.surprise ? '攻め手が奇襲に成功した。' : ''),
        choices: [] });
    return bt;
  }
  function startBaseBattle(s, a, b) {
    // 守備兵（拠点）との戦い。拠点にいる守備軍がいればそれも防御側
    if (b.owner && b.owner !== s.playerFaction) { s.aiUrgent = s.aiUrgent || {}; s.aiUrgent[b.owner] = b.id; } // 攻められた家は当日のうちに評定する
    // その国でまだ動員していない武士団は籠城に加わる
    var levy = b.owner ? Math.min(availableBandTroops(s, b.owner, b.province, true), Math.max(60, b.garrison)) : 0;
    if (levy >= 10) { levy = Math.floor(levy); var nd = levy; bandsIn(s, b.owner, b.province).forEach(function (x) { var n = Math.min(nd, Math.floor(x.strength - x.mobilized)); if (n <= 0) return; x.strength -= n; x.base = Math.max(0, x.base - n); nd -= n; }); b.garrison += levy - nd; news(s, PV(s, b.province).name + 'の武士' + (levy - nd) + 'が' + b.name + 'の籠城に加わった', { type: 'military', factions: [b.owner], province: b.province }); }
    var id = nid(s, 'battle');
    var bt = { id: id, name: battleName(s, b.province, b), province: b.province, base: b.id, sides: { att: [a.id], def: [] }, startDay: s.day, days: 0,
      start: { att: a.troops, def: b.garrison }, losses: { att: 0, def: 0 }, attFaction: a.faction, defFaction: b.owner, log: [] };
    provinceArmies(s, b.province).forEach(function (x) { if (!x.battleId && x.base === b.id && sameCamp(s, x.faction, b.owner)) { bt.sides.def.push(x.id); x.battleId = id; x.status = 'battle'; bt.start.def += x.troops; } });
    s.battles[id] = bt; a.battleId = id; a.status = 'battle';
    joinAllies(s, bt);
    var ai = a.commander ? Pn(s, a.commander).abilities.intellect : 40;
    bt.surprise = rand(s) < clamp(0.12 + ai / 400, 0.05, 0.35) ? 'att' : null;
    news(s, '【合戦】' + bt.name + '：' + armyLabel(s, a) + 'が' + b.name + '（守備' + Math.round(bt.start.def) + '）を攻撃' + (bt.surprise ? '（夜襲）' : ''), { type: 'battle', important: true, factions: [a.faction, b.owner], province: b.province });
    if (b.id === 'kofukuji' || b.id === 'todaiji') s.flags.nantoAttacked = b.id;
    if (involvesPlayer(s, a.faction) || involvesPlayer(s, b.owner))
      stop(s, { key: 'battle_start', title: bt.name, place: b.name, persons: [a.commander].filter(Boolean), battle: id,
        text: fname(s, a.faction) + 'の' + armyLabel(s, a) + 'が' + fname(s, b.owner) + 'の' + b.name + 'を攻撃した。守備兵 ' + Math.round(bt.start.def) + '、防御 ' + b.defense + '。', choices: [] });
    return bt;
  }
  function involvesPlayer(s, fid) { return !!s.playerFaction && fid && (fid === s.playerFaction || topLord(s, fid) === s.playerFaction); }
  // 軍の質：総大将と各部隊の大将の能力、部隊の大きさ、軍奉行の有無
  function armyQuality(s, a) {
    var c = a.commander && s.persons[a.commander] && s.persons[a.commander].alive ? s.persons[a.commander].abilities : { command: 35, valor: 35, intellect: 35 };
    var cp = a.corps && s.corps && s.corps[a.corps];
    var remoteNote = null;
    if (cp && alive(s, cp.commander)) { // 軍団の総大将が同じ国にいれば、その采配が及ぶ。本陣に残る場合は半分だけ及ぶ
      var ca = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (x) { return x.corps === a.corps && x.commander === cp.commander; })[0];
      if (ca && ca.province === a.province && ca.id !== a.id) c = Pn(s, cp.commander).abilities;
      else if (!ca && cp.remote) { var C = Pn(s, cp.commander).abilities; c = { command: (C.command + c.command) / 2, valor: c.valor, intellect: c.intellect }; remoteNote = '総大将は本陣から采配（統率の効果は半分）'; }
    }
    var divs = (a.divisions && a.divisions.length) ? a.divisions : [{ leader: a.commander, troops: a.troops }];
    var tt = divs.reduce(function (t, d) { return t + Math.max(1, d.troops); }, 0);
    var lead = 0, val = 0, over = 0;
    divs.forEach(function (d) {
      var ab = d.leader && s.persons[d.leader] && s.persons[d.leader].alive ? s.persons[d.leader].abilities : { command: 30, valor: 30 };
      var w = Math.max(1, d.troops) / tt; lead += ab.command * w; val += ab.valor * w;
      over += Math.max(0, d.troops - 1500) / 1000;                     // 一人の大将が率いられるのは千五百程度まで
    });
    var L = 0.5 * c.command + 0.5 * lead;
    var q = (0.6 + L / 125) * (0.85 + val / 500);
    var notes = [];
    var bf = 0;
    var bug = a.bugyo;
    if (!bug && cp && cp.bugyo && alive(s, cp.bugyo)) { var ba = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (x) { return x.corps === a.corps && x.bugyo === cp.bugyo; })[0]; if (ba && ba.province === a.province) bug = cp.bugyo; }
    var big = cp ? Object.keys(s.armies).reduce(function (t, k) { var x = s.armies[k]; return t + (x.corps === a.corps && x.province === a.province ? x.troops : 0); }, 0) : a.troops;
    if (bug && s.persons[bug] && s.persons[bug].alive) { bf = 0.05 + s.persons[bug].abilities.intellect / 1000; notes.push('軍奉行 +' + Math.round(bf * 100) + '%'); }
    else if (big > 1000) { bf = -0.06; notes.push('軍奉行なし −6%（軍紀・兵站の乱れ）'); }
    if (remoteNote) notes.push(remoteNote);
    var op = -Math.min(0.15, over * 0.03); if (op < 0) notes.push('部隊が大きすぎる ' + Math.round(op * 100) + '%');
    var inst = F(s, topLord(s, a.faction)).institutions || {};
    var ib = inst.samurai_dokoro ? 0.03 : 0; if (ib) notes.push('侍所 +3%');
    var tf = F(s, topLord(s, a.faction)), sb = 0;
    if (tf && tf.flags && tf.flags.strifeUntil > s.day) { sb -= 0.06; notes.push('家中の内紛 −6%'); }
    if (tf && tf.regime && tf.regime.commandBonus) { sb += tf.regime.commandBonus; notes.push('指揮系統 +3%'); }
    if (tf && tf.flags && tf.flags.surpriseUntil != null && s.day <= tf.flags.surpriseUntil && a.mission === 'attack') { sb = 0.35; notes.push('挙兵直後の奇襲 +35%'); }
    return { factor: q * (1 + bf + op + ib + sb), lead: Math.round(L), valor: Math.round(val), notes: notes };
  }
  function sidePower(s, ids, defending, bt) {
    var tot = 0, troops = 0;
    ids.forEach(function (id) {
      var a = s.armies[id]; if (!a) return;
      var f = armyQuality(s, a).factor * (0.4 + a.morale / 110) * (1 - a.fatigue / 220) * (a.food > 0 ? 1 : 0.7);
      tot += a.troops * f; troops += a.troops;
    });
    if (defending && bt.base) { var b = B(s, bt.base); tot += b.garrison * 0.9; troops += b.garrison; tot *= 1 + b.defense / 60; }
    if (defending && !bt.base) { var t = PV(s, bt.province).terrain; tot *= (t === '山地' ? 1.2 : 1.05); }
    return { power: tot, troops: troops };
  }
  function resolveBattles(s) {
    Object.keys(s.battles).forEach(function (k) {
      var bt = s.battles[k]; bt.days += 1;
      bt.sides.att = bt.sides.att.filter(function (id) { return s.armies[id] && s.armies[id].troops > 0; });
      bt.sides.def = bt.sides.def.filter(function (id) { return s.armies[id] && s.armies[id].troops > 0; });
      var A = sidePower(s, bt.sides.att, false, bt), D = sidePower(s, bt.sides.def, true, bt);
      if (bt.surprise === 'att' && bt.days === 1) A.power *= 1.6;
      if (A.troops <= 0) return endBattle(s, bt, 'def');
      if (D.troops <= 0) return endBattle(s, bt, 'att');
      var k1 = rr(s, 0.035, 0.07);
      var lossA = D.power * k1 * (bt.base ? 1.1 : 1), lossD = A.power * rr(s, 0.035, 0.07) * (bt.base ? 0.55 : 1);
      applyLoss(s, bt.sides.att, lossA, A.troops); bt.losses.att += lossA;
      if (bt.base) { var b = B(s, bt.base); var gl = Math.min(b.garrison, lossD * (b.garrison / Math.max(1, D.troops))); b.garrison -= gl; applyLoss(s, bt.sides.def, lossD - gl, D.troops - b.garrison - gl); b.defense = Math.max(0, b.defense - rr(s, 1, 4)); }
      else applyLoss(s, bt.sides.def, lossD, D.troops);
      bt.losses.def += lossD;
      // 士気
      var ra = lossA / Math.max(1, A.troops), rd = lossD / Math.max(1, D.troops);
      moraleHit(s, bt.sides.att, ra * 120 + (A.power < D.power ? 3 : 0));
      moraleHit(s, bt.sides.def, rd * 120 + (D.power < A.power ? 3 : 0));
      // 動揺・潰走（水鳥の羽音のような総崩れ）
      [['att', bt.sides.att, D, A], ['def', bt.sides.def, A, D]].forEach(function (x) {
        var arr = x[1]; if (!arr.length) return;
        var avgM = avg(s, arr, 'morale'), avgF = avg(s, arr, 'fatigue');
        if (avgM < 45 && avgF > 55 && rand(s) < 0.15) { arr.forEach(function (id) { s.armies[id].morale = 5; }); bt.log.push('day' + bt.days + ':' + x[0] + '総崩れ'); news(s, bt.name + '：' + (x[0] === 'att' ? '攻め手' : '守り手') + 'が夜陰に動揺し、総崩れとなった', { type: 'battle', important: true, province: bt.province }); }
      });
      var mA = avg(s, bt.sides.att, 'morale'), mD = bt.sides.def.length ? avg(s, bt.sides.def, 'morale') : 60;
      var curA = A.troops - lossA, curD = D.troops - lossD;
      if (mA < 22 || curA < bt.start.att * 0.35) return endBattle(s, bt, 'def');
      if (bt.base) { var gb = B(s, bt.base).garrison; if ((gb < 10 && (!bt.sides.def.length || mD < 22)) || curD < bt.start.def * 0.25) return endBattle(s, bt, 'att'); } // 籠城は守備兵が尽きるまで続く
      else if (bt.sides.def.length && (mD < 22 || curD < bt.start.def * 0.3)) return endBattle(s, bt, 'att');
      if (bt.base && bt.days > 25) return endBattle(s, bt, B(s, bt.base).garrison > 0 ? 'def' : 'att');
      if (!bt.base && bt.days > 6) return endBattle(s, bt, A.power > D.power ? 'att' : 'def');
    });
  }
  function estimateOdds(s, armyId, target) {
    var a = s.armies[armyId]; if (!a) return null;
    var mine = a.troops * armyQuality(s, a).factor * (0.4 + a.morale / 110) * (1 - Math.min(80, a.fatigue + 15) / 220);
    var dpow = 0, dtro = 0, label = '';
    if (target.type === 'base') {
      var b = B(s, target.id); if (!b.owner || sameCamp(s, b.owner, a.faction)) return { odds: null, note: '味方・無主の拠点' };
      dpow = b.garrison * 0.9; dtro = b.garrison;
      provinceArmies(s, b.province).forEach(function (x) { if (sameCamp(s, x.faction, b.owner)) { dpow += x.troops * armyQuality(s, x).factor * (0.4 + x.morale / 110); dtro += x.troops; } });
      dpow *= 1 + b.defense / 60; mine *= 1.1; label = b.name;
    } else {
      provinceArmies(s, target.id).forEach(function (x) { if (atWar(s, a.faction, x.faction)) { dpow += x.troops * armyQuality(s, x).factor * (0.4 + x.morale / 110); dtro += x.troops; } });
      var t = PV(s, target.id).terrain; dpow *= (t === '山地' ? 1.2 : 1.05); label = PV(s, target.id).name;
      if (!dtro) return { odds: null, note: '敵軍はいない' };
    }
    var r = mine / Math.max(1, dpow), p = Math.pow(r, 2.2) / (1 + Math.pow(r, 2.2));
    return { odds: Math.round(p * 100), enemyTroops: Math.round(dtro), ratio: Math.round(r * 100) / 100, target: label, quality: armyQuality(s, a) };
  }
  function avg(s, ids, key) { var t = 0, n = 0; ids.forEach(function (id) { var a = s.armies[id]; if (a) { t += a[key] * a.troops; n += a.troops; } }); return n ? t / n : 0; }
  function applyLoss(s, ids, loss, total) { ids.forEach(function (id) { var a = s.armies[id]; if (!a || total <= 0) return; var before = a.troops; a.troops = Math.max(0, a.troops - loss * (a.troops / total)); var k = before ? a.troops / before : 0; (a.divisions || []).forEach(function (d) { d.troops = Math.floor(d.troops * k); }); }); }
  function moraleHit(s, ids, v) { ids.forEach(function (id) { var a = s.armies[id]; if (a) a.morale = clamp(a.morale - v, 0, 100); }); }

  function endBattle(s, bt, winner) {
    delete s.battles[bt.id];
    var winIds = winner === 'att' ? bt.sides.att : bt.sides.def, loseIds = winner === 'att' ? bt.sides.def : bt.sides.att;
    var winF = winner === 'att' ? bt.attFaction : bt.defFaction, loseF = winner === 'att' ? bt.defFaction : bt.attFaction;
    var big = (bt.start.att + bt.start.def) >= 800 ? 1 : 0.4;
    var honored = {}; winIds.forEach(function (id) { var a = s.armies[id]; if (!a) return; var cpx = s.corps[a.joinCorps || a.corps]; if (!cpx || !cpx.senjin || honored[cpx.id]) return; var rec = (cpx.contingents || []).filter(function (c) { return c.id === cpx.senjin && /joined/.test(c.decision); })[0]; if (!rec) return; honored[cpx.id] = 1; var rr0 = { kind: rec.kind, id: rec.id }; retAddLoyalty(s, rr0, cpx.faction, 8); addService(s, cpx.faction, rec.id, 2); news(s, '【先陣の功名】' + rec.name + 'は' + bt.name + 'で先陣を務め、名を上げた（忠誠が上がる。恩賞で報いること）', { type: 'military', important: true, factions: [cpx.faction] }); });
    winIds.forEach(function (id) { var a = s.armies[id]; if (!a || !a.corps || !s.corps[a.corps]) return; (s.corps[a.corps].contingents || []).forEach(function (c) { if (/joined/.test(c.decision)) addService(s, s.corps[a.corps].faction, c.id, 3 * big); }); if (a.faction !== s.corps[a.corps].faction) addService(s, s.corps[a.corps].faction, a.faction, 3 * big); }); // 勝ち戦の奉公 [[winF, 1.5], [loseF, -2.5]].forEach(function (x) { var rf = x[0] && F(s, topLord(s, x[0])); if (rf && rf.regime) { rf.regime.cohesion = clamp(rf.regime.cohesion + x[1] * big, 0, 100); if (x[1] > 0 && rf.id === 'yoritomo') rf.regime.maturity = clamp(rf.regime.maturity + 0.3 * big, 0, 100); } }); // 勝てば家臣団がまとまる
    var dead = [], captured = [];
    // 敗者の指揮官の生死
    loseIds.forEach(function (id) {
      var a = s.armies[id]; if (!a) return;
      [a.commander].concat(a.officers).forEach(function (pid) {
        var p = s.persons[pid]; if (!p || !p.alive) return;
        var r = rand(s), heavy = a.troops < a.initialTroops * 0.4;
        var lf = F(s, p.faction), isLeader = lf && lf.leader === p.id, m = isLeader ? 0.35 : 1; // 当主は郎党に守られ落ち延びやすい
        if (historyProtects(s, p, winF, loseF)) m = 0;
        if (r < ((heavy ? 0.012 : 0.003) + (p.abilities.valor > 80 ? 0.002 : 0)) * m) { killPerson(s, p, 'battle', bt.name + 'で討死'); dead.push(p.name); } // 討死はまれ（郎党が身を挺して落ち延びさせる）
        else if (r < (heavy ? 0.08 : 0.025) * m) { p.captiveOf = winF; p.location = null; captured.push(p.name); }
      });
    });
    // 敗軍は退却、勝軍は待機
    loseIds.forEach(function (id) { var a = s.armies[id]; if (!a) return; a.battleId = null; a.morale = Math.max(a.morale, 15); retreat(s, a); });
    winIds.forEach(function (id) { var a = s.armies[id]; if (!a) return; a.battleId = null; a.status = 'idle'; a.morale = clamp(a.morale + 10, 0, 95); });
    if (bt.base && winner === 'def' && s.playerFaction && !s._noFailPrompt) { var mineL = loseIds.map(function (id) { return s.armies[id]; }).filter(function (a) { return a && a.faction === s.playerFaction; });
      if (mineL.length) { var bb = B(s, bt.base), rest = mineL.reduce(function (t, a) { return t + a.troops; }, 0);
        stop(s, { key: 'attack_failed', base: bt.base, armies: mineL.map(function (a) { return a.id; }), title: bb.name + 'の攻撃は失敗した', persons: mineL.map(function (a) { return a.commander; }).filter(Boolean),
          text: bb.name + 'を落とせず、味方は退いた（残る兵 約' + Math.round(rest) + '、士気は落ちている）。\n兵をどうするか決める。何もしなければ、退いた先でしばらく待機したのち館に戻る。',
          choices: [{ id: 'return', label: '館に戻して兵を休める（武士団に戻し、また出陣できる）' }, { id: 'retry', label: '兵を立て直して、もう一度攻める' }, { id: 'stay', label: 'その場で待機する' }] }); } }
    var capturedBase = null;
    if (bt.base && winner === 'att' && s.playerFaction && sameCamp(s, winF, s.playerFaction)) {
      var helpers = {}; winIds.forEach(function (id) { var a = s.armies[id]; if (!a) return; var cpx = s.corps[a.joinCorps || a.corps]; if (!cpx || cpx.faction !== s.playerFaction) return; (cpx.contingents || []).forEach(function (c) { if (/joined/.test(c.decision)) helpers[c.id] = c.name; }); if (a.lordOrder && a.lordOrder.lord === s.playerFaction) helpers[a.house || a.faction] = a.house ? H(s, a.house).name : fname(s, a.faction); });
      var hk = Object.keys(helpers);
      if (hk.length) stop(s, { key: 'rewards', base: bt.base, helpers: hk, title: '論功行賞：' + B(s, bt.base).name, text: B(s, bt.base).name + 'を落とした。働いた家：' + hk.map(function (k) { return helpers[k]; }).join('・') + '。\n働きに報いなければ、奉公が積もって不満になる。御恩・所領・没官領の処分は「恩賞」タブからいつでも行える。',
        choices: [{ id: 'kanjo', label: '感状と引出物を配る（' + hk.length * 40 + '貫）' }, { id: 'kanjo_only', label: '感状だけ配る（銭はかからない）' }, { id: 'later', label: 'あとで恩賞を考える' }] });
    }
    if (bt.base && winner === 'att') {
      var b = B(s, bt.base), old = b.owner; capturedBase = b;
      b.owner = winF; conquerHoldings(s, b, old, winF); var w = s.armies[winIds[0]]; b.garrison = w ? Math.round(Math.min(w.troops * 0.15, 300)) : 50; if (w) { w.troops -= b.garrison; w.base = b.id; }
      // 拠点にいた人物
      var of = F(s, old);
      factionPersons(s, old).forEach(function (p) { if (p.location === b.id) { if (historyProtects(s, p, winF, old)) { var nb0 = factionBases(s, old).filter(function (x) { return x.id !== b.id; })[0]; p.location = nb0 ? nb0.id : null; return; } var r = rand(s) + (nonCombatant(p) ? 0.4 : 0) + (of && of.leader === p.id ? 0.25 : 0); if (r < 0.03) { killPerson(s, p, 'battle', b.name + '陥落時に討たれる'); dead.push(p.name); } else if (r < 0.3) { p.captiveOf = winF; p.location = null; captured.push(p.name); } else { var nb = factionBases(s, old)[0]; p.location = nb ? nb.id : null; } } });
      if (of && of.capital === b.id) { var rest = factionBases(s, old); of.capital = rest.length ? rest[0].id : null; }
      if (bt.base === 'kofukuji' || bt.base === 'todaiji') nantoBurned(s, winF);
    }
    var lossTxt = '損害 攻' + Math.round(bt.losses.att) + '／守' + Math.round(bt.losses.def);
    var txt = bt.name + '終結（' + bt.days + '日間）：' + fname(s, winF) + 'の勝利。' + lossTxt + (dead.length ? '。討死：' + dead.join('、') : '') + (captured.length ? '。捕虜：' + captured.join('、') : '') + (capturedBase ? '。' + capturedBase.name + 'が陥落' : '');
    news(s, txt, { type: 'battle', important: true, factions: [winF, loseF], province: bt.province });
    s.battleHistory.push({ name: bt.name, date: dateStr(s), province: bt.province, winner: winF, loser: loseF, days: bt.days, start: bt.start, losses: { att: Math.round(bt.losses.att), def: Math.round(bt.losses.def) }, dead: dead, captured: captured, baseFallen: capturedBase ? capturedBase.id : null });
    // 名声・正当性
    var wf = F(s, winF), lf = F(s, loseF); if (wf) wf.legitimacy = clamp(wf.legitimacy + 3, 0, 100); if (lf) lf.legitimacy = clamp(lf.legitimacy - 3, 0, 100);
    broadcast(s, 'lastBattle', bt.province, null);
    s.flags.battlesWon = s.flags.battlesWon || {}; s.flags.battlesWon[winF] = (s.flags.battlesWon[winF] || 0) + 1;
    if (involvesPlayer(s, winF) || involvesPlayer(s, loseF) || capturedBase) stop(s, { key: capturedBase ? 'base_fall' : 'battle_end', title: bt.name + ' 決着', place: PV(s, bt.province).name, text: txt, choices: [] });
  }

  // ---- 退却命令：行軍中・交戦中の自軍を引かせる（交戦中は追撃で損害を受ける）
  function withdrawArmy(s, fid, aid) {
    var a = s.armies[aid]; if (!a || a.faction !== fid) return { ok: false, reason: '自軍の軍勢ではない' };
    if (a.status === 'retreating') return { ok: false, reason: 'すでに退却中' };
    var label = armyLabel(s, a), msg;
    if (a.battleId && s.battles[a.battleId]) {
      var bt = s.battles[a.battleId], side = bt.sides.att.indexOf(a.id) >= 0 ? 'att' : 'def', other = side === 'att' ? 'def' : 'att';
      var mine = sidePower(s, [a.id], side === 'def', bt), theirs = sidePower(s, bt.sides[other], other === 'def', bt);
      var lossR = clamp(0.06 + 0.06 * theirs.power / Math.max(1, mine.power), 0.06, 0.3), lost = Math.round(a.troops * lossR);
      if (bt.sides[side].length <= 1) { s._noFailPrompt = true; endBattle(s, bt, other); s._noFailPrompt = false; } // 最後の一隊が引けば、合戦は相手の勝ち
      else { bt.sides[side] = bt.sides[side].filter(function (x) { return x !== a.id; }); a.battleId = null; retreat(s, a); }
      a.troops = Math.max(1, a.troops - lost); a.morale = Math.max(5, a.morale - 12); a.withdrawHome = true; a.corps = null;
      msg = label + 'に退却を命じた。追撃を受けて約' + lost + 'を失った';
    } else {
      a.corps = null; a.gatherUntil = 0; if (a.status === 'gathering') a.status = 'idle';
      var own = Object.keys(s.bases).some(function (k) { return s.bases[k].province === a.province && sameCamp(s, s.bases[k].owner, fid); });
      if (own && a.status !== 'marching') { disbandArmy(s, a, 'garrison'); return { ok: true, message: label + 'は館に戻り、兵を武士団に戻した' }; }
      retreat(s, a); a.withdrawHome = true; msg = label + 'に退却を命じた' + (a.retreatTo && B(s, a.retreatTo) ? '（' + B(s, a.retreatTo).name + 'へ）' : '');
    }
    news(s, msg, { type: 'order', factions: [fid] }); return { ok: true, message: msg };
  }
  function retreat(s, a) {
    var own = factionBases(s, a.faction).concat(Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.owner && b.owner !== a.faction && sameCamp(s, b.owner, a.faction); }));
    var avoid = {}; Object.keys(s.armies).forEach(function (k) { var x = s.armies[k]; if (atWar(s, x.faction, a.faction)) avoid[x.province] = 1; });
    var best = null, bd = 1e9;
    own.forEach(function (b) { if (b.province === a.province && !avoid[a.province]) { best = b; bd = 0; return; } var p = findPath(s, a.province, b.province, a.faction, avoid); if (!p) return; var d = pathKm(s, p) + p.filter(function (x) { return avoid[x]; }).length * 400; if (d < bd) { bd = d; best = b; } });
    if (!best) { a.status = 'idle'; a.mission = 'idle'; return; }
    if (best.province === a.province) { a.base = best.id; a.status = 'idle'; a.mission = 'idle'; a.path = []; a.target = null; news(s, armyLabel(s, a) + 'は' + best.name + 'に籠もった', { type: 'military', factions: [a.faction] }); return; }
    var path = findPath(s, a.province, best.province, a.faction, avoid);
    a.path = path.slice(1); a.edge = null; a.status = a.path.length ? 'retreating' : 'idle'; a.retreatTo = best.id; a.mission = 'retreat'; a.target = { type: 'base', id: best.id };
    news(s, armyLabel(s, a) + 'は' + best.name + 'へ退く', { type: 'military', factions: [a.faction] });
  }
  // 史実モード：プレイヤーが関与しない戦いでは、史実の没年より前に主要人物を死なせない
  function historyProtects(s, p, a, b) {
    if (s.options.mode !== 'historical' || !p.died) return false;
    if (involvesPlayer(s, a) || involvesPlayer(s, b)) return false;
    return s.date.y < p.died || (p.naturalDeath && dayDiffApprox(s.date, p.naturalDeath) < 0);
  }
  function nantoBurned(s, by) {
    if (s.firedEvents.nanto_yakiuchi) return; s.firedEvents.nanto_yakiuchi = s.day;
    ['kofukuji', 'todaiji'].forEach(function (id) { B(s, id).defense = 5; B(s, id).burned = true; });
    Object.keys(s.factions).forEach(function (k) { if (s.factions[k].type === '寺社') { var r = rel(s, by, k); r.value = clamp(r.value - 50, -100, 100); } });
    var f = F(s, by); f.legitimacy = clamp(f.legitimacy - 15, 0, 100);
    ensureCourt(s); var jc = s.court.cliques.jisha; jc.grudge = jc.grudge || {}; jc.grudge[topLord(s, by)] = 45; jc.attitude[topLord(s, by)] = clamp((jc.attitude[topLord(s, by)] || 0) - 45, -100, 100); s.court.cliques.in.influence += 3;
    news(s, '【南都焼討】' + fname(s, by) + 'の兵火により興福寺・東大寺が焼亡。仏敵の汚名を負う', { type: 'event', important: true, factions: [by] });
    stop(s, { key: 'nanto_yakiuchi', title: '南都焼討', place: '大和', text: '戦火は伽藍に及び、興福寺・東大寺が炎上した。寺社勢力・公家の反発は必至である。', choices: [] });
  }
  function killPerson(s, p, cause, note) {
    if (!p.alive) return;
    p.alive = false; p.deathDay = s.day; p.deathDate = dateStr(s); p.deathCause = cause; p.deathNote = note || ''; p.location = null;
    var f = F(s, p.faction);
    var important = f && (f.leader === p.id) || ['antoku', 'takakura', 'goshirakawa', 'kiyomori', 'yoritomo', 'yoshinaka', 'hidehira'].indexOf(p.id) >= 0;
    news(s, '【死去】' + p.name + (note ? '：' + note : '') + (p.born ? '（享年' + (s.date.y - p.born + 1) + '）' : ''), { type: 'death', important: important, factions: [p.faction] });
    if (f && f.leader === p.id) succession(s, f, p);
    if (p.id === 'takakura') takakuraDeath(s);
    if (important) stop(s, { key: 'death', title: p.name + ' 死去', persons: [p.id], text: p.name + 'が亡くなった。' + (note || '') + (f && f.leader !== p.id && f.alive ? '' : ''), choices: [] });
  }
  // ================================================================ 政権の体制・継承・存続AI（v1.0）
  // 当主依存度・組織成熟度・後継者安定度・家臣団結束度・権力集中度・地方統制力・外交能力（政治的正統性は既存の legitimacy）
  var REGIME0 = { // 1180年の初期値（史実の傾向にもとづくゲーム設定）
    heike:     { leaderDep: 85, maturity: 45, heirStab: 50, cohesion: 72, central: 85, local: 50, note: '清盛個人の権威と朝廷への影響力に強く依存。一門の結束は固い。重盛の死（1179）で後継は宗盛' },
    yoritomo:  { leaderDep: 80, maturity: 12, heirStab: 15, cohesion: 40, central: 35, local: 15, note: '発展途上の流人の政権。御家人との関係・所領安堵・勝利・機構の整備で成熟する' },
    kiso:      { leaderDep: 88, maturity: 10, heirStab: 20, cohesion: 55, central: 50, local: 30, note: '義仲個人の武勇に依存' },
    kai:       { leaderDep: 50, maturity: 25, heirStab: 45, cohesion: 42, central: 30, local: 50, note: '一族が並び立つ連合' },
    oshu:      { leaderDep: 55, maturity: 62, heirStab: 60, cohesion: 62, central: 60, local: 75, note: '三代の統治で機構が整う' },
    miura:     { leaderDep: 50, maturity: 40, heirStab: 62, cohesion: 72, central: 50, local: 62, note: '一族の結束が固い相模の大族' },
    mochihito: { leaderDep: 90, maturity: 8, heirStab: 5, cohesion: 40, central: 60, local: 5, note: '以仁王・頼政の個人的な企て' },
  };
  var REGIME_GOAL = { // 家の存続目標・政治的野心（CPUの判断の重みと説明に使う）
    heike: '平家政権と一門の存続', yoritomo: '東国の武家政権を固める', kiso: '入京し源氏の棟梁となる', oshu: '奥州の独立を保つ', kai: '甲斐源氏の自立',
    miura: '相模の支配と一族の繁栄', kazusa: '房総の支配', chiba: '下総の回復と一族の繁栄', mochihito: '平家を退け皇統を正す',
  };
  var HOUSES0 = { // 勢力の内側にある「家」（勢力と家系を分けて扱う。第2仕様の土台）
    hojo: { name: '北条氏', faction: 'yoritomo', head: 'tokimasa', members: ['tokimasa', 'yoshitoki', 'masako', 'munetoki'], ambition: 45, note: '時政の娘・政子は頼朝の妻（史実）。1180年時点では伊豆の小豪族で、幕府の実権はない' },
    hiki: { name: '比企氏', faction: 'yoritomo', head: 'hiki_yoshikazu', members: ['hiki_yoshikazu', 'hikinoama'], ambition: 55, note: '比企尼は頼朝の乳母で流人時代を支えた（史実）' },
  };
  function regimeBase(f) {
    if (REGIME0[f.id]) return JSON.parse(JSON.stringify(REGIME0[f.id]));
    if (f.type.indexOf('寺社') >= 0) return { leaderDep: 15, maturity: 80, heirStab: 90, cohesion: 55, central: 40, local: 60, note: '組織として存続する寺社' };
    if (f.id === 'court') return { leaderDep: 20, maturity: 90, heirStab: 70, cohesion: 40, central: 30, local: 20, note: '朝廷' };
    return { leaderDep: 62, maturity: 28, heirStab: 50, cohesion: 58, central: 50, local: 50, note: '在地の武士団（標準値）' };
  }
  function ensureRegime(s) {
    Object.keys(s.factions).forEach(function (k) { var f = s.factions[k]; if (!f.regime) { f.regime = regimeBase(f); f.regime.confidence = 'ゲーム設定'; f.regime.goal = REGIME_GOAL[k] || '家の存続'; f.regime.lastAct = null; } });
    if (!s.houses) { s.houses = JSON.parse(JSON.stringify(HOUSES0)); Object.keys(s.houses).forEach(function (k) { var h = s.houses[k]; h.id = k; h.influence = 0; h.members = h.members.filter(function (m) { return s.persons[m]; }); if (!s.persons[h.head]) h.head = h.members[0] || null; }); for (var hi = 0; hi < 25; hi++) houseTick(s); }
  }
  function diplomacyOf(s, f) {
    var ps = factionPersons(s, f.id).filter(function (p) { return !p.captiveOf; }), ld = Pn(s, f.leader);
    var best = ps.reduce(function (m, p) { return Math.max(m, p.abilities.diplomacy); }, 0);
    return Math.round(clamp((ld && ld.alive ? ld.abilities.diplomacy * 0.6 : 20) + best * 0.3 + f.courtRelation * 0.1, 0, 100));
  }
  function regimeOf(s, fid) { ensureRegime(s); var f = F(s, fid); var r = f.regime; r.diplomacy = diplomacyOf(s, f); r.legitimacy = f.legitimacy; return r; }
  function heirScore(s, f, p) {
    if (!p || !p.alive) return 0; var age = ageOf(s, p), v = (p.abilities.politics + p.abilities.command) / 2;
    if (age != null && age < 15) v -= 22; else if (age != null && age < 20) v -= 8; else if (age != null && age > 65) v -= 6;
    if (f.heir === p.id) v += 15;
    if ((p.relations || []).some(function (r) { return /父子|兄弟/.test(r.type) && r.person === f.leader; })) v += 8;
    if (p.courtOffices && p.courtOffices.length) v += 4;
    return v;
  }
  function threatRatio(s, fid) { var mine = campPower(s, fid) || 1, en = enemiesOf(s, fid).reduce(function (t, e) { return t + (topLord(s, e) === e ? campPower(s, e) : 0); }, 0); return clamp(en / mine, 0, 3); }
  // 毎月：体制の値が行動・事件によって動く
  function regimeTick(s) {
    ensureRegime(s);
    Object.keys(s.factions).forEach(function (k) {
      var f = s.factions[k]; if (!f.alive || k === 'court') return; var r = f.regime, inst = f.institutions || {}, ld = Pn(s, f.leader);
      var ni = Object.keys(inst).length, vass = Object.keys(s.factions).filter(function (v) { return s.factions[v].alive && s.factions[v].overlord === k; }).length;
      var jito = Object.keys(s.holdings).filter(function (h) { return s.holdings[h].rights && s.holdings[h].rights.jito === k; }).length;
      // 組織成熟度：機構・幕府・御家人の数・地頭・問注所で上がる。内紛と不穏で下がる
      r.maturity = clamp(r.maturity + ni * 0.04 + (f.flags.bakufu ? 0.08 : 0) + Math.min(0.06, vass * 0.015) + Math.min(0.08, jito * 0.005) + (inst.monchujo ? 0.04 : 0) - (f.flags.strifeUntil > s.day ? 0.3 : 0) - (r.maturity > 60 ? 0.05 : 0.02), 0, 100);
      // 当主依存度：成熟するほど下がり、当主の力量が大きいほど上がる
      var lv = ld && ld.alive ? (ld.abilities.politics + ld.abilities.command) / 2 : 40;
      var depT = clamp(95 - r.maturity * 0.75 + (lv - 60) * 0.3 + (r.central - 50) * 0.15, 5, 98); r.leaderDep += (depT - r.leaderDep) * 0.06;
      // 後継者安定度：後継者が決まっているか・年齢・力量・基盤
      var heir = f.heir && alive(s, f.heir) && Pn(s, f.heir).faction === k ? Pn(s, f.heir) : null;
      if (!heir) { var cand = factionPersons(s, k).filter(function (p) { return !p.captiveOf && p.id !== f.leader && (p.relations || []).some(function (x) { return /父子/.test(x.type) && x.person === f.leader; }); }).sort(function (a, b) { return heirScore(s, f, b) - heirScore(s, f, a); })[0]; if (cand && ageOf(s, cand) != null && ageOf(s, cand) >= 12) { f.heir = cand.id; heir = cand; news(s, f.name + 'は' + cand.name + 'を後継者に定めた', { type: 'politics', factions: [k] }); } }
      var hsT = heir ? clamp(35 + heirScore(s, f, heir) * 0.35 + (r.heirBase || 0), 0, 95) : 12; r.heirStab += (hsT - r.heirStab) * 0.08;
      if (r.heirBase) r.heirBase *= 0.97;
      // 家臣団結束度：勝ち負け（合戦の結果で直接動く）・恩賞・集中のしすぎ・内紛
      r.cohesion = clamp(r.cohesion + (55 - r.cohesion) * 0.02 - (r.central > 80 ? 0.4 : 0) - (f.flags.strifeUntil > s.day ? 0.8 : 0), 0, 100);
      // 地方統制力：地頭・問注所・支配国の不穏
      var held = Object.keys(s.provinces).filter(function (p) { var i = provinceInfluence(s, p)[0]; return i && topLord(s, i.faction) === k; });
      var unrest = held.length ? held.reduce(function (t, p) { return t + PV(s, p).unrest; }, 0) / held.length : 50;
      var locT = clamp(20 + r.maturity * 0.4 + Math.min(20, jito * 0.5) + (inst.monchujo ? 8 : 0) - (unrest - 20) * 0.5, 0, 100); r.local += (locT - r.local) * 0.06;
      var cb = (REGIME0[k] || {}).central || 50; r.central += ((cb + (f.flags.bakufu ? 10 : 0)) - r.central) * 0.02; // 権力の集中は元の体質へ少しずつ戻る
      ['leaderDep', 'maturity', 'heirStab', 'cohesion', 'central', 'local'].forEach(function (x) { r[x] = Math.round(r[x] * 10) / 10; });
    });
    houseTick(s);
  }
  // 家（勢力の内側の一族）の政治的影響力：役職・婚姻・兵を率いる力・当主との縁
  // 政権の中の有力者：家（北条・比企など）と、従う勢力（三浦・千葉など＝御家人の家）の影響力を並べる
  function regimeHouses(s, fid) {
    var out = Object.keys(s.houses || {}).filter(function (k) { return s.houses[k].faction === fid; }).map(function (k) { var h = s.houses[k]; return { id: k, name: h.name, head: h.head, influence: h.influence, kind: '家' }; });
    Object.keys(s.factions).forEach(function (v) { var x = s.factions[v]; if (!x.alive || x.overlord !== fid) return; var inf = clamp(5 + campPower(s, v) / 120 + rel(s, v, fid).value / 6 + factionPersons(s, v).reduce(function (t, p) { return t + (p.warriorOffices || []).length * 3; }, 0), 0, 60); out.push({ id: v, name: x.name.replace(/（.*）/, ''), head: x.leader, influence: Math.round(inf * 10) / 10, kind: '御家人' }); });
    return out.sort(function (a, b) { return b.influence - a.influence; });
  }
  function houseTick(s) {
    Object.keys(s.houses || {}).forEach(function (k) {
      var h = s.houses[k], f = F(s, h.faction); if (!f || !f.alive) { h.influence = 0; return; }
      var ms = h.members.map(function (m) { return Pn(s, m); }).filter(function (p) { return p && p.alive && topLord(s, p.faction || '') === topLord(s, h.faction); });
      if (h.head && !alive(s, h.head) && ms.length) { h.head = ms.sort(function (a, b) { return (b.abilities.politics + b.abilities.command) - (a.abilities.politics + a.abilities.command); })[0].id; news(s, h.name + 'の家督は' + pname(s, h.head) + 'が継いだ', { type: 'politics', factions: [h.faction] }); }
      var offices = ms.reduce(function (t, p) { return t + (p.courtOffices || []).length + (p.warriorOffices || []).length * 2; }, 0);
      var marriage = ms.some(function (p) { return (p.relations || []).some(function (r) { return /夫婦/.test(r.type) && (r.person === f.leader || r.person === f.heir); }); }) ? 12 : ms.some(function (p) { return (p.relations || []).some(function (r) { return /乳母/.test(r.type) && (r.person === f.leader || r.person === f.heir); }); }) ? 8 : 0;
      var cmdr = Math.min(6, ms.filter(function (p) { return /^army:/.test(String(p.location || '')); }).length * 2);
      var abil = Math.min(8, ms.reduce(function (t, p) { return t + (p.abilities.politics + p.abilities.command) / 80; }, 0));
      var t = clamp(3 + Math.min(30, offices * 3) + marriage + cmdr + abil + (h.favor || 0), 0, 100); h.influence = Math.round((h.influence + (t - h.influence) * 0.15) * 10) / 10;
      if (h.favor) h.favor *= 0.97;
    });
  }
  // 当主の死：継承の安定度を判定する（安定・派閥争い・内乱・分裂）
  function resolveSuccession(s, f, dead, heir, pool) {
    ensureRegime(s); var r = f.regime;
    var rival = pool.filter(function (p) { return p.id !== heir.id && p.alive && !p.captiveOf; }).sort(function (a, b) { return heirScore(s, f, b) - heirScore(s, f, a); })[0] || null;
    var hs = heirScore(s, f, heir), gap = rival ? hs - heirScore(s, f, rival) : 25, th = threatRatio(s, f.id);
    var S = 0.25 * hs + 0.2 * r.heirStab + 0.2 * r.maturity + 0.2 * r.cohesion - 0.5 * Math.max(0, r.leaderDep - 45) - 0.15 * Math.max(0, r.central - 70) - th * 6 + clamp(gap, -20, 25) * 0.3 + (rand(s) - 0.5) * 10; // 当日の情勢・人心の揺れ
    var kind = S >= 42 ? 'stable' : S >= 30 ? 'strife' : S >= 20 ? 'revolt' : 'split';
    if ((kind === 'split' || kind === 'revolt') && (!rival || factionBases(s, f.id).length < 2 || (ageOf(s, rival) != null && ageOf(s, rival) < 15))) kind = 'strife'; // 幼い候補は自立できない（担ぐ家の争いは将軍交代の動きで扱う）
    var why = '後継者の力量' + Math.round(hs) + '・後継者安定度' + Math.round(r.heirStab) + '・組織成熟度' + Math.round(r.maturity) + '・結束' + Math.round(r.cohesion) + '・当主依存' + Math.round(r.leaderDep) + '・外敵' + th.toFixed(1) + '倍→' + Math.round(S);
    r.lastSuccession = { day: s.day, date: dateStr(s), from: dead.id, to: heir.id, kind: kind, score: Math.round(S), rival: rival ? rival.id : null };
    r.leaderDep = clamp(80 - r.maturity * 0.6, 10, 90); r.heirStab = 15; r.heirBase = 0; f.heir = null;
    var label = { stable: '安定した継承', strife: '家中の派閥争い', revolt: '内乱', split: '分裂' }[kind], t;
    if (kind === 'stable') { r.cohesion = clamp(r.cohesion - 3, 0, 100); t = heir.name + 'への家督継承は滞りなく行われた。'; }
    else if (kind === 'strife') { r.cohesion = clamp(r.cohesion - 15, 0, 100); f.legitimacy = clamp(f.legitimacy - 5, 0, 100); f.flags.strifeUntil = s.day + 180; if (rival) rival.loyalty = clamp((rival.loyalty || 60) - 25, 0, 100);
      t = heir.name + 'が家督を継いだが、' + (rival ? rival.name + 'を推す者もあり、' : '') + '家中は割れた。半年ほどは足並みがそろわない。'; }
    else if (kind === 'revolt') { r.cohesion = clamp(r.cohesion - 25, 0, 100); f.legitimacy = clamp(f.legitimacy - 10, 0, 100); f.flags.strifeUntil = s.day + 300;
      var gone = Object.keys(s.factions).filter(function (v) { var x = s.factions[v]; return x.alive && x.overlord === f.id && kinship(s, f.id, { kind: 'vassal', id: v }) !== 'blood' && (rel(s, v, f.id).value < 0 || rand(s) < 0.12); });
      gone.forEach(function (v) { s.factions[v].overlord = null; rel(s, v, f.id).status = '緊張'; rel(s, v, f.id).value = Math.min(rel(s, v, f.id).value, -10); news(s, '【離反】' + fname(s, v) + 'は代替わりを機に' + f.name + 'から離れた', { type: 'politics', important: true, factions: [v, f.id] }); });
      t = heir.name + 'の継承に家中が従わず、内乱となった。' + (gone.length ? gone.length + '家が離反した。' : '') }
    else { var nf = splitFaction(s, f, rival); t = heir.name + 'の継承を認めない' + rival.name + 'が自立し、' + f.name + 'は分裂した。' + (nf ? '（' + nf.name + '）' : ''); f.flags.strifeUntil = s.day + 240; r.cohesion = clamp(r.cohesion - 20, 0, 100); }
    news(s, '【継承：' + label + '】' + f.name + '：' + t, { type: 'politics', important: kind !== 'stable' || f.id === s.playerFaction, factions: [f.id] });
    aiLog(s, f.id, '家督継承（' + label + '）', why, t);
    if (kind !== 'stable' && f.id !== s.playerFaction) s.firedEvents['succession_' + f.id + '_' + s.day] = s.day;
    if (f.id === s.playerFaction) stop(s, { key: 'succession', title: '家督継承：' + label, persons: [heir.id].concat(rival ? [rival.id] : []), text: dead.name + 'の死去により、' + t + '\n（判定：' + why + '）', choices: [] });
    return kind;
  }
  function splitFaction(s, f, rival) {
    var bases = factionBases(s, f.id).filter(function (b) { return b.id !== f.capital; }), capB = B(s, f.capital);
    bases.sort(function (a, b) { return (capB ? distProv(s, capB.province, b.province) - distProv(s, capB.province, a.province) : 0); });
    var take = bases.slice(0, Math.max(1, Math.floor(factionBases(s, f.id).length / 3))); if (!take.length) return null;
    var id = f.id + '_' + rival.id, short = f.name.replace(/（.*）/, '');
    var nf = s.factions[id] = { id: id, name: rival.name + '（' + short + 'の分流）', type: f.type, color: f.color, leader: rival.id, heir: null, capital: take[0].id, money: Math.round(f.money * 0.2), food: Math.round(f.food * 0.2),
      policy: f.policy, ambition: 70, courtRelation: f.courtRelation, legitimacy: Math.round(f.legitimacy * 0.6), playable: false, status: '在地', overlord: null, navy: f.navy, alive: true,
      description: f.name + 'の家督争いから分かれた一流（ゲーム展開）', flags: {}, ai: { posture: '', memo: '' }, regime: null, institutions: {} };
    f.money -= nf.money; f.food -= nf.food;
    nf.regime = regimeBase(nf); nf.regime.cohesion = 50; nf.regime.maturity = Math.max(5, f.regime.maturity * 0.5); nf.regime.goal = '本家に代わる家督'; nf.regime.confidence = 'ゲーム展開';
    take.forEach(function (b) { b.owner = id; Object.keys(s.bands).forEach(function (k) { var x = s.bands[k]; if (x.faction === f.id && x.province === b.province && x.mobilized === 0) x.faction = id; }); });
    rival.faction = id; rival.location = take[0].id; rival.status = nf.name + 'の当主';
    factionPersons(s, f.id).forEach(function (p) { if (take.some(function (b) { return b.id === p.location; }) && p.id !== f.leader && rand(s) < 0.6) p.faction = id; });
    var rr = rel(s, id, f.id); rr.war = true; rr.value = -60; rr.status = '敵対';
    Object.keys(s.factions).forEach(function (k) { if (k !== id && k !== f.id && atWar(s, k, f.id)) { var x = rel(s, k, id); x.value = 10; } });
    news(s, '【分裂】' + rival.name + 'が' + take.map(function (b) { return b.name; }).join('・') + 'に拠り、' + short + 'の本家と争う', { type: 'politics', important: true, factions: [f.id, id] });
    return nf;
  }
  // 政権維持の行動（CPU・プレイヤー共通）
  var REGIME_ACTS = {
    heir_base:   { label: '後継者の基盤を固める', money: 300, desc: '後継者に所領・郎党・役目を与え、一門と家臣に披露する。後継者安定度↑・当主依存度↓' },
    appoint:     { label: '有力家臣に役職を与える', money: 150, desc: '力のある家臣を侍大将・奉行などに任じる。結束↑・権力集中度↓' },
    mediate:     { label: '家臣団の対立を調整する', money: 200, desc: '争う家臣の間を取りもつ。結束↑（内紛中は鎮める）' },
    admin:       { label: '行政機構を整える', money: 400, desc: '文書・評定・奉行の仕組みを整える。組織成熟度↑・当主依存度↓' },
    local:       { label: '地方の統制を強める', money: 300, desc: '代官・目代を送り、支配国の不穏を抑える。地方統制力↑' },
    reward:      { label: '所領・権益を配分する（恩賞）', money: 350, desc: '戦功ある家臣・御家人に所領を安堵・給与する。結束↑・権力集中度↓・成熟度↑（安堵の積み重ね）' },
    command:     { label: '軍事の指揮系統を整える', money: 300, desc: '侍大将・軍奉行の役目を定める。成熟度↑、合戦の質 +3%' },
    decentralize:{ label: '権力の集中を改める', money: 100, desc: '一門・重臣に裁量を分ける。権力集中度↓・結束↑・当主依存度↓' },
  };
  function regimeAct(s, fid, act, opts) {
    ensureRegime(s); var f = F(s, fid), r = f.regime, d = REGIME_ACTS[act]; opts = opts || {};
    if (!d) return { ok: false, reason: '不明な行動' };
    if (f.money < d.money) return { ok: false, reason: '銭が足りない（' + d.money + '貫）' };
    r.cooldown = r.cooldown || {}; if (r.cooldown[act] != null && s.day - r.cooldown[act] < 60) return { ok: false, reason: '同じ施策は2か月に一度まで' };
    var msg = '';
    if (act === 'heir_base') { var h = f.heir && alive(s, f.heir) ? Pn(s, f.heir) : null; if (!h) return { ok: false, reason: '後継者が決まっていない（人物タブ・自勢力タブで定める）' }; r.heirBase = Math.min(25, (r.heirBase || 0) + 8); r.leaderDep = clamp(r.leaderDep - 2, 0, 100); msg = h.name + 'の基盤を固めた'; }
    else if (act === 'appoint') { var c = factionPersons(s, fid).filter(function (p) { return p.id !== f.leader && p.id !== f.heir && !p.captiveOf && (p.warriorOffices || []).indexOf('侍大将') < 0; }).sort(function (a, b) { return (b.abilities.command + b.abilities.politics) - (a.abilities.command + a.abilities.politics); })[0];
      if (opts.person && Pn(s, opts.person) && Pn(s, opts.person).faction === fid) c = Pn(s, opts.person); if (!c) return { ok: false, reason: '任じる家臣がいない' };
      c.warriorOffices = (c.warriorOffices || []).concat([c.abilities.politics > c.abilities.command ? '奉行' : '侍大将']); c.loyalty = clamp((c.loyalty || 60) + 8, 0, 100); r.cohesion = clamp(r.cohesion + 4, 0, 100); r.central = clamp(r.central - 2, 0, 100);
      var hh = Object.keys(s.houses || {}).filter(function (k) { return s.houses[k].members.indexOf(c.id) >= 0; })[0]; if (hh) s.houses[hh].favor = Math.min(20, (s.houses[hh].favor || 0) + 5);
      msg = c.name + 'を' + c.warriorOffices[c.warriorOffices.length - 1] + 'に任じた'; }
    else if (act === 'mediate') { r.cohesion = clamp(r.cohesion + 6, 0, 100); if (f.flags.strifeUntil > s.day) f.flags.strifeUntil = Math.max(s.day, f.flags.strifeUntil - 45); msg = '家臣団の対立を調停した'; }
    else if (act === 'admin') { r.maturity = clamp(r.maturity + 3, 0, 100); r.leaderDep = clamp(r.leaderDep - 2, 0, 100); msg = '行政の仕組みを整えた'; }
    else if (act === 'local') { r.local = clamp(r.local + 5, 0, 100); Object.keys(s.provinces).forEach(function (p) { var i = provinceInfluence(s, p)[0]; if (i && topLord(s, i.faction) === fid) PV(s, p).unrest = Math.max(0, PV(s, p).unrest - 5); }); msg = '支配国の統制を強めた'; }
    else if (act === 'reward') { r.cohesion = clamp(r.cohesion + 8, 0, 100); r.central = clamp(r.central - 3, 0, 100); r.maturity = clamp(r.maturity + 1, 0, 100); Object.keys(s.factions).forEach(function (v) { if (s.factions[v].alive && s.factions[v].overlord === fid) { var x = rel(s, v, fid); x.value = clamp(x.value + 6, -100, 100); } }); msg = '家臣・御家人に恩賞を配った'; }
    else if (act === 'command') { r.maturity = clamp(r.maturity + 2, 0, 100); r.commandBonus = 0.03; msg = '軍事の指揮系統を整えた'; }
    else if (act === 'decentralize') { r.central = clamp(r.central - 8, 0, 100); r.cohesion = clamp(r.cohesion + 4, 0, 100); r.leaderDep = clamp(r.leaderDep - 4, 0, 100); msg = '一門・重臣に裁量を分けた'; }
    f.money -= d.money; r.cooldown[act] = s.day; r.lastAct = { act: act, day: s.day };
    news(s, f.name + '：' + msg, { type: 'politics', factions: [fid] });
    return { ok: true, message: msg + '（' + d.money + '貫）' };
  }
  // CPU：自勢力の弱点を見て、一つ手を打つ（月に一度）
  var REGIME_TPL = {
    heir_base: ['{A}は「{L}様に万一あれば家が揺らぐ。{H}殿の地歩を固めるべし」と説いた。', '{L}は{H}を後継として一門に披露し、所領と郎党を与えた。'],
    appoint: ['{L}は家臣の不満を見てとり、{P}を重い役目に任じた。'],
    mediate: ['家中の争いが目立つ。{L}は{A}に命じて双方をなだめさせた。'],
    admin: ['{A}の進言により、{L}は文書と評定の仕組みを整えさせた。「人に頼らず、仕組みで家を保つ」'],
    local: ['支配する国々の不穏を憂え、{L}は代官を送って統制を強めた。'],
    reward: ['{L}は戦功ある者に所領を与えた。「恩賞なくして奉公なし」と{A}が説いた。'],
    command: ['{L}は侍大将と軍奉行の役目を定め、軍の指揮を改めた。'],
    decentralize: ['{A}は「すべてを{L}様お一人で決めては、御身に何かあれば立ち行かぬ」と諫めた。{L}は重臣に裁量を分けた。'],
    rival_weak: ['{E}は代替わりで家中が割れている。{L}は「いまこそ」と{A}らに出陣を命じた。', '{A}が「{E}の新しい当主はまだ家中を束ねきれておらぬ」と説き、{L}は{T}を攻めることにした。'],
  };
  function aiRegime(s, f) {
    ensureRegime(s); if (f.id === 'court' || !f.alive || f.overlord) return; var r = f.regime, ld = Pn(s, f.leader), age = ld ? ageOf(s, ld) : null;
    if (f.money < 250) return;
    var needs = [];
    if (f.heir && alive(s, f.heir) && r.heirStab < 80 && ((age != null && age > 55) || r.leaderDep > 65)) needs.push(['heir_base', 70 - r.heirStab + (age > 60 ? 15 : 0) + (r.leaderDep - 60) * 0.3]);
    if (f.flags.strifeUntil > s.day || r.cohesion < 45) needs.push(['mediate', 50 - r.cohesion + (f.flags.strifeUntil > s.day ? 20 : 0)]);
    if (r.cohesion < 60 && Object.keys(s.factions).some(function (v) { return s.factions[v].alive && s.factions[v].overlord === f.id; })) needs.push(['reward', 62 - r.cohesion]);
    if (r.leaderDep > 70) needs.push(['admin', (r.leaderDep - 65) * 0.8 + (age > 55 ? 10 : 0)]);
    if (r.central > 80) needs.push(['decentralize', (r.central - 75) + (age > 55 ? 8 : 0)]);
    if (r.local < 35) needs.push(['local', 35 - r.local]);
    if (r.cohesion < 55) needs.push(['appoint', 55 - r.cohesion]);
    if (r.maturity < 35 && enemiesOf(s, f.id).length) needs.push(['command', 35 - r.maturity]);
    needs.sort(function (a, b) { return b[1] - a[1]; });
    for (var i = 0; i < needs.length; i++) {
      var act = needs[i][0], res = regimeAct(s, f.id, act); if (!res.ok) continue;
      var c = factionPersons(s, f.id).filter(function (p) { return p.id !== f.leader; }).sort(function (a, b) { return b.abilities.command - a.abilities.command; })[0];
      var sp = tplFrom(s, REGIME_TPL[act], { L: ld ? ld.name : f.name, A: advisorOf(s, f.id), H: pname(s, f.heir), P: c ? c.name : '重臣' });
      aiLog(s, f.id, REGIME_ACTS[act].label, '後継者安定度' + Math.round(r.heirStab) + '・結束' + Math.round(r.cohesion) + '・当主依存' + Math.round(r.leaderDep) + '・集中' + Math.round(r.central) + '・地方統制' + Math.round(r.local), sp);
      break;
    }
  }
  function tplFrom(s, arr, v) { var t = arr[Math.floor(rand(s) * arr.length)]; return t.replace(/\{(\w)\}/g, function (m, k) { return v[k] != null ? v[k] : ''; }); }
  // 他家の代替わり・内紛は好機（攻めの点数に加える）
  function weaknessBonus(s, owner) {
    var o = F(s, topLord(s, owner)); if (!o || !o.regime) return 0; var r = o.regime, v = 0;
    if (o.flags.strifeUntil > s.day) v += 18;
    if (r.lastSuccession && s.day - r.lastSuccession.day < 240) v += r.lastSuccession.kind === 'stable' ? 4 : 10;
    if (r.cohesion < 35) v += 6;
    return v;
  }
  // ================================================================ 家と御家人の所領・兵（v1.1）
  // 勢力（政治・軍事の集団）と家（血縁の一族）を分ける。家は主君の勢力に属しつつ、当主・一族・郎党（兵）・所領・財産・忠誠を持つ。
  var HOUSE_SEED = {
    hojo: { lord: 'yoritomo', heir: 'munetoki', money: 150, food: 1500, loyalty: 78, seat: 'hojo', note: '伊豆国田方郡北条を本拠とする在庁官人の家。時政の娘政子は頼朝の妻（史実）。1180年時点では幕府の実権はない' },
    hiki: { lord: 'yoritomo', heir: null, money: 120, food: 900, loyalty: 88, seat: null, note: '武蔵国比企郡の家。比企尼は頼朝の乳母（史実）。治承4年の動向は要確認' },
    doi:  { name: '土肥氏', head: 'sanehira', members: ['sanehira'], ambition: 35, lord: 'yoritomo', heir: null, money: 80, food: 700, loyalty: 88, seat: 'doi', note: '相模国土肥郷の武士。挙兵当初から頼朝に従う（史実）' },
  };
  function migrateHouses(s) {
    if (s.flags.houseModel >= 2) return; s.flags.houseModel = 2;
    ensureRegime(s);
    // 頼朝の配所（蛭ヶ小島）と北条氏の館を分ける。鎌倉入り（史実：治承4年10月）で頼朝の本拠は鎌倉へ移る
    var hb = s.bases.hojo;
    if (hb && !s.bases.hirugakojima) {
      s.bases.hirugakojima = { id: 'hirugakojima', name: '蛭ヶ小島（頼朝の配所）', province: 'izu', type: '館', owner: hb.owner, defense: 5, maxDefense: 5, garrison: 25, x: hb.x - 3.5, y: hb.y + 3, confidence: '史実', note: '頼朝の流刑地（伊豆国田方郡）。北条館とは別の場所' };
      hb.name = '北条館'; hb.x += 2; hb.y -= 2; hb.house = 'hojo'; hb.garrison = Math.max(30, hb.garrison - 25); hb.note = '北条氏の館（伊豆国田方郡北条、守山の麓）';
      if (s.factions.yoritomo && s.factions.yoritomo.capital === 'hojo') s.factions.yoritomo.capital = 'hirugakojima';
      if (s.persons.yoritomo && s.persons.yoritomo.location === 'hojo') s.persons.yoritomo.location = 'hirugakojima';
    }
    if (s.bases.doi) s.bases.doi.house = 'doi';
    // 兵：北条一族の郎党は北条氏の兵、相模の土肥・岡崎らは土肥氏の兵。頼朝の直轄兵は流人の近臣だけ
    var b13 = s.bands.band_13;
    if (b13 && !s.bands.band_hojo) { s.bands.band_hojo = { id: 'band_hojo', faction: b13.faction, house: 'hojo', province: 'izu', name: '北条一族と郎党', strength: 65, base: 65, mobilized: 0, confidence: '推定' }; b13.name = '流人の近臣（安達盛長ら）'; b13.strength = Math.min(b13.strength, 25); b13.base = 25; }
    if (s.bands.band_14) s.bands.band_14.house = 'doi';
    if (!s.bands.band_hiki && s.provinces.musashi) s.bands.band_hiki = { id: 'band_hiki', faction: 'yoritomo', house: 'hiki', province: 'musashi', name: '比企氏の郎党', strength: 40, base: 40, mobilized: 0, confidence: '推定' };
    // 所領：北条・土肥郷は家の本領。比企郡は比企氏。鎌倉郷は鎌倉を押さえた者の直轄（将軍家直轄領のはじまり）
    if (s.holdings.hojo_go) s.holdings.hojo_go.house = 'hojo';
    if (s.holdings.doi_go) s.holdings.doi_go.house = 'doi';
    if (!s.holdings.hiki_go && s.provinces.musashi) s.holdings.hiki_go = { id: 'hiki_go', name: '比企郡', province: 'musashi', type: '郷', proprietor: '—', controller: 'yoritomo', house: 'hiki', output: 3000, confidence: '推定', note: '比企氏の本領。規模は推定' };
    if (!s.holdings.kamakura_go && s.provinces.sagami) s.holdings.kamakura_go = { id: 'kamakura_go', name: '鎌倉郷', province: 'sagami', type: '郷', proprietor: '—', controller: s.bases.kamakura ? s.bases.kamakura.owner : null, output: 1500, seat: 'kamakura', confidence: '推定', note: '鎌倉の地。押さえた者の直轄領になる' };
    Object.keys(s.holdings).forEach(function (k) { var h = s.holdings[k]; if (!h.rights) { h.rights = null; } });
    s.holdings.hiki_go && (s.holdings.hiki_go.rights = null); s.holdings.kamakura_go && (s.holdings.kamakura_go.rights = null);
    ensureHoldings(s);
    // 家の詳細
    Object.keys(HOUSE_SEED).forEach(function (k) { var d = HOUSE_SEED[k], h = s.houses[k];
      if (!h) { h = s.houses[k] = { id: k, name: d.name, faction: d.lord, head: d.head, members: (d.members || []).filter(function (m) { return s.persons[m]; }), ambition: d.ambition || 40, influence: 0 }; }
      h.lord = d.lord; h.faction = h.faction || d.lord; h.heir = d.heir && s.persons[d.heir] ? d.heir : null; h.money = d.money; h.food = d.food; h.loyalty = d.loyalty; h.seat = d.seat; h.note = d.note; h.rel = h.rel || {}; h.anduDay = null; });
    for (var i = 0; i < 25; i++) houseTick(s);
  }
  function H(s, id) { return (s.houses || {})[id]; }
  function houseBands(s, hid) { return Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (b) { return b.house === hid; }); }
  function houseTroops(s, hid) { return houseBands(s, hid).reduce(function (t, b) { return t + Math.max(0, Math.floor(b.strength - b.mobilized)); }, 0); }
  function houseHoldings(s, hid) { return Object.keys(s.holdings).map(function (k) { return s.holdings[k]; }).filter(function (h) { return h.house === hid; }); }
  function vassalsOf(s, fid) { return Object.keys(s.factions).filter(function (k) { var x = s.factions[k]; return x.alive && x.overlord === fid; }); }
  // 主君に仕える者（家と御家人の勢力）を同じ形で扱う
  function retainersOf(s, fid) {
    var out = Object.keys(s.houses || {}).filter(function (k) { var h = s.houses[k]; return h.lord === fid && h.faction === fid && h.head && alive(s, h.head); }).map(function (k) { return { kind: 'house', id: k }; });
    return out.concat(vassalsOf(s, fid).map(function (k) { return { kind: 'vassal', id: k }; }));
  }
  function retName(s, r) { return r.kind === 'house' ? H(s, r.id).name : fname(s, r.id).replace(/（.*）/, ''); }
  function retLoyalty(s, r, lord) { return r.kind === 'house' ? (H(s, r.id).loyalty == null ? 50 : H(s, r.id).loyalty) : clamp(50 + rel(s, r.id, lord).value / 2, 0, 100); }
  function retAddLoyalty(s, r, lord, v) { if (r.kind === 'house') { var h = H(s, r.id); h.loyalty = clamp((h.loyalty == null ? 50 : h.loyalty) + v, 0, 100); } else { var x = rel(s, r.id, lord); x.value = clamp(x.value + v * 2, -100, 100); } }
  // 土地の区分：将軍家直轄領／御家人・武家の所領／朝廷・貴族・寺社の所領
  function landCategory(s, h) {
    var c = h.controller, cf = c && F(s, c);
    if (!c) return '無主';
    if (h.type === '国衙領') return '国衙領（公領・知行国主 ' + fname(s, (h.rights && h.rights.taxHolder) || c).replace(/（.*）/, '') + '）';
    if (c === 'court' || (cf && cf.type.indexOf('寺社') >= 0)) return '朝廷・貴族・寺社の所領';
    if (h.house || (cf && cf.overlord)) return '御家人・武家の所領';
    return cf && cf.flags.bakufu ? '将軍家直轄領' : (cf ? fname(s, c).replace(/（.*）/, '') + 'の直轄領' : '—');
  }
  // 鎌倉郷のように拠点とともに動く所領：拠点の持ち主がそのまま直轄する
  function syncSeatHoldings(s) {
    Object.keys(s.holdings).forEach(function (k) { var h = s.holdings[k]; if (!h.seat || !s.bases[h.seat]) return; var o = s.bases[h.seat].owner; if (o && h.controller !== o) { h.controller = o; h.house = null; if (h.rights) { h.rights.taxHolder = o; } } });
  }
  // 主君の権限：本領安堵・新恩給与・没収

  // ---- 御恩（所領のほかに与えられるもの）：屋敷・引出物（馬・太刀）・感状・官途の推挙。先陣の名誉は出陣の際に任せる
  var BESTOW = {
    yashiki: { label: '屋敷を与える', cost: 150, loy: 15, svc: 3, once: true, note: '本拠の近くに屋敷を構えさせる。出仕の場ができ、以後の参陣の呼びかけに応じやすくなる' },
    gift: { label: '引出物（馬・太刀）', cost: 40, loy: 5, svc: 1, cool: 60, note: '名馬や太刀を贈る' },
    kanjo: { label: '感状を与える', cost: 0, loy: 6, svc: 1, cool: 90, needSvc: true, note: '働きを書き付けて褒める。奉公（働き）があるときだけ' },
    kanto: { label: '官途を推挙する', cost: 100, loy: 12, svc: 4, cool: 365, needCourt: true, note: '朝廷に任官を推薦する（左衛門尉・兵衛尉など）。朝廷との伝手（令旨・院宣・幕府・正統性50以上）が要る' }
  };
  var KANTO = ['左衛門尉', '右衛門尉', '左兵衛尉', '右兵衛尉', '馬允', '介'];

  // ---- 館を与える：家臣（人物）に与えれば独立した家（御家人）となり、自分の兵・蔵を持つ。家・御家人に与えれば本拠が増える
  var SURNAME2 = ['佐々木', '宇都宮', '小山田', '長谷川', '大河戸', '比企'];
  function surnameOf(name) { var sn = SURNAME2.filter(function (x) { return name.indexOf(x) === 0; })[0]; return sn || (name.length >= 4 ? name.slice(0, 2) : name.slice(0, 1)); }
  function grantBase(s, fid, cmd) {
    var f = F(s, fid), b = B(s, cmd.base); if (!f || !b) return { ok: false, reason: '館を選ぶこと' };
    if (b.owner !== fid) return { ok: false, reason: b.name + 'は自勢力の直轄ではない' }; if (b.house) return { ok: false, reason: b.name + 'はすでに' + H(s, b.house).name + 'の館' };
    if (b.id === f.capital) return { ok: false, reason: '本拠点は与えられない' }; if (b.type === '寺社' || b.type === '都') return { ok: false, reason: b.name + 'は与えられない' };
    if (Object.keys(s.battles).some(function (k) { return s.battles[k].base === b.id; })) return { ok: false, reason: b.name + 'は合戦の最中' };
    var r = retainersOf(s, fid).filter(function (x) { return x.id === cmd.to; })[0], p = !r ? Pn(s, cmd.to) : null, msg;
    var avail = Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (x) { return x.faction === fid && !x.house && x.province === b.province; });
    var give = Math.max(0, Math.min(Math.round(cmd.troops || 0), avail.reduce(function (t, x) { return t + x.strength - (x.mobilized || 0); }, 0)));
    var moveTroops = function (hid) { var left = give; avail.forEach(function (x) { var n = Math.min(left, x.strength - (x.mobilized || 0)); if (n <= 0) return; x.strength -= n; x.base = Math.max(0, (x.base || x.strength) - n); left -= n; });
      if (give > 0) { var hb = houseBands(s, hid).filter(function (x) { return x.province === b.province; })[0]; if (!hb) { var bid = nid(s, 'band'); hb = s.bands[bid] = { id: bid, faction: fid, house: hid, province: b.province, name: H(s, hid).name + 'の郎党', strength: 0, base: 0, mobilized: 0, confidence: 'ゲーム展開' }; } hb.strength += give; hb.base = (hb.base || 0) + give; } };
    if (p) {
      if (!p.alive || p.faction !== fid || p.captiveOf || p.id === f.leader) return { ok: false, reason: '自勢力の家臣（当主以外）を選ぶこと' };
      var hk0 = houseOfPerson(s, p.id); if (s.houses[hk0] && !s.houses[hk0].asFaction) return { ok: false, reason: p.name + 'は' + s.houses[hk0].name + 'の人。家（' + s.houses[hk0].name + '）を選んで与えること' };
      var sn = surnameOf(p.name), hname = sn + '氏', hid = 'h_' + p.id; if (Object.keys(s.houses).some(function (k) { return s.houses[k].name === hname; })) hname = p.name + 'の家';
      s.houses[hid] = { id: hid, name: hname, faction: fid, lord: fid, head: p.id, members: [p.id], ambition: p.ambition || 50, influence: 0, heir: null, money: 150, food: 800, loyalty: 92, seat: b.id, note: (f.name.replace(/（.*）/, '')) + 'から' + b.name + 'を与えられて独立した家', rel: {}, cohesion: 70, heirStab: 50, granted: s.day, grantedBy: fid };
      b.house = hid; moveTroops(hid); p.loyalty = clamp((p.loyalty == null ? 60 : p.loyalty) + 15, 0, 100); p.location = b.id; p.status = hname + 'の当主';
      // 館のある国の直轄の所領をひとつ添える（なければ館だけ）
      var hd = Object.keys(s.holdings).filter(function (k) { var x = s.holdings[k]; return x.province === b.province && x.controller === fid && !x.house && x.type !== '国衙領'; }).sort(function (a, c) { return s.holdings[a].output - s.holdings[c].output; })[0];
      if (hd && cmd.withLand !== false) { s.holdings[hd].house = hid; s.holdings[hd].seat = b.id; }
      if (s.shogunate) s.shogunate.inf[hid] = 5;
      msg = p.name + 'に' + b.name + 'を与えた。' + hname + 'として独立し、御家人となる（兵' + give + (hd && cmd.withLand !== false ? '・所領 ' + s.holdings[hd].name : '') + '）。' + p.name + 'は深く恩を感じている';
    } else if (r) {
      if (r.kind === 'house') { var h = H(s, r.id); b.house = r.id; if (!h.seat || !B(s, h.seat)) h.seat = b.id; moveTroops(r.id); h.granted = s.day; h.grantedBy = fid; retAddLoyalty(s, r, fid, 15); addService(s, fid, r.id, -5); msg = h.name + 'に' + b.name + 'を与えた（兵' + give + '）。' + h.name + 'は恩を感じている'; }
      else { var vf = F(s, r.id); b.owner = r.id; if (give) { avail.forEach(function () {}); var left2 = give; avail.forEach(function (x) { var n = Math.min(left2, x.strength - (x.mobilized || 0)); if (n <= 0) return; x.strength -= n; left2 -= n; }); var vb = nid(s, 'band'); s.bands[vb] = { id: vb, faction: r.id, province: b.province, name: vf.name.replace(/（.*）/, '') + 'の郎党', strength: give, base: give, mobilized: 0, confidence: 'ゲーム展開' }; }
        vf.granted = s.day; retAddLoyalty(s, r, fid, 15); addService(s, fid, r.id, -5); msg = vf.name.replace(/（.*）/, '') + 'に' + b.name + 'を与えた（兵' + give + '）。恩を感じている'; }
    } else return { ok: false, reason: '与える相手（家臣・家・御家人）を選ぶこと' };
    news(s, '【館を与える】' + msg, { type: 'politics', important: true, factions: [fid] }); aiLog(s, fid, '館を与える', b.name);
    return { ok: true, message: msg };
  }
  function renameBase(s, fid, cmd) { var b = B(s, cmd.base); if (!b) return { ok: false, reason: '館を選ぶこと' }; if (!b.owner || topLord(s, b.owner) !== topLord(s, fid)) return { ok: false, reason: '自陣営の館・城だけ名前を変えられる' };
    var nm = String(cmd.name || '').trim(); if (!nm || nm.length > 16) return { ok: false, reason: '名前は1〜16文字' }; if (Object.keys(s.bases).some(function (k) { return k !== b.id && s.bases[k].name === nm; })) return { ok: false, reason: '同じ名前の拠点がある' };
    var old = b.name; b.name = nm; b.renamed = old; return { ok: true, message: old + 'を「' + nm + '」と改めた' }; }
  function bestow(s, fid, cmd) {
    var f = F(s, fid), d = BESTOW[cmd.kind]; if (!f) return { ok: false, reason: '勢力が不明' }; if (!d) return { ok: false, reason: '与えるものを選ぶこと' };
    var r = retainersOf(s, fid).filter(function (x) { return x.id === cmd.target; })[0], p = !r ? Pn(s, cmd.target) : null;
    if (!r && !(p && p.alive && p.faction === fid && p.id !== f.leader)) return { ok: false, reason: '自分に従う家・御家人・家臣を選ぶこと' };
    var name = r ? retName(s, r) : p.name, key = (r ? r.id : 'p:' + p.id); s.bestowed = s.bestowed || {}; var rec = s.bestowed[fid + '>' + key] = s.bestowed[fid + '>' + key] || {};
    if (d.once && rec[cmd.kind] != null) return { ok: false, reason: name + 'にはすでに' + d.label.replace('を与える', '') + 'を与えている' };
    if (d.cool && rec[cmd.kind] != null && s.day - rec[cmd.kind] < d.cool) return { ok: false, reason: name + 'には' + (d.cool - (s.day - rec[cmd.kind])) + '日後まで同じ御恩は与えられない' };
    if (d.needSvc && r && serviceOf(s, fid, r.id) < 1) return { ok: false, reason: name + 'には褒めるべき働き（奉公）がまだない' };
    if (d.needCourt && !(f.flags.ryoji || f.flags.insen || (f.flags || {}).bakufu || f.legitimacy >= 50)) return { ok: false, reason: '朝廷への伝手がない（令旨・院宣を得るか、正統性を50以上に）' };
    if (cmd.kind === 'yashiki' && !B(s, f.capital)) return { ok: false, reason: '本拠点がない' };
    if (f.money < d.cost) return { ok: false, reason: '銭が足りない（' + d.cost + '貫）' };
    f.money -= d.cost; rec[cmd.kind] = s.day;
    var extra = '';
    if (r) { retAddLoyalty(s, r, fid, d.loy); addService(s, fid, r.id, -d.svc); if (r.kind === 'house') H(s, r.id).lastGrant = s.day; else { var vf = F(s, r.id); if (cmd.kind === 'yashiki') vf.yashiki = f.capital; } }
    var who = r ? (r.kind === 'house' ? Pn(s, H(s, r.id).head) : Pn(s, F(s, r.id).leader)) : p;
    if (p) p.loyalty = clamp((p.loyalty == null ? 60 : p.loyalty) + d.loy, 0, 100);
    if (cmd.kind === 'yashiki' && r && r.kind === 'house') H(s, r.id).yashiki = f.capital;
    if (cmd.kind === 'yashiki' && p) p.yashiki = f.capital;
    if (cmd.kind === 'kanto' && who) { var t = KANTO.filter(function (x) { return (who.courtOffices || []).indexOf(x) < 0; })[0] || '介'; who.courtOffices = (who.courtOffices || []).concat([t]); extra = '（' + who.name + 'は' + t + 'に任じられた）'; }
    if (cmd.kind === 'yashiki') extra = '（' + (B(s, f.capital) ? B(s, f.capital).name + 'の近く' : '本拠の近く') + 'に屋敷を構える）';
    var msg = name + 'に' + d.label.replace('を与える', '').replace('する', '') + 'を与えた' + extra + '。忠誠が上がった';
    news(s, '【御恩】' + msg, { type: 'politics', factions: [fid] }); aiLog(s, fid, '御恩：' + d.label, name);
    return { ok: true, message: msg };
  }
  // 屋敷を構えて出仕する家は、主君の呼びかけに応じやすい
  function yashikiBonus(s, lord, r) { var x = r.kind === 'house' ? H(s, r.id) : F(s, r.id); return x && x.yashiki && B(s, x.yashiki) && sameCamp(s, B(s, x.yashiki).owner, lord) ? 8 : 0; }
  function lordAct(s, fid, cmd) {
    var f = F(s, fid), rs = retainersOf(s, fid), r = rs.filter(function (x) { return x.id === cmd.target; })[0];
    if (cmd.type === 'ando') {
      if (!r) return { ok: false, reason: '自家に仕える家・御家人を指定すること' };
      var key = 'ando_' + r.id; f.flags[key] = f.flags[key] == null ? -999 : f.flags[key];
      if (s.day - f.flags[key] < 365) return { ok: false, reason: '同じ相手への本領安堵は1年に一度' };
      f.flags[key] = s.day; retAddLoyalty(s, r, fid, 10); addService(s, fid, r.id, -4); if (f.regime) f.regime.cohesion = clamp(f.regime.cohesion + 1.5, 0, 100);
      news(s, '【本領安堵】' + f.name + 'は' + retName(s, r) + 'の本領を安堵した', { type: 'politics', factions: [fid] });
      return { ok: true, message: retName(s, r) + 'の本領を安堵した（忠誠↑）' };
    }
    var h = s.holdings[cmd.holding]; if (!h) return { ok: false, reason: '所領が不明' };
    if (cmd.type === 'grant') {
      if (h.controller !== fid || h.house) return { ok: false, reason: '与えられるのは自家の直轄領だけ' };
      if (!r) return { ok: false, reason: '与える相手（家・御家人）を指定すること' };
      if (r.kind === 'house') { h.house = r.id; H(s, r.id).lastGrant = s.day; } else { h.controller = r.id; if (h.rights && h.rights.taxHolder === fid) h.rights.taxHolder = r.id; }
      retAddLoyalty(s, r, fid, 15); addService(s, fid, r.id, -10); if (f.regime) { f.regime.cohesion = clamp(f.regime.cohesion + 2, 0, 100); f.regime.maturity = clamp(f.regime.maturity + 0.5, 0, 100); }
      news(s, '【新恩給与】' + f.name + 'は' + h.name + 'を' + retName(s, r) + 'に与えた', { type: 'politics', factions: [fid] });
      return { ok: true, message: h.name + 'を' + retName(s, r) + 'に与えた（忠誠↑・直轄の年貢は減る）' };
    }
    if (cmd.type === 'confiscate') {
      var victim = h.house && H(s, h.house) && H(s, h.house).lord === fid ? { kind: 'house', id: h.house } : (h.controller && F(s, h.controller) && F(s, h.controller).overlord === fid ? { kind: 'vassal', id: h.controller } : null);
      if (!victim) return { ok: false, reason: '没収できるのは自家に仕える家・御家人の所領だけ' };
      if (victim.kind === 'house') h.house = null; else { h.controller = fid; if (h.rights && h.rights.taxHolder === victim.id) h.rights.taxHolder = fid; }
      retAddLoyalty(s, victim, fid, -30);
      rs.forEach(function (x) { if (x.id !== victim.id) retAddLoyalty(s, x, fid, -6); }); // ほかの家も警戒する
      if (f.regime) f.regime.cohesion = clamp(f.regime.cohesion - 5, 0, 100);
      news(s, '【没収】' + f.name + 'は' + retName(s, victim) + 'から' + h.name + 'を取り上げた。御家人たちは警戒している', { type: 'politics', important: true, factions: [fid] });
      if (victim.kind === 'vassal' && rel(s, victim.id, fid).value < -40) { F(s, victim.id).overlord = null; news(s, '【離反】' + fname(s, victim.id) + 'は所領を奪われて' + f.name + 'から離れた', { type: 'politics', important: true, factions: [victim.id, fid] }); }
      return { ok: true, message: h.name + 'を没収した（' + retName(s, victim) + 'の忠誠−30、他の家も警戒）' };
    }
    return { ok: false, reason: '未対応' };
  }
  // 家の毎月：年貢の取り分は家の蔵へ。主君へ2割。郎党の回復。忠誠は恩賞・勝ち負け・扱いで動く
  function houseMonthly(s, houseInc, harvest) {
    Object.keys(s.houses || {}).forEach(function (k) {
      var h = s.houses[k]; if (h.money == null) return; var lord = F(s, h.lord);
      var tax = houseInc[k] || 0, pay = tax * 0.2; tax -= pay;
      h.money += tax / 12 * 0.15; h.food = Math.round((h.food || 0) * 0.985 + tax * harvest);
      if (lord && lord.alive) { lord.money += pay / 12 * 0.15; lord.food += pay * harvest; }
      if (lord && lord.regime) h.loyalty = clamp((h.loyalty == null ? 50 : h.loyalty) + (lord.regime.cohesion - 55) / 40 + (h.lastGrant && s.day - h.lastGrant < 365 ? 0.3 : 0) - (h.ambition > 60 ? 0.1 : 0), 0, 100);
    });
  }
  // ---- 所領の中の施設（家・主君が建てる。本所の権利がある土地は許しが要る）
  var FACILITIES = {
    residence: { label: '武家館', money: 350, days: 60, max: 1, desc: '一族の館。拠点がなければ地図に館ができる' },
    fort:      { label: '城・砦', money: 600, days: 90, max: 1, desc: '本拠の防御+15（拠点がなければ砦を築く）' },
    temple:    { label: '寺院', money: 800, days: 150, max: 1, desc: '家の影響力+6・寺社派の態度↑・国の不穏↓' },
    shrine:    { label: '神社', money: 400, days: 90, max: 1, desc: '家の影響力+3・国の不穏↓' },
    market:    { label: '市場', money: 400, days: 60, max: 1, desc: '年貢のほかに銭が入る（年貢の5%）' },
    farm:      { label: '農地の開発', money: 300, days: 90, max: 3, desc: '所領の生産+5%（3度まで）' },
    road:      { label: '道路', money: 250, days: 45, max: 1, desc: '国の不穏↓・主君の地方統制↑' },
    bridge:    { label: '橋', money: 300, days: 50, max: 1, desc: '国の不穏↓・主君の地方統制↑' },
    warehouse: { label: '倉庫', money: 200, days: 30, max: 1, desc: '本拠の籠城の兵糧+30%' },
  };
  function facilityPermission(s, h, lordCamp) {
    var hj = h.rights && h.rights.honjo; if (!hj || topLord(s, hj) === lordCamp) return { ok: true, fee: 0 };
    var att = hj === 'court' ? (s.court.cliques ? cliqueAtt(s, s.court.cliques.sekkan, lordCamp) : 0) : rel(s, hj, lordCamp).value;
    if (att < -10) return { ok: false, reason: '本所（' + fname(s, hj).replace(/（.*）/, '') + '）の許しが得られない（態度' + Math.round(att) + '）' };
    return { ok: true, fee: 0.25, to: hj };
  }
  function buildFacility(s, fid, cmd) {
    var h = s.holdings[cmd.holding], d = FACILITIES[cmd.kind], f = F(s, fid); if (!h || !d) return { ok: false, reason: '所領または施設が不明' };
    var house = h.house ? H(s, h.house) : null, lordCamp = topLord(s, fid);
    var own = h.controller === fid && !h.house, mine = house && house.lord === fid, vas = h.controller && F(s, h.controller) && F(s, h.controller).overlord === fid;
    if (!own && !mine && !vas) return { ok: false, reason: '自家の直轄領か、自家に仕える家・御家人の所領にだけ建てられる' };
    h.facilities = h.facilities || [];
    if (h.facilities.filter(function (x) { return x.kind === cmd.kind; }).length >= d.max) return { ok: false, reason: d.label + 'はこれ以上建てられない' };
    var pm = facilityPermission(s, h, lordCamp); if (!pm.ok) return { ok: false, reason: pm.reason };
    var cost = Math.round(d.money * (1 + pm.fee)), payer = own ? 'lord' : (cmd.payer === 'self' ? 'self' : 'lord');
    var purse = payer === 'lord' ? f : (house || F(s, h.controller)); if ((purse.money || 0) < cost) return { ok: false, reason: (payer === 'lord' ? '' : '家の') + '銭が足りない（' + cost + '貫）' };
    purse.money -= cost; if (pm.to && F(s, pm.to)) F(s, pm.to).money += Math.round(d.money * pm.fee);
    h.facilities.push({ kind: cmd.kind, progress: 0, days: d.days, done: false, builder: h.house || h.controller, payer: payer === 'lord' ? fid : (h.house || h.controller), started: s.day });
    if (payer === 'lord' && (mine || vas)) retAddLoyalty(s, mine ? { kind: 'house', id: h.house } : { kind: 'vassal', id: h.controller }, fid, 4); // 主君の依頼・負担は喜ばれる
    news(s, h.name + 'で' + d.label + 'の普請を始めた（' + (payer === 'lord' ? fname(s, fid).replace(/（.*）/, '') + 'の負担' : '自費') + '・約' + d.days + '日' + (pm.fee ? '・本所へ礼銭' : '') + '）', { type: 'build', factions: [fid], province: h.province });
    return { ok: true, message: h.name + 'に' + d.label + '（' + cost + '貫・約' + d.days + '日）' };
  }
  function facilitiesTick(s) {
    Object.keys(s.holdings).forEach(function (k) {
      var h = s.holdings[k]; if (!h.facilities) return;
      h.facilities.forEach(function (x) {
        if (x.done) return; var hostile = provinceArmies(s, h.province).some(function (a) { return h.controller && atWar(s, a.faction, h.controller); }); if (hostile) return;
        x.progress += 1; if (x.progress < x.days) return; x.done = true;
        var d = FACILITIES[x.kind], house = h.house ? H(s, h.house) : null, pv = PV(s, h.province), seat = house && house.seat && B(s, house.seat) ? B(s, house.seat) : null, lord = house ? F(s, house.lord) : F(s, topLord(s, h.controller || ''));
        if (x.kind === 'farm') h.output = Math.round(h.output * 1.05);
        if (x.kind === 'temple' || x.kind === 'shrine') { pv.unrest = Math.max(0, pv.unrest - 3); if (house) house.favor = Math.min(30, (house.favor || 0) + (x.kind === 'temple' ? 6 : 3)); if (x.kind === 'temple' && s.court.cliques && lord) { var jc = s.court.cliques.jisha; jc.favor = jc.favor || {}; jc.favor[lord.id] = Math.min(40, (jc.favor[lord.id] || 0) + 3); } }
        if (x.kind === 'road' || x.kind === 'bridge') { pv.unrest = Math.max(0, pv.unrest - 3); if (lord && lord.regime) lord.regime.local = clamp(lord.regime.local + 1, 0, 100); }
        if (x.kind === 'fort') { if (seat) { seat.maxDefense += 15; seat.defense += 15; } else newHouseBase(s, h, house, '城', h.name + 'の砦', 30, 60); }
        if (x.kind === 'residence' && !seat) newHouseBase(s, h, house, '館', (house ? house.name.replace(/氏$/, '') : '') + '館', 10, 40);
        news(s, h.name + 'の' + d.label + 'が完成した', { type: 'build', factions: [h.controller], province: h.province });
      });
    });
  }
  function newHouseBase(s, h, house, type, name, def, gar) {
    var any = Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.province === h.province; })[0], pv = PV(s, h.province);
    var id = 'hb_' + h.id + '_' + s.day; s.bases[id] = { id: id, name: name, province: h.province, type: type, owner: h.controller, house: h.house || null, defense: def, maxDefense: def, garrison: gar, x: (any ? any.x : pv.x) + 6, y: (any ? any.y : pv.y) + 5, confidence: 'ゲーム展開', note: '所領の普請でできた拠点' };
    if (house && !house.seat) house.seat = id;
  }
  // ---- 出陣の参陣催促：家・御家人がそれぞれ参加・遅参・不参を決め、合流地点へ向かう
  function joinDecision(s, lord, r, target, joinedShare) {
    var f = F(s, lord), L = retLoyalty(s, r, lord), tp = target.type === 'base' ? B(s, target.id).province : target.id;
    var home = r.kind === 'house' ? (houseBands(s, r.id)[0] || {}).province : (B(s, F(s, r.id).capital) || {}).province;
    if (!home) return { decision: 'refuse', score: 0, why: '兵がいない' };
    var tOwner = target.type === 'base' ? B(s, target.id).owner : null, tf = tOwner && F(s, topLord(s, tOwner));
    var cause = (f.legitimacy - 40) / 2 + (f.flags.insen || f.flags.ryoji ? 10 : 0) + (tf && tf.flags.choteki ? 10 : 0);
    var E = nearEnemyPower(s, lord, tp, 150, 0.25) / Math.max(1, campPower(s, lord)), enemyT = -8 * clamp(E - 1, 0, 2); // 目標のまわりの敵の強さ
    var kin = r.kind === 'house' && H(s, r.id).members.some(function (m) { var p = Pn(s, m); return p && (p.relations || []).some(function (x) { return /夫婦|乳母/.test(x.type) && (x.person === f.leader || x.person === f.heir); }); }) ? 20 : 0; // 縁戚・乳母の家
    var homeHit = Object.keys(s.armies).some(function (k) { var a = s.armies[k]; return atWar(s, a.faction, lord) && a.province === home; });
    var threat = homeHit ? 25 : (Object.keys(s.armies).some(function (k) { var a = s.armies[k]; return atWar(s, a.faction, lord) && distProv(s, a.province, home) <= 100; }) && distProv(s, home, tp) > 100 ? 8 : 0); // 戦場が本領の近くなら、本領を守る戦いでもある
    var reward = (f.regime ? (f.regime.cohesion - 50) / 3 : 0) + (r.kind === 'house' && H(s, r.id).lastGrant && s.day - H(s, r.id).lastGrant < 365 ? 8 : 0);
    var dist = distProv(s, home, tp), food = r.kind === 'house' ? H(s, r.id).food : F(s, r.id).food, avail = r.kind === 'house' ? houseTroops(s, r.id) : availableBandTroops(s, r.id, null);
    var field = r.kind === 'vassal' ? idleFieldArmy(s, r.id) : null; if (field) avail += field.troops;
    var busy = Object.keys(s.armies).some(function (k) { var a = s.armies[k]; return (r.kind === 'house' ? a.house === r.id && a.faction === lord : a.faction === r.id) && a.battleId; }); // 戦の最中
    var foodPen = food < avail * 0.005 * 20 ? 15 : 0;
    var senjin = s._senjin === r.id ? 18 : 0, yb = yashikiBonus(s, lord, r), gx = r.kind === 'house' ? H(s, r.id) : F(s, r.id), onB = gx && gx.granted != null && s.day - gx.granted < 1095 ? 10 : 0; yb += onB;
    var unpaid = Math.min(12, Math.max(0, serviceOf(s, lord, r.id) - 2) * 2); // 報われない働きが重なると渋る（上限あり）
    var score = L * 0.75 + kin + cause * 0.6 + reward + joinedShare * 10 - dist / 50 - threat - foodPen + enemyT * 0.5 - unpaid - 5 + senjin + yb + (s._noNoise ? 0 : (rand(s) - 0.5) * 16);
    var decision = score >= 35 ? 'join' : score >= 22 ? 'late' : 'refuse';
    var sure = L > 65 && !homeHit && !busy; // 忠誠が65を超え、戦の最中でも本領を攻められてもいない家は、必ず参陣する
    if (sure) decision = 'join';
    var why = '忠誠' + Math.round(L) + (kin ? '・縁戚' : '') + '・大義' + Math.round(cause) + '・恩賞の見込み' + Math.round(reward) + '・距離' + Math.round(dist) + 'km' + (homeHit ? '・本領が攻められている' : threat ? '・本領に敵が迫る' : '') + (foodPen ? '・兵糧不足' : '') + (unpaid ? '・恩賞が滞る' : '') + (senjin ? '・先陣の名誉' : '') + (yb ? '・屋敷に出仕' : '') + (enemyT < 0 ? '・敵が強大' : '') + '・他家の参陣' + Math.round(joinedShare * 100) + '%→' + Math.round(score);
    if (sure) why = '忠誠' + Math.round(L) + '（65超）・戦なし→必ず参陣';
    else if (busy) why += '・戦の最中';
    return { decision: decision, score: score, why: why, home: home, avail: avail, field: field ? field.id : null, sure: sure };
  }
  function idleFieldArmy(s, vid) { return Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.faction === vid && !a.joinCorps && !a.lordOrder && !a.battleId && (a.status === 'idle' || a.status === 'arrived') && a.troops >= 30; }).sort(function (a, b) { return b.troops - a.troops; })[0] || null; }
  // 出陣の前に、参陣しそうな家と兵の数を見る（運の揺らぎを除いた見込み）
  function callPreview(s, fid, target) {
    var f = F(s, fid); if (!f || !target) return []; s._noNoise = true; var rs = retainersOf(s, fid), out = [];
    try { rs.forEach(function (r) { if (r.kind === 'vassal' && (F(s, r.id).flags.strifeUntil > s.day)) { out.push({ id: r.id, kind: r.kind, name: retName(s, r), decision: 'refuse', why: '家中が乱れている', avail: 0, troops: 0 }); return; }
      var d = joinDecision(s, fid, r, target, 0); var dflt = d.decision === 'refuse' ? 0 : Math.floor(d.avail * (d.decision === 'late' ? 0.6 : 0.85));
      out.push({ id: r.id, kind: r.kind, name: retName(s, r), decision: !(d.avail >= 20) ? 'refuse' : d.decision, why: !(d.avail >= 20) ? '出せる兵がない' : d.why, avail: Math.round(d.avail || 0), troops: !(d.avail >= 20) ? 0 : dflt, sure: d.sure, home: d.home, dist: Math.round(distProv(s, d.home, target.type === 'base' ? B(s, target.id).province : target.id)), field: !!d.field }); }); }
    finally { s._noNoise = false; }
    return out;
  }
  function rendezvousFor(s, lead, home, tp) {
    var path = [lead.province].concat(lead.path || []), md = 0;
    for (var i = 0; i < path.length; i++) {
      if (i > 0) md += travelDays(s, path[i - 1], path[i], 25);
      if (travelDays(s, home, path[i], 25) <= md + 2 + (lead.status === 'gathering' ? Math.max(0, (lead.gatherUntil || s.day) - s.day) : 0)) return path[i];
    }
    return tp;
  }

  // ---- 御家人・家への指図（出陣・守り・合流の要請）。家臣ではないので、受けるかどうかは相手が決める

  // ---- 御家人全体への命令（軍役）：兵を増やす・守り・出陣・参陣・帰陣
  function houseRecruitRoom(s, hid) { var h = H(s, hid), bands = houseBands(s, hid), prov = bands[0] ? bands[0].province : null; if (!prov) { var hd = Object.keys(s.holdings).filter(function (k) { return s.holdings[k].house === hid; })[0]; prov = hd ? s.holdings[hd].province : null; } if (!prov) return { prov: null, room: 0 };
    var cap = Object.keys(s.holdings).reduce(function (t, k) { var x = s.holdings[k]; return t + (x.house === hid ? x.output * 0.035 : 0); }, 0) + (h.seat && B(s, h.seat) ? 150 : 60);
    var lord = F(s, h.lord || h.faction), rally = lord && (lord.status === '挙兵' || lord.status === '幕府') && (lord.flags.ryoji || lord.flags.insen) ? 1.3 : 1;
    var cur = bands.reduce(function (t, b) { return t + (b.base || b.strength); }, 0) + s.recruits.filter(function (r) { return r.house === hid; }).reduce(function (t, r) { return t + r.remaining; }, 0);
    return { prov: prov, room: Math.max(0, Math.round(cap * rally - cur)), cap: Math.round(cap * rally), cur: Math.round(cur) }; }
  function retainerMuster(s, lord, r) { // 一つの家・御家人が自分の銭と兵糧で兵を集める
    var L = retLoyalty(s, r, lord), name = retName(s, r);
    if (L < 40) return { id: r.id, ok: false, text: name + '：命に服さない（忠誠' + Math.round(L) + '）' };
    var share = L >= 70 ? 0.7 : 0.45;
    if (r.kind === 'house') { var h = H(s, r.id), rm = houseRecruitRoom(s, r.id); if (!rm.prov) return { id: r.id, ok: false, text: name + '：兵を集める本領がない' };
      var n = Math.floor(Math.min(rm.room, (h.money || 0) * share / 0.6, (h.food || 0) * share / 0.4)); if (n < 10) return { id: r.id, ok: false, text: name + '：' + (rm.room < 10 ? 'これ以上は集められない（上限' + rm.cap + '）' : '銭・兵糧が足りない') };
      h.money -= Math.round(n * 0.6); h.food -= Math.round(n * 0.4); var days = 20 + Math.round(n / 40); s.recruits.push({ faction: h.faction, house: r.id, province: rm.prov, remaining: n, perDay: n / days, total: n, started: s.day, days: days });
      return { id: r.id, ok: true, n: n, text: name + '：' + n + '人を集める（約' + days + '日）' }; }
    var vf = F(s, r.id), total = 0, provs = {}; factionBases(s, r.id).forEach(function (b) { provs[b.province] = 1; }); Object.keys(s.holdings).forEach(function (k) { if (s.holdings[k].controller === r.id) provs[s.holdings[k].province] = 1; });
    var budget = (vf.money || 0) * share;
    Object.keys(provs).forEach(function (pid) { var ri = recruitInfo(s, r.id, pid), n = Math.floor(Math.min(ri.room, budget / ri.costPer, (vf.food || 0) * share / ri.foodPer)); if (n >= 10) { var rr = recruit(s, r.id, pid, n); if (rr.ok) { total += n; budget -= n * ri.costPer; } } });
    return total ? { id: r.id, ok: true, n: total, text: name + '：' + total + '人を集める' } : { id: r.id, ok: false, text: name + '：これ以上は集められない（銭・兵糧・本領の広さ）' };
  }
  function vassalCommand(s, lord, cmd) {
    var f = F(s, lord); if (!f) return { ok: false, reason: '勢力が不明' }; var rets = retainersOf(s, lord).filter(function (r) { return !cmd.only || cmd.only.indexOf(r.id) >= 0; });
    if (!rets.length) return { ok: false, reason: '従う家・御家人がいない' };
    s.massCool = s.massCool || {}; var ck = lord + ':' + cmd.act; if (s.massCool[ck] != null && s.day - s.massCool[ck] < 30 && cmd.act === 'muster') return { ok: false, reason: '軍役の備えは30日に一度（' + (30 - (s.day - s.massCool[ck])) + '日後）' };
    var res = [];
    if (cmd.act === 'muster') { s.massCool[ck] = s.day; rets.forEach(function (r) { var x = retainerMuster(s, lord, r); res.push(x); if (x.ok) retAddLoyalty(s, r, lord, -1); }); }
    else if (cmd.act === 'recall') { Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (!a) return; var mine = rets.some(function (r) { return r.kind === 'house' ? a.house === r.id && a.faction === lord : a.faction === r.id; }); if (!mine || !(a.lordOrder || a.contingentOf === lord)) return; if (a.status === 'battle') { res.push({ ok: false, text: armyLabel(s, a) + '：合戦中' }); return; } a.lordOrder = null; a.joinCorps = null; res.push({ ok: true, text: armyLabel(s, a) + '：本領へ帰る' }); disbandArmy(s, a, 'home'); }); if (!res.length) return { ok: false, reason: '指図で出ている御家人の軍はない' }; }
    else if (['attack', 'defend', 'join'].indexOf(cmd.act) >= 0) { rets.forEach(function (r) { var x = orderRetainer(s, lord, { vassal: r.id, act: cmd.act, target: cmd.target, corps: cmd.corps }); res.push({ id: r.id, ok: x.ok && !x.refused, text: retName(s, r) + '：' + (x.ok ? x.message.replace(retName(s, r) + 'は', '') : x.reason) }); }); }
    else return { ok: false, reason: '命令の種類が不明' };
    var okN = res.filter(function (x) { return x.ok; }).length, label = { muster: '兵を増やせ（軍役の備え）', recall: '帰陣せよ', attack: '出陣せよ', defend: '守りにつけ', join: '軍団に加われ' }[cmd.act];
    news(s, '【御家人への命】' + label + '：' + okN + '／' + res.length + '家が応じた', { type: 'military', important: true, factions: [lord] });
    return { ok: true, message: label + '：' + okN + '／' + res.length + '家が応じた', results: res };
  }
  // 比企氏の館（比企郡）：頼朝の乳母・比企尼の一族の本領
  function migrateHouses4(s) { if (s.flags.houseModel >= 4) return; s.flags.houseModel = 4; var h = s.houses.hiki; if (!h || h.seat || !s.holdings.hiki_go) return; var hd = s.holdings.hiki_go;
    var any = Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.province === hd.province; })[0], pv = PV(s, hd.province);
    s.bases.hiki_kan = { id: 'hiki_kan', name: '比企館', province: hd.province, type: '館', owner: hd.controller, house: 'hiki', defense: 25, maxDefense: 25, garrison: 20, x: (any ? any.x : pv.x) - 14, y: (any ? any.y : pv.y) + 10, confidence: '推定', note: '比企氏の本領・比企郡の館（位置は推定）', facilities: {} };
    h.seat = 'hiki_kan'; hd.seat = 'hiki_kan'; }
  function orderRetainer(s, fid, cmd) {
    var f = F(s, fid), r = retainersOf(s, fid).filter(function (x) { return x.id === cmd.vassal; })[0]; if (!r) return { ok: false, reason: '自分に従う家・御家人ではない' };
    var name = retName(s, r), act = cmd.act, target = null, cp = null, lead = null;
    if (act === 'join') { cp = s.corps[cmd.corps]; if (!cp || cp.faction !== fid) return { ok: false, reason: '合流先の軍団を選ぶこと' }; target = cp.target;
      lead = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.corps === cp.id && !a.joinCorps; }).sort(function (a, b) { return b.troops - a.troops; })[0]; if (!lead) return { ok: false, reason: 'その軍団には本隊がいない' }; }
    else if (act === 'attack' || act === 'defend') { if (!cmd.target || !B(s, cmd.target)) return { ok: false, reason: '拠点を選ぶこと' }; target = { type: 'base', id: cmd.target }; var bo = B(s, cmd.target).owner;
      if (act === 'attack' && (!bo || sameCamp(s, bo, fid))) return { ok: false, reason: '敵の拠点を選ぶこと' }; if (act === 'attack' && !atWar(s, fid, bo)) return { ok: false, reason: fname(s, bo) + 'とは交戦していない' };
      if (act === 'defend' && !sameCamp(s, bo, fid)) return { ok: false, reason: '味方の拠点を選ぶこと' }; }
    else return { ok: false, reason: '指図の種類が不明' };
    s.orderCool = s.orderCool || {}; var ck = fid + '>' + r.id; if (s.orderCool[ck] != null && s.day - s.orderCool[ck] < 20) return { ok: false, reason: name + 'には先日頼んだばかり（20日あける）' };
    if (r.kind === 'vassal' && (F(s, r.id).flags || {}).strifeUntil > s.day) return { ok: false, reason: name + 'は家中が乱れていて動けない' };
    var mineArm = function (a) { return r.kind === 'house' ? a.house === r.id : a.faction === r.id; };
    if (Object.keys(s.armies).some(function (k) { var a = s.armies[k]; return mineArm(a) && ((a.lordOrder && a.lordOrder.lord === fid && a.lordOrder.until > s.day) || (a.joinCorps && a.contingentOf === fid)); })) return { ok: false, reason: name + 'の軍はすでに指図で出ている' };
    s.orderCool[ck] = s.day;
    var d = joinDecision(s, fid, r, target, 0.3), L = retLoyalty(s, r, fid), tp0 = target.type === 'base' ? B(s, target.id).province : target.id;
    var kin0 = kinship(s, fid, r), cause0 = ((f.legitimacy || 0) - 40) / 4 + (f.flags.insen || f.flags.ryoji ? 6 : 0), threat0 = /本領に敵が迫る/.test(d.why) ? 10 : 0;
    var sc = L * 0.75 + cause0 + (kin0 === 'blood' ? 20 : kin0 === 'inlaw' ? 10 : 0) - distProv(s, d.home, tp0) / 60 - threat0 + (act === 'defend' ? 12 : act === 'join' ? 4 : 0) + serviceOf(s, fid, r.id) * -1 + yashikiBonus(s, fid, r) + (act === 'attack' && cmd.senjin ? 15 : 0) + (rand(s) - 0.5) * 30; // 直接の頼みは主従の情（忠誠）で決まる
    d.why = '忠誠' + Math.round(L) + (kin0 ? (kin0 === 'blood' ? '・一門' : '・縁戚') : '') + '・大義' + Math.round(cause0) + '・距離' + Math.round(distProv(s, d.home, tp0)) + 'km' + (threat0 ? '・本領に敵が迫る' : '') + (serviceOf(s, fid, r.id) > 2 ? '・恩賞が滞っている' : '') + '→' + Math.round(sc);
    var dec = sc >= 35 ? 'join' : sc >= 22 ? 'late' : 'refuse'; if (d.sure) dec = 'join'; // 忠誠65超・戦なしの家は必ず応じる
    if (r.kind === 'house') { var hh = H(s, r.id); hh.loyalty = clamp((hh.loyalty == null ? 50 : hh.loyalty) - 1, 0, 100); } else { var rv0 = rel(s, r.id, fid); rv0.value = clamp(rv0.value - 1, -100, 100); } // たびたびの使い立ては負担になる
    if (dec === 'refuse' || d.avail < 20) { aiLog(s, fid, name + 'に指図（不承知）', d.why); return { ok: true, refused: true, message: name + 'は申し出を断った（' + (d.avail < 20 ? '出せる兵がない' : d.why) + '）' }; }
    var field = r.kind === 'vassal' && act !== 'join' ? Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.faction === r.id && !a.joinCorps && !a.lordOrder && (a.status === 'idle' || a.status === 'arrived') && a.troops >= 50; }).sort(function (a, b) { return b.troops - a.troops; })[0] : null;
    if (field) { var ef = setArmyTarget(s, field, target, act === 'attack' ? 'attack' : 'move'); if (!ef) { field.lordOrder = { lord: fid, act: act, target: target, until: s.day + 120 }; var fm = name + 'は出陣中の' + Math.round(field.troops) + 'を' + (act === 'attack' ? B(s, target.id).name + 'へ向けた' : B(s, target.id).name + 'の守りに回した');
        news(s, '【指図】' + fm, { type: 'military', important: true, factions: [fid] }); aiLog(s, fid, name + 'に指図（承知）', d.why); return { ok: true, message: fm }; } }
    var order = B(s, f.capital) ? travelDays(s, B(s, f.capital).province, d.home, 55) : 1, prep = dec === 'late' ? 7 + Math.round(rand(s) * 6) : 2 + Math.round(rand(s) * 2);
    var n = Math.floor(d.avail * (dec === 'late' ? 0.6 : 0.85)), actor = r.kind === 'house' ? fid : r.id, cmdr = r.kind === 'house' ? (H(s, r.id).head && personFree(s, H(s, r.id).head, fid) ? H(s, r.id).head : null) : null;
    var m = mobilize(s, actor, d.home, n, cmdr, { house: r.kind === 'house' ? r.id : null, gather: order + prep, foodDays: 40, force: true, allowNeighbors: false }); if (!m.army) return { ok: true, refused: true, message: name + 'は兵を集められなかった' };
    var a = typeof m.army === 'string' ? s.armies[m.army] : m.army; a.house = r.kind === 'house' ? r.id : null; a.status = 'gathering'; a.gatherUntil = s.day + order + prep;
    if (act === 'join') { a.joinCorps = cp.id; a.contingentOf = fid; var rvp = rendezvousFor(s, lead, d.home, target.type === 'base' ? B(s, target.id).province : target.id); setArmyTarget(s, a, { type: 'province', id: rvp }, 'move'); a.status = 'gathering';
      cp.contingents = cp.contingents || []; cp.contingents.push({ id: r.id, kind: r.kind, name: name, decision: dec, why: d.why, troops: a.troops, army: a.id, rendezvous: rvp, eta: s.day + order + prep + travelDays(s, d.home, rvp, 25) }); }
    else { a.lordOrder = { lord: fid, act: act, target: target, until: s.day + 120 }; var e = setArmyTarget(s, a, target, act === 'attack' ? 'attack' : 'move'); if (e) { disbandArmy(s, a, 'home'); return { ok: false, reason: e }; } a.status = 'gathering'; }
    var msg = name + 'は' + (dec === 'late' ? '遅れて' : '') + a.troops + 'を率いて' + (act === 'join' ? pname(s, cp.commander) + 'の軍団に合流する' : act === 'attack' ? B(s, target.id).name + 'を攻める' : B(s, target.id).name + 'の守りにつく') + '（' + (a.gatherUntil - s.day) + '日後に発つ）';
    news(s, '【指図】' + msg, { type: 'military', important: true, factions: [fid] }); aiLog(s, fid, name + 'に指図（承知）', d.why);
    return { ok: true, message: msg };
  }
  function lordOrderTick(s) { // 指図を果たした・期限が来た軍は御家人の判断に戻る（功は奉公として記録）
    Object.keys(s.armies).forEach(function (k) { var a = s.armies[k], o = a.lordOrder; if (!o) return; var b = o.target && o.target.type === 'base' ? B(s, o.target.id) : null;
      var done = o.act === 'attack' && b && sameCamp(s, b.owner, o.lord);
      if (done) { addService(s, o.lord, a.house || a.faction, 3); news(s, armyLabel(s, a) + 'は指図どおり' + b.name + 'の攻略を果たした（奉公が加わる）', { type: 'military', factions: [o.lord] }); }
      if (done || o.until <= s.day || ((a.status === 'idle' || a.status === 'retreating') && o.act === 'attack' && a.morale < 30)) a.lordOrder = null; });
  }

  // 加勢：呼ばれていない御家人や、近くの同盟・友好の家が、自分の判断で軍に加わることがある（出陣の見込みには入らない）
  function volunteerTick(s) {
    if (s.day % 5) return;
    Object.keys(s.corps).forEach(function (cid) { var cp = s.corps[cid]; if (!cp || !cp.target || cp.target.type !== 'base') return; var fid = cp.faction, f = F(s, fid); if (!f || !f.alive) return;
      var tb = B(s, cp.target.id); if (!tb || !tb.owner || sameCamp(s, tb.owner, fid)) return;
      var lead = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.corps === cid && !a.joinCorps; }).sort(function (a, b) { return b.troops - a.troops; })[0]; if (!lead || lead.status === 'retreating') return;
      cp.volunteers = cp.volunteers || []; if (cp.volunteers.length >= 3) return;
      var asked = (cp.contingents || []).map(function (c) { return c.id; }).concat(cp.volunteers);
      var pool = retainersOf(s, fid).filter(function (r) { return asked.indexOf(r.id) < 0; }).map(function (r) { return { r: r, w: retLoyalty(s, r, fid), kind: r.kind, id: r.id }; });
      Object.keys(s.factions).forEach(function (k) { var x = s.factions[k]; if (!x.alive || k === fid || x.overlord || x.type === '寺社' || k === 'court' || asked.indexOf(k) >= 0 || atWar(s, k, fid)) return; var rv = rel(s, k, fid); if (rv.value < 30 && rv.status !== '同盟') return; if (!atWar(s, k, tb.owner) && rv.status !== '同盟') return; pool.push({ r: { kind: 'vassal', id: k }, w: rv.value + (rv.status === '同盟' ? 25 : 0), kind: 'ally', id: k }); });
      pool.forEach(function (c) { if (cp.volunteers.length >= 3) return; var home = c.kind === 'house' ? (houseBands(s, c.id)[0] || {}).province : (B(s, F(s, c.id).capital) || {}).province; if (!home || distProv(s, home, lead.province) > 160) return;
        if (rand(s) > clamp((c.w - 40) / 500, 0, 0.12)) return; if (Object.keys(s.armies).some(function (k) { var a = s.armies[k]; return a.battleId && (c.kind === 'house' ? a.house === c.id : a.faction === c.id); })) return;
        var avail = c.kind === 'house' ? houseTroops(s, c.id) : availableBandTroops(s, c.id, null), n = Math.floor(avail * 0.4); if (n < 30) return;
        var actor = c.kind === 'house' ? fid : c.id, m = mobilize(s, actor, home, n, null, { house: c.kind === 'house' ? c.id : null, gather: 2, foodDays: 30, force: true, allowNeighbors: false }); if (!m.army) return;
        var a = typeof m.army === 'string' ? s.armies[m.army] : m.army, rv2 = rendezvousFor(s, lead, home, tb.province); a.joinCorps = cid; a.contingentOf = fid; a.house = c.kind === 'house' ? c.id : null; setArmyTarget(s, a, { type: 'province', id: rv2 }, 'move'); a.status = 'gathering'; a.gatherUntil = s.day + 2;
        var nm = c.kind === 'house' ? H(s, c.id).name : fname(s, c.id).replace(/（.*）/, ''); cp.volunteers.push(c.id); cp.contingents = cp.contingents || []; cp.contingents.push({ id: c.id, kind: c.kind === 'ally' ? 'vassal' : c.kind, name: nm, decision: 'volunteer', why: '自らの意思で加勢', troops: a.troops, army: a.id, rendezvous: rv2, eta: s.day + 2 + travelDays(s, home, rv2, 25) });
        news(s, '【加勢】' + nm + 'が自らの意思で' + a.troops + 'を率いて' + pname(s, cp.commander) + 'の軍に加わる（合流先：' + PV(s, rv2).name + '）', { type: 'military', important: fid === s.playerFaction, factions: [fid] }); });
    });
  }
  // 頼朝の配所：頼朝が本拠を移したら、ただの館（蛭ヶ小島館）として扱う（家に与えられる）
  function haishoTick(s) { var b = s.bases.hirugakojima, y = F(s, 'yoritomo'); if (!b || !y || /配所/.test(b.name) === false) return; if (y.capital !== 'hirugakojima' && y.alive && b.owner && topLord(s, b.owner) === topLord(s, 'yoritomo')) { b.name = '蛭ヶ小島館'; b.note = '頼朝の旧配所。頼朝が本拠を移したので、ただの館となった'; news(s, '頼朝が本拠を移したので、配所の蛭ヶ小島は「蛭ヶ小島館」となった（家臣・御家人に与えられる）', { type: 'politics', factions: ['yoritomo'] }); } }
  function callToArms(s, fid, corpsId, lead) {
    var cp = s.corps[corpsId]; if (!cp || !lead) return []; s._senjin = cp.senjin || null;
    var rs = retainersOf(s, fid).sort(function (a, b) { return retLoyalty(s, b, fid) - retLoyalty(s, a, fid); }), joined = 0, out = [], f = F(s, fid), cap = B(s, f.capital);
    var tp = cp.target.type === 'base' ? B(s, cp.target.id).province : cp.target.id;
    rs.forEach(function (r, i) {
      if (r.kind === 'vassal' && (F(s, r.id).flags.strifeUntil > s.day)) return;
      var plan = cp.callPlan && cp.callPlan[r.id] != null ? Math.max(0, Math.round(cp.callPlan[r.id])) : null, name = retName(s, r);
      if (plan === 0) { cp.contingents = cp.contingents || []; cp.contingents.push({ id: r.id, kind: r.kind, name: name, decision: 'excused', why: '主君が今回は不要とした', troops: 0 }); return; }
      if (plan != null) s._noNoise = true; var d = joinDecision(s, fid, r, cp.target, rs.length ? joined / rs.length : 0); s._noNoise = false;
      var rec = { id: r.id, kind: r.kind, name: name, decision: d.decision, why: d.why, troops: 0, army: null, rendezvous: null, eta: null };
      cp.contingents = cp.contingents || []; cp.contingents.push(rec);
      if (d.decision !== 'refuse' && d.field && s.armies[d.field]) { var fa = s.armies[d.field], rvf = rendezvousFor(s, lead, fa.province, tp); fa.joinCorps = corpsId; fa.contingentOf = fid; fa.lordOrder = null; if (!setArmyTarget(s, fa, { type: 'province', id: rvf }, 'move')) { fa.status = 'gathering'; fa.gatherUntil = s.day + 1; rec.troops = fa.troops; rec.army = fa.id; rec.rendezvous = rvf; rec.eta = s.day + 1 + travelDays(s, fa.province, rvf, 25); if (d.decision === 'join') joined++;
          news(s, '【参陣】' + name + 'が出陣中の' + Math.round(fa.troops) + 'を率いて加わる（合流先：' + PV(s, rvf).name + '・約' + (rec.eta - s.day) + '日後）', { type: 'military', factions: [fid], important: fid === s.playerFaction }); out.push(rec); return; } }
      if (d.decision === 'refuse' || d.avail < 20) { rec.decision = 'refuse'; news(s, '【不参】' + name + 'は' + f.name.replace(/（.*）/, '') + 'の催促に応じなかった', { type: 'military', factions: [fid], important: fid === s.playerFaction }); aiLog(s, fid, name + '不参', d.why); return; }
      var order = cap ? travelDays(s, cap.province, d.home, 55) : 1, prep = d.decision === 'late' ? 7 + Math.round(rand(s) * 8) : 2 + Math.round(rand(s) * 2);
      var n = Math.floor(d.avail * (d.decision === 'late' ? 0.6 : 0.85)); if (plan != null) n = Math.min(plan, Math.floor(d.avail));
      var actor = r.kind === 'house' ? fid : r.id, cmdr = r.kind === 'house' ? (H(s, r.id).head && personFree(s, H(s, r.id).head, fid) ? H(s, r.id).head : null) : null;
      var m = mobilize(s, actor, d.home, n, cmdr, { house: r.kind === 'house' ? r.id : null, gather: order + prep, foodDays: 30, force: true, allowNeighbors: false });
      if (!m.army) { rec.decision = 'refuse'; return; }
      var a = typeof m.army === 'string' ? s.armies[m.army] : m.army;
      if (r.kind === 'house') { var hh = H(s, r.id); f.money += m.cost; f.food += m.food; hh.money = Math.max(0, (hh.money || 0) - m.cost); hh.food = Math.max(0, (hh.food || 0) - m.food); } // 家の兵は家の負担で出る
      a.gatherUntil = s.day + order + prep; a.joinCorps = corpsId; a.contingentOf = fid; a.house = r.kind === 'house' ? r.id : null; a.status = 'gathering';
      var rv = rendezvousFor(s, lead, d.home, tp); setArmyTarget(s, a, { type: 'province', id: rv }, 'move'); a.status = 'gathering';
      rec.troops = a.troops; rec.army = a.id; rec.rendezvous = rv; rec.eta = s.day + order + prep + travelDays(s, d.home, rv, 25);
      if (d.decision === 'join') joined++;
      news(s, '【' + (d.decision === 'join' ? '参陣' : '遅参') + '】' + name + 'が' + a.troops + 'を率いて' + (d.decision === 'late' ? '遅れて' : '') + '参陣する（合流先：' + PV(s, rv).name + '・約' + (rec.eta - s.day) + '日後）', { type: 'military', factions: [fid] });
      aiLog(s, fid, name + (d.decision === 'join' ? '参陣' : '遅参'), d.why);
      out.push(rec);
    });
    // 参陣を約した家が合流地点に着くころに本隊も着くよう、出陣を待つ（最大12日）
    var lp = [lead.province].concat(lead.path || []), wait = 0;
    out.forEach(function (c) { if (c.decision !== 'join') return; var i = lp.indexOf(c.rendezvous), lt = 0; for (var j = 1; j <= i; j++) lt += travelDays(s, lp[j - 1], lp[j], 25); wait = Math.max(wait, c.eta - s.day - lt); });
    s._senjin = null; wait = Math.min(12, Math.max(0, Math.round(wait)));
    if (wait > 0 && cp.wait !== false) { Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (a.corps === corpsId && !a.joinCorps) { a.status = 'gathering'; a.gatherUntil = Math.max(a.gatherUntil || 0, s.day + wait); } });
      news(s, pname(s, cp.commander) + 'は参陣する家を待ち、' + wait + '日後に進む', { type: 'military', factions: [fid] }); }
    return out;
  }
  // 毎日：合流の処理・途中離脱・記録上の騎数
  function contingentsTick(s) {
    Object.keys(s.armies).forEach(function (k) {
      var a = s.armies[k]; if (!a || !a.joinCorps) return; var cp = s.corps[a.joinCorps];
      var leads = Object.keys(s.armies).map(function (x) { return s.armies[x]; }).filter(function (x) { return x.corps === a.joinCorps && !x.joinCorps; });
      if (!cp || !leads.length) { a.joinCorps = null; if (a.status === 'idle' || a.status === 'arrived') { if (a.contingentOf === s.playerFaction) news(s, '【引き揚げ】' + armyLabel(s, a) + 'は合流先の本隊がすでに退いていたため、本領へ引き返した（「御家人」タブで、改めて出陣や合流を命じられる）', { type: 'military', important: true, factions: [s.playerFaction] }); disbandArmy(s, a, 'home'); } return; }
      var lord = F(s, a.contingentOf), rec = (cp.contingents || []).filter(function (c) { return c.army === a.id; })[0], r = rec ? { kind: rec.kind, id: rec.id } : null;
      // 途中離脱：忠誠が低いか、本隊が負けて士気が落ちている
      var lowMor = leads.every(function (x) { return x.morale < 35; }), L = r ? retLoyalty(s, r, a.contingentOf) : 60;
      if (a.status !== 'battle' && ((L < 35 && rand(s) < 0.02) || (lowMor && rand(s) < 0.05))) {
        news(s, '【離脱】' + (rec ? rec.name : armyLabel(s, a)) + 'の兵' + Math.round(a.troops) + 'は途中で引き返した' + (lowMor ? '（本隊の負け戦を見て）' : ''), { type: 'military', important: a.contingentOf === s.playerFaction, factions: [a.contingentOf] });
        if (rec) rec.decision = 'left'; a.joinCorps = null; var home = rec ? (rec.kind === 'house' ? (houseBands(s, rec.id)[0] || {}).province : null) : null; if (home) setArmyTarget(s, a, { type: 'province', id: home }, 'move'); else retreat(s, a); return;
      }
      if (a.status === 'gathering' || a.status === 'marching' || a.status === 'battle' || a.status === 'retreating') return;
      var here = leads.filter(function (x) { return x.province === a.province && x.status !== 'battle'; })[0];
      if (here && a.faction === here.faction) { // 同じ勢力（家の兵）は本隊に合流
        here.troops += a.troops; here.initialTroops += a.troops; here.food += a.food; here.bands = here.bands.concat(a.bands); if (a.commander && here.officers.indexOf(a.commander) < 0) here.officers.push(a.commander); a.officers.forEach(function (o) { if (here.officers.indexOf(o) < 0) here.officers.push(o); });
        here.divisions = (here.divisions || []).concat([{ leader: a.commander, troops: a.troops, house: a.house }]); here.house = here.house || null;
        a.officers.concat(a.commander ? [a.commander] : []).forEach(function (p) { if (s.persons[p]) s.persons[p].location = 'army:' + here.id; });
        if (rec) { rec.decision = rec.decision === 'late' ? 'late-joined' : 'joined'; rec.joinedDay = s.day; addService(s, a.contingentOf, rec.id, 2 + a.troops / 100); }
        news(s, '【合流】' + (rec ? rec.name : '') + 'の兵' + Math.round(a.troops) + 'が' + PV(s, a.province).name + 'で' + armyLabel(s, here) + 'に加わった（' + Math.round(here.troops) + '）', { type: 'military', factions: [a.faction] });
        delete s.armies[a.id]; return;
      }
      if (here) { a.corps = a.joinCorps; a.joinCorps = null; if (rec) rec.decision = 'joined'; setArmyTarget(s, a, cp.target, 'attack'); return; } // 御家人の勢力の軍は軍団に入って共に進む
      // 本隊がまだ来ていなければ待つ（最大10日）。過ぎていれば追う
      a.waitDays = (a.waitDays || 0) + 1;
      var lead = leads[0], ahead = (lead.path || []).indexOf(a.province) >= 0;
      if (!ahead || a.waitDays > 10) setArmyTarget(s, a, { type: 'province', id: lead.path && lead.path.length ? lead.path[lead.path.length - 1] : lead.province }, 'move');
    });
    // 記録上の騎数：大軍になると軍記は誇張して伝える（史料の数字とゲームの実数を分ける）
    Object.keys(s.corps || {}).forEach(function (cid) { var cp = s.corps[cid]; if (cp.recorded) return; var tot = Object.keys(s.armies).reduce(function (t, k) { var a = s.armies[k]; return t + (a.corps === cid ? a.troops : 0); }, 0);
      if (tot >= 3000) { var rec = Math.round(tot * (6 + rand(s) * 10) / 1000) * 1000; cp.recorded = { troops: tot, legend: rec, day: s.day };
        news(s, '【軍記】' + pname(s, cp.commander) + 'の軍は「' + (rec >= 10000 ? (rec / 10000).toFixed(rec % 10000 ? 1 : 0) + '万' : rec) + '騎」と伝えられる（ゲーム上の実数はおよそ' + Math.round(tot / 100) * 100 + '。軍記の数字は誇張を含む）', { type: 'military', factions: [cp.faction] }); } });
  }
  // ---- 大軍勢の軍団分割：東海道・東山道・北陸道など別々の道から同じ目標へ
  var ROUTES = { tokaido: { label: '東海道', via: ['suruga', 'totomi', 'mikawa', 'owari', 'ise'] }, tosando: { label: '東山道', via: ['kozuke', 'shinano', 'mino', 'omi'] }, hokurikudo: { label: '北陸道', via: ['echigo', 'etchu', 'kaga', 'echizen', 'wakasa'] }, sanyodo: { label: '山陽道', via: ['harima', 'bizen', 'bitchu', 'bingo', 'aki'] } };
  function routePath(s, from, to, route, fid) {
    var R = ROUTES[route]; if (!R) return null; var best = null, bd = 1e9;
    R.via.forEach(function (w) { if (w === from || w === to || !s.provinces[w]) return; var d = distProv(s, from, w) + distProv(s, w, to); if (d < bd) { bd = d; best = w; } });
    if (!best) return null; var p1 = findPath(s, from, best, fid), p2 = findPath(s, best, to, fid); if (!p1 || !p2) return null;
    return p1.slice(1).concat(p2.slice(1));
  }
  function splitCorps(s, fid, cmd) {
    var cp = s.corps[cmd.corps]; if (!cp || cp.faction !== fid) return { ok: false, reason: '軍団が不明' };
    var groups = (cmd.groups || []).filter(function (g) { return g.armies && g.armies.length; }); if (groups.length < 2) return { ok: false, reason: '二つ以上の軍団に分けること' };
    var made = [];
    groups.forEach(function (g, i) {
      var arms = g.armies.map(function (id) { return s.armies[id]; }).filter(function (a) { return a && a.faction === fid && a.corps === cmd.corps && a.status !== 'battle'; }); if (!arms.length) return;
      var cid = i === 0 ? cmd.corps : nid(s, 'corps'), commander = g.commander && arms.some(function (a) { return a.commander === g.commander; }) ? g.commander : arms[0].commander;
      if (i > 0) s.corps[cid] = { id: cid, faction: fid, commander: commander, bugyo: null, target: g.target || cp.target, created: s.day, remote: false, hq: null, parent: cmd.corps, contingents: [] };
      else { cp.commander = commander; if (g.target) cp.target = g.target; }
      var C = s.corps[cid]; C.vice = g.vice || null; C.route = g.route || null; C.strategic = cp.strategic || cp.target;
      arms.forEach(function (a) { a.corps = cid; var t = C.target, dest = t.type === 'base' ? B(s, t.id).province : t.id;
        var p = g.route && g.route !== 'auto' ? routePath(s, a.province, dest, g.route, fid) : null;
        setArmyTarget(s, a, t, 'attack'); if (p && p.length) { a.path = p; a.edge = null; if (a.status !== 'gathering') a.status = 'marching'; } });
      made.push(pname(s, commander) + (g.route && ROUTES[g.route] ? '（' + ROUTES[g.route].label + '）' : '') + '・' + arms.reduce(function (t, a) { return t + a.troops; }, 0));
    });
    news(s, '【軍団分割】' + made.join('／') + '。目標は' + targetName(s, cp.strategic || cp.target), { type: 'military', important: true, factions: [fid] });
    return { ok: true, message: '軍団を' + made.length + 'つに分けた：' + made.join('／') };
  }
  // ---- 北条氏への移行との連携：家を、主君に従う独立した勢力として切り出す（第2仕様で操作対象の移行に使う）
  function houseToFaction(s, hid) {
    var h = H(s, hid); if (!h) return null; var lord = F(s, h.lord), id = hid;
    if (s.factions[id] && s.factions[id].alive) return s.factions[id];
    var nf = s.factions[id] = { id: id, name: h.name, type: '御家人', color: lord ? lord.color : '#777', leader: h.head, heir: h.heir || null, capital: h.seat && B(s, h.seat) ? h.seat : null, money: Math.round(h.money || 0), food: Math.round(h.food || 0),
      policy: '主家に従う', ambition: h.ambition || 40, courtRelation: 10, legitimacy: 20, playable: false, status: '在地', overlord: h.lord, navy: false, alive: true, description: h.note || '', flags: {}, ai: { posture: '', memo: '' }, institutions: {} };
    nf.regime = regimeBase(nf); nf.regime.goal = '家の存続と幕府内の地位'; nf.regime.confidence = 'ゲーム設定';
    h.members.forEach(function (m) { var p = Pn(s, m); if (p && p.alive && p.faction === h.lord) p.faction = id; });
    houseBands(s, hid).forEach(function (b) { b.faction = id; b.house = null; });
    houseHoldings(s, hid).forEach(function (x) { x.controller = id; x.house = null; if (x.rights && x.rights.taxHolder === h.lord) x.rights.taxHolder = id; });
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (b.house === hid) { b.owner = id; b.house = null; } });
    var r = rel(s, id, h.lord); r.value = Math.round((h.loyalty || 60) - 50) * 2; r.status = '主従';
    Object.keys(s.factions).forEach(function (k) { if (k !== id && atWar(s, k, h.lord)) rel(s, k, id).war = true; });
    h.faction = id; h.asFaction = id;
    return nf;
  }
  // ================================================================ 世代継承キャンペーン（v1.2）：源氏 → 北条執権
  // プレイヤー操作対象（s.player）は勢力・家と別に管理する。A方式：頼朝の死で源氏の操作を終え、北条氏へ完全に移る。
  var ERAS_LATER = [['正治', [1199, 4, 27]], ['建仁', [1201, 2, 13]], ['元久', [1204, 2, 20]], ['建永', [1206, 4, 27]], ['承元', [1207, 10, 25]], ['建暦', [1211, 3, 9]], ['建保', [1213, 12, 6]], ['承久', [1219, 4, 12]], ['貞応', [1222, 4, 13]], ['元仁', [1224, 11, 20]], ['嘉禄', [1225, 4, 20]], ['安貞', [1227, 12, 10]], ['寛喜', [1229, 3, 5]], ['貞永', [1232, 4, 2]], ['天福', [1233, 4, 15]], ['文暦', [1234, 11, 5]], ['嘉禎', [1235, 9, 19]], ['暦仁', [1238, 11, 23]], ['延応', [1239, 2, 7]], ['仁治', [1240, 7, 16]]];
  function ensureEras(s) { var c = s.calendar; if (!c || !c.eras) return; ERAS_LATER.forEach(function (e) { if (!c.eras.some(function (x) { return x.name === e[0]; })) { c.eras.push({ name: e[0], from: e[1] }); if (c.eraStartYear) c.eraStartYear[e[0]] = e[1][0]; } }); } // 改元の月日は和暦（史実）。月の大小・閏月はこの期間は近似
  function ensurePlayer(s) { ensureEras(s); if (!s.player) s.player = { faction: s.playerFaction || null, house: null, history: [] }; s.player.faction = s.playerFaction; return s.player; }
  function transferPlayer(s, toFid, reason) {
    ensurePlayer(s); var from = s.playerFaction; if (!F(s, toFid) || !F(s, toFid).alive || from === toFid) return { ok: false, reason: '移る先がない' };
    s.player.history.push({ day: s.day, date: dateStr(s), from: from, to: toFid, reason: reason });
    s.playerFaction = toFid; s.player.faction = toFid; s.player.house = (s.houses[toFid] ? toFid : null);
    s.flags.playerHadBase = factionBases(s, toFid).length > 0; s.flags.victory = false; s.flags.unifiedDay = null;
    news(s, '【操作の移行】' + fname(s, from) + 'の操作を終え、' + fname(s, toFid) + 'として続ける（' + reason + '）。' + fname(s, from) + 'は以後CPUが動かす', { type: 'politics', important: true, factions: [from, toFid] });
    return { ok: true, from: from, to: toFid };
  }
  // 頼朝の死：源氏（将軍家）は滅びずCPUが継ぎ、プレイヤーは北条氏へ（A方式・キャンペーン時）
  function campaignOnDeath(s, f, dead) {
    if (s.options.goal !== 'campaign' || f.id !== s.playerFaction || f.id !== 'yoritomo' || s.flags.campaignStage >= 2) return;
    var h = s.houses.hojo; var hf = h && h.asFaction ? F(s, h.asFaction) : null;
    if (!hf && h && h.head && alive(s, h.head)) hf = houseToFaction(s, 'hojo');
    if (!hf || !hf.alive) { news(s, '北条氏が絶えているため、源氏のまま続ける', { type: 'politics', important: true }); return; }
    { var kb = B(s, 'kamakura'); var id = 'nagoe_tei'; if (!s.bases[id]) s.bases[id] = { id: id, name: '名越亭（北条氏の鎌倉の屋敷）', province: 'sagami', type: '館', owner: hf.id, defense: 10, maxDefense: 10, garrison: 60, x: (kb ? kb.x : 1068) + 4, y: (kb ? kb.y : 780) + 4, confidence: '有力説', note: '北条時政の鎌倉の邸宅（名越）。幕府に出仕する北条氏の拠点' }; if (!hf.capital || !B(s, hf.capital) || B(s, hf.capital).owner !== hf.id) hf.capital = id; }
    s.flags.campaignStage = 2; transferPlayer(s, hf.id, '源頼朝の死去'); shogunateTick(s); // 御家人の影響力をすぐ計る
    stop(s, { key: 'campaign_transfer', title: '源頼朝の死 ― 北条氏へ', persons: [hf.leader], text: dead.name + 'が世を去った。源氏（将軍家）は' + pname(s, f.leader) + 'が継ぎ、以後はCPUが動かす。\nあなたは北条氏として、幕府の有力御家人の一つから出発する。北条氏が持つのは自家の所領・郎党・蔵だけで、源氏の資産は引き継がない。\n比企・三浦・和田・梶原ら他の御家人と争い、執権として幕府の実権を握れ。執権となった後もゲームは続く。', choices: [] });
  }
  // 将軍家の子と北条の次代（史実の誕生。両親が生きていれば生まれる）
  var BIRTHS = [
    { id: 'yoriie', date: [1182, 8, 12], parents: ['yoritomo', 'masako'], p: { name: '源頼家', kana: 'みなもとのよりいえ', born: 1182, died: 1204, faction: 'yoritomo', status: '頼朝の嫡男', abilities: { command: 55, valor: 70, politics: 38, intellect: 45, diplomacy: 35 }, personality: '剛直', ambition: 70, loyalty: 90, rel: [['yoritomo', '父子（相手側）'], ['masako', '母子（相手側）']] } },
    { id: 'yasutoki', date: [1183, 1, 1], parents: ['yoshitoki'], house: 'hojo', p: { name: '北条泰時', kana: 'ほうじょうやすとき', born: 1183, died: 1242, faction: null, status: '義時の子', abilities: { command: 75, valor: 65, politics: 92, intellect: 88, diplomacy: 80 }, personality: '公正', ambition: 50, loyalty: 90, rel: [['yoshitoki', '父子（相手側）']] }, note: '誕生月日は不詳（1183年）' },
    { id: 'sanetomo', date: [1192, 8, 9], parents: ['yoritomo', 'masako'], p: { name: '源実朝', kana: 'みなもとのさねとも', born: 1192, died: 1219, faction: 'yoritomo', status: '頼朝の次男', abilities: { command: 25, valor: 20, politics: 55, intellect: 80, diplomacy: 65 }, personality: '風雅', ambition: 30, loyalty: 90, rel: [['yoritomo', '父子（相手側）'], ['masako', '母子（相手側）']] } },
  ];

  // ---- 文官の下向：京の下級官人が鎌倉の頼朝のもとへ下る（史実の時期を基準に、自由モードでは条件しだい）
  var ARRIVALS = [
    { id: 'toshikane', date: [1181, 2, 1], earliest: [1180, 12, 1], p: { name: '藤原俊兼', kana: 'ふじわらのとしかね', born: null, died: null, status: '頼朝の右筆（文書の作成）', abilities: { command: 15, valor: 10, politics: 72, intellect: 78, diplomacy: 55 }, personality: '能吏', ambition: 30, loyalty: 85 }, note: '頼朝の右筆として文書を扱った（史実）。生没年は不詳' },
    { id: 'chikayoshi', date: [1183, 10, 1], earliest: [1182, 6, 1], p: { name: '中原親能', kana: 'なかはらのちかよし', born: 1143, died: 1209, status: '京と鎌倉をつなぐ文官', abilities: { command: 35, valor: 20, politics: 82, intellect: 80, diplomacy: 88 }, personality: '如才ない', ambition: 45, loyalty: 85 }, note: '頼朝と旧知で、京の事情に通じた側近（史実）。下向の時期は諸説' },
    { id: 'yasunobu', date: [1184, 4, 14], earliest: [1183, 6, 1], existing: true, note: '元暦元年（1184）4月に鎌倉へ下向し、問注所の執事となる（史実）' },
    { id: 'hiromoto', date: [1184, 6, 1], earliest: [1183, 6, 1], p: { name: '大江広元', kana: 'おおえのひろもと', born: 1148, died: 1225, status: '京の下級官人（明法・文筆に通じる）', abilities: { command: 20, valor: 10, politics: 96, intellect: 95, diplomacy: 85 }, personality: '沈着', ambition: 45, loyalty: 85 }, note: '元暦元年（1184）に鎌倉へ下向し、公文所の別当となる（史実）。中原親能の弟（兄弟関係は諸説）' },
    { id: 'yukimasa', date: [1184, 9, 1], earliest: [1183, 9, 1], p: { name: '二階堂行政', kana: 'にかいどうゆきまさ', born: null, died: null, status: '公文所の寄人となる文官', abilities: { command: 20, valor: 15, politics: 80, intellect: 82, diplomacy: 60 }, personality: '実直', ambition: 40, loyalty: 85 }, note: '公文所の寄人、のち政所令（史実）。生没年は不詳' }
  ];
  var KANTO_P = ['izu', 'sagami', 'musashi', 'kazusa', 'shimosa', 'awa_t', 'suruga', 'hitachi', 'kozuke', 'shimotsuke'];
  function arrivalsTick(s) {
    var y = F(s, 'yoritomo'); if (!y || !y.alive || ['挙兵', '幕府'].indexOf(y.status) < 0 && !(y.flags || {}).bakufu) return;
    var cap = B(s, y.capital); if (!cap || KANTO_P.indexOf(cap.province) < 0) return;
    ARRIVALS.forEach(function (a) {
      s.flags.arrived = s.flags.arrived || {}; if (s.flags.arrived[a.id]) return;
      var due = cmpDate(s.date, { y: a.date[0], m: a.date[1], leap: false, d: a.date[2] }) >= 0, early = cmpDate(s.date, { y: a.earliest[0], m: a.earliest[1], leap: false, d: 1 }) >= 0;
      var go = histMode(s) ? due : (due && (y.legitimacy >= 35 || y.flags.ryoji || y.flags.insen)) || (early && (y.legitimacy >= 55 || y.flags.insen) && rand(s) < 0.06);
      if (!go) return; s.flags.arrived[a.id] = s.day;
      var p = s.persons[a.id];
      if (a.existing) { if (!p || !p.alive) return; p.faction = 'yoritomo'; p.location = y.capital; }
      else { if (p) return; p = s.persons[a.id] = { id: a.id, name: a.p.name, kana: a.p.kana, born: a.p.born, died: a.p.died, birthConfidence: a.p.born ? '史実' : '要確認', faction: 'yoritomo', location: y.capital, status: a.p.status, rank: '', courtOffices: [], warriorOffices: [], abilities: a.p.abilities, abilitiesConfidence: 'ゲーム設定', personality: a.p.personality, ambition: a.p.ambition, loyalty: a.p.loyalty, alive: true, health: 100, note: a.note, relations: [], naturalDeath: a.p.died ? { y: a.p.died, m: 6, d: 1 } : null, captiveOf: null };
        if (a.id === 'hiromoto' && s.persons.chikayoshi) { p.relations.push({ person: 'chikayoshi', type: '兄弟' }); } }
      news(s, '【下向】' + p.name + 'が京から' + cap.name + 'の源頼朝のもとへ下ってきた。' + (a.note || ''), { type: 'politics', important: true, factions: ['yoritomo'] });
      if (s.playerFaction === 'yoritomo') stop(s, { key: 'arrival', title: '文官の下向：' + p.name, persons: [p.id], text: p.name + 'が京から下ってきた。政務・文書に通じた文官で、幕府の機関（公文所・問注所など）の長や使者に向く。\n' + (a.note || ''), choices: [] });
    });
  }
  function birthsTick(s) {
    BIRTHS.forEach(function (b) {
      if (s.persons[b.id] || cmpDate(s.date, { y: b.date[0], m: b.date[1], leap: false, d: b.date[2] }) < 0) return;
      if (b.requires && !s.flags[b.requires]) return;
      if (!b.parents.every(function (pid) { return alive(s, pid); })) { s.persons[b.id] = { id: b.id, name: b.p.name, alive: false, born: null, died: null, faction: null, abilities: b.p.abilities, relations: [], status: '（生まれなかった）', note: '親が亡くなっていたため誕生しない（歴史の分岐）', notBorn: true, courtOffices: [], warriorOffices: [] }; return; }
      var par = Pn(s, b.parents[0]), fac = b.p.faction || par.faction;
      var p = s.persons[b.id] = { id: b.id, name: b.p.name, kana: b.p.kana, born: b.p.born, died: b.p.died, birthConfidence: '史実', faction: fac, location: par.location && !/^(army|envoy):/.test(String(par.location)) ? par.location : (F(s, fac) ? F(s, fac).capital : null), status: b.p.status, rank: '', courtOffices: [], warriorOffices: [], abilities: b.p.abilities, abilitiesConfidence: 'ゲーム設定', personality: b.p.personality, ambition: b.p.ambition, loyalty: b.p.loyalty, alive: true, health: 100, note: b.note || '', relations: b.p.rel.map(function (r) { return { person: r[0], type: r[1] }; }), naturalDeath: null, captiveOf: null };
      b.p.rel.forEach(function (r) { var q = Pn(s, r[0]); if (q) q.relations.push({ person: b.id, type: r[1].replace('（相手側）', '') }); });
      if (b.house && s.houses[b.house]) { var h = s.houses[b.house]; if (h.members.indexOf(b.id) < 0) h.members.push(b.id); if (h.asFaction) p.faction = h.asFaction; }
      news(s, '【誕生】' + p.name + 'が生まれた', { type: 'politics', factions: [fac] });
    });
    // 頼家と比企氏の縁（史実：頼家の妻・若狭局は比企能員の娘）。頼家が成人し比企氏が健在なら結ばれる
    var y = Pn(s, 'yoriie'), hk = s.houses.hiki;
    if (y && y.alive && ageOf(s, y) >= 16 && hk && hk.head && alive(s, hk.head) && !s.flags.wakasa && rand(s) < 0.1) { s.flags.wakasa = s.day; y.relations.push({ person: hk.head, type: '舅' }); var hp = Pn(s, hk.head); hp.relations.push({ person: 'yoriie', type: '娘婿' }); news(s, '【婚姻】源頼家は比企能員の娘（若狭局）を妻とした。比企氏は将軍家の外戚となる', { type: 'politics', important: true, factions: ['yoritomo'] }); }
  }
  // ---- 幕府の御家人政治：参加者＝将軍家に仕える家と御家人の勢力（北条・比企・三浦・和田・梶原…）
  function shogunId(s) { return s.factions.yoritomo && s.factions.yoritomo.alive && s.factions.yoritomo.flags.bakufu ? 'yoritomo' : null; }
  function ensureShogunate(s) { if (!s.shogunate) s.shogunate = { inf: {}, ties: {}, wary: {}, shikken: null, rensho: null, reforms: {}, log: [], hyojo: [] }; return s.shogunate; }
  function participants(s) {
    var sh = shogunId(s); if (!sh) return [];
    var out = Object.keys(s.houses || {}).filter(function (k) { var h = s.houses[k]; return !h.asFaction && !h.ruined && h.head && alive(s, h.head) && F(s, h.faction) && F(s, h.faction).alive && topLord(s, h.faction) === sh; }).map(function (k) { return { kind: 'house', id: k }; });
    vassalsOf(s, sh).forEach(function (k) { out.push({ kind: 'vassal', id: k }); });
    Object.keys(s.factions).forEach(function (k) { var f = s.factions[k]; if (k !== sh && f.alive && f.overlord && f.overlord !== sh && topLord(s, k) === sh && !out.some(function (o) { return o.id === k; })) out.push({ kind: 'vassal', id: k }); }); // 陪臣の家（北条の分家が勢力になった場合など）
    return out;
  }
  function pName(s, id) { return s.houses[id] && !s.houses[id].asFaction ? s.houses[id].name : fname(s, id).replace(/（.*）/, ''); }
  function pMembers(s, id) { return s.houses[id] && !s.houses[id].asFaction ? s.houses[id].members.map(function (m) { return Pn(s, m); }).filter(function (p) { return p && p.alive; }) : factionPersons(s, id); }
  function pTroops(s, id) { if (s.houses[id] && !s.houses[id].asFaction) return houseTroops(s, id); var p = factionPower(s, id); return p.available + p.garrison + p.field; }
  function tieKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function tie(s, a, b) { var sg = ensureShogunate(s), k = tieKey(a, b); if (sg.ties[k] == null) { var base = 0; if (F(s, a) && F(s, b) && !s.houses[a] && !s.houses[b]) base = rel(s, a, b).value / 2; sg.ties[k] = base; } return sg.ties[k]; }
  function addTie(s, a, b, v) { var sg = ensureShogunate(s); sg.ties[tieKey(a, b)] = clamp(tie(s, a, b) + v, -100, 100); }
  function shogunTie(s, id) { var sh = shogunId(s); if (!sh) return 0; var h = s.houses[id]; if (h && !h.asFaction) return h.faction === sh ? (h.loyalty == null ? 50 : h.loyalty) * 2 - 100 : clamp(rel(s, h.faction, sh).value + 20, -100, 100); return rel(s, id, sh).value; }
  function pOffices(s, id) { var sh = F(s, shogunId(s) || ''), n = 0, ms = pMembers(s, id).map(function (p) { return p.id; }); if (sh && sh.institutions) Object.keys(sh.institutions).forEach(function (k) { if (ms.indexOf(sh.institutions[k].head) >= 0) n++; }); var sg = ensureShogunate(s); if (sg.shikken && sg.shikken.holder === id) n += 2; if (sg.rensho && sg.rensho.holder === id) n++; return n; }
  function pMarriage(s, id) { var sh = F(s, shogunId(s) || ''); if (!sh) return 0; var lords = [sh.leader, sh.heir].filter(Boolean); return pMembers(s, id).some(function (p) { return (p.relations || []).some(function (r) { return /夫婦|母子|舅|娘婿|乳母/.test(r.type) && lords.indexOf(r.person) >= 0; }); }) ? 15 : 0; }
  function shogunateTick(s) {
    var sh = shogunId(s); if (!sh) return; var sg = ensureShogunate(s), ps = participants(s);
    ps.forEach(function (p) {
      var hold = Object.keys(s.holdings).reduce(function (t, k) { var h = s.holdings[k]; return t + ((h.house === p.id || (h.controller === p.id && !h.house)) ? h.output : 0); }, 0);
      var t = clamp(5 + pOffices(s, p.id) * 10 + pTroops(s, p.id) / 80 + hold / 5000 + shogunTie(s, p.id) / 5 + pMarriage(s, p.id) + (s.houses[p.id] ? (s.houses[p.id].favor || 0) / 2 : 0) - (sg.wary[p.id] || 0) / 5, 0, 100);
      sg.inf[p.id] = Math.round(((sg.inf[p.id] == null ? t : sg.inf[p.id]) + (t - (sg.inf[p.id] == null ? t : sg.inf[p.id])) * 0.2) * 10) / 10;
      if (sg.wary[p.id]) { ps.forEach(function (q) { if (q.id !== p.id) addTie(s, p.id, q.id, -sg.wary[p.id] / 25); }); sg.wary[p.id] = Math.max(0, sg.wary[p.id] - 2); }
    });
    if (!ps.some(function (p) { return p.id === s.playerFaction; }) || true) aiShogunate(s, ps);
    // 将軍家（CPU）は空いた役職を最も信頼する家に与える
    var shf = F(s, sh); if (sh !== s.playerFaction && shf.institutions) Object.keys(shf.institutions).forEach(function (k) { var ins = shf.institutions[k]; if (ins.head && alive(s, ins.head)) return; var best = ps.slice().sort(function (a, b) { return shogunTie(s, b.id) - shogunTie(s, a.id); })[0]; var pp = best && pMembers(s, best.id).sort(function (a, b) { return b.abilities.politics - a.abilities.politics; })[0]; if (pp) { ins.head = pp.id; news(s, '【幕府人事】' + pp.name + '（' + pName(s, best.id) + '）が' + INSTITUTIONS[k].name + 'の' + INSTITUTIONS[k].head + 'に任じられた', { type: 'politics', factions: [sh] }); } });
    checkShikken(s, ps);
  }
  var BK_TPL = {
    ally: ['{A}は{B}と誼を通じ、互いに助け合うことを約した。'], marriage: ['{A}は{B}と婚姻を結び、一族の縁を固めた。'],
    seek: ['{A}は将軍家に願い出て、{O}の役を得た。'], seekfail: ['{A}は{O}の役を望んだが、将軍家は許さなかった。'],
    isolate: ['{A}は{B}の非を御家人たちに説いて回った。{B}は孤立しはじめている。'],
    impeach: ['{A}を中心に御家人{N}人が連署し、{B}の非を将軍家に訴えた。{B}は役を解かれ、幕府を追われた。'], impeachfail: ['{A}は{B}を訴えたが、同心する者が少なく、かえって将軍家の不興を買った。'],
    attack: ['{A}は{B}を討つべく兵を挙げた。'], exploit: ['{A}は{B}と{C}の間に不和の種をまいた。'],
    wary: ['{B}の勢いを警戒し、{A}は{C}に近づいた。「このままでは{B}の天下になる」'],
    shikken: ['{P}が政所別当として幕政を主導し、執権と呼ばれるようになった。'],
  };
  function bkLog(s, actor, key, v, reason) { var t = tplFrom(s, BK_TPL[key], v); var sg = ensureShogunate(s); sg.log.push({ day: s.day, date: dateStr(s), text: t }); if (sg.log.length > 200) sg.log.shift(); aiLog(s, actor, '幕府政治：' + key, reason || '', t); news(s, '【幕府】' + t, { type: 'politics', important: actor === s.playerFaction || key === 'impeach' || key === 'attack' || key === 'shikken' }); return t; }
  function bkAct(s, actor, act, target, extra) {
    var sg = ensureShogunate(s), ps = participants(s); extra = extra || {};
    if (!shogunId(s)) return { ok: false, reason: '幕府がまだない' };
    if (!ps.some(function (p) { return p.id === actor; })) return { ok: false, reason: '幕府の御家人ではない' };
    var purse = s.houses[actor] && !s.houses[actor].asFaction ? s.houses[actor] : F(s, actor);
    var tgtOk = target && target !== actor && ps.some(function (p) { return p.id === target; });
    var cost = { ally: 200, marriage: 300, seek: 300, isolate: 300, impeach: 500, attack: 0, exploit: 250, shikken: 0 }[act];
    if (cost == null) return { ok: false, reason: '不明な行動' };
    if ((purse.money || 0) < cost) return { ok: false, reason: '銭が足りない（' + cost + '貫）' };
    sg.cool = sg.cool || {}; var ck = actor + ':' + act; if (sg.cool[ck] != null && s.day - sg.cool[ck] < 45) return { ok: false, reason: '同じ手は45日空ける' };
    var A = pName(s, actor), Bn = tgtOk ? pName(s, target) : '', res;
    if (['ally', 'marriage', 'isolate', 'impeach', 'attack'].indexOf(act) >= 0 && !tgtOk) return { ok: false, reason: '相手の御家人を選ぶこと' };
    if (act === 'ally') { addTie(s, actor, target, 20); res = bkLog(s, actor, 'ally', { A: A, B: Bn }); }
    else if (act === 'marriage') { if (tie(s, actor, target) < -20) return { ok: false, reason: Bn + 'とは不和で婚姻は結べない' }; addTie(s, actor, target, 35); res = bkLog(s, actor, 'marriage', { A: A, B: Bn }); }
    else if (act === 'seek') { var shf = F(s, shogunId(s)), k = extra.office; var ins = shf.institutions && shf.institutions[k]; if (!ins) return { ok: false, reason: 'その機関はまだない' };
      var cur = ps.filter(function (p) { return pMembers(s, p.id).some(function (m) { return m.id === ins.head; }); })[0], pr = clamp(0.3 + (sg.inf[actor] - (cur ? sg.inf[cur.id] : 0)) / 80 + shogunTie(s, actor) / 200, 0.05, 0.9);
      if (rand(s) < pr) { var best = pMembers(s, actor).sort(function (a, b) { return b.abilities.politics - a.abilities.politics; })[0]; ins.head = best.id; if (cur) addTie(s, actor, cur.id, -15); res = bkLog(s, actor, 'seek', { A: A, O: INSTITUTIONS[k].name + 'の' + INSTITUTIONS[k].head }); }
      else { res = bkLog(s, actor, 'seekfail', { A: A, O: INSTITUTIONS[k].name + 'の' + INSTITUTIONS[k].head }); } }
    else if (act === 'isolate') { ps.forEach(function (p) { if (p.id !== target && p.id !== actor) addTie(s, p.id, target, -10); }); addTie(s, actor, target, -15); sg.wary[actor] = (sg.wary[actor] || 0) + 8; res = bkLog(s, actor, 'isolate', { A: A, B: Bn }); }
    else if (act === 'exploit') { var others = ps.filter(function (p) { return p.id !== actor; }).sort(function (a, b) { return (sg.inf[b.id] || 0) - (sg.inf[a.id] || 0); }); if (others.length < 2) return { ok: false, reason: '相手が足りない' }; addTie(s, others[0].id, others[1].id, -15); sg.wary[actor] = (sg.wary[actor] || 0) + 4; res = bkLog(s, actor, 'exploit', { A: A, B: pName(s, others[0].id), C: pName(s, others[1].id) }); }
    else if (act === 'impeach') { // 将軍との関係と御家人の連署で、相手を幕府から退ける
      var sup = ps.filter(function (p) { return p.id !== actor && p.id !== target && tie(s, p.id, actor) > tie(s, p.id, target) + 5; }), n = 10 + sup.length * 14 + Math.round(rand(s) * 20);
      var pr2 = clamp(0.15 + ((sg.inf[actor] || 0) + sup.reduce(function (t, p) { return t + (sg.inf[p.id] || 0) * 0.5; }, 0) - (sg.inf[target] || 0) * 1.3) / 100 + (shogunTie(s, actor) - shogunTie(s, target)) / 300, 0.05, 0.9);
      sg.wary[actor] = (sg.wary[actor] || 0) + 15;
      if (rand(s) < pr2) { var shf2 = F(s, shogunId(s)); if (shf2.institutions) Object.keys(shf2.institutions).forEach(function (k) { if (pMembers(s, target).some(function (m) { return m.id === shf2.institutions[k].head; })) shf2.institutions[k].head = null; });
        if (sg.shikken && sg.shikken.holder === target) sg.shikken = null; sg.inf[target] = (sg.inf[target] || 0) * 0.5; sg.impeached = sg.impeached || {}; sg.impeached[target] = s.day;
        if (s.houses[target] && !s.houses[target].asFaction) s.houses[target].loyalty = 10; else { var x = rel(s, target, shogunId(s)); x.value = Math.min(x.value, -40); }
        ps.forEach(function (p) { addTie(s, p.id, target, -10); }); res = bkLog(s, actor, 'impeach', { A: A, B: Bn, N: n }, '成功率' + Math.round(pr2 * 100) + '%・同心' + sup.length + '家'); }
      else { var x2 = s.houses[actor] && !s.houses[actor].asFaction ? null : rel(s, actor, shogunId(s)); if (x2) x2.value = clamp(x2.value - 15, -100, 100); else s.houses[actor].loyalty = clamp(s.houses[actor].loyalty - 7, 0, 100); addTie(s, actor, target, -25); res = bkLog(s, actor, 'impeachfail', { A: A, B: Bn }, '成功率' + Math.round(pr2 * 100) + '%'); } }
    else if (act === 'attack') { // 討伐：弾劾で幕府を追われた相手、または執権の名でのみ大義が立つ
      var sanctioned = (sg.impeached && sg.impeached[target] != null) || (sg.shikken && sg.shikken.holder === actor);
      var tf = s.houses[target] && !s.houses[target].asFaction ? houseToFaction(s, target) : F(s, target); var af = s.houses[actor] && !s.houses[actor].asFaction ? houseToFaction(s, actor) : F(s, actor);
      declareWar(s, af.id, tf.id); if (sanctioned) { var sh3 = shogunId(s); if (sh3 && tf.overlord === sh3) { tf.overlord = null; declareWar(s, sh3, tf.id); } } else { sg.wary[actor] = (sg.wary[actor] || 0) + 30; var x3 = rel(s, af.id, shogunId(s)); x3.value = clamp(x3.value - 30, -100, 100); }
      res = bkLog(s, actor, 'attack', { A: A, B: Bn }, sanctioned ? '幕府の大義あり' : '私戦（御家人の警戒↑・将軍家の不興）'); }
    purse.money -= cost; sg.cool[ck] = s.day;
    return { ok: true, message: res };
  }
  // CPU の御家人：最も強い家を警戒し、連携・将軍への接近・訴え・役職を求める
  function aiShogunate(s, ps) {
    var sg = ensureShogunate(s); if (ps.length < 2) return;
    ps.forEach(function (p) {
      if (p.id === s.playerFaction || rand(s) > 0.35) return;
      var amb = s.houses[p.id] ? s.houses[p.id].ambition : (F(s, p.id) || {}).ambition || 40, my = sg.inf[p.id] || 0;
      var top = ps.filter(function (q) { return q.id !== p.id; }).sort(function (a, b) { return (sg.inf[b.id] || 0) - (sg.inf[a.id] || 0); })[0]; if (!top) return; var tv = sg.inf[top.id] || 0;
      var purse = s.houses[p.id] && !s.houses[p.id].asFaction ? s.houses[p.id] : F(s, p.id); if (!purse || (purse.money || 0) < 300) return;
      if (tv > my * 1.3 && tie(s, p.id, top.id) < 10) {
        var friend = ps.filter(function (q) { return q.id !== p.id && q.id !== top.id; }).sort(function (a, b) { return tie(s, p.id, b.id) - tie(s, p.id, a.id); })[0];
        if (amb > 55 && tie(s, p.id, top.id) < -30 && rand(s) < 0.4) { bkAct(s, p.id, 'impeach', top.id); return; }
        if (friend) { var r = bkAct(s, p.id, 'ally', friend.id); if (r.ok) bkLog(s, p.id, 'wary', { A: pName(s, p.id), B: pName(s, top.id), C: pName(s, friend.id) }, pName(s, top.id) + 'の影響力' + Math.round(tv) + '・自家' + Math.round(my)); return; }
      }
      var shf = F(s, shogunId(s)); var vac = shf.institutions && Object.keys(shf.institutions).filter(function (k) { return !shf.institutions[k].head || !alive(s, shf.institutions[k].head); })[0];
      if (vac && amb > 40) { bkAct(s, p.id, 'seek', null, { office: vac }); return; }
      if (amb > 65 && my > tv * 0.9 && rand(s) < 0.3) { var weak = ps.filter(function (q) { return q.id !== p.id; }).sort(function (a, b) { return tie(s, p.id, a.id) - tie(s, p.id, b.id); })[0]; if (weak && tie(s, p.id, weak.id) < -40) bkAct(s, p.id, 'isolate', weak.id); }
    });
  }
  // ---- 執権：政所別当として幕政を主導する者。条件がそろえば就く（1203年は史実の目安で、固定しない）
  function shikkenStatus(s, id) {
    var sg = ensureShogunate(s), sh = shogunId(s), ps = participants(s); if (!sh) return null;
    var shf = F(s, sh), ofc = s.offices.filter(function (o) { return o.id === 'shikken'; })[0];
    var mand = shf.institutions && (shf.institutions.mandokoro || shf.institutions.kumonjo), holdsM = !!(mand && pMembers(s, id).some(function (m) { return m.id === mand.head; }));
    var my = sg.inf[id] || 0, rival = ps.filter(function (p) { return p.id !== id; }).reduce(function (m, p) { return Math.max(m, sg.inf[p.id] || 0); }, 0);
    var founderGone = !alive(s, 'yoritomo'), year = histMode(s) ? (ofc ? ofc.established : 1203) : 1199;
    var rows = [
      { label: '頼朝が世を去っている（将軍の親裁が終わる）', ok: founderGone },
      { label: (histMode(s) ? '史実モード：' + year + '年以降（執権の成立年）' : '自由モード：1199年以降'), ok: s.date.y >= year },
      { label: '政所（公文所）の別当を握る', ok: holdsM },
      { label: '幕府内の影響力が最大で、二番手の1.2倍以上（' + Math.round(my) + '／' + Math.round(rival) + '）', ok: my >= rival * 1.2 && my > 0 },
      { label: '将軍家との関係が良い（' + Math.round(shogunTie(s, id)) + '／20以上）', ok: shogunTie(s, id) >= 20 },
    ];
    return { rows: rows, ok: rows.every(function (r) { return r.ok; }), holder: sg.shikken ? sg.shikken.holder : null };
  }
  function checkShikken(s, ps) {
    var sg = ensureShogunate(s); if (sg.shikken && ps.some(function (p) { return p.id === sg.shikken.holder; })) return;
    ps.forEach(function (p) { if (sg.shikken) return; if (p.id === s.playerFaction) return; var st = shikkenStatus(s, p.id); if (st && st.ok && rand(s) < 0.3) grantShikken(s, p.id); });
  }
  function grantShikken(s, id) {
    var sg = ensureShogunate(s), best = pMembers(s, id).filter(function (p) { return !p.captiveOf; }).sort(function (a, b) { return (b.abilities.politics + b.abilities.intellect) - (a.abilities.politics + a.abilities.intellect); })[0];
    var head = s.houses[id] && !s.houses[id].asFaction ? Pn(s, s.houses[id].head) : Pn(s, F(s, id).leader); var person = head && head.alive ? head : best;
    sg.shikken = { holder: id, person: person.id, since: s.day, date: dateStr(s) }; person.warriorOffices = (person.warriorOffices || []).concat(['執権']);
    bkLog(s, id, 'shikken', { P: person.name + '（' + pName(s, id) + '）' }, '執権の条件がそろった');
    if (id === s.playerFaction) { s.flags.campaignShikken = s.day; stop(s, { key: 'shikken', title: '執権就任', persons: [person.id], text: person.name + 'は執権として幕政を主導する立場に就いた。将軍家はCPUに任せ、これからは執権として幕府を運営する（ゲームは続く）。\n御家人の所領や兵は北条氏のものにはならない。役職・恩賞・命令・制度で幕府を動かす。', choices: [] }); }
    return { ok: true, message: person.name + 'が執権となった' };
  }
  // ---- 執権としての幕府運営：人事・制度改革（時間・銭・御家人の支持が要る）
  var REFORMS = {
    shikken_power: { label: '執権の権限を強める', money: 600, days: 90, support: 40, desc: '将軍の親裁を減らし、執権の裁可で動く。幕府の当主依存↓・権力集中↑' },
    rensho: { label: '連署を置く', money: 300, days: 30, support: 30, desc: '北条一門から連署を選び、執権と並んで署判する。北条一門の結束↑・継承の安定↑' },
    hyojoshu: { label: '評定衆（合議制）を置く', money: 800, days: 120, support: 45, desc: '有力御家人の合議で裁く。御家人の警戒↓・結束↑・成熟↑' },
    litigation: { label: '訴訟の制度を整える', money: 500, days: 90, support: 30, desc: '問注所の裁きを整える。地方統制↑・不穏↓' },
    land_admin: { label: '所領の管理を整える', money: 500, days: 90, support: 30, desc: '御家人の所領を帳簿で管理する。成熟↑・地頭の年貢が安定' },
    local_gov: { label: '地方の統治機構を強める', money: 700, days: 120, support: 40, desc: '守護・地頭の職務を定める。地方統制↑' },
    gokenin_ctl: { label: '御家人の統制を定める', money: 400, days: 60, support: 35, desc: '御家人の勤めと罰を定める。御家人の離反↓' },
  };
  function reformSupport(s, id) { var sg = ensureShogunate(s), ps = participants(s); return ps.reduce(function (t, p) { return t + (p.id === id ? (sg.inf[p.id] || 0) : Math.max(0, tie(s, p.id, id)) / 100 * (sg.inf[p.id] || 0)); }, 0); }
  function startReform(s, id, kind, extra) {
    var sg = ensureShogunate(s), d = REFORMS[kind]; if (!d) return { ok: false, reason: '不明な改革' };
    if (!sg.shikken || sg.shikken.holder !== id) return { ok: false, reason: '執権でなければ制度は改められない' };
    if (sg.reforms[kind]) return { ok: false, reason: d.label + 'はすでに' + (sg.reforms[kind].done ? '行った' : '進めている') };
    var sup = reformSupport(s, id); if (sup < d.support) return { ok: false, reason: '御家人の支持が足りない（' + Math.round(sup) + '／' + d.support + '）' };
    var purse = F(s, id) || s.houses[id]; if ((purse.money || 0) < d.money) return { ok: false, reason: '銭が足りない（' + d.money + '貫）' };
    if (kind === 'rensho') { var m = extra && extra.person ? Pn(s, extra.person) : pMembers(s, id).filter(function (p) { return p.id !== sg.shikken.person; }).sort(function (a, b) { return b.abilities.politics - a.abilities.politics; })[0]; if (!m || !m.alive) return { ok: false, reason: '連署に就ける一門がいない' }; sg.rensho = { holder: id, person: m.id }; m.warriorOffices = (m.warriorOffices || []).concat(['連署']); }
    purse.money -= d.money; sg.reforms[kind] = { start: s.day, days: d.days, done: false };
    news(s, '【幕府】' + d.label + '（約' + d.days + '日）', { type: 'politics', important: true, factions: [id] });
    return { ok: true, message: d.label + 'に着手した' };
  }
  function reformsTick(s) {
    var sg = s.shogunate; if (!sg) return; var sh = F(s, shogunId(s) || ''); if (!sh) return; var r = sh.regime;
    Object.keys(sg.reforms).forEach(function (k) { var x = sg.reforms[k]; if (x.done || s.day - x.start < x.days) return; x.done = true;
      if (k === 'shikken_power') { r.leaderDep = clamp(r.leaderDep - 15, 0, 100); r.central = clamp(r.central + 10, 0, 100); }
      if (k === 'rensho') { var hf = F(s, sg.shikken.holder); if (hf && hf.regime) { hf.regime.cohesion = clamp(hf.regime.cohesion + 10, 0, 100); hf.regime.heirStab = clamp(hf.regime.heirStab + 15, 0, 100); } }
      if (k === 'hyojoshu') { r.cohesion = clamp(r.cohesion + 10, 0, 100); r.maturity = clamp(r.maturity + 8, 0, 100); Object.keys(sg.wary).forEach(function (w) { sg.wary[w] = Math.max(0, sg.wary[w] - 20); }); sg.hyojo = participants(s).slice().sort(function (a, b) { return (sg.inf[b.id] || 0) - (sg.inf[a.id] || 0); }).slice(0, 6).map(function (p) { return p.id; }); }
      if (k === 'litigation' || k === 'local_gov') { r.local = clamp(r.local + (k === 'local_gov' ? 12 : 8), 0, 100); }
      if (k === 'land_admin') r.maturity = clamp(r.maturity + 6, 0, 100);
      if (k === 'gokenin_ctl') { r.cohesion = clamp(r.cohesion + 6, 0, 100); participants(s).forEach(function (p) { if (s.houses[p.id] && !s.houses[p.id].asFaction) s.houses[p.id].loyalty = clamp(s.houses[p.id].loyalty + 8, 0, 100); else { var x = rel(s, p.id, sh.id); x.value = clamp(x.value + 10, -100, 100); } }); }
      news(s, '【幕府】' + REFORMS[k].label + 'が成った', { type: 'politics', important: true, factions: [sg.shikken ? sg.shikken.holder : sh.id] }); });
  }
  // 執権による人事（幕府の機関の長・守護）
  function shikkenAppoint(s, id, cmd) {
    var sg = ensureShogunate(s), sh = F(s, shogunId(s) || ''); if (!sh) return { ok: false, reason: '幕府がない' };
    var isShogunPlayer = id === sh.id; if (!isShogunPlayer && (!sg.shikken || sg.shikken.holder !== id)) return { ok: false, reason: '人事は将軍家か執権が行う' };
    var p = Pn(s, cmd.person); if (!p || !p.alive) return { ok: false, reason: '人物が不明' };
    var part = participants(s).filter(function (q) { return pMembers(s, q.id).some(function (m) { return m.id === p.id; }); })[0];
    if (!part && p.faction !== sh.id && p.faction !== id) return { ok: false, reason: '幕府の御家人の人物を選ぶこと' };
    if (cmd.office === 'shugo') { p.warriorOffices = (p.warriorOffices || []).concat(['守護']); }
    else { var ins = sh.institutions && sh.institutions[cmd.office]; if (!ins) return { ok: false, reason: 'その機関はまだない' }; ins.head = p.id; }
    if (part) { if (s.houses[part.id] && !s.houses[part.id].asFaction) s.houses[part.id].loyalty = clamp(s.houses[part.id].loyalty + 6, 0, 100); else { var x = rel(s, part.id, sh.id); x.value = clamp(x.value + 8, -100, 100); } if (part.id !== id) addTie(s, part.id, id, 8); }
    var lbl = cmd.office === 'shugo' ? '守護' : INSTITUTIONS[cmd.office].name + 'の' + INSTITUTIONS[cmd.office].head;
    news(s, '【幕府人事】' + p.name + 'を' + lbl + 'に任じた', { type: 'politics', factions: [id] });
    return { ok: true, message: p.name + 'を' + lbl + 'に任じた' };
  }
  // ================================================================ 没官領・奉公と御恩・謀反（v1.3）
  var BLOOD = /父子|兄弟|従兄弟|叔父甥|祖父孫|母子|一族|伯父|甥/;
  function retPersons(s, r) { return r.kind === 'house' ? H(s, r.id).members.map(function (m) { return Pn(s, m); }).filter(Boolean) : factionPersons(s, r.id).concat(F(s, r.id).leader && Pn(s, F(s, r.id).leader) ? [Pn(s, F(s, r.id).leader)] : []); }
  // 主君と血のつながった家（一門）は謀反を起こさない。縁戚（婚姻）は起こしにくい
  function kinship(s, lord, r) {
    var L = F(s, lord); if (!L) return null; var lp = Pn(s, L.leader); var ids = [L.leader, L.heir].filter(Boolean);
    var ps = retPersons(s, r), blood = false, inlaw = false;
    ps.forEach(function (p) { (p.relations || []).forEach(function (x) { if (ids.indexOf(x.person) < 0) return; if (BLOOD.test(x.type)) blood = true; else if (/夫婦|舅|娘婿|乳母/.test(x.type)) inlaw = true; }); });
    if (lp) (lp.relations || []).forEach(function (x) { if (ps.some(function (p) { return p.id === x.person; })) { if (BLOOD.test(x.type)) blood = true; else if (/夫婦|舅|娘婿|乳母/.test(x.type)) inlaw = true; } });
    return blood ? 'blood' : inlaw ? 'inlaw' : null;
  }
  function serviceOf(s, lord, id) { s.service = s.service || {}; s.service[lord] = s.service[lord] || {}; return s.service[lord][id] || 0; }
  function addService(s, lord, id, v) { s.service = s.service || {}; s.service[lord] = s.service[lord] || {}; s.service[lord][id] = Math.max(0, (s.service[lord][id] || 0) + v); }
  // 攻め落とした拠点の国で、敵が持っていた所領は没官領（主君が直轄にするか、御家人に恩賞として与える）
  function conquerHoldings(s, b, old, winF) {
    if (!old || !winF) return; var lord = topLord(s, winF);
    if (Object.keys(s.bases).some(function (k) { var x = s.bases[k]; return x.province === b.province && x.owner === old; })) return; // その家の拠点がまだ残る国は動かない
    var got = [];
    Object.keys(s.holdings).forEach(function (k) { var h = s.holdings[k]; if (h.controller !== old || h.province !== b.province || h.type === '国衙領') return; // 落とした家の所領（国衙領は朝廷の任命で動く）
      h.controller = lord; h.house = null; if (h.rights && h.rights.taxHolder && topLord(s, h.rights.taxHolder) === topLord(s, old)) h.rights.taxHolder = lord;
      h.spoil = { from: old, day: s.day }; got.push(h); });
    if (!got.length) return;
    s.spoils = s.spoils || []; got.forEach(function (h) { s.spoils.push({ holding: h.id, lord: lord, from: old, day: s.day }); });
    news(s, '【没官領】' + PV(s, b.province).name + 'の' + got.map(function (h) { return h.name; }).join('・') + 'を' + fname(s, old).replace(/（.*）/, '') + 'から奪った。' + fname(s, lord).replace(/（.*）/, '') + 'が直轄にするか御家人に与えるかを決める', { type: 'politics', important: lord === s.playerFaction, factions: [lord] });
    if (lord !== s.playerFaction) aiSpoils(s, lord);
  }
  function pendingSpoils(s, lord) { return (s.spoils || []).filter(function (x) { return x.lord === lord && s.holdings[x.holding] && s.holdings[x.holding].controller === lord && !s.holdings[x.holding].house; }); }
  function decideSpoil(s, lord, hid, to) {
    var i = (s.spoils || []).findIndex(function (x) { return x.holding === hid && x.lord === lord; }); if (i < 0) return { ok: false, reason: '処分を待つ没官領ではない' };
    if (!to || to === 'direct') { s.spoils.splice(i, 1); var h = s.holdings[hid]; if (h) delete h.spoil; news(s, fname(s, lord).replace(/（.*）/, '') + 'は' + (h ? h.name : '') + 'を直轄領とした', { type: 'politics', factions: [lord] }); return { ok: true, message: (h ? h.name : '') + 'を直轄領とした' }; }
    var r = lordAct(s, lord, { type: 'grant', holding: hid, target: to }); if (r.ok) { s.spoils.splice(i, 1); delete s.holdings[hid].spoil; addService(s, lord, to, -12); } return r;
  }
  // CPU の主君：奉公の大きい家から恩賞を与える。結束が高く余裕があれば直轄に残す
  function aiSpoils(s, lord) {
    var f = F(s, lord); pendingSpoils(s, lord).forEach(function (x) {
      var rs = retainersOf(s, lord).sort(function (a, b) { return serviceOf(s, lord, b.id) - serviceOf(s, lord, a.id); });
      var keep = !rs.length || (f.regime && f.regime.cohesion > 70 && serviceOf(s, lord, rs[0].id) < 3 && rand(s) < 0.5);
      var res = decideSpoil(s, lord, x.holding, keep ? 'direct' : rs[0].id);
      if (res.ok) aiLog(s, lord, keep ? '没官領を直轄に' : '没官領を恩賞に', keep ? '家臣団はまとまっている' : retName(s, rs[0]) + 'の奉公' + Math.round(serviceOf(s, lord, rs[0].id) + 12), keep ? null : tplFrom(s, REGIME_TPL.reward, { L: pname(s, f.leader), A: advisorOf(s, lord) }));
    });
  }
  // 毎月：恩賞を待つ不満、謀反の兆し・謀反
  var REBEL_TPL = ['{R}は「{L}は奉公に報いぬ」と言い放ち、兵を挙げて{L}に背いた。', '{R}の一族は密かに{E}と通じ、ついに{L}に叛旗を翻した。', '恩賞の沙汰を待ちかねた{R}が、{L}に背いて自立した。'];
  function loyaltyTick(s) {
    Object.keys(s.factions).forEach(function (lord) {
      var L = F(s, lord); if (!L.alive) return; var rs = retainersOf(s, lord); if (!rs.length) return;
      rs.forEach(function (r) {
        var kin = kinship(s, lord, r), sv = serviceOf(s, lord, r.id), loy = retLoyalty(s, r, lord);
        if (sv > 4) retAddLoyalty(s, r, lord, -Math.min(2, sv / 12)); // 奉公に報いられないと不満が積もる
        if (kin === 'blood' && loy < 70) retAddLoyalty(s, r, lord, 70 - loy); // 一門は忠誠を誓って従う
        loy = retLoyalty(s, r, lord); var amb = r.kind === 'house' ? (H(s, r.id).ambition || 40) : (F(s, r.id).ambition || 40);
        var flag = 'unrest_' + r.id;
        if (loy < 35 && kin !== 'blood' && (L.flags[flag] == null || s.day - L.flags[flag] > 360)) { L.flags[flag] = s.day; news(s, '【不穏】' + retName(s, r) + 'に' + L.name.replace(/（.*）/, '') + 'への不満がつのっている（忠誠' + Math.round(loy) + (sv > 4 ? '・恩賞を待っている' : '') + '）', { type: 'politics', important: lord === s.playerFaction, factions: [lord] }); }
        if (kin === 'blood' || loy >= 25 || amb < 40) return;
        var troops = r.kind === 'house' ? houseTroops(s, r.id) : availableBandTroops(s, r.id, null, true);
        var p = (25 - loy) / 100 * (amb / 60) * (kin === 'inlaw' ? 0.3 : 1) * (L.flags.strifeUntil > s.day ? 1.5 : 1) * (troops > campPower(s, lord) * 0.08 ? 1 : 0.3);
        if (rand(s) < p) rebel(s, lord, r);
      });
    });
  }
  function rebel(s, lord, r) {
    var L = F(s, lord), nf = r.kind === 'house' ? houseToFaction(s, r.id) : F(s, r.id); if (!nf) return;
    nf.overlord = null; declareWar(s, nf.id, lord); var en = enemiesOf(s, lord).filter(function (e) { return e !== nf.id; })[0];
    if (en && rand(s) < 0.5) { var x = rel(s, nf.id, en); x.value = clamp(x.value + 30, -100, 100); x.war = false; }
    var t = tplFrom(s, REBEL_TPL, { R: nf.name.replace(/（.*）/, ''), L: (Pn(s, L.leader) || {}).name || L.name, E: en ? fname(s, en).replace(/（.*）/, '') : '敵方' });
    news(s, '【謀反】' + t, { type: 'politics', important: true, factions: [lord, nf.id] }); aiLog(s, nf.id, '謀反', '忠誠' + Math.round(retLoyalty(s, r, lord)) + '・奉公の未報' + Math.round(serviceOf(s, lord, r.id)), t);
    if (lord === s.playerFaction) stop(s, { key: 'rebellion', title: '御家人の謀反', persons: [nf.leader], text: t + '\n恩賞（没官領の給与・新恩給与）・本領安堵・役職で忠誠を保てば防げる。血のつながった一門は背かない。', choices: [] });
  }
  // 幕府の相関図に載せる人々（UI用）
  function bakufuChart(s) {
    var sh = shogunId(s); if (!sh) return null; var f = F(s, sh), ins = f.institutions || {}, sg = ensureShogunate(s);
    var ichimon = factionPersons(s, sh).filter(function (p) { return p.id !== f.leader && !p.captiveOf && (p.relations || []).some(function (x) { return BLOOD.test(x.type) && x.person === f.leader; }); }).map(function (p) { return { name: p.name, id: p.id }; });
    retainersOf(s, sh).forEach(function (r) { if (kinship(s, sh, r) === 'blood') ichimon.push({ name: retName(s, r), id: r.id, loyalty: Math.round(retLoyalty(s, r, sh)) }); });
    var rest = retainersOf(s, sh).filter(function (r) { return kinship(s, sh, r) !== 'blood'; }).map(function (r) { return { id: r.id, name: retName(s, r), inf: sg.inf[r.id] || 0, loyalty: Math.round(retLoyalty(s, r, sh)), kin: kinship(s, sh, r), service: Math.round(serviceOf(s, sh, r.id)) }; }).sort(function (a, b) { return b.inf - a.inf; });
    var shukuro = rest.filter(function (x, i) { return i < 3 && x.inf >= 20; });
    return { shogun: f.leader, shikken: sg.shikken, offices: { monchujo: ins.monchujo ? ins.monchujo.head : null, mandokoro: (ins.mandokoro || ins.kumonjo) ? (ins.mandokoro || ins.kumonjo).head : null, mandokoroName: ins.mandokoro ? '政所別当' : '公文所別当', samurai: ins.samurai_dokoro ? ins.samurai_dokoro.head : null },
      ichimon: ichimon, shukuro: shukuro, gokenin: rest.filter(function (x) { return shukuro.indexOf(x) < 0; }) };
  }
  // ================================================================ 有力御家人の家・将軍の継承と交代・北条一門と得宗家（v1.4）
  var HOUSES2 = { // 既存の人物・武士団を使う（新しく作らない。兵は親の武士団から分ける）
    wada: { name: '和田氏', faction: 'miura', head: 'yoshimori', members: ['yoshimori'], ambition: 65, band: ['band_21', 180, 'sagami', '和田一族'], note: '三浦一族の和田義盛の家。初代侍所別当（史実）' },
    kajiwara: { name: '梶原氏', faction: 'oba', head: 'kagetoki', members: ['kagetoki'], ambition: 60, band: ['band_24', 150, 'sagami', '梶原一族'], note: '鎌倉党の梶原景時の家。石橋山で頼朝を見逃したと伝わり、のち頼朝の側近（史実・伝承）' },
    adachi: { name: '安達氏', faction: 'yoritomo', head: 'morinaga', members: ['morinaga'], ambition: 45, band: null, note: '流人時代から頼朝に仕えた安達盛長の家（史実）' },
  };
  function migrateHouses3(s) {
    if (s.flags.houseModel >= 3) return; s.flags.houseModel = 3;
    Object.keys(HOUSES2).forEach(function (k) { var d = HOUSES2[k]; if (s.houses[k] || !s.persons[d.head]) return;
      var f = F(s, d.faction); var h = s.houses[k] = { id: k, name: d.name, faction: d.faction, lord: d.faction, head: d.head, members: d.members.filter(function (m) { return s.persons[m]; }), ambition: d.ambition, influence: 0, heir: null, money: 400, food: 1200, loyalty: 75, seat: null, note: d.note, rel: {}, cohesion: 65, heirStab: 50 };
      if (d.band && s.bands[d.band[0]]) { var src = s.bands[d.band[0]], n = Math.min(d.band[1], Math.floor(src.strength * 0.4)); src.strength -= n; src.base = Math.max(0, (src.base || src.strength) - n); s.bands['band_' + k] = { id: 'band_' + k, faction: src.faction, house: k, province: d.band[2], name: d.band[3], strength: n, base: n, mobilized: 0, confidence: '推定' }; }
    });
    // 三浦・畠山などの勢力も「家」の一覧に載せる（勢力として表すので人物・兵は重ねない）
    [['miura', '三浦氏'], ['hatakeyama', '畠山氏（秩父党）'], ['chiba', '千葉氏'], ['kazusa', '上総氏']].forEach(function (x) { if (!s.houses[x[0]] && s.factions[x[0]]) s.houses[x[0]] = { id: x[0], name: x[1], faction: x[0], asFaction: x[0], head: s.factions[x[0]].leader, members: [], ambition: s.factions[x[0]].ambition || 50, influence: 0, note: '勢力として扱う家' }; });
  }
  // 家の所属の移り変わり：主家が滅んだ家は、ふさわしい陣営へ移る（梶原の帰順など）
  function houseDrift(s) {
    Object.keys(s.houses).forEach(function (k) { var h = s.houses[k]; if (h.asFaction || !h.head || !alive(s, h.head)) return; var f = F(s, h.faction);
      var joinY = s.factions.yoritomo && s.factions.yoritomo.alive && (s.factions.yoritomo.status !== '雌伏' || (s.factions.yoritomo.flags || {}).bakufu);
      if ((!f || !f.alive || (joinY && h.faction !== 'yoritomo' && topLord(s, h.faction) !== 'yoritomo' && k === 'kajiwara' && provHeld(s, 'yoritomo', 'sagami', true) && rand(s) < 0.15)) && joinY) {
        var old = h.faction; h.faction = 'yoritomo'; h.lord = 'yoritomo'; h.loyalty = 70;
        h.members.forEach(function (m) { var p = Pn(s, m); if (p && p.alive) { p.faction = 'yoritomo'; if (!p.location || !B(s, p.location) || B(s, p.location).owner !== 'yoritomo') p.location = F(s, 'yoritomo').capital; } });
        houseBands(s, k).forEach(function (b) { b.faction = 'yoritomo'; });
        news(s, '【帰順】' + h.name + '（' + pname(s, h.head) + '）は' + (f && f.alive ? fname(s, old) + 'を離れ' : '主家を失い') + '、源頼朝に従った', { type: 'politics', important: true, factions: ['yoritomo'] });
        if (s.shogunate) participants(s).forEach(function (p) { if (p.id !== k && p.id !== 'hojo') addTie(s, p.id, k, -15); }); // 新参の側近は古参に疎まれる
      } else if (h.faction !== 'yoritomo' && f && f.alive) h.lord = topLord(s, h.faction) === 'yoritomo' ? 'yoritomo' : h.faction;
    });
  }
  // ---- 将軍：権威・支持・軍事的な支え・継承の候補
  function shogunPerson(s) { var sh = shogunId(s); return sh ? Pn(s, F(s, sh).leader) : null; }
  function shogunCandidates(s) {
    var sp = shogunPerson(s); if (!sp) return []; var sh = shogunId(s);
    return factionPersons(s, sh).filter(function (p) { return p.id !== sp.id && !p.captiveOf && !p.deposed && (p.relations || []).some(function (r) { return /父子|兄弟/.test(r.type) && (r.person === sp.id || r.person === 'yoritomo'); }); });
  }
  var NURSE = { yoriie: 'hiki', ichiman: 'hiki', sanetomo: 'hojo' }; // 乳母の家（史実：頼家は比企尼の一族、千幡は北条時政の娘・阿波局が乳母）
  function backStrength(s, hid, pid) { // その家が人物を担ぐ強さ（乳母・妻の実家・外祖父は強く、母の実家は弱い）
    var p = Pn(s, pid); if (!p) return 0; var v = (p.nurseHouse || NURSE[pid]) === hid ? 3 : 0;
    pMembers(s, hid).forEach(function (m) { (p.relations || []).concat((m.relations || []).map(function (r) { return { person: r.person === pid ? m.id : null, type: r.type }; })).forEach(function (r) { if (r.person !== m.id) return; v += /舅|娘婿|外孫|祖父孫|乳母/.test(r.type) ? 3 : /母子/.test(r.type) ? 1 : 0; }); });
    return v;
  }
  function childrenOf(s, pid) { return Object.keys(s.persons).filter(function (k) { var q = s.persons[k]; return q.alive && (q.relations || []).some(function (r) { return r.person === pid && /父子/.test(r.type); }) || (Pn(s, pid).relations || []).some(function (r) { return r.person === k && /父子/.test(r.type) && q.alive && (q.born || 0) > (Pn(s, pid).born || 0); }); }); }
  function rivalsOf(s) { var sp = shogunPerson(s); if (!sp) return []; var kids = childrenOf(s, sp.id); return shogunCandidates(s).map(function (p) { return p.id; }).filter(function (c) { return kids.indexOf(c) < 0; }); }
  function backersOf(s, pid, rivals) { // 縁戚・乳母・外戚として人物を支える家（ほかの候補をより強く担ぐ家は除く）
    var sp = shogunPerson(s); if (!rivals && sp && pid === sp.id) { var kids = childrenOf(s, sp.id); return participants(s).filter(function (q) { var v = Math.max.apply(null, [backStrength(s, q.id, pid)].concat(kids.map(function (k) { return backStrength(s, q.id, k); }))); return v > 0 && rivalsOf(s).every(function (r) { return backStrength(s, q.id, r) < v; }); }).map(function (q) { return q.id; }); }
    rivals = rivals || shogunCandidates(s).map(function (p) { return p.id; }).concat(sp ? [sp.id] : []).filter(function (x) { return x !== pid; });
    return participants(s).filter(function (q) { var v = backStrength(s, q.id, pid); return v > 0 && rivals.every(function (r) { return backStrength(s, q.id, r) < v; }); }).map(function (q) { return q.id; });
  }
  function shogunState(s) {
    var sg = ensureShogunate(s), sp = shogunPerson(s); if (!sp) return null; var ps = participants(s), tot = 0, sum = 0, mil = 0;
    ps.forEach(function (p) { var w = sg.inf[p.id] || 0, t = shogunTie(s, p.id); tot += w; sum += w * t; if (t > 20) mil += pTroops(s, p.id); });
    var sh = F(s, shogunId(s)); mil += availableBandTroops(s, sh.id, null);
    if (sg.authority == null || sg.authorityOf !== sp.id) { sg.authorityOf = sp.id; sg.authority = clamp(30 + sp.abilities.politics * 0.4 + (ageOf(s, sp) != null && ageOf(s, sp) < 18 ? -20 : 0) + (sp.id === 'yoritomo' ? 30 : 0), 5, 100); }
    return { person: sp.id, ability: sp.abilities.politics, authority: Math.round(sg.authority), support: tot ? Math.round(sum / tot) : 0, military: Math.round(mil), sick: sg.sick != null && s.day - sg.sick < 120, candidates: shogunCandidates(s).map(function (p) { return p.id; }), backers: backersOf(s, sp.id), crisis: sg.crisis || null, history: sg.history || [] };
  }
  function shogunTick(s) {
    var sg = ensureShogunate(s), st = shogunState(s); if (!st) return; var sp = shogunPerson(s), ps = participants(s);
    sg.authority = clamp(sg.authority + st.support / 15 - (ageOf(s, sp) != null && ageOf(s, sp) < 18 ? 0.8 : 0) - (st.sick ? 2 : 0) + (sp.abilities.politics - 50) / 50, 0, 100);
    if (sp.id !== 'yoritomo' && !st.sick && rand(s) < 0.012) { sg.sick = s.day; news(s, '【将軍】' + sp.name + 'が病に伏し、政務を執れない', { type: 'politics', important: true }); }
    // 将軍の親裁：権威が強く野心のある将軍は、目障りな有力御家人を抑えようとする
    if (sp.id !== 'yoritomo' && sg.authority >= 50 && (sp.ambition || 50) >= 60 && rand(s) < 0.08) {
      var bk = st.backers, tgt = ps.filter(function (p) { return bk.indexOf(p.id) < 0; }).sort(function (a, b) { return (sg.inf[b.id] || 0) - (sg.inf[a.id] || 0); })[0];
      if (tgt) { sg.inf[tgt.id] = (sg.inf[tgt.id] || 0) * 0.8; if (s.houses[tgt.id] && !s.houses[tgt.id].asFaction) s.houses[tgt.id].loyalty = clamp(s.houses[tgt.id].loyalty - 15, 0, 100); else { var x = rel(s, tgt.id, shogunId(s)); x.value = clamp(x.value - 25, -100, 100); }
        var t1 = sp.name + 'は自ら政を執ろうとし、' + pName(s, tgt.id) + 'の権勢を抑えにかかった。御家人たちは将軍の独断を危ぶんでいる'; bkLogRaw(s, shogunId(s), t1, '将軍の権威' + Math.round(sg.authority)); ps.forEach(function (p) { if (bk.indexOf(p.id) < 0) { if (s.houses[p.id] && !s.houses[p.id].asFaction) s.houses[p.id].loyalty = clamp(s.houses[p.id].loyalty - 4, 0, 100); } }); }
    }
    // 将軍交代の政治的な動き
    if (!sg.crisis && st.candidates.length && !(sg.crisisCool != null && s.day - sg.crisisCool < 540) && (st.support < -5 || sg.authority < 25 || st.sick) && sp.id !== 'yoritomo' && rand(s) < 0.35) startCrisis(s, st);
    if (sg.crisis && s.day >= sg.crisis.resolveDay) resolveCrisis(s);
  }
  function bkLogRaw(s, actor, text, reason) { var sg = ensureShogunate(s); sg.log.push({ day: s.day, date: dateStr(s), text: text }); aiLog(s, actor, '幕府政治', reason || '', text); news(s, '【幕府】' + text, { type: 'politics', important: true }); }
  function startCrisis(s, st) {
    var sg = ensureShogunate(s), ps = participants(s), sp = shogunPerson(s);
    var cb = function (id) { return Math.max.apply(null, [0].concat(st.candidates.map(function (c) { return backStrength(s, id, c); }))) * 8; };
    var opp = ps.filter(function (p) { return st.backers.indexOf(p.id) < 0; }).sort(function (a, b) { return ((sg.inf[b.id] || 0) - shogunTie(s, b.id) / 3 + cb(b.id)) - ((sg.inf[a.id] || 0) - shogunTie(s, a.id) / 3 + cb(a.id)); })[0]; if (!opp) return;
    var riv = rivalsOf(s), cands = st.candidates.map(function (c) { return Pn(s, c); }).sort(function (a, b) { return backStrength(s, opp.id, b.id) - backStrength(s, opp.id, a.id) || (riv.indexOf(b.id) >= 0) - (riv.indexOf(a.id) >= 0) || (a.born || 0) - (b.born || 0); }); var cand = cands[0];
    var heirSide = st.candidates.filter(function (c) { return (Pn(s, c).relations || []).some(function (r) { return r.person === sp.id && /父子/.test(r.type); }); })[0];
    sg.crisis = { start: s.day, resolveDay: s.day + 25, shogun: sp.id, candidate: cand.id, leader: opp.id, backers: st.backers.slice(), heirCandidate: heirSide || null, playerSide: null, why: (st.sick ? '将軍の病・' : '') + (st.support < -5 ? '御家人の支持を失う・' : '') + (sg.authority < 25 ? '権威の低下・' : '') + '後継の候補あり' };
    var t = '将軍' + sp.name + 'の進退をめぐり、' + pName(s, opp.id) + 'は' + cand.name + 'を立てようと動き出した。' + (st.backers.length ? st.backers.map(function (b) { return pName(s, b); }).join('・') + 'は将軍を支える構え。' : '');
    bkLogRaw(s, opp.id, t, sg.crisis.why);
    var me = s.playerFaction; if (ps.some(function (p) { return p.id === me; })) stop(s, { key: 'shogun_crisis', title: '将軍の進退をめぐる争い', persons: [sp.id, cand.id], text: t + '\nどちらにつくか。決着はおよそ25日後。', choices: [{ id: 'oppose', label: cand.name + 'を立てる側（' + pName(s, opp.id) + '方）につく' }, { id: 'support', label: '将軍' + sp.name + 'を支える' }, { id: 'neutral', label: '動かない' }] });
  }
  function crisisPower(s, ids) { var sg = ensureShogunate(s); return ids.reduce(function (t, id) { return t + (sg.inf[id] || 0) + pTroops(s, id) / 40; }, 0); }
  function resolveCrisis(s) {
    var sg = ensureShogunate(s), c = sg.crisis; sg.crisis = null; sg.crisisCool = s.day; var sp = Pn(s, c.shogun), sh = F(s, shogunId(s)); if (!sp || !sp.alive || !sh || sh.leader !== sp.id) return;
    var ps = participants(s), opp = [c.leader], sup = c.backers.slice();
    ps.forEach(function (p) { if (p.id === c.leader || sup.indexOf(p.id) >= 0) return; if (p.id === s.playerFaction) { if (c.playerSide === 'oppose') opp.push(p.id); else if (c.playerSide === 'support') sup.push(p.id); return; }
      var tl = tie(s, p.id, c.leader), ts = shogunTie(s, p.id); if (tl > 25 && ts < 30) opp.push(p.id); else if (ts > 40 && tl < 0) sup.push(p.id); });
    var A = crisisPower(s, opp) * (0.85 + rand(s) * 0.3), B = (crisisPower(s, sup) + sg.authority / 4 + availableBandTroops(s, sh.id, null) / 150) * (0.85 + rand(s) * 0.3);
    var kind = A > B * 1.3 ? 'depose' : A > B ? 'limit' : B > A * 1.3 ? 'keep' : 'war', leaderName = pName(s, c.leader), cand = Pn(s, c.candidate), t;
    sg.history = sg.history || [];
    if (kind === 'depose' && cand && cand.alive) {
      sh.leader = cand.id; sh.heir = null; sp.status = '前将軍（出家・幽閉）'; sp.deposed = s.day; sp.location = 'hirugakojima'; cand.status = '将軍'; sg.authorityOf = null; sg.sick = null;
      sg.inf[c.leader] = (sg.inf[c.leader] || 0) + 15; if (s.houses[c.leader]) s.houses[c.leader].favor = Math.min(30, (s.houses[c.leader].favor || 0) + 15);
      var fallen = c.backers.filter(function (b) { return opp.indexOf(b) < 0; });
      fallen.forEach(function (b) { ruinHouse(s, b, c.leader); });
      t = leaderName + 'らは将軍' + sp.name + 'を出家させて伊豆に幽閉し、' + cand.name + 'を新たな将軍に立てた。' + (fallen.length ? fallen.map(function (b) { return pName(s, b); }).join('・') + 'は討たれ、没落した。' : '');
    } else if (kind === 'limit') { sg.authority = clamp(sg.authority - 25, 0, 100); sg.inf[c.leader] = (sg.inf[c.leader] || 0) + 8; t = '将軍' + sp.name + 'は地位を保ったが、訴訟の親裁を止められ、' + leaderName + 'ら宿老の合議に政を委ねることになった。'; }
    else if (kind === 'keep') { sg.authority = clamp(sg.authority + 15, 0, 100); sg.inf[c.leader] = (sg.inf[c.leader] || 0) * 0.5; sg.impeached = sg.impeached || {}; sg.impeached[c.leader] = s.day;
      var shf = F(s, shogunId(s)); if (shf.institutions) Object.keys(shf.institutions).forEach(function (k) { if (pMembers(s, c.leader).some(function (m) { return m.id === shf.institutions[k].head; })) shf.institutions[k].head = null; });
      if (sg.shikken && sg.shikken.holder === c.leader) sg.shikken = null;
      t = '将軍' + sp.name + 'と' + (c.backers.map(function (b) { return pName(s, b); }).join('・') || '近臣') + 'は' + leaderName + 'の企てを退けた。' + leaderName + 'は役を解かれ、勢いを失った。'; }
    else { var b0 = c.backers[0]; t = '将軍の進退をめぐる争いは決着せず、' + leaderName + 'と' + (b0 ? pName(s, b0) : '将軍の近臣') + 'が兵を交えることになった。'; if (b0) { var lf = s.houses[c.leader] && !s.houses[c.leader].asFaction ? houseToFaction(s, c.leader) : F(s, c.leader), bf = s.houses[b0] && !s.houses[b0].asFaction ? houseToFaction(s, b0) : F(s, b0); if (lf && bf) declareWar(s, lf.id, bf.id); } }
    sg.history.push({ day: s.day, date: dateStr(s), kind: kind, from: sp.id, to: kind === 'depose' && cand ? cand.id : sp.id, by: c.leader, opp: opp, sup: sup });
    bkLogRaw(s, c.leader, t, '擁立側' + Math.round(A) + '対将軍側' + Math.round(B));
    if (ps.some(function (p) { return p.id === s.playerFaction; })) stop(s, { key: 'shogun_crisis_end', title: { depose: '将軍の廃位', limit: '将軍の権限の制限', keep: '将軍の権力の維持', war: '幕府内の内乱' }[kind], persons: [sp.id], text: t, choices: [] });
  }
  function ruinHouse(s, id, by) { // 比企能員の変の型：当主は討たれ、所領は没官領として幕府へ
    var sg = ensureShogunate(s), h = s.houses[id] && !s.houses[id].asFaction ? s.houses[id] : null, sh = shogunId(s);
    var head = h ? Pn(s, h.head) : Pn(s, (F(s, id) || {}).leader); if (head && head.alive && rand(s) < 0.7) killPerson(s, head, 'battle', '政変で討たれた');
    Object.keys(s.holdings).forEach(function (k) { var x = s.holdings[k]; if ((h && x.house === id) || (!h && x.controller === id)) { x.house = null; x.controller = sh; s.spoils = s.spoils || []; s.spoils.push({ holding: k, lord: sh, from: id, day: s.day }); } });
    if (h) { h.loyalty = 0; h.influence = 0; h.ruined = s.day; houseBands(s, id).forEach(function (b) { b.strength = Math.round(b.strength * 0.2); }); } else if (F(s, id)) { F(s, id).overlord = null; declareWar(s, sh, id); }
    sg.inf[id] = 0;
  }
  // ---- 北条一門：家督（のちの得宗家）と分家。分家は人物の誕生と成人に応じて現れる
  var HOJO_BRANCHES = [
    { id: 'hojo_nagoe', name: '名越流北条氏', founder: 'tomotoki', ambition: 65 }, { id: 'hojo_gokurakuji', name: '極楽寺流北条氏', founder: 'shigetoki', ambition: 45 },
    { id: 'hojo_masamura', name: '政村流北条氏', founder: 'masamura', ambition: 50 }, { id: 'hojo_kanazawa', name: '金沢流北条氏', founder: 'saneyasu', ambition: 45 },
  ];
  BIRTHS.push(
    { id: 'tomotoki', date: [1193, 1, 1], parents: ['yoshitoki'], house: 'hojo', p: { name: '北条朝時', kana: 'ほうじょうともとき', born: 1193, died: 1245, faction: null, status: '義時の子（名越流の祖）', abilities: { command: 70, valor: 70, politics: 65, intellect: 60, diplomacy: 50 }, personality: '剛毅', ambition: 70, loyalty: 70, rel: [['yoshitoki', '父子（相手側）']] }, note: '誕生月日は不詳' },
    { id: 'shigetoki', date: [1198, 6, 6], parents: ['yoshitoki'], house: 'hojo', p: { name: '北条重時', kana: 'ほうじょうしげとき', born: 1198, died: 1261, faction: null, status: '義時の子（極楽寺流の祖）', abilities: { command: 60, valor: 55, politics: 80, intellect: 80, diplomacy: 70 }, personality: '謹厳', ambition: 45, loyalty: 85, rel: [['yoshitoki', '父子（相手側）']] } },
    { id: 'masamura', date: [1205, 6, 22], parents: ['yoshitoki'], house: 'hojo', p: { name: '北条政村', kana: 'ほうじょうまさむら', born: 1205, died: 1273, faction: null, status: '義時の子（政村流の祖）', abilities: { command: 50, valor: 45, politics: 80, intellect: 80, diplomacy: 70 }, personality: '温厚', ambition: 50, loyalty: 80, rel: [['yoshitoki', '父子（相手側）']] } },
    { id: 'saneyasu', date: [1208, 1, 1], parents: ['yoshitoki'], house: 'hojo', p: { name: '北条実泰', kana: 'ほうじょうさねやす', born: 1208, died: 1263, faction: null, status: '義時の子（金沢流の祖）', abilities: { command: 45, valor: 45, politics: 60, intellect: 70, diplomacy: 55 }, personality: '学問好き', ambition: 40, loyalty: 80, rel: [['yoshitoki', '父子（相手側）']] }, note: '誕生月日は不詳' },
    { id: 'ichiman', date: [1198, 1, 1], parents: ['yoriie'], requires: 'wakasa', p: { name: '一幡', kana: 'いちまん', born: 1198, died: 1203, faction: 'yoritomo', status: '頼家の長子（母は比企能員の娘）', abilities: { command: 10, valor: 10, politics: 10, intellect: 20, diplomacy: 10 }, personality: '幼少', ambition: 0, loyalty: 100, rel: [['yoriie', '父子（相手側）'], ['hiki_yoshikazu', '外孫（相手側）']] }, note: '誕生月日は不詳。比企氏の外孫' }
  );
  function hojoHouseId(s) { var h = s.houses.hojo; return h ? (h.asFaction || 'hojo') : null; }
  function clanTick(s) {
    var h = s.houses.hojo; if (!h) return; var c = s.hojoClan = s.hojoClan || { level: 0, miuchi: [], kanrei: null, branches: [] };
    // 分家の成立：祖が18歳になり、家督（嫡流）とは別の家を立てる
    HOJO_BRANCHES.forEach(function (b) { if (s.houses[b.id]) return; var p = Pn(s, b.founder); if (!p || !p.alive || ageOf(s, p) == null || ageOf(s, p) < 18) return; if (h.head === p.id || (h.asFaction && F(s, h.asFaction) && F(s, h.asFaction).leader === p.id)) return;
      var hf = h.asFaction ? F(s, h.asFaction) : null, fac = hf ? hf.id : h.faction, lord = shogunId(s) || h.lord || 'yoritomo';
      var nh = s.houses[b.id] = { id: b.id, name: b.name, faction: fac, lord: hf ? fac : lord, parent: 'hojo', head: p.id, members: [p.id], ambition: b.ambition, influence: 0, heir: null, money: 200, food: 1000, loyalty: 70, seat: null, note: '北条氏の分家（' + p.name + 'を祖とする）', rel: {}, cohesion: 60, heirStab: 40, founded: s.day };
      h.members = h.members.filter(function (m) { return m !== p.id; });
      var src = houseBands(s, 'hojo')[0] || Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (x) { return hf && x.faction === hf.id; })[0];
      if (src) { var n = Math.floor(src.strength * 0.15); src.strength -= n; src.base = Math.max(0, (src.base || 0) - n); s.bands['band_' + b.id] = { id: 'band_' + b.id, faction: src.faction, house: b.id, province: src.province, name: b.name + 'の郎党', strength: n, base: n, mobilized: 0, confidence: 'ゲーム設定' }; }
      if (s.shogunate) { addTie(s, b.id, hojoHouseId(s), 30); } c.branches.push(b.id);
      news(s, '【分家】' + p.name + 'が' + b.name + 'を立てた。北条一門は一つの意思を持つ集団ではなくなっていく', { type: 'politics', important: true });
    });
    // 嫡流の家督（得宗）の性格は段階的に形づくられる
    var sg = s.shogunate, hid = hojoHouseId(s), holdsShikken = sg && sg.shikken && sg.shikken.holder === hid;
    if (s.date.y >= 1200) c.level = clamp(c.level + 0.12 + (holdsShikken ? 0.25 : 0) + (s.date.y >= 1224 ? 0.15 : 0) + c.branches.length * 0.03, 0, 100);
    if (c.level >= 40 && c.miuchi.length < 3) { var MI = [['taira_moritsuna', '平盛綱', '得宗家の家令（史実）'], ['bito_kagetsuna', '尾藤景綱', '得宗家の家令（史実）'], ['suwa_morishige', '諏訪盛重', '得宗家の御内人（史実）']]; var m = MI[c.miuchi.length];
      if (!s.persons[m[0]]) s.persons[m[0]] = { id: m[0], name: m[1], kana: '', born: null, died: null, birthConfidence: '要確認', faction: hid, location: F(s, hid) ? F(s, hid).capital : null, status: '御内人', rank: '', courtOffices: [], warriorOffices: [], abilities: { command: 50, valor: 50, politics: 65, intellect: 60, diplomacy: 50 }, abilitiesConfidence: 'ゲーム設定', personality: '忠勤', ambition: 55, loyalty: 90, alive: true, health: 100, note: m[2] + '。生没年は要確認', relations: [], naturalDeath: null, captiveOf: null };
      c.miuchi.push({ person: m[0], loyalty: 85, influence: 3, troops: 60, wealth: 100, ambition: 55, kin: 1 }); news(s, '【御内人】' + m[1] + 'が北条氏の家督に直接仕える御内人として重きをなしはじめた', { type: 'politics' }); }
    c.miuchi.forEach(function (x) { x.influence = clamp(x.influence + c.level / 400 + (x.ambition - 50) / 400, 0, 60); x.wealth += 5;
      if (sg && sg.shikken && sg.shikken.holder !== hid && x.influence > 15 && rand(s) < 0.05) { addTie(s, hid, sg.shikken.holder, -6); news(s, '【御内人】' + pname(s, x.person) + 'ら御内人は、執権を出す' + pName(s, sg.shikken.holder) + 'と張り合っている', { type: 'politics' }); } });
    // 執権の交代：執権が世を去ると、北条一門の中から後任が選ばれる。得宗とは限らない
    if (sg && sg.shikken && !canLead(Pn(s, sg.shikken.person)) && [hid].concat(c.branches).indexOf(sg.shikken.holder) >= 0) {
      var cands = [hid].concat(c.branches).filter(function (id) { var x = s.houses[id] || {}; return !x.ruined; }).map(function (id) { var hp = id === hid ? Pn(s, (F(s, hid) && s.houses.hojo.asFaction) ? F(s, hid).leader : s.houses.hojo.head) : Pn(s, s.houses[id].head); return hp && hp.alive && !hp.captiveOf && (ageOf(s, hp) == null || ageOf(s, hp) >= 18) ? { id: id, p: hp, sc: (sg.inf[id] || 0) + hp.abilities.politics / 2 + (id === hid ? c.level / 3 : (s.houses[id].ambition || 50) / 5) + rand(s) * 15 } : null; }).filter(Boolean).sort(function (a, b) { return b.sc - a.sc; });
      var prev = pname(s, sg.shikken.person);
      if (cands.length) { var w = cands[0]; sg.shikken = { holder: w.id, person: w.p.id, since: s.day, date: dateStr(s) }; w.p.warriorOffices = (w.p.warriorOffices || []).concat(['執権']);
        var t2 = '執権' + prev + 'の死後、' + w.p.name + '（' + pName(s, w.id) + '）が執権を継いだ。' + (w.id !== hid ? '家督（' + (c.level >= 30 ? '得宗' : '嫡流') + '）の' + pname(s, cands.filter(function (x) { return x.id === hid; }).map(function (x) { return x.p.id; })[0] || '') + 'とは別の人である。' : '');
        if (cands[1] && cands[1].sc > w.sc * 0.85) { addTie(s, cands[1].id, w.id, -20); t2 += cands[1].p.name + '（' + pName(s, cands[1].id) + '）はこの決定に不満を抱いた。'; }
        bkLogRaw(s, w.id, t2, '一門の中での影響力と器量'); } else sg.shikken = null;
    }
    // 一門の内部：分家は得宗家と協力も反発もする
    c.branches.forEach(function (bid) { var b = s.houses[bid]; if (!b || !sg) return; var t = tie(s, bid, hid), amb = b.ambition || 50;
      if (amb > 60 && (sg.inf[bid] || 0) > (sg.inf[hid] || 0) * 0.6 && rand(s) < 0.1) { addTie(s, bid, hid, -8); news(s, '【北条一門】' + b.name + 'は家督（' + (c.level >= 30 ? '得宗' : '嫡流') + '）に対抗する構えを見せている', { type: 'politics' }); }
      else if (t < 50) addTie(s, bid, hid, 0.5); });
  }
  function clanStatus(s) {
    var h = s.houses.hojo; if (!h) return null; var c = s.hojoClan || { level: 0, miuchi: [], branches: [] }, sg = s.shogunate, hid = hojoHouseId(s);
    var head = h.asFaction && F(s, h.asFaction) ? F(s, h.asFaction).leader : h.head;
    return { title: c.level >= 30 ? '得宗' : '北条氏の家督（嫡流）', head: head, level: Math.round(c.level), shikken: sg && sg.shikken ? sg.shikken : null, shikkenIsTokuso: !!(sg && sg.shikken && sg.shikken.person === head),
      branches: c.branches.map(function (b) { var x = s.houses[b]; return { id: b, name: x.name, head: x.head, inf: sg ? Math.round(sg.inf[b] || 0) : 0, tie: sg ? Math.round(tie(s, b, hid)) : 0 }; }),
      miuchi: c.miuchi.map(function (m) { return { name: pname(s, m.person), influence: Math.round(m.influence), loyalty: m.loyalty, troops: m.troops }; }) };
  }
  // ================================================================ 操作人物・世代交代・権力闘争（v1.5）
  // 家（勢力・家）／家督（勢力の当主 leader）／役職（執権など）／操作人物（s.player.person）を別々に持つ
  function canLead(p) { return !!(p && p.alive && !p.captiveOf && !p.confined && !p.exiled && !p.retired); }
  function ensurePolitics(s) {
    ensurePlayer(s); var pl = s.player;
    if (pl.person === undefined) { var f = F(s, s.playerFaction); pl.person = f ? f.leader : null; pl.status = '在任'; }
    pl.personHistory = pl.personHistory || [];
    if (!s.politics) s.politics = { grudge: {}, why: {}, cabals: [], intel: {}, guard: {}, records: { heads: [], offices: [], falls: [] }, nextId: 1, cool: {}, lastShikken: null, favor: {} };
    return s.politics;
  }
  function recHead(s, fid, from, to, why) { var P = ensurePolitics(s); P.records.heads.push({ day: s.day, date: dateStr(s), faction: fid, from: from, to: to, why: why }); if (P.records.heads.length > 200) P.records.heads.shift(); }
  function recFall(s, pid, kind, by, why) { var P = ensurePolitics(s); P.records.falls.push({ day: s.day, date: dateStr(s), person: pid, kind: kind, by: by, why: why }); if (P.records.falls.length > 200) P.records.falls.shift(); }
  function purseOf(s, id) { return s.houses[id] && !s.houses[id].asFaction ? s.houses[id] : F(s, id); }
  function repOf(s, id) { // その家・勢力を代表して権力を握る人物（プレイヤーの勢力なら操作人物）
    if (id === s.playerFaction && s.player && s.player.person && alive(s, s.player.person)) return Pn(s, s.player.person);
    var h = s.houses[id]; if (h && !h.asFaction) return Pn(s, h.head); var f = F(s, id); return f ? Pn(s, f.leader) : null;
  }
  // ---- 不満（家 → 家）
  function grudge(s, from, to) { var P = ensurePolitics(s); return P.grudge[from + '>' + to] || 0; }
  function addGrudge(s, from, to, v, why) { if (!from || !to || from === to) return; var P = ensurePolitics(s), k = from + '>' + to; P.grudge[k] = clamp((P.grudge[k] || 0) + v, 0, 100); if (v > 0 && why) P.why[k] = why; if (P.grudge[k] < 1) { delete P.grudge[k]; delete P.why[k]; } }
  function grudgeAll(s, to, v, why, except) { participants(s).forEach(function (p) { if (p.id !== to && (!except || except.indexOf(p.id) < 0)) addGrudge(s, p.id, to, v, why); }); }
  function supportFrom(s, from, to) { return Math.round(clamp(tie(s, from, to) * 0.6 - grudge(s, from, to), -100, 100)); }
  function isIchimon(s, id) { if (!s.houses.hojo) return false; var hid = hojoHouseId(s); return id === hid || (s.houses[id] && s.houses[id].parent === 'hojo') || ((s.hojoClan || {}).branches || []).indexOf(id) >= 0; }
  // ---- 既存の行動に不満・満足を結びつける（プレイヤーにもCPUにも同じように働く）
  var bkAct0 = bkAct;
  bkAct = function (s, actor, act, target, extra) {
    if (playerBlocked(s, actor)) return { ok: false, reason: playerBlocked(s, actor) };
    var r = bkAct0(s, actor, act, target, extra); if (!r || !r.ok) return r; var sg = s.shogunate;
    if (act === 'impeach' && sg.impeached && sg.impeached[target] === s.day) { addGrudge(s, target, actor, 45, '訴えで幕府を追われた'); grudgeAll(s, actor, 5, '有力御家人を退けた強引さ', [target]); }
    else if (act === 'attack') { addGrudge(s, target, actor, 60, '討伐を受けた'); grudgeAll(s, actor, 6, '御家人を武力で排除しようとした', [target]); }
    else if (act === 'isolate') { addGrudge(s, target, actor, 25, '孤立させられた'); }
    else if (act === 'exploit') grudgeAll(s, actor, 3, '御家人同士を争わせた');
    else if (act === 'marriage') addGrudge(s, target, actor, -30);
    else if (act === 'ally') addGrudge(s, target, actor, -12);
    return r;
  };
  var lordAct0 = lordAct;
  lordAct = function (s, fid, cmd) {
    var r = lordAct0(s, fid, cmd); if (!r || !r.ok || !cmd.target) return r; var P = ensurePolitics(s);
    var others = retainersOf(s, fid).map(function (x) { return x.id; }).filter(function (x) { return x !== cmd.target; });
    if (cmd.type === 'confiscate') { addGrudge(s, cmd.target, fid, 45, '所領を没収された'); others.forEach(function (o) { addGrudge(s, o, fid, 8, '所領の没収（次は我が身）'); }); }
    else if (cmd.type === 'ando') addGrudge(s, cmd.target, fid, -20);
    else if (cmd.type === 'grant') { addGrudge(s, cmd.target, fid, -15); var fk = fid + '>' + cmd.target, fv = P.favor[fk] = (P.favor[fk] || []).filter(function (d) { return s.day - d < 730; }).concat([s.day]);
      if (fv.length >= 3) others.forEach(function (o) { addGrudge(s, o, fid, 4, pName(s, cmd.target) + 'ばかりが優遇される'); }); }
    return r;
  };
  var decideSpoil0 = decideSpoil;
  decideSpoil = function (s, lord, hid, to) { var r = decideSpoil0(s, lord, hid, to); if (r && r.ok && (!to || to === 'direct')) retainersOf(s, lord).forEach(function (x) { addGrudge(s, x.id, lord, 3, '恩賞を直轄に取り込んだ'); }); return r; };
  var shikkenAppoint0 = shikkenAppoint;
  shikkenAppoint = function (s, id, cmd) {
    if (playerBlocked(s, id)) return { ok: false, reason: playerBlocked(s, id) };
    var r = shikkenAppoint0(s, id, cmd); if (!r || !r.ok) return r; var part = participants(s).filter(function (q) { return pMembers(s, q.id).some(function (m) { return m.id === cmd.person; }); })[0];
    if (part && (part.id === id || (isIchimon(s, part.id) && isIchimon(s, id)))) participants(s).forEach(function (p) { if (!isIchimon(s, p.id) && p.id !== id) addGrudge(s, p.id, id, 5, '役職を一門で固める'); });
    else if (part) addGrudge(s, part.id, id, -15);
    return r;
  };
  var startReform0 = startReform;
  startReform = function (s, id, kind, extra) { if (playerBlocked(s, id)) return { ok: false, reason: playerBlocked(s, id) }; var r = startReform0(s, id, kind, extra); if (r && r.ok) { var hy = s.shogunate.reforms.hyojo; if (!(hy && hy.done) && kind !== 'hyojo') grudgeAll(s, id, 3, '合議をへずに重要な決定を強行した'); } return r; };
  // ---- 政治情勢（数値と文章）。情報は諜報の度合いで不確かになる
  function politicalStatus(s, fid) {
    var sg = s.shogunate; if (!sg || !participants(s).some(function (p) { return p.id === fid; })) return null; var P = ensurePolitics(s), ps = participants(s);
    var avg = function (arr) { var w = 0, t = 0; arr.forEach(function (p) { var ww = (sg.inf[p.id] || 0) + 5; w += ww; t += ww * supportFrom(s, p.id, fid); }); return w ? Math.round(t / w) : null; };
    var gk = ps.filter(function (p) { return p.id !== fid && !isIchimon(s, p.id); }), ic = ps.filter(function (p) { return p.id !== fid && isIchimon(s, p.id); });
    var f = F(s, fid), rep = repOf(s, fid), cab = P.cabals.filter(function (c) { return c.target === fid; });
    var risk = cab.reduce(function (m, c) { return Math.max(m, c.stage * 20 + c.hostility / 5); }, 0), kn = cab.reduce(function (m, c) { return Math.max(m, c.known); }, 0);
    var tot = ps.reduce(function (t, p) { return t + (sg.inf[p.id] || 0); }, 0) || 1;
    return { person: rep ? rep.id : null, head: f ? f.leader : (s.houses[fid] || {}).head, gokenin: avg(gk), ichimon: avg(ic), shogun: Math.round(shogunTie(s, fid)), court: f ? Math.round(courtSupport(s, fid) * 100) : null,
      military: Math.round(pTroops(s, fid)), money: Math.round((purseOf(s, fid) || {}).money || 0), influence: Math.round(sg.inf[fid] || 0), share: Math.round((sg.inf[fid] || 0) / tot * 100), legitimacy: f ? Math.round(f.legitimacy || 0) : 40,
      intel: Math.round(P.intel[fid] || 0), guard: Math.round(P.guard[fid] || 0),
      danger: fid === s.playerFaction ? (kn < 25 ? (risk > 0 ? '不明（諜報が足りない）' : '目立った兆しはない') : risk >= 75 ? '非常に高い' : risk >= 50 ? '高い' : risk >= 30 ? 'やや高い' : '低い') : null,
      complaints: ps.filter(function (p) { return grudge(s, p.id, fid) >= 15; }).map(function (p) { return { id: p.id, v: Math.round(grudge(s, p.id, fid)), why: P.why[p.id + '>' + fid] || '' }; }).sort(function (a, b) { return b.v - a.v; }) };
  }
  function cabalView(s, c) { // プレイヤーに見える反対派の姿
    var k = c.known, lead = k >= 55 ? pName(s, c.leader) : null;
    return { id: c.id, known: Math.round(k), stage: k >= 30 ? c.stage : null, goal: k >= 45 ? c.goal : null, leader: lead, members: k >= 70 ? c.members.map(function (m) { return pName(s, m); }) : null, size: k >= 40 ? (k >= 70 ? c.members.length : (c.members.length <= 2 ? '2家ほど' : '数家')) : null,
      hostility: k >= 60 ? Math.round(c.hostility) : null, cohesion: k >= 60 ? Math.round(c.cohesion) : null, power: k >= 60 ? Math.round(c.power) : null,
      text: k < 25 ? '御家人の間に不穏な噂がある。誰が動いているかは分からない' : k < 55 ? '有力者のあいだで会合が重ねられているらしい（' + (c.members.length <= 2 ? '少数' : '数家') + '）' : pName(s, c.leader) + 'を中心とする反対派（' + (k >= 70 ? c.members.length + '家' : '数家') + '）。目的：' + (k >= 45 ? c.goal : '不明'),
      demand: c.demand || null };
  }
  // ---- 派閥（反対派）の形成と権力闘争の段階
  function cabalPower(s, ids) { var sg = s.shogunate; return ids.reduce(function (t, id) { return t + (sg.inf[id] || 0) + pTroops(s, id) / 40; }, 0); }
  function targetPower(s, T) { var sg = s.shogunate, P = ensurePolitics(s); return (sg.inf[T] || 0) + pTroops(s, T) / 40 + (P.guard[T] || 0) / 3 + participants(s).filter(function (p) { return p.id !== T && supportFrom(s, p.id, T) > 30; }).reduce(function (t, p) { return t + (sg.inf[p.id] || 0) * 0.5; }, 0); }
  function cabalTick(s) {
    var sg = s.shogunate, P = ensurePolitics(s), ps = participants(s); if (ps.length < 3) return;
    var tgts = ps.slice().sort(function (a, b) { return (sg.inf[b.id] || 0) - (sg.inf[a.id] || 0); }).slice(0, 2).map(function (p) { return p.id; });
    if (ps.some(function (p) { return p.id === s.playerFaction; }) && tgts.indexOf(s.playerFaction) < 0) tgts.push(s.playerFaction);
    if (sg.shikken && tgts.indexOf(sg.shikken.holder) < 0 && ps.some(function (p) { return p.id === sg.shikken.holder; })) tgts.push(sg.shikken.holder);
    P.cabals = P.cabals.filter(function (c) { return ps.some(function (p) { return p.id === c.target; }) && repOf(s, c.target) && canLead(repOf(s, c.target)); });
    tgts.forEach(function (T) {
      var score = function (id) { return grudge(s, id, T) - tie(s, id, T) / 2; };
      var opp = ps.filter(function (p) { return p.id !== T && !(isIchimon(s, T) && isIchimon(s, p.id) && grudge(s, p.id, T) < 35) && score(p.id) >= 30; }).map(function (p) { return p.id; });
      var c = P.cabals.filter(function (x) { return x.target === T; })[0];
      if (!c) { if (opp.length >= 2 || (opp.length === 1 && (sg.inf[opp[0]] || 0) > (sg.inf[T] || 0) * 0.8)) { c = { id: 'cb' + (P.nextId++), target: T, members: opp.slice(), stage: 1, formed: s.day, known: 0, history: [{ day: s.day, date: dateStr(s), text: '結成：' + opp.map(function (o) { return pName(s, o); }).join('・') }] }; P.cabals.push(c); aiLog(s, opp[0], '反対派の結成', pName(s, T) + 'への不満', pName(s, T) + 'の専横を許してはならぬ、と語り合った'); } else return; }
      else { c.members.filter(function (m) { return opp.indexOf(m) < 0 && score(m) < 15; }).forEach(function (m) { c.history.push({ day: s.day, date: dateStr(s), text: '離反：' + pName(s, m) }); });
        c.members = c.members.filter(function (m) { return opp.indexOf(m) >= 0 || score(m) >= 15; }); opp.forEach(function (o) { if (c.members.indexOf(o) < 0) { c.members.push(o); c.history.push({ day: s.day, date: dateStr(s), text: '参加：' + pName(s, o) }); } }); }
      if (!c.members.length) { P.cabals.splice(P.cabals.indexOf(c), 1); return; }
      c.leader = c.members.slice().sort(function (a, b) { return (sg.inf[b] || 0) - (sg.inf[a] || 0); })[0];
      c.hostility = c.members.reduce(function (t, m) { return t + score(m); }, 0) / c.members.length;
      c.cohesion = clamp(40 + c.members.reduce(function (t, m) { return t + c.members.reduce(function (u, n) { return u + (m !== n ? tie(s, m, n) : 0); }, 0); }, 0) / Math.max(1, c.members.length * (c.members.length - 1)) / 2, 0, 100);
      c.power = cabalPower(s, c.members); var ratio = c.power / Math.max(1, targetPower(s, T));
      c.goal = sg.shikken && sg.shikken.holder === T ? '執権の退陣' : (c.members.some(function (m) { return isIchimon(s, m); }) && isIchimon(s, T) && F(s, T) && repOf(s, T) && F(s, T).leader === repOf(s, T).id) ? '家督の交代' : c.members.some(function (m) { return /没収/.test(P.why[m + '>' + T] || ''); }) ? '所領の回復' : '排除';
      // 諜報：察知の度合い（不満の大きい家ほど口が軽い、結束が弱いほど漏れる）
      if (T === s.playerFaction) c.known = clamp(c.known + (P.intel[T] || 0) / 8 + (100 - c.cohesion) / 25 + (c.stage >= 2 ? 6 : 0), 0, 100);
      var leadP = repOf(s, c.leader), amb = leadP ? (leadP.ambition || 50) : 50;
      // 段階を進める
      if (c.stage === 1 && c.hostility > 35) { c.stage = 2; c.history.push({ day: s.day, date: dateStr(s), text: '政治的な対立へ' }); sg.inf[T] = Math.max(0, (sg.inf[T] || 0) - 2); if (T === s.playerFaction) c.known = Math.max(c.known, 30); bkLogRaw(s, c.leader, pName(s, c.leader) + 'らは評定の場で' + pName(s, T) + 'の政に異を唱えた', '不満' + Math.round(c.hostility)); }
      else if (c.stage === 2 && c.members.length >= 2 && ratio > 0.6) { c.stage = 3; c.demand = { day: s.day, goal: c.goal }; c.history.push({ day: s.day, date: dateStr(s), text: '要求を突きつける：' + c.goal }); demandOf(s, c, ratio); }
      var calm = P.lastCoup && P.lastCoup[T] != null && s.day - P.lastCoup[T] < 540; // 政変の直後は世が落ち着くまで次は起きにくい
      if (calm) {} else if (c.stage === 3 && c.refused && ratio > 0.9 && c.hostility > 45 && s.day - c.refused > 25) executeCabal(s, c, ratio, false);
      else if (c.stage >= 2 && c.hostility > 70 && amb > 65 && rand(s) < 0.06) executeCabal(s, c, ratio, true); // 急な政変
      if (c.stage >= 2 && T !== s.playerFaction) cpuDefend(s, c, ratio);
    });
  }
  function demandOf(s, c, ratio) {
    var T = c.target, t = pName(s, c.leader) + 'らは' + pName(s, T) + 'に「' + c.goal + '」を求めて圧力をかけてきた。';
    bkLogRaw(s, c.leader, t, '反対派の力' + Math.round(c.power) + '・比' + ratio.toFixed(2));
    if (T === s.playerFaction) { c.known = Math.max(c.known, 60);
      stop(s, { key: 'cabal_demand', cabal: c.id, title: '反対派の要求：' + c.goal, persons: [repOf(s, c.leader) ? repOf(s, c.leader).id : null].filter(Boolean), text: t + '\n受け入れれば対立は和らぐが、要求に応じた分だけ失う。拒めば、反対派は実力に訴えるかもしれない（力の比 ' + ratio.toFixed(2) + '）。',
        choices: [{ id: 'accept', label: '要求を受け入れる（妥協）' }, { id: 'refuse', label: '拒む' }, { id: 'divide', label: '拒み、切り崩しを図る（300貫）' }, { id: 'strike', label: '先手を打って首謀者を除く' }] });
    } else if (ratio > 1.2 || rand(s) < 0.3) compromise(s, c); else c.refused = s.day;
  }
  function compromise(s, c) {
    var T = c.target, sg = s.shogunate, P = ensurePolitics(s), what;
    if (c.goal === '執権の退陣' && sg.shikken && sg.shikken.holder === T) { sg.shikken = null; what = '執権を退いた'; }
    else if (c.goal === '所領の回復') { var pr = purseOf(s, T), pay = Math.min(pr.money || 0, 300); pr.money -= pay; c.members.forEach(function (m) { var q = purseOf(s, m); if (q) q.money = (q.money || 0) + Math.round(pay / c.members.length); }); what = '償いとして' + pay + '貫を分け与えた'; }
    else if (c.goal === '家督の交代') { var f = F(s, T), cand = f ? factionPersons(s, T).filter(function (p) { return canLead(p) && p.id !== f.leader && (ageOf(s, p) == null || ageOf(s, p) >= 15); }).sort(function (a, b) { return heirScore(s, f, b) - heirScore(s, f, a); })[0] : null;
      if (cand) { var old = f.leader; f.leader = cand.id; recHead(s, T, old, cand.id, '一門の要求による家督の交代'); what = '家督を' + cand.name + 'に譲った'; } else { sg.inf[T] = (sg.inf[T] || 0) * 0.75; what = '一門に政の一部を委ねた'; } }
    else { sg.inf[T] = (sg.inf[T] || 0) * 0.75; var shf = F(s, shogunId(s)); if (shf && shf.institutions) Object.keys(shf.institutions).some(function (k) { if (pMembers(s, T).some(function (m) { return m.id === shf.institutions[k].head; })) { var best = pMembers(s, c.leader).sort(function (a, b) { return b.abilities.politics - a.abilities.politics; })[0]; if (best) shf.institutions[k].head = best.id; return true; } }); what = '役職の一部を反対派に譲った'; }
    c.members.forEach(function (m) { addGrudge(s, m, T, -40); addTie(s, m, T, 10); }); P.cabals.splice(P.cabals.indexOf(c), 1);
    bkLogRaw(s, T, pName(s, T) + 'は反対派の求めに応じ、' + what + '。対立はひとまず収まった', '政治的な妥協'); return what;
  }
  function cpuDefend(s, c, ratio) { // CPUの標的：合議で不満を和らげるか、切り崩す
    var T = c.target, pr = purseOf(s, T); if (!pr || (pr.money || 0) < 150 || rand(s) > 0.4) return;
    if (c.members.length >= 2 && (pr.money || 0) >= 300 && rand(s) < 0.5) politicsAct(s, T, { act: 'divide', cabal: c.id, target: c.members.slice().sort(function (a, b) { return grudge(s, a, T) - grudge(s, b, T); })[0] });
    else politicsAct(s, T, { act: 'consult' });
  }
  // ---- 実行：退陣・家督交代・出家・追放・幽閉・軍事的排除・暗殺
  function removeOffices(s, T, p) {
    var sg = s.shogunate, shf = F(s, shogunId(s) || ''); if (sg.shikken && (sg.shikken.holder === T && (!p || sg.shikken.person === p.id))) sg.shikken = null;
    if (shf && shf.institutions) Object.keys(shf.institutions).forEach(function (k) { if (p ? shf.institutions[k].head === p.id : pMembers(s, T).some(function (m) { return m.id === shf.institutions[k].head; })) shf.institutions[k].head = null; });
    if (p) p.warriorOffices = (p.warriorOffices || []).filter(function (o) { return o !== '執権'; });
  }
  function replaceLeader(s, T, p, why) { // 当主が政から外れたとき家督を移す（家・勢力とも）
    var h = s.houses[T]; if (h && !h.asFaction) { if (h.head === p.id) { var nx = h.members.map(function (m) { return Pn(s, m); }).filter(function (q) { return canLead(q) && q.id !== p.id; }).sort(function (a, b) { return (ageOf(s, b) || 99) >= 15 ? 1 : -1; })[0]; if (nx) { recHead(s, T, p.id, nx.id, why); h.head = nx.id; } } return; }
    var f = F(s, T); if (f && f.leader === p.id) { var nxt = factionPersons(s, T).filter(function (q) { return canLead(q) && q.id !== p.id; }).sort(function (a, b) { var ad = function (q) { return ageOf(s, q) == null || ageOf(s, q) >= 15 ? 1 : 0; }; return ad(b) - ad(a) || heirScore(s, f, b) - heirScore(s, f, a); })[0]; if (nxt) { recHead(s, T, p.id, nxt.id, why); f.leader = nxt.id; if (f.heir === nxt.id) f.heir = null; news(s, f.name + 'の家督は' + nxt.name + 'に移った（' + why + '）', { type: 'politics', important: true, factions: [T] }); } }
  }
  function fallPerson(s, T, p, kind, by, why) {
    if (!p || !p.alive) return; var sg = s.shogunate;
    var label = { resign: '役職を解かれた', tonsure: '出家させられた', exile: '追放された', confine: '幽閉された', headchange: '家督を退かされた' }[kind];
    removeOffices(s, T, kind === 'resign' ? null : p); sg.inf[T] = (sg.inf[T] || 0) * ({ resign: 0.6, headchange: 0.8, tonsure: 0.6, exile: 0.4, confine: 0.45 }[kind] || 0.7);
    if (kind === 'tonsure') { p.retired = s.day; p.status = '出家'; } else if (kind === 'exile') { p.exiled = s.day; p.status = '追放'; p.location = null; houseOrFactionBands(s, T).forEach(function (b) { b.strength = Math.round(b.strength * 0.8); }); }
    else if (kind === 'confine') { p.confined = { by: by, day: s.day }; p.status = '幽閉'; p.location = null; } else if (kind === 'headchange') { p.status = '家督を退いた'; }
    if (kind !== 'resign') replaceLeader(s, T, p, label); if (kind === 'headchange') { var fh = F(s, T); if (fh && fh.leader === p.id) { var nn = factionPersons(s, T).filter(function (q) { return canLead(q) && q.id !== p.id && (ageOf(s, q) == null || ageOf(s, q) >= 15); }).sort(function (a, b) { return heirScore(s, fh, b) - heirScore(s, fh, a); })[0]; if (nn) { recHead(s, T, p.id, nn.id, label); fh.leader = nn.id; } } }
    recFall(s, p.id, kind, by, why); news(s, '【政変】' + p.name + '（' + pName(s, T) + '）は' + label + (by ? '。主導：' + pName(s, by) : ''), { type: 'politics', important: true, factions: [T] });
    if (s.player && p.id === s.player.person) { s.player.status = { resign: '失脚', tonsure: '出家', exile: '追放', confine: '幽閉', headchange: '家督を失う' }[kind]; if (kind !== 'resign') openSelection(s, label, kind === 'exile' || kind === 'headchange'); }
  }
  function houseOrFactionBands(s, id) { if (s.houses[id] && !s.houses[id].asFaction) return houseBands(s, id); return Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (b) { return b.faction === id && !b.house; }); }
  function tryAssassinate(s, actor, T, p, intent) { // 単なる確率でなく、意図・実行能力・警固・諜報・人間関係で決める
    var P = ensurePolitics(s), ap = repOf(s, actor); if (!p || !p.alive || !ap) return { done: false };
    var cap = clamp(((purseOf(s, actor) || {}).money || 0) / 1500, 0, 0.4) + ap.abilities.intellect / 250 + ((ap.personality || '').match(/冷酷|謀略|権謀|野心/) ? 0.15 : 0);
    var guard = 0.15 + (P.guard[T] || 0) / 100 + Math.min(0.25, pTroops(s, T) / 4000) + (p.abilities.valor || 50) / 400 + Math.min(0.4, ((s.shogunate && s.shogunate.inf[T]) || 0) / 800), detect = (P.intel[T] || 0) / 100 * (1 - ap.abilities.intellect / 250);
    var bond = (p.relations || []).some(function (r) { return pMembers(s, actor).some(function (m) { return m.id === r.person && /父子|兄弟|母子|夫婦|舅|娘婿/.test(r.type); }); }) ? 0.25 : 0;
    if (rand(s) < detect * 0.8) { addGrudge(s, T, actor, 60, '暗殺を企てた'); recFall(s, p.id, 'plot_foiled', actor, '暗殺の企て'); news(s, '【陰謀露見】' + p.name + 'の命を狙う' + pName(s, actor) + 'の企てが事前に露見した', { type: 'politics', important: true, factions: [T] }); return { done: true, foiled: true }; }
    var sc = intent * cap * 1.5 - guard - bond + (rand(s) - 0.5) * 0.25;
    if (sc > 0.25) { recFall(s, p.id, 'assassinated', actor, '暗殺'); killPerson(s, p, 'assassination', '暗殺された（' + pName(s, actor) + 'の手の者と噂される）'); return { done: true, killed: true }; }
    news(s, '【襲撃】' + p.name + 'を狙う刺客が現れたが、警固の者に退けられた', { type: 'politics', important: true, factions: [T] }); return { done: true, failed: true };
  }
  function executeCabal(s, c, ratio, sudden) {
    var P = ensurePolitics(s), T = c.target, p = repOf(s, T), sg = s.shogunate; P.cabals.splice(P.cabals.indexOf(c), 1); if (!p) return; P.lastCoup = P.lastCoup || {}; P.lastCoup[T] = s.day;
    var leadP = repOf(s, c.leader), amb = leadP ? leadP.ambition || 50 : 50, roll = ratio * (0.8 + rand(s) * 0.4);
    if (sudden) bkLogRaw(s, c.leader, '突然の政変。' + pName(s, c.leader) + 'らがにわかに動いた', '');
    if (c.hostility > 65 && amb > 60 && (ratio < 1.3 || rand(s) < 0.35)) { var r = tryAssassinate(s, c.leader, T, p, c.hostility / 100); if (r.killed || r.foiled) return; }
    if (roll < 0.9) { // 失敗：首謀者が逆に退けられる
      sg.inf[c.leader] = (sg.inf[c.leader] || 0) * 0.5; sg.impeached = sg.impeached || {}; sg.impeached[c.leader] = s.day; c.members.forEach(function (m) { addGrudge(s, m, T, -20); addTie(s, m, T, -10); }); sg.inf[T] = (sg.inf[T] || 0) + 5;
      if (c.hostility > 60) { var af = s.houses[c.leader] && !s.houses[c.leader].asFaction ? houseToFaction(s, c.leader) : F(s, c.leader), tf = s.houses[T] && !s.houses[T].asFaction ? houseToFaction(s, T) : F(s, T); if (af && tf) declareWar(s, af.id, tf.id); bkLogRaw(s, c.leader, pName(s, c.leader) + 'らは' + pName(s, T) + 'を討とうと兵を挙げた', '政治で敗れ実力に訴える'); }
      else bkLogRaw(s, T, pName(s, c.leader) + 'らの' + pName(s, T) + '排除の企ては失敗し、首謀者は勢いを失った', '力の比' + ratio.toFixed(2));
      return;
    }
    var hard = c.hostility > 55;
    var kind = c.goal === '執権の退陣' ? (roll > 2 && hard ? 'exile' : roll > 1.4 ? 'tonsure' : 'resign') : c.goal === '家督の交代' ? 'headchange' : c.goal === '所領の回復' ? (roll > 2 && hard ? 'exile' : 'resign') : (roll > 2.4 && hard ? 'confine' : roll > 1.9 && hard ? 'exile' : roll > 1.4 ? 'tonsure' : 'resign');
    if (c.goal === '排除' && c.hostility > 60 && roll > 1.5) { var af2 = s.houses[c.leader] && !s.houses[c.leader].asFaction ? houseToFaction(s, c.leader) : F(s, c.leader), tf2 = s.houses[T] && !s.houses[T].asFaction ? houseToFaction(s, T) : F(s, T); if (af2 && tf2) { declareWar(s, af2.id, tf2.id); bkLogRaw(s, c.leader, pName(s, c.leader) + 'らは' + pName(s, T) + 'を武力で除こうと兵を挙げた', '軍事的な排除'); return; } }
    sg.inf[c.leader] = (sg.inf[c.leader] || 0) + 10; c.members.forEach(function (m) { addGrudge(s, m, T, -35); });
    fallPerson(s, T, p, kind, c.leader, c.goal);
    bkLogRaw(s, c.leader, pName(s, c.leader) + 'ら反対派が勝ち、' + p.name + 'は' + { resign: '役職を失った', tonsure: '出家に追い込まれた', exile: '鎌倉から追われた', confine: '幽閉された', headchange: '家督を退いた' }[kind], '力の比' + ratio.toFixed(2));
  }
  function confinedTick(s) { // 幽閉中の人物：解放・処刑・再起
    Object.keys(s.persons).forEach(function (k) { var p = s.persons[k]; if (!p.alive) return;
      if (p.confined) { var by = p.confined.by, byOk = by && (participants(s).some(function (q) { return q.id === by; })); var d = s.day - p.confined.day;
        if (!byOk || (d > 365 && rand(s) < 0.05)) { p.confined = null; p.status = '解放'; news(s, '【解放】' + p.name + 'は幽閉を解かれた', { type: 'politics' }); }
        else if (rand(s) < 0.015 && grudge(s, by, p.faction) > 40) { recFall(s, p.id, 'executed', by, '幽閉中に殺害'); killPerson(s, p, 'execution', '幽閉先で殺害された'); } }
      else if (p.exiled && s.day - p.exiled > 540 && rand(s) < 0.03) { p.exiled = null; p.status = '赦免'; news(s, '【赦免】' + p.name + 'は追放を解かれた', { type: 'politics' }); } });
  }
  // ---- 対抗手段（プレイヤー・CPU共通）
  function playerBlocked(s, fid) { if (fid !== s.playerFaction || !s.player) return null; var st = s.player.status; return ['追放', '幽閉', '出家', '捕虜', '隠居', '死去'].indexOf(st) >= 0 ? '操作人物は' + st + 'の身で、幕府の政に関われない（隠居して後を託すか、再起を待つ）' : null; }
  function politicsAct(s, fid, cmd) {
    var P = ensurePolitics(s), sg = s.shogunate, ps = participants(s), pr = purseOf(s, fid); if (!pr) return { ok: false, reason: '勢力が不明' };
    var act = cmd.act, cost = { consult: 100, guard: 200, spy: 150, divide: 300, strike: 200, compromise: 0, retire: 0 }[act]; if (cost == null) return { ok: false, reason: '不明な手' };
    if (act !== 'retire' && (!sg || !ps.some(function (p) { return p.id === fid; }))) return { ok: false, reason: '幕府の御家人として政に加わっていない' };
    if (act !== 'retire' && act !== 'guard' && act !== 'spy' && playerBlocked(s, fid)) return { ok: false, reason: playerBlocked(s, fid) };
    if ((pr.money || 0) < cost) return { ok: false, reason: '銭が足りない（' + cost + '貫）' };
    var ck = fid + ':' + act; if (P.cool[ck] != null && s.day - P.cool[ck] < 45 && act !== 'compromise') return { ok: false, reason: '同じ手は45日空ける' };
    var c = cmd.cabal ? P.cabals.filter(function (x) { return x.id === cmd.cabal; })[0] : null, msg;
    if (act === 'consult') { var hy = sg.reforms && sg.reforms.hyojo && sg.reforms.hyojo.done; ps.forEach(function (p) { addGrudge(s, p.id, fid, hy ? -12 : -8); }); sg.inf[fid] = Math.max(0, (sg.inf[fid] || 0) - 2); msg = pName(s, fid) + 'は有力御家人と協議し、異論を取り入れた（不満が和らぐ。影響力はやや下がる）'; }
    else if (act === 'guard') { P.guard[fid] = clamp((P.guard[fid] || 0) + 20, 0, 80); msg = '館の警固を厚くした（警固' + P.guard[fid] + '）'; }
    else if (act === 'spy') { P.intel[fid] = clamp((P.intel[fid] || 0) + 20, 0, 90); P.cabals.forEach(function (x) { if (x.target === fid) x.known = clamp(x.known + 25, 0, 100); }); msg = '情報を集める者を放った（諜報' + P.intel[fid] + '）'; }
    else if (act === 'compromise') { if (!c || c.target !== fid) return { ok: false, reason: '自家に向けられた反対派を選ぶこと' }; msg = compromise(s, c); }
    else if (act === 'divide') { if (!c || c.target !== fid) return { ok: false, reason: '自家に向けられた反対派を選ぶこと' }; var m = cmd.target && c.members.indexOf(cmd.target) >= 0 ? cmd.target : c.members.slice().sort(function (a, b) { return grudge(s, a, fid) - grudge(s, b, fid); })[0];
      var pk = clamp(0.55 - grudge(s, m, fid) / 150 + tie(s, m, fid) / 200 + (fid === s.playerFaction ? c.known / 300 : 0.15), 0.05, 0.85);
      if (rand(s) < pk) { addGrudge(s, m, fid, -30); addTie(s, m, fid, 15); c.members = c.members.filter(function (x) { return x !== m; }); c.history.push({ day: s.day, date: dateStr(s), text: '切り崩されて離反：' + pName(s, m) }); var q = purseOf(s, m); if (q) q.money = (q.money || 0) + 150; msg = pName(s, m) + 'を反対派から引き離した'; if (!c.members.length) P.cabals.splice(P.cabals.indexOf(c), 1); }
      else { addGrudge(s, m, fid, 10, '切り崩しの誘いを恥とした'); c.hostility += 5; msg = pName(s, m) + 'は誘いに乗らなかった'; } }
    else if (act === 'strike') { if (!c || c.target !== fid) return { ok: false, reason: '自家に向けられた反対派を選ぶこと' }; if (fid === s.playerFaction && c.known < 55) return { ok: false, reason: '首謀者が分からない（諜報が足りない）' };
      var ratio = targetPower(s, fid) / Math.max(1, c.power); grudgeAll(s, fid, 7, '反対派を力で弾圧した', c.members);
      if (ratio * (0.8 + rand(s) * 0.4) > 1.1) { var lp = repOf(s, c.leader); P.cabals.splice(P.cabals.indexOf(c), 1); if (lp) fallPerson(s, c.leader, lp, ratio > 1.8 ? 'exile' : 'resign', fid, '反対派の首謀者として'); sg.inf[c.leader] = (sg.inf[c.leader] || 0) * 0.5; msg = '首謀者' + pName(s, c.leader) + 'を退けた'; }
      else { pr.money -= cost; P.cool[ck] = s.day; executeCabal(s, c, c.power / Math.max(1, targetPower(s, fid)), true); return { ok: true, message: '先手は失敗し、反対派が動いた' }; } }
    else if (act === 'retire') { var me = repOf(s, fid); if (fid !== s.playerFaction || !me) return { ok: false, reason: '操作人物がいない' }; var cands = successorCandidates(s).filter(function (x) { return x.id !== me.id; }); if (!cands.length) return { ok: false, reason: '後を託せる人物がいない' };
      me.retired = s.day; me.status = '隠居'; removeOffices(s, fid, me); replaceLeader(s, fid, me, '隠居'); s.player.status = '隠居'; recFall(s, me.id, 'retire', null, '自ら隠居'); openSelection(s, me.name + 'の隠居', false); msg = me.name + 'は隠居し、後を託す人物を選ぶ'; }
    pr.money -= cost; P.cool[ck] = s.day; if (fid !== s.playerFaction) aiLog(s, fid, '政治の手当て', act, msg);
    return { ok: true, message: msg };
  }
  // ---- 操作人物の交代と後継者選択
  function successorCandidates(s) {
    var fid = s.playerFaction, out = [], seen = {}; var add = function (p, base) { var hd = F(s, base) ? F(s, base).leader === (p && p.id) : (s.houses[base] || {}).head === (p && p.id); if (!p || seen[p.id] || !canLead(p) || (!hd && ageOf(s, p) != null && ageOf(s, p) < 13)) return; seen[p.id] = 1; out.push({ id: p.id, base: base }); };
    Object.keys(s.houses).forEach(function (k) { var h = s.houses[k]; if (h.asFaction || h.ruined) return; if (isIchimon(s, k) && (isIchimon(s, fid) || fid === hojoHouseId(s))) h.members.forEach(function (m) { add(Pn(s, m), k); }); }); // 北条の分家の人は分家を基盤とする
    factionPersons(s, fid).forEach(function (p) { add(p, fid); });
    Object.keys(s.houses).forEach(function (k) { var h = s.houses[k]; if (h.asFaction || h.ruined) return; if (h.faction === fid) h.members.forEach(function (m) { add(Pn(s, m), k); }); });
    if (isIchimon(s, fid) && fid !== hojoHouseId(s) && F(s, hojoHouseId(s))) factionPersons(s, hojoHouseId(s)).forEach(function (p) { add(p, hojoHouseId(s)); });
    return out;
  }
  function candidateInfo(s, c) {
    var p = Pn(s, c.id), base = c.base, f = F(s, base), h = s.houses[base];
    var sg = s.shogunate || { inf: {} }, ps = s.shogunate ? participants(s) : [];
    var sup = ps.length ? Math.round(ps.filter(function (q) { return q.id !== base; }).reduce(function (t, q) { var m = pMembers(s, q.id); return t + (m.some(function (x) { return (x.relations || []).some(function (r) { return r.person === p.id && /舅|娘婿|夫婦|母子|兄弟/.test(r.type); }); }) ? 20 : 0) + supportFrom(s, q.id, base) / ps.length; }, 0)) : null;
    var head = f ? f.leader === p.id : h ? h.head === p.id : false, hs = f ? Math.round(heirScore(s, f, p)) : null;
    return { id: p.id, name: p.name, age: ageOf(s, p), base: base, baseName: f ? f.name : h ? h.name : '', house: h && !h.asFaction ? h.name : (f ? f.name : ''), abilities: p.abilities, personality: p.personality || '', ambition: p.ambition || 50,
      holdings: Object.keys(s.holdings).filter(function (k) { var x = s.holdings[k]; return h && !h.asFaction ? x.house === base : x.controller === base && !x.house; }).length, troops: Math.round(pTroops(s, base)), offices: (p.warriorOffices || []).concat(p.courtOffices || []),
      support: sup, head: head, heirScore: hs, status: p.status || '', relations: (p.relations || []).slice(0, 4).map(function (r) { return pname(s, r.person) + '（' + r.type + '）'; }), switchBase: base !== s.playerFaction };
  }
  function openSelection(s, reason, allowStay) {
    var P = ensurePolitics(s); if (s.pendingStops.some(function (e) { return e.key === 'choose_person' && !e.resolved; })) return;
    var cands = successorCandidates(s).filter(function (c) { return c.id !== s.player.person; }).map(function (c) { return candidateInfo(s, c); }).sort(function (a, b) { return (b.head - a.head) || (b.heirScore || 0) - (a.heirScore || 0); }).slice(0, 8);
    var me = Pn(s, s.player.person), stay = allowStay && me && me.alive && !me.confined;
    if (!cands.length && !stay) { s.flags.gameOver = true; stop(s, { key: 'game_over', title: '家の断絶', text: '操作を続けられる人物がいない（' + reason + '）。', choices: [] }); return; }
    var choices = cands.map(function (c) { return { id: c.id, label: c.name + '（' + (c.age != null ? c.age + '歳・' : '') + c.baseName + (c.head ? '・当主' : '') + '）' }; });
    if (stay) choices.unshift({ id: 'stay', label: me.name + 'のまま再起を目指す（' + s.player.status + '）' });
    stop(s, { key: 'choose_person', reason: reason, candidates: cands, title: '操作人物の交代', persons: cands.map(function (c) { return c.id; }), text: reason + '。次に操作する人物を選ぶ。家の所領・財産・家臣は引き継ぐが、役職（執権など）と影響力は自動では引き継がない。分家の人物を選ぶと、その家の所領・兵だけが基盤になる。', choices: choices });
  }
  function applySuccessor(s, pid, reason) {
    var P = ensurePolitics(s), pl = s.player, old = pl.person;
    if (pid === 'stay') { if (!Pn(s, old) || !Pn(s, old).alive || Pn(s, old).confined) return '続けられない'; pl.personHistory.push({ day: s.day, date: dateStr(s), from: old, to: old, reason: '再起を目指す（' + pl.status + '）' }); return pl.status + 'の身で再起を目指す'; }
    var p = Pn(s, pid); if (!canLead(p)) return '選べない人物';
    var c = successorCandidates(s).filter(function (x) { return x.id === pid; })[0]; if (!c) return '候補ではない';
    var base = c.base, msg = '';
    if (base !== s.playerFaction) { var nf = s.houses[base] && !s.houses[base].asFaction ? houseToFaction(s, base) : F(s, base); if (nf) { transferPlayer(s, nf.id, '操作人物の交代（' + p.name + '）'); msg += nf.name + 'の所領・兵を基盤とする。'; } }
    var fid = s.playerFaction, f = F(s, fid), sg = s.shogunate;
    pl.personHistory.push({ day: s.day, date: dateStr(s), from: old, to: pid, reason: reason || '' }); pl.person = pid; pl.status = '在任';
    if (f && f.leader !== pid) { var ld = Pn(s, f.leader);
      if (!canLead(ld)) { recHead(s, fid, f.leader, pid, '操作人物の交代'); f.leader = pid; msg += p.name + 'が家督を継いだ。'; }
      else { var mine = heirScore(s, f, p), his = heirScore(s, f, ld);
        if (mine >= his * 0.9) { recHead(s, fid, f.leader, pid, '家督の継承（争いあり）'); ld.retired = s.day; ld.status = '隠居'; f.leader = pid; if (f.regime) f.regime.cohesion = clamp(f.regime.cohesion - 8, 0, 100); if (s.shogunate) participants(s).forEach(function (q) { if (isIchimon(s, q.id) && q.id !== fid) addGrudge(s, q.id, fid, 6, '家督の継ぎ方に異論'); }); msg += p.name + 'が' + ld.name + 'に代わって家督を握った（家中に不満）。'; }
        else msg += '家督は' + ld.name + 'のまま。' + p.name + 'は一門の有力者として家を動かす（正統性で劣るため支持は弱い）。'; } }
    if (sg && sg.shikken && sg.shikken.person === old && !canLead(Pn(s, old))) { sg.shikken = null; msg += '執権は空席となった。'; }
    if (sg) sg.inf[fid] = (sg.inf[fid] || 0) * 0.75 + p.abilities.politics / 10;
    var leg = f ? heirScore(s, f, p) : 50, loss = clamp((50 - leg) / 200 + (f && f.leader !== pid ? 0.05 : 0), 0, 0.15);
    if (loss > 0.01) { var lost = 0; houseOrFactionBands(s, fid).forEach(function (b) { var n = Math.round(b.strength * loss); b.strength -= n; lost += n; }); if (lost) msg += '代替わりを機に郎党' + lost + 'が離れた。'; }
    news(s, '【操作人物の交代】' + p.name + 'を操作する。' + msg, { type: 'politics', important: true, factions: [fid] });
    return p.name + 'を操作する。' + msg;
  }
  function checkPlayerPerson(s) {
    var pl = s.player; if (!pl || !pl.person || s.flags.gameOver) return; var p = Pn(s, pl.person);
    if (!p || !p.alive) { pl.status = '死去'; openSelection(s, (p ? p.name : '当主') + 'の死', false); }
    else if (p.captiveOf && pl.status !== '捕虜') { pl.status = '捕虜'; openSelection(s, p.name + 'が捕らわれた', true); }
    else if (['追放', '捕虜', '失脚'].indexOf(pl.status) >= 0 && canLead(p) && (pl.status !== '失脚' || (s.shogunate && (s.shogunate.inf[s.playerFaction] || 0) >= 30))) { pl.status = '在任'; news(s, '【再起】' + p.name + 'は政の場に戻った', { type: 'politics', important: true }); }
  }
  function politicsDaily(s) {
    var P = ensurePolitics(s); checkPlayerPerson(s);
    var sg = s.shogunate, key = sg && sg.shikken ? sg.shikken.holder + ':' + sg.shikken.person : null;
    if (key !== P.lastShikken) { P.records.offices.push({ day: s.day, date: dateStr(s), office: '執権', holder: sg && sg.shikken ? sg.shikken.holder : null, person: sg && sg.shikken ? sg.shikken.person : null }); if (P.records.offices.length > 200) P.records.offices.shift(); P.lastShikken = key; }
  }
  function politicsMonthly(s) {
    var P = ensurePolitics(s), sg = s.shogunate; Object.keys(P.grudge).forEach(function (k) { P.grudge[k] *= 0.96; if (P.grudge[k] < 1) { delete P.grudge[k]; delete P.why[k]; } });
    Object.keys(P.intel).forEach(function (k) { P.intel[k] = Math.max(0, P.intel[k] - 2); }); Object.keys(P.guard).forEach(function (k) { P.guard[k] = Math.max(0, P.guard[k] - 2); });
    confinedTick(s); if (!sg || !shogunId(s)) return; var ps = participants(s); if (ps.length < 3) return;
    var tot = ps.reduce(function (t, p) { return t + (sg.inf[p.id] || 0); }, 0) || 1;
    ps.forEach(function (T) { var sh = (sg.inf[T.id] || 0) / tot * 100; if (sh > 35) grudgeAll(s, T.id, (sh - 35) / 4, '権力が一家に集まりすぎている');
      if (sg.shikken && sg.shikken.holder === T.id && (sg.authority || 50) < 20) ps.forEach(function (q) { if (q.id !== T.id && shogunTie(s, q.id) > 40) addGrudge(s, q.id, T.id, 2, '将軍の権威を軽んじている'); }); });
    cabalTick(s);
  }
  // ================================================================ 任官（官位・官職）：国司（受領・遙任）・検非違使・衛府の尉。幕府の役職（warriorOffices）とは別に持つ
  // 任命権は朝廷。頼朝（幕府を開いた将軍）は御家人の任官を推挙し、無断の任官を統制する。時代とともに幕府の関与が強まる
  var KAN = {
    kami: { name: '国守', weight: 3, rank: '従五位下', cost: 200, note: '国の長官。受領として赴任すれば国衙の収入の一部が入り、その国で兵を集めやすい。遙任なら目代に任せ、収入は少ない' },
    kebiishi: { name: '検非違使', title: '左衛門少尉・検非違使', weight: 2, rank: null, cost: 120, kyo: true, note: '京の治安を担う。在京が条件：任じられると京へ移り、在任中は京を離れて出陣できない（辞すれば戻れる）。朝廷・院との結びつきが強まる' },
    jo: { name: '衛府の尉', weight: 1, rank: null, cost: 80, note: '左右衛門尉・兵衛尉。御家人の名誉の官途' }
  };
  var JO_T = ['左衛門尉', '右衛門尉', '左兵衛尉', '右兵衛尉'];
  function ninkanEra(s) { var y = s.date.y, bk = shogunId(s) && (F(s, shogunId(s)).flags || {}).bakufu;
    if (!bk) return { id: 'pre', name: '幕府成立前', note: '任官は朝廷と公家の派閥しだい。推挙できるのは自家の人物だけ（幕府を開くと御家人の推挙ができる）', bonus: 0, strict: 0 };
    if (y >= 1221) return { id: 'jokyu', name: '承久の乱以後', note: '幕府が朝廷の人事にも強く介入する（推挙が通りやすい）', bonus: 0.3, strict: 2 };
    if (y >= 1214) return { id: 'sanetomo', name: '実朝期（1214年以後）', note: '御家人の任官は幕府の許可を要するとの方針が再確認された（無断任官の咎めが重い）', bonus: 0.15, strict: 2 };
    if (y >= 1199) return { id: 'yoriie', name: '頼家・実朝期', note: '将軍と北条氏・有力御家人が任官に関わる', bonus: 0.1, strict: 1 };
    return { id: 'yoritomo', name: '頼朝期', note: '頼朝が御家人の任官を推挙し、管理する（無断の任官は咎めの対象）', bonus: 0.1, strict: 1 }; }
  function ensureNinkan(s) {
    if (!s.ninkan) { s.ninkan = { queue: [], senrei: {}, control: {}, log: [] };
      Object.keys(s.provinces).forEach(function (pid) { var pv = s.provinces[pid]; if (pv.kokushi) return; var nm = pv.name + '守';
        var hold = Object.keys(s.persons).map(function (k) { return s.persons[k]; }).filter(function (p) { return p.alive && (p.courtOffices || []).indexOf(nm) >= 0; })[0];
        if (hold) pv.kokushi = { person: hold.id, faction: hold.faction, mode: '遙任', since: s.day, confidence: '史実' }; }); }
    s.offices = s.offices || []; if (!s.offices.some(function (o) { return o.id === 'kebiishi'; })) s.offices.push({ id: 'kebiishi', name: '検非違使', category: '官職', established: 816, abolished: null, note: '在京が条件' });
    return s.ninkan;
  }
  function jinji(s, fid) { var N = ensureNinkan(s); return N.control[fid] == null ? 50 : N.control[fid]; } // 人事の統制力
  function addJinji(s, fid, v) { var N = ensureNinkan(s); N.control[fid] = clamp(jinji(s, fid) + v, 0, 100); }
  function houseOfPerson(s, pid) { var hk = Object.keys(s.houses).filter(function (k) { var h = s.houses[k]; return !h.asFaction && (h.members || []).indexOf(pid) >= 0; })[0]; return hk || (Pn(s, pid) ? Pn(s, pid).faction : null); }
  function kakushiki(s, id) { // 家の格式：家の人々の官位・官職の重み
    var ms = s.houses[id] && !s.houses[id].asFaction ? s.houses[id].members.map(function (m) { return Pn(s, m); }) : factionPersons(s, id);
    return ms.filter(function (p) { return p && p.alive; }).reduce(function (t, p) { return t + (p.courtOffices || []).reduce(function (u, o) { return u + (/守$/.test(o) ? 3 : /検非違使/.test(o) ? 2 : /尉|允|介/.test(o) ? 1 : /大臣|納言|参議|卿/.test(o) ? 5 : 0); }, 0) + (p.rank && /五位/.test(p.rank) ? 2 : p.rank && /[四三二一]位/.test(p.rank) ? 4 : 0); }, 0);
  }
  function candidatesFor(s, fid) { // 推挙できる人物：自家の人々、幕府を開いていれば御家人・家の人々も
    var f = F(s, fid), inHouse = function (pid) { var hk = houseOfPerson(s, pid); return s.houses[hk] && !s.houses[hk].asFaction ? hk : null; };
    var out = factionPersons(s, fid).filter(function (p) { return !p.captiveOf && !inHouse(p.id); }).map(function (p) { return { id: p.id, own: true }; }); // 家（北条・土肥など）の人々は御家人として扱う
    if (f && (f.flags || {}).bakufu) retainersOf(s, fid).forEach(function (r) { var ms = r.kind === 'house' ? H(s, r.id).members : factionPersons(s, r.id).map(function (p) { return p.id; }); ms.forEach(function (m) { var p = Pn(s, m); if (p && p.alive && !p.captiveOf && !out.some(function (o) { return o.id === m; })) out.push({ id: m, own: false, via: r.id }); }); });
    return out;
  }
  function nominate(s, fid, cmd) {
    var f = F(s, fid), N = ensureNinkan(s), d = KAN[cmd.office]; if (!f) return { ok: false, reason: '勢力が不明' }; if (!d) return { ok: false, reason: '官職を選ぶこと' };
    var c = candidatesFor(s, fid).filter(function (x) { return x.id === cmd.person; })[0], p = Pn(s, cmd.person);
    if (!c) return { ok: false, reason: (f.flags || {}).bakufu ? '自家・御家人の人物を選ぶこと' : '幕府を開くまでは、自家の人物しか推挙できない' };
    if (f.flags.choteki) return { ok: false, reason: '朝敵とされている間は任官できない' };
    if (N.queue.some(function (q) { return q.person === p.id; })) return { ok: false, reason: p.name + 'の任官はすでに申請中' };
    var pv = null; if (cmd.office === 'kami') { pv = PV(s, cmd.province); if (!pv) return { ok: false, reason: '国を選ぶこと' }; if (pv.kokushi && alive(s, pv.kokushi.person) && topLord(s, Pn(s, pv.kokushi.person).faction) === topLord(s, fid)) return { ok: false, reason: pv.name + '守はすでに味方の' + pname(s, pv.kokushi.person) }; if ((p.courtOffices || []).indexOf(pv.name + '守') >= 0) return { ok: false, reason: 'すでに' + pv.name + '守' }; }
    if (cmd.office === 'kebiishi' && (p.courtOffices || []).some(function (o) { return /検非違使/.test(o); })) return { ok: false, reason: 'すでに検非違使' };
    if (cmd.office === 'kebiishi' && /^army:/.test(String(p.location || ''))) return { ok: false, reason: p.name + 'は出陣中。検非違使は在京が条件なので、軍を離れてから' };
    var gift = Math.max(0, cmd.gift || 0), cost = d.cost + gift; if (f.money < cost) return { ok: false, reason: '銭が足りない（使者と献上に' + cost + '貫）' };
    var era = ninkanEra(s), hk = houseOfPerson(s, p.id), sen = (N.senrei[hk] || []).indexOf(cmd.office === 'kami' && pv ? pv.name + '守' : d.name) >= 0 || (N.senrei[hk] || []).indexOf(d.name) >= 0;
    var chiko = pv && topLord(s, pv.kokuga.holder || '') === topLord(s, fid);
    var pr = clamp(0.15 + courtSupport(s, fid) * 0.45 + ((f.flags || {}).bakufu ? 0.2 : 0) + era.bonus + (chiko ? 0.35 : 0) + (sen ? 0.15 : 0) + jinji(s, fid) / 500 + gift / 2000 + (f.flags.insen ? 0.1 : 0) - (cmd.office === 'kami' && !chiko ? 0.1 : 0), 0.03, 0.95);
    f.money -= cost; var cap = B(s, f.capital), dist = cap ? travelDays(s, cap.province, B(s, s.court.location).province, 45) : 10;
    N.queue.push({ id: nid(s, 'nk'), from: fid, person: p.id, office: cmd.office, province: pv ? pv.id : null, mode: cmd.mode === '受領' ? '受領' : '遙任', due: s.day + dist + 10, chance: pr, own: c.own });
    var msg = '使者を京へ送り、' + p.name + 'の' + (pv ? pv.name + '守' + (cmd.mode === '受領' ? '（受領として赴任）' : '（遙任）') : d.title || d.name) + '任官を' + (c.own ? '申請' : '推挙') + 'した（見込み' + Math.round(pr * 100) + '%' + (chiko ? '・自陣営の知行国' : '') + (sen ? '・家の先例あり' : '') + '。返事まで約' + (dist + 10) + '日）';
    news(s, msg, { type: 'court', factions: [fid] }); return { ok: true, message: msg };
  }
  function applyOffice(s, p, office, provId, mode, fid, why) {
    var N = ensureNinkan(s), d = KAN[office], t, hk = houseOfPerson(s, p.id);
    if (office === 'kami') { var pv = PV(s, provId); t = pv.name + '守'; if (pv.kokushi && Pn(s, pv.kokushi.person)) { var op = Pn(s, pv.kokushi.person); op.courtOffices = (op.courtOffices || []).filter(function (o) { return o !== t; }); }
      pv.kokushi = { person: p.id, faction: p.faction, mode: mode || '遙任', since: s.day, confidence: 'ゲーム展開' };
      if (mode === '受領') { var bb = Object.keys(s.bases).filter(function (k) { return s.bases[k].province === provId && sameCamp(s, s.bases[k].owner, p.faction); })[0]; if (bb && !/^army:/.test(String(p.location || ''))) p.location = bb; }
      if (!p.rank || !/位/.test(p.rank)) p.rank = '従五位下'; }
    else if (office === 'kebiishi') { t = d.title; p.zaikyo = { office: t, since: s.day }; p.location = s.court.location || 'heiankyo'; }
    else { t = JO_T.filter(function (x) { return (p.courtOffices || []).indexOf(x) < 0; })[0] || '左兵衛尉'; }
    p.courtOffices = (p.courtOffices || []).filter(function (o) { return o !== t; }).concat([t]);
    N.senrei[hk] = N.senrei[hk] || []; if (N.senrei[hk].indexOf(t) < 0) N.senrei[hk].push(t);
    N.log.push({ day: s.day, date: dateStr(s), person: p.id, office: t, why: why }); if (N.log.length > 150) N.log.shift();
    news(s, '【除目】' + p.name + 'が' + t + (office === 'kami' ? '（' + (mode || '遙任') + '）' : '') + 'に任じられた' + (why ? '（' + why + '）' : ''), { type: 'court', important: true, factions: [p.faction, fid].filter(Boolean) });
    return t;
  }
  function dropOffice(s, p, t, why) { p.courtOffices = (p.courtOffices || []).filter(function (o) { return o !== t; }); if (/検非違使/.test(t)) p.zaikyo = null;
    Object.keys(s.provinces).forEach(function (pid) { var pv = s.provinces[pid]; if (pv.kokushi && pv.kokushi.person === p.id && pv.name + '守' === t) pv.kokushi = null; });
    if (why) news(s, p.name + 'は' + t + 'を辞した（' + why + '）', { type: 'court', factions: [p.faction] }); }
  function resignOffice(s, fid, cmd) { var p = Pn(s, cmd.person); if (!p || !p.alive || topLord(s, p.faction) !== topLord(s, fid)) return { ok: false, reason: '味方の人物を選ぶこと' };
    var t = (p.courtOffices || []).filter(function (o) { return o === cmd.title || (!cmd.title && /検非違使/.test(o)); })[0]; if (!t) return { ok: false, reason: 'その官職に就いていない' };
    dropOffice(s, p, t, '主君の命'); if (!/検非違使/.test(t)) return { ok: true, message: p.name + 'は' + t + 'を辞した' };
    var f = F(s, p.faction), cap = f && B(s, f.capital); p.location = cap ? cap.id : p.location; return { ok: true, message: p.name + 'は検非違使を辞し、' + (cap ? cap.name : '本拠') + 'へ戻る' }; }
  function ninkanTick(s) { // 日々：申請の結果・在京の条件
    var N = ensureNinkan(s), due = N.queue.filter(function (q) { return q.due <= s.day; }); N.queue = N.queue.filter(function (q) { return q.due > s.day; });
    due.forEach(function (q) { var p = Pn(s, q.person), f = F(s, q.from), ok = p && p.alive && rand(s) < q.chance;
      if (ok) { var t = applyOffice(s, p, q.office, q.province, q.mode, q.from, q.own ? '申請' : '将軍の推挙'); if (!q.own) { var r = retainersOf(s, q.from).filter(function (x) { return x.kind === 'house' ? H(s, x.id).members.indexOf(p.id) >= 0 : x.id === p.faction; })[0]; if (r) { retAddLoyalty(s, r, q.from, 12); addService(s, q.from, r.id, -4); } addJinji(s, q.from, 3); }
        if (q.from === s.playerFaction) stop(s, { key: 'court', title: '任官：' + p.name, persons: [p.id], text: p.name + 'が' + t + 'に任じられた。' + (q.office === 'kebiishi' ? '\n検非違使は在京が条件のため、' + p.name + 'は京に移った。在任中は京を離れて出陣できない（朝廷タブで辞させれば戻る）。' : q.office === 'kami' && q.mode === '受領' ? '\n受領として任国に赴いた。' : ''), choices: [] }); }
      else if (p) { news(s, '【除目】' + p.name + 'の任官は見送られた', { type: 'court', factions: [q.from] }); if (q.from === s.playerFaction) stop(s, { key: 'court', title: '任官の結果', text: p.name + 'の任官は見送られた（朝廷・公家の派閥の支持が足りない）。', choices: [] }); } });
    // 検非違使は在京が条件。京が敵の手に落ちる・京を離れると職を失う
    Object.keys(s.persons).forEach(function (k) { var p = s.persons[k]; if (!p.alive || !p.zaikyo) return; var loc = B(s, p.location), kyo = B(s, s.court.location || 'heiankyo');
      var away = !loc || loc.province !== (kyo ? kyo.province : 'yamashiro'); var lost = kyo && kyo.owner && kyo.owner !== 'court' && !sameCamp(s, kyo.owner, p.faction) && atWar(s, kyo.owner, p.faction);
      if ((away && !/^army:/.test(String(p.location || '')) && s.day - p.zaikyo.since > 3) || lost) dropOffice(s, p, p.zaikyo.office, lost ? '京が敵の手に落ちた' : '京を離れた'); });
  }
  function ninkanMonthly(s) {
    var N = ensureNinkan(s), era = ninkanEra(s);
    // 受領の収入：任国の国衙領の年貢の一部（受領1割・遙任は目代任せで5%）。家の格式は幕府での影響力になる
    Object.keys(s.provinces).forEach(function (pid) { var pv = s.provinces[pid], k = pv.kokushi; if (!k) return; var p = Pn(s, k.person); if (!p || !p.alive) { pv.kokushi = null; return; }
      if (k.mode === '受領') { var here = B(s, p.location) && B(s, p.location).province === pid; if (!here && !/^army:/.test(String(p.location || ''))) { k.awayM = (k.awayM || 0) + 1; if (k.awayM >= 2) { k.mode = '遙任'; news(s, p.name + 'は任国を離れたので、' + pv.name + 'は目代に任せる遙任となった', { type: 'court', factions: [p.faction] }); } } else k.awayM = 0; }
      var out = Object.keys(s.holdings).reduce(function (t, h) { var x = s.holdings[h]; return t + (x.province === pid && x.type === '国衙領' ? x.output : 0); }, 0), gain = Math.round(out * 0.3 / 12 * (k.mode === '受領' ? 0.1 : 0.05));
      var pf = F(s, p.faction); if (pf && pf.alive && gain > 0) pf.money += gain; if (k.mode === '受領') pv.unrest = clamp((pv.unrest || 0) - 1, 0, 100); });
    if (s.shogunate) participants(s).forEach(function (q) { var kk = kakushiki(s, q.id); if (kk) s.shogunate.inf[q.id] = (s.shogunate.inf[q.id] || 0) + Math.min(3, kk * 0.15); });
    // 朝廷からの国司任命：朝廷の支持の厚い有力者に、勢力の及ぶ国の国守を与えて取り込もうとする
    Object.keys(s.factions).forEach(function (fid) { var f = s.factions[fid]; if (!f.alive || f.type === '寺社' || fid === 'court' || f.flags.choteki || f.overlord) return; var sup = courtSupport(s, fid); if (sup < 0.3 || rand(s) > 0.03 + sup * 0.04) return;
      var noble = function (p) { return /[一二三]位/.test(p.rank || '') || (p.courtOffices || []).some(function (o) { return /大臣|納言|参議|大将|督/.test(o); }); }; // 公卿は国守にならない
      var leader = Pn(s, f.leader); if (leader && leader.alive && noble(leader)) leader = factionPersons(s, fid).filter(function (p) { return !noble(p) && !p.captiveOf && (ageOf(s, p) == null || ageOf(s, p) >= 15) && !(p.courtOffices || []).some(function (o) { return /守$/.test(o); }); }).sort(function (a, b) { return b.abilities.politics - a.abilities.politics; })[0];
      if (!leader || !leader.alive || (leader.courtOffices || []).some(function (o) { return /守$/.test(o); })) return;
      var pids = factionBases(s, fid).map(function (b) { return b.province; }).filter(function (pid, i, a) { var pv = PV(s, pid); return a.indexOf(pid) === i && (!pv.kokushi || !alive(s, pv.kokushi.person)); }); if (!pids.length) return; var pid = pids[0];
      if (fid === s.playerFaction) stop(s, { key: 'kokushi_offer', person: leader.id, province: pid, title: '朝廷から国司の任命', persons: [leader.id], text: '朝廷は' + leader.name + 'を' + PV(s, pid).name + '守に任じようとしている（朝廷の支持' + Math.round(sup * 100) + '）。受けると家の格式と収入が上がるが、朝廷との結びつきも深まる。', choices: [{ id: '受領', label: '受ける（受領として任国に赴く）' }, { id: '遙任', label: '受ける（遙任：目代に任せる）' }, { id: 'decline', label: '辞退する' }] });
      else applyOffice(s, leader, 'kami', pid, rand(s) < 0.4 ? '受領' : '遙任', fid, '朝廷の任命'); });
    // 無断任官：在京の御家人に朝廷が直接官職を与える（主君の統制が弱いほど起きやすい）
    Object.keys(s.persons).forEach(function (k) { var p = s.persons[k]; if (!p.alive || p.captiveOf) return; var loc = B(s, p.location); if (!loc || loc.province !== 'yamashiro') return;
      var lord = topLord(s, p.faction), lf = F(s, lord); if (!lf || !lf.alive || !(lf.flags || {}).bakufu || lf.leader === p.id || (p.courtOffices || []).some(function (o) { return /検非違使|衛門尉/.test(o); })) return;
      if ((p.abilities.valor < 65 && (p.ambition || 50) < 60) || rand(s) > 0.04 * (1.5 - jinji(s, lord) / 100)) return;
      var accept = (p.ambition || 50) >= 55 || (p.loyalty == null ? 60 : p.loyalty) < 75; if (!accept) { news(s, p.name + 'は朝廷からの任官の打診を、主君の許しがないとして辞退した', { type: 'court', factions: [lord] }); addJinji(s, lord, 2); return; }
      var t = applyOffice(s, p, 'kebiishi', null, null, null, '主君の推挙なし（無断任官）'); p.mudan = { day: s.day, office: t, lord: lord };
      if (lord === s.playerFaction) stop(s, { key: 'mudan', person: p.id, title: '無断任官：' + p.name, persons: [p.id], text: p.name + 'が主君の推挙を経ずに、朝廷から' + t + 'に任じられた。' + (era.strict >= 2 ? '幕府は御家人の任官に許可を要すると定めている。' : '') + '\n認めれば本人は喜ぶが、人事の統制が緩む（ほかの御家人も勝手に官を求めるようになる）。咎めれば統制は保たれるが、本人は不満を抱く。', choices: [{ id: 'approve', label: '認める' }, { id: 'refuse', label: '叱責して辞退させる' }, { id: 'punish', label: '処罰する（所領を削る）' }] });
      else { if (rand(s) < 0.5) { dropOffice(s, p, t, '主君の咎め'); p.loyalty = clamp((p.loyalty || 60) - 10, 0, 100); } else addJinji(s, lord, -6); } });
  }
  function resolveMudan(s, ev, choiceId) { var p = Pn(s, ev.person), lord = s.playerFaction, era = ninkanEra(s); if (!p || !p.alive || !p.mudan) return '本人はもういない';
    var t = p.mudan.office, r = retainersOf(s, lord).filter(function (x) { return x.kind === 'house' ? H(s, x.id).members.indexOf(p.id) >= 0 : x.id === p.faction; })[0];
    if (choiceId === 'approve') { addJinji(s, lord, -10 * era.strict - 5); p.loyalty = clamp((p.loyalty || 60) + 5, 0, 100); return p.name + 'の' + t + 'を認めた（人事の統制が緩んだ）'; }
    dropOffice(s, p, t, '主君の咎め'); var f = F(s, p.faction), cap = f && B(s, f.capital); if (cap) p.location = cap.id;
    if (choiceId === 'refuse') { addJinji(s, lord, 6); p.loyalty = clamp((p.loyalty || 60) - 12, 0, 100); if (r) retAddLoyalty(s, r, lord, -6); return p.name + 'を叱責し、' + t + 'を辞退させた'; }
    addJinji(s, lord, 12); p.loyalty = clamp((p.loyalty || 60) - 25, 0, 100); if (r) { retAddLoyalty(s, r, lord, -15); if (s.politics) addGrudge(s, r.id, lord, 25, '無断任官を咎められ所領を削られた'); }
    var hk = r && r.kind === 'house' ? Object.keys(s.holdings).filter(function (k) { return s.holdings[k].house === r.id; })[0] : null; if (hk && Object.keys(s.holdings).filter(function (k) { return s.holdings[k].house === r.id; }).length > 1) { s.holdings[hk].house = null; }
    retainersOf(s, lord).forEach(function (x) { if (x !== r) retAddLoyalty(s, x, lord, -1); }); return p.name + 'を処罰した（統制は強まったが、本人と一門は強く不満を抱いた）';
  }
  function succession(s, f, dead) {
    if (f.id === 'court') return;
    var fam = (dead.relations || []).filter(function (r) { return /父子|兄弟/.test(r.type); }).map(function (r) { return s.persons[r.person]; })
      .filter(function (p) { return p && p.alive && p.faction === f.id && canLead(p); });
    var pool = fam.length ? fam : factionPersons(s, f.id).filter(function (p) { return canLead(p); });
    // 嫡流優先：あらかじめ定めた後継者
    var heir = f.heir && canLead(Pn(s, f.heir)) && Pn(s, f.heir).faction === f.id ? Pn(s, f.heir) : null;
    if (!heir) { pool.sort(function (a, b) { return (b.abilities.politics + b.abilities.command) - (a.abilities.politics + a.abilities.command); }); heir = pool[0]; }
    if (!heir && f.type.indexOf('寺社') >= 0) { // 寺社は組織として存続し、新たな代表を立てる
      var nid2 = dead.id + '_s' + s.day; s.persons[nid2] = JSON.parse(JSON.stringify(dead)); heir = s.persons[nid2];
      heir.id = nid2; heir.name = f.name.replace(/（.*）/, '') + 'の新たな代表'; heir.alive = true; heir.born = null; heir.died = null; heir.birthConfidence = 'ゲーム設定'; heir.location = f.capital; heir.relations = []; heir.deathDay = null; heir.note = '前代表の死後に立てられた代表（架空）';
    }
    if (!heir) { destroyFaction(s, f, '当主の死去と後継者の不在'); return; }
    f.leader = heir.id; if (s.politics) recHead(s, f.id, dead.id, heir.id, dead.alive ? '当主が政から退いた' : '当主の死');
    news(s, f.name + 'の家督は' + heir.name + 'が継いだ', { type: 'politics', important: true, factions: [f.id] });
    if (heir.born && s.date.y - heir.born < 15) news(s, '幼少の当主のため、一門の後見が政務を執る', { factions: [f.id] });
    campaignOnDeath(s, f, dead);
    if (f.type.indexOf('寺社') < 0) resolveSuccession(s, f, dead, heir, pool.concat(factionPersons(s, f.id).filter(function (p) { return pool.indexOf(p) < 0 && (p.relations || []).some(function (x) { return /父子|兄弟|一族/.test(x.type) && x.person === dead.id; }); })));
  }
  function destroyFaction(s, f, why) {
    if (!f.alive) return; f.alive = false;
    news(s, '【滅亡】' + f.name + '：' + why, { type: 'politics', important: true, factions: [f.id] });
    Object.keys(s.armies).forEach(function (k) { if (s.armies[k].faction === f.id) disbandArmy(s, s.armies[k]); });
    Object.keys(s.bands).forEach(function (k) { if (s.bands[k].faction === f.id) s.bands[k].faction = null; });
    if (f.id === s.playerFaction) { s.flags.gameOver = true; stop(s, { key: 'game_over', title: '滅亡 ― ゲームオーバー', text: f.name + 'は滅亡した（' + why + '）。\n' + dateStr(s) + '、' + s.day + '日目のことであった。', choices: [] }); }
  }
  // ---- 天下統一：寺社と朝廷（都・御所）を除く全拠点を自家と家臣が押さえる。5年保てばゲームクリア
  function unifyStatus(s, fid) {
    fid = fid || s.playerFaction; var tot = 0, mine = 0, rest = [];
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (!b.owner || b.owner === 'court' || b.type === '寺社') return; tot++; if (topLord(s, b.owner) === fid) mine++; else rest.push(b.id); });
    var since = s.flags.unifiedDay, held = since != null ? s.day - since : 0, need = 5 * 354;
    return { total: tot, mine: mine, rest: rest, unified: tot > 0 && mine === tot && topLord(s, fid) === fid, since: since, held: held, need: need, sinceDate: s.flags.unifiedDate || null, victory: !!s.flags.victory };
  }
  // ---- 勢力の目標・家の存続
  function provHeld(s, fid, pid, camp) { var i = provinceInfluence(s, pid)[0]; return !!i && (camp ? topLord(s, i.faction) === topLord(s, fid) : i.faction === fid || (topLord(s, i.faction) === fid)); }
  function evalObj(s, fid, c) {
    var f = F(s, fid), v = false, prog = null;
    switch (c.t) {
      case 'courtControl': v = s.court.controller === topLord(s, fid) && topLord(s, fid) === fid; break;
      case 'notController': v = s.court.controller !== c.f; break;
      case 'provinces': { var n = c.list.filter(function (p) { return provHeld(s, fid, p, c.camp); }).length; v = n >= c.n; prog = n + '／' + c.n; break; }
      case 'bakufu': v = !!f.flags.bakufu; break;
      case 'institutions': { var inst = f.institutions || {}, m = c.list.filter(function (k) { return inst[k] || (k === 'kumonjo' && inst.mandokoro); }).length; v = m === c.list.length; prog = m + '／' + c.list.length; break; }
      case 'office': v = factionPersons(s, fid).some(function (p) { return (p.courtOffices || []).concat(p.warriorOffices || []).some(function (o) { return c.list.some(function (x) { return o.indexOf(x) >= 0; }); }); }); break;
      case 'support': { var sp = courtSupport(s, fid); v = sp >= c.min; prog = (sp >= 0 ? '+' : '') + Math.round(sp * 100); break; }
      case 'anyOf': v = c.list.some(function (x) { return evalObj(s, fid, x).ok; }); break;
      case 'notVassal': v = !f.overlord; break;
      case 'holdBase': v = !!B(s, c.base) && B(s, c.base).owner === fid; break;
      case 'minBases': v = factionBases(s, fid).length >= c.n; prog = factionBases(s, fid).length + '／' + c.n; break;
      case 'money': v = f.money >= c.min; prog = Math.round(f.money) + '／' + c.min; break;
      case 'date': v = cmpDate(s.date, { y: c.y, m: c.m, leap: false, d: 1 }) >= 0; break;
      case 'alive': v = f.alive; break;
      case 'shikken': v = !!(s.shogunate && s.shogunate.shikken && s.shogunate.shikken.holder === fid); break;
      case 'never': v = false; break;
    }
    return { ok: !!v, label: c.label || c.t, progress: prog };
  }
  function objectiveFor(s, fid) {
    var g = s.options.goal || 'objective';
    if (g === 'none' || g === 'unify') return null;
    if (g === 'campaign') { if (s.flags.campaignStage >= 2) return { title: '執権として幕府の実権を握る', text: '御家人の権力闘争に勝ち、執権に就く（就任後もゲームは続く）', conds: [{ t: 'shikken', label: '執権に就く' }] }; if (fid === 'yoritomo') return { title: '第1段階：源氏政権を築く', text: '平家と戦い、東国を押さえ、幕府を開く。頼朝が世を去れば北条氏へ移る', conds: [{ t: 'bakufu', label: '幕府を開く' }, { t: 'provinces', list: ['izu', 'sagami', 'musashi', 'awa_t', 'kazusa', 'shimosa', 'hitachi', 'kozuke', 'shimotsuke'], n: 5, label: '東国の5か国を押さえる' }, { t: 'never', label: '（頼朝の死で第2段階へ）' }] }; }
    if (g === 'survive') return { title: '家の存続', text: '建久元年（1190）4月まで家を保つ', conds: [{ t: 'minBases', n: 1, label: '拠点を一つ以上保つ' }, { t: 'date', y: 1190, m: 4, label: '建久元年（1190）4月を迎える' }] };
    return (s.objectives || {})[fid] || { title: '家の存続', text: '建久元年（1190）4月まで家を保つ（この家には固有の目標がない）', conds: [{ t: 'minBases', n: 1, label: '拠点を一つ以上保つ' }, { t: 'date', y: 1190, m: 4, label: '建久元年（1190）4月を迎える' }] };
  }
  function objectiveStatus(s, fid) {
    fid = fid || s.playerFaction; var o = objectiveFor(s, fid); if (!o) return null;
    var rows = o.conds.map(function (c) { return evalObj(s, fid, c); });
    return { goal: s.options.goal, title: o.title, text: o.text, rows: rows, done: rows.every(function (r) { return r.ok; }), victory: !!s.flags.victory };
  }
  function checkVictory(s) {
    if (!s.playerFaction || s.flags.gameOver) return;
    var g = s.options.goal || 'unify';
    if (g === 'none') return;
    if (g === 'campaign') return; // キャンペーンは執権就任後も続く（サンドボックス）
    if (g !== 'unify') {
      var st = objectiveStatus(s); var pf = F(s, s.playerFaction);
      if (st && st.done && !s.flags.victory && pf.alive) {
        s.flags.victory = true; s.flags.victoryDate = dateStr(s);
        news(s, '【目標達成】' + pf.name + '：' + st.title, { type: 'event', important: true, factions: [pf.id] });
        stop(s, { key: 'victory', title: st.title + ' ― ゲームクリア', persons: [pf.leader], text: pf.name + 'は「' + st.title + '」を成し遂げた。\n' + st.rows.map(function (r) { return '・' + r.label; }).join('\n') + '\n' + dateStr(s) + '。', choices: [] });
      }
      return;
    }
    if (!s.playerFaction || s.flags.gameOver) return;
    var f = F(s, s.playerFaction); if (!f || !f.alive) return;
    var u = unifyStatus(s);
    if (u.unified) {
      if (s.flags.unifiedDay == null) {
        s.flags.unifiedDay = s.day; s.flags.unifiedDate = dateStr(s);
        news(s, '【天下統一】' + f.name + 'が天下の拠点をすべて押さえた。5年保てば天下は定まる', { type: 'event', important: true, factions: [f.id] });
        stop(s, { key: 'unified', title: '天下統一', persons: [f.leader], text: f.name + 'は寺社と朝廷を除く天下の拠点をすべて手中に収めた。\nこのまま5年間、一つの拠点も失わずに保てばゲームクリアとなる（' + dateStr(s) + 'から）。', choices: [] });
      } else if (!s.flags.victory && s.day - s.flags.unifiedDay >= u.need) {
        s.flags.victory = true; s.flags.victoryDate = dateStr(s);
        news(s, '【天下静謐】' + f.name + 'は統一を5年保ち、天下を定めた', { type: 'event', important: true, factions: [f.id] });
        stop(s, { key: 'victory', title: '天下静謐 ― ゲームクリア', persons: [f.leader], text: f.name + 'は' + s.flags.unifiedDate + 'に天下を統一し、5年のあいだ保ち抜いた。\n' + dateStr(s) + '、天下は定まった。', choices: [] });
      }
    } else if (s.flags.unifiedDay != null && !s.flags.victory) {
      s.flags.unifiedDay = null; s.flags.unifiedDate = null;
      news(s, '【統一崩れる】拠点を失い、天下統一が崩れた。5年の数え直し', { type: 'event', important: true, factions: [f.id] });
    }
  }
  function takakuraDeath(s) {
    var c = s.court; c.cloisteredEmperor = 'goshirakawa'; c.dharmaEmperorConfined = false;
    var gp = Pn(s, 'goshirakawa'); if (gp && gp.alive) gp.status = '法皇（院政）';
    ensureCourt(s); c.cliques.in.influence = Math.min(60, c.cliques.in.influence + 18); c.cliques.tenno.influence = Math.max(3, c.cliques.tenno.influence - 12); c.dominance.heike = Math.max(20, c.dominance.heike - 20);
    news(s, '後白河法皇が院政を再開した', { type: 'politics', important: true });
  }

  // ---------------------------------------------------------------- 経済（月初に前月分を集計）
  // ================================================================ 所領の権利（v0.9）
  // 本所（名目上の権利者）・徴税権（知行国主／預所・下司）・地頭・実効支配（軍事）を分けて持ち、年貢を分け合う。
  var HONJO_MAP = [[/延暦寺/, 'enryakuji'], [/園城寺/, 'onjoji'], [/興福寺|東大寺/, 'nanto'], [/熊野/, 'kumano'], [/^—$|^-$|^$/, null]];
  var SHARES = { // 年貢（生産の3割）の分け方（ゲーム設定）
    '国衙領': { honjo: 0.1, tax: 0.6, ctrl: 0.3 },     // 朝廷（形式）・知行国主・在庁官人ら在地の支配者
    '荘園':   { honjo: 0.35, tax: 0.45, ctrl: 0.2 },   // 本所・領家／預所・下司・在地の武士
    '荘園群': { honjo: 0.35, tax: 0.45, ctrl: 0.2 }, '御厨': { honjo: 0.35, tax: 0.45, ctrl: 0.2 }, '寺社領': { honjo: 0.5, tax: 0.3, ctrl: 0.2 },
    '私領': { honjo: 0, tax: 0, ctrl: 1 }, '郷': { honjo: 0, tax: 0, ctrl: 1 }, '郡': { honjo: 0, tax: 0, ctrl: 1 },
  };
  function ensureHoldings(s) {
    Object.keys(s.holdings).forEach(function (k) {
      var h = s.holdings[k]; if (h.rights) return;
      var hj = 'court'; HONJO_MAP.some(function (m) { if (m[0].test(h.proprietor || '')) { hj = m[1]; return true; } return false; });
      if ((SHARES[h.type] || {}).honjo === 0) hj = null;
      h.rights = { honjo: hj, taxHolder: h.type === '国衙領' ? (PV(s, h.province).kokuga.holder || h.controller) : h.controller, jito: null };
      h.oryo = false;
    });
  }
  function jitoAllowed(s) { return cmpDate(s.date, { y: 1185, m: 11, leap: false, d: 29 }) >= 0; } // 文治元年11月29日の勅許（史実）
  // 月ごとの年貢の分配：各勢力の取り分（年貢の量）と押領の数を返す
  function distributeIncome(s) {
    ensureHoldings(s); var inc = {}, oryo = {}, hinc = {};
    function give(fid, v, hh) { if (!fid || v <= 0) return; if (hh) { hinc[hh] = (hinc[hh] || 0) + v; return; } inc[fid] = (inc[fid] || 0) + v; }
    Object.keys(s.holdings).forEach(function (k) {
      var h = s.holdings[k], sh = SHARES[h.type] || SHARES['荘園'], tax = h.output * 0.3 * (1 - PV(s, h.province).devastation / 150), r = h.rights;
      var ctrl = h.controller, parts = [[r.honjo, sh.honjo], [r.taxHolder, sh.tax], [ctrl, sh.ctrl]];
      if (r.jito && sh.tax > 0) { var cut = Math.min(sh.tax, 0.2); parts[1][1] -= cut; parts.push([r.jito, cut]); } // 地頭の得分
      h.oryo = false;
      parts.forEach(function (p) {
        var who = p[0], v = tax * p[1]; if (!v) return;
        var dead = who && (!F(s, who) || !F(s, who).alive);
        if (!who || dead) { give(ctrl || r.taxHolder, v); return; }
        if (ctrl && who !== ctrl && atWar(s, ctrl, who)) { give(ctrl, v); h.oryo = true; oryo[ctrl] = oryo[ctrl] || {}; oryo[ctrl][topLord(s, who)] = (oryo[ctrl][topLord(s, who)] || 0) + 1; return; } // 押領
        var hh = who === ctrl && h.house && H(s, h.house) && topLord(s, H(s, h.house).lord) === topLord(s, ctrl) ? h.house : null; // 家の所領の取り分は家の蔵へ
        give(who, v, hh);
        if (who === ctrl && h.facilities && h.facilities.some(function (x) { return x.kind === 'market' && x.done; })) give(who, tax * 0.05, hh);
      });
    });
    return { income: inc, oryo: oryo, houseInc: hinc };
  }
  // 知行国（国司の任命権）：朝廷が毎月見直す。朝廷と戦う家からは取り上げ、国を実際に押さえる家や朝廷に近い家へ与える
  function kokugaReview(s) {
    var c = s.court, ctrl = c.controller, moved = [];
    Object.keys(s.provinces).forEach(function (pid) {
      var pv = s.provinces[pid], h = pv.kokuga.holder, i = provinceInfluence(s, pid)[0], mc = i ? topLord(s, i.faction) : null, to = null;
      if (mc === 'court' || (mc && F(s, mc) && F(s, mc).type === '寺社')) mc = null;
      if (h && (!F(s, h) || !F(s, h).alive)) to = mc || ctrl;
      else if (h && atWar(s, h, ctrl) && rand(s) < 0.3) to = mc && !atWar(s, mc, ctrl) ? mc : ctrl;           // 朝廷と戦う家は解官
      else if (mc && mc !== topLord(s, h || mc) && (mc === ctrl || courtSupport(s, mc) > courtSupport(s, h || ctrl) + 0.2) && rand(s) < 0.1) to = mc; // 押さえている家を国司に
      if (to && to !== h) { pv.kokuga.holder = to; pv.kokuga.confidence = 'ゲーム展開'; moved.push(pv.name + '→' + fname(s, to).replace(/（.*）/, ''));
        Object.keys(s.holdings).forEach(function (k) { var x = s.holdings[k]; if (x.province === pid && x.type === '国衙領') { ensureHoldings(s); x.rights.taxHolder = to; } }); }
    });
    if (moved.length) { news(s, '【知行国】朝廷は国司を改めた：' + moved.slice(0, 6).join('、') + (moved.length > 6 ? ' ほか' : ''), { type: 'court', important: moved.some(function (m) { return s.playerFaction && m.indexOf(fname(s, s.playerFaction).replace(/（.*）/, '')) >= 0; }) }); aiLog(s, 'court', '知行国の見直し（' + moved.length + 'か国）', moved.join('、')); }
  }
  function appointJito(s, fid, hid) {
    var f = F(s, fid), h = s.holdings[hid]; ensureHoldings(s);
    if (!h) return { ok: false, reason: '所領が不明' };
    if (!f.flags.bakufu) return { ok: false, reason: '地頭を置けるのは幕府を開いた家だけ' };
    if (!jitoAllowed(s)) return { ok: false, reason: '地頭の設置は文治元年（1185）11月の勅許から（史実）' };
    if (!h.controller || topLord(s, h.controller) !== topLord(s, fid)) return { ok: false, reason: '自陣営が実効支配している所領にだけ置ける' };
    if ((SHARES[h.type] || {}).tax === 0) return { ok: false, reason: '私領・郷には地頭を置く意味がない（すでに在地の支配）' };
    if (h.rights.jito) return { ok: false, reason: 'すでに地頭がいる' };
    if (f.money < 50) return { ok: false, reason: '銭が足りない（50貫）' };
    f.money -= 50; h.rights.jito = fid;
    if (h.rights.honjo && s.court.cliques) { var cl = h.rights.honjo === 'court' ? s.court.cliques.sekkan : s.court.cliques.jisha; if (cl) { cl.grudge = cl.grudge || {}; cl.grudge[topLord(s, fid)] = Math.min(30, (cl.grudge[topLord(s, fid)] || 0) + 1); } } // 本所の不満
    return { ok: true, message: h.name + 'に地頭を置いた（年貢の2割を地頭の得分に）' };
  }
  function petitionKokushi(s, fid, pid) {
    var f = F(s, fid), pv = PV(s, pid); if (!pv) return { ok: false, reason: '国が不明' };
    if (topLord(s, pv.kokuga.holder || '') === topLord(s, fid)) return { ok: false, reason: pv.name + 'の知行国主はすでに自陣営' };
    if (f.flags.choteki) return { ok: false, reason: '朝敵とされている間は国司に任じられない' };
    var i = provinceInfluence(s, pid)[0], mine = i && topLord(s, i.faction) === topLord(s, fid);
    var p = clamp(0.08 + courtSupport(s, fid) * 0.6 + (mine ? 0.25 : 0) + (s.court.controller === fid ? 0.3 : 0), 0.02, 0.9);
    var cap = B(s, f.capital), dist = cap ? travelDays(s, cap.province, B(s, s.court.location).province, 45) : 10;
    s.court.pendingPetitions.push({ id: nid(s, 'pet'), from: fid, kind: 'kokushi', province: pid, decideDay: s.day + dist + 8, chance: p });
    return { ok: true, message: pv.name + 'の知行国（国司の任命）を申請（見込み ' + Math.round(p * 100) + '%' + (mine ? '・実効支配あり' : '') + '）' };
  }
  function monthly(s) {
    var harvest = (s.date.m === 9 || s.date.m === 10) ? 0.4 : 0.02, dist = distributeIncome(s); s.lastOryo = dist.oryo;
    // 主従：家臣は年貢の2割を主家へ納める（奉公）。朝廷は年貢の7割を公事・儀式・造営に費やす（ゲーム設定）
    Object.keys(dist.income).forEach(function (k) { var x = F(s, k); if (x && x.alive && x.overlord && F(s, x.overlord) && F(s, x.overlord).alive) { var t = dist.income[k] * 0.2; dist.income[k] -= t; dist.income[x.overlord] = (dist.income[x.overlord] || 0) + t; } });
    if (dist.income.court) dist.income.court *= 0.3;
    Object.keys(s.factions).forEach(function (fid) {
      var f = s.factions[fid]; if (!f.alive) return;
      f.food = Math.round(f.food * 0.985); // 蔵の米は少しずつ傷む・目減りする
      var tax = dist.income[fid] || 0;
      var money = tax / 12 * 0.15, food = tax * harvest; // 年貢の一部を銭・絹等の換金分として扱う（ゲーム設定）
      if (fid === 'heike') money += 800; // 日宋貿易（推定）
      if (fid === 'oshu') money += 600;  // 金（推定）
      var inst = f.institutions || {};
      var adm = inst.mandokoro ? 0.25 : inst.kumonjo ? 0.15 : 0;
      if (adm) { var hd = Pn(s, (inst.mandokoro || inst.kumonjo).head); money *= 1 + adm * (hd && hd.alive ? 0.5 + hd.abilities.politics / 100 : 0.5); }
      if (inst.monchujo) holdingsOf(s, fid).forEach(function (h) { var pv = PV(s, h.province); pv.unrest = Math.max(0, pv.unrest - 1); });
      if (fid === s.playerFaction) { money *= diff(s).income; food *= diff(s).income; }
      var upkeep = factionArmies(s, fid).reduce(function (t, a) { return t + a.troops * 0.03; }, 0);
      f.money = Math.max(0, f.money + money - upkeep); f.food += food;
      f.lastIncome = { money: Math.round(money), food: Math.round(food), upkeep: Math.round(upkeep) };
    });
    houseMonthly(s, dist.houseInc, harvest);
    // 武士団の回復と国の荒廃回復
    Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.strength < b.base) b.strength = Math.min(b.base, b.strength + b.base * 0.01); });
    Object.keys(s.provinces).forEach(function (k) { var p = s.provinces[k]; p.devastation = Math.max(0, p.devastation - 2); p.unrest = Math.max(5, p.unrest - 1); });
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (!b.burned) b.defense = Math.min(b.maxDefense, b.defense + 2); });
    if (s.date.m === 1 || s.date.m === 8) news(s, (s.date.m === 1 ? '春' : '秋') + 'の除目の時期（任官申請の審議が行われる）', { type: 'court' });
  }

  // ---------------------------------------------------------------- 人物の死亡
  function mortality(s) {
    Object.keys(s.persons).forEach(function (k) {
      var p = s.persons[k]; if (!p.alive || !p.born) return;
      var age = s.date.y - p.born;
      var daily = Math.max(0, (age - 40)) * 0.0000025 + (age > 65 ? 0.00004 : 0);
      if (s.options.mode === 'historical') {
        if (p.died && s.date.y < p.died) daily = 0;                  // 史実の没年までは病没しない
        if (p.naturalDeath) {
          var nd = p.naturalDeath, diff = dayDiffApprox(s.date, nd);
          if (diff > -30 && !p.ill) { p.ill = true; news(s, p.name + 'が病に伏せっているとの噂', { type: 'politics', factions: [p.faction] }); }
          if (cmpDate(s.date, nd) >= 0) { killPerson(s, p, 'illness', '病没（史実の日付）'); return; }
        }
      }
      if (rand(s) < daily) killPerson(s, p, 'illness', '病没');
    });
  }
  function dayDiffApprox(a, b) { return (a.y - b.y) * 354 + ((a.m + (a.leap ? 0.5 : 0)) - (b.m + (b.leap ? 0.5 : 0))) * 29.5 + (a.d - b.d); }

  // ================================================================ 幕府（武家政権）と諸機関
  var INSTITUTIONS = {
    samurai_dokoro: { name: '侍所', head: '別当', est: 1180, money: 500, effect: '御家人の統率：主従下の勢力の離反を防ぎ、合戦の戦力 +3%。臣従の勧誘が通りやすくなる', hist: '治承4年（1180）11月、和田義盛を別当として設置' },
    kumonjo: { name: '公文所', head: '別当', est: 1184, money: 800, effect: '一般政務・財政：毎月の銭収入 +15%（長官の政治力で増減）', hist: '元暦元年（1184）10月、大江広元を別当として設置。のち政所に改称' },
    monchujo: { name: '問注所', head: '執事', est: 1184, money: 600, effect: '訴訟の裁定：自領の国の不穏が下がり、正当性 +5', hist: '元暦元年（1184）10月、三善康信を執事として設置' },
    mandokoro: { name: '政所', head: '別当', est: 1191, money: 1200, requires: 'kumonjo', effect: '公文所を改組：毎月の銭収入 +25%、朝廷関係 +5', hist: '建久2年（1191）、頼朝の右近衛大将任官（1190）を受けて公文所を政所と改称' },
  };
  function bakufuCheck(s, fid) {
    var f = F(s, fid), why = [];
    if (!f || !f.alive) return { ok: false, why: ['勢力がない'] };
    if (/朝廷|寺社|皇族/.test(f.type)) why.push('武家ではない');
    if (f.overlord) why.push('他の勢力に従属している');
    var cap = B(s, f.capital); if (!cap) why.push('本拠がない'); else if (cap.type === '都' || cap.type === '御所') why.push('都・御所は武家政権の本拠にできない');
    var vas = Object.keys(s.factions).filter(function (k) { return s.factions[k].alive && s.factions[k].overlord === fid; }).length;
    if (vas < 3) why.push('主従関係の武士団（御家人）が3つ以上必要（現在' + vas + '）');
    if (f.legitimacy < 35) why.push('正当性が35以上必要（現在' + Math.round(f.legitimacy) + '）');
    return { ok: !why.length, why: why, vassals: vas };
  }
  function foundBakufu(s, fid) {
    var f = F(s, fid);
    if (f.flags.bakufu) return { ok: false, reason: 'すでに武家政権を開いている' };
    var c = bakufuCheck(s, fid); if (!c.ok) return { ok: false, reason: '幕府（武家政権）を開く条件を満たしていない：' + c.why.join('／') };
    f.flags.bakufu = true; f.flags.bakufuDay = s.day; f.status = '幕府'; f.legitimacy = clamp(f.legitimacy + 10, 0, 100); f.institutions = f.institutions || {};
    news(s, '【武家政権の成立】' + f.name + 'が' + B(s, f.capital).name + 'に武家政権（幕府）を開いた。侍所・公文所・問注所などを置けるようになった', { type: 'event', important: true, factions: [fid] });
    aiLog(s, fid, '武家政権を開く', '本拠・御家人' + c.vassals + '・正当性の条件を満たす');
    if (involvesPlayer(s, fid)) stop(s, { key: 'bakufu', title: '武家政権の成立', place: B(s, f.capital).name, persons: [f.leader], text: f.name + 'は' + B(s, f.capital).name + 'に武家政権を開いた。\n（幕府の成立時期は1180年・1183年・1185年・1192年など諸説ある。本作では御家人を統べる本拠を定めた時点を成立とする）\n「幕府」タブから侍所・公文所・問注所を設置できる。', choices: [] });
    return { ok: true, message: '武家政権を開いた' };
  }
  function establishInstitution(s, fid, inst, head) {
    var f = F(s, fid), d = INSTITUTIONS[inst];
    if (!d) return { ok: false, reason: '機関が不明' };
    if (!f.flags.bakufu) return { ok: false, reason: '先に武家政権（幕府）を開く必要がある' };
    f.institutions = f.institutions || {};
    if (f.institutions[inst]) return { ok: false, reason: d.name + 'はすでにある' };
    if (d.requires && !f.institutions[d.requires]) return { ok: false, reason: d.name + 'は' + INSTITUTIONS[d.requires].name + 'を改組して置く（先に' + INSTITUTIONS[d.requires].name + 'が必要）' };
    if (s.options.mode === 'historical' && s.date.y < d.est) return { ok: false, reason: '史実モードでは' + d.name + 'は' + d.est + '年以降に設置できる（' + d.hist + '）' };
    if (f.money < d.money) return { ok: false, reason: '資金不足（' + d.money + '貫が必要）' };
    var hp = head ? Pn(s, head) : null;
    if (head && (!hp || !hp.alive || hp.captiveOf || topLord(s, hp.faction) !== fid)) return { ok: false, reason: '長官は自勢力か御家人から選ぶ' };
    if (!hp) { hp = Object.keys(s.persons).map(function (k) { return s.persons[k]; }).filter(function (p) { return p.alive && !p.captiveOf && topLord(s, p.faction) === fid && p.id !== f.leader && !nonCombatant(p); }).sort(function (a, b) { return (inst === 'samurai_dokoro' ? b.abilities.command - a.abilities.command : b.abilities.politics - a.abilities.politics); })[0]; }
    if (!hp) return { ok: false, reason: '長官に任じる人物がいない' };
    f.money -= d.money;
    if (d.requires) delete f.institutions[d.requires];
    f.institutions[inst] = { head: hp.id, day: s.day, date: dateStr(s) };
    var title = d.name + d.head;
    hp.warriorOffices = (hp.warriorOffices || []).filter(function (o) { return !(d.requires && o.indexOf(INSTITUTIONS[d.requires].name) === 0); }).concat([title]);
    if (inst === 'samurai_dokoro') { f.flags.samuraiDokoro = true; mark(s, 'samurai_dokoro'); }
    if (inst === 'monchujo') f.legitimacy = clamp(f.legitimacy + 5, 0, 100);
    if (inst === 'mandokoro') f.courtRelation = clamp(f.courtRelation + 5, 0, 100);
    news(s, '【' + d.name + '設置】' + f.name + 'が' + d.name + 'を置き、' + hp.name + 'を' + title + 'とした', { type: 'event', important: true, factions: [fid] });
    return { ok: true, message: d.name + 'を設置（' + title + '：' + hp.name + '）。効果：' + d.effect };
  }

  // ================================================================ 出陣（複数の拠点から兵を出し、一つの軍団として目的地へ）
  // 軍団＝総大将のもとに、各拠点（国）から出る部隊（大将＋兵数）をまとめたもの。部隊は各国から目的地へ向かい、合流して戦う。
  function sortieSources(s, fid) {
    var by = {};
    Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction !== fid || b.house) return; var n = Math.max(0, Math.floor(b.strength - b.mobilized)); if (n <= 0) return; by[b.province] = (by[b.province] || 0) + n; });
    return Object.keys(by).map(function (pid) {
      var bases = Object.keys(s.bases).filter(function (k) { return s.bases[k].province === pid && s.bases[k].owner === fid; });
      return { province: pid, available: by[pid], bases: bases, label: bases.length ? B(s, bases[0]).name + '（' + PV(s, pid).name + '）' : PV(s, pid).name + 'の武士団' };
    }).sort(function (a, b) { return b.available - a.available; });
  }
  function sortie(s, cmd) {
    var fid = cmd.faction, f = F(s, fid), units = (cmd.units || []).filter(function (u) { return u && +u.troops > 0; });
    if (!units.length && !(cmd.commanderUnit && +cmd.commanderUnit.troops > 0 && !cmd.join)) return { ok: false, reason: '出陣する部隊がない（兵を出す拠点と兵数を決めること）' };
    var join = cmd.join ? s.corps[cmd.join] : null;
    if (cmd.join && (!join || join.faction !== fid)) return { ok: false, reason: '合流先の軍団がない' };
    var target = join ? (join.target || null) : cmd.target;
    if (join && !target) { var ca = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (x) { return x.corps === join.id; }).sort(function (a, b) { return b.troops - a.troops; })[0]; if (ca) target = { type: 'province', id: ca.province }; }
    if (!target) return { ok: false, reason: '攻め先（目的地）を決めること' };
    var total = units.reduce(function (t, u) { return t + Math.floor(u.troops); }, 0);
    var enemyBase = target.type === 'base' && B(s, target.id).owner && !sameCamp(s, B(s, target.id).owner, fid);
    var commander = join ? join.commander : cmd.commander;
    if (!commander) return { ok: false, reason: '総大将を決めること' };
    // 総大将の部隊（各部隊に割り振った残り）。旧形式（総大将を部隊に含める）にも対応
    var cu0 = units.filter(function (u) { return u.leader === commander; })[0];
    var cmdUnit = join ? null : (cmd.commanderUnit || (cu0 ? { province: cu0.province, troops: cu0.troops } : null));
    units = units.filter(function (u) { return u.leader !== commander; });
    if (cmdUnit && +cmdUnit.troops > 0) units.push({ province: cmdUnit.province, leader: commander, troops: Math.floor(cmdUnit.troops) });
    var stays = !join && !units.some(function (u) { return u.leader === commander; });
    if (!units.length) return { ok: false, reason: '出陣する部隊がない' };
    if (!join && Object.keys(s.corps).some(function (k) { return s.corps[k].commander === commander && s.corps[k].faction === fid; })) return { ok: false, reason: pname(s, commander) + 'はすでに別の軍団の総大将である（その軍への後詰めにすること）' };
    if (stays && !personFree(s, commander, fid)) return { ok: false, reason: pname(s, commander) + 'は他の軍・使者に出ている' };
    var leaders = units.map(function (u) { return u.leader; });
    if (leaders.some(function (x) { return !x; })) return { ok: false, reason: '大将が決まっていない部隊がある' };
    var dup = leaders.concat(cmd.bugyo && !join ? [cmd.bugyo] : []).filter(function (x, i, a) { return a.indexOf(x) !== i; });
    if (dup.length) return { ok: false, reason: pname(s, dup[0]) + 'が二つの役に就いている' };
    leaders.forEach(function () {});
    var busy = leaders.filter(function (l) { return Object.keys(s.corps).some(function (k) { return s.corps[k].commander === l && s.corps[k].remote; }); })[0];
    if (busy) return { ok: false, reason: pname(s, busy) + 'は本陣で別の軍団の采配をしている' };
    var srcs = {}; sortieSources(s, fid).forEach(function (x) { srcs[x.province] = x.available; });
    var useBy = {};
    for (var i = 0; i < units.length; i++) {
      var u = units[i], p = Pn(s, u.leader);
      if (!personFree(s, u.leader, fid)) return { ok: false, reason: pname(s, u.leader) + 'は他の軍・使者に出ているか、家臣ではない' };
      if (nonCombatant(p)) return { ok: false, reason: p.name + 'は大将にできない' };
      if (!personNear(s, u.leader, u.province)) return { ok: false, reason: p.name + 'は' + PV(s, u.province).name + 'から遠く、出陣に間に合わない（約5日以内の距離にいる者だけ）' };
      useBy[u.province] = (useBy[u.province] || 0) + Math.floor(u.troops);
      if (useBy[u.province] > (srcs[u.province] || 0)) return { ok: false, reason: PV(s, u.province).name + 'から出せる兵は' + (srcs[u.province] || 0) + 'まで' };
    }
    var bugyoUnit = null;
    if (cmd.bugyo && !join) {
      if (!personFree(s, cmd.bugyo, fid)) return { ok: false, reason: pname(s, cmd.bugyo) + 'は軍奉行にできない（出払っている）' };
      bugyoUnit = units.filter(function (u) { return u.leader === commander; })[0] || units.slice().sort(function (a, b) { return b.troops - a.troops; })[0]; // 総大将が残るときは最大の部隊に同行
      if (!personNear(s, cmd.bugyo, bugyoUnit.province)) return { ok: false, reason: pname(s, cmd.bugyo) + 'は' + PV(s, bugyoUnit.province).name + 'から遠く、部隊に同行できない' };
    }
    var cost = Math.round(total * 0.08), food = Math.round(total * 0.005 * 40);
    if (f.money < cost) return { ok: false, reason: '資金不足（出陣の費用 ' + cost + '貫）' };
    if (f.food < food * 0.5) return { ok: false, reason: '兵糧不足（' + food + '石が目安）' };
    var roseMsg = join ? null : autoRise(s, fid, target);
    if (enemyBase && !atWar(s, fid, B(s, target.id).owner)) { if (!cmd.declare) return { ok: false, reason: fname(s, B(s, target.id).owner) + 'とは交戦状態にない（宣戦して攻めるか選ぶこと）' }; declareWar(s, fid, B(s, target.id).owner, '出陣'); }
    var cid = join ? join.id : nid(s, 'corps');
    var hq = null;
    if (stays) { // 総大将は本拠点（近ければ）または今いる拠点で待機し、采配する
      var capB = B(s, f.capital), cp0 = Pn(s, commander);
      hq = capB && personNear(s, commander, capB.province) ? capB.id : (B(s, cp0.location) ? cp0.location : (capB ? capB.id : null));
      if (hq) cp0.location = hq;
    }
    if (!join) s.corps[cid] = { id: cid, faction: fid, commander: commander, bugyo: cmd.bugyo || null, target: target, created: s.day, remote: stays, hq: hq, senjin: cmd.senjin || null, callPlan: cmd.callPlan || null };
    var mission = enemyBase ? 'attack' : 'move', made = [], eta = 0;
    units.forEach(function (u) {
      var r = mobilize(s, fid, u.province, Math.floor(u.troops), u.leader, { allowNeighbors: false, divisions: [], bugyo: (bugyoUnit === u) ? cmd.bugyo || null : null, foodDays: 40, force: true });
      if (!r.army) return;
      r.army.corps = cid; setArmyTarget(s, r.army, target, mission); r.army.status = 'gathering';
      var d = estimateDays(s, r.army) + r.gather; eta = Math.max(eta, d);
      made.push(pname(s, u.leader) + '（' + PV(s, u.province).name + '・' + r.army.troops + '・約' + d + '日）');
    });
    if (!made.length) return { ok: false, reason: '兵が集まらなかった' };
    var msg = (join ? pname(s, commander) + 'の軍に後詰めを送った：' : pname(s, commander) + 'を総大将として出陣' + (stays ? '（総大将は' + (hq ? B(s, hq).name : '本陣') + 'に残って采配）' : '') + '：') + made.join('、') + ' → ' + targetName(s, target) + '（全軍の到着まで約' + eta + '日）';
    news(s, msg, { type: 'order', factions: [fid] });
    if (roseMsg) msg += roseMsg;
    if (!join && cmd.call !== false) { if (cmd.waitCall === false) s.corps[cid].wait = false; var lead0 = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (a) { return a.corps === cid; }).sort(function (a, b) { return b.troops - a.troops; })[0];
      var cr = callToArms(s, fid, cid, lead0); if (cr.length) msg += '。参陣：' + cr.map(function (c) { return c.name + c.troops; }).join('・'); }
    return { ok: true, message: msg, corps: cid };
  }
  function oddsFor(s, fid, troops, factor, target) {
    var dpow = 0, dtro = 0;
    if (target.type === 'base') { var b = B(s, target.id); if (!b.owner || sameCamp(s, b.owner, fid)) return null; dpow = b.garrison * 0.9; dtro = b.garrison; provinceArmies(s, b.province).forEach(function (x) { if (sameCamp(s, x.faction, b.owner)) { dpow += x.troops * armyQuality(s, x).factor * (0.4 + x.morale / 110); dtro += x.troops; } }); dpow *= 1 + b.defense / 60; }
    else { provinceArmies(s, target.id).forEach(function (x) { if (atWar(s, fid, x.faction)) { dpow += x.troops * armyQuality(s, x).factor * (0.4 + x.morale / 110); dtro += x.troops; } }); if (!dtro) return null; }
    var mine = troops * factor * (0.4 + 75 / 110) * (1 - 30 / 220) * (target.type === 'base' ? 1.1 : 1);
    var r = mine / Math.max(1, dpow); return { odds: Math.round(Math.pow(r, 2.2) / (1 + Math.pow(r, 2.2)) * 100), enemyTroops: Math.round(dtro), ratio: Math.round(r * 100) / 100 };
  }

  // ================================================================ 徴兵（武士団を増やす）・守備の増強
  // 兵は「武士団」（家ごと・国ごとの動員可能兵力）として存在し、出陣で動員される。
  // 徴兵は、自分の所領・拠点がある国で郎党・所従・駆り武者を新たに召し抱え、その国の武士団を増やす。
  function manpowerCap(s, fid, pid) {
    // 私領・郷・御厨（在地の主従関係が強い）は兵を出しやすく、国衙領（知行国の収入）や荘園は出しにくい
    var W = { '私領': 0.03, '郷': 0.03, '郡': 0.025, '御厨': 0.02, '荘園': 0.012, '寺社領': 0.02, '国衙領': 0.004, '荘園群': 0.002 };
    var out = Object.keys(s.holdings).reduce(function (t, k) { var h = s.holdings[k]; return t + (h.province === pid && h.controller === fid ? h.output * (W[h.type] || 0.01) : 0); }, 0);
    var bases = Object.keys(s.bases).filter(function (k) { return s.bases[k].province === pid && s.bases[k].owner === fid; }).length;
    var f = F(s, fid), tl = f ? F(s, topLord(s, fid)) : null, rf = tl && (tl.status === '挙兵' || tl.status === '幕府') ? tl : f, rally = rf && (rf.status === '挙兵' || rf.status === '幕府') && (rf.flags.ryoji || rf.flags.insen) ? 1 + Math.max(0, rf.legitimacy - 20) / 50 : 1;
    if (f && tl && tl !== f && rally > 1) rally *= 1.15; // 御家人の本領には、主君の旗揚げに応じて在地の武士が加わる // 旗揚げした家には在地の武士が集まる
    return Math.round((out + bases * 200) * rally);
  }
  function bandsIn(s, fid, pid) { return Object.keys(s.bands).map(function (k) { return s.bands[k]; }).filter(function (b) { return b.faction === fid && b.province === pid; }); }
  function recruitInfo(s, fid, pid) {
    var cap = manpowerCap(s, fid, pid), cur = bandsIn(s, fid, pid).filter(function (b) { return !b.house; }).reduce(function (t, b) { return t + b.base; }, 0);
    var pending = s.recruits.filter(function (r) { return r.faction === fid && r.province === pid && !r.house; }).reduce(function (t, r) { return t + r.remaining; }, 0);
    return { cap: cap, current: Math.round(cur), pending: Math.round(pending), room: Math.max(0, Math.round(cap - cur - pending)), costPer: 0.6, foodPer: 0.4 };
  }
  function recruit(s, fid, pid, amount) {
    var f = F(s, fid), pv = PV(s, pid); if (!pv) return { ok: false, reason: '国が不明' };
    var info = recruitInfo(s, fid, pid);
    if (info.cap <= 0) return { ok: false, reason: pv.name + 'に自勢力の所領・拠点がないため兵を集められない' };
    if (provinceArmies(s, pid).some(function (a) { return atWar(s, a.faction, fid); })) return { ok: false, reason: pv.name + 'に敵軍がいて徴兵できない' };
    amount = Math.min(Math.round(amount || info.room), info.room);
    if (amount < 10) return { ok: false, reason: pv.name + 'ではこれ以上兵を集められない（上限' + info.cap + '：所領の石高と拠点から決まる。現在' + info.current + (info.pending ? '・募集中' + info.pending : '') + '）' };
    var cost = Math.round(amount * info.costPer), food = Math.round(amount * info.foodPer);
    if (f.money < cost) return { ok: false, reason: '資金不足（' + cost + '貫が必要）' };
    if (f.food < food) return { ok: false, reason: '兵糧不足（' + food + '石が必要）' };
    f.money -= cost; f.food -= food;
    var days = 20 + Math.round(amount / 40);
    s.recruits.push({ faction: fid, province: pid, remaining: amount, perDay: amount / days, total: amount, started: s.day, days: days });
    pv.unrest = clamp(pv.unrest + amount / 60, 0, 100);
    return { ok: true, message: pv.name + 'で' + amount + '人の徴兵を始めた（費用' + cost + '貫・兵糧' + food + '石。約' + days + '日かけて少しずつ集まり、その国の武士団に加わる）' };
  }
  function progressRecruits(s) {
    s.recruits = s.recruits.filter(function (r) {
      var f = F(s, r.faction); if (!f || !f.alive) return false;
      if (provinceArmies(s, r.province).some(function (a) { return atWar(s, a.faction, r.faction); })) return true; // 敵がいる間は止まる
      var n = Math.min(r.remaining, r.perDay); r.remaining -= n;
      var b = bandsIn(s, r.faction, r.province).filter(function (x) { return (x.house || null) === (r.house || null); })[0];
      if (!b) { var id = nid(s, 'band'); b = s.bands[id] = { id: id, faction: r.faction, house: r.house || undefined, province: r.province, name: r.house ? H(s, r.house).name + 'が召し抱えた兵' : PV(s, r.province).name + 'で召し抱えた兵', strength: 0, base: 0, mobilized: 0, confidence: 'ゲーム設定' }; }
      b.strength += n; b.base += n;
      if (r.remaining <= 0.5) { news(s, (r.house ? H(s, r.house).name + 'の' : '') + PV(s, r.province).name + 'の徴兵が終わった（' + Math.round(r.total) + '人）', { type: 'military', factions: [r.faction] }); return false; }
      return true;
    });
  }
  function reinforceGarrison(s, fid, bid, amount) {
    var b = B(s, bid); if (!b || b.owner !== fid) return { ok: false, reason: '自勢力の拠点を指定すること' };
    var avail = availableBandTroops(s, fid, b.province);
    amount = Math.min(Math.round(amount || avail), avail);
    if (amount < 10) return { ok: false, reason: PV(s, b.province).name + 'に守備へ回せる武士団の兵がいない（先に徴兵を）' };
    var need = amount;
    bandsIn(s, fid, b.province).forEach(function (x) { var n = Math.min(need, Math.floor(x.strength - x.mobilized)); if (n <= 0) return; x.strength -= n; x.base -= n; need -= n; });
    b.garrison += amount - need;
    return { ok: true, message: b.name + 'の守備兵を' + (amount - need) + '増やした（守備' + Math.round(b.garrison) + '）' };
  }

  // ================================================================ 普請（館・城の新築）
  var BUILD = {
    small: { label: '館', type: '館', money: 300, food: 400, days: 45, defense: 15, garrison: 50, note: '堀と塀をめぐらせた居館' },
    medium: { label: '城館', type: '館', money: 1200, food: 1500, days: 100, defense: 30, garrison: 150, note: '土塁・堀・櫓を備えた城館' },
    large: { label: '城郭', type: '城', money: 3000, food: 3500, days: 180, defense: 50, garrison: 300, note: '山や川を利用した大規模な城郭' },
  };
  function buildRights(s, fid, pid) {
    var mine = Object.keys(s.holdings).some(function (k) { var h = s.holdings[k]; return h.province === pid && sameCamp(s, h.controller, fid); });
    var base = Object.keys(s.bases).some(function (k) { var b = s.bases[k]; return b.province === pid && sameCamp(s, b.owner, fid); });
    var inf = provinceInfluence(s, pid).filter(function (x) { return sameCamp(s, x.faction, fid); }).reduce(function (t, x) { return t + x.share; }, 0);
    return { ok: mine || base || inf >= 0.25, mine: mine, base: base, share: inf };
  }
  function startConstruction(s, cmd) {
    var f = F(s, cmd.faction), spec = BUILD[cmd.scale || 'small'], pv = PV(s, cmd.province);
    if (!spec) return { ok: false, reason: '規模は small / medium / large' };
    if (!pv) return { ok: false, reason: '建設する国が不明' };
    var rt = buildRights(s, cmd.faction, cmd.province);
    if (!rt.ok) return { ok: false, reason: pv.name + 'に自勢力の所領・拠点がなく、土地の権利がない（影響力 ' + Math.round(rt.share * 100) + '%、25%以上が必要）' };
    if (provinceArmies(s, cmd.province).some(function (a) { return atWar(s, a.faction, cmd.faction); })) return { ok: false, reason: pv.name + 'に敵軍がいるため普請を始められない' };
    var x = cmd.x, y = cmd.y;
    if (x == null || y == null) { x = pv.x + rr(s, -12, 12); y = pv.y + rr(s, -12, 12); }
    var clash = Object.keys(s.bases).map(function (k) { return s.bases[k]; }).concat(Object.keys(s.constructions).map(function (k) { return s.constructions[k]; }))
      .filter(function (b) { return Math.hypot(b.x - x, b.y - y) < 2.5; })[0];
    if (clash) return { ok: false, reason: '近くに' + clash.name + 'がある（約' + Math.round(Math.hypot(clash.x - x, clash.y - y) / s.meta.map.pxPerKm * 10) / 10 + 'km）。少し離して選ぶこと' };
    var count = Object.keys(s.constructions).filter(function (k) { return s.constructions[k].faction === cmd.faction; }).length;
    if (count >= 3) return { ok: false, reason: '同時に進められる普請は3か所まで' };
    if (f.money < spec.money) return { ok: false, reason: '資金不足（必要 ' + spec.money + '貫、所持 ' + Math.floor(f.money) + '貫）' };
    if (f.food < spec.food) return { ok: false, reason: '兵糧不足（人夫の食料 ' + spec.food + '石が必要、所持 ' + Math.floor(f.food) + '石）' };
    f.money -= spec.money; f.food -= spec.food;
    var id = nid(s, 'build');
    var name = (cmd.name && String(cmd.name).trim()) || (pv.name + 'の新' + spec.label);
    s.constructions[id] = { id: id, faction: cmd.faction, province: cmd.province, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, name: name, scale: cmd.scale || 'small', spec: spec, progress: 0, required: spec.days, started: s.day, threatDays: 0, paused: false };
    var est = Math.round(spec.days / laborRate(s, cmd.province));
    news(s, '【普請開始】' + f.name + 'が' + pv.name + 'で' + name + '（' + spec.label + '）の普請を始めた（完成まで約' + est + '日）', { type: 'build', factions: [cmd.faction], province: cmd.province, important: cmd.faction === s.playerFaction });
    return { ok: true, message: name + '（' + spec.label + '）の普請を開始。費用' + spec.money + '貫・兵糧' + spec.food + '石。完成まで約' + est + '日（約' + Math.round(est / 30 * 10) / 10 + 'か月）。冬の雪国・荒廃・敵の侵入で遅れる', id: id };
  }
  function laborRate(s, pid) {
    var pv = PV(s, pid), r = 1 - pv.devastation / 150 - pv.unrest / 300;
    if (season(s.date) === 'winter' && pv.snowyWinter) r *= 0.4;
    if (s.date.m === 9 || s.date.m === 10) r *= 0.8; // 収穫期は人手が足りない
    return Math.max(0.2, r);
  }
  function progressConstruction(s) {
    Object.keys(s.constructions).forEach(function (k) {
      var c = s.constructions[k], f = F(s, c.faction);
      if (!f || !f.alive) { delete s.constructions[k]; return; }
      var enemy = provinceArmies(s, c.province).some(function (a) { return atWar(s, a.faction, c.faction); });
      if (enemy) {
        c.threatDays += 1; c.paused = true;
        if (c.threatDays === 1) news(s, c.name + 'の普請は敵の侵入で中断している', { type: 'build', factions: [c.faction] });
        if (c.threatDays >= 12) { news(s, '【普請放棄】' + c.name + 'は敵に荒らされ、普請が放棄された', { type: 'build', important: true, factions: [c.faction] }); if (c.faction === s.playerFaction) stop(s, { key: 'build_lost', title: '普請放棄', place: PV(s, c.province).name, text: c.name + 'の普請は敵に荒らされ放棄された。', choices: [] }); delete s.constructions[k]; }
        return;
      }
      c.threatDays = 0; c.paused = false;
      c.progress += laborRate(s, c.province);
      if (c.progress >= c.required) {
        var id = 'built_' + k;
        s.bases[id] = { id: id, name: c.name, province: c.province, type: c.spec.type, owner: c.faction, defense: c.spec.defense, maxDefense: c.spec.defense, garrison: c.spec.garrison, x: c.x, y: c.y, confidence: 'ゲーム設定', note: c.spec.note + '（' + dateStr(s) + '完成）', built: true };
        delete s.constructions[k];
        news(s, '【完成】' + c.name + '（' + c.spec.label + '）が完成した', { type: 'build', important: true, factions: [c.faction], province: c.province });
        if (c.faction === s.playerFaction) stop(s, { key: 'build_done', title: c.name + ' 完成', place: PV(s, c.province).name, text: c.spec.label + 'が完成した。防御 ' + c.spec.defense + '、守備兵 ' + c.spec.garrison + '。本拠に定めることもできる。', choices: [] });
      }
    });
  }

  function cleanup(s) {
    Object.keys(s.armies).forEach(function (k) {
      var a = s.armies[k];
      if (a.troops < 15) { news(s, armyLabel(s, a) + 'は四散した', { type: 'military', factions: [a.faction] }); if (a.battleId) { var bt = s.battles[a.battleId]; if (bt) { bt.sides.att = bt.sides.att.filter(function (x) { return x !== k; }); bt.sides.def = bt.sides.def.filter(function (x) { return x !== k; }); } } releaseArmyPersons(s, a); delete s.armies[k]; return; }
      if (a.commander && !alive(s, a.commander)) { a.commander = a.officers.filter(function (o) { return alive(s, o); })[0] || null; if (a.officers.indexOf(a.commander) >= 0) a.officers.splice(a.officers.indexOf(a.commander), 1); }
      if (a.commander && Pn(s, a.commander).captiveOf) a.commander = null;
    });
    Object.keys(s.corps || {}).forEach(function (cid) { if (!Object.keys(s.armies).some(function (k) { return s.armies[k].corps === cid; })) delete s.corps[cid]; });
    Object.keys(s.factions).forEach(function (k) {
      var f = s.factions[k]; if (!f.alive || k === 'court') return;
      if (k === s.playerFaction && factionBases(s, k).length) s.flags.playerHadBase = true;
      if (k === s.playerFaction && s.flags.playerHadBase && !factionBases(s, k).length) { destroyFaction(s, f, 'すべての拠点を失った'); return; }
      if (!factionBases(s, k).length && !factionArmies(s, k).length && !Object.keys(s.envoys).some(function (e) { return s.envoys[e].faction === k; })) {
        if (!alive(s, f.leader) || Pn(s, f.leader).captiveOf) destroyFaction(s, f, '拠点と軍勢を失った');
        else if (f.status !== '流浪') { f.status = '流浪'; news(s, f.name + 'は拠点を失い流浪の身となった', { factions: [k], important: true }); }
      }
      if (f.capital && B(s, f.capital) && B(s, f.capital).owner !== k) { var rest = factionBases(s, k); f.capital = rest.length ? rest[0].id : null; }
    });
  }

  // ================================================================ 外交
  function proposeDiplomacy(s, fid, toFid, kind, personId) {
    var f = F(s, fid), t = F(s, toFid);
    if (!t || !t.alive) return { ok: false, reason: '相手勢力が存在しない' };
    if (!t.capital) return { ok: false, reason: t.name + 'には使者を送る拠点がない' };
    var from = personId && s.persons[personId] ? personLocationProvince(s, Pn(s, personId)) : (B(s, f.capital) || {}).province;
    if (!from) return { ok: false, reason: '使者の出発地が不明' };
    var v = sendEnvoy(s, fid, personId, from, t.capital, { kind: 'diplomacy', proposal: kind, from: fid, to: toFid });
    if (!v) return { ok: false, reason: '経路がない' };
    var days = travelDays(s, from, B(s, t.capital).province, 45);
    return { ok: true, message: (personId ? pname(s, personId) : '使者') + 'が' + t.name + 'へ出発（到着まで約' + days + '日）', envoy: v.id };
  }
  function personLocationProvince(s, p) {
    if (!p.location) return null;
    if (p.location.indexOf('army:') === 0) { var a = s.armies[p.location.slice(5)]; return a ? a.province : null; }
    if (p.location.indexOf('envoy:') === 0) return null;
    var b = B(s, p.location); return b ? b.province : null;
  }
  function diplomacyArrive(s, v, dest, to, p) {
    var f = F(s, p.from), t = F(s, p.to); if (!t || !t.alive) return;
    var r = rel(s, p.from, p.to);
    var envoyDip = v.person && s.persons[v.person] ? s.persons[v.person].abilities.diplomacy : 50;
    var myP = campPower(s, p.from), theirP = campPower(s, p.to);
    var score = r.value + (envoyDip - 50) * 0.5 + rr(s, -15, 15), accept = false, txt = '';
    switch (p.proposal) {
      case 'alliance': accept = score > 20 && !atWar(s, p.from, p.to); if (accept) { r.status = '同盟'; r.value = clamp(r.value + 20, -100, 100); } txt = '同盟'; break;
      case 'vassal_request': // 相手を従属させる（主従締結を求める）
        score += (myP / Math.max(1, theirP) - 1) * 30 + (f.legitimacy - 40) * 0.4 + (f.flags.ryoji ? 8 : 0) + (t.policy.indexOf('源氏') >= 0 && f.id === 'yoritomo' ? 20 : 0);
        accept = score > 35 && !t.overlord && t.id !== 'court' && ['kiso', 'kai', 'yoritomo', 'heike', 'oshu'].indexOf(t.id) < 0;
        if (accept) { t.overlord = p.from; t.pledgedDay = s.day; r.status = '主従'; r.war = false; r.value = clamp(r.value + 25, -100, 100); inheritWars(s, t.id, p.from); }
        txt = '臣従の要求'; break;
      case 'submit': accept = !atWar(s, p.from, p.to) || score > -30; if (accept) { f.overlord = p.to; f.pledgedDay = s.day; r.status = '主従'; r.war = false; inheritWars(s, f.id, p.to); } txt = '臣従の申し入れ'; break;
      case 'peace': accept = atWar(s, p.from, p.to) && (score + (myP - theirP) / Math.max(1, theirP) * 20) > 10; if (accept) { r.war = false; r.status = '和睦'; } txt = '和睦'; break;
      case 'break': r.status = '敵対'; r.value -= 30; accept = true; txt = '同盟破棄'; break;
    }
    r.value = clamp(r.value + (accept ? 5 : -5), -100, 100);
    var msg = fname(s, p.from) + 'の' + txt + 'を' + t.name + 'が' + (accept ? '受け入れた' : '拒んだ');
    news(s, '【外交】' + msg, { type: 'diplomacy', important: involvesPlayer(s, p.from) || involvesPlayer(s, p.to), factions: [p.from, p.to] });
    aiLog(s, p.to, txt + (accept ? '受諾' : '拒否'), '関係' + Math.round(r.value) + '／評価値' + Math.round(score) + '／兵力比 ' + Math.round(myP) + ':' + Math.round(theirP));
    if (p.from === s.playerFaction || p.to === s.playerFaction) stop(s, { key: 'diplomacy', title: '使者の返答', place: dest.name, text: msg, choices: [] });
    // 使者は帰還
    if (v.person && s.persons[v.person]) s.persons[v.person].location = f.capital;
  }
  function inheritWars(s, vassal, lord) {
    Object.keys(s.factions).forEach(function (k) { if (k !== vassal && k !== lord && rel(s, lord, k).war) { rel(s, vassal, k).war = true; } });
    // 旧主との関係
    Object.keys(s.factions).forEach(function (k) { var f = s.factions[k]; if (k !== lord && f.overlord === undefined) return; });
  }
  function declareWar(s, a, b, why) {
    var r = rel(s, a, b); if (r.war) return;
    r.war = true; r.status = '敵対'; r.value = Math.min(r.value, -40);
    // 主従の連鎖：互いの家臣も交戦状態
    Object.keys(s.factions).forEach(function (k) {
      var f = s.factions[k]; if (!f.alive) return;
      if (f.overlord === a && k !== b) rel(s, k, b).war = true;
      if (f.overlord === b && k !== a) rel(s, k, a).war = true;
    });
    news(s, '【開戦】' + fname(s, a) + 'と' + fname(s, b) + 'が交戦状態に入った' + (why ? '（' + why + '）' : ''), { type: 'diplomacy', important: true, factions: [a, b] });
  }
  function changeAllegiance(s, fid, newLord, reason) {
    var f = F(s, fid), old = f.overlord;
    if (old === newLord) return;
    if (old) { var r0 = rel(s, fid, old); r0.status = '敵対'; r0.value = -50; r0.war = true; }
    f.overlord = newLord; f.pledgedDay = s.day; f.switches = (f.switches || 0) + (old ? 1 : 0); var r = rel(s, fid, newLord); r.status = '主従'; r.war = false; r.value = Math.max(r.value, 50);
    Object.keys(s.factions).forEach(function (k) { if (k !== fid && k !== newLord && rel(s, newLord, k).war) rel(s, fid, k).war = true; });
    news(s, '【去就】' + f.name + 'が' + fname(s, newLord) + 'に属した' + (old ? '（' + fname(s, old) + 'から離反）' : '') + '。' + (reason || ''), { type: 'politics', important: true, factions: [fid, newLord] });
    aiLog(s, fid, fname(s, newLord) + 'に帰属', reason || '');
    if (involvesPlayer(s, newLord) || (old && involvesPlayer(s, old))) stop(s, { key: 'allegiance', title: f.name + 'の去就', text: f.name + 'が' + fname(s, newLord) + 'に味方した。' + (reason || ''), choices: [] });
  }

  // ================================================================ 朝廷
  // ================================================================ 朝廷の派閥政治（v0.8）
  // 派閥は「影響力」と「各武家への態度（-100〜100）」を持ち、申請の可否・院宣・摂関交代・皇位継承を左右する。
  var CLIQUES0 = {
    in:      { name: '院方（後白河法皇と院近臣）', leader: 'goshirakawa', members: [], influence: 10, attitude: { heike: -45, yoritomo: 15, mochihito: 25, kiso: 5 }, interest: '院政の回復と平家の排除', confidence: '史実', note: '治承三年の政変で院政停止・鳥羽殿に幽閉（史実）' },
    sekkan:  { name: '摂関家（九条兼実ら）', leader: 'kanezane', members: [], influence: 16, attitude: { heike: -15 }, interest: '摂関の地位と家領の保全', confidence: '有力説', note: '兼実は『玉葉』で平家に批判的（有力説）' },
    tenno:   { name: '天皇側近（高倉院・安徳天皇の周辺）', leader: 'takakura', members: ['tsunemune'], influence: 20, attitude: { heike: 35 }, interest: '高倉院政と幼帝の保護', confidence: '推定', note: '経宗の所属はゲーム上の推定' },
    shinhei: { name: '親平家の公家（近衛基通ら）', leader: 'motomichi', members: [], influence: 30, attitude: { heike: 65, yoritomo: -30, mochihito: -30 }, interest: '平家との縁による地位', confidence: '史実', note: '基通は清盛の娘・完子を室とし、政変後に関白（史実）' },
    jisha:   { name: '寺社と結ぶ公家（南都・北嶺の縁者）', leader: null, members: [], influence: 8, attitude: { heike: -20, nanto: 40, enryakuji: 30, onjoji: 30 }, interest: '寺社の権益と所領の保護', confidence: 'ゲーム設定', note: '特定の人物を立てない合議の集まりとして扱う' },
  };
  var TPL = { // CPUの評定・朝廷の動きの言い回し（生成AIは使わない。数パターンから選ぶ）
    attack: ['{L}は{A}らと評定し、{T}を攻めると決した。「{T}の守りは{S}ほど、いまが好機」と{A}が説いた。', '{A}の進言を容れ、{L}は{T}への出陣を命じた。', '{L}は「{T}を取れば{R}」と述べ、{A}らに兵を集めさせた。'],
    opportunity: ['{L}は{E}の主力が{W}に出払っていると見て、{A}らと評定し、{T}への進軍を決めた。', '{A}が「{E}の兵はいま{W}にある。{T}は手薄だ」と説き、{L}は出陣を決した。', '{E}が{W}で手一杯のうちに、と{L}は{T}を衝くことにした。'],
    hold_food: ['兵糧が乏しく、{A}は出陣に反対した。{L}は攻勢を見送った。', '{L}は「兵糧なくして戦はできぬ」として{T}攻めを先送りした。'],
    hold_home: ['{A}は「いま兵を出せば{H}が空になる」と諫め、{L}は{T}攻めを見送った。', '{H}の守りを案じ、{L}は兵を動かさなかった。'],
    hold_keep: ['{A}は「{T}を落としても周りの敵に奪い返される」と述べ、{L}は出陣を思いとどまった。'],
    defend: ['{A}は「{H}を失えば家が保てぬ」と述べ、{L}はただちに兵を呼び戻した。', '{H}に敵が迫ったとの報せに、{L}は急ぎ守りを固めさせた。'],
    insen: ['後白河法皇は{W}を頼みとし、密かに院宣を下した。', '院の近臣が{W}のもとへ院宣を携えて下った。'],
    purge: ['法皇は{W}の武威を背に、{C}の公家を解官した。', '{W}の兵が都を固めるなか、院は{C}に連なる公家の官を解いた。'],
    regent: ['{W}の意を受け、{P}が{T}に任じられた。前任の{Q}は退いた。', '朝廷では{Q}に代わり{P}が{T}となった。{W}の推挙による。'],
    enthrone: ['天皇が都を離れたまま、院は{P}を新帝に立てた。', '帝位は空けておけぬとして、院の詔で{P}が践祚した。'],
    sway: ['{C}は{W}に{D}。', '{C}の公家たちは{W}に{D}。'],
  };
  function tpl(s, key, v) { var a = TPL[key]; var t = a[Math.floor(rand(s) * a.length)]; return t.replace(/\{(\w)\}/g, function (m, k) { return v[k] != null ? v[k] : ''; }); }
  function ensureCourt(s) {
    var c = s.court; if (c.cliques) return;
    c.cliques = JSON.parse(JSON.stringify(CLIQUES0)); Object.keys(c.cliques).forEach(function (k) { var x = c.cliques[k]; x.id = k; x.bias = JSON.parse(JSON.stringify(x.attitude)); x.favor = {}; }); c.lastGift = {};
    // 旧データの dominance に混じっていた 'in'・'sekkan' は派閥の影響力に移す
    ['in', 'sekkan'].forEach(function (k) { if (c.dominance[k] != null) { c.cliques[k].influence = Math.max(c.cliques[k].influence, c.dominance[k]); delete c.dominance[k]; } });
    delete c.dominance.others;
    c.gaiseki = c.gaiseki || (s.persons.antoku && s.persons.antoku.alive ? 'heike' : null); // 安徳天皇の母は清盛の娘・徳子（史実）
    c.emperorAwaySince = null; c.lastInsen = c.lastInsen || {};
  }
  function cliqueAtt(s, c, fid) {
    var t = topLord(s, fid), f = F(s, t); if (!f) return 0;
    var v = c.attitude[t]; if (v == null) v = attTarget(s, c, t);
    return clamp(v, -100, 100);
  }
  // 態度の目標値＝史実上の傾き（bias）＋いまの状況＋献金の恩（favor）。毎月この値へ少しずつ近づく
  function attTarget(s, c, t) {
    var f = F(s, t), ctrl = s.court.controller, v = (c.bias && c.bias[t] != null ? c.bias[t] : 0) + (f.legitimacy - 45) / 2 + (c.favor && c.favor[t] || 0);
    if (f.type === '寺社') v += c.id === 'jisha' ? 30 : -5;
    var inVsCtrl = c.id === 'in' && ctrl !== t && (c.attitude[ctrl] != null ? c.attitude[ctrl] : 0) < 0; // 院は自分を抑える家の宣旨を重んじない
    if (f.flags.choteki && !(c.id === 'shinhei' && t === 'heike') && !inVsCtrl) v -= 25;
    if (t === ctrl) v += c.id === 'in' && s.court.dharmaEmperorConfined ? -25 : 12;
    if (c.id === 'in' && inVsCtrl && atWar(s, t, ctrl)) v += 20;
    if (c.id === 'tenno' && t === s.court.gaiseki) v += 30;
    if (c.grudge && c.grudge[t]) v -= c.grudge[t];
    return clamp(v, -100, 100);
  }
  function courtSupport(s, fid) { // -1〜1：派閥の影響力で重みづけた支持
    ensureCourt(s); var cl = s.court.cliques, tot = 0, sum = 0;
    Object.keys(cl).forEach(function (k) { var c = cl[k]; if (c.leader && !alive(s, c.leader) && !c.members.some(function (m) { return alive(s, m); })) return; tot += c.influence; sum += c.influence * cliqueAtt(s, c, fid) / 100; });
    return tot ? sum / tot : 0;
  }
  function insenAvailable(s) { var c = s.court; return !c.dharmaEmperorConfined && s.day - (c.lastInsenAny == null ? -999 : c.lastInsenAny) >= 180 && alive(s, 'goshirakawa') && Pn(s, 'goshirakawa').location !== null && !/^army:/.test(String(Pn(s, 'goshirakawa').location)); }
  function grantInsen(s, fid, target, why) {
    var c = s.court, f = F(s, fid); f.legitimacy = clamp(f.legitimacy + 8, 0, 100); f.flags.insen = s.day; c.lastInsen[fid] = s.day; c.lastInsenAny = s.day;
    c.edicts.push({ type: '院宣', target: target || fid, requester: fid, date: dateStr(s), day: s.day });
    if (target) { var t = F(s, target); if (t) { t.legitimacy = clamp(t.legitimacy - 12, 0, 100); } }
    var txt = tpl(s, 'insen', { W: f.name }) + (target ? '（' + fname(s, target) + 'を討てとの院宣）' : '');
    news(s, '【院宣】' + txt, { type: 'court', important: true, factions: [fid].concat(target ? [target] : []) });
    aiLog(s, 'court', '院宣を' + f.name + 'へ', why || txt, txt);
  }
  function cliqueOf(s, pid) { var cl = s.court.cliques || {}; return Object.keys(cl).filter(function (k) { return cl[k].leader === pid || cl[k].members.indexOf(pid) >= 0; })[0] || null; }
  // 毎月：朝廷の内部政治（CPU）
  function courtPolitics(s) {
    ensureCourt(s); var c = s.court, cl = c.cliques, ctrl = c.controller = courtController(s), cf = F(s, ctrl), capB = B(s, c.location);
    // 0) 都の武力：山城を実際に押さえる陣営へ朝廷の主導権が移っていく
    var cap = capB ? capB.province : 'yamashiro', inf = provinceInfluence(s, cap)[0], holder = inf ? topLord(s, inf.faction) : null;
    if (holder && holder !== 'court' && F(s, holder) && F(s, holder).type !== '寺社') {
      Object.keys(c.dominance).forEach(function (k) { if (k !== holder) c.dominance[k] = Math.max(0, c.dominance[k] - ((c.dominance[holder] || 0) > 50 ? 6 : 3)); });
      c.dominance[holder] = Math.min(100, (c.dominance[holder] || 0) + 6);
      if (holder !== ctrl && (c.dominance[holder] || 0) > (c.dominance[ctrl] || 0)) { var prev = ctrl; ctrl = c.controller = holder; cf = F(s, ctrl);
        news(s, '【朝廷】都を押さえた' + cf.name + 'が朝廷の主導権を握った（' + fname(s, prev) + 'に代わって）', { type: 'court', important: true, factions: [holder, prev] }); aiLog(s, 'court', cf.name + 'が朝廷を主導', '山城の実効支配'); }
    }
    // 1) 影響力の変動：都を握る武家と結ぶ派閥が伸び、対立する派閥が細る
    Object.keys(cl).forEach(function (k) { var x = cl[k], a = cliqueAtt(s, x, ctrl);
      if (x.leader && !alive(s, x.leader) && !x.members.some(function (m) { return alive(s, m); })) { x.influence = Math.max(0, x.influence - 4); return; }
      x.influence = clamp(x.influence + (a > 30 ? 1.5 : a < -20 ? -1.5 : 0), 2, 60); });
    // 幽閉の解除：幽閉した清盛が世を去るか、平家が朝廷の主導権を失えば、法皇は院政に戻りうる
    if (c.dharmaEmperorConfined && alive(s, 'goshirakawa') && (ctrl !== 'heike' || !alive(s, 'kiyomori') || F(s, 'heike').leader !== 'kiyomori') && rand(s) < 0.15) {
      c.dharmaEmperorConfined = false; var gp = Pn(s, 'goshirakawa'); gp.status = '法皇（院政）'; if (!gp.location || /^army:/.test(String(gp.location))) gp.location = c.location;
      cl.in.influence = Math.min(60, cl.in.influence + 15); cl.tenno.influence = Math.max(3, cl.tenno.influence - 8);
      news(s, '【院政再開】後白河法皇の幽閉が解かれ、院政が再び始まった', { type: 'court', important: true }); aiLog(s, 'court', '法皇の幽閉解除', ctrl !== 'heike' ? '平家が朝廷の主導権を失った' : '清盛の死去', '幽閉を命じた者が去り、法皇はふたたび政務をみることとなった。');
    }
    if (c.dharmaEmperorConfined) cl.in.influence = Math.min(cl.in.influence, 12); else if (alive(s, 'goshirakawa')) cl.in.influence = Math.min(50, cl.in.influence + 2);
    if (c.gaiseki && F(s, c.gaiseki) && F(s, c.gaiseki).alive) c.dominance[c.gaiseki] = Math.min(100, (c.dominance[c.gaiseki] || 0) + 1); // 外戚の家は朝廷での足場を保つ
    // 2) 態度の変動：目標値へ毎月1割ずつ近づく。献金の恩は毎月5%ずつ薄れる
    Object.keys(s.factions).forEach(function (fid) { var f = s.factions[fid]; if (!f.alive || fid === 'court' || f.overlord) return;
      var big = campPower(s, fid) > 2500 || fid === ctrl;
      Object.keys(cl).forEach(function (k) { var x = cl[k]; x.favor = x.favor || {}; if (x.favor[fid]) x.favor[fid] *= 0.95;
        if (!big && x.attitude[fid] == null) return; var v = x.attitude[fid] != null ? x.attitude[fid] : attTarget(s, x, fid);
        x.attitude[fid] = Math.round((v + (attTarget(s, x, fid) - v) * 0.1) * 10) / 10; }); });
    // 2.5) 押領の恨み：本所（朝廷・寺社）の年貢を押さえる家は、摂関家・寺社派に疎まれる
    Object.keys(s.lastOryo || {}).forEach(function (who) { var o = s.lastOryo[who], lord = topLord(s, who);
      Object.keys(o).forEach(function (vict) { var x = vict === 'court' ? cl.sekkan : (F(s, vict) && F(s, vict).type === '寺社' ? cl.jisha : null); if (!x) return; x.grudge = x.grudge || {}; x.grudge[lord] = Math.min(35, (x.grudge[lord] || 0) + Math.min(2, o[vict] * 0.2)); }); });
    Object.keys(cl).forEach(function (k) { var g = cl[k].grudge; if (g) Object.keys(g).forEach(function (w) { if (!(s.lastOryo || {})[w] && k !== 'jisha') g[w] = Math.max(0, g[w] - 1); }); });
    kokugaReview(s);
    // 3) 院の動き：院宣・解官
    if (insenAvailable(s)) {
      var cands = Object.keys(s.factions).filter(function (k) { var f = s.factions[k]; return f.alive && !f.overlord && k !== ctrl && k !== 'court' && f.type !== '寺社' && cliqueAtt(s, cl.in, k) >= 25 && atWar(s, k, ctrl) && campPower(s, k) > 1500 && (c.lastInsen[k] == null || s.day - c.lastInsen[k] > 360); })
        .sort(function (a, b) { return cliqueAtt(s, cl.in, b) + campPower(s, b) / 400 - cliqueAtt(s, cl.in, a) - campPower(s, a) / 400; });
      if (cands[0] && rand(s) < 0.25) grantInsen(s, cands[0], null, '法皇は都を握る' + fname(s, ctrl) + 'に対抗する力として' + fname(s, cands[0]) + 'を頼んだ（院方の態度' + Math.round(cliqueAtt(s, cl.in, cands[0])) + '）');
      if (cl.in.influence >= 25 && cliqueAtt(s, cl.in, ctrl) >= 30) {
        var foe = Object.keys(cl).filter(function (k) { return k !== 'in' && cl[k].influence > 10 && cliqueAtt(s, cl[k], ctrl) < -15; }).sort(function (a, b) { return cl[b].influence - cl[a].influence; })[0];
        if (foe && rand(s) < 0.3) { cl[foe].influence -= 10; cl.in.influence += 5; var t1 = tpl(s, 'purge', { W: cf.name, C: cl[foe].name });
          news(s, '【解官】' + t1, { type: 'court', important: true }); aiLog(s, 'court', cl[foe].name + 'を解官', '院方の影響力' + Math.round(cl.in.influence) + '・' + cf.name + 'の後ろ盾', t1); }
      }
    }
    // 4) 摂関の交代：都を握る武家に近い摂関家筋の派閥が摂関の座を求める
    var rc = cliqueOf(s, c.regent), best = ['sekkan', 'shinhei'].filter(function (k) { return cl[k].leader && alive(s, cl[k].leader); }).sort(function (a, b) { return cl[b].influence * (100 + cliqueAtt(s, cl[b], ctrl)) - cl[a].influence * (100 + cliqueAtt(s, cl[a], ctrl)); })[0];
    if (best && best !== rc && cl[best].influence * (100 + cliqueAtt(s, cl[best], ctrl)) > (rc && cl[rc] ? cl[rc].influence * (100 + cliqueAtt(s, cl[rc], ctrl)) : 0) * 1.3 && rand(s) < 0.2) {
      var old = c.regent, np = cl[best].leader; c.regent = np; var t2 = tpl(s, 'regent', { W: cf.name, P: pname(s, np), Q: pname(s, old), T: c.regentTitle });
      news(s, '【摂関交代】' + t2, { type: 'court', important: true }); aiLog(s, 'court', pname(s, np) + 'が' + c.regentTitle + 'に', cl[best].name + 'の影響力と' + cf.name + 'との近さ', t2);
    }
    // 5) 皇位：天皇が都を離れたまま、または崩御
    var emp = Pn(s, c.emperor), capB = B(s, c.location);
    var away = !emp || !emp.alive || (emp.location !== c.location && !(capB && B(s, emp.location) && B(s, emp.location).province === capB.province));
    if (away) { if (c.emperorAwaySince == null) c.emperorAwaySince = s.day; } else c.emperorAwaySince = null;
    if (away && c.emperorAwaySince != null && s.day - c.emperorAwaySince >= 25 && insenAvailable(s)) enthrone(s, emp);
  }
  function enthrone(s, prev) {
    var c = s.court, np = s.persons.gotoba;
    if (!np || !np.alive || c.emperor === 'gotoba') { // 後鳥羽天皇がすでに立っているなど：架空の皇子（ゲーム設定）
      var id = 'prince_' + s.day; np = s.persons[id] = { id: id, name: '新帝（皇子）', kana: '', born: s.date.y - 3, died: null, birthConfidence: 'ゲーム設定', faction: 'court', status: '天皇', rank: '（天皇）', courtOffices: [], warriorOffices: [], abilities: { command: 5, valor: 5, politics: 10, intellect: 10, diplomacy: 10 }, abilitiesConfidence: 'ゲーム設定', personality: '幼帝', ambition: 0, loyalty: 100, relations: [], location: c.location, alive: true, health: 90, captiveOf: null, naturalDeath: null, note: 'ゲーム上の皇位継承者' };
    }
    if (prev && prev.alive) { c.rivalEmperor = { person: prev.id, with: prev.location && B(s, prev.location) ? B(s, prev.location).owner : null, since: s.day }; prev.status = '天皇（都を離れた帝）'; }
    c.emperor = np.id; np.status = '天皇'; np.location = c.location; c.emperorAwaySince = null;
    var old = c.gaiseki; c.gaiseki = null; // 新帝の母方（後鳥羽なら坊門家）は武家ではない
    if (old && c.dominance[old]) c.dominance[old] = Math.max(0, c.dominance[old] - 15);
    s.court.cliques.in.influence = Math.min(60, s.court.cliques.in.influence + 10);
    var t = tpl(s, 'enthrone', { P: np.name }); news(s, '【践祚】' + t, { type: 'court', important: true });
    aiLog(s, 'court', np.name + 'の践祚', prev ? prev.name + 'が都を離れて' + (s.day - (c.emperorAwaySince || s.day)) + '日' : '天皇の崩御', t);
    stop(s, { key: 'enthrone', title: '新帝の践祚', persons: [np.id], text: t + (c.rivalEmperor ? '\n' + pname(s, c.rivalEmperor.person) + 'も帝位にあり、二人の天皇が並び立つ。' : ''), choices: [] });
  }
  // 献金・儀式の支援：派閥の態度を上げる
  function courtGift(s, fid, cid, amount) {
    ensureCourt(s); var f = F(s, fid), x = s.court.cliques[cid]; amount = Math.floor(amount || 0);
    if (!x) return { ok: false, reason: '派閥が不明' }; if (amount < 100) return { ok: false, reason: '献金は100貫から' }; if (f.money < amount) return { ok: false, reason: '銭が足りない' };
    var lg = s.court.lastGift = s.court.lastGift || {}, key = fid + ':' + cid;
    if (lg[key] != null && s.day - lg[key] < 60) return { ok: false, reason: '同じ派閥への献金は2か月に一度まで（前回から' + (s.day - lg[key]) + '日）' };
    f.money -= amount; lg[key] = s.day; var t = topLord(s, fid), cur = cliqueAtt(s, x, fid);
    var eff = cid === 'in' && t === s.court.controller && s.court.dharmaEmperorConfined ? 0.3 : 1; // 法皇を幽閉している家の献金は響かない
    var up = Math.round(amount / 60 * eff * (cur > 50 ? 0.5 : 1)); x.favor = x.favor || {}; x.favor[t] = Math.min(40, (x.favor[t] || 0) + up);
    x.attitude[t] = clamp(cur + up, -100, 100); x.influence = Math.min(60, x.influence + amount / 1500);
    f.courtRelation = clamp(f.courtRelation + amount / 300, 0, 100);
    news(s, f.name + 'が' + x.name + 'へ' + amount + '貫を献じた（態度 +' + up + '）', { type: 'court', factions: [fid] });
    return { ok: true, message: x.name + 'へ' + amount + '貫を献じた。態度 ' + Math.round(cur) + '→' + Math.round(cur + up) };
  }
  function courtController(s) { var d = s.court.dominance, best = 'heike', bv = -1; Object.keys(d).forEach(function (k) { if (d[k] > bv) { bv = d[k]; best = k; } }); return best; }
  function petitionCourt(s, fid, kind, target, extra) {
    var f = F(s, fid), c = s.court;
    var cap = B(s, f.capital); var dist = cap ? travelDays(s, cap.province, B(s, c.location).province, 45) : 10;
    if (kind === 'tsuito') {
      var t = F(s, target); if (!t || !t.alive) return { ok: false, reason: '対象勢力がない' };
      if (!atWar(s, fid, target)) return { ok: false, reason: t.name + 'とは交戦状態にない。追討の名目が立たない' };
      if (t.flags.choteki) return { ok: false, reason: t.name + 'はすでに追討の対象である' };
      if (t.id === 'court') return { ok: false, reason: '朝廷を追討の対象にはできない' };
      var influence = courtInfluence(s, fid), tInf = courtInfluence(s, target), sd = courtSupport(s, fid) - courtSupport(s, target);
      var p = clamp(0.12 + (influence - tInf) / 200 + sd * 0.55 + (f.legitimacy - t.legitimacy) / 300, 0.03, 0.97);
      c.pendingPetitions.push({ id: nid(s, 'pet'), from: fid, kind: kind, target: target, decideDay: s.day + dist + Math.round(rr(s, 3, 8)), chance: p });
      return { ok: true, message: '追討宣旨の申請を朝廷へ送った（審議・伝達におよそ' + (dist + 5) + '日。見込み ' + Math.round(p * 100) + '%）' };
    }
    if (kind === 'appointment') {
      var person = Pn(s, extra.person), office = s.offices.filter(function (o) { return o.id === extra.office || o.name === extra.office; })[0];
      if (!person || !person.alive || person.faction !== fid) return { ok: false, reason: '自勢力の存命人物を指定してください' };
      if (!office) return { ok: false, reason: '官職が見つからない' };
      if (office.category === '武家役職') return { ok: false, reason: office.name + 'は武家の役職であり、朝廷の除目では任じられない' };
      if (office.established > s.date.y) return { ok: false, reason: office.name + 'は' + office.established + '年成立で、この時代にはまだ存在しない' };
      if (f.flags.choteki) return { ok: false, reason: '朝敵とされている間は任官できない' };
      var inf = courtInfluence(s, fid);
      var sup = courtSupport(s, fid), rcl = s.court.cliques[cliqueOf(s, s.court.regent)] || null; // 除目は摂関と院の意向が大きい
      var pr = clamp(0.05 + inf / 220 + sup * 0.45 + (rcl ? cliqueAtt(s, rcl, fid) / 400 : 0) + (insenAvailable(s) ? cliqueAtt(s, s.court.cliques.in, fid) / 400 : 0) + (extra.gift || 0) / 20000, 0.02, 0.9);
      if (['sadaijin', 'udaijin', 'daijodaijin', 'sessho', 'kampaku', 'naidaijin'].indexOf(office.id) >= 0 && !/公卿|摂関家/.test(person.status)) pr *= 0.1;
      c.pendingPetitions.push({ id: nid(s, 'pet'), from: fid, kind: kind, person: person.id, office: office.id, decideDay: s.day + dist + 10, chance: pr, gift: extra.gift || 0 });
      if (extra.gift) f.money -= extra.gift;
      return { ok: true, message: person.name + 'の' + office.name + '任官を申請（見込み ' + Math.round(pr * 100) + '%。摂関・院・公家の派閥の態度で決まる）' };
    }
    if (kind === 'kokushi') return petitionKokushi(s, fid, extra.province || target);
    if (kind === 'insen') { // 院宣を求める：法皇が自由の身であることが要る
      if (!insenAvailable(s)) return { ok: false, reason: s.court.dharmaEmperorConfined ? '法皇は幽閉されており、院宣は出ない' : '法皇が院宣を出せる状態にない' };
      if (s.court.lastInsen[fid] != null && s.day - s.court.lastInsen[fid] < 120) return { ok: false, reason: '先の院宣から日が浅い' };
      var ai = cliqueAtt(s, s.court.cliques.in, fid), pi = clamp(0.05 + (ai + 10) / 110 + (target && atWar(s, fid, target) ? 0.05 : 0), 0.02, 0.92);
      c.pendingPetitions.push({ id: nid(s, 'pet'), from: fid, kind: 'insen', target: target || null, decideDay: s.day + dist + 4, chance: pi });
      return { ok: true, message: '院宣を求める使いを送った' + (target ? '（' + fname(s, target) + '追討）' : '') + '（見込み ' + Math.round(pi * 100) + '%。院方の態度 ' + Math.round(ai) + '）' };
    }
    return { ok: false, reason: '未対応の申請' };
  }
  function courtInfluence(s, fid) {
    var f = F(s, fid); if (!f) return 0;
    var d = s.court.dominance[fid] || 0;
    var ranks = factionPersons(s, fid).reduce(function (t, p) { var i = s.ranks.indexOf(p.rank.replace(/（.*）/, '')); return t + (i >= 0 && i < 6 ? (6 - i) * 2 : 0); }, 0);
    return d + f.courtRelation * 0.3 + f.legitimacy * 0.2 + ranks;
  }
  function courtTick(s) {
    var c = s.court;
    var due = c.pendingPetitions.filter(function (p) { return p.decideDay <= s.day; });
    c.pendingPetitions = c.pendingPetitions.filter(function (p) { return p.decideDay > s.day; });
    due.forEach(function (p) {
      var ok = rand(s) < p.chance;
      if (p.kind === 'tsuito') {
        if (ok) issueTsuito(s, p.target, p.from);
        else { news(s, '朝廷は' + fname(s, p.from) + 'の追討申請を退けた', { type: 'court', factions: [p.from], important: p.from === s.playerFaction }); if (p.from === s.playerFaction) stop(s, { key: 'court', title: '追討申請 却下', text: '朝廷は追討宣旨を出さなかった。', choices: [] }); }
      } else if (p.kind === 'kokushi') {
        var kpv = PV(s, p.province);
        if (ok && kpv) { kpv.kokuga.holder = p.from; kpv.kokuga.confidence = 'ゲーム展開'; ensureHoldings(s); Object.keys(s.holdings).forEach(function (k) { var x = s.holdings[k]; if (x.province === p.province && x.type === '国衙領') x.rights.taxHolder = p.from; }); news(s, '【除目】' + fname(s, p.from) + 'が' + kpv.name + 'の知行国を得た（国衙領の年貢を取る）', { type: 'court', important: true, factions: [p.from] }); }
        else news(s, fname(s, p.from) + 'の' + (kpv ? kpv.name : '') + '知行国の申請は退けられた', { type: 'court', factions: [p.from], important: p.from === s.playerFaction });
        if (p.from === s.playerFaction) stop(s, { key: 'court', title: '知行国の申請', text: ok ? kpv.name + 'の知行国主となった。国衙領の年貢の6割が入る。' : '申請は退けられた。', choices: [] });
      } else if (p.kind === 'insen') {
        if (ok && insenAvailable(s)) grantInsen(s, p.from, p.target, fname(s, p.from) + 'の求めに応じて');
        else news(s, '法皇は' + fname(s, p.from) + 'に院宣を与えなかった', { type: 'court', factions: [p.from], important: p.from === s.playerFaction });
        if (p.from === s.playerFaction) stop(s, { key: 'court', title: '院宣の結果', text: ok ? '院宣を得た（正当性 +8）。' : '院宣は得られなかった。院方の態度を上げるには献金・儀式の支援を。', choices: [] });
      } else if (p.kind === 'appointment') {
        var person = Pn(s, p.person), office = s.offices.filter(function (o) { return o.id === p.office; })[0];
        if (ok && person && person.alive) { person.courtOffices.push(office.name); F(s, p.from).courtRelation = clamp(F(s, p.from).courtRelation + 5, 0, 100); news(s, '【除目】' + person.name + 'が' + office.name + 'に任じられた', { type: 'court', important: true, factions: [p.from] }); }
        else news(s, '【除目】' + (person ? person.name : '') + 'の' + (office ? office.name : '') + '任官は見送られた', { type: 'court', factions: [p.from] });
        if (p.from === s.playerFaction) stop(s, { key: 'court', title: '任官の結果', text: ok ? person.name + 'が' + office.name + 'に任じられた。' : '任官は見送られた。', choices: [] });
      }
    });
  }
  function issueTsuito(s, target, requester) {
    var t = F(s, target); if (!t || !t.alive) return;
    t.flags.choteki = true; t.legitimacy = clamp(t.legitimacy - 25, 0, 100);
    var rf = F(s, requester); if (rf) rf.legitimacy = clamp(rf.legitimacy + 10, 0, 100);
    s.court.edicts.push({ type: '追討宣旨', target: target, requester: requester, date: dateStr(s), day: s.day });
    s.firedEvents['tsuito_' + target] = s.day;
    news(s, '【追討宣旨】朝廷は' + t.name + 'の追討を命じた（' + fname(s, requester) + 'の申請）。諸国の武士に参陣が求められる', { type: 'court', important: true, factions: [target, requester] });
    broadcast(s, 'tsuito_' + target, B(s, s.court.location).province, '朝廷が' + t.name + '追討の宣旨を下した');
    stop(s, { key: 'tsuito_senji', title: '追討宣旨', place: B(s, s.court.location).name, persons: [], text: '朝廷は' + t.name + 'を追討する宣旨を下した。宣旨は正当性を与えるが、すべての武士が従うわけではない。各勢力は利害に応じて参加・静観を判断する。', choices: [] });
  }

  // ================================================================ AI
  function runAI(s) {
    courtTick(s);
    var ids = Object.keys(s.factions);
    if (s.date.d === 2) ids.forEach(function (fid) { var f = s.factions[fid]; if (f.alive && fid !== s.playerFaction && fid !== 'court') { try { aiDomestic(s, f); } catch (e) { aiLog(s, fid, 'エラー', String(e && e.message)); } } });
    var urgent = s.aiUrgent || {}; s.aiUrgent = {};
    ids.forEach(function (fid, idx) {
      var f = s.factions[fid]; if (!f.alive || fid === s.playerFaction || fid === 'court') return;
      if (urgent[fid] && B(s, urgent[fid])) council(s, fid, 'defend', { H: B(s, urgent[fid]).name }, '緊急の評定', B(s, urgent[fid]).name + 'が攻められた');
      if ((s.day + idx) % s.options.aiInterval !== 0 && !urgent[fid]) return;
      try { aiFaction(s, f); } catch (e) { aiLog(s, fid, 'エラー', String(e && e.message)); }
    });
    // プレイヤー勢力の家臣（主従関係にある勢力）は AI が動かす（上で処理済み）。プレイヤー軍の兵糧切れ警告
    if (s.playerFaction) factionArmies(s, s.playerFaction).forEach(function (a) { if (a.food > 0 && a.food < a.troops * 0.005 * 3 && s.day % 3 === 0) news(s, armyLabel(s, a) + 'の兵糧が残りわずか', { type: 'military', factions: [s.playerFaction] }); });
  }
  // 内政（月に一度）：徴兵・兵糧の購入・守備の増強・普請・寄進
  function aiDomestic(s, f) {
    var fid = f.id, done = [];
    aiRegime(s, f);
    if (f.flags.bakufu && jitoAllowed(s)) { var nj = 0; Object.keys(s.holdings).forEach(function (k) { if (nj >= 4) return; var h = s.holdings[k]; if (h.controller && topLord(s, h.controller) === fid && h.rights && !h.rights.jito && (SHARES[h.type] || {}).tax > 0 && f.money > 300) { if (appointJito(s, fid, k).ok) { nj++; } } }); if (nj) done.push('地頭' + nj + 'か所'); }
    var atwar = enemiesOf(s, fid).length > 0, cap = B(s, f.capital);
    // 1) 徴兵：余裕のある国から（戦時は積極的に）
    var budget = f.money * (atwar ? 0.35 : 0.15);
    if (budget > 120) {
      var provs = {}; Object.keys(s.bases).forEach(function (k) { if (s.bases[k].owner === fid) provs[s.bases[k].province] = 1; }); Object.keys(s.bands).forEach(function (k) { if (s.bands[k].faction === fid) provs[s.bands[k].province] = 1; });
      Object.keys(provs).map(function (pid) { return { pid: pid, info: recruitInfo(s, fid, pid) }; }).filter(function (x) { return x.info.room >= 50; })
        .sort(function (a, b) { return b.info.room - a.info.room; }).slice(0, 2).forEach(function (x) {
          var n = Math.min(x.info.room, Math.floor(budget / 0.6)); if (n < 50) return;
          var r = recruit(s, fid, x.pid, n); if (r.ok) { budget -= n * 0.6; done.push(PV(s, x.pid).name + 'で' + n + '人徴兵'); }
        });
    }
    // 2) 兵糧：出陣中の軍の60日分を下回れば購入
    var need = factionArmies(s, fid).reduce(function (t, a) { return t + a.troops * 0.005 * 60; }, 0) + 500;
    if (f.food < need && f.money > 600) { var amt = Math.min(Math.round(need - f.food), Math.floor(f.money * 0.3)); if (amt > 100) { f.money -= amt; f.food += amt; done.push('兵糧' + amt + '石を購入'); } }
    // 3) 本拠の守備：脅威があれば武士団から守備へ
    if (cap && atwar && cap.garrison < 300) { var r2 = reinforceGarrison(s, fid, cap.id, 200); if (r2.ok) done.push(cap.name + 'の守備を増強'); }
    // 4) 普請：富裕で城がなければ本拠の国に城館を
    if (cap && f.money > 5000 && !atwar && !Object.keys(s.constructions).some(function (k) { return s.constructions[k].faction === fid; }) && !factionBases(s, fid).some(function (b) { return b.built; }) && rand(s) < 0.3) {
      var r3 = startConstruction(s, { faction: fid, province: cap.province, scale: f.money > 9000 ? 'large' : 'medium', x: cap.x + rr(s, -6, 6), y: cap.y + rr(s, -6, 6) });
      if (r3.ok) done.push('普請を開始');
    }
    // 5) 寄進：朝廷との関係が低く余裕があれば寺社へ
    if (f.money > 3000 && f.courtRelation < 50 && rand(s) < 0.25) {
      var t = Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.type === '寺社' && b.owner !== fid && !(b.owner && atWar(s, fid, b.owner)); })[0];
      if (t) { var r4 = executeCommand(s, { type: 'donate', faction: fid, base: t.id, amount: 300 }); if (r4.ok) done.push(t.name + 'へ寄進'); }
    }
    if (done.length) aiLog(s, fid, '内政：' + done.join('・'), '資金' + Math.round(f.money) + '貫・兵糧' + Math.round(f.food) + '石' + (atwar ? '・戦時' : ''));
  }
  function enemiesOf(s, fid) { return Object.keys(s.factions).filter(function (k) { return s.factions[k].alive && atWar(s, fid, k); }); }
  function baseStrength(s, b) { var t = b.garrison * (1 + b.defense / 60); provinceArmies(s, b.province).forEach(function (a) { if (sameCamp(s, a.faction, b.owner)) t += a.troops; }); return t; }
  var DIST_CACHE = {}; // 国と国の距離（街道は変わらないのでシナリオごとに覚えておく）
  function distProv(s, a, b) { if (a === b) return 0; var ck = s.scenarioId + ':' + (a < b ? a + '|' + b : b + '|' + a), v = DIST_CACHE[ck]; if (v != null) return v; var p = findPath(s, a, b, null); v = p ? pathKm(s, p) : 9999; DIST_CACHE[ck] = v; return v; }

  // ---- 評定（CPUの判断を言葉にする）
  function advisorOf(s, fid) {
    var f = F(s, fid), ps = factionPersons(s, fid).filter(function (p) { return p.id !== f.leader && !p.captiveOf; }).sort(function (a, b) { return b.abilities.intellect - a.abilities.intellect; });
    return ps[0] ? ps[0].name : '老臣たち';
  }
  function council(s, fid, key, v, action, reason) {
    var f = F(s, fid); v = v || {}; var ln = f.leader && Pn(s, f.leader) ? Pn(s, f.leader).name : null; v.L = v.L || ln || f.name.replace(/（.*）/, ''); v.A = v.A || advisorOf(s, fid);
    var sp = tpl(s, key, v); aiLog(s, fid, action, reason, sp); return sp;
  }
  // 敵陣営の兵のうち、目標から遠い戦線に出ている割合（隙）
  function awayRatio(s, owner, pid) {
    var lord = topLord(s, owner), away = 0, home = 0, where = null, wmax = 0;
    Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (topLord(s, a.faction) !== lord) return; var d = distProv(s, a.province, pid);
      if (d > 200 || (a.battleId && d > 60)) { away += a.troops; if (a.troops > wmax) { wmax = a.troops; where = PV(s, a.province).name; } } else home += a.troops; });
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (b.owner && topLord(s, b.owner) === lord && distProv(s, b.province, pid) <= 150) home += b.garrison; });
    Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction && topLord(s, b.faction) === lord && distProv(s, b.province, pid) <= 150) home += Math.max(0, b.strength - b.mobilized) * 0.5; });
    return { ratio: away + home > 0 ? away / (away + home) : 0, where: where, away: away };
  }
  function nearEnemyPower(s, fid, pid, km, bandW) { // 半径内の敵の野戦軍＋動員できる兵の一部（守り切れるかの目安）
    var t = 0; bandW = bandW == null ? 0.25 : bandW;
    Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (atWar(s, fid, a.faction) && distProv(s, a.province, pid) <= km) t += a.troops; });
    if (bandW) Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction && atWar(s, fid, b.faction) && distProv(s, b.province, pid) <= km) t += Math.max(0, b.strength - b.mobilized) * bandW; });
    return t;
  }
  function aiFaction(s, f) {
    var fid = f.id;
    aiUprising(s, f);
    aiAlignment(s, f);
    aiCourt(s, f);
    if (!f.alive) return;
    var enemies = enemiesOf(s, fid);
    var myArmies = factionArmies(s, fid).filter(function (a) { return !a.joinCorps && !(a.lordOrder && a.lordOrder.until > s.day); }); // 参陣中・主君の指図で動く軍は任せる
    var capB = B(s, f.capital);
    // 1) 退却判断
    myArmies.forEach(function (a) {
      if (a.status === 'battle' || a.status === 'retreating' || a.status === 'gathering') return;
      var atHome = a.status === 'idle' && Object.keys(s.bases).some(function (bk) { var b = s.bases[bk]; return b.province === a.province && sameCamp(s, b.owner, a.faction); });
      if (!atHome && (a.morale < 28 || (a.food <= 0 && a.troops > 50))) { aiLog(s, fid, armyLabel(s, a) + '撤退', '士気' + Math.round(a.morale) + '・兵糧' + Math.round(a.food)); retreat(s, a); }
    });
    // 遊軍の整理：同じ国の小部隊を統合、長く遊んでいる軍は解散
    var idleArm = myArmies.filter(function (a) { return a.status === 'idle' && !a.battleId; });
    idleArm.forEach(function (a) {
      if (!s.armies[a.id]) return;
      var host = idleArm.filter(function (b) { return b !== a && s.armies[b.id] && b.province === a.province && b.troops >= a.troops; })[0];
      if (host && a.troops < 600) { host.troops += a.troops; host.food += a.food; host.bands = host.bands.concat(a.bands); host.initialTroops += a.initialTroops; releaseArmyPersons(s, a); delete s.armies[a.id]; aiLog(s, fid, armyLabel(s, host) + 'に小部隊を統合', '指揮系統の一本化'); }
    });
    myArmies = factionArmies(s, fid);
    // 着いたまま止まっている軍・守る相手のいない守備軍を遊軍に戻す（世界が凍りつくのを防ぐ）
    myArmies.forEach(function (a) {
      if (a.battleId || !s.armies[a.id]) return;
      if (a.status === 'arrived') { a.status = 'idle'; if (a.mission === 'attack' || a.mission === 'move') a.mission = 'idle'; }
      if (a.status === 'idle' && a.mission === 'defend' && a.idleDays > 25 && localEnemyPower(s, fid, a.province, true) < a.troops * 0.3) { a.mission = 'idle'; aiLog(s, fid, armyLabel(s, a) + 'の守りを解く', '敵が近くにいない'); }
    });
    myArmies.forEach(function (a) { if (a.status === 'idle' && !a.battleId && a.idleDays > 30 && a.mission !== 'defend') { aiLog(s, fid, armyLabel(s, a) + 'を解散', '長期の対陣で兵糧と士気が尽きる前に帰国'); disbandArmy(s, a, 'garrison'); } });
    myArmies = factionArmies(s, fid);
    if (!enemies.length) {
      // 平時：遊軍は帰還・解散
      myArmies.forEach(function (a) { if (a.status === 'idle' && a.idleDays > 8 && !a.battleId) { aiLog(s, fid, armyLabel(s, a) + 'を解散', '交戦相手がいない'); disbandArmy(s, a, 'garrison'); } });
      return;
    }
    // 1.5) 劣勢の反乱勢力：当主を味方になり得る勢力の近くへ逃がし、再起を図る（例：石橋山の後の安房渡海）
    if ((f.status === '挙兵' || f.status === '幕府') && !f.overlord) aiFlight(s, f);
    myArmies = factionArmies(s, fid);
    // 2) 防衛：自拠点に迫る敵
    var threats = [];
    factionBases(s, fid).forEach(function (b) {
      var near = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (x) {
        if (!atWar(s, fid, x.faction)) return false;
        if (x.province === b.province) return true;
        if (x.target && x.target.type === 'base' && x.target.id === b.id) return true;
        return neighbors(s, b.province).some(function (rid) { var e = s.roads[rid]; return e.a === x.province || e.b === x.province; }) && x.troops > b.garrison;
      });
      if (near.length) threats.push({ base: b, enemy: near.reduce(function (t, x) { return t + x.troops; }, 0) });
    });
    threats.sort(function (a, b) { return (b.base.id === f.capital) - (a.base.id === f.capital) || b.enemy - a.enemy; });
    // 当主・一門の避難：守り切れない拠点からは脱出する
    threats.forEach(function (th) {
      if (baseStrength(s, th.base) > th.enemy * 0.7) return;
      factionPersons(s, fid).forEach(function (p) {
        if (p.location !== th.base.id || p.captiveOf) return;
        var safe = factionArmies(s, fid).filter(function (a) { return a.troops > th.enemy * 0.5 && a.province !== th.base.province; }).sort(function (a, b) { return b.troops - a.troops; })[0];
        var refuge = safe ? null : factionBases(s, fid).concat(Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.owner && b.owner !== fid && sameCamp(s, b.owner, fid); })).filter(function (b) { return !threats.some(function (t2) { return t2.base.id === b.id; }); }).filter(function (b) { return b.id !== th.base.id && baseStrength(s, b) > th.enemy * 0.5; })[0];
        if (safe) { p.location = 'army:' + safe.id; if (safe.officers.indexOf(p.id) < 0 && safe.commander !== p.id) safe.officers.push(p.id); aiLog(s, fid, p.name + 'が' + armyLabel(s, safe) + 'へ逃れる', th.base.name + 'は守り切れない'); }
        else if (refuge) { p.location = refuge.id; aiLog(s, fid, p.name + 'が' + refuge.name + 'へ逃れる', th.base.name + 'は守り切れない'); }
      });
    });
    if (threats.length) {
      var th = threats[0], mine = baseStrength(s, th.base);
      if (mine < th.enemy * 1.1) {
        var av = availableBandTroops(s, fid, th.base.province);
        if (av > 50) { var r = mobilize(s, fid, th.base.province, Math.min(av, Math.round(th.enemy * 1.3)), null, { base: th.base.id, foodDays: 20 }); if (r.army) { r.army.mission = 'defend'; aiLog(s, fid, th.base.name + 'の防衛に' + r.army.troops + 'を動員', '敵兵' + Math.round(th.enemy) + 'が接近'); } }
        // 野戦軍を呼び戻す
        myArmies.forEach(function (a) { if (a.status === 'idle' && a.province !== th.base.province && distProv(s, a.province, th.base.province) < 250) { setArmyTarget(s, a, { type: 'base', id: th.base.id }, 'defend'); aiLog(s, fid, armyLabel(s, a) + 'を' + th.base.name + 'へ', '本拠防衛'); } });
      }
    }
    // 3) 攻勢：目標の選定
    var targets = [];
    var offensives = myArmies.filter(function (a) { return a.mission === 'attack' && (a.status === 'marching' || a.status === 'gathering' || a.status === 'battle' || a.status === 'siege'); });
    var maxOff = fid === 'heike' ? 3 : 1;
    function tooEarly(owner, d) { // 挙兵の報が届き、兵を集めるまでの猶予（近くの豪族ほど早い）
      var lord = F(s, topLord(s, owner)); if (!lord || !lord.flags || lord.flags.roseDay == null) return false;
      var wait = (d <= 90 ? 10 : (d <= 250 ? 25 : 45)) * (topLord(s, owner) === s.playerFaction ? diff(s).grace : 1); return s.day - lord.flags.roseDay < wait;
    }
    function priorityEnemy(owner) { // 平家は反乱勢力・朝敵を優先し、それ以外は本拠近辺のみ
      if (fid !== 'heike') return true; var lord = F(s, topLord(s, owner));
      return lord.status === '挙兵' || lord.status === '幕府' || lord.flags.choteki;
    }
    Object.keys(s.bases).forEach(function (k) {
      var b = s.bases[k]; if (!b.owner || !enemies.some(function (e) { return e === b.owner || topLord(s, b.owner) === topLord(s, e); })) return;
      if (!priorityEnemy(b.owner) && capB && distProv(s, capB.province, b.province) > 120) return;
      if (offensives.some(function (a) { return a.target && a.target.type === 'base' && a.target.id === b.id; })) return;
      if (b.id === 'heiankyo' || b.id === 'toba') return; // 都・御所は直接攻撃しない
      var from = capB ? capB.province : (myArmies[0] || {}).province; if (!from) return;
      var d = distProv(s, from, b.province); if (d > aiReach(s, f)) return;
      if (tooEarly(b.owner, d)) return;
      if (histMode(s) && fid === 'heike' && d > 250) return; // 史実モード：平家の大遠征は予定表（追討軍）で行う
      var str = baseStrength(s, b);
      var value = 30 + (F(s, b.owner).capital === b.id ? 40 : 0) + (b.type === '城' ? 10 : 0) + (b.id === 'rokuhara' || b.id === 'fukuhara' ? 30 : 0);
      if (b.type === '寺社') value -= 25 + (fid === 'heike' ? 0 : 20);
      var aw = awayRatio(s, b.owner, b.province), opp = aw.ratio * 40;                      // 敵の主力が別の戦線にいる＝好機
      var keep = nearEnemyPower(s, fid, b.province, 120) - str;                            // 落とした後に周りの敵に奪い返されないか
      var keepPen = keep > campPower(s, fid) * 0.6 ? 20 : 0;
      var wb = weaknessBonus(s, b.owner);
      targets.push({ base: b, str: str, d: d, score: value - d / 12 - str / 60 + opp - keepPen + wb, opp: aw, keepPen: keepPen, weak: wb >= 10 });
    });
    // 敵野戦軍も目標（近距離）
    Object.keys(s.armies).forEach(function (k) {
      var x = s.armies[k]; if (!atWar(s, fid, x.faction) || x.status === 'battle' || !priorityEnemy(x.faction)) return;
      if (offensives.some(function (a) { return a.target && a.target.type === 'province' && a.target.id === x.province; })) return;
      var from = capB ? capB.province : null; if (!from) return;
      var d = distProv(s, from, x.province); if (d > aiReach(s, f) * 0.6) return;
      if (tooEarly(x.faction, d) && !factionBases(s, fid).some(function (b) { return b.province === x.province; })) return;
      if (histMode(s) && fid === 'heike' && d > 250) return;
      targets.push({ army: x, str: x.troops, d: d, score: 25 - d / 10 - x.troops / 80 + (x.faction === topLord(s, x.faction) && F(s, x.faction).leader === x.commander ? 25 : 0) });
    });
    targets.sort(function (a, b) { return b.score - a.score; });
    var idle = myArmies.filter(function (a) { return a.status === 'idle' && a.mission !== 'defend' && !a.battleId; });
    var idleTroops = idle.reduce(function (t, a) { return t + a.troops; }, 0);
    var homeProv = capB ? capB.province : null;
    var avail = homeProv ? availableBandTroops(s, fid, null) : 0;
    for (var i = 0; i < Math.min(3, targets.length); i++) {
      if (offensives.length >= maxOff) break;
      var tg = targets[i], need = tg.str * (tg.base ? 1.6 : 1.3) + 50;
      if (fid === 'heike' && tg.d > 300) need = Math.max(need, 3500); // 遠征は大軍で（追討軍）
      var tname = tg.base ? tg.base.name : armyLabel(s, tg.army), quiet = f.ai.lastHold != null && s.day - f.ai.lastHold < 30;
      // 兵糧：出陣する兵のおよそ45日分がなければ見送る
      if (f.food < need * 0.005 * 45 && !(tg.base && capB && tg.base.province === capB.province)) { if (!quiet) { f.ai.lastHold = s.day; council(s, fid, 'hold_food', { T: tname }, '攻勢を見送り', '兵糧' + Math.round(f.food) + '／必要' + Math.round(need * 0.005 * 45)); } break; }
      // 本拠が空にならないか：近くの敵に対し、出陣後の本拠の守りが薄すぎれば見送る
      if (capB) { var homeEnemy = nearEnemyPower(s, fid, capB.province, 150, 0.1), homeLeft = baseStrength(s, capB) + Math.max(0, availableBandTroops(s, fid, capB.province) - need * 0.5);
        var vassalRisk = Object.keys(s.factions).some(function (k) { var v = s.factions[k]; return v.alive && v.overlord === fid && rel(s, k, fid).value < -10; }); // 裏切りの気配があれば余力を残す
        if (homeEnemy > homeLeft * (vassalRisk ? 1.1 : 1.6) && tg.d > 120) { if (!quiet) { f.ai.lastHold = s.day; council(s, fid, 'hold_home', { T: tname, H: capB.name }, '攻勢を見送り', capB.name + '近くの敵' + Math.round(homeEnemy) + '・出陣後の守り' + Math.round(homeLeft) + (vassalRisk ? '・家臣に離反の気配' : '')); } continue; } }
      if (tg.keepPen && i === 0 && targets.length > 1 && !quiet) { f.ai.lastHold = s.day; council(s, fid, 'hold_keep', { T: tname }, tname + '攻めを見送り', '周囲の敵が多く、落としても保てない'); continue; }
      var oppTxt = tg.opp && tg.opp.ratio > 0.4 && tg.opp.where ? tg.opp : null;
      function decided(army) {
        var reason = '目標兵力' + Math.round(tg.str) + '・距離' + Math.round(tg.d) + 'km・評価' + Math.round(tg.score) + (oppTxt ? '・敵兵の' + Math.round(oppTxt.ratio * 100) + '%が' + oppTxt.where + '方面' : '');
        var gain = tg.base ? (F(s, tg.base.owner).capital === tg.base.id ? fname(s, tg.base.owner) + 'の本拠を衝ける' : (tg.base.type === '城' ? '要害が手に入る' : PV(s, tg.base.province).name + 'に足場ができる')) : '敵の軍勢を討てる';
        var sp = tg.weak && !oppTxt ? (function () { var t = tplFrom(s, REGIME_TPL.rival_weak, { L: (Pn(s, f.leader) || {}).name || f.name, A: advisorOf(s, fid), E: fname(s, tg.base.owner).replace(/（.*）/, ''), T: tname }); aiLog(s, fid, (army ? armyLabel(s, army) + 'で' : '') + tname + 'を攻撃', reason + '・相手の家中が不安定', t); return t; })() : oppTxt ? council(s, fid, 'opportunity', { E: fname(s, tg.base ? tg.base.owner : tg.army.faction).replace(/（.*）/, ''), W: oppTxt.where, T: tname }, (army ? armyLabel(s, army) + 'で' : '') + tname + 'を攻撃', reason)
                        : council(s, fid, 'attack', { T: tname, S: Math.round(tg.str / 100) * 100 || Math.round(tg.str), R: gain }, (army ? armyLabel(s, army) + 'で' : '') + tname + 'を攻撃', reason);
        if (oppTxt && (tg.base ? topLord(s, tg.base.owner) : topLord(s, tg.army.faction)) !== s.playerFaction) news(s, '【評定】' + sp, { type: 'politics', factions: [fid] });
      }
      // 既存の遊軍で足りる？
      var cand = idle.filter(function (a) { return a.troops >= need * 0.8; }).sort(function (a, b) { return distProv(s, a.province, tg.base ? tg.base.province : tg.army.province) - distProv(s, b.province, tg.base ? tg.base.province : tg.army.province); })[0];
      if (cand) {
        var err = tg.base ? setArmyTarget(s, cand, { type: 'base', id: tg.base.id }, 'attack') : setArmyTarget(s, cand, { type: 'province', id: tg.army.province }, 'attack');
        if (!err) { offensives.push(cand); decided(cand); idle.splice(idle.indexOf(cand), 1); }
        continue;
      }
      if (myArmies.filter(function (a) { return a.status === 'gathering'; }).length) break;
      if (avail + idleTroops < need) { if (i === 0) aiLog(s, fid, '攻勢を見送り', (tg.base ? tg.base.name : armyLabel(s, tg.army)) + 'の兵力' + Math.round(tg.str) + 'に対し動員可能' + Math.round(avail)); continue; }
      // 動員地：自勢力の武士団が最も多い国（目標に近い方を優先）
      var bandProvs = {};
      Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction === fid && b.strength - b.mobilized > 50) bandProvs[b.province] = (bandProvs[b.province] || 0) + b.strength - b.mobilized; });
      var tp = tg.base ? tg.base.province : tg.army.province;
      var bp = Object.keys(bandProvs).sort(function (a, b) { return (bandProvs[b] - distProv(s, b, tp) * 3) - (bandProvs[a] - distProv(s, a, tp) * 3); })[0];
      if (!bp) break;
      var vsP = s.playerFaction && topLord(s, tg.base ? tg.base.owner : tg.army.faction) === topLord(s, s.playerFaction) ? diff(s).enemy : 1;
      var r2 = mobilize(s, fid, bp, Math.round((fid === 'heike' ? need * 1.15 : Math.min(bandProvs[bp] + 400, need * 1.2)) * vsP), null, { foodDays: 40 });
      if (r2.army) offensives.push(r2.army);
      if (r2.army && retainersOf(s, fid).length && rand(s) < 0.7) { var acid = nid(s, 'corps'); s.corps[acid] = { id: acid, faction: fid, commander: r2.army.commander, bugyo: null, target: tg.base ? { type: 'base', id: tg.base.id } : { type: 'province', id: tp }, created: s.day, remote: false, hq: null, contingents: [] }; r2.army.corps = acid; s._pendingCall = { cid: acid, army: r2.army.id }; }
      if (r2.army) {
        if (tg.base) setArmyTarget(s, r2.army, { type: 'base', id: tg.base.id }, 'attack'); else setArmyTarget(s, r2.army, { type: 'province', id: tp }, 'attack');
        r2.army.status = 'gathering';
        decided(r2.army);
        if (s._pendingCall && s._pendingCall.army === r2.army.id) { callToArms(s, fid, s._pendingCall.cid, r2.army); s._pendingCall = null; }
        news(s, fname(s, fid) + 'が' + PV(s, bp).name + 'で兵を集めている（' + r2.army.troops + '）', { type: 'military', factions: [fid], province: bp });
        break;
      } else if (i === 0) aiLog(s, fid, '動員失敗', r2.error);
    }
    // 3.5) 武家政権の整備（AI）
    if (f.flags.bakufu) { ['samurai_dokoro', 'kumonjo', 'monchujo', 'mandokoro'].some(function (k) { if ((f.institutions || {})[k] || s.day - (f.flags.bakufuDay || 0) < 60) return false; if (INSTITUTIONS[k].requires && !(f.institutions || {})[INSTITUTIONS[k].requires]) return false; var r = establishInstitution(s, fid, k); if (r.ok) aiLog(s, fid, INSTITUTIONS[k].name + 'を設置', '武家政権の整備'); return r.ok; }); }
    else if (['yoritomo', 'kiso', 'kai'].indexOf(fid) >= 0 && !histMode(s) && bakufuCheck(s, fid).ok) foundBakufu(s, fid);
    // 4) 家臣化の勧誘（挙兵した源氏など）
    if (f.ai.lastInvite == null || s.day - f.ai.lastInvite > 20) aiInvite(s, f);
  }
  function localEnemyPower(s, fid, pid, armiesOnly) {
    var t = 0; Object.keys(s.armies).forEach(function (k) { var x = s.armies[k]; if (!atWar(s, fid, x.faction)) return; if (x.province === pid || neighbors(s, pid).some(function (rid) { var e = s.roads[rid]; return e.a === x.province || e.b === x.province; })) t += x.troops; });
    if (!armiesOnly) Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (b.owner && atWar(s, fid, b.owner) && b.province === pid) t += b.garrison; });
    return t;
  }
  function aiFlight(s, f) {
    var leader = Pn(s, f.leader); if (!leader || !leader.alive || leader.captiveOf) return;
    var lp = personLocationProvince(s, leader); if (!lp) return;
    var army = String(leader.location).indexOf('army:') === 0 ? s.armies[leader.location.slice(5)] : null;
    if (army && (army.status === 'battle' || (army.mission === 'flight' && army.status === 'marching'))) return;
    if (f.ai.lastFlight != null && s.day - f.ai.lastFlight < 25) return;
    if (s.day - (s.firedEvents[f.id + '_uprising'] || 0) < 6) return;
    var mine = 0; Object.keys(s.armies).forEach(function (k) { var x = s.armies[k]; if (sameCamp(s, x.faction, f.id) && x.province === lp) mine += x.troops; });
    var enemy = localEnemyPower(s, f.id, lp, true);
    if (enemy < mine * 1.6 || enemy < 300) return;
    // 逃げ先：関係が良く交戦していない勢力の本拠の国、または自陣営の拠点
    var cands = [];
    Object.keys(s.factions).forEach(function (k) {
      var t = s.factions[k]; if (!t.alive || k === f.id || !t.capital || atWar(s, f.id, k)) return;
      var r = sameCamp(s, k, f.id) ? 60 : rel(s, f.id, k).value; if (r < 0) return;
      var pv = B(s, t.capital).province, path = findPath(s, lp, pv, f.id); if (!path) return;
      var danger = localEnemyPower(s, f.id, pv, true), pw = factionPower(s, k);
      cands.push({ prov: pv, who: t.name, score: r + Math.min(25, (pw.available + pw.garrison) / 60) - pathKm(s, path) / 5 - danger / 30 });
    });
    cands.sort(function (a, b) { return b.score - a.score; });
    if (!cands.length || cands[0].prov === lp) return;
    if (!army) { // 当主が拠点にいる場合は小勢を率いて脱出
      var r = mobilize(s, f.id, lp, Math.max(30, Math.min(200, availableBandTroops(s, f.id, lp))), leader.id, { foodDays: 15, defensive: true, allowNeighbors: false });
      army = r.army || createArmy(s, f.id, lp, 30, leader.id, { food: 10, name: leader.name + '主従' });
      army.status = 'idle'; army.gatherUntil = null;
    }
    var avoid = {}; Object.keys(s.armies).forEach(function (k) { var x = s.armies[k]; if (atWar(s, f.id, x.faction)) avoid[x.province] = 1; });
    var path = findPath(s, lp, cands[0].prov, f.id, avoid); if (!path) return;
    f.ai.lastFlight = s.day;
    army.target = { type: 'province', id: cands[0].prov }; army.path = path.slice(1); army.edge = null; army.base = null; army.status = 'marching'; army.mission = 'flight';
    news(s, leader.name + 'は劣勢を悟り、' + cands[0].who + 'を頼って' + PV(s, cands[0].prov).name + 'へ逃れる', { type: 'military', important: true, factions: [f.id] });
    aiLog(s, f.id, PV(s, cands[0].prov).name + 'へ退避', '周辺の敵' + Math.round(enemy) + '／味方' + Math.round(mine) + '。' + cands[0].who + 'を頼る（評価' + Math.round(cands[0].score) + '）');
  }
  function aiReach(s, f) {
    if (f.id === 'heike') return 900;
    if (f.type.indexOf('寺社') >= 0) return 50;
    if (f.id === 'oshu') return 200;
    if (['yoritomo', 'kiso', 'kai'].indexOf(f.id) >= 0) return 160 + Math.min(400, campPower(s, f.id) / 12);
    return 130; // 在地の武士団は本領の近くでしか戦わない
  }

  function aiInvite(s, f) {
    if (f.overlord || ['yoritomo', 'kiso', 'kai', 'heike'].indexOf(f.id) < 0 || !enemiesOf(s, f.id).length) return;
    var capB = B(s, f.capital); if (!capB) return;
    var cands = Object.keys(s.factions).map(function (k) { return s.factions[k]; }).filter(function (t) {
      return t.alive && t.id !== f.id && !t.overlord && /東国武士団|地方武士団/.test(t.type) && ['kiso', 'kai', 'yoritomo'].indexOf(t.id) < 0 && !atWar(s, f.id, t.id) && t.capital && distProv(s, capB.province, B(s, t.capital).province) < 200;
    });
    if (!cands.length) return;
    cands.sort(function (a, b) { return rel(s, f.id, b.id).value - rel(s, f.id, a.id).value; });
    var t = cands[0]; f.ai.lastInvite = s.day;
    var envoy = factionPersons(s, f.id).filter(function (p) { return !String(p.location || '').match(/^(army|envoy):/) && p.id !== f.leader && !p.captiveOf && p.abilities.diplomacy > 0; }).sort(function (a, b) { return b.abilities.diplomacy - a.abilities.diplomacy; })[0];
    var r = proposeDiplomacy(s, f.id, t.id, 'vassal_request', envoy ? envoy.id : null);
    if (r.ok) aiLog(s, f.id, t.name + 'へ使者（臣従勧誘）', '関係' + Math.round(rel(s, f.id, t.id).value) + '・近隣の有力武士団');
  }

  // ---- 挙兵判断（雌伏中の勢力）
  function aiUprising(s, f) {
    if (f.status !== '雌伏' && f.status !== '密謀') return;
    if ((s.histEvents || []).some(function (e) { return e.status === 'pending' && (e.effects || []).some(function (x) { return x.action === 'uprising' && x.faction === f.id; }) && (histMode(s) || s.day < 200); })) return;
    var p = 0, why = '';
    var heikeWarWithOthers = Object.keys(s.factions).some(function (k) { return k !== f.id && rel(s, 'heike', k).war && F(s, k).alive; });
    if (f.id === 'yoritomo') {
      if (f.flags.ryoji) { p += 0.004; why += '令旨受領 '; }
      if (f.flags.warned) { p += 0.05; why += '追討の危機 '; }
      if (f.flags.ryoji && s.day > 120) { p += 0.03; why += '準備が整う '; }
    } else if (f.id === 'kiso') {
      if (!f.flags.ryoji) return; why += '令旨受領 ';
      if (f.flags.uprising_yoritomo) { p += 0.04; why += '頼朝挙兵の報 '; }
      if (s.day > 140) p += 0.015;
    } else if (f.id === 'kai') {
      if (!f.flags.ryoji) return; why += '令旨受領 ';
      if (f.flags.uprising_yoritomo) { p += 0.08; why += '頼朝挙兵の報 '; }
      else if (s.day > 150) p += 0.01;
    } else return;
    if (heikeWarWithOthers && f.id === 'yoritomo') p += 0.003;
    if (rand(s) < p) uprising(s, f.id, why.trim());
  }
  // 雌伏中の家が平家方を攻めれば、その出陣がそのまま挙兵となる
  function risesBy(s, fid, target) {
    var f = F(s, fid); if (!f || (f.status !== '雌伏' && f.status !== '密謀')) return false;
    if (!target) return false;
    if (target.type === 'base') { var b = B(s, target.id); return !!(b && b.owner && !sameCamp(s, b.owner, fid) && topLord(s, b.owner) === 'heike'); }
    return provinceArmies(s, target.id).some(function (x) { return topLord(s, x.faction) === 'heike'; });
  }
  function autoRise(s, fid, target) {
    if (!risesBy(s, fid, target)) return null;
    var r = uprising(s, fid, targetName(s, target) + 'への出陣をもって挙兵');
    return r && r.ok ? '（この出陣をもって挙兵、平家と交戦状態に入った）' : null;
  }
  function uprising(s, fid, why, firstTarget) {
    var f = F(s, fid);
    if (f.status !== '雌伏' && f.status !== '密謀') return { ok: false, reason: 'すでに挙兵している' };
    f.status = '挙兵'; s.firedEvents[fid + '_uprising'] = s.day; f.flags.roseDay = s.day; f.flags.surpriseUntil = s.day + (fid === s.playerFaction ? Math.round(10 * diff(s).grace) : 10);
    // 挙兵に呼応して地元の武士が集まる（正当性が高いほど多い）
    var capR = B(s, f.capital);
    if (capR) { var rally = Math.round((120 + f.legitimacy * 4) * (fid === s.playerFaction ? diff(s).rally : 1)); var bk = nid(s, 'band'); s.bands[bk] = { id: bk, faction: fid, province: capR.province, name: PV(s, capR.province).name + 'の呼応した武士', strength: rally, base: rally, mobilized: 0, confidence: 'ゲーム設定' }; news(s, '挙兵に呼応して' + PV(s, capR.province).name + 'の武士' + rally + 'が馳せ参じた', { factions: [fid], province: capR.province }); }
    declareWar(s, fid, 'heike', f.flags.ryoji ? '以仁王の令旨を掲げる' : '独自の挙兵');
    if (f.flags.ryoji) f.legitimacy = clamp(f.legitimacy + 15, 0, 100);
    var key = { yoritomo: 'yoritomo_uprising', kiso: 'kiso_uprising', kai: 'kai_uprising' }[fid] || (fid + '_uprising');
    news(s, '【挙兵】' + f.name + 'が平家打倒の兵を挙げた' + (why ? '（' + why + '）' : ''), { type: 'event', important: true, factions: [fid] });
    aiLog(s, fid, '挙兵', why || 'プレイヤー命令');
    var cap = B(s, f.capital);
    broadcast(s, 'uprising_' + fid, cap ? cap.province : null, f.name + '挙兵の報が届いた');
    // 初手：最寄りの平家方拠点へ（AI のとき）
    if ((fid !== s.playerFaction || firstTarget) && cap) {
      var near = firstTarget && B(s, firstTarget) && atWar(s, fid, B(s, firstTarget).owner) ? B(s, firstTarget) : Object.keys(s.bases).map(function (k) { return s.bases[k]; }).filter(function (b) { return b.owner && atWar(s, fid, b.owner) && b.type !== '寺社'; })
        .sort(function (a, b) { return distProv(s, cap.province, a.province) - distProv(s, cap.province, b.province) || a.garrison - b.garrison; })[0];
      var r = mobilize(s, fid, cap.province, availableBandTroops(s, fid, cap.province) + 400, alive(s, f.leader) ? f.leader : null, { base: cap.id, foodDays: 30, officers: factionPersons(s, fid).filter(function (p) { return p.id !== f.leader && !nonCombatant(p) && p.location === cap.id; }).slice(0, 3).map(function (p) { return p.id; }) });
      if (r.army && near) { setArmyTarget(s, r.army, { type: 'base', id: near.id }, 'attack'); aiLog(s, fid, '初戦の目標：' + near.name, '最寄りの敵拠点（守備' + near.garrison + '）'); }
    }
    stop(s, { key: key, title: f.name + ' 挙兵', place: cap ? cap.name : '', persons: [f.leader], text: f.name + 'が挙兵した。' + (why || ''), choices: [] });
    return { ok: true, message: f.name + 'は挙兵した' };
  }

  // ---- 去就の判断（中立・在地勢力）
  function aiAlignment(s, f) {
    if (f.type.indexOf('武士団') < 0 && f.type.indexOf('地方') < 0) return;
    if (histMode(s) && (s.histEvents || []).some(function (e) { return e.status === 'pending' && (e.effects || []).some(function (x) { return x.action === 'join' && x.faction === f.id; }); })) return;
    if (f.id === 'kiso' || f.id === 'kai') return;
    var rebels = Object.keys(s.factions).filter(function (k) { var x = s.factions[k]; return x.alive && (x.status === '挙兵' || x.status === '幕府') && !x.overlord; });
    if (!rebels.length) return;
    var cap = B(s, f.capital); if (!cap) return;
    var lord = f.overlord;
    // 主従の義理：いったん主君を定めた家は、主君が健在で恩義に背く理由がなければ鞍替えしない
    var bond = 0, held = false, far = false, LF = lord ? F(s, lord) : null;
    if (LF && LF.alive) {
      var since = f.pledgedDay != null ? s.day - f.pledgedDay : 9999, lr = rel(s, f.id, lord).value;
      if (since < 540) return; // 主従を結んで1年半は去就を変えない
      var lordBase = B(s, LF.capital), lordPow = campPower(s, lord), kinL = kinship(s, lord, { kind: 'vassal', id: f.id });
      var collapsing = !lordBase || lordPow < 150; // 主君が本拠を失った・兵がほとんどない
      if (kinL === 'blood' && !collapsing) return; // 一門は背かない
      far = lordBase && cap ? distProv(s, cap.province, lordBase.province) > 300 : false; // 遠い主君（京の平家など）との主従は緩い
      held = !collapsing && lr > -20; // 主君が健在で関係もこじれていない
      bond = (25 + Math.max(0, lr) * 0.4 + Math.min(20, since / 365 * 5) + (kinL === 'inlaw' ? 15 : 0) - (collapsing ? 25 : 0)) * (far ? 0.45 : 1);
    }
    rebels.forEach(function (rid) {
      if (lord === rid) return;
      if (LF && LF.alive && topLord(s, lord) === topLord(s, rid)) return; // 同じ陣営の中では動かない
      var R = F(s, rid), rb = B(s, R.capital) || null;
      // 反乱勢力の現在地（本拠 or 主力軍）
      var main = factionArmies(s, rid).sort(function (a, b) { return b.troops - a.troops; })[0];
      var lpv = alive(s, R.leader) ? personLocationProvince(s, Pn(s, R.leader)) : null;
      var rprov = lpv || (main ? main.province : rb ? rb.province : null); if (!rprov) return;
      var d = distProv(s, cap.province, rprov);
      if (d > 220) return;
      var r = rel(s, f.id, rid).value;
      var rebelPow = campPower(s, rid), heikePow = 0;
      // 近隣（250km 以内）の平家方の力：武士団・軍勢
      Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction && topLord(s, b.faction) === 'heike' && distProv(s, cap.province, b.province) < 250) heikePow += Math.max(0, b.strength - b.mobilized); });
      Object.keys(s.armies).forEach(function (k) { var x = s.armies[k]; if (topLord(s, x.faction) === 'heike' && distProv(s, cap.province, x.province) < 250) heikePow += x.troops; });
      var momentum = Object.keys(s.factions).filter(function (k) { return s.factions[k].alive && s.factions[k].overlord === rid; }).length * 4;
      if (held) { var lordNear = lord === 'heike' ? heikePow : campPower(s, lord) * (far ? 0.3 : 1), overwhelmed = d < 130 && rebelPow > 2.5 * Math.max(100, lordNear);
        if (!overwhelmed) { if (s.day % 30 === 0) aiLog(s, f.id, '主君に従う', fname(s, lord) + 'との主従（関係' + Math.round(rel(s, f.id, lord).value) + '）を重んじ、' + R.name + 'には付かない'); return; } }
      var presence = d < 60 ? 18 : d < 130 ? 8 : 0; // 反乱の主将が自ら近くに来ている
      if (lord && F(s, lord) && (F(s, lord).institutions || {}).samurai_dokoro) presence -= 15; // 侍所による御家人統制
      var grievance = rel(s, f.id, 'heike').value < -20 && !lord ? 12 : 0;
      var score = presence + grievance + momentum + r * 0.6 + (R.legitimacy - 40) * 0.3 + clamp((rebelPow - heikePow) / Math.max(200, heikePow) * 25, -12, 20) + (f.policy.indexOf('源氏寄り') >= 0 ? 20 : 0)
        - bond - (f.switches || 0) * 8 - (R.flags.choteki ? 5 : 0) - (lord === 'heike' ? rel(s, f.id, 'heike').value * 0.3 : 0) + (rel(s, f.id, 'heike').value < -20 ? 10 : 0) + rr(s, -10, 10);
      f.ai.memo = rid + ':' + Math.round(score);
      if (score > 28) {
        changeAllegiance(s, f.id, rid, '評価値' + Math.round(score) + '（関係' + Math.round(r) + '、反乱側兵力' + Math.round(rebelPow) + '対 平家方' + Math.round(heikePow) + '）');
        // 合流：兵を挙げて主君のもとへ
        var av = availableBandTroops(s, f.id, cap.province);
        if (av > 80) { var m = mobilize(s, f.id, cap.province, av, null, { base: cap.id, foodDays: 30 }); if (m.army && main) { setArmyTarget(s, m.army, { type: 'province', id: main.province }, 'move'); aiLog(s, f.id, m.army.troops + 'を率いて' + R.name + 'に合流', '参陣'); } }
      } else if (!lord && score < -15 && rel(s, f.id, 'heike').value > 0) {
        changeAllegiance(s, f.id, 'heike', '反乱に与せず平家方に付く（評価値' + Math.round(score) + '）');
      } else if (s.day % 20 === 0) aiLog(s, f.id, '静観', R.name + 'への評価値' + Math.round(score));
    });
  }

  function aiCourt(s, f) {
    ensureCourt(s); var cl = s.court.cliques, ctrl = s.court.controller;
    // 都を握る側と戦う家は、院宣を求めて正当性を得ようとする
    if (f.id !== ctrl && !f.overlord && f.type !== '寺社' && atWar(s, f.id, ctrl) && insenAvailable(s) && cliqueAtt(s, cl.in, f.id) > 0 && (s.court.lastInsen[f.id] == null || s.day - s.court.lastInsen[f.id] > 200) && !s.court.pendingPetitions.some(function (p) { return p.from === f.id || p.kind === 'insen'; }) && rand(s) < 0.06) {
      var ri = petitionCourt(s, f.id, 'insen', ctrl); if (ri.ok) aiLog(s, f.id, '院宣を求める', '都を握る' + fname(s, ctrl) + 'と交戦中で、院方の態度が' + Math.round(cliqueAtt(s, cl.in, f.id)));
    }
    // 実際に押さえている国の知行国（国司）を求める
    if (!f.overlord && f.type !== '寺社' && !f.flags.choteki && !s.court.pendingPetitions.some(function (p) { return p.from === f.id && p.kind === 'kokushi'; }) && rand(s) < 0.05) {
      var kp = Object.keys(s.provinces).filter(function (pid) { var i = provinceInfluence(s, pid)[0]; return i && topLord(s, i.faction) === f.id && topLord(s, s.provinces[pid].kokuga.holder || '') !== f.id; })[0];
      if (kp) { var rk = petitionKokushi(s, f.id, kp); if (rk.ok) aiLog(s, f.id, PV(s, kp).name + 'の知行国を申請', '実効支配している国の国衙領の年貢を得るため'); }
    }
    // 余裕のある家は、自分に冷たい有力派閥へ献金する
    if (f.money > 2500 && !f.overlord && f.type !== '寺社' && rand(s) < 0.05) {
      var tg = f.flags.lastCourtGift != null && s.day - f.flags.lastCourtGift < 120 ? null : Object.keys(cl).filter(function (k) { var a = cliqueAtt(s, cl[k], f.id); return cl[k].influence >= 12 && a < 30 && a > -30; }).sort(function (a, b) { return cl[b].influence - cl[a].influence; })[0];
      if (tg) { var amt = Math.round(Math.min(f.money * 0.15, 1200) / 100) * 100; var rg = courtGift(s, f.id, tg, amt); if (rg.ok) f.flags.lastCourtGift = s.day; if (rg.ok) aiLog(s, f.id, cl[tg].name + 'へ献金' + amt + '貫', '朝廷での支持を得るため（影響力' + Math.round(cl[tg].influence) + '）'); }
    }
    if (s.court.controller !== f.id && courtController(s) !== f.id) return;
    enemiesOf(s, f.id).forEach(function (e) {
      var t = F(s, e); if (t.flags.choteki || t.type === '寺社' || s.court.pendingPetitions.some(function (p) { return p.target === e; })) return;
      if (t.status !== '挙兵' && t.status !== '幕府' && t.type.indexOf('皇族') < 0) return;
      var r = petitionCourt(s, f.id, 'tsuito', e);
      if (r.ok) aiLog(s, f.id, t.name + 'の追討宣旨を申請', '朝廷を主導しているため');
    });
  }

  // ================================================================ 歴史イベント（条件付き）
  function fired(s, k) { return s.firedEvents[k] != null; }
  function histMode(s) { return s.options.mode === 'historical'; }
  function histCovered(s) { return (s.histEvents || []).length > 0; } // 史実イベントがある場合、同じ出来事の自然発生版は使わない

  // ================================================================ 史実イベント（条件を満たすと発生：信長の野望の史実イベント方式）
  function ymd(a) { return { y: a[0], m: a[1], leap: !!a[2], d: a[3] }; }
  function dateLabel(s, a) { return dateStr(s, ymd(a)).replace(/（.*）/, ''); }
  var FLAGNAME = { ryoji: '以仁王の令旨を受けている', warned: '平家の追討の危機を知っている', choteki: '朝敵とされている', bakufu: '武家政権を開いている' };
  function evalCond(s, c) {
    var ok = false, label = '';
    switch (c.t) {
      case 'date': ok = cmpDate(s.date, ymd(c.from)) >= 0; label = dateLabel(s, c.from) + '以降'; break;
      case 'before': ok = cmpDate(s.date, ymd(c.until)) <= 0; label = dateLabel(s, c.until) + 'まで'; break;
      case 'alive': ok = alive(s, c.p) && !Pn(s, c.p).captiveOf; label = pname(s, c.p) + 'が存命（捕らわれていない）'; break;
      case 'dead': ok = !alive(s, c.p); label = pname(s, c.p) + 'が死去している'; break;
      case 'falive': ok = !!(F(s, c.f) && F(s, c.f).alive); label = fname(s, c.f) + 'が存続'; break;
      case 'status': ok = !!(F(s, c.f) && F(s, c.f).alive && c['in'].indexOf(F(s, c.f).status) >= 0); label = fname(s, c.f) + 'の状態が「' + c['in'].join('／') + '」'; break;
      case 'flag': ok = !!(F(s, c.f) && F(s, c.f).flags[c.flag]); label = fname(s, c.f) + 'が' + (FLAGNAME[c.flag] || c.flag); break;
      case 'fired': ok = fired(s, c.key) || s.histEvents.some(function (e) { return e.id === c.key && e.status === 'done'; }); label = '「' + histName(s, c.key) + '」が起きている'; break;
      case 'notFired': ok = !(fired(s, c.key) || s.histEvents.some(function (e) { return e.id === c.key && e.status === 'done'; })); label = '「' + histName(s, c.key) + '」がまだ起きていない'; break;
      case 'vassal': ok = !!(F(s, c.f) && F(s, c.f).overlord === c.lord); label = fname(s, c.f) + 'が' + fname(s, c.lord) + 'に従属'; break;
      case 'notVassal': ok = !!(F(s, c.f) && F(s, c.f).alive && F(s, c.f).overlord !== c.lord); label = fname(s, c.f) + 'が' + fname(s, c.lord) + 'にまだ従っていない'; break;
      case 'capital': ok = !!(F(s, c.f) && F(s, c.f).capital === c.base); label = fname(s, c.f) + 'の本拠が' + B(s, c.base).name; break;
      case 'owns': ok = !!(B(s, c.base).owner && sameCamp(s, B(s, c.base).owner, c.f)); label = fname(s, c.f) + '方が' + B(s, c.base).name + 'を押さえている'; break;
      case 'notOwns': ok = !(B(s, c.base).owner && sameCamp(s, B(s, c.base).owner, c.f)); label = fname(s, c.f) + '方が' + B(s, c.base).name + 'を押さえていない'; break;
      case 'war': ok = atWar(s, c.a, c.b); label = fname(s, c.a) + 'と' + fname(s, c.b) + 'が交戦中'; break;
      case 'court': ok = s.court.location === c.base; label = '都が' + B(s, c.base).name; break;
      case 'power': ok = !!(F(s, c.f) && F(s, c.f).alive && campPower(s, c.f) >= c.min); label = fname(s, c.f) + '陣営の兵力が' + c.min + '以上（現在' + (F(s, c.f) && F(s, c.f).alive ? Math.round(campPower(s, c.f)) : 0) + '）'; break;
      case 'vassals': var vn = Object.keys(s.factions).filter(function (k) { return s.factions[k].alive && s.factions[k].overlord === c.f; }).length; ok = vn >= c.min; label = fname(s, c.f) + 'に従う武士団が' + c.min + '以上（現在' + vn + '）'; break;
      case 'bakufu': ok = !!(F(s, c.f) && F(s, c.f).flags.bakufu); label = fname(s, c.f) + 'が武家政権を開いている'; break;
      case 'inFaction': ok = !!(alive(s, c.p) && topLord(s, Pn(s, c.p).faction) === c.f); label = pname(s, c.p) + 'が' + fname(s, c.f) + '方にいる'; break;
      case 'leader': ok = !!(F(s, c.f) && F(s, c.f).leader === c.p); label = fname(s, c.f) + 'の当主が' + pname(s, c.p); break;
      case 'near': { var dmin = 9999; Object.keys(s.armies).forEach(function (k) { var a = s.armies[k]; if (sameCamp(s, a.faction, c.f) && a.troops >= (c.troops || 500)) dmin = Math.min(dmin, distProv(s, a.province, c.prov)); }); ok = dmin <= (c.km || 0); label = fname(s, c.f) + '方の軍（' + (c.troops || 500) + '以上）が' + PV(s, c.prov).name + 'から' + (c.km || 0) + 'km以内にいる'; break; }
      case 'courtCtl': ok = courtController(s) === c.f; label = '朝廷を' + fname(s, c.f) + 'が主導'; break;
      case 'notCourtCtl': ok = courtController(s) !== c.f; label = '朝廷を' + fname(s, c.f) + 'が主導していない'; break;
      default: label = c.t;
    }
    return { ok: !!ok, label: label };
  }
  function histName(s, id) { var e = s.histEvents.filter(function (x) { return x.id === id; })[0]; if (e) return e.name; var d = (s.eventDefs || []).filter(function (x) { return x.id === id; })[0]; return d ? d.name : id; }
  function histEventStatus(s) {
    return s.histEvents.map(function (e) {
      var conds = [{ t: 'date', from: e.from }].concat(e.until && s.options.mode === 'historical' ? [{ t: 'before', until: e.until }] : []).concat(e.conditions || []);
      var ev = conds.map(function (c) { return evalCond(s, c); });
      return { id: e.id, name: e.name, date: e.historicalDate, note: e.note || '', category: e.category, actor: e.actor, summary: e.summary, status: e.status, firedDate: e.firedDate || null, conds: ev, ready: ev.every(function (x) { return x.ok; }) };
    });
  }
  function runHistEvents(s) {
    var free = s.options.mode !== 'historical';
    s.histEvents.forEach(function (e) {
      if (e.status !== 'pending') return;
      var ar = e.afterRise && F(s, e.afterRise.f) && F(s, e.afterRise.f).flags.roseDay != null ? F(s, e.afterRise.f).flags.roseDay + e.afterRise.days : null; // 挙兵からの日数で起こる（挙兵が史実より早くても遅くても）
      if (ar != null ? s.day < ar : cmpDate(s.date, ymd(e.from)) < 0) return;
      if ((e.skipIf || []).length && e.skipIf.every(function (c) { return evalCond(s, c).ok; })) { e.status = 'done'; e.firedDate = dateStr(s); e.note = '別の経緯ですでに実現'; mark(s, e.id); return; }
      if (!free && e.until && (ar != null ? s.day > ar + 75 : cmpDate(s.date, ymd(e.until)) > 0)) { e.status = 'expired'; news(s, '（史実イベント「' + e.name + '」は条件がそろわず起こらなかった）', { type: 'system' }); return; }
      if (e.freeOnly === false && free) return;
      var all = (e.conditions || []).every(function (c) { return evalCond(s, c).ok; });
      if (!all) return;
      if (e.chance != null && rand(s) > e.chance) return;
      if (free && e.actor && e.actor !== s.playerFaction && rand(s) > 0.12) return; // 自由モード：他家は条件がそろってもすぐには動かない
      e.status = 'done'; e.firedDate = dateStr(s);
      var actor = e.actor;
      if (actor && actor === s.playerFaction && e.ask !== false) {
        e.status = 'asked';
        stop(s, { key: 'hist_' + e.id, hist: e.id, title: '史実イベント：' + e.name, place: e.place || '', persons: e.persons || [], text: (e.text || e.summary || '') + '\n条件がそろった。史実どおりにするか、自分で決めるか。', choices: [{ id: 'follow', label: e.followLabel || '史実どおりにする' }, { id: 'own', label: '従わない（自分で決める）' }] });
        return;
      }
      applyEffects(s, e);
    });
  }
  function applyEffects(s, e) {
    mark(s, e.id);
    news(s, '【史実イベント】' + e.name + (e.summary ? '：' + e.summary : ''), { type: 'event', important: true, factions: [e.actor].filter(Boolean) });
    (e.effects || []).forEach(function (x) {
      switch (x.do) {
        case 'schedule': execSchedule(s, Object.assign({ id: e.id, title: e.name }, x)); break;
        case 'legitimacy': if (F(s, x.f)) F(s, x.f).legitimacy = clamp(F(s, x.f).legitimacy + x.v, 0, 100); break;
        case 'money': if (F(s, x.f)) F(s, x.f).money = Math.max(0, F(s, x.f).money + x.v); break;
        case 'foodRate': if (x.v < 1) s.flags.famineUntil = s.day + 420; Object.keys(s.factions).forEach(function (k) { if (!x.region || x.region.indexOf(k) >= 0) s.factions[k].food = Math.round(s.factions[k].food * x.v); }); break;
        case 'relation': var r = rel(s, x.a, x.b); r.value = clamp(r.value + x.v, -100, 100); break;
        case 'unflag': if (F(s, x.f)) delete F(s, x.f).flags[x.flag]; break;
        case 'kill': if (alive(s, x.p)) killPerson(s, Pn(s, x.p), x.cause || 'executed', x.note || ''); break;
        case 'absorb': { var g = F(s, x.f), into = F(s, x.into); if (!g || !g.alive || !into) break; Object.keys(s.bands).forEach(function (k) { if (s.bands[k].faction === x.f) s.bands[k].faction = x.into; }); Object.keys(s.bases).forEach(function (k) { if (s.bases[k].owner === x.f) s.bases[k].owner = x.into; }); Object.keys(s.holdings).forEach(function (k) { if (s.holdings[k].controller === x.f) s.holdings[k].controller = x.into; }); Object.keys(s.armies).forEach(function (k) { if (s.armies[k].faction === x.f) s.armies[k].faction = x.into; }); factionPersons(s, x.f).forEach(function (p) { p.faction = x.into; }); into.money += g.money; into.food += g.food; g.alive = false; news(s, g.name + 'の所領と兵は' + into.name + 'に吸収された', { type: 'politics', important: true }); break; }
        case 'joinPerson': if (alive(s, x.p)) { Pn(s, x.p).faction = x.f; Pn(s, x.p).location = F(s, x.f).capital; news(s, pname(s, x.p) + 'が' + fname(s, x.f) + 'に加わった', { type: 'politics', important: true, factions: [x.f] }); } break;
        case 'moveCapital': { var hf = F(s, x.f), nb = B(s, x.base); if (!hf || !hf.alive || !nb) break; if (!nb.owner || nb.owner === x.f) { nb.owner = x.f; nb.garrison += x.garrison || 500; } hf.capital = x.base; if (x.abandon) x.abandon.forEach(function (bid) { var ob = B(s, bid); if (ob && ob.owner === x.f) { ob.owner = null; ob.garrison = 0; } }); factionPersons(s, x.f).forEach(function (p) { if (!/^(army|envoy):/.test(String(p.location || ''))) p.location = x.base; }); (x.withEmperor ? ['antoku', 'tokuko'] : []).forEach(function (pid) { if (alive(s, pid)) Pn(s, pid).location = x.base; }); factionArmies(s, x.f).forEach(function (a) { if (a.status === 'idle' && distProv(s, a.province, nb.province) < 400) setArmyTarget(s, a, { type: 'base', id: x.base }, 'move'); }); break; }
        case 'courtShift': { ensureCourt(s); var d = s.court.dominance, ccl = s.court.cliques; Object.keys(x.v).forEach(function (k) { if (ccl[k]) ccl[k].influence = clamp(ccl[k].influence + x.v[k], 2, 60); else d[k] = Math.max(0, (d[k] || 0) + x.v[k]); }); if (x.free) { s.court.dharmaEmperorConfined = false; } break; }
        case 'occupy': { var ob2 = B(s, x.base); if (ob2) { ob2.owner = x.f; ob2.garrison = Math.max(ob2.garrison, x.garrison || 300); } break; }
        case 'news': news(s, x.text, { type: 'event', important: true }); break;
      }
    });
    if (e.stopAll !== false) stop(s, { key: 'hist_done_' + e.id, title: e.name, place: e.place || '', persons: e.persons || [], text: (e.text || e.summary || ''), choices: [] });
  }

  // ================================================================ 史実モードの予定表
  // 各項目は史実の日付に、条件（当事者の存命・勢力の存続など）を満たせば実行。
  // 当事者がプレイヤーの場合は「史実どおりにするか」を選ばせる（強制しない）。
  function runSchedule(s) {
    s.schedule.forEach(function (e) {
      if (e.done) return;
      if (cmpDate(s.date, { y: e.date[0], m: e.date[1], leap: !!e.date[2], d: e.date[3] }) < 0) return;
      e.done = true;
      if (e.action === 'join' && F(s, e.faction) && F(s, e.faction).overlord === e.lord) return; // すでに合流済み
      if (!scheduleValid(s, e)) { news(s, '（史実の「' + e.title + '」は、状況が史実と異なるため起こらなかった）', { type: 'system' }); return; }
      var actor = e.faction || e.actor;
      if (actor && actor === s.playerFaction && e.ask !== false) {
        stop(s, { key: 'hist_' + e.id, sched: e.id, title: '史実の分岐点：' + e.title, place: e.place || '', persons: e.persons || [], text: (e.text || '') + '\n史実ではこの日にこうなった。史実どおりにするか、自分で決めるか。', choices: [{ id: 'follow', label: '史実どおりにする' }, { id: 'own', label: '従わない（自分で決める）' }] });
        return;
      }
      execSchedule(s, e);
    });
  }
  function scheduleValid(s, e) {
    var need = (e.requires || []);
    for (var i = 0; i < need.length; i++) { var r = need[i]; if (s.persons[r] && !alive(s, r)) return false; if (s.factions[r] && !s.factions[r].alive) return false; }
    if (e.action === 'join') { var f = F(s, e.faction), l = F(s, e.lord); if (!f || !f.alive || !l || !l.alive || f.overlord === e.lord || (l.status !== '挙兵' && l.status !== '幕府')) return false; }
    if (e.action === 'uprising') { var u = F(s, e.faction); if (!u || !u.alive || (u.status !== '雌伏' && u.status !== '密謀')) return false; }
    if (e.action === 'expose' && !fired(s, 'mochihito_ryoji')) return false;
    if (e.action === 'sento' && (F(s, 'heike').leader !== 'kiyomori' || s.court.location !== 'heiankyo')) return false;
    if (e.action === 'kango' && s.court.location !== 'fukuhara') return false;
    if (e.action === 'kamakura' && (F(s, 'yoritomo').status !== '挙兵' || (B(s, 'kamakura').owner && B(s, 'kamakura').owner !== 'yoritomo'))) return false;
    if (e.action === 'samurai' && F(s, 'yoritomo').capital !== 'kamakura') return false;
    if (e.action === 'yoshitsune' && (Pn(s, 'yoshitsune').faction !== 'oshu' || F(s, 'yoritomo').status !== '挙兵')) return false;
    if (e.action === 'campaign' && !F(s, e.target).alive && !(s.bases[e.targetBase] && s.bases[e.targetBase].owner)) return false;
    return true;
  }
  function execSchedule(s, e) {
    mark(s, 'sched_' + e.id);
    switch (e.action) {
      case 'ryoji': if (!fired(s, 'mochihito_ryoji')) issueRyoji(s); break;
      case 'expose': if (!fired(s, 'mochihito_exposed')) exposeMochihito(s); break;
      case 'sento': if (!fired(s, 'fukuhara_sento')) doSento(s); break;
      case 'kango': if (!fired(s, 'kyoto_return')) doKango(s); break;
      case 'letter': if (!fired(s, 'genji_rumor')) { mark(s, 'genji_rumor'); sendEnvoy(s, 'court', null, 'yamashiro', 'hojo', { kind: 'letter', to: 'yoritomo', flag: 'warned', text: '三善康信の書状：令旨を受けた諸国の源氏を平家が追討しようとしている。急ぎ奥州へ逃れられよ', stopTitle: '三善康信からの急報' }); } break;
      case 'uprising': uprising(s, e.faction, '史実の日付（' + e.title + '）', e.firstTarget); break;
      case 'join': changeAllegiance(s, e.faction, e.lord, e.text || ''); joinArmy(s, e.faction, e.lord); break;
      case 'kamakura': mark(s, 'kamakura_entry'); var k = B(s, 'kamakura'), yf = F(s, 'yoritomo'); k.owner = 'yoritomo'; yf.capital = 'kamakura'; k.garrison += 300; if (alive(s, yf.leader)) Pn(s, yf.leader).location = 'kamakura';
        factionArmies(s, 'yoritomo').forEach(function (a) { if (a.status === 'idle' && distProv(s, a.province, 'sagami') < 300) setArmyTarget(s, a, { type: 'base', id: 'kamakura' }, 'move'); });
        news(s, '【鎌倉入り】' + pname(s, yf.leader) + 'は鎌倉を本拠と定めた', { type: 'event', important: true, factions: ['yoritomo'] }); break;
      case 'yoshitsune': if (!fired(s, 'yoshitsune_join')) yoshitsuneLeaves(s); break;
      case 'samurai': if (!fired(s, 'samurai_dokoro')) { var yfz = F(s, 'yoritomo'); if (!yfz.flags.bakufu) { var bc = bakufuCheck(s, 'yoritomo'); if (!bc.ok) { yfz.legitimacy = Math.max(yfz.legitimacy, 35); } yfz.flags.bakufu = true; yfz.flags.bakufuDay = s.day; yfz.status = '幕府'; yfz.institutions = yfz.institutions || {}; news(s, '【武家政権の成立】' + pname(s, yfz.leader) + 'が鎌倉に武家政権を開いた（1180年説）', { type: 'event', important: true, factions: ['yoritomo'] }); }
        var c = alive(s, 'yoshimori') && topLord(s, Pn(s, 'yoshimori').faction) === 'yoritomo' ? 'yoshimori' : null; yfz.money += INSTITUTIONS.samurai_dokoro.money; establishInstitution(s, 'yoritomo', 'samurai_dokoro', c);
        if (involvesPlayer(s, 'yoritomo')) stop(s, { key: 'samurai_dokoro', title: '侍所の設置', place: '鎌倉', text: '御家人を統率する侍所を設けた（別当：' + pname(s, (yfz.institutions.samurai_dokoro || {}).head) + '）。', choices: [] }); } break;
      case 'campaign': { // 史実の遠征軍（追討軍・南都攻めなど）
        var f = F(s, e.faction); if (!f || !f.alive) break;
        if (e.target && !atWar(s, e.faction, e.target)) declareWar(s, e.faction, e.target, e.title);
        factionArmies(s, e.faction).forEach(function (a) { if (a.status === 'idle' && !a.battleId && distProv(s, a.province, e.province) < 250) disbandArmy(s, a); });
        var r = mobilize(s, e.faction, e.province, e.troops, alive(s, e.commander) ? e.commander : null, { officers: (e.officers || []).filter(function (o) { return alive(s, o) && Pn(s, o).faction === e.faction && !/^(army|envoy):/.test(String(Pn(s, o).location || '')); }), foodDays: 50, force: true, wide: 260 });
        if (r.error) news(s, '（史実の「' + e.title + '」は兵が集まらず実現しなかった：' + r.error + '）', { type: 'system' });
        if (r.army) { r.army.name = e.armyName || null; var tgt = e.targetBase && s.bases[e.targetBase] && s.bases[e.targetBase].owner && s.bases[e.targetBase].owner !== e.faction ? { type: 'base', id: e.targetBase } : campaignTarget(s, e); if (tgt) setArmyTarget(s, r.army, tgt, 'attack'); r.army.status = 'gathering'; news(s, '【出陣】' + e.title + '：' + armyLabel(s, r.army) + 'が' + (tgt ? (tgt.type === 'base' ? B(s, tgt.id).name : PV(s, tgt.id).name) : '') + 'を目指す', { type: 'military', important: true, factions: [e.faction] }); aiLog(s, e.faction, e.title, '史実モードの予定'); }
        break; }
    }
  }
  function campaignTarget(s, e) {
    var t = F(s, e.target); if (!t || !t.alive) return null;
    var main = factionArmies(s, e.target).sort(function (a, b) { return b.troops - a.troops; })[0];
    if (main) return { type: 'province', id: main.province };
    return t.capital ? { type: 'base', id: t.capital } : null;
  }
  function joinArmy(s, fid, lord) {
    var f = F(s, fid), cap = B(s, f.capital); if (!cap) return;
    var av = availableBandTroops(s, fid, cap.province); if (av < 80) return;
    var m = mobilize(s, fid, cap.province, av, null, { base: cap.id, foodDays: 30 });
    var main = factionArmies(s, lord).sort(function (a, b) { return b.troops - a.troops; })[0];
    if (m.army && main) setArmyTarget(s, m.army, { type: 'province', id: main.province }, 'move');
  }
  function mark(s, k) { s.firedEvents[k] = s.day; }
  function checkEvents(s) {
    var mo = F(s, 'mochihito'), heike = F(s, 'heike');
    // 以仁王の令旨（4月9日頃以降、以仁王・頼政・行家が健在）
    if (!histCovered(s) && !fired(s, 'mochihito_ryoji') && s.day >= 8 && mo.alive && alive(s, 'mochihito') && alive(s, 'yorimasa') && alive(s, 'yukiie') && mo.status === '密謀') {
      if (s.playerFaction === 'mochihito') { if (!s.flags.ryojiAsked) { s.flags.ryojiAsked = true; stop(s, { key: 'mochihito_ryoji', title: '令旨を発するか', place: '三条高倉御所', persons: ['mochihito', 'yorimasa', 'yukiie'], text: '源頼政が平家打倒を勧めている。令旨を発して諸国の源氏に挙兵を促すか。源行家が使者となって東国へ下る。', choices: [{ id: 'issue', label: '令旨を発する（行家を東国へ）' }, { id: 'wait', label: '時期を待つ' }] }); } }
      else if (rand(s) < 0.5) issueRyoji(s);
    }
    // 計画の露見
    if (!histCovered(s) && fired(s, 'mochihito_ryoji') && !fired(s, 'mochihito_exposed') && s.day >= 30 && mo.alive && mo.status === '密謀') {
      var pr = 0.04 + (heike.alive ? 0.03 : 0);
      if (rand(s) < pr) exposeMochihito(s);
    }
    // 以仁王の逃避行（園城寺 → 南都）
    if (fired(s, 'mochihito_exposed') && mo.alive && mo.status === '挙兵' && !s.flags.mochihitoToNara && mo.id !== s.playerFaction) {
      var ma = factionArmies(s, 'mochihito')[0];
      if (ma && ma.status === 'idle' && s.day - s.firedEvents.mochihito_exposed > 8) { s.flags.mochihitoToNara = true; setArmyTarget(s, ma, { type: 'base', id: 'kofukuji' }, 'move'); aiLog(s, 'mochihito', '南都へ向かう', '園城寺では平家の大軍を防げない'); news(s, '以仁王と頼政は南都を目指して園城寺を出た', { type: 'event', important: true, factions: ['mochihito'] }); }
    }
    // 伊豆の知行国主交代（頼政方の没落）
    if (fired(s, 'mochihito_exposed') && !fired(s, 'izu_transfer') && (!alive(s, 'yorimasa') || !mo.alive)) {
      mark(s, 'izu_transfer'); var kh = s.holdings.kokuga_izu; if (kh) kh.controller = 'heike'; PV(s, 'izu').kokuga.holder = 'heike';
      news(s, '伊豆の知行国主は平時忠に替わり、目代山木兼隆の権勢が強まった', { type: 'politics' });
    }
    // 福原遷都
    if (!histCovered(s) && !fired(s, 'fukuhara_sento') && s.day >= 58 && heike.alive && heike.leader === 'kiyomori' && fired(s, 'mochihito_exposed')) {
      if (s.playerFaction === 'heike') { if (!s.flags.sentoAsked) { s.flags.sentoAsked = true; stop(s, { key: 'fukuhara_sento', title: '福原遷都', place: '福原', persons: ['kiyomori'], text: '清盛は寺社勢力の強い京を離れ、福原へ都を移すことを考えている。遷都すれば平家の掌握は強まるが、公家・寺社の反発を招く。', choices: [{ id: 'move', label: '福原へ遷都する' }, { id: 'stay', label: '京に留まる' }] }); } }
      else if (rand(s) < 0.25) doSento(s);
    }
    // 源氏追討の噂 → 三善康信の書状
    if (!histCovered(s) && !fired(s, 'genji_rumor') && fired(s, 'mochihito_exposed') && s.day >= 75 && F(s, 'yoritomo').alive && F(s, 'yoritomo').flags.ryoji && alive(s, 'yasunobu')) {
      mark(s, 'genji_rumor');
      sendEnvoy(s, 'court', null, 'yamashiro', 'hojo', { kind: 'letter', to: 'yoritomo', flag: 'warned', text: '三善康信の書状：令旨を受けた諸国の源氏を平家が追討しようとしている。急ぎ奥州へ逃れられよ', stopTitle: '三善康信からの急報' });
      news(s, '平家は令旨を受けた源氏の追討を計画しているとの噂が京で流れている', { type: 'intel' });
    }
    // 還都（遷都中に反乱が拡大）
    if (!histCovered(s) && s.court.location === 'fukuhara' && !fired(s, 'kyoto_return') && heike.alive) {
      var rebels = Object.keys(s.factions).filter(function (k) { return s.factions[k].alive && s.factions[k].status === '挙兵'; }).length;
      if ((rebels >= 2 && s.day - s.firedEvents.fukuhara_sento > 90) || s.day - s.firedEvents.fukuhara_sento > 200) {
        if (s.playerFaction === 'heike') { if (!s.flags.kangoAsked) { s.flags.kangoAsked = true; stop(s, { key: 'kyoto_return', title: '還都', text: '各地の反乱と公家・寺社の不満が高まっている。都を京へ戻すか。', choices: [{ id: 'return', label: '京へ戻す' }, { id: 'stay', label: '福原に留める' }] }); } }
        else if (rand(s) < 0.1) doKango(s);
      }
    }
    // 鎌倉入り
    var yf = F(s, 'yoritomo');
    if (!histCovered(s) && yf.alive && yf.status === '挙兵' && !fired(s, 'kamakura_entry') && yf.id !== s.playerFaction) {
      var k = B(s, 'kamakura'), inSagami = factionArmies(s, 'yoritomo').some(function (a) { return a.province === 'sagami' && a.status === 'idle'; });
      var big = campPower(s, 'yoritomo') > 2500;
      if (big && (k.owner === null || k.owner === 'yoritomo')) {
        if (inSagami) { mark(s, 'kamakura_entry'); k.owner = 'yoritomo'; yf.capital = 'kamakura'; k.garrison += 300; if (alive(s, 'yoritomo')) Pn(s, 'yoritomo').location = 'kamakura'; news(s, '【鎌倉入り】' + pname(s, yf.leader) + 'は鎌倉を本拠と定めた', { type: 'event', important: true, factions: ['yoritomo'] }); aiLog(s, 'yoritomo', '鎌倉を本拠とする', '相模を押さえ、要害で源氏ゆかりの地'); }
        else if (!s.flags.kamakuraMarch) { var ma2 = factionArmies(s, 'yoritomo').filter(function (a) { return a.status === 'idle'; }).sort(function (a, b) { return b.troops - a.troops; })[0]; if (ma2) { s.flags.kamakuraMarch = true; setArmyTarget(s, ma2, { type: 'base', id: 'kamakura' }, 'move'); aiLog(s, 'yoritomo', '鎌倉へ向かう', '本拠の確保'); } }
      }
    }
    // 義経の参陣
    if (!histCovered(s) && !fired(s, 'yoshitsune_join') && yf.alive && yf.status === '挙兵' && F(s, 'oshu').flags['uprising_yoritomo'] && alive(s, 'yoshitsune') && Pn(s, 'yoshitsune').faction === 'oshu' && s.day - (s.firedEvents.yoritomo_uprising || 0) > 25 && yf.capital) {
      if (s.playerFaction === 'oshu') { if (!s.flags.ystAsked) { s.flags.ystAsked = true; stop(s, { key: 'yoshitsune_join', title: '義経、兄のもとへ', place: '平泉', persons: ['yoshitsune', 'hidehira'], text: '頼朝挙兵を聞いた義経が、兄のもとへ馳せ参じたいと願い出た。', choices: [{ id: 'allow', label: '佐藤兄弟を付けて送り出す' }, { id: 'deny', label: '引き留める' }] }); } }
      else if (rand(s) < 0.08) yoshitsuneLeaves(s);
    }
    // 侍所の設置（条件：本拠を定め、主従関係の武士団が3つ以上）
    if (!histCovered(s) && !fired(s, 'samurai_dokoro') && yf.alive && yf.capital === 'kamakura') {
      var vas = Object.keys(s.factions).filter(function (k2) { return s.factions[k2].alive && s.factions[k2].overlord === 'yoritomo'; });
      if (vas.length >= 3) {
        mark(s, 'samurai_dokoro');
        var cand = alive(s, 'yoshimori') && topLord(s, Pn(s, 'yoshimori').faction) === 'yoritomo' ? 'yoshimori' : (factionPersons(s, 'yoritomo').sort(function (a, b) { return b.abilities.command - a.abilities.command; })[0] || {}).id;
        if (!yf.flags.bakufu) { yf.flags.bakufu = true; f.flags.bakufuDay = s.day; yf.status = '幕府'; yf.institutions = yf.institutions || {}; }
        yf.money += INSTITUTIONS.samurai_dokoro.money; establishInstitution(s, 'yoritomo', 'samurai_dokoro', cand); yf.legitimacy += 5;
        news(s, '【侍所設置】' + pname(s, yf.leader) + 'は御家人を統べる侍所を置き、' + pname(s, cand) + 'を別当とした', { type: 'event', important: true, factions: ['yoritomo'] });
        if (involvesPlayer(s, 'yoritomo')) stop(s, { key: 'samurai_dokoro', title: '侍所の設置', place: '鎌倉', persons: [cand], text: '御家人を統率する機関として侍所を設けた（別当：' + pname(s, cand) + '）。', choices: [] });
      }
    }
    // 南都攻め（平家と南都が交戦中で、平家方の軍が大和へ迫る）— 戦闘の結果として焼討が起こり得る（endBattle 内）
    if (!histCovered(s) && !fired(s, 'nanto_war') && fired(s, 'mochihito_exposed') && heike.alive && F(s, 'nanto').alive && (s.flags.nantoSheltered || rel(s, 'heike', 'nanto').value < -60) && s.day > 120) {
      mark(s, 'nanto_war'); declareWar(s, 'heike', 'nanto', '南都大衆が以仁王に与し、平家に敵対');
    }
    // 即位礼（4月22日）
    if (!fired(s, 'sokui') && s.day >= 21 && alive(s, 'antoku')) { mark(s, 'sokui'); news(s, '安徳天皇の即位礼が行われた', { type: 'court' }); heike.legitimacy = clamp(heike.legitimacy + 3, 0, 100); }
  }
  function issueRyoji(s) {
    mark(s, 'mochihito_ryoji'); s.flags.ryojiIssued = true;
    var v = sendEnvoy(s, 'mochihito', 'yukiie', 'yamashiro', 'hojo', { kind: 'ryoji', recipients: ['yoritomo'], next: [{ base: 'kai_takeda', recipients: ['kai'] }, { base: 'kiso', recipients: ['kiso'] }] });
    news(s, '【以仁王の令旨】以仁王が平家追討の令旨を下した。源行家が八条院蔵人として東国へ下る', { type: 'event', important: true, factions: ['mochihito'] });
    aiLog(s, 'mochihito', '令旨を発する', '頼政の勧め・平家への不満');
    if (s.playerFaction === 'mochihito') news(s, '行家は伊豆・甲斐・信濃の源氏を回る予定', { factions: ['mochihito'] });
    return v;
  }
  function exposeMochihito(s) {
    mark(s, 'mochihito_exposed');
    var mo = F(s, 'mochihito'); mo.status = '挙兵';
    declareWar(s, 'heike', 'mochihito', '以仁王の謀叛が露見');
    news(s, '【露見】以仁王の挙兵計画が平家に漏れた。朝廷は以仁王を臣籍に降して配流と決した', { type: 'event', important: true, factions: ['mochihito', 'heike'] });
    if (s.playerFaction === 'mochihito') {
      stop(s, { key: 'mochihito_exposed', title: '計画露見', place: '三条高倉御所', persons: ['mochihito', 'yorimasa'], text: '平家が謀叛を察知した。追捕の兵が迫る。', choices: [{ id: 'flee', label: '園城寺へ逃れる' }, { id: 'stand', label: '京で迎え撃つ' }] });
    } else {
      mochihitoFlee(s);
      if (s.playerFaction === 'heike') stop(s, { key: 'mochihito_exposed', title: '以仁王の謀叛露見', place: '京', persons: ['mochihito', 'yorimasa'], text: '以仁王と源頼政が平家打倒を企てていた。以仁王は園城寺へ逃れた模様である。追捕の兵を出すべきか（「軍事」から動員・進軍を命じられる）。', choices: [] });
    }
    // 平家の追捕（AI）
    if (s.playerFaction !== 'heike') {
      var r = mobilize(s, 'heike', 'yamashiro', 2500, 'tomomori', { base: 'rokuhara', officers: ['shigehira'], foodDays: 20 });
      if (r.army) { r.army.name = '以仁王追捕軍'; setArmyTarget(s, r.army, { type: 'base', id: 'onjoji' }, 'attack'); aiLog(s, 'heike', '以仁王追捕の軍を出す', '謀叛の首謀者を捕らえる'); }
    }
    issueTsuitoDirect(s, 'mochihito');
  }
  function issueTsuitoDirect(s, target) { var t = F(s, target); t.flags.choteki = true; t.legitimacy = clamp(t.legitimacy - 20, 0, 100); s.court.edicts.push({ type: '配流の宣下', target: target, date: dateStr(s), day: s.day }); }
  function mochihitoFlee(s) {
    var mo = F(s, 'mochihito');
    // 夜陰に紛れて園城寺へ（すでに近江に入った状態から始める）
    var n = Math.min(300, availableBandTroops(s, 'mochihito'));
    Object.keys(s.bands).forEach(function (k) { var b = s.bands[k]; if (b.faction === 'mochihito') b.mobilized = b.strength; });
    var a = createArmy(s, 'mochihito', 'omi', n, 'yorimasa', { officers: ['mochihito', 'nakatsuna'].filter(function (p) { return alive(s, p); }), food: 60, base: 'onjoji', name: '以仁王・頼政勢' });
    a.mission = 'idle';
    // 園城寺は以仁王を受け入れる（関係による）
    if (rel(s, 'mochihito', 'onjoji').value > 20) { var rr2 = rel(s, 'mochihito', 'onjoji'); rr2.status = '同盟'; rr2.value = 70; declareWar(s, 'heike', 'onjoji', '以仁王を庇護'); }
    if (rel(s, 'mochihito', 'nanto').value > 20) { var rn = rel(s, 'mochihito', 'nanto'); rn.status = '同盟'; s.flags.nantoSheltered = true; }
    B(s, 'sanjo_takakura').owner = 'heike'; B(s, 'sanjo_takakura').garrison = 50;
    mo.capital = 'onjoji';
  }
  function doSento(s) {
    mark(s, 'fukuhara_sento'); s.court.location = 'fukuhara';
    ensureCourt(s); s.court.dominance.heike += 8; s.court.cliques.sekkan.influence = Math.max(2, s.court.cliques.sekkan.influence - 3);
    ['enryakuji', 'nanto', 'onjoji'].forEach(function (k) { var r = rel(s, 'heike', k); r.value -= 15; });
    F(s, 'heike').legitimacy -= 5;
    ['antoku', 'takakura', 'tokuko'].forEach(function (p) { if (alive(s, p)) Pn(s, p).location = 'fukuhara'; });
    news(s, '【福原遷都】清盛は天皇・上皇を福原に移した。公家・寺社の不満が募る', { type: 'event', important: true, factions: ['heike'] });
    aiLog(s, 'heike', '福原遷都', '寺社勢力から距離を置き、海上交通の拠点を都とする');
  }
  function doKango(s) {
    mark(s, 'kyoto_return'); s.court.location = 'heiankyo';
    ['antoku', 'takakura', 'tokuko'].forEach(function (p) { if (alive(s, p)) Pn(s, p).location = 'heiankyo'; });
    ['enryakuji'].forEach(function (k) { rel(s, 'heike', k).value += 10; });
    news(s, '【還都】都が京へ戻された', { type: 'event', important: true, factions: ['heike'] });
    aiLog(s, 'heike', '還都', '反乱の拡大と公家・延暦寺の要求');
  }
  function yoshitsuneLeaves(s) {
    mark(s, 'yoshitsune_join');
    var yf = F(s, 'yoritomo'), cap = B(s, yf.capital);
    var a = createArmy(s, 'yoritomo', 'mutsu', 80, 'yoshitsune', { officers: ['tsuginobu', 'tadanobu'].filter(function (p) { return alive(s, p); }), food: 40, name: '義経主従' });
    ['yoshitsune', 'tsuginobu', 'tadanobu'].forEach(function (p) { if (alive(s, p)) Pn(s, p).faction = 'yoritomo'; });
    var tgt = factionArmies(s, 'yoritomo').filter(function (x) { return x.id !== a.id; }).sort(function (x, y) { return y.troops - x.troops; })[0];
    if (tgt) setArmyTarget(s, a, { type: 'province', id: tgt.province }, 'move'); else setArmyTarget(s, a, { type: 'base', id: cap.id }, 'move');
    news(s, '【義経出立】源義経が佐藤兄弟を伴い、兄頼朝のもとへ向かった', { type: 'event', important: true, factions: ['oshu', 'yoritomo'] });
    aiLog(s, 'oshu', '義経の出立を許す', '頼朝との関係を損ねない範囲で恩を売る');
  }

  function resolveEvent(s, evId, choiceId) {
    var ev = s.pendingStops.filter(function (e) { return e.id === evId; })[0];
    if (!ev) return { ok: false, reason: 'イベントが見つからない' };
    if (ev.resolved) return { ok: true, message: '解決済み' };
    if (ev.choices && ev.choices.length && !ev.choices.some(function (c) { return c.id === choiceId; })) return { ok: false, reason: '選択肢が不正: ' + choiceId };
    ev.resolved = true; ev.choice = choiceId;
    var msg = '';
    if (ev.key === 'kokushi_offer') { var kp = Pn(s, ev.person); if (choiceId === 'decline' || !kp || !kp.alive) return { ok: true, message: '国司の任命を辞退した' }; var tt = applyOffice(s, kp, 'kami', ev.province, choiceId, s.playerFaction, '朝廷の任命'); return { ok: true, message: kp.name + 'は' + tt + '（' + choiceId + '）となった' }; }
    if (ev.key === 'mudan') return { ok: true, message: resolveMudan(s, ev, choiceId) };
    if (ev.key === 'rewards') { var done0 = [], fid0 = s.playerFaction;
      (ev.helpers || []).forEach(function (h) { if (choiceId === 'later') return; var r1 = bestow(s, fid0, { kind: 'kanjo', target: h }); if (r1.ok) done0.push(h); if (choiceId === 'kanjo') bestow(s, fid0, { kind: 'gift', target: h }); });
      return { ok: true, message: choiceId === 'later' ? '恩賞は追って考える' : done0.length + '家に感状' + (choiceId === 'kanjo' ? 'と引出物' : '') + 'を与えた' }; }
    if (ev.key === 'attack_failed') { var arms0 = (ev.armies || []).map(function (id) { return s.armies[id]; }).filter(function (a) { return a && a.status !== 'battle'; });
      if (choiceId === 'return') { arms0.forEach(function (a) { disbandArmy(s, a, 'garrison'); }); return { ok: true, message: '兵を館に戻した（' + arms0.length + '隊）' }; }
      if (choiceId === 'retry') { arms0.forEach(function (a) { a.regroup = ev.base; a.holdUntil = s.day + 90; }); return { ok: true, message: arms0.length + '隊は兵を立て直し、士気が戻りしだい' + B(s, ev.base).name + 'を再び攻める' }; }
      arms0.forEach(function (a) { a.holdUntil = s.day + 60; }); return { ok: true, message: 'その場で待機する' }; }
    if (ev.key === 'choose_person') return { ok: true, message: applySuccessor(s, choiceId, ev.reason) };
    if (ev.key === 'cabal_demand') { var cb = (s.politics.cabals || []).filter(function (x) { return x.id === ev.cabal; })[0]; if (!cb) return { ok: true, message: '反対派はすでに解けていた' };
      if (choiceId === 'accept') return { ok: true, message: compromise(s, cb) };
      cb.refused = s.day; if (choiceId === 'divide' || choiceId === 'strike') { var rr = politicsAct(s, s.playerFaction, { act: choiceId, cabal: cb.id }); return { ok: true, message: '要求を拒んだ。' + (rr.ok ? rr.message : rr.reason) }; }
      return { ok: true, message: '要求を拒んだ。反対派の出方に備えよ' }; }
    if (ev.key === 'shogun_crisis' && s.shogunate && s.shogunate.crisis) { s.shogunate.crisis.playerSide = choiceId; return { ok: true, message: { oppose: '擁立する側についた', support: '将軍を支える側についた', neutral: '動かないことにした' }[choiceId] }; }
    if (ev.hist) {
      var he = s.histEvents.filter(function (x) { return x.id === ev.hist; })[0];
      if (he) { he.status = 'done'; he.firedDate = dateStr(s); if (choiceId === 'follow') { applyEffects(s, Object.assign({}, he, { stopAll: false })); msg = '史実どおりにした'; } else { he.status = 'declined'; msg = '史実と異なる道を選んだ'; } }
      news(s, '（選択）' + ev.title + '：' + msg, { type: 'choice', factions: [s.playerFaction] });
      return { ok: true, message: msg };
    }
    if (ev.sched) {
      var se = s.schedule.filter(function (x) { return x.id === ev.sched; })[0];
      if (choiceId === 'follow' && se) { execSchedule(s, se); msg = '史実どおりにした'; } else msg = '史実と異なる道を選んだ';
      news(s, '（選択）' + ev.title + '：' + msg, { type: 'choice', factions: [s.playerFaction] });
      return { ok: true, message: msg };
    }
    switch (ev.key) {
      case 'mochihito_ryoji': if (choiceId === 'issue') { issueRyoji(s); msg = '令旨を発した'; } else { s.flags.ryojiAsked = false; s.flags.ryojiDelay = s.day; msg = '時期を待つ'; } break;
      case 'mochihito_exposed': if (choiceId === 'flee') { mochihitoFlee(s); msg = '園城寺へ逃れる'; } else { var r = mobilize(s, 'mochihito', 'yamashiro', 300, 'yorimasa', { base: 'sanjo_takakura' }); msg = '京で兵を集める' + (r.error ? '（' + r.error + '）' : ''); } if (s.playerFaction === 'mochihito') { var r2 = mobilize(s, 'heike', 'yamashiro', 2500, 'tomomori', { base: 'rokuhara', officers: ['shigehira'] }); if (r2.army) setArmyTarget(s, r2.army, { type: 'base', id: choiceId === 'flee' ? 'onjoji' : 'sanjo_takakura' }, 'attack'); } break;
      case 'fukuhara_sento': if (choiceId === 'move') { doSento(s); msg = '遷都した'; } else { mark(s, 'fukuhara_sento'); msg = '京に留まる'; } break;
      case 'kyoto_return': if (choiceId === 'return') { doKango(s); msg = '還都した'; } else { s.flags.kangoAsked = false; s.firedEvents.fukuhara_sento = s.day; msg = '福原に留まる'; } break;
      case 'yoshitsune_join': if (choiceId === 'allow') { yoshitsuneLeaves(s); msg = '義経を送り出した'; } else { mark(s, 'yoshitsune_join'); rel(s, 'oshu', 'yoritomo').value -= 10; msg = '義経を引き留めた'; } break;
      case 'ryoji_arrival': if (choiceId === 'rise') { var u = uprising(s, s.playerFaction, '令旨を奉じて'); msg = u.ok ? u.message : u.reason; } else msg = '時機を待つ'; break;
      default: msg = '確認';
    }
    news(s, '（選択）' + ev.title + '：' + msg, { type: 'choice', factions: [s.playerFaction] });
    return { ok: true, message: msg };
  }

  // ================================================================ 命令（プレイヤー / AI 共通の構造化命令）
  // cmd.type: mobilize | march | disband | envoy | declare_war | uprising | petition | donate | buy_food | set_capital
  function issueCommand(s, cmd) {
    cmd.faction = cmd.faction || s.playerFaction;
    var f = F(s, cmd.faction); if (!f || !f.alive) return { ok: false, reason: '勢力が存在しない' };
    // 伝達遅延：当主の居所から軍勢/拠点までの距離
    var delay = commandDelay(s, cmd);
    var label = describeCommand(s, cmd);
    var pre = checkCommand(s, cmd); if (pre) { s.commandHistory.push({ day: s.day, date: dateStr(s), label: label, ok: false, reason: pre }); return { ok: false, reason: pre }; }
    if (delay > 0) {
      s.orders.push({ executeDay: s.day + delay, cmd: cmd, label: label });
      s.commandHistory.push({ day: s.day, date: dateStr(s), label: label, ok: true, delayed: delay });
      return { ok: true, message: label + ' ― 使者が命令を伝える（約' + delay + '日後に実行）', delayed: delay };
    }
    var r = executeCommand(s, cmd, false);
    s.commandHistory.push({ day: s.day, date: dateStr(s), label: label, ok: r.ok, reason: r.reason });
    return r;
  }
  function leaderProvince(s, f) { var p = Pn(s, f.leader); var pr = p ? personLocationProvince(s, p) : null; return pr || (B(s, f.capital) || {}).province; }
  function commandDelay(s, cmd) {
    var f = F(s, cmd.faction), lp = leaderProvince(s, f); if (!lp) return 0;
    var at = null;
    if (cmd.type === 'march' || cmd.type === 'disband') { var a = s.armies[cmd.army]; if (!a) return 0; if (a.commander === f.leader) return 0; at = a.province; }
    else if (cmd.type === 'mobilize') at = cmd.province;
    else return 0;
    if (!at || at === lp) return 0;
    var d = travelDays(s, lp, at, 55); return d <= 1 ? 0 : d - 1;
  }
  function checkCommand(s, cmd) {
    var f = F(s, cmd.faction);
    switch (cmd.type) {
      case 'mobilize': if (!PV(s, cmd.province)) return '国が不明'; break;
      case 'march': { var a = s.armies[cmd.army]; if (!a || a.faction !== cmd.faction) return '指定の軍勢がない'; if (a.status === 'battle') return '交戦中のため命令を受けられない'; if (!cmd.target) return '目的地が不明'; break; }
      case 'uprising': if (['yoritomo', 'kiso', 'kai', 'mochihito'].indexOf(cmd.faction) < 0 && f.status !== '雌伏') return 'この勢力は挙兵の対象ではない'; break;
    }
    return null;
  }
  function executeCommand(s, cmd, delayed) {
    var f = F(s, cmd.faction);
    switch (cmd.type) {
      case 'mobilize': {
        var org = [cmd.commander].concat((cmd.divisions || []).map(function (d) { return d.leader; })).concat(cmd.bugyo ? [cmd.bugyo] : []).filter(Boolean);
        var dup2 = org.filter(function (x, i) { return org.indexOf(x) !== i; }); if (dup2.length) return { ok: false, reason: pname(s, dup2[0]) + 'が二つの役に就いている' };
        for (var j = 0; j < org.length; j++) { if (!personFree(s, org[j], cmd.faction)) return { ok: false, reason: pname(s, org[j]) + 'は他の軍・使者に出ているか、家臣ではない' }; if (!personNear(s, org[j], cmd.province)) return { ok: false, reason: pname(s, org[j]) + 'は遠方にいて出陣に間に合わない（約5日以内の距離にいる者だけ任じられる）' }; }
        if (cmd.commander && nonCombatant(Pn(s, cmd.commander))) return { ok: false, reason: pname(s, cmd.commander) + 'は総大将にできない' };
        var r = mobilize(s, cmd.faction, cmd.province, cmd.troops, cmd.commander, { base: cmd.base, foodDays: cmd.foodDays || 30, divisions: cmd.divisions ? cmd.divisions.map(function (d) { return { leader: d.leader, troops: +d.troops || 0 }; }) : undefined, bugyo: cmd.bugyo });
        if (r.error) return { ok: false, reason: r.error };
        var msg = PV(s, cmd.province).name + 'で' + r.army.troops + 'を動員（総大将：' + pname(s, r.army.commander) + '、部隊' + r.army.divisions.length + '、軍奉行' + (r.army.bugyo ? pname(s, r.army.bugyo) : 'なし') + '、集結に' + r.gather + '日、費用' + r.cost + '貫・兵糧' + r.food + '石）';
        if (cmd.target && (cmd.mission || 'attack') === 'attack') { var rm = autoRise(s, cmd.faction, cmd.target); if (rm) msg += rm; }
        if (cmd.target) { var e = setArmyTarget(s, r.army, cmd.target, cmd.mission || 'attack'); r.army.status = 'gathering'; msg += e ? '。ただし進軍不可：' + e : '。集結後に' + targetName(s, cmd.target) + 'へ進軍する（' + estimateDays(s, r.army) + '日程度）'; }
        news(s, msg, { type: 'order', factions: [cmd.faction] });
        return { ok: true, message: msg, army: r.army.id };
      }
      case 'march': {
        var a = s.armies[cmd.army]; if (!a) return { ok: false, reason: '軍勢が見つからない（すでに消滅）' };
        if (a.status === 'battle') return { ok: false, reason: '交戦中' };
        var tgt = cmd.target, rm2 = cmd.mission !== 'move' ? autoRise(s, a.faction, tgt) : null;
        if (tgt.type === 'base' && B(s, tgt.id).owner && !sameCamp(s, B(s, tgt.id).owner, a.faction) && !atWar(s, a.faction, B(s, tgt.id).owner)) {
          if (!cmd.declare) return { ok: false, reason: fname(s, B(s, tgt.id).owner) + 'とは交戦状態にない。攻めるなら宣戦（declare）を伴う命令にせよ' };
          declareWar(s, a.faction, B(s, tgt.id).owner, '攻撃命令');
        }
        var e2 = setArmyTarget(s, a, tgt, cmd.mission || (tgt.type === 'base' && B(s, tgt.id).owner && atWar(s, a.faction, B(s, tgt.id).owner) ? 'attack' : 'move'));
        if (e2) return { ok: false, reason: e2 };
        var m2 = armyLabel(s, a) + 'が' + targetName(s, tgt) + 'へ進軍開始（経路：' + [a.province].concat(a.path).map(function (p) { return PV(s, p).name; }).join('→') + '、約' + estimateDays(s, a) + '日）';
        if (rm2) m2 += rm2;
        news(s, m2, { type: 'order', factions: [cmd.faction] }); return { ok: true, message: m2 };
      }
      case 'disband': { var a3 = s.armies[cmd.army]; if (!a3) return { ok: false, reason: '軍勢がない' }; if (a3.status === 'battle') return { ok: false, reason: '交戦中は解散できない' }; disbandArmy(s, a3, 'garrison'); return { ok: true, message: '軍勢を解散した' }; }
      case 'envoy': {
        if (cmd.person) { var p = Pn(s, cmd.person); if (!p || !p.alive || p.faction !== cmd.faction) return { ok: false, reason: '使者に指定した人物は自勢力にいない' }; if (p.captiveOf) return { ok: false, reason: p.name + 'は捕らわれている' }; if (String(p.location || '').indexOf('envoy:') === 0) return { ok: false, reason: p.name + 'はすでに使者として外出中' }; }
        if (cmd.proposal === 'submit' && cmd.to === 'court') return { ok: false, reason: '朝廷への奉仕は「朝廷工作」で行う' };
        return proposeDiplomacy(s, cmd.faction, cmd.to, cmd.proposal || 'alliance', cmd.person);
      }
      case 'declare_war': { if (atWar(s, cmd.faction, cmd.to)) return { ok: false, reason: 'すでに交戦中' }; if (sameCamp(s, cmd.faction, cmd.to)) return { ok: false, reason: '同盟・主従関係にある相手。先に関係を破棄せよ' }; declareWar(s, cmd.faction, cmd.to, '宣戦'); return { ok: true, message: fname(s, cmd.to) + 'に宣戦した' }; }
      case 'uprising': return uprising(s, cmd.faction, cmd.reason || 'プレイヤーの決断');
      case 'petition': return petitionCourt(s, cmd.faction, cmd.kind, cmd.target, cmd);
      case 'court_gift': return courtGift(s, cmd.faction, cmd.clique, cmd.amount);
      case 'jito': return appointJito(s, cmd.faction, cmd.holding);
      case 'regime': return regimeAct(s, cmd.faction, cmd.action, cmd);
      case 'ando': case 'grant': case 'confiscate': return lordAct(s, cmd.faction, cmd);
      case 'spoil': return decideSpoil(s, cmd.faction, cmd.holding, cmd.to);
      case 'bakufu': return cmd.act === 'shikken' ? (function () { var st = shikkenStatus(s, cmd.faction); if (!st || !st.ok) return { ok: false, reason: '執権の条件がそろっていない' }; if (s.shogunate.shikken) return { ok: false, reason: 'すでに執権がいる（' + pName(s, s.shogunate.shikken.holder) + '）。まず退けること' }; return grantShikken(s, cmd.faction); })() : bkAct(s, cmd.faction, cmd.act, cmd.target, cmd);
      case 'reform': return startReform(s, cmd.faction, cmd.kind, cmd);
      case 'politics': return politicsAct(s, cmd.faction, cmd);
      case 'vassal_order': return orderRetainer(s, cmd.faction, cmd);
      case 'vassal_command': return vassalCommand(s, cmd.faction, cmd);
      case 'withdraw': return withdrawArmy(s, cmd.faction, cmd.army);
      case 'bestow': return bestow(s, cmd.faction, cmd);
      case 'grant_base': return grantBase(s, cmd.faction, cmd);
      case 'rename_base': return renameBase(s, cmd.faction, cmd);
      case 'nominate': return nominate(s, cmd.faction, cmd);
      case 'resign_office': return resignOffice(s, cmd.faction, cmd);
      case 'appoint_office': return shikkenAppoint(s, cmd.faction, cmd);
      case 'build_facility': return buildFacility(s, cmd.faction, cmd);
      case 'split_corps': return splitCorps(s, cmd.faction, cmd);
      case 'set_heir': { var hp = Pn(s, cmd.person); if (!hp || !hp.alive || hp.faction !== cmd.faction || hp.id === f.leader) return { ok: false, reason: '自家の存命の一門を指定すること' }; f.heir = hp.id; ensureRegime(s); f.regime.heirStab = Math.max(0, f.regime.heirStab - 5); news(s, f.name + 'は' + hp.name + 'を後継者に定めた', { type: 'politics', factions: [cmd.faction] }); return { ok: true, message: hp.name + 'を後継者に定めた' }; }
      case 'donate': {
        var b = B(s, cmd.base); if (!b || b.type !== '寺社') return { ok: false, reason: '寄進先の寺社を指定してください' };
        var amt = Math.max(0, cmd.amount || 0); if (f.money < amt) return { ok: false, reason: '資金不足（所持' + Math.floor(f.money) + '貫）' };
        if (amt < 100) return { ok: false, reason: '寄進は100貫以上から（儀礼上の最低額・ゲーム設定）' };
        if (b.owner && atWar(s, cmd.faction, b.owner)) return { ok: false, reason: '交戦中の寺社には寄進できない' };
        f.money -= amt;
        var days = travelDays(s, (B(s, f.capital) || b).province, b.province, 45);
        s.orders.push({ executeDay: s.day + days, cmd: { type: '_donate_effect', faction: cmd.faction, base: b.id, amount: amt }, label: b.name + 'への寄進' });
        return { ok: true, message: b.name + 'へ' + amt + '貫の寄進を送った（到着まで' + days + '日）' };
      }
      case '_donate_effect': {
        var b2 = B(s, cmd.base); var gain = Math.round(Math.sqrt(cmd.amount) * 0.8);
        if (b2.owner && b2.owner !== cmd.faction) { var r3 = rel(s, cmd.faction, b2.owner); r3.value = clamp(r3.value + gain, -100, 100); }
        f.courtRelation = clamp(f.courtRelation + gain / 3, 0, 100); f.legitimacy = clamp(f.legitimacy + gain / 4, 0, 100);
        PV(s, b2.province).unrest = clamp(PV(s, b2.province).unrest - gain / 2, 0, 100);
        news(s, b2.name + 'が' + f.name + 'の寄進を受けた（関係・朝廷評価が上昇）', { type: 'religion', factions: [cmd.faction] });
        return { ok: true };
      }
      case 'buy_food': {
        var amt2 = cmd.amount || 0, capb = B(s, f.capital);
        var market = capb && ['山城', '摂津', '筑前'].indexOf(PV(s, capb.province).name) >= 0 ? 1 : (Object.keys(s.bases).some(function (k) { var bb = s.bases[k]; return bb.owner === cmd.faction && bb.type === '港'; }) ? 1.2 : 1.6);
        var limit = Math.round(PV(s, capb ? capb.province : 'yamashiro').output * 0.05);
        if (amt2 > limit) return { ok: false, reason: 'この地域の市場で買える量は約' + limit + '石まで（地域経済の制約）' };
        var price = Math.round(amt2 * market * foodPrice(s));
        if (f.money < price) return { ok: false, reason: '資金不足（必要' + price + '貫）' };
        f.money -= price; f.food += amt2; return { ok: true, message: amt2 + '石を' + price + '貫で購入' };
      }
      case 'build': return startConstruction(s, cmd);
      case 'recruit': return recruit(s, cmd.faction, cmd.province, cmd.amount);
      case 'sortie': return sortie(s, cmd);
      case 'corps_march': {
        var cp2 = s.corps[cmd.corps]; if (!cp2 || cp2.faction !== cmd.faction) return { ok: false, reason: '軍団がない' };
        var arms = Object.keys(s.armies).map(function (k) { return s.armies[k]; }).filter(function (x) { return x.corps === cmd.corps && x.status !== 'battle' && x.status !== 'siege'; });
        if (!arms.length) return { ok: false, reason: '動ける部隊がない（交戦中）' };
        if (cmd.target.type === 'base' && B(s, cmd.target.id).owner && !sameCamp(s, B(s, cmd.target.id).owner, cmd.faction) && !atWar(s, cmd.faction, B(s, cmd.target.id).owner)) { if (!cmd.declare) return { ok: false, reason: '交戦状態にない相手' }; declareWar(s, cmd.faction, B(s, cmd.target.id).owner, '攻撃命令'); }
        var miss = cmd.target.type === 'base' && B(s, cmd.target.id).owner && atWar(s, cmd.faction, B(s, cmd.target.id).owner) ? 'attack' : 'move';
        arms.forEach(function (x) { setArmyTarget(s, x, cmd.target, miss); });
        cp2.target = cmd.target;
        return { ok: true, message: pname(s, cp2.commander) + 'の軍団（' + arms.length + '隊）が' + targetName(s, cmd.target) + 'へ向かう' };
      }
      case 'garrison': return reinforceGarrison(s, cmd.faction, cmd.base, cmd.amount);
      case 'organize': {
        var oa = s.armies[cmd.army]; if (!oa || oa.faction !== cmd.faction) return { ok: false, reason: '軍勢がない' };
        if (oa.status === 'battle' || oa.status === 'siege') return { ok: false, reason: '交戦中は編成を変えられない' };
        var who = [cmd.commander].concat((cmd.divisions || []).map(function (d) { return d.leader; })).concat(cmd.bugyo ? [cmd.bugyo] : []).filter(Boolean);
        var dup = who.filter(function (x, i) { return who.indexOf(x) !== i; }); if (dup.length) return { ok: false, reason: pname(s, dup[0]) + 'が二つの役に就いている' };
        for (var i = 0; i < who.length; i++) { if (!personFree(s, who[i], cmd.faction, oa.id)) return { ok: false, reason: pname(s, who[i]) + 'は他の軍・使者に出ているか、家臣ではない' }; if (String(Pn(s, who[i]).location) !== 'army:' + oa.id && !personNear(s, who[i], oa.province)) return { ok: false, reason: pname(s, who[i]) + 'は遠方にいて合流できない' }; }
        var cp = Pn(s, cmd.commander); if (!cp || nonCombatant(cp)) return { ok: false, reason: '総大将には武将を選ぶこと' };
        releaseArmyPersons(s, oa);
        oa.commander = cmd.commander; oa.bugyo = cmd.bugyo || null; oa.divisions = (cmd.divisions || []).map(function (d) { return { leader: d.leader, troops: Math.max(0, Math.floor(d.troops)) }; });
        normalizeDivisions(oa);
        [oa.commander].concat(oa.officers).forEach(function (pid) { Pn(s, pid).location = 'army:' + oa.id; });
        var q = armyQuality(s, oa);
        return { ok: true, message: armyLabel(s, oa) + 'を編成した（総大将' + pname(s, oa.commander) + '、部隊' + oa.divisions.length + '、軍奉行' + (oa.bugyo ? pname(s, oa.bugyo) : 'なし') + '。軍の質 ' + Math.round(q.factor * 100) + (q.notes.length ? '：' + q.notes.join('、') : '') + '）' };
      }
      case 'found_bakufu': return foundBakufu(s, cmd.faction);
      case 'establish': return establishInstitution(s, cmd.faction, cmd.inst, cmd.head);
      case 'cancel_build': { var cb = s.constructions[cmd.id]; if (!cb || cb.faction !== cmd.faction) return { ok: false, reason: '普請が見つからない' }; delete s.constructions[cmd.id]; return { ok: true, message: cb.name + 'の普請を取りやめた（費用は戻らない）' }; }
      case 'set_capital': { var b3 = B(s, cmd.base); if (!b3 || b3.owner !== cmd.faction) return { ok: false, reason: '自勢力の拠点を指定してください' };
        if (b3.id === f.capital) return { ok: false, reason: 'すでに本拠点である' };
        if (Object.keys(s.battles).some(function (k) { return s.battles[k].base === b3.id; })) return { ok: false, reason: b3.name + 'は攻められている最中で、本拠点にできない' };
        if (b3.type === '寺社') return { ok: false, reason: '寺社は本拠点にできない' };
        var mc = Math.round(100 + b3.defense * 5); if (f.money < mc) return { ok: false, reason: '移転の費用 ' + mc + '貫が足りない' }; f.money -= mc;
        var oldCap = f.capital; f.capital = b3.id; if (oldCap && B(s, oldCap)) news(s, f.name + 'が本拠点を' + B(s, oldCap).name + 'から' + b3.name + 'へ移した（費用' + mc + '貫）', { type: 'politics', important: true, factions: [cmd.faction] }); if (f.leader && alive(s, f.leader) && !/^(army|envoy):/.test(String(Pn(s, f.leader).location || ''))) Pn(s, f.leader).location = b3.id; if (b3.id === 'kamakura') mark(s, 'kamakura_entry'); return { ok: true, message: b3.name + 'を本拠とした' }; }
    }
    return { ok: false, reason: '未対応の命令: ' + cmd.type };
  }
  function targetName(s, t) { return t.type === 'base' ? B(s, t.id).name : PV(s, t.id).name; }
  function estimateDays(s, a) { var km = 0, prev = a.province; a.path.forEach(function (p) { km += roadBetween(s, prev, p).km; prev = p; }); return Math.max(1, Math.round(km / Math.max(8, armySpeedKm(s, a, null) * 0.85))); }
  function describeCommand(s, c) {
    switch (c.type) {
      case 'mobilize': return (PV(s, c.province) ? PV(s, c.province).name : '?') + 'で動員' + (c.troops ? c.troops : '') + (c.target ? '→' + targetName(s, c.target) : '');
      case 'march': return (s.armies[c.army] ? armyLabel(s, s.armies[c.army]) : '軍勢') + '→' + (c.target ? targetName(s, c.target) : '?');
      case 'envoy': return '使者' + (c.person ? pname(s, c.person) : '') + '→' + fname(s, c.to) + '（' + ({ alliance: '同盟', vassal_request: '臣従要求', submit: '臣従', peace: '和睦', break: '破棄' }[c.proposal] || c.proposal) + '）';
      case 'petition': return '朝廷へ申請（' + (c.kind === 'tsuito' ? fname(s, c.target) + '追討' : c.kind === 'insen' ? '院宣' : c.kind === 'kokushi' ? (PV(s, c.province) ? PV(s, c.province).name : '') + 'の知行国' : '任官') + '）';
      case 'court_gift': return '朝廷の派閥へ献金' + c.amount + '貫';
      case 'jito': return (s.holdings[c.holding] ? s.holdings[c.holding].name : '') + 'に地頭を置く';
      case 'regime': return (REGIME_ACTS[c.action] || {}).label || '体制の施策';
      case 'bakufu': return '幕府政治'; case 'reform': return (REFORMS[c.kind] || {}).label || '制度改革'; case 'grant_base': return (B(s, c.base) ? B(s, c.base).name : '館') + 'を与える'; case 'rename_base': return '館の名を改める'; case 'nominate': return '任官の推挙：' + (Pn(s, c.person) ? Pn(s, c.person).name : '') + ((KAN[c.office] || {}).name ? '（' + KAN[c.office].name + '）' : ''); case 'resign_office': return '官を辞させる'; case 'bestow': return '御恩：' + ((BESTOW[c.kind] || {}).label || ''); case 'withdraw': return (s.armies[c.army] ? armyLabel(s, s.armies[c.army]) : '軍勢') + 'の退却'; case 'vassal_command': return '御家人への命：' + ({ muster: '兵を増やせ', recall: '帰陣', attack: '出陣', defend: '守り', join: '軍団に加われ' }[c.act] || ''); case 'vassal_order': return '指図：' + ({ attack: '出陣の要請', defend: '守りの要請', join: '軍団への合流' }[c.act] || ''); case 'politics': return { consult: '合議', guard: '警固', spy: '諜報', divide: '切り崩し', strike: '反対派の弾圧', compromise: '妥協', retire: '隠居' }[c.act] || '政治'; case 'appoint_office': return '幕府の人事';
      case 'spoil': return '没官領の処分'; case 'ando': return '本領安堵'; case 'grant': return '新恩給与'; case 'confiscate': return '所領の没収';
      case 'build_facility': return (FACILITIES[c.kind] || {}).label + 'の普請'; case 'split_corps': return '軍団の分割';
      case 'set_heir': return pname(s, c.person) + 'を後継者に';
      case 'donate': return (B(s, c.base) ? B(s, c.base).name : '') + 'へ寄進' + c.amount + '貫';
      case 'build': return (PV(s, c.province) ? PV(s, c.province).name : '') + 'で普請（' + ((BUILD[c.scale] || {}).label || '') + (c.name ? '・' + c.name : '') + '）';
      default: return c.type;
    }
  }

  // ================================================================ 自然言語の命令解釈（Claude版・Web版共通）
  function findByName(s, text, kinds) {
    var hits = [];
    function scan(coll, kind, nameFn) {
      Object.keys(coll).forEach(function (k) { var o = coll[k]; var names = nameFn(o); names.forEach(function (n) { if (n && text.indexOf(n) >= 0) hits.push({ kind: kind, id: k, name: n, pos: text.indexOf(n), len: n.length }); }); });
    }
    if (kinds.indexOf('base') >= 0) scan(s.bases, 'base', function (b) { return [b.name, b.name.replace(/（.*）/, ''), b.name.replace(/館|城|殿|御所$/, '').length >= 2 ? b.name.replace(/館|城$/, '') : null]; });
    if (kinds.indexOf('province') >= 0) scan(s.provinces, 'province', function (p) { return [p.name + '国', p.name]; });
    if (kinds.indexOf('person') >= 0) scan(s.persons, 'person', function (p) { var given = p.name.replace(/^(平|源|藤原|北条|三浦|千葉|上総|大庭|梶原|伊東|畠山|河越|佐竹|足利|新田|城|武田|安田|一条|中原|今井|樋口|佐藤|佐々木|土肥|安達|和田|菊池|河野|山木|九条|三善)/, ''); return [p.name, given.length >= 2 ? given : null]; });
    if (kinds.indexOf('faction') >= 0) scan(s.factions, 'faction', function (f) { return [f.name, f.name.replace(/（.*）/, ''), { heike: '平家', yoritomo: '頼朝', kiso: '木曽', kai: '甲斐源氏', oshu: '奥州', mochihito: '以仁王', court: '朝廷', nanto: '南都', kazusa: '上総広常' }[f.id]]; });
    hits.sort(function (a, b) { return a.pos - b.pos || b.len - a.len; });
    return hits;
  }
  var ALIAS = { '京都': 'heiankyo', '京': 'heiankyo', '都': 'heiankyo', '平泉': 'hiraizumi', '鎌倉': 'kamakura', '福原': 'fukuhara', '六波羅': 'rokuhara', '山木': 'yamaki', '比叡山': 'hieizan', '三井寺': 'onjoji', '奈良': 'kofukuji', '南都': 'kofukuji', '大宰府': 'dazaifu' };
  function parseCommand(s, text) {
    var t = text.replace(/\s/g, ''), fid = s.playerFaction, f = F(s, fid);
    if (!fid) return { error: '観戦モードでは命令できない' };
    function resolveTarget(seg) {
      for (var a in ALIAS) if (seg.indexOf(a) >= 0) return { type: 'base', id: ALIAS[a] };
      var h = findByName(s, seg, ['base', 'province']); if (h.length) return h[0].kind === 'base' ? { type: 'base', id: h[0].id } : { type: 'province', id: h[0].id };
      return null;
    }
    var m;
    if (/挙兵/.test(t) && !/を.*進軍/.test(t)) return { cmd: { type: 'uprising', faction: fid } };
    if ((m = t.match(/(.+?)(?:国)?の兵(?:を)?(\d+)?(?:人|騎)?(?:を)?(.+?)(?:へ|に|まで)(?:進軍|出陣|派兵|攻め)/))) {
      var src = findByName(s, m[1], ['province', 'base'])[0]; var tgt = resolveTarget(m[3]);
      if (!src) return { error: '動員する国が分からない：「' + m[1] + '」' }; if (!tgt) return { error: '目的地が分からない：「' + m[3] + '」' };
      var prov = src.kind === 'base' ? B(s, src.id).province : src.id;
      var cm = findByName(s, t, ['person']).filter(function (h) { return Pn(s, h.id).faction === fid; })[0];
      return { cmd: { type: 'mobilize', faction: fid, province: prov, troops: m[2] ? +m[2] : null, target: tgt, mission: 'attack', commander: cm ? cm.id : null } };
    }
    if ((m = t.match(/(.+?)(?:国)?で(?:兵を)?(\d+)?(?:人|騎)?(?:を)?(?:動員|募兵|集め)/))) {
      var src2 = findByName(s, m[1], ['province', 'base'])[0]; if (!src2) return { error: '国が分からない：「' + m[1] + '」' };
      return { cmd: { type: 'mobilize', faction: fid, province: src2.kind === 'base' ? B(s, src2.id).province : src2.id, troops: m[2] ? +m[2] : null } };
    }
    if ((m = t.match(/(.+?)(?:の軍|勢|軍)(?:勢)?を(.+?)(?:へ|に)(?:進軍|向かわ|移動|攻め|退)/))) {
      var who = findByName(s, m[1], ['person'])[0]; var army = who ? factionArmies(s, fid).filter(function (a) { return a.commander === who.id || a.officers.indexOf(who.id) >= 0; })[0] : null;
      if (!army) army = factionArmies(s, fid).filter(function (a) { return a.name && m[1].indexOf(a.name) >= 0; })[0];
      if (!army && factionArmies(s, fid).length === 1) army = factionArmies(s, fid)[0];
      if (!army) return { error: '軍勢が特定できない（指揮官名で指定してください）' };
      var tg2 = resolveTarget(m[2]); if (!tg2) return { error: '目的地が分からない：「' + m[2] + '」' };
      return { cmd: { type: 'march', faction: fid, army: army.id, target: tg2, declare: /攻め/.test(t) } };
    }
    if ((m = t.match(/(.+?)を使者(?:として)?(.+?)(?:へ|に)(?:派遣|送)/))) {
      var ep = findByName(s, m[1], ['person'])[0]; var to = findByName(s, m[2], ['faction'])[0];
      if (!ep) return { error: '使者の人物が分からない：「' + m[1] + '」' }; if (!to) return { error: '相手の勢力が分からない：「' + m[2] + '」' };
      var prop = /臣従を求|従わせ|味方に|勧誘|招/.test(t) ? 'vassal_request' : /臣従する|降/.test(t) ? 'submit' : /和睦|和平/.test(t) ? 'peace' : 'alliance';
      if (/味方|参陣/.test(t) && !/同盟/.test(t)) prop = 'vassal_request';
      return { cmd: { type: 'envoy', faction: fid, person: ep.id, to: to.id, proposal: prop } };
    }
    if (/追討/.test(t) && /朝廷|宣旨|申請/.test(t)) { var tf = findByName(s, t.replace(/朝廷/g, ''), ['faction'])[0]; if (!tf) return { error: '追討の対象勢力が分からない' }; return { cmd: { type: 'petition', faction: fid, kind: 'tsuito', target: tf.id } }; }
    if ((m = t.match(/(.+?)を(.+?)に任官/)) || (m = t.match(/(.+?)の(.+?)任官/))) { var ap = findByName(s, m[1], ['person'])[0]; if (!ap) return { error: '人物が分からない' }; return { cmd: { type: 'petition', faction: fid, kind: 'appointment', person: ap.id, office: m[2].replace(/への?/, '') } }; }
    if (/寄進/.test(t)) {
      var amt = (t.match(/(\d+)貫/) || [])[1]; var tb = findByName(s, t, ['base']).filter(function (h) { return B(s, h.id).type === '寺社'; })[0];
      if (!tb) return { error: '寄進先の寺社が分からない（例：「伊勢神宮に500貫寄進する」）' };
      return { cmd: { type: 'donate', faction: fid, base: tb.id, amount: amt ? +amt : 500 } };
    }
    if (/(館|城)を?(?:建|築|作|造)|築城|普請/.test(t)) {
      var bp = findByName(s, t, ['province'])[0]; if (!bp) return { error: '建設する国が分からない（例：「相模国に城館を築く」）' };
      var sc = /城郭|大規模|山城/.test(t) ? 'large' : /城館|堀|中規模/.test(t) ? 'medium' : 'small';
      var nm = (t.match(/「(.+?)」/) || [])[1];
      return { cmd: { type: 'build', faction: fid, province: bp.id, scale: sc, name: nm } };
    }
    if ((m = t.match(/兵糧を?(\d+)石?(?:を)?(?:購入|買)/))) return { cmd: { type: 'buy_food', faction: fid, amount: +m[1] } };
    if ((m = t.match(/(.+?)に宣戦/))) { var wf = findByName(s, m[1], ['faction'])[0]; if (!wf) return { error: '勢力が分からない' }; return { cmd: { type: 'declare_war', faction: fid, to: wf.id } }; }
    if ((m = t.match(/(.+?)を本拠/))) { var hb = resolveTarget(m[1]); if (!hb || hb.type !== 'base') return { error: '拠点が分からない' }; return { cmd: { type: 'set_capital', faction: fid, base: hb.id } }; }
    if ((m = t.match(/(.+?)(?:の軍|勢)を?解散/))) { var dw = findByName(s, m[1], ['person'])[0]; var da = dw && factionArmies(s, fid).filter(function (a) { return a.commander === dw.id; })[0]; if (!da) return { error: '軍勢が特定できない' }; return { cmd: { type: 'disband', faction: fid, army: da.id } }; }
    return { error: '命令を解釈できなかった。例：「相模国の兵を京都へ進軍させる」「北条時政を使者として三浦氏へ派遣し味方に誘う」「朝廷に頼朝の追討を申請する」「伊勢神宮に500貫寄進する」「挙兵する」' };
  }

  // ================================================================ セーブ・ロード
  function save(s) { return JSON.stringify(s); }
  function load(json) {
    var s = typeof json === 'string' ? JSON.parse(json) : json;
    if (!s || !s.engineVersion || !s.factions || !s.date) throw new Error('セーブデータの形式が不正');
    if (s.engineVersion.split('.')[0] !== ENGINE_VERSION.split('.')[0]) throw new Error('エンジンのメジャーバージョンが異なる');
    s.corps = s.corps || {}; s.recruits = s.recruits || []; s.constructions = s.constructions || {};
    ensureCourt(s); ensureHoldings(s); ensureRegime(s); migrateHouses(s); migrateHouses3(s); migrateHouses4(s); ensurePlayer(s); ensurePolitics(s); ensureNinkan(s); s.options.goal = s.options.goal || 'unify'; s.objectives = s.objectives || {};
    return s;
  }
  function summary(s) {
    var pf = s.playerFaction ? F(s, s.playerFaction) : null;
    return {
      date: dateStr(s), day: s.day, player: pf ? pf.name : null,
      factions: Object.keys(s.factions).map(function (k) { var f = s.factions[k], p = factionPower(s, k); return { id: k, name: f.name, alive: f.alive, status: f.status, leader: pname(s, f.leader), capital: f.capital ? B(s, f.capital).name : null, overlord: f.overlord, money: Math.round(f.money), food: Math.round(f.food), troopsAvailable: p.available, field: p.field, legitimacy: Math.round(f.legitimacy), choteki: !!f.flags.choteki }; }),
      armies: Object.keys(s.armies).map(function (k) { var a = s.armies[k]; return { id: k, label: armyLabel(s, a), faction: a.faction, province: PV(s, a.province).name, status: a.status, target: a.target ? targetName(s, a.target) : null, morale: Math.round(a.morale), fatigue: Math.round(a.fatigue), food: Math.round(a.food) }; }),
      battles: Object.keys(s.battles).map(function (k) { return s.battles[k].name; }),
      court: { location: B(s, s.court.location).name, controller: courtController(s), cloistered: pname(s, s.court.cloisteredEmperor) },
    };
  }

  // ================================================================ 年代検証（受入条件：年代矛盾の検出／未確認項目の一覧）
  function validate(s) {
    var y = s.date.y, errors = [], uncertain = [];
    Object.keys(s.persons).forEach(function (k) {
      var p = s.persons[k];
      if (p.born && p.born > y) errors.push(p.name + '：生年' + p.born + 'は現在(' + y + ')より後');
      if (p.died && p.died < y && p.alive) errors.push(p.name + '：史実の没年' + p.died + 'を過ぎて存命（分岐による可能性）');
      (p.warriorOffices || []).forEach(function (o) { var od = s.offices.filter(function (x) { return x.name === o; })[0]; if (od && od.established > y) errors.push(p.name + '：' + o + 'は' + od.established + '年成立'); });
      if (['要確認', '伝承', 'ゲーム設定'].indexOf(p.birthConfidence) >= 0) uncertain.push({ kind: '人物', item: p.name, confidence: p.birthConfidence, note: p.note || '生年不詳' });
      if (/要確認/.test(p.rank + (p.courtOffices || []).join())) uncertain.push({ kind: '官位官職', item: p.name, confidence: '要確認', note: p.rank + ' ' + (p.courtOffices || []).join('・') });
    });
    Object.keys(s.bases).forEach(function (k) { var b = s.bases[k]; if (b.confidence !== '史実') uncertain.push({ kind: '拠点', item: b.name, confidence: b.confidence, note: b.note }); });
    Object.keys(s.provinces).forEach(function (k) { var p = s.provinces[k]; if (p.kokuga.confidence === '要確認') uncertain.push({ kind: '知行国', item: p.name, confidence: '要確認', note: p.kokuga.note }); });
    uncertain.push({ kind: '数値', item: '兵力・生産力・資金', confidence: '推定', note: '軍記物の誇張を割り引いたゲーム上の推定値' });
    uncertain.push({ kind: '暦', item: '月の大小', confidence: '推定', note: '30/29日交互の近似。閏月は1181年閏2月・1183年閏10月のみ設定' });
    if (s.court.ministers && !s.court.ministers.naidaijin) uncertain.push({ kind: '朝廷', item: '内大臣', confidence: '要確認', note: '治承4年時点の在任者未確定のため空欄' });
    return { errors: errors, uncertain: uncertain };
  }

  return {
    version: ENGINE_VERSION,
    createGame: createGame, advanceDay: advanceDay, runDays: runDays, runUntilMonthEnd: runUntilMonthEnd,
    issueCommand: issueCommand, BUILD: BUILD, buildRights: buildRights, INSTITUTIONS: INSTITUTIONS, bakufuCheck: bakufuCheck,
    unifyStatus: unifyStatus, killPerson: killPerson, shogunState: shogunState, clanStatus: clanStatus, arrivalsTick: arrivalsTick, ARRIVALS: ARRIVALS, politicalStatus: politicalStatus, orderRetainer: orderRetainer, vassalCommand: vassalCommand, callPreview: callPreview, ENGINE_VERSION: ENGINE_VERSION, grantBase: grantBase, renameBase: renameBase, KAN: KAN, ninkanEra: ninkanEra, nominate: nominate, candidatesFor: candidatesFor, kakushiki: kakushiki, jinji: jinji, ninkanMonthly: ninkanMonthly, ninkanTick: ninkanTick, applyOffice: applyOffice, houseOfPerson: houseOfPerson, houseRecruitRoom: houseRecruitRoom, addService: addService, BESTOW: BESTOW, bestow: bestow, cabalView: cabalView, grudge: grudge, addGrudge: addGrudge, successorCandidates: successorCandidates, candidateInfo: candidateInfo, openSelection: openSelection, applySuccessor: applySuccessor, politicsMonthly: politicsMonthly, cabalTick: cabalTick, tryAssassinate: tryAssassinate, fallPerson: fallPerson, politicsAct: politicsAct, canLead: canLead, ensurePolitics: ensurePolitics, supportFrom: supportFrom, shogunTick: shogunTick, clanTick: clanTick, houseDrift: houseDrift, bakufuChart: bakufuChart, pendingSpoils: pendingSpoils, kinship: kinship, serviceOf: serviceOf, loyaltyTick: loyaltyTick, transferPlayer: transferPlayer, participants: participants, shikkenStatus: shikkenStatus, REFORMS: REFORMS, tie: tie, pName: pName, shogunTie: shogunTie, reformSupport: reformSupport, birthsTick: birthsTick, shogunateTick: shogunateTick, retainersOf: retainersOf, retLoyalty: retLoyalty, landCategory: landCategory, houseTroops: houseTroops, houseHoldings: houseHoldings, houseBands: houseBands, FACILITIES: FACILITIES, ROUTES: ROUTES, houseToFaction: houseToFaction, joinDecision: joinDecision, regimeOf: regimeOf, regimeHouses: regimeHouses, REGIME_ACTS: REGIME_ACTS, heirScore: heirScore, distributeIncome: distributeIncome, jitoAllowed: jitoAllowed, SHARES: SHARES, supplyAt: supplyAt, foodPrice: foodPrice, baseFoodCap: baseFoodCap, DIFFICULTY: DIFFICULTY, GOALS: GOALS, objectiveStatus: objectiveStatus, courtSupport: courtSupport, cliqueAtt: cliqueAtt, insenAvailable: insenAvailable, risesBy: risesBy,
    estimateOdds: estimateOdds, armyQuality: armyQuality, personFree: personFree, personNear: personNear,
    recruitInfo: recruitInfo, histEventStatus: histEventStatus, sortieSources: sortieSources, oddsFor: oddsFor, parseCommand: parseCommand, resolveEvent: resolveEvent,
    save: save, load: load, validate: validate, summary: summary,
    util: { dateStr: dateStr, armyLabel: armyLabel, provinceInfluence: provinceInfluence, factionPower: factionPower, campPower: campPower,
      findPath: findPath, distProv: distProv, atWar: atWar, sameCamp: sameCamp, topLord: topLord, rel: rel, holdingsOf: holdingsOf, travelDays: travelDays,
      courtInfluence: courtInfluence, courtController: courtController, estimateDays: estimateDays, availableBandTroops: availableBandTroops, personLocationProvince: personLocationProvince },
  };
});
