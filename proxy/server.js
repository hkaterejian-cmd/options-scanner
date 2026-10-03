require("dotenv").config();

const crypto = require("node:crypto");
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
  HEALTH
  =========================================================
*/

app.get(
  "/",

  (_req, res) => {
    res.json({
      status:
        "ok",

      robinhood: {
        connected:
          !!robinhoodClient,

        oauthPending,

        endpoint:
          ROBINHOOD_MCP_URL,
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