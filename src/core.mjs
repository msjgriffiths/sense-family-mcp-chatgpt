import { createHash } from "node:crypto";

export const READ_TOOLS = Object.freeze([
  "get_family_members",
  "get_events",
  "search_events",
  "get_reminders",
  "search_reminders",
  "get_reminder_by_id",
]);

export const WRITE_TOOLS = Object.freeze([
  "create_event",
  "update_event",
  "create_reminder",
  "create_reminders",
  "update_reminder",
  "complete_reminder",
]);

const READ_TOOL_SET = new Set(READ_TOOLS);
const WRITE_TOOL_SET = new Set(WRITE_TOOLS);
const SAFE_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

const TOOL_ANNOTATIONS = Object.freeze({
  get_family_members: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_events: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  search_events: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_reminders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  search_reminders: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_reminder_by_id: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create_event: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_event: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  create_reminder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  create_reminders: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update_reminder: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  complete_reminder: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
});

function baseHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: baseHeaders(headers),
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function emptyResponse(statusCode, headers = {}) {
  return {
    statusCode,
    headers: {
      ...baseHeaders(headers),
      "content-type": "text/plain; charset=utf-8",
    },
    body: "",
    isBase64Encoded: false,
  };
}

function oauthErrorResponse(statusCode, body, challenge, urls) {
  if (urls.viaCloudFront) {
    return response(200, body, {
      "x-mcp-proxy-status": String(statusCode),
      "x-mcp-www-authenticate": challenge,
    });
  }
  return response(statusCode, body, { "www-authenticate": challenge });
}

function eventHeaders(event) {
  return Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function canonicalUrls(event) {
  const headers = eventHeaders(event);
  const forwardedDomain = headers["x-public-host"];
  const viaCloudFront =
    typeof forwardedDomain === "string" &&
    /^[a-z0-9.-]+\.cloudfront\.net$/i.test(forwardedDomain);
  const domain = viaCloudFront ? forwardedDomain : event.requestContext?.domainName;
  if (typeof domain !== "string" || !/^[a-z0-9.-]+$/i.test(domain)) {
    throw new Error("Trusted Lambda domain name is missing");
  }
  const origin = `https://${domain}`;
  return {
    origin,
    resource: `${origin}/mcp`,
    metadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
    authorizationServer: `${origin}/oauth`,
    viaCloudFront,
  };
}

function parseBearer(value) {
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function parseBody(event, maxBodyBytes) {
  const body = rawBody(event, maxBodyBytes);
  return { raw: body, value: JSON.parse(body) };
}

function rawBody(event, maxBodyBytes) {
  const raw = event.body ?? "";
  const body = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    const error = new Error("Request body too large");
    error.code = "BODY_TOO_LARGE";
    throw error;
  }
  return body;
}

function requestsFrom(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error("Empty JSON-RPC batch");
    return value;
  }
  return [value];
}

function inspectRpc(value, { enableWrites }) {
  let representativeMethod = "batch";
  let representativeTool = null;
  let requiresWrite = false;

  for (const message of requestsFrom(value)) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Invalid JSON-RPC request");
    }
    const method = message.method;
    if (typeof method !== "string" || !SAFE_METHODS.has(method)) {
      const error = new Error("Method is not allowed by the gateway");
      error.code = "METHOD_BLOCKED";
      error.rpcId = message.id ?? null;
      throw error;
    }
    representativeMethod = method;

    if (method === "tools/call") {
      const toolName = message.params?.name;
      if (typeof toolName !== "string") {
        throw new Error("Tool name is missing");
      }
      representativeTool = toolName;
      if (READ_TOOL_SET.has(toolName)) continue;
      if (enableWrites && WRITE_TOOL_SET.has(toolName)) {
        requiresWrite = true;
        continue;
      }
      const error = new Error("Tool is not allowed by the gateway");
      error.code = "TOOL_BLOCKED";
      error.rpcId = message.id ?? null;
      throw error;
    }
  }

  return { method: representativeMethod, tool: representativeTool, requiresWrite };
}

function jsonRpcError(id, code, message) {
  return response(200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function scopeSet(claim) {
  return new Set(typeof claim === "string" ? claim.split(/\s+/).filter(Boolean) : []);
}

function oauthScheme(scope) {
  return { type: "oauth2", scopes: [scope] };
}

function decorateTool(tool, { readScope, writeScope }) {
  const isRead = READ_TOOL_SET.has(tool.name);
  const scope = isRead ? readScope : writeScope;
  const securitySchemes = [oauthScheme(scope)];
  return {
    ...tool,
    annotations: {
      ...(tool.annotations ?? {}),
      ...(TOOL_ANNOTATIONS[tool.name] ?? {}),
    },
    securitySchemes,
    _meta: {
      ...(tool._meta ?? {}),
      securitySchemes,
    },
  };
}

function filterToolsPayload(value, config) {
  const transform = (message) => {
    if (!message?.result || !Array.isArray(message.result.tools)) return message;
    const allowed = new Set([
      ...READ_TOOLS,
      ...(config.enableWrites ? WRITE_TOOLS : []),
    ]);
    return {
      ...message,
      result: {
        ...message.result,
        tools: message.result.tools
          .filter((tool) => allowed.has(tool?.name))
          .map((tool) => decorateTool(tool, config)),
      },
    };
  };
  return Array.isArray(value) ? value.map(transform) : transform(value);
}

function safeUpstreamHeaders(upstreamHeaders) {
  const headers = {};
  const contentType = upstreamHeaders.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  for (const name of ["mcp-session-id", "mcp-protocol-version", "retry-after"]) {
    const value = upstreamHeaders.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function actorId(sub) {
  return createHash("sha256").update(sub).digest("hex").slice(0, 12);
}

function safeLog(log, fields) {
  log(JSON.stringify(fields));
}

function safeOAuthError(body) {
  try {
    const value = JSON.parse(body);
    return typeof value?.error === "string" ? value.error : null;
  } catch {
    return null;
  }
}

function safeJwtFailure(error) {
  const result = {};
  if (typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
    result.jwt_error = error.code;
  }
  if (["aud", "iss", "exp", "nbf", "iat"].includes(error?.claim)) {
    result.jwt_claim = error.claim;
  }
  if (["missing", "check_failed", "invalid"].includes(error?.reason)) {
    result.jwt_reason = error.reason;
  }
  return result;
}

export function createGateway({
  cognitoDomain,
  clientBindings,
  readScope = "sense-mcp/read",
  writeScope = "sense-mcp/write",
  enableWrites = false,
  allowedOrigins = ["https://chatgpt.com", "https://chat.openai.com"],
  upstreamUrl = "https://api.getsense.ai/mcp/",
  maxBodyBytes = 262_144,
  verifyAccessToken,
  readSecureParameter,
  fetchImpl = fetch,
  log = console.log,
  now = Date.now,
}) {
  if (!cognitoDomain?.startsWith("https://")) {
    throw new Error("cognitoDomain must be an HTTPS URL");
  }
  const oauthDomain = cognitoDomain.replace(/\/$/, "");
  const config = { enableWrites, readScope, writeScope };
  const allowedOriginSet = new Set(allowedOrigins);
  const oauthMetadataPaths = new Set([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/oauth",
    "/oauth/.well-known/oauth-authorization-server",
  ]);

  return async function handler(event) {
    const startedAt = now();
    const requestId = event.requestContext?.requestId ?? "unknown";
    const method = event.requestContext?.http?.method ?? "";
    const path = event.rawPath ?? "/";
    let rpc = { method: null, tool: null };
    let claims = null;

    const oauthFailure = (status, error, reason, clientId = null) => {
      safeLog(log, {
        request_id: requestId,
        actor: clientId ? actorId(clientId) : null,
        method: path === "/oauth/revoke" ? "oauth/revoke" : "oauth/token",
        status,
        oauth_error: error,
        rejection: reason,
        duration_ms: Math.max(0, now() - startedAt),
      });
      return response(status, { error });
    };

    const mcpFailure = (status, error, rejection, extra = {}) => {
      safeLog(log, {
        request_id: requestId,
        actor: claims?.sub ? actorId(claims.sub) : null,
        method: "mcp/handshake",
        status,
        error,
        rejection,
        duration_ms: Math.max(0, now() - startedAt),
        ...extra,
      });
    };

    try {
      const urls = canonicalUrls(event);
      if (method === "GET" && oauthMetadataPaths.has(path)) {
        return response(
          200,
          {
            issuer: urls.authorizationServer,
            authorization_endpoint: `${oauthDomain}/oauth2/authorize`,
            token_endpoint: `${urls.authorizationServer}/token`,
            revocation_endpoint: `${urls.authorizationServer}/revoke`,
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            revocation_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: [readScope, ...(enableWrites ? [writeScope] : [])],
          },
          { "cache-control": "public, max-age=300" },
        );
      }

      if (
        method === "GET" &&
        (path === "/.well-known/oauth-protected-resource" ||
          path === "/.well-known/oauth-protected-resource/mcp")
      ) {
        return response(
          200,
          {
            resource: urls.resource,
            authorization_servers: [urls.authorizationServer],
            scopes_supported: [readScope, ...(enableWrites ? [writeScope] : [])],
            bearer_methods_supported: ["header"],
            resource_name: "Sense family calendar gateway",
            resource_documentation: "https://api.getsense.ai/docs",
          },
          { "cache-control": "public, max-age=300" },
        );
      }

      if (path === "/oauth/token" || path === "/oauth/revoke") {
        if (method !== "POST") {
          const result = oauthFailure(405, "method_not_allowed", "http_method");
          result.headers.allow = "POST";
          return result;
        }

        const headers = eventHeaders(event);
        if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(headers["content-type"] ?? "")) {
          return oauthFailure(415, "unsupported_media_type", "content_type");
        }
        if (headers.authorization) {
          return oauthFailure(400, "invalid_client", "authorization_header");
        }

        let form;
        try {
          form = new URLSearchParams(rawBody(event, maxBodyBytes));
        } catch (error) {
          if (error.code === "BODY_TOO_LARGE") {
            return oauthFailure(413, "request_too_large", "body_size");
          }
          return oauthFailure(400, "invalid_request", "body_parse");
        }

        const clientId = form.get("client_id");
        if (!clientId || !clientBindings[clientId]) {
          return oauthFailure(400, "invalid_client", "client_id", clientId);
        }
        if (form.has("client_secret") || form.has("client_assertion")) {
          return oauthFailure(400, "invalid_client", "client_credential", clientId);
        }

        const resource = form.get("resource");
        if (resource && resource !== urls.resource) {
          return oauthFailure(400, "invalid_target", "resource", clientId);
        }
        // Cognito binds the audience from the authorize request and carries it
        // through refreshes. ChatGPT correctly echoes `resource` at the token
        // endpoint, but Cognito does not need that second copy.
        form.delete("resource");

        const isToken = path === "/oauth/token";
        const grantType = form.get("grant_type");
        if (isToken && grantType !== "authorization_code" && grantType !== "refresh_token") {
          return oauthFailure(400, "unsupported_grant_type", "grant_type", clientId);
        }
        if (!isToken && !form.get("token")) {
          return oauthFailure(400, "invalid_request", "missing_token", clientId);
        }

        let upstream;
        try {
          upstream = await fetchImpl(`${oauthDomain}${isToken ? "/oauth2/token" : "/oauth2/revoke"}`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "sense-mcp-gateway/0.1",
            },
            body: form.toString(),
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          });
        } catch {
          return response(502, { error: "authorization_server_unavailable" });
        }

        const upstreamBody = await upstream.text();
        safeLog(log, {
          request_id: requestId,
          actor: actorId(clientId),
          method: isToken ? "oauth/token" : "oauth/revoke",
          grant_type: isToken ? grantType : null,
          status: upstream.status,
          oauth_error: upstream.ok ? null : safeOAuthError(upstreamBody),
          duration_ms: Math.max(0, now() - startedAt),
        });
        return response(upstream.status, upstreamBody, {
          "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        });
      }

      if (path !== "/mcp" && path !== "/mcp/") {
        return response(404, { error: "not_found" });
      }
      if (method !== "POST") {
        mcpFailure(405, "method_not_allowed", "http_method");
        return response(405, { error: "method_not_allowed" }, { allow: "POST" });
      }

      const headers = eventHeaders(event);
      const origin = headers.origin;
      if (origin && !allowedOriginSet.has(origin)) {
        mcpFailure(403, "origin_not_allowed", "origin");
        return response(403, { error: "origin_not_allowed" });
      }

      const token = parseBearer(headers.authorization);
      if (!token) {
        mcpFailure(401, "unauthorized", "bearer");
        return oauthErrorResponse(
          401,
          { error: "unauthorized" },
          `Bearer resource_metadata="${urls.metadata}", scope="${readScope}"`,
          urls,
        );
      }

      try {
        claims = await verifyAccessToken(token, urls.resource);
      } catch (error) {
        mcpFailure(401, "invalid_token", "jwt", safeJwtFailure(error));
        return oauthErrorResponse(
          401,
          { error: "invalid_token" },
          `Bearer error="invalid_token", resource_metadata="${urls.metadata}"`,
          urls,
        );
      }

      const binding = clientBindings[claims.client_id];
      if (!binding || binding.username !== claims.username) {
        mcpFailure(403, "identity_not_allowed", "binding", {
          client_bound: Boolean(binding),
          username_match: Boolean(binding && binding.username === claims.username),
        });
        return response(403, { error: "identity_not_allowed" });
      }

      let parsed;
      try {
        parsed = parseBody(event, maxBodyBytes);
      } catch (error) {
        if (error.code === "BODY_TOO_LARGE") {
          mcpFailure(413, "request_too_large", "body_size");
          return response(413, { error: "request_too_large" });
        }
        mcpFailure(400, "invalid_json", "body_parse");
        return response(400, { error: "invalid_json" });
      }

      try {
        rpc = inspectRpc(parsed.value, { enableWrites });
      } catch (error) {
        if (error.code === "METHOD_BLOCKED") {
          mcpFailure(400, "method_blocked", "rpc_method");
          return jsonRpcError(error.rpcId, -32601, "Method not allowed by gateway");
        }
        if (error.code === "TOOL_BLOCKED") {
          mcpFailure(400, "tool_blocked", "rpc_tool");
          return jsonRpcError(error.rpcId, -32601, "Tool not allowed by gateway");
        }
        mcpFailure(400, "invalid_request", "rpc_parse");
        return jsonRpcError(null, -32600, "Invalid Request");
      }

      const scopes = scopeSet(claims.scope);
      const requiredScope = rpc.requiresWrite ? writeScope : readScope;
      if (!scopes.has(requiredScope)) {
        mcpFailure(403, "insufficient_scope", "scope", {
          required_scope: requiredScope,
        });
        return oauthErrorResponse(
          403,
          { error: "insufficient_scope" },
          `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${urls.metadata}"`,
          urls,
        );
      }

      const senseKey = await readSecureParameter(binding.parameter);
      const upstreamHeaders = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${senseKey}`,
        "content-type": headers["content-type"] ?? "application/json",
        "user-agent": "sense-mcp-gateway/0.1",
      };
      if (headers["mcp-protocol-version"]) {
        upstreamHeaders["mcp-protocol-version"] = headers["mcp-protocol-version"];
      }

      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: parsed.raw,
          signal: AbortSignal.timeout(25_000),
          redirect: "error",
        });
      } catch {
        mcpFailure(502, "upstream_unavailable", "upstream_fetch");
        return response(502, { error: "upstream_unavailable" });
      }

      let upstreamBody = await upstream.text();
      if (rpc.method === "tools/list" && upstream.ok) {
        try {
          upstreamBody = JSON.stringify(filterToolsPayload(JSON.parse(upstreamBody), config));
        } catch {
          mcpFailure(502, "unsafe_upstream_response", "tools_list_parse");
          return response(502, { error: "unsafe_upstream_response" });
        }
      }

      safeLog(log, {
        request_id: requestId,
        actor: actorId(claims.sub),
        method: rpc.method,
        tool: rpc.tool,
        status: upstream.status,
        duration_ms: Math.max(0, now() - startedAt),
        request_bytes: Buffer.byteLength(parsed.raw, "utf8"),
        response_bytes: Buffer.byteLength(upstreamBody, "utf8"),
      });

      if (!upstreamBody) return emptyResponse(upstream.status, safeUpstreamHeaders(upstream.headers));
      return response(upstream.status, upstreamBody, safeUpstreamHeaders(upstream.headers));
    } catch (error) {
      safeLog(log, {
        request_id: requestId,
        actor: claims?.sub ? actorId(claims.sub) : null,
        method: rpc.method,
        tool: rpc.tool,
        status: 500,
        duration_ms: Math.max(0, now() - startedAt),
        failure: error?.name ?? "Error",
      });
      return response(500, { error: "internal_error" });
    }
  };
}
