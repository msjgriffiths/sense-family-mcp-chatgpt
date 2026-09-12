# Sense MCP to ChatGPT Cloud

Status: Infrastructure deployed in AWS `us-east-2`, 2026-09-11. The OAuth
gateway, invite-only Cognito users, private artifact storage, $1 budget alert,
six read tools, and six reviewed non-delete write tools are live. The primary
ChatGPT account is connected end to end: OAuth token exchange and the upstream
Sense `tools/list` call both returned `200`, and ChatGPT displays all twelve
allowed actions with URL-bound scopes. Both adult OAuth clients currently map
to the same encrypted family Sense key. No calendar or reminder record was
read or changed during verification. The partner ChatGPT account still needs
its own app installation and exact callback URL.

## Recommendation

Deploy a small OAuth-to-API-key gateway on AWS:

```text
Michael's ChatGPT Pro ──OAuth──┐
                              ├── Amazon Cognito ── access token ──┐
Wife's ChatGPT Pro ─────OAuth─┘                                    │
                                                                   v
                                                  CloudFront + edge header shim
                                                                   │
                                                                   v
                                                        Lambda Function URL
                                                        - validate token
                                                        - map user to key
                                                        - filter tools
                                                        - suppress content logs
                                                                   │
                                                                   │ Bearer <person's Sense key>
                                                                   v
                                                  https://api.getsense.ai/mcp/
```

Use one Cognito identity and OAuth client per adult. Prefer one Sense API key
per adult when Sense supports that cleanly; otherwise intentionally map both
clients to the shared family key. The deployed gateway exposes six read tools
and six narrowly reviewed non-delete write tools. Actual record mutations still
require normal ChatGPT confirmation and should be tested with a clearly labeled
temporary event.

Do not deploy an unauthenticated proxy with a secret URL. Do not forward ChatGPT's OAuth token to Sense. Do not put Lambda in a VPC, because the NAT gateway would dominate the cost.

## What was verified against Sense

- The working endpoint is `POST https://api.getsense.ai/mcp/` with `Authorization: Bearer <Sense API key>` and an `Accept` header covering `application/json` and `text/event-stream`.
- The endpoint negotiated MCP `2025-06-18`; the server identified itself as `sense` version `1.28.1`.
- It is a stateless, JSON-response MCP server: no `Mcp-Session-Id` was returned.
- `tools/list` returned 96 tools in an 86,055-byte response in about 0.9 seconds from this machine.
- 36 tools have `readOnlyHint: true`; 60 are mutating or otherwise not marked read-only.
- The tool definitions do not declare per-tool `securitySchemes`.
- An unauthenticated MCP request returns `401`, but there is no `WWW-Authenticate` discovery challenge.
- OAuth protected-resource, OAuth authorization-server, and OpenID discovery URLs on the Sense host all returned `404`.
- The URL without the trailing slash returns a `307` whose `Location` is incorrectly downgraded to `http://api.getsense.ai/mcp/`. A client should never rely on that redirect.
- Sense's public OpenAPI document exposes OAuth endpoints, but they are described as Alexa account-linking endpoints. A test client ID was rejected as unknown. The documented authorization request also lacks the MCP-required PKCE and resource-indicator contract, so this is not currently a usable ChatGPT OAuth path.
- Sense's public token-creation schema offers `read` and `read_write` scopes and describes tokens as belonging to the current user. This suggests that separate, scoped adult tokens should be possible, but that must be confirmed in each adult's Sense account.

I did not call any tool that reads family records, and I did not call any write tool.

Relevant public surfaces: [Sense API documentation](https://api.getsense.ai/docs) and [Sense OpenAPI document](https://api.getsense.ai/openapi.json).

## Why a gateway is needed

ChatGPT's custom MCP flow does not offer a field for an arbitrary Sense API-key header. Its supported remote authentication modes are OAuth, no authentication, and mixed authentication. For personal family data, no authentication is unacceptable.

The MCP authorization contract also forbids simply passing ChatGPT's token downstream. The gateway must validate a token minted specifically for the gateway, then use a separate Sense credential on the upstream request. That is exactly what this design does.

Official references:

- [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [OpenAI MCP authentication guide](https://developers.openai.com/plugins/build/auth)
- [MCP 2025-06-18 authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

## Proposed AWS design

### 1. Amazon Cognito user pool

- Disable public self-registration and create exactly two users.
- Use the Essentials feature tier: refresh-token rotation requires it, and two direct users remain far below Cognito's ongoing 10,000-MAU free allowance.
- Prefer TOTP MFA; avoid SMS charges.
- Use Cognito's managed login page and authorization-code flow with PKCE S256.
- Publish a small OAuth authorization-server metadata document from the gateway. Cognito's live discovery document can omit `code_challenge_methods_supported`, while ChatGPT requires an explicit `S256` declaration. The shim advertises only capabilities Cognito actually provides and points every login, token, and revocation endpoint back to Cognito; it does not handle credentials or mint tokens.
- Create one app client per ChatGPT account. This makes callback URLs, revocation, and troubleshooting independent.
- Prefer a public app client without a client secret if ChatGPT's creation UI accepts a predefined client ID alone. Otherwise use a confidential client and store its client secret only in ChatGPT's app configuration.
- Configure Cognito managed login version 2 and resource binding so the access-token `aud` is the exact gateway MCP URL. Cognito's classic hosted UI ignores the resource indicator; managed login carries the audience through refreshes.
- Issue short-lived access tokens and rotating refresh tokens.
- Use URL-bound scopes derived from the canonical MCP resource, ending in
  `/read` and `/write`. Cognito requires custom scopes requested with resource
  binding to belong to that exact URL resource.

### 2. Lambda Function URL

Use CloudFront in front of a Lambda Function URL, with authentication enforced in the function. Lambda Function URLs rename the standards-required `WWW-Authenticate` response header; a tiny CloudFront response function restores it, while a request function binds OAuth metadata and token audiences to the public CloudFront hostname. Caching is disabled for all MCP traffic.

Routes:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server/oauth`
- `POST /mcp`
- `POST /mcp/`

Behavior:

1. Return protected-resource metadata naming the gateway's OAuth metadata endpoint and supported scopes. That metadata directs ChatGPT to Cognito's managed authorization and token endpoints and explicitly advertises public-client PKCE S256.
2. On a missing or invalid token, return `401` plus a standards-compliant `WWW-Authenticate: Bearer resource_metadata="..."` header.
3. Validate JWT signature, issuer, expiry, token type, audience, app client, user `sub`, and scopes.
4. Map the Cognito `sub` to that person's encrypted Sense API key.
5. Parse only enough JSON-RPC to enforce the tool and scope allowlists.
6. Replace the inbound authorization header with the selected Sense bearer key and forward the request to the trailing-slash Sense endpoint.
7. Return the upstream JSON-RPC response while preserving the safe MCP/content headers.

For `tools/list`, filter out all non-allowed tools and add OAuth `securitySchemes`. Preserve `readOnlyHint` and add accurate `destructiveHint` and `idempotentHint` annotations where applicable. For `tools/call`, reject a tool not in the allowlist even if a caller guesses its name.

The function must never log request bodies, response bodies, authorization headers, calendar fields, names, or API keys. Log only a request ID, a pseudonymous user identifier, JSON-RPC method/tool name, status, duration, and byte counts. Set log retention to seven days.

### 3. Key storage

Store encrypted `SecureString` values in AWS Systems Manager Parameter Store
and cache the selected value for the life of a Lambda execution environment.
The Lambda role can read only the exact configured parameter ARNs. Two OAuth
clients may deliberately point to the same parameter for a shared family key;
their Cognito identities and client bindings remain separate.

Do not place key values in source control, deployment templates, CloudFormation outputs, command history, or test fixtures. Secrets Manager is also fine but adds a fixed $0.40 per secret per month; Parameter Store standard parameters have no storage charge.

### 4. Cost and abuse controls

At family traffic, expected running cost is effectively $0 and should remain pennies even outside promotional credits:

| Component | Family-scale expectation |
|---|---:|
| Cognito, two monthly active users | $0 under the ongoing MAU free tier |
| Lambda, likely under a few thousand calls/month | $0 inside the ongoing Lambda free tier |
| CloudFront, uncached family-scale MCP traffic | Effectively $0 inside the free allowance |
| SSM standard parameters | $0 |
| CloudWatch logs with body logging disabled | $0 inside the log free tier |
| Domain, API Gateway, load balancer, NAT gateway | Not used |
| Optional Secrets Manager | $0.40 per stored secret/month |

Set Lambda reserved concurrency to 5 and an AWS Budget alert at $1/month. Do not enable provisioned concurrency. The random Function URL plus JWT validation is not the security boundary, but it reduces casual scanning; Cognito validation and the allowlists are the security boundaries.

Pricing references: [Cognito](https://aws.amazon.com/cognito/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/), [Systems Manager](https://aws.amazon.com/systems-manager/pricing/), and [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/).

## Tool rollout

### Phase 1: read-only

Expose only:

- `get_family_members`
- `get_events`
- `search_events`
- `get_reminders`
- `search_reminders`
- `get_reminder_by_id`

Use a Sense token scoped `read` if the Sense UI permits it. Keep forwarded-email, recent-conversation, calendar-feed-URL, medical/family-memory, and all mutation tools hidden.

### Phase 2: low-risk writes

After Phase 1 passes, consider:

- `create_event`
- `update_event`
- `create_reminder`
- `create_reminders`
- `update_reminder`
- `complete_reminder`

Keep deletion, bulk cleanup, allowance, memory, rules, email extraction, external-calendar import, and account/settings tools off until there is a concrete use case and a separate review.

## Per-person Sense identity matters

The Sense tools repeatedly refer to the "current user," and event visibility includes private events owned by a user. If both ChatGPT accounts share one Sense key, both spouses will act as the key owner. That can blur private-event boundaries and audit attribution.

Preferred mapping:

```text
Cognito sub for adult A -> Sense API key created by adult A
Cognito sub for adult B -> Sense API key created by adult B
```

If Sense cannot issue one token per adult, a single family key can work technically, but it should be treated as a shared service account. Private-event behavior and attribution must then be tested and explicitly accepted.

## ChatGPT Pro availability caveat

OpenAI's documentation is currently inconsistent:

- The current developer-mode guide says Pro and Plus are eligible and says developer mode can use all exposed tools, including writes.
- The Help Center article says Pro can connect read/fetch MCPs, while full write support is limited to Business and Enterprise/Edu.

The signed-in Pro account has Developer mode enabled and successfully scanned
all six write actions as well as all six reads. This proves discovery and OAuth
scope negotiation on Pro. A live record mutation has deliberately not been run,
so ChatGPT's action-time write confirmation and Sense's write result remain to
be verified with a clearly labeled temporary event.

## Rollout and acceptance tests

1. Revoke the current diagnostic Sense key and create fresh, labeled keys. Prefer one read-only key per adult for Phase 1.
2. Ask Sense whether they can expose native MCP OAuth with protected-resource metadata, PKCE, resource indicators, and a ChatGPT client. A vendor-native solution would eventually be better than this bridge.
3. Implement the gateway and Cognito configuration as infrastructure-as-code, without secret values in the template.
4. Unit-test JWT validation, audience/scope checks, allowlist filtering, header replacement, redaction, and upstream failure handling.
5. Deploy and verify OAuth discovery with MCP Inspector.
6. The account owner manually enables ChatGPT Developer mode; this is a security setting and should not be automated.
7. Add the app separately in each ChatGPT account and authenticate as the matching Cognito user.
8. Confirm that tool scan shows exactly the Phase 1 list.
9. Test date-bounded reads, search, token expiry/refresh, revocation, and one user's inability to see the other user's private event.
10. Inspect CloudWatch and prove that no event content, names, headers, tokens, or keys were logged.
11. If Pro allows writes, deploy the Phase 2 scope and create one clearly labeled test event only after reviewing ChatGPT's confirmation payload. Delete it manually in Sense after the test.

Release criteria:

- OAuth sign-in and refresh work for both people.
- Tokens with the wrong issuer, audience, user, client, expiry, or scope fail closed.
- Only allowlisted tools appear and guessed disallowed calls fail.
- The inbound ChatGPT token is never sent to Sense.
- Each spouse resolves to the intended Sense identity.
- No personal content or credentials appear in logs or deployment state.
- Monthly AWS budget alert is active.

## Decision

Keep the deployed AWS Cognito + CloudFront + Lambda bridge. It is working for
the primary ChatGPT Pro account with both read and narrowly allowed write tools,
while all delete, administrative, bulk, import, billing, account, and
family-management actions remain blocked. Finish the partner account's app
installation, rotate the exposed diagnostic Sense key, and revisit the bridge
if Sense adds standards-compliant native MCP OAuth.
