import assert from "node:assert/strict";
import test from "node:test";

import { isTransientUpdateError } from "../shared/update-error.mjs";

const gateway504 = `504 "method: GET url: https://github.com/aiedwardyi/orbit-releases/releases/download/v1/latest.yml\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n" Data: <html><head><title>504 Gateway Time-out</title></head></html>
Headers: { "server": "GitHub.com" }`;

test("transient failures are recognised", () => {
  for (const message of [
    gateway504,
    "read ECONNRESET",
    "connect ETIMEDOUT 140.82.112.4:443",
    "getaddrinfo ENOTFOUND github.com",
    'Cannot download "https://x/latest.yml", status 429: Too Many Requests',
    "net::ERR_INTERNET_DISCONNECTED",
    "502 Bad Gateway",
  ]) {
    assert.equal(isTransientUpdateError(message), true, message);
  }
});

test("integrity and missing-feed failures are not transient", () => {
  for (const message of [
    "sha512 checksum mismatch, expected abc, got def",
    "New version 1.0.2 is not signed by the application owner",
    "Cannot find latest.yml in the latest release artifacts",
    "404 Not Found",
    "",
    undefined,
  ]) {
    assert.equal(isTransientUpdateError(message), false, String(message));
  }
});
