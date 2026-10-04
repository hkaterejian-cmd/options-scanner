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

const FORWARD_VALIDATOR_FILE =
  path.join(
    SCANNER_DATA_DIR,
    "forward-validator.json"
  );

const SINGLE_LEG_PRACTICE_FILE =
  path.join(
    SCANNER_DATA_DIR,
    "single-leg-practice.json"
  );

let forwardValidatorScheduler =
  null;

let forwardValidatorTickInProgress =
  false;

let forwardValidatorLastRunAt =
  null;

let forwardValidatorLastError =
  null;

let singleLegPracticeTickInProgress =
  false;

let singleLegPracticeLastRunAt =
  null;

let singleLegPracticeLastError =
  null;

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

function configurableMomentumSignal({
  rsi,
  macdHistogram,
  changePct,
  bullishRsi = 55,
  bearishRsi = 45,
  requiredSignals = 2,
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
      bullishRsi
    ) {
      bullishScore +=
        1;
    }

    if (
      rsi <=
      bearishRsi
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
      requiredSignals &&
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
      requiredSignals &&
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

function scannerMomentumSignal({
  rsi,
  macdHistogram,
  changePct,
}) {
  return configurableMomentumSignal({
    rsi,
    macdHistogram,
    changePct,
    bullishRsi:
      55,
    bearishRsi:
      45,
    requiredSignals:
      2,
  });
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
  directionMode = "both",
  bullishRsi = 55,
  bearishRsi = 45,
  requiredSignals = 2,
  symbol = null,
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
      configurableMomentumSignal({
        rsi,
        macdHistogram,
        changePct,
        bullishRsi,
        bearishRsi,
        requiredSignals,
      });

    if (
      momentum.signal ===
      "neutral"
    ) {
      continue;
    }

    if (
      directionMode ===
        "bullish_only" &&
      momentum.signal !==
        "bullish"
    ) {
      continue;
    }

    if (
      directionMode ===
        "bearish_only" &&
      momentum.signal !==
        "bearish"
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
        (
          symbol ||
          "UNKNOWN"
        ) +
        "|" +
        signalBar.time +
        "|" +
        momentum.signal,

      symbol:
        symbol,

      direction_mode:
        directionMode,

      bullish_rsi:
        bullishRsi,

      bearish_rsi:
        bearishRsi,

      required_signals:
        requiredSignals,

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

function splitTradesByDate({
  trades,
  trainBoundary,
  validationBoundary,
}) {
  const train = [];
  const validation = [];
  const test = [];

  for (const trade of trades) {
    const time =
      Date.parse(
        trade.signal_time ||
        trade.entry_time ||
        0
      );

    if (
      time <
      trainBoundary.getTime()
    ) {
      train.push(
        trade
      );

      continue;
    }

    if (
      time <
      validationBoundary.getTime()
    ) {
      validation.push(
        trade
      );

      continue;
    }

    test.push(
      trade
    );
  }

  return {
    train,
    validation,
    test,
  };
}

function researchCandidateScore(
  summary
) {
  if (
    !summary ||
    summary.trades <
      5 ||
    summary.average_return_pct ===
      null
  ) {
    return null;
  }

  const average =
    summary.average_return_pct;

  const drawdownPenalty =
    Math.abs(
      summary.max_drawdown_pct ??
      0
    ) *
    0.05;

  return (
    average -
    drawdownPenalty
  );
}

function summarizeBySymbol(
  trades,
  symbols
) {
  return symbols.map(
    (symbol) => ({
      symbol,

      summary:
        summarizeBacktestTrades(
          trades.filter(
            (trade) =>
              trade.symbol ===
              symbol
          )
        ),
    })
  );
}


function tradeInDateRange(
  trade,
  start,
  end
) {
  const time =
    Date.parse(
      trade.signal_time ||
      trade.entry_time ||
      0
    );

  return (
    time >=
      start.getTime() &&
    time <
      end.getTime()
  );
}

function buildResearchVariantDefinitions() {
  const holdVariants = [
    1,
    3,
    5,
    10,
    20,
  ];

  const rsiProfiles = [
    {
      label:
        "50/50",

      bullishRsi:
        50,

      bearishRsi:
        50,
    },

    {
      label:
        "55/45",

      bullishRsi:
        55,

      bearishRsi:
        45,
    },

    {
      label:
        "60/40",

      bullishRsi:
        60,

      bearishRsi:
        40,
    },
  ];

  const signalRequirements = [
    2,
    3,
  ];

  const directionModes = [
    "both",
    "bullish_only",
    "bearish_only",
  ];

  const definitions =
    [];

  for (
    const directionMode of directionModes
  ) {
    for (
      const holdDays of holdVariants
    ) {
      for (
        const rsiProfile of rsiProfiles
      ) {
        for (
          const requiredSignals of signalRequirements
        ) {
          definitions.push({
            id:
              directionMode +
              "|" +
              holdDays +
              "|" +
              rsiProfile.label +
              "|" +
              requiredSignals,

            directionMode,
            holdDays,

            rsiProfile:
              rsiProfile.label,

            bullishRsi:
              rsiProfile
                .bullishRsi,

            bearishRsi:
              rsiProfile
                .bearishRsi,

            requiredSignals,
          });
        }
      }
    }
  }

  return definitions;
}

function selectionFrequencyRows(
  selections
) {
  const map =
    new Map();

  for (
    const selection of selections
  ) {
    if (
      !selection
    ) {
      continue;
    }

    const current =
      map.get(
        selection.id
      ) ?? {
        id:
          selection.id,

        parameters:
          selection.parameters,

        count:
          0,
      };

    current.count +=
      1;

    map.set(
      selection.id,
      current
    );
  }

  return [
    ...map.values(),
  ].sort(
    (a, b) =>
      b.count -
        a.count ||
      a.id.localeCompare(
        b.id
      )
  );
}


function buildWalkForwardRobustnessGate({
  completedFolds,
  positiveFolds,
  selectedSummary,
  byTicker,
  selectionFrequency,
}) {
  const completed =
    completedFolds.length;

  const positiveFoldRate =
    completed >
    0
      ? (
          positiveFolds /
          completed
        ) *
        100
      : null;

  const eligibleTickerRows =
    byTicker.filter(
      (row) =>
        (
          row.summary
            ?.trades ??
          0
        ) >=
        5
    );

  const profitableTickerRows =
    eligibleTickerRows.filter(
      (row) =>
        (
          row.summary
            ?.average_return_pct ??
          0
        ) >
        0
    );

  const profitableTickerRate =
    eligibleTickerRows.length >
    0
      ? (
          profitableTickerRows.length /
          eligibleTickerRows.length
        ) *
        100
      : null;

  const totalTickerTrades =
    byTicker.reduce(
      (
        total,
        row
      ) =>
        total +
        (
          row.summary
            ?.trades ??
          0
        ),
      0
    );

  const largestTickerShare =
    totalTickerTrades >
    0
      ? Math.max(
          0,
          ...byTicker.map(
            (row) =>
              (
                (
                  row.summary
                    ?.trades ??
                  0
                ) /
                totalTickerTrades
              ) *
              100
          )
        )
      : null;

  const dominantSelectionCount =
    selectionFrequency[0]
      ?.count ??
    0;

  const dominantSelectionRate =
    completed >
    0
      ? (
          dominantSelectionCount /
          completed
        ) *
        100
      : null;

  const checks = [
    {
      id:
        "oos_trades",

      label:
        "OOS sample size",

      passed:
        (
          selectedSummary
            ?.trades ??
          0
        ) >=
        100,

      actual:
        selectedSummary
          ?.trades ??
        0,

      threshold:
        ">= 100 trades",
    },

    {
      id:
        "positive_folds",

      label:
        "Positive unseen folds",

      passed:
        positiveFoldRate !==
          null &&
        positiveFoldRate >=
          60,

      actual:
        positiveFoldRate,

      threshold:
        ">= 60%",
    },

    {
      id:
        "profit_factor",

      label:
        "OOS profit factor",

      passed:
        (
          selectedSummary
            ?.profit_factor ??
          0
        ) >=
        1.2,

      actual:
        selectedSummary
          ?.profit_factor ??
        null,

      threshold:
        ">= 1.20x",
    },

    {
      id:
        "average_return",

      label:
        "OOS average return",

      passed:
        (
          selectedSummary
            ?.average_return_pct ??
          0
        ) >
        0,

      actual:
        selectedSummary
          ?.average_return_pct ??
        null,

      threshold:
        "> 0%",
    },

    {
      id:
        "drawdown",

      label:
        "OOS max drawdown",

      passed:
        (
          selectedSummary
            ?.max_drawdown_pct ??
          -100
        ) >=
        -40,

      actual:
        selectedSummary
          ?.max_drawdown_pct ??
        null,

      threshold:
        ">= -40%",
    },

    {
      id:
        "ticker_consistency",

      label:
        "Cross-ticker consistency",

      passed:
        profitableTickerRate !==
          null &&
        profitableTickerRate >=
          60,

      actual:
        profitableTickerRate,

      threshold:
        ">= 60% profitable tickers with 5+ OOS trades",
    },

    {
      id:
        "ticker_concentration",

      label:
        "Single-ticker concentration",

      passed:
        largestTickerShare !==
          null &&
        largestTickerShare <=
          30,

      actual:
        largestTickerShare,

      threshold:
        "<= 30% of OOS trades from one ticker",
    },

    {
      id:
        "selection_stability",

      label:
        "Rule-selection stability",

      passed:
        dominantSelectionRate !==
          null &&
        dominantSelectionRate >=
          30,

      actual:
        dominantSelectionRate,

      threshold:
        ">= 30% of folds choose the same rule",
    },
  ];

  const passedCount =
    checks.filter(
      (check) =>
        check.passed
    ).length;

  return {
    status:
      passedCount ===
      checks.length
        ? "pass"
        : "fail",

    passed_count:
      passedCount,

    total_checks:
      checks.length,

    checks,

    metrics: {
      positive_fold_rate:
        positiveFoldRate,

      eligible_ticker_count:
        eligibleTickerRows.length,

      profitable_ticker_count:
        profitableTickerRows.length,

      profitable_ticker_rate:
        profitableTickerRate,

      largest_ticker_trade_share:
        largestTickerShare,

      dominant_selection_rate:
        dominantSelectionRate,
    },

    note:
      "Passing this research gate does not prove future profitability or authorize live trading. It only means the historical proxy met the configured robustness standards.",
  };
}

function walkForwardDatasetToCsv(
  rows
) {
  if (
    !Array.isArray(
      rows
    ) ||
    rows.length ===
      0
  ) {
    return "";
  }

  const headers =
    Object.keys(
      rows[0]
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

  return [
    headers.join(","),

    ...rows.map(
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
}


function buildRiskOverlayDefinitions() {
  const stops = [
    2,
    4,
    6,
    8,
  ];

  const targets = [
    4,
    8,
    12,
    null,
  ];

  const maxHolds = [
    5,
    10,
    20,
  ];

  const riskBudgets = [
    1,
    2,
  ];

  const definitions =
    [];

  for (
    const stopLossPct of stops
  ) {
    for (
      const profitTargetPct of targets
    ) {
      for (
        const maxHoldSessions of maxHolds
      ) {
        for (
          const riskBudgetPct of riskBudgets
        ) {
          definitions.push({
            id:
              "stop" +
              stopLossPct +
              "|target" +
              (
                profitTargetPct ===
                null
                  ? "none"
                  : profitTargetPct
              ) +
              "|hold" +
              maxHoldSessions +
              "|risk" +
              riskBudgetPct,

            stopLossPct,
            profitTargetPct,
            maxHoldSessions,
            riskBudgetPct,
          });
        }
      }
    }
  }

  return definitions;
}

function riskOverlayScore(
  summary
) {
  if (
    !summary ||
    summary.trades <
      5 ||
    summary.average_return_pct ===
      null
  ) {
    return null;
  }

  return (
    summary.average_return_pct -
    Math.abs(
      summary.max_drawdown_pct ??
      0
    ) *
      0.1
  );
}

function findBarIndexByTime(
  bars,
  time
) {
  return bars.findIndex(
    (bar) =>
      bar.time ===
      time
  );
}

function applyRiskOverlayToTrade({
  trade,
  bars,
  overlay,
}) {
  if (
    !trade ||
    !Array.isArray(
      bars
    ) ||
    !bars.length
  ) {
    return null;
  }

  const entryIndex =
    findBarIndexByTime(
      bars,
      trade.entry_time
    );

  if (
    entryIndex <
    0
  ) {
    return null;
  }

  const entryPrice =
    finiteNumber(
      trade.entry_open
    );

  if (
    entryPrice ===
      null ||
    entryPrice <=
      0
  ) {
    return null;
  }

  const direction =
    trade.signal ===
    "bullish"
      ? 1
      : -1;

  const baseHold =
    Math.max(
      1,
      Math.round(
        finiteNumber(
          trade.hold_sessions
        ) ??
        1
      )
    );

  const maxHold =
    Math.max(
      1,
      Math.min(
        baseHold,
        overlay.maxHoldSessions
      )
    );

  const exitIndex =
    Math.min(
      bars.length -
        1,
      entryIndex +
        maxHold -
        1
    );

  const stopPct =
    overlay.stopLossPct;

  const targetPct =
    overlay.profitTargetPct;

  const stopPrice =
    direction >
    0
      ? entryPrice *
        (
          1 -
          stopPct /
            100
        )
      : entryPrice *
        (
          1 +
          stopPct /
            100
        );

  const targetPrice =
    targetPct ===
    null
      ? null
      : direction >
          0
        ? entryPrice *
          (
            1 +
            targetPct /
              100
          )
        : entryPrice *
          (
            1 -
            targetPct /
              100
          );

  let actualExitPrice =
    bars[
      exitIndex
    ]?.close ??
    entryPrice;

  let actualExitTime =
    bars[
      exitIndex
    ]?.time ??
    trade.exit_time;

  let exitReason =
    "time_exit";

  let realizedHoldSessions =
    Math.max(
      1,
      exitIndex -
        entryIndex +
        1
    );

  let maxFavorablePct =
    0;

  let maxAdversePct =
    0;

  for (
    let index =
      entryIndex;
    index <=
    exitIndex;
    index++
  ) {
    const bar =
      bars[
        index
      ];

    const open =
      finiteNumber(
        bar.open
      );

    const high =
      finiteNumber(
        bar.high
      );

    const low =
      finiteNumber(
        bar.low
      );

    if (
      open ===
        null ||
      high ===
        null ||
      low ===
        null
    ) {
      continue;
    }

    const favorablePct =
      direction >
      0
        ? (
            (
              high -
              entryPrice
            ) /
            entryPrice
          ) *
          100
        : (
            (
              entryPrice -
              low
            ) /
            entryPrice
          ) *
          100;

    const adversePct =
      direction >
      0
        ? (
            (
              low -
              entryPrice
            ) /
            entryPrice
          ) *
          100
        : (
            (
              entryPrice -
              high
            ) /
            entryPrice
          ) *
          100;

    maxFavorablePct =
      Math.max(
        maxFavorablePct,
        favorablePct
      );

    maxAdversePct =
      Math.min(
        maxAdversePct,
        adversePct
      );

    const stopGapHit =
      direction >
      0
        ? open <=
          stopPrice
        : open >=
          stopPrice;

    if (
      stopGapHit
    ) {
      actualExitPrice =
        open;

      actualExitTime =
        bar.time;

      exitReason =
        "stop_gap";

      realizedHoldSessions =
        index -
        entryIndex +
        1;

      break;
    }

    const targetGapHit =
      targetPrice !==
        null &&
      (
        direction >
        0
          ? open >=
            targetPrice
          : open <=
            targetPrice
      );

    if (
      targetGapHit
    ) {
      actualExitPrice =
        open;

      actualExitTime =
        bar.time;

      exitReason =
        "profit_target_gap";

      realizedHoldSessions =
        index -
        entryIndex +
        1;

      break;
    }

    const stopTouched =
      direction >
      0
        ? low <=
          stopPrice
        : high >=
          stopPrice;

    const targetTouched =
      targetPrice !==
        null &&
      (
        direction >
        0
          ? high >=
            targetPrice
          : low <=
            targetPrice
      );

    if (
      stopTouched &&
      targetTouched
    ) {
      actualExitPrice =
        stopPrice;

      actualExitTime =
        bar.time;

      exitReason =
        "same_bar_stop_first";

      realizedHoldSessions =
        index -
        entryIndex +
        1;

      break;
    }

    if (
      stopTouched
    ) {
      actualExitPrice =
        stopPrice;

      actualExitTime =
        bar.time;

      exitReason =
        "stop_loss";

      realizedHoldSessions =
        index -
        entryIndex +
        1;

      break;
    }

    if (
      targetTouched
    ) {
      actualExitPrice =
        targetPrice;

      actualExitTime =
        bar.time;

      exitReason =
        "profit_target";

      realizedHoldSessions =
        index -
        entryIndex +
        1;

      break;
    }
  }

  const rawGrossReturnPct =
    direction *
    (
      (
        actualExitPrice -
        entryPrice
      ) /
      entryPrice
    ) *
    100;

  const frictionPct =
    finiteNumber(
      trade.friction_pct
    ) ??
    0;

  const rawNetReturnPct =
    rawGrossReturnPct -
    frictionPct;

  const allocationFraction =
    Math.min(
      1,
      overlay.riskBudgetPct /
        overlay.stopLossPct
    );

  const portfolioReturnPct =
    rawNetReturnPct *
    allocationFraction;

  return {
    ...trade,

    original_exit_time:
      trade.exit_time,

    original_exit_close:
      trade.exit_close,

    original_net_return_pct:
      trade.net_return_pct,

    risk_overlay_id:
      overlay.id,

    stop_loss_pct:
      overlay.stopLossPct,

    profit_target_pct:
      overlay.profitTargetPct,

    risk_budget_pct:
      overlay.riskBudgetPct,

    allocation_fraction:
      allocationFraction,

    max_hold_sessions:
      maxHold,

    exit_time:
      actualExitTime,

    exit_close:
      actualExitPrice,

    hold_sessions:
      realizedHoldSessions,

    exit_reason:
      exitReason,

    gross_return_pct:
      rawGrossReturnPct,

    net_return_pct:
      portfolioReturnPct,

    raw_net_return_pct:
      rawNetReturnPct,

    mfe_pct:
      maxFavorablePct *
      allocationFraction,

    mae_pct:
      maxAdversePct *
      allocationFraction,
  };
}

function applyRiskOverlayToTrades({
  trades,
  marketData,
  overlay,
}) {
  return trades
    .map(
      (trade) =>
        applyRiskOverlayToTrade({
          trade,
          bars:
            marketData[
              trade.symbol
            ]?.bars ??
            [],
          overlay,
        })
    )
    .filter(
      Boolean
    )
    .sort(
      (a, b) =>
        Date.parse(
          a.exit_time
        ) -
        Date.parse(
          b.exit_time
        )
    );
}


function utcDateKey(
  value
) {
  const date =
    value instanceof Date
      ? value
      : new Date(
          value
        );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date
    .toISOString()
    .slice(
      0,
      10
    );
}

function addUtcDays(
  value,
  days
) {
  const date =
    value instanceof Date
      ? new Date(
          value.getTime()
        )
      : new Date(
          value
        );

  date.setUTCDate(
    date.getUTCDate() +
      days
  );

  return date;
}

function nextFridayOnOrAfter(
  value
) {
  const date =
    value instanceof Date
      ? new Date(
          value.getTime()
        )
      : new Date(
          value
        );

  date.setUTCHours(
    0,
    0,
    0,
    0
  );

  const day =
    date.getUTCDay();

  const delta =
    (
      5 -
      day +
      7
    ) %
    7;

  return addUtcDays(
    date,
    delta
  );
}

function extractOptionHistoricalResults(
  payload
) {
  const data =
    payload?.data ??
    payload ??
    {};

  return Array.isArray(
    data?.results
  )
    ? data.results
    : [];
}

function normalizeOptionBars(
  result
) {
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

        date:
          utcDateKey(
            bar.begins_at
          ),

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
      })
    )
    .filter(
      (bar) =>
        bar.date &&
        bar.open !==
          null &&
        bar.close !==
          null
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

async function loadExpiredOptionInstruments({
  symbol,
  expiration,
  type,
  maxPages = 8,
}) {
  const instruments =
    [];

  let cursor =
    null;

  for (
    let page =
      0;
    page <
    maxPages;
    page++
  ) {
    const result =
      await callRobinhoodTool(
        "get_option_instruments",
        {
          chain_symbol:
            symbol,

          expiration_dates:
            expiration,

          state:
            "expired",

          type,

          ...(cursor
            ? {
                cursor,
              }
            : {}),
        }
      );

    const payload =
      unwrapRobinhoodToolResult(
        result
      );

    const data =
      payload?.data ??
      payload ??
      {};

    const pageInstruments =
      Array.isArray(
        data?.instruments
      )
        ? data.instruments
        : [];

    instruments.push(
      ...pageInstruments
    );

    cursor =
      data?.next ??
      null;

    if (!cursor) {
      break;
    }
  }

  return instruments;
}

function chooseHistoricalVertical({
  instruments,
  type,
  spot,
  shortDistancePct,
}) {
  const usable =
    instruments
      .map(
        (instrument) => ({
          ...instrument,

          strike:
            finiteNumber(
              instrument
                .strike_price
            ),
        })
      )
      .filter(
        (instrument) =>
          instrument.strike !==
            null &&
          instrument.type ===
            type
      )
      .sort(
        (a, b) =>
          a.strike -
          b.strike
      );

  if (
    usable.length <
    2
  ) {
    return null;
  }

  const long =
    usable.reduce(
      (
        best,
        item
      ) =>
        Math.abs(
          item.strike -
          spot
        ) <
        Math.abs(
          best.strike -
          spot
        )
          ? item
          : best,
      usable[0]
    );

  const targetShort =
    type ===
    "call"
      ? spot *
        (
          1 +
          shortDistancePct /
            100
        )
      : spot *
        (
          1 -
          shortDistancePct /
            100
        );

  const candidates =
    usable.filter(
      (item) =>
        type ===
        "call"
          ? item.strike >
            long.strike
          : item.strike <
            long.strike
    );

  if (
    !candidates.length
  ) {
    return null;
  }

  const short =
    candidates.reduce(
      (
        best,
        item
      ) =>
        Math.abs(
          item.strike -
          targetShort
        ) <
        Math.abs(
          best.strike -
          targetShort
        )
          ? item
          : best,
      candidates[0]
    );

  const width =
    Math.abs(
      short.strike -
      long.strike
    );

  if (
    width <=
    0
  ) {
    return null;
  }

  return {
    long,
    short,
    width,
  };
}

function summarizeOptionReplay(
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
        trade.pnl_dollars >
        0
    );

  const losses =
    usable.filter(
      (trade) =>
        trade.pnl_dollars <
        0
    );

  const grossProfit =
    wins.reduce(
      (
        total,
        trade
      ) =>
        total +
        trade.pnl_dollars,
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
          trade.pnl_dollars,
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
    const trade of usable
  ) {
    cumulative +=
      trade.pnl_dollars;

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
    trades:
      usable.length,

    wins:
      wins.length,

    losses:
      losses.length,

    win_rate_pct:
      usable.length
        ? (
            wins.length /
            usable.length
          ) *
          100
        : null,

    total_pnl_dollars:
      cumulative,

    average_pnl_dollars:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.pnl_dollars
        )
      ),

    average_return_on_debit_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.return_on_debit_pct
        )
      ),

    profit_factor:
      grossLoss >
      0
        ? grossProfit /
          grossLoss
        : null,

    max_drawdown_dollars:
      maxDrawdown,

    average_entry_debit:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.entry_debit
        )
      ),

    average_dte:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.entry_dte
        )
      ),

    average_close_path_mfe_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.close_path_mfe_pct
        )
      ),

    average_close_path_mae_pct:
      averageNumbers(
        usable.map(
          (trade) =>
            trade.close_path_mae_pct
        )
      ),
  };
}


function optionReplayResearchScore(
  summary
) {
  if (
    !summary ||
    summary.trades <
      4 ||
    summary.average_return_on_debit_pct ===
      null
  ) {
    return null;
  }

  const returnScore =
    summary.average_return_on_debit_pct;

  const maePenalty =
    Math.abs(
      summary.average_close_path_mae_pct ??
      0
    ) *
    0.1;

  return (
    returnScore -
    maePenalty
  );
}

function optionReplayVariantKey({
  holdDays,
  targetDte,
  shortDistancePct,
}) {
  return (
    holdDays +
    "|" +
    targetDte +
    "|" +
    shortDistancePct
  );
}

function splitReplayRowsByDate({
  rows,
  trainBoundary,
  validationBoundary,
}) {
  const train = [];
  const validation = [];
  const test = [];

  for (const row of rows) {
    const time =
      Date.parse(
        row.signal_time ||
        row.entry_time ||
        0
      );

    if (
      time <
      trainBoundary.getTime()
    ) {
      train.push(
        row
      );

      continue;
    }

    if (
      time <
      validationBoundary.getTime()
    ) {
      validation.push(
        row
      );

      continue;
    }

    test.push(
      row
    );
  }

  return {
    train,
    validation,
    test,
  };
}


function sampleEvenly(
  rows,
  maxCount
) {
  if (
    !Array.isArray(
      rows
    ) ||
    rows.length <=
      maxCount
  ) {
    return rows;
  }

  if (
    maxCount <=
    1
  ) {
    return [
      rows[
        rows.length -
        1
      ],
    ];
  }

  const sampled =
    [];

  const lastIndex =
    rows.length -
    1;

  for (
    let index =
      0;
    index <
    maxCount;
    index++
  ) {
    const position =
      Math.round(
        (
          index /
          (
            maxCount -
            1
          )
        ) *
        lastIndex
      );

    sampled.push(
      rows[
        position
      ]
    );
  }

  return sampled;
}

async function buildOptionReplayRows({
  symbol,
  lookbackDays,
  maxSignalsPerHold,
  holdVariants,
  targetDteVariants,
  shortDistanceVariants,
}) {
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

  const bars =
    extractBacktestBars(
      unwrapRobinhoodToolResult(
        historicalResult
      )
    );

  const rsiSeries =
    extractBacktestIndicator(
      unwrapRobinhoodToolResult(
        rsiResult
      ),
      "rsi"
    );

  const macdSeries =
    extractBacktestIndicator(
      unwrapRobinhoodToolResult(
        macdResult
      ),
      "macd"
    );

  const signalsByHold =
    new Map();

  for (
    const holdDays of holdVariants
  ) {
    const rawSignals =
      runDirectionalBacktest({
        bars,
        rsiSeries,
        macdSeries,
        requestedStart,
        holdDays,
        costBps:
          0,
        nonOverlapping:
          true,
        directionMode:
          "both",
        bullishRsi:
          55,
        bearishRsi:
          45,
        requiredSignals:
          2,
        symbol,
      })
        .filter(
          (trade) =>
            Date.parse(
              trade.exit_time
            ) <
            end.getTime()
        );

    signalsByHold.set(
      holdDays,
      sampleEvenly(
        rawSignals,
        maxSignalsPerHold
      )
    );
  }

  const instrumentCache =
    new Map();

  const verticalCache =
    new Map();

  const specs =
    [];

  const setupSkips =
    [];

  async function resolveVertical({
    signal,
    targetDte,
    shortDistancePct,
  }) {
    const type =
      signal.signal ===
      "bullish"
        ? "call"
        : "put";

    const entryDate =
      new Date(
        signal.entry_time
      );

    const entryKey =
      utcDateKey(
        entryDate
      );

    const verticalKey =
      [
        entryKey,
        type,
        targetDte,
        shortDistancePct,
      ].join(
        "|"
      );

    if (
      verticalCache.has(
        verticalKey
      )
    ) {
      return verticalCache.get(
        verticalKey
      );
    }

    const desiredExpiration =
      nextFridayOnOrAfter(
        addUtcDays(
          entryDate,
          targetDte
        )
      );

    let resolved =
      null;

    for (
      let attempt =
        0;
      attempt <
      4;
      attempt++
    ) {
      const expirationDate =
        addUtcDays(
          desiredExpiration,
          attempt *
            7
        );

      if (
        expirationDate.getTime() >=
        end.getTime()
      ) {
        continue;
      }

      const expiration =
        utcDateKey(
          expirationDate
        );

      const cacheKey =
        symbol +
        "|" +
        expiration +
        "|" +
        type;

      let instruments =
        instrumentCache.get(
          cacheKey
        );

      if (!instruments) {
        instruments =
          await loadExpiredOptionInstruments({
            symbol,
            expiration,
            type,
          });

        instrumentCache.set(
          cacheKey,
          instruments
        );
      }

      const vertical =
        chooseHistoricalVertical({
          instruments,
          type,
          spot:
            signal.entry_open,
          shortDistancePct,
        });

      if (!vertical) {
        continue;
      }

      resolved = {
        type,
        expiration,
        vertical,
      };

      break;
    }

    verticalCache.set(
      verticalKey,
      resolved
    );

    return resolved;
  }

  for (
    const holdDays of holdVariants
  ) {
    const signals =
      signalsByHold.get(
        holdDays
      ) ??
      [];

    for (
      const signal of signals
    ) {
      for (
        const targetDte of targetDteVariants
      ) {
        for (
          const shortDistancePct of shortDistanceVariants
        ) {
          const resolved =
            await resolveVertical({
              signal,
              targetDte,
              shortDistancePct,
            });

          if (!resolved) {
            setupSkips.push({
              hold_days:
                holdDays,

              target_dte:
                targetDte,

              short_distance_pct:
                shortDistancePct,

              signal_time:
                signal.signal_time,

              entry_time:
                signal.entry_time,

              signal:
                signal.signal,

              reason:
                "No usable expired vertical could be constructed.",
            });

            continue;
          }

          specs.push({
            signal,
            holdDays,
            targetDte,
            shortDistancePct,
            type:
              resolved.type,
            expiration:
              resolved.expiration,
            vertical:
              resolved.vertical,
          });
        }
      }
    }
  }

  const optionIds =
    [
      ...new Set(
        specs.flatMap(
          (spec) => [
            spec.vertical
              .long
              .id,
            spec.vertical
              .short
              .id,
          ]
        )
      ),
    ];

  const optionHistoryById =
    new Map();

  for (
    let index =
      0;
    index <
    optionIds.length;
    index +=
      10
  ) {
    const batch =
      optionIds.slice(
        index,
        index +
          10
      );

    const historical =
      await callRobinhoodTool(
        "get_option_historicals",
        {
          instrument_ids:
            batch,

          start_time:
            fetchStart.toISOString(),

          end_time:
            end.toISOString(),

          interval:
            "day",

          bounds:
            "regular",
        }
      );

    const payload =
      unwrapRobinhoodToolResult(
        historical
      );

    const results =
      extractOptionHistoricalResults(
        payload
      );

    for (
      const result of results
    ) {
      optionHistoryById.set(
        result.instrument_id,
        normalizeOptionBars(
          result
        )
      );
    }
  }

  const rowsByVariant =
    new Map();

  const replaySkips =
    [];

  for (
    const spec of specs
  ) {
    const {
      signal,
      holdDays,
      targetDte,
      shortDistancePct,
      type,
      expiration,
      vertical,
    } = spec;

    const longBars =
      optionHistoryById.get(
        vertical.long.id
      ) ??
      [];

    const shortBars =
      optionHistoryById.get(
        vertical.short.id
      ) ??
      [];

    const entryKey =
      utcDateKey(
        signal.entry_time
      );

    const exitKey =
      utcDateKey(
        signal.exit_time
      );

    const longEntry =
      longBars.find(
        (bar) =>
          bar.date ===
          entryKey
      );

    const shortEntry =
      shortBars.find(
        (bar) =>
          bar.date ===
          entryKey
      );

    const longExit =
      longBars.find(
        (bar) =>
          bar.date ===
          exitKey
      );

    const shortExit =
      shortBars.find(
        (bar) =>
          bar.date ===
          exitKey
      );

    if (
      !longEntry ||
      !shortEntry ||
      !longExit ||
      !shortExit
    ) {
      replaySkips.push({
        hold_days:
          holdDays,

        target_dte:
          targetDte,

        short_distance_pct:
          shortDistancePct,

        signal_time:
          signal.signal_time,

        entry_time:
          signal.entry_time,

        expiration,

        reason:
          "Missing exact historical option bar on entry or exit date.",
      });

      continue;
    }

    const entryDebit =
      longEntry.open -
      shortEntry.open;

    if (
      entryDebit <=
        0 ||
      entryDebit >=
        vertical.width
    ) {
      replaySkips.push({
        hold_days:
          holdDays,

        target_dte:
          targetDte,

        short_distance_pct:
          shortDistancePct,

        signal_time:
          signal.signal_time,

        entry_time:
          signal.entry_time,

        expiration,

        reason:
          "Historical leg trade prices produced an invalid debit.",
      });

      continue;
    }

    const exitValue =
      Math.max(
        0,
        Math.min(
          vertical.width,
          longExit.close -
          shortExit.close
        )
      );

    const pnlDollars =
      (
        exitValue -
        entryDebit
      ) *
      100;

    const returnPct =
      (
        (
          exitValue -
          entryDebit
        ) /
        entryDebit
      ) *
      100;

    const shortByDate =
      new Map(
        shortBars.map(
          (bar) => [
            bar.date,
            bar,
          ]
        )
      );

    const closeReturns =
      longBars
        .filter(
          (bar) =>
            bar.date >=
              entryKey &&
            bar.date <=
              exitKey &&
            shortByDate.has(
              bar.date
            )
        )
        .map(
          (bar) => {
            const shortBar =
              shortByDate.get(
                bar.date
              );

            const value =
              Math.max(
                0,
                Math.min(
                  vertical.width,
                  bar.close -
                  shortBar.close
                )
              );

            return (
              (
                value -
                entryDebit
              ) /
              entryDebit
            ) *
              100;
          }
        );

    const dte =
      Math.round(
        (
          Date.parse(
            expiration +
            "T00:00:00Z"
          ) -
          Date.parse(
            signal.entry_time
          )
        ) /
          (
            24 *
            60 *
            60 *
            1000
          )
      );

    const row = {
      id:
        [
          signal.signal_time,
          holdDays,
          targetDte,
          shortDistancePct,
          type,
        ].join(
          "|"
        ),

      symbol,

      signal:
        signal.signal,

      signal_time:
        signal.signal_time,

      entry_time:
        signal.entry_time,

      exit_time:
        signal.exit_time,

      rsi:
        signal.rsi,

      macd_histogram:
        signal.macd_histogram,

      signal_change_pct:
        signal.signal_change_pct,

      hold_sessions:
        holdDays,

      target_dte:
        targetDte,

      short_distance_pct:
        shortDistancePct,

      option_type:
        type,

      expiration,

      entry_dte:
        dte,

      long_strike:
        vertical.long.strike,

      short_strike:
        vertical.short.strike,

      spread_width:
        vertical.width,

      entry_debit:
        entryDebit,

      exit_spread_value:
        exitValue,

      pnl_dollars:
        pnlDollars,

      return_on_debit_pct:
        returnPct,

      close_path_mfe_pct:
        closeReturns.length
          ? Math.max(
              ...closeReturns
            )
          : null,

      close_path_mae_pct:
        closeReturns.length
          ? Math.min(
              ...closeReturns
            )
          : null,
    };

    const variantKey =
      optionReplayVariantKey({
        holdDays,
        targetDte,
        shortDistancePct,
      });

    if (
      !rowsByVariant.has(
        variantKey
      )
    ) {
      rowsByVariant.set(
        variantKey,
        []
      );
    }

    rowsByVariant.get(
      variantKey
    ).push(
      row
    );
  }

  for (
    const rows of rowsByVariant.values()
  ) {
    rows.sort(
      (a, b) =>
        Date.parse(
          a.exit_time
        ) -
        Date.parse(
          b.exit_time
        )
    );
  }

  return {
    symbol,
    end,
    requestedStart,
    fetchStart,
    rowsByVariant,

    coverage: {
      unique_option_contracts:
        optionIds.length,

      replay_rows:
        [
          ...rowsByVariant.values(),
        ].reduce(
          (
            total,
            rows
          ) =>
            total +
            rows.length,
          0
        ),

      setup_skips:
        setupSkips.length,

      replay_skips:
        replaySkips.length,

      sampled_signal_counts:
        Object.fromEntries(
          [
            ...signalsByHold.entries(),
          ].map(
            ([
              hold,
              signals,
            ]) => [
              hold,
              signals.length,
            ]
          )
        ),
    },

    skipExamples: [
      ...setupSkips,
      ...replaySkips,
    ].slice(
      0,
      40
    ),
  };
}


function buildOptionCoverageDetail({
  rowsByVariant,
  coverage,
}) {
  const allRows =
    [
      ...rowsByVariant.values(),
    ].flat();

  const signalMap =
    new Map();

  for (
    const row of allRows
  ) {
    const key =
      row.signal_time +
      "|" +
      row.signal;

    if (
      !signalMap.has(
        key
      )
    ) {
      signalMap.set(
        key,
        row
      );
    }
  }

  const signalRows =
    [
      ...signalMap.values(),
    ].sort(
      (a, b) =>
        Date.parse(
          a.signal_time
        ) -
        Date.parse(
          b.signal_time
        )
    );

  const coverageDates =
    [
      ...new Set(
        signalRows
          .map(
            (row) =>
              utcDateKey(
                row.signal_time
              )
          )
          .filter(
            Boolean
          )
      ),
    ].sort();

  const monthlyMap =
    new Map();

  for (
    const date of coverageDates
  ) {
    const month =
      date.slice(
        0,
        7
      );

    monthlyMap.set(
      month,
      (
        monthlyMap.get(
          month
        ) ??
        0
      ) +
        1
    );
  }

  const replayMonthlyMap =
    new Map();

  for (
    const row of allRows
  ) {
    const date =
      utcDateKey(
        row.signal_time
      );

    if (!date) {
      continue;
    }

    const month =
      date.slice(
        0,
        7
      );

    replayMonthlyMap.set(
      month,
      (
        replayMonthlyMap.get(
          month
        ) ??
        0
      ) +
        1
    );
  }

  const holdMap =
    new Map();

  const dteBuckets = {
    "7-9":
      0,

    "10-14":
      0,

    "15-21":
      0,

    "22+":
      0,
  };

  for (
    const row of allRows
  ) {
    const hold =
      String(
        row.hold_sessions ??
        "unknown"
      );

    holdMap.set(
      hold,
      (
        holdMap.get(
          hold
        ) ??
        0
      ) +
        1
    );

    const dte =
      finiteNumber(
        row.entry_dte
      );

    if (
      dte ===
      null
    ) {
      continue;
    }

    if (
      dte <=
      9
    ) {
      dteBuckets[
        "7-9"
      ] +=
        1;

    } else if (
      dte <=
      14
    ) {
      dteBuckets[
        "10-14"
      ] +=
        1;

    } else if (
      dte <=
      21
    ) {
      dteBuckets[
        "15-21"
      ] +=
        1;

    } else {
      dteBuckets[
        "22+"
      ] +=
        1;
    }
  }

  const attemptedReplays =
    (
      coverage
        ?.replay_rows ??
      0
    ) +
    (
      coverage
        ?.replay_skips ??
      0
    );

  const missingBarRate =
    attemptedReplays >
    0
      ? (
          (
            coverage
              ?.replay_skips ??
            0
          ) /
          attemptedReplays
        ) *
        100
      : null;

  const earliest =
    coverageDates[0] ??
    null;

  const latest =
    coverageDates[
      coverageDates.length -
      1
    ] ??
    null;

  const coverageDays =
    earliest &&
    latest
      ? Math.round(
          (
            Date.parse(
              latest
            ) -
            Date.parse(
              earliest
            )
          ) /
            (
              24 *
              60 *
              60 *
              1000
            )
        )
      : null;

  return {
    earliest_replayable_date:
      earliest,

    latest_replayable_date:
      latest,

    coverage_days:
      coverageDays,

    unique_signal_dates:
      coverageDates.length,

    bullish_signal_dates:
      signalRows.filter(
        (row) =>
          row.signal ===
          "bullish"
      ).length,

    bearish_signal_dates:
      signalRows.filter(
        (row) =>
          row.signal ===
          "bearish"
      ).length,

    missing_bar_rate_pct:
      missingBarRate,

    monthly_signal_dates:
      [
        ...monthlyMap.entries(),
      ].map(
        ([
          month,
          count,
        ]) => ({
          month,
          count,
        })
      ),

    monthly_replay_rows:
      [
        ...replayMonthlyMap.entries(),
      ].map(
        ([
          month,
          count,
        ]) => ({
          month,
          count,
        })
      ),

    replay_rows_by_hold:
      [
        ...holdMap.entries(),
      ]
        .map(
          ([
            hold,
            count,
          ]) => ({
            hold_sessions:
              Number(
                hold
              ),

            count,
          })
        )
        .sort(
          (a, b) =>
            a.hold_sessions -
            b.hold_sessions
        ),

    replay_rows_by_dte_bucket:
      Object.entries(
        dteBuckets
      ).map(
        ([
          bucket,
          count,
        ]) => ({
          bucket,
          count,
        })
      ),

    coverage_dates:
      coverageDates,
  };
}


function stressOptionReplayTrade({
  trade,
  roundTripFrictionCents,
  feePerContractPerLeg,
}) {
  const totalFrictionPoints =
    Math.max(
      0,
      Number(
        roundTripFrictionCents
      ) ||
      0
    ) /
    100;

  const entryFrictionPoints =
    totalFrictionPoints /
    2;

  const exitFrictionPoints =
    totalFrictionPoints /
    2;

  const stressedEntryDebit =
    Math.max(
      0,
      (
        finiteNumber(
          trade.entry_debit
        ) ??
        0
      ) +
      entryFrictionPoints
    );

  const stressedExitValue =
    Math.max(
      0,
      (
        finiteNumber(
          trade.exit_spread_value
        ) ??
        0
      ) -
      exitFrictionPoints
    );

  const feePerLeg =
    Math.max(
      0,
      Number(
        feePerContractPerLeg
      ) ||
      0
    );

  const totalFees =
    feePerLeg *
    4;

  const pnlDollars =
    (
      stressedExitValue -
      stressedEntryDebit
    ) *
      100 -
    totalFees;

  const returnOnDebitPct =
    stressedEntryDebit >
    0
      ? (
          pnlDollars /
          (
            stressedEntryDebit *
            100
          )
        ) *
        100
      : null;

  return {
    ...trade,

    round_trip_friction_cents:
      totalFrictionPoints *
      100,

    entry_friction_points:
      entryFrictionPoints,

    exit_friction_points:
      exitFrictionPoints,

    fee_per_contract_per_leg:
      feePerLeg,

    estimated_total_fees:
      totalFees,

    stressed_entry_debit:
      stressedEntryDebit,

    stressed_exit_value:
      stressedExitValue,

    pnl_dollars:
      pnlDollars,

    return_on_debit_pct:
      returnOnDebitPct,

    favorable:
      pnlDollars >
      0,
  };
}

function summarizeExecutionStress(
  trades
) {
  return summarizeOptionReplay(
    trades
  );
}

function buildExecutionStressScenario({
  rows,
  roundTripFrictionCents,
  feePerContractPerLeg,
}) {
  const stressedRows =
    rows.map(
      (trade) =>
        stressOptionReplayTrade({
          trade,
          roundTripFrictionCents,
          feePerContractPerLeg,
        })
    );

  return {
    round_trip_friction_cents:
      roundTripFrictionCents,

    fee_per_contract_per_leg:
      feePerContractPerLeg,

    summary:
      summarizeExecutionStress(
        stressedRows
      ),

    trades:
      stressedRows,
  };
}


/*
  =========================================================
  FORWARD PAPER VALIDATOR
  =========================================================

  Paper-only. No Robinhood order tools are exposed.
*/

function defaultForwardValidatorState() {
  return {
    version: 1,

    settings: {
      enabled:
        false,

      symbol:
        "PLTR",

      holdSessions:
        5,

      targetDte:
        9,

      shortDistancePct:
        4,

      fillModel:
        "quarter_spread",

      feePerContractPerLeg:
        0,

      tickSeconds:
        60,
    },

    lastEvaluatedAt:
      null,

    lastSignalKey:
      null,

    lastSnapshot:
      null,

    trades: [],
  };
}

function normalizeForwardValidatorState(
  input
) {
  const base =
    defaultForwardValidatorState();

  const value =
    input &&
    typeof input ===
      "object" &&
    !Array.isArray(
      input
    )
      ? input
      : {};

  const settings =
    value.settings &&
    typeof value.settings ===
      "object" &&
    !Array.isArray(
      value.settings
    )
      ? value.settings
      : {};

  return {
    version: 1,

    settings: {
      enabled:
        !!settings.enabled,

      symbol:
        normalizeTicker(
          settings.symbol ||
          base.settings.symbol
        ),

      holdSessions:
        Math.max(
          1,
          Math.min(
            20,
            Math.round(
              Number(
                settings.holdSessions ??
                base.settings.holdSessions
              ) ||
              base.settings.holdSessions
            )
          )
        ),

      targetDte:
        Math.max(
          5,
          Math.min(
            30,
            Math.round(
              Number(
                settings.targetDte ??
                base.settings.targetDte
              ) ||
              base.settings.targetDte
            )
          )
        ),

      shortDistancePct:
        Math.max(
          1,
          Math.min(
            15,
            Number(
              settings.shortDistancePct ??
              base.settings.shortDistancePct
            ) ||
            base.settings.shortDistancePct
          )
        ),

      fillModel:
        [
          "midpoint",
          "quarter_spread",
          "conservative",
        ].includes(
          settings.fillModel
        )
          ? settings.fillModel
          : base.settings.fillModel,

      feePerContractPerLeg:
        Math.max(
          0,
          Number(
            settings.feePerContractPerLeg ??
            base.settings.feePerContractPerLeg
          ) ||
          0
        ),

      tickSeconds:
        Math.max(
          30,
          Math.min(
            300,
            Math.round(
              Number(
                settings.tickSeconds ??
                base.settings.tickSeconds
              ) ||
              base.settings.tickSeconds
            )
          )
        ),
    },

    lastEvaluatedAt:
      value.lastEvaluatedAt ||
      null,

    lastSignalKey:
      value.lastSignalKey ||
      null,

    lastSnapshot:
      value.lastSnapshot &&
      typeof value.lastSnapshot ===
        "object"
        ? value.lastSnapshot
        : null,

    trades:
      Array.isArray(
        value.trades
      )
        ? value.trades.filter(
            (trade) =>
              trade &&
              typeof trade ===
                "object" &&
              !Array.isArray(
                trade
              )
          )
        : [],
  };
}

async function readForwardValidatorState() {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  try {
    const raw =
      await fs.readFile(
        FORWARD_VALIDATOR_FILE,
        "utf8"
      );

    return normalizeForwardValidatorState(
      JSON.parse(
        raw
      )
    );

  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return defaultForwardValidatorState();
    }

    throw error;
  }
}

async function writeForwardValidatorState(
  state
) {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  const normalized =
    normalizeForwardValidatorState(
      state
    );

  await fs.writeFile(
    FORWARD_VALIDATOR_FILE,
    JSON.stringify(
      normalized,
      null,
      2
    ),
    "utf8"
  );

  return normalized;
}

function easternClockParts(
  date = new Date()
) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "America/New_York",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        weekday:
          "short",

        hour:
          "2-digit",

        minute:
          "2-digit",

        hourCycle:
          "h23",
      }
    );

  const parts =
    Object.fromEntries(
      formatter
        .formatToParts(
          date
        )
        .filter(
          (part) =>
            part.type !==
            "literal"
        )
        .map(
          (part) => [
            part.type,
            part.value,
          ]
        )
    );

  const hour =
    Number(
      parts.hour
    );

  const minute =
    Number(
      parts.minute
    );

  const minutes =
    hour *
      60 +
    minute;

  const weekday =
    parts.weekday;

  const isWeekday =
    ![
      "Sat",
      "Sun",
    ].includes(
      weekday
    );

  return {
    date:
      parts.year +
      "-" +
      parts.month +
      "-" +
      parts.day,

    weekday,

    minutes,

    regularOpen:
      isWeekday &&
      minutes >=
        9 *
          60 +
        30 &&
      minutes <
        16 *
          60,

    nearClose:
      isWeekday &&
      minutes >=
        15 *
          60 +
        55,

    afterClose:
      isWeekday &&
      minutes >=
        16 *
          60 +
        5,
  };
}

function optionQuoteMapFromPayload(
  payload
) {
  const data =
    payload?.data ??
    payload ??
    {};

  const results =
    Array.isArray(
      data?.results
    )
      ? data.results
      : [];

  const map =
    new Map();

  for (
    const item of results
  ) {
    const quote =
      item?.quote ??
      item;

    const id =
      quote?.instrument_id ??
      item?.instrument_id;

    if (id) {
      map.set(
        id,
        quote
      );
    }
  }

  return map;
}

function optionLegSnapshot(
  quote
) {
  if (!quote) {
    return null;
  }

  const bid =
    finiteNumber(
      quote.bid_price
    );

  const ask =
    finiteNumber(
      quote.ask_price
    );

  const mark =
    finiteNumber(
      quote.mark_price
    ) ??
    (
      bid !==
        null &&
      ask !==
        null
        ? (
            bid +
            ask
          ) /
          2
        : null
    );

  return {
    bid,
    ask,
    mark,

    iv:
      finiteNumber(
        quote.implied_volatility
      ),

    delta:
      finiteNumber(
        quote.delta
      ),

    gamma:
      finiteNumber(
        quote.gamma
      ),

    theta:
      finiteNumber(
        quote.theta
      ),

    vega:
      finiteNumber(
        quote.vega
      ),

    volume:
      finiteNumber(
        quote.volume
      ) ??
      0,

    openInterest:
      finiteNumber(
        quote.open_interest
      ) ??
      0,

    updatedAt:
      quote.updated_at ??
      null,
  };
}

function clampSpreadValue(
  value,
  width
) {
  const number =
    finiteNumber(
      value
    );

  if (
    number ===
    null
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.min(
      width,
      number
    )
  );
}

function verticalQuoteSnapshot({
  longQuote,
  shortQuote,
  width,
}) {
  const long =
    optionLegSnapshot(
      longQuote
    );

  const short =
    optionLegSnapshot(
      shortQuote
    );

  if (
    !long ||
    !short
  ) {
    return null;
  }

  const midpoint =
    long.mark !==
      null &&
    short.mark !==
      null
      ? clampSpreadValue(
          long.mark -
          short.mark,
          width
        )
      : null;

  const ask =
    long.ask !==
      null &&
    short.bid !==
      null
      ? clampSpreadValue(
          long.ask -
          short.bid,
          width
        )
      : null;

  const bid =
    long.bid !==
      null &&
    short.ask !==
      null
      ? clampSpreadValue(
          long.bid -
          short.ask,
          width
        )
      : null;

  return {
    long,
    short,
    midpoint,
    bid,
    ask,
  };
}

function simulateVerticalFill({
  quote,
  side,
  model,
}) {
  if (!quote) {
    return null;
  }

  const midpoint =
    finiteNumber(
      quote.midpoint
    );

  if (
    midpoint ===
    null
  ) {
    return null;
  }

  if (
    model ===
    "midpoint"
  ) {
    return midpoint;
  }

  if (
    side ===
    "entry"
  ) {
    const ask =
      finiteNumber(
        quote.ask
      );

    if (
      ask ===
      null
    ) {
      return midpoint;
    }

    if (
      model ===
      "conservative"
    ) {
      return ask;
    }

    return (
      midpoint +
      (
        ask -
        midpoint
      ) *
        0.25
    );
  }

  const bid =
    finiteNumber(
      quote.bid
    );

  if (
    bid ===
    null
  ) {
    return midpoint;
  }

  if (
    model ===
    "conservative"
  ) {
    return bid;
  }

  return (
    midpoint -
    (
      midpoint -
      bid
    ) *
      0.25
  );
}

async function loadActiveOptionInstruments({
  symbol,
  expiration,
  type,
  maxPages = 8,
}) {
  const instruments =
    [];

  let cursor =
    null;

  for (
    let page =
      0;
    page <
    maxPages;
    page++
  ) {
    const result =
      await callRobinhoodTool(
        "get_option_instruments",
        {
          chain_symbol:
            symbol,

          expiration_dates:
            expiration,

          state:
            "active",

          type,

          ...(cursor
            ? {
                cursor,
              }
            : {}),
        }
      );

    const payload =
      unwrapRobinhoodToolResult(
        result
      );

    const data =
      payload?.data ??
      payload ??
      {};

    const pageInstruments =
      Array.isArray(
        data?.instruments
      )
        ? data.instruments
        : [];

    instruments.push(
      ...pageInstruments
    );

    cursor =
      data?.next ??
      null;

    if (!cursor) {
      break;
    }
  }

  return instruments;
}

function activeExpirationDates(
  payload
) {
  const data =
    payload?.data ??
    payload ??
    {};

  const chains =
    Array.isArray(
      data?.chains
    )
      ? data.chains
      : [];

  return [
    ...new Set(
      chains.flatMap(
        (chain) =>
          Array.isArray(
            chain?.expiration_dates
          )
            ? chain.expiration_dates
            : []
      )
    ),
  ].sort();
}

function chooseTargetExpiration({
  dates,
  now,
  targetDte,
}) {
  const current =
    new Date(
      now
    );

  current.setUTCHours(
    0,
    0,
    0,
    0
  );

  return dates.find(
    (dateText) => {
      const expiration =
        new Date(
          dateText +
          "T00:00:00Z"
        );

      const dte =
        Math.round(
          (
            expiration.getTime() -
            current.getTime()
          ) /
            (
              24 *
              60 *
              60 *
              1000
            )
        );

      return dte >=
        targetDte;
    }
  ) ??
  null;
}

function latestSeriesValueOnOrBefore({
  series,
  date,
  field,
}) {
  const usable =
    Array.isArray(
      series
    )
      ? series
          .filter(
            (item) => {
              const key =
                utcDateKey(
                  item?.begins_at
                );

              return (
                key &&
                key <=
                  date
              );
            }
          )
          .sort(
            (a, b) =>
              Date.parse(
                a.begins_at
              ) -
              Date.parse(
                b.begins_at
              )
          )
      : [];

  const latest =
    usable[
      usable.length -
      1
    ];

  return finiteNumber(
    latest?.[
      field
    ]
  );
}

async function getForwardSignalSnapshot({
  symbol,
  now,
}) {
  const start =
    new Date(
      now.getTime() -
      90 *
        24 *
        60 *
        60 *
        1000
    );

  const common = {
    start_time:
      start.toISOString(),

    end_time:
      now.toISOString(),

    interval:
      "day",

    bounds:
      "regular",

    adjustment_type:
      "split",
  };

  const [
    quoteResult,
    historicalResult,
    rsiResult,
    macdResult,
  ] =
    await Promise.all([
      callRobinhoodTool(
        "get_equity_quotes",
        {
          symbols: [
            symbol,
          ],
        }
      ),

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

  const quotePayload =
    unwrapRobinhoodToolResult(
      quoteResult
    );

  const quoteData =
    quotePayload?.data ??
    quotePayload ??
    {};

  const quoteResultRow =
    quoteData?.results?.[0] ??
    null;

  const quote =
    quoteResultRow?.quote ??
    {};

  const currentPrice =
    finiteNumber(
      quote.last_trade_price
    );

  const previousClose =
    finiteNumber(
      quote.adjusted_previous_close ??
      quoteResultRow
        ?.close
        ?.price ??
      quote.previous_close
    );

  const bars =
    extractBacktestBars(
      unwrapRobinhoodToolResult(
        historicalResult
      )
    );

  const eastern =
    easternClockParts(
      now
    );

  const completedBars =
    bars.filter(
      (bar) => {
        const date =
          utcDateKey(
            bar.time
          );

        return (
          date &&
          date <
            eastern.date
        );
      }
    );

  if (
    completedBars.length <
    2
  ) {
    throw new Error(
      "Not enough completed daily bars to evaluate the forward signal."
    );
  }

  const signalBar =
    completedBars[
      completedBars.length -
      1
    ];

  const previousBar =
    completedBars[
      completedBars.length -
      2
    ];

  const signalDate =
    utcDateKey(
      signalBar.time
    );

  const rsiPayload =
    unwrapRobinhoodToolResult(
      rsiResult
    );

  const macdPayload =
    unwrapRobinhoodToolResult(
      macdResult
    );

  const rsiSeries =
    rsiPayload
      ?.data
      ?.indicators
      ?.[0]
      ?.series ??
    [];

  const macdSeries =
    macdPayload
      ?.data
      ?.indicators
      ?.[0]
      ?.series ??
    [];

  const rsi =
    latestSeriesValueOnOrBefore({
      series:
        rsiSeries,

      date:
        signalDate,

      field:
        "value",
    });

  const macdHistogram =
    latestSeriesValueOnOrBefore({
      series:
        macdSeries,

      date:
        signalDate,

      field:
        "histogram",
    });

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
    configurableMomentumSignal({
      rsi,
      macdHistogram,
      changePct,
      bullishRsi:
        55,
      bearishRsi:
        45,
      requiredSignals:
        2,
    });

  const venueTime =
    quote.venue_last_trade_time ??
    null;

  const quoteAgeMinutes =
    venueTime
      ? (
          now.getTime() -
          Date.parse(
            venueTime
          )
        ) /
        60000
      : null;

  return {
    now:
      now.toISOString(),

    eastern,

    signalDate,

    signal:
      momentum.signal,

    bullishScore:
      momentum.bullishScore,

    bearishScore:
      momentum.bearishScore,

    rsi,
    macdHistogram,
    changePct,

    signalClose:
      signalBar.close,

    previousClose:
      previousBar.close,

    currentPrice,
    quotedPreviousClose:
      previousClose,

    quoteAgeMinutes,

    quoteTimestamp:
      venueTime,
  };
}

async function buildForwardVertical({
  symbol,
  direction,
  spot,
  targetDte,
  shortDistancePct,
  now,
}) {
  const chainResult =
    await callRobinhoodTool(
      "get_option_chains",
      {
        underlying_symbol:
          symbol,
      }
    );

  const chainPayload =
    unwrapRobinhoodToolResult(
      chainResult
    );

  const expiration =
    chooseTargetExpiration({
      dates:
        activeExpirationDates(
          chainPayload
        ),

      now,
      targetDte,
    });

  if (!expiration) {
    throw new Error(
      "No active option expiration met the target DTE."
    );
  }

  const type =
    direction ===
    "bullish"
      ? "call"
      : "put";

  const instruments =
    await loadActiveOptionInstruments({
      symbol,
      expiration,
      type,
    });

  const vertical =
    chooseHistoricalVertical({
      instruments,
      type,
      spot,
      shortDistancePct,
    });

  if (!vertical) {
    throw new Error(
      "Could not construct the fixed ATM-to-OTM vertical."
    );
  }

  const quoteResult =
    await callRobinhoodTool(
      "get_option_quotes",
      {
        instrument_ids: [
          vertical.long.id,
          vertical.short.id,
        ],
      }
    );

  const quotePayload =
    unwrapRobinhoodToolResult(
      quoteResult
    );

  const quoteMap =
    optionQuoteMapFromPayload(
      quotePayload
    );

  const spreadQuote =
    verticalQuoteSnapshot({
      longQuote:
        quoteMap.get(
          vertical.long.id
        ),

      shortQuote:
        quoteMap.get(
          vertical.short.id
        ),

      width:
        vertical.width,
    });

  if (
    !spreadQuote ||
    spreadQuote.midpoint ===
      null
  ) {
    throw new Error(
      "Current option quotes were incomplete for the fixed vertical."
    );
  }

  const expirationDate =
    new Date(
      expiration +
      "T00:00:00Z"
    );

  const dte =
    Math.round(
      (
        expirationDate.getTime() -
        now.getTime()
      ) /
        (
          24 *
          60 *
          60 *
          1000
        )
    );

  return {
    type,
    expiration,
    dte,

    long: {
      id:
        vertical.long.id,

      strike:
        vertical.long.strike,
    },

    short: {
      id:
        vertical.short.id,

      strike:
        vertical.short.strike,
    },

    width:
      vertical.width,

    quote:
      spreadQuote,
  };
}

async function historicalForwardExit({
  trade,
  exitDate,
}) {
  const start =
    new Date(
      exitDate +
      "T00:00:00Z"
    );

  const end =
    addUtcDays(
      start,
      2
    );

  const result =
    await callRobinhoodTool(
      "get_option_historicals",
      {
        instrument_ids: [
          trade.longOptionId,
          trade.shortOptionId,
        ],

        start_time:
          start.toISOString(),

        end_time:
          end.toISOString(),

        interval:
          "day",

        bounds:
          "regular",
      }
    );

  const payload =
    unwrapRobinhoodToolResult(
      result
    );

  const results =
    extractOptionHistoricalResults(
      payload
    );

  const longResult =
    results.find(
      (item) =>
        item.instrument_id ===
        trade.longOptionId
    );

  const shortResult =
    results.find(
      (item) =>
        item.instrument_id ===
        trade.shortOptionId
    );

  const longBar =
    normalizeOptionBars(
      longResult
    ).find(
      (bar) =>
        bar.date ===
        exitDate
    );

  const shortBar =
    normalizeOptionBars(
      shortResult
    ).find(
      (bar) =>
        bar.date ===
        exitDate
    );

  if (
    !longBar ||
    !shortBar
  ) {
    return null;
  }

  const value =
    clampSpreadValue(
      longBar.close -
      shortBar.close,
      trade.width
    );

  return {
    midpoint:
      value,

    fill:
      value,

    source:
      "historical_daily_close",

    exitTimestamp:
      exitDate +
      "T20:00:00Z",
  };
}

function summarizeForwardValidator(
  state
) {
  const trades =
    Array.isArray(
      state?.trades
    )
      ? state.trades
      : [];

  const open =
    trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closed =
    trades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const wins =
    closed.filter(
      (trade) =>
        (
          finiteNumber(
            trade.realizedPL
          ) ??
          0
        ) >
        0
    );

  const losses =
    closed.filter(
      (trade) =>
        (
          finiteNumber(
            trade.realizedPL
          ) ??
          0
        ) <
        0
    );

  const grossProfit =
    wins.reduce(
      (
        total,
        trade
      ) =>
        total +
        (
          finiteNumber(
            trade.realizedPL
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
          trade
        ) =>
          total +
          (
            finiteNumber(
              trade.realizedPL
            ) ??
            0
          ),
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
    const trade of closed
  ) {
    cumulative +=
      finiteNumber(
        trade.realizedPL
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

  const averageRoundTripSlippageCents =
    averageNumbers(
      closed
        .map(
          (trade) => {
            const entry =
              finiteNumber(
                trade.entrySlippageCents
              );

            const exit =
              finiteNumber(
                trade.exitSlippageCents
              );

            if (
              entry ===
                null ||
              exit ===
                null
            ) {
              return null;
            }

            return (
              entry +
              exit
            );
          }
        )
        .filter(
          (value) =>
            value !==
            null
        )
    );

  const averagePL =
    averageNumbers(
      closed.map(
        (trade) =>
          finiteNumber(
            trade.realizedPL
          )
      )
    );

  const readinessChecks = [
    {
      id:
        "closed_trades",

      label:
        "Closed forward trades",

      passed:
        closed.length >=
        20,

      actual:
        closed.length,

      threshold:
        ">= 20",
    },

    {
      id:
        "profit_factor",

      label:
        "Forward profit factor",

      passed:
        grossLoss >
        0 &&
        grossProfit /
          grossLoss >=
        1.1,

      actual:
        grossLoss >
        0
          ? grossProfit /
            grossLoss
          : null,

      threshold:
        ">= 1.10x",
    },

    {
      id:
        "average_pl",

      label:
        "Average forward P/L",

      passed:
        averagePL !==
          null &&
        averagePL >
          0,

      actual:
        averagePL,

      threshold:
        "> $0",
    },

    {
      id:
        "round_trip_slippage",

      label:
        "Average round-trip slippage",

      passed:
        averageRoundTripSlippageCents !==
          null &&
        averageRoundTripSlippageCents <=
          17,

      actual:
        averageRoundTripSlippageCents,

      threshold:
        "<= 17 cents",
    },

    {
      id:
        "max_drawdown",

      label:
        "Forward max drawdown",

      passed:
        maxDrawdown >=
        -500,

      actual:
        maxDrawdown,

      threshold:
        ">= -$500",
    },
  ];

  const readinessPassed =
    readinessChecks.filter(
      (check) =>
        check.passed
    ).length;

  return {
    total_trades:
      trades.length,

    open_trades:
      open.length,

    closed_trades:
      closed.length,

    wins:
      wins.length,

    losses:
      losses.length,

    win_rate_pct:
      closed.length
        ? (
            wins.length /
            closed.length
          ) *
          100
        : null,

    total_pl:
      cumulative,

    average_pl:
      averageNumbers(
        closed.map(
          (trade) =>
            finiteNumber(
              trade.realizedPL
            )
        )
      ),

    profit_factor:
      grossLoss >
      0
        ? grossProfit /
          grossLoss
        : grossProfit >
            0
          ? null
          : null,

    max_drawdown:
      maxDrawdown,

    average_entry_slippage_cents:
      averageNumbers(
        trades.map(
          (trade) =>
            finiteNumber(
              trade.entrySlippageCents
            )
        )
      ),

    average_exit_slippage_cents:
      averageNumbers(
        closed.map(
          (trade) =>
            finiteNumber(
              trade.exitSlippageCents
            )
        )
      ),

    average_round_trip_slippage_cents:
      averageRoundTripSlippageCents,

    readiness_gate: {
      status:
        readinessPassed ===
        readinessChecks.length
          ? "pass"
          : "collecting",

      passed_count:
        readinessPassed,

      total_checks:
        readinessChecks.length,

      checks:
        readinessChecks,

      note:
        "This gate is for paper-forward evidence only. Passing it does not authorize live trading.",
    },
  };
}

async function updateForwardOpenTrades({
  state,
  now,
}) {
  const openTrades =
    state.trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  if (!openTrades.length) {
    return state;
  }

  const ids =
    [
      ...new Set(
        openTrades.flatMap(
          (trade) => [
            trade.longOptionId,
            trade.shortOptionId,
          ]
        )
      ),
    ];

  const quoteResult =
    await callRobinhoodTool(
      "get_option_quotes",
      {
        instrument_ids:
          ids,
      }
    );

  const quoteMap =
    optionQuoteMapFromPayload(
      unwrapRobinhoodToolResult(
        quoteResult
      )
    );

  const earliest =
    openTrades
      .map(
        (trade) =>
          Date.parse(
            trade.entryTimestamp
          )
      )
      .filter(
        Number.isFinite
      )
      .reduce(
        (
          min,
          value
        ) =>
          Math.min(
            min,
            value
          ),
        now.getTime()
      );

  const historicalResult =
    await callRobinhoodTool(
      "get_equity_historicals",
      {
        symbols: [
          state.settings.symbol,
        ],

        start_time:
          new Date(
            earliest -
            2 *
              24 *
              60 *
              60 *
              1000
          ).toISOString(),

        end_time:
          now.toISOString(),

        interval:
          "day",

        bounds:
          "regular",

        adjustment_type:
          "split",
      }
    );

  const equityBars =
    extractBacktestBars(
      unwrapRobinhoodToolResult(
        historicalResult
      )
    );

  const eastern =
    easternClockParts(
      now
    );

  const completedBars =
    equityBars.filter(
      (bar) => {
        const date =
          utcDateKey(
            bar.time
          );

        return (
          date <
            eastern.date ||
          (
            date ===
              eastern.date &&
            eastern.afterClose
          )
        );
      }
    );

  const updatedTrades =
    [];

  for (
    const trade of state.trades
  ) {
    if (
      trade.status !==
      "open"
    ) {
      updatedTrades.push(
        trade
      );

      continue;
    }

    const quote =
      verticalQuoteSnapshot({
        longQuote:
          quoteMap.get(
            trade.longOptionId
          ),

        shortQuote:
          quoteMap.get(
            trade.shortOptionId
          ),

        width:
          trade.width,
      });

    const currentMidpoint =
      finiteNumber(
        quote?.midpoint
      );

    const theoreticalPL =
      currentMidpoint !==
        null
        ? (
            currentMidpoint -
            trade.entryFill
          ) *
          100
        : null;

    const nextTrade = {
      ...trade,

      lastMarkedAt:
        now.toISOString(),

      currentMidpoint,

      currentTheoreticalPL:
        theoreticalPL,

      maxFavorablePL:
        theoreticalPL !==
          null
          ? Math.max(
              finiteNumber(
                trade.maxFavorablePL
              ) ??
              0,
              theoreticalPL
            )
          : trade.maxFavorablePL,

      maxAdversePL:
        theoreticalPL !==
          null
          ? Math.min(
              finiteNumber(
                trade.maxAdversePL
              ) ??
              0,
              theoreticalPL
            )
          : trade.maxAdversePL,
    };

    const entryDate =
      utcDateKey(
        trade.entryTimestamp
      );

    const sessionBars =
      completedBars.filter(
        (bar) =>
          utcDateKey(
            bar.time
          ) >=
          entryDate
      );

    if (
      sessionBars.length <
      state.settings
        .holdSessions
    ) {
      updatedTrades.push(
        nextTrade
      );

      continue;
    }

    const exitBar =
      sessionBars[
        state.settings
          .holdSessions -
        1
      ];

    const exitDate =
      utcDateKey(
        exitBar.time
      );

    let exit =
      null;

    if (
      exitDate ===
        eastern.date &&
      eastern.nearClose &&
      quote
    ) {
      const fill =
        simulateVerticalFill({
          quote,
          side:
            "exit",
          model:
            state.settings
              .fillModel,
        });

      if (
        fill !==
        null
      ) {
        exit = {
          midpoint:
            quote.midpoint,

          fill,

          source:
            "live_near_close",

          exitTimestamp:
            now.toISOString(),
        };
      }
    }

    if (!exit) {
      exit =
        await historicalForwardExit({
          trade,
          exitDate,
        });
    }

    if (!exit) {
      updatedTrades.push(
        nextTrade
      );

      continue;
    }

    const fee =
      state.settings
        .feePerContractPerLeg *
      4;

    const realizedPL =
      (
        exit.fill -
        trade.entryFill
      ) *
        100 -
      fee;

    const exitSlippageCents =
      exit.midpoint !==
        null &&
      exit.fill !==
        null
        ? (
            exit.midpoint -
            exit.fill
          ) *
          100
        : null;

    updatedTrades.push({
      ...nextTrade,

      status:
        "closed",

      exitDate,

      exitTimestamp:
        exit.exitTimestamp,

      exitSource:
        exit.source,

      exitMidpoint:
        exit.midpoint,

      exitFill:
        exit.fill,

      exitSlippageCents,

      totalFees:
        fee,

      realizedPL,

      realizedReturnPct:
        trade.entryFill >
        0
          ? (
              realizedPL /
              (
                trade.entryFill *
                100
              )
            ) *
            100
          : null,
    });
  }

  return {
    ...state,
    trades:
      updatedTrades,
  };
}

async function maybeOpenForwardTrade({
  state,
  snapshot,
  now,
}) {
  const settings =
    state.settings;

  if (
    !settings.enabled ||
    !snapshot.eastern
      ?.regularOpen ||
    snapshot.quoteAgeMinutes ===
      null ||
    snapshot.quoteAgeMinutes >
      30 ||
    snapshot.currentPrice ===
      null
  ) {
    return state;
  }

  if (
    ![
      "bullish",
      "bearish",
    ].includes(
      snapshot.signal
    )
  ) {
    return state;
  }

  const signalKey =
    snapshot.signalDate +
    "|" +
    snapshot.signal;

  const alreadyUsed =
    state.trades.some(
      (trade) =>
        trade.signalKey ===
        signalKey
    );

  const hasOpenTrade =
    state.trades.some(
      (trade) =>
        trade.status ===
        "open"
    );

  if (
    alreadyUsed ||
    hasOpenTrade
  ) {
    return {
      ...state,
      lastSignalKey:
        signalKey,
    };
  }

  const vertical =
    await buildForwardVertical({
      symbol:
        settings.symbol,

      direction:
        snapshot.signal,

      spot:
        snapshot.currentPrice,

      targetDte:
        settings.targetDte,

      shortDistancePct:
        settings.shortDistancePct,

      now,
    });

  const entryFill =
    simulateVerticalFill({
      quote:
        vertical.quote,

      side:
        "entry",

      model:
        settings.fillModel,
    });

  if (
    entryFill ===
      null ||
    entryFill <=
      0 ||
    entryFill >=
      vertical.width
  ) {
    return state;
  }

  const entrySlippageCents =
    (
      entryFill -
      vertical.quote
        .midpoint
    ) *
    100;

  const trade = {
    id:
      crypto.randomUUID(),

    validatorVersion:
      1,

    status:
      "open",

    symbol:
      settings.symbol,

    signalKey,

    signalDate:
      snapshot.signalDate,

    signal:
      snapshot.signal,

    entryTimestamp:
      now.toISOString(),

    entryMinutesAfterMarketOpen:
      Math.max(
        0,
        snapshot.eastern.minutes -
          (
            9 *
              60 +
            30
          )
      ),

    entryUnderlyingPrice:
      snapshot.currentPrice,

    entryRsi:
      snapshot.rsi,

    entryMacdHistogram:
      snapshot.macdHistogram,

    entryDailyChangePct:
      snapshot.changePct,

    bullishScore:
      snapshot.bullishScore,

    bearishScore:
      snapshot.bearishScore,

    optionType:
      vertical.type,

    expiration:
      vertical.expiration,

    entryDte:
      vertical.dte,

    longOptionId:
      vertical.long.id,

    shortOptionId:
      vertical.short.id,

    longStrike:
      vertical.long.strike,

    shortStrike:
      vertical.short.strike,

    width:
      vertical.width,

    fillModel:
      settings.fillModel,

    entryMidpoint:
      vertical.quote
        .midpoint,

    entryBid:
      vertical.quote.bid,

    entryAsk:
      vertical.quote.ask,

    entryFill,

    entrySlippageCents,

    entryLong:
      vertical.quote.long,

    entryShort:
      vertical.quote.short,

    currentMidpoint:
      vertical.quote
        .midpoint,

    currentTheoreticalPL:
      0,

    maxFavorablePL:
      0,

    maxAdversePL:
      0,

    lastMarkedAt:
      now.toISOString(),
  };

  return {
    ...state,

    lastSignalKey:
      signalKey,

    trades: [
      ...state.trades,
      trade,
    ],
  };
}

async function runForwardValidatorTick(
  state
) {
  const now =
    new Date();

  let next =
    await updateForwardOpenTrades({
      state,
      now,
    });

  const snapshot =
    await getForwardSignalSnapshot({
      symbol:
        next.settings.symbol,

      now,
    });

  next = {
    ...next,

    lastEvaluatedAt:
      now.toISOString(),

    lastSnapshot:
      snapshot,
  };

  next =
    await maybeOpenForwardTrade({
      state:
        next,

      snapshot,
      now,
    });

  return writeForwardValidatorState(
    next
  );
}

function forwardValidatorSchedulerStatus() {
  return {
    backend_scheduler_active:
      !!forwardValidatorScheduler,

    tick_in_progress:
      forwardValidatorTickInProgress,

    last_run_at:
      forwardValidatorLastRunAt,

    last_error:
      forwardValidatorLastError,
  };
}

async function runScheduledForwardValidatorTick() {
  if (
    forwardValidatorTickInProgress
  ) {
    return;
  }

  forwardValidatorTickInProgress =
    true;

  try {
    const state =
      await readForwardValidatorState();

    if (
      !state.settings
        ?.enabled
    ) {
      return;
    }

    const seconds =
      Math.max(
        30,
        Number(
          state.settings
            ?.tickSeconds ??
          60
        ) ||
        60
      );

    const lastTime =
      state.lastEvaluatedAt
        ? Date.parse(
            state.lastEvaluatedAt
          )
        : NaN;

    if (
      Number.isFinite(
        lastTime
      ) &&
      Date.now() -
        lastTime <
        seconds *
          1000
    ) {
      return;
    }

    await runForwardValidatorTick(
      state
    );

    forwardValidatorLastRunAt =
      new Date().toISOString();

    forwardValidatorLastError =
      null;

  } catch (error) {
    forwardValidatorLastError =
      safeErrorMessage(
        error
      );

    console.error(
      "[Forward validator scheduler]",
      forwardValidatorLastError
    );

  } finally {
    forwardValidatorTickInProgress =
      false;
  }
}

function startForwardValidatorScheduler() {
  if (
    forwardValidatorScheduler
  ) {
    return;
  }

  forwardValidatorScheduler =
    setInterval(
      () => {
        runScheduledForwardValidatorTick();
        runScheduledSingleLegPracticeTick();
      },
      15000
    );

  if (
    typeof forwardValidatorScheduler.unref ===
    "function"
  ) {
    forwardValidatorScheduler.unref();
  }

  setTimeout(
    () => {
      runScheduledForwardValidatorTick();
      runScheduledSingleLegPracticeTick();
    },
    2500
  );
}


/*
  =========================================================
  SINGLE-LEG CALL / PUT PAPER PRACTICE
  =========================================================

  Manual paper-only long calls and puts.
  Robinhood order tools remain unavailable.
*/

function defaultSingleLegPracticeState() {
  return {
    version: 1,

    settings: {
      symbol:
        "PLTR",

      targetDte:
        9,

      holdSessions:
        5,

      quantity:
        1,

      fillModel:
        "quarter_spread",

      feePerContractPerLeg:
        0,
    },

    lastUpdatedAt:
      null,

    trades: [],
  };
}

function normalizeSingleLegPracticeState(
  input
) {
  const base =
    defaultSingleLegPracticeState();

  const value =
    input &&
    typeof input ===
      "object" &&
    !Array.isArray(
      input
    )
      ? input
      : {};

  const settings =
    value.settings &&
    typeof value.settings ===
      "object" &&
    !Array.isArray(
      value.settings
    )
      ? value.settings
      : {};

  return {
    version: 1,

    settings: {
      symbol:
        normalizeTicker(
          settings.symbol ||
          base.settings.symbol
        ),

      targetDte:
        Math.max(
          5,
          Math.min(
            45,
            Math.round(
              Number(
                settings.targetDte ??
                base.settings.targetDte
              ) ||
              base.settings.targetDte
            )
          )
        ),

      holdSessions:
        Math.max(
          1,
          Math.min(
            20,
            Math.round(
              Number(
                settings.holdSessions ??
                base.settings.holdSessions
              ) ||
              base.settings.holdSessions
            )
          )
        ),

      quantity:
        Math.max(
          1,
          Math.min(
            10,
            Math.round(
              Number(
                settings.quantity ??
                base.settings.quantity
              ) ||
              base.settings.quantity
            )
          )
        ),

      fillModel:
        [
          "midpoint",
          "quarter_spread",
          "conservative",
        ].includes(
          settings.fillModel
        )
          ? settings.fillModel
          : base.settings.fillModel,

      feePerContractPerLeg:
        Math.max(
          0,
          Number(
            settings.feePerContractPerLeg ??
            base.settings.feePerContractPerLeg
          ) ||
          0
        ),
    },

    lastUpdatedAt:
      value.lastUpdatedAt ||
      null,

    trades:
      Array.isArray(
        value.trades
      )
        ? value.trades.filter(
            (trade) =>
              trade &&
              typeof trade ===
                "object" &&
              !Array.isArray(
                trade
              )
          )
        : [],
  };
}

async function readSingleLegPracticeState() {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  try {
    const raw =
      await fs.readFile(
        SINGLE_LEG_PRACTICE_FILE,
        "utf8"
      );

    return normalizeSingleLegPracticeState(
      JSON.parse(
        raw
      )
    );

  } catch (error) {
    if (
      error?.code ===
      "ENOENT"
    ) {
      return defaultSingleLegPracticeState();
    }

    throw error;
  }
}

async function writeSingleLegPracticeState(
  state
) {
  await fs.mkdir(
    SCANNER_DATA_DIR,
    {
      recursive: true,
    }
  );

  const normalized =
    normalizeSingleLegPracticeState({
      ...state,

      lastUpdatedAt:
        new Date().toISOString(),
    });

  await fs.writeFile(
    SINGLE_LEG_PRACTICE_FILE,
    JSON.stringify(
      normalized,
      null,
      2
    ),
    "utf8"
  );

  return normalized;
}

function singleOptionQuoteSnapshot(
  quote
) {
  const leg =
    optionLegSnapshot(
      quote
    );

  if (!leg) {
    return null;
  }

  return {
    ...leg,

    midpoint:
      leg.mark,

    bid:
      leg.bid,

    ask:
      leg.ask,
  };
}

function simulateSingleLegFill({
  quote,
  side,
  model,
}) {
  if (!quote) {
    return null;
  }

  const midpoint =
    finiteNumber(
      quote.midpoint
    );

  if (
    midpoint ===
    null
  ) {
    return null;
  }

  if (
    model ===
    "midpoint"
  ) {
    return midpoint;
  }

  if (
    side ===
    "entry"
  ) {
    const ask =
      finiteNumber(
        quote.ask
      );

    if (
      ask ===
      null
    ) {
      return midpoint;
    }

    if (
      model ===
      "conservative"
    ) {
      return ask;
    }

    return (
      midpoint +
      (
        ask -
        midpoint
      ) *
        0.25
    );
  }

  const bid =
    finiteNumber(
      quote.bid
    );

  if (
    bid ===
      null
  ) {
    return midpoint;
  }

  if (
    model ===
    "conservative"
  ) {
    return bid;
  }

  return (
    midpoint -
    (
      midpoint -
      bid
    ) *
      0.25
  );
}

async function currentEquityPrice(
  symbol
) {
  const result =
    await callRobinhoodTool(
      "get_equity_quotes",
      {
        symbols: [
          symbol,
        ],
      }
    );

  const payload =
    unwrapRobinhoodToolResult(
      result
    );

  const data =
    payload?.data ??
    payload ??
    {};

  const row =
    data?.results?.[0] ??
    null;

  const quote =
    row?.quote ??
    {};

  const price =
    finiteNumber(
      quote.last_trade_price
    ) ??
    finiteNumber(
      quote.last_non_reg_trade_price
    );

  if (
    price ===
    null
  ) {
    throw new Error(
      "Current stock price was unavailable."
    );
  }

  return {
    price,

    timestamp:
      quote.venue_last_trade_time ??
      quote.venue_last_non_reg_trade_time ??
      null,
  };
}

async function buildSingleLegContract({
  symbol,
  type,
  targetDte,
  now,
}) {
  const stock =
    await currentEquityPrice(
      symbol
    );

  const chainResult =
    await callRobinhoodTool(
      "get_option_chains",
      {
        underlying_symbol:
          symbol,
      }
    );

  const chainPayload =
    unwrapRobinhoodToolResult(
      chainResult
    );

  const expiration =
    chooseTargetExpiration({
      dates:
        activeExpirationDates(
          chainPayload
        ),

      now,
      targetDte,
    });

  if (!expiration) {
    throw new Error(
      "No active option expiration met the target DTE."
    );
  }

  const instruments =
    await loadActiveOptionInstruments({
      symbol,
      expiration,
      type,
    });

  const usable =
    instruments
      .map(
        (instrument) => ({
          ...instrument,

          strike:
            finiteNumber(
              instrument.strike_price
            ),
        })
      )
      .filter(
        (instrument) =>
          instrument.strike !==
          null
      );

  if (
    !usable.length
  ) {
    throw new Error(
      "No active option contracts were returned."
    );
  }

  const chosen =
    usable.reduce(
      (
        best,
        instrument
      ) =>
        Math.abs(
          instrument.strike -
          stock.price
        ) <
        Math.abs(
          best.strike -
          stock.price
        )
          ? instrument
          : best,
      usable[0]
    );

  const quoteResult =
    await callRobinhoodTool(
      "get_option_quotes",
      {
        instrument_ids: [
          chosen.id,
        ],
      }
    );

  const quotePayload =
    unwrapRobinhoodToolResult(
      quoteResult
    );

  const quoteMap =
    optionQuoteMapFromPayload(
      quotePayload
    );

  const quote =
    singleOptionQuoteSnapshot(
      quoteMap.get(
        chosen.id
      )
    );

  if (
    !quote ||
    quote.midpoint ===
      null
  ) {
    throw new Error(
      "Current option quote was incomplete."
    );
  }

  const expirationDate =
    new Date(
      expiration +
      "T00:00:00Z"
    );

  const dte =
    Math.round(
      (
        expirationDate.getTime() -
        now.getTime()
      ) /
        (
          24 *
          60 *
          60 *
          1000
        )
    );

  return {
    stock,
    expiration,
    dte,

    instrument: {
      id:
        chosen.id,

      strike:
        chosen.strike,

      type,
    },

    quote,
  };
}

async function historicalSingleLegExit({
  trade,
  exitDate,
}) {
  const start =
    new Date(
      exitDate +
      "T00:00:00Z"
    );

  const end =
    addUtcDays(
      start,
      2
    );

  const result =
    await callRobinhoodTool(
      "get_option_historicals",
      {
        instrument_ids: [
          trade.instrumentId,
        ],

        start_time:
          start.toISOString(),

        end_time:
          end.toISOString(),

        interval:
          "day",

        bounds:
          "regular",
      }
    );

  const payload =
    unwrapRobinhoodToolResult(
      result
    );

  const results =
    extractOptionHistoricalResults(
      payload
    );

  const optionResult =
    results.find(
      (item) =>
        item.instrument_id ===
        trade.instrumentId
    );

  const bar =
    normalizeOptionBars(
      optionResult
    ).find(
      (item) =>
        item.date ===
        exitDate
    );

  if (!bar) {
    return null;
  }

  return {
    midpoint:
      bar.close,

    fill:
      bar.close,

    source:
      "historical_daily_close",

    exitTimestamp:
      exitDate +
      "T20:00:00Z",
  };
}

async function updateSingleLegPracticeOpenTrades({
  state,
  now,
}) {
  const openTrades =
    state.trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  if (
    !openTrades.length
  ) {
    return state;
  }

  const ids =
    openTrades.map(
      (trade) =>
        trade.instrumentId
    );

  const quoteResult =
    await callRobinhoodTool(
      "get_option_quotes",
      {
        instrument_ids:
          ids,
      }
    );

  const quoteMap =
    optionQuoteMapFromPayload(
      unwrapRobinhoodToolResult(
        quoteResult
      )
    );

  const earliest =
    openTrades
      .map(
        (trade) =>
          Date.parse(
            trade.entryTimestamp
          )
      )
      .filter(
        Number.isFinite
      )
      .reduce(
        (
          min,
          value
        ) =>
          Math.min(
            min,
            value
          ),
        now.getTime()
      );

  const historicalResult =
    await callRobinhoodTool(
      "get_equity_historicals",
      {
        symbols: [
          state.settings.symbol,
        ],

        start_time:
          new Date(
            earliest -
            2 *
              24 *
              60 *
              60 *
              1000
          ).toISOString(),

        end_time:
          now.toISOString(),

        interval:
          "day",

        bounds:
          "regular",

        adjustment_type:
          "split",
      }
    );

  const equityBars =
    extractBacktestBars(
      unwrapRobinhoodToolResult(
        historicalResult
      )
    );

  const eastern =
    easternClockParts(
      now
    );

  const completedBars =
    equityBars.filter(
      (bar) => {
        const date =
          utcDateKey(
            bar.time
          );

        return (
          date <
            eastern.date ||
          (
            date ===
              eastern.date &&
            eastern.afterClose
          )
        );
      }
    );

  const updatedTrades =
    [];

  for (
    const trade of state.trades
  ) {
    if (
      trade.status !==
      "open"
    ) {
      updatedTrades.push(
        trade
      );

      continue;
    }

    const quote =
      singleOptionQuoteSnapshot(
        quoteMap.get(
          trade.instrumentId
        )
      );

    const currentMidpoint =
      finiteNumber(
        quote?.midpoint
      );

    const currentPL =
      currentMidpoint !==
        null
        ? (
            currentMidpoint -
            trade.entryFill
          ) *
          100 *
          trade.quantity
        : null;

    const nextTrade = {
      ...trade,

      lastMarkedAt:
        now.toISOString(),

      currentMidpoint,

      currentPL,

      maxFavorablePL:
        currentPL !==
          null
          ? Math.max(
              finiteNumber(
                trade.maxFavorablePL
              ) ??
              0,
              currentPL
            )
          : trade.maxFavorablePL,

      maxAdversePL:
        currentPL !==
          null
          ? Math.min(
              finiteNumber(
                trade.maxAdversePL
              ) ??
              0,
              currentPL
            )
          : trade.maxAdversePL,
    };

    const entryDate =
      utcDateKey(
        trade.entryTimestamp
      );

    const sessionBars =
      completedBars.filter(
        (bar) =>
          utcDateKey(
            bar.time
          ) >=
          entryDate
      );

    if (
      sessionBars.length <
      state.settings
        .holdSessions
    ) {
      updatedTrades.push(
        nextTrade
      );

      continue;
    }

    const exitBar =
      sessionBars[
        state.settings
          .holdSessions -
        1
      ];

    const exitDate =
      utcDateKey(
        exitBar.time
      );

    let exit =
      null;

    if (
      exitDate ===
        eastern.date &&
      eastern.nearClose &&
      quote
    ) {
      const fill =
        simulateSingleLegFill({
          quote,
          side:
            "exit",
          model:
            state.settings
              .fillModel,
        });

      if (
        fill !==
        null
      ) {
        exit = {
          midpoint:
            quote.midpoint,

          fill,

          source:
            "live_near_close",

          exitTimestamp:
            now.toISOString(),
        };
      }
    }

    if (!exit) {
      exit =
        await historicalSingleLegExit({
          trade,
          exitDate,
        });
    }

    if (!exit) {
      updatedTrades.push(
        nextTrade
      );

      continue;
    }

    const totalFees =
      state.settings
        .feePerContractPerLeg *
      2 *
      trade.quantity;

    const realizedPL =
      (
        exit.fill -
        trade.entryFill
      ) *
        100 *
        trade.quantity -
      totalFees;

    const exitSlippageCents =
      exit.midpoint !==
        null &&
      exit.fill !==
        null
        ? (
            exit.midpoint -
            exit.fill
          ) *
          100
        : null;

    updatedTrades.push({
      ...nextTrade,

      status:
        "closed",

      exitDate,

      exitTimestamp:
        exit.exitTimestamp,

      exitSource:
        exit.source,

      exitMidpoint:
        exit.midpoint,

      exitFill:
        exit.fill,

      exitSlippageCents,

      totalFees,

      realizedPL,

      realizedReturnPct:
        trade.entryFill >
        0
          ? (
              realizedPL /
              (
                trade.entryFill *
                100 *
                trade.quantity
              )
            ) *
            100
          : null,
    });
  }

  return {
    ...state,

    trades:
      updatedTrades,
  };
}

function summarizeSingleLegPractice(
  state
) {
  const trades =
    Array.isArray(
      state?.trades
    )
      ? state.trades
      : [];

  const open =
    trades.filter(
      (trade) =>
        trade.status ===
        "open"
    );

  const closed =
    trades.filter(
      (trade) =>
        trade.status ===
        "closed"
    );

  const wins =
    closed.filter(
      (trade) =>
        (
          finiteNumber(
            trade.realizedPL
          ) ??
          0
        ) >
        0
    );

  const losses =
    closed.filter(
      (trade) =>
        (
          finiteNumber(
            trade.realizedPL
          ) ??
          0
        ) <
        0
    );

  const grossProfit =
    wins.reduce(
      (
        total,
        trade
      ) =>
        total +
        (
          finiteNumber(
            trade.realizedPL
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
          trade
        ) =>
          total +
          (
            finiteNumber(
              trade.realizedPL
            ) ??
            0
          ),
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
    const trade of closed
  ) {
    cumulative +=
      finiteNumber(
        trade.realizedPL
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
    total_trades:
      trades.length,

    open_trades:
      open.length,

    closed_trades:
      closed.length,

    wins:
      wins.length,

    losses:
      losses.length,

    win_rate_pct:
      closed.length
        ? (
            wins.length /
            closed.length
          ) *
          100
        : null,

    total_pl:
      cumulative,

    average_pl:
      averageNumbers(
        closed.map(
          (trade) =>
            finiteNumber(
              trade.realizedPL
            )
        )
      ),

    average_return_pct:
      averageNumbers(
        closed.map(
          (trade) =>
            finiteNumber(
              trade.realizedReturnPct
            )
        )
      ),

    profit_factor:
      grossLoss >
      0
        ? grossProfit /
          grossLoss
        : grossProfit >
            0
          ? null
          : null,

    max_drawdown:
      maxDrawdown,
  };
}

async function openSingleLegPracticeTrade({
  state,
  type,
  quantity,
}) {
  if (
    ![
      "call",
      "put",
    ].includes(
      type
    )
  ) {
    throw new Error(
      "Single-leg practice type must be call or put."
    );
  }

  const openCount =
    state.trades.filter(
      (trade) =>
        trade.status ===
        "open"
    ).length;

  if (
    openCount >=
    5
  ) {
    throw new Error(
      "Single-leg practice is limited to 5 open paper positions."
    );
  }

  const now =
    new Date();

  const contract =
    await buildSingleLegContract({
      symbol:
        state.settings.symbol,

      type,
      targetDte:
        state.settings.targetDte,

      now,
    });

  const entryFill =
    simulateSingleLegFill({
      quote:
        contract.quote,

      side:
        "entry",

      model:
        state.settings.fillModel,
    });

  if (
    entryFill ===
      null ||
    entryFill <=
      0
  ) {
    throw new Error(
      "A valid paper entry fill could not be simulated."
    );
  }

  const qty =
    Math.max(
      1,
      Math.min(
        10,
        Math.round(
          Number(
            quantity ??
            state.settings.quantity
          ) ||
          state.settings.quantity
        )
      )
    );

  const duplicate =
    state.trades.some(
      (trade) =>
        trade.status ===
          "open" &&
        trade.instrumentId ===
          contract.instrument.id
    );

  if (duplicate) {
    throw new Error(
      "That option contract is already open in single-leg practice."
    );
  }

  const entrySlippageCents =
    (
      entryFill -
      contract.quote
        .midpoint
    ) *
    100;

  const trade = {
    id:
      crypto.randomUUID(),

    practiceVersion:
      1,

    status:
      "open",

    symbol:
      state.settings.symbol,

    optionType:
      type,

    quantity:
      qty,

    entryTimestamp:
      now.toISOString(),

    entryUnderlyingPrice:
      contract.stock.price,

    expiration:
      contract.expiration,

    entryDte:
      contract.dte,

    instrumentId:
      contract.instrument.id,

    strike:
      contract.instrument.strike,

    fillModel:
      state.settings.fillModel,

    entryMidpoint:
      contract.quote.midpoint,

    entryBid:
      contract.quote.bid,

    entryAsk:
      contract.quote.ask,

    entryFill,

    entrySlippageCents,

    entryIv:
      contract.quote.iv,

    entryDelta:
      contract.quote.delta,

    entryGamma:
      contract.quote.gamma,

    entryTheta:
      contract.quote.theta,

    entryVega:
      contract.quote.vega,

    entryVolume:
      contract.quote.volume,

    entryOpenInterest:
      contract.quote.openInterest,

    currentMidpoint:
      contract.quote.midpoint,

    currentPL:
      0,

    maxFavorablePL:
      0,

    maxAdversePL:
      0,

    lastMarkedAt:
      now.toISOString(),
  };

  return writeSingleLegPracticeState({
    ...state,

    trades: [
      ...state.trades,
      trade,
    ],
  });
}

async function closeSingleLegPracticeTrade({
  state,
  tradeId,
}) {
  const trade =
    state.trades.find(
      (item) =>
        item.id ===
        tradeId
    );

  if (
    !trade ||
    trade.status !==
      "open"
  ) {
    throw new Error(
      "Open single-leg paper trade not found."
    );
  }

  const quoteResult =
    await callRobinhoodTool(
      "get_option_quotes",
      {
        instrument_ids: [
          trade.instrumentId,
        ],
      }
    );

  const quoteMap =
    optionQuoteMapFromPayload(
      unwrapRobinhoodToolResult(
        quoteResult
      )
    );

  const quote =
    singleOptionQuoteSnapshot(
      quoteMap.get(
        trade.instrumentId
      )
    );

  const exitFill =
    simulateSingleLegFill({
      quote,
      side:
        "exit",
      model:
        state.settings.fillModel,
    });

  if (
    exitFill ===
      null
  ) {
    throw new Error(
      "Current option quote was unavailable for the paper close."
    );
  }

  const totalFees =
    state.settings
      .feePerContractPerLeg *
    2 *
    trade.quantity;

  const realizedPL =
    (
      exitFill -
      trade.entryFill
    ) *
      100 *
      trade.quantity -
    totalFees;

  const exitSlippageCents =
    (
      quote.midpoint -
      exitFill
    ) *
    100;

  const nextTrades =
    state.trades.map(
      (item) =>
        item.id ===
        trade.id
          ? {
              ...item,

              status:
                "closed",

              exitTimestamp:
                new Date().toISOString(),

              exitSource:
                "manual_live_quote",

              exitMidpoint:
                quote.midpoint,

              exitFill,

              exitSlippageCents,

              totalFees,

              realizedPL,

              realizedReturnPct:
                item.entryFill >
                0
                  ? (
                      realizedPL /
                      (
                        item.entryFill *
                        100 *
                        item.quantity
                      )
                    ) *
                    100
                  : null,
            }
          : item
    );

  return writeSingleLegPracticeState({
    ...state,

    trades:
      nextTrades,
  });
}

async function runSingleLegPracticeTick(
  state
) {
  const next =
    await updateSingleLegPracticeOpenTrades({
      state,
      now:
        new Date(),
    });

  return writeSingleLegPracticeState(
    next
  );
}

function singleLegPracticeSchedulerStatus() {
  return {
    backend_scheduler_active:
      !!forwardValidatorScheduler,

    tick_in_progress:
      singleLegPracticeTickInProgress,

    last_run_at:
      singleLegPracticeLastRunAt,

    last_error:
      singleLegPracticeLastError,
  };
}

async function runScheduledSingleLegPracticeTick() {
  if (
    singleLegPracticeTickInProgress
  ) {
    return;
  }

  singleLegPracticeTickInProgress =
    true;

  try {
    const state =
      await readSingleLegPracticeState();

    if (
      !state.trades.some(
        (trade) =>
          trade.status ===
          "open"
      )
    ) {
      return;
    }

    await runSingleLegPracticeTick(
      state
    );

    singleLegPracticeLastRunAt =
      new Date().toISOString();

    singleLegPracticeLastError =
      null;

  } catch (error) {
    singleLegPracticeLastError =
      safeErrorMessage(
        error
      );

    console.error(
      "[Single-leg practice scheduler]",
      singleLegPracticeLastError
    );

  } finally {
    singleLegPracticeTickInProgress =
      false;
  }
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

app.post(
  "/scanner/backtest-research",

  async (req, res) => {
    try {
      const rawSymbols =
        Array.isArray(
          req.body
            ?.symbols
        )
          ? req.body
              .symbols
          : [
              req.body
                ?.symbol,
            ];

      const symbols =
        [
          ...new Set(
            rawSymbols
              .filter(
                Boolean
              )
              .map(
                normalizeTicker
              )
          ),
        ].slice(
          0,
          12
        );

      if (
        !symbols.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "At least one ticker symbol is required.",
          });
      }

      const lookbackDays =
        clampNumber(
          req.body
            ?.lookbackDays,
          180,
          3650,
          730
        );

      const costBps =
        Math.max(
          0,
          Math.min(
            500,
            Number(
              req.body
                ?.costBps ??
              10
            ) ||
            0
          )
        );

      const nonOverlapping =
        req.body
          ?.nonOverlapping !==
        false;

      const holdVariants =
        [
          1,
          3,
          5,
          10,
          20,
        ];

      const rsiProfiles = [
        {
          label:
            "50/50",

          bullishRsi:
            50,

          bearishRsi:
            50,
        },

        {
          label:
            "55/45",

          bullishRsi:
            55,

          bearishRsi:
            45,
        },

        {
          label:
            "60/40",

          bullishRsi:
            60,

          bearishRsi:
            40,
        },
      ];

      const signalRequirements = [
        2,
        3,
      ];

      const directionModes = [
        "both",
        "bullish_only",
        "bearish_only",
      ];

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

      const trainBoundary =
        new Date(
          requestedStart.getTime() +
          (
            end.getTime() -
            requestedStart.getTime()
          ) *
            0.6
        );

      const validationBoundary =
        new Date(
          requestedStart.getTime() +
          (
            end.getTime() -
            requestedStart.getTime()
          ) *
            0.8
        );

      const marketData =
        {};

      for (
        const symbol of symbols
      ) {
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

        marketData[
          symbol
        ] = {
          bars:
            extractBacktestBars(
              unwrapRobinhoodToolResult(
                historicalResult
              )
            ),

          rsiSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                rsiResult
              ),
              "rsi"
            ),

          macdSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                macdResult
              ),
              "macd"
            ),
        };
      }

      const variants =
        [];

      for (
        const directionMode of directionModes
      ) {
        for (
          const holdDays of holdVariants
        ) {
          for (
            const rsiProfile of rsiProfiles
          ) {
            for (
              const requiredSignals of signalRequirements
            ) {
              const allTrades =
                [];

              for (
                const symbol of symbols
              ) {
                const data =
                  marketData[
                    symbol
                  ];

                const symbolTrades =
                  runDirectionalBacktest({
                    bars:
                      data.bars,

                    rsiSeries:
                      data.rsiSeries,

                    macdSeries:
                      data.macdSeries,

                    requestedStart,
                    holdDays,
                    costBps,
                    nonOverlapping,
                    directionMode,

                    bullishRsi:
                      rsiProfile
                        .bullishRsi,

                    bearishRsi:
                      rsiProfile
                        .bearishRsi,

                    requiredSignals,
                    symbol,
                  });

                allTrades.push(
                  ...symbolTrades
                );
              }

              allTrades.sort(
                (a, b) =>
                  Date.parse(
                    a.exit_time
                  ) -
                  Date.parse(
                    b.exit_time
                  )
              );

              const split =
                splitTradesByDate({
                  trades:
                    allTrades,

                  trainBoundary,

                  validationBoundary,
                });

              const trainSummary =
                summarizeBacktestTrades(
                  split.train
                );

              const validationSummary =
                summarizeBacktestTrades(
                  split.validation
                );

              const testSummary =
                summarizeBacktestTrades(
                  split.test
                );

              variants.push({
                id:
                  directionMode +
                  "|" +
                  holdDays +
                  "|" +
                  rsiProfile.label +
                  "|" +
                  requiredSignals,

                parameters: {
                  direction_mode:
                    directionMode,

                  hold_sessions:
                    holdDays,

                  rsi_profile:
                    rsiProfile.label,

                  bullish_rsi:
                    rsiProfile
                      .bullishRsi,

                  bearish_rsi:
                    rsiProfile
                      .bearishRsi,

                  required_signals:
                    requiredSignals,

                  cost_bps:
                    costBps,
                },

                train:
                  trainSummary,

                validation:
                  validationSummary,

                test:
                  testSummary,

                overall:
                  summarizeBacktestTrades(
                    allTrades
                  ),

                validation_score:
                  researchCandidateScore(
                    validationSummary
                  ),
              });
            }
          }
        }
      }

      const eligible =
        variants
          .filter(
            (variant) =>
              variant.validation_score !==
                null &&
              variant.train.trades >=
                10
          )
          .sort(
            (a, b) =>
              b.validation_score -
                a.validation_score ||
              (
                b.validation
                  .profit_factor ??
                -Infinity
              ) -
                (
                  a.validation
                    .profit_factor ??
                  -Infinity
                )
          );

      const selected =
        eligible[0] ??
        null;

      const baseline =
        variants.find(
          (variant) =>
            variant.parameters
              .direction_mode ===
              "both" &&
            variant.parameters
              .hold_sessions ===
              5 &&
            variant.parameters
              .rsi_profile ===
              "55/45" &&
            variant.parameters
              .required_signals ===
              2
        ) ??
        null;

      const frictionSensitivity =
        [];

      if (
        selected
      ) {
        for (
          const sensitivityBps of [
            0,
            10,
            25,
            50,
          ]
        ) {
          const sensitivityTrades =
            [];

          for (
            const symbol of symbols
          ) {
            const data =
              marketData[
                symbol
              ];

            sensitivityTrades.push(
              ...runDirectionalBacktest({
                bars:
                  data.bars,

                rsiSeries:
                  data.rsiSeries,

                macdSeries:
                  data.macdSeries,

                requestedStart,

                holdDays:
                  selected
                    .parameters
                    .hold_sessions,

                costBps:
                  sensitivityBps,

                nonOverlapping,

                directionMode:
                  selected
                    .parameters
                    .direction_mode,

                bullishRsi:
                  selected
                    .parameters
                    .bullish_rsi,

                bearishRsi:
                  selected
                    .parameters
                    .bearish_rsi,

                requiredSignals:
                  selected
                    .parameters
                    .required_signals,

                symbol,
              })
            );
          }

          sensitivityTrades.sort(
            (a, b) =>
              Date.parse(
                a.exit_time
              ) -
              Date.parse(
                b.exit_time
              )
          );

          const split =
            splitTradesByDate({
              trades:
                sensitivityTrades,

              trainBoundary,

              validationBoundary,
            });

          frictionSensitivity.push({
            cost_bps:
              sensitivityBps,

            validation:
              summarizeBacktestTrades(
                split.validation
              ),

            test:
              summarizeBacktestTrades(
                split.test
              ),
          });
        }
      }

      let selectedTickerTest =
        [];

      if (
        selected
      ) {
        const selectedTrades =
          [];

        for (
          const symbol of symbols
        ) {
          const data =
            marketData[
              symbol
            ];

          selectedTrades.push(
            ...runDirectionalBacktest({
              bars:
                data.bars,

              rsiSeries:
                data.rsiSeries,

              macdSeries:
                data.macdSeries,

              requestedStart,

              holdDays:
                selected
                  .parameters
                  .hold_sessions,

              costBps,

              nonOverlapping,

              directionMode:
                selected
                  .parameters
                  .direction_mode,

              bullishRsi:
                selected
                  .parameters
                  .bullish_rsi,

              bearishRsi:
                selected
                  .parameters
                  .bearish_rsi,

              requiredSignals:
                selected
                  .parameters
                  .required_signals,

              symbol,
            })
          );
        }

        const selectedSplit =
          splitTradesByDate({
            trades:
              selectedTrades,

            trainBoundary,

            validationBoundary,
          });

        selectedTickerTest =
          summarizeBySymbol(
            selectedSplit.test,
            symbols
          );
      }

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "scanner_research_lab_v1",

        symbols,

        parameters: {
          lookback_days:
            lookbackDays,

          cost_bps:
            costBps,

          non_overlapping:
            nonOverlapping,
        },

        split_dates: {
          requested_start:
            requestedStart.toISOString(),

          train_end:
            trainBoundary.toISOString(),

          validation_end:
            validationBoundary.toISOString(),

          end:
            end.toISOString(),
        },

        search_space: {
          direction_modes:
            directionModes,

          hold_sessions:
            holdVariants,

          rsi_profiles:
            rsiProfiles,

          required_signals:
            signalRequirements,

          variant_count:
            variants.length,

          selection_rule:
            "Highest validation score among variants with at least 5 validation trades and 10 training trades. Score = validation average return minus 5% of absolute validation drawdown. Test results are not used for selection.",
        },

        baseline,

        selected_candidate:
          selected,

        top_candidates:
          eligible.slice(
            0,
            12
          ),

        selected_candidate_friction_sensitivity:
          frictionSensitivity,

        selected_candidate_test_by_ticker:
          selectedTickerTest,

        cautions: [
          "The research lab uses underlying stock directional returns, not historical option-spread P/L.",
          "The test window is displayed only after a candidate is selected from earlier data; do not retune parameters based on the test result.",
          "A small number of trades can make validation and test statistics unstable.",
          "Research across many variants increases overfitting risk even with a held-out test period.",
        ],
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/walk-forward",

  async (req, res) => {
    try {
      const rawSymbols =
        Array.isArray(
          req.body
            ?.symbols
        )
          ? req.body
              .symbols
          : [
              req.body
                ?.symbol,
            ];

      const symbols =
        [
          ...new Set(
            rawSymbols
              .filter(
                Boolean
              )
              .map(
                normalizeTicker
              )
          ),
        ].slice(
          0,
          12
        );

      if (
        !symbols.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "At least one ticker symbol is required.",
          });
      }

      const lookbackDays =
        clampNumber(
          req.body
            ?.lookbackDays,
          540,
          3650,
          1095
        );

      const initialTrainDays =
        clampNumber(
          req.body
            ?.trainDays,
          180,
          1825,
          365
        );

      const validationDays =
        clampNumber(
          req.body
            ?.validationDays,
          30,
          365,
          90
        );

      const testDays =
        clampNumber(
          req.body
            ?.testDays,
          20,
          365,
          60
        );

      const costBps =
        Math.max(
          0,
          Math.min(
            500,
            Number(
              req.body
                ?.costBps ??
              10
            ) ||
            0
          )
        );

      const nonOverlapping =
        req.body
          ?.nonOverlapping !==
        false;

      if (
        initialTrainDays +
          validationDays +
          testDays >
        lookbackDays
      ) {
        return res
          .status(400)
          .json({
            error:
              "Lookback must be longer than the initial train + validation + test windows.",
          });
      }

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

      const marketData =
        {};

      for (
        const symbol of symbols
      ) {
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

        marketData[
          symbol
        ] = {
          bars:
            extractBacktestBars(
              unwrapRobinhoodToolResult(
                historicalResult
              )
            ),

          rsiSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                rsiResult
              ),
              "rsi"
            ),

          macdSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                macdResult
              ),
              "macd"
            ),
        };
      }

      const definitions =
        buildResearchVariantDefinitions();

      const variantTrades =
        new Map();

      for (
        const definition of definitions
      ) {
        const trades =
          [];

        for (
          const symbol of symbols
        ) {
          const data =
            marketData[
              symbol
            ];

          trades.push(
            ...runDirectionalBacktest({
              bars:
                data.bars,

              rsiSeries:
                data.rsiSeries,

              macdSeries:
                data.macdSeries,

              requestedStart,

              holdDays:
                definition
                  .holdDays,

              costBps,

              nonOverlapping,

              directionMode:
                definition
                  .directionMode,

              bullishRsi:
                definition
                  .bullishRsi,

              bearishRsi:
                definition
                  .bearishRsi,

              requiredSignals:
                definition
                  .requiredSignals,

              symbol,
            })
          );
        }

        trades.sort(
          (a, b) =>
            Date.parse(
              a.exit_time
            ) -
            Date.parse(
              b.exit_time
            )
        );

        variantTrades.set(
          definition.id,
          trades
        );
      }

      const baselineId =
        "both|5|55/45|2";

      const folds =
        [];

      const selectedTestTrades =
        [];

      const baselineTestTrades =
        [];

      const selections =
        [];

      let trainEnd =
        new Date(
          requestedStart.getTime() +
          initialTrainDays *
            24 *
            60 *
            60 *
            1000
        );

      let foldIndex =
        1;

      while (
        true
      ) {
        const validationEnd =
          new Date(
            trainEnd.getTime() +
            validationDays *
              24 *
              60 *
              60 *
              1000
          );

        const testEnd =
          new Date(
            validationEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        if (
          testEnd.getTime() >
          end.getTime()
        ) {
          break;
        }

        const candidates =
          [];

        for (
          const definition of definitions
        ) {
          const trades =
            variantTrades.get(
              definition.id
            ) ??
            [];

          const trainTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  requestedStart,
                  trainEnd
                )
            );

          const validationTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  trainEnd,
                  validationEnd
                )
            );

          const testTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  validationEnd,
                  testEnd
                )
            );

          const trainSummary =
            summarizeBacktestTrades(
              trainTrades
            );

          const validationSummary =
            summarizeBacktestTrades(
              validationTrades
            );

          const validationScore =
            researchCandidateScore(
              validationSummary
            );

          if (
            validationScore ===
              null ||
            trainSummary.trades <
              10 ||
            validationSummary.trades <
              5
          ) {
            continue;
          }

          candidates.push({
            id:
              definition.id,

            parameters: {
              direction_mode:
                definition
                  .directionMode,

              hold_sessions:
                definition
                  .holdDays,

              rsi_profile:
                definition
                  .rsiProfile,

              bullish_rsi:
                definition
                  .bullishRsi,

              bearish_rsi:
                definition
                  .bearishRsi,

              required_signals:
                definition
                  .requiredSignals,

              cost_bps:
                costBps,
            },

            train:
              trainSummary,

            validation:
              validationSummary,

            test:
              summarizeBacktestTrades(
                testTrades
              ),

            validation_score:
              validationScore,

            test_trades:
              testTrades,
          });
        }

        candidates.sort(
          (a, b) =>
            b.validation_score -
              a.validation_score ||
            (
              b.validation
                .profit_factor ??
              -Infinity
            ) -
              (
                a.validation
                  .profit_factor ??
                -Infinity
              )
        );

        const selected =
          candidates[0] ??
          null;

        if (
          selected
        ) {
          selections.push(
            selected
          );

          selectedTestTrades.push(
            ...selected
              .test_trades
              .map(
                (trade) => ({
                  ...trade,

                  walk_forward_fold:
                    foldIndex,

                  selected_rule_id:
                    selected.id,

                  selected_direction_mode:
                    selected
                      .parameters
                      .direction_mode,

                  selected_hold_sessions:
                    selected
                      .parameters
                      .hold_sessions,

                  selected_rsi_profile:
                    selected
                      .parameters
                      .rsi_profile,

                  selected_required_signals:
                    selected
                      .parameters
                      .required_signals,

                  selected_validation_score:
                    selected
                      .validation_score,

                  selected_using_prior_data_only:
                    true,
                })
              )
          );
        }

        const baselineTrades =
          variantTrades.get(
            baselineId
          ) ??
          [];

        const foldBaselineTest =
          baselineTrades.filter(
            (trade) =>
              tradeInDateRange(
                trade,
                validationEnd,
                testEnd
              )
          );

        baselineTestTrades.push(
          ...foldBaselineTest
        );

        folds.push({
          fold:
            foldIndex,

          train_start:
            requestedStart.toISOString(),

          train_end:
            trainEnd.toISOString(),

          validation_start:
            trainEnd.toISOString(),

          validation_end:
            validationEnd.toISOString(),

          test_start:
            validationEnd.toISOString(),

          test_end:
            testEnd.toISOString(),

          eligible_candidate_count:
            candidates.length,

          selected_candidate:
            selected
              ? {
                  id:
                    selected.id,

                  parameters:
                    selected.parameters,

                  train:
                    selected.train,

                  validation:
                    selected.validation,

                  test:
                    selected.test,

                  validation_score:
                    selected.validation_score,
                }
              : null,

          baseline_test:
            summarizeBacktestTrades(
              foldBaselineTest
            ),
        });

        trainEnd =
          new Date(
            trainEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        foldIndex +=
          1;
      }

      selectedTestTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      baselineTestTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      const completedFolds =
        folds.filter(
          (fold) =>
            !!fold
              .selected_candidate
        );

      const positiveFolds =
        completedFolds.filter(
          (fold) =>
            (
              fold
                .selected_candidate
                ?.test
                ?.compounded_return_pct ??
              0
            ) >
            0
        ).length;

      const selectionFrequency =
        selectionFrequencyRows(
          selections
        );

      const selectedOosByTicker =
        summarizeBySymbol(
          selectedTestTrades,
          symbols
        );

      const baselineOosByTicker =
        summarizeBySymbol(
          baselineTestTrades,
          symbols
        );

      const selectedOosSummary =
        summarizeBacktestTrades(
          selectedTestTrades
        );

      const robustnessGate =
        buildWalkForwardRobustnessGate({
          completedFolds,
          positiveFolds,
          selectedSummary:
            selectedOosSummary,
          byTicker:
            selectedOosByTicker,
          selectionFrequency,
        });

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "scanner_expanding_walk_forward_v1",

        symbols,

        parameters: {
          lookback_days:
            lookbackDays,

          initial_train_days:
            initialTrainDays,

          validation_days:
            validationDays,

          test_days:
            testDays,

          cost_bps:
            costBps,

          non_overlapping:
            nonOverlapping,

          variant_count:
            definitions.length,
        },

        methodology: {
          selection:
            "Each fold selects the highest validation-scoring rule using only data before that fold's test window. Minimum eligibility is 10 training trades and 5 validation trades.",

          rolling:
            "Training expands forward by one test window per fold. Validation and test windows roll forward without overlap.",

          score:
            "Validation score = average return minus 5% of absolute validation drawdown.",

          caution:
            "This remains an underlying-stock directional proxy, not historical option-spread P/L.",
        },

        summary: {
          folds:
            folds.length,

          completed_folds:
            completedFolds.length,

          skipped_folds:
            folds.length -
            completedFolds.length,

          positive_test_folds:
            positiveFolds,

          positive_test_fold_rate:
            completedFolds.length
              ? (
                  positiveFolds /
                  completedFolds.length
                ) *
                100
              : null,

          selected_oos:
            selectedOosSummary,

          baseline_oos:
            summarizeBacktestTrades(
              baselineTestTrades
            ),
        },

        robustness_gate:
          robustnessGate,

        selection_frequency:
          selectionFrequency,

        selected_oos_by_ticker:
          selectedOosByTicker,

        baseline_oos_by_ticker:
          baselineOosByTicker,

        folds,

        selected_oos_trades:
          selectedTestTrades,

        oos_learning_dataset:
          selectedTestTrades.map(
            (trade) => ({
              ticker:
                trade.symbol,

              fold:
                trade.walk_forward_fold,

              signal_time:
                trade.signal_time,

              entry_time:
                trade.entry_time,

              exit_time:
                trade.exit_time,

              signal:
                trade.signal,

              selected_rule_id:
                trade.selected_rule_id,

              selected_direction_mode:
                trade.selected_direction_mode,

              selected_hold_sessions:
                trade.selected_hold_sessions,

              selected_rsi_profile:
                trade.selected_rsi_profile,

              selected_required_signals:
                trade.selected_required_signals,

              selected_validation_score:
                trade.selected_validation_score,

              selected_using_prior_data_only:
                trade.selected_using_prior_data_only,

              rsi:
                trade.rsi,

              macd_histogram:
                trade.macd_histogram,

              signal_change_pct:
                trade.signal_change_pct,

              bullish_score:
                trade.bullish_score,

              bearish_score:
                trade.bearish_score,

              entry_open:
                trade.entry_open,

              exit_close:
                trade.exit_close,

              hold_sessions:
                trade.hold_sessions,

              friction_pct:
                trade.friction_pct,

              net_return_pct:
                trade.net_return_pct,

              mfe_pct:
                trade.mfe_pct,

              mae_pct:
                trade.mae_pct,

              favorable:
                trade.favorable,
            })
          ),
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/risk-overlay-walk-forward",

  async (req, res) => {
    try {
      const rawSymbols =
        Array.isArray(
          req.body
            ?.symbols
        )
          ? req.body
              .symbols
          : [
              req.body
                ?.symbol,
            ];

      const symbols =
        [
          ...new Set(
            rawSymbols
              .filter(
                Boolean
              )
              .map(
                normalizeTicker
              )
          ),
        ].slice(
          0,
          12
        );

      if (
        !symbols.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "At least one ticker symbol is required.",
          });
      }

      const lookbackDays =
        clampNumber(
          req.body
            ?.lookbackDays,
          540,
          3650,
          1095
        );

      const initialTrainDays =
        clampNumber(
          req.body
            ?.trainDays,
          180,
          1825,
          365
        );

      const validationDays =
        clampNumber(
          req.body
            ?.validationDays,
          30,
          365,
          90
        );

      const testDays =
        clampNumber(
          req.body
            ?.testDays,
          20,
          365,
          60
        );

      const costBps =
        Math.max(
          0,
          Math.min(
            500,
            Number(
              req.body
                ?.costBps ??
              10
            ) ||
            0
          )
        );

      const nonOverlapping =
        req.body
          ?.nonOverlapping !==
        false;

      if (
        initialTrainDays +
          validationDays +
          testDays >
        lookbackDays
      ) {
        return res
          .status(400)
          .json({
            error:
              "Lookback must exceed train + validation + test windows.",
          });
      }

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

      const marketData =
        {};

      for (
        const symbol of symbols
      ) {
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

        marketData[
          symbol
        ] = {
          bars:
            extractBacktestBars(
              unwrapRobinhoodToolResult(
                historicalResult
              )
            ),

          rsiSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                rsiResult
              ),
              "rsi"
            ),

          macdSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                macdResult
              ),
              "macd"
            ),
        };
      }

      const baseDefinitions =
        buildResearchVariantDefinitions();

      const riskDefinitions =
        buildRiskOverlayDefinitions();

      const baseTrades =
        new Map();

      for (
        const definition of baseDefinitions
      ) {
        const trades =
          [];

        for (
          const symbol of symbols
        ) {
          const data =
            marketData[
              symbol
            ];

          trades.push(
            ...runDirectionalBacktest({
              bars:
                data.bars,

              rsiSeries:
                data.rsiSeries,

              macdSeries:
                data.macdSeries,

              requestedStart,

              holdDays:
                definition
                  .holdDays,

              costBps,

              nonOverlapping,

              directionMode:
                definition
                  .directionMode,

              bullishRsi:
                definition
                  .bullishRsi,

              bearishRsi:
                definition
                  .bearishRsi,

              requiredSignals:
                definition
                  .requiredSignals,

              symbol,
            })
          );
        }

        trades.sort(
          (a, b) =>
            Date.parse(
              a.exit_time
            ) -
            Date.parse(
              b.exit_time
            )
        );

        baseTrades.set(
          definition.id,
          trades
        );
      }

      const folds =
        [];

      const selectedOosTrades =
        [];

      const unprotectedOosTrades =
        [];

      const overlaySelections =
        [];

      let trainEnd =
        new Date(
          requestedStart.getTime() +
          initialTrainDays *
            24 *
            60 *
            60 *
            1000
        );

      let foldIndex =
        1;

      while (
        true
      ) {
        const validationEnd =
          new Date(
            trainEnd.getTime() +
            validationDays *
              24 *
              60 *
              60 *
              1000
          );

        const testEnd =
          new Date(
            validationEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        if (
          testEnd.getTime() >
          end.getTime()
        ) {
          break;
        }

        const baseCandidates =
          [];

        for (
          const definition of baseDefinitions
        ) {
          const trades =
            baseTrades.get(
              definition.id
            ) ??
            [];

          const trainTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  requestedStart,
                  trainEnd
                )
            );

          const validationTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  trainEnd,
                  validationEnd
                )
            );

          const trainSummary =
            summarizeBacktestTrades(
              trainTrades
            );

          const validationSummary =
            summarizeBacktestTrades(
              validationTrades
            );

          const score =
            researchCandidateScore(
              validationSummary
            );

          if (
            score ===
              null ||
            trainSummary.trades <
              10 ||
            validationSummary.trades <
              5
          ) {
            continue;
          }

          baseCandidates.push({
            definition,
            trainTrades,
            validationTrades,
            trainSummary,
            validationSummary,
            score,
          });
        }

        baseCandidates.sort(
          (a, b) =>
            b.score -
              a.score ||
            (
              b.validationSummary
                .profit_factor ??
              -Infinity
            ) -
              (
                a.validationSummary
                  .profit_factor ??
                -Infinity
              )
        );

        const selectedBase =
          baseCandidates[0] ??
          null;

        if (
          !selectedBase
        ) {
          folds.push({
            fold:
              foldIndex,

            test_start:
              validationEnd.toISOString(),

            test_end:
              testEnd.toISOString(),

            selected_base:
              null,

            selected_overlay:
              null,
          });

          trainEnd =
            new Date(
              trainEnd.getTime() +
              testDays *
                24 *
                60 *
                60 *
                1000
            );

          foldIndex +=
            1;

          continue;
        }

        const allBaseTrades =
          baseTrades.get(
            selectedBase
              .definition
              .id
          ) ??
          [];

        const foldTestBase =
          allBaseTrades.filter(
            (trade) =>
              tradeInDateRange(
                trade,
                validationEnd,
                testEnd
              )
          );

        const overlayCandidates =
          [];

        for (
          const overlay of riskDefinitions
        ) {
          const validationOverlayTrades =
            applyRiskOverlayToTrades({
              trades:
                selectedBase
                  .validationTrades,

              marketData,
              overlay,
            });

          const validationOverlaySummary =
            summarizeBacktestTrades(
              validationOverlayTrades
            );

          const score =
            riskOverlayScore(
              validationOverlaySummary
            );

          if (
            score ===
              null
          ) {
            continue;
          }

          overlayCandidates.push({
            overlay,
            validation:
              validationOverlaySummary,
            score,
          });
        }

        overlayCandidates.sort(
          (a, b) =>
            b.score -
              a.score ||
            (
              b.validation
                .profit_factor ??
              -Infinity
            ) -
              (
                a.validation
                  .profit_factor ??
                -Infinity
              )
        );

        const selectedOverlay =
          overlayCandidates[0] ??
          null;

        if (
          selectedOverlay
        ) {
          overlaySelections.push({
            id:
              selectedOverlay
                .overlay
                .id,

            parameters:
              selectedOverlay
                .overlay,
          });

          const protectedTestTrades =
            applyRiskOverlayToTrades({
              trades:
                foldTestBase,

              marketData,
              overlay:
                selectedOverlay
                  .overlay,
            }).map(
              (trade) => ({
                ...trade,

                risk_overlay_fold:
                  foldIndex,

                selected_base_rule_id:
                  selectedBase
                    .definition
                    .id,

                selected_using_prior_data_only:
                  true,
              })
            );

          selectedOosTrades.push(
            ...protectedTestTrades
          );
        }

        unprotectedOosTrades.push(
          ...foldTestBase.map(
            (trade) => ({
              ...trade,

              risk_overlay_fold:
                foldIndex,
            })
          )
        );

        folds.push({
          fold:
            foldIndex,

          train_start:
            requestedStart.toISOString(),

          train_end:
            trainEnd.toISOString(),

          validation_start:
            trainEnd.toISOString(),

          validation_end:
            validationEnd.toISOString(),

          test_start:
            validationEnd.toISOString(),

          test_end:
            testEnd.toISOString(),

          selected_base: {
            id:
              selectedBase
                .definition
                .id,

            parameters: {
              direction_mode:
                selectedBase
                  .definition
                  .directionMode,

              hold_sessions:
                selectedBase
                  .definition
                  .holdDays,

              rsi_profile:
                selectedBase
                  .definition
                  .rsiProfile,

              required_signals:
                selectedBase
                  .definition
                  .requiredSignals,
            },

            validation:
              selectedBase
                .validationSummary,
          },

          selected_overlay:
            selectedOverlay
              ? {
                  parameters:
                    selectedOverlay
                      .overlay,

                  validation:
                    selectedOverlay
                      .validation,

                  validation_score:
                    selectedOverlay
                      .score,

                  test:
                    summarizeBacktestTrades(
                      applyRiskOverlayToTrades({
                        trades:
                          foldTestBase,

                        marketData,
                        overlay:
                          selectedOverlay
                            .overlay,
                      })
                    ),
                }
              : null,

          unprotected_test:
            summarizeBacktestTrades(
              foldTestBase
            ),
        });

        trainEnd =
          new Date(
            trainEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        foldIndex +=
          1;
      }

      selectedOosTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      unprotectedOosTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      const protectedSummary =
        summarizeBacktestTrades(
          selectedOosTrades
        );

      const unprotectedSummary =
        summarizeBacktestTrades(
          unprotectedOosTrades
        );

      const positiveProtectedFolds =
        folds.filter(
          (fold) =>
            (
              fold
                .selected_overlay
                ?.test
                ?.compounded_return_pct ??
              0
            ) >
            0
        ).length;

      const completedFolds =
        folds.filter(
          (fold) =>
            !!fold
              .selected_overlay
        );

      const protectedByTicker =
        summarizeBySymbol(
          selectedOosTrades,
          symbols
        );

      const overlayFrequency =
        selectionFrequencyRows(
          overlaySelections
        );

      const robustnessGate =
        buildWalkForwardRobustnessGate({
          completedFolds,
          positiveFolds:
            positiveProtectedFolds,
          selectedSummary:
            protectedSummary,
          byTicker:
            protectedByTicker,
          selectionFrequency:
            overlayFrequency,
        });

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "scanner_risk_overlay_walk_forward_v1",

        symbols,

        parameters: {
          lookback_days:
            lookbackDays,

          initial_train_days:
            initialTrainDays,

          validation_days:
            validationDays,

          test_days:
            testDays,

          cost_bps:
            costBps,

          non_overlapping:
            nonOverlapping,

          base_variant_count:
            baseDefinitions.length,

          overlay_variant_count:
            riskDefinitions.length,
        },

        methodology: {
          base_selection:
            "Each fold first selects the signal rule using validation data only.",

          overlay_selection:
            "After the base rule is frozen, stop loss, profit target, max hold cap, and risk budget are selected using the same prior validation window only.",

          execution:
            "Daily OHLC bars are used for stop and target checks. If both stop and target are touched in the same bar, the stop is assumed to occur first. Opening gaps through a stop or target exit at that session open.",

          sizing:
            "Allocation fraction = min(100%, risk budget percent divided by stop-loss percent). This is a portfolio-exposure proxy, not brokerage position sizing.",

          caution:
            "Underlying-stock proxy only; historical option spread prices are not replayed.",
        },

        summary: {
          folds:
            folds.length,

          completed_folds:
            completedFolds.length,

          positive_protected_folds:
            positiveProtectedFolds,

          positive_protected_fold_rate:
            completedFolds.length
              ? (
                  positiveProtectedFolds /
                  completedFolds.length
                ) *
                100
              : null,

          protected_oos:
            protectedSummary,

          unprotected_oos:
            unprotectedSummary,

          drawdown_improvement_pct_points:
            (
              protectedSummary
                .max_drawdown_pct ??
              0
            ) -
            (
              unprotectedSummary
                .max_drawdown_pct ??
              0
            ),
        },

        robustness_gate:
          robustnessGate,

        overlay_selection_frequency:
          overlayFrequency,

        protected_oos_by_ticker:
          protectedByTicker,

        unprotected_oos_by_ticker:
          summarizeBySymbol(
            unprotectedOosTrades,
            symbols
          ),

        folds,

        protected_oos_dataset:
          selectedOosTrades.map(
            (trade) => ({
              ticker:
                trade.symbol,

              fold:
                trade.risk_overlay_fold,

              signal_time:
                trade.signal_time,

              entry_time:
                trade.entry_time,

              exit_time:
                trade.exit_time,

              signal:
                trade.signal,

              base_rule_id:
                trade.selected_base_rule_id,

              risk_overlay_id:
                trade.risk_overlay_id,

              stop_loss_pct:
                trade.stop_loss_pct,

              profit_target_pct:
                trade.profit_target_pct,

              risk_budget_pct:
                trade.risk_budget_pct,

              allocation_fraction:
                trade.allocation_fraction,

              max_hold_sessions:
                trade.max_hold_sessions,

              realized_hold_sessions:
                trade.hold_sessions,

              exit_reason:
                trade.exit_reason,

              rsi:
                trade.rsi,

              macd_histogram:
                trade.macd_histogram,

              signal_change_pct:
                trade.signal_change_pct,

              entry_open:
                trade.entry_open,

              exit_close:
                trade.exit_close,

              raw_net_return_pct:
                trade.raw_net_return_pct,

              portfolio_return_pct:
                trade.net_return_pct,

              mfe_pct:
                trade.mfe_pct,

              mae_pct:
                trade.mae_pct,

              selected_using_prior_data_only:
                trade.selected_using_prior_data_only,
            })
          ),
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/nested-risk-walk-forward",

  async (req, res) => {
    try {
      const rawSymbols =
        Array.isArray(
          req.body
            ?.symbols
        )
          ? req.body
              .symbols
          : [
              req.body
                ?.symbol,
            ];

      const symbols =
        [
          ...new Set(
            rawSymbols
              .filter(
                Boolean
              )
              .map(
                normalizeTicker
              )
          ),
        ].slice(
          0,
          12
        );

      if (
        !symbols.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "At least one ticker symbol is required.",
          });
      }

      const lookbackDays =
        clampNumber(
          req.body
            ?.lookbackDays,
          540,
          3650,
          1095
        );

      const initialTrainDays =
        clampNumber(
          req.body
            ?.trainDays,
          180,
          1825,
          365
        );

      const strategyValidationDays =
        clampNumber(
          req.body
            ?.strategyValidationDays,
          30,
          365,
          60
        );

      const riskCalibrationDays =
        clampNumber(
          req.body
            ?.riskCalibrationDays,
          20,
          365,
          30
        );

      const testDays =
        clampNumber(
          req.body
            ?.testDays,
          20,
          365,
          60
        );

      const costBps =
        Math.max(
          0,
          Math.min(
            500,
            Number(
              req.body
                ?.costBps ??
              10
            ) ||
            0
          )
        );

      const nonOverlapping =
        req.body
          ?.nonOverlapping !==
        false;

      if (
        initialTrainDays +
          strategyValidationDays +
          riskCalibrationDays +
          testDays >
        lookbackDays
      ) {
        return res
          .status(400)
          .json({
            error:
              "Lookback must exceed train + strategy validation + risk calibration + test windows.",
          });
      }

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

      const marketData =
        {};

      for (
        const symbol of symbols
      ) {
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

        marketData[
          symbol
        ] = {
          bars:
            extractBacktestBars(
              unwrapRobinhoodToolResult(
                historicalResult
              )
            ),

          rsiSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                rsiResult
              ),
              "rsi"
            ),

          macdSeries:
            extractBacktestIndicator(
              unwrapRobinhoodToolResult(
                macdResult
              ),
              "macd"
            ),
        };
      }

      const baseDefinitions =
        buildResearchVariantDefinitions();

      const riskDefinitions =
        buildRiskOverlayDefinitions();

      const baseTrades =
        new Map();

      for (
        const definition of baseDefinitions
      ) {
        const trades =
          [];

        for (
          const symbol of symbols
        ) {
          const data =
            marketData[
              symbol
            ];

          trades.push(
            ...runDirectionalBacktest({
              bars:
                data.bars,

              rsiSeries:
                data.rsiSeries,

              macdSeries:
                data.macdSeries,

              requestedStart,

              holdDays:
                definition
                  .holdDays,

              costBps,

              nonOverlapping,

              directionMode:
                definition
                  .directionMode,

              bullishRsi:
                definition
                  .bullishRsi,

              bearishRsi:
                definition
                  .bearishRsi,

              requiredSignals:
                definition
                  .requiredSignals,

              symbol,
            })
          );
        }

        trades.sort(
          (a, b) =>
            Date.parse(
              a.exit_time
            ) -
            Date.parse(
              b.exit_time
            )
        );

        baseTrades.set(
          definition.id,
          trades
        );
      }

      const folds =
        [];

      const protectedOosTrades =
        [];

      const unprotectedOosTrades =
        [];

      const baseSelections =
        [];

      const overlaySelections =
        [];

      const combinedSelections =
        [];

      let trainEnd =
        new Date(
          requestedStart.getTime() +
          initialTrainDays *
            24 *
            60 *
            60 *
            1000
        );

      let foldIndex =
        1;

      while (
        true
      ) {
        const strategyValidationEnd =
          new Date(
            trainEnd.getTime() +
            strategyValidationDays *
              24 *
              60 *
              60 *
              1000
          );

        const riskCalibrationEnd =
          new Date(
            strategyValidationEnd.getTime() +
            riskCalibrationDays *
              24 *
              60 *
              60 *
              1000
          );

        const testEnd =
          new Date(
            riskCalibrationEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        if (
          testEnd.getTime() >
          end.getTime()
        ) {
          break;
        }

        const baseCandidates =
          [];

        for (
          const definition of baseDefinitions
        ) {
          const trades =
            baseTrades.get(
              definition.id
            ) ??
            [];

          const trainTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  requestedStart,
                  trainEnd
                )
            );

          const strategyValidationTrades =
            trades.filter(
              (trade) =>
                tradeInDateRange(
                  trade,
                  trainEnd,
                  strategyValidationEnd
                )
            );

          const trainSummary =
            summarizeBacktestTrades(
              trainTrades
            );

          const strategyValidationSummary =
            summarizeBacktestTrades(
              strategyValidationTrades
            );

          const score =
            researchCandidateScore(
              strategyValidationSummary
            );

          if (
            score ===
              null ||
            trainSummary.trades <
              10 ||
            strategyValidationSummary.trades <
              5
          ) {
            continue;
          }

          baseCandidates.push({
            definition,
            trainSummary,
            strategyValidationSummary,
            score,
          });
        }

        baseCandidates.sort(
          (a, b) =>
            b.score -
              a.score ||
            (
              b.strategyValidationSummary
                .profit_factor ??
              -Infinity
            ) -
              (
                a.strategyValidationSummary
                  .profit_factor ??
                -Infinity
              )
        );

        const selectedBase =
          baseCandidates[0] ??
          null;

        if (
          !selectedBase
        ) {
          folds.push({
            fold:
              foldIndex,

            train_end:
              trainEnd.toISOString(),

            strategy_validation_end:
              strategyValidationEnd.toISOString(),

            risk_calibration_end:
              riskCalibrationEnd.toISOString(),

            test_end:
              testEnd.toISOString(),

            selected_base:
              null,

            selected_overlay:
              null,
          });

          trainEnd =
            new Date(
              trainEnd.getTime() +
              testDays *
                24 *
                60 *
                60 *
                1000
            );

          foldIndex +=
            1;

          continue;
        }

        baseSelections.push({
          id:
            selectedBase
              .definition
              .id,

          parameters: {
            direction_mode:
              selectedBase
                .definition
                .directionMode,

            hold_sessions:
              selectedBase
                .definition
                .holdDays,

            rsi_profile:
              selectedBase
                .definition
                .rsiProfile,

            required_signals:
              selectedBase
                .definition
                .requiredSignals,
          },
        });

        const selectedBaseTrades =
          baseTrades.get(
            selectedBase
              .definition
              .id
          ) ??
          [];

        const riskCalibrationTrades =
          selectedBaseTrades.filter(
            (trade) =>
              tradeInDateRange(
                trade,
                strategyValidationEnd,
                riskCalibrationEnd
              )
          );

        const testBaseTrades =
          selectedBaseTrades.filter(
            (trade) =>
              tradeInDateRange(
                trade,
                riskCalibrationEnd,
                testEnd
              )
          );

        const overlayCandidates =
          [];

        for (
          const overlay of riskDefinitions
        ) {
          const calibratedTrades =
            applyRiskOverlayToTrades({
              trades:
                riskCalibrationTrades,

              marketData,
              overlay,
            });

          const calibrationSummary =
            summarizeBacktestTrades(
              calibratedTrades
            );

          if (
            calibrationSummary.trades <
              5 ||
            (
              calibrationSummary
                .average_return_pct ??
              0
            ) <=
              0 ||
            (
              calibrationSummary
                .profit_factor ??
              0
            ) <
              1.05
          ) {
            continue;
          }

          overlayCandidates.push({
            overlay,
            calibration:
              calibrationSummary,
          });
        }

        overlayCandidates.sort(
          (a, b) => {
            const drawdownA =
              a.calibration
                .max_drawdown_pct ??
              -Infinity;

            const drawdownB =
              b.calibration
                .max_drawdown_pct ??
              -Infinity;

            if (
              drawdownB !==
              drawdownA
            ) {
              return (
                drawdownB -
                drawdownA
              );
            }

            const averageA =
              a.calibration
                .average_return_pct ??
              -Infinity;

            const averageB =
              b.calibration
                .average_return_pct ??
              -Infinity;

            if (
              averageB !==
              averageA
            ) {
              return (
                averageB -
                averageA
              );
            }

            return (
              (
                b.calibration
                  .profit_factor ??
                -Infinity
              ) -
              (
                a.calibration
                  .profit_factor ??
                -Infinity
              )
            );
          }
        );

        const selectedOverlay =
          overlayCandidates[0] ??
          null;

        const unprotectedTestSummary =
          summarizeBacktestTrades(
            testBaseTrades
          );

        unprotectedOosTrades.push(
          ...testBaseTrades.map(
            (trade) => ({
              ...trade,

              nested_fold:
                foldIndex,
            })
          )
        );

        if (
          selectedOverlay
        ) {
          overlaySelections.push({
            id:
              selectedOverlay
                .overlay
                .id,

            parameters:
              selectedOverlay
                .overlay,
          });

          combinedSelections.push({
            id:
              selectedBase
                .definition
                .id +
              "||" +
              selectedOverlay
                .overlay
                .id,

            parameters: {
              base_rule:
                selectedBase
                  .definition
                  .id,

              risk_overlay:
                selectedOverlay
                  .overlay
                  .id,
            },
          });

          const protectedTestTrades =
            applyRiskOverlayToTrades({
              trades:
                testBaseTrades,

              marketData,

              overlay:
                selectedOverlay
                  .overlay,
            }).map(
              (trade) => ({
                ...trade,

                nested_fold:
                  foldIndex,

                selected_base_rule_id:
                  selectedBase
                    .definition
                    .id,

                selected_using_prior_data_only:
                  true,
              })
            );

          protectedOosTrades.push(
            ...protectedTestTrades
          );
        }

        folds.push({
          fold:
            foldIndex,

          train_start:
            requestedStart.toISOString(),

          train_end:
            trainEnd.toISOString(),

          strategy_validation_start:
            trainEnd.toISOString(),

          strategy_validation_end:
            strategyValidationEnd.toISOString(),

          risk_calibration_start:
            strategyValidationEnd.toISOString(),

          risk_calibration_end:
            riskCalibrationEnd.toISOString(),

          test_start:
            riskCalibrationEnd.toISOString(),

          test_end:
            testEnd.toISOString(),

          selected_base: {
            id:
              selectedBase
                .definition
                .id,

            parameters: {
              direction_mode:
                selectedBase
                  .definition
                  .directionMode,

              hold_sessions:
                selectedBase
                  .definition
                  .holdDays,

              rsi_profile:
                selectedBase
                  .definition
                  .rsiProfile,

              required_signals:
                selectedBase
                  .definition
                  .requiredSignals,
            },

            strategy_validation:
              selectedBase
                .strategyValidationSummary,

            strategy_validation_score:
              selectedBase
                .score,
          },

          selected_overlay:
            selectedOverlay
              ? {
                  parameters:
                    selectedOverlay
                      .overlay,

                  risk_calibration:
                    selectedOverlay
                      .calibration,

                  test:
                    summarizeBacktestTrades(
                      applyRiskOverlayToTrades({
                        trades:
                          testBaseTrades,

                        marketData,

                        overlay:
                          selectedOverlay
                            .overlay,
                      })
                    ),
                }
              : null,

          risk_calibration_trade_count:
            riskCalibrationTrades.length,

          unprotected_test:
            unprotectedTestSummary,
        });

        trainEnd =
          new Date(
            trainEnd.getTime() +
            testDays *
              24 *
              60 *
              60 *
              1000
          );

        foldIndex +=
          1;
      }

      protectedOosTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      unprotectedOosTrades.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      const completedFolds =
        folds.filter(
          (fold) =>
            !!fold
              .selected_overlay
        );

      const positiveFolds =
        completedFolds.filter(
          (fold) =>
            (
              fold
                .selected_overlay
                ?.test
                ?.compounded_return_pct ??
              0
            ) >
            0
        ).length;

      const protectedSummary =
        summarizeBacktestTrades(
          protectedOosTrades
        );

      const unprotectedSummary =
        summarizeBacktestTrades(
          unprotectedOosTrades
        );

      const protectedByTicker =
        summarizeBySymbol(
          protectedOosTrades,
          symbols
        );

      const combinedSelectionFrequency =
        selectionFrequencyRows(
          combinedSelections
        );

      const robustnessGate =
        buildWalkForwardRobustnessGate({
          completedFolds,
          positiveFolds,
          selectedSummary:
            protectedSummary,
          byTicker:
            protectedByTicker,
          selectionFrequency:
            combinedSelectionFrequency,
        });

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "scanner_nested_risk_walk_forward_v1",

        symbols,

        parameters: {
          lookback_days:
            lookbackDays,

          initial_train_days:
            initialTrainDays,

          strategy_validation_days:
            strategyValidationDays,

          risk_calibration_days:
            riskCalibrationDays,

          test_days:
            testDays,

          cost_bps:
            costBps,

          non_overlapping:
            nonOverlapping,

          base_variant_count:
            baseDefinitions.length,

          overlay_variant_count:
            riskDefinitions.length,
        },

        methodology: {
          strategy_selection:
            "The signal rule is selected using the strategy-validation window only.",

          risk_selection:
            "The signal rule is then frozen. Risk overlays are evaluated only on the later risk-calibration window. Eligible overlays require at least 5 trades, positive average return, and profit factor of at least 1.05. Among eligible overlays, lower drawdown is preferred first.",

          test:
            "The next test block is unseen by both signal selection and risk calibration.",

          execution:
            "Daily OHLC bars are used for stop and target checks. Same-bar stop/target ambiguity assumes the stop occurs first.",

          caution:
            "This remains an underlying-stock directional proxy and does not replay historical option-spread prices.",
        },

        summary: {
          folds:
            folds.length,

          completed_folds:
            completedFolds.length,

          skipped_folds:
            folds.length -
            completedFolds.length,

          positive_folds:
            positiveFolds,

          positive_fold_rate:
            completedFolds.length
              ? (
                  positiveFolds /
                  completedFolds.length
                ) *
                100
              : null,

          protected_oos:
            protectedSummary,

          unprotected_oos:
            unprotectedSummary,

          drawdown_improvement_pct_points:
            (
              protectedSummary
                .max_drawdown_pct ??
              0
            ) -
            (
              unprotectedSummary
                .max_drawdown_pct ??
              0
            ),
        },

        robustness_gate:
          robustnessGate,

        base_selection_frequency:
          selectionFrequencyRows(
            baseSelections
          ),

        overlay_selection_frequency:
          selectionFrequencyRows(
            overlaySelections
          ),

        combined_selection_frequency:
          combinedSelectionFrequency,

        protected_oos_by_ticker:
          protectedByTicker,

        unprotected_oos_by_ticker:
          summarizeBySymbol(
            unprotectedOosTrades,
            symbols
          ),

        folds,

        protected_oos_dataset:
          protectedOosTrades.map(
            (trade) => ({
              ticker:
                trade.symbol,

              fold:
                trade.nested_fold,

              signal_time:
                trade.signal_time,

              entry_time:
                trade.entry_time,

              exit_time:
                trade.exit_time,

              signal:
                trade.signal,

              base_rule_id:
                trade.selected_base_rule_id,

              risk_overlay_id:
                trade.risk_overlay_id,

              stop_loss_pct:
                trade.stop_loss_pct,

              profit_target_pct:
                trade.profit_target_pct,

              risk_budget_pct:
                trade.risk_budget_pct,

              allocation_fraction:
                trade.allocation_fraction,

              max_hold_sessions:
                trade.max_hold_sessions,

              realized_hold_sessions:
                trade.hold_sessions,

              exit_reason:
                trade.exit_reason,

              rsi:
                trade.rsi,

              macd_histogram:
                trade.macd_histogram,

              signal_change_pct:
                trade.signal_change_pct,

              entry_open:
                trade.entry_open,

              exit_close:
                trade.exit_close,

              raw_net_return_pct:
                trade.raw_net_return_pct,

              portfolio_return_pct:
                trade.net_return_pct,

              mfe_pct:
                trade.mfe_pct,

              mae_pct:
                trade.mae_pct,

              selected_using_prior_data_only:
                trade.selected_using_prior_data_only,
            })
          ),
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/option-spread-replay",

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
          730,
          180
        );

      const holdDays =
        clampNumber(
          req.body
            ?.holdDays,
          1,
          20,
          5
        );

      const targetDte =
        clampNumber(
          req.body
            ?.targetDte,
          5,
          30,
          9
        );

      const shortDistancePct =
        Math.max(
          1,
          Math.min(
            15,
            Number(
              req.body
                ?.shortDistancePct ??
              4
            ) ||
            4
          )
        );

      const maxSignals =
        clampNumber(
          req.body
            ?.maxSignals,
          1,
          30,
          12
        );

      const directionMode =
        [
          "both",
          "bullish_only",
          "bearish_only",
        ].includes(
          req.body
            ?.directionMode
        )
          ? req.body
              .directionMode
          : "both";

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

      const bars =
        extractBacktestBars(
          unwrapRobinhoodToolResult(
            historicalResult
          )
        );

      const rsiSeries =
        extractBacktestIndicator(
          unwrapRobinhoodToolResult(
            rsiResult
          ),
          "rsi"
        );

      const macdSeries =
        extractBacktestIndicator(
          unwrapRobinhoodToolResult(
            macdResult
          ),
          "macd"
        );

      const signals =
        runDirectionalBacktest({
          bars,
          rsiSeries,
          macdSeries,
          requestedStart,
          holdDays,
          costBps:
            0,
          nonOverlapping:
            true,
          directionMode,
          bullishRsi:
            55,
          bearishRsi:
            45,
          requiredSignals:
            2,
          symbol,
        })
          .filter(
            (trade) =>
              Date.parse(
                trade.exit_time
              ) <
              end.getTime()
          )
          .slice(
            -maxSignals
          );

      const instrumentCache =
        new Map();

      const replayed =
        [];

      const skipped =
        [];

      for (
        const signal of signals
      ) {
        const type =
          signal.signal ===
          "bullish"
            ? "call"
            : "put";

        const entryDate =
          new Date(
            signal.entry_time
          );

        const desiredExpiration =
          nextFridayOnOrAfter(
            addUtcDays(
              entryDate,
              targetDte
            )
          );

        let chosenExpiration =
          null;

        let instruments =
          [];

        for (
          let attempt =
            0;
          attempt <
          4;
          attempt++
        ) {
          const expirationDate =
            addUtcDays(
              desiredExpiration,
              attempt *
                7
            );

          if (
            expirationDate.getTime() >=
            end.getTime()
          ) {
            continue;
          }

          const expiration =
            utcDateKey(
              expirationDate
            );

          const cacheKey =
            symbol +
            "|" +
            expiration +
            "|" +
            type;

          if (
            instrumentCache.has(
              cacheKey
            )
          ) {
            instruments =
              instrumentCache.get(
                cacheKey
              );
          } else {
            instruments =
              await loadExpiredOptionInstruments({
                symbol,
                expiration,
                type,
              });

            instrumentCache.set(
              cacheKey,
              instruments
            );
          }

          if (
            instruments.length >=
            2
          ) {
            chosenExpiration =
              expiration;

            break;
          }
        }

        if (
          !chosenExpiration
        ) {
          skipped.push({
            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            reason:
              "No expired option expiration found after target DTE.",
          });

          continue;
        }

        const vertical =
          chooseHistoricalVertical({
            instruments,
            type,
            spot:
              signal.entry_open,
            shortDistancePct,
          });

        if (!vertical) {
          skipped.push({
            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            expiration:
              chosenExpiration,

            reason:
              "Could not construct an ATM-to-OTM vertical from expired contracts.",
          });

          continue;
        }

        const historyStart =
          addUtcDays(
            new Date(
              signal.entry_time
            ),
            -1
          );

        const plannedExit =
          new Date(
            signal.exit_time
          );

        const historyEnd =
          addUtcDays(
            plannedExit,
            1
          );

        const optionHistoricalResult =
          await callRobinhoodTool(
            "get_option_historicals",
            {
              instrument_ids: [
                vertical
                  .long
                  .id,

                vertical
                  .short
                  .id,
              ],

              start_time:
                historyStart.toISOString(),

              end_time:
                historyEnd.toISOString(),

              interval:
                "day",

              bounds:
                "regular",
            }
          );

        const historyPayload =
          unwrapRobinhoodToolResult(
            optionHistoricalResult
          );

        const results =
          extractOptionHistoricalResults(
            historyPayload
          );

        const longResult =
          results.find(
            (item) =>
              item.instrument_id ===
              vertical.long.id
          );

        const shortResult =
          results.find(
            (item) =>
              item.instrument_id ===
              vertical.short.id
          );

        const longBars =
          normalizeOptionBars(
            longResult
          );

        const shortBars =
          normalizeOptionBars(
            shortResult
          );

        const entryKey =
          utcDateKey(
            signal.entry_time
          );

        const exitKey =
          utcDateKey(
            signal.exit_time
          );

        const longEntry =
          longBars.find(
            (bar) =>
              bar.date ===
              entryKey
          );

        const shortEntry =
          shortBars.find(
            (bar) =>
              bar.date ===
              entryKey
          );

        const longExit =
          longBars.find(
            (bar) =>
              bar.date ===
              exitKey
          );

        const shortExit =
          shortBars.find(
            (bar) =>
              bar.date ===
              exitKey
          );

        if (
          !longEntry ||
          !shortEntry ||
          !longExit ||
          !shortExit
        ) {
          skipped.push({
            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            expiration:
              chosenExpiration,

            long_strike:
              vertical
                .long
                .strike,

            short_strike:
              vertical
                .short
                .strike,

            reason:
              "Historical option bars were missing on the exact entry or exit date.",
          });

          continue;
        }

        const rawEntryDebit =
          longEntry.open -
          shortEntry.open;

        if (
          rawEntryDebit <=
            0 ||
          rawEntryDebit >=
            vertical.width
        ) {
          skipped.push({
            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            expiration:
              chosenExpiration,

            long_strike:
              vertical
                .long
                .strike,

            short_strike:
              vertical
                .short
                .strike,

            reason:
              "Historical trade-price bars produced an invalid vertical entry debit.",
          });

          continue;
        }

        const rawExitValue =
          longExit.close -
          shortExit.close;

        const exitValue =
          Math.max(
            0,
            Math.min(
              vertical.width,
              rawExitValue
            )
          );

        const pnlDollars =
          (
            exitValue -
            rawEntryDebit
          ) *
          100;

        const returnOnDebitPct =
          (
            (
              exitValue -
              rawEntryDebit
            ) /
            rawEntryDebit
          ) *
          100;

        const shortByDate =
          new Map(
            shortBars.map(
              (bar) => [
                bar.date,
                bar,
              ]
            )
          );

        const closePath =
          longBars
            .filter(
              (bar) =>
                bar.date >=
                  entryKey &&
                bar.date <=
                  exitKey &&
                shortByDate.has(
                  bar.date
                )
            )
            .map(
              (bar) => {
                const shortBar =
                  shortByDate.get(
                    bar.date
                  );

                const value =
                  Math.max(
                    0,
                    Math.min(
                      vertical.width,
                      bar.close -
                      shortBar.close
                    )
                  );

                return {
                  date:
                    bar.date,

                  spread_value:
                    value,

                  return_pct:
                    (
                      (
                        value -
                        rawEntryDebit
                      ) /
                      rawEntryDebit
                    ) *
                    100,
                };
              }
            );

        const closeReturns =
          closePath.map(
            (row) =>
              row.return_pct
          );

        const expirationDate =
          new Date(
            chosenExpiration +
            "T00:00:00Z"
          );

        const dte =
          Math.round(
            (
              expirationDate.getTime() -
              entryDate.getTime()
            ) /
              (
                24 *
                60 *
                60 *
                1000
              )
          );

        replayed.push({
          id:
            symbol +
            "|" +
            signal.signal_time +
            "|" +
            chosenExpiration +
            "|" +
            type,

          symbol,

          signal:
            signal.signal,

          signal_time:
            signal.signal_time,

          entry_time:
            signal.entry_time,

          exit_time:
            signal.exit_time,

          entry_underlying:
            signal.entry_open,

          exit_underlying:
            signal.exit_close,

          rsi:
            signal.rsi,

          macd_histogram:
            signal.macd_histogram,

          option_type:
            type,

          expiration:
            chosenExpiration,

          entry_dte:
            dte,

          long_option_id:
            vertical.long.id,

          short_option_id:
            vertical.short.id,

          long_strike:
            vertical.long.strike,

          short_strike:
            vertical.short.strike,

          spread_width:
            vertical.width,

          entry_long_open:
            longEntry.open,

          entry_short_open:
            shortEntry.open,

          entry_debit:
            rawEntryDebit,

          exit_long_close:
            longExit.close,

          exit_short_close:
            shortExit.close,

          exit_spread_value:
            exitValue,

          pnl_dollars:
            pnlDollars,

          return_on_debit_pct:
            returnOnDebitPct,

          close_path_mfe_pct:
            closeReturns.length
              ? Math.max(
                  ...closeReturns
                )
              : null,

          close_path_mae_pct:
            closeReturns.length
              ? Math.min(
                  ...closeReturns
                )
              : null,

          close_path:
            closePath,

          favorable:
            pnlDollars >
            0,
        });
      }

      replayed.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "historical_option_vertical_replay_v1",

        symbol,

        methodology: {
          signal:
            "Current scanner rule: RSI 55/45, MACD histogram sign, and daily move; 2 of 3 aligned signals.",

          structure:
            "Bullish signals use call debit spreads; bearish signals use put debit spreads. The long strike is nearest the historical underlying entry price. The short strike is chosen near the configured OTM distance.",

          expiration:
            "The replay searches for the first expired Friday expiration on or after the target DTE, then up to three later weekly dates.",

          pricing:
            "Entry debit uses each leg's historical option daily open trade price. Exit value uses each leg's historical daily close trade price. These are trade-price proxies, not synchronized bid/ask quotes.",

          path:
            "MFE and MAE use synchronized daily closing spread values only, not intraday spread quotes.",

          caution:
            "Historical Greeks, IV surfaces, bid/ask spreads, volume, open interest, and assignment are not reconstructed in this v1 replay.",
        },

        parameters: {
          lookback_days:
            lookbackDays,

          hold_sessions:
            holdDays,

          target_dte:
            targetDte,

          short_distance_pct:
            shortDistancePct,

          max_signals:
            maxSignals,

          direction_mode:
            directionMode,
        },

        signal_count:
          signals.length,

        replayed_count:
          replayed.length,

        skipped_count:
          skipped.length,

        summary:
          summarizeOptionReplay(
            replayed
          ),

        trades:
          replayed,

        skipped,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/option-replay-research",

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
          120,
          730,
          365
        );

      const maxSignalsPerHold =
        clampNumber(
          req.body
            ?.maxSignalsPerHold,
          8,
          40,
          24
        );

      const holdVariants = [
        1,
        3,
        5,
        10,
      ];

      const targetDteVariants = [
        7,
        9,
        14,
        21,
      ];

      const shortDistanceVariants = [
        2,
        4,
        6,
        8,
      ];

      const directionModes = [
        "both",
        "bullish_only",
        "bearish_only",
      ];

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

      const bars =
        extractBacktestBars(
          unwrapRobinhoodToolResult(
            historicalResult
          )
        );

      const rsiSeries =
        extractBacktestIndicator(
          unwrapRobinhoodToolResult(
            rsiResult
          ),
          "rsi"
        );

      const macdSeries =
        extractBacktestIndicator(
          unwrapRobinhoodToolResult(
            macdResult
          ),
          "macd"
        );

      const signalsByHold =
        new Map();

      for (
        const holdDays of holdVariants
      ) {
        const signals =
          runDirectionalBacktest({
            bars,
            rsiSeries,
            macdSeries,
            requestedStart,
            holdDays,
            costBps:
              0,
            nonOverlapping:
              true,
            directionMode:
              "both",
            bullishRsi:
              55,
            bearishRsi:
              45,
            requiredSignals:
              2,
            symbol,
          })
            .filter(
              (trade) =>
                Date.parse(
                  trade.exit_time
                ) <
                end.getTime()
            )
            .slice(
              -maxSignalsPerHold
            );

        signalsByHold.set(
          holdDays,
          signals
        );
      }

      const instrumentCache =
        new Map();

      const verticalCache =
        new Map();

      const specs =
        [];

      const setupSkips =
        [];

      async function resolveVertical({
        signal,
        targetDte,
        shortDistancePct,
      }) {
        const type =
          signal.signal ===
          "bullish"
            ? "call"
            : "put";

        const entryDate =
          new Date(
            signal.entry_time
          );

        const entryKey =
          utcDateKey(
            entryDate
          );

        const verticalKey =
          [
            entryKey,
            type,
            targetDte,
            shortDistancePct,
          ].join(
            "|"
          );

        if (
          verticalCache.has(
            verticalKey
          )
        ) {
          return verticalCache.get(
            verticalKey
          );
        }

        const desiredExpiration =
          nextFridayOnOrAfter(
            addUtcDays(
              entryDate,
              targetDte
            )
          );

        let resolved =
          null;

        for (
          let attempt =
            0;
          attempt <
          4;
          attempt++
        ) {
          const expirationDate =
            addUtcDays(
              desiredExpiration,
              attempt *
                7
            );

          if (
            expirationDate.getTime() >=
            end.getTime()
          ) {
            continue;
          }

          const expiration =
            utcDateKey(
              expirationDate
            );

          const cacheKey =
            symbol +
            "|" +
            expiration +
            "|" +
            type;

          let instruments =
            instrumentCache.get(
              cacheKey
            );

          if (!instruments) {
            instruments =
              await loadExpiredOptionInstruments({
                symbol,
                expiration,
                type,
              });

            instrumentCache.set(
              cacheKey,
              instruments
            );
          }

          const vertical =
            chooseHistoricalVertical({
              instruments,
              type,
              spot:
                signal.entry_open,
              shortDistancePct,
            });

          if (!vertical) {
            continue;
          }

          resolved = {
            type,
            expiration,
            vertical,
          };

          break;
        }

        verticalCache.set(
          verticalKey,
          resolved
        );

        return resolved;
      }

      for (
        const holdDays of holdVariants
      ) {
        const signals =
          signalsByHold.get(
            holdDays
          ) ??
          [];

        for (
          const signal of signals
        ) {
          for (
            const targetDte of targetDteVariants
          ) {
            for (
              const shortDistancePct of shortDistanceVariants
            ) {
              const resolved =
                await resolveVertical({
                  signal,
                  targetDte,
                  shortDistancePct,
                });

              if (!resolved) {
                setupSkips.push({
                  hold_days:
                    holdDays,

                  target_dte:
                    targetDte,

                  short_distance_pct:
                    shortDistancePct,

                  signal_time:
                    signal.signal_time,

                  entry_time:
                    signal.entry_time,

                  signal:
                    signal.signal,

                  reason:
                    "No usable expired vertical could be constructed.",
                });

                continue;
              }

              specs.push({
                signal,
                holdDays,
                targetDte,
                shortDistancePct,
                type:
                  resolved.type,
                expiration:
                  resolved.expiration,
                vertical:
                  resolved.vertical,
              });
            }
          }
        }
      }

      const optionIds =
        [
          ...new Set(
            specs.flatMap(
              (spec) => [
                spec.vertical
                  .long
                  .id,
                spec.vertical
                  .short
                  .id,
              ]
            )
          ),
        ];

      const optionHistoryById =
        new Map();

      for (
        let index =
          0;
        index <
        optionIds.length;
        index +=
          10
      ) {
        const batch =
          optionIds.slice(
            index,
            index +
              10
          );

        const historical =
          await callRobinhoodTool(
            "get_option_historicals",
            {
              instrument_ids:
                batch,

              start_time:
                fetchStart.toISOString(),

              end_time:
                end.toISOString(),

              interval:
                "day",

              bounds:
                "regular",
            }
          );

        const payload =
          unwrapRobinhoodToolResult(
            historical
          );

        const results =
          extractOptionHistoricalResults(
            payload
          );

        for (
          const result of results
        ) {
          optionHistoryById.set(
            result.instrument_id,
            normalizeOptionBars(
              result
            )
          );
        }
      }

      const rowsByVariant =
        new Map();

      const replaySkips =
        [];

      for (
        const spec of specs
      ) {
        const {
          signal,
          holdDays,
          targetDte,
          shortDistancePct,
          type,
          expiration,
          vertical,
        } = spec;

        const longBars =
          optionHistoryById.get(
            vertical.long.id
          ) ??
          [];

        const shortBars =
          optionHistoryById.get(
            vertical.short.id
          ) ??
          [];

        const entryKey =
          utcDateKey(
            signal.entry_time
          );

        const exitKey =
          utcDateKey(
            signal.exit_time
          );

        const longEntry =
          longBars.find(
            (bar) =>
              bar.date ===
              entryKey
          );

        const shortEntry =
          shortBars.find(
            (bar) =>
              bar.date ===
              entryKey
          );

        const longExit =
          longBars.find(
            (bar) =>
              bar.date ===
              exitKey
          );

        const shortExit =
          shortBars.find(
            (bar) =>
              bar.date ===
              exitKey
          );

        if (
          !longEntry ||
          !shortEntry ||
          !longExit ||
          !shortExit
        ) {
          replaySkips.push({
            hold_days:
              holdDays,

            target_dte:
              targetDte,

            short_distance_pct:
              shortDistancePct,

            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            expiration,

            reason:
              "Missing exact historical option bar on entry or exit date.",
          });

          continue;
        }

        const entryDebit =
          longEntry.open -
          shortEntry.open;

        if (
          entryDebit <=
            0 ||
          entryDebit >=
            vertical.width
        ) {
          replaySkips.push({
            hold_days:
              holdDays,

            target_dte:
              targetDte,

            short_distance_pct:
              shortDistancePct,

            signal_time:
              signal.signal_time,

            entry_time:
              signal.entry_time,

            expiration,

            reason:
              "Historical leg trade prices produced an invalid debit.",
          });

          continue;
        }

        const exitValue =
          Math.max(
            0,
            Math.min(
              vertical.width,
              longExit.close -
              shortExit.close
            )
          );

        const pnlDollars =
          (
            exitValue -
            entryDebit
          ) *
          100;

        const returnPct =
          (
            (
              exitValue -
              entryDebit
            ) /
            entryDebit
          ) *
          100;

        const shortByDate =
          new Map(
            shortBars.map(
              (bar) => [
                bar.date,
                bar,
              ]
            )
          );

        const closeReturns =
          longBars
            .filter(
              (bar) =>
                bar.date >=
                  entryKey &&
                bar.date <=
                  exitKey &&
                shortByDate.has(
                  bar.date
                )
            )
            .map(
              (bar) => {
                const shortBar =
                  shortByDate.get(
                    bar.date
                  );

                const value =
                  Math.max(
                    0,
                    Math.min(
                      vertical.width,
                      bar.close -
                      shortBar.close
                    )
                  );

                return (
                  (
                    value -
                    entryDebit
                  ) /
                  entryDebit
                ) *
                  100;
              }
            );

        const dte =
          Math.round(
            (
              Date.parse(
                expiration +
                "T00:00:00Z"
              ) -
              Date.parse(
                signal.entry_time
              )
            ) /
              (
                24 *
                60 *
                60 *
                1000
              )
          );

        const row = {
          id:
            [
              signal.signal_time,
              holdDays,
              targetDte,
              shortDistancePct,
              type,
            ].join(
              "|"
            ),

          symbol,

          signal:
            signal.signal,

          signal_time:
            signal.signal_time,

          entry_time:
            signal.entry_time,

          exit_time:
            signal.exit_time,

          rsi:
            signal.rsi,

          macd_histogram:
            signal.macd_histogram,

          hold_sessions:
            holdDays,

          target_dte:
            targetDte,

          short_distance_pct:
            shortDistancePct,

          option_type:
            type,

          expiration,

          entry_dte:
            dte,

          long_strike:
            vertical.long.strike,

          short_strike:
            vertical.short.strike,

          spread_width:
            vertical.width,

          entry_debit:
            entryDebit,

          exit_spread_value:
            exitValue,

          pnl_dollars:
            pnlDollars,

          return_on_debit_pct:
            returnPct,

          close_path_mfe_pct:
            closeReturns.length
              ? Math.max(
                  ...closeReturns
                )
              : null,

          close_path_mae_pct:
            closeReturns.length
              ? Math.min(
                  ...closeReturns
                )
              : null,
        };

        const variantKey =
          optionReplayVariantKey({
            holdDays,
            targetDte,
            shortDistancePct,
          });

        if (
          !rowsByVariant.has(
            variantKey
          )
        ) {
          rowsByVariant.set(
            variantKey,
            []
          );
        }

        rowsByVariant.get(
          variantKey
        ).push(
          row
        );
      }

      const trainBoundary =
        new Date(
          requestedStart.getTime() +
          (
            end.getTime() -
            requestedStart.getTime()
          ) *
            0.6
        );

      const validationBoundary =
        new Date(
          requestedStart.getTime() +
          (
            end.getTime() -
            requestedStart.getTime()
          ) *
            0.8
        );

      const variants =
        [];

      for (
        const directionMode of directionModes
      ) {
        for (
          const holdDays of holdVariants
        ) {
          for (
            const targetDte of targetDteVariants
          ) {
            for (
              const shortDistancePct of shortDistanceVariants
            ) {
              const variantKey =
                optionReplayVariantKey({
                  holdDays,
                  targetDte,
                  shortDistancePct,
                });

              let rows =
                rowsByVariant.get(
                  variantKey
                ) ??
                [];

              if (
                directionMode ===
                "bullish_only"
              ) {
                rows =
                  rows.filter(
                    (row) =>
                      row.signal ===
                      "bullish"
                  );
              }

              if (
                directionMode ===
                "bearish_only"
              ) {
                rows =
                  rows.filter(
                    (row) =>
                      row.signal ===
                      "bearish"
                  );
              }

              const split =
                splitReplayRowsByDate({
                  rows,
                  trainBoundary,
                  validationBoundary,
                });

              const train =
                summarizeOptionReplay(
                  split.train
                );

              const validation =
                summarizeOptionReplay(
                  split.validation
                );

              const test =
                summarizeOptionReplay(
                  split.test
                );

              const validationScore =
                optionReplayResearchScore(
                  validation
                );

              variants.push({
                id:
                  [
                    directionMode,
                    holdDays,
                    targetDte,
                    shortDistancePct,
                  ].join(
                    "|"
                  ),

                parameters: {
                  direction_mode:
                    directionMode,

                  hold_sessions:
                    holdDays,

                  target_dte:
                    targetDte,

                  short_distance_pct:
                    shortDistancePct,
                },

                train,
                validation,
                test,

                overall:
                  summarizeOptionReplay(
                    rows
                  ),

                validation_score:
                  validationScore,
              });
            }
          }
        }
      }

      const eligible =
        variants
          .filter(
            (variant) =>
              variant.validation_score !==
                null &&
              variant.train.trades >=
                6 &&
              variant.validation.trades >=
                4
          )
          .sort(
            (a, b) =>
              b.validation_score -
                a.validation_score ||
              (
                b.validation
                  .profit_factor ??
                -Infinity
              ) -
                (
                  a.validation
                    .profit_factor ??
                  -Infinity
                )
          );

      const selected =
        eligible[0] ??
        null;

      const baseline =
        variants.find(
          (variant) =>
            variant.parameters
              .direction_mode ===
              "both" &&
            variant.parameters
              .hold_sessions ===
              5 &&
            variant.parameters
              .target_dte ===
              9 &&
            variant.parameters
              .short_distance_pct ===
              4
        ) ??
        null;

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "option_replay_research_lab_v1",

        symbol,

        methodology: {
          signal_rule:
            "Scanner directional signal remains fixed at RSI 55/45, MACD histogram sign, daily move, with 2 of 3 aligned.",

          search:
            "Searches direction, hold sessions, target DTE, and short-strike OTM distance using historical expired vertical spreads.",

          selection:
            "Candidate selection uses validation data only. Eligibility requires at least 6 training replays and 4 validation replays. The recent 20% test is not used for selection.",

          score:
            "Validation score = average spread return on debit minus 10% of absolute average close-path MAE.",

          pricing:
            "Historical option trade OHLC bars are used as a proxy for synchronized spread fills. Historical bid/ask and Greeks are not reconstructed.",
        },

        split_dates: {
          requested_start:
            requestedStart.toISOString(),

          train_end:
            trainBoundary.toISOString(),

          validation_end:
            validationBoundary.toISOString(),

          end:
            end.toISOString(),
        },

        search_space: {
          direction_modes:
            directionModes,

          hold_sessions:
            holdVariants,

          target_dte:
            targetDteVariants,

          short_distance_pct:
            shortDistanceVariants,

          variant_count:
            variants.length,

          max_signals_per_hold:
            maxSignalsPerHold,
        },

        coverage: {
          unique_option_contracts:
            optionIds.length,

          replay_rows:
            [
              ...rowsByVariant.values(),
            ].reduce(
              (
                total,
                rows
              ) =>
                total +
                rows.length,
              0
            ),

          setup_skips:
            setupSkips.length,

          replay_skips:
            replaySkips.length,
        },

        baseline,

        selected_candidate:
          selected,

        top_candidates:
          eligible.slice(
            0,
            15
          ),

        skip_examples: [
          ...setupSkips,
          ...replaySkips,
        ].slice(
          0,
          30
        ),
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);


app.post(
  "/scanner/option-replay-walk-forward",

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
          365,
          730,
          730
        );

      const trainCoverageDates =
        clampNumber(
          req.body
            ?.trainCoverageDates,
          12,
          60,
          60
        );

      const validationCoverageDates =
        clampNumber(
          req.body
            ?.validationCoverageDates,
          6,
          30,
          24
        );

      const testCoverageDates =
        clampNumber(
          req.body
            ?.testCoverageDates,
          4,
          24,
          8
        );

      const maxSignalsPerHold =
        clampNumber(
          req.body
            ?.maxSignalsPerHold,
          20,
          60,
          60
        );

      const holdVariants = [
        1,
        3,
        5,
        10,
      ];

      const targetDteVariants = [
        7,
        9,
        14,
        21,
      ];

      const shortDistanceVariants = [
        2,
        4,
        6,
        8,
      ];

      const directionModes = [
        "both",
        "bullish_only",
        "bearish_only",
      ];

      const dataset =
        await buildOptionReplayRows({
          symbol,
          lookbackDays,
          maxSignalsPerHold,
          holdVariants,
          targetDteVariants,
          shortDistanceVariants,
        });

      const {
        rowsByVariant,
        coverage,
        skipExamples,
      } = dataset;

      const coverageDetail =
        buildOptionCoverageDetail({
          rowsByVariant,
          coverage,
        });

      const coverageDates =
        coverageDetail
          .coverage_dates;

      const minimumDatesNeeded =
        trainCoverageDates +
        validationCoverageDates +
        testCoverageDates;

      if (
        coverageDates.length <
        minimumDatesNeeded
      ) {
        return res.json({
          generated_at:
            new Date().toISOString(),

          engine:
            "option_replay_walk_forward_coverage_v2",

          symbol,

          parameters: {
            lookback_days:
              lookbackDays,

            train_coverage_dates:
              trainCoverageDates,

            validation_coverage_dates:
              validationCoverageDates,

            test_coverage_dates:
              testCoverageDates,

            max_signals_per_hold:
              maxSignalsPerHold,

            variant_count:
              192,
          },

          methodology: {
            selection:
              "Coverage-aware folds are built from actual replayable option signal dates rather than empty calendar periods.",

            eligibility:
              "A structure still requires at least 20 training replays, 8 validation replays, positive validation average return, and validation profit factor of at least 1.10.",

            caution:
              "There are not enough replayable signal dates to create even one full coverage-aware fold with the requested settings.",
          },

          coverage,

          coverage_detail:
            coverageDetail,

          summary: {
            folds:
              0,

            completed_folds:
              0,

            skipped_folds:
              0,

            positive_test_folds:
              0,

            positive_test_fold_rate:
              null,

            selected_oos:
              summarizeOptionReplay(
                []
              ),

            baseline_oos:
              summarizeOptionReplay(
                []
              ),
          },

          selection_frequency:
            [],

          folds:
            [],

          selected_oos_dataset:
            [],

          skip_examples:
            skipExamples,
        });
      }

      const definitions =
        [];

      for (
        const directionMode of directionModes
      ) {
        for (
          const holdDays of holdVariants
        ) {
          for (
            const targetDte of targetDteVariants
          ) {
            for (
              const shortDistancePct of shortDistanceVariants
            ) {
              definitions.push({
                id:
                  [
                    directionMode,
                    holdDays,
                    targetDte,
                    shortDistancePct,
                  ].join(
                    "|"
                  ),

                directionMode,
                holdDays,
                targetDte,
                shortDistancePct,
              });
            }
          }
        }
      }

      const folds =
        [];

      const selectedOosRows =
        [];

      const baselineOosRows =
        [];

      const selections =
        [];

      const baselineDefinition = {
        directionMode:
          "both",

        holdDays:
          5,

        targetDte:
          9,

        shortDistancePct:
          4,
      };

      function rowsForDefinition(
        definition
      ) {
        const key =
          optionReplayVariantKey({
            holdDays:
              definition.holdDays,

            targetDte:
              definition.targetDte,

            shortDistancePct:
              definition.shortDistancePct,
          });

        let rows =
          rowsByVariant.get(
            key
          ) ??
          [];

        if (
          definition.directionMode ===
          "bullish_only"
        ) {
          rows =
            rows.filter(
              (row) =>
                row.signal ===
                "bullish"
            );
        }

        if (
          definition.directionMode ===
          "bearish_only"
        ) {
          rows =
            rows.filter(
              (row) =>
                row.signal ===
                "bearish"
            );
        }

        return rows;
      }

      let trainDateCount =
        trainCoverageDates;

      let foldIndex =
        1;

      while (
        trainDateCount +
          validationCoverageDates +
          testCoverageDates <=
        coverageDates.length
      ) {
        const trainDates =
          coverageDates.slice(
            0,
            trainDateCount
          );

        const validationDates =
          coverageDates.slice(
            trainDateCount,
            trainDateCount +
              validationCoverageDates
          );

        const testDates =
          coverageDates.slice(
            trainDateCount +
              validationCoverageDates,
            trainDateCount +
              validationCoverageDates +
              testCoverageDates
          );

        const trainDateSet =
          new Set(
            trainDates
          );

        const validationDateSet =
          new Set(
            validationDates
          );

        const testDateSet =
          new Set(
            testDates
          );

        const candidates =
          [];

        for (
          const definition of definitions
        ) {
          const rows =
            rowsForDefinition(
              definition
            );

          const trainRows =
            rows.filter(
              (row) =>
                trainDateSet.has(
                  utcDateKey(
                    row.signal_time
                  )
                )
            );

          const validationRows =
            rows.filter(
              (row) =>
                validationDateSet.has(
                  utcDateKey(
                    row.signal_time
                  )
                )
            );

          const testRows =
            rows.filter(
              (row) =>
                testDateSet.has(
                  utcDateKey(
                    row.signal_time
                  )
                )
            );

          const trainSummary =
            summarizeOptionReplay(
              trainRows
            );

          const validationSummary =
            summarizeOptionReplay(
              validationRows
            );

          if (
            trainSummary.trades <
              20 ||
            validationSummary.trades <
              8 ||
            (
              validationSummary
                .average_return_on_debit_pct ??
              0
            ) <=
              0 ||
            (
              validationSummary
                .profit_factor ??
              0
            ) <
              1.1
          ) {
            continue;
          }

          const score =
            optionReplayResearchScore(
              validationSummary
            );

          if (
            score ===
            null
          ) {
            continue;
          }

          candidates.push({
            id:
              definition.id,

            parameters: {
              direction_mode:
                definition
                  .directionMode,

              hold_sessions:
                definition
                  .holdDays,

              target_dte:
                definition
                  .targetDte,

              short_distance_pct:
                definition
                  .shortDistancePct,
            },

            train:
              trainSummary,

            validation:
              validationSummary,

            test:
              summarizeOptionReplay(
                testRows
              ),

            score,

            testRows,
          });
        }

        candidates.sort(
          (a, b) =>
            b.score -
              a.score ||
            (
              b.validation
                .profit_factor ??
              -Infinity
            ) -
              (
                a.validation
                  .profit_factor ??
                -Infinity
              )
        );

        const selected =
          candidates[0] ??
          null;

        if (
          selected
        ) {
          selections.push({
            id:
              selected.id,

            parameters:
              selected.parameters,
          });

          selectedOosRows.push(
            ...selected.testRows.map(
              (row) => ({
                ...row,

                walk_forward_fold:
                  foldIndex,

                selected_rule_id:
                  selected.id,

                selected_using_prior_data_only:
                  true,
              })
            )
          );
        }

        const baselineRows =
          rowsForDefinition(
            baselineDefinition
          ).filter(
            (row) =>
              testDateSet.has(
                utcDateKey(
                  row.signal_time
                )
              )
          );

        baselineOosRows.push(
          ...baselineRows.map(
            (row) => ({
              ...row,

              walk_forward_fold:
                foldIndex,
            })
          )
        );

        folds.push({
          fold:
            foldIndex,

          train_signal_dates:
            trainDates.length,

          validation_signal_dates:
            validationDates.length,

          test_signal_dates:
            testDates.length,

          train_start:
            trainDates[0] ??
            null,

          train_end:
            trainDates[
              trainDates.length -
              1
            ] ??
            null,

          validation_start:
            validationDates[0] ??
            null,

          validation_end:
            validationDates[
              validationDates.length -
              1
            ] ??
            null,

          test_start:
            testDates[0] ??
            null,

          test_end:
            testDates[
              testDates.length -
              1
            ] ??
            null,

          eligible_candidate_count:
            candidates.length,

          selected_candidate:
            selected
              ? {
                  id:
                    selected.id,

                  parameters:
                    selected.parameters,

                  train:
                    selected.train,

                  validation:
                    selected.validation,

                  test:
                    selected.test,

                  validation_score:
                    selected.score,
                }
              : null,

          baseline_test:
            summarizeOptionReplay(
              baselineRows
            ),
        });

        trainDateCount +=
          testCoverageDates;

        foldIndex +=
          1;
      }

      selectedOosRows.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      baselineOosRows.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      const completedFolds =
        folds.filter(
          (fold) =>
            !!fold
              .selected_candidate
        );

      const positiveFolds =
        completedFolds.filter(
          (fold) =>
            (
              fold
                .selected_candidate
                ?.test
                ?.total_pnl_dollars ??
              0
            ) >
            0
        ).length;

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "option_replay_walk_forward_coverage_v2",

        symbol,

        parameters: {
          lookback_days:
            lookbackDays,

          train_coverage_dates:
            trainCoverageDates,

          validation_coverage_dates:
            validationCoverageDates,

          test_coverage_dates:
            testCoverageDates,

          max_signals_per_hold:
            maxSignalsPerHold,

          variant_count:
            definitions.length,
        },

        methodology: {
          selection:
            "Folds are aligned to actual replayable option signal dates rather than fixed calendar windows. Each fold searches direction, hold, target DTE, and short-strike distance using only prior option replays.",

          eligibility:
            "A structure still requires at least 20 training replays, 8 validation replays, positive validation average return, and validation profit factor of at least 1.10.",

          rolling:
            "Training expands by the number of signal dates in one test block. The next replayable signal-date block remains unseen until after selection.",

          pricing:
            "Expired option daily trade-price OHLC bars are used as a spread-fill proxy. Historical synchronized bid/ask quotes and Greeks are not reconstructed.",

          caution:
            "Coverage-aware folds prevent empty validation windows, but they do not create historical data that Robinhood does not provide.",
        },

        coverage,

        coverage_detail:
          coverageDetail,

        summary: {
          folds:
            folds.length,

          completed_folds:
            completedFolds.length,

          skipped_folds:
            folds.length -
            completedFolds.length,

          positive_test_folds:
            positiveFolds,

          positive_test_fold_rate:
            completedFolds.length
              ? (
                  positiveFolds /
                  completedFolds.length
                ) *
                100
              : null,

          selected_oos:
            summarizeOptionReplay(
              selectedOosRows
            ),

          baseline_oos:
            summarizeOptionReplay(
              baselineOosRows
            ),
        },

        selection_frequency:
          selectionFrequencyRows(
            selections
          ),

        folds,

        selected_oos_dataset:
          selectedOosRows.map(
            (row) => ({
              symbol:
                row.symbol,

              fold:
                row.walk_forward_fold,

              selected_rule_id:
                row.selected_rule_id,

              selected_using_prior_data_only:
                row.selected_using_prior_data_only,

              signal:
                row.signal,

              signal_time:
                row.signal_time,

              entry_time:
                row.entry_time,

              exit_time:
                row.exit_time,

              rsi:
                row.rsi,

              macd_histogram:
                row.macd_histogram,

              signal_change_pct:
                row.signal_change_pct,

              hold_sessions:
                row.hold_sessions,

              target_dte:
                row.target_dte,

              short_distance_pct:
                row.short_distance_pct,

              option_type:
                row.option_type,

              expiration:
                row.expiration,

              entry_dte:
                row.entry_dte,

              long_strike:
                row.long_strike,

              short_strike:
                row.short_strike,

              spread_width:
                row.spread_width,

              entry_debit:
                row.entry_debit,

              exit_spread_value:
                row.exit_spread_value,

              pnl_dollars:
                row.pnl_dollars,

              return_on_debit_pct:
                row.return_on_debit_pct,

              close_path_mfe_pct:
                row.close_path_mfe_pct,

              close_path_mae_pct:
                row.close_path_mae_pct,
            })
          ),

        skip_examples:
          skipExamples,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);



app.post(
  "/scanner/option-execution-stress",

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
          365,
          730,
          730
        );

      const trainCoverageDates =
        clampNumber(
          req.body
            ?.trainCoverageDates,
          12,
          90,
          60
        );

      const validationCoverageDates =
        clampNumber(
          req.body
            ?.validationCoverageDates,
          6,
          45,
          24
        );

      const testCoverageDates =
        clampNumber(
          req.body
            ?.testCoverageDates,
          4,
          24,
          8
        );

      const maxSignalsPerHold =
        clampNumber(
          req.body
            ?.maxSignalsPerHold,
          20,
          80,
          60
        );

      const feePerContractPerLeg =
        Math.max(
          0,
          Number(
            req.body
              ?.feePerContractPerLeg ??
            0
          ) ||
          0
        );

      const frictionTiers =
        Array.isArray(
          req.body
            ?.frictionTiers
        )
          ? req.body
              .frictionTiers
              .map(
                (value) =>
                  Math.max(
                    0,
                    Math.min(
                      200,
                      Number(
                        value
                      ) ||
                      0
                    )
                  )
              )
              .filter(
                (
                  value,
                  index,
                  array
                ) =>
                  array.indexOf(
                    value
                  ) ===
                  index
              )
          : [
              0,
              5,
              10,
              25,
              50,
            ];

      const holdVariants = [
        1,
        3,
        5,
        10,
      ];

      const targetDteVariants = [
        7,
        9,
        14,
        21,
      ];

      const shortDistanceVariants = [
        2,
        4,
        6,
        8,
      ];

      const dataset =
        await buildOptionReplayRows({
          symbol,
          lookbackDays,
          maxSignalsPerHold,
          holdVariants,
          targetDteVariants,
          shortDistanceVariants,
        });

      const {
        rowsByVariant,
        coverage,
      } = dataset;

      const coverageDetail =
        buildOptionCoverageDetail({
          rowsByVariant,
          coverage,
        });

      const coverageDates =
        coverageDetail
          .coverage_dates;

      const baselineDefinition = {
        directionMode:
          "both",

        holdDays:
          5,

        targetDte:
          9,

        shortDistancePct:
          4,
      };

      const baselineKey =
        optionReplayVariantKey({
          holdDays:
            baselineDefinition
              .holdDays,

          targetDte:
            baselineDefinition
              .targetDte,

          shortDistancePct:
            baselineDefinition
              .shortDistancePct,
        });

      const baselineRows =
        rowsByVariant.get(
          baselineKey
        ) ??
        [];

      const oosRows =
        [];

      let trainDateCount =
        trainCoverageDates;

      let foldIndex =
        1;

      while (
        trainDateCount +
          validationCoverageDates +
          testCoverageDates <=
        coverageDates.length
      ) {
        const testDates =
          coverageDates.slice(
            trainDateCount +
              validationCoverageDates,
            trainDateCount +
              validationCoverageDates +
              testCoverageDates
          );

        const testDateSet =
          new Set(
            testDates
          );

        const foldRows =
          baselineRows.filter(
            (row) =>
              testDateSet.has(
                utcDateKey(
                  row.signal_time
                )
              )
          );

        oosRows.push(
          ...foldRows.map(
            (row) => ({
              ...row,

              execution_stress_fold:
                foldIndex,
            })
          )
        );

        trainDateCount +=
          testCoverageDates;

        foldIndex +=
          1;
      }

      oosRows.sort(
        (a, b) =>
          Date.parse(
            a.exit_time
          ) -
          Date.parse(
            b.exit_time
          )
      );

      const scenarios =
        frictionTiers.map(
          (roundTripFrictionCents) =>
            buildExecutionStressScenario({
              rows:
                oosRows,

              roundTripFrictionCents,
              feePerContractPerLeg,
            })
        );

      const rawSummary =
        summarizeOptionReplay(
          oosRows
        );

      const averageRawPnl =
        finiteNumber(
          rawSummary
            .average_pnl_dollars
        );

      const totalRoundTripFees =
        feePerContractPerLeg *
        4;

      const approximateBreakEvenFrictionCents =
        averageRawPnl !==
          null
          ? Math.max(
              0,
              averageRawPnl -
                totalRoundTripFees
            )
          : null;

      const positiveScenarios =
        scenarios.filter(
          (scenario) =>
            (
              scenario.summary
                ?.average_pnl_dollars ??
              0
            ) >
              0 &&
            (
              scenario.summary
                ?.profit_factor ??
              0
            ) >
              1
        );

      return res.json({
        generated_at:
          new Date().toISOString(),

        engine:
          "option_execution_stress_v1",

        symbol,

        baseline_structure: {
          direction_mode:
            "both",

          hold_sessions:
            5,

          target_dte:
            9,

          short_distance_pct:
            4,
        },

        methodology: {
          sample:
            "Uses the same coverage-aware unseen test blocks as the fixed PLTR option baseline: 5-session hold, target 9 DTE, short leg 4% OTM.",

          friction:
            "Round-trip spread friction is split equally between entry and exit. For example, 10 cents round-trip adds 5 cents to the entry debit and subtracts 5 cents from the exit spread value.",

          fees:
            "Fee input is dollars per contract per leg. A one-lot vertical incurs four contract-leg events round trip: two legs on entry and two on exit.",

          caution:
            "Historical synchronized bid/ask quotes are unavailable in this replay, so these are execution stress assumptions layered on historical option trade-price OHLC.",
        },

        parameters: {
          lookback_days:
            lookbackDays,

          train_coverage_dates:
            trainCoverageDates,

          validation_coverage_dates:
            validationCoverageDates,

          test_coverage_dates:
            testCoverageDates,

          max_signals_per_hold:
            maxSignalsPerHold,

          fee_per_contract_per_leg:
            feePerContractPerLeg,

          friction_tiers_cents:
            frictionTiers,
        },

        coverage,

        coverage_detail:
          coverageDetail,

        oos_trade_count:
          oosRows.length,

        raw_summary:
          rawSummary,

        scenarios:
          scenarios.map(
            (scenario) => ({
              round_trip_friction_cents:
                scenario
                  .round_trip_friction_cents,

              fee_per_contract_per_leg:
                scenario
                  .fee_per_contract_per_leg,

              summary:
                scenario.summary,
            })
          ),

        approximate_break_even_round_trip_friction_cents:
          approximateBreakEvenFrictionCents,

        largest_positive_stress_tier_cents:
          positiveScenarios.length
            ? Math.max(
                ...positiveScenarios.map(
                  (scenario) =>
                    scenario
                      .round_trip_friction_cents
                )
              )
            : null,

        stressed_trade_examples:
          scenarios.find(
            (scenario) =>
              scenario
                .round_trip_friction_cents ===
              10
          )?.trades
            ?.slice(
              -12
            ) ??
          [],
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
  "/scanner/forward-validator",

  async (_req, res) => {
    try {
      const state =
        await readForwardValidatorState();

      return res.json({
        ...state,

        summary:
          summarizeForwardValidator(
            state
          ),

        scheduler:
          forwardValidatorSchedulerStatus(),

        paper_only:
          true,
      });

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
  "/scanner/forward-validator/settings",

  async (req, res) => {
    try {
      const current =
        await readForwardValidatorState();

      const incoming =
        req.body
          ?.settings &&
        typeof req.body
          .settings ===
          "object"
          ? req.body
              .settings
          : {};

      const next =
        await writeForwardValidatorState({
          ...current,

          settings: {
            ...current.settings,

            ...incoming,
          },
        });

      return res.json({
        ...next,

        summary:
          summarizeForwardValidator(
            next
          ),

        scheduler:
          forwardValidatorSchedulerStatus(),

        paper_only:
          true,
      });

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
  "/scanner/forward-validator/tick",

  async (_req, res) => {
    try {
      const current =
        await readForwardValidatorState();

      const next =
        await runForwardValidatorTick(
          current
        );

      return res.json({
        ...next,

        summary:
          summarizeForwardValidator(
            next
          ),

        scheduler:
          forwardValidatorSchedulerStatus(),

        paper_only:
          true,
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
  "/scanner/single-leg-practice",

  async (_req, res) => {
    try {
      const state =
        await readSingleLegPracticeState();

      return res.json({
        ...state,

        summary:
          summarizeSingleLegPractice(
            state
          ),

        scheduler:
          singleLegPracticeSchedulerStatus(),

        paper_only:
          true,
      });

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
  "/scanner/single-leg-practice/settings",

  async (req, res) => {
    try {
      const current =
        await readSingleLegPracticeState();

      const incoming =
        req.body
          ?.settings &&
        typeof req.body
          .settings ===
          "object"
          ? req.body
              .settings
          : {};

      const next =
        await writeSingleLegPracticeState({
          ...current,

          settings: {
            ...current.settings,

            ...incoming,
          },
        });

      return res.json({
        ...next,

        summary:
          summarizeSingleLegPractice(
            next
          ),

        scheduler:
          singleLegPracticeSchedulerStatus(),

        paper_only:
          true,
      });

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
  "/scanner/single-leg-practice/open",

  async (req, res) => {
    try {
      const current =
        await readSingleLegPracticeState();

      const next =
        await openSingleLegPracticeTrade({
          state:
            current,

          type:
            req.body
              ?.optionType,

          quantity:
            req.body
              ?.quantity,
        });

      return res.json({
        ...next,

        summary:
          summarizeSingleLegPractice(
            next
          ),

        scheduler:
          singleLegPracticeSchedulerStatus(),

        paper_only:
          true,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

app.post(
  "/scanner/single-leg-practice/close",

  async (req, res) => {
    try {
      const current =
        await readSingleLegPracticeState();

      const next =
        await closeSingleLegPracticeTrade({
          state:
            current,

          tradeId:
            req.body
              ?.tradeId,
        });

      return res.json({
        ...next,

        summary:
          summarizeSingleLegPractice(
            next
          ),

        scheduler:
          singleLegPracticeSchedulerStatus(),

        paper_only:
          true,
      });

    } catch (error) {
      return handleRobinhoodError(
        error,
        res
      );
    }
  }
);

app.post(
  "/scanner/single-leg-practice/tick",

  async (_req, res) => {
    try {
      const current =
        await readSingleLegPracticeState();

      const next =
        await runSingleLegPracticeTick(
          current
        );

      return res.json({
        ...next,

        summary:
          summarizeSingleLegPractice(
            next
          ),

        scheduler:
          singleLegPracticeSchedulerStatus(),

        paper_only:
          true,
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

require("./singleLegResearch").registerSingleLegResearch(app, {
  normalizeTicker,
  call: callRobinhoodTool,
  unwrap: unwrapRobinhoodToolResult,
  extractStock: extractBacktestBars,
  nextFriday: nextFridayOnOrAfter,
  loadInstruments: loadExpiredOptionInstruments,
  extractOptions: extractOptionHistoricalResults,
  normalizeOptions: normalizeOptionBars,
});

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

    startForwardValidatorScheduler();

    console.log(
      "Forward validator scheduler: active"
    );

    console.log("");
  }
);