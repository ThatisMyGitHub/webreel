import CDP from "chrome-remote-interface";
import type { CDPClient } from "./types.js";

export const REQUEST_HEADERS_ENV = "WEBREEL_REQUEST_HEADERS_JSON";

export function parseRequestHeaders(raw = process.env[REQUEST_HEADERS_ENV]):
  | Record<string, string>
  | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${REQUEST_HEADERS_ENV} must contain a valid JSON object`, {
      cause: err,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${REQUEST_HEADERS_ENV} must contain a JSON object`);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name.trim().length === 0) {
      throw new Error(`${REQUEST_HEADERS_ENV} contains an empty header name`);
    }
    if (typeof value !== "string") {
      throw new Error(
        `${REQUEST_HEADERS_ENV} header "${name}" must have a string value`,
      );
    }
    headers[name] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function connectCDP(port: number): Promise<CDPClient> {
  const client = (await CDP({ port })) as unknown as CDPClient;
  const headers = parseRequestHeaders();

  if (headers) {
    await client.Network.enable();
    await client.Network.setExtraHTTPHeaders({ headers });
  }

  return client;
}
