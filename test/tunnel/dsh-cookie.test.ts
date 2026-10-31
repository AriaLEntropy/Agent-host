import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { applyDshCookie } from "../../src/tunnel/relay-client.js";
import { cookieName } from "../../src/connectors/dsh/auth.js";

const AUTHORITY = "127.0.0.1:3080";
const SECRET = Buffer.alloc(32, 7);

function cookieNames(header: string): string[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.slice(0, part.indexOf("=")));
}

test("no secret leaves the forwarded headers untouched", () => {
  const headers: Record<string, any> = { cookie: "theme=dark; session=abc" };
  applyDshCookie(headers, null, AUTHORITY);
  assert.deepEqual(headers, { cookie: "theme=dark; session=abc" });
});

test("a secret adds the signed cookie and keeps the other cookies", () => {
  const headers: Record<string, any> = { cookie: "theme=dark; session=abc" };
  applyDshCookie(headers, SECRET, AUTHORITY);

  assert.equal(headers.Cookie, undefined, "the duplicate capitalised key is dropped");
  const names = cookieNames(headers.cookie);
  assert.deepEqual(names, ["theme", "session", cookieName(AUTHORITY)]);
  assert.match(headers.cookie, new RegExp(`${cookieName(AUTHORITY)}=v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`));
});

test("an existing cookie with the same name is replaced, not duplicated", () => {
  const name = cookieName(AUTHORITY);
  const headers: Record<string, any> = {
    cookie: `theme=dark; ${name}=stale; session=abc`,
  };
  applyDshCookie(headers, SECRET, AUTHORITY, 1_700_000_000_000);

  const names = cookieNames(headers.cookie);
  assert.equal(names.filter((value) => value === name).length, 1);
  assert.deepEqual(names, ["theme", "session", name]);
  assert.doesNotMatch(headers.cookie, /=stale/);

  // A second pass with another secret swaps the value without growing the header.
  applyDshCookie(headers, randomBytes(32), AUTHORITY, 1_700_000_000_000);
  assert.equal(cookieNames(headers.cookie).length, 3);
});
