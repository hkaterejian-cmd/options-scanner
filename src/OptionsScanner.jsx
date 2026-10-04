import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import TickerDetailModal from "./TickerDetailModal";

const PROXY_BASE = "http://127.0.0.1:3001";

const DEFAULT_TICKERS = [
  "PLTR",
  "AAPL",
  "META",
  "AMZN",
  "KO",
  "XOM",
  "GM",
  "MCD",
];

const STORAGE_KEY = "options-scanner-tickers-robinhood-v2";
const SAVED_PLANS_STORAGE_KEY = "optionsScannerSavedStrategyPlansV1";
const SAVED_COMPARISONS_STORAGE_KEY = "optionsScannerSavedComparisonsV1";
const AUTO_REFRESH_STORAGE_KEY = "optionsScannerAutoRefreshV1";
const NOTIFICATION_STORAGE_KEY = "optionsScannerNotificationsV1";

/*
  =========================================================
  BASIC HELPERS
  =========================================================
*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function formatMoney(value) {
  const n = toNumber(value);

  return n === null ? "—" : `$${n.toFixed(2)}`;
}

function formatPercent(value, digits = 1) {
  const n = toNumber(value);

  return n === null
    ? "—"
    : `${(n * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value, digits = 2) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function percentChangeFromSaved(savedValue, currentValue) {
  const saved =
    toNumber(
      savedValue
    );

  const current =
    toNumber(
      currentValue
    );

  if (
    saved === null ||
    current === null ||
    saved === 0
  ) {
    return null;
  }

  return (
    (
      current -
      saved
    ) /
    saved
  ) * 100;
}

function numericDifference(savedValue, currentValue) {
  const saved =
    toNumber(
      savedValue
    );

  const current =
    toNumber(
      currentValue
    );

  if (
    saved === null ||
    current === null
  ) {
    return null;
  }

  return (
    current -
    saved
  );
}

function formatSignedNumber(value, digits = 2) {
  const n =
    toNumber(
      value
    );

  if (n === null) {
    return "—";
  }

  return `${n >= 0 ? "+" : ""}${n.toFixed(
    digits
  )}`;
}

function formatDataAge(seconds) {
  const n =
    toNumber(
      seconds
    );

  if (n === null) {
    return "Never";
  }

  if (n < 5) {
    return "Just now";
  }

  if (n < 60) {
    return `${Math.floor(
      n
    )}s ago`;
  }

  if (n < 3600) {
    return `${Math.floor(
      n / 60
    )}m ago`;
  }

  return `${Math.floor(
    n / 3600
  )}h ago`;
}

function formatBytes(value) {
  const n =
    toNumber(
      value
    );

  if (n === null) {
    return "—";
  }

  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(
      n /
      1024
    ).toFixed(
      1
    )} KB`;
  }

  return `${(
    n /
    (
      1024 *
      1024
    )
  ).toFixed(
    1
  )} MB`;
}

function formatUptime(seconds) {
  const n =
    toNumber(
      seconds
    );

  if (n === null) {
    return "—";
  }

  if (n < 60) {
    return `${Math.floor(
      n
    )}s`;
  }

  if (n < 3600) {
    return `${Math.floor(
      n /
      60
    )}m`;
  }

  const hours =
    Math.floor(
      n /
      3600
    );

  const minutes =
    Math.floor(
      (
        n %
        3600
      ) /
      60
    );

  return `${hours}h ${minutes}m`;
}

function buildPlanStatusConditions(plan, liveData) {
  if (!plan || !liveData) {
    return [];
  }

  const conditions = [];

  const currentSpot =
    toNumber(
      liveData.price
    );

  const breakeven =
    toNumber(
      plan.breakeven
    );

  const invalidation =
    toNumber(
      plan.invalidationPrice
    );

  const savedRsi =
    toNumber(
      plan.savedRsi
    );

  const currentRsi =
    toNumber(
      liveData.rsi
    );

  const savedMacd =
    toNumber(
      plan.savedMacdHistogram
    );

  const currentMacd =
    toNumber(
      liveData.macd?.histogram
    );

  if (
    invalidation !==
      null &&
    currentSpot !==
      null
  ) {
    const crossed =
      plan.optionType ===
      "call"
        ? currentSpot <=
          invalidation
        : currentSpot >=
          invalidation;

    if (crossed) {
      conditions.push({
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
    currentSpot !==
      null
  ) {
    const reached =
      plan.optionType ===
      "call"
        ? currentSpot >=
          breakeven
        : currentSpot <=
          breakeven;

    if (reached) {
      conditions.push({
        label:
          "Breakeven reached",
        tone:
          "green",
      });
    }
  }

  if (
    savedRsi !==
      null &&
    currentRsi !==
      null
  ) {
    if (
      savedRsi <
        70 &&
      currentRsi >=
        70
    ) {
      conditions.push({
        label:
          "RSI crossed above 70",
        tone:
          "amber",
      });
    }

    if (
      savedRsi >
        30 &&
      currentRsi <=
        30
    ) {
      conditions.push({
        label:
          "RSI crossed below 30",
        tone:
          "amber",
      });
    }

    if (
      savedRsi <
        50 &&
      currentRsi >=
        50
    ) {
      conditions.push({
        label:
          "RSI crossed above 50",
        tone:
          "sky",
      });
    }

    if (
      savedRsi >
        50 &&
      currentRsi <=
        50
    ) {
      conditions.push({
        label:
          "RSI crossed below 50",
        tone:
          "sky",
      });
    }
  }

  if (
    savedMacd !==
      null &&
    currentMacd !==
      null &&
    (
      (
        savedMacd <
          0 &&
        currentMacd >=
          0
      ) ||
      (
        savedMacd >
          0 &&
        currentMacd <=
          0
      )
    )
  ) {
    conditions.push({
      label:
        `MACD flipped ${
          currentMacd >=
          0
            ? "positive"
            : "negative"
        }`,
      tone:
        "sky",
    });
  }

  return conditions;
}

function PlanStatusConditions({
  plan,
  liveData,
}) {
  const conditions =
    buildPlanStatusConditions(
      plan,
      liveData
    );

  if (!liveData) {
    return (
      <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/50 px-2.5 py-2 text-[9px] text-zinc-600">
        Status conditions unavailable until this ticker is loaded.
      </div>
    );
  }

  if (!conditions.length) {
    return (
      <div className="mt-2 rounded border border-emerald-500/15 bg-emerald-500/[0.02] px-2.5 py-2 text-[9px] text-emerald-400">
        No active price / RSI / MACD condition
      </div>
    );
  }

  return (
    <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/[0.025] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[9px] uppercase tracking-widest text-amber-400">
          Active conditions
        </div>

        <div className="font-mono text-[9px] text-zinc-500">
          {conditions.length}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {conditions.map(
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
                      "sky"
                    ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300";

            return (
              <span
                key={`${condition.label}-${index}`}
                className={`rounded-full border px-2 py-1 text-[9px] font-mono ${toneClass}`}
              >
                {condition.label}
              </span>
            );
          }
        )}
      </div>
    </div>
  );
}

function formatCompact(value) {
  const n = toNumber(value);

  if (n === null) {
    return "—";
  }

  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }

  return String(Math.round(n));
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const d = new Date(`${value}T00:00:00`);

  if (Number.isNaN(d.getTime())) {
    return value;
  }

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^-]/g, "")
    .slice(0, 15);
}

/*
  =========================================================
  STORAGE
  =========================================================
*/

function loadSavedTickers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return DEFAULT_TICKERS;
    }

    const parsed = JSON.parse(raw);

    if (
      Array.isArray(parsed) &&
      parsed.length > 0
    ) {
      return parsed;
    }
  } catch {
    // defaults
  }

  return DEFAULT_TICKERS;
}

function saveTickers(tickers) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tickers)
    );
  } catch (error) {
    console.warn("Failed to save tickers:", error);
  }
}

function readLocalJson(
  key,
  fallback
) {
  try {
    const raw =
      window.localStorage.getItem(
        key
      );

    if (!raw) {
      return fallback;
    }

    return JSON.parse(
      raw
    );
  } catch {
    return fallback;
  }
}

function writeLocalJson(
  key,
  value
) {
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify(
        value
      )
    );
  } catch {
    // Ignore restrictive browser storage modes.
  }
}

function loadSavedStrategyPlans() {
  if (
    typeof window ===
    "undefined"
  ) {
    return [];
  }

  try {
    const raw =
      window.localStorage.getItem(
        SAVED_PLANS_STORAGE_KEY
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
}

function savedPlanCountsByTicker(plans) {
  const counts = {};

  for (const plan of plans) {
    const ticker =
      normalizeTicker(
        plan?.ticker
      );

    if (!ticker) {
      continue;
    }

    counts[ticker] =
      (counts[ticker] || 0) +
      1;
  }

  return counts;
}

/*
  =========================================================
  NETWORK
  =========================================================
*/

async function fetchJson(url, options) {
  const response = await fetch(url, options);

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Non-JSON backend response (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error || `HTTP ${response.status}`
    );
  }

  return data;
}

function unwrapMcp(envelope) {
  const result = envelope?.result ?? envelope;

  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const content = Array.isArray(result?.content)
    ? result.content
    : [];

  for (const block of content) {
    if (
      block?.type !== "text" ||
      typeof block.text !== "string"
    ) {
      continue;
    }

    try {
      return JSON.parse(block.text);
    } catch {
      // continue
    }
  }

  return result;
}

/*
  =========================================================
  QUOTE HELPERS
  =========================================================
*/

function selectCurrentPrice(quote) {
  if (!quote) {
    return {
      price: null,
      timestamp: null,
      session: null,
    };
  }

  const regularPrice = toNumber(
    quote.last_trade_price
  );

  const extendedPrice = toNumber(
    quote.last_non_reg_trade_price
  );

  const regularTime = quote.venue_last_trade_time
    ? Date.parse(quote.venue_last_trade_time)
    : NaN;

  const extendedTime =
    quote.venue_last_non_reg_trade_time
      ? Date.parse(
          quote.venue_last_non_reg_trade_time
        )
      : NaN;

  if (
    extendedPrice !== null &&
    Number.isFinite(extendedTime) &&
    (
      !Number.isFinite(regularTime) ||
      extendedTime > regularTime
    )
  ) {
    return {
      price: extendedPrice,
      timestamp:
        quote.venue_last_non_reg_trade_time,
      session: "extended",
    };
  }

  return {
    price: regularPrice,
    timestamp:
      quote.venue_last_trade_time ?? null,
    session: "regular",
  };
}

/*
  =========================================================
  INDICATORS
  =========================================================
*/

function latestIndicatorSeries(payload) {
  const data = payload?.data ?? payload ?? {};

  const indicator = data?.indicators?.[0];

  const series = indicator?.series;

  if (
    !Array.isArray(series) ||
    series.length === 0
  ) {
    return null;
  }

  return series[series.length - 1];
}

/*
  =========================================================
  OPTIONS HELPERS
  =========================================================
*/

function getExpirationDates(chainPayload) {
  const data =
    chainPayload?.data ??
    chainPayload ??
    {};

  const chains = Array.isArray(data.chains)
    ? data.chains
    : [];

  const set = new Set();

  for (const chain of chains) {
    for (
      const expiration of
        chain.expiration_dates || []
    ) {
      set.add(expiration);
    }
  }

  return [...set].sort();
}

function getNearestExpiration(dates) {
  if (
    !Array.isArray(dates) ||
    dates.length === 0
  ) {
    return null;
  }

  const today = new Date();

  const todayText = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");

  return (
    dates.find((date) => date >= todayText) ??
    dates[0]
  );
}

function selectNearestStrikes(
  instruments,
  stockPrice,
  count = 3
) {
  if (
    !Array.isArray(instruments) ||
    stockPrice === null
  ) {
    return [];
  }

  const strikes = [
    ...new Set(
      instruments
        .map((item) =>
          toNumber(item.strike_price)
        )
        .filter((value) => value !== null)
    ),
  ];

  strikes.sort(
    (a, b) =>
      Math.abs(a - stockPrice) -
      Math.abs(b - stockPrice)
  );

  return strikes
    .slice(0, count)
    .sort((a, b) => a - b);
}

/*
  =========================================================
  FETCH ONE TICKER
  =========================================================
*/

async function fetchTicker(ticker) {
  const [
    quoteEnvelope,
    rsiEnvelope,
    macdEnvelope,
    chainEnvelope,
  ] = await Promise.all([
    fetchJson(
      `${PROXY_BASE}/robinhood/quote/${ticker}`
    ),

    fetchJson(
      `${PROXY_BASE}/robinhood/technical/${ticker}/rsi`
    ),

    fetchJson(
      `${PROXY_BASE}/robinhood/technical/${ticker}/macd`
    ),

    fetchJson(
      `${PROXY_BASE}/robinhood/options/${ticker}/chains`
    ).catch(() => null),
  ]);

  /*
    EQUITY QUOTE
  */

  const quotePayload = unwrapMcp(
    quoteEnvelope
  );

  const quoteData =
    quotePayload?.data ??
    quotePayload ??
    {};

  const quoteResult =
    quoteData?.results?.[0];

  const quote =
    quoteResult?.quote ?? {};

  const officialClose =
    quoteResult?.close ?? {};

  const current =
    selectCurrentPrice(quote);

  const previousClose = toNumber(
    quote.adjusted_previous_close ??
      officialClose.price ??
      quote.previous_close
  );

  const change =
    current.price !== null &&
    previousClose !== null
      ? current.price - previousClose
      : null;

  const changePct =
    change !== null &&
    previousClose
      ? (change / previousClose) * 100
      : null;

  /*
    RSI
  */

  const rsiPayload = unwrapMcp(
    rsiEnvelope
  );

  const rsiSeries =
    latestIndicatorSeries(rsiPayload);

  const rsi = toNumber(
    rsiSeries?.value
  );

  /*
    MACD
  */

  const macdPayload = unwrapMcp(
    macdEnvelope
  );

  const macdSeries =
    latestIndicatorSeries(macdPayload);

  const macd = {
    macd: toNumber(
      macdSeries?.macd
    ),

    signal: toNumber(
      macdSeries?.signal
    ),

    histogram: toNumber(
      macdSeries?.histogram
    ),
  };

  /*
    OPTIONS
  */

  let expiration = null;
  let contracts = [];
  let optionError = null;

  let atmIV = null;

  let callOI = 0;
  let putOI = 0;

  let callVolume = 0;
  let putVolume = 0;

  try {
    if (!chainEnvelope) {
      throw new Error(
        "No option chain returned"
      );
    }

    const chainPayload =
      unwrapMcp(chainEnvelope);

    const expirations =
      getExpirationDates(chainPayload);

    expiration =
      getNearestExpiration(
        expirations
      );

    if (!expiration) {
      throw new Error(
        "No active expiration found"
      );
    }

    const instrumentEnvelope =
      await fetchJson(
        `${PROXY_BASE}/robinhood/options/${ticker}/instruments?expiration=${encodeURIComponent(
          expiration
        )}`
      );

    const instrumentPayload =
      unwrapMcp(
        instrumentEnvelope
      );

    const instruments =
      instrumentPayload?.data?.instruments ??
      instrumentPayload?.instruments ??
      [];

    const nearestStrikes =
      selectNearestStrikes(
        instruments,
        current.price,
        3
      );

    const selected =
      instruments.filter(
        (instrument) =>
          nearestStrikes.includes(
            toNumber(
              instrument.strike_price
            )
          )
      );

    if (selected.length > 0) {
      const quoteBatch =
        await fetchJson(
          `${PROXY_BASE}/robinhood/options/quotes`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              instrument_ids:
                selected.map(
                  (instrument) =>
                    instrument.id
                ),
            }),
          }
        );

      const optionPayload =
        unwrapMcp(
          quoteBatch
        );

      const optionResults =
        optionPayload?.data?.results ??
        optionPayload?.results ??
        [];

      const quoteMap =
        new Map();

      for (const item of optionResults) {
        const optionQuote =
          item?.quote;

        if (
          optionQuote?.instrument_id
        ) {
          quoteMap.set(
            optionQuote.instrument_id,
            optionQuote
          );
        }
      }

      contracts =
        selected
          .map((instrument) => {
            const optionQuote =
              quoteMap.get(
                instrument.id
              ) ?? {};

            return {
              id:
                instrument.id,

              type:
                instrument.type,

              strike:
                toNumber(
                  instrument.strike_price
                ),

              expiration:
                instrument.expiration_date,

              bid:
                toNumber(
                  optionQuote.bid_price
                ),

              ask:
                toNumber(
                  optionQuote.ask_price
                ),

              mark:
                toNumber(
                  optionQuote.mark_price
                ),

              breakEven:
                toNumber(
                  optionQuote.break_even_price
                ),

              iv:
                toNumber(
                  optionQuote
                    .implied_volatility
                ),

              delta:
                toNumber(
                  optionQuote.delta
                ),

              gamma:
                toNumber(
                  optionQuote.gamma
                ),

              theta:
                toNumber(
                  optionQuote.theta
                ),

              vega:
                toNumber(
                  optionQuote.vega
                ),

              volume:
                toNumber(
                  optionQuote.volume
                ) ?? 0,

              openInterest:
                toNumber(
                  optionQuote.open_interest
                ) ?? 0,

              updatedAt:
                optionQuote.updated_at ??
                null,
            };
          })
          .sort((a, b) => {
            if (
              a.strike !==
              b.strike
            ) {
              return (
                a.strike -
                b.strike
              );
            }

            return a.type ===
              "call"
              ? -1
              : 1;
          });

      const closestStrike =
        nearestStrikes[0];

      const closestContracts =
        contracts.filter(
          (contract) =>
            contract.strike ===
            closestStrike
        );

      const ivs =
        closestContracts
          .map(
            (contract) =>
              contract.iv
          )
          .filter(
            (iv) =>
              iv !== null
          );

      if (ivs.length > 0) {
        atmIV =
          ivs.reduce(
            (sum, value) =>
              sum + value,
            0
          ) /
          ivs.length;
      }

      for (const contract of contracts) {
        if (
          contract.type === "call"
        ) {
          callOI +=
            contract.openInterest;

          callVolume +=
            contract.volume;
        }

        if (
          contract.type === "put"
        ) {
          putOI +=
            contract.openInterest;

          putVolume +=
            contract.volume;
        }
      }
    }
  } catch (error) {
    optionError =
      error.message;
  }

  const pcrOI =
    callOI > 0
      ? putOI / callOI
      : null;

  const pcrVolume =
    callVolume > 0
      ? putVolume /
        callVolume
      : null;

  return {
    ticker,

    price:
      current.price,

    priceTimestamp:
      current.timestamp,

    session:
      current.session,

    previousClose,

    change,

    changePct,

    bid:
      toNumber(
        quote.bid_price
      ),

    ask:
      toNumber(
        quote.ask_price
      ),

    quoteState:
      quote.state ?? null,

    rsi,

    rsiTimestamp:
      rsiSeries?.begins_at ??
      null,

    macd,

    expiration,

    atmIV,

    callOI,

    putOI,

    callVolume,

    putVolume,

    pcrOI,

    pcrVolume,

    contracts,

    optionError,

    raw: {
      quote:
        quotePayload,

      rsi:
        rsiPayload,

      macd:
        macdPayload,
    },
  };
}

/*
  =========================================================
  AI
  =========================================================
*/

async function askClaude(prompt) {
  const response =
    await fetchJson(
      `${PROXY_BASE}/anthropic`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            "claude-sonnet-4-6",

          max_tokens:
            1800,

          system:
            "Analyze the supplied market data only. Distinguish observed values from interpretation. Be concise. Do not invent missing data.",

          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

  const text =
    response?.content
      ?.map(
        (block) =>
          block.text
      )
      .filter(Boolean)
      .join("") ?? "";

  if (!text) {
    throw new Error(
      "AI returned no content"
    );
  }

  return text;
}

/*
  =========================================================
  UI HELPERS
  =========================================================
*/

function rsiLabel(rsi) {
  if (rsi === null) {
    return {
      text: "RSI N/A",
      className:
        "text-zinc-400 border-zinc-700 bg-zinc-800/40",
    };
  }

  if (rsi >= 70) {
    return {
      text:
        `RSI ${rsi.toFixed(
          1
        )} · Overbought`,

      className:
        "text-red-300 border-red-500/30 bg-red-500/10",
    };
  }

  if (rsi <= 30) {
    return {
      text:
        `RSI ${rsi.toFixed(
          1
        )} · Oversold`,

      className:
        "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    };
  }

  return {
    text:
      `RSI ${rsi.toFixed(
        1
      )}`,

    className:
      "text-zinc-200 border-zinc-600/40 bg-zinc-800/50",
  };
}

function macdLabel(macd) {
  if (
    macd?.histogram ===
      null ||
    macd?.histogram ===
      undefined
  ) {
    return {
      text: "MACD N/A",
      className:
        "text-zinc-400 border-zinc-700 bg-zinc-800/40",
    };
  }

  if (
    macd.histogram > 0
  ) {
    return {
      text:
        "MACD Bullish",

      className:
        "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    };
  }

  if (
    macd.histogram < 0
  ) {
    return {
      text:
        "MACD Bearish",

      className:
        "text-red-300 border-red-500/30 bg-red-500/10",
    };
  }

  return {
    text:
      "MACD Flat",

    className:
      "text-zinc-300 border-zinc-600 bg-zinc-800/50",
  };
}

function DataPill({
  text,
  className,
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-mono ${className}`}
    >
      {text}
    </span>
  );
}

function Stat({
  label,
  value,
  color = "text-zinc-100",
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
        {label}
      </div>

      <div
        className={`mt-0.5 text-xs font-mono ${color}`}
      >
        {value}
      </div>
    </div>
  );
}

/*
  =========================================================
  SMALL OPTIONS TABLE
  =========================================================
*/

function OptionsTable({
  contracts,
}) {
  if (
    !contracts?.length
  ) {
    return (
      <div className="text-[11px] text-zinc-500">
        No near-money option quotes.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500">
            <th className="py-1 text-left font-normal">
              Type
            </th>

            <th className="py-1 text-right font-normal">
              Strike
            </th>

            <th className="py-1 text-right font-normal">
              Bid
            </th>

            <th className="py-1 text-right font-normal">
              Ask
            </th>

            <th className="py-1 text-right font-normal">
              IV
            </th>

            <th className="py-1 text-right font-normal">
              Δ
            </th>

            <th className="py-1 text-right font-normal">
              Θ
            </th>

            <th className="py-1 text-right font-normal">
              Vol
            </th>
          </tr>
        </thead>

        <tbody>
          {contracts.map(
            (contract) => (
              <tr
                key={
                  contract.id
                }
                className="border-b border-zinc-900 text-zinc-300"
              >
                <td
                  className={`py-1 ${
                    contract.type ===
                    "call"
                      ? "text-emerald-300"
                      : "text-red-300"
                  }`}
                >
                  {contract.type ===
                  "call"
                    ? "CALL"
                    : "PUT"}
                </td>

                <td className="text-right">
                  {formatMoney(
                    contract.strike
                  )}
                </td>

                <td className="text-right">
                  {contract.bid !==
                  null
                    ? contract.bid.toFixed(
                        2
                      )
                    : "—"}
                </td>

                <td className="text-right">
                  {contract.ask !==
                  null
                    ? contract.ask.toFixed(
                        2
                      )
                    : "—"}
                </td>

                <td className="text-right">
                  {formatPercent(
                    contract.iv
                  )}
                </td>

                <td className="text-right">
                  {contract.delta !==
                  null
                    ? contract.delta.toFixed(
                        3
                      )
                    : "—"}
                </td>

                <td className="text-right">
                  {contract.theta !==
                  null
                    ? contract.theta.toFixed(
                        3
                      )
                    : "—"}
                </td>

                <td className="text-right">
                  {formatCompact(
                    contract.volume
                  )}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}

/*
  =========================================================
  TICKER CARD
  =========================================================
*/

function TickerCard({
  data,
  selected,
  onSelect,
  savedPlanCount = 0,
}) {
  const rsi =
    rsiLabel(
      data.rsi
    );

  const macd =
    macdLabel(
      data.macd
    );

  const positive =
    data.changePct !==
      null &&
    data.changePct >= 0;

  return (
    <div
      onClick={() =>
        onSelect(data)
      }
      className={`cursor-pointer rounded-xl border p-4 transition-all hover:scale-[1.005] ${
        selected
          ? "border-amber-400/70 bg-amber-400/[0.04] shadow-lg shadow-amber-400/5"
          : "border-zinc-800 bg-zinc-900/80 hover:border-zinc-600"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black font-mono">
              {data.ticker}
            </span>

            <span className="text-sm font-mono text-zinc-200">
              {formatMoney(
                data.price
              )}
            </span>
          </div>

          <div
            className={`mt-1 text-xs font-mono ${
              positive
                ? "text-emerald-300"
                : "text-red-300"
            }`}
          >
            {data.change !==
              null &&
            data.changePct !==
              null
              ? `${
                  data.change >=
                  0
                    ? "+"
                    : ""
                }${data.change.toFixed(
                  2
                )} (${formatSignedPercent(
                  data.changePct
                )})`
              : "Daily change unavailable"}
          </div>
        </div>

        <div className="text-[9px] uppercase tracking-widest text-zinc-500">
          {data.session ===
          "extended"
            ? "Extended"
            : "Regular"}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <DataPill
          text={rsi.text}
          className={
            rsi.className
          }
        />

        <DataPill
          text={macd.text}
          className={
            macd.className
          }
        />

        {data.expiration && (
          <DataPill
            text={`EXP ${formatDate(
              data.expiration
            )}`}
            className="border-amber-500/30 bg-amber-500/10 text-amber-300"
          />
        )}

        {savedPlanCount > 0 && (
          <DataPill
            text={`${savedPlanCount} SAVED PLAN${savedPlanCount === 1 ? "" : "S"}`}
            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          />
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat
          label="RSI 14"
          value={
            data.rsi !==
            null
              ? data.rsi.toFixed(
                  2
                )
              : "—"
          }
        />

        <Stat
          label="MACD Histogram"
          value={
            data.macd
              ?.histogram !==
              null &&
            data.macd
              ?.histogram !==
              undefined
              ? data.macd.histogram.toFixed(
                  3
                )
              : "—"
          }
          color={
            data.macd
              ?.histogram >
            0
              ? "text-emerald-300"
              : data.macd
                    ?.histogram <
                  0
                ? "text-red-300"
                : "text-zinc-100"
          }
        />

        <Stat
          label="ATM IV"
          value={
            formatPercent(
              data.atmIV
            )
          }
        />

        <Stat
          label="Near-ATM P/C Vol"
          value={
            data.pcrVolume !==
            null
              ? data.pcrVolume.toFixed(
                  2
                )
              : "—"
          }
        />
      </div>

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-zinc-400">
            Near-money options
          </span>

          <span className="text-[9px] text-zinc-500">
            {data.expiration
              ? formatDate(
                  data.expiration
                )
              : ""}
          </span>
        </div>

        {data.optionError ? (
          <div className="text-[10px] text-zinc-500">
            Options:{" "}
            {data.optionError}
          </div>
        ) : (
          <OptionsTable
            contracts={
              data.contracts
            }
          />
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat
          label="Near-ATM Call OI"
          value={
            formatCompact(
              data.callOI
            )
          }
          color="text-emerald-300"
        />

        <Stat
          label="Near-ATM Put OI"
          value={
            formatCompact(
              data.putOI
            )
          }
          color="text-red-300"
        />
      </div>

      <div className="mt-3 text-center text-[9px] uppercase tracking-widest text-zinc-600">
        Click for full option chain
      </div>
    </div>
  );
}

/*
  =========================================================
  SAVED PLANS SUMMARY
  =========================================================
*/

function SavedPlansSummary({
  plans,
  tickerData,
  onOpenTicker,
}) {
  const activeConditionCount =
    useMemo(
      () =>
        plans.reduce(
          (
            total,
            plan
          ) => {
            const liveData =
              tickerData.find(
                (item) =>
                  item.ticker ===
                  normalizeTicker(
                    plan?.ticker
                  )
              );

            return (
              total +
              buildPlanStatusConditions(
                plan,
                liveData
              ).length
            );
          },
          0
        ),
      [
        plans,
        tickerData,
      ]
    );
  const groups =
    useMemo(
      () => {
        const map =
          new Map();

        for (const plan of plans) {
          const ticker =
            normalizeTicker(
              plan?.ticker
            );

          if (!ticker) {
            continue;
          }

          if (
            !map.has(
              ticker
            )
          ) {
            map.set(
              ticker,
              []
            );
          }

          map.get(
            ticker
          ).push(
            plan
          );
        }

        return [
          ...map.entries(),
        ]
          .map(
            ([
              ticker,
              tickerPlans,
            ]) => ({
              ticker,

              plans:
                [...tickerPlans].sort(
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
            })
          )
          .sort(
            (a, b) =>
              a.ticker.localeCompare(
                b.ticker
              )
          );
      },
      [
        plans,
      ]
    );

  if (!plans.length) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-5 text-center">
        <div className="text-[10px] uppercase tracking-widest text-emerald-400">
          Saved strategy plans
        </div>

        <div className="mt-2 text-sm text-zinc-400">
          No saved plans yet.
        </div>

        <div className="mt-1 text-[10px] text-zinc-600">
          Open a ticker, build a manual spread, and use Save Current Plan.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-emerald-400">
            Saved strategy plans
          </div>

          <div className="mt-1 text-lg font-bold text-white">
            {plans.length} saved plan{plans.length === 1 ? "" : "s"} across{" "}
            {groups.length} ticker{groups.length === 1 ? "" : "s"}
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Saved snapshots with current stock, RSI, MACD, breakeven, and invalidation tracking. Open a ticker for current option-spread, OI-wall, and gamma tracking.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className={`rounded border px-2 py-1 text-[9px] uppercase tracking-widest ${
              activeConditionCount >
              0
                ? "border-amber-500/30 bg-amber-500/[0.05] text-amber-300"
                : "border-emerald-500/20 bg-emerald-500/[0.04] text-emerald-300"
            }`}
          >
            {activeConditionCount} active condition{activeConditionCount === 1 ? "" : "s"}
          </div>

          <div className="rounded border border-emerald-500/20 bg-emerald-500/[0.04] px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300">
            Browser saved
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {groups.map(
          (group) => {
            const liveData =
              tickerData.find(
                (item) =>
                  item.ticker ===
                  group.ticker
              ) ??
              null;

            return (
              <div
                key={
                  group.ticker
                }
                className="rounded-xl border border-zinc-800 bg-black/25 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xl font-black text-white">
                        {group.ticker}
                      </span>

                      <span className="font-mono text-sm text-zinc-300">
                        {liveData
                          ? formatMoney(
                              liveData.price
                            )
                          : "Not loaded"}
                      </span>
                    </div>

                    <div className="mt-1 text-[9px] uppercase tracking-widest text-emerald-400">
                      {group.plans.length} saved plan{group.plans.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={
                      !liveData
                    }
                    onClick={() =>
                      onOpenTicker(
                        group.ticker
                      )
                    }
                    className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-emerald-400/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Open ticker
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {group.plans.map(
                    (plan) => (
                      <div
                        key={
                          plan.id ||
                          plan.structureKey
                        }
                        className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div
                              className={`text-[9px] uppercase tracking-widest ${
                                plan.optionType ===
                                "call"
                                  ? "text-emerald-400"
                                  : "text-red-400"
                              }`}
                            >
                              {plan.optionType ===
                              "call"
                                ? "Call spread"
                                : "Put spread"}{" "}
                              ·{" "}
                              {formatDate(
                                plan.expiration
                              )}
                            </div>

                            <div className="mt-1 font-mono text-sm font-bold text-white">
                              {formatMoney(
                                plan.longStrike
                              )}
                              {" / "}
                              {formatMoney(
                                plan.shortStrike
                              )}
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                              Saved debit
                            </div>

                            <div className="font-mono text-xs text-amber-300">
                              {formatMoney(
                                plan.savedEntryDebit
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Stat
                            label="Saved Spot"
                            value={formatMoney(
                              plan.savedSpot
                            )}
                          />

                          <Stat
                            label="Breakeven"
                            value={formatMoney(
                              plan.breakeven
                            )}
                          />

                          <Stat
                            label="Max Loss"
                            value={
                              plan.maxLoss !==
                                null &&
                              plan.maxLoss !==
                                undefined
                                ? `${Math.round(
                                    plan.maxLoss
                                  )}`
                                : "—"
                            }
                            color="text-red-300"
                          />

                          <Stat
                            label="Max Profit"
                            value={
                              plan.maxProfit !==
                                null &&
                              plan.maxProfit !==
                                undefined
                                ? `${Math.round(
                                    plan.maxProfit
                                  )}`
                                : "—"
                            }
                            color="text-emerald-300"
                          />
                        </div>

                        <div className="mt-3 rounded-lg border border-sky-500/15 bg-sky-500/[0.025] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[9px] uppercase tracking-widest text-sky-400">
                              Current tracking
                            </div>

                            <div className="text-[9px] text-zinc-600">
                              {liveData
                                ? "Live scanner snapshot"
                                : "Ticker not loaded"}
                            </div>
                          </div>

                          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <Stat
                              label="Stock Since Saved"
                              value={
                                liveData
                                  ? formatSignedPercent(
                                      percentChangeFromSaved(
                                        plan.savedSpot,
                                        liveData.price
                                      )
                                    )
                                  : "—"
                              }
                              color="text-sky-300"
                            />

                            <Stat
                              label="RSI Change"
                              value={
                                liveData
                                  ? `${formatSignedNumber(
                                      numericDifference(
                                        plan.savedRsi,
                                        liveData.rsi
                                      ),
                                      1
                                    )} pts`
                                  : "—"
                              }
                            />

                            <Stat
                              label="MACD Hist Change"
                              value={
                                liveData
                                  ? formatSignedNumber(
                                      numericDifference(
                                        plan.savedMacdHistogram,
                                        liveData.macd?.histogram
                                      ),
                                      3
                                    )
                                  : "—"
                              }
                            />

                            <Stat
                              label="Spot vs Breakeven"
                              value={
                                liveData
                                  ? formatSignedPercent(
                                      percentChangeFromSaved(
                                        plan.breakeven,
                                        liveData.price
                                      )
                                    )
                                  : "—"
                              }
                            />
                          </div>

                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
                              <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                                Saved → Current
                              </div>

                              <div className="mt-1 text-[10px] text-zinc-400">
                                Spot{" "}
                                <span className="font-mono text-zinc-200">
                                  {formatMoney(
                                    plan.savedSpot
                                  )}{" "}
                                  →{" "}
                                  {liveData
                                    ? formatMoney(
                                        liveData.price
                                      )
                                    : "—"}
                                </span>
                                {" · "}
                                RSI{" "}
                                <span className="font-mono text-zinc-200">
                                  {plan.savedRsi !==
                                    null &&
                                  plan.savedRsi !==
                                    undefined
                                    ? Number(
                                        plan.savedRsi
                                      ).toFixed(
                                        1
                                      )
                                    : "—"}{" "}
                                  →{" "}
                                  {liveData?.rsi !==
                                    null &&
                                  liveData?.rsi !==
                                    undefined
                                    ? Number(
                                        liveData.rsi
                                      ).toFixed(
                                        1
                                      )
                                    : "—"}
                                </span>
                              </div>
                            </div>

                            <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
                              <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                                Invalidation Reference
                              </div>

                              <div className="mt-1 font-mono text-[10px] text-amber-300">
                                {plan.invalidationPrice !==
                                  null &&
                                plan.invalidationPrice !==
                                  undefined
                                  ? `${formatMoney(
                                      plan.invalidationPrice
                                    )} · ${
                                      liveData
                                        ? `${Math.abs(
                                            percentChangeFromSaved(
                                              liveData.price,
                                              plan.invalidationPrice
                                            ) ?? 0
                                          ).toFixed(
                                            2
                                          )}% ${
                                            Number(
                                              plan.invalidationPrice
                                            ) >=
                                            Number(
                                              liveData.price
                                            )
                                              ? "above"
                                              : "below"
                                          } spot`
                                        : "ticker not loaded"
                                    }`
                                  : "Not set"}
                              </div>
                            </div>
                          </div>
                        </div>

                        <PlanStatusConditions
                          plan={
                            plan
                          }
                          liveData={
                            liveData
                          }
                        />

                        {plan.notes && (
                          <div className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-zinc-500">
                            {plan.notes}
                          </div>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}

/*
  =========================================================
  TRADE ANALYTICS
  =========================================================
*/

function TradeAnalyticsPanel({
  analytics,
  loading,
  error,
  onRefresh,
  onDownload,
}) {
  const summary =
    analytics?.summary ??
    {};

  const breakdowns =
    analytics?.breakdowns ??
    {};

  const dataset =
    Array.isArray(
      analytics?.dataset
    )
      ? analytics.dataset
      : [];

  const dollar0 =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : `${n >= 0 ? "+" : "-"}${Math.abs(
            n
          ).toFixed(
            0
          )}`;
    };

  const percent1 =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : `${n.toFixed(
            1
          )}%`;
    };

  const number2 =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          );
    };

  const breakdownCards = [
    {
      key:
        "ticker",

      label:
        "By ticker",
    },

    {
      key:
        "option_type",

      label:
        "Call vs put",
    },

    {
      key:
        "entry_rsi",

      label:
        "Entry RSI",
    },

    {
      key:
        "entry_macd",

      label:
        "Entry MACD",
    },

    {
      key:
        "entry_iv",

      label:
        "Entry IV",
    },

    {
      key:
        "reward_risk",

      label:
        "Reward / risk",
    },

    {
      key:
        "exit_reason",

      label:
        "Exit reason",
    },

    {
      key:
        "holding_time",

      label:
        "Holding time",
    },
  ];

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-cyan-500/20 bg-cyan-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-cyan-400">
              Trade analytics
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Paper performance + model-ready dataset
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Closed paper trades only. Results are descriptive and do not establish future profitability.
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={
                onRefresh
              }
              disabled={
                loading
              }
              className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-300 disabled:opacity-40"
            >
              {loading
                ? "Refreshing..."
                : "Refresh analytics"}
            </button>

            <button
              type="button"
              onClick={
                onDownload
              }
              className="rounded border border-cyan-400/40 bg-cyan-400/[0.05] px-3 py-1.5 text-[9px] uppercase tracking-widest text-cyan-300"
            >
              Download dataset CSV
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Analytics error: {error}
          </div>
        )}

        {!error && (
          <>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
              {[
                {
                  label:
                    "Closed trades",

                  value:
                    summary.closed_trades ??
                    0,

                  className:
                    "text-white",
                },

                {
                  label:
                    "Win rate",

                  value:
                    percent1(
                      summary.win_rate
                    ),

                  className:
                    "text-sky-300",
                },

                {
                  label:
                    "Realized P/L",

                  value:
                    dollar0(
                      summary.cumulative_pl
                    ),

                  className:
                    toNumber(
                      summary.cumulative_pl
                    ) >
                    0
                      ? "text-emerald-300"
                      : toNumber(
                          summary.cumulative_pl
                        ) <
                        0
                        ? "text-red-300"
                        : "text-zinc-200",
                },

                {
                  label:
                    "Expectancy / trade",

                  value:
                    dollar0(
                      summary.expectancy_per_trade
                    ),

                  className:
                    "text-violet-300",
                },

                {
                  label:
                    "Profit factor",

                  value:
                    number2(
                      summary.profit_factor
                    ),

                  className:
                    "text-amber-300",
                },

                {
                  label:
                    "Max drawdown",

                  value:
                    dollar0(
                      summary.max_drawdown
                    ),

                  className:
                    "text-red-300",
                },

                {
                  label:
                    "Average winner",

                  value:
                    dollar0(
                      summary.average_winner
                    ),

                  className:
                    "text-emerald-300",
                },

                {
                  label:
                    "Average loser",

                  value:
                    dollar0(
                      summary.average_loser
                    ),

                  className:
                    "text-red-300",
                },

                {
                  label:
                    "Average MFE",

                  value:
                    dollar0(
                      summary.average_mfe
                    ),

                  className:
                    "text-emerald-300",
                },

                {
                  label:
                    "Average MAE",

                  value:
                    dollar0(
                      summary.average_mae
                    ),

                  className:
                    "text-red-300",
                },

                {
                  label:
                    "Avg slippage",

                  value:
                    dollar0(
                      summary.average_slippage
                    ),

                  className:
                    "text-amber-300",
                },

                {
                  label:
                    "Avg hold",

                  value:
                    toNumber(
                      summary.average_holding_minutes
                    ) !==
                    null
                      ? `${Math.round(
                          summary.average_holding_minutes
                        )}m`
                      : "—",

                  className:
                    "text-zinc-200",
                },
              ].map(
                (item) => (
                  <div
                    key={
                      item.label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {item.label}
                    </div>

                    <div className={`mt-1 font-mono text-sm font-bold ${item.className}`}>
                      {item.value}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-4 rounded-lg border border-violet-500/20 bg-violet-500/[0.025] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-violet-400">
                    Learning dataset
                  </div>

                  <div className="mt-1 text-sm font-bold text-white">
                    {dataset.length} closed trade row{dataset.length === 1 ? "" : "s"} available
                  </div>
                </div>

                <div className="rounded border border-violet-500/20 px-2 py-1 text-[9px] uppercase tracking-widest text-violet-300">
                  Dataset v{analytics?.dataset_version ?? 1}
                </div>
              </div>

              <div className="mt-2 text-[10px] leading-relaxed text-zinc-500">
                Each row contains entry market features, Greeks, IV, OI/gamma structure, execution quality, slippage, fees, MFE, MAE, holding time, exit reason, return, and realized P/L. A very small sample is useful for validating data collection, not for claiming a predictive model is profitable.
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              {breakdownCards.map(
                (card) => {
                  const rows =
                    Array.isArray(
                      breakdowns[
                        card.key
                      ]
                    )
                      ? breakdowns[
                          card.key
                        ]
                      : [];

                  return (
                    <div
                      key={
                        card.key
                      }
                      className="rounded-xl border border-zinc-800 bg-black/25 p-3"
                    >
                      <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                        {card.label}
                      </div>

                      {rows.length >
                      0 ? (
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-[9px] font-mono">
                            <thead>
                              <tr className="border-b border-zinc-800 text-zinc-600">
                                <th className="py-1.5 text-left">
                                  Group
                                </th>

                                <th className="py-1.5 text-right">
                                  N
                                </th>

                                <th className="py-1.5 text-right">
                                  Win%
                                </th>

                                <th className="py-1.5 text-right">
                                  P/L
                                </th>

                                <th className="py-1.5 text-right">
                                  Avg
                                </th>
                              </tr>
                            </thead>

                            <tbody>
                              {rows.map(
                                (row) => (
                                  <tr
                                    key={
                                      row.key
                                    }
                                    className="border-b border-zinc-900"
                                  >
                                    <td className="py-1.5 text-left text-zinc-300">
                                      {String(
                                        row.key
                                      ).replaceAll(
                                        "_",
                                        " "
                                      )}
                                    </td>

                                    <td className="py-1.5 text-right">
                                      {row.trades}
                                    </td>

                                    <td className="py-1.5 text-right">
                                      {percent1(
                                        row.win_rate
                                      )}
                                    </td>

                                    <td
                                      className={`py-1.5 text-right ${
                                        toNumber(
                                          row.total_pl
                                        ) >
                                        0
                                          ? "text-emerald-300"
                                          : toNumber(
                                              row.total_pl
                                            ) <
                                            0
                                            ? "text-red-300"
                                            : ""
                                      }`}
                                    >
                                      {dollar0(
                                        row.total_pl
                                      )}
                                    </td>

                                    <td className="py-1.5 text-right">
                                      {dollar0(
                                        row.average_pl
                                      )}
                                    </td>
                                  </tr>
                                )
                              )}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="mt-2 text-[9px] text-zinc-600">
                          No closed trades yet.
                        </div>
                      )}
                    </div>
                  );
                }
              )}
            </div>

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Model-ready rows
              </div>

              {dataset.length >
              0 ? (
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="min-w-[1250px] w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="px-3 py-2 text-left">
                          Ticker
                        </th>

                        <th className="px-3 py-2 text-left">
                          Structure
                        </th>

                        <th className="px-3 py-2 text-right">
                          RSI
                        </th>

                        <th className="px-3 py-2 text-right">
                          MACD Hist
                        </th>

                        <th className="px-3 py-2 text-right">
                          Mean IV
                        </th>

                        <th className="px-3 py-2 text-right">
                          Delta
                        </th>

                        <th className="px-3 py-2 text-right">
                          Theta
                        </th>

                        <th className="px-3 py-2 text-right">
                          R/R
                        </th>

                        <th className="px-3 py-2 text-right">
                          Slip
                        </th>

                        <th className="px-3 py-2 text-right">
                          MFE
                        </th>

                        <th className="px-3 py-2 text-right">
                          MAE
                        </th>

                        <th className="px-3 py-2 text-left">
                          Exit
                        </th>

                        <th className="px-3 py-2 text-right">
                          Return
                        </th>

                        <th className="px-3 py-2 text-right">
                          P/L
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {dataset
                        .slice(
                          -20
                        )
                        .reverse()
                        .map(
                          (row) => (
                            <tr
                              key={
                                row.id
                              }
                              className="border-b border-zinc-900"
                            >
                              <td className="px-3 py-2 text-left text-white">
                                {row.ticker}
                              </td>

                              <td className="px-3 py-2 text-left">
                                {formatMoney(
                                  row.long_strike
                                )}{" "}
                                /{" "}
                                {formatMoney(
                                  row.short_strike
                                )}{" "}
                                {String(
                                  row.option_type ??
                                  ""
                                ).toUpperCase()}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {toNumber(
                                  row.entry_rsi
                                ) !==
                                null
                                  ? Number(
                                      row.entry_rsi
                                    ).toFixed(
                                      1
                                    )
                                  : "—"}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatSignedNumber(
                                  row.entry_macd_histogram,
                                  3
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {toNumber(
                                  row.entry_mean_iv
                                ) !==
                                null
                                  ? `${(
                                      Number(
                                        row.entry_mean_iv
                                      ) *
                                      100
                                    ).toFixed(
                                      1
                                    )}%`
                                  : "—"}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatSignedNumber(
                                  row.entry_delta,
                                  3
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatSignedNumber(
                                  row.entry_theta,
                                  3
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {number2(
                                  row.reward_risk
                                )}
                              </td>

                              <td className="px-3 py-2 text-right text-amber-300">
                                {dollar0(
                                  row.total_slippage_dollars
                                )}
                              </td>

                              <td className="px-3 py-2 text-right text-emerald-300">
                                {dollar0(
                                  row.mfe
                                )}
                              </td>

                              <td className="px-3 py-2 text-right text-red-300">
                                {dollar0(
                                  row.mae
                                )}
                              </td>

                              <td className="px-3 py-2 text-left">
                                {String(
                                  row.exit_reason ??
                                  "unknown"
                                ).replaceAll(
                                  "_",
                                  " "
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {percent1(
                                  row.realized_return_pct
                                )}
                              </td>

                              <td
                                className={`px-3 py-2 text-right font-bold ${
                                  toNumber(
                                    row.realized_pl
                                  ) >
                                  0
                                    ? "text-emerald-300"
                                    : toNumber(
                                        row.realized_pl
                                      ) <
                                      0
                                      ? "text-red-300"
                                      : ""
                                }`}
                              >
                                {dollar0(
                                  row.realized_pl
                                )}
                              </td>
                            </tr>
                          )
                        )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
                  Close paper trades to populate the learning dataset.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  HISTORICAL BACKTEST
  =========================================================
*/

function HistoricalBacktestPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const trades =
    Array.isArray(
      result?.trades
    )
      ? result.trades
      : [];

  const chronological =
    result?.chronological_evaluation ??
    {};

  const pct =
    (
      value,
      digits = 2
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const plainPct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            digits
          ) +
          "%";
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  const curve =
    Array.isArray(
      result?.equity_curve
    )
      ? result.equity_curve
      : [];

  const chartWidth =
    920;

  const chartHeight =
    220;

  const chartPad =
    28;

  const curveValues =
    curve.map(
      (point) =>
        toNumber(
          point?.cumulative_return_pct
        ) ??
        0
    );

  const curveMin =
    curveValues.length
      ? Math.min(
          0,
          ...curveValues
        )
      : 0;

  const curveMax =
    curveValues.length
      ? Math.max(
          0,
          ...curveValues
        )
      : 1;

  const curveRange =
    Math.max(
      0.0001,
      curveMax -
      curveMin
    );

  const curvePath =
    curve
      .map(
        (
          point,
          index
        ) => {
          const x =
            chartPad +
            (
              index /
              Math.max(
                1,
                curve.length -
                  1
              )
            ) *
              (
                chartWidth -
                chartPad *
                  2
              );

          const value =
            toNumber(
              point?.cumulative_return_pct
            ) ??
            0;

          const y =
            chartHeight -
            chartPad -
            (
              (
                value -
                curveMin
              ) /
              curveRange
            ) *
              (
                chartHeight -
                chartPad *
                  2
              );

          return (
            index ===
            0
              ? "M "
              : "L "
          ) +
          x.toFixed(
            1
          ) +
          " " +
          y.toFixed(
            1
          );
        }
      )
      .join(
        " "
      );

  const zeroY =
    chartHeight -
    chartPad -
    (
      (
        0 -
        curveMin
      ) /
      curveRange
    ) *
      (
        chartHeight -
        chartPad *
          2
      );

  const splits = [
    {
      key:
        "train",

      label:
        "Early 60%",
    },

    {
      key:
        "validation",

      label:
        "Middle 20%",
    },

    {
      key:
        "test",

      label:
        "Recent 20%",
    },
  ];

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-blue-500/20 bg-blue-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-blue-400">
              Historical backtest
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Scanner momentum rule · historical directional proxy
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Real Robinhood daily stock bars, RSI(14), and MACD(12,26,9). Signals are evaluated after the close and entered at the next regular-session open.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            Underlying proxy · not options P/L
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Lookback
            </div>

            <select
              value={
                settings.lookbackDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    lookbackDays:
                      Number(
                        event.target.value
                      ),
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value={180}>
                6 months
              </option>

              <option value={365}>
                1 year
              </option>

              <option value={730}>
                2 years
              </option>

              <option value={1095}>
                3 years
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Hold sessions
            </div>

            <select
              value={
                settings.holdDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    holdDays:
                      Number(
                        event.target.value
                      ),
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {[1, 3, 5, 10, 20].map(
                (days) => (
                  <option
                    key={
                      days
                    }
                    value={
                      days
                    }
                  >
                    {days}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Friction bps
            </div>

            <input
              type="number"
              min="0"
              max="500"
              step="1"
              value={
                settings.costBps
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    costBps:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-black/25 p-3">
            <input
              type="checkbox"
              checked={
                settings.nonOverlapping
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    nonOverlapping:
                      event.target.checked,
                  })
                )
              }
            />

            <span>
              <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                No overlap
              </div>

              <div className="mt-1 text-[9px] text-zinc-600">
                One active same-ticker proxy trade.
              </div>
            </span>
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !settings.symbol
              }
              className="w-full rounded border border-blue-400/50 bg-blue-400/10 px-4 py-2.5 text-[10px] font-bold text-blue-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "RUNNING..."
                : connected
                  ? "RUN BACKTEST"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Backtest error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              <span className="font-bold text-amber-300">
                Methodology:
              </span>{" "}
              {result.methodology?.signal_rule}{" "}
              {result.methodology?.execution}{" "}
              <span className="text-amber-300">
                {result.methodology?.instrument}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                {
                  label:
                    "Trades",

                  value:
                    summary.trades ??
                    0,

                  color:
                    "text-white",
                },

                {
                  label:
                    "Win rate",

                  value:
                    plainPct(
                      summary.win_rate_pct
                    ),

                  color:
                    "text-sky-300",
                },

                {
                  label:
                    "Avg return",

                  value:
                    pct(
                      summary.average_return_pct
                    ),

                  color:
                    toNumber(
                      summary.average_return_pct
                    ) >
                    0
                      ? "text-emerald-300"
                      : "text-red-300",
                },

                {
                  label:
                    "Compounded",

                  value:
                    pct(
                      summary.compounded_return_pct
                    ),

                  color:
                    toNumber(
                      summary.compounded_return_pct
                    ) >
                    0
                      ? "text-emerald-300"
                      : "text-red-300",
                },

                {
                  label:
                    "Profit factor",

                  value:
                    ratio(
                      summary.profit_factor
                    ),

                  color:
                    "text-amber-300",
                },

                {
                  label:
                    "Max drawdown",

                  value:
                    pct(
                      summary.max_drawdown_pct
                    ),

                  color:
                    "text-red-300",
                },

                {
                  label:
                    "Avg MFE",

                  value:
                    pct(
                      summary.average_mfe_pct
                    ),

                  color:
                    "text-emerald-300",
                },

                {
                  label:
                    "Avg MAE",

                  value:
                    pct(
                      summary.average_mae_pct
                    ),

                  color:
                    "text-red-300",
                },
              ].map(
                (item) => (
                  <div
                    key={
                      item.label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {item.label}
                    </div>

                    <div
                      className={
                        "mt-1 font-mono text-sm font-bold " +
                        item.color
                      }
                    >
                      {item.value}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {[
                {
                  label:
                    "Bullish signals",

                  data:
                    result.by_direction?.bullish,

                  color:
                    "text-emerald-300",
                },

                {
                  label:
                    "Bearish signals",

                  data:
                    result.by_direction?.bearish,

                  color:
                    "text-red-300",
                },
              ].map(
                (side) => (
                  <div
                    key={
                      side.label
                    }
                    className="rounded-xl border border-zinc-800 bg-black/25 p-3"
                  >
                    <div
                      className={
                        "text-[9px] uppercase tracking-widest " +
                        side.color
                      }
                    >
                      {side.label}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat
                        label="Trades"
                        value={
                          side.data?.trades ??
                          0
                        }
                      />

                      <Stat
                        label="Win Rate"
                        value={plainPct(
                          side.data?.win_rate_pct
                        )}
                      />

                      <Stat
                        label="Avg Return"
                        value={pct(
                          side.data?.average_return_pct
                        )}
                      />

                      <Stat
                        label="Compounded"
                        value={pct(
                          side.data?.compounded_return_pct
                        )}
                      />
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Sequential proxy equity curve
                  </div>

                  <div className="mt-1 text-[9px] text-zinc-600">
                    Each signal contributes its net directional return sequentially. This is not account equity.
                  </div>
                </div>

                <div className="font-mono text-[10px] text-zinc-500">
                  {result.symbol} · {result.parameters?.hold_sessions} sessions · {result.parameters?.cost_bps} bps
                </div>
              </div>

              {curve.length >
              0 ? (
                <div className="mt-3 overflow-x-auto">
                  <svg
                    viewBox={
                      "0 0 " +
                      chartWidth +
                      " " +
                      chartHeight
                    }
                    className="h-[220px] min-w-[760px] w-full"
                  >
                    <line
                      x1={
                        chartPad
                      }
                      x2={
                        chartWidth -
                        chartPad
                      }
                      y1={
                        zeroY
                      }
                      y2={
                        zeroY
                      }
                      stroke="currentColor"
                      className="text-zinc-700"
                      strokeDasharray="5 5"
                    />

                    <path
                      d={
                        curvePath
                      }
                      fill="none"
                      stroke="currentColor"
                      className={
                        toNumber(
                          summary.compounded_return_pct
                        ) >=
                        0
                          ? "text-emerald-400"
                          : "text-red-400"
                      }
                      strokeWidth="3"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              ) : (
                <div className="mt-3 rounded border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
                  No qualifying historical signals were generated.
                </div>
              )}
            </div>

            <div className="mt-4">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-violet-400">
                Chronological stability check
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {splits.map(
                  (split) => {
                    const splitSummary =
                      chronological[
                        split.key
                      ]?.summary ??
                      {};

                    return (
                      <div
                        key={
                          split.key
                        }
                        className="rounded-xl border border-violet-500/15 bg-violet-500/[0.02] p-3"
                      >
                        <div className="text-[10px] font-bold text-violet-300">
                          {split.label}
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <Stat
                            label="Trades"
                            value={
                              splitSummary.trades ??
                              0
                            }
                          />

                          <Stat
                            label="Win Rate"
                            value={plainPct(
                              splitSummary.win_rate_pct
                            )}
                          />

                          <Stat
                            label="Avg Return"
                            value={pct(
                              splitSummary.average_return_pct
                            )}
                          />

                          <Stat
                            label="Compounded"
                            value={pct(
                              splitSummary.compounded_return_pct
                            )}
                          />

                          <Stat
                            label="Max DD"
                            value={pct(
                              splitSummary.max_drawdown_pct
                            )}
                          />

                          <Stat
                            label="Profit Factor"
                            value={ratio(
                              splitSummary.profit_factor
                            )}
                          />
                        </div>
                      </div>
                    );
                  }
                )}
              </div>

              <div className="mt-2 text-[9px] text-zinc-600">
                This checks the fixed rule across early, middle, and recent history. The later model phase will use genuine walk-forward fitting where each model sees only earlier data.
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Historical signal trades
                </div>

                <div className="text-[9px] text-zinc-600">
                  {trades.length} simulated signals
                </div>
              </div>

              {trades.length >
              0 ? (
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="min-w-[1200px] w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="px-3 py-2 text-left">
                          Signal
                        </th>

                        <th className="px-3 py-2 text-left">
                          Signal
                        </th>

                        <th className="px-3 py-2 text-left">
                          Entry
                        </th>

                        <th className="px-3 py-2 text-left">
                          Exit
                        </th>

                        <th className="px-3 py-2 text-right">
                          RSI
                        </th>

                        <th className="px-3 py-2 text-right">
                          MACD Hist
                        </th>

                        <th className="px-3 py-2 text-right">
                          Entry Px
                        </th>

                        <th className="px-3 py-2 text-right">
                          Exit Px
                        </th>

                        <th className="px-3 py-2 text-right">
                          Net Return
                        </th>

                        <th className="px-3 py-2 text-right">
                          MFE
                        </th>

                        <th className="px-3 py-2 text-right">
                          MAE
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {[...trades]
                        .slice(
                          -30
                        )
                        .reverse()
                        .map(
                          (trade) => (
                            <tr
                              key={
                                trade.id
                              }
                              className="border-b border-zinc-900"
                            >
                              <td
                                className={
                                  "px-3 py-2 text-left font-bold " +
                                  (
                                    trade.signal ===
                                    "bullish"
                                      ? "text-emerald-300"
                                      : "text-red-300"
                                  )
                                }
                              >
                                {String(
                                  trade.signal
                                ).toUpperCase()}
                              </td>

                              <td className="px-3 py-2 text-left">
                                {new Date(
                                  trade.signal_time
                                ).toLocaleDateString()}
                              </td>

                              <td className="px-3 py-2 text-left">
                                {new Date(
                                  trade.entry_time
                                ).toLocaleDateString()}
                              </td>

                              <td className="px-3 py-2 text-left">
                                {new Date(
                                  trade.exit_time
                                ).toLocaleDateString()}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {toNumber(
                                  trade.rsi
                                ) !==
                                null
                                  ? Number(
                                      trade.rsi
                                    ).toFixed(
                                      1
                                    )
                                  : "—"}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatSignedNumber(
                                  trade.macd_histogram,
                                  3
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatMoney(
                                  trade.entry_open
                                )}
                              </td>

                              <td className="px-3 py-2 text-right">
                                {formatMoney(
                                  trade.exit_close
                                )}
                              </td>

                              <td
                                className={
                                  "px-3 py-2 text-right font-bold " +
                                  (
                                    trade.net_return_pct >
                                    0
                                      ? "text-emerald-300"
                                      : trade.net_return_pct <
                                          0
                                        ? "text-red-300"
                                        : ""
                                  )
                                }
                              >
                                {pct(
                                  trade.net_return_pct
                                )}
                              </td>

                              <td className="px-3 py-2 text-right text-emerald-300">
                                {pct(
                                  trade.mfe_pct
                                )}
                              </td>

                              <td className="px-3 py-2 text-right text-red-300">
                                {pct(
                                  trade.mae_pct
                                )}
                              </td>
                            </tr>
                          )
                        )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
                  No trades generated for these settings.
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              This backtest avoids same-day lookahead by entering on the next session open. It still does not replay historical option premiums, IV, Greeks, option bid/ask spreads, assignment, or actual debit-spread fills. Use it to test directional signal stability before the historical-option replay layer.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  BACKTEST RESEARCH LAB
  =========================================================
*/

function BacktestResearchLabPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const selected =
    result?.selected_candidate ??
    null;

  const baseline =
    result?.baseline ??
    null;

  const topCandidates =
    Array.isArray(
      result?.top_candidates
    )
      ? result.top_candidates
      : [];

  const frictionSensitivity =
    Array.isArray(
      result?.selected_candidate_friction_sensitivity
    )
      ? result.selected_candidate_friction_sensitivity
      : [];

  const tickerTest =
    Array.isArray(
      result?.selected_candidate_test_by_ticker
    )
      ? result.selected_candidate_test_by_ticker
      : [];

  const pct =
    (
      value,
      digits = 2
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const plainPct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            digits
          ) +
          "%";
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function directionLabel(
    value
  ) {
    if (
      value ===
      "bullish_only"
    ) {
      return "Bullish only";
    }

    if (
      value ===
      "bearish_only"
    ) {
      return "Bearish only";
    }

    return "Both directions";
  }

  function SplitCard({
    label,
    summary,
    accent,
  }) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
        <div
          className={
            "text-[10px] font-bold " +
            accent
          }
        >
          {label}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat
            label="Trades"
            value={
              summary?.trades ??
              0
            }
          />

          <Stat
            label="Win Rate"
            value={plainPct(
              summary?.win_rate_pct
            )}
          />

          <Stat
            label="Avg Return"
            value={pct(
              summary?.average_return_pct
            )}
          />

          <Stat
            label="Compounded"
            value={pct(
              summary?.compounded_return_pct
            )}
          />

          <Stat
            label="Profit Factor"
            value={ratio(
              summary?.profit_factor
            )}
          />

          <Stat
            label="Max DD"
            value={pct(
              summary?.max_drawdown_pct
            )}
          />
        </div>
      </div>
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-fuchsia-400">
              Backtest research lab
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Parameter research with an untouched recent test window
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Searches direction, hold period, RSI thresholds, and signal strength using earlier data. The recent 20% is not used to select the candidate.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            Research only · underlying proxy
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Scope
            </div>

            <select
              value={
                settings.scope
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    scope:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="selected">
                One ticker
              </option>

              <option value="all">
                All scanner tickers
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              disabled={
                settings.scope ===
                "all"
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white disabled:opacity-40"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Lookback
            </div>

            <select
              value={
                settings.lookbackDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    lookbackDays:
                      Number(
                        event.target.value
                      ),
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value={365}>
                1 year
              </option>

              <option value={730}>
                2 years
              </option>

              <option value={1095}>
                3 years
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Base friction bps
            </div>

            <input
              type="number"
              min="0"
              max="500"
              step="1"
              value={
                settings.costBps
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    costBps:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !tickers.length
              }
              className="w-full rounded border border-fuchsia-400/50 bg-fuchsia-400/10 px-4 py-2.5 text-[10px] font-bold text-fuchsia-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "RUNNING RESEARCH..."
                : connected
                  ? "RUN RESEARCH LAB"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[9px] text-zinc-500">
          <input
            type="checkbox"
            checked={
              settings.nonOverlapping
            }
            onChange={(
              event
            ) =>
              setSettings(
                (current) => ({
                  ...current,

                  nonOverlapping:
                    event.target.checked,
                })
              )
            }
          />

          Prevent overlapping same-ticker proxy trades.
        </label>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Research error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              Tested{" "}
              <span className="font-mono text-zinc-200">
                {result.search_space?.variant_count ?? 0}
              </span>{" "}
              variants across{" "}
              <span className="font-mono text-zinc-200">
                {result.symbols?.length ?? 0}
              </span>{" "}
              ticker{result.symbols?.length === 1 ? "" : "s"}.{" "}
              {result.search_space?.selection_rule}
            </div>

            {selected ? (
              <div className="mt-4 rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/[0.035] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-fuchsia-400">
                      Validation-selected candidate
                    </div>

                    <div className="mt-1 text-base font-bold text-white">
                      {directionLabel(
                        selected.parameters?.direction_mode
                      )} · {selected.parameters?.hold_sessions} sessions · RSI {selected.parameters?.rsi_profile} · {selected.parameters?.required_signals}/3 signals
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-500">
                      Selection score {toNumber(
                        selected.validation_score
                      ) !== null
                        ? Number(
                            selected.validation_score
                          ).toFixed(
                            3
                          )
                        : "—"} · test results were not used to choose this row.
                    </div>
                  </div>

                  <div className="rounded border border-violet-500/30 bg-violet-500/[0.05] px-2 py-1 text-[9px] uppercase tracking-widest text-violet-300">
                    Holdout test preserved
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <SplitCard
                    label="Training · early 60%"
                    summary={
                      selected.train
                    }
                    accent="text-zinc-300"
                  />

                  <SplitCard
                    label="Validation · middle 20%"
                    summary={
                      selected.validation
                    }
                    accent="text-fuchsia-300"
                  />

                  <SplitCard
                    label="Untouched test · recent 20%"
                    summary={
                      selected.test
                    }
                    accent="text-amber-300"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[10px] text-amber-300">
                No candidate had enough training and validation trades to qualify for selection.
              </div>
            )}

            {baseline && (
              <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Current-rule baseline
                </div>

                <div className="mt-1 text-[10px] text-zinc-400">
                  Both directions · 5 sessions · RSI 55/45 · 2 of 3 signals
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Validation Avg"
                    value={pct(
                      baseline.validation?.average_return_pct
                    )}
                  />

                  <Stat
                    label="Validation PF"
                    value={ratio(
                      baseline.validation?.profit_factor
                    )}
                  />

                  <Stat
                    label="Test Avg"
                    value={pct(
                      baseline.test?.average_return_pct
                    )}
                  />

                  <Stat
                    label="Test Compounded"
                    value={pct(
                      baseline.test?.compounded_return_pct
                    )}
                  />
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Top validation candidates
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1200px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-left">
                        Direction
                      </th>

                      <th className="px-3 py-2 text-right">
                        Hold
                      </th>

                      <th className="px-3 py-2 text-right">
                        RSI
                      </th>

                      <th className="px-3 py-2 text-right">
                        Signals
                      </th>

                      <th className="px-3 py-2 text-right">
                        Train N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test DD
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {topCandidates.map(
                      (candidate) => (
                        <tr
                          key={
                            candidate.id
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-left">
                            {directionLabel(
                              candidate.parameters?.direction_mode
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.hold_sessions}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.rsi_profile}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.required_signals}/3
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.train?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.validation?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right text-fuchsia-300">
                            {pct(
                              candidate.validation?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.validation?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.test?.trades ?? 0}
                          </td>

                          <td
                            className={
                              "px-3 py-2 text-right " +
                              (
                                toNumber(
                                  candidate.test?.average_return_pct
                                ) >
                                0
                                  ? "text-emerald-300"
                                  : "text-red-300"
                              )
                            }
                          >
                            {pct(
                              candidate.test?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.test?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {pct(
                              candidate.test?.max_drawdown_pct
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {frictionSensitivity.length >
              0 && (
              <div className="mt-5 grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Selected candidate · friction sensitivity
                  </div>

                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-[9px] font-mono">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-600">
                          <th className="py-1.5 text-left">
                            Bps
                          </th>

                          <th className="py-1.5 text-right">
                            Val Avg
                          </th>

                          <th className="py-1.5 text-right">
                            Test Avg
                          </th>

                          <th className="py-1.5 text-right">
                            Test PF
                          </th>

                          <th className="py-1.5 text-right">
                            Test DD
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {frictionSensitivity.map(
                          (row) => (
                            <tr
                              key={
                                row.cost_bps
                              }
                              className="border-b border-zinc-900"
                            >
                              <td className="py-1.5 text-left">
                                {row.cost_bps}
                              </td>

                              <td className="py-1.5 text-right">
                                {pct(
                                  row.validation?.average_return_pct
                                )}
                              </td>

                              <td className="py-1.5 text-right">
                                {pct(
                                  row.test?.average_return_pct
                                )}
                              </td>

                              <td className="py-1.5 text-right">
                                {ratio(
                                  row.test?.profit_factor
                                )}
                              </td>

                              <td className="py-1.5 text-right text-red-300">
                                {pct(
                                  row.test?.max_drawdown_pct
                                )}
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Selected candidate · recent test by ticker
                  </div>

                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-[9px] font-mono">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-600">
                          <th className="py-1.5 text-left">
                            Ticker
                          </th>

                          <th className="py-1.5 text-right">
                            N
                          </th>

                          <th className="py-1.5 text-right">
                            Win%
                          </th>

                          <th className="py-1.5 text-right">
                            Avg
                          </th>

                          <th className="py-1.5 text-right">
                            PF
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {tickerTest.map(
                          (row) => (
                            <tr
                              key={
                                row.symbol
                              }
                              className="border-b border-zinc-900"
                            >
                              <td className="py-1.5 text-left text-white">
                                {row.symbol}
                              </td>

                              <td className="py-1.5 text-right">
                                {row.summary?.trades ?? 0}
                              </td>

                              <td className="py-1.5 text-right">
                                {plainPct(
                                  row.summary?.win_rate_pct
                                )}
                              </td>

                              <td className="py-1.5 text-right">
                                {pct(
                                  row.summary?.average_return_pct
                                )}
                              </td>

                              <td className="py-1.5 text-right">
                                {ratio(
                                  row.summary?.profit_factor
                                )}
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Do not keep changing parameters after seeing the recent test result. Repeatedly tuning to the holdout turns it into training data and defeats the purpose of the test. This lab still tests underlying directional returns, not historical option-spread P/L.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  WALK-FORWARD LAB
  =========================================================
*/

function WalkForwardLabPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const selectedOos =
    summary.selected_oos ??
    {};

  const baselineOos =
    summary.baseline_oos ??
    {};

  const folds =
    Array.isArray(
      result?.folds
    )
      ? result.folds
      : [];

  const selectionFrequency =
    Array.isArray(
      result?.selection_frequency
    )
      ? result.selection_frequency
      : [];

  const byTicker =
    Array.isArray(
      result?.selected_oos_by_ticker
    )
      ? result.selected_oos_by_ticker
      : [];

  const robustnessGate =
    result?.robustness_gate ??
    null;

  const learningDataset =
    Array.isArray(
      result?.oos_learning_dataset
    )
      ? result.oos_learning_dataset
      : [];

  const pct =
    (
      value,
      digits = 2
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const plainPct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            digits
          ) +
          "%";
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function directionLabel(
    value
  ) {
    if (
      value ===
      "bullish_only"
    ) {
      return "Bullish only";
    }

    if (
      value ===
      "bearish_only"
    ) {
      return "Bearish only";
    }

    return "Both";
  }

  function downloadOosDataset() {
    if (!learningDataset.length) {
      return;
    }

    const headers =
      Object.keys(
        learningDataset[0]
      );

    const esc =
      (value) => {
        if (
          value === null ||
          value === undefined
        ) {
          return "";
        }

        const text =
          String(value);

        if (
          text.includes(",") ||
          text.includes('"') ||
          text.includes("\n")
        ) {
          return (
            '"' +
            text.replaceAll(
              '"',
              '""'
            ) +
            '"'
          );
        }

        return text;
      };

    const csv = [
      headers.join(","),
      ...learningDataset.map(
        (row) =>
          headers
            .map(
              (header) =>
                esc(
                  row[header]
                )
            )
            .join(",")
      ),
    ].join("\n");

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      "walk-forward-oos-learning-dataset.csv";

    document.body.appendChild(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-emerald-400">
              Walk-forward research
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Re-select on past data, then test on the next unseen block
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Each fold chooses a rule from training + validation history only. The next test window remains unseen until after selection.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            Expanding walk-forward · underlying proxy
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Scope
            </div>

            <select
              value={
                settings.scope
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    scope:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="selected">
                One ticker
              </option>

              <option value="all">
                All scanner tickers
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              disabled={
                settings.scope ===
                "all"
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white disabled:opacity-40"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Lookback
            </div>

            <select
              value={
                settings.lookbackDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    lookbackDays:
                      Number(
                        event.target.value
                      ),
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value={730}>
                2 years
              </option>

              <option value={1095}>
                3 years
              </option>

              <option value={1460}>
                4 years
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Initial train days
            </div>

            <input
              type="number"
              min="180"
              step="30"
              value={
                settings.trainDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    trainDays:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Validation days
            </div>

            <input
              type="number"
              min="30"
              step="15"
              value={
                settings.validationDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    validationDays:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Test days
            </div>

            <input
              type="number"
              min="20"
              step="10"
              value={
                settings.testDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    testDays:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Friction bps
            </div>

            <input
              type="number"
              min="0"
              max="500"
              step="1"
              value={
                settings.costBps
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    costBps:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !tickers.length
              }
              className="w-full rounded border border-emerald-400/50 bg-emerald-400/10 px-4 py-2.5 text-[10px] font-bold text-emerald-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "RUNNING WALK-FORWARD..."
                : connected
                  ? "RUN WALK-FORWARD"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[9px] text-zinc-500">
          <input
            type="checkbox"
            checked={
              settings.nonOverlapping
            }
            onChange={(
              event
            ) =>
              setSettings(
                (current) => ({
                  ...current,

                  nonOverlapping:
                    event.target.checked,
                })
              )
            }
          />

          Prevent overlapping same-ticker proxy trades.
        </label>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Walk-forward error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.selection}{" "}
              {result.methodology?.rolling}{" "}
              <span className="text-amber-300">
                {result.methodology?.caution}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                {
                  label:
                    "Folds",

                  value:
                    summary.completed_folds ??
                    0,

                  color:
                    "text-white",
                },

                {
                  label:
                    "Positive folds",

                  value:
                    plainPct(
                      summary.positive_test_fold_rate
                    ),

                  color:
                    "text-sky-300",
                },

                {
                  label:
                    "OOS trades",

                  value:
                    selectedOos.trades ??
                    0,

                  color:
                    "text-white",
                },

                {
                  label:
                    "OOS avg return",

                  value:
                    pct(
                      selectedOos.average_return_pct
                    ),

                  color:
                    toNumber(
                      selectedOos.average_return_pct
                    ) >
                    0
                      ? "text-emerald-300"
                      : "text-red-300",
                },

                {
                  label:
                    "OOS compounded",

                  value:
                    pct(
                      selectedOos.compounded_return_pct
                    ),

                  color:
                    toNumber(
                      selectedOos.compounded_return_pct
                    ) >
                    0
                      ? "text-emerald-300"
                      : "text-red-300",
                },

                {
                  label:
                    "OOS profit factor",

                  value:
                    ratio(
                      selectedOos.profit_factor
                    ),

                  color:
                    "text-amber-300",
                },

                {
                  label:
                    "OOS max DD",

                  value:
                    pct(
                      selectedOos.max_drawdown_pct
                    ),

                  color:
                    "text-red-300",
                },

                {
                  label:
                    "Baseline OOS avg",

                  value:
                    pct(
                      baselineOos.average_return_pct
                    ),

                  color:
                    "text-violet-300",
                },
              ].map(
                (item) => (
                  <div
                    key={
                      item.label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {item.label}
                    </div>

                    <div
                      className={
                        "mt-1 font-mono text-sm font-bold " +
                        item.color
                      }
                    >
                      {item.value}
                    </div>
                  </div>
                )
              )}
            </div>

            {robustnessGate && (
              <div className={
                robustnessGate.status === "pass"
                  ? "mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
                  : "mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.03] p-4"
              }>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className={
                      robustnessGate.status === "pass"
                        ? "text-[9px] uppercase tracking-widest text-emerald-400"
                        : "text-[9px] uppercase tracking-widest text-red-400"
                    }>
                      Research robustness gate
                    </div>

                    <div className="mt-1 text-sm font-bold text-white">
                      {robustnessGate.status === "pass"
                        ? "Historical proxy passed all robustness checks"
                        : "Historical proxy still fails one or more robustness checks"}
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-600">
                      {robustnessGate.passed_count}/{robustnessGate.total_checks} checks passed.
                    </div>
                  </div>

                  <div className={
                    robustnessGate.status === "pass"
                      ? "rounded border border-emerald-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300"
                      : "rounded border border-red-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-red-300"
                  }>
                    {String(robustnessGate.status).toUpperCase()}
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {(robustnessGate.checks ?? []).map(
                    (check) => (
                      <div
                        key={check.id}
                        className={
                          check.passed
                            ? "rounded-lg border border-emerald-500/15 bg-emerald-500/[0.02] p-3"
                            : "rounded-lg border border-red-500/20 bg-red-500/[0.03] p-3"
                        }
                      >
                        <div className={
                          check.passed
                            ? "text-[9px] uppercase tracking-widest text-emerald-400"
                            : "text-[9px] uppercase tracking-widest text-red-400"
                        }>
                          {check.passed ? "PASS" : "FAIL"} · {check.label}
                        </div>

                        <div className="mt-1 font-mono text-xs text-zinc-200">
                          {typeof check.actual === "number"
                            ? check.actual.toFixed(2)
                            : check.actual ?? "—"}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-600">
                          Target {check.threshold}
                        </div>
                      </div>
                    )
                  )}
                </div>

                <div className="mt-3 text-[9px] text-zinc-600">
                  {robustnessGate.note}
                </div>
              </div>
            )}

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.025] p-3">
                <div className="text-[9px] uppercase tracking-widest text-emerald-400">
                  Selected-rule unseen performance
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat
                    label="Win Rate"
                    value={plainPct(
                      selectedOos.win_rate_pct
                    )}
                  />

                  <Stat
                    label="Avg Return"
                    value={pct(
                      selectedOos.average_return_pct
                    )}
                  />

                  <Stat
                    label="Compounded"
                    value={pct(
                      selectedOos.compounded_return_pct
                    )}
                  />

                  <Stat
                    label="Profit Factor"
                    value={ratio(
                      selectedOos.profit_factor
                    )}
                  />

                  <Stat
                    label="Max DD"
                    value={pct(
                      selectedOos.max_drawdown_pct
                    )}
                  />

                  <Stat
                    label="Avg Hold"
                    value={
                      toNumber(
                        selectedOos.average_hold_sessions
                      ) !==
                      null
                        ? Number(
                            selectedOos.average_hold_sessions
                          ).toFixed(
                            1
                          )
                        : "—"
                    }
                  />
                </div>
              </div>

              <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.025] p-3">
                <div className="text-[9px] uppercase tracking-widest text-violet-400">
                  Fixed baseline unseen performance
                </div>

                <div className="mt-1 text-[9px] text-zinc-600">
                  Both directions · 5 sessions · RSI 55/45 · 2/3 signals
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat
                    label="Trades"
                    value={
                      baselineOos.trades ??
                      0
                    }
                  />

                  <Stat
                    label="Win Rate"
                    value={plainPct(
                      baselineOos.win_rate_pct
                    )}
                  />

                  <Stat
                    label="Avg Return"
                    value={pct(
                      baselineOos.average_return_pct
                    )}
                  />

                  <Stat
                    label="Compounded"
                    value={pct(
                      baselineOos.compounded_return_pct
                    )}
                  />

                  <Stat
                    label="Profit Factor"
                    value={ratio(
                      baselineOos.profit_factor
                    )}
                  />

                  <Stat
                    label="Max DD"
                    value={pct(
                      baselineOos.max_drawdown_pct
                    )}
                  />
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Fold-by-fold unseen results
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1500px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">
                        Fold
                      </th>

                      <th className="px-3 py-2 text-left">
                        Test Window
                      </th>

                      <th className="px-3 py-2 text-left">
                        Selected
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test DD
                      </th>

                      <th className="px-3 py-2 text-right">
                        Baseline Avg
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {folds.map(
                      (fold) => {
                        const candidate =
                          fold.selected_candidate;

                        const params =
                          candidate?.parameters;

                        return (
                          <tr
                            key={
                              fold.fold
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="px-3 py-2 text-right">
                              {fold.fold}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {new Date(
                                fold.test_start
                              ).toLocaleDateString()}{" "}
                              →{" "}
                              {new Date(
                                fold.test_end
                              ).toLocaleDateString()}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {candidate
                                ? directionLabel(
                                    params?.direction_mode
                                  ) +
                                  " · " +
                                  params?.hold_sessions +
                                  "d · RSI " +
                                  params?.rsi_profile +
                                  " · " +
                                  params?.required_signals +
                                  "/3"
                                : "No eligible candidate"}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {candidate?.validation?.trades ?? 0}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                candidate?.validation?.average_return_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {ratio(
                                candidate?.validation?.profit_factor
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {candidate?.test?.trades ?? 0}
                            </td>

                            <td
                              className={
                                "px-3 py-2 text-right " +
                                (
                                  toNumber(
                                    candidate?.test?.average_return_pct
                                  ) >
                                  0
                                    ? "text-emerald-300"
                                    : "text-red-300"
                                )
                              }
                            >
                              {pct(
                                candidate?.test?.average_return_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {ratio(
                                candidate?.test?.profit_factor
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-red-300">
                              {pct(
                                candidate?.test?.max_drawdown_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-violet-300">
                              {pct(
                                fold.baseline_test?.average_return_pct
                              )}
                            </td>
                          </tr>
                        );
                      }
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Strategy selection frequency
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="py-1.5 text-left">
                          Strategy
                        </th>

                        <th className="py-1.5 text-right">
                          Folds
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {selectionFrequency.map(
                        (row) => (
                          <tr
                            key={
                              row.id
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="py-1.5 text-left">
                              {directionLabel(
                                row.parameters?.direction_mode
                              )}{" "}
                              · {row.parameters?.hold_sessions}d · RSI {row.parameters?.rsi_profile} · {row.parameters?.required_signals}/3
                            </td>

                            <td className="py-1.5 text-right text-fuchsia-300">
                              {row.count}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Unseen selected-rule performance by ticker
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="py-1.5 text-left">
                          Ticker
                        </th>

                        <th className="py-1.5 text-right">
                          N
                        </th>

                        <th className="py-1.5 text-right">
                          Win%
                        </th>

                        <th className="py-1.5 text-right">
                          Avg
                        </th>

                        <th className="py-1.5 text-right">
                          PF
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {byTicker.map(
                        (row) => (
                          <tr
                            key={
                              row.symbol
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="py-1.5 text-left text-white">
                              {row.symbol}
                            </td>

                            <td className="py-1.5 text-right">
                              {row.summary?.trades ?? 0}
                            </td>

                            <td className="py-1.5 text-right">
                              {plainPct(
                                row.summary?.win_rate_pct
                              )}
                            </td>

                            <td className="py-1.5 text-right">
                              {pct(
                                row.summary?.average_return_pct
                              )}
                            </td>

                            <td className="py-1.5 text-right">
                              {ratio(
                                row.summary?.profit_factor
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.025] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-cyan-400">
                    Out-of-sample learning dataset
                  </div>

                  <div className="mt-1 text-sm font-bold text-white">
                    {learningDataset.length} unseen row{learningDataset.length === 1 ? "" : "s"} available
                  </div>
                </div>

                <button
                  type="button"
                  onClick={
                    downloadOosDataset
                  }
                  disabled={
                    !learningDataset.length
                  }
                  className="rounded border border-cyan-400/40 px-3 py-1.5 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
                >
                  Download CSV
                </button>
              </div>

              <div className="mt-2 text-[9px] leading-relaxed text-zinc-500">
                Each row comes only from an unseen walk-forward test window and carries the ticker, selected rule, fold number, RSI, MACD, signal scores, entry and exit prices, MFE, MAE, friction, and realized directional return.
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Walk-forward results are stronger evidence than a single train/validation/test split, but they are still historical proxy results. We should require repeated positive unseen folds, adequate trade counts, manageable drawdown, and cross-ticker consistency before treating a rule as a candidate for live review.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  RISK-OVERLAY WALK-FORWARD
  =========================================================
*/

function RiskOverlayWalkForwardPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const protectedOos =
    summary.protected_oos ??
    {};

  const unprotectedOos =
    summary.unprotected_oos ??
    {};

  const folds =
    Array.isArray(
      result?.folds
    )
      ? result.folds
      : [];

  const overlayFrequency =
    Array.isArray(
      result?.overlay_selection_frequency
    )
      ? result.overlay_selection_frequency
      : [];

  const byTicker =
    Array.isArray(
      result?.protected_oos_by_ticker
    )
      ? result.protected_oos_by_ticker
      : [];

  const gate =
    result?.robustness_gate ??
    null;

  const dataset =
    Array.isArray(
      result?.protected_oos_dataset
    )
      ? result.protected_oos_dataset
      : [];

  const pct =
    (
      value,
      digits = 2
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const plainPct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            digits
          ) +
          "%";
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function overlayLabel(
    params
  ) {
    if (!params) {
      return "—";
    }

    return (
      "Stop " +
      params.stopLossPct +
      "% · Target " +
      (
        params.profitTargetPct ===
        null
          ? "None"
          : params.profitTargetPct +
            "%"
      ) +
      " · Hold ≤" +
      params.maxHoldSessions +
      " · Risk " +
      params.riskBudgetPct +
      "%"
    );
  }

  function downloadDataset() {
    if (!dataset.length) {
      return;
    }

    const headers =
      Object.keys(
        dataset[0]
      );

    const escape =
      (value) => {
        if (
          value ===
            null ||
          value ===
            undefined
        ) {
          return "";
        }

        const text =
          String(
            value
          );

        if (
          text.includes(",") ||
          text.includes('"') ||
          text.includes("\n")
        ) {
          return (
            '"' +
            text.replaceAll(
              '"',
              '""'
            ) +
            '"'
          );
        }

        return text;
      };

    const csv = [
      headers.join(","),
      ...dataset.map(
        (row) =>
          headers
            .map(
              (header) =>
                escape(
                  row[
                    header
                  ]
                )
            )
            .join(",")
      ),
    ].join("\n");

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      "risk-overlay-walk-forward-oos.csv";

    document.body.appendChild(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-amber-500/20 bg-amber-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-amber-400">
              Risk-overlay walk-forward
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Select the signal rule first, then select risk controls using prior validation data only
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Tests stop loss, profit target, maximum hold, and position-risk budget without using the next unseen test window for selection.
            </div>
          </div>

          <button
            type="button"
            onClick={
              downloadDataset
            }
            disabled={
              !dataset.length
            }
            className="rounded border border-cyan-400/40 px-3 py-2 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
          >
            Download protected OOS CSV
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Scope
            </div>

            <select
              value={
                settings.scope
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    scope:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="selected">
                One ticker
              </option>

              <option value="all">
                All scanner tickers
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              disabled={
                settings.scope ===
                "all"
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white disabled:opacity-40"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          {[
            {
              key:
                "lookbackDays",

              label:
                "Lookback days",
            },

            {
              key:
                "trainDays",

              label:
                "Train days",
            },

            {
              key:
                "validationDays",

              label:
                "Validation days",
            },

            {
              key:
                "testDays",

              label:
                "Test days",
            },

            {
              key:
                "costBps",

              label:
                "Friction bps",
            },
          ].map(
            (field) => (
              <label
                key={
                  field.key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  {field.label}
                </div>

                <input
                  type="number"
                  min="0"
                  value={
                    settings[
                      field.key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    setSettings(
                      (current) => ({
                        ...current,

                        [field.key]:
                          event.target.value,
                      })
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                />
              </label>
            )
          )}

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !tickers.length
              }
              className="w-full rounded border border-amber-400/50 bg-amber-400/10 px-4 py-2.5 text-[10px] font-bold text-amber-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "RUNNING RISK LAB..."
                : connected
                  ? "RUN RISK OVERLAY"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[9px] text-zinc-500">
          <input
            type="checkbox"
            checked={
              settings.nonOverlapping
            }
            onChange={(
              event
            ) =>
              setSettings(
                (current) => ({
                  ...current,

                  nonOverlapping:
                    event.target.checked,
                })
              )
            }
          />

          Prevent overlapping same-ticker proxy trades.
        </label>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Risk-overlay error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.base_selection}{" "}
              {result.methodology?.overlay_selection}{" "}
              {result.methodology?.execution}{" "}
              <span className="text-amber-300">
                {result.methodology?.caution}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                {
                  label:
                    "Folds",

                  value:
                    summary.completed_folds ??
                    0,
                },

                {
                  label:
                    "Positive protected",

                  value:
                    plainPct(
                      summary.positive_protected_fold_rate
                    ),
                },

                {
                  label:
                    "Protected trades",

                  value:
                    protectedOos.trades ??
                    0,
                },

                {
                  label:
                    "Protected avg",

                  value:
                    pct(
                      protectedOos.average_return_pct
                    ),
                },

                {
                  label:
                    "Protected PF",

                  value:
                    ratio(
                      protectedOos.profit_factor
                    ),
                },

                {
                  label:
                    "Protected max DD",

                  value:
                    pct(
                      protectedOos.max_drawdown_pct
                    ),
                },

                {
                  label:
                    "Unprotected max DD",

                  value:
                    pct(
                      unprotectedOos.max_drawdown_pct
                    ),
                },

                {
                  label:
                    "DD improvement",

                  value:
                    pct(
                      summary.drawdown_improvement_pct_points
                    ),
                },
              ].map(
                (item) => (
                  <div
                    key={
                      item.label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {item.label}
                    </div>

                    <div className="mt-1 font-mono text-sm font-bold text-zinc-100">
                      {item.value}
                    </div>
                  </div>
                )
              )}
            </div>

            {gate && (
              <div className={
                gate.status ===
                "pass"
                  ? "mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
                  : "mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.03] p-4"
              }>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                      Protected robustness gate
                    </div>

                    <div className="mt-1 text-sm font-bold text-white">
                      {gate.passed_count}/{gate.total_checks} checks passed
                    </div>
                  </div>

                  <div className={
                    gate.status ===
                    "pass"
                      ? "rounded border border-emerald-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300"
                      : "rounded border border-red-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-red-300"
                  }>
                    {String(
                      gate.status
                    ).toUpperCase()}
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {(gate.checks ?? []).map(
                    (check) => (
                      <div
                        key={
                          check.id
                        }
                        className={
                          check.passed
                            ? "rounded border border-emerald-500/15 bg-emerald-500/[0.02] p-3"
                            : "rounded border border-red-500/20 bg-red-500/[0.03] p-3"
                        }
                      >
                        <div className={
                          check.passed
                            ? "text-[9px] uppercase tracking-widest text-emerald-400"
                            : "text-[9px] uppercase tracking-widest text-red-400"
                        }>
                          {check.passed ? "PASS" : "FAIL"} · {check.label}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-500">
                          {typeof check.actual === "number"
                            ? check.actual.toFixed(2)
                            : check.actual ?? "—"}{" "}
                          · target {check.threshold}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Fold-by-fold selected risk controls
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1450px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">
                        Fold
                      </th>

                      <th className="px-3 py-2 text-left">
                        Base rule
                      </th>

                      <th className="px-3 py-2 text-left">
                        Risk overlay
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Protected Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Protected PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Protected DD
                      </th>

                      <th className="px-3 py-2 text-right">
                        Unprotected Avg
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {folds.map(
                      (fold) => (
                        <tr
                          key={
                            fold.fold
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-right">
                            {fold.fold}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {fold.selected_base
                              ? fold.selected_base.id
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-left text-amber-300">
                            {overlayLabel(
                              fold.selected_overlay?.parameters
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              fold.selected_overlay?.validation?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {fold.selected_overlay?.test?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              fold.selected_overlay?.test?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              fold.selected_overlay?.test?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {pct(
                              fold.selected_overlay?.test?.max_drawdown_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-violet-300">
                            {pct(
                              fold.unprotected_test?.average_return_pct
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Risk-overlay selection frequency
                </div>

                <div className="mt-2 space-y-2">
                  {overlayFrequency.map(
                    (row) => (
                      <div
                        key={
                          row.id
                        }
                        className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-2 text-[9px]"
                      >
                        <span className="font-mono text-zinc-300">
                          {overlayLabel(
                            row.parameters
                          )}
                        </span>

                        <span className="font-mono text-amber-300">
                          {row.count} fold{row.count === 1 ? "" : "s"}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Protected unseen performance by ticker
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="py-1.5 text-left">
                          Ticker
                        </th>

                        <th className="py-1.5 text-right">
                          N
                        </th>

                        <th className="py-1.5 text-right">
                          Win%
                        </th>

                        <th className="py-1.5 text-right">
                          Avg
                        </th>

                        <th className="py-1.5 text-right">
                          PF
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {byTicker.map(
                        (row) => (
                          <tr
                            key={
                              row.symbol
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="py-1.5 text-left text-white">
                              {row.symbol}
                            </td>

                            <td className="py-1.5 text-right">
                              {row.summary?.trades ?? 0}
                            </td>

                            <td className="py-1.5 text-right">
                              {plainPct(
                                row.summary?.win_rate_pct
                              )}
                            </td>

                            <td className="py-1.5 text-right">
                              {pct(
                                row.summary?.average_return_pct
                              )}
                            </td>

                            <td className="py-1.5 text-right">
                              {ratio(
                                row.summary?.profit_factor
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              Same-day stop/target ambiguity is handled conservatively by assuming the stop occurs first. Risk-budget sizing scales the proxy return and drawdown; it does not model brokerage margin, option Greeks, or actual option-spread prices.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  NESTED RISK WALK-FORWARD
  =========================================================
*/

function NestedRiskWalkForwardPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const protectedOos =
    summary.protected_oos ??
    {};

  const unprotectedOos =
    summary.unprotected_oos ??
    {};

  const folds =
    Array.isArray(
      result?.folds
    )
      ? result.folds
      : [];

  const baseFrequency =
    Array.isArray(
      result?.base_selection_frequency
    )
      ? result.base_selection_frequency
      : [];

  const overlayFrequency =
    Array.isArray(
      result?.overlay_selection_frequency
    )
      ? result.overlay_selection_frequency
      : [];

  const byTicker =
    Array.isArray(
      result?.protected_oos_by_ticker
    )
      ? result.protected_oos_by_ticker
      : [];

  const gate =
    result?.robustness_gate ??
    null;

  const dataset =
    Array.isArray(
      result?.protected_oos_dataset
    )
      ? result.protected_oos_dataset
      : [];

  const pct =
    (
      value,
      digits = 2
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const plainPct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            digits
          ) +
          "%";
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function directionLabel(
    value
  ) {
    if (
      value ===
      "bullish_only"
    ) {
      return "Bullish only";
    }

    if (
      value ===
      "bearish_only"
    ) {
      return "Bearish only";
    }

    return "Both";
  }

  function overlayLabel(
    params
  ) {
    if (!params) {
      return "—";
    }

    return (
      "Stop " +
      params.stopLossPct +
      "% · Target " +
      (
        params.profitTargetPct ===
        null
          ? "None"
          : params.profitTargetPct +
            "%"
      ) +
      " · Hold ≤" +
      params.maxHoldSessions +
      " · Risk " +
      params.riskBudgetPct +
      "%"
    );
  }

  function downloadDataset() {
    if (!dataset.length) {
      return;
    }

    const headers =
      Object.keys(
        dataset[0]
      );

    const esc =
      (value) => {
        if (
          value ===
            null ||
          value ===
            undefined
        ) {
          return "";
        }

        const text =
          String(
            value
          );

        if (
          text.includes(",") ||
          text.includes('"') ||
          text.includes("\n")
        ) {
          return (
            '"' +
            text.replaceAll(
              '"',
              '""'
            ) +
            '"'
          );
        }

        return text;
      };

    const csv = [
      headers.join(","),
      ...dataset.map(
        (row) =>
          headers
            .map(
              (header) =>
                esc(
                  row[
                    header
                  ]
                )
            )
            .join(",")
      ),
    ].join("\n");

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      "nested-risk-walk-forward-oos.csv";

    document.body.appendChild(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-orange-500/20 bg-orange-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-orange-400">
              Nested risk walk-forward
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Separate strategy selection, risk calibration, and unseen testing
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Signal rules and risk controls are calibrated on different historical windows before either reaches the next test block.
            </div>
          </div>

          <button
            type="button"
            onClick={
              downloadDataset
            }
            disabled={
              !dataset.length
            }
            className="rounded border border-cyan-400/40 px-3 py-2 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
          >
            Download nested OOS CSV
          </button>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-4">
          {[
            "Training history",
            "Strategy validation",
            "Risk calibration",
            "Unseen test",
          ].map(
            (
              label,
              index
            ) => (
              <div
                key={
                  label
                }
                className={
                  index ===
                  3
                    ? "rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3"
                    : "rounded-lg border border-zinc-800 bg-black/25 p-3"
                }
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  Step {index + 1}
                </div>

                <div className="mt-1 text-xs font-bold text-zinc-200">
                  {label}
                </div>
              </div>
            )
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-9">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Scope
            </div>

            <select
              value={
                settings.scope
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    scope:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="selected">
                One ticker
              </option>

              <option value="all">
                All scanner tickers
              </option>
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              disabled={
                settings.scope ===
                "all"
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white disabled:opacity-40"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          {[
            {
              key:
                "lookbackDays",

              label:
                "Lookback",
            },

            {
              key:
                "trainDays",

              label:
                "Train",
            },

            {
              key:
                "strategyValidationDays",

              label:
                "Strategy val",
            },

            {
              key:
                "riskCalibrationDays",

              label:
                "Risk cal",
            },

            {
              key:
                "testDays",

              label:
                "Test",
            },

            {
              key:
                "costBps",

              label:
                "Friction bps",
            },
          ].map(
            (field) => (
              <label
                key={
                  field.key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  {field.label}
                </div>

                <input
                  type="number"
                  min="0"
                  value={
                    settings[
                      field.key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    setSettings(
                      (current) => ({
                        ...current,

                        [field.key]:
                          event.target.value,
                      })
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                />
              </label>
            )
          )}

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !tickers.length
              }
              className="w-full rounded border border-orange-400/50 bg-orange-400/10 px-4 py-2.5 text-[10px] font-bold text-orange-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "RUNNING NESTED TEST..."
                : connected
                  ? "RUN NESTED RISK"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[9px] text-zinc-500">
          <input
            type="checkbox"
            checked={
              settings.nonOverlapping
            }
            onChange={(
              event
            ) =>
              setSettings(
                (current) => ({
                  ...current,

                  nonOverlapping:
                    event.target.checked,
                })
              )
            }
          />

          Prevent overlapping same-ticker proxy trades.
        </label>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Nested-risk error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.strategy_selection}{" "}
              {result.methodology?.risk_selection}{" "}
              <span className="text-amber-300">
                {result.methodology?.test}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                {
                  label:
                    "Completed folds",

                  value:
                    summary.completed_folds ??
                    0,
                },

                {
                  label:
                    "Positive folds",

                  value:
                    plainPct(
                      summary.positive_fold_rate
                    ),
                },

                {
                  label:
                    "Protected trades",

                  value:
                    protectedOos.trades ??
                    0,
                },

                {
                  label:
                    "Protected avg",

                  value:
                    pct(
                      protectedOos.average_return_pct
                    ),
                },

                {
                  label:
                    "Protected PF",

                  value:
                    ratio(
                      protectedOos.profit_factor
                    ),
                },

                {
                  label:
                    "Protected max DD",

                  value:
                    pct(
                      protectedOos.max_drawdown_pct
                    ),
                },

                {
                  label:
                    "Unprotected max DD",

                  value:
                    pct(
                      unprotectedOos.max_drawdown_pct
                    ),
                },

                {
                  label:
                    "DD improvement",

                  value:
                    pct(
                      summary.drawdown_improvement_pct_points
                    ),
                },
              ].map(
                (item) => (
                  <div
                    key={
                      item.label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {item.label}
                    </div>

                    <div className="mt-1 font-mono text-sm font-bold text-zinc-100">
                      {item.value}
                    </div>
                  </div>
                )
              )}
            </div>

            {gate && (
              <div
                className={
                  gate.status ===
                  "pass"
                    ? "mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
                    : "mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.03] p-4"
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                      Nested robustness gate
                    </div>

                    <div className="mt-1 text-sm font-bold text-white">
                      {gate.passed_count}/{gate.total_checks} checks passed
                    </div>
                  </div>

                  <div
                    className={
                      gate.status ===
                      "pass"
                        ? "rounded border border-emerald-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300"
                        : "rounded border border-red-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-red-300"
                    }
                  >
                    {String(
                      gate.status
                    ).toUpperCase()}
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {(gate.checks ?? []).map(
                    (check) => (
                      <div
                        key={
                          check.id
                        }
                        className={
                          check.passed
                            ? "rounded border border-emerald-500/15 bg-emerald-500/[0.02] p-3"
                            : "rounded border border-red-500/20 bg-red-500/[0.03] p-3"
                        }
                      >
                        <div
                          className={
                            check.passed
                              ? "text-[9px] uppercase tracking-widest text-emerald-400"
                              : "text-[9px] uppercase tracking-widest text-red-400"
                          }
                        >
                          {check.passed ? "PASS" : "FAIL"} · {check.label}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-500">
                          {typeof check.actual ===
                            "number"
                            ? check.actual.toFixed(
                                2
                              )
                            : check.actual ??
                              "—"}{" "}
                          · target {check.threshold}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Nested fold results
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1600px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">
                        Fold
                      </th>

                      <th className="px-3 py-2 text-left">
                        Base rule
                      </th>

                      <th className="px-3 py-2 text-right">
                        Strat Val N
                      </th>

                      <th className="px-3 py-2 text-left">
                        Risk overlay
                      </th>

                      <th className="px-3 py-2 text-right">
                        Risk Cal N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Risk Cal Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test DD
                      </th>

                      <th className="px-3 py-2 text-right">
                        Unprotected Avg
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {folds.map(
                      (fold) => (
                        <tr
                          key={
                            fold.fold
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-right">
                            {fold.fold}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {fold.selected_base
                              ? directionLabel(
                                  fold.selected_base.parameters?.direction_mode
                                ) +
                                " · " +
                                fold.selected_base.parameters?.hold_sessions +
                                "d · RSI " +
                                fold.selected_base.parameters?.rsi_profile +
                                " · " +
                                fold.selected_base.parameters?.required_signals +
                                "/3"
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {fold.selected_base?.strategy_validation?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-left text-orange-300">
                            {overlayLabel(
                              fold.selected_overlay?.parameters
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {fold.selected_overlay?.risk_calibration?.trades ?? fold.risk_calibration_trade_count ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              fold.selected_overlay?.risk_calibration?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {fold.selected_overlay?.test?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              fold.selected_overlay?.test?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              fold.selected_overlay?.test?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {pct(
                              fold.selected_overlay?.test?.max_drawdown_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-violet-300">
                            {pct(
                              fold.unprotected_test?.average_return_pct
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Base-rule selection frequency
                </div>

                <div className="mt-2 space-y-2">
                  {baseFrequency.map(
                    (row) => (
                      <div
                        key={
                          row.id
                        }
                        className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-2 text-[9px]"
                      >
                        <span className="font-mono text-zinc-300">
                          {row.id}
                        </span>

                        <span className="font-mono text-orange-300">
                          {row.count}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Risk-overlay selection frequency
                </div>

                <div className="mt-2 space-y-2">
                  {overlayFrequency.map(
                    (row) => (
                      <div
                        key={
                          row.id
                        }
                        className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-2 text-[9px]"
                      >
                        <span className="font-mono text-zinc-300">
                          {overlayLabel(
                            row.parameters
                          )}
                        </span>

                        <span className="font-mono text-orange-300">
                          {row.count}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Protected unseen by ticker
                </div>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="py-1.5 text-left">
                          Ticker
                        </th>

                        <th className="py-1.5 text-right">
                          N
                        </th>

                        <th className="py-1.5 text-right">
                          Avg
                        </th>

                        <th className="py-1.5 text-right">
                          PF
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {byTicker.map(
                        (row) => (
                          <tr
                            key={
                              row.symbol
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="py-1.5 text-left text-white">
                              {row.symbol}
                            </td>

                            <td className="py-1.5 text-right">
                              {row.summary?.trades ?? 0}
                            </td>

                            <td className="py-1.5 text-right">
                              {pct(
                                row.summary?.average_return_pct
                              )}
                            </td>

                            <td className="py-1.5 text-right">
                              {ratio(
                                row.summary?.profit_factor
                              )}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              A fold is skipped when no risk overlay has at least five calibration trades, positive average return, and profit factor of at least 1.05. Skipping is preferable to forcing a risk rule that failed its own calibration window.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  HISTORICAL OPTION-SPREAD REPLAY
  =========================================================
*/

function HistoricalOptionReplayPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const trades =
    Array.isArray(
      result?.trades
    )
      ? result.trades
      : [];

  const skipped =
    Array.isArray(
      result?.skipped
    )
      ? result.skipped
      : [];

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >= 0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >= 0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-sky-500/20 bg-sky-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-sky-400">
              Historical option-spread replay
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Replay expired vertical spreads from Robinhood option history
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Uses expired contracts and historical option OHLC bars to measure spread P/L rather than only the underlying move.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            v1 · trade-price proxy
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,
                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Direction
            </div>

            <select
              value={
                settings.directionMode
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,
                    directionMode:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="both">Both</option>
              <option value="bullish_only">Bullish only</option>
              <option value="bearish_only">Bearish only</option>
            </select>
          </label>

          {[
            ["lookbackDays", "Lookback days"],
            ["holdDays", "Hold sessions"],
            ["targetDte", "Target DTE"],
            ["shortDistancePct", "Short OTM %"],
            ["maxSignals", "Max signals"],
          ].map(
            ([
              key,
              label,
            ]) => (
              <label
                key={
                  key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  {label}
                </div>

                <input
                  type="number"
                  min="1"
                  value={
                    settings[
                      key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    setSettings(
                      (current) => ({
                        ...current,
                        [key]:
                          event.target.value,
                      })
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                />
              </label>
            )
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={
              onRun
            }
            disabled={
              loading ||
              !connected ||
              !settings.symbol
            }
            className="rounded border border-sky-400/50 bg-sky-400/10 px-4 py-2.5 text-[10px] font-bold text-sky-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {loading
              ? "REPLAYING OPTIONS..."
              : connected
                ? "RUN OPTION REPLAY"
                : "CONNECT ROBINHOOD"}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Option replay error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              <span className="text-sky-300">
                {result.methodology?.structure}
              </span>{" "}
              {result.methodology?.expiration}{" "}
              {result.methodology?.pricing}{" "}
              <span className="text-amber-300">
                {result.methodology?.caution}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                ["Signals", result.signal_count ?? 0],
                ["Replayed", result.replayed_count ?? 0],
                ["Skipped", result.skipped_count ?? 0],
                ["Win rate", pct(summary.win_rate_pct)],
                ["Avg spread return", pct(summary.average_return_on_debit_pct)],
                ["Avg P/L", dollar(summary.average_pnl_dollars)],
                ["Profit factor", ratio(summary.profit_factor)],
                ["Max DD", dollar(summary.max_drawdown_dollars)],
              ].map(
                ([
                  label,
                  value,
                ]) => (
                  <div
                    key={
                      label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {label}
                    </div>

                    <div className="mt-1 font-mono text-sm font-bold text-zinc-100">
                      {value}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Replayed vertical spreads
              </div>

              {trades.length >
              0 ? (
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="min-w-[1400px] w-full text-[9px] font-mono">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-600">
                        <th className="px-3 py-2 text-left">Signal</th>
                        <th className="px-3 py-2 text-left">Entry</th>
                        <th className="px-3 py-2 text-left">Expiration</th>
                        <th className="px-3 py-2 text-left">Structure</th>
                        <th className="px-3 py-2 text-right">DTE</th>
                        <th className="px-3 py-2 text-right">Debit</th>
                        <th className="px-3 py-2 text-right">Exit Value</th>
                        <th className="px-3 py-2 text-right">P/L</th>
                        <th className="px-3 py-2 text-right">Return</th>
                        <th className="px-3 py-2 text-right">MFE</th>
                        <th className="px-3 py-2 text-right">MAE</th>
                        <th className="px-3 py-2 text-right">RSI</th>
                      </tr>
                    </thead>

                    <tbody>
                      {trades.map(
                        (trade) => (
                          <tr
                            key={
                              trade.id
                            }
                            className="border-b border-zinc-900"
                          >
                            <td
                              className={
                                "px-3 py-2 text-left font-bold " +
                                (
                                  trade.signal ===
                                  "bullish"
                                    ? "text-emerald-300"
                                    : "text-red-300"
                                )
                              }
                            >
                              {String(
                                trade.signal
                              ).toUpperCase()}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {new Date(
                                trade.entry_time
                              ).toLocaleDateString()}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {trade.expiration}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {"$"}{Number(
                                trade.long_strike
                              ).toFixed(
                                2
                              )} / {"$"}{Number(
                                trade.short_strike
                              ).toFixed(
                                2
                              )} {String(
                                trade.option_type
                              ).toUpperCase()}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {trade.entry_dte}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {"$"}{Number(
                                trade.entry_debit
                              ).toFixed(
                                2
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {"$"}{Number(
                                trade.exit_spread_value
                              ).toFixed(
                                2
                              )}
                            </td>

                            <td className={
                              "px-3 py-2 text-right " +
                              (
                                trade.pnl_dollars >
                                0
                                  ? "text-emerald-300"
                                  : trade.pnl_dollars <
                                      0
                                    ? "text-red-300"
                                    : ""
                              )
                            }>
                              {dollar(
                                trade.pnl_dollars
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                trade.return_on_debit_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-emerald-300">
                              {pct(
                                trade.close_path_mfe_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-red-300">
                              {pct(
                                trade.close_path_mae_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {toNumber(
                                trade.rsi
                              ) !==
                              null
                                ? Number(
                                    trade.rsi
                                  ).toFixed(
                                    1
                                  )
                                : "—"}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
                  No historical spreads were replayed for these settings.
                </div>
              )}
            </div>

            {skipped.length >
              0 && (
              <div className="mt-4 rounded-xl border border-zinc-800 bg-black/20 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Skipped signals
                </div>

                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[9px] text-zinc-600">
                  {skipped.map(
                    (
                      item,
                      index
                    ) => (
                      <div
                        key={
                          index
                        }
                      >
                        {item.entry_time
                          ? new Date(
                              item.entry_time
                            ).toLocaleDateString()
                          : "—"}{" "}
                        · {item.reason}
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  OPTION REPLAY RESEARCH LAB
  =========================================================
*/

function OptionReplayResearchPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const selected =
    result?.selected_candidate ??
    null;

  const baseline =
    result?.baseline ??
    null;

  const topCandidates =
    Array.isArray(
      result?.top_candidates
    )
      ? result.top_candidates
      : [];

  const coverage =
    result?.coverage ??
    {};

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function directionLabel(
    value
  ) {
    if (
      value ===
      "bullish_only"
    ) {
      return "Bullish only";
    }

    if (
      value ===
      "bearish_only"
    ) {
      return "Bearish only";
    }

    return "Both";
  }

  function SummaryCard({
    title,
    summary,
    accent,
  }) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
        <div
          className={
            "text-[10px] font-bold " +
            accent
          }
        >
          {title}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat
            label="Trades"
            value={
              summary?.trades ??
              0
            }
          />

          <Stat
            label="Win Rate"
            value={pct(
              summary?.win_rate_pct
            )}
          />

          <Stat
            label="Avg Return"
            value={pct(
              summary?.average_return_on_debit_pct
            )}
          />

          <Stat
            label="Avg P/L"
            value={dollar(
              summary?.average_pnl_dollars
            )}
          />

          <Stat
            label="Profit Factor"
            value={ratio(
              summary?.profit_factor
            )}
          />

          <Stat
            label="Max DD"
            value={dollar(
              summary?.max_drawdown_dollars
            )}
          />
        </div>
      </div>
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-indigo-500/20 bg-indigo-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-indigo-400">
              Option replay research lab
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Search historical vertical-spread structure parameters with an untouched recent test
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Searches direction, hold period, target DTE, and short-strike distance using expired Robinhood option contracts.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            Option OHLC research · no live orders
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Lookback days
            </div>

            <input
              type="number"
              min="120"
              max="730"
              step="30"
              value={
                settings.lookbackDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    lookbackDays:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Max signals / hold
            </div>

            <input
              type="number"
              min="8"
              max="40"
              step="1"
              value={
                settings.maxSignalsPerHold
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    maxSignalsPerHold:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !settings.symbol
              }
              className="w-full rounded border border-indigo-400/50 bg-indigo-400/10 px-4 py-2.5 text-[10px] font-bold text-indigo-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {loading
                ? "BUILDING OPTION RESEARCH..."
                : connected
                  ? "RUN OPTION RESEARCH"
                  : "CONNECT ROBINHOOD"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
          The lab searches 192 combinations: 3 direction modes × 4 hold periods × 4 target-DTE settings × 4 short-strike distances. Option histories are cached within the run so the same contract is not repeatedly fetched.
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Option research error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.search}{" "}
              {result.methodology?.selection}{" "}
              <span className="text-amber-300">
                {result.methodology?.pricing}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Variants"
                value={
                  result.search_space?.variant_count ??
                  0
                }
              />

              <Stat
                label="Unique Option Contracts"
                value={
                  coverage.unique_option_contracts ??
                  0
                }
              />

              <Stat
                label="Replay Rows"
                value={
                  coverage.replay_rows ??
                  0
                }
              />

              <Stat
                label="Skipped Setups / Replays"
                value={
                  String(
                    coverage.setup_skips ??
                    0
                  ) +
                  " / " +
                  String(
                    coverage.replay_skips ??
                    0
                  )
                }
              />
            </div>

            {selected ? (
              <div className="mt-4 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.035] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-indigo-400">
                      Validation-selected option structure
                    </div>

                    <div className="mt-1 text-base font-bold text-white">
                      {directionLabel(
                        selected.parameters?.direction_mode
                      )} · {selected.parameters?.hold_sessions} sessions · target {selected.parameters?.target_dte} DTE · short {selected.parameters?.short_distance_pct}% OTM
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-500">
                      Validation score{" "}
                      {toNumber(
                        selected.validation_score
                      ) !==
                      null
                        ? Number(
                            selected.validation_score
                          ).toFixed(
                            2
                          )
                        : "—"}
                      . Recent test results were not used to select this structure.
                    </div>
                  </div>

                  <div className="rounded border border-indigo-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-indigo-300">
                    Holdout preserved
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <SummaryCard
                    title="Training · early 60%"
                    summary={
                      selected.train
                    }
                    accent="text-zinc-300"
                  />

                  <SummaryCard
                    title="Validation · middle 20%"
                    summary={
                      selected.validation
                    }
                    accent="text-indigo-300"
                  />

                  <SummaryCard
                    title="Untouched test · recent 20%"
                    summary={
                      selected.test
                    }
                    accent="text-amber-300"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[10px] text-amber-300">
                No option-spread candidate had enough training and validation replays to qualify.
              </div>
            )}

            {baseline && (
              <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Current option-replay baseline
                </div>

                <div className="mt-1 text-[10px] text-zinc-400">
                  Both directions · 5 sessions · target 9 DTE · short 4% OTM
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Validation Avg"
                    value={pct(
                      baseline.validation?.average_return_on_debit_pct
                    )}
                  />

                  <Stat
                    label="Validation PF"
                    value={ratio(
                      baseline.validation?.profit_factor
                    )}
                  />

                  <Stat
                    label="Test Avg"
                    value={pct(
                      baseline.test?.average_return_on_debit_pct
                    )}
                  />

                  <Stat
                    label="Test P/L"
                    value={dollar(
                      baseline.test?.total_pnl_dollars
                    )}
                  />
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Top validation candidates
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1350px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-left">
                        Direction
                      </th>

                      <th className="px-3 py-2 text-right">
                        Hold
                      </th>

                      <th className="px-3 py-2 text-right">
                        DTE
                      </th>

                      <th className="px-3 py-2 text-right">
                        Short OTM
                      </th>

                      <th className="px-3 py-2 text-right">
                        Train N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Val PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test N
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test Avg
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test PF
                      </th>

                      <th className="px-3 py-2 text-right">
                        Test P/L
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {topCandidates.map(
                      (candidate) => (
                        <tr
                          key={
                            candidate.id
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-left">
                            {directionLabel(
                              candidate.parameters?.direction_mode
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.hold_sessions}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.target_dte}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.short_distance_pct}%
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.train?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.validation?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right text-indigo-300">
                            {pct(
                              candidate.validation?.average_return_on_debit_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.validation?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.test?.trades ?? 0}
                          </td>

                          <td
                            className={
                              "px-3 py-2 text-right " +
                              (
                                toNumber(
                                  candidate.test?.average_return_on_debit_pct
                                ) >
                                0
                                  ? "text-emerald-300"
                                  : "text-red-300"
                              )
                            }
                          >
                            {pct(
                              candidate.test?.average_return_on_debit_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.test?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {dollar(
                              candidate.test?.total_pnl_dollars
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Do not switch to a different row after seeing its test result. This lab still uses historical option trade-price OHLC rather than synchronized bid/ask quotes, so positive results must later survive execution-slippage stress testing.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  OPTION-SPREAD WALK-FORWARD
  =========================================================
*/

function OptionSpreadWalkForwardPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const summary =
    result?.summary ??
    {};

  const selectedOos =
    summary.selected_oos ??
    {};

  const baselineOos =
    summary.baseline_oos ??
    {};

  const folds =
    Array.isArray(
      result?.folds
    )
      ? result.folds
      : [];

  const selectionFrequency =
    Array.isArray(
      result?.selection_frequency
    )
      ? result.selection_frequency
      : [];

  const dataset =
    Array.isArray(
      result?.selected_oos_dataset
    )
      ? result.selected_oos_dataset
      : [];

  const coverage =
    result?.coverage ??
    {};

  const coverageDetail =
    result?.coverage_detail ??
    {};

  const monthlySignalDates =
    Array.isArray(
      coverageDetail
        ?.monthly_signal_dates
    )
      ? coverageDetail
          .monthly_signal_dates
      : [];

  const holdCoverage =
    Array.isArray(
      coverageDetail
        ?.replay_rows_by_hold
    )
      ? coverageDetail
          .replay_rows_by_hold
      : [];

  const dteCoverage =
    Array.isArray(
      coverageDetail
        ?.replay_rows_by_dte_bucket
    )
      ? coverageDetail
          .replay_rows_by_dte_bucket
      : [];

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function directionLabel(
    value
  ) {
    if (
      value ===
      "bullish_only"
    ) {
      return "Bullish only";
    }

    if (
      value ===
      "bearish_only"
    ) {
      return "Bearish only";
    }

    return "Both";
  }

  function downloadDataset() {
    if (!dataset.length) {
      return;
    }

    const headers =
      Object.keys(
        dataset[0]
      );

    const esc =
      (value) => {
        if (
          value ===
            null ||
          value ===
            undefined
        ) {
          return "";
        }

        const text =
          String(
            value
          );

        if (
          text.includes(",") ||
          text.includes('"') ||
          text.includes("\n")
        ) {
          return (
            '"' +
            text.replaceAll(
              '"',
              '""'
            ) +
            '"'
          );
        }

        return text;
      };

    const csv = [
      headers.join(","),
      ...dataset.map(
        (row) =>
          headers
            .map(
              (header) =>
                esc(
                  row[
                    header
                  ]
                )
            )
            .join(",")
      ),
    ].join("\n");

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      "option-spread-walk-forward-oos.csv";

    document.body.appendChild(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-teal-500/20 bg-teal-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-teal-400">
              Option-spread walk-forward
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Re-select DTE, hold, direction, and spread width using only prior option history
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Each fold chooses a vertical-spread structure from prior expired-option replays, then measures the next unseen option period.
            </div>
          </div>

          <button
            type="button"
            onClick={
              downloadDataset
            }
            disabled={
              !dataset.length
            }
            className="rounded border border-cyan-400/40 px-3 py-2 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
          >
            Download OOS Option CSV
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          {[
            ["lookbackDays", "Lookback days"],
            ["trainCoverageDates", "Train signal dates"],
            ["validationCoverageDates", "Validation signal dates"],
            ["testCoverageDates", "Test signal dates"],
            ["maxSignalsPerHold", "Max signals / hold"],
          ].map(
            ([
              key,
              label,
            ]) => (
              <label
                key={
                  key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  {label}
                </div>

                <input
                  type="number"
                  min="1"
                  value={
                    settings[
                      key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    setSettings(
                      (current) => ({
                        ...current,

                        [key]:
                          event.target.value,
                      })
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                />
              </label>
            )
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={
              onRun
            }
            disabled={
              loading ||
              !connected ||
              !settings.symbol
            }
            className="rounded border border-teal-400/50 bg-teal-400/10 px-4 py-2.5 text-[10px] font-bold text-teal-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {loading
              ? "RUNNING OPTION WALK-FORWARD..."
              : connected
                ? "RUN OPTION WALK-FORWARD"
                : "CONNECT ROBINHOOD"}
          </button>
        </div>

        <div className="mt-3 rounded-lg border border-teal-500/15 bg-teal-500/[0.02] p-3 text-[9px] leading-relaxed text-zinc-500">
          Coverage-aware mode uses actual replayable option-signal dates rather than empty calendar windows. The defaults now use 60 replayable signal dates for training, 24 for validation, and 8 for the unseen test, with up to 60 sampled signals per hold. The actual eligibility floor remains 20 training replays and 8 validation replays.
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Option walk-forward error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.selection}{" "}
              {result.methodology?.rolling}{" "}
              <span className="text-amber-300">
                {result.methodology?.pricing}
              </span>
            </div>

            {summary.completed_folds === 0 && (
              <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3 text-[9px] leading-relaxed text-amber-200">
                No structure qualified in the previous coverage windows. This usually means each individual hold/DTE/width variant did not accumulate 20 actual training replays and 8 actual validation replays, even though the combined dataset is large. Increase coverage-window signal dates and sampled signals per hold rather than lowering the eligibility standards.
              </div>
            )}

            <div className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.02] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-sky-400">
                    Option data coverage
                  </div>

                  <div className="mt-1 text-sm font-bold text-white">
                    Actual replayable history used to build folds
                  </div>
                </div>

                <div className="rounded border border-sky-500/20 px-2 py-1 text-[9px] uppercase tracking-widest text-sky-300">
                  {coverageDetail.unique_signal_dates ?? 0} signal dates
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                <Stat
                  label="Earliest Replay"
                  value={
                    coverageDetail.earliest_replayable_date ??
                    "—"
                  }
                />

                <Stat
                  label="Latest Replay"
                  value={
                    coverageDetail.latest_replayable_date ??
                    "—"
                  }
                />

                <Stat
                  label="Coverage Days"
                  value={
                    coverageDetail.coverage_days ??
                    "—"
                  }
                />

                <Stat
                  label="Signal Dates"
                  value={
                    coverageDetail.unique_signal_dates ??
                    0
                  }
                />

                <Stat
                  label="Bullish Dates"
                  value={
                    coverageDetail.bullish_signal_dates ??
                    0
                  }
                />

                <Stat
                  label="Bearish Dates"
                  value={
                    coverageDetail.bearish_signal_dates ??
                    0
                  }
                />

                <Stat
                  label="Missing-Bar Rate"
                  value={pct(
                    coverageDetail.missing_bar_rate_pct
                  )}
                />

                <Stat
                  label="Replay Rows"
                  value={
                    coverage.replay_rows ??
                    0
                  }
                />
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                <div className="rounded-lg border border-zinc-800 bg-black/20 p-3">
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Replayable signal dates by month
                  </div>

                  <div className="mt-2 max-h-44 overflow-y-auto">
                    {monthlySignalDates.length >
                    0 ? (
                      monthlySignalDates
                        .slice(
                          -18
                        )
                        .map(
                          (row) => (
                            <div
                              key={
                                row.month
                              }
                              className="flex items-center justify-between border-b border-zinc-900 py-1.5 font-mono text-[9px]"
                            >
                              <span className="text-zinc-400">
                                {row.month}
                              </span>

                              <span className="text-sky-300">
                                {row.count}
                              </span>
                            </div>
                          )
                        )
                    ) : (
                      <div className="text-[9px] text-zinc-600">
                        No replayable months.
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-black/20 p-3">
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Replay rows by hold
                  </div>

                  <div className="mt-2 space-y-1">
                    {holdCoverage.map(
                      (row) => (
                        <div
                          key={
                            row.hold_sessions
                          }
                          className="flex items-center justify-between border-b border-zinc-900 py-1.5 font-mono text-[9px]"
                        >
                          <span className="text-zinc-400">
                            {row.hold_sessions} sessions
                          </span>

                          <span className="text-teal-300">
                            {row.count}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-black/20 p-3">
                  <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                    Replay rows by entry DTE
                  </div>

                  <div className="mt-2 space-y-1">
                    {dteCoverage.map(
                      (row) => (
                        <div
                          key={
                            row.bucket
                          }
                          className="flex items-center justify-between border-b border-zinc-900 py-1.5 font-mono text-[9px]"
                        >
                          <span className="text-zinc-400">
                            {row.bucket} DTE
                          </span>

                          <span className="text-indigo-300">
                            {row.count}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {[
                ["Folds", summary.completed_folds ?? 0],
                ["Positive folds", pct(summary.positive_test_fold_rate)],
                ["OOS trades", selectedOos.trades ?? 0],
                ["OOS win rate", pct(selectedOos.win_rate_pct)],
                ["OOS avg return", pct(selectedOos.average_return_on_debit_pct)],
                ["OOS P/L", dollar(selectedOos.total_pnl_dollars)],
                ["OOS PF", ratio(selectedOos.profit_factor)],
                ["OOS Max DD", dollar(selectedOos.max_drawdown_dollars)],
              ].map(
                ([
                  label,
                  value,
                ]) => (
                  <div
                    key={
                      label
                    }
                    className="rounded-lg border border-zinc-800 bg-black/25 p-3"
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                      {label}
                    </div>

                    <div className="mt-1 font-mono text-sm font-bold text-zinc-100">
                      {value}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-teal-500/20 bg-teal-500/[0.025] p-3">
                <div className="text-[9px] uppercase tracking-widest text-teal-400">
                  Walk-forward selected option structures
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat
                    label="Trades"
                    value={
                      selectedOos.trades ??
                      0
                    }
                  />

                  <Stat
                    label="Avg Return"
                    value={pct(
                      selectedOos.average_return_on_debit_pct
                    )}
                  />

                  <Stat
                    label="Avg P/L"
                    value={dollar(
                      selectedOos.average_pnl_dollars
                    )}
                  />

                  <Stat
                    label="Profit Factor"
                    value={ratio(
                      selectedOos.profit_factor
                    )}
                  />

                  <Stat
                    label="Max DD"
                    value={dollar(
                      selectedOos.max_drawdown_dollars
                    )}
                  />

                  <Stat
                    label="Avg Debit"
                    value={
                      toNumber(
                        selectedOos.average_entry_debit
                      ) !==
                      null
                        ? "$" +
                          Number(
                            selectedOos.average_entry_debit
                          ).toFixed(
                            2
                          )
                        : "—"
                    }
                  />
                </div>
              </div>

              <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.025] p-3">
                <div className="text-[9px] uppercase tracking-widest text-violet-400">
                  Fixed option baseline OOS
                </div>

                <div className="mt-1 text-[9px] text-zinc-600">
                  Both directions · 5 sessions · target 9 DTE · short 4% OTM
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat
                    label="Trades"
                    value={
                      baselineOos.trades ??
                      0
                    }
                  />

                  <Stat
                    label="Avg Return"
                    value={pct(
                      baselineOos.average_return_on_debit_pct
                    )}
                  />

                  <Stat
                    label="P/L"
                    value={dollar(
                      baselineOos.total_pnl_dollars
                    )}
                  />

                  <Stat
                    label="Profit Factor"
                    value={ratio(
                      baselineOos.profit_factor
                    )}
                  />

                  <Stat
                    label="Max DD"
                    value={dollar(
                      baselineOos.max_drawdown_dollars
                    )}
                  />

                  <Stat
                    label="Win Rate"
                    value={pct(
                      baselineOos.win_rate_pct
                    )}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Unique Option Contracts"
                value={
                  coverage.unique_option_contracts ??
                  0
                }
              />

              <Stat
                label="Replay Rows"
                value={
                  coverage.replay_rows ??
                  0
                }
              />

              <Stat
                label="Setup Skips"
                value={
                  coverage.setup_skips ??
                  0
                }
              />

              <Stat
                label="Replay Skips"
                value={
                  coverage.replay_skips ??
                  0
                }
              />
            </div>

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Fold-by-fold unseen option results
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1500px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">Fold</th>
                      <th className="px-3 py-2 text-left">Test Window</th>
                      <th className="px-3 py-2 text-left">Selected</th>
                      <th className="px-3 py-2 text-right">Val N</th>
                      <th className="px-3 py-2 text-right">Val Avg</th>
                      <th className="px-3 py-2 text-right">Val PF</th>
                      <th className="px-3 py-2 text-right">Test N</th>
                      <th className="px-3 py-2 text-right">Test Avg</th>
                      <th className="px-3 py-2 text-right">Test PF</th>
                      <th className="px-3 py-2 text-right">Test P/L</th>
                      <th className="px-3 py-2 text-right">Baseline Avg</th>
                    </tr>
                  </thead>

                  <tbody>
                    {folds.map(
                      (fold) => {
                        const candidate =
                          fold.selected_candidate;

                        const params =
                          candidate?.parameters;

                        return (
                          <tr
                            key={
                              fold.fold
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="px-3 py-2 text-right">
                              {fold.fold}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {new Date(
                                fold.test_start
                              ).toLocaleDateString()}{" "}
                              →{" "}
                              {new Date(
                                fold.test_end
                              ).toLocaleDateString()}
                            </td>

                            <td className="px-3 py-2 text-left">
                              {candidate
                                ? directionLabel(
                                    params?.direction_mode
                                  ) +
                                  " · " +
                                  params?.hold_sessions +
                                  "d · " +
                                  params?.target_dte +
                                  " DTE · " +
                                  params?.short_distance_pct +
                                  "% OTM"
                                : "No eligible structure"}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {candidate?.validation?.trades ?? 0}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                candidate?.validation?.average_return_on_debit_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {ratio(
                                candidate?.validation?.profit_factor
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {candidate?.test?.trades ?? 0}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                candidate?.test?.average_return_on_debit_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {ratio(
                                candidate?.test?.profit_factor
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {dollar(
                                candidate?.test?.total_pnl_dollars
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-violet-300">
                              {pct(
                                fold.baseline_test?.average_return_on_debit_pct
                              )}
                            </td>
                          </tr>
                        );
                      }
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Option-structure selection frequency
                </div>

                <div className="mt-2 space-y-2">
                  {selectionFrequency.map(
                    (row) => (
                      <div
                        key={
                          row.id
                        }
                        className="flex items-center justify-between gap-3 border-b border-zinc-900 pb-2 text-[9px]"
                      >
                        <span className="font-mono text-zinc-300">
                          {directionLabel(
                            row.parameters?.direction_mode
                          )}{" "}
                          · {row.parameters?.hold_sessions}d · {row.parameters?.target_dte} DTE · {row.parameters?.short_distance_pct}% OTM
                        </span>

                        <span className="font-mono text-teal-300">
                          {row.count} fold{row.count === 1 ? "" : "s"}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.025] p-3">
                <div className="text-[9px] uppercase tracking-widest text-cyan-400">
                  Unseen option learning dataset
                </div>

                <div className="mt-1 text-sm font-bold text-white">
                  {dataset.length} option-spread row{dataset.length === 1 ? "" : "s"}
                </div>

                <div className="mt-2 text-[9px] leading-relaxed text-zinc-500">
                  Every row is from a walk-forward test window after the structure was selected using only earlier option history. This is the clean option-specific dataset for later model evaluation.
                </div>

                <button
                  type="button"
                  onClick={
                    downloadDataset
                  }
                  disabled={
                    !dataset.length
                  }
                  className="mt-3 rounded border border-cyan-400/40 px-3 py-1.5 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
                >
                  Download CSV
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Folds are now built from real replayable option-signal dates, but a structure still must have at least 20 actual training replays, 8 actual validation replays, positive validation average return, and validation profit factor of at least 1.10. The engine does not lower those standards merely to force a result.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  OPTION EXECUTION STRESS TEST
  =========================================================
*/

function OptionExecutionStressPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const scenarios =
    Array.isArray(
      result?.scenarios
    )
      ? result.scenarios
      : [];

  const rawSummary =
    result?.raw_summary ??
    {};

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-rose-500/20 bg-rose-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-rose-400">
              Option execution stress test
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Freeze the PLTR baseline, then stress entry/exit execution
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Uses the fixed 5-session / 9-DTE / 4%-OTM option baseline and the same unseen coverage-aware test blocks.
            </div>
          </div>

          <div className="rounded border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[9px] uppercase tracking-widest text-amber-300">
            No parameter search
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          {[
            ["lookbackDays", "Lookback days"],
            ["trainCoverageDates", "Train signal dates"],
            ["validationCoverageDates", "Validation signal dates"],
            ["testCoverageDates", "Test signal dates"],
            ["maxSignalsPerHold", "Max signals / hold"],
            ["feePerContractPerLeg", "Fee / contract / leg $"],
          ].map(
            ([
              key,
              label,
            ]) => (
              <label
                key={
                  key
                }
                className="rounded-lg border border-zinc-800 bg-black/25 p-3"
              >
                <div className="text-[9px] uppercase tracking-widest text-zinc-600">
                  {label}
                </div>

                <input
                  type="number"
                  min="0"
                  step={
                    key ===
                    "feePerContractPerLeg"
                      ? "0.01"
                      : "1"
                  }
                  value={
                    settings[
                      key
                    ]
                  }
                  onChange={(
                    event
                  ) =>
                    setSettings(
                      (current) => ({
                        ...current,

                        [key]:
                          event.target.value,
                      })
                    )
                  }
                  className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
                />
              </label>
            )
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={
              onRun
            }
            disabled={
              loading ||
              !connected ||
              !settings.symbol
            }
            className="rounded border border-rose-400/50 bg-rose-400/10 px-4 py-2.5 text-[10px] font-bold text-rose-300 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {loading
              ? "RUNNING EXECUTION STRESS..."
              : connected
                ? "RUN EXECUTION STRESS"
                : "CONNECT ROBINHOOD"}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Execution stress error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.sample}{" "}
              {result.methodology?.friction}{" "}
              {result.methodology?.fees}{" "}
              <span className="text-amber-300">
                {result.methodology?.caution}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              <Stat
                label="OOS Trades"
                value={
                  result.oos_trade_count ??
                  0
                }
              />

              <Stat
                label="Raw Win Rate"
                value={pct(
                  rawSummary.win_rate_pct
                )}
              />

              <Stat
                label="Raw Avg Return"
                value={pct(
                  rawSummary.average_return_on_debit_pct
                )}
              />

              <Stat
                label="Raw P/L"
                value={dollar(
                  rawSummary.total_pnl_dollars
                )}
              />

              <Stat
                label="Raw Profit Factor"
                value={ratio(
                  rawSummary.profit_factor
                )}
              />

              <Stat
                label="Raw Max DD"
                value={dollar(
                  rawSummary.max_drawdown_dollars
                )}
              />

              <Stat
                label="Approx Break-Even Friction"
                value={
                  toNumber(
                    result.approximate_break_even_round_trip_friction_cents
                  ) !==
                  null
                    ? Number(
                        result.approximate_break_even_round_trip_friction_cents
                      ).toFixed(
                        1
                      ) +
                      "¢ round trip"
                    : "—"
                }
              />

              <Stat
                label="Largest Positive Stress Tier"
                value={
                  toNumber(
                    result.largest_positive_stress_tier_cents
                  ) !==
                  null
                    ? Number(
                        result.largest_positive_stress_tier_cents
                      ).toFixed(
                        0
                      ) +
                      "¢"
                    : "None"
                }
              />
            </div>

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Execution-friction survival table
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1150px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">
                        Round-Trip Friction
                      </th>

                      <th className="px-3 py-2 text-right">
                        Win Rate
                      </th>

                      <th className="px-3 py-2 text-right">
                        Avg Return
                      </th>

                      <th className="px-3 py-2 text-right">
                        Avg P/L
                      </th>

                      <th className="px-3 py-2 text-right">
                        Total P/L
                      </th>

                      <th className="px-3 py-2 text-right">
                        Profit Factor
                      </th>

                      <th className="px-3 py-2 text-right">
                        Max DD
                      </th>

                      <th className="px-3 py-2 text-right">
                        Survives
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {scenarios.map(
                      (scenario) => {
                        const stress =
                          scenario.summary ??
                          {};

                        const survives =
                          (
                            stress.average_pnl_dollars ??
                            0
                          ) >
                            0 &&
                          (
                            stress.profit_factor ??
                            0
                          ) >
                            1;

                        return (
                          <tr
                            key={
                              scenario.round_trip_friction_cents
                            }
                            className="border-b border-zinc-900"
                          >
                            <td className="px-3 py-2 text-right text-rose-300">
                              {Number(
                                scenario.round_trip_friction_cents
                              ).toFixed(
                                0
                              )}¢
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                stress.win_rate_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {pct(
                                stress.average_return_on_debit_pct
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {dollar(
                                stress.average_pnl_dollars
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {dollar(
                                stress.total_pnl_dollars
                              )}
                            </td>

                            <td className="px-3 py-2 text-right">
                              {ratio(
                                stress.profit_factor
                              )}
                            </td>

                            <td className="px-3 py-2 text-right text-red-300">
                              {dollar(
                                stress.max_drawdown_dollars
                              )}
                            </td>

                            <td
                              className={
                                survives
                                  ? "px-3 py-2 text-right font-bold text-emerald-300"
                                  : "px-3 py-2 text-right font-bold text-red-300"
                              }
                            >
                              {survives
                                ? "YES"
                                : "NO"}
                            </td>
                          </tr>
                        );
                      }
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Friction tiers are total round-trip spread friction. A 10¢ tier means 5¢ worse on entry and 5¢ worse on exit. This test intentionally freezes the option structure so we measure execution sensitivity rather than optimize another historical parameter.
            </div>
          </>
        )}
      </div>
    </section>
  );
}


/*
  =========================================================
  FORWARD PAPER VALIDATOR
  =========================================================
*/

function ForwardPaperValidatorPanel({
  status,
  loading,
  error,
  connected,
  onTick,
  onToggle,
}) {
  const settings =
    status?.settings ??
    {};

  const summary =
    status?.summary ??
    {};

  const scheduler =
    status?.scheduler ??
    {};

  const readiness =
    summary?.readiness_gate ??
    null;

  const snapshot =
    status?.lastSnapshot ??
    null;

  const trades =
    Array.isArray(
      status?.trades
    )
      ? status.trades
      : [];

  const openTrades =
    trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closedTrades =
    trades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-emerald-400">
              Forward paper validator
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Collect live PLTR spread observations without submitting orders
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Fixed baseline: both directions · 5-session hold · target 9 DTE · short leg about 4% OTM · quarter-spread paper fills.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onToggle(
                  !settings.enabled
                )
              }
              disabled={
                loading ||
                !connected
              }
              className={
                settings.enabled
                  ? "rounded border border-red-500/35 bg-red-500/10 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-red-300 disabled:opacity-30"
                  : "rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-emerald-300 disabled:opacity-30"
              }
            >
              {settings.enabled
                ? "Disable Validator"
                : "Enable Validator"}
            </button>

            <button
              type="button"
              onClick={
                onTick
              }
              disabled={
                loading ||
                !connected
              }
              className="rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-sky-300 disabled:opacity-30"
            >
              {loading
                ? "Evaluating..."
                : "Evaluate Now"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
          Paper only. This feature uses read-only Robinhood market-data tools and cannot place an order. Automatic checks now run from the backend scheduler, so the browser page does not need to remain open; the proxy process still must be running and Robinhood must remain connected. New paper entries are only created during regular U.S. market hours from the latest completed daily signal.
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Forward validator error: {error}
          </div>
        )}

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Stat
            label="Status"
            value={
              settings.enabled
                ? "ENABLED"
                : "PAUSED"
            }
            color={
              settings.enabled
                ? "text-emerald-300"
                : "text-zinc-400"
            }
          />

          <Stat
            label="Total Paper Trades"
            value={
              summary.total_trades ??
              0
            }
          />

          <Stat
            label="Open"
            value={
              summary.open_trades ??
              0
            }
          />

          <Stat
            label="Closed"
            value={
              summary.closed_trades ??
              0
            }
          />

          <Stat
            label="Forward Win Rate"
            value={pct(
              summary.win_rate_pct
            )}
          />

          <Stat
            label="Forward P/L"
            value={dollar(
              summary.total_pl
            )}
          />

          <Stat
            label="Profit Factor"
            value={ratio(
              summary.profit_factor
            )}
          />

          <Stat
            label="Max DD"
            value={dollar(
              summary.max_drawdown
            )}
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">
              Latest completed signal snapshot
            </div>

            {snapshot ? (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat
                  label="Signal Date"
                  value={
                    snapshot.signalDate ??
                    "—"
                  }
                />

                <Stat
                  label="Signal"
                  value={
                    String(
                      snapshot.signal ??
                      "neutral"
                    ).toUpperCase()
                  }
                  color={
                    snapshot.signal ===
                    "bullish"
                      ? "text-emerald-300"
                      : snapshot.signal ===
                          "bearish"
                        ? "text-red-300"
                        : "text-zinc-300"
                  }
                />

                <Stat
                  label="Current PLTR"
                  value={
                    snapshot.currentPrice !==
                    null &&
                    snapshot.currentPrice !==
                    undefined
                      ? formatMoney(
                          snapshot.currentPrice
                        )
                      : "—"
                  }
                />

                <Stat
                  label="RSI"
                  value={
                    toNumber(
                      snapshot.rsi
                    ) !==
                    null
                      ? Number(
                          snapshot.rsi
                        ).toFixed(
                          1
                        )
                      : "—"
                  }
                />

                <Stat
                  label="MACD Hist"
                  value={formatSignedNumber(
                    snapshot.macdHistogram,
                    3
                  )}
                />

                <Stat
                  label="Daily Move"
                  value={pct(
                    snapshot.changePct
                  )}
                />
              </div>
            ) : (
              <div className="mt-3 text-[10px] text-zinc-600">
                No validator evaluation has been recorded yet.
              </div>
            )}

            <div className="mt-3 text-[9px] text-zinc-600">
              Last evaluation:{" "}
              {status?.lastEvaluatedAt
                ? new Date(
                    status.lastEvaluatedAt
                  ).toLocaleString()
                : "Never"}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500">
              Live execution observations
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Stat
                label="Avg Entry Slippage"
                value={
                  toNumber(
                    summary.average_entry_slippage_cents
                  ) !==
                  null
                    ? Number(
                        summary.average_entry_slippage_cents
                      ).toFixed(
                        1
                      ) +
                      "¢"
                    : "—"
                }
              />

              <Stat
                label="Avg Exit Slippage"
                value={
                  toNumber(
                    summary.average_exit_slippage_cents
                  ) !==
                  null
                    ? Number(
                        summary.average_exit_slippage_cents
                      ).toFixed(
                        1
                      ) +
                      "¢"
                    : "—"
                }
              />

              <Stat
                label="Historical Stress BE"
                value="~17¢ round trip"
              />

              <Stat
                label="Backend Scheduler"
                value={
                  scheduler.backend_scheduler_active
                    ? "ACTIVE"
                    : "OFF"
                }
                color={
                  scheduler.backend_scheduler_active
                    ? "text-emerald-300"
                    : "text-red-300"
                }
              />
            </div>

            <div className="mt-3 text-[9px] leading-relaxed text-zinc-600">
              Forward validation is meant to answer whether real live quote behavior remains inside the execution tolerance observed in the historical stress test.
            </div>
          </div>
        </div>

        {readiness && (
          <div
            className={
              readiness.status ===
              "pass"
                ? "mt-5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
                : "mt-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.03] p-4"
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Forward evidence gate
                </div>

                <div className="mt-1 text-sm font-bold text-white">
                  {readiness.status ===
                  "pass"
                    ? "Paper-forward evidence gate passed"
                    : "Collecting paper-forward evidence"}
                </div>

                <div className="mt-1 text-[9px] text-zinc-600">
                  {readiness.passed_count}/{readiness.total_checks} checks currently pass. This gate does not authorize live trading.
                </div>
              </div>

              <div
                className={
                  readiness.status ===
                  "pass"
                    ? "rounded border border-emerald-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-emerald-300"
                    : "rounded border border-amber-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300"
                }
              >
                {readiness.status ===
                "pass"
                  ? "PASS"
                  : "COLLECTING"}
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {(readiness.checks ?? []).map(
                (check) => (
                  <div
                    key={
                      check.id
                    }
                    className={
                      check.passed
                        ? "rounded border border-emerald-500/15 bg-emerald-500/[0.02] p-3"
                        : "rounded border border-zinc-800 bg-black/20 p-3"
                    }
                  >
                    <div
                      className={
                        check.passed
                          ? "text-[9px] uppercase tracking-widest text-emerald-400"
                          : "text-[9px] uppercase tracking-widest text-zinc-500"
                      }
                    >
                      {check.passed ? "PASS" : "WAIT"} · {check.label}
                    </div>

                    <div className="mt-1 font-mono text-xs text-zinc-200">
                      {typeof check.actual ===
                        "number"
                        ? check.actual.toFixed(
                            2
                          )
                        : check.actual ??
                          "—"}
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-600">
                      Target {check.threshold}
                    </div>
                  </div>
                )
              )}
            </div>

            <div className="mt-3 text-[9px] text-zinc-600">
              Scheduler last run:{" "}
              {scheduler.last_run_at
                ? new Date(
                    scheduler.last_run_at
                  ).toLocaleString()
                : "Not yet"}{" "}
              · Last scheduler error: {scheduler.last_error || "None"}
            </div>
          </div>
        )}

        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Open forward paper positions
          </div>

          {openTrades.length >
          0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {openTrades.map(
                (trade) => (
                  <div
                    key={
                      trade.id
                    }
                    className="rounded-xl border border-sky-500/20 bg-sky-500/[0.02] p-3"
                  >
                    <div className="font-mono text-sm font-bold text-white">
                      {formatMoney(
                        trade.longStrike
                      )} / {formatMoney(
                        trade.shortStrike
                      )}{" "}
                      {String(
                        trade.optionType
                      ).toUpperCase()} spread
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-500">
                      Signal {trade.signalDate} · Exp {trade.expiration} · Entry {new Date(
                        trade.entryTimestamp
                      ).toLocaleString()}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat
                        label="Entry Fill"
                        value={formatMoney(
                          trade.entryFill
                        )}
                      />

                      <Stat
                        label="Current Mid"
                        value={formatMoney(
                          trade.currentMidpoint
                        )}
                      />

                      <Stat
                        label="Current P/L"
                        value={dollar(
                          trade.currentTheoreticalPL
                        )}
                      />

                      <Stat
                        label="MFE / MAE"
                        value={
                          dollar(
                            trade.maxFavorablePL
                          ) +
                          " / " +
                          dollar(
                            trade.maxAdversePL
                          )
                        }
                      />
                    </div>
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
              No open forward paper position. The validator will wait for a qualifying completed daily signal and a regular-hours evaluation.
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Closed forward paper journal
          </div>

          {closedTrades.length >
          0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="min-w-[1200px] w-full text-[9px] font-mono">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-600">
                    <th className="px-3 py-2 text-left">
                      Signal
                    </th>

                    <th className="px-3 py-2 text-left">
                      Structure
                    </th>

                    <th className="px-3 py-2 text-left">
                      Entry
                    </th>

                    <th className="px-3 py-2 text-left">
                      Exit
                    </th>

                    <th className="px-3 py-2 text-right">
                      Entry Fill
                    </th>

                    <th className="px-3 py-2 text-right">
                      Exit Fill
                    </th>

                    <th className="px-3 py-2 text-right">
                      P/L
                    </th>

                    <th className="px-3 py-2 text-right">
                      Return
                    </th>

                    <th className="px-3 py-2 text-right">
                      Entry Slip
                    </th>

                    <th className="px-3 py-2 text-right">
                      Exit Slip
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {[...closedTrades]
                    .reverse()
                    .map(
                      (trade) => (
                        <tr
                          key={
                            trade.id
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-left">
                            {String(
                              trade.signal
                            ).toUpperCase()}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {formatMoney(
                              trade.longStrike
                            )} / {formatMoney(
                              trade.shortStrike
                            )} {String(
                              trade.optionType
                            ).toUpperCase()}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {new Date(
                              trade.entryTimestamp
                            ).toLocaleDateString()}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {trade.exitTimestamp
                              ? new Date(
                                  trade.exitTimestamp
                                ).toLocaleDateString()
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              trade.entryFill
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              trade.exitFill
                            )}
                          </td>

                          <td
                            className={
                              "px-3 py-2 text-right " +
                              (
                                toNumber(
                                  trade.realizedPL
                                ) >
                                0
                                  ? "text-emerald-300"
                                  : "text-red-300"
                              )
                            }
                          >
                            {dollar(
                              trade.realizedPL
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              trade.realizedReturnPct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {toNumber(
                              trade.entrySlippageCents
                            ) !==
                            null
                              ? Number(
                                  trade.entrySlippageCents
                                ).toFixed(
                                  1
                                ) +
                                "¢"
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {toNumber(
                              trade.exitSlippageCents
                            ) !==
                            null
                              ? Number(
                                  trade.exitSlippageCents
                                ).toFixed(
                                  1
                                ) +
                                "¢"
                              : "—"}
                          </td>
                        </tr>
                      )
                    )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
              No closed forward trades yet. This dataset grows only from future live observations.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


/*
  =========================================================
  SINGLE-LEG CALL / PUT PRACTICE
  =========================================================
*/

function SingleLegPracticePanel({
  tickers,
  status,
  loading,
  error,
  connected,
  onRefresh,
  onOpen,
  onClose,
  onSettings,
}) {
  const settings =
    status?.settings ??
    {};

  const summary =
    status?.summary ??
    {};

  const scheduler =
    status?.scheduler ??
    {};

  const trades =
    Array.isArray(
      status?.trades
    )
      ? status.trades
      : [];

  const openTrades =
    trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closedTrades =
    trades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-violet-500/20 bg-violet-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-violet-400">
              Single-leg practice
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Practice buying calls and puts with live Robinhood quotes
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Paper-only long options. No short leg, no brokerage order, and no real money is used.
            </div>
          </div>

          <button
            type="button"
            onClick={
              onRefresh
            }
            disabled={
              loading ||
              !connected
            }
            className="rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-sky-300 disabled:opacity-30"
          >
            {loading
              ? "Refreshing..."
              : "Refresh Quotes"}
          </button>
        </div>

        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
          The practice engine chooses the active option strike nearest the current stock price at approximately the selected DTE. Entry and exit fills use the selected paper fill model. Open positions are marked by the backend scheduler and automatically close after the selected number of completed trading sessions unless you close them manually first.
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Single-leg practice error: {error}
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol ??
                "PLTR"
              }
              onChange={(
                event
              ) =>
                onSettings({
                  symbol:
                    event.target.value,
                })
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Target DTE
            </div>

            <select
              value={
                settings.targetDte ??
                9
              }
              onChange={(
                event
              ) =>
                onSettings({
                  targetDte:
                    Number(
                      event.target.value
                    ),
                })
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {[7, 9, 14, 21, 30].map(
                (value) => (
                  <option
                    key={
                      value
                    }
                    value={
                      value
                    }
                  >
                    {value} DTE
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Hold Sessions
            </div>

            <select
              value={
                settings.holdSessions ??
                5
              }
              onChange={(
                event
              ) =>
                onSettings({
                  holdSessions:
                    Number(
                      event.target.value
                    ),
                })
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {[1, 3, 5, 10].map(
                (value) => (
                  <option
                    key={
                      value
                    }
                    value={
                      value
                    }
                  >
                    {value}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Quantity
            </div>

            <select
              value={
                settings.quantity ??
                1
              }
              onChange={(
                event
              ) =>
                onSettings({
                  quantity:
                    Number(
                      event.target.value
                    ),
                })
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {[1, 2, 3, 5].map(
                (value) => (
                  <option
                    key={
                      value
                    }
                    value={
                      value
                    }
                  >
                    {value}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Fill Model
            </div>

            <select
              value={
                settings.fillModel ??
                "quarter_spread"
              }
              onChange={(
                event
              ) =>
                onSettings({
                  fillModel:
                    event.target.value,
                })
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              <option value="midpoint">
                Midpoint
              </option>

              <option value="quarter_spread">
                25% toward bid/ask
              </option>

              <option value="conservative">
                Ask in / bid out
              </option>
            </select>
          </label>

          <div className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Backend Tracker
            </div>

            <div
              className={
                scheduler.backend_scheduler_active
                  ? "mt-2 font-mono text-sm font-bold text-emerald-300"
                  : "mt-2 font-mono text-sm font-bold text-red-300"
              }
            >
              {scheduler.backend_scheduler_active
                ? "ACTIVE"
                : "OFF"}
            </div>

            <div className="mt-1 text-[9px] text-zinc-600">
              Last run:{" "}
              {scheduler.last_run_at
                ? new Date(
                    scheduler.last_run_at
                  ).toLocaleTimeString()
                : "—"}
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() =>
              onOpen(
                "call"
              )
            }
            disabled={
              loading ||
              !connected
            }
            className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-4 text-left disabled:opacity-30"
          >
            <div className="text-[9px] uppercase tracking-widest text-emerald-400">
              Bullish practice
            </div>

            <div className="mt-1 text-base font-bold text-white">
              BUY PAPER CALL
            </div>

            <div className="mt-1 text-[9px] text-zinc-500">
              Buys the near-ATM long call only. Maximum paper loss is the premium paid.
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              onOpen(
                "put"
              )
            }
            disabled={
              loading ||
              !connected
            }
            className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-4 text-left disabled:opacity-30"
          >
            <div className="text-[9px] uppercase tracking-widest text-red-400">
              Bearish practice
            </div>

            <div className="mt-1 text-base font-bold text-white">
              BUY PAPER PUT
            </div>

            <div className="mt-1 text-[9px] text-zinc-500">
              Buys the near-ATM long put only. Maximum paper loss is the premium paid.
            </div>
          </button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Stat
            label="Total Trades"
            value={
              summary.total_trades ??
              0
            }
          />

          <Stat
            label="Open"
            value={
              summary.open_trades ??
              0
            }
          />

          <Stat
            label="Closed"
            value={
              summary.closed_trades ??
              0
            }
          />

          <Stat
            label="Win Rate"
            value={pct(
              summary.win_rate_pct
            )}
          />

          <Stat
            label="Average Return"
            value={pct(
              summary.average_return_pct
            )}
          />

          <Stat
            label="Total P/L"
            value={dollar(
              summary.total_pl
            )}
          />

          <Stat
            label="Profit Factor"
            value={ratio(
              summary.profit_factor
            )}
          />

          <Stat
            label="Max DD"
            value={dollar(
              summary.max_drawdown
            )}
          />
        </div>

        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Open calls / puts
          </div>

          {openTrades.length >
          0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {openTrades.map(
                (trade) => (
                  <div
                    key={
                      trade.id
                    }
                    className={
                      trade.optionType ===
                      "call"
                        ? "rounded-xl border border-emerald-500/20 bg-emerald-500/[0.02] p-3"
                        : "rounded-xl border border-red-500/20 bg-red-500/[0.02] p-3"
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-sm font-bold text-white">
                          {trade.symbol} {formatMoney(
                            trade.strike
                          )} {String(
                            trade.optionType
                          ).toUpperCase()}
                        </div>

                        <div className="mt-1 text-[9px] text-zinc-500">
                          {trade.quantity} contract{trade.quantity === 1 ? "" : "s"} · Exp {trade.expiration} · Entry DTE {trade.entryDte}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          onClose(
                            trade.id
                          )
                        }
                        disabled={
                          loading ||
                          !connected
                        }
                        className="rounded border border-amber-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-amber-300 disabled:opacity-30"
                      >
                        Close Paper Position
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat
                        label="Entry Fill"
                        value={formatMoney(
                          trade.entryFill
                        )}
                      />

                      <Stat
                        label="Current Mid"
                        value={formatMoney(
                          trade.currentMidpoint
                        )}
                      />

                      <Stat
                        label="Current P/L"
                        value={dollar(
                          trade.currentPL
                        )}
                      />

                      <Stat
                        label="MFE / MAE"
                        value={
                          dollar(
                            trade.maxFavorablePL
                          ) +
                          " / " +
                          dollar(
                            trade.maxAdversePL
                          )
                        }
                      />

                      <Stat
                        label="Delta"
                        value={formatSignedNumber(
                          trade.entryDelta,
                          3
                        )}
                      />

                      <Stat
                        label="Theta"
                        value={formatSignedNumber(
                          trade.entryTheta,
                          3
                        )}
                      />

                      <Stat
                        label="IV"
                        value={formatPercent(
                          trade.entryIv
                        )}
                      />

                      <Stat
                        label="Volume / OI"
                        value={
                          formatCompact(
                            trade.entryVolume
                          ) +
                          " / " +
                          formatCompact(
                            trade.entryOpenInterest
                          )
                        }
                      />
                    </div>

                    <div className="mt-2 text-[9px] text-zinc-600">
                      Entry midpoint {formatMoney(
                        trade.entryMidpoint
                      )} · simulated slippage {toNumber(
                        trade.entrySlippageCents
                      ) !==
                      null
                        ? Number(
                            trade.entrySlippageCents
                          ).toFixed(
                            1
                          ) +
                          "¢"
                        : "—"}
                    </div>
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
              No open single-leg paper position. Use Buy Paper Call or Buy Paper Put above.
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Closed call / put journal
          </div>

          {closedTrades.length >
          0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="min-w-[1150px] w-full text-[9px] font-mono">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-600">
                    <th className="px-3 py-2 text-left">
                      Contract
                    </th>

                    <th className="px-3 py-2 text-left">
                      Entry
                    </th>

                    <th className="px-3 py-2 text-left">
                      Exit
                    </th>

                    <th className="px-3 py-2 text-right">
                      Entry Fill
                    </th>

                    <th className="px-3 py-2 text-right">
                      Exit Fill
                    </th>

                    <th className="px-3 py-2 text-right">
                      P/L
                    </th>

                    <th className="px-3 py-2 text-right">
                      Return
                    </th>

                    <th className="px-3 py-2 text-right">
                      MFE
                    </th>

                    <th className="px-3 py-2 text-right">
                      MAE
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {[...closedTrades]
                    .reverse()
                    .map(
                      (trade) => (
                        <tr
                          key={
                            trade.id
                          }
                          className="border-b border-zinc-900"
                        >
                          <td
                            className={
                              trade.optionType ===
                              "call"
                                ? "px-3 py-2 text-left text-emerald-300"
                                : "px-3 py-2 text-left text-red-300"
                            }
                          >
                            {trade.symbol} {formatMoney(
                              trade.strike
                            )} {String(
                              trade.optionType
                            ).toUpperCase()}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {new Date(
                              trade.entryTimestamp
                            ).toLocaleDateString()}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {trade.exitTimestamp
                              ? new Date(
                                  trade.exitTimestamp
                                ).toLocaleDateString()
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              trade.entryFill
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {formatMoney(
                              trade.exitFill
                            )}
                          </td>

                          <td
                            className={
                              toNumber(
                                trade.realizedPL
                              ) >
                              0
                                ? "px-3 py-2 text-right text-emerald-300"
                                : "px-3 py-2 text-right text-red-300"
                            }
                          >
                            {dollar(
                              trade.realizedPL
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              trade.realizedReturnPct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-emerald-300">
                            {dollar(
                              trade.maxFavorablePL
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {dollar(
                              trade.maxAdversePL
                            )}
                          </td>
                        </tr>
                      )
                    )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[10px] text-zinc-600">
              No closed single-leg paper trades yet.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


/*
  =========================================================
  SINGLE-LEG HISTORICAL RESEARCH
  =========================================================
*/

function SingleLegHistoricalResearchPanel({
  tickers,
  settings,
  setSettings,
  result,
  loading,
  error,
  onRun,
  connected,
}) {
  const selected =
    result?.selected_candidate ??
    null;

  const baseline =
    result?.baseline ??
    null;

  const topCandidates =
    Array.isArray(
      result?.top_candidates
    )
      ? result.top_candidates
      : [];

  const dataset =
    Array.isArray(
      result?.selected_test_dataset
    )
      ? result.selected_test_dataset
      : [];

  const coverage =
    result?.coverage ??
    {};

  const pct =
    (
      value,
      digits = 1
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : ""
          ) +
          n.toFixed(
            digits
          ) +
          "%";
    };

  const dollar =
    (
      value,
      digits = 0
    ) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : (
            n >=
            0
              ? "+"
              : "-"
          ) +
          "$" +
          Math.abs(
            n
          ).toFixed(
            digits
          );
    };

  const ratio =
    (value) => {
      const n =
        toNumber(
          value
        );

      return n ===
        null
        ? "—"
        : n.toFixed(
            2
          ) +
          "×";
    };

  function targetLabel(
    value
  ) {
    return value ===
      null ||
      value ===
        undefined
      ? "None"
      : "+" +
        value +
        "%";
  }

  function stopLabel(
    value
  ) {
    return value ===
      null ||
      value ===
        undefined
      ? "None"
      : "-" +
        value +
        "%";
  }

  function downloadDataset() {
    if (!dataset.length) {
      return;
    }

    const headers =
      Object.keys(
        dataset[0]
      );

    const esc =
      (value) => {
        if (
          value ===
            null ||
          value ===
            undefined
        ) {
          return "";
        }

        const text =
          String(
            value
          );

        if (
          text.includes(",") ||
          text.includes('"') ||
          text.includes("\n")
        ) {
          return (
            '"' +
            text.replaceAll(
              '"',
              '""'
            ) +
            '"'
          );
        }

        return text;
      };

    const csv = [
      headers.join(","),
      ...dataset.map(
        (row) =>
          headers
            .map(
              (header) =>
                esc(
                  row[
                    header
                  ]
                )
            )
            .join(",")
      ),
    ].join("\n");

    const blob =
      new Blob(
        [csv],
        {
          type:
            "text/csv;charset=utf-8",
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      document.createElement(
        "a"
      );

    link.href =
      url;

    link.download =
      "single-leg-" +
      (
        result?.option_type ??
        settings.optionType
      ) +
      "-research-test.csv";

    document.body.appendChild(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );
  }

  function SummaryCard({
    title,
    summary,
    accent,
  }) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-black/25 p-3">
        <div
          className={
            "text-[10px] font-bold " +
            accent
          }
        >
          {title}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat
            label="Trades"
            value={
              summary?.trades ??
              0
            }
          />

          <Stat
            label="Win Rate"
            value={pct(
              summary?.win_rate_pct
            )}
          />

          <Stat
            label="Avg Return"
            value={pct(
              summary?.average_return_pct
            )}
          />

          <Stat
            label="Median"
            value={pct(
              summary?.median_return_pct
            )}
          />

          <Stat
            label="Profit Factor"
            value={ratio(
              summary?.profit_factor
            )}
          />

          <Stat
            label="Max DD"
            value={pct(
              summary?.max_drawdown_pct
            )}
          />
        </div>
      </div>
    );
  }

  return (
    <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="mx-auto max-w-7xl rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-fuchsia-400">
              Single-leg historical research
            </div>

            <div className="mt-1 text-lg font-bold text-white">
              Refine historical call and put entries and exits
            </div>

            <div className="mt-1 text-[10px] text-zinc-500">
              Uses expired Robinhood option contracts and historical daily option OHLC. The recent test segment is not used to choose the candidate.
            </div>
          </div>

          <button
            type="button"
            onClick={
              downloadDataset
            }
            disabled={
              !dataset.length
            }
            className="rounded border border-cyan-400/40 px-3 py-2 text-[9px] uppercase tracking-widest text-cyan-300 disabled:opacity-30"
          >
            Download Test CSV
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              setSettings(
                (current) => ({
                  ...current,

                  optionType:
                    "call",
                })
              )
            }
            className={
              settings.optionType ===
              "call"
                ? "rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-bold text-emerald-300"
                : "rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-zinc-400"
            }
          >
            CALL RESEARCH
          </button>

          <button
            type="button"
            onClick={() =>
              setSettings(
                (current) => ({
                  ...current,

                  optionType:
                    "put",
                })
              )
            }
            className={
              settings.optionType ===
              "put"
                ? "rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-300"
                : "rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs text-zinc-400"
            }
          >
            PUT RESEARCH
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Ticker
            </div>

            <select
              value={
                settings.symbol
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    symbol:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs text-white"
            >
              {tickers.map(
                (ticker) => (
                  <option
                    key={
                      ticker
                    }
                    value={
                      ticker
                    }
                  >
                    {ticker}
                  </option>
                )
              )}
            </select>
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Lookback Days
            </div>

            <input
              type="number"
              min="180"
              max="730"
              step="30"
              value={
                settings.lookbackDays
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    lookbackDays:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <label className="rounded-lg border border-zinc-800 bg-black/25 p-3">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600">
              Max Signals / Profile
            </div>

            <input
              type="number"
              min="20"
              max="100"
              step="5"
              value={
                settings.maxSignalsPerProfile
              }
              onChange={(
                event
              ) =>
                setSettings(
                  (current) => ({
                    ...current,

                    maxSignalsPerProfile:
                      event.target.value,
                  })
                )
              }
              className="mt-2 w-full bg-transparent font-mono text-sm text-white outline-none"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={
                onRun
              }
              disabled={
                loading ||
                !connected ||
                !settings.symbol
              }
              className={
                settings.optionType ===
                "call"
                  ? "w-full rounded border border-emerald-400/50 bg-emerald-400/10 px-4 py-2.5 text-[10px] font-bold text-emerald-300 disabled:opacity-30"
                  : "w-full rounded border border-red-400/50 bg-red-400/10 px-4 py-2.5 text-[10px] font-bold text-red-300 disabled:opacity-30"
              }
            >
              {loading
                ? "RUNNING SINGLE-LEG RESEARCH..."
                : "RUN " +
                  String(
                    settings.optionType
                  ).toUpperCase() +
                  " RESEARCH"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
          Search space: 7/9/14/21/30 DTE · about 2% ITM / ATM / 2% OTM · 2-of-3 or 3-of-3 momentum · multiple RSI thresholds · 1/3/5/7/10-session max holds · profit targets from +20% to +100% or none · stops from -20% to -50% or none.
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
            Single-leg research error: {error}
          </div>
        )}

        {!error &&
          result && (
          <>
            <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
              {result.methodology?.entry}{" "}
              {result.methodology?.contract}{" "}
              {result.methodology?.exit}{" "}
              <span className="text-amber-300">
                {result.methodology?.caution}
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              <Stat
                label="Replayable Signal Dates"
                value={
                  coverage.replayable_signal_dates ??
                  0
                }
              />

              <Stat
                label="Base Entry Rows"
                value={
                  coverage.base_rows ??
                  0
                }
              />

              <Stat
                label="Unique Contracts"
                value={
                  coverage.unique_option_contracts ??
                  0
                }
              />

              <Stat
                label="Setup Skips"
                value={
                  coverage.setup_skips ??
                  0
                }
              />

              <Stat
                label="Replay Skips"
                value={
                  coverage.replay_skips ??
                  0
                }
              />

              <Stat
                label="Train Dates"
                value={
                  result.split?.train_signal_dates ??
                  0
                }
              />

              <Stat
                label="Validation Dates"
                value={
                  result.split?.validation_signal_dates ??
                  0
                }
              />

              <Stat
                label="Test Dates"
                value={
                  result.split?.test_signal_dates ??
                  0
                }
              />
            </div>

            {selected ? (
              <div
                className={
                  result.option_type ===
                  "call"
                    ? "mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.03] p-4"
                    : "mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.03] p-4"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div
                      className={
                        result.option_type ===
                        "call"
                          ? "text-[9px] uppercase tracking-widest text-emerald-400"
                          : "text-[9px] uppercase tracking-widest text-red-400"
                      }
                    >
                      Validation-selected {String(
                        result.option_type
                      ).toUpperCase()} setup
                    </div>

                    <div className="mt-1 text-base font-bold text-white">
                      {selected.parameters?.target_dte} DTE · {selected.parameters?.moneyness_label} · {selected.parameters?.required_signals}/3 signals · RSI {selected.parameters?.rsi_threshold} · max {selected.parameters?.max_hold_sessions} sessions · target {targetLabel(
                        selected.parameters?.profit_target_pct
                      )} · stop {stopLabel(
                        selected.parameters?.stop_loss_pct
                      )}
                    </div>

                    <div className="mt-1 text-[9px] text-zinc-500">
                      Validation score{" "}
                      {toNumber(
                        selected.validation_score
                      ) !==
                      null
                        ? Number(
                            selected.validation_score
                          ).toFixed(
                            2
                          )
                        : "—"}
                      . The test segment was not used to select this candidate.
                    </div>
                  </div>

                  <div className="rounded border border-fuchsia-500/30 px-2 py-1 text-[9px] uppercase tracking-widest text-fuchsia-300">
                    Holdout preserved
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <SummaryCard
                    title="Training · early 60%"
                    summary={
                      selected.train
                    }
                    accent="text-zinc-300"
                  />

                  <SummaryCard
                    title="Validation · middle 20%"
                    summary={
                      selected.validation
                    }
                    accent="text-fuchsia-300"
                  />

                  <SummaryCard
                    title="Untouched test · recent 20%"
                    summary={
                      selected.test
                    }
                    accent="text-amber-300"
                  />
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Test Avg Winner"
                    value={pct(
                      selected.test?.average_winner_pct
                    )}
                  />

                  <Stat
                    label="Test Avg Loser"
                    value={pct(
                      selected.test?.average_loser_pct
                    )}
                  />

                  <Stat
                    label="Test MFE / MAE"
                    value={
                      pct(
                        selected.test?.average_mfe_pct
                      ) +
                      " / " +
                      pct(
                        selected.test?.average_mae_pct
                      )
                    }
                  />

                  <Stat
                    label="Test 50% Gain / Loss Rate"
                    value={
                      pct(
                        selected.test?.gain_50_rate_pct
                      ) +
                      " / " +
                      pct(
                        selected.test?.loss_50_rate_pct
                      )
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3 text-[10px] text-amber-300">
                No candidate met the minimum training and validation requirements for this run.
              </div>
            )}

            {baseline && (
              <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-3">
                <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                  Current single-leg practice baseline
                </div>

                <div className="mt-1 text-[10px] text-zinc-400">
                  {String(
                    result.option_type
                  ).toUpperCase()} · 9 DTE · ATM · 2/3 signals · RSI {baseline.parameters?.rsi_threshold} · 5-session hold · no target · no stop
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label="Validation Avg"
                    value={pct(
                      baseline.validation?.average_return_pct
                    )}
                  />

                  <Stat
                    label="Validation PF"
                    value={ratio(
                      baseline.validation?.profit_factor
                    )}
                  />

                  <Stat
                    label="Test Avg"
                    value={pct(
                      baseline.test?.average_return_pct
                    )}
                  />

                  <Stat
                    label="Test PF"
                    value={ratio(
                      baseline.test?.profit_factor
                    )}
                  />
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
                Top validation candidates
              </div>

              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="min-w-[1700px] w-full text-[9px] font-mono">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-600">
                      <th className="px-3 py-2 text-right">DTE</th>
                      <th className="px-3 py-2 text-left">Strike</th>
                      <th className="px-3 py-2 text-right">Signals</th>
                      <th className="px-3 py-2 text-right">RSI</th>
                      <th className="px-3 py-2 text-right">Hold</th>
                      <th className="px-3 py-2 text-right">Target</th>
                      <th className="px-3 py-2 text-right">Stop</th>
                      <th className="px-3 py-2 text-right">Train N</th>
                      <th className="px-3 py-2 text-right">Val N</th>
                      <th className="px-3 py-2 text-right">Val Avg</th>
                      <th className="px-3 py-2 text-right">Val PF</th>
                      <th className="px-3 py-2 text-right">Test N</th>
                      <th className="px-3 py-2 text-right">Test Avg</th>
                      <th className="px-3 py-2 text-right">Test Median</th>
                      <th className="px-3 py-2 text-right">Test PF</th>
                      <th className="px-3 py-2 text-right">Test DD</th>
                    </tr>
                  </thead>

                  <tbody>
                    {topCandidates.map(
                      (candidate) => (
                        <tr
                          key={
                            candidate.id
                          }
                          className="border-b border-zinc-900"
                        >
                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.target_dte}
                          </td>

                          <td className="px-3 py-2 text-left">
                            {candidate.parameters?.moneyness_label}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.required_signals}/3
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.rsi_threshold}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.parameters?.max_hold_sessions}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {targetLabel(
                              candidate.parameters?.profit_target_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {stopLabel(
                              candidate.parameters?.stop_loss_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.train?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.validation?.trades ?? 0}
                          </td>

                          <td className="px-3 py-2 text-right text-fuchsia-300">
                            {pct(
                              candidate.validation?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.validation?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {candidate.test?.trades ?? 0}
                          </td>

                          <td
                            className={
                              "px-3 py-2 text-right " +
                              (
                                toNumber(
                                  candidate.test?.average_return_pct
                                ) >
                                0
                                  ? "text-emerald-300"
                                  : "text-red-300"
                              )
                            }
                          >
                            {pct(
                              candidate.test?.average_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {pct(
                              candidate.test?.median_return_pct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right">
                            {ratio(
                              candidate.test?.profit_factor
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {pct(
                              candidate.test?.max_drawdown_pct
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.035] p-3 text-[9px] leading-relaxed text-zinc-500">
              Do not switch candidates after inspecting their untouched test results. This is a research lab, not a live-trading recommendation. The next stage is walk-forward testing of single-leg rules that survive this screen.
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/*
  =========================================================
  TICKER TAG
  =========================================================
*/

function TickerTag({
  ticker,
  onRemove,
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-mono">
      {ticker}

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();

          onRemove(
            ticker
          );
        }}
        className="ml-1 text-zinc-500 hover:text-red-300"
      >
        ×
      </button>
    </span>
  );
}

/*
  =========================================================
  FILTERS
  =========================================================
*/

function filterCards(
  cards,
  mode
) {
  switch (mode) {
    case "RSI Overbought":
      return cards.filter(
        (card) =>
          card.rsi !==
            null &&
          card.rsi >= 70
      );

    case "RSI Oversold":
      return cards.filter(
        (card) =>
          card.rsi !==
            null &&
          card.rsi <= 30
      );

    case "MACD Bullish":
      return cards.filter(
        (card) =>
          card.macd
            ?.histogram >
          0
      );

    case "MACD Bearish":
      return cards.filter(
        (card) =>
          card.macd
            ?.histogram <
          0
      );

    case "High ATM IV":
      return cards.filter(
        (card) =>
          card.atmIV !==
            null &&
          card.atmIV >= 0.5
      );

    default:
      return cards;
  }
}

/*
  =========================================================
  MAIN
  =========================================================
*/

export default function OptionsScanner() {
  const [
    tickers,
    setTickers,
  ] =
    useState([]);

  const [
    tickerData,
    setTickerData,
  ] =
    useState([]);

  const [
    addInput,
    setAddInput,
  ] =
    useState("");

  const [
    loading,
    setLoading,
  ] =
    useState(false);

  const [
    loadProgress,
    setLoadProgress,
  ] =
    useState(0);

  const [
    errors,
    setErrors,
  ] =
    useState({});

  const [
    selected,
    setSelected,
  ] =
    useState(null);

  const [
    filterMode,
    setFilterMode,
  ] =
    useState("All");

  const [
    robinhoodStatus,
    setRobinhoodStatus,
  ] =
    useState({
      connected:
        false,

      oauthPending:
        false,
    });

  const [
    aiEnabled,
    setAiEnabled,
  ] =
    useState(false);

  const [
    statusLoading,
    setStatusLoading,
  ] =
    useState(true);

  const [
    summaryOpen,
    setSummaryOpen,
  ] =
    useState(false);

  const [
    summary,
    setSummary,
  ] =
    useState("");

  const [
    summaryLoading,
    setSummaryLoading,
  ] =
    useState(false);

  const [
    savedPlansOpen,
    setSavedPlansOpen,
  ] =
    useState(true);

  const [
    savedPlansRevision,
    setSavedPlansRevision,
  ] =
    useState(0);

  const [
    autoRefreshEnabled,
    setAutoRefreshEnabled,
  ] =
    useState(() => {
      try {
        const raw =
          window.localStorage.getItem(
            AUTO_REFRESH_STORAGE_KEY
          );

        const parsed =
          raw
            ? JSON.parse(
                raw
              )
            : null;

        return !!parsed?.enabled;
      } catch {
        return false;
      }
    });

  const [
    autoRefreshSeconds,
    setAutoRefreshSeconds,
  ] =
    useState(() => {
      try {
        const raw =
          window.localStorage.getItem(
            AUTO_REFRESH_STORAGE_KEY
          );

        const parsed =
          raw
            ? JSON.parse(
                raw
              )
            : null;

        const seconds =
          Number(
            parsed?.seconds
          );

        return [
          30,
          60,
          300,
        ].includes(
          seconds
        )
          ? seconds
          : 60;
      } catch {
        return 60;
      }
    });

  const [
    dataUpdatedAt,
    setDataUpdatedAt,
  ] =
    useState(null);

  const [
    nowTick,
    setNowTick,
  ] =
    useState(
      Date.now()
    );

  const [
    newConditionCount,
    setNewConditionCount,
  ] =
    useState(0);

  const [
    notificationsEnabled,
    setNotificationsEnabled,
  ] =
    useState(() => {
      try {
        const raw =
          window.localStorage.getItem(
            NOTIFICATION_STORAGE_KEY
          );

        const parsed =
          raw
            ? JSON.parse(
                raw
              )
            : null;

        return !!parsed?.enabled;
      } catch {
        return false;
      }
    });

  const [
    notificationPermission,
    setNotificationPermission,
  ] =
    useState(() => {
      if (
        typeof window ===
          "undefined" ||
        !(
          "Notification" in
          window
        )
      ) {
        return "unsupported";
      }

      return window.Notification.permission;
    });

  const [
    persistentStateReady,
    setPersistentStateReady,
  ] =
    useState(false);

  const [
    persistentStateStatus,
    setPersistentStateStatus,
  ] =
    useState("syncing");

  const [
    systemHealthOpen,
    setSystemHealthOpen,
  ] =
    useState(false);

  const [
    systemHealth,
    setSystemHealth,
  ] =
    useState(null);

  const [
    systemHealthLoading,
    setSystemHealthLoading,
  ] =
    useState(false);

  const [
    systemHealthError,
    setSystemHealthError,
  ] =
    useState("");

  const [
    tradeAnalyticsOpen,
    setTradeAnalyticsOpen,
  ] =
    useState(false);

  const [
    tradeAnalytics,
    setTradeAnalytics,
  ] =
    useState(null);

  const [
    tradeAnalyticsLoading,
    setTradeAnalyticsLoading,
  ] =
    useState(false);

  const [
    tradeAnalyticsError,
    setTradeAnalyticsError,
  ] =
    useState("");

  const [
    backtestOpen,
    setBacktestOpen,
  ] =
    useState(false);

  const [
    backtestResult,
    setBacktestResult,
  ] =
    useState(null);

  const [
    backtestLoading,
    setBacktestLoading,
  ] =
    useState(false);

  const [
    backtestError,
    setBacktestError,
  ] =
    useState("");

  const [
    backtestSettings,
    setBacktestSettings,
  ] =
    useState({
      symbol:
        "PLTR",

      lookbackDays:
        365,

      holdDays:
        5,

      costBps:
        0,

      nonOverlapping:
        true,
    });

  const [
    researchOpen,
    setResearchOpen,
  ] =
    useState(false);

  const [
    researchResult,
    setResearchResult,
  ] =
    useState(null);

  const [
    researchLoading,
    setResearchLoading,
  ] =
    useState(false);

  const [
    researchError,
    setResearchError,
  ] =
    useState("");

  const [
    researchSettings,
    setResearchSettings,
  ] =
    useState({
      scope:
        "selected",

      symbol:
        "PLTR",

      lookbackDays:
        730,

      costBps:
        10,

      nonOverlapping:
        true,
    });

  const [
    walkForwardOpen,
    setWalkForwardOpen,
  ] =
    useState(false);

  const [
    walkForwardResult,
    setWalkForwardResult,
  ] =
    useState(null);

  const [
    walkForwardLoading,
    setWalkForwardLoading,
  ] =
    useState(false);

  const [
    walkForwardError,
    setWalkForwardError,
  ] =
    useState("");

  const [
    walkForwardSettings,
    setWalkForwardSettings,
  ] =
    useState({
      scope:
        "all",

      symbol:
        "PLTR",

      lookbackDays:
        1095,

      trainDays:
        365,

      validationDays:
        90,

      testDays:
        60,

      costBps:
        10,

      nonOverlapping:
        true,
    });

  const [
    riskOverlayOpen,
    setRiskOverlayOpen,
  ] =
    useState(false);

  const [
    riskOverlayResult,
    setRiskOverlayResult,
  ] =
    useState(null);

  const [
    riskOverlayLoading,
    setRiskOverlayLoading,
  ] =
    useState(false);

  const [
    riskOverlayError,
    setRiskOverlayError,
  ] =
    useState("");

  const [
    riskOverlaySettings,
    setRiskOverlaySettings,
  ] =
    useState({
      scope:
        "all",

      symbol:
        "PLTR",

      lookbackDays:
        1095,

      trainDays:
        365,

      validationDays:
        90,

      testDays:
        60,

      costBps:
        10,

      nonOverlapping:
        true,
    });

  const [
    nestedRiskOpen,
    setNestedRiskOpen,
  ] =
    useState(false);

  const [
    nestedRiskResult,
    setNestedRiskResult,
  ] =
    useState(null);

  const [
    nestedRiskLoading,
    setNestedRiskLoading,
  ] =
    useState(false);

  const [
    nestedRiskError,
    setNestedRiskError,
  ] =
    useState("");

  const [
    nestedRiskSettings,
    setNestedRiskSettings,
  ] =
    useState({
      scope:
        "all",

      symbol:
        "PLTR",

      lookbackDays:
        1095,

      trainDays:
        365,

      strategyValidationDays:
        60,

      riskCalibrationDays:
        30,

      testDays:
        60,

      costBps:
        10,

      nonOverlapping:
        true,
    });

  const [
    optionReplayOpen,
    setOptionReplayOpen,
  ] =
    useState(false);

  const [
    optionReplayResult,
    setOptionReplayResult,
  ] =
    useState(null);

  const [
    optionReplayLoading,
    setOptionReplayLoading,
  ] =
    useState(false);

  const [
    optionReplayError,
    setOptionReplayError,
  ] =
    useState("");

  const [
    optionReplaySettings,
    setOptionReplaySettings,
  ] =
    useState({
      symbol:
        "PLTR",

      directionMode:
        "both",

      lookbackDays:
        180,

      holdDays:
        5,

      targetDte:
        9,

      shortDistancePct:
        4,

      maxSignals:
        12,
    });

  const [
    optionResearchOpen,
    setOptionResearchOpen,
  ] =
    useState(false);

  const [
    optionResearchResult,
    setOptionResearchResult,
  ] =
    useState(null);

  const [
    optionResearchLoading,
    setOptionResearchLoading,
  ] =
    useState(false);

  const [
    optionResearchError,
    setOptionResearchError,
  ] =
    useState("");

  const [
    optionResearchSettings,
    setOptionResearchSettings,
  ] =
    useState({
      symbol:
        "PLTR",

      lookbackDays:
        365,

      maxSignalsPerHold:
        24,
    });

  const [
    optionWalkForwardOpen,
    setOptionWalkForwardOpen,
  ] =
    useState(false);

  const [
    optionWalkForwardResult,
    setOptionWalkForwardResult,
  ] =
    useState(null);

  const [
    optionWalkForwardLoading,
    setOptionWalkForwardLoading,
  ] =
    useState(false);

  const [
    optionWalkForwardError,
    setOptionWalkForwardError,
  ] =
    useState("");

  const [
    optionWalkForwardSettings,
    setOptionWalkForwardSettings,
  ] =
    useState({
      symbol:
        "PLTR",

      lookbackDays:
        730,

      trainCoverageDates:
        60,

      validationCoverageDates:
        24,

      testCoverageDates:
        8,

      maxSignalsPerHold:
        60,
    });

  const [
    executionStressOpen,
    setExecutionStressOpen,
  ] =
    useState(false);

  const [
    executionStressResult,
    setExecutionStressResult,
  ] =
    useState(null);

  const [
    executionStressLoading,
    setExecutionStressLoading,
  ] =
    useState(false);

  const [
    executionStressError,
    setExecutionStressError,
  ] =
    useState("");

  const [
    executionStressSettings,
    setExecutionStressSettings,
  ] =
    useState({
      symbol:
        "PLTR",

      lookbackDays:
        730,

      trainCoverageDates:
        60,

      validationCoverageDates:
        24,

      testCoverageDates:
        8,

      maxSignalsPerHold:
        60,

      feePerContractPerLeg:
        0,
    });

  const [
    forwardValidatorOpen,
    setForwardValidatorOpen,
  ] =
    useState(false);

  const [
    forwardValidatorStatus,
    setForwardValidatorStatus,
  ] =
    useState(null);

  const [
    forwardValidatorLoading,
    setForwardValidatorLoading,
  ] =
    useState(false);

  const [
    forwardValidatorError,
    setForwardValidatorError,
  ] =
    useState("");

  const forwardValidatorTickRef =
    useRef(false);

  const [
    singleLegPracticeOpen,
    setSingleLegPracticeOpen,
  ] =
    useState(false);

  const [
    singleLegPracticeStatus,
    setSingleLegPracticeStatus,
  ] =
    useState(null);

  const [
    singleLegPracticeLoading,
    setSingleLegPracticeLoading,
  ] =
    useState(false);

  const [
    singleLegPracticeError,
    setSingleLegPracticeError,
  ] =
    useState("");

  const [
    singleLegResearchOpen,
    setSingleLegResearchOpen,
  ] =
    useState(false);

  const [
    singleLegResearchResult,
    setSingleLegResearchResult,
  ] =
    useState(null);

  const [
    singleLegResearchLoading,
    setSingleLegResearchLoading,
  ] =
    useState(false);

  const [
    singleLegResearchError,
    setSingleLegResearchError,
  ] =
    useState("");

  const [
    singleLegResearchSettings,
    setSingleLegResearchSettings,
  ] =
    useState({
      symbol:
        "PLTR",

      optionType:
        "call",

      lookbackDays:
        730,

      maxSignalsPerProfile:
        80,
    });

  const scanInProgressRef =
    useRef(false);

  const previousConditionKeysRef =
    useRef(null);

  const savedPlans =
    useMemo(
      () =>
        loadSavedStrategyPlans(),
      [
        savedPlansRevision,
        selected,
      ]
    );

  const savedPlanCounts =
    useMemo(
      () =>
        savedPlanCountsByTicker(
          savedPlans
        ),
      [
        savedPlans,
      ]
    );

  const activeConditionEntries =
    useMemo(
      () => {
        const entries = [];

        for (
          const plan of savedPlans
        ) {
          const liveData =
            tickerData.find(
              (item) =>
                item.ticker ===
                normalizeTicker(
                  plan?.ticker
                )
            );

          const conditions =
            buildPlanStatusConditions(
              plan,
              liveData
            );

          for (
            const condition of conditions
          ) {
            entries.push({
              key:
                `${plan.id || plan.structureKey}|${condition.label}`,

              ticker:
                normalizeTicker(
                  plan?.ticker
                ),

              label:
                condition.label,

              tone:
                condition.tone,

              plan,
            });
          }
        }

        return entries.sort(
          (a, b) =>
            a.key.localeCompare(
              b.key
            )
        );
      },
      [
        savedPlans,
        tickerData,
      ]
    );

  const activeConditionKeys =
    useMemo(
      () =>
        activeConditionEntries.map(
          (entry) =>
            entry.key
        ),
      [
        activeConditionEntries,
      ]
    );

  const dataAgeSeconds =
    dataUpdatedAt
      ? Math.max(
          0,
          Math.floor(
            (
              nowTick -
              dataUpdatedAt
            ) /
              1000
          )
        )
      : null;

  const staleThresholdSeconds =
    autoRefreshEnabled
      ? Math.max(
          autoRefreshSeconds *
            2,
          60
        )
      : 120;

  const dataIsStale =
    dataAgeSeconds !==
      null &&
    dataAgeSeconds >
      staleThresholdSeconds;

  const visibleCards =
    useMemo(
      () =>
        filterMode ===
        "Saved Plans"
          ? tickerData.filter(
              (item) =>
                (
                  savedPlanCounts[
                    item.ticker
                  ] || 0
                ) > 0
            )
          : filterCards(
              tickerData,
              filterMode
            ),
      [
        tickerData,
        filterMode,
        savedPlanCounts,
      ]
    );

  useEffect(() => {
    let cancelled =
      false;

    async function hydratePersistentState() {
      setPersistentStateStatus(
        "syncing"
      );

      const localPlans =
        loadSavedStrategyPlans();

      const localComparisons =
        readLocalJson(
          SAVED_COMPARISONS_STORAGE_KEY,
          {}
        );

      const localAuto =
        readLocalJson(
          AUTO_REFRESH_STORAGE_KEY,
          {
            enabled:
              autoRefreshEnabled,

            seconds:
              autoRefreshSeconds,
          }
        );

      const localNotifications =
        readLocalJson(
          NOTIFICATION_STORAGE_KEY,
          {
            enabled:
              notificationsEnabled,
          }
        );

      try {
        const merged =
          await fetchJson(
            `${PROXY_BASE}/scanner/state/migrate`,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body:
                JSON.stringify({
                  savedPlans:
                    localPlans,

                  savedComparisons:
                    localComparisons,

                  preferences: {
                    autoRefresh:
                      localAuto,

                    notifications:
                      localNotifications,
                  },
                }),
            }
          );

        if (cancelled) {
          return;
        }

        writeLocalJson(
          SAVED_PLANS_STORAGE_KEY,
          Array.isArray(
            merged?.savedPlans
          )
            ? merged.savedPlans
            : []
        );

        writeLocalJson(
          SAVED_COMPARISONS_STORAGE_KEY,
          merged?.savedComparisons &&
          typeof merged.savedComparisons ===
            "object"
            ? merged.savedComparisons
            : {}
        );

        const remoteSeconds =
          Number(
            merged?.preferences
              ?.autoRefresh
              ?.seconds
          );

        const normalizedSeconds =
          [
            30,
            60,
            300,
          ].includes(
            remoteSeconds
          )
            ? remoteSeconds
            : 60;

        setAutoRefreshEnabled(
          !!merged?.preferences
            ?.autoRefresh
            ?.enabled
        );

        setAutoRefreshSeconds(
          normalizedSeconds
        );

        writeLocalJson(
          AUTO_REFRESH_STORAGE_KEY,
          {
            enabled:
              !!merged?.preferences
                ?.autoRefresh
                ?.enabled,

            seconds:
              normalizedSeconds,
          }
        );

        const remoteNotificationsEnabled =
          !!merged?.preferences
            ?.notifications
            ?.enabled;

        const canEnableNotifications =
          notificationPermission ===
          "granted";

        setNotificationsEnabled(
          remoteNotificationsEnabled &&
          canEnableNotifications
        );

        writeLocalJson(
          NOTIFICATION_STORAGE_KEY,
          {
            enabled:
              remoteNotificationsEnabled &&
              canEnableNotifications,
          }
        );

        setSavedPlansRevision(
          (value) =>
            value + 1
        );

        setPersistentStateStatus(
          "synced"
        );

      } catch (error) {
        if (!cancelled) {
          console.warn(
            "Backend state sync failed:",
            error
          );

          setPersistentStateStatus(
            "local-only"
          );
        }

      } finally {
        if (!cancelled) {
          setPersistentStateReady(
            true
          );
        }
      }
    }

    hydratePersistentState();

    return () => {
      cancelled =
        true;
    };
  }, []);

  useEffect(() => {
    const refreshSavedPlans =
      () =>
        setSavedPlansRevision(
          (value) =>
            value + 1
        );

    window.addEventListener(
      "storage",
      refreshSavedPlans
    );

    window.addEventListener(
      "focus",
      refreshSavedPlans
    );

    return () => {
      window.removeEventListener(
        "storage",
        refreshSavedPlans
      );

      window.removeEventListener(
        "focus",
        refreshSavedPlans
      );
    };
  }, []);

  useEffect(() => {
    const timer =
      window.setInterval(
        () =>
          setNowTick(
            Date.now()
          ),
        1000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, []);

  useEffect(() => {
    writeLocalJson(
      AUTO_REFRESH_STORAGE_KEY,
      {
        enabled:
          autoRefreshEnabled,

        seconds:
          autoRefreshSeconds,
      }
    );

    writeLocalJson(
      NOTIFICATION_STORAGE_KEY,
      {
        enabled:
          notificationsEnabled,
      }
    );

    if (
      !persistentStateReady
    ) {
      return;
    }

    fetchJson(
      `${PROXY_BASE}/scanner/state/preferences`,
      {
        method:
          "PUT",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            preferences: {
              autoRefresh: {
                enabled:
                  autoRefreshEnabled,

                seconds:
                  autoRefreshSeconds,
              },

              notifications: {
                enabled:
                  notificationsEnabled,
              },
            },
          }),
      }
    )
      .then(
        () =>
          setPersistentStateStatus(
            "synced"
          )
      )
      .catch(
        (error) => {
          console.warn(
            "Preference persistence failed:",
            error
          );

          setPersistentStateStatus(
            "local-only"
          );
        }
      );
  }, [
    autoRefreshEnabled,
    autoRefreshSeconds,
    notificationsEnabled,
    persistentStateReady,
  ]);

  useEffect(() => {
    if (
      notificationPermission !==
        "granted" &&
      notificationsEnabled
    ) {
      setNotificationsEnabled(
        false
      );
    }
  }, [
    notificationPermission,
    notificationsEnabled,
  ]);

  useEffect(() => {
    const previous =
      previousConditionKeysRef.current;

    const currentSet =
      new Set(
        activeConditionKeys
      );

    if (
      previous === null
    ) {
      previousConditionKeysRef.current =
        currentSet;

      return;
    }

    const addedEntries =
      activeConditionEntries.filter(
        (entry) =>
          !previous.has(
            entry.key
          )
      );

    if (
      addedEntries.length >
      0
    ) {
      setNewConditionCount(
        (current) =>
          current +
          addedEntries.length
      );

      if (
        notificationsEnabled &&
        notificationPermission ===
          "granted" &&
        typeof window !==
          "undefined" &&
        "Notification" in
          window
      ) {
        for (
          const entry of addedEntries
        ) {
          try {
            const notification =
              new window.Notification(
                `${entry.ticker} saved-plan condition`,
                {
                  body:
                    entry.label,

                  tag:
                    `options-scanner-${entry.key}`,
                }
              );

            notification.onclick =
              () => {
                window.focus();

                const liveTicker =
                  tickerData.find(
                    (item) =>
                      item.ticker ===
                      entry.ticker
                  );

                if (
                  liveTicker
                ) {
                  setSelected(
                    liveTicker
                  );
                }

                notification.close();
              };
          } catch {
            // Browser can reject notifications in restricted environments.
          }
        }
      }
    }

    previousConditionKeysRef.current =
      currentSet;
  }, [
    activeConditionKeys,
    activeConditionEntries,
    notificationsEnabled,
    notificationPermission,
    tickerData,
  ]);

  const refreshSystemHealth =
    useCallback(
      async () => {
        setSystemHealthLoading(
          true
        );

        setSystemHealthError(
          ""
        );

        try {
          const health =
            await fetchJson(
              `${PROXY_BASE}/scanner/health`
            );

          setSystemHealth(
            health
          );

          return health;

        } catch (error) {
          setSystemHealthError(
            error.message
          );

          return null;

        } finally {
          setSystemHealthLoading(
            false
          );
        }
      },
      []
    );

  useEffect(() => {
    if (
      !systemHealthOpen
    ) {
      return;
    }

    refreshSystemHealth();

    const timer =
      window.setInterval(
        refreshSystemHealth,
        30000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, [
    systemHealthOpen,
    refreshSystemHealth,
  ]);

  const refreshTradeAnalytics =
    useCallback(
      async () => {
        setTradeAnalyticsLoading(
          true
        );

        setTradeAnalyticsError(
          ""
        );

        try {
          const result =
            await fetchJson(
              `${PROXY_BASE}/scanner/paper-analytics`
            );

          setTradeAnalytics(
            result
          );

          return result;

        } catch (error) {
          setTradeAnalyticsError(
            error.message
          );

          return null;

        } finally {
          setTradeAnalyticsLoading(
            false
          );
        }
      },
      []
    );

  useEffect(() => {
    if (
      !tradeAnalyticsOpen
    ) {
      return;
    }

    refreshTradeAnalytics();
  }, [
    tradeAnalyticsOpen,
    refreshTradeAnalytics,
  ]);

  const runHistoricalBacktest =
    useCallback(
      async () => {
        setBacktestLoading(
          true
        );

        setBacktestError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/backtest",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      backtestSettings.symbol,

                    lookbackDays:
                      Number(
                        backtestSettings.lookbackDays
                      ),

                    holdDays:
                      Number(
                        backtestSettings.holdDays
                      ),

                    costBps:
                      Number(
                        backtestSettings.costBps
                      ) ||
                      0,

                    nonOverlapping:
                      !!backtestSettings.nonOverlapping,
                  }),
              }
            );

          setBacktestResult(
            result
          );

          return result;

        } catch (error) {
          setBacktestError(
            error.message
          );

          return null;

        } finally {
          setBacktestLoading(
            false
          );
        }
      },
      [
        backtestSettings,
      ]
    );

  const runBacktestResearch =
    useCallback(
      async () => {
        setResearchLoading(
          true
        );

        setResearchError(
          ""
        );

        try {
          const symbols =
            researchSettings.scope ===
            "all"
              ? tickers
              : [
                  researchSettings.symbol,
                ];

          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/backtest-research",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbols,

                    lookbackDays:
                      Number(
                        researchSettings.lookbackDays
                      ),

                    costBps:
                      Number(
                        researchSettings.costBps
                      ) ||
                      0,

                    nonOverlapping:
                      !!researchSettings.nonOverlapping,
                  }),
              }
            );

          setResearchResult(
            result
          );

          return result;

        } catch (error) {
          setResearchError(
            error.message
          );

          return null;

        } finally {
          setResearchLoading(
            false
          );
        }
      },
      [
        researchSettings,
        tickers,
      ]
    );

  const runWalkForward =
    useCallback(
      async () => {
        setWalkForwardLoading(
          true
        );

        setWalkForwardError(
          ""
        );

        try {
          const symbols =
            walkForwardSettings.scope ===
            "all"
              ? tickers
              : [
                  walkForwardSettings.symbol,
                ];

          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/walk-forward",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbols,

                    lookbackDays:
                      Number(
                        walkForwardSettings.lookbackDays
                      ),

                    trainDays:
                      Number(
                        walkForwardSettings.trainDays
                      ),

                    validationDays:
                      Number(
                        walkForwardSettings.validationDays
                      ),

                    testDays:
                      Number(
                        walkForwardSettings.testDays
                      ),

                    costBps:
                      Number(
                        walkForwardSettings.costBps
                      ) ||
                      0,

                    nonOverlapping:
                      !!walkForwardSettings.nonOverlapping,
                  }),
              }
            );

          setWalkForwardResult(
            result
          );

          return result;

        } catch (error) {
          setWalkForwardError(
            error.message
          );

          return null;

        } finally {
          setWalkForwardLoading(
            false
          );
        }
      },
      [
        walkForwardSettings,
        tickers,
      ]
    );

  const runRiskOverlay =
    useCallback(
      async () => {
        setRiskOverlayLoading(
          true
        );

        setRiskOverlayError(
          ""
        );

        try {
          const symbols =
            riskOverlaySettings.scope ===
            "all"
              ? tickers
              : [
                  riskOverlaySettings.symbol,
                ];

          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/risk-overlay-walk-forward",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbols,

                    lookbackDays:
                      Number(
                        riskOverlaySettings.lookbackDays
                      ),

                    trainDays:
                      Number(
                        riskOverlaySettings.trainDays
                      ),

                    validationDays:
                      Number(
                        riskOverlaySettings.validationDays
                      ),

                    testDays:
                      Number(
                        riskOverlaySettings.testDays
                      ),

                    costBps:
                      Number(
                        riskOverlaySettings.costBps
                      ) ||
                      0,

                    nonOverlapping:
                      !!riskOverlaySettings.nonOverlapping,
                  }),
              }
            );

          setRiskOverlayResult(
            result
          );

          return result;

        } catch (error) {
          setRiskOverlayError(
            error.message
          );

          return null;

        } finally {
          setRiskOverlayLoading(
            false
          );
        }
      },
      [
        riskOverlaySettings,
        tickers,
      ]
    );

  const runNestedRisk =
    useCallback(
      async () => {
        setNestedRiskLoading(
          true
        );

        setNestedRiskError(
          ""
        );

        try {
          const symbols =
            nestedRiskSettings.scope ===
            "all"
              ? tickers
              : [
                  nestedRiskSettings.symbol,
                ];

          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/nested-risk-walk-forward",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbols,

                    lookbackDays:
                      Number(
                        nestedRiskSettings.lookbackDays
                      ),

                    trainDays:
                      Number(
                        nestedRiskSettings.trainDays
                      ),

                    strategyValidationDays:
                      Number(
                        nestedRiskSettings.strategyValidationDays
                      ),

                    riskCalibrationDays:
                      Number(
                        nestedRiskSettings.riskCalibrationDays
                      ),

                    testDays:
                      Number(
                        nestedRiskSettings.testDays
                      ),

                    costBps:
                      Number(
                        nestedRiskSettings.costBps
                      ) ||
                      0,

                    nonOverlapping:
                      !!nestedRiskSettings.nonOverlapping,
                  }),
              }
            );

          setNestedRiskResult(
            result
          );

          return result;

        } catch (error) {
          setNestedRiskError(
            error.message
          );

          return null;

        } finally {
          setNestedRiskLoading(
            false
          );
        }
      },
      [
        nestedRiskSettings,
        tickers,
      ]
    );

  const runOptionReplay =
    useCallback(
      async () => {
        setOptionReplayLoading(
          true
        );

        setOptionReplayError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/option-spread-replay",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      optionReplaySettings.symbol,

                    directionMode:
                      optionReplaySettings.directionMode,

                    lookbackDays:
                      Number(
                        optionReplaySettings.lookbackDays
                      ),

                    holdDays:
                      Number(
                        optionReplaySettings.holdDays
                      ),

                    targetDte:
                      Number(
                        optionReplaySettings.targetDte
                      ),

                    shortDistancePct:
                      Number(
                        optionReplaySettings.shortDistancePct
                      ),

                    maxSignals:
                      Number(
                        optionReplaySettings.maxSignals
                      ),
                  }),
              }
            );

          setOptionReplayResult(
            result
          );

          return result;

        } catch (error) {
          setOptionReplayError(
            error.message
          );

          return null;

        } finally {
          setOptionReplayLoading(
            false
          );
        }
      },
      [
        optionReplaySettings,
      ]
    );

  const runOptionResearch =
    useCallback(
      async () => {
        setOptionResearchLoading(
          true
        );

        setOptionResearchError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/option-replay-research",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      optionResearchSettings.symbol,

                    lookbackDays:
                      Number(
                        optionResearchSettings.lookbackDays
                      ),

                    maxSignalsPerHold:
                      Number(
                        optionResearchSettings.maxSignalsPerHold
                      ),
                  }),
              }
            );

          setOptionResearchResult(
            result
          );

          return result;

        } catch (error) {
          setOptionResearchError(
            error.message
          );

          return null;

        } finally {
          setOptionResearchLoading(
            false
          );
        }
      },
      [
        optionResearchSettings,
      ]
    );

  const runOptionWalkForward =
    useCallback(
      async () => {
        setOptionWalkForwardLoading(
          true
        );

        setOptionWalkForwardError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/option-replay-walk-forward",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      optionWalkForwardSettings.symbol,

                    lookbackDays:
                      Number(
                        optionWalkForwardSettings.lookbackDays
                      ),

                    trainCoverageDates:
                      Number(
                        optionWalkForwardSettings.trainCoverageDates
                      ),

                    validationCoverageDates:
                      Number(
                        optionWalkForwardSettings.validationCoverageDates
                      ),

                    testCoverageDates:
                      Number(
                        optionWalkForwardSettings.testCoverageDates
                      ),

                    maxSignalsPerHold:
                      Number(
                        optionWalkForwardSettings.maxSignalsPerHold
                      ),
                  }),
              }
            );

          setOptionWalkForwardResult(
            result
          );

          return result;

        } catch (error) {
          setOptionWalkForwardError(
            error.message
          );

          return null;

        } finally {
          setOptionWalkForwardLoading(
            false
          );
        }
      },
      [
        optionWalkForwardSettings,
      ]
    );

  const runExecutionStress =
    useCallback(
      async () => {
        setExecutionStressLoading(
          true
        );

        setExecutionStressError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/option-execution-stress",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      executionStressSettings.symbol,

                    lookbackDays:
                      Number(
                        executionStressSettings.lookbackDays
                      ),

                    trainCoverageDates:
                      Number(
                        executionStressSettings.trainCoverageDates
                      ),

                    validationCoverageDates:
                      Number(
                        executionStressSettings.validationCoverageDates
                      ),

                    testCoverageDates:
                      Number(
                        executionStressSettings.testCoverageDates
                      ),

                    maxSignalsPerHold:
                      Number(
                        executionStressSettings.maxSignalsPerHold
                      ),

                    feePerContractPerLeg:
                      Number(
                        executionStressSettings.feePerContractPerLeg
                      ) ||
                      0,

                    frictionTiers: [
                      0,
                      5,
                      10,
                      25,
                      50,
                    ],
                  }),
              }
            );

          setExecutionStressResult(
            result
          );

          return result;

        } catch (error) {
          setExecutionStressError(
            error.message
          );

          return null;

        } finally {
          setExecutionStressLoading(
            false
          );
        }
      },
      [
        executionStressSettings,
      ]
    );

  const refreshForwardValidator =
    useCallback(
      async () => {
        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/forward-validator"
            );

          setForwardValidatorStatus(
            result
          );

          return result;

        } catch (error) {
          setForwardValidatorError(
            error.message
          );

          return null;
        }
      },
      []
    );

  const runForwardValidatorTick =
    useCallback(
      async () => {
        if (
          forwardValidatorTickRef.current
        ) {
          return null;
        }

        forwardValidatorTickRef.current =
          true;

        setForwardValidatorLoading(
          true
        );

        setForwardValidatorError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/forward-validator/tick",
              {
                method:
                  "POST",
              }
            );

          setForwardValidatorStatus(
            result
          );

          return result;

        } catch (error) {
          setForwardValidatorError(
            error.message
          );

          return null;

        } finally {
          forwardValidatorTickRef.current =
            false;

          setForwardValidatorLoading(
            false
          );
        }
      },
      []
    );

  const setForwardValidatorEnabled =
    useCallback(
      async (enabled) => {
        setForwardValidatorLoading(
          true
        );

        setForwardValidatorError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/forward-validator/settings",
              {
                method:
                  "PUT",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    settings: {
                      enabled:
                        !!enabled,
                    },
                  }),
              }
            );

          setForwardValidatorStatus(
            result
          );

          if (
            enabled &&
            robinhoodStatus.connected
          ) {
            setTimeout(
              () => {
                runForwardValidatorTick();
              },
              50
            );
          }

          return result;

        } catch (error) {
          setForwardValidatorError(
            error.message
          );

          return null;

        } finally {
          setForwardValidatorLoading(
            false
          );
        }
      },
      [
        robinhoodStatus.connected,
        runForwardValidatorTick,
      ]
    );

  useEffect(() => {
    if (
      !robinhoodStatus.connected
    ) {
      return;
    }

    refreshForwardValidator();
  }, [
    robinhoodStatus.connected,
    refreshForwardValidator,
  ]);

  useEffect(() => {
    if (
      !robinhoodStatus.connected ||
      !forwardValidatorStatus
        ?.settings
        ?.enabled
    ) {
      return undefined;
    }

    const timer =
      window.setInterval(
        () => {
          refreshForwardValidator();
        },
        30000
      );

    return () => {
      window.clearInterval(
        timer
      );
    };
  }, [
    robinhoodStatus.connected,
    forwardValidatorStatus
      ?.settings
      ?.enabled,
    refreshForwardValidator,
  ]);

  const refreshSingleLegPractice =
    useCallback(
      async () => {
        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/single-leg-practice"
            );

          setSingleLegPracticeStatus(
            result
          );

          return result;

        } catch (error) {
          setSingleLegPracticeError(
            error.message
          );

          return null;
        }
      },
      []
    );

  const updateSingleLegPracticeSettings =
    useCallback(
      async (patch) => {
        setSingleLegPracticeLoading(
          true
        );

        setSingleLegPracticeError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/single-leg-practice/settings",
              {
                method:
                  "PUT",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    settings:
                      patch,
                  }),
              }
            );

          setSingleLegPracticeStatus(
            result
          );

          return result;

        } catch (error) {
          setSingleLegPracticeError(
            error.message
          );

          return null;

        } finally {
          setSingleLegPracticeLoading(
            false
          );
        }
      },
      []
    );

  const openSingleLegPractice =
    useCallback(
      async (optionType) => {
        setSingleLegPracticeLoading(
          true
        );

        setSingleLegPracticeError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/single-leg-practice/open",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    optionType,

                    quantity:
                      singleLegPracticeStatus
                        ?.settings
                        ?.quantity ??
                      1,
                  }),
              }
            );

          setSingleLegPracticeStatus(
            result
          );

          return result;

        } catch (error) {
          setSingleLegPracticeError(
            error.message
          );

          return null;

        } finally {
          setSingleLegPracticeLoading(
            false
          );
        }
      },
      [
        singleLegPracticeStatus
          ?.settings
          ?.quantity,
      ]
    );

  const closeSingleLegPractice =
    useCallback(
      async (tradeId) => {
        setSingleLegPracticeLoading(
          true
        );

        setSingleLegPracticeError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/single-leg-practice/close",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    tradeId,
                  }),
              }
            );

          setSingleLegPracticeStatus(
            result
          );

          return result;

        } catch (error) {
          setSingleLegPracticeError(
            error.message
          );

          return null;

        } finally {
          setSingleLegPracticeLoading(
            false
          );
        }
      },
      []
    );

  useEffect(() => {
    if (
      !robinhoodStatus.connected ||
      !singleLegPracticeOpen
    ) {
      return undefined;
    }

    refreshSingleLegPractice();

    const timer =
      window.setInterval(
        () => {
          refreshSingleLegPractice();
        },
        30000
      );

    return () => {
      window.clearInterval(
        timer
      );
    };
  }, [
    robinhoodStatus.connected,
    singleLegPracticeOpen,
    refreshSingleLegPractice,
  ]);

  const runSingleLegResearch =
    useCallback(
      async () => {
        setSingleLegResearchLoading(
          true
        );

        setSingleLegResearchError(
          ""
        );

        try {
          const result =
            await fetchJson(
              PROXY_BASE +
              "/scanner/single-leg-research",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    symbol:
                      singleLegResearchSettings.symbol,

                    optionType:
                      singleLegResearchSettings.optionType,

                    lookbackDays:
                      Number(
                        singleLegResearchSettings.lookbackDays
                      ),

                    maxSignalsPerProfile:
                      Number(
                        singleLegResearchSettings.maxSignalsPerProfile
                      ),
                  }),
              }
            );

          setSingleLegResearchResult(
            result
          );

          return result;

        } catch (error) {
          setSingleLegResearchError(
            error.message
          );

          return null;

        } finally {
          setSingleLegResearchLoading(
            false
          );
        }
      },
      [
        singleLegResearchSettings,
      ]
    );

  /*
    =======================================================
    STATUS
    =======================================================
  */

  const refreshStatus =
    useCallback(
      async () => {
        try {
          const [
            status,
            health,
          ] =
            await Promise.all([
              fetchJson(
                `${PROXY_BASE}/robinhood/status`
              ),

              fetchJson(
                `${PROXY_BASE}/`
              ),
            ]);

          setRobinhoodStatus(
            status
          );

          setAiEnabled(
            !!health
              ?.anthropic
              ?.active
          );

          return status;

        } catch {
          const status = {
            connected:
              false,

            oauthPending:
              false,
          };

          setRobinhoodStatus(
            status
          );

          return status;

        } finally {
          setStatusLoading(
            false
          );
        }
      },
      []
    );

  /*
    =======================================================
    SCAN
    =======================================================
  */

  const scan =
    useCallback(
      async (list) => {
        if (
          scanInProgressRef.current
        ) {
          return;
        }

        if (
          !list?.length
        ) {
          setTickerData(
            []
          );

          return;
        }

        scanInProgressRef.current =
          true;

        setLoading(true);
        setLoadProgress(0);
        setErrors({});

        const collected =
          [];

        const failures =
          {};

        try {
          for (
            let i = 0;
            i < list.length;
            i++
          ) {
            const ticker =
              normalizeTicker(
                list[i]
              );

            if (!ticker) {
              continue;
            }

            try {
              const data =
                await fetchTicker(
                  ticker
                );

              collected.push(
                data
              );

              const map =
                new Map(
                  collected.map(
                    (item) => [
                      item.ticker,
                      item,
                    ]
                  )
                );

              const ordered =
                list
                  .map(
                    (symbol) =>
                      map.get(
                        normalizeTicker(
                          symbol
                        )
                      )
                  )
                  .filter(
                    Boolean
                  );

              setTickerData(
                ordered
              );

            } catch (error) {
              failures[
                ticker
              ] =
                error.message;

              setErrors({
                ...failures,
              });
            }

            setLoadProgress(
              Math.round(
                (
                  (i + 1) /
                  list.length
                ) *
                  100
              )
            );
          }

          setDataUpdatedAt(
            Date.now()
          );

          setNowTick(
            Date.now()
          );

        } finally {
          setLoading(false);

          scanInProgressRef.current =
            false;
        }
      },
      []
    );

  /*
    =======================================================
    INITIAL LOAD
    =======================================================
  */

  useEffect(() => {
    const saved =
      loadSavedTickers();

    setTickers(
      saved
    );

    refreshStatus()
      .then(
        (status) => {
          if (
            status.connected
          ) {
            scan(saved);
          }
        }
      );

  }, [
    refreshStatus,
    scan,
  ]);

  useEffect(() => {
    if (
      !autoRefreshEnabled ||
      !robinhoodStatus.connected ||
      !tickers.length
    ) {
      return;
    }

    const timer =
      window.setInterval(
        () => {
          scan(
            tickers
          );
        },
        autoRefreshSeconds *
          1000
      );

    return () =>
      window.clearInterval(
        timer
      );
  }, [
    autoRefreshEnabled,
    autoRefreshSeconds,
    robinhoodStatus.connected,
    tickers,
    scan,
  ]);

  const toggleNotifications =
    async () => {
      if (
        typeof window ===
          "undefined" ||
        !(
          "Notification" in
          window
        )
      ) {
        setNotificationPermission(
          "unsupported"
        );

        setNotificationsEnabled(
          false
        );

        return;
      }

      if (
        notificationsEnabled
      ) {
        setNotificationsEnabled(
          false
        );

        return;
      }

      let permission =
        window.Notification.permission;

      if (
        permission ===
        "default"
      ) {
        try {
          permission =
            await window.Notification.requestPermission();
        } catch {
          permission =
            window.Notification.permission;
        }
      }

      setNotificationPermission(
        permission
      );

      setNotificationsEnabled(
        permission ===
          "granted"
      );
    };

  /*
    =======================================================
    CONNECT ROBINHOOD
    =======================================================
  */

  const connectRobinhood =
    async () => {
      window.open(
        `${PROXY_BASE}/robinhood/connect`,
        "_blank",
        "noopener,noreferrer"
      );

      for (
        let i = 0;
        i < 40;
        i++
      ) {
        await sleep(
          1500
        );

        const status =
          await refreshStatus();

        if (
          status.connected
        ) {
          scan(
            tickers
          );

          break;
        }
      }
    };

  /*
    =======================================================
    ADD / REMOVE
    =======================================================
  */

  const addTicker =
    () => {
      const newSymbols =
        addInput
          .split(",")
          .map(
            normalizeTicker
          )
          .filter(Boolean)
          .filter(
            (ticker) =>
              !tickers.includes(
                ticker
              )
          );

      if (
        !newSymbols.length
      ) {
        setAddInput("");

        return;
      }

      const next = [
        ...tickers,
        ...newSymbols,
      ];

      setTickers(
        next
      );

      saveTickers(
        next
      );

      setAddInput("");

      if (
        robinhoodStatus.connected
      ) {
        scan(
          next
        );
      }
    };

  const removeTicker =
    (ticker) => {
      const next =
        tickers.filter(
          (item) =>
            item !== ticker
        );

      setTickers(
        next
      );

      setTickerData(
        (previous) =>
          previous.filter(
            (item) =>
              item.ticker !==
              ticker
          )
      );

      saveTickers(
        next
      );

      if (
        selected?.ticker ===
        ticker
      ) {
        setSelected(
          null
        );
      }
    };

  const openSavedTicker =
    (ticker) => {
      const match =
        tickerData.find(
          (item) =>
            item.ticker ===
            ticker
        );

      if (match) {
        setSelected(
          match
        );
      }
    };

  /*
    =======================================================
    AI MARKET SUMMARY
    =======================================================
  */

  const runSummary =
    async () => {
      if (
        !aiEnabled ||
        !tickerData.length
      ) {
        return;
      }

      setSummaryOpen(
        true
      );

      setSummaryLoading(
        true
      );

      setSummary("");

      const rows =
        tickerData.map(
          (item) =>
            `${item.ticker}: price=${item.price ?? "n/a"}, day=${item.changePct ?? "n/a"}%, RSI14=${item.rsi ?? "n/a"}, MACD=${item.macd?.macd ?? "n/a"}, signal=${item.macd?.signal ?? "n/a"}, hist=${item.macd?.histogram ?? "n/a"}, nearest_exp=${item.expiration ?? "n/a"}, ATM_IV=${item.atmIV ?? "n/a"}, near_ATM_PCR_volume=${item.pcrVolume ?? "n/a"}`
        );

      try {
        const result =
          await askClaude(
            `Compare these live Robinhood market snapshots:

${rows.join("\n")}

Identify:
1. strongest bullish momentum
2. strongest bearish momentum
3. unusual RSI conditions
4. high option IV
5. conflicts between RSI, MACD and options activity

Do not invent missing values.`
          );

        setSummary(
          result
        );

      } catch (error) {
        setSummary(
          `Error: ${error.message}`
        );

      } finally {
        setSummaryLoading(
          false
        );
      }
    };

  /*
    =======================================================
    RENDER
    =======================================================
  */

  const filterModes = [
    "All",
    "Saved Plans",
    "RSI Overbought",
    "RSI Oversold",
    "MACD Bullish",
    "MACD Bearish",
    "High ATM IV",
  ];

  return (
    <div
      className="min-h-screen bg-zinc-950 text-white"
      style={{
        fontFamily:
          "'IBM Plex Mono', monospace",
      }}
    >
      <style>
        {`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&family=Barlow+Condensed:wght@900&display=swap');

          .display {
            font-family: 'Barlow Condensed', sans-serif;
          }
        `}
      </style>

      {/* HEADER */}

      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="display text-4xl font-black tracking-tight">
              OPTIONS{" "}
              <span className="text-amber-400">
                SCANNER
              </span>
            </h1>

            <p className="mt-1 text-xs text-zinc-400">
              Robinhood Trading MCP
              · live quotes ·
              options · RSI · MACD
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`rounded-lg border px-3 py-2 text-xs font-mono ${
                robinhoodStatus.connected
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-red-500/30 bg-red-500/10 text-red-300"
              }`}
            >
              {statusLoading
                ? "Checking..."
                : robinhoodStatus.connected
                  ? "● Robinhood connected"
                  : "○ Robinhood disconnected"}
            </div>

            {!robinhoodStatus.connected && (
              <button
                onClick={
                  connectRobinhood
                }
                className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-black hover:bg-emerald-400"
              >
                Connect Robinhood
              </button>
            )}

            <button
              onClick={
                refreshStatus
              }
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-500"
            >
              ↻ Status
            </button>

            <button
              type="button"
              onClick={() =>
                setSystemHealthOpen(
                  (current) =>
                    !current
                )
              }
              className={`rounded-lg border px-3 py-2 text-xs font-mono ${
                systemHealthOpen
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              System Health
            </button>

            <button
              type="button"
              onClick={() =>
                setTradeAnalyticsOpen(
                  (current) =>
                    !current
                )
              }
              className={`rounded-lg border px-3 py-2 text-xs font-mono ${
                tradeAnalyticsOpen
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              Trade Analytics
            </button>

            <button
              type="button"
              onClick={() =>
                setBacktestOpen(
                  (current) =>
                    !current
                )
              }
              className={
                backtestOpen
                  ? "rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs font-mono text-blue-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Historical Backtest
            </button>

            <button
              type="button"
              onClick={() =>
                setResearchOpen(
                  (current) =>
                    !current
                )
              }
              className={
                researchOpen
                  ? "rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-xs font-mono text-fuchsia-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Research Lab
            </button>

            <button
              type="button"
              onClick={() =>
                setWalkForwardOpen(
                  (current) =>
                    !current
                )
              }
              className={
                walkForwardOpen
                  ? "rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-mono text-emerald-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Walk-Forward
            </button>

            <button
              type="button"
              onClick={() =>
                setRiskOverlayOpen(
                  (current) =>
                    !current
                )
              }
              className={
                riskOverlayOpen
                  ? "rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-mono text-amber-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Risk Overlay
            </button>

            <button
              type="button"
              onClick={() =>
                setNestedRiskOpen(
                  (current) =>
                    !current
                )
              }
              className={
                nestedRiskOpen
                  ? "rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs font-mono text-orange-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Nested Risk
            </button>

            <button
              type="button"
              onClick={() =>
                setOptionReplayOpen(
                  (current) =>
                    !current
                )
              }
              className={
                optionReplayOpen
                  ? "rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-mono text-sky-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Option Replay
            </button>

            <button
              type="button"
              onClick={() =>
                setOptionResearchOpen(
                  (current) =>
                    !current
                )
              }
              className={
                optionResearchOpen
                  ? "rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs font-mono text-indigo-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Option Research
            </button>

            <button
              type="button"
              onClick={() =>
                setOptionWalkForwardOpen(
                  (current) =>
                    !current
                )
              }
              className={
                optionWalkForwardOpen
                  ? "rounded-lg border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-mono text-teal-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Option Walk-Forward
            </button>

            <button
              type="button"
              onClick={() =>
                setExecutionStressOpen(
                  (current) =>
                    !current
                )
              }
              className={
                executionStressOpen
                  ? "rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-mono text-rose-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Execution Stress
            </button>

            <button
              type="button"
              onClick={() =>
                setForwardValidatorOpen(
                  (current) =>
                    !current
                )
              }
              className={
                forwardValidatorOpen
                  ? "rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-mono text-emerald-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Forward Validator
            </button>

            <button
              type="button"
              onClick={() =>
                setSingleLegPracticeOpen(
                  (current) =>
                    !current
                )
              }
              className={
                singleLegPracticeOpen
                  ? "rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs font-mono text-violet-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Calls / Puts Practice
            </button>

            <button
              type="button"
              onClick={() =>
                setSingleLegResearchOpen(
                  (current) =>
                    !current
                )
              }
              className={
                singleLegResearchOpen
                  ? "rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-xs font-mono text-fuchsia-300"
                  : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 hover:border-zinc-500"
              }
            >
              Single-Leg Research
            </button>

            <button
              onClick={() => {
                setSavedPlansOpen(
                  (current) =>
                    !current
                );

                setNewConditionCount(
                  0
                );
              }}
              className={`rounded-lg border px-3 py-2 text-xs font-mono ${
                savedPlansOpen
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              Saved Plans{" "}
              <span className="font-bold">
                {savedPlans.length}
              </span>

              {newConditionCount >
              0 && (
                <span className="ml-2 inline-flex animate-pulse rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                  NEW {newConditionCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={
                toggleNotifications
              }
              disabled={
                notificationPermission ===
                "unsupported"
              }
              title={
                notificationPermission ===
                "denied"
                  ? "Browser notifications are blocked for this site. Change the site notification permission in your browser settings."
                  : notificationPermission ===
                      "unsupported"
                    ? "Browser notifications are not supported in this environment."
                    : notificationsEnabled
                      ? "Turn browser notifications off."
                      : "Enable browser notifications for newly triggered saved-plan conditions."
              }
              className={`rounded-lg border px-3 py-2 text-xs font-mono disabled:cursor-not-allowed disabled:opacity-30 ${
                notificationsEnabled &&
                notificationPermission ===
                  "granted"
                  ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                  : notificationPermission ===
                      "denied"
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              {notificationPermission ===
              "denied"
                ? "Notifications Blocked"
                : notificationPermission ===
                    "unsupported"
                  ? "Notifications N/A"
                  : notificationsEnabled
                    ? "● Notifications"
                    : "○ Notifications"}
            </button>

            <button
              onClick={
                runSummary
              }
              disabled={
                !aiEnabled ||
                !tickerData.length ||
                summaryLoading
              }
              className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-black hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-30"
            >
              ⚡ Market Summary
            </button>
          </div>
        </div>

        <div className="border-t border-zinc-900 bg-black/20">
          <div className="mx-auto flex max-w-7xl items-center gap-5 px-6 py-2 text-[10px] uppercase tracking-widest">
            <span
              className={
                robinhoodStatus.connected
                  ? "text-emerald-400"
                  : "text-zinc-500"
              }
            >
              Market Data{" "}
              {robinhoodStatus.connected
                ? "LIVE"
                : "OFF"}
            </span>

            <span
              className={
                aiEnabled
                  ? "text-amber-400"
                  : "text-zinc-500"
              }
            >
              AI{" "}
              {aiEnabled
                ? "ENABLED"
                : "NOT CONFIGURED"}
            </span>

            <span className="text-zinc-600">
              Read-only scanner
            </span>

            <span
              className={
                dataIsStale
                  ? "text-amber-400"
                  : dataUpdatedAt
                    ? "text-sky-400"
                    : "text-zinc-600"
              }
            >
              {dataIsStale
                ? "Data stale · "
                : "Updated "}
              {formatDataAge(
                dataAgeSeconds
              )}
            </span>

            <span
              className={
                autoRefreshEnabled
                  ? "text-emerald-400"
                  : "text-zinc-600"
              }
            >
              Auto{" "}
              {autoRefreshEnabled
                ? `${autoRefreshSeconds}s`
                : "OFF"}
            </span>

            <span
              className={
                notificationsEnabled &&
                notificationPermission ===
                  "granted"
                  ? "text-sky-400"
                  : notificationPermission ===
                      "denied"
                    ? "text-red-400"
                    : "text-zinc-600"
              }
            >
              Notifications{" "}
              {notificationPermission ===
              "denied"
                ? "BLOCKED"
                : notificationsEnabled &&
                    notificationPermission ===
                      "granted"
                  ? "ON"
                  : "OFF"}
            </span>

            <span
              className={
                persistentStateStatus ===
                  "synced"
                  ? "text-violet-400"
                  : persistentStateStatus ===
                      "syncing"
                    ? "text-zinc-500"
                    : "text-amber-400"
              }
            >
              Storage{" "}
              {persistentStateStatus ===
              "synced"
                ? "SYNCED"
                : persistentStateStatus ===
                    "syncing"
                  ? "SYNCING"
                  : "LOCAL ONLY"}
            </span>
          </div>
        </div>
      </header>

      {/* SYSTEM HEALTH */}

      {systemHealthOpen && (
        <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
          <div className="mx-auto max-w-7xl rounded-xl border border-violet-500/20 bg-violet-500/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-violet-400">
                  System health
                </div>

                <div className="mt-1 text-lg font-bold text-white">
                  Scanner runtime status
                </div>

                <div className="mt-1 text-[10px] text-zinc-500">
                  Frontend, Robinhood connection, persistence, refresh loop, notification permission, and backend state file.
                </div>
              </div>

              <button
                type="button"
                onClick={
                  refreshSystemHealth
                }
                disabled={
                  systemHealthLoading
                }
                className="rounded border border-zinc-700 px-3 py-1.5 text-[9px] uppercase tracking-widest text-zinc-400 hover:border-violet-400/40 hover:text-violet-300 disabled:opacity-40"
              >
                {systemHealthLoading
                  ? "Refreshing..."
                  : "Refresh Health"}
              </button>
            </div>

            {systemHealthError ? (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[10px] text-red-300">
                Health endpoint unavailable: {systemHealthError}
              </div>
            ) : (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <Stat
                  label="Robinhood"
                  value={
                    robinhoodStatus.connected
                      ? "CONNECTED"
                      : "DISCONNECTED"
                  }
                  color={
                    robinhoodStatus.connected
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                />

                <Stat
                  label="Storage"
                  value={
                    persistentStateStatus ===
                    "synced"
                      ? "SYNCED"
                      : persistentStateStatus ===
                          "syncing"
                        ? "SYNCING"
                        : "LOCAL ONLY"
                  }
                  color={
                    persistentStateStatus ===
                    "synced"
                      ? "text-violet-300"
                      : persistentStateStatus ===
                          "syncing"
                        ? "text-zinc-300"
                        : "text-amber-300"
                  }
                />

                <Stat
                  label="Notifications"
                  value={
                    notificationPermission ===
                    "denied"
                      ? "BLOCKED"
                      : notificationsEnabled &&
                          notificationPermission ===
                          "granted"
                        ? "ON"
                        : notificationPermission ===
                            "unsupported"
                          ? "N/A"
                          : "OFF"
                  }
                  color={
                    notificationsEnabled &&
                    notificationPermission ===
                    "granted"
                      ? "text-sky-300"
                      : notificationPermission ===
                          "denied"
                        ? "text-red-300"
                        : "text-zinc-300"
                  }
                />

                <Stat
                  label="Auto Refresh"
                  value={
                    autoRefreshEnabled
                      ? `ON · ${autoRefreshSeconds}s`
                      : "OFF"
                  }
                  color={
                    autoRefreshEnabled
                      ? "text-emerald-300"
                      : "text-zinc-300"
                  }
                />

                <Stat
                  label="Last Scan"
                  value={
                    dataIsStale
                      ? `STALE · ${formatDataAge(
                          dataAgeSeconds
                        )}`
                      : formatDataAge(
                          dataAgeSeconds
                        )
                  }
                  color={
                    dataIsStale
                      ? "text-amber-300"
                      : dataUpdatedAt
                        ? "text-sky-300"
                        : "text-zinc-300"
                  }
                />

                <Stat
                  label="Backend Uptime"
                  value={formatUptime(
                    systemHealth
                      ?.backend
                      ?.uptime_seconds
                  )}
                  color="text-zinc-200"
                />
              </div>
            )}

            {!systemHealthError && (
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="State File"
                  value={
                    systemHealth
                      ?.storage
                      ?.exists &&
                    systemHealth
                      ?.storage
                      ?.readable
                      ? "READY"
                      : systemHealthLoading
                        ? "CHECKING"
                        : "NOT READY"
                  }
                  color={
                    systemHealth
                      ?.storage
                      ?.exists &&
                    systemHealth
                      ?.storage
                      ?.readable
                      ? "text-emerald-300"
                      : "text-amber-300"
                  }
                />

                <Stat
                  label="State File Size"
                  value={formatBytes(
                    systemHealth
                      ?.storage
                      ?.size_bytes
                  )}
                />

                <Stat
                  label="Persisted Plans"
                  value={
                    systemHealth
                      ?.storage
                      ?.saved_plan_count ??
                    "—"
                  }
                  color="text-emerald-300"
                />

                <Stat
                  label="Persisted Comparisons"
                  value={
                    systemHealth
                      ?.storage
                      ?.saved_comparison_count ??
                    "—"
                  }
                  color="text-indigo-300"
                />
              </div>
            )}

            {!systemHealthError && (
              <div className="mt-3 rounded-lg border border-zinc-800 bg-black/20 p-3 text-[9px] leading-relaxed text-zinc-500">
                Backend state file:{" "}
                <span className="font-mono text-zinc-300">
                  {systemHealth
                    ?.storage
                    ?.file ??
                    ".data/scanner-state.json"}
                </span>
                {" · "}
                Last backend state update:{" "}
                <span className="font-mono text-zinc-300">
                  {systemHealth
                    ?.storage
                    ?.state_updated_at
                    ? new Date(
                        systemHealth.storage.state_updated_at
                      ).toLocaleString()
                    : "—"}
                </span>
                . Notification permission remains browser-specific even though the scanner preference is persisted.
              </div>
            )}
          </div>
        </section>
      )}

      {/* TRADE ANALYTICS */}

      {tradeAnalyticsOpen && (
        <TradeAnalyticsPanel
          analytics={
            tradeAnalytics
          }
          loading={
            tradeAnalyticsLoading
          }
          error={
            tradeAnalyticsError
          }
          onRefresh={
            refreshTradeAnalytics
          }
          onDownload={() =>
            window.open(
              `${PROXY_BASE}/scanner/paper-dataset.csv`,
              "_blank",
              "noopener,noreferrer"
            )
          }
        />
      )}

      {/* HISTORICAL BACKTEST */}

      {backtestOpen && (
        <HistoricalBacktestPanel
          tickers={
            tickers
          }
          settings={
            backtestSettings
          }
          setSettings={
            setBacktestSettings
          }
          result={
            backtestResult
          }
          loading={
            backtestLoading
          }
          error={
            backtestError
          }
          onRun={
            runHistoricalBacktest
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* RESEARCH LAB */}

      {researchOpen && (
        <BacktestResearchLabPanel
          tickers={
            tickers
          }
          settings={
            researchSettings
          }
          setSettings={
            setResearchSettings
          }
          result={
            researchResult
          }
          loading={
            researchLoading
          }
          error={
            researchError
          }
          onRun={
            runBacktestResearch
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* WALK-FORWARD LAB */}

      {walkForwardOpen && (
        <WalkForwardLabPanel
          tickers={
            tickers
          }
          settings={
            walkForwardSettings
          }
          setSettings={
            setWalkForwardSettings
          }
          result={
            walkForwardResult
          }
          loading={
            walkForwardLoading
          }
          error={
            walkForwardError
          }
          onRun={
            runWalkForward
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* RISK-OVERLAY WALK-FORWARD */}

      {riskOverlayOpen && (
        <RiskOverlayWalkForwardPanel
          tickers={
            tickers
          }
          settings={
            riskOverlaySettings
          }
          setSettings={
            setRiskOverlaySettings
          }
          result={
            riskOverlayResult
          }
          loading={
            riskOverlayLoading
          }
          error={
            riskOverlayError
          }
          onRun={
            runRiskOverlay
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* NESTED RISK WALK-FORWARD */}

      {nestedRiskOpen && (
        <NestedRiskWalkForwardPanel
          tickers={
            tickers
          }
          settings={
            nestedRiskSettings
          }
          setSettings={
            setNestedRiskSettings
          }
          result={
            nestedRiskResult
          }
          loading={
            nestedRiskLoading
          }
          error={
            nestedRiskError
          }
          onRun={
            runNestedRisk
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* HISTORICAL OPTION-SPREAD REPLAY */}

      {optionReplayOpen && (
        <HistoricalOptionReplayPanel
          tickers={
            tickers
          }
          settings={
            optionReplaySettings
          }
          setSettings={
            setOptionReplaySettings
          }
          result={
            optionReplayResult
          }
          loading={
            optionReplayLoading
          }
          error={
            optionReplayError
          }
          onRun={
            runOptionReplay
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* OPTION REPLAY RESEARCH */}

      {optionResearchOpen && (
        <OptionReplayResearchPanel
          tickers={
            tickers
          }
          settings={
            optionResearchSettings
          }
          setSettings={
            setOptionResearchSettings
          }
          result={
            optionResearchResult
          }
          loading={
            optionResearchLoading
          }
          error={
            optionResearchError
          }
          onRun={
            runOptionResearch
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* OPTION-SPREAD WALK-FORWARD */}

      {optionWalkForwardOpen && (
        <OptionSpreadWalkForwardPanel
          tickers={
            tickers
          }
          settings={
            optionWalkForwardSettings
          }
          setSettings={
            setOptionWalkForwardSettings
          }
          result={
            optionWalkForwardResult
          }
          loading={
            optionWalkForwardLoading
          }
          error={
            optionWalkForwardError
          }
          onRun={
            runOptionWalkForward
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* OPTION EXECUTION STRESS */}

      {executionStressOpen && (
        <OptionExecutionStressPanel
          tickers={
            tickers
          }
          settings={
            executionStressSettings
          }
          setSettings={
            setExecutionStressSettings
          }
          result={
            executionStressResult
          }
          loading={
            executionStressLoading
          }
          error={
            executionStressError
          }
          onRun={
            runExecutionStress
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* FORWARD PAPER VALIDATOR */}

      {forwardValidatorOpen && (
        <ForwardPaperValidatorPanel
          status={
            forwardValidatorStatus
          }
          loading={
            forwardValidatorLoading
          }
          error={
            forwardValidatorError
          }
          connected={
            robinhoodStatus.connected
          }
          onTick={
            runForwardValidatorTick
          }
          onToggle={
            setForwardValidatorEnabled
          }
        />
      )}

      {/* SINGLE-LEG CALL / PUT PRACTICE */}

      {singleLegPracticeOpen && (
        <SingleLegPracticePanel
          tickers={
            tickers
          }
          status={
            singleLegPracticeStatus
          }
          loading={
            singleLegPracticeLoading
          }
          error={
            singleLegPracticeError
          }
          connected={
            robinhoodStatus.connected
          }
          onRefresh={
            refreshSingleLegPractice
          }
          onOpen={
            openSingleLegPractice
          }
          onClose={
            closeSingleLegPractice
          }
          onSettings={
            updateSingleLegPracticeSettings
          }
        />
      )}

      {/* SINGLE-LEG HISTORICAL RESEARCH */}

      {singleLegResearchOpen && (
        <SingleLegHistoricalResearchPanel
          tickers={
            tickers
          }
          settings={
            singleLegResearchSettings
          }
          setSettings={
            setSingleLegResearchSettings
          }
          result={
            singleLegResearchResult
          }
          loading={
            singleLegResearchLoading
          }
          error={
            singleLegResearchError
          }
          onRun={
            runSingleLegResearch
          }
          connected={
            robinhoodStatus.connected
          }
        />
      )}

      {/* TICKERS */}

      <section className="border-b border-zinc-800 bg-zinc-900/40 px-6 py-3">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-wrap items-center gap-1.5">
            {tickers.map(
              (ticker) => (
                <TickerTag
                  key={
                    ticker
                  }
                  ticker={
                    ticker
                  }
                  onRemove={
                    removeTicker
                  }
                />
              )
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={
                addInput
              }
              onChange={(
                event
              ) =>
                setAddInput(
                  event.target.value
                )
              }
              onKeyDown={(
                event
              ) => {
                if (
                  event.key ===
                  "Enter"
                ) {
                  addTicker();
                }
              }}
              placeholder="Add ticker: NVDA, TSLA..."
              className="min-w-64 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono outline-none focus:border-amber-400"
            />

            <button
              onClick={
                addTicker
              }
              className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300 hover:bg-amber-400/20"
            >
              + Add
            </button>

            <button
              onClick={() =>
                scan(
                  tickers
                )
              }
              disabled={
                loading ||
                !robinhoodStatus.connected
              }
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-30"
            >
              {loading
                ? `Scanning ${loadProgress}%`
                : "↻ Rescan"}
            </button>

            {loading && (
              <div className="h-1 w-32 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-amber-400 transition-all"
                  style={{
                    width:
                      `${loadProgress}%`,
                  }}
                />
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                setAutoRefreshEnabled(
                  (current) =>
                    !current
                )
              }
              disabled={
                !robinhoodStatus.connected
              }
              className={`rounded-lg border px-3 py-2 text-xs font-mono disabled:opacity-30 ${
                autoRefreshEnabled
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {autoRefreshEnabled
                ? "● Auto Refresh"
                : "○ Auto Refresh"}
            </button>

            <select
              value={
                autoRefreshSeconds
              }
              onChange={(
                event
              ) =>
                setAutoRefreshSeconds(
                  Number(
                    event.target.value
                  )
                )
              }
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-mono text-zinc-300 outline-none"
            >
              <option value={30}>
                30 sec
              </option>

              <option value={60}>
                1 min
              </option>

              <option value={300}>
                5 min
              </option>
            </select>

            <div
              className={`rounded-lg border px-3 py-2 text-[10px] font-mono ${
                dataIsStale
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-500"
              }`}
            >
              {dataIsStale
                ? "STALE · "
                : "Updated "}
              {formatDataAge(
                dataAgeSeconds
              )}
            </div>

            <div className="text-[9px] text-zinc-600">
              Desktop notifications fire only for newly triggered saved-plan conditions while the screener page is running.
            </div>
          </div>
        </div>
      </section>

      {/* ERRORS */}

      {Object.keys(
        errors
      ).length > 0 && (
        <section className="border-b border-red-900/40 bg-red-950/20 px-6 py-2">
          <div className="mx-auto max-w-7xl text-xs text-red-300">
            Failed:{" "}
            {Object.entries(
              errors
            )
              .map(
                ([
                  ticker,
                  error,
                ]) =>
                  `${ticker}: ${error}`
              )
              .join(" | ")}
          </div>
        </section>
      )}

      {/* FILTERS */}

      <section className="border-b border-zinc-800 bg-zinc-900/20 px-6 py-2">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] uppercase tracking-widest text-zinc-500">
            Filter
          </span>

          {filterModes.map(
            (mode) => (
              <button
                key={
                  mode
                }
                onClick={() =>
                  setFilterMode(
                    mode
                  )
                }
                className={`rounded-full border px-2.5 py-1 text-[10px] font-mono ${
                  filterMode ===
                  mode
                    ? "border-amber-400/60 bg-amber-400/10 text-amber-300"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {mode}
              </button>
            )
          )}
        </div>
      </section>

      {/* SAVED PLANS SUMMARY */}

      {savedPlansOpen && (
        <section className="border-b border-zinc-800 bg-zinc-950 px-6 py-4">
          <div className="mx-auto max-w-7xl">
            <SavedPlansSummary
              plans={
                savedPlans
              }
              tickerData={
                tickerData
              }
              onOpenTicker={
                openSavedTicker
              }
            />
          </div>
        </section>
      )}

      {/* CARDS */}

      <main className="mx-auto max-w-7xl px-6 py-6">
        {!robinhoodStatus.connected &&
          !statusLoading && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-10 text-center">
              <div className="display text-4xl">
                ROBINHOOD CONNECTION REQUIRED
              </div>

              <p className="mt-2 text-sm text-zinc-400">
                Connect the scanner backend before loading live market data.
              </p>

              <button
                onClick={
                  connectRobinhood
                }
                className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-black"
              >
                Connect Robinhood
              </button>
            </div>
          )}

        {robinhoodStatus.connected &&
          tickerData.length ===
            0 &&
          !loading && (
            <div className="py-20 text-center text-zinc-500">
              <div className="display text-5xl">
                READY
              </div>

              <p className="mt-2 text-sm">
                Click Rescan to load Robinhood market data.
              </p>
            </div>
          )}

        {visibleCards.length ===
          0 &&
          tickerData.length >
            0 &&
          !loading && (
            <div className="py-20 text-center text-sm text-zinc-500">
              No tickers match{" "}
              <span className="text-amber-400">
                {filterMode}
              </span>
            </div>
          )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {visibleCards.map(
            (data) => (
              <TickerCard
                key={
                  data.ticker
                }
                data={
                  data
                }
                selected={
                  selected?.ticker ===
                  data.ticker
                }
                onSelect={
                  setSelected
                }
                savedPlanCount={
                  savedPlanCounts[
                    data.ticker
                  ] || 0
                }
              />
            )
          )}
        </div>
      </main>

      {/* FULL TICKER DETAIL MODAL */}

      {selected && (
        <TickerDetailModal
          data={
            selected
          }
          onClose={() => {
            setSelected(
              null
            );

            setSavedPlansRevision(
              (value) =>
                value + 1
            );
          }}
        />
      )}

      {/* AI SUMMARY */}

      {summaryOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() =>
            setSummaryOpen(
              false
            )
          }
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-amber-400/30 bg-zinc-950 p-6"
            onClick={(
              event
            ) =>
              event.stopPropagation()
            }
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="display text-3xl">
                  MARKET PULSE
                </h2>

                <div className="text-xs uppercase tracking-widest text-amber-400">
                  Cross-ticker analysis
                </div>
              </div>

              <button
                onClick={() =>
                  setSummaryOpen(
                    false
                  )
                }
                className="text-2xl text-zinc-400 hover:text-white"
              >
                ×
              </button>
            </div>

            {summaryLoading ? (
              <div className="py-10 text-sm text-zinc-300">
                Analyzing scanner...
              </div>
            ) : (
              <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
                {summary}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}