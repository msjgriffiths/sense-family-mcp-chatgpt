import assert from "node:assert/strict";
import test from "node:test";
import { createGateway, READ_TOOLS, WRITE_TOOLS } from "../src/core.mjs";

const DOMAIN = "example.lambda-url.us-east-2.on.aws";
const RESOURCE = `https://${DOMAIN}/mcp`;
const PUBLIC_DOMAIN = "example.cloudfront.net";
const PUBLIC_RESOURCE = `https://${PUBLIC_DOMAIN}/mcp`;
const CLIENT_ID = "client-primary";
const USERNAME = "primary";

function event({
  method = "POST",
  path = "/mcp",
  authorization = "Bearer valid-token",
  origin,
  publicHost,
  contentType = "application/json",
  body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
} = {}) {
  return {
    rawPath: path,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(origin ? { origin } : {}),
      ...(publicHost ? { "x-public-host": publicHost } : {}),
      "content-type": contentType,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      domainName: DOMAIN,
      requestId: "request-1",
      http: { method },
    },
  };
}

function upstream(body, status = 200, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  const handler = createGateway({
    cognitoDomain: "https://family-login.example",
    clientBindings: {
      [CLIENT_ID]: { username: USERNAME, parameter: "/sense-mcp/primary/key" },
    },
    verifyAccessToken: async (_token, audience) => {
      assert.equal(audience, RESOURCE);
      return {
        sub: "opaque-user-subject",
        client_id: CLIENT_ID,
        username: USERNAME,
        scope: "sense-mcp/read",
        token_use: "access",
      };
    },
    readSecureParameter: async (name) => {
      assert.equal(name, "/sense-mcp/primary/key");
      return "test-sense-key-not-a-secret";
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return upstream({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            ...READ_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
            ...WRITE_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
            { name: "delete_everything", inputSchema: { type: "object" } },
          ],
        },
      });
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { handler, calls, logs };
}

test("serves RFC 9728 protected-resource metadata without authentication", async () => {
  const { handler } = harness();
  const result = await handler(event({
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    authorization: null,
  }));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.resource, RESOURCE);
  assert.deepEqual(body.authorization_servers, [`https://${DOMAIN}/oauth`]);
  assert.deepEqual(body.scopes_supported, ["sense-mcp/read"]);
});

test("publishes ChatGPT-compatible OAuth metadata for Cognito PKCE", async () => {
  const { handler } = harness();
  const result = await handler(event({
    method: "GET",
    path: "/.well-known/oauth-authorization-server/oauth",
    authorization: null,
  }));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.issuer, `https://${DOMAIN}/oauth`);
  assert.equal(body.authorization_endpoint, "https://family-login.example/oauth2/authorize");
  assert.equal(body.token_endpoint, `https://${DOMAIN}/oauth/token`);
  assert.equal(body.revocation_endpoint, `https://${DOMAIN}/oauth/revoke`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(body.scopes_supported, ["sense-mcp/read"]);
  assert.equal("authorization_response_iss_parameter_supported" in body, false);
  assert.equal(body.scopes_supported.includes("offline_access"), false);
});

test("proxies public-client token exchange without logging OAuth credentials", async () => {
  const calls = [];
  const logs = [];
  const { handler } = harness({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return upstream({
        access_token: "sensitive-access-token",
        refresh_token: "sensitive-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
    log: (line) => logs.push(line),
  });
  const code = "sensitive-authorization-code";
  const verifier = "sensitive-pkce-verifier";
  const result = await handler(event({
    path: "/oauth/token",
    authorization: null,
    publicHost: PUBLIC_DOMAIN,
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: "https://chatgpt.com/connector/oauth/example",
      resource: PUBLIC_RESOURCE,
    }).toString(),
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://family-login.example/oauth2/token");
  assert.equal(calls[0].options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(calls[0].options.body).has("resource"), false);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, new RegExp(code));
  assert.doesNotMatch(serializedLogs, new RegExp(verifier));
  assert.doesNotMatch(serializedLogs, /sensitive-(?:access|refresh)-token/);
});

test("rejects token exchange for an unknown app client or wrong resource", async () => {
  const logs = [];
  const { handler, calls } = harness({ log: (line) => logs.push(line) });
  const base = {
    grant_type: "authorization_code",
    code: "unused",
    code_verifier: "unused",
  };

  const unknownClient = await handler(event({
    path: "/oauth/token",
    authorization: null,
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...base, client_id: "unknown-client" }).toString(),
  }));
  assert.equal(unknownClient.statusCode, 400);
  assert.equal(JSON.parse(unknownClient.body).error, "invalid_client");

  const wrongResource = await handler(event({
    path: "/oauth/token",
    authorization: null,
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      ...base,
      client_id: CLIENT_ID,
      resource: "https://attacker.example/mcp",
    }).toString(),
  }));
  assert.equal(wrongResource.statusCode, 400);
  assert.equal(JSON.parse(wrongResource.body).error, "invalid_target");
  assert.equal(calls.length, 0);
  assert.deepEqual(logs.map((line) => JSON.parse(line).rejection), ["client_id", "resource"]);
  assert.doesNotMatch(JSON.stringify(logs), /unused/);
});

test("challenges unauthenticated MCP requests with metadata URL", async () => {
  const { handler } = harness();
  const result = await handler(event({ authorization: null }));
  assert.equal(result.statusCode, 401);
  assert.match(result.headers["www-authenticate"], /oauth-protected-resource\/mcp/);
  assert.doesNotMatch(result.body, /Sense|token/i);
});

test("encodes OAuth challenges for CloudFront to restore", async () => {
  const { handler } = harness();
  const result = await handler(event({ authorization: null, publicHost: PUBLIC_DOMAIN }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["x-mcp-proxy-status"], "401");
  assert.match(result.headers["x-mcp-www-authenticate"], /oauth-protected-resource\/mcp/);
  assert.match(result.headers["x-mcp-www-authenticate"], new RegExp(PUBLIC_DOMAIN));
});

test("uses the CloudFront host as the protected resource audience", async () => {
  const { handler } = harness({
    verifyAccessToken: async (_token, audience) => {
      assert.equal(audience, PUBLIC_RESOURCE);
      return {
        sub: "opaque-user-subject",
        client_id: CLIENT_ID,
        username: USERNAME,
        scope: "sense-mcp/read",
      };
    },
  });
  const result = await handler(event({ publicHost: PUBLIC_DOMAIN }));
  assert.equal(result.statusCode, 200);
});

test("filters tools/list and adds matching OAuth security schemes", async () => {
  const { handler } = harness();
  const result = await handler(event());
  assert.equal(result.statusCode, 200);
  const tools = JSON.parse(result.body).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), READ_TOOLS);
  for (const tool of tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["sense-mcp/read"] }]);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test("replaces inbound OAuth token with the selected Sense key", async () => {
  const { handler, calls, logs } = harness();
  const result = await handler(event());
  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.getsense.ai/mcp/");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-sense-key-not-a-secret");
  const serialized = JSON.stringify({ result, logs });
  assert.doesNotMatch(serialized, /valid-token/);
  assert.doesNotMatch(JSON.stringify(logs), /test-sense-key-not-a-secret/);
});

test("blocks guessed tools before contacting Sense", async () => {
  const { handler, calls } = harness();
  const result = await handler(event({
    body: {
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).error.code, -32601);
  assert.equal(calls.length, 0);
});

test("keeps writes disabled even when the token contains write scope", async () => {
  const { handler, calls } = harness({
    verifyAccessToken: async () => ({
      sub: "opaque-user-subject",
      client_id: CLIENT_ID,
      username: USERNAME,
      scope: "sense-mcp/read sense-mcp/write",
    }),
  });
  const result = await handler(event({
    body: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_event", arguments: { title: "private data" } },
    },
  }));
  assert.equal(JSON.parse(result.body).error.code, -32601);
  assert.equal(calls.length, 0);
});

test("allows the narrow write set only when deployment and OAuth scope both enable it", async () => {
  const { handler, calls } = harness({
    enableWrites: true,
    verifyAccessToken: async () => ({
      sub: "opaque-user-subject",
      client_id: CLIENT_ID,
      username: USERNAME,
      scope: "sense-mcp/read sense-mcp/write",
    }),
  });

  const listed = await handler(event());
  const tools = JSON.parse(listed.body).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS]);
  for (const tool of tools.filter((candidate) => WRITE_TOOLS.includes(candidate.name))) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["sense-mcp/write"] }]);
    assert.equal(tool.annotations.readOnlyHint, false);
  }

  const called = await handler(event({
    body: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "create_event", arguments: { title: "private data" } },
    },
  }));
  assert.equal(called.statusCode, 200);
  assert.equal(calls.length, 2);
});

test("fails closed when client and Cognito user binding do not match", async () => {
  const { handler, calls } = harness({
    verifyAccessToken: async () => ({
      sub: "opaque-user-subject",
      client_id: CLIENT_ID,
      username: "partner",
      scope: "sense-mcp/read",
    }),
  });
  const result = await handler(event());
  assert.equal(result.statusCode, 403);
  assert.equal(JSON.parse(result.body).error, "identity_not_allowed");
  assert.equal(calls.length, 0);
});

test("rejects unexpected browser origins", async () => {
  const { handler, calls } = harness();
  const result = await handler(event({ origin: "https://attacker.example" }));
  assert.equal(result.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("returns a generic error when JWT verification fails", async () => {
  const { handler, calls } = harness({
    verifyAccessToken: async () => {
      throw new Error("signature details must not escape");
    },
  });
  const result = await handler(event());
  assert.equal(result.statusCode, 401);
  assert.equal(JSON.parse(result.body).error, "invalid_token");
  assert.doesNotMatch(result.body, /signature details/);
  assert.equal(calls.length, 0);
});
