import { useState } from "react";

const inputClass =
  "rounded border border-zinc-700 bg-zinc-950 p-2 text-zinc-200";
const fmt = (v, suffix = "") =>
  v == null || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toFixed(2) + suffix;
const dollars = v => v == null ? "—" : "$" + fmt(v);
const dates = v => Array.isArray(v) ? v.join(" → ") : "—";
const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;

function ruleText(r) {
  if (!r) return "No passing rule in the training shortlist";
  return [
    `${r.dte} target DTE`,
    Number(r.money) === 0
      ? "ATM"
      : `${Math.abs(r.money)}% ${Number(r.money) < 0 ? "ITM" : "OTM"}`,
    `${r.score}-of-3 signals`,
    `RSI vote threshold ${r.rsi}`,
    `${r.hold}-session maximum hold`,
    r.mode,
    r.target != null ? `+${r.target}% target / -${r.stop}% stop` : null,
  ].filter(Boolean).join(" · ");
}

const metrics = [
  ["Trades", "trades", v => v ?? "—"],
  ["Win rate", "win_rate_pct", v => fmt(v, "%")],
  ["Average return", "average_return_pct", v => fmt(v, "%")],
  ["Median return", "median_return_pct", v => fmt(v, "%")],
  ["Expectancy / contract", "expectancy_dollars", dollars],
  ["Total P/L", "pnl", dollars],
  ["Premium paid", "premium_paid", dollars],
  ["Return on premium", "return_on_premium_pct", v => fmt(v, "%")],
  ["Realized drawdown", "realized_drawdown_dollars", dollars],
  ["Average winner", "average_winner_pct", v => fmt(v, "%")],
  ["Average loser", "average_loser_pct", v => fmt(v, "%")],
  ["Average MFE", "average_mfe_pct", v => fmt(v, "%")],
  ["Average MAE", "average_mae_pct", v => fmt(v, "%")],
  ["Average holding sessions", "average_hold_sessions", v => fmt(v)],
  ["Losing 50%+", "loss_50_pct", v => fmt(v, "%")],
  ["Gaining 50%+", "gain_50_pct", v => fmt(v, "%")],
  ["Ambiguous exit bars", "ambiguous_bars", v => v ?? "—"],
];
const profitFactor = d => !d ? "Not evaluated" :
  d.no_losses ? "No losses in sample" : fmt(d.profit_factor);

function summarize(rows) {
  const returns = rows.map(t => t.return_pct).sort((a, b) => a - b);
  const wins = rows.filter(t => t.pnl > 0);
  const losses = rows.filter(t => t.pnl < 0);
  const profit = wins.reduce((a, t) => a + t.pnl, 0);
  const loss = -losses.reduce((a, t) => a + t.pnl, 0);
  const premium = rows.reduce((a, t) => a + t.premium_paid, 0);
  let equity = 10000, peak = 10000, drawdown = 0;
  for (const t of rows) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return {
    trades: rows.length,
    win_rate_pct: rows.length ? wins.length / rows.length * 100 : null,
    average_return_pct: mean(returns),
    median_return_pct: returns.length ?
      (returns[Math.floor((returns.length - 1) / 2)] +
       returns[Math.floor(returns.length / 2)]) / 2 : null,
    expectancy_dollars: mean(rows.map(t => t.pnl)),
    profit_factor: loss ? profit / loss : null,
    no_losses: rows.length > 0 && !losses.length,
    pnl: profit - loss,
    premium_paid: premium,
    return_on_premium_pct: premium ? (profit - loss) / premium * 100 : null,
    realized_drawdown_dollars: drawdown,
    average_winner_pct: mean(wins.map(t => t.return_pct)),
    average_loser_pct: mean(losses.map(t => t.return_pct)),
    average_mfe_pct: mean(rows.map(t => t.mfe_pct)),
    average_mae_pct: mean(rows.map(t => t.mae_pct)),
    average_hold_sessions: mean(rows.map(t => t.hold_sessions)),
    loss_50_pct: rows.length ?
      rows.filter(t => t.return_pct <= -50).length / rows.length * 100 : null,
    gain_50_pct: rows.length ?
      rows.filter(t => t.return_pct >= 50).length / rows.length * 100 : null,
    ambiguous_bars: rows.filter(t => t.ambiguous_bar).length,
  };
}

function validBar(b) {
  return !!b &&
    [b.open, b.high, b.low, b.close].every(Number.isFinite) &&
    b.low >= 0 &&
    b.low <= Math.min(b.open, b.close) &&
    b.high >= Math.max(b.open, b.close);
}

function qualityCheck(t, type) {
  const a = t.audit;
  const issues = [];
  if (!a || !Array.isArray(a.held_path) || !a.held_path.length ||
      !validBar(a.prior_option_bar) || !Number.isFinite(Number(t.strike))) {
    return { status: "unverifiable", issues: ["Missing or invalid audit inputs"] };
  }
  const prior = a.prior_option_bar;
  if ([prior.open, prior.high, prior.low, prior.close]
      .every(v => v <= 0.0100001)) {
    issues.push("Prior-session option OHLC entirely at or below $0.01");
  }
  const held = a.held_path.filter(row => !row.entry_only);
  if (!held.length || held.some(row => !row.option || !row.stock)) {
    return { status: "unverifiable", issues: ["Incomplete held-path audit"] };
  }
  for (const row of held) {
    if (!validBar(row.option) || !validBar(row.stock)) {
      issues.push(`${row.date}: malformed replay bar`);
      continue;
    }
    const intrinsic = Math.max(0, type === "put"
      ? Number(t.strike) - row.stock.high
      : row.stock.low - Number(t.strike));
    if (row.option.low + 0.05 < intrinsic) {
      issues.push(
        `${row.date}: option low ${dollars(row.option.low)} below intrinsic proxy ${dollars(intrinsic)}`
      );
    }
  }
  return { status: issues.length ? "excluded" : "retained", issues };
}

function Metrics({ data }) {
  if (!data) return <p className="text-sm text-zinc-400">Not evaluated.</p>;
  const rows = [
    ...metrics.map(([label, key, f]) => [label, f(data[key])]),
    ["Profit factor", profitFactor(data)],
  ];
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
    {rows.map(([label, value]) => <div key={label}
      className="rounded border border-zinc-700 p-2">
      <div className="text-xs text-zinc-400">{label}</div><div>{value}</div>
    </div>)}
  </div>;
}

function Comparison({ columns, showRules = false }) {
  return <div className="overflow-auto">
    <table className="w-full text-left text-sm">
      <thead><tr className="border-b border-zinc-700">
        <th className="p-2">Metric</th>
        {columns.map(c => <th key={c.label} className="min-w-40 p-2">{c.label}</th>)}
      </tr></thead>
      <tbody>
        {showRules && <tr className="border-b border-zinc-800">
          <td className="p-2 text-zinc-400">Selected rule</td>
          {columns.map(c => <td key={c.label} className="max-w-xs p-2 text-xs">
            {ruleText(c.fold?.selected?.rule)}
          </td>)}
        </tr>}
        {metrics.map(([label, key, f]) => <tr key={key}
          className="border-b border-zinc-800">
          <td className="p-2 text-zinc-400">{label}</td>
          {columns.map(c => <td key={c.label} className="p-2">
            {c.data ? f(c.data[key]) : "Not evaluated"}
          </td>)}
        </tr>)}
        <tr><td className="p-2 text-zinc-400">Profit factor</td>
          {columns.map(c => <td key={c.label} className="p-2">
            {profitFactor(c.data)}
          </td>)}
        </tr>
      </tbody>
    </table>
  </div>;
}

function RawDetails({ title, value }) {
  return <details><summary className="cursor-pointer">{title}</summary>
    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  </details>;
}

function TradeTable({ trades = [] }) {
  return <details><summary className="cursor-pointer">Trades ({trades.length})</summary>
    <div className="overflow-auto"><table className="w-full text-left text-xs">
      <thead><tr>
        {["Entry", "Exit", "Strike", "DTE", "Return", "P/L", "Exit reason"]
          .map(v => <th key={v} className="p-2">{v}</th>)}
      </tr></thead>
      <tbody>{trades.map((t, i) => <tr key={i} className="border-t border-zinc-800">
        <td className="p-2">{t.entry_date}</td><td className="p-2">{t.exit_date}</td>
        <td className="p-2">{t.strike}</td><td className="p-2">{t.actual_dte}</td>
        <td className="p-2">{fmt(t.return_pct, "%")}</td>
        <td className="p-2">{dollars(t.pnl)}</td>
        <td className="p-2">{t.exit_reason}</td>
      </tr>)}</tbody>
    </table></div>
  </details>;
}

function PriceAudit({ fold, optionType }) {
  const [showAll, setShowAll] = useState(false);
  const groups = [
    ["Training", fold.training_trades || fold.selected?.training_trades || []],
    ["Validation", fold.validation_trades || fold.selected?.validation_trades || []],
    ["Test", fold.trades || []],
  ];
  const rows = groups.flatMap(([group, trades]) => trades.map((t, index) => {
    const check = qualityCheck(t, optionType);
    const flags = [...(t.price_quality_flags || [])];
    if (check.status === "excluded") flags.push(...check.issues);
    const first = t.audit?.held_path?.find(r => r.option)?.option;
    const open = t.audit?.raw_entry_open ?? first?.open;
    if (open > 0 && first?.close / open >= 3) {
      flags.push("Entry-day close is at least three times the open");
    }
    return { group, index, trade: t, check, flags: [...new Set(flags)] };
  }));
  const flagged = rows.filter(r => r.flags.length);
  return <details className="rounded border border-amber-500/30 p-3">
    <summary className="cursor-pointer">
      Price audit: {flagged.length}/{rows.length} selected-rule trades flagged
    </summary>
    <p className="my-2 text-xs text-amber-200">
      Display alerts do not change selection. The quality filter excludes only
      its specified checks, not every audit alert. Daily intrinsic checks are approximate.
    </p>
    <label className="my-3 flex items-center gap-2 text-sm">
      <input type="checkbox" checked={showAll}
        onChange={e => setShowAll(e.target.checked)} />Show all trades
    </label>
    {rows.some(r => r.check.status === "unverifiable") &&
      <p className="my-2 text-xs text-amber-300">Some audits are incomplete.</p>}
    {(showAll ? rows : flagged).map(r => <details
      key={`${r.group}-${r.index}`} className="my-2 rounded border border-zinc-700 p-3">
      <summary className="cursor-pointer text-sm">
        {r.group} · {r.trade.entry_date} → {r.trade.exit_date} ·
        strike {r.trade.strike} · {fmt(r.trade.return_pct, "%")}
      </summary>
      <p className="my-2 text-xs">
        Entry model: {r.trade.entry_model || "open"} ·
        raw entry {dollars(r.trade.audit?.raw_entry_price)} ·
        raw exit {dollars(r.trade.audit?.raw_exit_fill)}
      </p>
      {!!r.flags.length && <ul className="my-2 list-disc pl-5 text-xs text-amber-300">
        {r.flags.map(flag => <li key={flag}>{flag}</li>)}
      </ul>}
      <RawDetails title="Raw bars and calculation inputs" value={r.trade} />
    </details>)}
  </details>;
}

function Fold({ fold, title, optionType }) {
  if (!fold) return null;
  const selected = fold.selected;
  const test = fold.test_summary;
  const status = !selected ? "Test not evaluated" :
    !test?.trades ? "No replayable test trades" :
    test.pnl > 0 ? "Positive test sample" :
    test.pnl < 0 ? "Negative test sample" : "Flat test sample";
  return <div className="space-y-3 rounded border border-zinc-700 p-4">
    <h3 className="font-semibold">{title}</h3>
    <p className="text-sm text-violet-300">
      {selected ? "Rule frozen for testing" : "No passing rule in training shortlist"}
      {" · "}{status}
    </p>
    <p className="text-xs text-zinc-400">
      Train: {dates(fold.train)} · Validation: {dates(fold.validation)} ·
      Test: {dates(fold.test)}
    </p>
    <p className="text-sm">{ruleText(selected?.rule)}</p>
    {!selected && <p className="text-sm text-amber-300">
      No shortlisted candidate passed. This does not establish that the full grid failed.
    </p>}
    <RawDetails title="Acceptance policy and shortlist" value={{
      acceptance_policy: fold.acceptance_policy, shortlist: fold.shortlist,
    }} />
    {selected && <>
      <details><summary className="cursor-pointer">Training and validation metrics</summary>
        <p className="my-2">Training</p><Metrics data={selected.training} />
        <p className="my-2">Validation</p><Metrics data={selected.validation} />
      </details>
      <Metrics data={test} /><PriceAudit fold={fold} optionType={optionType} />
      <TradeTable trades={fold.trades} />
    </>}
  </div>;
}

function WalkForward({ model, optionType }) {
  return <details className="rounded border border-zinc-700 p-3">
    <summary className="cursor-pointer">Earlier walk-forward windows</summary>
    <div className="mt-3 space-y-3">
      <Metrics data={model?.walk_forward_summary} />
      {(model?.folds || []).map((f, i) => <details key={i}>
        <summary className="cursor-pointer">Fold {i + 1}: {dates(f.test)}</summary>
        <Fold fold={f} title={`Fold ${i + 1}`} optionType={optionType} />
      </details>)}
    </div>
  </details>;
}

function FrozenQuality({ fold, label, optionType }) {
  if (!fold?.selected) return <p className="text-sm text-zinc-400">
    {label}: no original rule selected; comparison unavailable.
  </p>;
  const phases = [
    ["Training", fold.training_trades || fold.selected.training_trades,
      fold.selected.training],
    ["Validation", fold.validation_trades || fold.selected.validation_trades,
      fold.selected.validation],
    ["Final test", fold.trades, fold.test_summary],
  ];
  return <div className="space-y-3 rounded border border-zinc-700 p-3">
    <h4>{label}</h4>
    <p className="text-sm text-violet-300">{ruleText(fold.selected.rule)}</p>
    {phases.map(([phase, trades, original]) => {
      if (!Array.isArray(trades) || !original ||
          original.trades !== trades.length) {
        return <p key={phase} className="text-sm text-amber-300">
          {phase}: complete trade arrays unavailable; cannot verify comparison.
        </p>;
      }
      const checked = trades.map(trade => ({
        trade, ...qualityCheck(trade, optionType),
      }));
      const retained = checked.filter(r => r.status === "retained").map(r => r.trade);
      const excluded = checked.filter(r => r.status === "excluded");
      const unknown = checked.filter(r => r.status === "unverifiable");
      return <details key={phase} open={phase === "Final test"}>
        <summary className="cursor-pointer">
          {phase}: {trades.length} original · {retained.length} retained ·
          {" "}{excluded.length} excluded · {unknown.length} unverifiable
        </summary>
        {!!unknown.length && <p className="my-2 text-xs text-amber-300">
          Unverifiable trades are shown separately and are not counted as retained.
        </p>}
        <Comparison columns={[
          { label: "Original fixed trades", data: original },
          { label: "Retained subset", data: summarize(retained) },
          { label: "Excluded subset", data: summarize(excluded.map(r => r.trade)) },
        ]} />
        <RawDetails title="Excluded trades and reasons" value={excluded} />
        {!!unknown.length &&
          <RawDetails title="Unverifiable trades" value={unknown} />}
        <TradeTable trades={retained} />
      </details>;
    })}
  </div>;
}

function QualityPanel({ result }) {
  const q = result.quality_sensitivity;
  const models = [
    ["Original open", result],
    ["Original close", result.close_sensitivity],
    ["Filtered open", q?.open],
    ["Filtered close", q?.close],
  ];
  const columns = phase => models.map(([label, m]) => ({
    label, fold: m?.holdout,
    data: phase === "test" ? m?.holdout?.test_summary :
      m?.holdout?.selected?.[phase],
  }));
  return <div className="space-y-3 rounded border border-emerald-500/40 p-4">
    <h3 className="font-semibold">Price-quality sensitivity</h3>
    {!q ? <p className="text-sm text-amber-300">
      Import a version 1.6 export for filtered search results.
    </p> : <>
      <p className="text-sm text-zinc-400">
        Each column independently selects a rule. Differences reflect both
        exclusions and rule changes, not just entry timing.
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded border border-zinc-700 p-3">
          Additional prior-penny entry exclusions: {q.extra_entry_exclusions}
          <p className="text-xs text-zinc-400">Counted across the setup pool.</p>
        </div>
        <div className="rounded border border-zinc-700 p-3">
          Replay-quality exclusion groups: {q.replay_exclusions_count}
          <p className="text-xs text-zinc-400">{q.replay_exclusions_count_unit}</p>
        </div>
      </div>
      <Comparison columns={columns("test")} showRules />
      <details><summary className="cursor-pointer">Training and validation comparisons</summary>
        <p className="my-2">Training</p><Comparison columns={columns("training")} />
        <p className="my-2">Validation</p><Comparison columns={columns("validation")} />
      </details>
      <RawDetails title="Filter policy" value={{
        version: q.policy_version, entry: q.entry_policy,
        replay: q.replay_policy, overlap: q.overlap_policy,
      }} />
      <RawDetails title="Excluded prior-penny entries" value={q.rejected_entry_setups} />
      <RawDetails title="Replay exclusion groups" value={q.replay_exclusions} />
      {[["Filtered open search", q.open], ["Filtered close search", q.close]]
        .map(([label, m]) => <details key={label}>
          <summary className="cursor-pointer">{label}: full results</summary>
          <div className="mt-3 space-y-3">
            <Fold fold={m?.holdout} title={label} optionType={result.optionType} />
            <WalkForward model={m} optionType={result.optionType} />
          </div>
        </details>)}
    </>}
  </div>;
}

export default function SingleLegResearch({ proxyBase, connected }) {
  const [type, setType] = useState("call");
  const [settings, setSettings] = useState({
    symbol: "PLTR", dateMode: "fixed",
    startDate: "2024-10-01", endDate: "2025-09-30",
    lookbackDays: 365, frictionBps: 10,
  });
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [running, setRunning] = useState(null);
  const result = results[type];
  const close = result?.close_sensitivity;
  const same = close?.same_open_selected_rule;
  const change = (name, value) => setSettings(old => ({ ...old, [name]: value }));

  async function run() {
    const requestedType = type;
    const requested = { ...settings };
    const body = {
      symbol: requested.symbol, optionType: requestedType,
      dateMode: requested.dateMode, frictionBps: Number(requested.frictionBps),
      ...(requested.dateMode === "fixed"
        ? { startDate: requested.startDate, endDate: requested.endDate }
        : { lookbackDays: Number(requested.lookbackDays) }),
    };
    setRunning(requestedType);
    setErrors(old => ({ ...old, [requestedType]: "" }));
    setResults(old => ({ ...old, [requestedType]: null }));
    try {
      const response = await fetch(
        `${String(proxyBase || "").replace(/\/$/, "")}/scanner/single-leg-research`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body) }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (requested.dateMode === "fixed" &&
          (payload.settings?.dateMode !== "fixed" ||
           payload.settings?.startDate !== requested.startDate ||
           payload.settings?.endDate !== requested.endDate)) {
        throw new Error("Backend date mismatch. Save the backend and restart the proxy.");
      }
      setResults(old => ({ ...old, [requestedType]: payload }));
    } catch (e) {
      setErrors(old => ({ ...old, [requestedType]: e.message }));
    } finally { setRunning(null); }
  }

  async function importResult(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (!["call", "put"].includes(p.optionType) ||
          !p.settings || !p.coverage || !p.holdout ||
          !Array.isArray(p.holdout.train) ||
          !Array.isArray(p.holdout.validation) ||
          !Array.isArray(p.holdout.test)) {
        throw new Error("Unsupported single-leg research export.");
      }
      setResults(old => ({ ...old, [p.optionType]: p }));
      setErrors(old => ({ ...old, [p.optionType]: "" }));
      setType(p.optionType);
    } catch (e) { setErrors(old => ({ ...old, [type]: e.message })); }
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob(
      [JSON.stringify(result, null, 2)], { type: "application/json" }
    ));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.symbol}-${result.optionType}-research-${result.settings.startDate || "rolling"}-to-${result.settings.endDate || "latest"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const sameColumns = phase => [
    { label: "Open entry", data: phase === "test"
      ? result?.holdout?.test_summary : result?.holdout?.selected?.[phase] },
    { label: "Close entry", data: phase === "test"
      ? same?.test_summary : same?.[phase] },
  ];

  return <section className="mx-auto my-4 max-w-7xl rounded-xl border border-violet-500/30 bg-zinc-900 p-5 text-zinc-200">
    <h2 className="mb-2 text-lg font-semibold">Single-Leg Historical Research</h2>
    <p className="mb-4 text-sm text-zinc-400">
      Calls and puts separately · daily-bar replay · one contract per trade
    </p>
    <div className="mb-4 flex flex-wrap gap-2">
      {["call", "put"].map(v => <button key={v} disabled={!!running}
        onClick={() => setType(v)}
        className={`${inputClass} ${type === v ? "border-violet-400 text-violet-300" : ""}`}>
        {v === "call" ? "Call Research" : "Put Research"}
      </button>)}
      <label className={`${inputClass} cursor-pointer`}>Import results JSON
        <input className="hidden" type="file" accept=".json,application/json"
          disabled={!!running} onChange={importResult} />
      </label>
    </div>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">Ticker
        <input className={inputClass} disabled={!!running} value={settings.symbol}
          onChange={e => change("symbol", e.target.value.toUpperCase())} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Date mode
        <select className={inputClass} disabled={!!running} value={settings.dateMode}
          onChange={e => change("dateMode", e.target.value)}>
          <option value="fixed">Fixed dates</option>
          <option value="rolling">Rolling lookback</option>
        </select>
      </label>
      {(settings.dateMode === "fixed"
        ? [["startDate", "Start date", "date"], ["endDate", "End date inclusive", "date"]]
        : [["lookbackDays", "Lookback days (180–730)", "number"]]
      ).map(([name, label, kind]) => <label key={name}
        className="flex flex-col gap-1 text-sm">{label}
        <input className={inputClass} type={kind} disabled={!!running}
          value={settings[name]} onChange={e => change(name, e.target.value)} />
      </label>)}
      <label className="flex flex-col gap-1 text-sm">Round-trip friction (bps)
        <input className={inputClass} type="number" min="0" max="500"
          disabled={!!running} value={settings.frictionBps}
          onChange={e => change("frictionBps", e.target.value)} />
      </label>
      <button disabled={!!running || !connected} onClick={run}
        className={`${inputClass} disabled:opacity-40`}>
        {running ? "Research running…" : `Run ${type} research`}
      </button>
      {result && <button className={inputClass} onClick={download}>Export results JSON</button>}
    </div>
    {!connected && <p className="mb-3 text-sm text-amber-300">
      Connect Robinhood for new runs. Import existing exports offline.
    </p>}
    {running && <p className="mb-3 text-sm text-violet-300">
      Loading history and evaluating models. Keep the backend running.
    </p>}
    {errors[type] && <p role="alert" className="mb-3 text-red-300">{errors[type]}</p>}
    {result && <div className="space-y-4">
      <div className="rounded border border-zinc-700 p-3 text-sm">
        <p>{result.symbol} {result.optionType}s · {result.research_version}</p>
        <p className="mt-1 text-xs text-zinc-400">
          Saved range: {result.settings.startDate} → {result.settings.endDate} ·
          {result.settings.frictionBps} bps. Controls apply to the next run.
        </p>
      </div>
      <p className="text-sm text-amber-200">
        Viewed history remains diagnostic. Quality exclusions are retrospective
        data sensitivity checks; retained results are not proof of executable performance.
      </p>
      <RawDetails title="Coverage, settings and baseline exclusions" value={{
        settings: result.settings, coverage: result.coverage,
        entry_quality: result.entry_quality,
      }} />

      <div className="space-y-3 rounded border border-orange-500/40 p-4">
        <h3 className="font-semibold">Same original rule: quality-filter comparison</h3>
        <p className="text-sm text-zinc-400">
          The rule, entry dates, contracts, exits and original trade schedule stay
          fixed. No replacement trades are added. Retained and excluded subsets
          are calculated from exported audit bars using the version 1.6 checks.
          This isolates exclusions on the original trades; it is separate from
          the filtered searches that select different rules.
        </p>
        <p className="text-xs text-zinc-400">
          Retained-subset drawdown omits excluded trades. It is a diagnostic
          statistic, not the equity curve of a strategy that could know future
          data quality at entry. Export JSON remains unchanged.
        </p>
        <FrozenQuality fold={result.holdout} label="Original open-selected rule"
          optionType={result.optionType} />
        <FrozenQuality fold={close?.holdout} label="Original close-selected rule"
          optionType={result.optionType} />
      </div>

      <QualityPanel result={result} />

      <div className="space-y-3 rounded border border-violet-500/40 p-4">
        <h3 className="font-semibold">Same original rule: open versus close entry</h3>
        <p className="text-sm text-zinc-400">
          The original open-selected rule is replayed with close entry.
          Close exit checks start the following session; trade schedules can differ.
        </p>
        {same ? <>
          <p className="text-sm">{ruleText(same.rule)}</p>
          <Comparison columns={sameColumns("test")} />
          <details><summary className="cursor-pointer">Training and validation</summary>
            <p className="my-2">Training</p><Comparison columns={sameColumns("training")} />
            <p className="my-2">Validation</p><Comparison columns={sameColumns("validation")} />
          </details>
        </> : <p className="text-sm text-amber-300">
          No same-rule close-entry comparison available in this export.
        </p>}
      </div>

      <Fold fold={result.holdout} title="Original open search: final holdout"
        optionType={result.optionType} />
      <WalkForward model={result} optionType={result.optionType} />
      {close && <div className="space-y-3 rounded border border-sky-500/30 p-4">
        <Fold fold={close.holdout} title="Original independent close search: final holdout"
          optionType={result.optionType} />
        <WalkForward model={close} optionType={result.optionType} />
      </div>}
      <details><summary className="cursor-pointer">Research assumptions</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-400">
          {(result.assumptions || []).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </details>
    </div>}
  </section>;
}