import { createCognitoVerifier } from "./auth.mjs";
import { createGateway } from "./core.mjs";
import { createDefaultParameterReader } from "./secrets.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

function parseBindings(value) {
  const bindings = JSON.parse(value);
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("CLIENT_BINDINGS must be a JSON object");
  }
  for (const [clientId, binding] of Object.entries(bindings)) {
    if (
      !clientId ||
      typeof binding?.username !== "string" ||
      typeof binding?.parameter !== "string" ||
      !binding.parameter.startsWith("/sense-mcp/")
    ) {
      throw new Error("CLIENT_BINDINGS contains an invalid entry");
    }
  }
  return bindings;
}

const issuer = required("COGNITO_ISSUER");
const region = required("AWS_REGION");

export const handler = createGateway({
  cognitoDomain: required("COGNITO_DOMAIN"),
  clientBindings: parseBindings(required("CLIENT_BINDINGS")),
  readScope: process.env.READ_SCOPE ?? "sense-mcp/read",
  writeScope: process.env.WRITE_SCOPE ?? "sense-mcp/write",
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "https://chatgpt.com,https://chat.openai.com")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  upstreamUrl: process.env.SENSE_MCP_URL ?? "https://api.getsense.ai/mcp/",
  verifyAccessToken: createCognitoVerifier({ issuer }),
  readSecureParameter: createDefaultParameterReader({ region }),
});
