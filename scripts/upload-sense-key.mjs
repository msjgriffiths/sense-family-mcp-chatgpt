import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const person = option("--person");
const file = option("--file");
const profile = option("--profile", "sense-mcp");
const region = option("--region", "us-east-2");
if (!new Set(["primary", "partner"]).has(person) || !file) {
  throw new Error("Usage: node scripts/upload-sense-key.mjs --person primary|partner --file <path>");
}

function parseKey(contents) {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const named = lines.find((line) => /^(SENSE_API_KEY\s*=|api_key\s*:)/i.test(line));
  const raw = named ? named.replace(/^(SENSE_API_KEY\s*=|api_key\s*:)/i, "").trim() : lines[0];
  const key = raw?.replace(/^("|')|("|')$/g, "").trim();
  if (!/^sense_\S{10,500}$/.test(key)) throw new Error("Key file does not contain a valid Sense key");
  return key;
}

const key = parseKey(await readFile(file, "utf8"));
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
const name = `/sense-mcp/${person}/key`;
const result = await client.send(
  new PutParameterCommand({
    Name: name,
    Type: "SecureString",
    Tier: "Standard",
    Value: key,
    Overwrite: true,
    Description: `Sense MCP API key for ${person} Cognito identity`,
  }),
);
console.log(`Stored ${name} as encrypted Standard parameter version ${result.Version}.`);
