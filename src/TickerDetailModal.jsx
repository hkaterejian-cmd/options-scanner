import { useEffect, useMemo, useState } from "react";
import ExpirationComparison from "./ExpirationComparison";

const PROXY_BASE = "http://127.0.0.1:3001";

/* =========================================================
   BASIC HELPERS
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
  const n = distancePct(level, spot);

  if (n === null) return "—";

  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}% from spot`;
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

async function persistScannerStateSection(
  section,
  body
) {
  return fetchJson(
    `${PROXY_BASE}/scanner/state/${section}`,
    {
      method:
        "PUT",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify(
          body
        ),
    }
  );
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

function buildNormalizedContracts(instruments, quotes) {
  if (!instruments.length || !quotes.length) return [];

  const quoteMap = createQuoteMap(quotes);

  return instruments
    .map((instrument) => normalizeContract(instrument, quoteMap))
    .filter(Boolean)
    .filter((contract) => contract.strike !== null)
    .sort((a, b) => a.strike - b.strike);
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
   VISIBLE CHAIN
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
  const contracts = buildNormalizedContracts(instruments, quotes);

  if (!contracts.length) return null;

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
      Math.abs(contract.gamma ?? 0) *
      contract.openInterest;

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
        (a, b) =>
          b.gammaOIProxy -
          a.gammaOIProxy
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
    ? [...lowerRows].sort(
        (a, b) =>
          b.totalOI -
          a.totalOI
      )[0]
    : null;

  const upperOIConcentration = upperRows.length
    ? [...upperRows].sort(
        (a, b) =>
          b.totalOI -
          a.totalOI
      )[0]
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
    (contract) =>
      contract &&
      contract.delta !== null
  );

  if (!usable.length) return null;

  return [...usable].sort((a, b) => {
    const da = absolute
      ? Math.abs(a.delta)
      : a.delta;

    const db = absolute
      ? Math.abs(b.delta)
      : b.delta;

    return (
      Math.abs(da - target) -
      Math.abs(db - target)
    );
  })[0];
}

function analyzeSetup(data, rows, atmStrike) {
  const calls = rows.map((row) => row.call).filter(Boolean);
  const puts = rows.map((row) => row.put).filter(Boolean);

  const callVolume = calls.reduce(
    (total, contract) =>
      total +
      (contract.volume || 0),
    0
  );

  const putVolume = puts.reduce(
    (total, contract) =>
      total +
      (contract.volume || 0),
    0
  );

  const callOI = calls.reduce(
    (total, contract) =>
      total +
      (contract.openInterest || 0),
    0
  );

  const putOI = puts.reduce(
    (total, contract) =>
      total +
      (contract.openInterest || 0),
    0
  );

  const pcrVolume =
    callVolume > 0
      ? putVolume / callVolume
      : null;

  const pcrOI =
    callOI > 0
      ? putOI / callOI
      : null;

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

  if (
    bullishScore >= 2 &&
    bullishScore > bearishScore
  ) {
    momentum = "Bullish";
    momentumTextClass = "text-emerald-300";
  }

  if (
    bearishScore >= 2 &&
    bearishScore > bullishScore
  ) {
    momentum = "Bearish";
    momentumTextClass = "text-red-300";
  }

  const allContracts = [
    ...calls,
    ...puts,
  ];

  const gammaLeader =
    allContracts
      .filter(
        (contract) =>
          contract.gamma !== null
      )
      .sort(
        (a, b) =>
          Math.abs(b.gamma) -
          Math.abs(a.gamma)
      )[0] ??
    null;

  const thetaLeader =
    allContracts
      .filter(
        (contract) =>
          contract.theta !== null
      )
      .sort(
        (a, b) =>
          Math.abs(b.theta) -
          Math.abs(a.theta)
      )[0] ??
    null;

  const atmRow =
    rows.find(
      (row) =>
        row.strike === atmStrike
    );

  const atmIvs = [
    atmRow?.call?.iv,
    atmRow?.put?.iv,
  ].filter(
    (value) =>
      value !== null &&
      value !== undefined
  );

  const atmIV = atmIvs.length
    ? atmIvs.reduce(
        (total, value) =>
          total + value,
        0
      ) /
      atmIvs.length
    : data.atmIV;

  const lowerRows =
    rows.filter(
      (row) =>
        row.strike < data.price
    );

  const upperRows =
    rows.filter(
      (row) =>
        row.strike > data.price
    );

  const lowerReference =
    lowerRows.length
      ? lowerRows[
          lowerRows.length - 1
        ].strike
      : null;

  const upperReference =
    upperRows.length
      ? upperRows[0].strike
      : null;

  const flow =
    flowDescriptor(
      pcrVolume
    );

  let strategy = {
    name:
      "No clear directional structure",

    bias:
      "Neutral",

    description:
      "The directional signals are not sufficiently aligned for the rule-based spread engine.",

    legs: [],

    invalidation:
      "Wait for stronger agreement between RSI, MACD and price direction.",
  };

  if (momentum === "Bullish") {
    const longCall =
      closestByDelta(
        calls,
        0.55
      );

    const higherCalls =
      calls.filter(
        (contract) =>
          longCall &&
          contract.strike >
            longCall.strike
      );

    const shortCall =
      closestByDelta(
        higherCalls,
        0.3
      );

    strategy = {
      name:
        "Bull Call Debit Spread",

      bias:
        "Bullish",

      description:
        "The rule engine found positive momentum alignment. The defined-risk debit spread reduces premium and theta exposure relative to the long call alone.",

      legs:
        longCall &&
        shortCall
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
    const longPut =
      closestByDelta(
        puts,
        0.55,
        true
      );

    const lowerPuts =
      puts.filter(
        (contract) =>
          longPut &&
          contract.strike <
            longPut.strike
      );

    const shortPut =
      closestByDelta(
        lowerPuts,
        0.3,
        true
      );

    strategy = {
      name:
        "Bear Put Debit Spread",

      bias:
        "Bearish",

      description:
        "The rule engine found negative momentum alignment. The defined-risk debit spread reduces premium and theta exposure relative to the long put alone.",

      legs:
        longPut &&
        shortPut
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

    flowLabel:
      flow.label,

    flowClass:
      flow.className,

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

  const bid =
    toNumber(contract.bid);

  const ask =
    toNumber(contract.ask);

  const mark =
    toNumber(contract.mark);

  if (
    bid === null ||
    ask === null ||
    mark === null ||
    mark <= 0
  ) {
    return null;
  }

  return (
    ((ask - bid) / mark) *
    100
  );
}

function calculateSpreadEconomics(strategy) {
  if (
    !strategy ||
    strategy.legs?.length !== 2
  ) {
    return null;
  }

  const longLeg =
    strategy.legs.find(
      (leg) =>
        leg.side === "long"
    );

  const shortLeg =
    strategy.legs.find(
      (leg) =>
        leg.side === "short"
    );

  if (!longLeg || !shortLeg) return null;

  const longContract =
    longLeg.contract;

  const shortContract =
    shortLeg.contract;

  const width =
    Math.abs(
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

  const longSpreadPct =
    legSpreadPercent(
      longContract
    );

  const shortSpreadPct =
    legSpreadPercent(
      shortContract
    );

  const warnings = [];

  function checkLeg(
    label,
    contract,
    spreadPct
  ) {
    if (contract.bid === 0) {
      warnings.push(
        `${label}: no active bid shown`
      );
    }

    if (
      spreadPct !== null &&
      spreadPct >= 15
    ) {
      warnings.push(
        `${label}: wide bid/ask (${spreadPct.toFixed(
          1
        )}% of mark)`
      );
    }

    if (
      contract.openInterest <
      100
    ) {
      warnings.push(
        `${label}: low open interest (${compact(
          contract.openInterest
        )})`
      );
    }

    if (
      contract.volume <
      20
    ) {
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
   EXPIRATION PAYOFF
========================================================= */

function spreadPLAtExpiration(
  strategy,
  economics,
  stockPrice
) {
  if (
    !economics ||
    stockPrice === null ||
    stockPrice === undefined
  ) {
    return null;
  }

  const longContract =
    economics.longLeg.contract;

  const shortContract =
    economics.shortLeg.contract;

  const debit =
    economics.entryDebit;

  if (
    debit === null ||
    debit <= 0
  ) {
    return null;
  }

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

  return (
    intrinsic -
    debit
  ) * 100;
}

function buildPayoffSeries(
  strategy,
  economics,
  currentSpot
) {
  if (
    !economics ||
    currentSpot === null ||
    currentSpot === undefined
  ) {
    return [];
  }

  const longStrike =
    economics.longLeg.contract.strike;

  const shortStrike =
    economics.shortLeg.contract.strike;

  const lowStrike =
    Math.min(
      longStrike,
      shortStrike
    );

  const highStrike =
    Math.max(
      longStrike,
      shortStrike
    );

  const spreadWidth =
    Math.abs(
      highStrike -
      lowStrike
    );

  const margin =
    Math.max(
      spreadWidth * 1.5,
      currentSpot * 0.04,
      5
    );

  const minPrice =
    Math.max(
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

  for (
    let i = 0;
    i <= 60;
    i++
  ) {
    const price =
      minPrice +
      ((maxPrice - minPrice) * i) /
        60;

    series.push({
      price,

      pl:
        spreadPLAtExpiration(
          strategy,
          economics,
          price
        ),
    });
  }

  return series;
}

/* =========================================================
   GREEK SCENARIO
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

  const forwardDays =
    Math.max(
      0,
      toNumber(days) ?? 0
    );

  const volatilityPoints =
    toNumber(ivPoints) ?? 0;

  const priceMove =
    targetPrice -
    spot;

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

function ContractCard({
  title,
  contract,
  accentClass,
}) {
  if (!contract) return null;

  const spreadPct =
    legSpreadPercent(contract);

  return (
    <div className="rounded-lg border border-zinc-800 bg-black/25 p-3">
      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
        {title}
      </div>

      <div
        className={`mt-1 text-lg font-mono font-bold ${accentClass}`}
      >
        {money(contract.strike)}{" "}
        {contract.type.toUpperCase()}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-zinc-400 sm:grid-cols-4">
        <span>
          Bid{" "}
          <b className="text-zinc-200">
            {money(contract.bid)}
          </b>
        </span>

        <span>
          Ask{" "}
          <b className="text-zinc-200">
            {money(contract.ask)}
          </b>
        </span>

        <span>
          Mark{" "}
          <b className="text-zinc-200">
            {money(contract.mark)}
          </b>
        </span>

        <span>
          IV{" "}
          <b className="text-zinc-200">
            {pct(contract.iv)}
          </b>
        </span>

        <span>
          Δ{" "}
          <b className="text-zinc-200">
            {signed(contract.delta)}
          </b>
        </span>

        <span>
          Γ{" "}
          <b className="text-zinc-200">
            {signed(contract.gamma, 4)}
          </b>
        </span>

        <span>
          Θ{" "}
          <b className="text-zinc-200">
            {signed(contract.theta)}
          </b>
        </span>

        <span>
          Vega{" "}
          <b className="text-zinc-200">
            {signed(contract.vega)}
          </b>
        </span>

        <span>
          Volume{" "}
          <b className="text-zinc-200">
            {compact(contract.volume)}
          </b>
        </span>

        <span>
          OI{" "}
          <b className="text-zinc-200">
            {compact(contract.openInterest)}
          </b>
        </span>

        <span className="col-span-2">
          Bid/ask width{" "}
          <b className="text-zinc-200">
            {spreadPct !== null
              ? `${spreadPct.toFixed(1)}%`
              : "—"}
          </b>
        </span>
      </div>
    </div>
  );
}

/* =========================================================
   FULL CHAIN FLOW PANEL
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

            <div className="mt-1 text-sm font-bold">
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

  const volumeFlow =
    flowDescriptor(
      analysis.pcrVolume
    );

  const oiFlow =
    flowDescriptor(
      analysis.pcrOI
    );

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
          value={compact(
            analysis.callVolume
          )}
          valueClass="text-emerald-300"
          subtext={`${analysis.callCount} quoted call contracts`}
        />

        <MetricBox
          label="Total Put Volume"
          value={compact(
            analysis.putVolume
          )}
          valueClass="text-red-300"
          subtext={`${analysis.putCount} quoted put contracts`}
        />

        <MetricBox
          label="P/C Volume Ratio"
          value={ratioText(
            analysis.pcrVolume
          )}
          valueClass={
            volumeFlow.className
          }
          subtext={
            volumeFlow.label
          }
        />

        <MetricBox
          label="Total Call OI"
          value={compact(
            analysis.callOI
          )}
          valueClass="text-emerald-300"
        />

        <MetricBox
          label="Total Put OI"
          value={compact(
            analysis.putOI
          )}
          valueClass="text-red-300"
        />

        <MetricBox
          label="P/C OI Ratio"
          value={ratioText(
            analysis.pcrOI
          )}
          valueClass={
            oiFlow.className
          }
          subtext={
            oiFlow.label
          }
        />
      </div>

      <div className="mt-4 text-[9px] uppercase tracking-widest text-zinc-500">
        Volume concentrations
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <MetricBox
          label="Highest-Volume Call"
          value={money(
            analysis.highestCallVolume?.strike
          )}
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
          value={money(
            analysis.highestPutVolume?.strike
          )}
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
          value={money(
            analysis.callOIWall?.strike
          )}
          valueClass="text-emerald-300"
          subtext={
            analysis.callOIWall
              ? `OI ${compact(
                  analysis.callOIWall.openInterest
                )}`
              : "—"
          }
        />

        <MetricBox
          label="Put OI Wall"
          value={money(
            analysis.putOIWall?.strike
          )}
          valueClass="text-red-300"
          subtext={
            analysis.putOIWall
              ? `OI ${compact(
                  analysis.putOIWall.openInterest
                )}`
              : "—"
          }
        />

        <MetricBox
          label="Lower OI Concentration"
          value={money(
            analysis.lowerOIConcentration?.strike
          )}
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
          value={money(
            analysis.upperOIConcentration?.strike
          )}
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
            {money(
              analysis.gammaConcentration?.strike
            )}
          </div>

          <div className="text-[10px] text-zinc-500">
            |Γ| × OI proxy{" "}
            {analysis.gammaConcentration
              ? compact(
                  analysis.gammaConcentration.gammaOIProxy
                )
              : "—"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[9px] text-zinc-500">
        Volume and open interest show concentration, not whether contracts
        were bought or sold. Gamma is an |gamma| × open-interest proxy, not
        dealer positioning.
      </div>
    </div>
  );
}

/* =========================================================
   HISTORICAL TECHNICAL CHART
========================================================= */

function HistoricalTechnicalChart({
  ticker,
  spot,
  fullChainAnalysis,
}) {
  const [
    rangeDays,
    setRangeDays,
  ] = useState(90);

  const [
    showStructure,
    setShowStructure,
  ] = useState(true);

  const [
    showOptions,
    setShowOptions,
  ] = useState(true);

  const [
    bars,
    setBars,
  ] = useState([]);

  const [
    rsiSeries,
    setRsiSeries,
  ] = useState([]);

  const [
    macdSeries,
    setMacdSeries,
  ] = useState([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  useEffect(() => {
    if (!ticker) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const end = new Date();
        const start = new Date();

        start.setDate(
          start.getDate() -
            (rangeDays + 90)
        );

        const common = {
          start_time:
            start.toISOString(),

          end_time:
            end.toISOString(),

          interval:
            "day",

          bounds:
            "regular",

          adjustment_type:
            "split",
        };

        const [
          historicalPayload,
          rsiPayload,
          macdPayload,
        ] =
          await Promise.all([
            callRobinhood(
              "get_equity_historicals",
              {
                symbols: [
                  ticker,
                ],

                ...common,
              }
            ),

            callRobinhood(
              "get_equity_technical_indicators",
              {
                symbol:
                  ticker,

                type:
                  "rsi",

                ...common,

                output:
                  "series",

                period: 14,
              }
            ),

            callRobinhood(
              "get_equity_technical_indicators",
              {
                symbol:
                  ticker,

                type:
                  "macd",

                ...common,

                output:
                  "series",

                fast_period: 12,
                slow_period: 26,
                signal_period: 9,
              }
            ),
          ]);

        if (cancelled) return;

        const loadedBars =
          extractHistoricalBars(
            historicalPayload
          );

        const loadedRsi =
          extractIndicatorSeries(
            rsiPayload,
            "rsi"
          );

        const loadedMacd =
          extractIndicatorSeries(
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
            loadedRsi.map(
              (item) => ({
                ...item,
                time:
                  item.begins_at,
              })
            ),
            rangeDays
          )
        );

        setMacdSeries(
          filterByCalendarDays(
            loadedMacd.map(
              (item) => ({
                ...item,
                time:
                  item.begins_at,
              })
            ),
            rangeDays
          )
        );
      } catch (err) {
        if (!cancelled) {
          setError(
            err.message
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(
            false
          );
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    ticker,
    rangeDays,
  ]);

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

  const high20 =
    highestHigh(
      bars,
      20
    );

  const low20 =
    lowestLow(
      bars,
      20
    );

  const high50 =
    highestHigh(
      bars,
      50
    );

  const low50 =
    lowestLow(
      bars,
      50
    );

  const recentSwingHigh =
    findRecentSwingHigh(
      bars,
      2
    );

  const recentSwingLow =
    findRecentSwingLow(
      bars,
      2
    );

  const callWall =
    fullChainAnalysis
      ?.callOIWall
      ?.strike ??
    null;

  const putWall =
    fullChainAnalysis
      ?.putOIWall
      ?.strike ??
    null;

  const gammaLevel =
    fullChainAnalysis
      ?.gammaConcentration
      ?.strike ??
    null;

  const width = 1100;

  const priceHeight = 330;
  const rsiHeight = 145;
  const macdHeight = 165;

  const left = 62;
  const right = 18;

  const top = 18;
  const bottom = 30;

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
      Math.abs(
        value - spot
      ) /
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

  const rawPriceLow =
    Math.min(
      ...rangeLevels
    );

  const rawPriceHigh =
    Math.max(
      ...rangeLevels
    );

  const pricePadding =
    Math.max(
      (
        rawPriceHigh -
        rawPriceLow
      ) * 0.07,
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

  const pricePoints =
    bars
      .map(
        (
          bar,
          index
        ) =>
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

  const periodHigh =
    Math.max(
      ...bars.map(
        (bar) =>
          bar.high ??
          bar.close
      )
    );

  const periodLow =
    Math.min(
      ...bars.map(
        (bar) =>
          bar.low ??
          bar.close
      )
    );

  const overlayDefinitions = [];

  if (
    spot !== null &&
    spot !== undefined
  ) {
    overlayDefinitions.push({
      id: "spot",
      level: spot,
      label: "Spot",
      className:
        "text-yellow-400",
      dash: "7 5",
    });
  }

  if (showStructure) {
    if (high20 !== null) {
      overlayDefinitions.push({
        id: "20-high",
        level: high20,
        label: "20D High",
        className:
          "text-cyan-400",
        dash: "6 5",
      });
    }

    if (low20 !== null) {
      overlayDefinitions.push({
        id: "20-low",
        level: low20,
        label: "20D Low",
        className:
          "text-cyan-400",
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
        id:
          "swing-high",

        level:
          recentSwingHigh.price,

        label:
          "Swing High",

        className:
          "text-amber-400",

        dash:
          "3 6",
      });
    }

    if (
      recentSwingLow?.price !==
        null &&
      recentSwingLow?.price !==
        undefined
    ) {
      overlayDefinitions.push({
        id:
          "swing-low",

        level:
          recentSwingLow.price,

        label:
          "Swing Low",

        className:
          "text-amber-400",

        dash:
          "3 6",
      });
    }
  }

  if (showOptions) {
    if (
      callWall !== null &&
      callWall !== undefined
    ) {
      overlayDefinitions.push({
        id:
          "call-wall",

        level:
          callWall,

        label:
          "Call OI Wall",

        className:
          "text-emerald-400",

        dash:
          "10 5",
      });
    }

    if (
      putWall !== null &&
      putWall !== undefined
    ) {
      overlayDefinitions.push({
        id:
          "put-wall",

        level:
          putWall,

        label:
          "Put OI Wall",

        className:
          "text-red-400",

        dash:
          "10 5",
      });
    }

    if (
      gammaLevel !== null &&
      gammaLevel !== undefined
    ) {
      overlayDefinitions.push({
        id:
          "gamma",

        level:
          gammaLevel,

        label:
          "Gamma",

        className:
          "text-violet-400",

        dash:
          "2 5",
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

  const usableRsi =
    rsiSeries.filter(
      (item) =>
        toNumber(
          item.value
        ) !== null
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

  let macdMin =
    Math.min(
      ...macdValues,
      0
    );

  let macdMax =
    Math.max(
      ...macdValues,
      0
    );

  const macdSpan =
    Math.max(
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
    usableMacd.length > 0
      ? Math.max(
          2,
          (
            indicatorWidth /
            usableMacd.length
          ) *
            0.65
        )
      : 2;

  const firstBar =
    bars[0];

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

          <div className="mt-1 text-sm font-bold">
            {ticker} price + momentum + structure
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Daily regular-session data · RSI(14) · MACD(12,26,9)
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {[
            {
              label:
                "1M",

              days:
                30,
            },

            {
              label:
                "3M",

              days:
                90,
            },

            {
              label:
                "6M",

              days:
                180,
            },
          ].map(
            (item) => (
              <button
                type="button"
                key={
                  item.days
                }
                onClick={() =>
                  setRangeDays(
                    item.days
                  )
                }
                className={`rounded border px-2.5 py-1 text-[10px] ${
                  rangeDays ===
                  item.days
                    ? "border-blue-400 bg-blue-400/10 text-blue-300"
                    : "border-zinc-700 text-zinc-500"
                }`}
              >
                {item.label}
              </button>
            )
          )}

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
                ? "border-cyan-400 text-cyan-300"
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
                ? "border-violet-400 text-violet-300"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            Options Levels
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-5">
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
            periodChange > 0
              ? "text-emerald-300"
              : periodChange < 0
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

      <div className="mt-4">
        <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
          Price structure
        </div>

        <div className="grid gap-2 lg:grid-cols-3">
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
              recentSwingHigh?.price
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
                : "—"
            }
          />

          <MetricBox
            label="Recent Swing Low"
            value={money(
              recentSwingLow?.price
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
                : "—"
            }
          />
        </div>
      </div>

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

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
          Daily closing price
        </div>

        <svg
          viewBox={`0 0 ${width} ${priceHeight}`}
          className="w-full"
        >
          <line
            x1={
              pricePlotRight +
              8
            }
            x2={
              pricePlotRight +
              8
            }
            y1={
              top
            }
            y2={
              priceHeight -
              bottom
            }
            stroke="currentColor"
            className="text-zinc-800"
            strokeDasharray="3 5"
          />

          {[0.25, 0.5, 0.75].map(
            (fraction) => {
              const y =
                top +
                pricePlotHeight *
                  fraction;

              return (
                <line
                  key={
                    fraction
                  }
                  x1={
                    left
                  }
                  x2={
                    pricePlotRight
                  }
                  y1={
                    y
                  }
                  y2={
                    y
                  }
                  stroke="currentColor"
                  className="text-zinc-800"
                />
              );
            }
          )}

          {overlayLayout.map(
            (item) => (
              <g
                key={
                  item.id
                }
                className={
                  item.className
                }
              >
                <line
                  x1={
                    left
                  }
                  x2={
                    pricePlotRight
                  }
                  y1={
                    item.actualY
                  }
                  y2={
                    item.actualY
                  }
                  stroke="currentColor"
                  strokeDasharray={
                    item.dash
                  }
                />

                <line
                  x1={
                    pricePlotRight
                  }
                  x2={
                    pricePlotRight +
                    13
                  }
                  y1={
                    item.actualY
                  }
                  y2={
                    item.labelY
                  }
                  stroke="currentColor"
                />

                <circle
                  cx={
                    pricePlotRight +
                    13
                  }
                  cy={
                    item.labelY
                  }
                  r="2"
                  fill="currentColor"
                />

                <text
                  x={
                    pricePlotRight +
                    20
                  }
                  y={
                    item.labelY +
                    4
                  }
                  fill="currentColor"
                  className="text-[10px]"
                >
                  {item.label}{" "}
                  <tspan fontWeight="700">
                    {money(
                      item.level
                    )}
                  </tspan>
                </text>
              </g>
            )
          )}

          <polyline
            points={
              pricePoints
            }
            fill="none"
            stroke="currentColor"
            className="text-blue-400"
            strokeWidth="3"
          />

          <text
            x="4"
            y={
              top +
              5
            }
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            {money(
              priceMax
            )}
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
            {money(
              priceMin
            )}
          </text>

          <text
            x={
              left
            }
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
            x={
              pricePlotRight
            }
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

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 flex justify-between">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            RSI (14)
          </div>

          <div className="text-[9px] font-mono">
            Latest{" "}
            <span className="text-violet-300">
              {latestRsi !== null
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
          {[30, 50, 70].map(
            (level) => (
              <g
                key={
                  level
                }
              >
                <line
                  x1={
                    left
                  }
                  x2={
                    width -
                    right
                  }
                  y1={
                    rsiY(
                      level
                    )
                  }
                  y2={
                    rsiY(
                      level
                    )
                  }
                  stroke="currentColor"
                  className="text-zinc-800"
                  strokeDasharray="5 5"
                />

                <text
                  x="20"
                  y={
                    rsiY(
                      level
                    ) +
                    4
                  }
                  fill="currentColor"
                  className="text-[10px] text-zinc-600"
                >
                  {level}
                </text>
              </g>
            )
          )}

          <polyline
            points={
              rsiPoints
            }
            fill="none"
            stroke="currentColor"
            className="text-violet-400"
            strokeWidth="2.5"
          />
        </svg>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/25 p-3">
        <div className="mb-2 flex flex-wrap justify-between gap-2">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            MACD (12, 26, 9)
          </div>

          <div className="flex gap-3 text-[9px] font-mono">
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
            x1={
              left
            }
            x2={
              width -
              right
            }
            y1={
              zeroY
            }
            y2={
              zeroY
            }
            stroke="currentColor"
            className="text-zinc-600"
          />

          {usableMacd.map(
            (
              item,
              index
            ) => {
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
                  ? macdY(
                      value
                    )
                  : zeroY;

              const barHeight =
                Math.max(
                  1,
                  Math.abs(
                    macdY(
                      value
                    ) -
                      zeroY
                  )
                );

              return (
                <rect
                  key={`${item.begins_at}-${index}`}
                  x={
                    x
                  }
                  y={
                    barY
                  }
                  width={
                    histogramBarWidth
                  }
                  height={
                    barHeight
                  }
                  fill="currentColor"
                  className={
                    value >= 0
                      ? "text-emerald-500/40"
                      : "text-red-500/40"
                  }
                />
              );
            }
          )}

          <polyline
            points={
              macdPoints
            }
            fill="none"
            stroke="currentColor"
            className="text-blue-400"
            strokeWidth="2.4"
          />

          <polyline
            points={
              signalPoints
            }
            fill="none"
            stroke="currentColor"
            className="text-amber-400"
            strokeWidth="2"
          />
        </svg>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 px-3 py-2 text-[9px] text-zinc-500">
        Swing levels are derived from recent daily price pivots. Options
        levels show concentration rather than guaranteed support or
        resistance.
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
  const series =
    useMemo(
      () =>
        buildPayoffSeries(
          strategy,
          economics,
          spot
        ),
      [
        strategy,
        economics,
        spot,
      ]
    );

  if (
    !economics ||
    !series.length
  ) {
    return null;
  }

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

  const prices =
    series.map(
      (point) =>
        point.price
    );

  const pls =
    series.map(
      (point) =>
        point.pl
    );

  const xMin =
    Math.min(
      ...prices
    );

  const xMax =
    Math.max(
      ...prices
    );

  let yMin =
    Math.min(
      ...pls,
      0
    );

  let yMax =
    Math.max(
      ...pls,
      0
    );

  const ySpan =
    Math.max(
      yMax -
        yMin,
      100
    );

  yMin -=
    ySpan *
    0.12;

  yMax +=
    ySpan *
    0.12;

  const x =
    (price) =>
      paddingLeft +
      (
        (
          price -
          xMin
        ) /
        (
          xMax -
          xMin
        )
      ) *
        chartWidth;

  const y =
    (pl) =>
      paddingTop +
      (
        1 -
        (
          pl -
          yMin
        ) /
          (
            yMax -
            yMin
          )
      ) *
        chartHeight;

  const zeroY =
    y(0);

  const breakevenX =
    economics.breakeven !==
    null
      ? x(
          economics.breakeven
        )
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

  const points =
    series
      .map(
        (point) =>
          `${x(
            point.price
          )},${y(
            point.pl
          )}`
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
      (
        value,
        index,
        array
      ) =>
        array.findIndex(
          (item) =>
            Math.abs(
              item -
                value
            ) <
            0.01
        ) ===
        index
    )
    .sort(
      (a, b) =>
        a - b
    );

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[9px] uppercase tracking-widest text-zinc-500">
          Expiration P/L
        </div>

        <div className="text-[9px] font-mono text-zinc-500">
          Spot{" "}
          <span className="text-zinc-200">
            {money(
              spot
            )}
          </span>

          {" · "}

          Breakeven{" "}
          <span className="text-amber-300">
            {money(
              economics.breakeven
            )}
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
        >
          <line
            x1={
              paddingLeft
            }
            x2={
              width -
              paddingRight
            }
            y1={
              zeroY
            }
            y2={
              zeroY
            }
            stroke="currentColor"
            className="text-zinc-600"
            strokeDasharray="5 5"
          />

          {breakevenX !== null && (
            <line
              x1={
                breakevenX
              }
              x2={
                breakevenX
              }
              y1={
                paddingTop
              }
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
              x1={
                spotX
              }
              x2={
                spotX
              }
              y1={
                paddingTop
              }
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
            points={
              points
            }
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
            {samplePrices.map(
              (price) => {
                const pl =
                  spreadPLAtExpiration(
                    strategy,
                    economics,
                    price
                  );

                const returnOnRisk =
                  pl !== null &&
                  economics.maxLoss >
                    0
                    ? (
                        pl /
                        economics.maxLoss
                      ) * 100
                    : null;

                return (
                  <tr
                    key={
                      price
                    }
                    className="border-b border-zinc-900"
                  >
                    <td className="px-3 py-2">
                      {money(
                        price
                      )}
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
                      {returnOnRisk !==
                      null
                        ? `${
                            returnOnRisk >=
                            0
                              ? "+"
                              : ""
                          }${returnOnRisk.toFixed(
                            1
                          )}%`
                        : "—"}
                    </td>
                  </tr>
                );
              }
            )}
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

  const result =
    calculateGreekScenario({
      economics,

      spot,

      scenarioPrice,

      days:
        daysForward,

      ivPoints:
        ivChange,
    });

  if (!result) return null;

  const expirationPL =
    spreadPLAtExpiration(
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
            setScenarioPrice(
              spot
            );

            setDaysForward(
              0
            );

            setIvChange(
              0
            );
          }}
          className="rounded border border-zinc-700 px-2.5 py-1 text-[9px] text-zinc-400"
        >
          RESET
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {quickScenarios.map(
          (item) => (
            <button
              type="button"
              key={
                item.label
              }
              onClick={() =>
                setScenarioPrice(
                  Number(
                    item.price.toFixed(
                      2
                    )
                  )
                )
              }
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-mono text-zinc-400"
            >
              {item.label}{" "}
              {money(
                item.price
              )}
            </button>
          )
        )}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="rounded-lg border border-zinc-800 p-3">
          <div className="text-[9px] uppercase text-zinc-500">
            Scenario Stock Price
          </div>

          <input
            type="number"
            step="0.01"
            value={
              scenarioPrice
            }
            onChange={(
              event
            ) =>
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
            step="1"
            value={
              daysForward
            }
            onChange={(
              event
            ) =>
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
            value={
              ivChange
            }
            onChange={(
              event
            ) =>
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
          value={money(
            result.estimatedSpreadValue
          )}
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
            result.estimatedReturn !==
            null
              ? `${
                  result.estimatedReturn >=
                  0
                    ? "+"
                    : ""
                }${result.estimatedReturn.toFixed(
                  1
                )}%`
              : "—"
          }
        />

        <MetricBox
          label="Approx. Net Delta"
          value={signed(
            result.estimatedDelta
          )}
        />
      </div>

      <div className="mt-4 grid gap-2 lg:grid-cols-4">
        <MetricBox
          label="Delta"
          value={signedDollar(
            result.deltaComponent *
              100,
            0
          )}
        />

        <MetricBox
          label="Gamma"
          value={signedDollar(
            result.gammaComponent *
              100,
            0
          )}
        />

        <MetricBox
          label="Theta"
          value={signedDollar(
            result.thetaComponent *
              100,
            0
          )}
        />

        <MetricBox
          label="Vega"
          value={signedDollar(
            result.vegaComponent *
              100,
            0
          )}
        />
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 p-3">
        <div className="text-[9px] uppercase text-zinc-500">
          If stock expires at scenario price
        </div>

        <div className="mt-2 font-mono">
          {money(
            result.targetPrice
          )}{" "}
          →{" "}
          <span
            className={
              expirationPL > 0
                ? "text-emerald-300"
                : expirationPL < 0
                  ? "text-red-300"
                  : "text-zinc-300"
            }
          >
            {signedDollar(
              expirationPL,
              0
            )}
          </span>
        </div>
      </div>

      <div className="mt-3 text-[9px] text-zinc-600">
        Greek scenario values are local approximations and become less
        reliable as price, time, or implied volatility move farther from
        current conditions.
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-violet-400">
            Scenario matrix
          </div>

          <div className="mt-1 text-sm font-bold">
            Price × IV sensitivity
          </div>
        </div>

        <div className="flex gap-2">
          {dayChoices.map(
            (days) => (
              <button
                key={
                  days
                }
                type="button"
                onClick={() =>
                  setDaysForward(
                    days
                  )
                }
                className={`rounded border px-2.5 py-1 text-[10px] ${
                  daysForward === days
                    ? "border-violet-400 bg-violet-400/10 text-violet-300"
                    : "border-zinc-700 text-zinc-500"
                }`}
              >
                {days}d
              </button>
            )
          )}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[650px] text-[10px] font-mono">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="px-3 py-2 text-left">
                Stock move
              </th>

              {ivChanges.map(
                (iv) => (
                  <th
                    key={
                      iv
                    }
                    className="px-3 py-2 text-center"
                  >
                    IV{" "}
                    {iv >= 0
                      ? "+"
                      : ""}
                    {iv} pts
                  </th>
                )
              )}
            </tr>
          </thead>

          <tbody>
            {stockMoves.map(
              (
                stockMove
              ) => {
                const scenarioPrice =
                  spot *
                  (
                    1 +
                    stockMove /
                      100
                  );

                return (
                  <tr
                    key={
                      stockMove
                    }
                    className="border-b border-zinc-900"
                  >
                    <td className="px-3 py-3">
                      <b>
                        {stockMove >
                        0
                          ? "+"
                          : ""}
                        {stockMove}%
                      </b>

                      <div className="text-[9px] text-zinc-600">
                        {money(
                          scenarioPrice
                        )}
                      </div>
                    </td>

                    {ivChanges.map(
                      (iv) => {
                        const result =
                          calculateGreekScenario({
                            economics,
                            spot,
                            scenarioPrice,

                            days:
                              daysForward,

                            ivPoints:
                              iv,
                          });

                        const pl =
                          result?.estimatedPL;

                        const returnOnRisk =
                          result?.estimatedReturn;

                        return (
                          <td
                            key={`${stockMove}-${iv}`}
                            className={`px-3 py-3 text-center ${
                              pl > 25
                                ? "bg-emerald-500/10 text-emerald-300"
                                : pl < -25
                                  ? "bg-red-500/10 text-red-300"
                                  : "text-zinc-300"
                            }`}
                          >
                            <b>
                              {signedDollar(
                                pl,
                                0
                              )}
                            </b>

                            <div className="mt-1 text-[9px] opacity-70">
                              {returnOnRisk !==
                              null &&
                              returnOnRisk !==
                              undefined
                                ? `${
                                    returnOnRisk >=
                                    0
                                      ? "+"
                                      : ""
                                  }${returnOnRisk.toFixed(
                                    1
                                  )}% risk`
                                : "—"}
                            </div>
                          </td>
                        );
                      }
                    )}
                  </tr>
                );
              }
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =========================================================
   AUTOMATIC STRATEGY PANEL
========================================================= */

function StrategyPanel({
  analysis,
  expiration,
  spot,
}) {
  const strategy =
    analysis.strategy;

  const economics =
    calculateSpreadEconomics(
      strategy
    );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Automatic strategy structure
          </div>

          <div className="mt-1 text-lg font-bold">
            {strategy.name}
          </div>

          <div
            className={`mt-1 text-xs ${
              strategy.bias ===
              "Bullish"
                ? "text-emerald-300"
                : strategy.bias ===
                    "Bearish"
                  ? "text-red-300"
                  : "text-zinc-400"
            }`}
          >
            {strategy.bias} bias
          </div>
        </div>

        <div className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400">
          {dateLabel(
            expiration
          )}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-zinc-300">
        {strategy.description}
      </p>

      {strategy.legs.length >
        0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {strategy.legs.map(
            (
              leg,
              index
            ) => (
              <ContractCard
                key={`${leg.action}-${index}`}
                title={
                  leg.action
                }
                contract={
                  leg.contract
                }
                accentClass={
                  leg.side ===
                  "long"
                    ? "text-sky-300"
                    : "text-amber-300"
                }
              />
            )
          )}
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
              subtext="Long ask − short bid"
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
              value={
                economics.maxProfit !==
                  null &&
                economics.maxProfit >=
                  0
                  ? dollar(
                      economics.maxProfit
                    )
                  : "—"
              }
              valueClass="text-emerald-300"
            />

            <MetricBox
              label="Reward / Risk"
              value={
                economics.rewardRisk !==
                null
                  ? `${economics.rewardRisk.toFixed(
                      2
                    )}×`
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
            strategy={
              strategy
            }
            economics={
              economics
            }
            spot={
              spot
            }
          />

          <ScenarioCalculator
            strategy={
              strategy
            }
            economics={
              economics
            }
            spot={
              spot
            }
          />

          <ScenarioMatrix
            economics={
              economics
            }
            spot={
              spot
            }
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
                  economics.longSpreadPct !==
                  null
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
                  economics.shortSpreadPct !==
                  null
                    ? `Bid/ask width ${economics.shortSpreadPct.toFixed(
                        1
                      )}%`
                    : "—"
                }
              />
            </div>
          </div>
        </>
      )}

      <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
        <div className="text-[9px] uppercase tracking-widest text-amber-400">
          Invalidation
        </div>

        <div className="mt-1 text-[10px]">
          {strategy.invalidation}
        </div>
      </div>
    </div>
  );
}

function SavedStrategyPlansPanel({
  ticker,
  expiration,
  optionType,
  longContract,
  shortContract,
  economics,
  spot,
  marketContext,
  fullChainAnalysis,
  contracts,
  onLoadPlan,
}) {
  const STORAGE_KEY =
    "optionsScannerSavedStrategyPlansV1";

  const [
    savedPlans,
    setSavedPlans,
  ] = useState(() => {
    if (
      typeof window ===
      "undefined"
    ) {
      return [];
    }

    try {
      const raw =
        window.localStorage.getItem(
          STORAGE_KEY
        );

      if (!raw) {
        return [];
      }

      const parsed =
        JSON.parse(raw);

      return Array.isArray(
        parsed
      )
        ? parsed
        : [];
    } catch {
      return [];
    }
  });

  const [
    notes,
    setNotes,
  ] = useState("");

  const [
    invalidationPrice,
    setInvalidationPrice,
  ] = useState("");

  const [
    midpointAlertPct,
    setMidpointAlertPct,
  ] = useState("10");

  const currentStructureKey =
    longContract &&
    shortContract
      ? `${ticker}|${expiration}|${optionType}|${longContract.strike}|${shortContract.strike}`
      : "";

  const existingPlan =
    currentStructureKey
      ? savedPlans.find(
          (plan) =>
            plan.structureKey ===
            currentStructureKey
        ) ??
        null
      : null;

  useEffect(() => {
    if (
      typeof window ===
      "undefined"
    ) {
      return;
    }

    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          savedPlans
        )
      );
    } catch {
      // Storage can fail in restrictive browser modes.
    }
  }, [
    savedPlans,
  ]);

  useEffect(() => {
    setNotes(
      existingPlan?.notes ??
      ""
    );

    setInvalidationPrice(
      existingPlan?.invalidationPrice ??
      ""
    );

    setMidpointAlertPct(
      existingPlan?.midpointAlertPct ??
      "10"
    );
  }, [
    currentStructureKey,
    existingPlan?.id,
  ]);

  const plansForTicker =
    useMemo(
      () =>
        savedPlans
          .filter(
            (plan) =>
              plan.ticker ===
              ticker
          )
          .sort(
            (a, b) =>
              new Date(
                b.updatedAt ||
                b.savedAt ||
                0
              ).getTime() -
              new Date(
                a.updatedAt ||
                a.savedAt ||
                0
              ).getTime()
          ),
      [
        savedPlans,
        ticker,
      ]
    );

  function saveCurrentPlan() {
    if (
      !longContract ||
      !shortContract ||
      !economics
    ) {
      return;
    }

    const now =
      new Date().toISOString();

    const plan = {
      id:
        existingPlan?.id ??
        (
          typeof crypto !==
            "undefined" &&
          typeof crypto.randomUUID ===
            "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${ticker}`
        ),

      structureKey:
        currentStructureKey,

      ticker,
      expiration,
      optionType,

      longStrike:
        longContract.strike,

      shortStrike:
        shortContract.strike,

      savedAt:
        existingPlan?.savedAt ??
        now,

      updatedAt:
        now,

      savedSpot:
        toNumber(
          spot
        ),

      savedEntryDebit:
        economics.entryDebit,

      savedMidpointDebit:
        economics.midpointDebit,

      width:
        economics.width,

      maxLoss:
        economics.maxLoss,

      maxProfit:
        economics.maxProfit,

      breakeven:
        economics.breakeven,

      rewardRisk:
        economics.rewardRisk,

      netDelta:
        economics.netDelta,

      netGamma:
        economics.netGamma,

      netTheta:
        economics.netTheta,

      netVega:
        economics.netVega,

      savedRsi:
        toNumber(
          marketContext?.rsi
        ),

      savedMacdHistogram:
        toNumber(
          marketContext
            ?.macd
            ?.histogram
        ),

      callOIWall:
        fullChainAnalysis
          ?.callOIWall
          ?.strike ??
        null,

      putOIWall:
        fullChainAnalysis
          ?.putOIWall
          ?.strike ??
        null,

      gammaConcentration:
        fullChainAnalysis
          ?.gammaConcentration
          ?.strike ??
        null,

      notes:
        notes.trim(),

      invalidationPrice:
        toNumber(
          invalidationPrice
        ),

      midpointAlertPct:
        Math.max(
          0,
          toNumber(
            midpointAlertPct
          ) ??
          10
        ),
    };

    const index =
      savedPlans.findIndex(
        (item) =>
          item.structureKey ===
          currentStructureKey
      );

    let nextPlans;

    if (
      index === -1
    ) {
      nextPlans = [
        plan,
        ...savedPlans,
      ];
    } else {
      nextPlans = [
        ...savedPlans,
      ];

      nextPlans[index] =
        plan;
    }

    setSavedPlans(
      nextPlans
    );

    persistScannerStateSection(
      "saved-plans",
      {
        savedPlans:
          nextPlans,
      }
    ).catch(
      (error) =>
        console.warn(
          "Saved-plan backend persistence failed:",
          error
        )
    );
  }

  function deletePlan(id) {
    const nextPlans =
      savedPlans.filter(
        (plan) =>
          plan.id !==
          id
      );

    setSavedPlans(
      nextPlans
    );

    persistScannerStateSection(
      "saved-plans",
      {
        savedPlans:
          nextPlans,
      }
    ).catch(
      (error) =>
        console.warn(
          "Saved-plan backend persistence failed:",
          error
        )
    );
  }

  function currentEconomicsForPlan(
    plan
  ) {
    if (
      plan.expiration !==
      expiration
    ) {
      return null;
    }

    const currentLong =
      contracts.find(
        (contract) =>
          contract.type ===
            plan.optionType &&
          contract.strike ===
            Number(
              plan.longStrike
            )
      );

    const currentShort =
      contracts.find(
        (contract) =>
          contract.type ===
            plan.optionType &&
          contract.strike ===
            Number(
              plan.shortStrike
            )
      );

    if (
      !currentLong ||
      !currentShort
    ) {
      return null;
    }

    const strategy = {
      name:
        "Saved plan refresh",

      bias:
        plan.optionType ===
        "call"
          ? "Bullish"
          : "Bearish",

      legs: [
        {
          action:
            `Long ${plan.optionType}`,

          side:
            "long",

          contract:
            currentLong,
        },

        {
          action:
            `Short ${plan.optionType}`,

          side:
            "short",

          contract:
            currentShort,
        },
      ],
    };

    return calculateSpreadEconomics(
      strategy
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-emerald-400">
            Saved strategy plans
          </div>

          <div className="mt-1 text-sm font-bold">
            Save this setup for later
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Plans are stored in this browser and remain after closing the modal or refreshing the screener.
          </div>
        </div>

        <div className="rounded border border-emerald-500/20 px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300">
          {plansForTicker.length} saved for {ticker}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_220px_220px]">
        <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Notes / thesis
          </div>

          <textarea
            value={
              notes
            }
            onChange={(
              event
            ) =>
              setNotes(
                event.target.value
              )
            }
            rows="3"
            placeholder="Example: Watching the $190 gamma concentration and the $200 call OI wall."
            className="mt-2 w-full resize-y rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-200 outline-none focus:border-emerald-500/40"
          />
        </label>

        <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Invalidation price
          </div>

          <input
            type="number"
            step="0.01"
            value={
              invalidationPrice
            }
            onChange={(
              event
            ) =>
              setInvalidationPrice(
                event.target.value
              )
            }
            placeholder="Optional"
            className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
          />

          <div className="mt-2 text-[9px] text-zinc-600">
            Optional reference level only.
          </div>
        </label>

        <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Midpoint alert %
          </div>

          <input
            type="number"
            min="0"
            step="1"
            value={
              midpointAlertPct
            }
            onChange={(
              event
            ) =>
              setMidpointAlertPct(
                event.target.value
              )
            }
            placeholder="10"
            className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
          />

          <div className="mt-2 text-[9px] text-zinc-600">
            Flags a spread-midpoint move of this size or more.
          </div>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={
            saveCurrentPlan
          }
          disabled={
            !economics
          }
          className={`rounded border px-4 py-2 text-[10px] font-bold ${
            economics
              ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300 hover:border-emerald-300"
              : "cursor-not-allowed border-zinc-800 text-zinc-700"
          }`}
        >
          {existingPlan
            ? "UPDATE SAVED PLAN"
            : "SAVE CURRENT PLAN"}
        </button>

        {existingPlan && (
          <div className="text-[9px] text-zinc-500">
            This exact structure already has a saved plan. Saving updates its snapshot and notes.
          </div>
        )}
      </div>

      {plansForTicker.length >
      0 ? (
        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Saved {ticker} plans
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            {plansForTicker.map(
              (plan) => {
                const currentEconomics =
                  currentEconomicsForPlan(
                    plan
                  );

                const sameExpiration =
                  plan.expiration ===
                  expiration;

                const currentMidpoint =
                  currentEconomics
                    ?.midpointDebit ??
                  null;

                const currentRsi =
                  toNumber(
                    marketContext?.rsi
                  );

                const currentMacd =
                  toNumber(
                    marketContext
                      ?.macd
                      ?.histogram
                  );

                const savedSpot =
                  toNumber(
                    plan.savedSpot
                  );

                const spotChangePct =
                  savedSpot !==
                    null &&
                  savedSpot !==
                    0 &&
                  toNumber(
                    spot
                  ) !==
                    null
                    ? (
                        (
                          Number(
                            spot
                          ) -
                          savedSpot
                        ) /
                        savedSpot
                      ) *
                      100
                    : null;

                const savedMidpoint =
                  toNumber(
                    plan.savedMidpointDebit
                  );

                const midpointChange =
                  currentMidpoint !==
                    null &&
                  savedMidpoint !==
                    null
                    ? currentMidpoint -
                      savedMidpoint
                    : null;

                const midpointChangePct =
                  midpointChange !==
                    null &&
                  savedMidpoint !==
                    null &&
                  savedMidpoint !==
                    0
                    ? (
                        midpointChange /
                        savedMidpoint
                      ) *
                      100
                    : null;

                const rsiChange =
                  currentRsi !==
                    null &&
                  toNumber(
                    plan.savedRsi
                  ) !==
                    null
                    ? currentRsi -
                      Number(
                        plan.savedRsi
                      )
                    : null;

                const macdChange =
                  currentMacd !==
                    null &&
                  toNumber(
                    plan.savedMacdHistogram
                  ) !==
                    null
                    ? currentMacd -
                      Number(
                        plan.savedMacdHistogram
                      )
                    : null;

                const currentPutWall =
                  sameExpiration
                    ? fullChainAnalysis
                        ?.putOIWall
                        ?.strike ??
                      null
                    : null;

                const currentCallWall =
                  sameExpiration
                    ? fullChainAnalysis
                        ?.callOIWall
                        ?.strike ??
                      null
                    : null;

                const currentGammaLevel =
                  sameExpiration
                    ? fullChainAnalysis
                        ?.gammaConcentration
                        ?.strike ??
                      null
                    : null;

                const breakeven =
                  toNumber(
                    plan.breakeven
                  );

                const spotVsBreakeven =
                  breakeven !==
                    null &&
                  breakeven !==
                    0 &&
                  toNumber(
                    spot
                  ) !==
                    null
                    ? (
                        (
                          Number(
                            spot
                          ) -
                          breakeven
                        ) /
                        breakeven
                      ) *
                      100
                    : null;

                const invalidation =
                  toNumber(
                    plan.invalidationPrice
                  );

                const invalidationFromSpot =
                  invalidation !==
                    null &&
                  toNumber(
                    spot
                  ) !==
                    null &&
                  Number(
                    spot
                  ) !==
                    0
                    ? (
                        (
                          invalidation -
                          Number(
                            spot
                          )
                        ) /
                        Number(
                          spot
                        )
                      ) *
                      100
                    : null;

                const savedRsiValue =
                  toNumber(
                    plan.savedRsi
                  );

                const savedMacdValue =
                  toNumber(
                    plan.savedMacdHistogram
                  );

                const currentSpotValue =
                  toNumber(
                    spot
                  );

                const midpointThreshold =
                  Math.max(
                    0,
                    toNumber(
                      plan.midpointAlertPct
                    ) ??
                    10
                  );

                const alertConditions =
                  [];

                if (
                  invalidation !==
                    null &&
                  currentSpotValue !==
                    null
                ) {
                  const invalidationCrossed =
                    plan.optionType ===
                    "call"
                      ? currentSpotValue <=
                        invalidation
                      : currentSpotValue >=
                        invalidation;

                  if (
                    invalidationCrossed
                  ) {
                    alertConditions.push({
                      label:
                        "Invalidation crossed",
                      tone:
                        "red",
                    });
                  }
                }

                if (
                  breakeven !==
                    null &&
                  currentSpotValue !==
                    null
                ) {
                  const breakevenReached =
                    plan.optionType ===
                    "call"
                      ? currentSpotValue >=
                        breakeven
                      : currentSpotValue <=
                        breakeven;

                  if (
                    breakevenReached
                  ) {
                    alertConditions.push({
                      label:
                        "Breakeven reached",
                      tone:
                        "green",
                    });
                  }
                }

                if (
                  midpointChangePct !==
                    null &&
                  Math.abs(
                    midpointChangePct
                  ) >=
                    midpointThreshold
                ) {
                  alertConditions.push({
                    label:
                      `Midpoint ${
                        midpointChangePct >=
                        0
                          ? "+"
                          : ""
                      }${midpointChangePct.toFixed(
                        1
                      )}%`,
                    tone:
                      "violet",
                  });
                }

                if (
                  savedRsiValue !==
                    null &&
                  currentRsi !==
                    null
                ) {
                  if (
                    savedRsiValue <
                      70 &&
                    currentRsi >=
                      70
                  ) {
                    alertConditions.push({
                      label:
                        "RSI crossed above 70",
                      tone:
                        "amber",
                    });
                  }

                  if (
                    savedRsiValue >
                      30 &&
                    currentRsi <=
                      30
                  ) {
                    alertConditions.push({
                      label:
                        "RSI crossed below 30",
                      tone:
                        "amber",
                    });
                  }

                  if (
                    savedRsiValue <
                      50 &&
                    currentRsi >=
                      50
                  ) {
                    alertConditions.push({
                      label:
                        "RSI crossed above 50",
                      tone:
                        "sky",
                    });
                  }

                  if (
                    savedRsiValue >
                      50 &&
                    currentRsi <=
                      50
                  ) {
                    alertConditions.push({
                      label:
                        "RSI crossed below 50",
                      tone:
                        "sky",
                    });
                  }
                }

                if (
                  savedMacdValue !==
                    null &&
                  currentMacd !==
                    null &&
                  (
                    (
                      savedMacdValue <
                        0 &&
                      currentMacd >=
                        0
                    ) ||
                    (
                      savedMacdValue >
                        0 &&
                      currentMacd <=
                        0
                    )
                  )
                ) {
                  alertConditions.push({
                    label:
                      `MACD histogram flipped ${
                        currentMacd >=
                        0
                          ? "positive"
                          : "negative"
                      }`,
                    tone:
                      "sky",
                  });
                }

                if (
                  sameExpiration
                ) {
                  if (
                    toNumber(
                      plan.putOIWall
                    ) !==
                      null &&
                    toNumber(
                      currentPutWall
                    ) !==
                      null &&
                    Number(
                      plan.putOIWall
                    ) !==
                      Number(
                        currentPutWall
                      )
                  ) {
                    alertConditions.push({
                      label:
                        `Put OI wall moved to ${money(
                          currentPutWall
                        )}`,
                      tone:
                        "amber",
                    });
                  }

                  if (
                    toNumber(
                      plan.callOIWall
                    ) !==
                      null &&
                    toNumber(
                      currentCallWall
                    ) !==
                      null &&
                    Number(
                      plan.callOIWall
                    ) !==
                      Number(
                        currentCallWall
                      )
                  ) {
                    alertConditions.push({
                      label:
                        `Call OI wall moved to ${money(
                          currentCallWall
                        )}`,
                      tone:
                        "amber",
                    });
                  }

                  if (
                    toNumber(
                      plan.gammaConcentration
                    ) !==
                      null &&
                    toNumber(
                      currentGammaLevel
                    ) !==
                      null &&
                    Number(
                      plan.gammaConcentration
                    ) !==
                      Number(
                        currentGammaLevel
                      )
                  ) {
                    alertConditions.push({
                      label:
                        `Gamma concentration moved to ${money(
                          currentGammaLevel
                        )}`,
                      tone:
                        "violet",
                    });
                  }
                }

                return (
                  <div
                    key={
                      plan.id
                    }
                    className="rounded-xl border border-zinc-800 bg-black/25 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div
                          className={`text-[9px] uppercase tracking-widest ${
                            plan.optionType ===
                            "call"
                              ? "text-emerald-400"
                              : "text-red-400"
                          }`}
                        >
                          {plan.optionType} spread · {dateLabel(
                            plan.expiration
                          )}
                        </div>

                        <div className="mt-1 font-mono text-base font-bold text-white">
                          {money(
                            plan.longStrike
                          )}
                          {" / "}
                          {money(
                            plan.shortStrike
                          )}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-600">
                          Updated{" "}
                          {new Date(
                            plan.updatedAt ||
                            plan.savedAt
                          ).toLocaleString()}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            onLoadPlan(
                              plan
                            )
                          }
                          className="rounded border border-zinc-700 px-2 py-1 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-emerald-400/40 hover:text-emerald-300"
                        >
                          Load
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            deletePlan(
                              plan.id
                            )
                          }
                          className="rounded border border-zinc-800 px-2 py-1 text-[9px] uppercase tracking-widest text-zinc-600 hover:border-red-400/40 hover:text-red-300"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <MetricBox
                        label="Saved Spot"
                        value={money(
                          plan.savedSpot
                        )}
                        subtext={`Current ${money(
                          spot
                        )}`}
                      />

                      <MetricBox
                        label="Saved Debit"
                        value={money(
                          plan.savedEntryDebit
                        )}
                        subtext={
                          sameExpiration
                            ? `Current midpoint ${money(
                                currentMidpoint
                              )}`
                            : "Load this expiration to refresh quotes"
                        }
                      />

                      <MetricBox
                        label="Breakeven"
                        value={money(
                          plan.breakeven
                        )}
                        subtext={distanceText(
                          plan.breakeven,
                          spot
                        )}
                      />

                      <MetricBox
                        label="Max Loss / Profit"
                        value={`${dollar(
                          plan.maxLoss
                        )} / ${dollar(
                          plan.maxProfit
                        )}`}
                      />

                      <MetricBox
                        label="Saved RSI"
                        value={
                          plan.savedRsi !==
                          null &&
                          plan.savedRsi !==
                          undefined
                            ? Number(
                                plan.savedRsi
                              ).toFixed(
                                1
                              )
                            : "—"
                        }
                        subtext={
                          currentRsi !==
                          null
                            ? `Current ${currentRsi.toFixed(
                                1
                              )}`
                            : "Current —"
                        }
                      />

                      <MetricBox
                        label="Saved MACD Hist"
                        value={signed(
                          plan.savedMacdHistogram
                        )}
                        subtext={
                          currentMacd !==
                          null
                            ? `Current ${signed(
                                currentMacd
                              )}`
                            : "Current —"
                        }
                      />

                      <MetricBox
                        label="Saved OI Walls"
                        value={`${money(
                          plan.putOIWall
                        )} / ${money(
                          plan.callOIWall
                        )}`}
                        subtext="Put / Call"
                      />

                      <MetricBox
                        label="Saved Gamma Level"
                        value={money(
                          plan.gammaConcentration
                        )}
                      />
                    </div>

                    <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.025] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[9px] uppercase tracking-widest text-sky-400">
                            Saved plan tracking
                          </div>

                          <div className="mt-1 text-[10px] text-zinc-500">
                            Original snapshot compared with the current market data loaded in this ticker.
                          </div>
                        </div>

                        <div
                          className={`rounded border px-2 py-1 text-[9px] uppercase tracking-widest ${
                            sameExpiration &&
                            currentEconomics
                              ? "border-sky-400/30 bg-sky-400/[0.05] text-sky-300"
                              : "border-zinc-700 text-zinc-500"
                          }`}
                        >
                          {sameExpiration &&
                          currentEconomics
                            ? "Live contract tracking"
                            : "Load expiration for contract tracking"}
                        </div>
                      </div>

                      <div
                        className={`mt-3 rounded-lg border p-3 ${
                          alertConditions.length >
                          0
                            ? "border-amber-500/25 bg-amber-500/[0.035]"
                            : "border-emerald-500/20 bg-emerald-500/[0.025]"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div
                            className={`text-[9px] uppercase tracking-widest ${
                              alertConditions.length >
                              0
                                ? "text-amber-400"
                                : "text-emerald-400"
                            }`}
                          >
                            Plan status conditions
                          </div>

                          <div className="font-mono text-[9px] text-zinc-500">
                            {alertConditions.length} active
                          </div>
                        </div>

                        {alertConditions.length >
                        0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {alertConditions.map(
                              (
                                condition,
                                index
                              ) => {
                                const toneClass =
                                  condition.tone ===
                                  "red"
                                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                                    : condition.tone ===
                                        "green"
                                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                      : condition.tone ===
                                          "violet"
                                        ? "border-violet-500/30 bg-violet-500/10 text-violet-300"
                                        : condition.tone ===
                                            "sky"
                                          ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                                          : "border-amber-500/30 bg-amber-500/10 text-amber-300";

                                return (
                                  <span
                                    key={
                                      `${condition.label}-${index}`
                                    }
                                    className={`rounded-full border px-2.5 py-1 text-[9px] font-mono ${toneClass}`}
                                  >
                                    {condition.label}
                                  </span>
                                );
                              }
                            )}
                          </div>
                        ) : (
                          <div className="mt-2 text-[10px] text-zinc-500">
                            No tracked condition has changed enough to trigger a visual alert.
                          </div>
                        )}

                        <div className="mt-2 text-[9px] text-zinc-600">
                          Midpoint alert threshold: {midpointThreshold.toFixed(
                            1
                          )}% · Conditions update when market data is refreshed.
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        <MetricBox
                          label="Stock Since Saved"
                          value={
                            spotChangePct !==
                            null
                              ? `${
                                  spotChangePct >=
                                  0
                                    ? "+"
                                    : ""
                                }${spotChangePct.toFixed(
                                  2
                                )}%`
                              : "—"
                          }
                          valueClass="text-sky-300"
                          subtext={`${money(
                            plan.savedSpot
                          )} → ${money(
                            spot
                          )}`}
                        />

                        <MetricBox
                          label="Spread Midpoint Change"
                          value={
                            midpointChange !==
                            null
                              ? signedDollar(
                                  midpointChange,
                                  2
                                )
                              : "—"
                          }
                          valueClass="text-violet-300"
                          subtext={
                            midpointChange !==
                            null
                              ? `${midpointChangePct !==
                                null
                                  ? `${
                                      midpointChangePct >=
                                      0
                                        ? "+"
                                        : ""
                                    }${midpointChangePct.toFixed(
                                      1
                                    )}% · `
                                  : ""}~${signedDollar(
                                  midpointChange *
                                    100,
                                  0
                                )} per 1-lot vs saved midpoint`
                              : sameExpiration
                                ? "Current contract quotes unavailable"
                                : "Load this expiration to refresh"
                          }
                        />

                        <MetricBox
                          label="RSI Change"
                          value={
                            rsiChange !==
                            null
                              ? `${
                                  rsiChange >=
                                  0
                                    ? "+"
                                    : ""
                                }${rsiChange.toFixed(
                                  1
                                )} pts`
                              : "—"
                          }
                          subtext={`${
                            plan.savedRsi !==
                              null &&
                            plan.savedRsi !==
                              undefined
                              ? Number(
                                  plan.savedRsi
                                ).toFixed(
                                  1
                                )
                              : "—"
                          } → ${
                            currentRsi !==
                            null
                              ? currentRsi.toFixed(
                                  1
                                )
                              : "—"
                          }`}
                        />

                        <MetricBox
                          label="MACD Hist Change"
                          value={
                            macdChange !==
                            null
                              ? signed(
                                  macdChange
                                )
                              : "—"
                          }
                          subtext={`${signed(
                            plan.savedMacdHistogram
                          )} → ${signed(
                            currentMacd
                          )}`}
                        />

                        <MetricBox
                          label="Current OI Walls"
                          value={
                            sameExpiration
                              ? `${money(
                                  currentPutWall
                                )} / ${money(
                                  currentCallWall
                                )}`
                              : "—"
                          }
                          subtext={
                            sameExpiration
                              ? `Saved ${money(
                                  plan.putOIWall
                                )} / ${money(
                                  plan.callOIWall
                                )} · Put / Call`
                              : "Load this expiration to refresh"
                          }
                        />

                        <MetricBox
                          label="Current Gamma Level"
                          value={
                            sameExpiration
                              ? money(
                                  currentGammaLevel
                                )
                              : "—"
                          }
                          subtext={
                            sameExpiration
                              ? `Saved ${money(
                                  plan.gammaConcentration
                                )}`
                              : "Load this expiration to refresh"
                          }
                        />

                        <MetricBox
                          label="Spot vs Breakeven"
                          value={
                            spotVsBreakeven !==
                            null
                              ? `${
                                  spotVsBreakeven >=
                                  0
                                    ? "+"
                                    : ""
                                }${spotVsBreakeven.toFixed(
                                  2
                                )}%`
                              : "—"
                          }
                          subtext={
                            breakeven !==
                            null
                              ? `${money(
                                  spot
                                )} is ${
                                  Number(
                                    spot
                                  ) >=
                                  breakeven
                                    ? "above"
                                    : "below"
                                } ${money(
                                  breakeven
                                )}`
                              : "No breakeven saved"
                          }
                        />

                        <MetricBox
                          label="Invalidation Reference"
                          value={money(
                            invalidation
                          )}
                          valueClass={
                            invalidation !==
                            null
                              ? "text-amber-300"
                              : "text-zinc-400"
                          }
                          subtext={
                            invalidationFromSpot !==
                            null
                              ? `${Math.abs(
                                  invalidationFromSpot
                                ).toFixed(
                                  2
                                )}% ${
                                  invalidationFromSpot >=
                                  0
                                    ? "above"
                                    : "below"
                                } current spot`
                              : "No invalidation reference saved"
                          }
                        />
                      </div>

                      <div className="mt-3 text-[9px] leading-relaxed text-zinc-600">
                        Midpoint change compares the current spread midpoint with the saved midpoint snapshot. It is not realized or account P/L.
                      </div>
                    </div>

                    {(plan.notes ||
                      plan.invalidationPrice !==
                        null) && (
                      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                        {plan.notes && (
                          <>
                            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                              Notes
                            </div>

                            <div className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-zinc-300">
                              {plan.notes}
                            </div>
                          </>
                        )}

                        {plan.invalidationPrice !==
                          null && (
                          <div className={plan.notes ? "mt-3" : ""}>
                            <span className="text-[9px] uppercase tracking-widest text-amber-500">
                              Invalidation{" "}
                            </span>

                            <span className="font-mono text-[10px] text-amber-300">
                              {money(
                                plan.invalidationPrice
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              }
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-800 bg-black/20 p-4 text-center text-[10px] text-zinc-600">
          No saved plans for {ticker} yet.
        </div>
      )}

      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
        Saved plans preserve the original snapshot. Visual alert conditions are evaluated only when the scanner refreshes or the ticker is opened; they are not background push notifications. Current option midpoint, OI walls, and gamma concentration refresh only when the saved plan's expiration is loaded.
      </div>
    </div>
  );
}

/* =========================================================
   PAPER TRADE JOURNAL
========================================================= */

function PaperTradeJournal({
  ticker,
  expiration,
  optionType,
  longContract,
  shortContract,
  economics,
  spot,
  marketContext,
  fullChainAnalysis,
  contracts,
  onSelectExpiration,
}) {
  const DEFAULT_PAPER_SETTINGS = {
    fillModel:
      "quarter_spread",

    feePerContractPerLeg:
      0,

    riskLimits: {
      maxLossPerTrade:
        500,

      maxTotalOpenRisk:
        1500,

      maxTickerOpenRisk:
        750,

      maxOpenPositions:
        3,

      minOpenInterest:
        100,

      minVolume:
        20,

      maxBidAskPct:
        15,

      minRewardRisk:
        1,
    },
  };

  const [
    paperTrades,
    setPaperTrades,
  ] = useState([]);

  const [
    quantity,
    setQuantity,
  ] = useState(1);

  const [
    paperSettings,
    setPaperSettings,
  ] = useState(
    DEFAULT_PAPER_SETTINGS
  );

  const [
    settingsDraft,
    setSettingsDraft,
  ] = useState(
    DEFAULT_PAPER_SETTINGS
  );

  const [
    settingsStatus,
    setSettingsStatus,
  ] = useState("");

  const [
    exitReasons,
    setExitReasons,
  ] = useState({});

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  const [
    hydrated,
    setHydrated,
  ] = useState(false);

  useEffect(() => {
    let cancelled =
      false;

    async function load() {
      setLoading(
        true
      );

      setError(
        ""
      );

      try {
        const state =
          await fetchJson(
            `${PROXY_BASE}/scanner/state`
          );

        if (
          cancelled
        ) {
          return;
        }

        setPaperTrades(
          Array.isArray(
            state?.paperTrades
          )
            ? state.paperTrades
            : []
        );

        const loadedSettings = {
          ...DEFAULT_PAPER_SETTINGS,

          ...(
            state?.paperSettings &&
            typeof state.paperSettings ===
              "object"
              ? state.paperSettings
              : {}
          ),

          riskLimits: {
            ...DEFAULT_PAPER_SETTINGS
              .riskLimits,

            ...(
              state?.paperSettings
                ?.riskLimits &&
              typeof state.paperSettings
                .riskLimits ===
                "object"
                ? state.paperSettings
                    .riskLimits
                : {}
            ),
          },
        };

        setPaperSettings(
          loadedSettings
        );

        setSettingsDraft(
          loadedSettings
        );

        setHydrated(
          true
        );

      } catch (err) {
        if (
          !cancelled
        ) {
          setError(
            err.message
          );
        }

      } finally {
        if (
          !cancelled
        ) {
          setLoading(
            false
          );
        }
      }
    }

    load();

    return () => {
      cancelled =
        true;
    };
  }, []);

  function persistTrades(
    nextTrades
  ) {
    setPaperTrades(
      nextTrades
    );

    persistScannerStateSection(
      "paper-trades",
      {
        paperTrades:
          nextTrades,
      }
    ).catch(
      (err) => {
        console.warn(
          "Paper-trade persistence failed:",
          err
        );

        setError(
          err.message
        );
      }
    );
  }

  function updateDraftRisk(
    key,
    value
  ) {
    setSettingsDraft(
      (current) => ({
        ...current,

        riskLimits: {
          ...current.riskLimits,

          [key]:
            value,
        },
      })
    );
  }

  async function savePaperSettings() {
    const normalized = {
      fillModel:
        settingsDraft.fillModel,

      feePerContractPerLeg:
        Math.max(
          0,
          toNumber(
            settingsDraft
              .feePerContractPerLeg
          ) ??
          0
        ),

      riskLimits: {
        maxLossPerTrade:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .maxLossPerTrade
            ) ??
            0
          ),

        maxTotalOpenRisk:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .maxTotalOpenRisk
            ) ??
            0
          ),

        maxTickerOpenRisk:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .maxTickerOpenRisk
            ) ??
            0
          ),

        maxOpenPositions:
          Math.max(
            1,
            Math.floor(
              toNumber(
                settingsDraft
                  .riskLimits
                  .maxOpenPositions
              ) ??
              1
            )
          ),

        minOpenInterest:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .minOpenInterest
            ) ??
            0
          ),

        minVolume:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .minVolume
            ) ??
            0
          ),

        maxBidAskPct:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .maxBidAskPct
            ) ??
            0
          ),

        minRewardRisk:
          Math.max(
            0,
            toNumber(
              settingsDraft
                .riskLimits
                .minRewardRisk
            ) ??
            0
          ),
      },
    };

    setSettingsStatus(
      "Saving..."
    );

    try {
      await persistScannerStateSection(
        "paper-settings",
        {
          paperSettings:
            normalized,
        }
      );

      setPaperSettings(
        normalized
      );

      setSettingsDraft(
        normalized
      );

      setSettingsStatus(
        "Saved"
      );

    } catch (err) {
      setSettingsStatus(
        "Save failed"
      );

      setError(
        err.message
      );
    }
  }

  function contractsForTrade(
    trade
  ) {
    if (
      trade.expiration !==
      expiration
    ) {
      return {
        longContract:
          null,

        shortContract:
          null,
      };
    }

    return {
      longContract:
        contracts.find(
          (contract) =>
            contract.type ===
              trade.optionType &&
            contract.strike ===
              Number(
                trade.longStrike
              )
        ) ??
        null,

      shortContract:
        contracts.find(
          (contract) =>
            contract.type ===
              trade.optionType &&
            contract.strike ===
              Number(
                trade.shortStrike
              )
        ) ??
        null,
    };
  }

  function economicsForTrade(
    trade
  ) {
    const currentContracts =
      contractsForTrade(
        trade
      );

    if (
      !currentContracts
        .longContract ||
      !currentContracts
        .shortContract
    ) {
      return null;
    }

    return calculateSpreadEconomics({
      name:
        "Paper trade refresh",

      bias:
        trade.optionType ===
        "call"
          ? "Bullish"
          : "Bearish",

      legs: [
        {
          action:
            `Long ${trade.optionType}`,

          side:
            "long",

          contract:
            currentContracts
              .longContract,
        },

        {
          action:
            `Short ${trade.optionType}`,

          side:
            "short",

          contract:
            currentContracts
              .shortContract,
        },
      ],
    });
  }

  function calculateFill({
    economics:
      spreadEconomics,

    long:
      longLeg,

    short:
      shortLeg,

    fillModel,

    action,
  }) {
    if (
      !spreadEconomics ||
      !longLeg ||
      !shortLeg
    ) {
      return null;
    }

    const midpoint =
      spreadEconomics
        .midpointDebit;

    if (
      midpoint ===
      null
    ) {
      return null;
    }

    const conservativeEntry =
      longLeg.ask !==
        null &&
      shortLeg.bid !==
        null
        ? longLeg.ask -
          shortLeg.bid
        : midpoint;

    const conservativeExit =
      longLeg.bid !==
        null &&
      shortLeg.ask !==
        null
        ? longLeg.bid -
          shortLeg.ask
        : midpoint;

    const worst =
      action ===
      "entry"
        ? conservativeEntry
        : conservativeExit;

    let fill =
      midpoint;

    if (
      fillModel ===
      "quarter_spread"
    ) {
      fill =
        midpoint +
        (
          worst -
          midpoint
        ) *
          0.25;
    }

    if (
      fillModel ===
      "conservative"
    ) {
      fill =
        worst;
    }

    fill =
      clamp(
        fill,
        0,
        spreadEconomics
          .width
      );

    const slippage =
      action ===
      "entry"
        ? fill -
          midpoint
        : midpoint -
          fill;

    return {
      midpoint,

      fill,

      slippage:
        Math.max(
          0,
          slippage
        ),

      conservativeEntry,

      conservativeExit,
    };
  }

  const tickerTrades =
    useMemo(
      () =>
        paperTrades
          .filter(
            (trade) =>
              trade.ticker ===
              ticker
          )
          .sort(
            (a, b) =>
              new Date(
                b.openedAt ||
                0
              ).getTime() -
              new Date(
                a.openedAt ||
                0
              ).getTime()
          ),
      [
        paperTrades,
        ticker,
      ]
    );

  const allOpenTrades =
    paperTrades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const openTrades =
    tickerTrades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closedTrades =
    tickerTrades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const unrealizedTotal =
    openTrades.reduce(
      (
        total,
        trade
      ) =>
        total +
        (
          toNumber(
            trade.unrealizedPL
          ) ??
          0
        ),
      0
    );

  const realizedTotal =
    closedTrades.reduce(
      (
        total,
        trade
      ) =>
        total +
        (
          toNumber(
            trade.realizedPL
          ) ??
          0
        ),
      0
    );

  const wins =
    closedTrades.filter(
      (trade) =>
        (
          toNumber(
            trade.realizedPL
          ) ??
          0
        ) >
        0
    ).length;

  const winRate =
    closedTrades.length >
    0
      ? (
          wins /
          closedTrades.length
        ) *
        100
      : null;

  const tradeQuantity =
    Math.max(
      1,
      Math.floor(
        Number(
          quantity
        ) ||
        1
      )
    );

  const currentEntryFill =
    economics &&
    longContract &&
    shortContract
      ? calculateFill({
          economics,

          long:
            longContract,

          short:
            shortContract,

          fillModel:
            paperSettings
              .fillModel,

          action:
            "entry",
        })
      : null;

  const entryFee =
    Math.max(
      0,
      toNumber(
        paperSettings
          .feePerContractPerLeg
      ) ??
      0
    ) *
    2 *
    tradeQuantity;

  const estimatedExitFee =
    entryFee;

  const paperMaxLoss =
    currentEntryFill
      ? currentEntryFill
          .fill *
          100 *
          tradeQuantity +
        entryFee
      : null;

  const paperMaxProfit =
    currentEntryFill
      ? (
          economics.width -
          currentEntryFill.fill
        ) *
          100 *
          tradeQuantity -
        entryFee -
        estimatedExitFee
      : null;

  const paperRewardRisk =
    paperMaxLoss !==
      null &&
    paperMaxLoss >
      0 &&
    paperMaxProfit !==
      null
      ? paperMaxProfit /
        paperMaxLoss
      : null;

  const exactOpenTrade =
    longContract &&
    shortContract
      ? openTrades.find(
          (trade) =>
            trade.expiration ===
              expiration &&
            trade.optionType ===
              optionType &&
            Number(
              trade.longStrike
            ) ===
              Number(
                longContract.strike
              ) &&
            Number(
              trade.shortStrike
            ) ===
              Number(
                shortContract.strike
              )
        ) ??
        null
      : null;

  const totalOpenRisk =
    allOpenTrades.reduce(
      (
        total,
        trade
      ) =>
        total +
        (
          toNumber(
            trade.paperMaxLoss
          ) ??
          toNumber(
            trade.maxLoss
          ) ??
          0
        ),
      0
    );

  const tickerOpenRisk =
    allOpenTrades
      .filter(
        (trade) =>
          trade.ticker ===
          ticker
      )
      .reduce(
        (
          total,
          trade
        ) =>
          total +
          (
            toNumber(
              trade.paperMaxLoss
            ) ??
            toNumber(
              trade.maxLoss
            ) ??
            0
          ),
        0
      );

  const longSpreadPct =
    legSpreadPercent(
      longContract
    );

  const shortSpreadPct =
    legSpreadPercent(
      shortContract
    );

  const riskChecks =
    [];

  const limits =
    paperSettings
      .riskLimits;

  function addCheck(
    name,
    passed,
    detail
  ) {
    riskChecks.push({
      name,
      passed,
      detail,
    });
  }

  addCheck(
    "Entry price",
    !!currentEntryFill &&
      currentEntryFill.fill >
        0,
    currentEntryFill
      ? `Simulated fill ${money(
          currentEntryFill.fill
        )}`
      : "No valid spread quote"
  );

  addCheck(
    "Per-trade max loss",
    paperMaxLoss !==
      null &&
      (
        limits.maxLossPerTrade <=
          0 ||
        paperMaxLoss <=
          limits.maxLossPerTrade
      ),
    paperMaxLoss !==
      null
      ? `${dollar(
          paperMaxLoss
        )} / ${dollar(
          limits.maxLossPerTrade
        )} limit`
      : "Unavailable"
  );

  addCheck(
    "Portfolio open risk",
    paperMaxLoss !==
      null &&
      (
        limits.maxTotalOpenRisk <=
          0 ||
        totalOpenRisk +
          paperMaxLoss <=
          limits.maxTotalOpenRisk
      ),
    paperMaxLoss !==
      null
      ? `${dollar(
          totalOpenRisk +
            paperMaxLoss
        )} after trade / ${dollar(
          limits.maxTotalOpenRisk
        )} limit`
      : "Unavailable"
  );

  addCheck(
    "Ticker open risk",
    paperMaxLoss !==
      null &&
      (
        limits.maxTickerOpenRisk <=
          0 ||
        tickerOpenRisk +
          paperMaxLoss <=
          limits.maxTickerOpenRisk
      ),
    paperMaxLoss !==
      null
      ? `${dollar(
          tickerOpenRisk +
            paperMaxLoss
        )} after trade / ${dollar(
          limits.maxTickerOpenRisk
        )} limit`
      : "Unavailable"
  );

  addCheck(
    "Open position count",
    allOpenTrades.length <
      limits.maxOpenPositions,
    `${allOpenTrades.length} open / ${limits.maxOpenPositions} max before new trade`
  );

  addCheck(
    "Long-leg open interest",
    !!longContract &&
      longContract.openInterest >=
        limits.minOpenInterest,
    longContract
      ? `${compact(
          longContract.openInterest
        )} / ${compact(
          limits.minOpenInterest
        )} minimum`
      : "Unavailable"
  );

  addCheck(
    "Short-leg open interest",
    !!shortContract &&
      shortContract.openInterest >=
        limits.minOpenInterest,
    shortContract
      ? `${compact(
          shortContract.openInterest
        )} / ${compact(
          limits.minOpenInterest
        )} minimum`
      : "Unavailable"
  );

  addCheck(
    "Long-leg volume",
    !!longContract &&
      longContract.volume >=
        limits.minVolume,
    longContract
      ? `${compact(
          longContract.volume
        )} / ${compact(
          limits.minVolume
        )} minimum`
      : "Unavailable"
  );

  addCheck(
    "Short-leg volume",
    !!shortContract &&
      shortContract.volume >=
        limits.minVolume,
    shortContract
      ? `${compact(
          shortContract.volume
        )} / ${compact(
          limits.minVolume
        )} minimum`
      : "Unavailable"
  );

  addCheck(
    "Long bid/ask width",
    longSpreadPct !==
      null &&
      (
        limits.maxBidAskPct <=
          0 ||
        longSpreadPct <=
          limits.maxBidAskPct
      ),
    longSpreadPct !==
      null
      ? `${longSpreadPct.toFixed(
          1
        )}% / ${limits.maxBidAskPct.toFixed(
          1
        )}% max`
      : "Unavailable"
  );

  addCheck(
    "Short bid/ask width",
    shortSpreadPct !==
      null &&
      (
        limits.maxBidAskPct <=
          0 ||
        shortSpreadPct <=
          limits.maxBidAskPct
      ),
    shortSpreadPct !==
      null
      ? `${shortSpreadPct.toFixed(
          1
        )}% / ${limits.maxBidAskPct.toFixed(
          1
        )}% max`
      : "Unavailable"
  );

  addCheck(
    "Reward / risk",
    paperRewardRisk !==
      null &&
      paperRewardRisk >=
        limits.minRewardRisk,
    paperRewardRisk !==
      null
      ? `${paperRewardRisk.toFixed(
          2
        )}× / ${limits.minRewardRisk.toFixed(
          2
        )}× minimum`
      : "Unavailable"
  );

  addCheck(
    "Duplicate structure",
    !exactOpenTrade,
    exactOpenTrade
      ? "This exact paper structure is already open."
      : "No duplicate open paper position."
  );

  const blockingChecks =
    riskChecks.filter(
      (check) =>
        !check.passed
    );

  const riskPassed =
    blockingChecks.length ===
    0;

  useEffect(() => {
    if (
      !hydrated ||
      !contracts.length
    ) {
      return;
    }

    setPaperTrades(
      (current) => {
        let changed =
          false;

        const now =
          new Date().toISOString();

        const next =
          current.map(
            (trade) => {
              if (
                trade.status !==
                  "open" ||
                trade.ticker !==
                  ticker ||
                trade.expiration !==
                  expiration
              ) {
                return trade;
              }

              const currentEconomics =
                economicsForTrade(
                  trade
                );

              const currentContracts =
                contractsForTrade(
                  trade
                );

              const fillModel =
                trade.fillModel ??
                paperSettings
                  .fillModel;

              const liquidationFill =
                calculateFill({
                  economics:
                    currentEconomics,

                  long:
                    currentContracts
                      .longContract,

                  short:
                    currentContracts
                      .shortContract,

                  fillModel,

                  action:
                    "exit",
                });

              const entryPrice =
                toNumber(
                  trade.entryPrice
                );

              const savedQuantity =
                Math.max(
                  1,
                  Number(
                    trade.quantity ||
                    1
                  )
                );

              const feeRate =
                Math.max(
                  0,
                  toNumber(
                    trade
                      .feePerContractPerLeg
                  ) ??
                  toNumber(
                    paperSettings
                      .feePerContractPerLeg
                  ) ??
                  0
                );

              const estimatedExitFees =
                feeRate *
                2 *
                savedQuantity;

              if (
                !liquidationFill ||
                entryPrice ===
                  null
              ) {
                return trade;
              }

              const entryFees =
                toNumber(
                  trade.entryFees
                ) ??
                feeRate *
                  2 *
                  savedQuantity;

              const unrealizedPL =
                (
                  liquidationFill.fill -
                  entryPrice
                ) *
                  100 *
                  savedQuantity -
                entryFees -
                estimatedExitFees;

              const entryCost =
                entryPrice *
                  100 *
                  savedQuantity +
                entryFees;

              const unrealizedReturnPct =
                entryCost >
                0
                  ? (
                      unrealizedPL /
                      entryCost
                    ) *
                    100
                  : null;

              const maxFavorablePL =
                Math.max(
                  toNumber(
                    trade.maxFavorablePL
                  ) ??
                    0,
                  unrealizedPL
                );

              const maxAdversePL =
                Math.min(
                  toNumber(
                    trade.maxAdversePL
                  ) ??
                    0,
                  unrealizedPL
                );

              const shouldUpdate =
                Math.abs(
                  (
                    toNumber(
                      trade.currentMidpoint
                    ) ??
                    0
                  ) -
                  liquidationFill
                    .midpoint
                ) >
                  0.0001 ||
                Math.abs(
                  (
                    toNumber(
                      trade.currentLiquidationPrice
                    ) ??
                    0
                  ) -
                  liquidationFill
                    .fill
                ) >
                  0.0001 ||
                Math.abs(
                  (
                    toNumber(
                      trade.currentSpot
                    ) ??
                    0
                  ) -
                  (
                    toNumber(
                      spot
                    ) ??
                    0
                  )
                ) >
                  0.0001 ||
                Math.abs(
                  (
                    toNumber(
                      trade.unrealizedPL
                    ) ??
                    0
                  ) -
                  unrealizedPL
                ) >
                  0.01;

              if (
                !shouldUpdate
              ) {
                return trade;
              }

              changed =
                true;

              return {
                ...trade,

                currentMidpoint:
                  liquidationFill
                    .midpoint,

                currentLiquidationPrice:
                  liquidationFill
                    .fill,

                currentExitSlippage:
                  liquidationFill
                    .slippage,

                currentSpot:
                  toNumber(
                    spot
                  ),

                unrealizedPL,

                unrealizedReturnPct,

                maxFavorablePL,

                maxAdversePL,

                estimatedExitFees,

                currentRsi:
                  toNumber(
                    marketContext?.rsi
                  ),

                currentMacdHistogram:
                  toNumber(
                    marketContext
                      ?.macd
                      ?.histogram
                  ),

                updatedAt:
                  now,
              };
            }
          );

        if (
          changed
        ) {
          persistScannerStateSection(
            "paper-trades",
            {
              paperTrades:
                next,
            }
          ).catch(
            (err) =>
              console.warn(
                "Paper-trade mark update failed:",
                err
              )
          );

          return next;
        }

        return current;
      }
    );
  }, [
    hydrated,
    contracts,
    ticker,
    expiration,
    spot,
    marketContext?.rsi,
    marketContext?.macd?.histogram,
    paperSettings.fillModel,
    paperSettings.feePerContractPerLeg,
  ]);

  function openPaperTrade() {
    if (
      !economics ||
      !longContract ||
      !shortContract ||
      !currentEntryFill
    ) {
      return;
    }

    if (
      !riskPassed
    ) {
      setError(
        "Risk manager blocked this paper trade. Adjust the structure, quantity, or paper risk limits first."
      );

      return;
    }

    const now =
      new Date().toISOString();

    const entryPrice =
      currentEntryFill
        .fill;

    const entryFees =
      entryFee;

    const entrySlippageDollars =
      currentEntryFill
        .slippage *
      100 *
      tradeQuantity;

    const trade = {
      id:
        typeof crypto !==
          "undefined" &&
        typeof crypto.randomUUID ===
          "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${ticker}-paper`,

      status:
        "open",

      ticker,
      expiration,
      optionType,

      longStrike:
        longContract.strike,

      shortStrike:
        shortContract.strike,

      longOptionId:
        longContract.id,

      shortOptionId:
        shortContract.id,

      quantity:
        tradeQuantity,

      fillModel:
        paperSettings
          .fillModel,

      feePerContractPerLeg:
        paperSettings
          .feePerContractPerLeg,

      entryTheoreticalMidpoint:
        currentEntryFill
          .midpoint,

      entryPrice,

      entrySlippage:
        currentEntryFill
          .slippage,

      entrySlippageDollars,

      entryFees,

      estimatedRoundTripFees:
        entryFees +
        estimatedExitFee,

      entryCost:
        entryPrice *
          100 *
          tradeQuantity +
        entryFees,

      openedAt:
        now,

      updatedAt:
        now,

      entrySpot:
        toNumber(
          spot
        ),

      currentSpot:
        toNumber(
          spot
        ),

      currentMidpoint:
        currentEntryFill
          .midpoint,

      currentLiquidationPrice:
        currentEntryFill
          .midpoint,

      unrealizedPL:
        -entryFees,

      unrealizedReturnPct:
        entryPrice >
        0
          ? (
              -entryFees /
              (
                entryPrice *
                  100 *
                  tradeQuantity +
                entryFees
              )
            ) *
            100
          : 0,

      maxFavorablePL:
        0,

      maxAdversePL:
        Math.min(
          0,
          -entryFees
        ),

      entryRsi:
        toNumber(
          marketContext?.rsi
        ),

      entryMacdHistogram:
        toNumber(
          marketContext
            ?.macd
            ?.histogram
        ),

      entryLongIv:
        toNumber(
          longContract.iv
        ),

      entryShortIv:
        toNumber(
          shortContract.iv
        ),

      entryDelta:
        economics.netDelta,

      entryGamma:
        economics.netGamma,

      entryTheta:
        economics.netTheta,

      entryVega:
        economics.netVega,

      paperMaxLoss,

      paperMaxProfit,

      paperRewardRisk,

      maxLoss:
        paperMaxLoss,

      maxProfit:
        paperMaxProfit,

      breakeven:
        economics.breakeven,

      rewardRisk:
        paperRewardRisk,

      riskSnapshot: {
        limits:
          paperSettings
            .riskLimits,

        checks:
          riskChecks,

        totalOpenRiskBefore:
          totalOpenRisk,

        tickerOpenRiskBefore:
          tickerOpenRisk,
      },

      entryPutOIWall:
        fullChainAnalysis
          ?.putOIWall
          ?.strike ??
        null,

      entryCallOIWall:
        fullChainAnalysis
          ?.callOIWall
          ?.strike ??
        null,

      entryGammaConcentration:
        fullChainAnalysis
          ?.gammaConcentration
          ?.strike ??
        null,

      entryLongQuote: {
        bid:
          longContract.bid,

        ask:
          longContract.ask,

        mark:
          longContract.mark,

        volume:
          longContract.volume,

        openInterest:
          longContract.openInterest,

        bidAskPct:
          longSpreadPct,
      },

      entryShortQuote: {
        bid:
          shortContract.bid,

        ask:
          shortContract.ask,

        mark:
          shortContract.mark,

        volume:
          shortContract.volume,

        openInterest:
          shortContract.openInterest,

        bidAskPct:
          shortSpreadPct,
      },

      realizedPL:
        null,

      closedAt:
        null,

      exitPrice:
        null,

      exitReason:
        null,

      exitSpot:
        null,
    };

    persistTrades([
      trade,
      ...paperTrades,
    ]);

    setError(
      ""
    );
  }

  function closePaperTrade(
    trade
  ) {
    const currentEconomics =
      economicsForTrade(
        trade
      );

    const currentContracts =
      contractsForTrade(
        trade
      );

    const fillModel =
      trade.fillModel ??
      paperSettings
        .fillModel;

    const exitFill =
      calculateFill({
        economics:
          currentEconomics,

        long:
          currentContracts
            .longContract,

        short:
          currentContracts
            .shortContract,

        fillModel,

        action:
          "exit",
      });

    const entryPrice =
      toNumber(
        trade.entryPrice
      );

    if (
      !exitFill ||
      entryPrice ===
        null
    ) {
      setError(
        "Load this trade's expiration and current option quotes before closing the paper trade."
      );

      return;
    }

    const savedQuantity =
      Math.max(
        1,
        Number(
          trade.quantity ||
          1
        )
      );

    const feeRate =
      Math.max(
        0,
        toNumber(
          trade
            .feePerContractPerLeg
        ) ??
        toNumber(
          paperSettings
            .feePerContractPerLeg
        ) ??
        0
      );

    const entryFees =
      toNumber(
        trade.entryFees
      ) ??
      feeRate *
        2 *
        savedQuantity;

    const exitFees =
      feeRate *
      2 *
      savedQuantity;

    const realizedPL =
      (
        exitFill.fill -
        entryPrice
      ) *
        100 *
        savedQuantity -
      entryFees -
      exitFees;

    const now =
      new Date().toISOString();

    const reason =
      exitReasons[
        trade.id
      ] ??
      "manual_close";

    const nextTrades =
      paperTrades.map(
        (item) =>
          item.id ===
          trade.id
            ? {
                ...item,

                status:
                  "closed",

                exitTheoreticalMidpoint:
                  exitFill
                    .midpoint,

                exitPrice:
                  exitFill
                    .fill,

                exitSlippage:
                  exitFill
                    .slippage,

                exitSlippageDollars:
                  exitFill
                    .slippage *
                  100 *
                  savedQuantity,

                exitFees,

                totalFees:
                  entryFees +
                  exitFees,

                exitReason:
                  reason,

                exitSpot:
                  toNumber(
                    spot
                  ),

                exitRsi:
                  toNumber(
                    marketContext?.rsi
                  ),

                exitMacdHistogram:
                  toNumber(
                    marketContext
                      ?.macd
                      ?.histogram
                  ),

                realizedPL,

                unrealizedPL:
                  null,

                unrealizedReturnPct:
                  null,

                closedAt:
                  now,

                updatedAt:
                  now,

                holdingMinutes:
                  Math.max(
                    0,
                    Math.round(
                      (
                        Date.parse(
                          now
                        ) -
                        Date.parse(
                          item.openedAt
                        )
                      ) /
                        60000
                    )
                  ),
              }
            : item
      );

    persistTrades(
      nextTrades
    );

    setExitReasons(
      (current) => {
        const next = {
          ...current,
        };

        delete next[
          trade.id
        ];

        return next;
      }
    );

    setError(
      ""
    );
  }

  function deleteClosedPaperTrade(
    id
  ) {
    const nextTrades =
      paperTrades.filter(
        (trade) =>
          !(
            trade.id ===
              id &&
            trade.status ===
              "closed"
          )
      );

    persistTrades(
      nextTrades
    );
  }

  const fillModelLabel =
    paperSettings
      .fillModel ===
      "midpoint"
      ? "Midpoint"
      : paperSettings
          .fillModel ===
          "conservative"
        ? "Conservative bid/ask"
        : "25% toward bid/ask";

  return (
    <div className="mt-5 rounded-xl border border-cyan-500/25 bg-cyan-500/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-cyan-400">
            Paper trading
          </div>

          <div className="mt-1 text-lg font-bold">
            Trade journal + risk-managed simulated execution
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Paper-only execution. No Robinhood order is submitted.
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="rounded border border-cyan-500/20 px-2 py-1 text-[9px] uppercase tracking-widest text-cyan-300">
            {openTrades.length} open
          </div>

          <div className="rounded border border-zinc-700 px-2 py-1 text-[9px] uppercase tracking-widest text-zinc-400">
            {closedTrades.length} closed
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricBox
          label="Paper Unrealized P/L"
          value={signedDollar(
            unrealizedTotal,
            0
          )}
          valueClass={
            unrealizedTotal >
            0
              ? "text-emerald-300"
              : unrealizedTotal <
                  0
                ? "text-red-300"
                : "text-zinc-200"
          }
        />

        <MetricBox
          label="Paper Realized P/L"
          value={signedDollar(
            realizedTotal,
            0
          )}
          valueClass={
            realizedTotal >
            0
              ? "text-emerald-300"
              : realizedTotal <
                  0
                ? "text-red-300"
                : "text-zinc-200"
          }
        />

        <MetricBox
          label="Closed Trades"
          value={
            closedTrades.length
          }
        />

        <MetricBox
          label="Win Rate"
          value={
            winRate !==
            null
              ? `${winRate.toFixed(
                  1
                )}%`
              : "—"
          }
          subtext="Descriptive only; not a profitability forecast."
        />
      </div>

      <div className="mt-5 rounded-xl border border-violet-500/20 bg-violet-500/[0.025] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-widest text-violet-400">
              Paper execution settings
            </div>

            <div className="mt-1 text-sm font-bold">
              Fill model + hard paper risk limits
            </div>

            <div className="mt-1 text-[9px] text-zinc-600">
              These are editable paper-testing controls, not live-trading recommendations.
            </div>
          </div>

          <div className="flex items-center gap-2">
            {settingsStatus && (
              <span className="text-[9px] text-zinc-500">
                {settingsStatus}
              </span>
            )}

            <button
              type="button"
              onClick={
                savePaperSettings
              }
              className="rounded border border-violet-400/40 bg-violet-400/[0.05] px-3 py-1.5 text-[9px] uppercase tracking-widest text-violet-300"
            >
              Save paper settings
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">
              Fill model
            </div>

            <select
              value={
                settingsDraft
                  .fillModel
              }
              onChange={(
                event
              ) =>
                setSettingsDraft(
                  (current) => ({
                    ...current,

                    fillModel:
                      event.target
                        .value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs"
            >
              <option value="midpoint">
                Midpoint
              </option>

              <option value="quarter_spread">
                25% toward bid/ask
              </option>

              <option value="conservative">
                Conservative bid/ask
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">
              Fee / contract / leg
            </div>

            <input
              type="number"
              min="0"
              step="0.01"
              value={
                settingsDraft
                  .feePerContractPerLeg
              }
              onChange={(
                event
              ) =>
                setSettingsDraft(
                  (current) => ({
                    ...current,

                    feePerContractPerLeg:
                      event.target
                        .value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm outline-none"
            />
          </label>

          <MetricBox
            label="Active Fill Model"
            value={
              fillModelLabel
            }
            subtext="Saved settings apply to new paper trades."
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              key:
                "maxLossPerTrade",

              label:
                "Max loss / trade ($)",
            },

            {
              key:
                "maxTotalOpenRisk",

              label:
                "Max total open risk ($)",
            },

            {
              key:
                "maxTickerOpenRisk",

              label:
                "Max ticker open risk ($)",
            },

            {
              key:
                "maxOpenPositions",

              label:
                "Max open positions",
            },

            {
              key:
                "minOpenInterest",

              label:
                "Min OI / leg",
            },

            {
              key:
                "minVolume",

              label:
                "Min volume / leg",
            },

            {
              key:
                "maxBidAskPct",

              label:
                "Max bid/ask width %",
            },

            {
              key:
                "minRewardRisk",

              label:
                "Min reward / risk",
            },
          ].map(
            (field) => (
              <label
                key={
                  field.key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  {field.label}
                </div>

                <input
                  type="number"
                  min="0"
                  step={
                    field.key ===
                    "minRewardRisk"
                      ? "0.1"
                      : field.key ===
                          "maxBidAskPct"
                        ? "0.5"
                        : "1"
                  }
                  value={
                    settingsDraft
                      .riskLimits[
                      field.key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    updateDraftRisk(
                      field.key,
                      event.target
                        .value
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm outline-none"
                />
              </label>
            )
          )}
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-zinc-800 bg-black/25 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">
              Current structure
            </div>

            <div className="mt-1 font-mono text-sm font-bold">
              {longContract &&
              shortContract
                ? `${money(
                    longContract.strike
                  )} / ${money(
                    shortContract.strike
                  )} ${optionType.toUpperCase()} spread`
                : "Select both legs"}
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Midpoint{" "}
              <span className="font-mono text-zinc-300">
                {money(
                  currentEntryFill
                    ?.midpoint
                )}
              </span>
              {" · "}
              Simulated fill{" "}
              <span className="font-mono text-cyan-300">
                {money(
                  currentEntryFill
                    ?.fill
                )}
              </span>
              {" · "}
              Entry slippage{" "}
              <span className="font-mono text-amber-300">
                {money(
                  currentEntryFill
                    ?.slippage
                )}
              </span>
              {" · "}
              Spot{" "}
              <span className="font-mono text-zinc-300">
                {money(
                  spot
                )}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label>
              <div className="mb-1 text-[9px] uppercase tracking-widest text-zinc-600">
                Qty
              </div>

              <input
                type="number"
                min="1"
                step="1"
                value={
                  quantity
                }
                onChange={(
                  event
                ) =>
                  setQuantity(
                    event.target.value
                  )
                }
                className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-center font-mono text-xs outline-none"
              />
            </label>

            <button
              type="button"
              onClick={
                openPaperTrade
              }
              disabled={
                loading ||
                !economics ||
                !longContract ||
                !shortContract ||
                !riskPassed
              }
              className="rounded border border-cyan-400/50 bg-cyan-400/10 px-4 py-2 text-[10px] font-bold text-cyan-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {exactOpenTrade
                ? "PAPER TRADE OPEN"
                : riskPassed
                  ? "OPEN PAPER TRADE"
                  : "BLOCKED BY RISK MANAGER"}
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <MetricBox
            label="Paper Max Loss"
            value={dollar(
              paperMaxLoss
            )}
            valueClass="text-red-300"
          />

          <MetricBox
            label="Paper Max Profit"
            value={dollar(
              paperMaxProfit
            )}
            valueClass="text-emerald-300"
          />

          <MetricBox
            label="Paper Reward / Risk"
            value={
              paperRewardRisk !==
              null
                ? `${paperRewardRisk.toFixed(
                    2
                  )}×`
                : "—"
            }
          />

          <MetricBox
            label="Estimated Round-Trip Fees"
            value={money(
              entryFee +
              estimatedExitFee
            )}
          />
        </div>
      </div>

      <div
        className={`mt-4 rounded-xl border p-4 ${
          riskPassed
            ? "border-emerald-500/20 bg-emerald-500/[0.025]"
            : "border-red-500/25 bg-red-500/[0.035]"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div
              className={`text-[9px] uppercase tracking-widest ${
                riskPassed
                  ? "text-emerald-400"
                  : "text-red-400"
              }`}
            >
              Paper risk manager
            </div>

            <div className="mt-1 text-sm font-bold">
              {riskPassed
                ? "All hard checks passed"
                : `${blockingChecks.length} hard check${
                    blockingChecks.length ===
                    1
                      ? ""
                      : "s"
                  } blocking entry`}
            </div>
          </div>

          <div className="text-right text-[9px] text-zinc-500">
            Open risk{" "}
            <span className="font-mono text-zinc-200">
              {dollar(
                totalOpenRisk
              )}
            </span>
            {" · "}
            {ticker}{" "}
            <span className="font-mono text-zinc-200">
              {dollar(
                tickerOpenRisk
              )}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {riskChecks.map(
            (check) => (
              <div
                key={
                  check.name
                }
                className={`rounded-lg border px-3 py-2 ${
                  check.passed
                    ? "border-emerald-500/15 bg-emerald-500/[0.02]"
                    : "border-red-500/25 bg-red-500/[0.04]"
                }`}
              >
                <div
                  className={`text-[9px] uppercase tracking-widest ${
                    check.passed
                      ? "text-emerald-400"
                      : "text-red-400"
                  }`}
                >
                  {check.passed
                    ? "PASS"
                    : "BLOCK"}{" "}
                  · {check.name}
                </div>

                <div className="mt-1 text-[9px] text-zinc-500">
                  {check.detail}
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {loading ? (
        <div className="mt-4 text-[10px] text-zinc-500">
          Loading paper journal...
        </div>
      ) : openTrades.length >
        0 ? (
        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-cyan-400">
            Open paper positions
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            {openTrades.map(
              (trade) => {
                const liveEconomics =
                  economicsForTrade(
                    trade
                  );

                const currentContracts =
                  contractsForTrade(
                    trade
                  );

                const liveFill =
                  liveEconomics
                    ? calculateFill({
                        economics:
                          liveEconomics,

                        long:
                          currentContracts
                            .longContract,

                        short:
                          currentContracts
                            .shortContract,

                        fillModel:
                          trade.fillModel ??
                          paperSettings
                            .fillModel,

                        action:
                          "exit",
                      })
                    : null;

                const currentMidpoint =
                  liveFill
                    ?.midpoint ??
                  toNumber(
                    trade.currentMidpoint
                  );

                const liquidationPrice =
                  liveFill
                    ?.fill ??
                  toNumber(
                    trade.currentLiquidationPrice
                  );

                const currentPL =
                  toNumber(
                    trade.unrealizedPL
                  );

                const sameExpiration =
                  trade.expiration ===
                  expiration;

                return (
                  <div
                    key={
                      trade.id
                    }
                    className="rounded-xl border border-cyan-500/20 bg-black/25 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-[9px] uppercase tracking-widest text-cyan-400">
                          OPEN · {dateLabel(
                            trade.expiration
                          )}
                        </div>

                        <div className="mt-1 font-mono text-base font-bold">
                          {money(
                            trade.longStrike
                          )}
                          {" / "}
                          {money(
                            trade.shortStrike
                          )}{" "}
                          {String(
                            trade.optionType
                          ).toUpperCase()}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-600">
                          {trade.quantity} contract{Number(
                            trade.quantity
                          ) === 1
                            ? ""
                            : "s"} · opened{" "}
                          {new Date(
                            trade.openedAt
                          ).toLocaleString()}
                        </div>
                      </div>

                      {sameExpiration ? (
                        <div className="flex flex-wrap items-end gap-2">
                          <label>
                            <div className="mb-1 text-[9px] uppercase tracking-widest text-zinc-600">
                              Exit reason
                            </div>

                            <select
                              value={
                                exitReasons[
                                  trade.id
                                ] ??
                                "manual_close"
                              }
                              onChange={(
                                event
                              ) =>
                                setExitReasons(
                                  (current) => ({
                                    ...current,

                                    [trade.id]:
                                      event.target
                                        .value,
                                  })
                                )
                              }
                              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[9px]"
                            >
                              <option value="manual_close">
                                Manual close
                              </option>

                              <option value="profit_target">
                                Profit target
                              </option>

                              <option value="invalidation">
                                Stop / invalidation
                              </option>

                              <option value="signal_reversal">
                                Signal reversal
                              </option>

                              <option value="expiration_management">
                                Expiration management
                              </option>

                              <option value="time_exit">
                                Time-based exit
                              </option>
                            </select>
                          </label>

                          <button
                            type="button"
                            onClick={() =>
                              closePaperTrade(
                                trade
                              )
                            }
                            disabled={
                              liquidationPrice ===
                              null
                            }
                            className="rounded border border-amber-500/40 bg-amber-500/[0.06] px-3 py-1.5 text-[9px] uppercase tracking-widest text-amber-300 disabled:opacity-30"
                          >
                            Close paper trade
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            onSelectExpiration?.(
                              trade.expiration
                            )
                          }
                          className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400"
                        >
                          Load expiration
                        </button>
                      )}
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <MetricBox
                        label="Entry Fill"
                        value={money(
                          trade.entryPrice
                        )}
                        subtext={`Mid ${money(
                          trade.entryTheoreticalMidpoint ??
                          trade.entryPrice
                        )} · slip ${money(
                          trade.entrySlippage
                        )}`}
                      />

                      <MetricBox
                        label="Current Midpoint"
                        value={money(
                          currentMidpoint
                        )}
                        subtext={`Liquidation ${money(
                          liquidationPrice
                        )}`}
                      />

                      <MetricBox
                        label="Unrealized P/L"
                        value={signedDollar(
                          currentPL,
                          0
                        )}
                        valueClass={
                          currentPL >
                          0
                            ? "text-emerald-300"
                            : currentPL <
                                0
                              ? "text-red-300"
                              : "text-zinc-200"
                        }
                        subtext={
                          toNumber(
                            trade.unrealizedReturnPct
                          ) !==
                          null
                            ? `${signed(
                                trade.unrealizedReturnPct,
                                1
                              )}% on paper cost`
                            : "—"
                        }
                      />

                      <MetricBox
                        label="MFE / MAE"
                        value={`${signedDollar(
                          trade.maxFavorablePL,
                          0
                        )} / ${signedDollar(
                          trade.maxAdversePL,
                          0
                        )}`}
                        subtext="Max favorable / adverse excursion"
                      />

                      <MetricBox
                        label="Entry RSI"
                        value={
                          toNumber(
                            trade.entryRsi
                          ) !==
                          null
                            ? Number(
                                trade.entryRsi
                              ).toFixed(
                                1
                              )
                            : "—"
                        }
                      />

                      <MetricBox
                        label="Entry MACD Hist"
                        value={signed(
                          trade.entryMacdHistogram
                        )}
                      />

                      <MetricBox
                        label="Entry OI Walls"
                        value={`${money(
                          trade.entryPutOIWall
                        )} / ${money(
                          trade.entryCallOIWall
                        )}`}
                        subtext="Put / Call"
                      />

                      <MetricBox
                        label="Entry Gamma Level"
                        value={money(
                          trade.entryGammaConcentration
                        )}
                      />

                      <MetricBox
                        label="Fill Model"
                        value={
                          trade.fillModel ===
                          "midpoint"
                            ? "Midpoint"
                            : trade.fillModel ===
                                "conservative"
                              ? "Conservative"
                              : "25% toward bid/ask"
                        }
                      />

                      <MetricBox
                        label="Entry Slippage"
                        value={signedDollar(
                          trade.entrySlippageDollars,
                          2
                        )}
                      />

                      <MetricBox
                        label="Fees Paid / Est."
                        value={money(
                          (
                            toNumber(
                              trade.entryFees
                            ) ??
                            0
                          ) +
                          (
                            toNumber(
                              trade.estimatedExitFees
                            ) ??
                            0
                          )
                        )}
                        subtext="Entry + estimated exit"
                      />

                      <MetricBox
                        label="Paper Max Risk"
                        value={dollar(
                          trade.paperMaxLoss ??
                          trade.maxLoss
                        )}
                        valueClass="text-red-300"
                      />
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
          No open paper trades for {ticker}.
        </div>
      )}

      {closedTrades.length >
        0 && (
        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Closed paper journal
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="min-w-[1500px] w-full text-[10px] font-mono">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="px-3 py-2 text-left">
                    Structure
                  </th>

                  <th className="px-3 py-2 text-right">
                    Qty
                  </th>

                  <th className="px-3 py-2 text-right">
                    Entry Mid
                  </th>

                  <th className="px-3 py-2 text-right">
                    Entry Fill
                  </th>

                  <th className="px-3 py-2 text-right">
                    Exit Mid
                  </th>

                  <th className="px-3 py-2 text-right">
                    Exit Fill
                  </th>

                  <th className="px-3 py-2 text-right">
                    Slippage
                  </th>

                  <th className="px-3 py-2 text-right">
                    Fees
                  </th>

                  <th className="px-3 py-2 text-right">
                    Realized P/L
                  </th>

                  <th className="px-3 py-2 text-right">
                    MFE
                  </th>

                  <th className="px-3 py-2 text-right">
                    MAE
                  </th>

                  <th className="px-3 py-2 text-right">
                    Hold
                  </th>

                  <th className="px-3 py-2 text-left">
                    Exit reason
                  </th>

                  <th className="px-3 py-2 text-right">
                    Action
                  </th>
                </tr>
              </thead>

              <tbody>
                {closedTrades.map(
                  (trade) => {
                    const totalSlippage =
                      (
                        toNumber(
                          trade.entrySlippageDollars
                        ) ??
                        0
                      ) +
                      (
                        toNumber(
                          trade.exitSlippageDollars
                        ) ??
                        0
                      );

                    return (
                      <tr
                        key={
                          trade.id
                        }
                        className="border-b border-zinc-900"
                      >
                        <td className="px-3 py-2">
                          {money(
                            trade.longStrike
                          )}{" "}
                          /{" "}
                          {money(
                            trade.shortStrike
                          )}{" "}
                          {String(
                            trade.optionType
                          ).toUpperCase()}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {trade.quantity}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {money(
                            trade.entryTheoreticalMidpoint ??
                            trade.entryPrice
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {money(
                            trade.entryPrice
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {money(
                            trade.exitTheoreticalMidpoint ??
                            trade.exitPrice
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {money(
                            trade.exitPrice
                          )}
                        </td>

                        <td className="px-3 py-2 text-right text-amber-300">
                          {signedDollar(
                            totalSlippage,
                            2
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {money(
                            trade.totalFees
                          )}
                        </td>

                        <td
                          className={`px-3 py-2 text-right ${
                            toNumber(
                              trade.realizedPL
                            ) >
                            0
                              ? "text-emerald-300"
                              : toNumber(
                                    trade.realizedPL
                                  ) <
                                  0
                                ? "text-red-300"
                                : "text-zinc-300"
                          }`}
                        >
                          {signedDollar(
                            trade.realizedPL,
                            0
                          )}
                        </td>

                        <td className="px-3 py-2 text-right text-emerald-300">
                          {signedDollar(
                            trade.maxFavorablePL,
                            0
                          )}
                        </td>

                        <td className="px-3 py-2 text-right text-red-300">
                          {signedDollar(
                            trade.maxAdversePL,
                            0
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          {toNumber(
                            trade.holdingMinutes
                          ) !==
                          null
                            ? `${trade.holdingMinutes}m`
                            : "—"}
                        </td>

                        <td className="px-3 py-2 text-left">
                          {String(
                            trade.exitReason ??
                            "manual_close"
                          ).replaceAll(
                            "_",
                            " "
                          )}
                        </td>

                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              deleteClosedPaperTrade(
                                trade.id
                              )
                            }
                            className="text-zinc-600 hover:text-red-300"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  }
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
        Paper fills now model configurable execution quality, slippage, and fees. The hard risk manager blocks new paper entries that violate the saved limits. These controls are for validating the process before any real-money execution is enabled.
      </div>
    </div>
  );
}

/* =========================================================
   NEW — MANUAL STRATEGY BUILDER
========================================================= */

function ManualStrategyBuilder({
  ticker,
  contracts,
  expiration,
  spot,
  loading,
  marketContext,
  fullChainAnalysis,
  onSelectExpiration,
}) {
  const [
    optionType,
    setOptionType,
  ] = useState("call");

  const [
    longStrike,
    setLongStrike,
  ] = useState("");

  const [
    shortStrike,
    setShortStrike,
  ] = useState("");

  const [
    savedSpreads,
    setSavedSpreads,
  ] = useState([]);

  const [
    pendingPlan,
    setPendingPlan,
  ] = useState(null);

  const [
    comparisonPrice,
    setComparisonPrice,
  ] = useState(
    spot ?? 0
  );

  const [
    comparisonDays,
    setComparisonDays,
  ] = useState(0);

  const [
    comparisonIvChange,
    setComparisonIvChange,
  ] = useState(0);

  const [
    comparisonHydrated,
    setComparisonHydrated,
  ] = useState(false);

  const COMPARISON_STORAGE_KEY =
    "optionsScannerSavedComparisonsV1";

  const comparisonStorageId =
    `${ticker}|${expiration}`;

  const typedContracts =
    useMemo(
      () =>
        contracts
          .filter(
            (contract) =>
              contract.type ===
              optionType
          )
          .sort(
            (a, b) =>
              a.strike -
              b.strike
          ),
      [
        contracts,
        optionType,
      ]
    );

  function chooseDefaults() {
    if (!typedContracts.length) {
      setLongStrike("");
      setShortStrike("");
      return;
    }

    const longContract =
      optionType === "call"
        ? closestByDelta(
            typedContracts,
            0.55
          )
        : closestByDelta(
            typedContracts,
            0.55,
            true
          );

    if (!longContract) {
      setLongStrike("");
      setShortStrike("");
      return;
    }

    const shortCandidates =
      optionType === "call"
        ? typedContracts.filter(
            (contract) =>
              contract.strike >
              longContract.strike
          )
        : typedContracts.filter(
            (contract) =>
              contract.strike <
              longContract.strike
          );

    const shortContract =
      optionType === "call"
        ? closestByDelta(
            shortCandidates,
            0.3
          )
        : closestByDelta(
            shortCandidates,
            0.3,
            true
          );

    setLongStrike(
      longContract.strike
    );

    setShortStrike(
      shortContract?.strike ??
        ""
    );
  }

  useEffect(() => {
    chooseDefaults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contracts,
    optionType,
  ]);

  useEffect(() => {
    setSavedSpreads([]);

    setComparisonPrice(
      Number(
        spot || 0
      )
    );

    setComparisonDays(0);
    setComparisonIvChange(0);

    setComparisonHydrated(
      false
    );
  }, [
    ticker,
    expiration,
  ]);

  useEffect(() => {
    if (
      !contracts.length ||
      !ticker ||
      !expiration
    ) {
      return;
    }

    let storedEntry =
      null;

    if (
      typeof window !==
      "undefined"
    ) {
      try {
        const raw =
          window.localStorage.getItem(
            COMPARISON_STORAGE_KEY
          );

        const parsed =
          raw
            ? JSON.parse(
                raw
              )
            : {};

        storedEntry =
          parsed?.[
            comparisonStorageId
          ] ??
          null;
      } catch {
        storedEntry =
          null;
      }
    }

    const definitions =
      Array.isArray(
        storedEntry?.spreads
      )
        ? storedEntry.spreads
        : [];

    const rebuilt =
      definitions
        .map(
          (definition) => {
            const type =
              definition?.optionType;

            const currentLong =
              contracts.find(
                (contract) =>
                  contract.type ===
                    type &&
                  contract.strike ===
                    Number(
                      definition.longStrike
                    )
              );

            const currentShort =
              contracts.find(
                (contract) =>
                  contract.type ===
                    type &&
                  contract.strike ===
                    Number(
                      definition.shortStrike
                    )
              );

            if (
              !currentLong ||
              !currentShort
            ) {
              return null;
            }

            const validOrientation =
              type === "call"
                ? currentShort.strike >
                  currentLong.strike
                : currentShort.strike <
                  currentLong.strike;

            if (
              !validOrientation
            ) {
              return null;
            }

            const strategy = {
              name:
                type === "call"
                  ? "Manual Bull Call Debit Spread"
                  : "Manual Bear Put Debit Spread",

              bias:
                type === "call"
                  ? "Bullish"
                  : "Bearish",

              legs: [
                {
                  action:
                    type === "call"
                      ? "Long call"
                      : "Long put",

                  side:
                    "long",

                  contract:
                    currentLong,
                },

                {
                  action:
                    type === "call"
                      ? "Short call"
                      : "Short put",

                  side:
                    "short",

                  contract:
                    currentShort,
                },
              ],
            };

            const rebuiltEconomics =
              calculateSpreadEconomics(
                strategy
              );

            if (
              !rebuiltEconomics
            ) {
              return null;
            }

            return {
              key:
                `${type}:${currentLong.id}:${currentShort.id}`,

              optionType:
                type,

              label:
                `${String(
                  type
                ).toUpperCase()} ${money(
                  currentLong.strike
                )}/${money(
                  currentShort.strike
                )}`,

              longStrike:
                currentLong.strike,

              shortStrike:
                currentShort.strike,

              strategy,

              economics:
                rebuiltEconomics,
            };
          }
        )
        .filter(
          Boolean
        )
        .slice(
          0,
          4
        );

    setSavedSpreads(
      rebuilt
    );

    const storedPrice =
      toNumber(
        storedEntry
          ?.scenario
          ?.price
      );

    const storedDays =
      toNumber(
        storedEntry
          ?.scenario
          ?.days
      );

    const storedIv =
      toNumber(
        storedEntry
          ?.scenario
          ?.ivChange
      );

    setComparisonPrice(
      storedPrice ??
      Number(
        spot || 0
      )
    );

    setComparisonDays(
      storedDays ??
      0
    );

    setComparisonIvChange(
      storedIv ??
      0
    );

    setComparisonHydrated(
      true
    );
  }, [
    ticker,
    expiration,
    contracts,
    comparisonStorageId,
    spot,
  ]);

  useEffect(() => {
    if (
      !comparisonHydrated ||
      !ticker ||
      !expiration ||
      typeof window ===
        "undefined"
    ) {
      return;
    }

    try {
      const raw =
        window.localStorage.getItem(
          COMPARISON_STORAGE_KEY
        );

      const parsed =
        raw
          ? JSON.parse(
              raw
            )
          : {};

      const next =
        parsed &&
        typeof parsed ===
          "object" &&
        !Array.isArray(
          parsed
        )
          ? {
              ...parsed,
            }
          : {};

      if (
        savedSpreads.length ===
        0
      ) {
        delete next[
          comparisonStorageId
        ];
      } else {
        next[
          comparisonStorageId
        ] = {
          ticker,
          expiration,

          spreads:
            savedSpreads.map(
              (item) => ({
                optionType:
                  item.optionType,

                longStrike:
                  item.longStrike,

                shortStrike:
                  item.shortStrike,
              })
            ),

          scenario: {
            price:
              toNumber(
                comparisonPrice
              ) ??
              Number(
                spot || 0
              ),

            days:
              Math.max(
                0,
                toNumber(
                  comparisonDays
                ) ??
                  0
              ),

            ivChange:
              toNumber(
                comparisonIvChange
              ) ??
              0,
          },

          updatedAt:
            new Date().toISOString(),
        };
      }

      window.localStorage.setItem(
        COMPARISON_STORAGE_KEY,
        JSON.stringify(
          next
        )
      );

      persistScannerStateSection(
        "saved-comparisons",
        {
          savedComparisons:
            next,
        }
      ).catch(
        (error) =>
          console.warn(
            "Comparison backend persistence failed:",
            error
          )
      );
    } catch {
      // Storage can fail in restrictive browser modes.
    }
  }, [
    comparisonHydrated,
    savedSpreads,
    comparisonPrice,
    comparisonDays,
    comparisonIvChange,
    comparisonStorageId,
    ticker,
    expiration,
    spot,
  ]);

  useEffect(() => {
    if (
      comparisonHydrated &&
      savedSpreads.length === 0
    ) {
      setComparisonPrice(
        Number(
          spot || 0
        )
      );
    }
  }, [
    spot,
    savedSpreads.length,
    comparisonHydrated,
  ]);

  const longContract =
    typedContracts.find(
      (contract) =>
        contract.strike ===
        Number(
          longStrike
        )
    ) ??
    null;

  const validShortContracts =
    useMemo(
      () =>
        longContract
          ? typedContracts.filter(
              (contract) =>
                optionType ===
                "call"
                  ? contract.strike >
                    longContract.strike
                  : contract.strike <
                    longContract.strike
            )
          : [],
      [
        typedContracts,
        longContract,
        optionType,
      ]
    );

  useEffect(() => {
    if (
      !longContract ||
      !validShortContracts.length
    ) {
      return;
    }

    const currentShortIsValid =
      validShortContracts.some(
        (contract) =>
          contract.strike ===
          Number(
            shortStrike
          )
      );

    if (
      currentShortIsValid
    ) {
      return;
    }

    const defaultShort =
      optionType ===
      "call"
        ? closestByDelta(
            validShortContracts,
            0.3
          )
        : closestByDelta(
            validShortContracts,
            0.3,
            true
          );

    setShortStrike(
      defaultShort?.strike ??
        validShortContracts[0]?.strike ??
        ""
    );
  }, [
    longContract,
    validShortContracts,
    optionType,
    shortStrike,
  ]);

  const shortContract =
    validShortContracts.find(
      (contract) =>
        contract.strike ===
        Number(
          shortStrike
        )
    ) ??
    null;

  const manualStrategy =
    longContract &&
    shortContract
      ? {
          name:
            optionType ===
            "call"
              ? "Manual Bull Call Debit Spread"
              : "Manual Bear Put Debit Spread",

          bias:
            optionType ===
            "call"
              ? "Bullish"
              : "Bearish",

          description:
            "This spread uses the exact contracts selected below rather than the scanner's automatic delta-based contract selection.",

          legs: [
            {
              action:
                optionType ===
                "call"
                  ? "Long call"
                  : "Long put",

              side:
                "long",

              contract:
                longContract,
            },

            {
              action:
                optionType ===
                "call"
                  ? "Short call"
                  : "Short put",

              side:
                "short",

              contract:
                shortContract,
            },
          ],

          invalidation:
            "Manual structure. Invalidation depends on the thesis and price levels being evaluated.",
        }
      : null;

  const economics =
    manualStrategy
      ? calculateSpreadEconomics(
          manualStrategy
        )
      : null;

  function loadSavedPlan(
    plan
  ) {
    if (!plan) {
      return;
    }

    setOptionType(
      plan.optionType
    );

    if (
      plan.expiration !==
      expiration
    ) {
      setPendingPlan(
        plan
      );

      if (
        onSelectExpiration
      ) {
        onSelectExpiration(
          plan.expiration
        );
      }

      return;
    }

    setLongStrike(
      Number(
        plan.longStrike
      )
    );

    setShortStrike(
      Number(
        plan.shortStrike
      )
    );
  }

  useEffect(() => {
    if (
      !pendingPlan ||
      pendingPlan.expiration !==
        expiration ||
      !contracts.length
    ) {
      return;
    }

    setOptionType(
      pendingPlan.optionType
    );

    setLongStrike(
      Number(
        pendingPlan.longStrike
      )
    );

    setShortStrike(
      Number(
        pendingPlan.shortStrike
      )
    );

    setPendingPlan(
      null
    );
  }, [
    pendingPlan,
    expiration,
    contracts,
  ]);

  const comparisonKey =
    longContract &&
    shortContract
      ? `${optionType}:${longContract.id}:${shortContract.id}`
      : "";

  const comparisonAlreadySaved =
    comparisonKey
      ? savedSpreads.some(
          (item) =>
            item.key ===
            comparisonKey
        )
      : false;

  const comparisonFull =
    savedSpreads.length >=
    4;

  function addCurrentSpreadToComparison() {
    if (
      !manualStrategy ||
      !economics ||
      !longContract ||
      !shortContract ||
      comparisonAlreadySaved ||
      comparisonFull
    ) {
      return;
    }

    setSavedSpreads(
      (current) => [
        ...current,
        {
          key:
            comparisonKey,

          optionType,

          label:
            `${optionType.toUpperCase()} ${money(
              longContract.strike
            )}/${money(
              shortContract.strike
            )}`,

          longStrike:
            longContract.strike,

          shortStrike:
            shortContract.strike,

          strategy:
            manualStrategy,

          economics,
        },
      ]
    );
  }

  function removeSavedSpread(key) {
    setSavedSpreads(
      (current) =>
        current.filter(
          (item) =>
            item.key !==
            key
        )
    );
  }

  const comparisonRows =
    savedSpreads.map(
      (item) => {
        const scenario =
          calculateGreekScenario({
            economics:
              item.economics,

            spot,

            scenarioPrice:
              comparisonPrice,

            days:
              comparisonDays,

            ivPoints:
              comparisonIvChange,
          });

        return {
          ...item,
          scenario,
        };
      }
    );

  const comparisonQuickPrices = [
    {
      label: "-5%",
      price:
        spot *
        0.95,
    },

    {
      label: "-2%",
      price:
        spot *
        0.98,
    },

    {
      label: "Spot",
      price:
        spot,
    },

    {
      label: "+2%",
      price:
        spot *
        1.02,
    },

    {
      label: "+5%",
      price:
        spot *
        1.05,
    },
  ];

  if (loading) {
    return (
      <div className="mt-5 rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.025] p-4">
        <div className="text-[9px] uppercase tracking-widest text-fuchsia-400">
          Manual strategy builder
        </div>

        <div className="mt-2 text-sm text-zinc-400">
          Waiting for full-chain quotes...
        </div>
      </div>
    );
  }

  if (!contracts.length) {
    return null;
  }

  return (
    <div className="mt-5 rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-fuchsia-400">
            Manual strategy builder
          </div>

          <div className="mt-1 text-lg font-bold">
            Choose your own vertical spread
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Uses the full {dateLabel(
              expiration
            )} option chain. Analysis only; no order is submitted.
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={
              addCurrentSpreadToComparison
            }
            disabled={
              !economics ||
              comparisonAlreadySaved ||
              comparisonFull
            }
            className={`rounded border px-3 py-1.5 text-[9px] uppercase tracking-widest ${
              !economics ||
              comparisonAlreadySaved ||
              comparisonFull
                ? "cursor-not-allowed border-zinc-800 text-zinc-700"
                : "border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-300 hover:border-fuchsia-300"
            }`}
          >
            {comparisonFull
              ? "Comparison full"
              : comparisonAlreadySaved
                ? "Already saved"
                : `Add to comparison (${savedSpreads.length}/4)`}
          </button>

          <button
            type="button"
            onClick={
              chooseDefaults
            }
            className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-fuchsia-400/50 hover:text-fuchsia-300"
          >
            Reset Legs
          </button>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
          Option type
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setOptionType(
                "call"
              )
            }
            className={`rounded-lg border px-4 py-2 text-[11px] font-bold ${
              optionType ===
              "call"
                ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            CALL SPREAD
          </button>

          <button
            type="button"
            onClick={() =>
              setOptionType(
                "put"
              )
            }
            className={`rounded-lg border px-4 py-2 text-[11px] font-bold ${
              optionType ===
              "put"
                ? "border-red-400/60 bg-red-400/10 text-red-300"
                : "border-zinc-700 text-zinc-500"
            }`}
          >
            PUT SPREAD
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="rounded-lg border border-sky-500/20 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-sky-400">
            Long {optionType}
          </div>

          <select
            value={
              longStrike
            }
            onChange={(
              event
            ) =>
              setLongStrike(
                Number(
                  event.target.value
                )
              )
            }
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-white"
          >
            {typedContracts.map(
              (contract) => (
                <option
                  key={
                    contract.id
                  }
                  value={
                    contract.strike
                  }
                >
                  {money(
                    contract.strike
                  )} · Δ{" "}
                  {contract.delta !==
                  null
                    ? contract.delta.toFixed(
                        3
                      )
                    : "—"}{" "}
                  · Mark{" "}
                  {money(
                    contract.mark
                  )}
                </option>
              )
            )}
          </select>

          <div className="mt-2 text-[9px] text-zinc-600">
            You pay premium for this leg.
          </div>
        </label>

        <label className="rounded-lg border border-amber-500/20 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-amber-400">
            Short {optionType}
          </div>

          <select
            value={
              shortStrike
            }
            onChange={(
              event
            ) =>
              setShortStrike(
                Number(
                  event.target.value
                )
              )
            }
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-white"
          >
            {validShortContracts.map(
              (contract) => (
                <option
                  key={
                    contract.id
                  }
                  value={
                    contract.strike
                  }
                >
                  {money(
                    contract.strike
                  )} · Δ{" "}
                  {contract.delta !==
                  null
                    ? contract.delta.toFixed(
                        3
                      )
                    : "—"}{" "}
                  · Mark{" "}
                  {money(
                    contract.mark
                  )}
                </option>
              )
            )}
          </select>

          <div className="mt-2 text-[9px] text-zinc-600">
            {optionType ===
            "call"
              ? "Short strike must be above the long call."
              : "Short strike must be below the long put."}
          </div>
        </label>
      </div>

      {longContract &&
        shortContract && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ContractCard
            title={
              optionType ===
              "call"
                ? "Selected Long Call"
                : "Selected Long Put"
            }
            contract={
              longContract
            }
            accentClass="text-sky-300"
          />

          <ContractCard
            title={
              optionType ===
              "call"
                ? "Selected Short Call"
                : "Selected Short Put"
            }
            contract={
              shortContract
            }
            accentClass="text-amber-300"
          />
        </div>
      )}

      {economics && (
        <>
          <div className="mt-5 border-t border-zinc-800 pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                Manual spread economics
              </div>

              <div
                className={`text-[10px] font-bold ${
                  manualStrategy.bias ===
                  "Bullish"
                    ? "text-emerald-300"
                    : "text-red-300"
                }`}
              >
                {manualStrategy.name}
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <MetricBox
                label="Est. Net Debit"
                value={money(
                  economics.entryDebit
                )}
                valueClass="text-amber-300"
                subtext="Long ask − short bid"
              />

              <MetricBox
                label="Midpoint Debit"
                value={money(
                  economics.midpointDebit
                )}
                subtext="Long mark − short mark"
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
                value={
                  economics.maxProfit !==
                    null &&
                  economics.maxProfit >=
                    0
                    ? dollar(
                        economics.maxProfit
                      )
                    : "—"
                }
                valueClass="text-emerald-300"
              />

              <MetricBox
                label="Reward / Risk"
                value={
                  economics.rewardRisk !==
                  null
                    ? `${economics.rewardRisk.toFixed(
                        2
                      )}×`
                    : "—"
                }
              />

              <MetricBox
                label="Spot"
                value={money(
                  spot
                )}
              />
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
              Manual spread net Greeks
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
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
                valueClass={
                  economics.netTheta <
                  0
                    ? "text-red-300"
                    : "text-emerald-300"
                }
              />

              <MetricBox
                label="Vega"
                value={signed(
                  economics.netVega
                )}
              />
            </div>
          </div>

          <div
            className={`mt-4 rounded-lg border px-3 py-3 ${
              economics.warnings.length >
              0
                ? "border-amber-500/30 bg-amber-500/[0.05]"
                : "border-emerald-500/20 bg-emerald-500/[0.03]"
            }`}
          >
            <div
              className={`text-[9px] uppercase tracking-widest ${
                economics.warnings.length >
                0
                  ? "text-amber-400"
                  : "text-emerald-400"
              }`}
            >
              Manual spread liquidity check
            </div>

            {economics.warnings.length >
            0 ? (
              <ul className="mt-2 space-y-1 text-[10px] text-zinc-400">
                {economics.warnings.map(
                  (
                    warning,
                    index
                  ) => (
                    <li
                      key={
                        index
                      }
                    >
                      •{" "}
                      {warning}
                    </li>
                  )
                )}
              </ul>
            ) : (
              <div className="mt-2 text-[10px] text-zinc-400">
                No obvious liquidity warning in the selected contracts.
              </div>
            )}
          </div>

          <div className="mt-5 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.025] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[9px] uppercase tracking-widest text-indigo-400">
                  Strategy comparison
                </div>

                <div className="mt-1 text-sm font-bold">
                  Compare saved manual spreads
                </div>

                <div className="mt-1 text-[10px] text-zinc-500">
                  Save up to four structures from this expiration. The comparison and shared scenario are stored automatically in this browser.
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {savedSpreads.length > 0 && (
                  <div className="rounded border border-indigo-400/20 bg-indigo-400/[0.04] px-2 py-1 text-[9px] uppercase tracking-widest text-indigo-300">
                    Saved in browser
                  </div>
                )}

                {savedSpreads.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSavedSpreads(
                        []
                      )
                    }
                    className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-red-400/40 hover:text-red-300"
                  >
                    Clear comparison
                  </button>
                )}
              </div>
            </div>

            {savedSpreads.length ===
            0 ? (
              <div className="mt-4 rounded-lg border border-dashed border-zinc-800 bg-black/20 p-4 text-center text-[10px] text-zinc-500">
                Select a spread above, then click{" "}
                <span className="text-fuchsia-300">
                  Add to comparison
                </span>
                . Change the strikes or switch between calls and puts to add more. Once added, the comparison persists after refresh or reopening the ticker.
              </div>
            ) : (
              <>
                <div className="mt-4">
                  <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                    Shared comparison scenario
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {comparisonQuickPrices.map(
                      (item) => (
                        <button
                          type="button"
                          key={
                            item.label
                          }
                          onClick={() =>
                            setComparisonPrice(
                              Number(
                                item.price.toFixed(
                                  2
                                )
                              )
                            )
                          }
                          className="rounded border border-zinc-700 px-2.5 py-1 text-[9px] font-mono text-zinc-400 hover:border-indigo-400/40 hover:text-indigo-300"
                        >
                          {item.label}{" "}
                          {money(
                            item.price
                          )}
                        </button>
                      )
                    )}
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
                      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                        Scenario stock price
                      </div>

                      <input
                        type="number"
                        step="0.01"
                        value={
                          comparisonPrice
                        }
                        onChange={(
                          event
                        ) =>
                          setComparisonPrice(
                            event.target.value
                          )
                        }
                        className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                      />
                    </label>

                    <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
                      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                        Days forward
                      </div>

                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={
                          comparisonDays
                        }
                        onChange={(
                          event
                        ) =>
                          setComparisonDays(
                            event.target.value
                          )
                        }
                        className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                      />
                    </label>

                    <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
                      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                        IV change
                      </div>

                      <input
                        type="number"
                        step="0.5"
                        value={
                          comparisonIvChange
                        }
                        onChange={(
                          event
                        ) =>
                          setComparisonIvChange(
                            event.target.value
                          )
                        }
                        className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                      />
                    </label>
                  </div>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {savedSpreads.map(
                    (item) => (
                      <div
                        key={
                          item.key
                        }
                        className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                      >
                        <div
                          className={`text-[9px] uppercase tracking-widest ${
                            item.optionType ===
                            "call"
                              ? "text-emerald-400"
                              : "text-red-400"
                          }`}
                        >
                          {item.optionType} spread
                        </div>

                        <div className="mt-1 font-mono text-sm font-bold text-white">
                          {money(
                            item.longStrike
                          )}
                          {" / "}
                          {money(
                            item.shortStrike
                          )}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-600">
                          Debit{" "}
                          {money(
                            item.economics.entryDebit
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            removeSavedSpread(
                              item.key
                            )
                          }
                          className="mt-2 text-[9px] uppercase tracking-widest text-zinc-600 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </div>
                    )
                  )}
                </div>

                <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="min-w-[1450px] w-full text-[10px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-700 bg-zinc-900/70 text-zinc-500">
                        <th className="px-3 py-2 text-left">
                          Structure
                        </th>

                        <th className="px-3 py-2 text-right">
                          Debit
                        </th>

                        <th className="px-3 py-2 text-right">
                          Width
                        </th>

                        <th className="px-3 py-2 text-right">
                          Max Loss
                        </th>

                        <th className="px-3 py-2 text-right">
                          Max Profit
                        </th>

                        <th className="px-3 py-2 text-right">
                          Breakeven
                        </th>

                        <th className="px-3 py-2 text-right">
                          R/R
                        </th>

                        <th className="px-3 py-2 text-right">
                          Delta
                        </th>

                        <th className="px-3 py-2 text-right">
                          Gamma
                        </th>

                        <th className="px-3 py-2 text-right">
                          Theta
                        </th>

                        <th className="px-3 py-2 text-right">
                          Vega
                        </th>

                        <th className="px-3 py-2 text-center">
                          Liquidity
                        </th>

                        <th className="px-3 py-2 text-right">
                          Scenario P/L
                        </th>

                        <th className="px-3 py-2 text-right">
                          Scenario Return
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {comparisonRows.map(
                        (item) => {
                          const e =
                            item.economics;

                          const scenario =
                            item.scenario;

                          const scenarioPL =
                            scenario?.estimatedPL ??
                            null;

                          const scenarioReturn =
                            scenario?.estimatedReturn ??
                            null;

                          return (
                            <tr
                              key={
                                item.key
                              }
                              className="border-b border-zinc-900"
                            >
                              <td className="px-3 py-3 text-left">
                                <div
                                  className={
                                    item.optionType ===
                                    "call"
                                      ? "text-emerald-300"
                                      : "text-red-300"
                                  }
                                >
                                  {item.optionType.toUpperCase()}
                                </div>

                                <div className="mt-0.5 text-zinc-200">
                                  {money(
                                    item.longStrike
                                  )}
                                  {" / "}
                                  {money(
                                    item.shortStrike
                                  )}
                                </div>
                              </td>

                              <td className="px-3 py-3 text-right text-amber-300">
                                {money(
                                  e.entryDebit
                                )}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {money(
                                  e.width
                                )}
                              </td>

                              <td className="px-3 py-3 text-right text-red-300">
                                {dollar(
                                  e.maxLoss
                                )}
                              </td>

                              <td className="px-3 py-3 text-right text-emerald-300">
                                {e.maxProfit !==
                                  null &&
                                e.maxProfit >=
                                  0
                                  ? dollar(
                                      e.maxProfit
                                    )
                                  : "—"}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {money(
                                  e.breakeven
                                )}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {e.rewardRisk !==
                                null
                                  ? `${e.rewardRisk.toFixed(
                                      2
                                    )}×`
                                  : "—"}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {signed(
                                  e.netDelta
                                )}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {signed(
                                  e.netGamma,
                                  4
                                )}
                              </td>

                              <td
                                className={`px-3 py-3 text-right ${
                                  e.netTheta <
                                  0
                                    ? "text-red-300"
                                    : "text-emerald-300"
                                }`}
                              >
                                {signed(
                                  e.netTheta
                                )}
                              </td>

                              <td className="px-3 py-3 text-right">
                                {signed(
                                  e.netVega
                                )}
                              </td>

                              <td
                                className={`px-3 py-3 text-center ${
                                  e.warnings.length >
                                  0
                                    ? "text-amber-300"
                                    : "text-emerald-300"
                                }`}
                              >
                                {e.warnings.length >
                                0
                                  ? `${e.warnings.length} warning${
                                      e.warnings.length ===
                                      1
                                        ? ""
                                        : "s"
                                    }`
                                  : "No warning"}
                              </td>

                              <td
                                className={`px-3 py-3 text-right font-bold ${
                                  scenarioPL >
                                  0
                                    ? "text-emerald-300"
                                    : scenarioPL <
                                        0
                                      ? "text-red-300"
                                      : "text-zinc-300"
                                }`}
                              >
                                {signedDollar(
                                  scenarioPL,
                                  0
                                )}
                              </td>

                              <td
                                className={`px-3 py-3 text-right ${
                                  scenarioReturn >
                                  0
                                    ? "text-emerald-300"
                                    : scenarioReturn <
                                        0
                                      ? "text-red-300"
                                      : "text-zinc-300"
                                }`}
                              >
                                {scenarioReturn !==
                                null
                                  ? `${
                                      scenarioReturn >=
                                      0
                                        ? "+"
                                        : ""
                                    }${scenarioReturn.toFixed(
                                      1
                                    )}%`
                                  : "—"}
                              </td>
                            </tr>
                          );
                        }
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
                  Comparison structures and shared scenario inputs are saved in browser storage. When reopened, the selected strikes are rebuilt using the current Robinhood quote snapshot. The table remains descriptive and does not rank or select a preferred structure.
                </div>
              </>
            )}
          </div>

          <SavedStrategyPlansPanel
            ticker={
              ticker
            }
            expiration={
              expiration
            }
            optionType={
              optionType
            }
            longContract={
              longContract
            }
            shortContract={
              shortContract
            }
            economics={
              economics
            }
            spot={
              spot
            }
            marketContext={
              marketContext
            }
            fullChainAnalysis={
              fullChainAnalysis
            }
            contracts={
              contracts
            }
            onLoadPlan={
              loadSavedPlan
            }
          />

          <PaperTradeJournal
            ticker={
              ticker
            }
            expiration={
              expiration
            }
            optionType={
              optionType
            }
            longContract={
              longContract
            }
            shortContract={
              shortContract
            }
            economics={
              economics
            }
            spot={
              spot
            }
            marketContext={
              marketContext
            }
            fullChainAnalysis={
              fullChainAnalysis
            }
            contracts={
              contracts
            }
            onSelectExpiration={
              onSelectExpiration
            }
          />

          <div className="mt-5 border-t border-fuchsia-500/20 pt-4">
            <div className="text-[9px] uppercase tracking-widest text-fuchsia-400">
              Manual spread analysis
            </div>

            <PayoffChart
              strategy={
                manualStrategy
              }
              economics={
                economics
              }
              spot={
                spot
              }
            />

            <ScenarioCalculator
              strategy={
                manualStrategy
              }
              economics={
                economics
              }
              spot={
                spot
              }
            />

            <ScenarioMatrix
              economics={
                economics
              }
              spot={
                spot
              }
            />
          </div>
        </>
      )}

      {!shortContract &&
        longContract && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3 text-[10px] text-amber-300">
          No valid short strike is available for the selected long contract.
        </div>
      )}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
        Manual calculations use the displayed Robinhood bid, ask, mark and
        current Greeks. Conservative entry debit uses the long ask minus the
        short bid. Scenario calculations remain local Greek approximations.
      </div>
    </div>
  );
}


/* =========================================================
   OPTION TABLE CELL
========================================================= */

function Cell({
  value,
}) {
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

  /* LOAD EXPIRATIONS */

  useEffect(() => {
    if (!data?.ticker) return;

    let cancelled = false;

    async function load() {
      try {
        const payload =
          await callRobinhood(
            "get_option_chains",
            {
              underlying_symbol:
                data.ticker,
            }
          );

        if (cancelled) return;

        const dates =
          getExpirations(
            payload
          );

        setExpirations(
          dates
        );

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
          setError(
            err.message
          );
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

  /* LOAD ALL CONTRACT INSTRUMENTS */

  useEffect(() => {
    if (
      !data?.ticker ||
      !expiration
    ) {
      return;
    }

    let cancelled = false;

    async function load() {
      setInstrumentLoading(
        true
      );

      setVisibleLoading(
        true
      );

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
          setError(
            err.message
          );
        }
      } finally {
        if (!cancelled) {
          setInstrumentLoading(
            false
          );
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

  /* LOAD VISIBLE ±5 / ±10 */

  useEffect(() => {
    if (
      instrumentLoading
    ) {
      return;
    }

    if (
      !allInstruments.length
    ) {
      setInstruments([]);
      setQuotes([]);
      setVisibleLoading(
        false
      );

      return;
    }

    let cancelled = false;

    async function load() {
      setVisibleLoading(
        true
      );

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
          setError(
            err.message
          );
        }
      } finally {
        if (!cancelled) {
          setVisibleLoading(
            false
          );
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

  /* LOAD FULL CHAIN QUOTES */

  useEffect(() => {
    if (
      instrumentLoading ||
      !allInstruments.length
    ) {
      return;
    }

    let cancelled = false;

    async function load() {
      setFullChainLoading(
        true
      );

      setFullChainError(
        ""
      );

      setFullChainProgress({
        completed: 0,
        total:
          allInstruments.length,
      });

      try {
        const result =
          await fetchOptionQuotesProgressive(
            allInstruments.map(
              (instrument) =>
                instrument.id
            ),

            {
              onProgress:
                ({
                  completed,
                  total,
                }) => {
                  if (
                    !cancelled
                  ) {
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
          setFullChainLoading(
            false
          );
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
  } =
    useMemo(
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

  const analysis =
    useMemo(
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

  const fullChainAnalysis =
    useMemo(
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

  /*
    NEW:
    Give the manual builder every quoted contract
    from the selected expiration.
  */

  const fullChainContracts =
    useMemo(
      () =>
        buildNormalizedContracts(
          allInstruments,
          fullChainQuotes
        ),
      [
        allInstruments,
        fullChainQuotes,
      ]
    );

  const loading =
    instrumentLoading ||
    visibleLoading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
      onClick={
        onClose
      }
    >
      <div
        className="flex max-h-[95vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(
          event
        ) =>
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
              onClick={
                onClose
              }
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
              value={
                expiration
              }
              onChange={(
                event
              ) =>
                setExpiration(
                  event.target.value
                )
              }
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs"
            >
              {expirations.map(
                (date) => (
                  <option
                    key={
                      date
                    }
                    value={
                      date
                    }
                  >
                    {dateLabel(
                      date
                    )}
                  </option>
                )
              )}
            </select>

            <span className="ml-2 text-xs text-zinc-500">
              Strike range
            </span>

            {[5, 10].map(
              (range) => (
                <button
                  key={
                    range
                  }
                  onClick={() =>
                    setStrikeRange(
                      range
                    )
                  }
                  className={`rounded border px-3 py-2 text-xs ${
                    strikeRange ===
                    range
                      ? "border-amber-400 bg-amber-400/10 text-amber-300"
                      : "border-zinc-700 text-zinc-400"
                  }`}
                >
                  ±{range}
                </button>
              )
            )}

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

          {!loading &&
            error && (
              <div className="rounded border border-red-500/30 bg-red-500/10 p-4 text-red-300">
                {error}
              </div>
            )}

          {!loading &&
            !error && (
              <>
                {/* NEAR ATM */}

                <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-600">
                  Near-ATM analysis · visible strike window
                </div>

                <div className="mb-4 grid gap-3 lg:grid-cols-4">
                  <AnalysisStat
                    label="Momentum"
                    value={
                      analysis.momentum
                    }
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
                    value={
                      analysis.flowLabel
                    }
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

                {/* FULL CHAIN */}

                <FullChainFlowPanel
                  analysis={
                    fullChainAnalysis
                  }
                  loading={
                    fullChainLoading
                  }
                  error={
                    fullChainError
                  }
                  progress={
                    fullChainProgress
                  }
                  expiration={
                    expiration
                  }
                />

                {/* REFERENCES */}

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

                {/* TECHNICAL CHART */}

                <HistoricalTechnicalChart
                  ticker={
                    data.ticker
                  }
                  spot={
                    data.price
                  }
                  fullChainAnalysis={
                    fullChainAnalysis
                  }
                />

                {/* AUTOMATIC STRATEGY */}

                <StrategyPanel
                  analysis={
                    analysis
                  }
                  expiration={
                    expiration
                  }
                  spot={
                    data.price
                  }
                />

                {/* NEW MANUAL STRATEGY BUILDER */}

                <ManualStrategyBuilder
                  ticker={
                    data.ticker
                  }
                  contracts={
                    fullChainContracts
                  }
                  expiration={
                    expiration
                  }
                  spot={
                    data.price
                  }
                  loading={
                    fullChainLoading
                  }
                  marketContext={
                    data
                  }
                  fullChainAnalysis={
                    fullChainAnalysis
                  }
                  onSelectExpiration={
                    setExpiration
                  }
                />

                {/* EXPIRATION COMPARISON */}

                <ExpirationComparison
                  data={
                    data
                  }
                  expirations={
                    expirations
                  }
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

                {/* CHAIN HEADER */}

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
                      {rows.map(
                        (row) => {
                          const call =
                            row.call;

                          const put =
                            row.put;

                          const atm =
                            row.strike ===
                            atmStrike;

                          return (
                            <tr
                              key={
                                row.strike
                              }
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
                        }
                      )}
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