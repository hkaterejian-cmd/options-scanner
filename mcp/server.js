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

const { Client } = require(
  "@modelcontextprotocol/sdk/client/index.js"
);

const { StreamableHTTPClientTransport } = require(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

const { z } = require("zod");

const ROBINHOOD_MCP_URL =
  "https://agent.robinhood.com/mcp/trading";

const server = new McpServer({
  name: "options-scanner",
  version: "2.0.0",
});

let robinhoodClient = null;

async function getRobinhoodClient() {
  if (robinhoodClient) {
    return robinhoodClient;
  }

  const client = new Client({
    name: "options-scanner-robinhood-client",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(ROBINHOOD_MCP_URL)
  );

  try {
    await client.connect(transport);

    robinhoodClient = client;

    return robinhoodClient;
  } catch (error) {
    throw new Error(
      "Unable to connect to Robinhood MCP. " +
      "Authentication may still be required. " +
      error.message
    );
  }
}

server.registerTool(
  "list_robinhood_tools",
  {
    title: "List Robinhood MCP tools",
    description:
      "Lists the tools exposed by the connected Robinhood Trading MCP.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const client = await getRobinhoodClient();

      const result = await client.listTools();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              result,
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error.message,
          },
        ],
      };
    }
  }
);

server.registerTool(
  "call_robinhood_tool",
  {
    title: "Call Robinhood MCP tool",
    description:
      "Calls a tool exposed by the Robinhood Trading MCP.",
    inputSchema: {
      toolName: z
        .string()
        .min(1)
        .describe("Exact Robinhood MCP tool name"),

      arguments: z
        .record(z.any())
        .default({})
        .describe(
          "Arguments required by the Robinhood MCP tool"
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ toolName, arguments: args }) => {
    try {
      const client = await getRobinhoodClient();

      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: "Robinhood Trading MCP",
                tool: toolName,
                retrieved_at: new Date().toISOString(),
                result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Robinhood MCP request failed: " +
              error.message,
          },
        ],
      };
    }
  }
);

server.registerTool(
  "get_ticker_data",
  {
    title: "Get ticker data",
    description:
      "Attempts to retrieve market data for a ticker using Robinhood MCP.",
    inputSchema: {
      ticker: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9.^-]{1,15}$/)
        .describe("Ticker symbol, for example PLTR"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ ticker }) => {
    try {
      const client = await getRobinhoodClient();

      const tools = await client.listTools();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ticker,
                message:
                  "Robinhood MCP connected. " +
                  "Use list_robinhood_tools to determine " +
                  "the exact market-data tool for this ticker.",
                availableTools:
                  tools.tools?.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })) || [],
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error.message,
          },
        ],
      };
    }
  }
);

async function main() {
  await server.connect(
    new StdioServerTransport()
  );
}

main().catch((error) => {
  console.error(
    "Options scanner MCP server failed to start:",
    error
  );

  process.exitCode = 1;
});