import { describe, expect, it } from "vitest";
import { secureSecretEqual } from "../../../../src/server/auth/secret";
import {
  createSession,
  sessionCookieOptions,
  validateSession,
} from "../../../../src/server/auth/session";
import { isDownloadAuthorized } from "../../../../src/server/auth/guards";
import {
  browserUrl,
  isSameOriginSubmission,
} from "../../../../src/server/auth/origin";
describe("dashboard authentication", () => {
  it("accepts same-origin posts and opaque browser origins", () => {
    const same = new Request("http://127.0.0.1/logout", {
      method: "POST",
      headers: { origin: "http://127.0.0.1" },
    });
    const opaque = new Request("http://127.0.0.1/logout", {
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    });
    const cross = new Request("http://127.0.0.1/logout", {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    const rewritten = new Request("http://localhost/logout", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(isSameOriginSubmission(same)).toBe(true);
    expect(isSameOriginSubmission(opaque)).toBe(true);
    expect(isSameOriginSubmission(cross)).toBe(false);
    expect(isSameOriginSubmission(rewritten)).toBe(true);
    expect(
      browserUrl(
        new Request("http://localhost/login/submit", {
          headers: { origin: "http://127.0.0.1:3000" },
        }),
        "/dashboard",
      ).href,
    ).toBe("http://127.0.0.1:3000/dashboard");
  });
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
