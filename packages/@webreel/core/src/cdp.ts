import CDP from "chrome-remote-interface";
import type { CDPClient, CDPHeaderMap } from "./types.js";

export const REQUEST_HEADERS_ENV = "WEBREEL_REQUEST_HEADERS_JSON";
export const REQUEST_HEADERS_ORIGIN_ENV = "WEBREEL_REQUEST_HEADERS_ORIGIN";

export interface RequestHeaderConfig {
  origin: string;
  headers: Record<string, string>;
}

export function parseRequestHeaders(
  raw = process.env[REQUEST_HEADERS_ENV],
): Record<string, string> | undefined {
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
      throw new Error(`${REQUEST_HEADERS_ENV} header "${name}" must have a string value`);
    }
    headers[name] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function parseRequestHeaderOrigin(
  raw = process.env[REQUEST_HEADERS_ORIGIN_ENV],
): string | undefined {
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new Error(`${REQUEST_HEADERS_ORIGIN_ENV} must contain a valid URL origin`, {
      cause: err,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${REQUEST_HEADERS_ORIGIN_ENV} must use http or https`);
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `${REQUEST_HEADERS_ORIGIN_ENV} must contain only an origin, without credentials, path, query, or fragment`,
    );
  }

  return url.origin;
}

export function parseRequestHeaderConfig(): RequestHeaderConfig | undefined {
  const headers = parseRequestHeaders();
  const origin = parseRequestHeaderOrigin();

  if (!headers && !origin) return undefined;
  if (!headers) {
    throw new Error(
      `${REQUEST_HEADERS_ENV} is required when ${REQUEST_HEADERS_ORIGIN_ENV} is set`,
    );
  }
  if (!origin) {
    throw new Error(
      `${REQUEST_HEADERS_ORIGIN_ENV} is required when ${REQUEST_HEADERS_ENV} is set`,
    );
  }

  return { origin, headers };
}

export function mergeRequestHeaders(
  existing: CDPHeaderMap,
  injected: Record<string, string>,
): Array<{ name: string; value: string }> {
  const injectedNames = new Set(Object.keys(injected).map((name) => name.toLowerCase()));

  const headers = Object.entries(existing)
    .filter(([name]) => !injectedNames.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }));

  for (const [name, value] of Object.entries(injected)) {
    headers.push({ name, value });
  }

  return headers;
}

export async function configureScopedRequestHeaders(
  client: CDPClient,
  config: RequestHeaderConfig,
): Promise<void> {
  client.Fetch.requestPaused(async ({ requestId, request }) => {
    let requestOrigin: string | undefined;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      requestOrigin = undefined;
    }

    const headers =
      requestOrigin === config.origin
        ? mergeRequestHeaders(request.headers, config.headers)
        : Object.entries(request.headers).map(([name, value]) => ({
            name,
            value,
          }));

    try {
      await client.Fetch.continueRequest({ requestId, headers });
    } catch (err) {
      console.error(
        `Failed to continue an intercepted request for ${config.origin}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  await client.Fetch.enable({
    patterns: [
      {
        urlPattern: `${config.origin}/*`,
        requestStage: "Request",
      },
    ],
  });
}

export async function connectCDP(port: number): Promise<CDPClient> {
  const client = (await CDP({ port })) as unknown as CDPClient;
  const requestHeaderConfig = parseRequestHeaderConfig();

  if (requestHeaderConfig) {
    await configureScopedRequestHeaders(client, requestHeaderConfig);
  }

  return client;
}
