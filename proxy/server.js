require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const cors = require("cors");

const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3001);

const ROBINHOOD_MCP_URL =
  "https://agent.robinhood.com/mcp/trading";

const ROBINHOOD_CALLBACK_URL =
  `http://127.0.0.1:${PORT}/robinhood/callback`;

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || "";

const SCANNER_DATA_DIR =
  path.join(
    process.cwd(),
    ".data"
  );

const SCANNER_STATE_FILE =
  path.join(
    SCANNER_DATA_DIR,
    "scanner-state.json"
  );

/*
  =========================================================
  READ-ONLY ROBINHOOD TOOLS
  =========================================================

  Trading/order tools are intentionally NOT exposed
  through this backend.
*/

const ROBINHOOD_READ_TOOLS = new Set([
  "get_equity_quotes",
  "get_equity_historicals",
  "get_equity_technical_indicators",
  "get_equity_fundamentals",
  "get_equity_analyst_ratings",
  "get_equity_price_book",
  "get_equity_tradability",

  "get_option_chains",
  "get_option_instruments",
  "get_option_quotes",
  "get_option_historicals",

  "get_scanner_datapoints",
  "get_scanner_filter_specs",
  "get_scans",
  "preview_scan",
  "run_scan",
]);

/*
  =========================================================
  ROBINHOOD OAUTH PROVIDER
  =========================================================
*/

class RobinhoodOAuthProvider {
  constructor() {
    this.clientInfo = undefined;
    this.savedTokens = undefined;

    this.verifier = undefined;
    this.discovery = undefined;

    this.lastState = undefined;
    this.authorizationUrl = undefined;
  }

  get redirectUrl() {
    return ROBINHOOD_CALLBACK_URL;
  }

  get clientMetadata() {
    return {
      client_name:
        "Options Scanner",

      redirect_uris: [
        ROBINHOOD_CALLBACK_URL,
      ],

      grant_types: [
        "authorization_code",
        "refresh_token",
      ],

      response_types: [
        "code",
      ],

      application_type:
        "native",

      /*
        This is the important setting that worked in
        our successful v2 test.
      */

      token_endpoint_auth_method:
        "client_secret_post",
    };
  }

  /*
    -------------------------------------------------------
    CLIENT REGISTRATION
    -------------------------------------------------------
  */

  clientInformation() {
    return this.clientInfo;
  }

  saveClientInformation(info) {
    this.clientInfo = info;

    console.log(
      "[Robinhood OAuth] Client registration saved."
    );

    console.log(
      "[Robinhood OAuth] Client secret present:",
      !!info?.client_secret
    );

    console.log(
      "[Robinhood OAuth] Registered auth method:",
      info?.token_endpoint_auth_method ||
        "not specified"
    );
  }

  /*
    -------------------------------------------------------
    TOKENS
    -------------------------------------------------------
  */

  tokens() {
    return this.savedTokens;
  }

  saveTokens(tokens) {
    this.savedTokens = tokens;

    console.log(
      "[Robinhood OAuth] Tokens saved."
    );
  }

  /*
    -------------------------------------------------------
    OAUTH STATE
    -------------------------------------------------------
  */

  state() {
    this.lastState =
      crypto.randomUUID();

    return this.lastState;
  }

  /*
    -------------------------------------------------------
    AUTHORIZATION URL
    -------------------------------------------------------
  */

  redirectToAuthorization(url) {
    this.authorizationUrl =
      url.toString();

    console.log(
      "[Robinhood OAuth] Authorization required."
    );
  }

  /*
    -------------------------------------------------------
    PKCE
    -------------------------------------------------------
  */

  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) {
      throw new Error(
        "No Robinhood PKCE verifier is available."
      );
    }

    return this.verifier;
  }

  /*
    -------------------------------------------------------
    DISCOVERY
    -------------------------------------------------------
  */

  saveDiscoveryState(state) {
    this.discovery = state;
  }

  discoveryState() {
    return this.discovery;
  }

  /*
    -------------------------------------------------------
    CREDENTIAL INVALIDATION
    -------------------------------------------------------
  */

  invalidateCredentials(scope) {
    if (
      scope === "all" ||
      scope === "client"
    ) {
      this.clientInfo =
        undefined;
    }

    if (
      scope === "all" ||
      scope === "tokens"
    ) {
      this.savedTokens =
        undefined;
    }

    if (
      scope === "all" ||
      scope === "verifier"
    ) {
      this.verifier =
        undefined;
    }

    if (
      scope === "all" ||
      scope === "discovery"
    ) {
      this.discovery =
        undefined;
    }
  }
}

const robinhoodAuth =
  new RobinhoodOAuthProvider();

/*
  =========================================================
  MCP STATE
  =========================================================
*/

let robinhoodClient = null;

let pendingTransport = null;

let oauthPending = false;

let connectionPromise = null;

/*
  =========================================================
  MCP FACTORIES
  =========================================================
*/

function makeRobinhoodClient() {
  return new Client({
    name:
      "options-scanner",

    version:
      "2.0.0",
  });
}

function makeRobinhoodTransport() {
  return new StreamableHTTPClientTransport(
    new URL(
      ROBINHOOD_MCP_URL
    ),
    {
      authProvider:
        robinhoodAuth,
    }
  );
}

/*
  =========================================================
  CONNECT TO ROBINHOOD
  =========================================================
*/

async function connectRobinhood() {
  /*
    Already authenticated.
  */

  if (robinhoodClient) {
    return robinhoodClient;
  }

  /*
    OAuth already started.

    Reuse that exact session.
  */

  if (
    oauthPending &&
    pendingTransport &&
    robinhoodAuth.authorizationUrl
  ) {
    return null;
  }

  /*
    Prevent multiple simultaneous initialization attempts.
  */

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise =
    (async () => {
      const client =
        makeRobinhoodClient();

      const transport =
        makeRobinhoodTransport();

      pendingTransport =
        transport;

      try {
        await client.connect(
          transport
        );

        robinhoodClient =
          client;

        pendingTransport =
          null;

        oauthPending =
          false;

        robinhoodAuth.authorizationUrl =
          undefined;

        console.log(
          "[Robinhood] MCP connected."
        );

        return robinhoodClient;

      } catch (error) {
        /*
          Normal first-login path:
          the SDK generated an OAuth URL.
        */

        if (
          robinhoodAuth.authorizationUrl
        ) {
          oauthPending =
            true;

          console.log(
            "[Robinhood] Waiting for OAuth authorization."
          );

          return null;
        }

        pendingTransport =
          null;

        oauthPending =
          false;

        throw error;
      }
    })();

  try {
    return await connectionPromise;

  } finally {
    connectionPromise =
      null;
  }
}

/*
  =========================================================
  REQUIRE AUTHENTICATED ROBINHOOD CLIENT
  =========================================================
*/

async function requireRobinhood() {
  if (robinhoodClient) {
    return robinhoodClient;
  }

  const client =
    await connectRobinhood();

  if (!client) {
    const error =
      new Error(
        "Robinhood authentication required. Open /robinhood/connect first."
      );

    error.status =
      401;

    throw error;
  }

  return client;
}

/*
  =========================================================
  MCP TOOL HELPER
  =========================================================
*/

async function callRobinhoodTool(
  toolName,
  args = {}
) {
  if (
    !ROBINHOOD_READ_TOOLS.has(
      toolName
    )
  ) {
    const error =
      new Error(
        `Robinhood tool '${toolName}' is not permitted by this backend.`
      );

    error.status =
      403;

    throw error;
  }

  const client =
    await requireRobinhood();

  return client.callTool({
    name:
      toolName,

    arguments:
      args,
  });
}

/*
  =========================================================
  PERSISTENT SCANNER STATE
  =========================================================
*/

function defaultScannerState() {
  return {
    version: 1,

    savedPlans: [],

    savedComparisons: {},

    paperTrades: [],

    paperSettings: {
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
    },

    preferences: {
      autoRefresh: {
        enabled: false,
        seconds: 60,
      },

      notifications: {
        enabled: false,
      },
    },

    updatedAt: null,
  };
}

function normalizeStoredState(input) {
  const base =
    defaultScannerState();

  const value =
    input &&
    typeof input ===
      "object" &&
    !Array.isArray(
      input
    )
      ? input
      : {};

  const savedPlans =
    Array.isArray(
      value.savedPlans
    )
      ? value.savedPlans.filter(
          (plan) =>
            plan &&
            typeof plan ===
              "object" &&
            !Array.isArray(
              plan
            )
        )
      : [];

  const savedComparisons =
    value.savedComparisons &&
    typeof value.savedComparisons ===
      "object" &&
    !Array.isArray(
      value.savedComparisons
    )
      ? value.savedComparisons
      : {};

  const paperTrades =
    Array.isArray(
      value.paperTrades
    )
      ? value.paperTrades.filter(
          (trade) =>
            trade &&
            typeof trade ===
              "object" &&
            !Array.isArray(
              trade
            )
        )
      : [];

  const incomingPaperSettings =
    value.paperSettings &&
    typeof value.paperSettings ===
      "object" &&
    !Array.isArray(
      value.paperSettings
    )
      ? value.paperSettings
      : {};

  const allowedFillModels =
    new Set([
      "midpoint",
      "quarter_spread",
      "conservative",
    ]);

  const normalizeNonNegativeNumber =
    (
      input,
      fallback
    ) => {
      const number =
        Number(
          input
        );

      return Number.isFinite(
        number
      )
        ? Math.max(
            0,
            number
          )
        : fallback;
    };

  const paperSettings = {
    fillModel:
      allowedFillModels.has(
        incomingPaperSettings
          .fillModel
      )
        ? incomingPaperSettings
            .fillModel
        : base.paperSettings
            .fillModel,

    feePerContractPerLeg:
      normalizeNonNegativeNumber(
        incomingPaperSettings
          .feePerContractPerLeg,
        base.paperSettings
          .feePerContractPerLeg
      ),

    riskLimits: {
      maxLossPerTrade:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.maxLossPerTrade,
          base.paperSettings
            .riskLimits
            .maxLossPerTrade
        ),

      maxTotalOpenRisk:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.maxTotalOpenRisk,
          base.paperSettings
            .riskLimits
            .maxTotalOpenRisk
        ),

      maxTickerOpenRisk:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.maxTickerOpenRisk,
          base.paperSettings
            .riskLimits
            .maxTickerOpenRisk
        ),

      maxOpenPositions:
        Math.max(
          1,
          Math.round(
            normalizeNonNegativeNumber(
              incomingPaperSettings
                ?.riskLimits
                ?.maxOpenPositions,
              base.paperSettings
                .riskLimits
                .maxOpenPositions
            )
          )
        ),

      minOpenInterest:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.minOpenInterest,
          base.paperSettings
            .riskLimits
            .minOpenInterest
        ),

      minVolume:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.minVolume,
          base.paperSettings
            .riskLimits
            .minVolume
        ),

      maxBidAskPct:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.maxBidAskPct,
          base.paperSettings
            .riskLimits
            .maxBidAskPct
        ),

      minRewardRisk:
        normalizeNonNegativeNumber(
          incomingPaperSettings
            ?.riskLimits
            ?.minRewardRisk,
          base.paperSettings
            .riskLimits
            .minRewardRisk
        ),
    },
  };

  const autoRefreshSeconds =
    Number(
      value.preferences
        ?.autoRefresh
        ?.seconds
    );

  const allowedRefreshSeconds =
    new Set([
      30,
      60,
      300,
    ]);

  return {
    version: 1,

    savedPlans,

    savedComparisons,

    paperTrades,

    paperSettings,

    preferences: {
      autoRefresh: {
        enabled:
          !!value.preferences
            ?.autoRefresh
            ?.enabled,

        seconds:
          allowedRefreshSeconds.has(
            autoRefreshSeconds
          )
            ? autoRefreshSeconds
            : base.preferences
                .autoRefresh
                .seconds,
      },

      notifications: {
        enabled:
          !!value.preferences
            ?.notifications
            ?.enabled,
      },
    },

    updatedAt:
      value.updatedAt ||
      null,
  };
}

async function readScannerState() {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  try {
    const raw =
      await fs.readFile(
        SCANNER_STATE_FILE,
        "utf8"
      );

    return normalizeStoredState(
      JSON.parse(
        raw
      )
    );
  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return defaultScannerState();
    }

    console.error(
      "[Scanner state read]",
      safeErrorMessage(
        error
      )
    );

    return defaultScannerState();
  }
}

async function writeScannerState(state) {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  const normalized =
    normalizeStoredState({
      ...state,

      updatedAt:
        new Date().toISOString(),
    });

  normalized.updatedAt =
    new Date().toISOString();

  const temporaryFile =
    `${SCANNER_STATE_FILE}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(
      normalized,
      null,
      2
    ),
    "utf8"
  );

  await fs.rename(
    temporaryFile,
    SCANNER_STATE_FILE
  );

  return normalized;
}

function savedPlanIdentity(plan) {
  return (
    plan?.structureKey ||
    plan?.id ||
    [
      plan?.ticker,
      plan?.expiration,
      plan?.optionType,
      plan?.longStrike,
      plan?.shortStrike,
    ].join("|")
  );
}

function mergeSavedPlans(
  existing,
  incoming
) {
  const map =
    new Map();

  for (
    const plan of [
      ...(Array.isArray(
        existing
      )
        ? existing
        : []),

      ...(Array.isArray(
        incoming
      )
        ? incoming
        : []),
    ]
  ) {
    if (
      !plan ||
      typeof plan !==
        "object"
    ) {
      continue;
    }

    const key =
      savedPlanIdentity(
        plan
      );

    const previous =
      map.get(
        key
      );

    if (!previous) {
      map.set(
        key,
        plan
      );

      continue;
    }

    const previousTime =
      Date.parse(
        previous.updatedAt ||
        previous.savedAt ||
        0
      ) || 0;

    const nextTime =
      Date.parse(
        plan.updatedAt ||
        plan.savedAt ||
        0
      ) || 0;

    if (
      nextTime >=
      previousTime
    ) {
      map.set(
        key,
        plan
      );
    }
  }

  return [
    ...map.values(),
  ];
}

function mergePaperTrades(
  existing,
  incoming
) {
  const map =
    new Map();

  for (
    const trade of [
      ...(Array.isArray(
        existing
      )
        ? existing
        : []),

      ...(Array.isArray(
        incoming
      )
        ? incoming
        : []),
    ]
  ) {
    if (
      !trade ||
      typeof trade !==
        "object"
    ) {
      continue;
    }

    const key =
      trade.id ||
      [
        trade.ticker,
        trade.expiration,
        trade.optionType,
        trade.longStrike,
        trade.shortStrike,
        trade.openedAt,
      ].join("|");

    const previous =
      map.get(
        key
      );

    if (!previous) {
      map.set(
        key,
        trade
      );

      continue;
    }

    const previousTime =
      Date.parse(
        previous.updatedAt ||
        previous.closedAt ||
        previous.openedAt ||
        0
      ) || 0;

    const nextTime =
      Date.parse(
        trade.updatedAt ||
        trade.closedAt ||
        trade.openedAt ||
        0
      ) || 0;

    if (
      nextTime >=
      previousTime
    ) {
      map.set(
        key,
        trade
      );
    }
  }

  return [
    ...map.values(),
  ];
}


/*
  =========================================================
  HISTORICAL SIGNAL BACKTEST
  =========================================================
*/

function unwrapRobinhoodToolResult(result) {
  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const blocks =
    Array.isArray(
      result?.content
    )
      ? result.content
      : [];

  for (const block of blocks) {
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
      // Continue.
    }
  }

  return result;
}

function extractBacktestBars(payload) {
  const data =
    payload?.data ??
    payload ??
    {};

  const result =
    data?.results?.[0] ??
    null;

  const bars =
    Array.isArray(
      result?.bars
    )
      ? result.bars
      : [];

  return bars
    .filter(
      (bar) =>
        !bar?.interpolated
    )
    .map(
      (bar) => ({
        time:
          bar.begins_at,

        open:
          finiteNumber(
            bar.open_price
          ),

        high:
          finiteNumber(
            bar.high_price
          ),

        low:
          finiteNumber(
            bar.low_price
          ),

        close:
          finiteNumber(
            bar.close_price
          ),

        volume:
          finiteNumber(
            bar.volume
          ),
      })
    )
    .filter(
      (bar) =>
        bar.time &&
        bar.open !== null &&
        bar.high !== null &&
        bar.low !== null &&
        bar.close !== null
    )
    .sort(
      (a, b) =>
        Date.parse(
          a.time
        ) -
        Date.parse(
          b.time
        )
    );
}

function extractBacktestIndicator(
  payload,
  type
) {
  const data =
    payload?.data ??
    payload ??
    {};

  const indicators =
    Array.isArray(
      data?.indicators
    )
      ? data.indicators
      : [];

  const indicator =
    indicators.find(
      (item) =>
        item?.type ===
        type
    ) ??
    indicators[0] ??
    null;

  const series =
    Array.isArray(
      indicator?.series
    )
      ? indicator.series
      : [];

  return series
    .filter(
      (item) =>
        item?.begins_at
    )
    .sort(
      (a, b) =>
        Date.parse(
          a.begins_at
        ) -
        Date.parse(
          b.begins_at
        )
    );
}

function scannerMomentumSignal({
  rsi,
  macdHistogram,
  changePct,
}) {
  let bullishScore =
    0;

  let bearishScore =
    0;

  if (
    rsi !==
    null
  ) {
    if (
      rsi >=
      55
    ) {
      bullishScore +=
        1;
    }

    if (
      rsi <=
      45
    ) {
      bearishScore +=
        1;
    }
  }

  if (
    macdHistogram !==
    null
  ) {
    if (
      macdHistogram >
      0
    ) {
      bullishScore +=
        1;
    }

    if (
      macdHistogram <
      0
    ) {
      bearishScore +=
        1;
    }
  }

  if (
    changePct !==
    null
  ) {
    if (
      changePct >
      0
    ) {
      bullishScore +=
        1;
    }

    if (
      changePct <
      0
    ) {
      bearishScore +=
        1;
    }
  }

  if (
    bullishScore >=
      2 &&
    bullishScore >
      bearishScore
  ) {
    return {
      signal:
        "bullish",

      bullishScore,
      bearishScore,
    };
  }

  if (
    bearishScore >=
      2 &&
    bearishScore >
      bullishScore
  ) {
    return {
      signal:
        "bearish",

      bullishScore,
      bearishScore,
    };
  }

  return {
    signal:
      "neutral",

    bullishScore,
    bearishScore,
  };
}

function summarizeBacktestTrades(
  trades
) {
  const usable =
    Array.isArray(
      trades
    )
      ? trades
      : [];

  const wins =
    usable.filter(
      (trade) =>
        trade.net_return_pct >
        0
    );

  const losses =
    usable.filter(
      (trade) =>
        trade.net_return_pct <
        0
    );

  const grossProfit =
    wins.reduce(
      (
        total,
        trade
      ) =>
        total +
        trade.net_return_pct,
      0
    );

  const grossLoss =
    Math.abs(
      losses.reduce(
        (
          total,
          trade
        ) =>
          total +
          trade.net_return_pct,
        0
      )
    );

  let equity =
    1;

  let peak =
    1;

  let maxDrawdownPct =
    0;

  for (const trade of usable) {
    equity *=
      1 +
      trade.net_return_pct /
        100;

    peak =
      Math.max(
        peak,
        equity
      );

    const drawdownPct =
      peak >
      0
        ? (
            equity /
            peak -
            1
          ) *
          100
        : 0;

    maxDrawdownPct =
      Math.min(
        maxDrawdownPct,
        drawdownPct
      );
  }

  return {
    trades:
      usable.length,

    wins:
      wins.length,

    losses:
      losses.length,

    breakeven:
      usable.length -
      wins.length -
      losses.length,

    win_rate_pct:
      usable.length
        ? (
            wins.length /
            usable.length
          ) *
          100
        : null,

    average_return_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.net_return_pct
        )
      ),

    average_winner_pct:
      averageNumbers(
        wins.map(
          (trade) =>
            trade.net_return_pct
        )
      ),

    average_loser_pct:
      averageNumbers(
        losses.map(
          (trade) =>
            trade.net_return_pct
        )
      ),

    profit_factor:
      grossLoss >
      0
        ? grossProfit /
          grossLoss
        : null,

    compounded_return_pct:
      (
        equity -
        1
      ) *
      100,

    max_drawdown_pct:
      maxDrawdownPct,

    average_mfe_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.mfe_pct
        )
      ),

    average_mae_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.mae_pct
        )
      ),

    average_hold_sessions:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.hold_sessions
        )
      ),
  };
}

function buildChronologicalEvaluation(
  trades
) {
  const n =
    trades.length;

  const trainEnd =
    Math.max(
      0,
      Math.floor(
        n *
        0.6
      )
    );

  const validationEnd =
    Math.max(
      trainEnd,
      Math.floor(
        n *
        0.8
      )
    );

  return {
    train: {
      summary:
        summarizeBacktestTrades(
          trades.slice(
            0,
            trainEnd
          )
        ),
    },

    validation: {
      summary:
        summarizeBacktestTrades(
          trades.slice(
            trainEnd,
            validationEnd
          )
        ),
    },

    test: {
      summary:
        summarizeBacktestTrades(
          trades.slice(
            validationEnd
          )
        ),
    },
  };
}

function buildBacktestEquityCurve(
  trades
) {
  let equity =
    1;

  return trades.map(
    (trade) => {
      equity *=
        1 +
        trade.net_return_pct /
          100;

      return {
        time:
          trade.exit_time,

        equity,

        cumulative_return_pct:
          (
            equity -
            1
          ) *
          100,
      };
    }
  );
}

function runDirectionalBacktest({
  bars,
  rsiSeries,
  macdSeries,
  requestedStart,
  holdDays,
  costBps,
  nonOverlapping,
}) {
  const rsiMap =
    new Map(
      rsiSeries.map(
        (item) => [
          item.begins_at,
          finiteNumber(
            item.value
          ),
        ]
      )
    );

  const macdMap =
    new Map(
      macdSeries.map(
        (item) => [
          item.begins_at,
          finiteNumber(
            item.histogram
          ),
        ]
      )
    );

  const trades =
    [];

  let nextEligibleSignalIndex =
    0;

  for (
    let i = 1;
    i <
    bars.length -
      holdDays;
    i++
  ) {
    const signalBar =
      bars[i];

    if (
      Date.parse(
        signalBar.time
      ) <
      requestedStart.getTime()
    ) {
      continue;
    }

    if (
      nonOverlapping &&
      i <
      nextEligibleSignalIndex
    ) {
      continue;
    }

    const previousBar =
      bars[
        i -
        1
      ];

    const rsi =
      rsiMap.get(
        signalBar.time
      ) ??
      null;

    const macdHistogram =
      macdMap.get(
        signalBar.time
      ) ??
      null;

    if (
      rsi ===
        null ||
      macdHistogram ===
        null
    ) {
      continue;
    }

    const changePct =
      previousBar.close >
      0
        ? (
            (
              signalBar.close -
              previousBar.close
            ) /
            previousBar.close
          ) *
          100
        : null;

    const momentum =
      scannerMomentumSignal({
        rsi,
        macdHistogram,
        changePct,
      });

    if (
      momentum.signal ===
      "neutral"
    ) {
      continue;
    }

    const entryIndex =
      i +
      1;

    const exitIndex =
      i +
      holdDays;

    const entryBar =
      bars[
        entryIndex
      ];

    const exitBar =
      bars[
        exitIndex
      ];

    if (
      !entryBar ||
      !exitBar ||
      entryBar.open <=
        0
    ) {
      continue;
    }

    const direction =
      momentum.signal ===
      "bullish"
        ? 1
        : -1;

    const grossReturnPct =
      direction *
      (
        (
          exitBar.close -
          entryBar.open
        ) /
        entryBar.open
      ) *
      100;

    const frictionPct =
      Math.max(
        0,
        costBps
      ) /
      100;

    const netReturnPct =
      grossReturnPct -
      frictionPct;

    const holdingBars =
      bars.slice(
        entryIndex,
        exitIndex +
          1
      );

    const highest =
      Math.max(
        ...holdingBars.map(
          (bar) =>
            bar.high
        )
      );

    const lowest =
      Math.min(
        ...holdingBars.map(
          (bar) =>
            bar.low
        )
      );

    const mfePct =
      direction >
      0
        ? (
            (
              highest -
              entryBar.open
            ) /
            entryBar.open
          ) *
          100
        : (
            (
              entryBar.open -
              lowest
            ) /
            entryBar.open
          ) *
          100;

    const maePct =
      direction >
      0
        ? (
            (
              lowest -
              entryBar.open
            ) /
            entryBar.open
          ) *
          100
        : (
            (
              entryBar.open -
              highest
            ) /
            entryBar.open
          ) *
          100;

    trades.push({
      id:
        signalBar.time +
        "|" +
        momentum.signal,

      signal:
        momentum.signal,

      signal_time:
        signalBar.time,

      entry_time:
        entryBar.time,

      exit_time:
        exitBar.time,

      hold_sessions:
        holdDays,

      signal_close:
        signalBar.close,

      entry_open:
        entryBar.open,

      exit_close:
        exitBar.close,

      rsi,

      macd_histogram:
        macdHistogram,

      signal_change_pct:
        changePct,

      bullish_score:
        momentum.bullishScore,

      bearish_score:
        momentum.bearishScore,

      gross_return_pct:
        grossReturnPct,

      friction_pct:
        frictionPct,

      net_return_pct:
        netReturnPct,

      mfe_pct:
        mfePct,

      mae_pct:
        maePct,

      favorable:
        netReturnPct >
        0,
    });

    if (
      nonOverlapping
    ) {
      nextEligibleSignalIndex =
        exitIndex;
    }
  }

  return trades;
}

/*
  =========================================================
  PAPER TRADE ANALYTICS
  =========================================================
*/

function finiteNumber(
  value
) {
  const number =
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}

function averageNumbers(
  values
) {
  const usable =
    values
      .map(
        finiteNumber
      )
      .filter(
        (value) =>
          value !==
          null
      );

  if (
    !usable.length
  ) {
    return null;
  }

  return (
    usable.reduce(
      (
        total,
        value
      ) =>
        total +
        value,
      0
    ) /
    usable.length
  );
}

function paperTradeDatasetRow(
  trade
) {
  const realizedPL =
    finiteNumber(
      trade.realizedPL
    );

  const entryCost =
    finiteNumber(
      trade.entryCost
    );

  const returnPct =
    realizedPL !==
      null &&
    entryCost !==
      null &&
    entryCost !==
      0
      ? (
          realizedPL /
          entryCost
        ) *
        100
      : null;

  const longIv =
    finiteNumber(
      trade.entryLongIv
    );

  const shortIv =
    finiteNumber(
      trade.entryShortIv
    );

  const meanIv =
    averageNumbers([
      longIv,
      shortIv,
    ]);

  const entrySlippageDollars =
    finiteNumber(
      trade.entrySlippageDollars
    ) ??
    0;

  const exitSlippageDollars =
    finiteNumber(
      trade.exitSlippageDollars
    ) ??
    0;

  return {
    id:
      trade.id ??
      null,

    ticker:
      trade.ticker ??
      null,

    status:
      trade.status ??
      null,

    opened_at:
      trade.openedAt ??
      null,

    closed_at:
      trade.closedAt ??
      null,

    expiration:
      trade.expiration ??
      null,

    option_type:
      trade.optionType ??
      null,

    long_strike:
      finiteNumber(
        trade.longStrike
      ),

    short_strike:
      finiteNumber(
        trade.shortStrike
      ),

    quantity:
      finiteNumber(
        trade.quantity
      ),

    fill_model:
      trade.fillModel ??
      null,

    entry_spot:
      finiteNumber(
        trade.entrySpot
      ),

    exit_spot:
      finiteNumber(
        trade.exitSpot
      ),

    entry_rsi:
      finiteNumber(
        trade.entryRsi
      ),

    exit_rsi:
      finiteNumber(
        trade.exitRsi
      ),

    entry_macd_histogram:
      finiteNumber(
        trade.entryMacdHistogram
      ),

    exit_macd_histogram:
      finiteNumber(
        trade.exitMacdHistogram
      ),

    entry_long_iv:
      longIv,

    entry_short_iv:
      shortIv,

    entry_mean_iv:
      meanIv,

    entry_delta:
      finiteNumber(
        trade.entryDelta
      ),

    entry_gamma:
      finiteNumber(
        trade.entryGamma
      ),

    entry_theta:
      finiteNumber(
        trade.entryTheta
      ),

    entry_vega:
      finiteNumber(
        trade.entryVega
      ),

    entry_put_oi_wall:
      finiteNumber(
        trade.entryPutOIWall
      ),

    entry_call_oi_wall:
      finiteNumber(
        trade.entryCallOIWall
      ),

    entry_gamma_concentration:
      finiteNumber(
        trade.entryGammaConcentration
      ),

    reward_risk:
      finiteNumber(
        trade.paperRewardRisk ??
        trade.rewardRisk
      ),

    max_loss:
      finiteNumber(
        trade.paperMaxLoss ??
        trade.maxLoss
      ),

    max_profit:
      finiteNumber(
        trade.paperMaxProfit ??
        trade.maxProfit
      ),

    breakeven:
      finiteNumber(
        trade.breakeven
      ),

    entry_theoretical_midpoint:
      finiteNumber(
        trade.entryTheoreticalMidpoint ??
        trade.entryPrice
      ),

    entry_fill:
      finiteNumber(
        trade.entryPrice
      ),

    entry_slippage_dollars:
      entrySlippageDollars,

    exit_theoretical_midpoint:
      finiteNumber(
        trade.exitTheoreticalMidpoint ??
        trade.exitPrice
      ),

    exit_fill:
      finiteNumber(
        trade.exitPrice
      ),

    exit_slippage_dollars:
      exitSlippageDollars,

    total_slippage_dollars:
      entrySlippageDollars +
      exitSlippageDollars,

    total_fees:
      finiteNumber(
        trade.totalFees
      ) ??
      finiteNumber(
        trade.entryFees
      ) ??
      0,

    realized_pl:
      realizedPL,

    realized_return_pct:
      returnPct,

    mfe:
      finiteNumber(
        trade.maxFavorablePL
      ),

    mae:
      finiteNumber(
        trade.maxAdversePL
      ),

    holding_minutes:
      finiteNumber(
        trade.holdingMinutes
      ),

    exit_reason:
      trade.exitReason ??
      null,

    profitable:
      realizedPL !==
      null
        ? realizedPL >
          0
        : null,
  };
}

function rsiBucket(
  value
) {
  const number =
    finiteNumber(
      value
    );

  if (
    number ===
    null
  ) {
    return "Unknown";
  }

  if (
    number <
    30
  ) {
    return "<30";
  }

  if (
    number <
    50
  ) {
    return "30-49.9";
  }

  if (
    number <
    70
  ) {
    return "50-69.9";
  }

  return "70+";
}

function macdBucket(
  value
) {
  const number =
    finiteNumber(
      value
    );

  if (
    number ===
    null
  ) {
    return "Unknown";
  }

  if (
    number >
    0
  ) {
    return "Positive";
  }

  if (
    number <
    0
  ) {
    return "Negative";
  }

  return "Zero";
}

function ivBucket(
  value
) {
  const number =
    finiteNumber(
      value
    );

  if (
    number ===
    null
  ) {
    return "Unknown";
  }

  const percent =
    number *
    100;

  if (
    percent <
    25
  ) {
    return "<25%";
  }

  if (
    percent <
    40
  ) {
    return "25-39.9%";
  }

  if (
    percent <
    60
  ) {
    return "40-59.9%";
  }

  return "60%+";
}

function rewardRiskBucket(
  value
) {
  const number =
    finiteNumber(
      value
    );

  if (
    number ===
    null
  ) {
    return "Unknown";
  }

  if (
    number <
    1
  ) {
    return "<1.0x";
  }

  if (
    number <
    1.5
  ) {
    return "1.0-1.49x";
  }

  if (
    number <
    2
  ) {
    return "1.5-1.99x";
  }

  return "2.0x+";
}

function holdingBucket(
  value
) {
  const minutes =
    finiteNumber(
      value
    );

  if (
    minutes ===
    null
  ) {
    return "Unknown";
  }

  if (
    minutes <
    60
  ) {
    return "<1h";
  }

  if (
    minutes <
    240
  ) {
    return "1-4h";
  }

  if (
    minutes <
    1440
  ) {
    return "4-24h";
  }

  if (
    minutes <
    4320
  ) {
    return "1-3d";
  }

  return "3d+";
}

function buildBreakdown(
  rows,
  keyFunction
) {
  const groups =
    new Map();

  for (
    const row of rows
  ) {
    const key =
      String(
        keyFunction(
          row
        ) ??
        "Unknown"
      );

    if (
      !groups.has(
        key
      )
    ) {
      groups.set(
        key,
        []
      );
    }

    groups.get(
      key
    ).push(
      row
    );
  }

  return [
    ...groups.entries(),
  ]
    .map(
      ([
        key,
        groupRows,
      ]) => {
        const wins =
          groupRows.filter(
            (row) =>
              (
                finiteNumber(
                  row.realized_pl
                ) ??
                0
              ) >
              0
          );

        const losses =
          groupRows.filter(
            (row) =>
              (
                finiteNumber(
                  row.realized_pl
                ) ??
                0
              ) <
              0
          );

        const totalPL =
          groupRows.reduce(
            (
              total,
              row
            ) =>
              total +
              (
                finiteNumber(
                  row.realized_pl
                ) ??
                0
              ),
            0
          );

        return {
          key,

          trades:
            groupRows.length,

          wins:
            wins.length,

          losses:
            losses.length,

          win_rate:
            groupRows.length >
            0
              ? (
                  wins.length /
                  groupRows.length
                ) *
                100
              : null,

          total_pl:
            totalPL,

          average_pl:
            averageNumbers(
              groupRows.map(
                (row) =>
                  row.realized_pl
              )
            ),

          average_return_pct:
            averageNumbers(
              groupRows.map(
                (row) =>
                  row.realized_return_pct
              )
            ),

          average_mfe:
            averageNumbers(
              groupRows.map(
                (row) =>
                  row.mfe
              )
            ),

          average_mae:
            averageNumbers(
              groupRows.map(
                (row) =>
                  row.mae
              )
            ),
        };
      }
    )
    .sort(
      (a, b) =>
        b.trades -
        a.trades ||
        a.key.localeCompare(
          b.key
        )
    );
}

function calculateMaxDrawdown(
  rows
) {
  const ordered =
    [...rows].sort(
      (a, b) =>
        Date.parse(
          a.closed_at ||
          0
        ) -
        Date.parse(
          b.closed_at ||
          0
        )
    );

  let cumulative =
    0;

  let peak =
    0;

  let maxDrawdown =
    0;

  for (
    const row of ordered
  ) {
    cumulative +=
      finiteNumber(
        row.realized_pl
      ) ??
      0;

    peak =
      Math.max(
        peak,
        cumulative
      );

    maxDrawdown =
      Math.min(
        maxDrawdown,
        cumulative -
        peak
      );
  }

  return {
    max_drawdown:
      maxDrawdown,

    cumulative_pl:
      cumulative,
  };
}

function buildPaperAnalytics(
  state
) {
  const allTrades =
    Array.isArray(
      state.paperTrades
    )
      ? state.paperTrades
      : [];

  const openTrades =
    allTrades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closedTrades =
    allTrades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const dataset =
    closedTrades.map(
      paperTradeDatasetRow
    );

  const wins =
    dataset.filter(
      (row) =>
        (
          finiteNumber(
            row.realized_pl
          ) ??
          0
        ) >
        0
    );

  const losses =
    dataset.filter(
      (row) =>
        (
          finiteNumber(
            row.realized_pl
          ) ??
          0
        ) <
        0
    );

  const grossProfit =
    wins.reduce(
      (
        total,
        row
      ) =>
        total +
        (
          finiteNumber(
            row.realized_pl
          ) ??
          0
        ),
      0
    );

  const grossLoss =
    Math.abs(
      losses.reduce(
        (
          total,
          row
        ) =>
          total +
          (
            finiteNumber(
              row.realized_pl
            ) ??
            0
          ),
        0
      )
    );

  const drawdown =
    calculateMaxDrawdown(
      dataset
    );

  const summary = {
    total_trades:
      allTrades.length,

    open_trades:
      openTrades.length,

    closed_trades:
      dataset.length,

    wins:
      wins.length,

    losses:
      losses.length,

    breakeven_trades:
      dataset.length -
      wins.length -
      losses.length,

    win_rate:
      dataset.length >
      0
        ? (
            wins.length /
            dataset.length
          ) *
          100
        : null,

    gross_profit:
      grossProfit,

    gross_loss:
      grossLoss,

    profit_factor:
      grossLoss >
      0
        ? grossProfit /
          grossLoss
        : grossProfit >
            0
          ? null
          : null,

    expectancy_per_trade:
      averageNumbers(
        dataset.map(
          (row) =>
            row.realized_pl
        )
      ),

    average_winner:
      averageNumbers(
        wins.map(
          (row) =>
            row.realized_pl
        )
      ),

    average_loser:
      averageNumbers(
        losses.map(
          (row) =>
            row.realized_pl
        )
      ),

    cumulative_pl:
      drawdown.cumulative_pl,

    max_drawdown:
      drawdown.max_drawdown,

    average_mfe:
      averageNumbers(
        dataset.map(
          (row) =>
            row.mfe
        )
      ),

    average_mae:
      averageNumbers(
        dataset.map(
          (row) =>
            row.mae
        )
      ),

    average_slippage:
      averageNumbers(
        dataset.map(
          (row) =>
            row.total_slippage_dollars
        )
      ),

    average_fees:
      averageNumbers(
        dataset.map(
          (row) =>
            row.total_fees
        )
      ),

    average_holding_minutes:
      averageNumbers(
        dataset.map(
          (row) =>
            row.holding_minutes
        )
      ),
  };

  return {
    generated_at:
      new Date().toISOString(),

    dataset_version:
      1,

    summary,

    breakdowns: {
      ticker:
        buildBreakdown(
          dataset,
          (row) =>
            row.ticker
        ),

      option_type:
        buildBreakdown(
          dataset,
          (row) =>
            row.option_type
        ),

      entry_rsi:
        buildBreakdown(
          dataset,
          (row) =>
            rsiBucket(
              row.entry_rsi
            )
        ),

      entry_macd:
        buildBreakdown(
          dataset,
          (row) =>
            macdBucket(
              row.entry_macd_histogram
            )
        ),

      entry_iv:
        buildBreakdown(
          dataset,
          (row) =>
            ivBucket(
              row.entry_mean_iv
            )
        ),

      reward_risk:
        buildBreakdown(
          dataset,
          (row) =>
            rewardRiskBucket(
              row.reward_risk
            )
        ),

      exit_reason:
        buildBreakdown(
          dataset,
          (row) =>
            row.exit_reason ||
            "Unknown"
        ),

      holding_time:
        buildBreakdown(
          dataset,
          (row) =>
            holdingBucket(
              row.holding_minutes
            )
        ),

      fill_model:
        buildBreakdown(
          dataset,
          (row) =>
            row.fill_model ||
            "legacy"
        ),
    },

    dataset,
  };
}

function csvEscape(
  value
) {
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
    return `"${text.replaceAll(
      '"',
      '""'
    )}"`;
  }

  return text;
}

function datasetToCsv(
  rows
) {
  if (
    !rows.length
  ) {
    return "";
  }

  const headers =
    Object.keys(
      rows[0]
    );

  return [
    headers
      .map(
        csvEscape
      )
      .join(","),

    ...rows.map(
      (row) =>
        headers
          .map(
            (header) =>
              csvEscape(
                row[
                  header
                ]
              )
          )
          .join(",")
    ),
  ].join("\n");
}

/*
  =========================================================
  SCANNER STATE API
  =========================================================
*/

app.get(
  "/scanner/state",

  async (_req, res) => {
    try {
      return res.json(
        await readScannerState()
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);


app.post(
  "/scanner/backtest",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.body
            ?.symbol
        );

      const lookbackDays =
        clampNumber(
          req.body
            ?.lookbackDays,
          60,
          3650,
          365
        );

      const holdDays =
        clampNumber(
          req.body
            ?.holdDays,
          1,
          30,
          5
        );

      const costBps =
        Math.max(
          0,
          Math.min(
            500,
            Number(
              req.body
                ?.costBps ??
              0
            ) ||
            0
          )
        );

      const nonOverlapping =
        req.body
          ?.nonOverlapping !==
        false;

      const end =
        new Date();

      const requestedStart =
        new Date(
          end.getTime() -
          lookbackDays *
            24 *
            60 *
            60 *
            1000
        );

      const fetchStart =
        new Date(
          requestedStart.getTime() -
          120 *
            24 *
            60 *
            60 *
            1000
        );

      const common = {
        start_time:
          fetchStart.toISOString(),

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
        historicalResult,
        rsiResult,
        macdResult,
      ] =
        await Promise.all([
          callRobinhoodTool(
            "get_equity_historicals",
            {
              symbols: [
                symbol,
              ],

              ...common,
            }
          ),

          callRobinhoodTool(
            "get_equity_technical_indicators",
            {
              symbol,

              type:
                "rsi",

              ...common,

              output:
                "series",

              period:
                14,
            }
          ),

          callRobinhoodTool(
            "get_equity_technical_indicators",
            {
              symbol,

              type:
                "macd",

              ...common,

              output:
                "series",

              fast_period:
                12,

              slow_period:
                26,

              signal_period:
                9,
            }
          ),
        ]);

      const historicalPayload =
        unwrapRobinhoodToolResult(
          historicalResult
        );

      const rsiPayload =
        unwrapRobinhoodToolResult(
          rsiResult
        );

      const macdPayload =
        unwrapRobinhoodToolResult(
          macdResult
        );

      const bars =
        extractBacktestBars(
          historicalPayload
        );

      const rsiSeries =
        extractBacktestIndicator(
          rsiPayload,
          "rsi"
        );

      const macdSeries =
        extractBacktestIndicator(
          macdPayload,
          "macd"
        );

      if (
        bars.length <
        holdDays +
          3
      ) {
        return res
          .status(400)
          .json({
            error:
              "Not enough historical bars were returned for this backtest.",
          });
      }

      const trades =
        runDirectionalBacktest({
          bars,
          rsiSeries,
          macdSeries,
          requestedStart,
          holdDays,
          costBps,
          nonOverlapping,
        });

      const summary =
        summarizeBacktestTrades(
          trades
        );

      const chronological =
        buildChronologicalEvaluation(
          trades
        );

      const bullishTrades =
        trades.filter(
          (trade) =>
            trade.signal ===
            "bullish"
        );

      const bearishTrades =
        trades.filter(
          (trade) =>
            trade.signal ===
            "bearish"
        );

      return res.json({
        generated_at:
          new Date().toISOString(),

        symbol,

        engine:
          "scanner_directional_proxy_v1",

        methodology: {
          signal_rule:
            "Same scanner momentum score: RSI >=55 / <=45, MACD histogram sign, and daily price direction. Two of three aligned signals are required.",

          execution:
            "Signal is evaluated at a completed daily close. Entry uses the next regular-session open. Exit uses the close after the selected number of trading sessions.",

          instrument:
            "Underlying stock directional return proxy. This is not an historical options-spread P/L reconstruction.",

          friction:
            costBps.toFixed(
              1
            ) +
            " bps round-trip return deduction per simulated trade.",

          overlap:
            nonOverlapping
              ? "Same-symbol trades do not overlap."
              : "Signals may overlap.",
        },

        parameters: {
          lookback_days:
            lookbackDays,

          hold_sessions:
            holdDays,

          cost_bps:
            costBps,

          non_overlapping:
            nonOverlapping,
        },

        data: {
          fetched_bar_count:
            bars.length,

          first_bar:
            bars[0]?.time ??
            null,

          last_bar:
            bars[
              bars.length -
              1
            ]?.time ??
            null,

          requested_start:
            requestedStart.toISOString(),
        },

        summary,

        by_direction: {
          bullish:
            summarizeBacktestTrades(
              bullishTrades
            ),

          bearish:
            summarizeBacktestTrades(
              bearishTrades
            ),
        },

        chronological_evaluation:
          chronological,

        equity_curve:
          buildBacktestEquityCurve(
            trades
          ),

        trades,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

app.get(
  "/scanner/paper-analytics",

  async (_req, res) => {
    try {
      const state =
        await readScannerState();

      return res.json(
        buildPaperAnalytics(
          state
        )
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.get(
  "/scanner/paper-dataset.csv",

  async (_req, res) => {
    try {
      const state =
        await readScannerState();

      const analytics =
        buildPaperAnalytics(
          state
        );

      const csv =
        datasetToCsv(
          analytics.dataset
        );

      res.setHeader(
        "Content-Type",
        "text/csv; charset=utf-8"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="options-scanner-paper-trades.csv"'
      );

      return res.send(
        csv
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.get(
  "/scanner/health",

  async (_req, res) => {
    let fileExists =
      false;

    let fileReadable =
      false;

    let fileSizeBytes =
      0;

    let fileModifiedAt =
      null;

    let state =
      defaultScannerState();

    try {
      const stats =
        await fs.stat(
          SCANNER_STATE_FILE
        );

      fileExists =
        stats.isFile();

      fileSizeBytes =
        stats.size;

      fileModifiedAt =
        stats.mtime
          ?.toISOString?.() ??
        null;

    } catch (error) {
      if (
        error?.code !==
        "ENOENT"
      ) {
        console.error(
          "[Scanner health stat]",
          safeErrorMessage(
            error
          )
        );
      }
    }

    try {
      state =
        await readScannerState();

      fileReadable =
        true;

    } catch (error) {
      console.error(
        "[Scanner health read]",
        safeErrorMessage(
          error
        )
      );
    }

    return res.json({
      status:
        "ok",

      backend: {
        port:
          PORT,

        uptime_seconds:
          Math.floor(
            process.uptime()
          ),

        started_at:
          new Date(
            Date.now() -
            process.uptime() *
              1000
          ).toISOString(),
      },

      robinhood: {
        connected:
          !!robinhoodClient,

        oauthPending,
      },

      storage: {
        mode:
          "backend-file",

        file:
          ".data/scanner-state.json",

        exists:
          fileExists,

        readable:
          fileReadable,

        size_bytes:
          fileSizeBytes,

        modified_at:
          fileModifiedAt,

        state_updated_at:
          state.updatedAt,

        saved_plan_count:
          state.savedPlans.length,

        saved_comparison_count:
          Object.keys(
            state.savedComparisons ||
            {}
          ).length,

        paper_trade_count:
          state.paperTrades.length,

        open_paper_trade_count:
          state.paperTrades.filter(
            (trade) =>
              trade.status ===
              "open"
          ).length,
      },

      paperTrading: {
        fillModel:
          state.paperSettings
            ?.fillModel ??
          "quarter_spread",

        feePerContractPerLeg:
          state.paperSettings
            ?.feePerContractPerLeg ??
          0,

        riskLimits:
          state.paperSettings
            ?.riskLimits ??
          {},
      },

      preferences: {
        autoRefresh:
          state.preferences
            ?.autoRefresh ??
          {
            enabled: false,
            seconds: 60,
          },

        notifications:
          state.preferences
            ?.notifications ??
          {
            enabled: false,
          },
      },
    });
  }
);

app.post(
  "/scanner/state/migrate",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const incoming =
        req.body || {};

      const merged = {
        ...current,

        savedPlans:
          mergeSavedPlans(
            current.savedPlans,
            incoming.savedPlans
          ),

        savedComparisons: {
          ...current.savedComparisons,

          ...(
            incoming.savedComparisons &&
            typeof incoming.savedComparisons ===
              "object" &&
            !Array.isArray(
              incoming.savedComparisons
            )
              ? incoming.savedComparisons
              : {}
          ),
        },

        paperTrades:
          mergePaperTrades(
            current.paperTrades,
            incoming.paperTrades
          ),

        paperSettings: {
          ...current.paperSettings,

          ...(
            incoming.paperSettings &&
            typeof incoming.paperSettings ===
              "object" &&
            !Array.isArray(
              incoming.paperSettings
            )
              ? incoming.paperSettings
              : {}
          ),

          riskLimits: {
            ...current.paperSettings
              .riskLimits,

            ...(
              incoming.paperSettings
                ?.riskLimits &&
              typeof incoming.paperSettings
                .riskLimits ===
                "object"
                ? incoming.paperSettings
                    .riskLimits
                : {}
            ),
          },
        },

        preferences: {
          autoRefresh: {
            ...current.preferences
              .autoRefresh,

            ...(
              incoming.preferences
                ?.autoRefresh &&
              typeof incoming.preferences
                .autoRefresh ===
                "object"
                ? incoming.preferences
                    .autoRefresh
                : {}
            ),
          },

          notifications: {
            ...current.preferences
              .notifications,

            ...(
              incoming.preferences
                ?.notifications &&
              typeof incoming.preferences
                .notifications ===
                "object"
                ? incoming.preferences
                    .notifications
                : {}
            ),
          },
        },
      };

      return res.json(
        await writeScannerState(
          merged
        )
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.put(
  "/scanner/state/saved-plans",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const savedPlans =
        Array.isArray(
          req.body
            ?.savedPlans
        )
          ? req.body
              .savedPlans
          : [];

      return res.json(
        await writeScannerState({
          ...current,
          savedPlans,
        })
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.put(
  "/scanner/state/saved-comparisons",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const savedComparisons =
        req.body
          ?.savedComparisons &&
        typeof req.body
          .savedComparisons ===
          "object" &&
        !Array.isArray(
          req.body
            .savedComparisons
        )
          ? req.body
              .savedComparisons
          : {};

      return res.json(
        await writeScannerState({
          ...current,
          savedComparisons,
        })
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.put(
  "/scanner/state/paper-settings",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const incoming =
        req.body
          ?.paperSettings &&
        typeof req.body
          .paperSettings ===
          "object" &&
        !Array.isArray(
          req.body
            .paperSettings
        )
          ? req.body
              .paperSettings
          : {};

      return res.json(
        await writeScannerState({
          ...current,

          paperSettings: {
            ...current.paperSettings,

            ...incoming,

            riskLimits: {
              ...current.paperSettings
                .riskLimits,

              ...(
                incoming.riskLimits &&
                typeof incoming.riskLimits ===
                  "object"
                  ? incoming
                      .riskLimits
                  : {}
              ),
            },
          },
        })
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.put(
  "/scanner/state/paper-trades",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const paperTrades =
        Array.isArray(
          req.body
            ?.paperTrades
        )
          ? req.body
              .paperTrades
          : [];

      return res.json(
        await writeScannerState({
          ...current,
          paperTrades,
        })
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

app.put(
  "/scanner/state/preferences",

  async (req, res) => {
    try {
      const current =
        await readScannerState();

      const preferences =
        req.body
          ?.preferences &&
        typeof req.body
          .preferences ===
          "object"
          ? req.body
              .preferences
          : {};

      return res.json(
        await writeScannerState({
          ...current,

          preferences: {
            autoRefresh: {
              ...current.preferences
                .autoRefresh,

              ...(
                preferences
                  .autoRefresh &&
                typeof preferences
                  .autoRefresh ===
                  "object"
                  ? preferences
                      .autoRefresh
                  : {}
              ),
            },

            notifications: {
              ...current.preferences
                .notifications,

              ...(
                preferences
                  .notifications &&
                typeof preferences
                  .notifications ===
                  "object"
                  ? preferences
                      .notifications
                  : {}
              ),
            },
          },
        })
      );

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

/*
  =========================================================
  HEALTH
  =========================================================
*/

app.get(
  "/",

  (_req, res) => {
    res.json({
      status:
        "ok",

      backend: {
        uptime_seconds:
          Math.floor(
            process.uptime()
          ),
      },

      robinhood: {
        connected:
          !!robinhoodClient,

        oauthPending,

        endpoint:
          ROBINHOOD_MCP_URL,
      },

      storage: {
        active:
          true,

        endpoint:
          "/scanner/health",
      },

      anthropic: {
        active:
          !!ANTHROPIC_API_KEY,
      },
    });
  }
);

/*
  =========================================================
  ROBINHOOD STATUS
  =========================================================
*/

app.get(
  "/robinhood/status",

  (_req, res) => {
    res.json({
      connected:
        !!robinhoodClient,

      oauthPending,

      clientRegistered:
        !!robinhoodAuth.clientInfo,

      tokensPresent:
        !!robinhoodAuth.savedTokens,

      verifierPresent:
        !!robinhoodAuth.verifier,
    });
  }
);

/*
  =========================================================
  START ROBINHOOD OAUTH
  =========================================================
*/

app.get(
  "/robinhood/connect",

  async (_req, res) => {
    try {
      /*
        OAuth already started.
        Reuse the same URL.
      */

      if (
        oauthPending &&
        pendingTransport &&
        robinhoodAuth.authorizationUrl
      ) {
        console.log(
          "[Robinhood OAuth] Reusing existing authorization URL."
        );

        return res.redirect(
          robinhoodAuth.authorizationUrl
        );
      }

      const connected =
        await connectRobinhood();

      if (connected) {
        return res.send(`
          <!doctype html>

          <html>
            <body>
              <h2>
                Robinhood already connected
              </h2>

              <p>
                The Options Scanner backend already has
                access to Robinhood.
              </p>

              <p>
                You may close this tab.
              </p>
            </body>
          </html>
        `);
      }

      if (
        robinhoodAuth.authorizationUrl
      ) {
        console.log(
          "[Robinhood OAuth] Redirecting browser to Robinhood."
        );

        return res.redirect(
          robinhoodAuth.authorizationUrl
        );
      }

      throw new Error(
        "Robinhood authorization URL was not generated."
      );

    } catch (error) {
      console.error(
        "[Robinhood connect]",
        safeErrorMessage(
          error
        )
      );

      return res
        .status(500)
        .json({
          error:
            safeErrorMessage(
              error
            ),
        });
    }
  }
);

/*
  =========================================================
  ROBINHOOD OAUTH CALLBACK
  =========================================================
*/

app.get(
  "/robinhood/callback",

  async (req, res) => {
    try {
      if (
        !oauthPending ||
        !pendingTransport
      ) {
        throw new Error(
          "No Robinhood OAuth session is waiting for this callback."
        );
      }

      const callbackUrl =
        new URL(
          req.originalUrl,
          `http://127.0.0.1:${PORT}`
        );

      const params =
        callbackUrl.searchParams;

      /*
        State validation.
      */

      if (
        params.get("state") !==
        robinhoodAuth.lastState
      ) {
        throw new Error(
          "Robinhood OAuth state mismatch."
        );
      }

      if (
        !params.get("code")
      ) {
        const oauthError =
          params.get(
            "error"
          );

        const description =
          params.get(
            "error_description"
          );

        throw new Error(
          oauthError
            ? `${oauthError}: ${
                description ||
                "Robinhood authorization failed."
              }`
            : "Robinhood did not return an authorization code."
        );
      }

      console.log(
        "[Robinhood OAuth] Authorization code received."
      );

      /*
        Finish OAuth on the SAME transport that initiated
        the authorization request.
      */

      await pendingTransport.finishAuth(
        params
      );

      console.log(
        "[Robinhood OAuth] Token exchange successful."
      );

      /*
        MCP requires a fresh transport after OAuth.
      */

      const newClient =
        makeRobinhoodClient();

      const newTransport =
        makeRobinhoodTransport();

      await newClient.connect(
        newTransport
      );

      robinhoodClient =
        newClient;

      pendingTransport =
        null;

      oauthPending =
        false;

      robinhoodAuth.authorizationUrl =
        undefined;

      robinhoodAuth.lastState =
        undefined;

      console.log(
        "[Robinhood] MCP connected successfully."
      );

      /*
        Confirm tools are available.
      */

      const tools =
        await robinhoodClient.listTools();

      const readableTools =
        (tools.tools || [])
          .filter(
            (tool) =>
              ROBINHOOD_READ_TOOLS.has(
                tool.name
              )
          );

      console.log(
        "[Robinhood] Total MCP tools:",
        tools.tools?.length || 0
      );

      console.log(
        "[Robinhood] Scanner-approved read tools:",
        readableTools.length
      );

      return res.send(`
        <!doctype html>

        <html>
          <head>
            <title>
              Robinhood Connected
            </title>
          </head>

          <body>
            <h2>
              Robinhood connected successfully
            </h2>

            <p>
              MCP tools discovered:
              ${tools.tools?.length || 0}
            </p>

            <p>
              Read-only tools available to Options Scanner:
              ${readableTools.length}
            </p>

            <p>
              You may close this tab.
            </p>
          </body>
        </html>
      `);

    } catch (error) {
      console.error(
        "[Robinhood OAuth callback]"
      );

      console.error(
        "name:",
        error?.name
      );

      console.error(
        "message:",
        error?.message
      );

      console.error(
        "errorCode:",
        error?.errorCode
      );

      return res
        .status(500)
        .send(`
          <!doctype html>

          <html>
            <body>
              <h2>
                Robinhood connection failed
              </h2>

              <pre>${escapeHtml(
                safeErrorMessage(
                  error
                )
              )}</pre>
            </body>
          </html>
        `);
    }
  }
);

/*
  =========================================================
  LIST ROBINHOOD READ TOOLS
  =========================================================
*/

app.get(
  "/robinhood/tools",

  async (_req, res) => {
    try {
      const client =
        await requireRobinhood();

      const result =
        await client.listTools();

      const tools =
        (result.tools || [])
          .filter(
            (tool) =>
              ROBINHOOD_READ_TOOLS.has(
                tool.name
              )
          );

      return res.json({
        count:
          tools.length,

        tools,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  GENERIC SAFE TOOL CALL
  =========================================================

  POST /robinhood/call

  {
    "toolName": "get_equity_quotes",
    "arguments": {
      "symbols": ["PLTR"]
    }
  }
*/

app.post(
  "/robinhood/call",

  async (req, res) => {
    try {
      const {
        toolName,
        arguments: args = {},
      } = req.body || {};

      if (!toolName) {
        return res
          .status(400)
          .json({
            error:
              "toolName is required.",
          });
      }

      const result =
        await callRobinhoodTool(
          toolName,
          args
        );

      return res.json({
        source:
          "Robinhood Trading MCP",

        tool:
          toolName,

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  EQUITY QUOTE
  =========================================================

  GET /robinhood/quote/PLTR
*/

app.get(
  "/robinhood/quote/:symbol",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.params.symbol
        );

      const result =
        await callRobinhoodTool(
          "get_equity_quotes",
          {
            symbols: [
              symbol,
            ],
          }
        );

      return res.json({
        symbol,

        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  EQUITY HISTORICALS
  =========================================================

  Example:

  /robinhood/historicals/PLTR?days=30&interval=5minute
*/

app.get(
  "/robinhood/historicals/:symbol",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.params.symbol
        );

      const days =
        clampNumber(
          req.query.days,
          1,
          3650,
          30
        );

      const interval =
        String(
          req.query.interval ||
          "day"
        );

      const end =
        new Date();

      const start =
        new Date(
          end.getTime() -
          days *
          24 *
          60 *
          60 *
          1000
        );

      const result =
        await callRobinhoodTool(
          "get_equity_historicals",
          {
            symbols: [
              symbol,
            ],

            start_time:
              start.toISOString(),

            end_time:
              end.toISOString(),

            interval,

            bounds:
              "regular",

            adjustment_type:
              "split",
          }
        );

      return res.json({
        symbol,
        interval,
        days,

        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  OPTION CHAINS
  =========================================================

  GET /robinhood/options/PLTR/chains
*/

app.get(
  "/robinhood/options/:symbol/chains",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.params.symbol
        );

      const result =
        await callRobinhoodTool(
          "get_option_chains",
          {
            underlying_symbol:
              symbol,
          }
        );

      return res.json({
        symbol,

        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  OPTION INSTRUMENTS
  =========================================================

  Examples:

  /robinhood/options/PLTR/instruments

  /robinhood/options/PLTR/instruments
    ?expiration=2026-10-09

  /robinhood/options/PLTR/instruments
    ?expiration=2026-10-09&type=call
*/

app.get(
  "/robinhood/options/:symbol/instruments",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.params.symbol
        );

      const expiration =
        String(
          req.query.expiration ||
          ""
        )
          .trim();

      const type =
        String(
          req.query.type ||
          ""
        )
          .trim()
          .toLowerCase();

      const strike =
        String(
          req.query.strike ||
          ""
        )
          .trim();

      const args = {
        chain_symbol:
          symbol,

        state:
          "active",
      };

      if (expiration) {
        args.expiration_dates =
          expiration;
      }

      if (
        type === "call" ||
        type === "put"
      ) {
        args.type =
          type;
      }

      if (strike) {
        args.strike_price =
          strike;
      }

      const result =
        await callRobinhoodTool(
          "get_option_instruments",
          args
        );

      return res.json({
        symbol,

        expiration:
          expiration || null,

        type:
          type || null,

        strike:
          strike || null,

        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  OPTION QUOTES
  =========================================================

  POST /robinhood/options/quotes

  {
    "instrument_ids": [
      "uuid",
      "uuid"
    ]
  }
*/

app.post(
  "/robinhood/options/quotes",

  async (req, res) => {
    try {
      const ids =
        req.body
          ?.instrument_ids;

      if (
        !Array.isArray(ids) ||
        ids.length === 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "instrument_ids must be a non-empty array.",
          });
      }

      const result =
        await callRobinhoodTool(
          "get_option_quotes",
          {
            instrument_ids:
              ids,
          }
        );

      return res.json({
        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  TECHNICAL INDICATORS
  =========================================================

  Examples:

  /robinhood/technical/PLTR/rsi
  /robinhood/technical/PLTR/macd
*/

app.get(
  "/robinhood/technical/:symbol/:indicator",

  async (req, res) => {
    try {
      const symbol =
        normalizeTicker(
          req.params.symbol
        );

      const indicator =
        String(
          req.params.indicator ||
          ""
        )
          .trim()
          .toLowerCase();

      const allowedIndicators =
        new Set([
          "ema",
          "sma",
          "rsi",
          "momentum",
          "roc",
          "cci",
          "williams_r",
          "atr",
          "mfi",
          "adx",
          "donchian_channels",
          "bollinger_bands",
          "macd",
          "keltner_channels",
          "supertrend",
          "vwap",
          "obv",
          "pivot_points",
        ]);

      if (
        !allowedIndicators.has(
          indicator
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Unsupported technical indicator.",
          });
      }

      const interval =
        String(
          req.query.interval ||
          "day"
        );

      const days =
        clampNumber(
          req.query.days,
          30,
          3650,
          365
        );

      const end =
        new Date();

      const start =
        new Date(
          end.getTime() -
          days *
          24 *
          60 *
          60 *
          1000
        );

      const args = {
        symbol,

        type:
          indicator,

        interval,

        start_time:
          start.toISOString(),

        end_time:
          end.toISOString(),

        bounds:
          "regular",

        adjustment_type:
          "split",

        output:
          "latest",
      };

      /*
        Optional RSI / SMA / EMA etc. period.
      */

      if (
        req.query.period
      ) {
        args.period =
          clampNumber(
            req.query.period,
            1,
            500,
            14
          );
      }

      /*
        Optional MACD configuration.
      */

      if (
        indicator === "macd"
      ) {
        if (
          req.query.fast
        ) {
          args.fast_period =
            clampNumber(
              req.query.fast,
              1,
              200,
              12
            );
        }

        if (
          req.query.slow
        ) {
          args.slow_period =
            clampNumber(
              req.query.slow,
              1,
              300,
              26
            );
        }

        if (
          req.query.signal
        ) {
          args.signal_period =
            clampNumber(
              req.query.signal,
              1,
              200,
              9
            );
        }
      }

      const result =
        await callRobinhoodTool(
          "get_equity_technical_indicators",
          args
        );

      return res.json({
        symbol,
        indicator,
        interval,

        source:
          "Robinhood Trading MCP",

        retrieved_at:
          new Date()
            .toISOString(),

        result,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

/*
  =========================================================
  ANTHROPIC PROXY
  =========================================================
*/

app.get(
  "/anthropic",

  (_req, res) =>
    res
      .status(405)
      .json({
        error:
          "Use POST /anthropic",
      })
);

app.post(
  "/anthropic",

  async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
      return res
        .status(500)
        .json({
          error:
            "ANTHROPIC_API_KEY not set in .env",
        });
    }

    let response;
    let text;

    try {
      response =
        await fetch(
          "https://api.anthropic.com/v1/messages",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-api-key":
                ANTHROPIC_API_KEY,

              "anthropic-version":
                "2023-06-01",
            },

            body:
              JSON.stringify(
                req.body
              ),
          }
        );

      text =
        await response.text();

    } catch (error) {
      return res
        .status(500)
        .json({
          error:
            `Fetch failed: ${error.message}`,
        });
    }

    let data;

    try {
      data =
        JSON.parse(text);

    } catch {
      return res
        .status(response.status)
        .send(text);
    }

    return res
      .status(response.status)
      .json(data);
  }
);

/*
  =========================================================
  HELPERS
  =========================================================
*/

function normalizeTicker(value) {
  const symbol =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    !/^[A-Z0-9.^-]{1,15}$/.test(
      symbol
    )
  ) {
    const error =
      new Error(
        "Invalid ticker symbol."
      );

    error.status =
      400;

    throw error;
  }

  return symbol;
}

function clampNumber(
  value,
  min,
  max,
  fallback
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(
      min,
      Math.round(number)
    )
  );
}

function safeErrorMessage(error) {
  return (
    error?.message ||
    error?.error_description ||
    error?.errorCode ||
    error?.name ||
    "Unknown error"
  );
}

function handleRobinhoodError(
  error,
  res
) {
  console.error(
    "[Robinhood]",
    safeErrorMessage(
      error
    )
  );

  return res
    .status(
      error.status ||
      500
    )
    .json({
      error:
        safeErrorMessage(
          error
        ),
    });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}

/*
  =========================================================
  START SERVER
  =========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",

  () => {
    console.log("");

    console.log(
      `Options Scanner backend running on port ${PORT}`
    );

    console.log(
      `Health: http://127.0.0.1:${PORT}/`
    );

    console.log(
      `Robinhood login: http://127.0.0.1:${PORT}/robinhood/connect`
    );

    console.log(
      `Robinhood callback: ${ROBINHOOD_CALLBACK_URL}`
    );

    console.log(
      `Anthropic: ${
        ANTHROPIC_API_KEY
          ? "configured"
          : "not configured"
      }`
    );

    console.log("");
  }
);