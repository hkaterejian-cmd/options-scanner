const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { McpServer } = require(
  "@modelcontextprotocol/sdk/server/mcp.js"
);
const { StdioServerTransport } = require(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const { z } = require("zod");

const server = new McpServer({
  name: "options-scanner",
  version: "1.0.0",
});

server.registerTool(
  "get_ticker_data",
  {
    title: "Get options scanner data",
    description:
      "Fetch Trading Volatility data for a ticker. " +
      "Provider estimates are not verified dealer positions. " +
      "Check provider timestamps before treating data as current.",
    inputSchema: {
      ticker: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9.^-]{1,15}$/)
        .describe("Ticker symbol, for example PLTR"),
      section: z
        .enum(["snapshot", "explanation", "market_structure"])
        .default("snapshot"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ ticker, section }) => {
    const key = (process.env.TV_API_KEY || "").trim();

    if (!key || key.startsWith("your_")) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Set TV_API_KEY in the server environment.",
        }],
      };
    }

    const suffix = {
      snapshot: "",
      explanation: "/explain",
      market_structure: "/market-structure",
    }[section];

    const url =
      "https://stocks.tradingvolatility.net/api/v2/tickers/" +
      encodeURIComponent(ticker) +
      suffix;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        throw new Error(`Provider returned HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ticker,
            section,
            source: "Trading Volatility",
            retrieved_at: new Date().toISOString(),
            timestamp_note:
              "retrieved_at is retrieval time, not market-data time.",
            data,
          }),
        }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            error.name === "TimeoutError"
              ? "The market-data request timed out."
              : "Market-data request failed. " +
                (error.message.startsWith("Provider returned HTTP")
                  ? error.message
                  : "Check the API key and server connection."),
        }],
      };
    }
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  console.error("Options scanner MCP server failed to start.");
  process.exitCode = 1;
});
