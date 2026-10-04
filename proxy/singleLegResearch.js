// Historical research only. Does not submit orders or change practice rules.
const DAY = 86400000;
const key = value => new Date(value).toISOString().slice(0, 10);
const mean = values =>
  values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;

function validBar(bar) {
  return !!bar &&
    [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
    bar.low >= 0 &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close);
}

function priorPenny(bar) {
  return validBar(bar) &&
    [bar.open, bar.high, bar.low, bar.close].every(v => v <= 0.0100001);
}

function replayIssues(trade, type) {
  const issues = [];

  for (const row of trade.audit?.held_path || []) {
    if (row.entry_only) continue;

    if (!validBar(row.option) || !validBar(row.stock)) {
      issues.push({
        date: row.date,
        reason: "malformed_replay_bar",
      });
      continue;
    }

    const intrinsic = Math.max(
      0,
      type === "call"
        ? row.stock.low - trade.strike
        : trade.strike - row.stock.high
    );

    if (row.option.low + 0.05 < intrinsic) {
      issues.push({
        date: row.date,
        reason: "option_low_below_daily_intrinsic_proxy",
        option_low: row.option.low,
        intrinsic_proxy: intrinsic,
      });
    }
  }

  return issues;
}

function researchRange(body, now = new Date()) {
  const frictionBps = Number(body?.frictionBps ?? 10);

  if (
    !Number.isFinite(frictionBps) ||
    frictionBps < 0 ||
    frictionBps > 500
  ) {
    throw new Error("Use 0–500 friction bps.");
  }

  const fixed =
    body?.dateMode === "fixed" ||
    Boolean(body?.startDate || body?.endDate);

  let start;
  let end;

  if (fixed) {
    const parse = value => {
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
      ) {
        throw new Error("Use YYYY-MM-DD for both dates.");
      }

      const date = new Date(value + "T00:00:00.000Z");

      if (!Number.isFinite(date.getTime()) || key(date) !== value) {
        throw new Error("Invalid calendar date.");
      }

      return date;
    };

    start = parse(body.startDate);
    const last = parse(body.endDate);

    if (last >= new Date(key(now) + "T00:00:00.000Z")) {
      throw new Error(
        "End date must be before today (UTC); only completed days are used."
      );
    }

    end = new Date(last.getTime() + DAY);
  } else {
    const days = Number(body?.lookbackDays ?? 365);

    if (!Number.isInteger(days)) {
      throw new Error("Lookback must be a whole number of days.");
    }

    end = new Date(key(now) + "T00:00:00.000Z");
    start = new Date(end.getTime() - days * DAY);
  }

  const lookbackDays = Math.round((end - start) / DAY);

  if (lookbackDays < 180 || lookbackDays > 730) {
    throw new Error("Choose an inclusive range of 180–730 days.");
  }

  return {
    start,
    end,
    fetchStart: new Date(start.getTime() - 150 * DAY),
    frictionBps,
    lookbackDays,
    settings: {
      dateMode: fixed ? "fixed" : "rolling",
      startDate: key(start),
      endDate: key(new Date(end - DAY)),
      lookbackDays,
      frictionBps,
    },
  };
}

function indicators(bars) {
  let fast;
  let slow;
  let signal;
  let gain = 0;
  let loss = 0;

  return bars.map((bar, i) => {
    fast = fast === undefined
      ? bar.close
      : fast + 2 / 13 * (bar.close - fast);

    slow = slow === undefined
      ? bar.close
      : slow + 2 / 27 * (bar.close - slow);

    const macd = fast - slow;

    signal = signal === undefined
      ? macd
      : signal + 0.2 * (macd - signal);

    const change = i ? bar.close - bars[i - 1].close : 0;

    if (i > 0 && i <= 14) {
      gain += Math.max(change, 0) / 14;
      loss += Math.max(-change, 0) / 14;
    } else if (i > 14) {
      gain = (gain * 13 + Math.max(change, 0)) / 14;
      loss = (loss * 13 + Math.max(-change, 0)) / 14;
    }

    return {
      ...bar,
      date: key(bar.time),
      rsi: i < 14
        ? null
        : loss
          ? 100 - 100 / (1 + gain / loss)
          : gain ? 100 : 50,
      histogram: macd - signal,
      changePct: i && bars[i - 1].close > 0
        ? change / bars[i - 1].close * 100
        : 0,
    };
  });
}

function qualifies(bar, rule, type) {
  if (bar.rsi === null) return false;

  const sign = type === "call" ? 1 : -1;

  const score =
    Number(type === "call" ? bar.rsi >= rule.rsi : bar.rsi <= rule.rsi) +
    Number(bar.histogram * sign > 0) +
    Number(bar.changePct * sign > 0);

  return score >= rule.score;
}

function entryQuality({ setup, stock, optionBars, type }) {
  const entryDate = stock[setup.index].date;
  const signalDate = stock[setup.index - 1].date;
  const entry = optionBars?.get(entryDate);
  const prior = optionBars?.get(signalDate);
  const reasons = [];

  if (!entry || !Number.isFinite(entry.open) || entry.open <= 0) {
    reasons.push("missing_or_invalid_entry_open");
  } else if (entry.open <= 0.0100001) {
    reasons.push("entry_at_or_below_one_cent");
  }

  if (!validBar(prior) || prior.close <= 0) {
    reasons.push("missing_or_invalid_previous_session_bar");
  }

  const spot = stock[setup.index].open;
  const intrinsic =
    Number.isFinite(spot) && Number.isFinite(setup.strike)
      ? Math.max(
          0,
          type === "call"
            ? spot - setup.strike
            : setup.strike - spot
        )
      : null;

  if (intrinsic === null || spot <= 0) {
    reasons.push("invalid_stock_entry_open");
  } else if (
    entry &&
    Number.isFinite(entry.open) &&
    entry.open + 0.05 < intrinsic
  ) {
    reasons.push("option_open_below_stock_open_intrinsic_proxy");
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    entry_date: entryDate,
    signal_date: signalDate,
    contract: setup.id,
    strike: setup.strike,
    expiration: setup.expiration,
    stock_open: spot,
    intrinsic_proxy: intrinsic,
    option_entry_bar: entry ?? null,
    previous_session_option_bar: prior ?? null,
  };
}

function replay({
  setup,
  rule,
  stock,
  optionBars,
  frictionBps,
  type,
  includeAudit = false,
  entryModel = "open",
}) {
  const entry = optionBars.get(stock[setup.index].date);

  if (!entry || !Number.isFinite(entry.open) || entry.open <= 0) {
    return null;
  }

  if (entryModel === "close" && !validBar(entry)) return null;

  const rawEntry = entryModel === "close" ? entry.close : entry.open;

  if (
    !Number.isFinite(rawEntry) ||
    rawEntry <= 0 ||
    (entryModel === "close" && rawEntry <= 0.0100001)
  ) {
    return null;
  }

  const entryPrice = rawEntry * (1 + frictionBps / 20000);
  const path = [];

  let mfe = 0;
  let mae = 0;
  let ambiguous = false;

  if (includeAudit && entryModel === "close") {
    path.push({
      date: stock[setup.index].date,
      option: { ...entry },
      stock: { ...stock[setup.index] },
      entry_only: true,
    });
  }

  const firstOffset = entryModel === "close" ? 1 : 0;

  for (let h = firstOffset; h < rule.hold + firstOffset; h++) {
    const i = setup.index + h;
    if (i >= stock.length) return null;

    const bar = optionBars.get(stock[i].date);
    if (!validBar(bar)) return null;

    if (includeAudit) {
      path.push({
        date: stock[i].date,
        option: { ...bar },
        stock: { ...stock[i] },
      });
    }

    const dte = Math.round(
      (Date.parse(setup.expiration) - Date.parse(stock[i].date)) / DAY
    );

    if (dte < 0) return null;

    const target = rule.target === null
      ? Infinity
      : entryPrice * (1 + rule.target / 100);

    const stop = rule.stop === null
      ? -Infinity
      : entryPrice * (1 - rule.stop / 100);

    let price;
    let reason;

    if (bar.open <= stop) {
      price = bar.open;
      reason = "stop gap";
    } else if (bar.open >= target) {
      price = bar.open;
      reason = "target gap";
    } else if (dte <= 3) {
      price = bar.open;
      reason = "3 DTE exit";
    } else if (
      h > 0 &&
      rule.mode === "macd" &&
      stock[i - 1].histogram * (type === "call" ? 1 : -1) <= 0
    ) {
      price = bar.open;
      reason = "MACD reversal";
    } else if (
      h > 0 &&
      rule.mode === "rsi" &&
      (type === "call"
        ? stock[i - 1].rsi < 50
        : stock[i - 1].rsi > 50)
    ) {
      price = bar.open;
      reason = "RSI reversal";
    } else if (
      h - firstOffset >= 3 &&
      rule.mode === "time" &&
      optionBars.get(stock[i - 1].date)?.close <= entryPrice
    ) {
      price = bar.open;
      reason = "3 session time stop";
    } else if (
      h > 0 &&
      rule.mode === "invalidation" &&
      (type === "call"
        ? stock[i].open < stock[setup.index - 1].low
        : stock[i].open > stock[setup.index - 1].high)
    ) {
      price = bar.open;
      reason = "stock invalidation at open";
    } else if (bar.low <= stop) {
      price = stop;
      reason = "stop";
      ambiguous = bar.high >= target;
    } else if (bar.high >= target) {
      price = target;
      reason = "target";
    } else if (h === rule.hold + firstOffset - 1) {
      price = bar.close;
      reason = "max hold";
    }

    // Exit-day ordering is unknown: excursions use only open and fill.
    const high = price === undefined
      ? bar.high
      : Math.max(bar.open, price);

    const low = price === undefined
      ? bar.low
      : Math.min(bar.open, price);

    mfe = Math.max(mfe, (high / entryPrice - 1) * 100);
    mae = Math.min(mae, (low / entryPrice - 1) * 100);

    if (price !== undefined) {
      const exitPrice = Math.max(0, price * (1 - frictionBps / 20000));
      const returnPct = (exitPrice / entryPrice - 1) * 100;
      const flags = [];

      if (rawEntry < 0.10) flags.push("entry_below_10_cents");
      if (returnPct > 1000) flags.push("return_above_1000_pct");
      if (price / rawEntry >= 5) flags.push("exit_at_least_5x_entry");

      if (
        includeAudit &&
        path.some(row =>
          row.option.raw?.volume != null &&
          Number(row.option.raw.volume) === 0
        )
      ) {
        flags.push("zero_volume_in_held_path");
      }

      return {
        signal_date: stock[setup.index - 1].date,
        entry_date: stock[setup.index].date,
        exit_date: stock[i].date,
        contract: setup.id,
        expiration: setup.expiration,
        strike: setup.strike,
        actual_dte: setup.dte,
        entry_price: entryPrice,
        exit_price: exitPrice,
        premium_paid: entryPrice * 100,
        pnl: (exitPrice - entryPrice) * 100,
        return_pct: returnPct,
        entry_model: entryModel,
        hold_sessions: h + 1 - firstOffset,
        mfe_pct: mfe,
        mae_pct: mae,
        exit_reason: reason,
        ambiguous_bar: ambiguous,
        ...(includeAudit ? {
          price_quality_flags: flags,
          audit: {
            option_type: type,
            signal_snapshot: { ...stock[setup.index - 1] },
            raw_entry_open: entry.open,
            raw_entry_price: rawEntry,
            entry_model: entryModel,
            raw_exit_fill: price,
            entry_friction_per_share: entryPrice - rawEntry,
            exit_friction_per_share: price - exitPrice,
            return_formula: "(exit_price / entry_price - 1) * 100",
            prior_option_bar:
              optionBars.get(stock[setup.index - 1].date) ?? null,
            held_path: path,
          },
        } : {}),
      };
    }
  }

  return null;
}

function summary(trades) {
  const returns = trades.map(t => t.return_pct).sort((a, b) => a - b);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);

  const profit = wins.reduce((a, t) => a + t.pnl, 0);
  const loss = -losses.reduce((a, t) => a + t.pnl, 0);
  const premium = trades.reduce((a, t) => a + t.premium_paid, 0);

  let equity = 10000;
  let peak = equity;
  let drawdown = 0;

  for (const trade of trades) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }

  return {
    trades: trades.length,
    win_rate_pct: trades.length ? wins.length / trades.length * 100 : null,
    average_return_pct: mean(returns),
    median_return_pct: returns.length
      ? (
          returns[Math.floor((returns.length - 1) / 2)] +
          returns[Math.floor(returns.length / 2)]
        ) / 2
      : null,
    expectancy_dollars: mean(trades.map(t => t.pnl)),
    profit_factor: loss ? profit / loss : null,
    no_losses: trades.length > 0 && losses.length === 0,
    pnl: profit - loss,
    premium_paid: premium,
    return_on_premium_pct: premium ? (profit - loss) / premium * 100 : null,
    realized_drawdown_dollars: drawdown,
    average_winner_pct: mean(wins.map(t => t.return_pct)),
    average_loser_pct: mean(losses.map(t => t.return_pct)),
    average_mfe_pct: mean(trades.map(t => t.mfe_pct)),
    average_mae_pct: mean(trades.map(t => t.mae_pct)),
    average_hold_sessions: mean(trades.map(t => t.hold_sessions)),
    loss_50_pct: trades.length
      ? trades.filter(t => t.return_pct <= -50).length / trades.length * 100
      : null,
    gain_50_pct: trades.length
      ? trades.filter(t => t.return_pct >= 50).length / trades.length * 100
      : null,
    ambiguous_bars: trades.filter(t => t.ambiguous_bar).length,
  };
}

function grid(type) {
  const rules = [];
  const exits = [{ target: null, stop: null, mode: "fixed" }];

  for (const target of [20, 30, 50, 75, 100]) {
    for (const stop of [20, 30, 40, 50]) {
      exits.push({ target, stop, mode: "bracket" });
    }
  }

  for (const mode of ["macd", "rsi", "time", "invalidation"]) {
    exits.push({ target: null, stop: null, mode });
  }

  for (const dte of [7, 9, 14, 21, 30])
    for (const money of [-2, 0, 2])
      for (const score of [2, 3])
        for (const rsi of type === "call" ? [50, 55, 60] : [50, 45, 40])
          for (const hold of [1, 3, 5, 7, 10])
            for (const exit of exits)
              rules.push({ dte, money, score, rsi, hold, ...exit });

  return rules;
}

function rank(stats) {
  return stats.trades >= 5
    ? stats.expectancy_dollars -
      stats.realized_drawdown_dollars / stats.trades
    : -Infinity;
}

function selectFold({ rules, evaluate, train, validation, test }) {
  const acceptancePolicy = {
    version: "validation-gate-v1",
    min_trades: 5,
    min_profit_factor_exclusive: 1,
    positive_expectancy_required: true,
    positive_return_on_premium_required: true,
  };

  const passes = stats =>
    stats.trades >= 5 &&
    Number.isFinite(stats.expectancy_dollars) &&
    stats.expectancy_dollars > 0 &&
    Number.isFinite(stats.return_on_premium_pct) &&
    stats.return_on_premium_pct > 0 &&
    (
      stats.no_losses ||
      (
        Number.isFinite(stats.profit_factor) &&
        stats.profit_factor > 1
      )
    );

  const assessed = rules
    .map(rule => ({
      rule,
      training: summary(evaluate(rule, train)),
    }))
    .filter(row => row.training.trades >= 5)
    .sort((a, b) => rank(b.training) - rank(a.training))
    .slice(0, 20)
    .map(row => ({
      ...row,
      validation: summary(evaluate(row.rule, validation)),
    }));

  const candidates = assessed
    .filter(row => passes(row.training) && passes(row.validation))
    .sort((a, b) => rank(b.validation) - rank(a.validation));

  if (!candidates.length) {
    return {
      train,
      validation,
      test,
      selected: null,
      test_summary: null,
      trades: [],
      acceptance_policy: acceptancePolicy,
      shortlist: assessed.slice(0, 5),
      message:
        "No qualifying rule: none of the training shortlist passed both training and validation gates. Test was not evaluated.",
    };
  }

  // Test is evaluated only after selection is frozen.
  const selected = candidates[0];
  const trainingTrades = evaluate(selected.rule, train, true);
  const validationTrades = evaluate(selected.rule, validation, true);
  const trades = evaluate(selected.rule, test, true);
  const diagnostics = {};

  for (const [name, rows] of Object.entries({
    training: trainingTrades,
    validation: validationTrades,
    test: trades,
  })) {
    const flagged = rows.filter(t => t.price_quality_flags?.length);

    diagnostics[name] = {
      flagged_trades: flagged.length,
      total_trades: rows.length,
      flags: flagged.map(t => ({
        entry_date: t.entry_date,
        contract: t.contract,
        return_pct: t.return_pct,
        flags: t.price_quality_flags,
      })),
      largest_returns: rows
        .slice()
        .sort((a, b) => b.return_pct - a.return_pct)
        .slice(0, 5)
        .map(t => ({
          entry_date: t.entry_date,
          contract: t.contract,
          return_pct: t.return_pct,
          entry_price: t.entry_price,
          exit_price: t.exit_price,
        })),
      summary_without_flagged_for_audit_only:
        summary(rows.filter(t => !t.price_quality_flags?.length)),
    };
  }

  return {
    train,
    validation,
    test,
    acceptance_policy: acceptancePolicy,
    selected,
    test_summary: summary(trades),
    trades,
    training_trades: trainingTrades,
    validation_trades: validationTrades,
    price_diagnostics: diagnostics,
    shortlist: candidates.slice(0, 5),
  };
}

function registerSingleLegResearch(app, deps) {
  let running = false;

  app.post("/scanner/single-leg-research", async (req, res) => {
    if (running) {
      return res.status(409).json({
        error: "A single-leg research run is already in progress.",
      });
    }

    running = true;

    try {
      const symbol = deps.normalizeTicker(req.body?.symbol || "PLTR");

      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
        throw new Error("Invalid ticker.");
      }

      const type = req.body?.optionType;

      if (!["call", "put"].includes(type)) {
        throw new Error("Choose call or put.");
      }

      const now = new Date();
      const { start, end, fetchStart, frictionBps, settings } =
        researchRange(req.body, now);

      const raw = deps.unwrap(await deps.call("get_equity_historicals", {
        symbols: [symbol],
        start_time: fetchStart.toISOString(),
        end_time: end.toISOString(),
        interval: "day",
        bounds: "regular",
        adjustment_type: "none",
      }));

      const stock = indicators(deps.extractStock(raw))
        .filter(bar => bar.date < key(end));

      const dates = stock
        .filter(bar => Date.parse(bar.date) >= start.getTime())
        .map(bar => bar.date);

      if (dates.length < 100) {
        throw new Error(
          "Fewer than 100 completed stock sessions are available."
        );
      }

      const dateSet = new Set(dates);
      const rules = grid(type);
      const instruments = new Map();
      const setups = new Map();
      const histories = new Map();

      const skips = {
        no_contract: 0,
        unreplayable_rule_evaluations: 0,
        incomplete_expiration: 0,
      };

      let eligibleSessions = 0;

      for (let i = 1; i < stock.length; i++) {
        if (
          !dateSet.has(stock[i - 1].date) ||
          !qualifies(stock[i - 1], { score: 2, rsi: 50 }, type)
        ) {
          continue;
        }

        eligibleSessions++;

        for (const targetDte of [7, 9, 14, 21, 30]) {
          const desired = deps.nextFriday(
            new Date(Date.parse(stock[i].date) + targetDte * DAY)
          );
          const expiration = key(desired);

          if (expiration >= key(now)) {
            skips.incomplete_expiration++;
            continue;
          }

          if (!instruments.has(expiration)) {
            instruments.set(
              expiration,
              await deps.loadInstruments({ symbol, expiration, type })
            );
          }

          const usable = instruments.get(expiration).filter(contract =>
            contract.type === type &&
            Number(contract.strike_price) > 0 &&
            contract.id &&
            (
              !contract.created_at ||
              Date.parse(contract.created_at) <= Date.parse(stock[i].time)
            ) &&
            (
              !contract.trade_value_multiplier ||
              Number(contract.trade_value_multiplier) === 100
            )
          );

          for (const money of [-2, 0, 2]) {
            const target = stock[i - 1].close *
              (1 + money / 100 * (type === "call" ? 1 : -1));

            const contract = usable.slice().sort((a, b) =>
              Math.abs(Number(a.strike_price) - target) -
              Math.abs(Number(b.strike_price) - target) ||
              Number(a.strike_price) - Number(b.strike_price)
            )[0];

            if (!contract) {
              skips.no_contract++;
              continue;
            }

            const setup = {
              index: i,
              id: contract.id,
              strike: Number(contract.strike_price),
              expiration,
              dte: Math.round(
                (Date.parse(expiration) - Date.parse(stock[i].date)) / DAY
              ),
            };

            setups.set([i, targetDte, money].join("|"), setup);
            histories.set(contract.id, null);
          }
        }
      }

      const ids = [...histories.keys()];

      for (let i = 0; i < ids.length; i += 10) {
        const result = deps.unwrap(await deps.call("get_option_historicals", {
          instrument_ids: ids.slice(i, i + 10),
          start_time: fetchStart.toISOString(),
          end_time: end.toISOString(),
          interval: "day",
          bounds: "regular",
        }));

        for (const item of deps.extractOptions(result)) {
          const rawByDate = new Map(
            (item.bars || [])
              .filter(bar => bar.begins_at)
              .map(bar => [key(bar.begins_at), bar])
          );

          histories.set(
            item.instrument_id,
            new Map(
              deps.normalizeOptions(item).map(bar => [
                bar.date,
                {
                  ...bar,
                  raw: rawByDate.get(bar.date) ?? null,
                },
              ])
            )
          );
        }
      }

      const qualityByEntry = new Map();
      const qualityReasons = {};
      const rejected = [];

      for (const setup of setups.values()) {
        const entryKey = stock[setup.index].date + "|" + setup.id;

        if (qualityByEntry.has(entryKey)) continue;

        const quality = entryQuality({
          setup,
          stock,
          optionBars: histories.get(setup.id),
          type,
        });

        qualityByEntry.set(entryKey, quality);

        if (!quality.accepted) {
          rejected.push(quality);

          for (const reason of quality.reasons) {
            qualityReasons[reason] = (qualityReasons[reason] || 0) + 1;
          }
        }
      }

      const setupGroups = new Map();

      for (const [setupKey, setup] of setups) {
        const groupKey = setupKey.split("|").slice(1).join("|");

        if (!setupGroups.has(groupKey)) setupGroups.set(groupKey, []);
        setupGroups.get(groupKey).push(setup);
      }

      const filteredExclusions = new Map();

      const makeEvaluate = (entryModel, filtered = false) =>
        (rule, window, includeAudit = false) => {
          const rows = [];
          let lastExit = "";

          for (
            const setup of
            setupGroups.get([rule.dte, rule.money].join("|")) || []
          ) {
            const signalDate = stock[setup.index - 1].date;
            const entryDate = stock[setup.index].date;

            if (
              signalDate < window[0] ||
              signalDate > window[1] ||
              entryDate <= lastExit ||
              !qualifies(stock[setup.index - 1], rule, type)
            ) {
              continue;
            }

            const quality = qualityByEntry.get(entryDate + "|" + setup.id);
            if (!quality?.accepted) continue;

            // Known prior-session information: this is an entry exclusion.
            if (
              filtered &&
              priorPenny(quality.previous_session_option_bar)
            ) {
              continue;
            }

            const bars = histories.get(setup.id);

            const trade = bars && replay({
              setup,
              rule,
              stock,
              optionBars: bars,
              frictionBps,
              type,
              includeAudit: includeAudit || filtered,
              entryModel,
            });

            if (!trade) {
              skips.unreplayable_rule_evaluations++;
              continue;
            }

            if (trade.exit_date > window[1]) continue;

            // Preserve occupancy even if the completed replay is unreliable.
            lastExit = trade.exit_date;

            if (filtered) {
              const issues = replayIssues(trade, type);

              if (issues.length) {
                const exclusionKey = [
                  entryModel,
                  trade.entry_date,
                  trade.contract,
                ].join("|");

                if (!filteredExclusions.has(exclusionKey)) {
                  filteredExclusions.set(exclusionKey, {
                    entry_model: entryModel,
                    entry_date: trade.entry_date,
                    contract: trade.contract,
                    evaluations: new Set(),
                    examples: [],
                  });
                }

                const record = filteredExclusions.get(exclusionKey);
                const evaluationKey = [
                  JSON.stringify(rule),
                  ...window,
                ].join("|");

                if (!record.evaluations.has(evaluationKey)) {
                  record.evaluations.add(evaluationKey);

                  if (record.examples.length < 3) {
                    record.examples.push({
                      rule,
                      window,
                      exit_date: trade.exit_date,
                      issues,
                    });
                  }
                }

                continue;
              }
            }

            rows.push(trade);
          }

          return rows;
        };

      const evaluate = makeEvaluate("open");
      const closeEvaluate = makeEvaluate("close");

      const n = dates.length;
      const trainEnd = Math.floor(n * 0.6);
      const valEnd = Math.floor(n * 0.8);

      const holdout = selectFold({
        rules,
        evaluate,
        train: [dates[0], dates[trainEnd - 1]],
        validation: [dates[trainEnd], dates[valEnd - 1]],
        test: [dates[valEnd], dates[n - 1]],
      });

      const folds = [];

      for (
        let testStart = 120;
        testStart + 30 <= valEnd;
        testStart += 30
      ) {
        folds.push(selectFold({
          rules,
          evaluate,
          train: [dates[0], dates[testStart - 32]],
          validation: [dates[testStart - 30], dates[testStart - 1]],
          test: [dates[testStart], dates[testStart + 29]],
        }));
      }

      const closeHoldout = selectFold({
        rules,
        evaluate: closeEvaluate,
        train: holdout.train,
        validation: holdout.validation,
        test: holdout.test,
      });

      const closeFolds = folds.map(fold => selectFold({
        rules,
        evaluate: closeEvaluate,
        train: fold.train,
        validation: fold.validation,
        test: fold.test,
      }));

      const closeSensitivity = {
        entry_model: "close",
        holdout: closeHoldout,
        folds: closeFolds,
        walk_forward_summary:
          summary(closeFolds.flatMap(fold => fold.trades || [])),
        same_open_selected_rule: holdout.selected ? {
          rule: holdout.selected.rule,
          training: summary(
            closeEvaluate(holdout.selected.rule, holdout.train)
          ),
          validation: summary(
            closeEvaluate(holdout.selected.rule, holdout.validation)
          ),
          test_summary: summary(
            closeEvaluate(holdout.selected.rule, holdout.test)
          ),
        } : null,
      };

      const buildFiltered = evaluator => {
        const final = selectFold({
          rules,
          evaluate: evaluator,
          train: holdout.train,
          validation: holdout.validation,
          test: holdout.test,
        });

        const earlier = folds.map(fold => selectFold({
          rules,
          evaluate: evaluator,
          train: fold.train,
          validation: fold.validation,
          test: fold.test,
        }));

        return {
          holdout: final,
          folds: earlier,
          walk_forward_summary:
            summary(earlier.flatMap(fold => fold.trades || [])),
        };
      };

      const filteredOpenResults = buildFiltered(makeEvaluate("open", true));
      const filteredCloseResults = buildFiltered(makeEvaluate("close", true));

      const extraEntryExclusions = [...qualityByEntry.values()].filter(
        quality =>
          quality.accepted &&
          priorPenny(quality.previous_session_option_bar)
      );

      const qualitySensitivity = {
        policy_version: "quality-sensitivity-v1",
        diagnostic_only: true,
        entry_policy:
          "Additionally reject an otherwise accepted entry when previous-session option OHLC is entirely at or below $0.01.",
        replay_policy:
          "Exclude completed replays with malformed held stock bars or option lows more than $0.05 below the stock daily intrinsic proxy. Missing/malformed option paths remain unreplayable in both models. Approximate timestamps can exclude legitimate prices. Exit-day full OHLC is audited after replay, not used as pre-entry information.",
        overlap_policy:
          "A quality-excluded completed replay still reserves its original holding interval; no replacement entry is created during that interval.",
        extra_entry_exclusions: extraEntryExclusions.length,
        rejected_entry_setups: extraEntryExclusions,
        replay_exclusions_count: filteredExclusions.size,
        replay_exclusions_count_unit:
          "Distinct entry-model/date/contract groups; each group reports affected rule/window evaluations. These are not counts of selected-rule trades.",
        replay_exclusions: [...filteredExclusions.values()].map(
          ({ evaluations, ...record }) => ({
            ...record,
            affected_rule_window_evaluations: evaluations.size,
          })
        ),
        open: filteredOpenResults,
        close: filteredCloseResults,
      };

      res.json({
        research_version: "1.6-quality-sensitivity",
        entry_model: "open",
        quality_sensitivity: qualitySensitivity,
        close_sensitivity: closeSensitivity,
        symbol,
        optionType: type,
        generated_at: new Date().toISOString(),
        settings,
        coverage: {
          requested_start: settings.startDate,
          requested_end: settings.endDate,
          returned_stock_start: dates[0],
          returned_stock_end: dates[n - 1],
          stock_sessions: n,
          eligible_signal_sessions: eligibleSessions,
          contracts_requested: ids.length,
          contracts_with_bars:
            [...histories.values()].filter(value => value?.size).length,
          rules_tested: rules.length,
          skips,
        },
        entry_quality: {
          policy_version: "fixed-entry-v1",
          unique_date_contract_entries: qualityByEntry.size,
          accepted_entries: qualityByEntry.size - rejected.length,
          rejected_entries: rejected.length,
          rejection_counts_by_reason: qualityReasons,
          rejected_setups: rejected,
          policy: [
            "Reject missing/nonpositive entry opens and opens at or below $0.01/share.",
            "Require a valid option bar on the previous stock session.",
            "Reject option opens more than $0.05 below intrinsic computed from stock open.",
            "Stock and option opens are not synchronized quotes; intrinsic is an approximate proxy.",
            "Each date/contract is counted once; rejection reasons can overlap.",
            "No future returns or exit prices determine baseline entry acceptance.",
            "This policy was introduced after inspecting the sample; reused holdouts remain diagnostic.",
          ],
        },
        holdout,
        folds,
        walk_forward_summary:
          summary(folds.flatMap(fold => fold.trades || [])),
        assumptions: [
          "Version 1.6 preserves baseline open/close searches and independently fits additional quality-filtered searches.",
          "The quality policy is fixed in code. It is not selected using whichever filtered test result is best.",
          "Filtered entry checks additionally exclude prior-session bars entirely at or below one cent. Legitimate penny-priced contracts can be excluded.",
          "Later daily intrinsic discrepancies are replay-quality exclusions, not information known at entry. Original holding intervals remain occupied for excluded completed replays.",
          "Quality checks inspect full exit-day OHLC for data auditing even when the simulated exit occurs at open. This is a retrospective sensitivity analysis, not a deployable intraday data filter.",
          "Returns above 1000%, fivefold exit prices, and large entry-day open/close changes are audit alerts rather than automatic quality exclusions.",
          "Missing or malformed option paths are unreplayable in both baseline and filtered searches; missing prices are never interpolated.",
          "Unreplayable-rule evaluation counts include repeated evaluations across all searches and windows, not unique trades.",
          "Close entry uses the shared open-qualified setup pool and additionally requires a valid close above one cent.",
          "Open holds include entry day; close holds count subsequent sessions. Close-entry exit checks and excursions begin the next session.",
          "Same-open-selected-rule close sensitivity freezes the open rule; it does not independently select a close rule.",
          "Fixed ranges include both chosen dates. Partial provider coverage is reported. A chosen date range does not prove the history is unseen.",
          "Training and validation each require at least five trades, positive dollar expectancy, positive return on premium, and profit factor above one or no losses.",
          "Training shortlist contains the top 20 candidates by expectancy dollars minus realized drawdown divided by trade count. Validation chooses within that shortlist.",
          "When no shortlisted candidate passes, test is not evaluated. This does not establish that the full grid has no passing configuration.",
          "Daily option trade-price OHLC is not synchronized bid/ask execution data.",
          "Contract strikes are chosen from prior stock close. Positive moneyness means OTM for both calls and puts.",
          "Target DTE rounds up to Friday. Actual DTE is recorded. Only already-expired standard 100-share contracts are requested.",
          "Round-trip premium friction is split equally between entry and exit. Commissions are excluded.",
          "Stop wins when stop and target both touch. Gap exits use observed open. Trades do not overlap within a rule/window replay.",
          "DTE exit occurs at open when three calendar days remain.",
          "MFE/MAE use full bars before exit and only open/fill on exit day; estimates do not reconstruct intraday ordering.",
          "Drawdown is realized dollar drawdown for one contract starting at $10,000; it excludes intratrade losses and capital constraints.",
          "RSI is a signal vote, not a mandatory filter. MACD uses histogram sign. Histogram-strength and RSI-band searches are not included.",
          "Coverage depends on retrievable expired contracts and histories. Existing instrument pagination cap remains eight pages.",
          "Stock prices are unadjusted to match historical strikes; split events are not normalized or excluded.",
          "Repeatedly viewed history remains diagnostic. No automatic application to practice or live trading occurs.",
        ],
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    } finally {
      running = false;
    }
  });
}

module.exports = {
  registerSingleLegResearch,
  indicators,
  qualifies,
  replay,
  summary,
  grid,
  selectFold,
  entryQuality,
  researchRange,
  validBar,
  priorPenny,
  replayIssues,
};