import { createRemoteJWKSet, jwtVerify } from "jose";

export function createCognitoVerifier({ issuer, fetchTimeoutMs = 5_000 }) {
  if (!issuer?.startsWith("https://")) {
    throw new Error("COGNITO_ISSUER must be an HTTPS URL");
  }

  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    timeoutDuration: fetchTimeoutMs,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });

  return async function verifyAccessToken(token, resource) {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      audience: resource,
      clockTolerance: 5,
      issuer,
    });

    if (payload.token_use !== "access") {
      throw new Error("Wrong token type");
    }
    if (typeof payload.sub !== "string" || typeof payload.client_id !== "string") {
      throw new Error("Required access-token claims are missing");
    }
    if (typeof payload.username !== "string" || typeof payload.scope !== "string") {
      throw new Error("Required authorization claims are missing");
    }

    return payload;
  };
}
