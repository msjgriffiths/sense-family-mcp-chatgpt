import { execFileSync } from "node:child_process";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const profile = "sense-mcp";
const region = "us-east-2";
const awsCli = process.env.AWS_CLI_PATH ?? "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe";
const exported = JSON.parse(
  execFileSync(
    awsCli,
    ["configure", "export-credentials", "--profile", profile, "--region", region, "--format", "process"],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ),
);

const client = new SSMClient({
  region,
  credentials: {
    accessKeyId: exported.AccessKeyId,
    secretAccessKey: exported.SecretAccessKey,
    sessionToken: exported.SessionToken,
    expiration: exported.Expiration ? new Date(exported.Expiration) : undefined,
  },
});

const parameter = await client.send(new GetParameterCommand({
  Name: "/sense-mcp/primary/key",
  WithDecryption: true,
}));
const key = parameter.Parameter?.Value;
if (!/^sense_\S{10,500}$/.test(key ?? "")) throw new Error("Stored primary Sense key is invalid");

async function rpc(id, method, params = {}) {
  const response = await fetch("https://api.getsense.ai/mcp/", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Sense MCP ${method} failed with HTTP ${response.status}`);
  return response.json();
}

const initialized = await rpc(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "sense-mcp-gateway-smoke", version: "0.1.0" },
});
const listed = await rpc(2, "tools/list");
const toolNames = new Set(listed.result?.tools?.map((tool) => tool.name));
const required = ["get_events", "create_event", "update_event", "create_reminder"];

console.log(JSON.stringify({
  server: initialized.result?.serverInfo?.name,
  version: initialized.result?.serverInfo?.version,
  protocolVersion: initialized.result?.protocolVersion,
  toolCount: toolNames.size,
  requiredToolsPresent: required.every((name) => toolNames.has(name)),
}, null, 2));
