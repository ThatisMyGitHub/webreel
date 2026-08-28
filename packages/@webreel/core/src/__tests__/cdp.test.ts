import { afterEach, describe, expect, it } from "vitest";
import {
  mergeRequestHeaders,
  parseRequestHeaderConfig,
  parseRequestHeaderOrigin,
  parseRequestHeaders,
  REQUEST_HEADERS_ENV,
  REQUEST_HEADERS_ORIGIN_ENV,
} from "../cdp.js";

describe("request headers", () => {
  afterEach(() => {
    delete process.env[REQUEST_HEADERS_ENV];
    delete process.env[REQUEST_HEADERS_ORIGIN_ENV];
  });

  it("returns undefined when no request headers are configured", () => {
    expect(parseRequestHeaders()).toBeUndefined();
    expect(parseRequestHeaderOrigin()).toBeUndefined();
    expect(parseRequestHeaderConfig()).toBeUndefined();
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

  it("normalizes an explicit http or https origin", () => {
    expect(parseRequestHeaderOrigin("https://example.com/")).toBe(
      "https://example.com",
    );
    expect(parseRequestHeaderOrigin("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  it("requires headers and origin together", () => {
    process.env[REQUEST_HEADERS_ENV] = '{"X-Test":"value"}';
    expect(() => parseRequestHeaderConfig()).toThrow(
      `${REQUEST_HEADERS_ORIGIN_ENV} is required when ${REQUEST_HEADERS_ENV} is set`,
    );

    delete process.env[REQUEST_HEADERS_ENV];
    process.env[REQUEST_HEADERS_ORIGIN_ENV] = "https://example.com";
    expect(() => parseRequestHeaderConfig()).toThrow(
      `${REQUEST_HEADERS_ENV} is required when ${REQUEST_HEADERS_ORIGIN_ENV} is set`,
    );
  });

  it("rejects origins with unsupported schemes or URL components", () => {
    expect(() => parseRequestHeaderOrigin("file:///tmp/demo")).toThrow(
      `${REQUEST_HEADERS_ORIGIN_ENV} must use http or https`,
    );
    expect(() => parseRequestHeaderOrigin("https://example.com/private")).toThrow(
      `${REQUEST_HEADERS_ORIGIN_ENV} must contain only an origin`,
    );
    expect(() => parseRequestHeaderOrigin("https://user@example.com")).toThrow(
      `${REQUEST_HEADERS_ORIGIN_ENV} must contain only an origin`,
    );
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

  it("replaces existing headers case-insensitively without changing others", () => {
    expect(
      mergeRequestHeaders(
        {
          Accept: "text/html",
          "x-demo-header": "old-value",
        },
        {
          "X-Demo-Header": "new-value",
          Authorization: "Bearer token",
        },
      ),
    ).toEqual([
      { name: "Accept", value: "text/html" },
      { name: "X-Demo-Header", value: "new-value" },
      { name: "Authorization", value: "Bearer token" },
    ]);
  });
});
