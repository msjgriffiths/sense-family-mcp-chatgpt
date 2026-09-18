# Sense Family MCP for ChatGPT

An OAuth-protected AWS gateway that lets a small, explicitly invited group use
the [Sense family calendar MCP server](https://api.getsense.ai/mcp/) from
ChatGPT without giving ChatGPT the underlying Sense API key.

Sense authenticates its MCP endpoint with a bearer API key. ChatGPT custom apps
expect a remote MCP server with OAuth. This project bridges those two models:
ChatGPT authenticates each adult through Amazon Cognito, the gateway validates
the resulting access token, and only then does it substitute the encrypted
Sense key for the upstream request.

The reference deployment has been tested end to end with ChatGPT Pro. The
gateway forwards the complete upstream MCP tool catalog, adding only the OAuth
metadata ChatGPT needs. It does not maintain a tool-name allowlist.

> [!IMPORTANT]
> This is a private family-data gateway, not a public proxy. Deploy your own
> stack, invite only the intended users, and never commit a Sense key or `.env`
> file. This project is not affiliated with Sense or OpenAI.

## Architecture

```text
ChatGPT account A ── OAuth + PKCE ──┐
                                    ├── Amazon Cognito
ChatGPT account B ── OAuth + PKCE ──┘          │
                                               │ short-lived JWT
                                               ▼
                                     CloudFront distribution
                                      - disables caching
                                      - restores OAuth challenge headers
                                               │
                                               ▼
                                      Lambda Function URL
                                      - validates JWT claims
                                      - binds client to user
                                      - enforces scopes
                                      - proxies the complete MCP surface
                                      - selects encrypted key
                                               │
                                               │ Sense bearer key
                                               ▼
                                  https://api.getsense.ai/mcp/
```

CloudFront is used because Lambda Function URLs do not preserve the
standards-required `WWW-Authenticate` response header in the form ChatGPT needs
for OAuth discovery. A small CloudFront response function restores the header;
the Lambda remains the authentication and authorization boundary.

## Security model

- Cognito public clients use authorization code flow with PKCE `S256`.
- Self-registration is disabled; the deployment creates only invited users.
- Cognito managed login v2 binds the canonical MCP resource URL into the access
  token audience.
- The gateway verifies signature, issuer, audience, expiry, token type, OAuth
  client, Cognito username, and required scope.
- Each OAuth client is bound to one Cognito identity and one explicitly selected
  SSM parameter path.
- Sense keys are encrypted `SecureString` parameters and never enter the
  CloudFormation template, Git history, Lambda environment, or application
  logs.
- The inbound ChatGPT access token is never forwarded to Sense.
- Every authenticated MCP method and tool is forwarded to the fixed Sense
  endpoint, so new Sense capabilities appear without a gateway code change.
- Request bodies, response bodies, calendar content, names, OAuth codes, and
  credentials are excluded from logs. Logs expire after seven days.
- Lambda reserved concurrency is capped at five.
- An optional AWS Budget sends alerts around a USD 1 monthly threshold.

The OAuth implementation follows the
[official OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth):
protected-resource metadata, authorization-server metadata, resource
indicators, PKCE, exact redirect URIs, audience validation, and per-request
token verification.

## Proxied actions

All tools returned by Sense's `tools/list` response are returned to ChatGPT,
including calendar, reminder, recipe, meal-planning, list, and administrative
tools. Calls are forwarded without a static name filter. Both OAuth scopes are
required for the private full-access connection; normal ChatGPT action-time
confirmations still apply to consequential operations.

## Prerequisites

- An AWS account
- AWS CLI v2 authenticated with a named profile
- Node.js 22 or newer
- PowerShell 7 or Windows PowerShell
- One Sense API key for a shared family identity, or one key per adult
- ChatGPT accounts that can create custom MCP apps

The included deployment scripts currently pin AWS resources to `us-east-2`.

## Local verification

```powershell
npm ci
npm run check
```

`npm run check` runs the Node test suite and builds the Lambda bundle in
`dist/index.cjs`.

The tests cover OAuth discovery, token-proxy redaction, JWT audience checks,
client/user binding, origin restrictions, read/write scopes, tool filtering,
blocked guessed tools, and replacement of the inbound token with the selected
Sense key.

## Deploy to AWS

### 1. Authenticate the AWS CLI

The scripts default to the profile `sense-mcp`:

```powershell
aws configure sso --profile sense-mcp
aws sso login --profile sense-mcp
```

Any AWS authentication method that makes the profile usable is fine. Confirm it
before deploying:

```powershell
aws sts get-caller-identity --profile sense-mcp --region us-east-2
```

### 2. Bootstrap the stack

The first deployment uses harmless placeholder values for the public MCP
resource and ChatGPT callback URLs:

```powershell
.\scripts\deploy.ps1 -BudgetEmail 'your-alert-address@example.com'
```

Copy the `McpUrl` output, then redeploy once so Cognito scopes and token
audiences use that exact CloudFront URL:

```powershell
.\scripts\deploy.ps1 -McpResourceUrl '<McpUrl output>'
```

On an existing stack, omitted resource URL, callback URL, key-path, budget, and
write-mode arguments are read from CloudFormation and preserved. An ordinary
redeploy therefore cannot silently reset working OAuth settings.

### 3. Invite the two Cognito users

```powershell
.\scripts\create-users.ps1 `
  -PrimaryEmail 'adult-a@example.com' `
  -PartnerEmail 'adult-b@example.com'
```

The intended user must complete the temporary-password change and MFA setup
interactively. Do not automate or share those credentials.

### 4. Store the Sense key

Create a local file outside Git containing either a raw key or:

```dotenv
SENSE_API_KEY=sense_replace_with_a_real_key
```

Upload it directly to encrypted SSM Parameter Store:

```powershell
node .\scripts\upload-sense-key.mjs `
  --person primary `
  --file C:\secure\path\sense.env
```

For separate adult Sense identities, upload a second key with
`--person partner`. To use one shared family key, map both OAuth clients to the
same encrypted parameter:

```powershell
.\scripts\deploy.ps1 `
  -PartnerKeyParameter '/sense-mcp/primary/key'
```

The source key file should remain outside the repository and be deleted or
secured after upload.

### 5. Deploy updates

```powershell
.\scripts\deploy.ps1
```

The deployment always advertises both `/mcp/read` and `/mcp/write` because the
gateway is a full proxy for its explicitly invited family users.

## Connect ChatGPT

Repeat this process separately in each ChatGPT account:

1. Enable developer mode in ChatGPT.
2. Open **Plugins** and choose **Create app**.
3. Select **Server URL** and enter the stack's `McpUrl` output.
4. Select **OAuth**.
5. Open **Advanced OAuth settings** and confirm that the discovered scopes end
   with `/mcp/read` and `/mcp/write`.
6. Choose **User-Defined OAuth Client** and enter the matching
   `PrimaryClientId` or `PartnerClientId` CloudFormation output.
7. Keep the token endpoint authentication method set to `none`.
8. Copy the exact callback URL displayed by ChatGPT.
9. Before completing the connection, deploy that callback into Cognito:

   ```powershell
   .\scripts\deploy.ps1 -PrimaryCallbackUrl '<exact ChatGPT callback URL>'
   ```

   Use `-PartnerCallbackUrl` for the second account.

10. Finish creating the app and sign in as the Cognito user bound to that
    client.

ChatGPT uses a callback-ID-specific redirect when the authorization server does
not advertise RFC 9207 issuer identification. The callback must therefore be
copied exactly from ChatGPT rather than guessed or shortened. See the
[OpenAI OAuth redirect guidance](https://developers.openai.com/plugins/build/auth#redirect-url).

If OAuth scopes change after a ChatGPT app has already been created, create a
fresh app definition. ChatGPT can cache the old scope list, and repeatedly
reconnecting that old definition may continue to return `invalid_scope`.

## Smoke tests and operations

Test the upstream Sense key without reading calendar content:

```powershell
node .\scripts\smoke-upstream.mjs
```

That script calls only MCP `initialize` and `tools/list` and prints server
metadata plus the tool count.

Tail safe gateway logs:

```powershell
aws logs tail /aws/lambda/sense-mcp-gateway `
  --since 10m `
  --profile sense-mcp `
  --region us-east-2 `
  --format short
```

Rotate a Sense key by uploading the replacement to the same SSM parameter. New
Lambda execution environments will use the new value. Revoke the old key in
Sense after confirming the replacement works.

## Cost

The design avoids a VPC, NAT gateway, API Gateway, load balancer, custom domain,
and provisioned concurrency. At family-scale traffic it is intended to stay
within or close to the free allowances for Cognito, Lambda, CloudFront, SSM
standard parameters, and CloudWatch. AWS pricing changes, so verify current
[Cognito](https://aws.amazon.com/cognito/pricing/),
[Lambda](https://aws.amazon.com/lambda/pricing/),
[Systems Manager](https://aws.amazon.com/systems-manager/pricing/),
[CloudFront](https://aws.amazon.com/cloudfront/pricing/), and
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) pricing for your
account and region.

## Repository layout

```text
src/                    Lambda gateway, JWT validation, and SSM access
test/                   Node test suite
scripts/deploy.ps1      Build, package, and deploy the CloudFormation stack
scripts/create-users.ps1
scripts/upload-sense-key.mjs
scripts/smoke-upstream.mjs
template.yaml           AWS SAM / CloudFormation infrastructure
PROPOSAL.md              Architecture, threat model, costs, and rollout notes
```

For the detailed design rationale and acceptance criteria, see
[PROPOSAL.md](PROPOSAL.md).

## License and support

No license is currently granted beyond the rights provided by GitHub's terms of
service. This is a small personal project and comes without warranty or vendor
support.
