const assert = require('node:assert/strict');
const { replay, summary, selectFold, grid, indicators, registerSingleLegResearch } = require('../singleLegResearch');
const stock = [0, 1, 2, 3, 4].map(i => ({ date: `2026-01-0${i+1}`, rsi: 60, histogram: 1, high: 102, low: 98, open: 100 }));
const setup = { index: 1, id: 'test', expiration: '2026-01-16', strike: 100, dte: 14 };
const bars = new Map(stock.map(b => [b.date, { open: 1, high: 1.1, low: .9, close: 1 }]));
const rule = { hold: 3, target: 50, stop: 30, mode: 'bracket' };
const run = () => replay({ setup, rule, stock, optionBars: bars, frictionBps: 0, type: 'call' });
bars.set('2026-01-02', { open: 1, high: 1.8, low: .6, close: 1.2 });
assert.equal(run().exit_reason, 'stop'); assert.equal(run().exit_price, .7); assert.equal(run().ambiguous_bar, true);
assert.equal(run().mfe_pct, 0); // Never count a post-stop high as reachable.
bars.set('2026-01-02', { open: 1, high: 1.1, low: .9, close: 1 });
bars.set('2026-01-03', { open: .4, high: .6, low: .3, close: .5 });
assert.equal(run().exit_price, .4); assert.equal(run().exit_reason, 'stop gap');
bars.delete('2026-01-03'); assert.equal(run(), null);
bars.set('2026-01-03', { open: 1, high: 1.1, low: .9, close: 1 });
assert.equal(run().hold_sessions, 3);
const dteTrade = replay({ setup: { ...setup, expiration: '2026-01-05' }, rule, stock, optionBars: bars, frictionBps: 0, type: 'call' });
assert.equal(dteTrade.exit_reason, '3 DTE exit');
const friction = replay({ setup, rule, stock, optionBars: bars, frictionBps: 10, type: 'call' });
assert.ok(friction.return_pct < 0); assert.ok(Math.abs(friction.return_pct + .09995) < .001);
const m = summary([{ pnl: 20, return_pct: 20, premium_paid: 100, mfe_pct: 25, mae_pct: -5, hold_sessions: 1 }, { pnl: -40, return_pct: -40, premium_paid: 100, mfe_pct: 0, mae_pct: -40, hold_sessions: 2 }]);
assert.equal(m.expectancy_dollars, -10); assert.equal(m.profit_factor, .5); assert.equal(m.realized_drawdown_dollars, 40);
assert.equal(grid('call').length, 11250); assert.equal(grid('put').length, 11250);
const seen=[];
const fold = selectFold({ rules: [{ id: 'A' }, { id: 'B' }], train: ['train'], validation: ['val'], test: ['test'], evaluate(rule, window) {
  seen.push(rule.id + ':' + window[0]);
  const pnl = window[0] === 'train' ? (rule.id === 'A' ? 10 : 5) : window[0] === 'val' ? (rule.id === 'A' ? 1 : 9) : (rule.id === 'A' ? 1000 : -20);
  return Array.from({length:5}, () => ({ pnl, return_pct: pnl, premium_paid: 100, mfe_pct: 0, mae_pct: 0, hold_sessions: 1 }));
} });
assert.equal(fold.selected.rule.id, 'B'); assert.ok(!seen.includes('A:test')); // A's better unseen result cannot alter selection.
assert.equal(indicators(Array.from({length:20},(_,i)=>({time:`2026-01-${String(i+1).padStart(2,'0')}`,close:100}))).at(-1).rsi,50);

// Diagnostic capture must leave fills unchanged and expose anomalous denominators.
const auditBars = new Map(stock.map(b => [b.date, { date: b.date, open: 1, high: 1.1, low: .9, close: 1, raw: { volume: 5 } }]));
auditBars.set('2026-01-02', { date: '2026-01-02', open: .01, high: .012, low: .009, close: .011, raw: { open_price: '.01', volume: 0 } });
auditBars.set('2026-01-03', { date: '2026-01-03', open: 10, high: 11, low: 9, close: 10, raw: { open_price: '10', volume: 5 } });
const auditArgs = { setup, rule, stock, optionBars: auditBars, frictionBps: 0, type: 'call' };
const plain = replay(auditArgs), audited = replay({ ...auditArgs, includeAudit: true });
assert.equal(audited.pnl, plain.pnl); assert.equal(audited.return_pct, plain.return_pct);
assert.ok(audited.price_quality_flags.includes('entry_below_10_cents'));
assert.ok(audited.price_quality_flags.includes('return_above_1000_pct'));
assert.ok(audited.price_quality_flags.includes('zero_volume_in_held_path'));
assert.equal(audited.audit.raw_entry_open, .01); assert.equal(audited.audit.raw_exit_fill, 10);
assert.equal(audited.audit.held_path.length, 2);

// Exercise the complete route using synthetic provider responses, not fabricated market results.
async function integration() {
  let handler; const app={post(url, fn){assert.equal(url,'/scanner/single-leg-research');handler=fn;}};
  const days=[];const start=new Date();start.setUTCDate(start.getUTCDate()-360);start.setUTCHours(14,30,0,0);
  for(let i=0;i<359;i++){const d=new Date(+start+i*86400000);if(![0,6].includes(d.getUTCDay()))days.push(d);}
  const stockBars=days.map((d,i)=>({time:d.toISOString(),open:100+i*.1,close:100+i*.1,high:101+i*.1,low:99+i*.1}));
  registerSingleLegResearch(app,{normalizeTicker:s=>s.toUpperCase(),unwrap:x=>x,extractStock:x=>x,
    nextFriday:d=>{const a=new Date(d);a.setUTCDate(a.getUTCDate()+(5-a.getUTCDay()+7)%7);return a;},
    loadInstruments:async({expiration,type})=>Array.from({length:40},(_,i)=>({id:expiration+'_'+i,strike_price:90+i,type})),
    extractOptions:x=>x,normalizeOptions:x=>x.bars,
    call:async(name,args)=>name==='get_equity_historicals'?stockBars:args.instrument_ids.map(id=>({instrument_id:id,bars:days.filter(d=>d.toISOString().slice(0,10)<=id.slice(0,10)).map(d=>({date:d.toISOString().slice(0,10),open:1,high:1.7,low:.95,close:1.2}))}))});
  let payload, status=200;const res={status(n){status=n;return this;},json(data){payload=data;}};
  await handler({body:{symbol:'PLTR',optionType:'call',lookbackDays:365,frictionBps:10}},res);
  assert.equal(status,200,payload?.error);assert.equal(payload.coverage.rules_tested,11250);
  assert.ok(payload.holdout.selected); assert.equal(payload.research_version, '1.1-diagnostics'); assert.equal(payload.holdout.training_trades.length, payload.holdout.selected.training.trades); assert.equal(payload.holdout.validation_trades.length, payload.holdout.selected.validation.trades); assert.ok(payload.holdout.trades.every(t=>t.audit && Array.isArray(t.price_quality_flags))); assert.ok(payload.holdout.trades.length>=5);
  assert.ok(payload.holdout.trades.every(t=>t.signal_date>=payload.holdout.test[0]&&t.exit_date<=payload.holdout.test[1]));
  assert.ok(payload.holdout.trades.every((t,i,all)=>!i||t.entry_date>all[i-1].exit_date));
  assert.ok(payload.folds.every(f=>f.test[1]<payload.holdout.test[0]));
  console.log('Replay, metrics, frozen selection, JSX-independent engine, and full mocked route checks passed.');
}
integration().catch(e=>{console.error(e);process.exitCode=1;});
