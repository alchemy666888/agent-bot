import { describe, expect, it } from "vitest";
import { secureSecretEqual } from "../../../../src/server/auth/secret";
import {
  createSession,
  sessionCookieOptions,
  validateSession,
} from "../../../../src/server/auth/session";
import { isDownloadAuthorized } from "../../../../src/server/auth/guards";
describe("dashboard authentication", () => {
  it("accepts arbitrary nonempty Unicode secrets", () =>
    expect(secureSecretEqual("🔐 not-a-uuid", "🔐 not-a-uuid", "signing")).toBe(
      true,
    ));
  it("fails closed for empty and unequal secrets", () => {
    expect(secureSecretEqual("", "", "x")).toBe(false);
    expect(secureSecretEqual("x", "xx", "key")).toBe(false);
  });
  it("signs 24-hour tamper-resistant sessions", () => {
    const value = createSession("signing", 100);
    expect(validateSession(value, "signing", 101)).toBe(true);
    expect(validateSession(value + "x", "signing", 101)).toBe(false);
    expect(validateSession(value, "signing", 86400101)).toBe(false);
    expect(sessionCookieOptions).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
  });
  it("accepts one exact bearer or valid cookie", () => {
    const common = { adminSecret: "admin", signingSecret: "sign" };
    expect(
      isDownloadAuthorized({
        ...common,
        authorization: "Bearer admin",
        cookie: undefined,
      }),
    ).toBe(true);
    expect(
      isDownloadAuthorized({
        ...common,
        authorization: "Bearer wrong, Bearer admin",
        cookie: undefined,
      }),
    ).toBe(false);
    expect(
      isDownloadAuthorized({
        ...common,
        authorization: null,
        cookie: createSession("sign"),
      }),
    ).toBe(true);
  });
});
