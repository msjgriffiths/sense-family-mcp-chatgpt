import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export function createParameterReader({ client, cacheTtlMs = 300_000, now = Date.now }) {
  const cache = new Map();

  return async function readSecureParameter(name) {
    const cached = cache.get(name);
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) {
      return cached.value;
    }

    const response = await client.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const value = response.Parameter?.Value;
    if (typeof value !== "string" || value.trim().length < 16) {
      throw new Error("Sense credential is unavailable");
    }

    cache.set(name, { value: value.trim(), expiresAt: currentTime + cacheTtlMs });
    return value.trim();
  };
}
export function createDefaultParameterReader({ region }) {
  return createParameterReader({ client: new SSMClient({ region }) });
}
