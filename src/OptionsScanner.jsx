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