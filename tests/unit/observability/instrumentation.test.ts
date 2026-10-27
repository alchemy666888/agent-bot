import { describe, expect, it, vi } from "vitest";
import { onRequestError } from "../../../src/instrumentation";

describe("Next.js request exception logging", () => {
  it("logs server failures with route context without request headers or query values", () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      onRequestError(
        new Error("RENDER_FAILED", { cause: new Error("backend unavailable") }),
        {
          path: "/dashboard?secret=fixture",
          method: "GET",
          headers: { authorization: "Bearer fixture" },
        },
        {
          routerKind: "App Router",
          routePath: "/dashboard",
          routeType: "render",
          renderSource: "react-server-components",
          revalidateReason: undefined,
        },
      );
      const line = sink.mock.calls[0]![0] as string;
      const record = JSON.parse(line);
      expect(record.level).toBe("error");
      expect(record.metadata.route).toBe("/dashboard");
      expect(record.metadata.causes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "backend unavailable" }),
        ]),
      );
      expect(line).not.toMatch(/fixture|authorization|secret=/);
    } finally {
      sink.mockRestore();
    }
  });
});
