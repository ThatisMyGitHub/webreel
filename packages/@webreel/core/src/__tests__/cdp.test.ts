import { afterEach, describe, expect, it } from "vitest";
import { parseRequestHeaders, REQUEST_HEADERS_ENV } from "../cdp.js";

describe("request headers", () => {
  afterEach(() => {
    delete process.env[REQUEST_HEADERS_ENV];
  });

  it("returns undefined when no request headers are configured", () => {
    expect(parseRequestHeaders()).toBeUndefined();
  });

  it("parses a string-valued header map", () => {
    process.env[REQUEST_HEADERS_ENV] = JSON.stringify({
      "X-Demo-Header": "demo-value",
      "CF-Access-Client-Id": "client-id",
    });

    expect(parseRequestHeaders()).toEqual({
      "X-Demo-Header": "demo-value",
      "CF-Access-Client-Id": "client-id",
    });
  });

  it("rejects invalid JSON", () => {
    process.env[REQUEST_HEADERS_ENV] = "not-json";
    expect(() => parseRequestHeaders()).toThrow(
      `${REQUEST_HEADERS_ENV} must contain a valid JSON object`,
    );
  });

  it("rejects arrays and non-string values", () => {
    expect(() => parseRequestHeaders("[]")).toThrow(
      `${REQUEST_HEADERS_ENV} must contain a JSON object`,
    );
    expect(() => parseRequestHeaders('{"X-Test":123}')).toThrow(
      `${REQUEST_HEADERS_ENV} header "X-Test" must have a string value`,
    );
  });
});
