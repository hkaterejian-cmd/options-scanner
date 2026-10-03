import {
  useEffect,
  useMemo,
  useState,
} from "react";

import ExpirationComparison from "./ExpirationComparison";

const PROXY_BASE =
  "http://127.0.0.1:3001";

/*
  =========================================================
  BASIC HELPERS
  =========================================================
*/

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );
}

function money(value) {
  const n = toNumber(value);

  return n === null
    ? "—"
    : `$${n.toFixed(2)}`;
}

function dollar(value) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  return new Intl.NumberFormat(
    undefined,
    {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }
  ).format(n);
}

function signedDollar(
  value,
  digits = 2
) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  return `${
    n >= 0
      ? "+"
      : "-"
  }$${Math.abs(
    n
  ).toFixed(digits)}`;
}

function pct(value) {
  const n = toNumber(value);

  return n === null
    ? "—"
    : `${(
        n *
        100
      ).toFixed(1)}%`;
}

function compact(value) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  if (
    Math.abs(n) >=
    1_000_000
  ) {
    return `${(
      n /
      1_000_000
    ).toFixed(1)}M`;
  }

  if (
    Math.abs(n) >=
    1_000
  ) {
    return `${(
      n /
      1_000
    ).toFixed(1)}K`;
  }

  return String(
    Math.round(n)
  );
}

function signed(
  value,
  digits = 3
) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  return `${
    n >= 0
      ? "+"
      : ""
  }${n.toFixed(digits)}`;
}

function ratioText(value) {
  const n = toNumber(value);

  return n === null
    ? "—"
    : n.toFixed(2);
}

function dateLabel(value) {
  if (!value) {
    return "—";
  }

  const date =
    new Date(
      `${value}T00:00:00`
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }

  return date.toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  );
}

/*
  =========================================================
  NETWORK
  =========================================================
*/

async function fetchJson(
  url,
  options
) {
  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `HTTP ${response.status}`
    );
  }

  return data;
}

function unwrapMcp(
  envelope
) {
  const result =
    envelope?.result ??
    envelope;

  if (
    result?.structuredContent
  ) {
    return result
      .structuredContent;
  }

  const content =
    Array.isArray(
      result?.content
    )
      ? result.content
      : [];

  for (
    const block of content
  ) {
    if (
      block?.type !== "text" ||
      typeof block.text !==
        "string"
    ) {
      continue;
    }

    try {
      return JSON.parse(
        block.text
      );
    } catch {
      // continue
    }
  }

  return result;
}

async function callRobinhood(
  toolName,
  args
) {
  const envelope =
    await fetchJson(
      `${PROXY_BASE}/robinhood/call`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            toolName,
            arguments:
              args,
          }),
      }
    );

  return unwrapMcp(
    envelope
  );
}

/*
  =========================================================
  OPTION DATA
  =========================================================
*/

function getExpirations(
  payload
) {
  const data =
    payload?.data ??
    payload ??
    {};

  const chains =
    data.chains ??
    [];

  const dates =
    new Set();

  for (
    const chain of chains
  ) {
    for (
      const expiration of
        chain.expiration_dates ||
        []
    ) {
      dates.add(
        expiration
      );
    }
  }

  return [
    ...dates,
  ].sort();
}

function nearestExpiration(
  dates
) {
  if (!dates.length) {
    return null;
  }

  const now =
    new Date();

  const today =
    [
      now.getFullYear(),

      String(
        now.getMonth() +
          1
      ).padStart(
        2,
        "0"
      ),

      String(
        now.getDate()
      ).padStart(
        2,
        "0"
      ),
    ].join("-");

  return (
    dates.find(
      (date) =>
        date >= today
    ) ??
    dates[0]
  );
}

async function fetchAllInstruments(
  ticker,
  expiration
) {
  let cursor;
  let pages = 0;

  const instruments =
    [];

  do {
    const payload =
      await callRobinhood(
        "get_option_instruments",
        {
          chain_symbol:
            ticker,

          expiration_dates:
            expiration,

          state:
            "active",

          ...(cursor
            ? {
                cursor,
              }
            : {}),
        }
      );

    const data =
      payload?.data ??
      payload ??
      {};

    instruments.push(
      ...(
        data.instruments ||
        []
      )
    );

    cursor =
      data.next ||
      null;

    pages += 1;

  } while (
    cursor &&
    pages < 20
  );

  return instruments;
}

function chunks(
  list,
  size
) {
  const result = [];

  for (
    let i = 0;
    i < list.length;
    i += size
  ) {
    result.push(
      list.slice(
        i,
        i + size
      )
    );
  }

  return result;
}

async function fetchOptionQuotes(
  instrumentIds
) {
  if (
    !instrumentIds.length
  ) {
    return [];
  }

  const batches =
    chunks(
      instrumentIds,
      20
    );

  const responses =
    await Promise.all(
      batches.map(
        (ids) =>
          callRobinhood(
            "get_option_quotes",
            {
              instrument_ids:
                ids,
            }
          )
      )
    );

  return responses.flatMap(
    (payload) => {
      const data =
        payload?.data ??
        payload ??
        {};

      return (
        data.results ||
        []
      );
    }
  );
}

/*
  =========================================================
  OPTION CHAIN NORMALIZATION
  =========================================================
*/

function buildChainRows(
  instruments,
  quotes,
  price,
  strikeRange
) {
  const quoteMap =
    new Map();

  for (
    const result of quotes
  ) {
    const quote =
      result?.quote;

    if (
      quote?.instrument_id
    ) {
      quoteMap.set(
        quote.instrument_id,
        quote
      );
    }
  }

  const strikes =
    [
      ...new Set(
        instruments
          .map(
            (item) =>
              toNumber(
                item.strike_price
              )
          )
          .filter(
            (value) =>
              value !== null
          )
      ),
    ].sort(
      (a, b) =>
        a - b
    );

  if (
    !strikes.length ||
    price === null ||
    price === undefined
  ) {
    return {
      rows: [],
      atmStrike: null,
    };
  }

  let atmIndex = 0;
  let bestDistance =
    Infinity;

  strikes.forEach(
    (
      strike,
      index
    ) => {
      const distance =
        Math.abs(
          strike - price
        );

      if (
        distance <
        bestDistance
      ) {
        bestDistance =
          distance;

        atmIndex =
          index;
      }
    }
  );

  const atmStrike =
    strikes[
      atmIndex
    ];

  const firstIndex =
    Math.max(
      0,
      atmIndex -
        strikeRange
    );

  const lastIndex =
    Math.min(
      strikes.length,
      atmIndex +
        strikeRange +
        1
    );

  const visibleStrikes =
    strikes.slice(
      firstIndex,
      lastIndex
    );

  const visibleSet =
    new Set(
      visibleStrikes
    );

  const byStrike =
    new Map();

  for (
    const instrument of
      instruments
  ) {
    const strike =
      toNumber(
        instrument
          .strike_price
      );

    if (
      strike === null ||
      !visibleSet.has(
        strike
      )
    ) {
      continue;
    }

    if (
      !byStrike.has(
        strike
      )
    ) {
      byStrike.set(
        strike,
        {
          strike,
          call: null,
          put: null,
        }
      );
    }

    const quote =
      quoteMap.get(
        instrument.id
      ) ?? {};

    const contract = {
      id:
        instrument.id,

      strike,

      type:
        instrument.type,

      bid:
        toNumber(
          quote.bid_price
        ),

      ask:
        toNumber(
          quote.ask_price
        ),

      mark:
        toNumber(
          quote.mark_price
        ),

      iv:
        toNumber(
          quote
            .implied_volatility
        ),

      delta:
        toNumber(
          quote.delta
        ),

      gamma:
        toNumber(
          quote.gamma
        ),

      theta:
        toNumber(
          quote.theta
        ),

      vega:
        toNumber(
          quote.vega
        ),

      volume:
        toNumber(
          quote.volume
        ) ?? 0,

      openInterest:
        toNumber(
          quote.open_interest
        ) ?? 0,

      breakEven:
        toNumber(
          quote
            .break_even_price
        ),

      updatedAt:
        quote.updated_at ||
        null,
    };

    if (
      instrument.type ===
      "call"
    ) {
      byStrike.get(
        strike
      ).call =
        contract;
    }

    if (
      instrument.type ===
      "put"
    ) {
      byStrike.get(
        strike
      ).put =
        contract;
    }
  }

  return {
    atmStrike,

    rows:
      visibleStrikes.map(
        (strike) =>
          byStrike.get(
            strike
          ) ?? {
            strike,
            call: null,
            put: null,
          }
      ),
  };
}

/*
  =========================================================
  STRATEGY ENGINE
  =========================================================
*/

function closestByDelta(
  contracts,
  target,
  absolute = false
) {
  const usable =
    contracts.filter(
      (contract) =>
        contract &&
        contract.delta !==
          null
    );

  if (!usable.length) {
    return null;
  }

  return [
    ...usable,
  ].sort(
    (a, b) => {
      const da =
        absolute
          ? Math.abs(
              a.delta
            )
          : a.delta;

      const db =
        absolute
          ? Math.abs(
              b.delta
            )
          : b.delta;

      return (
        Math.abs(
          da - target
        ) -
        Math.abs(
          db - target
        )
      );
    }
  )[0];
}

function analyzeSetup(
  data,
  rows,
  atmStrike
) {
  const calls =
    rows
      .map(
        (row) =>
          row.call
      )
      .filter(Boolean);

  const puts =
    rows
      .map(
        (row) =>
          row.put
      )
      .filter(Boolean);

  const callVolume =
    calls.reduce(
      (
        total,
        contract
      ) =>
        total +
        (
          contract.volume ||
          0
        ),
      0
    );

  const putVolume =
    puts.reduce(
      (
        total,
        contract
      ) =>
        total +
        (
          contract.volume ||
          0
        ),
      0
    );

  const callOI =
    calls.reduce(
      (
        total,
        contract
      ) =>
        total +
        (
          contract
            .openInterest ||
          0
        ),
      0
    );

  const putOI =
    puts.reduce(
      (
        total,
        contract
      ) =>
        total +
        (
          contract
            .openInterest ||
          0
        ),
      0
    );

  const pcrVolume =
    callVolume > 0
      ? putVolume /
        callVolume
      : null;

  const pcrOI =
    callOI > 0
      ? putOI /
        callOI
      : null;

  let bullishScore = 0;
  let bearishScore = 0;

  if (
    data.rsi !== null
  ) {
    if (
      data.rsi >= 55
    ) {
      bullishScore += 1;
    }

    if (
      data.rsi <= 45
    ) {
      bearishScore += 1;
    }
  }

  if (
    data.macd
      ?.histogram !==
      null &&
    data.macd
      ?.histogram !==
      undefined
  ) {
    if (
      data.macd
        .histogram >
      0
    ) {
      bullishScore += 1;
    }

    if (
      data.macd
        .histogram <
      0
    ) {
      bearishScore += 1;
    }
  }

  if (
    data.changePct !==
    null
  ) {
    if (
      data.changePct >
      0
    ) {
      bullishScore += 1;
    }

    if (
      data.changePct <
      0
    ) {
      bearishScore += 1;
    }
  }

  let momentum =
    "Mixed / Neutral";

  let momentumTextClass =
    "text-amber-300";

  if (
    bullishScore >= 2 &&
    bullishScore >
      bearishScore
  ) {
    momentum =
      "Bullish";

    momentumTextClass =
      "text-emerald-300";
  }

  if (
    bearishScore >= 2 &&
    bearishScore >
      bullishScore
  ) {
    momentum =
      "Bearish";

    momentumTextClass =
      "text-red-300";
  }

  const allContracts = [
    ...calls,
    ...puts,
  ];

  const gammaLeader =
    allContracts
      .filter(
        (contract) =>
          contract.gamma !==
          null
      )
      .sort(
        (a, b) =>
          Math.abs(
            b.gamma
          ) -
          Math.abs(
            a.gamma
          )
      )[0] ??
    null;

  const thetaLeader =
    allContracts
      .filter(
        (contract) =>
          contract.theta !==
          null
      )
      .sort(
        (a, b) =>
          Math.abs(
            b.theta
          ) -
          Math.abs(
            a.theta
          )
      )[0] ??
    null;

  const atmRow =
    rows.find(
      (row) =>
        row.strike ===
        atmStrike
    );

  const atmIvs =
    [
      atmRow?.call?.iv,
      atmRow?.put?.iv,
    ].filter(
      (value) =>
        value !== null &&
        value !==
          undefined
    );

  const atmIV =
    atmIvs.length
      ? atmIvs.reduce(
          (
            total,
            value
          ) =>
            total +
            value,
          0
        ) /
        atmIvs.length
      : data.atmIV;

  const lowerRows =
    rows.filter(
      (row) =>
        row.strike <
        data.price
    );

  const upperRows =
    rows.filter(
      (row) =>
        row.strike >
        data.price
    );

  const lowerReference =
    lowerRows.length
      ? lowerRows[
          lowerRows.length -
            1
        ].strike
      : null;

  const upperReference =
    upperRows.length
      ? upperRows[0]
          .strike
      : null;

  let flowLabel =
    "Balanced";

  let flowClass =
    "text-zinc-300";

  if (
    pcrVolume !==
      null &&
    pcrVolume >=
      1.25
  ) {
    flowLabel =
      "Put-heavy";

    flowClass =
      "text-red-300";
  }

  if (
    pcrVolume !==
      null &&
    pcrVolume <=
      0.8
  ) {
    flowLabel =
      "Call-heavy";

    flowClass =
      "text-emerald-300";
  }

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

  if (
    momentum ===
    "Bullish"
  ) {
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
        0.30
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
                action:
                  "Long call",

                side:
                  "long",

                contract:
                  longCall,
              },

              {
                action:
                  "Short call",

                side:
                  "short",

                contract:
                  shortCall,
              },
            ]
          : [],

      invalidation:
        "The bullish setup weakens if MACD histogram turns negative and RSI loses the 50 area.",
    };
  }

  if (
    momentum ===
    "Bearish"
  ) {
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
        0.30,
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
                action:
                  "Long put",

                side:
                  "long",

                contract:
                  longPut,
              },

              {
                action:
                  "Short put",

                side:
                  "short",

                contract:
                  shortPut,
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

    flowLabel,
    flowClass,

    gammaLeader,
    thetaLeader,

    atmIV,

    lowerReference,
    upperReference,

    strategy,
  };
}

/*
  =========================================================
  SPREAD ECONOMICS
  =========================================================
*/

function legSpreadPercent(
  contract
) {
  if (!contract) {
    return null;
  }

  const bid =
    toNumber(
      contract.bid
    );

  const ask =
    toNumber(
      contract.ask
    );

  const mark =
    toNumber(
      contract.mark
    );

  if (
    bid === null ||
    ask === null ||
    mark === null ||
    mark <= 0
  ) {
    return null;
  }

  return (
    (
      ask -
      bid
    ) /
    mark
  ) * 100;
}

function calculateSpreadEconomics(
  strategy
) {
  if (
    !strategy ||
    strategy.legs
      ?.length !==
      2
  ) {
    return null;
  }

  const longLeg =
    strategy.legs.find(
      (leg) =>
        leg.side ===
        "long"
    );

  const shortLeg =
    strategy.legs.find(
      (leg) =>
        leg.side ===
        "short"
    );

  if (
    !longLeg ||
    !shortLeg
  ) {
    return null;
  }

  const longContract =
    longLeg.contract;

  const shortContract =
    shortLeg.contract;

  const width =
    Math.abs(
      shortContract
        .strike -
      longContract
        .strike
    );

  const entryDebit =
    longContract.ask !==
      null &&
    shortContract.bid !==
      null
      ? longContract.ask -
        shortContract.bid
      : null;

  const midpointDebit =
    longContract.mark !==
      null &&
    shortContract.mark !==
      null
      ? longContract.mark -
        shortContract.mark
      : null;

  const validDebit =
    entryDebit !==
      null &&
    entryDebit > 0
      ? entryDebit
      : null;

  const maxLoss =
    validDebit !==
    null
      ? validDebit *
        100
      : null;

  const maxProfitPerShare =
    validDebit !==
    null
      ? width -
        validDebit
      : null;

  const maxProfit =
    maxProfitPerShare !==
      null
      ? maxProfitPerShare *
        100
      : null;

  let breakeven =
    null;

  if (
    validDebit !==
    null
  ) {
    if (
      strategy.bias ===
      "Bullish"
    ) {
      breakeven =
        longContract.strike +
        validDebit;
    }

    if (
      strategy.bias ===
      "Bearish"
    ) {
      breakeven =
        longContract.strike -
        validDebit;
    }
  }

  const rewardRisk =
    maxProfit !==
      null &&
    maxProfit > 0 &&
    maxLoss !==
      null &&
    maxLoss > 0
      ? maxProfit /
        maxLoss
      : null;

  const netDelta =
    longContract.delta !==
      null &&
    shortContract.delta !==
      null
      ? longContract.delta -
        shortContract.delta
      : null;

  const netGamma =
    longContract.gamma !==
      null &&
    shortContract.gamma !==
      null
      ? longContract.gamma -
        shortContract.gamma
      : null;

  const netTheta =
    longContract.theta !==
      null &&
    shortContract.theta !==
      null
      ? longContract.theta -
        shortContract.theta
      : null;

  const netVega =
    longContract.vega !==
      null &&
    shortContract.vega !==
      null
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

  const warnings =
    [];

  function checkLeg(
    label,
    contract,
    spreadPct
  ) {
    if (
      contract.bid ===
      0
    ) {
      warnings.push(
        `${label}: no active bid shown`
      );
    }

    if (
      spreadPct !==
        null &&
      spreadPct >= 15
    ) {
      warnings.push(
        `${label}: wide bid/ask (${spreadPct.toFixed(
          1
        )}% of mark)`
      );
    }

    if (
      contract
        .openInterest <
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

/*
  =========================================================
  EXPIRATION PAYOFF
  =========================================================
*/

function spreadPLAtExpiration(
  strategy,
  economics,
  stockPrice
) {
  if (
    !economics ||
    stockPrice ===
      null ||
    stockPrice ===
      undefined
  ) {
    return null;
  }

  const longContract =
    economics
      .longLeg
      .contract;

  const shortContract =
    economics
      .shortLeg
      .contract;

  const debit =
    economics.entryDebit;

  if (
    debit === null ||
    debit <= 0
  ) {
    return null;
  }

  let intrinsic = 0;

  if (
    strategy.bias ===
    "Bullish"
  ) {
    intrinsic =
      Math.max(
        stockPrice -
          longContract
            .strike,
        0
      ) -
      Math.max(
        stockPrice -
          shortContract
            .strike,
        0
      );
  }

  if (
    strategy.bias ===
    "Bearish"
  ) {
    intrinsic =
      Math.max(
        longContract
          .strike -
          stockPrice,
        0
      ) -
      Math.max(
        shortContract
          .strike -
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
    currentSpot ===
      null ||
    currentSpot ===
      undefined
  ) {
    return [];
  }

  const longStrike =
    economics
      .longLeg
      .contract
      .strike;

  const shortStrike =
    economics
      .shortLeg
      .contract
      .strike;

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
      spreadWidth *
        1.5,
      currentSpot *
        0.04,
      5
    );

  const minPrice =
    Math.max(
      0,
      Math.min(
        lowStrike,
        currentSpot
      ) -
        margin
    );

  const maxPrice =
    Math.max(
      highStrike,
      currentSpot
    ) +
    margin;

  const series =
    [];

  for (
    let i = 0;
    i <= 60;
    i++
  ) {
    const price =
      minPrice +
      (
        (
          maxPrice -
          minPrice
        ) *
        i
      ) /
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

/*
  =========================================================
  COMMON UI
  =========================================================
*/

function AnalysisStat({
  label,
  value,
  subtext,
  valueClass =
    "text-white",
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
  valueClass =
    "text-white",
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

/*
  =========================================================
  PAYOFF CHART
  =========================================================
*/

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
    economics
      .breakeven !==
    null
      ? x(
          economics
            .breakeven
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

  const samplePrices =
    [
      series[0]?.price,

      economics
        .longLeg
        .contract
        .strike,

      economics
        .breakeven,

      economics
        .shortLeg
        .contract
        .strike,

      series[
        series.length -
          1
      ]?.price,
    ]
      .filter(
        (value) =>
          value !==
            null &&
          value !==
            undefined
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
          ) === index
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
              economics
                .breakeven
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
            strokeWidth="1"
            strokeDasharray="5 5"
          />

          {breakevenX !==
            null && (
            <>
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
                strokeWidth="1"
                strokeDasharray="4 4"
              />

              <text
                x={
                  breakevenX +
                  5
                }
                y={
                  paddingTop +
                  12
                }
                fill="currentColor"
                className="text-[10px] text-amber-400"
              >
                BE{" "}
                {money(
                  economics
                    .breakeven
                )}
              </text>
            </>
          )}

          {spotX !==
            null && (
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
              strokeWidth="1"
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

          <text
            x="4"
            y={
              paddingTop +
              4
            }
            fill="currentColor"
            className="text-[10px] text-emerald-400"
          >
            {dollar(
              economics
                .maxProfit
            )}
          </text>

          <text
            x="4"
            y={
              zeroY +
              4
            }
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            $0
          </text>

          <text
            x="4"
            y={
              height -
              paddingBottom
            }
            fill="currentColor"
            className="text-[10px] text-red-400"
          >
            -
            {dollar(
              economics
                .maxLoss
            )}
          </text>

          <text
            x={
              paddingLeft
            }
            y={
              height -
              12
            }
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            {money(
              xMin
            )}
          </text>

          <text
            x={
              width -
              paddingRight
            }
            y={
              height -
              12
            }
            textAnchor="end"
            fill="currentColor"
            className="text-[10px] text-zinc-500"
          >
            {money(
              xMax
            )}
          </text>
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
                  economics
                    .maxLoss >
                    0
                    ? (
                        pl /
                        economics
                          .maxLoss
                      ) *
                      100
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

/*
  =========================================================
  SCENARIO CALCULATOR
  =========================================================
*/

function ScenarioCalculator({
  strategy,
  economics,
  spot,
}) {
  const [
    scenarioPrice,
    setScenarioPrice,
  ] =
    useState(
      spot ?? 0
    );

  const [
    daysForward,
    setDaysForward,
  ] =
    useState(0);

  const [
    ivChange,
    setIvChange,
  ] =
    useState(0);

  /*
    Reset when ticker / strategy / expiration changes.
  */

  useEffect(() => {
    setScenarioPrice(
      Number(
        spot || 0
      )
    );

    setDaysForward(
      0
    );

    setIvChange(
      0
    );

  }, [
    spot,
    economics
      ?.longLeg
      ?.contract
      ?.id,
    economics
      ?.shortLeg
      ?.contract
      ?.id,
  ]);

  if (!economics) {
    return null;
  }

  const scenario =
    toNumber(
      scenarioPrice
    ) ??
    spot;

  const days =
    Math.max(
      0,
      toNumber(
        daysForward
      ) ?? 0
    );

  /*
    IV change is entered in VOLATILITY POINTS.

    Example:
    current IV 40%
    input +5
    scenario approximately 45%
  */

  const ivPoints =
    toNumber(
      ivChange
    ) ?? 0;

  const priceMove =
    scenario -
    spot;

  /*
    Local Greek approximation:

    dV ≈
      delta*dS
      + 1/2*gamma*dS²
      + theta*days
      + vega*dIV

    All Greeks here are the NET spread Greeks.
  */

  const deltaComponent =
    economics.netDelta !==
    null
      ? economics.netDelta *
        priceMove
      : 0;

  const gammaComponent =
    economics.netGamma !==
    null
      ? 0.5 *
        economics.netGamma *
        priceMove *
        priceMove
      : 0;

  const thetaComponent =
    economics.netTheta !==
    null
      ? economics.netTheta *
        days
      : 0;

  const vegaComponent =
    economics.netVega !==
    null
      ? economics.netVega *
        ivPoints
      : 0;

  const estimatedMarkChange =
    deltaComponent +
    gammaComponent +
    thetaComponent +
    vegaComponent;

  /*
    Use current mark-to-mark spread value as the
    starting point of the approximation.
  */

  const currentSpreadMark =
    economics.midpointDebit ??
    economics.entryDebit ??
    0;

  /*
    Vertical spread value is bounded approximately
    between zero and its strike width.
  */

  const estimatedSpreadValue =
    clamp(
      currentSpreadMark +
        estimatedMarkChange,
      0,
      economics.width
    );

  /*
    P/L compared with the conservative displayed
    entry estimate: long ask - short bid.
  */

  const estimatedPL =
    economics.entryDebit !==
    null
      ? (
          estimatedSpreadValue -
          economics.entryDebit
        ) *
        100
      : null;

  const estimatedReturn =
    estimatedPL !==
      null &&
    economics.maxLoss >
      0
      ? (
          estimatedPL /
          economics.maxLoss
        ) *
        100
      : null;

  /*
    Delta approximation after stock-price movement:

      Δnew ≈ Δold + Γ*dS
  */

  const estimatedDelta =
    economics.netDelta !==
      null
      ? economics.netDelta +
        (
          economics.netGamma ??
          0
        ) *
          priceMove
      : null;

  const expirationPL =
    spreadPLAtExpiration(
      strategy,
      economics,
      scenario
    );

  const quickScenarios = [
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

  return (
    <div className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-sky-400">
            Scenario calculator
          </div>

          <div className="mt-1 text-sm font-bold text-white">
            Hypothetical spread response
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Approximate price, time, and IV effects using the spread's current Greeks.
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
          className="rounded border border-zinc-700 px-2.5 py-1 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-sky-500/40 hover:text-sky-300"
        >
          Reset
        </button>
      </div>

      {/* QUICK STOCK SCENARIOS */}

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
              className={`rounded-lg border px-3 py-1.5 text-[10px] font-mono ${
                Math.abs(
                  scenario -
                  item.price
                ) <
                0.02
                  ? "border-sky-400/60 bg-sky-400/10 text-sky-300"
                  : "border-zinc-700 bg-black/20 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {item.label}{" "}
              <span className="text-zinc-600">
                {money(
                  item.price
                )}
              </span>
            </button>
          )
        )}
      </div>

      {/* INPUTS */}

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="block rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Scenario stock price
          </div>

          <div className="mt-2 flex items-center gap-1">
            <span className="text-sm text-zinc-500">
              $
            </span>

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
                  event.target
                    .value
                )
              }
              className="w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </div>

          <div className="mt-1 text-[9px] text-zinc-600">
            Move from spot:{" "}
            <span
              className={
                priceMove > 0
                  ? "text-emerald-300"
                  : priceMove <
                      0
                    ? "text-red-300"
                    : "text-zinc-400"
              }
            >
              {signedDollar(
                priceMove
              )}
            </span>
          </div>
        </label>

        <label className="block rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Days forward
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
                event.target
                  .value
              )
            }
            className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
          />

          <div className="mt-1 text-[9px] text-zinc-600">
            Uses current net theta as a local approximation.
          </div>
        </label>

        <label className="block rounded-lg border border-zinc-800 bg-black/25 p-3">
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            IV change
          </div>

          <div className="mt-2 flex items-center gap-1">
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
                  event.target
                    .value
                )
              }
              className="w-full bg-transparent font-mono text-sm text-white outline-none"
            />

            <span className="text-xs text-zinc-500">
              pts
            </span>
          </div>

          <div className="mt-1 text-[9px] text-zinc-600">
            Example: +5 means approximately 40% → 45% IV.
          </div>
        </label>
      </div>

      {/* MAIN OUTPUT */}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricBox
          label="Est. Spread Value"
          value={
            money(
              estimatedSpreadValue
            )
          }
          valueClass="text-sky-300"
          subtext={`Current midpoint ${money(
            currentSpreadMark
          )}`}
        />

        <MetricBox
          label="Approx. P/L"
          value={
            signedDollar(
              estimatedPL,
              0
            )
          }
          valueClass={
            estimatedPL >
            0
              ? "text-emerald-300"
              : estimatedPL <
                  0
                ? "text-red-300"
                : "text-zinc-200"
          }
          subtext="Versus displayed ask/bid entry"
        />

        <MetricBox
          label="Approx. Return on Risk"
          value={
            estimatedReturn !==
            null
              ? `${
                  estimatedReturn >=
                  0
                    ? "+"
                    : ""
                }${estimatedReturn.toFixed(
                  1
                )}%`
              : "—"
          }
          valueClass={
            estimatedReturn >
            0
              ? "text-emerald-300"
              : estimatedReturn <
                  0
                ? "text-red-300"
                : "text-zinc-200"
          }
        />

        <MetricBox
          label="Approx. Net Delta"
          value={
            signed(
              estimatedDelta
            )
          }
          subtext={
            estimatedDelta !==
            null
              ? `${signed(
                  estimatedDelta *
                    100,
                  1
                )} share-equivalent`
              : undefined
          }
        />
      </div>

      {/* GREEK CONTRIBUTION */}

      <div className="mt-4">
        <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
          Approximate P/L contribution
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MetricBox
            label="Delta"
            value={
              signedDollar(
                deltaComponent *
                  100,
                0
              )
            }
            valueClass={
              deltaComponent >
              0
                ? "text-emerald-300"
                : deltaComponent <
                    0
                  ? "text-red-300"
                  : "text-zinc-300"
            }
            subtext={`Δ × stock move`}
          />

          <MetricBox
            label="Gamma"
            value={
              signedDollar(
                gammaComponent *
                  100,
                0
              )
            }
            valueClass={
              gammaComponent >
              0
                ? "text-emerald-300"
                : gammaComponent <
                    0
                  ? "text-red-300"
                  : "text-zinc-300"
            }
            subtext="½ Γ × move²"
          />

          <MetricBox
            label="Theta"
            value={
              signedDollar(
                thetaComponent *
                  100,
                0
              )
            }
            valueClass={
              thetaComponent >
              0
                ? "text-emerald-300"
                : thetaComponent <
                    0
                  ? "text-red-300"
                  : "text-zinc-300"
            }
            subtext={`${days} day${days === 1 ? "" : "s"}`}
          />

          <MetricBox
            label="Vega"
            value={
              signedDollar(
                vegaComponent *
                  100,
                0
              )
            }
            valueClass={
              vegaComponent >
              0
                ? "text-emerald-300"
                : vegaComponent <
                    0
                  ? "text-red-300"
                  : "text-zinc-300"
            }
            subtext={`${ivPoints >= 0 ? "+" : ""}${ivPoints.toFixed(
              1
            )} IV pts`}
          />
        </div>
      </div>

      {/* EXPIRATION COMPARISON FOR SAME PRICE */}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3">
        <div className="text-[9px] uppercase tracking-widest text-zinc-500">
          If stock expires at scenario price
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <span className="text-lg font-mono font-bold text-white">
            {money(
              scenario
            )}
          </span>

          <span
            className={`text-sm font-mono ${
              expirationPL >
              0
                ? "text-emerald-300"
                : expirationPL <
                    0
                  ? "text-red-300"
                  : "text-zinc-300"
            }`}
          >
            {signedDollar(
              expirationPL,
              0
            )}{" "}
            at expiration
          </span>
        </div>

        <div className="mt-1 text-[9px] text-zinc-600">
          This expiration result uses the vertical spread's intrinsic payoff rather than the Greek approximation.
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[9px] leading-relaxed text-zinc-500">
        Greek scenario estimates are local approximations, not option-pricing forecasts. Delta, gamma, theta, vega, and implied volatility change as the underlying moves and time passes. Large stock or IV changes can make the estimate materially inaccurate.
      </div>
    </div>
  );
}

/*
  =========================================================
  STRATEGY PANEL
  =========================================================
*/

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Strategy structure to research
          </div>

          <div className="mt-1 text-lg font-bold text-white">
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

        <div className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-400">
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
            ) => {
              const spreadPct =
                legSpreadPercent(
                  leg.contract
                );

              return (
                <div
                  key={`${leg.action}-${index}`}
                  className="rounded-lg border border-zinc-800 bg-black/30 p-3"
                >
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    {leg.action}
                  </div>

                  <div className="mt-1 text-sm font-bold">
                    {money(
                      leg.contract
                        .strike
                    )}
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2 text-[9px] text-zinc-400">
                    <span>
                      Δ{" "}
                      {leg.contract
                        .delta?.toFixed(
                          3
                        ) ??
                        "—"}
                    </span>

                    <span>
                      IV{" "}
                      {pct(
                        leg.contract
                          .iv
                      )}
                    </span>

                    <span>
                      Ask{" "}
                      {money(
                        leg.contract
                          .ask
                      )}
                    </span>

                    <span>
                      Bid{" "}
                      {money(
                        leg.contract
                          .bid
                      )}
                    </span>

                    <span>
                      Vol{" "}
                      {compact(
                        leg.contract
                          .volume
                      )}
                    </span>

                    <span>
                      OI{" "}
                      {compact(
                        leg.contract
                          .openInterest
                      )}
                    </span>

                    <span className="col-span-3">
                      Bid/ask width:{" "}
                      {spreadPct !==
                      null
                        ? `${spreadPct.toFixed(
                            1
                          )}% of mark`
                        : "—"}
                    </span>
                  </div>
                </div>
              );
            }
          )}
        </div>
      )}

      {economics && (
        <>
          {/* ECONOMICS */}

          <div className="mt-4 border-t border-zinc-800 pt-4">
            <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
              Estimated spread economics
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <MetricBox
                label="Est. Net Debit"
                value={
                  money(
                    economics.entryDebit
                  )
                }
                valueClass="text-amber-300"
                subtext="Long ask − short bid"
              />

              <MetricBox
                label="Midpoint Debit"
                value={
                  money(
                    economics.midpointDebit
                  )
                }
              />

              <MetricBox
                label="Spread Width"
                value={
                  money(
                    economics.width
                  )
                }
              />

              <MetricBox
                label="Breakeven"
                value={
                  money(
                    economics.breakeven
                  )
                }
              />

              <MetricBox
                label="Max Loss"
                value={
                  dollar(
                    economics.maxLoss
                  )
                }
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
                value={
                  signed(
                    economics.netDelta
                  )
                }
              />
            </div>
          </div>

          {/* NET GREEKS */}

          <div className="mt-4">
            <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
              Net Greeks
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <MetricBox
                label="Delta"
                value={
                  signed(
                    economics.netDelta
                  )
                }
              />

              <MetricBox
                label="Gamma"
                value={
                  signed(
                    economics.netGamma,
                    4
                  )
                }
              />

              <MetricBox
                label="Theta"
                value={
                  signed(
                    economics.netTheta
                  )
                }
                valueClass={
                  economics.netTheta <
                  0
                    ? "text-red-300"
                    : "text-emerald-300"
                }
              />

              <MetricBox
                label="Vega"
                value={
                  signed(
                    economics.netVega
                  )
                }
              />
            </div>
          </div>

          {/* PAYOFF */}

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

          {/* NEW SCENARIO CALCULATOR */}

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

          {/* CONTRACT QUALITY */}

          <div className="mt-4">
            <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
              Contract quality
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <MetricBox
                label="Long Leg"
                value={`Vol ${compact(
                  economics
                    .longLeg
                    .contract
                    .volume
                )} · OI ${compact(
                  economics
                    .longLeg
                    .contract
                    .openInterest
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
                  economics
                    .shortLeg
                    .contract
                    .volume
                )} · OI ${compact(
                  economics
                    .shortLeg
                    .contract
                    .openInterest
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

            <div
              className={`mt-2 rounded-lg border px-3 py-2 ${
                economics
                  .warnings
                  .length >
                0
                  ? "border-amber-500/30 bg-amber-500/[0.05]"
                  : "border-emerald-500/20 bg-emerald-500/[0.03]"
              }`}
            >
              <div
                className={`text-[9px] uppercase tracking-widest ${
                  economics
                    .warnings
                    .length >
                  0
                    ? "text-amber-400"
                    : "text-emerald-400"
                }`}
              >
                Liquidity check
              </div>

              {economics
                .warnings
                .length >
              0 ? (
                <ul className="mt-1 space-y-1 text-[10px] text-zinc-300">
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
                <div className="mt-1 text-[10px] text-zinc-400">
                  No obvious liquidity warning in the selected legs.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* INVALIDATION */}

      <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
        <div className="text-[9px] uppercase tracking-widest text-amber-500">
          Invalidation
        </div>

        <div className="mt-1 text-[10px] text-zinc-300">
          {strategy.invalidation}
        </div>
      </div>
    </div>
  );
}

/*
  =========================================================
  OPTION TABLE CELL
  =========================================================
*/

function Cell({
  value,
  className = "",
}) {
  return (
    <td
      className={`whitespace-nowrap px-2 py-1.5 text-right font-mono text-[10px] ${className}`}
    >
      {value}
    </td>
  );
}

/*
  =========================================================
  MAIN MODAL
  =========================================================
*/

export default function TickerDetailModal({
  data,
  onClose,
}) {
  const [
    expirations,
    setExpirations,
  ] =
    useState([]);

  const [
    expiration,
    setExpiration,
  ] =
    useState(
      data?.expiration ||
        ""
    );

  const [
    strikeRange,
    setStrikeRange,
  ] =
    useState(5);

  const [
    instruments,
    setInstruments,
  ] =
    useState([]);

  const [
    quotes,
    setQuotes,
  ] =
    useState([]);

  const [
    loading,
    setLoading,
  ] =
    useState(true);

  const [
    error,
    setError,
  ] =
    useState("");

  /*
    LOAD EXPIRATIONS
  */

  useEffect(() => {
    if (
      !data?.ticker
    ) {
      return;
    }

    let cancelled =
      false;

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

        if (cancelled) {
          return;
        }

        const dates =
          getExpirations(
            payload
          );

        setExpirations(
          dates
        );

        if (
          data.expiration &&
          dates.includes(
            data.expiration
          )
        ) {
          setExpiration(
            data.expiration
          );
        } else {
          setExpiration(
            nearestExpiration(
              dates
            ) || ""
          );
        }

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
      cancelled =
        true;
    };

  }, [
    data?.ticker,
    data?.expiration,
  ]);

  /*
    LOAD SELECTED EXPIRATION
  */

  useEffect(() => {
    if (
      !data?.ticker ||
      !expiration
    ) {
      return;
    }

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
        const allInstruments =
          await fetchAllInstruments(
            data.ticker,
            expiration
          );

        const strikes =
          [
            ...new Set(
              allInstruments
                .map(
                  (item) =>
                    toNumber(
                      item
                        .strike_price
                    )
                )
                .filter(
                  (value) =>
                    value !== null
                )
            ),
          ].sort(
            (a, b) =>
              a - b
          );

        let atmIndex = 0;
        let bestDistance =
          Infinity;

        strikes.forEach(
          (
            strike,
            index
          ) => {
            const distance =
              Math.abs(
                strike -
                  data.price
              );

            if (
              distance <
              bestDistance
            ) {
              bestDistance =
                distance;

              atmIndex =
                index;
            }
          }
        );

        const visibleStrikes =
          strikes.slice(
            Math.max(
              0,
              atmIndex -
                strikeRange
            ),

            Math.min(
              strikes.length,
              atmIndex +
                strikeRange +
                1
            )
          );

        const visibleSet =
          new Set(
            visibleStrikes
          );

        const visibleInstruments =
          allInstruments.filter(
            (instrument) =>
              visibleSet.has(
                toNumber(
                  instrument
                    .strike_price
                )
              )
          );

        const optionQuotes =
          await fetchOptionQuotes(
            visibleInstruments.map(
              (instrument) =>
                instrument.id
            )
          );

        if (cancelled) {
          return;
        }

        setInstruments(
          visibleInstruments
        );

        setQuotes(
          optionQuotes
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
      cancelled =
        true;
    };

  }, [
    data?.ticker,
    data?.price,
    expiration,
    strikeRange,
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
          data?.price ??
            null,
          strikeRange
        ),
      [
        instruments,
        quotes,
        data?.price,
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
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-baseline gap-3">
                <h2 className="text-3xl font-black">
                  {data.ticker}
                </h2>

                <span className="text-xl text-zinc-200">
                  {money(
                    data.price
                  )}
                </span>

                <span
                  className={
                    data.changePct >=
                    0
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  {data.changePct >=
                  0
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

                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  MACD{" "}
                  {data.macd
                    ?.histogram
                    ?.toFixed(
                      3
                    )}
                </span>

                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-300">
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

          {/* CONTROLS */}

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
                  event
                    .target
                    .value
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

        {/* SCROLL BODY */}

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
                {/* MARKET ANALYSIS */}

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
                    label="Visible Options Flow"
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
                    label="Gamma Concentration"
                    value={
                      money(
                        analysis
                          .gammaLeader
                          ?.strike
                      )
                    }
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
                    value={
                      money(
                        analysis
                          .thetaLeader
                          ?.strike
                      )
                    }
                    subtext={
                      analysis.thetaLeader
                        ? `${analysis.thetaLeader.type.toUpperCase()} Θ ${analysis.thetaLeader.theta.toFixed(
                            3
                          )}`
                        : "—"
                    }
                  />
                </div>

                {/* REFERENCES */}

                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <AnalysisStat
                    label="Lower Reference Strike"
                    value={
                      money(
                        analysis.lowerReference
                      )
                    }
                  />

                  <AnalysisStat
                    label="ATM Strike"
                    value={
                      money(
                        atmStrike
                      )
                    }
                    valueClass="text-amber-300"
                  />

                  <AnalysisStat
                    label="Upper Reference Strike"
                    value={
                      money(
                        analysis.upperReference
                      )
                    }
                  />
                </div>

                {/* STRATEGY */}

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
                    analysis
                      .strategy
                      .bias
                  }
                  onSelectExpiration={
                    setExpiration
                  }
                />

                {/* CHAIN HEADER */}

                <div className="my-4 flex gap-4 text-[10px] text-zinc-500">
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
                    Call vol{" "}
                    <b className="text-emerald-300">
                      {compact(
                        analysis.callVolume
                      )}
                    </b>
                  </span>

                  <span>
                    Put vol{" "}
                    <b className="text-red-300">
                      {compact(
                        analysis.putVolume
                      )}
                    </b>
                  </span>
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
                          const atm =
                            row.strike ===
                            atmStrike;

                          const call =
                            row.call;

                          const put =
                            row.put;

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
                              <Cell
                                value={
                                  call?.bid?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  call?.ask?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  call?.mark?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  pct(
                                    call?.iv
                                  )
                                }
                              />

                              <Cell
                                value={
                                  call?.delta?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  call?.gamma?.toFixed(
                                    4
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  call?.theta?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  call?.vega?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

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

                              <Cell
                                value={
                                  put?.bid?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  put?.ask?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  put?.mark?.toFixed(
                                    2
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  pct(
                                    put?.iv
                                  )
                                }
                              />

                              <Cell
                                value={
                                  put?.delta?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  put?.gamma?.toFixed(
                                    4
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  put?.theta?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

                              <Cell
                                value={
                                  put?.vega?.toFixed(
                                    3
                                  ) ?? "—"
                                }
                              />

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