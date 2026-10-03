const crypto = require("node:crypto");
const express = require("express");

const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");

const PORT = 3002;

const MCP_URL =
  "https://agent.robinhood.com/mcp/trading";

const CALLBACK_URL =
  `http://127.0.0.1:${PORT}/callback`;

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
    return CALLBACK_URL;
  }

  get clientMetadata() {
    return {
      client_name:
        "Options Scanner Test",

      redirect_uris: [
        CALLBACK_URL,
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
        Important difference from our old implementation.
      */
      token_endpoint_auth_method:
        "client_secret_post",
    };
  }

  clientInformation() {
    return this.clientInfo;
  }

  saveClientInformation(info) {
    this.clientInfo = info;

    console.log(
      "[OAuth] Client registration saved."
    );

    console.log(
      "[OAuth] Client secret present:",
      !!info?.client_secret
    );

    console.log(
      "[OAuth] Registered auth method:",
      info?.token_endpoint_auth_method ||
        "not specified"
    );
  }

  tokens() {
    return this.savedTokens;
  }

  saveTokens(tokens) {
    this.savedTokens = tokens;

    console.log(
      "[OAuth] Tokens saved."
    );
  }

  state() {
    this.lastState =
      crypto.randomUUID();

    return this.lastState;
  }

  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) {
      throw new Error(
        "No PKCE verifier saved."
      );
    }

    return this.verifier;
  }

  saveDiscoveryState(state) {
    this.discovery = state;
  }

  discoveryState() {
    return this.discovery;
  }

  redirectToAuthorization(url) {
    this.authorizationUrl =
      url.toString();

    console.log(
      "[OAuth] Authorization URL ready."
    );
  }

  invalidateCredentials(scope) {
    if (
      scope === "all" ||
      scope === "client"
    ) {
      this.clientInfo = undefined;
    }

    if (
      scope === "all" ||
      scope === "tokens"
    ) {
      this.savedTokens = undefined;
    }

    if (
      scope === "all" ||
      scope === "verifier"
    ) {
      this.verifier = undefined;
    }

    if (
      scope === "all" ||
      scope === "discovery"
    ) {
      this.discovery = undefined;
    }
  }
}

const provider =
  new RobinhoodOAuthProvider();

let client = null;
let pendingTransport = null;
let oauthPending = false;

function makeClient() {
  return new Client({
    name:
      "options-scanner-test",

    version:
      "1.0.0",
  });
}

function makeTransport() {
  return new StreamableHTTPClientTransport(
    new URL(MCP_URL),
    {
      authProvider:
        provider,
    }
  );
}

async function startConnection() {
  if (client) {
    return true;
  }

  if (
    oauthPending &&
    provider.authorizationUrl
  ) {
    return false;
  }

  const newClient =
    makeClient();

  const transport =
    makeTransport();

  pendingTransport =
    transport;

  try {
    await newClient.connect(
      transport
    );

    client =
      newClient;

    oauthPending =
      false;

    console.log(
      "[MCP] Connected."
    );

    return true;

  } catch (error) {
    if (
      provider.authorizationUrl
    ) {
      oauthPending =
        true;

      console.log(
        "[OAuth] Waiting for authorization."
      );

      return false;
    }

    throw error;
  }
}

const app =
  express();

app.get(
  "/",

  (_req, res) => {
    res.send(`
      <h2>Robinhood MCP v2 Test</h2>

      <p>
        <a href="/connect">
          Connect Robinhood
        </a>
      </p>
    `);
  }
);

app.get(
  "/connect",

  async (_req, res) => {
    try {
      if (
        oauthPending &&
        provider.authorizationUrl
      ) {
        return res.redirect(
          provider.authorizationUrl
        );
      }

      const connected =
        await startConnection();

      if (connected) {
        return res.send(
          "<h2>Already connected</h2>"
        );
      }

      return res.redirect(
        provider.authorizationUrl
      );

    } catch (error) {
      console.error(
        "[Connect error]",
        error
      );

      return res
        .status(500)
        .send(
          String(
            error?.message ||
            error
          )
        );
    }
  }
);

app.get(
  "/callback",

  async (req, res) => {
    try {
      const callback =
        new URL(
          req.originalUrl,
          `http://127.0.0.1:${PORT}`
        );

      const params =
        callback.searchParams;

      if (
        params.get("state") !==
        provider.lastState
      ) {
        throw new Error(
          "OAuth state mismatch."
        );
      }

      console.log(
        "[OAuth] Code received."
      );

      await pendingTransport.finishAuth(
        params
      );

      console.log(
        "[OAuth] Token exchange successful."
      );

      /*
        Reconnect using a fresh transport,
        as required by the v2 SDK.
      */

      const newClient =
        makeClient();

      const newTransport =
        makeTransport();

      await newClient.connect(
        newTransport
      );

      client =
        newClient;

      oauthPending =
        false;

      pendingTransport =
        null;

      provider.authorizationUrl =
        undefined;

      const tools =
        await client.listTools();

      console.log(
        "[MCP] Connected."
      );

      console.log(
        "[MCP] Tools discovered:",
        tools?.tools?.length || 0
      );

      return res.send(`
        <h2>
          Robinhood connected successfully
        </h2>

        <p>
          MCP tools discovered:
          ${tools?.tools?.length || 0}
        </p>

        <p>
          You may close this tab.
        </p>
      `);

    } catch (error) {
      console.error("");
      console.error(
        "[OAuth callback failed]"
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

      console.error("");

      return res
        .status(500)
        .send(`
          <h2>
            Robinhood connection failed
          </h2>

          <pre>
${String(
  error?.message ||
  error
)}
          </pre>
        `);
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",

  () => {
    console.log("");
    console.log(
      "Robinhood MCP v2 test running."
    );

    console.log(
      `Open: http://127.0.0.1:${PORT}/connect`
    );

    console.log("");
  }
);