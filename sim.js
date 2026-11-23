// node tools/sim.js <日数> <seed> [historical|free] [player]
const E=require('../engine/engine.js'),fs=require('fs');
const scn=JSON.parse(fs.readFileSync(__dirname+'/../data/scenario_1180.json','utf8'));
const days=+process.argv[2]||300, seed=+process.argv[3]||11804, mode=process.argv[4]||'historical', pf=process.argv[5]||null;
const s=E.createGame(scn,{seed, playerFaction:pf, mode});
for(let i=0;i<days;i++){ s.pendingStops.forEach(e=>{ if(!e.resolved) E.resolveEvent(s,e.id,(e.choices[0]||{}).id); }); E.advanceDay(s); }
s.log.filter(l=>l.important||/史実/.test(l.text)).forEach(l=>console.log(l.date.replace(/（.*）/,''),l.text.slice(0,90)));
