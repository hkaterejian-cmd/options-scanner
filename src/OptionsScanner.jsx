import {
  useCallback,
  useEffect,
  useMemo,
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

  const visibleCards =
    useMemo(
      () =>
        filterCards(
          tickerData,
          filterMode
        ),
      [
        tickerData,
        filterMode,
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
          !list?.length
        ) {
          setTickerData(
            []
          );

          return;
        }

        setLoading(true);
        setLoadProgress(0);
        setErrors({});

        const collected =
          [];

        const failures =
          {};

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

        setLoading(false);
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
          </div>
        </div>
      </header>

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
          onClose={() =>
            setSelected(
              null
            )
          }
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