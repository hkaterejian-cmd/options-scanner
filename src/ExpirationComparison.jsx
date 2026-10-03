import {
  useEffect,
  useMemo,
  useState,
} from "react";

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

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function money(value) {
  const n =
    toNumber(value);

  return n === null
    ? "—"
    : `$${n.toFixed(2)}`;
}

function dollar(value) {
  const n =
    toNumber(value);

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

function pct(value) {
  const n =
    toNumber(value);

  return n === null
    ? "—"
    : `${(
        n *
        100
      ).toFixed(1)}%`;
}

function rawPct(
  value,
  digits = 1
) {
  const n =
    toNumber(value);

  return n === null
    ? "—"
    : `${n.toFixed(
        digits
      )}%`;
}

function signed(
  value,
  digits = 3
) {
  const n =
    toNumber(value);

  if (n === null) {
    return "—";
  }

  return `${
    n >= 0
      ? "+"
      : ""
  }${n.toFixed(
    digits
  )}`;
}

function signedDollar(
  value,
  digits = 2
) {
  const n =
    toNumber(value);

  if (n === null) {
    return "—";
  }

  return `${
    n >= 0
      ? "+"
      : "-"
  }$${Math.abs(
    n
  ).toFixed(
    digits
  )}`;
}

function compact(value) {
  const n =
    toNumber(value);

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
    ).toFixed(
      1
    )}M`;
  }

  if (
    Math.abs(n) >=
    1_000
  ) {
    return `${(
      n /
      1_000
    ).toFixed(
      1
    )}K`;
  }

  return String(
    Math.round(n)
  );
}

function shortDate(value) {
  if (!value) {
    return "—";
  }

  const date =
    new Date(
      `${value}T00:00:00`
    );

  return date.toLocaleDateString(
    undefined,
    {
      month:
        "short",

      day:
        "numeric",
    }
  );
}

function daysToExpiration(
  value
) {
  if (!value) {
    return null;
  }

  const expiration =
    new Date(
      `${value}T23:59:59`
    );

  const now =
    new Date();

  return Math.max(
    0,
    Math.ceil(
      (
        expiration -
        now
      ) /
        86_400_000
    )
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

  if (
    !response.ok
  ) {
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
    result
      ?.structuredContent
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
    const block of
      content
  ) {
    if (
      block?.type !==
        "text" ||
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
        method:
          "POST",

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
  FETCH OPTION CONTRACTS
  =========================================================
*/

async function fetchAllInstruments(
  ticker,
  expiration
) {
  const instruments =
    [];

  let cursor;
  let pages = 0;

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

function chunk(
  items,
  size
) {
  const result =
    [];

  for (
    let i = 0;
    i < items.length;
    i += size
  ) {
    result.push(
      items.slice(
        i,
        i + size
      )
    );
  }

  return result;
}

async function fetchQuotes(
  ids
) {
  if (
    !ids.length
  ) {
    return [];
  }

  const groups =
    chunk(
      ids,
      20
    );

  const results =
    await Promise.all(
      groups.map(
        async (
          instrumentIds
        ) => {
          const payload =
            await callRobinhood(
              "get_option_quotes",
              {
                instrument_ids:
                  instrumentIds,
              }
            );

          return (
            payload
              ?.data
              ?.results ??
            payload
              ?.results ??
            []
          );
        }
      )
    );

  return results.flat();
}

/*
  =========================================================
  STRIKE SELECTION
  =========================================================
*/

function selectStrikeBand(
  instruments,
  spot,
  radius = 12
) {
  const strikes =
    [
      ...new Set(
        instruments
          .map(
            (item) =>
              toNumber(
                item
                  .strike_price
              )
          )
          .filter(
            (strike) =>
              strike !==
              null
          )
      ),
    ].sort(
      (a, b) =>
        a - b
    );

  if (
    !strikes.length
  ) {
    return [];
  }

  let atmIndex =
    0;

  let distance =
    Infinity;

  strikes.forEach(
    (
      strike,
      index
    ) => {
      const currentDistance =
        Math.abs(
          strike -
          spot
        );

      if (
        currentDistance <
        distance
      ) {
        atmIndex =
          index;

        distance =
          currentDistance;
      }
    }
  );

  const selectedStrikes =
    strikes.slice(
      Math.max(
        0,
        atmIndex -
          radius
      ),

      Math.min(
        strikes.length,
        atmIndex +
          radius +
          1
      )
    );

  const set =
    new Set(
      selectedStrikes
    );

  return instruments.filter(
    (instrument) =>
      set.has(
        toNumber(
          instrument
            .strike_price
        )
      )
  );
}

/*
  =========================================================
  CONTRACT NORMALIZATION
  =========================================================
*/

function buildContracts(
  instruments,
  results
) {
  const quoteMap =
    new Map();

  for (
    const result of
      results
  ) {
    if (
      result?.quote
        ?.instrument_id
    ) {
      quoteMap.set(
        result.quote
          .instrument_id,

        result.quote
      );
    }
  }

  return instruments.map(
    (instrument) => {
      const quote =
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
            instrument
              .strike_price
          ),

        bid:
          toNumber(
            quote
              .bid_price
          ),

        ask:
          toNumber(
            quote
              .ask_price
          ),

        mark:
          toNumber(
            quote
              .mark_price
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
            quote
              .open_interest
          ) ?? 0,
      };
    }
  );
}

/*
  =========================================================
  DELTA LEG SELECTION
  =========================================================
*/

function closestByDelta(
  contracts,
  target,
  absolute = false
) {
  const candidates =
    contracts.filter(
      (contract) =>
        contract.delta !==
        null
    );

  if (
    !candidates.length
  ) {
    return null;
  }

  return [
    ...candidates,
  ].sort(
    (a, b) => {
      const aDelta =
        absolute
          ? Math.abs(
              a.delta
            )
          : a.delta;

      const bDelta =
        absolute
          ? Math.abs(
              b.delta
            )
          : b.delta;

      return (
        Math.abs(
          aDelta -
          target
        ) -
        Math.abs(
          bDelta -
          target
        )
      );
    }
  )[0];
}

function bidAskWidth(
  contract
) {
  if (
    !contract ||
    contract.bid ===
      null ||
    contract.ask ===
      null ||
    contract.mark ===
      null ||
    contract.mark <=
      0
  ) {
    return null;
  }

  return (
    (
      contract.ask -
      contract.bid
    ) /
    contract.mark
  ) * 100;
}

/*
  =========================================================
  BUILD ONE EXPIRATION SNAPSHOT
  =========================================================
*/

function calculateSnapshot({
  expiration,
  bias,
  calls,
  puts,
  spot,
}) {
  let longContract =
    null;

  let shortContract =
    null;

  let type =
    null;

  if (
    bias ===
    "Bullish"
  ) {
    type =
      "Call";

    longContract =
      closestByDelta(
        calls,
        0.55
      );

    shortContract =
      closestByDelta(
        calls.filter(
          (contract) =>
            longContract &&
            contract.strike >
              longContract.strike
        ),
        0.30
      );
  }

  if (
    bias ===
    "Bearish"
  ) {
    type =
      "Put";

    longContract =
      closestByDelta(
        puts,
        0.55,
        true
      );

    shortContract =
      closestByDelta(
        puts.filter(
          (contract) =>
            longContract &&
            contract.strike <
              longContract.strike
        ),
        0.30,
        true
      );
  }

  if (
    !longContract ||
    !shortContract
  ) {
    return {
      expiration,

      dte:
        daysToExpiration(
          expiration
        ),

      error:
        "Could not find matching spread legs.",
    };
  }

  const width =
    Math.abs(
      shortContract
        .strike -
      longContract
        .strike
    );

  /*
    Conservative entry estimate:
    buy long at ask
    sell short at bid
  */

  const debit =
    longContract.ask !==
      null &&
    shortContract.bid !==
      null
      ? longContract.ask -
        shortContract.bid
      : null;

  const midpoint =
    longContract.mark !==
      null &&
    shortContract.mark !==
      null
      ? longContract.mark -
        shortContract.mark
      : null;

  const validDebit =
    debit !== null &&
    debit > 0
      ? debit
      : null;

  const maxLoss =
    validDebit !==
    null
      ? validDebit *
        100
      : null;

  const maxProfit =
    validDebit !==
    null
      ? (
          width -
          validDebit
        ) *
        100
      : null;

  let breakeven =
    null;

  if (
    validDebit !==
    null
  ) {
    breakeven =
      bias ===
      "Bullish"
        ? longContract
            .strike +
          validDebit
        : longContract
            .strike -
          validDebit;
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

  const netGamma =
    longContract.gamma !==
      null &&
    shortContract.gamma !==
      null
      ? longContract.gamma -
        shortContract.gamma
      : null;

  const longWidth =
    bidAskWidth(
      longContract
    );

  const shortWidth =
    bidAskWidth(
      shortContract
    );

  const warnings =
    [];

  if (
    longWidth !==
      null &&
    longWidth >= 15
  ) {
    warnings.push(
      "wide long-leg spread"
    );
  }

  if (
    shortWidth !==
      null &&
    shortWidth >= 15
  ) {
    warnings.push(
      "wide short-leg spread"
    );
  }

  if (
    longContract
      .openInterest <
    100
  ) {
    warnings.push(
      "low long-leg OI"
    );
  }

  if (
    shortContract
      .openInterest <
    100
  ) {
    warnings.push(
      "low short-leg OI"
    );
  }

  if (
    longContract.volume <
    20
  ) {
    warnings.push(
      "low long-leg volume"
    );
  }

  if (
    shortContract.volume <
    20
  ) {
    warnings.push(
      "low short-leg volume"
    );
  }

  const averageIV =
    longContract.iv !==
      null &&
    shortContract.iv !==
      null
      ? (
          longContract.iv +
          shortContract.iv
        ) /
        2
      : null;

  const dte =
    daysToExpiration(
      expiration
    );

  /*
    Additional comparison metrics
  */

  const breakevenDistance =
    breakeven !==
      null &&
    spot
      ? (
          (
            breakeven -
            spot
          ) /
          spot
        ) *
        100
      : null;

  const debitWidthPct =
    validDebit !==
      null &&
    width > 0
      ? (
          validDebit /
          width
        ) *
        100
      : null;

  /*
    Theta from Robinhood is quoted per option.
    Multiply the net spread theta by 100 shares.
  */

  const thetaDollarsPerDay =
    netTheta !==
      null
      ? netTheta *
        100
      : null;

  /*
    Descriptive normalization only.
  */

  const rewardRiskPerDte =
    rewardRisk !==
      null &&
    dte > 0
      ? rewardRisk /
        dte
      : null;

  return {
    expiration,

    dte,

    type,

    longContract,
    shortContract,

    width,

    debit,
    midpoint,

    maxLoss,
    maxProfit,

    breakeven,
    breakevenDistance,

    debitWidthPct,

    rewardRisk,
    rewardRiskPerDte,

    netDelta,
    netGamma,
    netTheta,
    netVega,

    thetaDollarsPerDay,

    averageIV,

    longWidth,
    shortWidth,

    warnings,
  };
}

async function buildExpirationSnapshot({
  ticker,
  expiration,
  spot,
  bias,
}) {
  const instruments =
    await fetchAllInstruments(
      ticker,
      expiration
    );

  const visible =
    selectStrikeBand(
      instruments,
      spot,
      12
    );

  const quoteResults =
    await fetchQuotes(
      visible.map(
        (instrument) =>
          instrument.id
      )
    );

  const contracts =
    buildContracts(
      visible,
      quoteResults
    );

  const calls =
    contracts.filter(
      (contract) =>
        contract.type ===
        "call"
    );

  const puts =
    contracts.filter(
      (contract) =>
        contract.type ===
        "put"
    );

  return calculateSnapshot({
    expiration,
    bias,
    calls,
    puts,
    spot,
  });
}

/*
  =========================================================
  TRADEOFF NOTES
  =========================================================
*/

function approximatelyEqual(
  a,
  b,
  tolerance
) {
  if (
    a === null ||
    b === null ||
    a === undefined ||
    b === undefined
  ) {
    return false;
  }

  return (
    Math.abs(
      a - b
    ) <= tolerance
  );
}

function buildTradeoffNote(
  row,
  baseline
) {
  if (
    !row ||
    row.error
  ) {
    return "";
  }

  if (
    !baseline ||
    baseline.error ||
    row.expiration ===
      baseline.expiration
  ) {
    return "Selected expiration baseline";
  }

  const notes =
    [];

  /*
    TIME
  */

  if (
    row.dte >
    baseline.dte
  ) {
    notes.push(
      "more time"
    );
  }

  if (
    row.dte <
    baseline.dte
  ) {
    notes.push(
      "less time"
    );
  }

  /*
    DEBIT
  */

  if (
    row.debit !==
      null &&
    baseline.debit !==
      null &&
    !approximatelyEqual(
      row.debit,
      baseline.debit,
      0.05
    )
  ) {
    notes.push(
      row.debit <
        baseline.debit
        ? "lower debit"
        : "higher debit"
    );
  }

  /*
    BREAKEVEN DISTANCE
  */

  if (
    row.breakevenDistance !==
      null &&
    baseline
      .breakevenDistance !==
      null
  ) {
    const rowDistance =
      Math.abs(
        row.breakevenDistance
      );

    const baseDistance =
      Math.abs(
        baseline
          .breakevenDistance
      );

    if (
      !approximatelyEqual(
        rowDistance,
        baseDistance,
        0.25
      )
    ) {
      notes.push(
        rowDistance <
          baseDistance
          ? "breakeven closer to spot"
          : "breakeven farther from spot"
      );
    }
  }

  /*
    THETA
  */

  if (
    row.netTheta !==
      null &&
    baseline.netTheta !==
      null
  ) {
    if (
      row.netTheta >
      baseline.netTheta +
        0.005
    ) {
      notes.push(
        "less negative theta"
      );
    }

    if (
      row.netTheta <
      baseline.netTheta -
        0.005
    ) {
      notes.push(
        "more negative theta"
      );
    }
  }

  /*
    IV
  */

  if (
    row.averageIV !==
      null &&
    baseline.averageIV !==
      null
  ) {
    const ivDifference =
      (
        row.averageIV -
        baseline.averageIV
      ) *
      100;

    if (
      ivDifference >=
      1
    ) {
      notes.push(
        "higher IV"
      );
    }

    if (
      ivDifference <=
      -1
    ) {
      notes.push(
        "lower IV"
      );
    }
  }

  /*
    REWARD / RISK
  */

  if (
    row.rewardRisk !==
      null &&
    baseline.rewardRisk !==
      null
  ) {
    if (
      row.rewardRisk >
      baseline.rewardRisk +
        0.1
    ) {
      notes.push(
        "higher R/R"
      );
    }

    if (
      row.rewardRisk <
      baseline.rewardRisk -
        0.1
    ) {
      notes.push(
        "lower R/R"
      );
    }
  }

  /*
    LIQUIDITY
  */

  if (
    row.warnings.length >
    baseline.warnings.length
  ) {
    notes.push(
      "more liquidity warnings"
    );
  }

  if (
    row.warnings.length <
    baseline.warnings.length
  ) {
    notes.push(
      "fewer liquidity warnings"
    );
  }

  if (
    notes.length === 0
  ) {
    return "Similar tradeoffs to selected expiration";
  }

  return notes
    .slice(
      0,
      4
    )
    .join(
      " · "
    );
}

/*
  =========================================================
  MAIN COMPONENT
  =========================================================
*/

export default function ExpirationComparison({
  data,
  expirations,
  selectedExpiration,
  bias,
  onSelectExpiration,
}) {
  const [
    count,
    setCount,
  ] =
    useState(4);

  const [
    loading,
    setLoading,
  ] =
    useState(false);

  const [
    progress,
    setProgress,
  ] =
    useState("");

  const [
    rows,
    setRows,
  ] =
    useState([]);

  const [
    error,
    setError,
  ] =
    useState("");

  useEffect(() => {
    setRows([]);
    setError("");
    setProgress("");

  }, [
    data?.ticker,
    selectedExpiration,
    bias,
  ]);

  /*
    Selected expiration becomes the
    baseline for descriptive comparisons.
  */

  const baseline =
    useMemo(
      () =>
        rows.find(
          (row) =>
            row.expiration ===
            selectedExpiration &&
            !row.error
        ) ??
        rows.find(
          (row) =>
            !row.error
        ) ??
        null,
      [
        rows,
        selectedExpiration,
      ]
    );

  if (
    bias !== "Bullish" &&
    bias !== "Bearish"
  ) {
    return (
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
        <div className="text-[9px] uppercase tracking-widest text-zinc-500">
          Expiration comparison
        </div>

        <div className="mt-2 text-[11px] text-zinc-400">
          The current strategy engine has no directional debit-spread structure to compare.
        </div>
      </div>
    );
  }

  async function runComparison() {
    setLoading(
      true
    );

    setRows(
      []
    );

    setError(
      ""
    );

    const startingIndex =
      Math.max(
        0,
        expirations.indexOf(
          selectedExpiration
        )
      );

    const dates =
      expirations.slice(
        startingIndex,
        startingIndex +
          count
      );

    const completed =
      [];

    for (
      let i = 0;
      i < dates.length;
      i++
    ) {
      const expiration =
        dates[i];

      setProgress(
        `${i + 1}/${dates.length} · ${shortDate(
          expiration
        )}`
      );

      try {
        const snapshot =
          await buildExpirationSnapshot({
            ticker:
              data.ticker,

            expiration,

            spot:
              data.price,

            bias,
          });

        completed.push(
          snapshot
        );

      } catch (err) {
        completed.push({
          expiration,

          dte:
            daysToExpiration(
              expiration
            ),

          error:
            err.message,
        });
      }

      setRows([
        ...completed,
      ]);
    }

    setProgress(
      ""
    );

    setLoading(
      false
    );
  }

  function selectExpiration(
    row
  ) {
    if (
      row.error ||
      !onSelectExpiration
    ) {
      return;
    }

    onSelectExpiration(
      row.expiration
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      {/* HEADER */}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-zinc-500">
            Expiration comparison
          </div>

          <div className="mt-1 text-sm font-bold text-white">
            {bias} debit-spread structure
          </div>

          <div className="mt-1 text-[10px] text-zinc-500">
            Same delta-based leg-selection rule across expirations.
          </div>

          <div className="mt-1 text-[9px] text-zinc-600">
            The selected expiration is the comparison baseline. Click another row to load it into the full strategy view.
          </div>
        </div>

        <div className="flex items-center gap-2">
          {[4, 6].map(
            (value) => (
              <button
                key={
                  value
                }
                onClick={() =>
                  setCount(
                    value
                  )
                }
                className={`rounded border px-2.5 py-1 text-[10px] font-mono ${
                  count ===
                  value
                    ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
                    : "border-zinc-700 text-zinc-500"
                }`}
              >
                {value} expiries
              </button>
            )
          )}

          <button
            onClick={
              runComparison
            }
            disabled={
              loading ||
              !expirations?.length
            }
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            {loading
              ? progress ||
                "Loading..."
              : "Compare expirations"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-[10px] text-red-300">
          {error}
        </div>
      )}

      {/* COMPARISON TABLE */}

      {rows.length >
        0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="min-w-[1650px] w-full text-[10px] font-mono">
            <thead>
              <tr className="border-b border-zinc-700 bg-zinc-900 text-zinc-500">
                <th className="px-3 py-2 text-left font-normal">
                  Exp
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  DTE
                </th>

                <th className="px-3 py-2 text-center font-normal">
                  Structure
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Debit
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Debit / Width
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Max Loss
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Max Profit
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  BE
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  BE Dist.
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  R/R
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  R/R ÷ DTE
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  IV
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  IV Δ
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Δ
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Θ
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Θ $/day
                </th>

                <th className="px-3 py-2 text-right font-normal">
                  Vega
                </th>

                <th className="px-3 py-2 text-center font-normal">
                  Liquidity
                </th>
              </tr>
            </thead>

            <tbody>
              {rows.map(
                (row) => {
                  const selected =
                    row.expiration ===
                    selectedExpiration;

                  const ivDifference =
                    !row.error &&
                    baseline?.averageIV !==
                      null &&
                    baseline?.averageIV !==
                      undefined &&
                    row.averageIV !==
                      null
                      ? (
                          row.averageIV -
                          baseline.averageIV
                        ) *
                        100
                      : null;

                  return (
                    <tr
                      key={
                        row.expiration
                      }
                      onClick={() =>
                        selectExpiration(
                          row
                        )
                      }
                      title={
                        row.error
                          ? row.error
                          : `Load ${shortDate(
                              row.expiration
                            )} expiration`
                      }
                      className={`border-b border-zinc-900 transition-colors ${
                        row.error
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer"
                      } ${
                        selected
                          ? "bg-amber-400/[0.08] outline outline-1 outline-inset outline-amber-400/20"
                          : !row.error
                            ? "hover:bg-emerald-500/[0.06]"
                            : ""
                      }`}
                    >
                      <td
                        className={`px-3 py-2 text-left ${
                          selected
                            ? "text-amber-300"
                            : "text-zinc-300"
                        }`}
                      >
                        {shortDate(
                          row.expiration
                        )}

                        {selected ? (
                          <span className="ml-2 text-[8px] uppercase tracking-widest text-amber-500">
                            selected
                          </span>
                        ) : !row.error ? (
                          <span className="ml-2 text-[8px] uppercase tracking-widest text-zinc-600">
                            click
                          </span>
                        ) : null}
                      </td>

                      <td className="px-3 py-2 text-right text-zinc-400">
                        {row.dte ??
                          "—"}
                      </td>

                      {row.error ? (
                        <td
                          colSpan={16}
                          className="px-3 py-2 text-left text-red-300"
                        >
                          {row.error}
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-center text-zinc-200">
                            {money(
                              row.longContract
                                .strike
                            )}
                            {" / "}
                            {money(
                              row.shortContract
                                .strike
                            )}
                            {" "}
                            {row.type}
                          </td>

                          <td className="px-3 py-2 text-right text-amber-300">
                            {money(
                              row.debit
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-300">
                            {rawPct(
                              row.debitWidthPct
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-red-300">
                            {dollar(
                              row.maxLoss
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-emerald-300">
                            {row.maxProfit !==
                              null &&
                            row.maxProfit >=
                              0
                              ? dollar(
                                  row.maxProfit
                                )
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-200">
                            {money(
                              row.breakeven
                            )}
                          </td>

                          <td
                            className={`px-3 py-2 text-right ${
                              row.breakevenDistance !==
                                null &&
                              Math.abs(
                                row.breakevenDistance
                              ) <= 2
                                ? "text-emerald-300"
                                : "text-zinc-300"
                            }`}
                          >
                            {row.breakevenDistance !==
                            null
                              ? `${
                                  row.breakevenDistance >=
                                  0
                                    ? "+"
                                    : ""
                                }${row.breakevenDistance.toFixed(
                                  2
                                )}%`
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-200">
                            {row.rewardRisk !==
                            null
                              ? `${row.rewardRisk.toFixed(
                                  2
                                )}×`
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-400">
                            {row.rewardRiskPerDte !==
                            null
                              ? row.rewardRiskPerDte.toFixed(
                                  3
                                )
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-300">
                            {pct(
                              row.averageIV
                            )}
                          </td>

                          <td
                            className={`px-3 py-2 text-right ${
                              ivDifference >
                              0
                                ? "text-red-300"
                                : ivDifference <
                                    0
                                  ? "text-emerald-300"
                                  : "text-zinc-500"
                            }`}
                          >
                            {ivDifference !==
                            null
                              ? `${
                                  ivDifference >=
                                  0
                                    ? "+"
                                    : ""
                                }${ivDifference.toFixed(
                                  1
                                )} pts`
                              : "—"}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-200">
                            {signed(
                              row.netDelta
                            )}
                          </td>

                          <td
                            className={`px-3 py-2 text-right ${
                              row.netTheta <
                              0
                                ? "text-red-300"
                                : "text-emerald-300"
                            }`}
                          >
                            {signed(
                              row.netTheta
                            )}
                          </td>

                          <td
                            className={`px-3 py-2 text-right ${
                              row.thetaDollarsPerDay <
                              0
                                ? "text-red-300"
                                : "text-emerald-300"
                            }`}
                          >
                            {signedDollar(
                              row.thetaDollarsPerDay
                            )}
                          </td>

                          <td className="px-3 py-2 text-right text-zinc-300">
                            {signed(
                              row.netVega
                            )}
                          </td>

                          <td className="px-3 py-2 text-center">
                            {row.warnings.length ===
                            0 ? (
                              <span className="text-emerald-300">
                                OK
                              </span>
                            ) : (
                              <span
                                className="text-amber-300"
                                title={row.warnings.join(
                                  ", "
                                )}
                              >
                                Watch (
                                {
                                  row.warnings.length
                                }
                                )
                              </span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                }
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TRADEOFF CARDS */}

      {rows.length >
        0 && (
        <div className="mt-4">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Expiration tradeoffs
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {rows
              .filter(
                (row) =>
                  !row.error
              )
              .map(
                (row) => {
                  const selected =
                    row.expiration ===
                    selectedExpiration;

                  const note =
                    buildTradeoffNote(
                      row,
                      baseline
                    );

                  const ivDifference =
                    baseline?.averageIV !==
                      null &&
                    baseline?.averageIV !==
                      undefined &&
                    row.averageIV !==
                      null
                      ? (
                          row.averageIV -
                          baseline.averageIV
                        ) *
                        100
                      : null;

                  return (
                    <button
                      type="button"
                      key={`tradeoff-${row.expiration}`}
                      onClick={() =>
                        onSelectExpiration?.(
                          row.expiration
                        )
                      }
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? "border-amber-400/40 bg-amber-400/[0.05]"
                          : "border-zinc-800 bg-black/20 hover:border-emerald-500/30 hover:bg-emerald-500/[0.03]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div
                          className={`text-xs font-bold ${
                            selected
                              ? "text-amber-300"
                              : "text-white"
                          }`}
                        >
                          {shortDate(
                            row.expiration
                          )}
                        </div>

                        <div className="text-[9px] text-zinc-500">
                          {row.dte} DTE
                        </div>
                      </div>

                      <div className="mt-2 text-[10px] font-mono text-zinc-300">
                        {money(
                          row.longContract
                            .strike
                        )}
                        {" / "}
                        {money(
                          row.shortContract
                            .strike
                        )}
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-[9px]">
                        <div>
                          <div className="text-zinc-600">
                            Debit
                          </div>

                          <div className="font-mono text-amber-300">
                            {money(
                              row.debit
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="text-zinc-600">
                            R/R
                          </div>

                          <div className="font-mono text-zinc-200">
                            {row.rewardRisk !==
                            null
                              ? `${row.rewardRisk.toFixed(
                                  2
                                )}×`
                              : "—"}
                          </div>
                        </div>

                        <div>
                          <div className="text-zinc-600">
                            BE distance
                          </div>

                          <div className="font-mono text-zinc-200">
                            {row.breakevenDistance !==
                            null
                              ? `${
                                  row.breakevenDistance >=
                                  0
                                    ? "+"
                                    : ""
                                }${row.breakevenDistance.toFixed(
                                  2
                                )}%`
                              : "—"}
                          </div>
                        </div>

                        <div>
                          <div className="text-zinc-600">
                            Theta/day
                          </div>

                          <div
                            className={`font-mono ${
                              row.thetaDollarsPerDay <
                              0
                                ? "text-red-300"
                                : "text-emerald-300"
                            }`}
                          >
                            {signedDollar(
                              row.thetaDollarsPerDay
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="text-zinc-600">
                            Avg IV
                          </div>

                          <div className="font-mono text-zinc-200">
                            {pct(
                              row.averageIV
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="text-zinc-600">
                            IV vs selected
                          </div>

                          <div className="font-mono text-zinc-200">
                            {ivDifference !==
                            null
                              ? `${
                                  ivDifference >=
                                  0
                                    ? "+"
                                    : ""
                                }${ivDifference.toFixed(
                                  1
                                )} pts`
                              : "—"}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 border-t border-zinc-800 pt-2">
                        <div className="text-[8px] uppercase tracking-widest text-zinc-600">
                          Tradeoff
                        </div>

                        <div className="mt-1 text-[9px] leading-relaxed text-zinc-400">
                          {note}
                        </div>
                      </div>

                      <div
                        className={`mt-2 text-[8px] uppercase tracking-widest ${
                          selected
                            ? "text-amber-500"
                            : "text-emerald-500/70"
                        }`}
                      >
                        {selected
                          ? "Currently loaded"
                          : "Load expiration →"}
                      </div>
                    </button>
                  );
                }
              )}
          </div>
        </div>
      )}

      {/* LIQUIDITY DETAIL */}

      {rows.length >
        0 && (
        <div className="mt-4">
          <div className="mb-2 text-[9px] uppercase tracking-widest text-zinc-500">
            Contract liquidity detail
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {rows
              .filter(
                (row) =>
                  !row.error
              )
              .map(
                (row) => (
                  <button
                    type="button"
                    onClick={() =>
                      onSelectExpiration?.(
                        row.expiration
                      )
                    }
                    key={`liquidity-${row.expiration}`}
                    className={`rounded-lg border bg-black/20 px-3 py-2 text-left transition-colors ${
                      row.expiration ===
                      selectedExpiration
                        ? "border-amber-400/40 bg-amber-400/[0.04]"
                        : "border-zinc-800 hover:border-emerald-500/30"
                    }`}
                  >
                    <div className="text-[9px] uppercase tracking-widest text-zinc-500">
                      {shortDate(
                        row.expiration
                      )}{" "}
                      ·{" "}
                      {row.dte} DTE
                    </div>

                    <div className="mt-1 text-[10px] text-zinc-300">
                      Long OI{" "}
                      {compact(
                        row.longContract
                          .openInterest
                      )}
                      {" · "}
                      Short OI{" "}
                      {compact(
                        row.shortContract
                          .openInterest
                      )}
                    </div>

                    <div className="mt-1 text-[10px] text-zinc-500">
                      Bid/ask:{" "}
                      {row.longWidth !==
                      null
                        ? `${row.longWidth.toFixed(
                            1
                          )}%`
                        : "—"}
                      {" / "}
                      {row.shortWidth !==
                      null
                        ? `${row.shortWidth.toFixed(
                            1
                          )}%`
                        : "—"}
                    </div>

                    <div className="mt-1 text-[10px] text-zinc-500">
                      Warnings:{" "}
                      <span
                        className={
                          row.warnings.length ===
                          0
                            ? "text-emerald-300"
                            : "text-amber-300"
                        }
                      >
                        {row.warnings.length}
                      </span>
                    </div>
                  </button>
                )
              )}
          </div>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-zinc-800 bg-black/20 px-3 py-2 text-[9px] leading-relaxed text-zinc-600">
        These are descriptive comparisons, not rankings. R/R ÷ DTE is a simple normalization of the displayed expiration payoff ratio by calendar days remaining; it is not an expected return rate. Theta $/day is the current net quoted theta × 100 and can change as price, volatility, and time change. IV Δ is measured against the selected expiration.
      </div>
    </div>
  );
}