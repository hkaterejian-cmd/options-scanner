import { useEffect, useMemo, useState } from "react";
import ExpirationComparison from "./ExpirationComparison";

const PROXY_BASE = "http://127.0.0.1:3001";

/* =========================================================
   HELPERS
========================================================= */

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function money(value) {
  const n = toNumber(value);
  return n === null ? "—" : `$${n.toFixed(2)}`;
}

function dollar(value) {
  const n = toNumber(value);
  if (n === null) return "—";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function signedDollar(value, digits = 2) {
  const n = toNumber(value);
  if (n === null) return "—";

  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(digits)}`;
}

function pct(value) {
  const n = toNumber(value);
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function compact(value) {
  const n = toNumber(value);

  if (n === null) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;

  return String(Math.round(n));
}

function signed(value, digits = 3) {
  const n = toNumber(value);
  if (n === null) return "—";

  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function ratioText(value) {
  const n = toNumber(value);
  return n === null ? "—" : n.toFixed(2);
}

function dateLabel(value) {
  if (!value) return "—";

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function chartDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function distancePct(level, spot) {
  const l = toNumber(level);
  const s = toNumber(spot);

  if (l === null || s === null || s === 0) return null;

  return ((l - s) / s) * 100;
}

function distanceText(level, spot) {
  const value = distancePct(level, spot);

  if (value === null) return "—";

  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}% from spot`;
}

function flowDescriptor(ratio) {
  if (ratio === null || ratio === undefined) {
    return {
      label: "Unavailable",
      className: "text-zinc-400",
    };
  }

  if (ratio >= 1.25) {
    return {
      label: "Put-heavy",
      className: "text-red-300",
    };
  }

  if (ratio <= 0.8) {
    return {
      label: "Call-heavy",
      className: "text-emerald-300",
    };
  }

  return {
    label: "Balanced",
    className: "text-zinc-300",
  };
}

/*
  Automatically spaces chart labels vertically.

  The horizontal line stays at its true price.
  Only the text label moves, with a connector showing
  which level it belongs to.
*/
function layoutChartLabels(labels, minY, maxY, gap = 17) {
  if (!labels.length) return [];

  const result = [...labels]
    .sort((a, b) => a.actualY - b.actualY)
    .map((item) => ({
      ...item,
      labelY: item.actualY,
    }));

  let cursor = minY;

  for (let i = 0; i < result.length; i++) {
    result[i].labelY = Math.max(result[i].actualY, cursor);
    cursor = result[i].labelY + gap;
  }

  if (result[result.length - 1].labelY > maxY) {
    result[result.length - 1].labelY = maxY;

    for (let i = result.length - 2; i >= 0; i--) {
      result[i].labelY = Math.min(
        result[i].labelY,
        result[i + 1].labelY - gap
      );
    }
  }

  if (result[0].labelY < minY) {
    const shift = minY - result[0].labelY;

    for (const item of result) {
      item.labelY += shift;
    }
  }

  return result;
}

/* =========================================================
   NETWORK
========================================================= */

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data;
}

function unwrapMcp(envelope) {
  const result = envelope?.result ?? envelope;

  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const content = Array.isArray(result?.content) ? result.content : [];

  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;

    try {
      return JSON.parse(block.text);
    } catch {
      // Continue.
    }
  }

  return result;
}

async function callRobinhood(toolName, args) {
  const envelope = await fetchJson(`${PROXY_BASE}/robinhood/call`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      toolName,
      arguments: args,
    }),
  });

  return unwrapMcp(envelope);
}

/* =========================================================
   OPTION DATA
========================================================= */

function getExpirations(payload) {
  const data = payload?.data ?? payload ?? {};
  const chains = data.chains ?? [];

  const dates = new Set();

  for (const chain of chains) {
    for (const expiration of chain.expiration_dates || []) {
      dates.add(expiration);
    }
  }

  return [...dates].sort();
}

function nearestExpiration(dates) {
  if (!dates.length) return null;

  const now = new Date();

  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  return dates.find((date) => date >= today) ?? dates[0];
}

async function fetchAllInstruments(ticker, expiration) {
  let cursor;
  let pages = 0;

  const instruments = [];

  do {
    const payload = await callRobinhood("get_option_instruments", {
      chain_symbol: ticker,
      expiration_dates: expiration,
      state: "active",

      ...(cursor ? { cursor } : {}),
    });

    const data = payload?.data ?? payload ?? {};

    instruments.push(...(data.instruments || []));

    cursor = data.next || null;
    pages += 1;
  } while (cursor && pages < 25);

  return instruments;
}

function chunks(list, size) {
  const result = [];

  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }

  return result;
}

function quoteResultsFromPayload(payload) {
  const data = payload?.data ?? payload ?? {};
  return data.results || [];
}

async function fetchOptionQuotes(instrumentIds) {
  if (!instrumentIds.length) return [];

  const batches = chunks(instrumentIds, 20);

  const responses = await Promise.all(
    batches.map((ids) =>
      callRobinhood("get_option_quotes", {
        instrument_ids: ids,
      })
    )
  );

  return responses.flatMap((payload) =>
    quoteResultsFromPayload(payload)
  );
}

async function fetchOptionQuotesProgressive(
  instrumentIds,
  { onProgress } = {}
) {
  if (!instrumentIds.length) return [];

  const batches = chunks(instrumentIds, 20);
  const concurrency = 4;
  const results = [];

  let completedContracts = 0;

  for (let i = 0; i < batches.length; i += concurrency) {
    const group = batches.slice(i, i + concurrency);

    const responses = await Promise.all(
      group.map((ids) =>
        callRobinhood("get_option_quotes", {
          instrument_ids: ids,
        })
      )
    );

    for (const payload of responses) {
      results.push(...quoteResultsFromPayload(payload));
    }

    completedContracts += group.reduce(
      (total, ids) => total + ids.length,
      0
    );

    if (onProgress) {
      onProgress({
        completed: Math.min(completedContracts, instrumentIds.length),
        total: instrumentIds.length,
      });
    }
  }

  return results;
}

/* =========================================================
   CONTRACT NORMALIZATION
========================================================= */

function createQuoteMap(quotes) {
  const quoteMap = new Map();

  for (const result of quotes || []) {
    const quote = result?.quote;

    if (quote?.instrument_id) {
      quoteMap.set(quote.instrument_id, quote);
    }
  }

  return quoteMap;
}

function normalizeContract(instrument, quoteMap) {
  if (!instrument) return null;

  const quote = quoteMap.get(instrument.id);

  if (!quote) return null;

  return {
    id: instrument.id,
    strike: toNumber(instrument.strike_price),
    type: instrument.type,

    bid: toNumber(quote.bid_price),
    ask: toNumber(quote.ask_price),
    mark: toNumber(quote.mark_price),

    iv: toNumber(quote.implied_volatility),

    delta: toNumber(quote.delta),
    gamma: toNumber(quote.gamma),
    theta: toNumber(quote.theta),
    vega: toNumber(quote.vega),

    volume: toNumber(quote.volume) ?? 0,
    openInterest: toNumber(quote.open_interest) ?? 0,

    breakEven: toNumber(quote.break_even_price),

    updatedAt: quote.updated_at || null,
  };
}

function getAllStrikes(instruments) {
  return [
    ...new Set(
      instruments
        .map((item) => toNumber(item.strike_price))
        .filter((value) => value !== null)
    ),
  ].sort((a, b) => a - b);
}

function getVisibleInstruments(instruments, price, strikeRange) {
  if (!instruments.length || price === null || price === undefined) {
    return [];
  }

  const strikes = getAllStrikes(instruments);

  if (!strikes.length) return [];

  let atmIndex = 0;
  let bestDistance = Infinity;

  strikes.forEach((strike, index) => {
    const distance = Math.abs(strike - price);

    if (distance < bestDistance) {
      bestDistance = distance;
      atmIndex = index;
    }
  });

  const visibleStrikes = strikes.slice(
    Math.max(0, atmIndex - strikeRange),
    Math.min(strikes.length, atmIndex + strikeRange + 1)
  );

  const visibleSet = new Set(visibleStrikes);

  return instruments.filter((instrument) =>
    visibleSet.has(toNumber(instrument.strike_price))
  );
}

/* =========================================================
   VISIBLE OPTION CHAIN
========================================================= */

function buildChainRows(instruments, quotes, price, strikeRange) {
  const quoteMap = createQuoteMap(quotes);
  const strikes = getAllStrikes(instruments);

  if (!strikes.length || price === null || price === undefined) {
    return {
      rows: [],
      atmStrike: null,
    };
  }

  let atmIndex = 0;
  let bestDistance = Infinity;

  strikes.forEach((strike, index) => {
    const distance = Math.abs(strike - price);

    if (distance < bestDistance) {
      bestDistance = distance;
      atmIndex = index;
    }
  });

  const atmStrike = strikes[atmIndex];

  const visibleStrikes = strikes.slice(
    Math.max(0, atmIndex - strikeRange),
    Math.min(strikes.length, atmIndex + strikeRange + 1)
  );

  const visibleSet = new Set(visibleStrikes);
  const byStrike = new Map();

  for (const instrument of instruments) {
    const strike = toNumber(instrument.strike_price);

    if (strike === null || !visibleSet.has(strike)) continue;

    if (!byStrike.has(strike)) {
      byStrike.set(strike, {
        strike,
        call: null,
        put: null,
      });
    }

    const contract = normalizeContract(instrument, quoteMap);

    if (!contract) continue;

    if (instrument.type === "call") {
      byStrike.get(strike).call = contract;
    }

    if (instrument.type === "put") {
      byStrike.get(strike).put = contract;
    }
  }

  return {
    atmStrike,

    rows: visibleStrikes.map(
      (strike) =>
        byStrike.get(strike) ?? {
          strike,
          call: null,
          put: null,
        }
    ),
  };
}

/* =========================================================
   FULL CHAIN ANALYSIS
========================================================= */

function highestBy(list, field) {
  if (!list.length) return null;

  return [...list].sort(
    (a, b) => (b?.[field] ?? 0) - (a?.[field] ?? 0)
  )[0];
}

function buildFullChainAnalysis(instruments, quotes, spot) {
  if (!instruments.length || !quotes.length) return null;

  const quoteMap = createQuoteMap(quotes);

  const contracts = instruments
    .map((instrument) => normalizeContract(instrument, quoteMap))
    .filter(Boolean)
    .filter((contract) => contract.strike !== null);

  const calls = contracts.filter((contract) => contract.type === "call");
  const puts = contracts.filter((contract) => contract.type === "put");

  const callVolume = calls.reduce(
    (total, contract) => total + contract.volume,
    0
  );

  const putVolume = puts.reduce(
    (total, contract) => total + contract.volume,
    0
  );

  const callOI = calls.reduce(
    (total, contract) => total + contract.openInterest,
    0
  );

  const putOI = puts.reduce(
    (total, contract) => total + contract.openInterest,
    0
  );

  const pcrVolume = callVolume > 0 ? putVolume / callVolume : null;
  const pcrOI = callOI > 0 ? putOI / callOI : null;

  const highestCallVolume = highestBy(calls, "volume");
  const highestPutVolume = highestBy(puts, "volume");

  const callOIWall = highestBy(calls, "openInterest");
  const putOIWall = highestBy(puts, "openInterest");

  const strikeMap = new Map();

  for (const contract of contracts) {
    if (!strikeMap.has(contract.strike)) {
      strikeMap.set(contract.strike, {
        strike: contract.strike,

        callOI: 0,
        putOI: 0,
        totalOI: 0,

        callVolume: 0,
        putVolume: 0,
        totalVolume: 0,

        gammaOIProxy: 0,
      });
    }

    const row = strikeMap.get(contract.strike);

    row.gammaOIProxy +=
      Math.abs(contract.gamma ?? 0) * contract.openInterest;

    row.totalOI += contract.openInterest;
    row.totalVolume += contract.volume;

    if (contract.type === "call") {
      row.callOI += contract.openInterest;
      row.callVolume += contract.volume;
    }

    if (contract.type === "put") {
      row.putOI += contract.openInterest;
      row.putVolume += contract.volume;
    }
  }

  const strikeRows = [...strikeMap.values()];

  const gammaConcentration = strikeRows.length
    ? [...strikeRows].sort(
        (a, b) => b.gammaOIProxy - a.gammaOIProxy
      )[0]
    : null;

  const lowerRows =
    spot !== null && spot !== undefined
      ? strikeRows.filter((row) => row.strike < spot)
      : [];

  const upperRows =
    spot !== null && spot !== undefined
      ? strikeRows.filter((row) => row.strike > spot)
      : [];

  const lowerOIConcentration = lowerRows.length
    ? [...lowerRows].sort((a, b) => b.totalOI - a.totalOI)[0]
    : null;

  const upperOIConcentration = upperRows.length
    ? [...upperRows].sort((a, b) => b.totalOI - a.totalOI)[0]
    : null;

  return {
    totalInstrumentCount: instruments.length,
    quotedContractCount: contracts.length,

    callCount: calls.length,
    putCount: puts.length,

    callVolume,
    putVolume,
    pcrVolume,

    callOI,
    putOI,
    pcrOI,

    highestCallVolume,
    highestPutVolume,

    callOIWall,
    putOIWall,

    gammaConcentration,

    lowerOIConcentration,
    upperOIConcentration,

    strikeRows,
  };
}

/* =========================================================
   HISTORICAL HELPERS
========================================================= */

function extractHistoricalBars(payload) {
  const data = payload?.data ?? payload ?? {};
  const result = data.results?.[0];

  return (result?.bars || [])
    .filter((bar) => !bar.interpolated)
    .map((bar) => ({
      time: bar.begins_at,

      open: toNumber(bar.open_price),
      high: toNumber(bar.high_price),
      low: toNumber(bar.low_price),
      close: toNumber(bar.close_price),

      volume: toNumber(bar.volume) ?? 0,
    }))
    .filter((bar) => bar.close !== null);
}

function extractIndicatorSeries(payload, type) {
  const data = payload?.data ?? payload ?? {};
  const indicators = data.indicators || [];

  return (
    indicators.find((indicator) => indicator.type === type)?.series ||
    []
  );
}

function filterByCalendarDays(list, days) {
  const cutoff = new Date();

  cutoff.setDate(cutoff.getDate() - days);

  return list.filter((item) => {
    const time = new Date(item.time || item.begins_at);

    return !Number.isNaN(time.getTime()) && time >= cutoff;
  });
}

function highestHigh(bars, count) {
  const subset = bars.slice(-count);

  if (!subset.length) return null;

  return Math.max(
    ...subset.map((bar) => bar.high ?? bar.close)
  );
}

function lowestLow(bars, count) {
  const subset = bars.slice(-count);

  if (!subset.length) return null;

  return Math.min(
    ...subset.map((bar) => bar.low ?? bar.close)
  );
}

function findRecentSwingHigh(bars, window = 2) {
  if (bars.length < window * 2 + 1) return null;

  for (
    let i = bars.length - window - 1;
    i >= window;
    i--
  ) {
    const current = bars[i];
    const value = current.high ?? current.close;

    let isSwing = true;

    for (let j = 1; j <= window; j++) {
      const left = bars[i - j].high ?? bars[i - j].close;
      const right = bars[i + j].high ?? bars[i + j].close;

      if (value <= left || value <= right) {
        isSwing = false;
        break;
      }
    }

    if (isSwing) {
      return {
        price: value,
        time: current.time,
      };
    }
  }

  return null;
}

function findRecentSwingLow(bars, window = 2) {
  if (bars.length < window * 2 + 1) return null;

  for (
    let i = bars.length - window - 1;
    i >= window;
    i--
  ) {
    const current = bars[i];
    const value = current.low ?? current.close;

    let isSwing = true;

    for (let j = 1; j <= window; j++) {
      const left = bars[i - j].low ?? bars[i - j].close;
      const right = bars[i + j].low ?? bars[i + j].close;

      if (value >= left || value >= right) {
        isSwing = false;
        break;
      }
    }

    if (isSwing) {
      return {
        price: value,
        time: current.time,
      };
    }
  }

  return null;
}

/* =========================================================
   STRATEGY ENGINE
========================================================= */

function closestByDelta(contracts, target, absolute = false) {
  const usable = contracts.filter(
    (contract) => contract && contract.delta !== null
  );

  if (!usable.length) return null;

  return [...usable].sort((a, b) => {
    const da = absolute ? Math.abs(a.delta) : a.delta;
    const db = absolute ? Math.abs(b.delta) : b.delta;

    return Math.abs(da - target) - Math.abs(db - target);
  })[0];
}

function analyzeSetup(data, rows, atmStrike) {
  const calls = rows.map((row) => row.call).filter(Boolean);
  const puts = rows.map((row) => row.put).filter(Boolean);

  const callVolume = calls.reduce(
    (total, contract) => total + (contract.volume || 0),
    0
  );

  const putVolume = puts.reduce(
    (total, contract) => total + (contract.volume || 0),
    0
  );

  const callOI = calls.reduce(
    (total, contract) => total + (contract.openInterest || 0),
    0
  );

  const putOI = puts.reduce(
    (total, contract) => total + (contract.openInterest || 0),
    0
  );

  const pcrVolume = callVolume > 0 ? putVolume / callVolume : null;
  const pcrOI = callOI > 0 ? putOI / callOI : null;

  let bullishScore = 0;
  let bearishScore = 0;

  if (data.rsi !== null) {
    if (data.rsi >= 55) bullishScore += 1;
    if (data.rsi <= 45) bearishScore += 1;
  }

  if (
    data.macd?.histogram !== null &&
    data.macd?.histogram !== undefined
  ) {
    if (data.macd.histogram > 0) bullishScore += 1;
    if (data.macd.histogram < 0) bearishScore += 1;
  }

  if (data.changePct !== null) {
    if (data.changePct > 0) bullishScore += 1;
    if (data.changePct < 0) bearishScore += 1;
  }

  let momentum = "Mixed / Neutral";
  let momentumTextClass = "text-amber-300";

  if (bullishScore >= 2 && bullishScore > bearishScore) {
    momentum = "Bullish";
    momentumTextClass = "text-emerald-300";
  }

  if (bearishScore >= 2 && bearishScore > bullishScore) {
    momentum = "Bearish";
    momentumTextClass = "text-red-300";
  }

  const allContracts = [...calls, ...puts];

  const gammaLeader =
    allContracts
      .filter((contract) => contract.gamma !== null)
      .sort(
        (a, b) =>
          Math.abs(b.gamma) -
          Math.abs(a.gamma)
      )[0] ?? null;

  const thetaLeader =
    allContracts
      .filter((contract) => contract.theta !== null)
      .sort(
        (a, b) =>
          Math.abs(b.theta) -
          Math.abs(a.theta)
      )[0] ?? null;

  const atmRow = rows.find((row) => row.strike === atmStrike);

  const atmIvs = [
    atmRow?.call?.iv,
    atmRow?.put?.iv,
  ].filter(
    (value) => value !== null && value !== undefined
  );

  const atmIV = atmIvs.length
    ? atmIvs.reduce((total, value) => total + value, 0) /
      atmIvs.length
    : data.atmIV;

  const lowerRows = rows.filter((row) => row.strike < data.price);
  const upperRows = rows.filter((row) => row.strike > data.price);

  const lowerReference = lowerRows.length
    ? lowerRows[lowerRows.length - 1].strike
    : null;

  const upperReference = upperRows.length
    ? upperRows[0].strike
    : null;

  const flow = flowDescriptor(pcrVolume);

  let strategy = {
    name: "No clear directional structure",

    bias: "Neutral",

    description:
      "The directional signals are not sufficiently aligned for the rule-based spread engine.",

    legs: [],

    invalidation:
      "Wait for stronger agreement between RSI, MACD and price direction.",
  };

  if (momentum === "Bullish") {
    const longCall = closestByDelta(calls, 0.55);

    const higherCalls = calls.filter(
      (contract) =>
        longCall &&
        contract.strike > longCall.strike
    );

    const shortCall = closestByDelta(higherCalls, 0.3);

    strategy = {
      name: "Bull Call Debit Spread",

      bias: "Bullish",

      description:
        "The rule engine found positive momentum alignment. The defined-risk debit spread reduces premium and theta exposure relative to the long call alone.",

      legs:
        longCall && shortCall
          ? [
              {
                action: "Long call",
                side: "long",
                contract: longCall,
              },

              {
                action: "Short call",
                side: "short",
                contract: shortCall,
              },
            ]
          : [],

      invalidation:
        "The bullish setup weakens if MACD histogram turns negative and RSI loses the 50 area.",
    };
  }

  if (momentum === "Bearish") {
    const longPut = closestByDelta(puts, 0.55, true);

    const lowerPuts = puts.filter(
      (contract) =>
        longPut &&
        contract.strike < longPut.strike
    );

    const shortPut = closestByDelta(lowerPuts, 0.3, true);

    strategy = {
      name: "Bear Put Debit Spread",

      bias: "Bearish",

      description:
        "The rule engine found negative momentum alignment. The defined-risk debit spread reduces premium and theta exposure relative to the long put alone.",

      legs:
        longPut && shortPut
          ? [
              {
                action: "Long put",
                side: "long",
                contract: longPut,
              },

              {
                action: "Short put",
                side: "short",
                contract: shortPut,
              },
            ]
          : [],

      invalidation:
        "The bearish setup weakens if MACD histogram turns positive and RSI recovers above the 50 area.",
    };
  }

  return {
    momentum,
    momentumTextClass,

    callVolume,
    putVolume,

    callOI,
    putOI,

    pcrVolume,
    pcrOI,

    flowLabel: flow.label,
    flowClass: flow.className,

    gammaLeader,
    thetaLeader,

    atmIV,

    lowerReference,
    upperReference,

    strategy,
  };
}

/* =========================================================
   SPREAD ECONOMICS
========================================================= */

function legSpreadPercent(contract) {
  if (!contract) return null;

  const bid = toNumber(contract.bid);
  const ask = toNumber(contract.ask);
  const mark = toNumber(contract.mark);

  if (
    bid === null ||
    ask === null ||
    mark === null ||
    mark <= 0
  ) {
    return null;
  }

  return ((ask - bid) / mark) * 100;
}

function calculateSpreadEconomics(strategy) {
  if (!strategy || strategy.legs?.length !== 2) return null;

  const longLeg = strategy.legs.find((leg) => leg.side === "long");
  const shortLeg = strategy.legs.find((leg) => leg.side === "short");

  if (!longLeg || !shortLeg) return null;

  const longContract = longLeg.contract;
  const shortContract = shortLeg.contract;

  const width = Math.abs(
    shortContract.strike -
      longContract.strike
  );

  const entryDebit =
    longContract.ask !== null &&
    shortContract.bid !== null
      ? longContract.ask -
        shortContract.bid
      : null;

  const midpointDebit =
    longContract.mark !== null &&
    shortContract.mark !== null
      ? longContract.mark -
        shortContract.mark
      : null;

  const validDebit =
    entryDebit !== null &&
    entryDebit > 0
      ? entryDebit
      : null;

  const maxLoss =
    validDebit !== null
      ? validDebit * 100
      : null;

  const maxProfitPerShare =
    validDebit !== null
      ? width - validDebit
      : null;

  const maxProfit =
    maxProfitPerShare !== null
      ? maxProfitPerShare * 100
      : null;

  let breakeven = null;

  if (validDebit !== null) {
    if (strategy.bias === "Bullish") {
      breakeven =
        longContract.strike +
        validDebit;
    }

    if (strategy.bias === "Bearish") {
      breakeven =
        longContract.strike -
        validDebit;
    }
  }

  const rewardRisk =
    maxProfit !== null &&
    maxProfit > 0 &&
    maxLoss !== null &&
    maxLoss > 0
      ? maxProfit / maxLoss
      : null;

  const netDelta =
    longContract.delta !== null &&
    shortContract.delta !== null
      ? longContract.delta -
        shortContract.delta
      : null;

  const netGamma =
    longContract.gamma !== null &&
    shortContract.gamma !== null
      ? longContract.gamma -
        shortContract.gamma
      : null;

  const netTheta =
    longContract.theta !== null &&
    shortContract.theta !== null
      ? longContract.theta -
        shortContract.theta
      : null;

  const netVega =
    longContract.vega !== null &&
    shortContract.vega !== null
      ? longContract.vega -
        shortContract.vega
      : null;

  const longSpreadPct = legSpreadPercent(longContract);
  const shortSpreadPct = legSpreadPercent(shortContract);

  const warnings = [];

  function checkLeg(label, contract, spreadPct) {
    if (contract.bid === 0) {
      warnings.push(`${label}: no active bid shown`);
    }

    if (spreadPct !== null && spreadPct >= 15) {
      warnings.push(
        `${label}: wide bid/ask (${spreadPct.toFixed(1)}% of mark)`
      );
    }

    if (contract.openInterest < 100) {
      warnings.push(
        `${label}: low open interest (${compact(
          contract.openInterest
        )})`
      );
    }

    if (contract.volume < 20) {
      warnings.push(
        `${label}: low displayed volume (${compact(
          contract.volume
        )})`
      );
    }
  }

  checkLeg(
    longLeg.action,
    longContract,
    longSpreadPct
  );

  checkLeg(
    shortLeg.action,
    shortContract,
    shortSpreadPct
  );

  return {
    longLeg,
    shortLeg,

    width,

    entryDebit,
    midpointDebit,

    maxLoss,
    maxProfit,

    breakeven,
    rewardRisk,

    netDelta,
    netGamma,
    netTheta,
    netVega,

    longSpreadPct,
    shortSpreadPct,

    warnings,
  };
}

/* =========================================================
   PAYOFF
========================================================= */

function spreadPLAtExpiration(strategy, economics, stockPrice) {
  if (
    !economics ||
    stockPrice === null ||
    stockPrice === undefined
  ) {
    return null;
  }

  const longContract = economics.longLeg.contract;
  const shortContract = economics.shortLeg.contract;

  const debit = economics.entryDebit;

  if (debit === null || debit <= 0) return null;

  let intrinsic = 0;

  if (strategy.bias === "Bullish") {
    intrinsic =
      Math.max(
        stockPrice -
          longContract.strike,
        0
      ) -
      Math.max(
        stockPrice -
          shortContract.strike,
        0
      );
  }

  if (strategy.bias === "Bearish") {
    intrinsic =
      Math.max(
        longContract.strike -
          stockPrice,
        0
      ) -
      Math.max(
        shortContract.strike -
          stockPrice,
        0
      );
  }

  return (intrinsic - debit) * 100;
}

function buildPayoffSeries(strategy, economics, currentSpot) {
  if (
    !economics ||
    currentSpot === null ||
    currentSpot === undefined
  ) {
    return [];
  }

  const longStrike = economics.longLeg.contract.strike;
  const shortStrike = economics.shortLeg.contract.strike;

  const lowStrike = Math.min(longStrike, shortStrike);
  const highStrike = Math.max(longStrike, shortStrike);

  const spreadWidth = Math.abs(highStrike - lowStrike);

  const margin = Math.max(
    spreadWidth * 1.5,
    currentSpot * 0.04,
    5
  );

  const minPrice = Math.max(
    0,
    Math.min(
      lowStrike,
      currentSpot
    ) - margin
  );

  const maxPrice =
    Math.max(
      highStrike,
      currentSpot
    ) + margin;

  const series = [];

  for (let i = 0; i <= 60; i++) {
    const price =
      minPrice +
      ((maxPrice - minPrice) * i) /
        60;

    series.push({
      price,

      pl: spreadPLAtExpiration(
        strategy,
        economics,
        price
      ),
    });
  }

  return series;
}

/* =========================================================
   SCENARIO ENGINE
========================================================= */

function calculateGreekScenario({
  economics,
  spot,
  scenarioPrice,
  days,
  ivPoints,
}) {
  if (
    !economics ||
    spot === null ||
    spot === undefined
  ) {
    return null;
  }

  const targetPrice =
    toNumber(scenarioPrice) ??
    spot;

  const forwardDays = Math.max(
    0,
    toNumber(days) ?? 0
  );

  const volatilityPoints =
    toNumber(ivPoints) ?? 0;

  const priceMove =
    targetPrice - spot;

  const deltaComponent =
    economics.netDelta !== null
      ? economics.netDelta *
        priceMove
      : 0;

  const gammaComponent =
    economics.netGamma !== null
      ? 0.5 *
        economics.netGamma *
        priceMove *
        priceMove
      : 0;

  const thetaComponent =
    economics.netTheta !== null
      ? economics.netTheta *
        forwardDays
      : 0;

  const vegaComponent =
    economics.netVega !== null
      ? economics.netVega *
        volatilityPoints
      : 0;

  const estimatedMarkChange =
    deltaComponent +
    gammaComponent +
    thetaComponent +
    vegaComponent;

  const currentSpreadMark =
    economics.midpointDebit ??
    economics.entryDebit ??
    0;

  const estimatedSpreadValue =
    clamp(
      currentSpreadMark +
        estimatedMarkChange,
      0,
      economics.width
    );

  const estimatedPL =
    economics.entryDebit !== null
      ? (
          estimatedSpreadValue -
          economics.entryDebit
        ) * 100
      : null;

  const estimatedReturn =
    estimatedPL !== null &&
    economics.maxLoss > 0
      ? (
          estimatedPL /
          economics.maxLoss
        ) * 100
      : null;

  const estimatedDelta =
    economics.netDelta !== null
      ? economics.netDelta +
        (economics.netGamma ?? 0) *
          priceMove
      : null;

  return {
    targetPrice,
    forwardDays,
    volatilityPoints,
    priceMove,

    deltaComponent,
    gammaComponent,
    thetaComponent,
    vegaComponent,

    currentSpreadMark,
    estimatedMarkChange,
    estimatedSpreadValue,
    estimatedPL,
    estimatedReturn,
    estimatedDelta,
  };
}

/* =========================================================
   COMMON UI
========================================================= */

function AnalysisStat({
  label,
  value,
  subtext,
  valueClass = "text-white",
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
        {label}
      </div>

      <div
        className={`mt-1 text-sm font-mono font-bold ${valueClass}`}
      >
        {value}
      </div>

      {subtext && (
        <div className="mt-1 text-[9px] text-zinc-500">
          {subtext}
        </div>
      )}
    </div>
  );
}

function MetricBox({
  label,
  value,
  subtext,
  valueClass = "text-white",
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-black/30 px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
        {label}
      </div>

      <div
        className={`mt-1 text-sm font-mono font-bold ${valueClass}`}
      >
        {value}
      </div>

      {subtext && (
        <div className="mt-1 text-[9px] leading-relaxed text-zinc-600">
          {subtext}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   FULL CHAIN PANEL
========================================================= */

function FullChainFlowPanel({
  analysis,
  loading,
  error,
  progress,
  expiration,
}) {
  const progressPct =
    progress.total > 0
      ? Math.round(
          (progress.completed /
            progress.total) *
            100
        )
      : 0;

  if (loading) {
    return (
      <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.025] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-widest text-cyan-400">
              Full-chain options flow
            </div>

            <div className="mt-1 text-sm font-bold text-white">
              Analyzing {dateLabel(expiration)}
            </div>
          </div>

          <div className="font-mono text-xs text-cyan-300">
            {progress.total > 0
              ? `${progress.completed}/${progress.total}`
              : "Loading..."}
          </div>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full bg-cyan-400"
            style={{
              width: `${progressPct}%`,
            }}
          />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 text-[10px] text-zinc-400">
        Full-chain analysis could not be loaded: {error}
      </div>
    );
  }

  if (!analysis) return null;

  const volumeFlow = flowDescriptor(analysis.pcrVolume);
  const oiFlow = flowDescriptor(analysis.pcrOI);

  return (
    <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.025] p-4">
      <div className="flex justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-cyan-400">
            Full-chain options flow
          </div>

          <div className="mt-1 text-sm font-bold">
            Entire {dateLabel(expiration)} expiration
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            {analysis.quotedContractCount} quoted contracts analyzed from{" "}
            {analysis.totalInstrumentCount} active instruments.
          </div>
        </div>

        <div className="h-fit rounded border border-cyan-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">
          Full expiration
        </div>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-3">
        <MetricBox
          label="Total Call Volume"
          value={compact(analysis.callVolume)}
          valueClass="text-emerald-300"
          subtext={`${analysis.callCount} quoted call contracts`}
        />

        <MetricBox
          label="Total Put Volume"
          value={compact(analysis.putVolume)}
          valueClass="text-red-300"
          subtext={`${analysis.putCount} quoted put contracts`}
        />

        <MetricBox
          label="P/C Volume Ratio"
          value={ratioText(analysis.pcrVolume)}
          valueClass={volumeFlow.className}
          subtext={volumeFlow.label}
        />

        <MetricBox
          label="Total Call OI"
          value={compact(analysis.callOI)}
          valueClass="text-emerald-300"
        />

        <MetricBox
          label="Total Put OI"
          value={compact(analysis.putOI)}
          valueClass="text-red-300"
        />

        <MetricBox
          label="P/C OI Ratio"
          value={ratioText(analysis.pcrOI)}
          valueClass={oiFlow.className}
          subtext={oiFlow.label}
        />
      </div>

      <div className="mt-4 text-[9px] uppercase tracking-widest text-zinc-500">
        Volume concentrations
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <MetricBox
          label="Highest-Volume Call"
          value={money(analysis.highestCallVolume?.strike)}
          valueClass="text-emerald-300"
          subtext={
            analysis.highestCallVolume
              ? `Volume ${compact(
                  analysis.highestCallVolume.volume
                )} · OI ${compact(
                  analysis.highestCallVolume.openInterest
                )}`
              : "—"
          }
        />

        <MetricBox
          label="Highest-Volume Put"
          value={money(analysis.highestPutVolume?.strike)}
          valueClass="text-red-300"
          subtext={
            analysis.highestPutVolume
              ? `Volume ${compact(
                  analysis.highestPutVolume.volume
                )} · OI ${compact(
                  analysis.highestPutVolume.openInterest
                )}`
              : "—"
          }
        />
      </div>

      <div className="mt-4 text-[9px] uppercase tracking-widest text-zinc-500">
        Open-interest concentrations
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-4">
        <MetricBox
          label="Call OI Wall"
          value={money(analysis.callOIWall?.strike)}
          valueClass="text-emerald-300"
          subtext={
            analysis.callOIWall
              ? `OI ${compact(analysis.callOIWall.openInterest)}`
              : "—"
          }
        />

        <MetricBox
          label="Put OI Wall"
          value={money(analysis.putOIWall?.strike)}
          valueClass="text-red-300"
          subtext={
            analysis.putOIWall
              ? `OI ${compact(analysis.putOIWall.openInterest)}`
              : "—"
          }
        />

        <MetricBox
          label="Lower OI Concentration"
          value={money(analysis.lowerOIConcentration?.strike)}
          subtext={
            analysis.lowerOIConcentration
              ? `Combined OI ${compact(
                  analysis.lowerOIConcentration.totalOI
                )}`
              : "—"
          }
        />

        <MetricBox
          label="Upper OI Concentration"
          value={money(analysis.upperOIConcentration?.strike)}
          subtext={
            analysis.upperOIConcentration
              ? `Combined OI ${compact(
                  analysis.upperOIConcentration.totalOI
                )}`
              : "—"
          }
        />
      </div>

      <div className="mt-4 rounded-lg border border-violet-500/20 bg-violet-500/[0.03] p-3">
        <div className="text-[9px] uppercase tracking-widest text-violet-400">
          Gamma concentration proxy
        </div>

        <div className="mt-1 flex gap-3">
          <div className="text-lg font-mono font-bold text-violet-300">
            {money(analysis.gammaConcentration?.strike)}
          </div>

          <div className="text-[10px] text-zinc-500">
            |Γ| × OI proxy{" "}
            {analysis.gammaConcentration
              ? compact(analysis.gammaConcentration.gammaOIProxy)
              : "—"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[9px] text-zinc-500">
        Volume and open interest show where contracts are concentrated, but not
        whether those contracts were bought or sold. Gamma is an |gamma| ×
        open-interest concentration proxy, not dealer positioning.
      </div>
    </div>
  );
}

/* =========================================================
   HISTORICAL PRICE + SMART LABELS + RSI + MACD
========================================================= */

function HistoricalTechnicalChart({
  ticker,
  spot,
  fullChainAnalysis,
}) {
  const [rangeDays, setRangeDays] = useState(90);

  const [showStructure, setShowStructure] = useState(true);
  const [showOptions, setShowOptions] = useState(true);

  const [bars, setBars] = useState([]);
  const [rsiSeries, setRsiSeries] = useState([]);
  const [macdSeries, setMacdSeries] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ticker) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const end = new Date();
        const start = new Date();

        start.setDate(start.getDate() - (rangeDays + 90));

        const common = {
          start_time: start.toISOString(),
          end_time: end.toISOString(),

          interval: "day",
          bounds: "regular",
          adjustment_type: "split",
        };

        const [
          historicalPayload,
          rsiPayload,
          macdPayload,
        ] = await Promise.all([
          callRobinhood("get_equity_historicals", {
            symbols: [ticker],
            ...common,
          }),

          callRobinhood("get_equity_technical_indicators", {
            symbol: ticker,
            type: "rsi",
            ...common,
            output: "series",
            period: 14,
          }),

          callRobinhood("get_equity_technical_indicators", {
            symbol: ticker,
            type: "macd",
            ...common,
            output: "series",

            fast_period: 12,
            slow_period: 26,
            signal_period: 9,
          }),
        ]);

        if (cancelled) return;

        const loadedBars = extractHistoricalBars(
          historicalPayload
        );

        const loadedRsi = extractIndicatorSeries(
          rsiPayload,
          "rsi"
        );

        const loadedMacd = extractIndicatorSeries(
          macdPayload,
          "macd"
        );

        setBars(
          filterByCalendarDays(
            loadedBars,
            rangeDays
          )
        );

        setRsiSeries(
          filterByCalendarDays(
            loadedRsi.map((item) => ({
              ...item,
              time: item.begins_at,
            })),
            rangeDays
          )
        );

        setMacdSeries(
          filterByCalendarDays(
            loadedMacd.map((item) => ({
              ...item,
              time: item.begins_at,
            })),
            rangeDays
          )
        );
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [ticker, rangeDays]);

  if (loading) {
    return (
      <div className="mb-4 rounded-xl border border-blue-500/20 bg-blue-500/[0.025] p-4">
        <div className="text-[9px] uppercase tracking-widest text-blue-400">
          Historical technicals
        </div>

        <div className="mt-2 text-sm text-zinc-300">
          Loading price, RSI and MACD history...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
        <div className="text-[9px] uppercase tracking-widest text-amber-400">
          Historical technicals
        </div>

        <div className="mt-2 text-[10px] text-zinc-400">
          Historical chart could not be loaded: {error}
        </div>
      </div>
    );
  }

  if (!bars.length) return null;

  /* PRICE STRUCTURE */

  const high20 = highestHigh(bars, 20);
  const low20 = lowestLow(bars, 20);

  const high50 = highestHigh(bars, 50);
  const low50 = lowestLow(bars, 50);

  const recentSwingHigh = findRecentSwingHigh(bars, 2);
  const recentSwingLow = findRecentSwingLow(bars, 2);

  const callWall =
    fullChainAnalysis?.callOIWall?.strike ??
    null;

  const putWall =
    fullChainAnalysis?.putOIWall?.strike ??
    null;

  const gammaLevel =
    fullChainAnalysis?.gammaConcentration?.strike ??
    null;

  /* CHART DIMENSIONS */

  const width = 1100;

  const priceHeight = 330;
  const rsiHeight = 145;
  const macdHeight = 165;

  const left = 62;
  const right = 18;

  const top = 18;
  const bottom = 30;

  /*
    NEW:
    price chart reserves a right-side gutter for labels.
  */

  const priceLabelGutter = 190;

  const pricePlotRight =
    width -
    priceLabelGutter;

  const pricePlotWidth =
    pricePlotRight -
    left;

  const indicatorWidth =
    width -
    left -
    right;

  function indicatorX(index, length) {
    if (length <= 1) return left;

    return (
      left +
      (index /
        (length - 1)) *
        indicatorWidth
    );
  }

  function priceX(index, length) {
    if (length <= 1) return left;

    return (
      left +
      (index /
        (length - 1)) *
        pricePlotWidth
    );
  }

  /* PRICE RANGE */

  const optionLevels = [
    callWall,
    putWall,
    gammaLevel,
  ].filter((value) => {
    if (
      value === null ||
      value === undefined ||
      !spot
    ) {
      return false;
    }

    return (
      Math.abs(value - spot) /
        spot <=
      0.15
    );
  });

  const structureLevels = [
    high20,
    low20,
    high50,
    low50,

    recentSwingHigh?.price,
    recentSwingLow?.price,
  ].filter(
    (value) =>
      value !== null &&
      value !== undefined
  );

  const rangeLevels = [
    ...bars.map(
      (bar) =>
        bar.high ??
        bar.close
    ),

    ...bars.map(
      (bar) =>
        bar.low ??
        bar.close
    ),

    ...(showOptions
      ? optionLevels
      : []),

    ...(showStructure
      ? structureLevels
      : []),
  ];

  const rawPriceLow = Math.min(
    ...rangeLevels
  );

  const rawPriceHigh = Math.max(
    ...rangeLevels
  );

  const pricePadding = Math.max(
    (
      rawPriceHigh -
      rawPriceLow
    ) *
      0.07,
    1
  );

  const priceMin =
    rawPriceLow -
    pricePadding;

  const priceMax =
    rawPriceHigh +
    pricePadding;

  const pricePlotHeight =
    priceHeight -
    top -
    bottom;

  function priceY(value) {
    return (
      top +
      (
        1 -
        (
          value -
          priceMin
        ) /
          (
            priceMax -
            priceMin
          )
      ) *
        pricePlotHeight
    );
  }

  const pricePoints = bars
    .map(
      (bar, index) =>
        `${priceX(
          index,
          bars.length
        )},${priceY(
          bar.close
        )}`
    )
    .join(" ");

  const firstClose =
    bars[0].close;

  const lastClose =
    bars[
      bars.length -
        1
    ].close;

  const periodChange =
    firstClose
      ? (
          (
            lastClose -
            firstClose
          ) /
          firstClose
        ) *
        100
      : null;

  const periodHigh = Math.max(
    ...bars.map(
      (bar) =>
        bar.high ??
        bar.close
    )
  );

  const periodLow = Math.min(
    ...bars.map(
      (bar) =>
        bar.low ??
        bar.close
    )
  );

  /*
    =======================================================
    SMART OVERLAY LABELS
    =======================================================
  */

  const overlayDefinitions = [];

  if (
    spot !== null &&
    spot !== undefined
  ) {
    overlayDefinitions.push({
      id: "spot",
      level: spot,
      label: "Spot",
      className: "text-yellow-400",
      dash: "7 5",
    });
  }

  if (showStructure) {
    if (high20 !== null) {
      overlayDefinitions.push({
        id: "20-high",
        level: high20,
        label: "20D High",
        className: "text-cyan-400",
        dash: "6 5",
      });
    }

    if (low20 !== null) {
      overlayDefinitions.push({
        id: "20-low",
        level: low20,
        label: "20D Low",
        className: "text-cyan-400",
        dash: "6 5",
      });
    }

    if (
      recentSwingHigh?.price !==
      null &&
      recentSwingHigh?.price !==
      undefined
    ) {
      overlayDefinitions.push({
        id: "swing-high",
        level: recentSwingHigh.price,
        label: "Swing High",
        className: "text-amber-400",
        dash: "3 6",
      });
    }

    if (
      recentSwingLow?.price !==
      null &&
      recentSwingLow?.price !==
      undefined
    ) {
      overlayDefinitions.push({
        id: "swing-low",
        level: recentSwingLow.price,
        label: "Swing Low",
        className: "text-amber-400",
        dash: "3 6",
      });
    }
  }

  if (showOptions) {
    if (
      callWall !== null &&
      callWall !== undefined
    ) {
      overlayDefinitions.push({
        id: "call-wall",
        level: callWall,
        label: "Call OI Wall",
        className: "text-emerald-400",
        dash: "10 5",
      });
    }

    if (
      putWall !== null &&
      putWall !== undefined
    ) {
      overlayDefinitions.push({
        id: "put-wall",
        level: putWall,
        label: "Put OI Wall",
        className: "text-red-400",
        dash: "10 5",
      });
    }

    if (
      gammaLevel !== null &&
      gammaLevel !== undefined
    ) {
      overlayDefinitions.push({
        id: "gamma",
        level: gammaLevel,
        label: "Gamma",
        className: "text-violet-400",
        dash: "2 5",
      });
    }
  }

  const overlayLayout =
    layoutChartLabels(
      overlayDefinitions
        .filter(
          (item) =>
            item.level >=
              priceMin &&
            item.level <=
              priceMax
        )
        .map(
          (item) => ({
            ...item,
            actualY:
              priceY(
                item.level
              ),
          })
        ),

      top + 8,

      priceHeight -
        bottom -
        8,

      18
    );

  /* RSI */

  const usableRsi =
    rsiSeries.filter(
      (item) =>
        toNumber(
          item.value
        ) !==
        null
    );

  const rsiPlotHeight =
    rsiHeight -
    top -
    bottom;

  function rsiY(value) {
    return (
      top +
      (
        1 -
        value /
          100
      ) *
        rsiPlotHeight
    );
  }

  const rsiPoints =
    usableRsi
      .map(
        (
          item,
          index
        ) =>
          `${indicatorX(
            index,
            usableRsi.length
          )},${rsiY(
            Number(
              item.value
            )
          )}`
      )
      .join(" ");

  const latestRsi =
    usableRsi.length
      ? toNumber(
          usableRsi[
            usableRsi.length -
              1
          ].value
        )
      : null;

  /* MACD */

  const usableMacd =
    macdSeries.filter(
      (item) =>
        toNumber(
          item.macd
        ) !==
          null &&
        toNumber(
          item.signal
        ) !==
          null
    );

  const macdValues =
    usableMacd.flatMap(
      (item) => [
        toNumber(
          item.macd
        ) ?? 0,

        toNumber(
          item.signal
        ) ?? 0,

        toNumber(
          item.histogram
        ) ?? 0,
      ]
    );

  let macdMin = Math.min(
    ...macdValues,
    0
  );

  let macdMax = Math.max(
    ...macdValues,
    0
  );

  const macdSpan = Math.max(
    macdMax -
      macdMin,
    1
  );

  macdMin -=
    macdSpan *
    0.12;

  macdMax +=
    macdSpan *
    0.12;

  const macdPlotHeight =
    macdHeight -
    top -
    bottom;

  function macdY(value) {
    return (
      top +
      (
        1 -
        (
          value -
          macdMin
        ) /
          (
            macdMax -
            macdMin
          )
      ) *
        macdPlotHeight
    );
  }

  const macdPoints =
    usableMacd
      .map(
        (
          item,
          index
        ) =>
          `${indicatorX(
            index,
            usableMacd.length
          )},${macdY(
            toNumber(
              item.macd
            ) ?? 0
          )}`
      )
      .join(" ");

  const signalPoints =
    usableMacd
      .map(
        (
          item,
          index
        ) =>
          `${indicatorX(
            index,
            usableMacd.length
          )},${macdY(
            toNumber(
              item.signal
            ) ?? 0
          )}`
      )
      .join(" ");

  const latestMacd =
    usableMacd.length
      ? usableMacd[
          usableMacd.length -
            1
        ]
      : null;

  const zeroY =
    macdY(0);

  const histogramBarWidth =
    usableMacd.length >
    0
      ? Math.max(
          2,
          (
            indicatorWidth /
            usableMacd.length
          ) *
            0.65
        )
      : 2;

  const firstBar = bars[0];

  const middleBar =
    bars[
      Math.floor(
        bars.length /
          2
      )
    ];

  const lastBar =
    bars[
      bars.length -
        1
    ];

  return (
    <div className="mb-4 rounded-xl border border-blue-500/20 bg-blue-500/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-blue-400">
            Historical technicals
          </div>

          <div className="mt-1 text-sm font-bold text-white">
            {ticker} price + momentum + structure
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Daily regular-session data · RSI(14) · MACD(12,26,9)
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {[
            {
              label: "1M",
              days: 30,
            },

            {
              label: "3M",
              days: 90,
            },

            {
              label: "6M",
              days: 180,
            },
          ].map((item) => (
            <button
              type="button"
              key={item.days}
              onClick={() =>
                setRangeDays(
                  item.days
                )
              }
              className={`rounded border px-2.5 py-1 text-[10px] font-mono ${
                rangeDays ===
                item.days
                  ? "border-blue-400/60 bg-blue-400/10 text-blue-300"
                  : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
              }`}
            >
              {item.label}
            </button>
          ))}

          <div className="mx-1 w-px bg-zinc-800" />

          <button
            type="button"
            onClick={() =>
              setShowStructure(
                (current) =>
                  !current
              )
            }
            className={`rounded border px-2.5 py-1 text-[10px] ${
              showStructure
                ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-300"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            Price Structure
          </button>

          <button
            type="button"
            onClick={() =>
              setShowOptions(
                (current) =>
                  !current
              )
            }
            className={`rounded border px-2.5 py-1 text-[10px] ${
              showOptions
                ? "border-violet-400/50 bg-violet-400/10 text-violet-300"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            Options Levels
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <MetricBox
          label="Latest Daily Close"
          value={money(
            lastClose
          )}
          subtext={`Live/extended ${money(
            spot
          )}`}
        />

        <MetricBox
          label="Period Change"
          value={
            periodChange !==
            null
              ? `${
                  periodChange >=
                  0
                    ? "+"
                    : ""
                }${periodChange.toFixed(
                  1
                )}%`
              : "—"
          }
          valueClass={
            periodChange >
            0
              ? "text-emerald-300"
              : periodChange <
                  0
                ? "text-red-300"
                : "text-zinc-200"
          }
        />

        <MetricBox
          label="Period High"
          value={money(
            periodHigh
          )}
        />

        <MetricBox
          label="Period Low"
          value={money(
            periodLow
          )}
        />

        <MetricBox
          label="Trading Days"
          value={
            bars.length
          }
        />
      </div>

      {/* PRICE STRUCTURE */}

      <div className="mt-4">
        <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
          Price structure
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <MetricBox
            label="20-Day High"
            value={money(
              high20
            )}
            valueClass="text-cyan-300"
            subtext={distanceText(
              high20,
              spot
            )}
          />

          <MetricBox
            label="20-Day Low"
            value={money(
              low20
            )}
            valueClass="text-cyan-300"
            subtext={distanceText(
              low20,
              spot
            )}
          />

          <MetricBox
            label="50-Day High"
            value={money(
              high50
            )}
            subtext={distanceText(
              high50,
              spot
            )}
          />

          <MetricBox
            label="50-Day Low"
            value={money(
              low50
            )}
            subtext={distanceText(
              low50,
              spot
            )}
          />

          <MetricBox
            label="Recent Swing High"
            value={money(
              recentSwingHigh
                ?.price
            )}
            valueClass="text-amber-300"
            subtext={
              recentSwingHigh
                ? `${chartDate(
                    recentSwingHigh.time
                  )} · ${distanceText(
                    recentSwingHigh.price,
                    spot
                  )}`
                : "No recent pivot found"
            }
          />

          <MetricBox
            label="Recent Swing Low"
            value={money(
              recentSwingLow
                ?.price
            )}
            valueClass="text-amber-300"
            subtext={
              recentSwingLow
                ? `${chartDate(
                    recentSwingLow.time
                  )} · ${distanceText(
                    recentSwingLow.price,
                    spot
                  )}`
                : "No recent pivot found"
            }
          />
        </div>
      </div>

      {/* OPTIONS LEVELS */}

      {fullChainAnalysis && (
        <div className="mt-4">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Options positioning overlay
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <MetricBox
              label="Call OI Wall"
              value={money(
                callWall
              )}
              valueClass="text-emerald-300"
              subtext={distanceText(
                callWall,
                spot
              )}
            />

            <MetricBox
              label="Put OI Wall"
              value={money(
                putWall
              )}
              valueClass="text-red-300"
              subtext={distanceText(
                putWall,
                spot
              )}
            />

            <MetricBox
              label="Gamma Concentration"
              value={money(
                gammaLevel
              )}
              valueClass="text-violet-300"
              subtext={distanceText(
                gammaLevel,
                spot
              )}
            />
          </div>
        </div>
      )}

      {/* PRICE CHART */}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Daily closing price
          </div>

          <div className="text-[9px] text-zinc-600">
            Smart label spacing enabled
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${priceHeight}`}
          className="w-full"
        >
          {/* Main chart background divider */}

          <line
            x1={pricePlotRight + 8}
            x2={pricePlotRight + 8}
            y1={top}
            y2={
              priceHeight -
              bottom
            }
            stroke="currentColor"
            className="text-zinc-800"
            strokeWidth="1"
            strokeDasharray="3 5"
          />

          {/* Horizontal grid */}

          {[0.25, 0.5, 0.75].map((fraction) => {
            const y =
              top +
              pricePlotHeight *
                fraction;

            return (
              <line
                key={fraction}
                x1={left}
                x2={pricePlotRight}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-zinc-800"
                strokeWidth="1"
              />
            );
          })}

          {/* Smart level lines + labels */}

          {overlayLayout.map((item) => (
            <g
              key={item.id}
              className={item.className}
            >
              {/* True price line */}

              <line
                x1={left}
                x2={pricePlotRight}
                y1={item.actualY}
                y2={item.actualY}
                stroke="currentColor"
                strokeWidth={
                  item.id ===
                  "spot"
                    ? "1.5"
                    : "1.2"
                }
                strokeDasharray={item.dash}
              />

              {/* Connector into label gutter */}

              <line
                x1={pricePlotRight}
                x2={pricePlotRight + 13}
                y1={item.actualY}
                y2={item.labelY}
                stroke="currentColor"
                strokeWidth="1"
                opacity="0.8"
              />

              {/* Small endpoint */}

              <circle
                cx={pricePlotRight + 13}
                cy={item.labelY}
                r="2"
                fill="currentColor"
              />

              {/* Smart-spaced label */}

              <text
                x={pricePlotRight + 20}
                y={item.labelY + 4}
                fill="currentColor"
                className="text-[10px]"
              >
                {item.label}{" "}
                <tspan fontWeight="700">
                  {money(item.level)}
                </tspan>
              </text>
            </g>
          ))}

          {/* Price history */}

          <polyline
            points={pricePoints}
            fill="none"
            stroke="currentColor"
            className="text-blue-400"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Y-axis labels */}

          <text
            x="4"
            y={top + 5}
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            {money(priceMax)}
          </text>

          <text
            x="4"
            y={
              priceHeight -
              bottom
            }
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            {money(priceMin)}
          </text>

          {/* Dates */}

          <text
            x={left}
            y={
              priceHeight -
              7
            }
            fill="currentColor"
            className="text-[10px] text-zinc-600"
          >
            {chartDate(
              firstBar?.time
            )}
          </text>

          <text
            x={
              left +
              pricePlotWidth /
                2
            }
            y={
              priceHeight -
              7
            }
            textAnchor="middle"
            fill="currentColor"
            className="text-[10px] text-zinc-600"
          >
            {chartDate(
              middleBar?.time
            )}
          </text>

          <text
            x={pricePlotRight}
            y={
              priceHeight -
              7
            }
            textAnchor="end"
            fill="currentColor"
            className="text-[10px] text-zinc-600"
          >
            {chartDate(
              lastBar?.time
            )}
          </text>
        </svg>
      </div>

      {/* RSI */}

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            RSI (14)
          </div>

          <div className="text-[9px] font-mono text-zinc-500">
            Latest{" "}
            <span className="text-violet-300">
              {latestRsi !==
              null
                ? latestRsi.toFixed(
                    1
                  )
                : "—"}
            </span>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${rsiHeight}`}
          className="w-full"
        >
          {[30, 50, 70].map((level) => (
            <g key={level}>
              <line
                x1={left}
                x2={
                  width -
                  right
                }
                y1={rsiY(level)}
                y2={rsiY(level)}
                stroke="currentColor"
                className="text-zinc-800"
                strokeWidth="1"
                strokeDasharray="5 5"
              />

              <text
                x="20"
                y={
                  rsiY(level) +
                  4
                }
                fill="currentColor"
                className="text-[10px] text-zinc-600"
              >
                {level}
              </text>
            </g>
          ))}

          <polyline
            points={rsiPoints}
            fill="none"
            stroke="currentColor"
            className="text-violet-400"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* MACD */}

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            MACD (12, 26, 9)
          </div>

          <div className="flex gap-3 text-[9px] font-mono text-zinc-500">
            <span>
              MACD{" "}
              <b className="text-blue-300">
                {latestMacd
                  ? toNumber(
                      latestMacd.macd
                    )?.toFixed(
                      3
                    )
                  : "—"}
              </b>
            </span>

            <span>
              Signal{" "}
              <b className="text-amber-300">
                {latestMacd
                  ? toNumber(
                      latestMacd.signal
                    )?.toFixed(
                      3
                    )
                  : "—"}
              </b>
            </span>

            <span>
              Histogram{" "}
              <b
                className={
                  toNumber(
                    latestMacd?.histogram
                  ) >= 0
                    ? "text-emerald-300"
                    : "text-red-300"
                }
              >
                {latestMacd
                  ? signed(
                      latestMacd.histogram
                    )
                  : "—"}
              </b>
            </span>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${macdHeight}`}
          className="w-full"
        >
          <line
            x1={left}
            x2={
              width -
              right
            }
            y1={zeroY}
            y2={zeroY}
            stroke="currentColor"
            className="text-zinc-600"
            strokeWidth="1"
          />

          {usableMacd.map((item, index) => {
            const value =
              toNumber(
                item.histogram
              ) ?? 0;

            const x =
              indicatorX(
                index,
                usableMacd.length
              ) -
              histogramBarWidth /
                2;

            const barY =
              value >= 0
                ? macdY(value)
                : zeroY;

            const barHeight =
              Math.max(
                1,
                Math.abs(
                  macdY(value) -
                    zeroY
                )
              );

            return (
              <rect
                key={`${item.begins_at}-${index}`}
                x={x}
                y={barY}
                width={histogramBarWidth}
                height={barHeight}
                fill="currentColor"
                className={
                  value >= 0
                    ? "text-emerald-500/40"
                    : "text-red-500/40"
                }
              />
            );
          })}

          <polyline
            points={macdPoints}
            fill="none"
            stroke="currentColor"
            className="text-blue-400"
            strokeWidth="2.4"
          />

          <polyline
            points={signalPoints}
            fill="none"
            stroke="currentColor"
            className="text-amber-400"
            strokeWidth="2"
          />
        </svg>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 px-3 py-2 text-[9px] leading-relaxed text-zinc-500">
        Swing levels are derived from recent daily price pivots. Options levels
        show open-interest and gamma concentration, not guaranteed support or
        resistance. Labels are visually spaced while their horizontal lines
        remain fixed at the actual price levels.
      </div>
    </div>
  );
}

/* =========================================================
   PAYOFF CHART
========================================================= */

function PayoffChart({
  strategy,
  economics,
  spot,
}) {
  const series = useMemo(
    () =>
      buildPayoffSeries(
        strategy,
        economics,
        spot
      ),
    [strategy, economics, spot]
  );

  if (!economics || !series.length) return null;

  const width = 900;
  const height = 260;

  const paddingLeft = 58;
  const paddingRight = 28;
  const paddingTop = 24;
  const paddingBottom = 42;

  const chartWidth =
    width -
    paddingLeft -
    paddingRight;

  const chartHeight =
    height -
    paddingTop -
    paddingBottom;

  const prices = series.map((point) => point.price);
  const pls = series.map((point) => point.pl);

  const xMin = Math.min(...prices);
  const xMax = Math.max(...prices);

  let yMin = Math.min(...pls, 0);
  let yMax = Math.max(...pls, 0);

  const ySpan = Math.max(
    yMax - yMin,
    100
  );

  yMin -= ySpan * 0.12;
  yMax += ySpan * 0.12;

  const x = (price) =>
    paddingLeft +
    ((price - xMin) /
      (xMax - xMin)) *
      chartWidth;

  const y = (pl) =>
    paddingTop +
    (1 -
      (pl - yMin) /
        (yMax - yMin)) *
      chartHeight;

  const zeroY = y(0);

  const breakevenX =
    economics.breakeven !== null
      ? x(economics.breakeven)
      : null;

  const spotX =
    spot !== null &&
    spot !== undefined
      ? x(
          clamp(
            spot,
            xMin,
            xMax
          )
        )
      : null;

  const points = series
    .map(
      (point) =>
        `${x(point.price)},${y(point.pl)}`
    )
    .join(" ");

  const samplePrices = [
    series[0]?.price,

    economics.longLeg.contract.strike,

    economics.breakeven,

    economics.shortLeg.contract.strike,

    series[
      series.length -
        1
    ]?.price,
  ]
    .filter(
      (value) =>
        value !== null &&
        value !== undefined
    )
    .filter(
      (value, index, array) =>
        array.findIndex(
          (item) =>
            Math.abs(item - value) <
            0.01
        ) === index
    )
    .sort((a, b) => a - b);

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-widest text-zinc-500">
          Expiration P/L
        </div>

        <div className="text-[9px] font-mono text-zinc-500">
          Spot{" "}
          <span className="text-zinc-200">
            {money(spot)}
          </span>

          {" · "}

          Breakeven{" "}
          <span className="text-amber-300">
            {money(economics.breakeven)}
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
        >
          <line
            x1={paddingLeft}
            x2={
              width -
              paddingRight
            }
            y1={zeroY}
            y2={zeroY}
            stroke="currentColor"
            className="text-zinc-600"
            strokeDasharray="5 5"
          />

          {breakevenX !== null && (
            <line
              x1={breakevenX}
              x2={breakevenX}
              y1={paddingTop}
              y2={
                height -
                paddingBottom
              }
              stroke="currentColor"
              className="text-amber-400"
              strokeDasharray="4 4"
            />
          )}

          {spotX !== null && (
            <line
              x1={spotX}
              x2={spotX}
              y1={paddingTop}
              y2={
                height -
                paddingBottom
              }
              stroke="currentColor"
              className="text-sky-400"
              strokeDasharray="3 5"
            />
          )}

          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            className="text-emerald-400"
            strokeWidth="3"
          />
        </svg>
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="px-3 py-2 text-left">
                Stock at expiration
              </th>

              <th className="px-3 py-2 text-right">
                Spread P/L
              </th>

              <th className="px-3 py-2 text-right">
                Return on risk
              </th>
            </tr>
          </thead>

          <tbody>
            {samplePrices.map((price) => {
              const pl = spreadPLAtExpiration(
                strategy,
                economics,
                price
              );

              const returnOnRisk =
                pl !== null &&
                economics.maxLoss > 0
                  ? (
                      pl /
                      economics.maxLoss
                    ) * 100
                  : null;

              return (
                <tr
                  key={price}
                  className="border-b border-zinc-900"
                >
                  <td className="px-3 py-2">
                    {money(price)}
                  </td>

                  <td
                    className={`px-3 py-2 text-right ${
                      pl > 0
                        ? "text-emerald-300"
                        : pl < 0
                          ? "text-red-300"
                          : ""
                    }`}
                  >
                    {signedDollar(
                      pl,
                      0
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    {returnOnRisk !== null
                      ? `${
                          returnOnRisk >= 0
                            ? "+"
                            : ""
                        }${returnOnRisk.toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =========================================================
   SCENARIO CALCULATOR
========================================================= */

function ScenarioCalculator({
  strategy,
  economics,
  spot,
}) {
  const [
    scenarioPrice,
    setScenarioPrice,
  ] = useState(
    spot ?? 0
  );

  const [
    daysForward,
    setDaysForward,
  ] = useState(0);

  const [
    ivChange,
    setIvChange,
  ] = useState(0);

  useEffect(() => {
    setScenarioPrice(
      Number(
        spot || 0
      )
    );

    setDaysForward(0);
    setIvChange(0);
  }, [
    spot,

    economics?.longLeg?.contract?.id,
    economics?.shortLeg?.contract?.id,
  ]);

  if (!economics) return null;

  const result = calculateGreekScenario({
    economics,
    spot,
    scenarioPrice,
    days: daysForward,
    ivPoints: ivChange,
  });

  if (!result) return null;

  const expirationPL = spreadPLAtExpiration(
    strategy,
    economics,
    result.targetPrice
  );

  const quickScenarios = [
    {
      label: "-5%",
      price: spot * 0.95,
    },

    {
      label: "-2%",
      price: spot * 0.98,
    },

    {
      label: "Spot",
      price: spot,
    },

    {
      label: "+2%",
      price: spot * 1.02,
    },

    {
      label: "+5%",
      price: spot * 1.05,
    },
  ];

  return (
    <div className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/[0.025] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-sky-400">
            Scenario calculator
          </div>

          <div className="mt-1 text-sm font-bold">
            Hypothetical spread response
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setScenarioPrice(spot);
            setDaysForward(0);
            setIvChange(0);
          }}
          className="rounded border border-zinc-700 px-2.5 py-1 text-[9px] text-zinc-400"
        >
          RESET
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {quickScenarios.map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={() =>
              setScenarioPrice(
                Number(
                  item.price.toFixed(2)
                )
              )
            }
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-mono text-zinc-400"
          >
            {item.label} {money(item.price)}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="rounded-lg border border-zinc-800 p-3">
          <div className="text-[9px] uppercase text-zinc-500">
            Scenario Stock Price
          </div>

          <input
            type="number"
            step="0.01"
            value={scenarioPrice}
            onChange={(event) =>
              setScenarioPrice(
                event.target.value
              )
            }
            className="mt-2 w-full bg-transparent font-mono text-sm outline-none"
          />
        </label>

        <label className="rounded-lg border border-zinc-800 p-3">
          <div className="text-[9px] uppercase text-zinc-500">
            Days Forward
          </div>

          <input
            type="number"
            min="0"
            value={daysForward}
            onChange={(event) =>
              setDaysForward(
                event.target.value
              )
            }
            className="mt-2 w-full bg-transparent font-mono text-sm outline-none"
          />
        </label>

        <label className="rounded-lg border border-zinc-800 p-3">
          <div className="text-[9px] uppercase text-zinc-500">
            IV Change
          </div>

          <input
            type="number"
            step="0.5"
            value={ivChange}
            onChange={(event) =>
              setIvChange(
                event.target.value
              )
            }
            className="mt-2 w-full bg-transparent font-mono text-sm outline-none"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-4">
        <MetricBox
          label="Est. Spread Value"
          value={money(result.estimatedSpreadValue)}
          valueClass="text-sky-300"
        />

        <MetricBox
          label="Approx. P/L"
          value={signedDollar(
            result.estimatedPL,
            0
          )}
          valueClass={
            result.estimatedPL > 0
              ? "text-emerald-300"
              : result.estimatedPL < 0
                ? "text-red-300"
                : "text-zinc-200"
          }
        />

        <MetricBox
          label="Approx. Return on Risk"
          value={
            result.estimatedReturn !== null
              ? `${
                  result.estimatedReturn >= 0
                    ? "+"
                    : ""
                }${result.estimatedReturn.toFixed(1)}%`
              : "—"
          }
        />

        <MetricBox
          label="Approx. Net Delta"
          value={signed(result.estimatedDelta)}
        />
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-4">
        <MetricBox
          label="Delta"
          value={signedDollar(
            result.deltaComponent * 100,
            0
          )}
        />

        <MetricBox
          label="Gamma"
          value={signedDollar(
            result.gammaComponent * 100,
            0
          )}
        />

        <MetricBox
          label="Theta"
          value={signedDollar(
            result.thetaComponent * 100,
            0
          )}
        />

        <MetricBox
          label="Vega"
          value={signedDollar(
            result.vegaComponent * 100,
            0
          )}
        />
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 p-3">
        <div className="text-[9px] uppercase text-zinc-500">
          If stock expires at scenario price
        </div>

        <div className="mt-2 font-mono">
          {money(result.targetPrice)} →{" "}
          <span
            className={
              expirationPL > 0
                ? "text-emerald-300"
                : "text-red-300"
            }
          >
            {signedDollar(
              expirationPL,
              0
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   SCENARIO MATRIX
========================================================= */

function ScenarioMatrix({
  economics,
  spot,
}) {
  const [
    daysForward,
    setDaysForward,
  ] = useState(0);

  if (
    !economics ||
    spot === null ||
    spot === undefined
  ) {
    return null;
  }

  const stockMoves = [
    -5,
    -2,
    0,
    2,
    5,
  ];

  const ivChanges = [
    -5,
    0,
    5,
  ];

  const dayChoices = [
    0,
    1,
    3,
    5,
  ];

  return (
    <div className="mt-5 rounded-xl border border-violet-500/20 bg-violet-500/[0.025] p-4">
      <div className="flex justify-between">
        <div>
          <div className="text-[9px] uppercase text-violet-400">
            Scenario matrix
          </div>

          <div className="mt-1 text-sm font-bold">
            Price × IV sensitivity
          </div>
        </div>

        <div className="flex gap-2">
          {dayChoices.map((days) => (
            <button
              key={days}
              onClick={() =>
                setDaysForward(days)
              }
              className={`rounded border px-2.5 py-1 text-[10px] ${
                daysForward === days
                  ? "border-violet-400 text-violet-300"
                  : "border-zinc-700 text-zinc-500"
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[650px] text-[10px] font-mono">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="px-3 py-2 text-left">
                Stock move
              </th>

              {ivChanges.map((iv) => (
                <th
                  key={iv}
                  className="px-3 py-2 text-center"
                >
                  IV{" "}
                  {iv >= 0 ? "+" : ""}
                  {iv} pts
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {stockMoves.map((stockMove) => {
              const scenarioPrice =
                spot *
                (
                  1 +
                  stockMove /
                    100
                );

              return (
                <tr
                  key={stockMove}
                  className="border-b border-zinc-900"
                >
                  <td className="px-3 py-3">
                    <b>
                      {stockMove > 0
                        ? "+"
                        : ""}
                      {stockMove}%
                    </b>

                    <div className="text-[9px] text-zinc-600">
                      {money(scenarioPrice)}
                    </div>
                  </td>

                  {ivChanges.map((iv) => {
                    const result =
                      calculateGreekScenario({
                        economics,
                        spot,
                        scenarioPrice,

                        days: daysForward,

                        ivPoints: iv,
                      });

                    const pl =
                      result?.estimatedPL;

                    return (
                      <td
                        key={`${stockMove}-${iv}`}
                        className={`px-3 py-3 text-center ${
                          pl > 25
                            ? "bg-emerald-500/10 text-emerald-300"
                            : pl < -25
                              ? "bg-red-500/10 text-red-300"
                              : ""
                        }`}
                      >
                        <b>
                          {signedDollar(
                            pl,
                            0
                          )}
                        </b>

                        <div className="text-[9px]">
                          {result?.estimatedReturn !== null
                            ? `${result.estimatedReturn.toFixed(
                                1
                              )}% risk`
                            : "—"}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =========================================================
   STRATEGY PANEL
========================================================= */

function StrategyPanel({
  analysis,
  expiration,
  spot,
}) {
  const strategy = analysis.strategy;

  const economics =
    calculateSpreadEconomics(strategy);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex justify-between">
        <div>
          <div className="text-[9px] uppercase text-zinc-500">
            Strategy structure to research
          </div>

          <div className="mt-1 text-lg font-bold">
            {strategy.name}
          </div>

          <div
            className={`mt-1 text-xs ${
              strategy.bias === "Bullish"
                ? "text-emerald-300"
                : strategy.bias === "Bearish"
                  ? "text-red-300"
                  : "text-zinc-400"
            }`}
          >
            {strategy.bias} bias
          </div>
        </div>

        <div className="h-fit rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400">
          {dateLabel(expiration)}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-zinc-300">
        {strategy.description}
      </p>

      {strategy.legs.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {strategy.legs.map((leg, index) => {
            const spreadPct =
              legSpreadPercent(
                leg.contract
              );

            return (
              <div
                key={`${leg.action}-${index}`}
                className="rounded-lg border border-zinc-800 p-3"
              >
                <div className="text-[9px] uppercase text-zinc-500">
                  {leg.action}
                </div>

                <div className="mt-1 font-bold">
                  {money(
                    leg.contract.strike
                  )}
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] text-zinc-400">
                  <span>
                    Δ{" "}
                    {leg.contract.delta?.toFixed(
                      3
                    ) ?? "—"}
                  </span>

                  <span>
                    IV{" "}
                    {pct(
                      leg.contract.iv
                    )}
                  </span>

                  <span>
                    Ask{" "}
                    {money(
                      leg.contract.ask
                    )}
                  </span>

                  <span>
                    Bid{" "}
                    {money(
                      leg.contract.bid
                    )}
                  </span>

                  <span>
                    Vol{" "}
                    {compact(
                      leg.contract.volume
                    )}
                  </span>

                  <span>
                    OI{" "}
                    {compact(
                      leg.contract.openInterest
                    )}
                  </span>

                  <span className="col-span-3">
                    Bid/ask width:{" "}
                    {spreadPct !== null
                      ? `${spreadPct.toFixed(1)}% of mark`
                      : "—"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {economics && (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MetricBox
              label="Est. Net Debit"
              value={money(
                economics.entryDebit
              )}
              valueClass="text-amber-300"
            />

            <MetricBox
              label="Midpoint Debit"
              value={money(
                economics.midpointDebit
              )}
            />

            <MetricBox
              label="Spread Width"
              value={money(
                economics.width
              )}
            />

            <MetricBox
              label="Breakeven"
              value={money(
                economics.breakeven
              )}
            />

            <MetricBox
              label="Max Loss"
              value={dollar(
                economics.maxLoss
              )}
              valueClass="text-red-300"
            />

            <MetricBox
              label="Max Profit"
              value={dollar(
                economics.maxProfit
              )}
              valueClass="text-emerald-300"
            />

            <MetricBox
              label="Reward / Risk"
              value={
                economics.rewardRisk !== null
                  ? `${economics.rewardRisk.toFixed(2)}×`
                  : "—"
              }
            />

            <MetricBox
              label="Net Delta"
              value={signed(
                economics.netDelta
              )}
            />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MetricBox
              label="Delta"
              value={signed(
                economics.netDelta
              )}
            />

            <MetricBox
              label="Gamma"
              value={signed(
                economics.netGamma,
                4
              )}
            />

            <MetricBox
              label="Theta"
              value={signed(
                economics.netTheta
              )}
            />

            <MetricBox
              label="Vega"
              value={signed(
                economics.netVega
              )}
            />
          </div>

          <PayoffChart
            strategy={strategy}
            economics={economics}
            spot={spot}
          />

          <ScenarioCalculator
            strategy={strategy}
            economics={economics}
            spot={spot}
          />

          <ScenarioMatrix
            economics={economics}
            spot={spot}
          />

          <div className="mt-4">
            <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
              Contract quality
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <MetricBox
                label="Long Leg"
                value={`Vol ${compact(
                  economics.longLeg.contract.volume
                )} · OI ${compact(
                  economics.longLeg.contract.openInterest
                )}`}
                subtext={
                  economics.longSpreadPct !== null
                    ? `Bid/ask width ${economics.longSpreadPct.toFixed(
                        1
                      )}%`
                    : "—"
                }
              />

              <MetricBox
                label="Short Leg"
                value={`Vol ${compact(
                  economics.shortLeg.contract.volume
                )} · OI ${compact(
                  economics.shortLeg.contract.openInterest
                )}`}
                subtext={
                  economics.shortSpreadPct !== null
                    ? `Bid/ask width ${economics.shortSpreadPct.toFixed(
                        1
                      )}%`
                    : "—"
                }
              />
            </div>

            <div
              className={`mt-2 rounded-lg border px-3 py-2 ${
                economics.warnings.length > 0
                  ? "border-amber-500/30 bg-amber-500/[0.05]"
                  : "border-emerald-500/20 bg-emerald-500/[0.03]"
              }`}
            >
              <div
                className={`text-[9px] uppercase tracking-widest ${
                  economics.warnings.length > 0
                    ? "text-amber-400"
                    : "text-emerald-400"
                }`}
              >
                Liquidity check
              </div>

              {economics.warnings.length > 0 ? (
                <ul className="mt-1 space-y-1 text-[10px] text-zinc-300">
                  {economics.warnings.map(
                    (
                      warning,
                      index
                    ) => (
                      <li key={index}>
                        • {warning}
                      </li>
                    )
                  )}
                </ul>
              ) : (
                <div className="mt-1 text-[10px] text-zinc-400">
                  No obvious liquidity warning in the selected legs.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-4 rounded-lg border border-amber-500/20 p-3">
        <div className="text-[9px] uppercase text-amber-400">
          Invalidation
        </div>

        <div className="mt-1 text-[10px]">
          {strategy.invalidation}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   TABLE CELL
========================================================= */

function Cell({ value }) {
  return (
    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[10px]">
      {value}
    </td>
  );
}

/* =========================================================
   MAIN MODAL
========================================================= */

export default function TickerDetailModal({
  data,
  onClose,
}) {
  const [
    expirations,
    setExpirations,
  ] = useState([]);

  const [
    expiration,
    setExpiration,
  ] = useState(
    data?.expiration || ""
  );

  const [
    strikeRange,
    setStrikeRange,
  ] = useState(5);

  const [
    allInstruments,
    setAllInstruments,
  ] = useState([]);

  const [
    instruments,
    setInstruments,
  ] = useState([]);

  const [
    quotes,
    setQuotes,
  ] = useState([]);

  const [
    fullChainQuotes,
    setFullChainQuotes,
  ] = useState([]);

  const [
    instrumentLoading,
    setInstrumentLoading,
  ] = useState(true);

  const [
    visibleLoading,
    setVisibleLoading,
  ] = useState(true);

  const [
    fullChainLoading,
    setFullChainLoading,
  ] = useState(false);

  const [
    fullChainProgress,
    setFullChainProgress,
  ] = useState({
    completed: 0,
    total: 0,
  });

  const [
    error,
    setError,
  ] = useState("");

  const [
    fullChainError,
    setFullChainError,
  ] = useState("");

  /* EXPIRATIONS */

  useEffect(() => {
    if (!data?.ticker) return;

    let cancelled = false;

    async function load() {
      try {
        const payload = await callRobinhood(
          "get_option_chains",
          {
            underlying_symbol: data.ticker,
          }
        );

        if (cancelled) return;

        const dates = getExpirations(payload);

        setExpirations(dates);

        setExpiration(
          data.expiration &&
            dates.includes(
              data.expiration
            )
            ? data.expiration
            : nearestExpiration(
                dates
              ) || ""
        );
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    data?.ticker,
    data?.expiration,
  ]);

  /* ALL INSTRUMENTS */

  useEffect(() => {
    if (
      !data?.ticker ||
      !expiration
    ) {
      return;
    }

    let cancelled = false;

    async function load() {
      setInstrumentLoading(true);
      setVisibleLoading(true);

      setError("");
      setFullChainError("");

      setAllInstruments([]);
      setInstruments([]);
      setQuotes([]);
      setFullChainQuotes([]);

      setFullChainProgress({
        completed: 0,
        total: 0,
      });

      try {
        const loaded =
          await fetchAllInstruments(
            data.ticker,
            expiration
          );

        if (!cancelled) {
          setAllInstruments(
            loaded
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setInstrumentLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    data?.ticker,
    expiration,
  ]);

  /* VISIBLE STRIKES */

  useEffect(() => {
    if (instrumentLoading) return;

    if (!allInstruments.length) {
      setInstruments([]);
      setQuotes([]);
      setVisibleLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setVisibleLoading(true);

      try {
        const visible =
          getVisibleInstruments(
            allInstruments,
            data.price,
            strikeRange
          );

        setInstruments(
          visible
        );

        const optionQuotes =
          await fetchOptionQuotes(
            visible.map(
              (instrument) =>
                instrument.id
            )
          );

        if (!cancelled) {
          setQuotes(
            optionQuotes
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setVisibleLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    allInstruments,
    instrumentLoading,
    data.price,
    strikeRange,
  ]);

  /* FULL CHAIN */

  useEffect(() => {
    if (
      instrumentLoading ||
      !allInstruments.length
    ) {
      return;
    }

    let cancelled = false;

    async function load() {
      setFullChainLoading(true);
      setFullChainError("");

      setFullChainProgress({
        completed: 0,
        total: allInstruments.length,
      });

      try {
        const result =
          await fetchOptionQuotesProgressive(
            allInstruments.map(
              (instrument) =>
                instrument.id
            ),

            {
              onProgress: ({
                completed,
                total,
              }) => {
                if (!cancelled) {
                  setFullChainProgress({
                    completed,
                    total,
                  });
                }
              },
            }
          );

        if (!cancelled) {
          setFullChainQuotes(
            result
          );
        }
      } catch (err) {
        if (!cancelled) {
          setFullChainError(
            err.message
          );
        }
      } finally {
        if (!cancelled) {
          setFullChainLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    allInstruments,
    instrumentLoading,
  ]);

  const {
    rows,
    atmStrike,
  } = useMemo(
    () =>
      buildChainRows(
        instruments,
        quotes,
        data.price,
        strikeRange
      ),
    [
      instruments,
      quotes,
      data.price,
      strikeRange,
    ]
  );

  const analysis = useMemo(
    () =>
      analyzeSetup(
        data,
        rows,
        atmStrike
      ),
    [
      data,
      rows,
      atmStrike,
    ]
  );

  const fullChainAnalysis = useMemo(
    () =>
      buildFullChainAnalysis(
        allInstruments,
        fullChainQuotes,
        data.price
      ),
    [
      allInstruments,
      fullChainQuotes,
      data.price,
    ]
  );

  const loading =
    instrumentLoading ||
    visibleLoading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[95vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(event) =>
          event.stopPropagation()
        }
      >
        {/* HEADER */}

        <div className="border-b border-zinc-800 px-5 py-4">
          <div className="flex justify-between">
            <div>
              <div className="flex items-baseline gap-3">
                <h2 className="text-3xl font-black">
                  {data.ticker}
                </h2>

                <span className="text-xl">
                  {money(
                    data.price
                  )}
                </span>

                <span
                  className={
                    data.changePct >= 0
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  {data.changePct >= 0
                    ? "+"
                    : ""}
                  {data.changePct?.toFixed(
                    2
                  )}
                  %
                </span>
              </div>

              <div className="mt-2 flex gap-2 text-[10px]">
                <span className="rounded border border-zinc-700 px-2 py-1">
                  RSI{" "}
                  {data.rsi?.toFixed(
                    2
                  )}
                </span>

                <span className="rounded border border-zinc-700 px-2 py-1">
                  MACD{" "}
                  {data.macd?.histogram?.toFixed(
                    3
                  )}
                </span>

                <span className="rounded border border-zinc-700 px-2 py-1">
                  ATM IV{" "}
                  {pct(
                    analysis.atmIV
                  )}
                </span>
              </div>
            </div>

            <button
              onClick={onClose}
              className="text-3xl text-zinc-500 hover:text-white"
            >
              ×
            </button>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs text-zinc-500">
              Expiration
            </span>

            <select
              value={expiration}
              onChange={(event) =>
                setExpiration(
                  event.target.value
                )
              }
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs"
            >
              {expirations.map((date) => (
                <option
                  key={date}
                  value={date}
                >
                  {dateLabel(date)}
                </option>
              ))}
            </select>

            <span className="ml-2 text-xs text-zinc-500">
              Strike range
            </span>

            {[5, 10].map((range) => (
              <button
                key={range}
                onClick={() =>
                  setStrikeRange(
                    range
                  )
                }
                className={`rounded border px-3 py-2 text-xs ${
                  strikeRange === range
                    ? "border-amber-400 bg-amber-400/10 text-amber-300"
                    : "border-zinc-700 text-zinc-400"
                }`}
              >
                ±{range}
              </button>
            ))}

            <span className="ml-auto text-[9px] uppercase tracking-widest text-zinc-600">
              Read-only market data
            </span>
          </div>
        </div>

        {/* BODY */}

        <div className="overflow-auto p-4">
          {loading && (
            <div className="py-20 text-center text-zinc-400">
              Loading option chain...
            </div>
          )}

          {!loading && error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-4 text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-600">
                Near-ATM analysis · visible strike window
              </div>

              <div className="mb-4 grid gap-3 lg:grid-cols-4">
                <AnalysisStat
                  label="Momentum"
                  value={analysis.momentum}
                  valueClass={
                    analysis.momentumTextClass
                  }
                  subtext={`RSI ${data.rsi?.toFixed(
                    1
                  )} · MACD hist ${data.macd?.histogram?.toFixed(
                    3
                  )}`}
                />

                <AnalysisStat
                  label="Near-ATM Options Flow"
                  value={analysis.flowLabel}
                  valueClass={
                    analysis.flowClass
                  }
                  subtext={`P/C volume ${ratioText(
                    analysis.pcrVolume
                  )} · P/C OI ${ratioText(
                    analysis.pcrOI
                  )}`}
                />

                <AnalysisStat
                  label="Near-ATM Gamma"
                  value={money(
                    analysis.gammaLeader?.strike
                  )}
                  subtext={
                    analysis.gammaLeader
                      ? `${analysis.gammaLeader.type.toUpperCase()} Γ ${analysis.gammaLeader.gamma.toFixed(
                          4
                        )}`
                      : "—"
                  }
                />

                <AnalysisStat
                  label="Theta Hotspot"
                  value={money(
                    analysis.thetaLeader?.strike
                  )}
                  subtext={
                    analysis.thetaLeader
                      ? `${analysis.thetaLeader.type.toUpperCase()} Θ ${analysis.thetaLeader.theta.toFixed(
                          3
                        )}`
                      : "—"
                  }
                />
              </div>

              <FullChainFlowPanel
                analysis={fullChainAnalysis}
                loading={fullChainLoading}
                error={fullChainError}
                progress={fullChainProgress}
                expiration={expiration}
              />

              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <AnalysisStat
                  label="Lower Reference"
                  value={money(
                    analysis.lowerReference
                  )}
                />

                <AnalysisStat
                  label="ATM Strike"
                  value={money(
                    atmStrike
                  )}
                  valueClass="text-amber-300"
                />

                <AnalysisStat
                  label="Upper Reference"
                  value={money(
                    analysis.upperReference
                  )}
                />
              </div>

              <HistoricalTechnicalChart
                ticker={data.ticker}
                spot={data.price}
                fullChainAnalysis={
                  fullChainAnalysis
                }
              />

              <StrategyPanel
                analysis={analysis}
                expiration={expiration}
                spot={data.price}
              />

              <ExpirationComparison
                data={data}
                expirations={expirations}
                selectedExpiration={
                  expiration
                }
                bias={
                  analysis.strategy.bias
                }
                onSelectExpiration={
                  setExpiration
                }
              />

              <div className="my-4 flex flex-wrap gap-4 text-[10px] text-zinc-500">
                <span>
                  Expiration{" "}
                  <b className="text-zinc-200">
                    {dateLabel(
                      expiration
                    )}
                  </b>
                </span>

                <span>
                  ATM{" "}
                  <b className="text-amber-300">
                    {money(
                      atmStrike
                    )}
                  </b>
                </span>

                <span>
                  Visible call vol{" "}
                  <b className="text-emerald-300">
                    {compact(
                      analysis.callVolume
                    )}
                  </b>
                </span>

                <span>
                  Visible put vol{" "}
                  <b className="text-red-300">
                    {compact(
                      analysis.putVolume
                    )}
                  </b>
                </span>

                {fullChainAnalysis && (
                  <span>
                    Full-chain contracts{" "}
                    <b className="text-cyan-300">
                      {
                        fullChainAnalysis.quotedContractCount
                      }
                    </b>
                  </span>
                )}
              </div>

              {/* OPTION CHAIN */}

              <div className="overflow-x-auto rounded-xl border border-zinc-800">
                <table className="min-w-[1400px] w-full border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-700 bg-zinc-900">
                      <th
                        colSpan={9}
                        className="py-2 text-center text-xs text-emerald-300"
                      >
                        CALLS
                      </th>

                      <th className="border-x border-zinc-700 text-amber-300">
                        STRIKE
                      </th>

                      <th
                        colSpan={9}
                        className="py-2 text-center text-xs text-red-300"
                      >
                        PUTS
                      </th>
                    </tr>

                    <tr className="text-[9px] text-zinc-500">
                      <th>Bid</th>
                      <th>Ask</th>
                      <th>Mark</th>
                      <th>IV</th>
                      <th>Δ</th>
                      <th>Γ</th>
                      <th>Θ</th>
                      <th>Vega</th>
                      <th>Vol/OI</th>

                      <th className="border-x border-zinc-700">
                        Strike
                      </th>

                      <th>Bid</th>
                      <th>Ask</th>
                      <th>Mark</th>
                      <th>IV</th>
                      <th>Δ</th>
                      <th>Γ</th>
                      <th>Θ</th>
                      <th>Vega</th>
                      <th>Vol/OI</th>
                    </tr>
                  </thead>

                  <tbody>
                    {rows.map((row) => {
                      const call = row.call;
                      const put = row.put;

                      const atm =
                        row.strike ===
                        atmStrike;

                      return (
                        <tr
                          key={row.strike}
                          className={
                            atm
                              ? "bg-amber-400/[0.07]"
                              : "border-t border-zinc-900"
                          }
                        >
                          <Cell value={call?.bid?.toFixed(2) ?? "—"} />
                          <Cell value={call?.ask?.toFixed(2) ?? "—"} />
                          <Cell value={call?.mark?.toFixed(2) ?? "—"} />
                          <Cell value={pct(call?.iv)} />
                          <Cell value={call?.delta?.toFixed(3) ?? "—"} />
                          <Cell value={call?.gamma?.toFixed(4) ?? "—"} />
                          <Cell value={call?.theta?.toFixed(3) ?? "—"} />
                          <Cell value={call?.vega?.toFixed(3) ?? "—"} />
                          <Cell
                            value={
                              call
                                ? `${compact(
                                    call.volume
                                  )}/${compact(
                                    call.openInterest
                                  )}`
                                : "—"
                            }
                          />

                          <td
                            className={`border-x border-zinc-700 px-3 py-2 text-center text-xs font-bold ${
                              atm
                                ? "text-amber-300"
                                : "text-white"
                            }`}
                          >
                            {money(
                              row.strike
                            )}
                          </td>

                          <Cell value={put?.bid?.toFixed(2) ?? "—"} />
                          <Cell value={put?.ask?.toFixed(2) ?? "—"} />
                          <Cell value={put?.mark?.toFixed(2) ?? "—"} />
                          <Cell value={pct(put?.iv)} />
                          <Cell value={put?.delta?.toFixed(3) ?? "—"} />
                          <Cell value={put?.gamma?.toFixed(4) ?? "—"} />
                          <Cell value={put?.theta?.toFixed(3) ?? "—"} />
                          <Cell value={put?.vega?.toFixed(3) ?? "—"} />
                          <Cell
                            value={
                              put
                                ? `${compact(
                                    put.volume
                                  )}/${compact(
                                    put.openInterest
                                  )}`
                                : "—"
                            }
                          />
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}