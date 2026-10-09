import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NEWS_MCP_URL,
  fetchNewsMcpClock,
  readNewsMcpConfig,
} from "../../../../src/server/news-mcp/datetime";

const apiKey = "00000000-0000-4000-8000-000000000000";
const zone = {
  requested_timezone: "Asia/Hong_Kong",
  timezone: "Asia/Hong_Kong",
  year: 2026,
  month: 10,
  day: 9,
  weekday: "Friday",
  weekday_number: 5,
  hour: 16,
  minute: 8,
  second: 44,
  millisecond: 832,
  utc_offset: "+08:00",
  date: "2026-10-09",
  time: "16:08:44.832",
  datetime: "2026-10-09T16:08:44.832+08:00",
};

function sse(result: unknown): Response {
  return new Response(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("news-mcp clock", () => {
  it("reads the UUID bearer key from either Vercel name", () => {
    expect(readNewsMcpConfig({ "NEWS-MCP-API-KEY": apiKey }).apiKey).toBe(
      apiKey,
    );
    expect(readNewsMcpConfig({ NEWS_MCP_API_KEY: apiKey })).toEqual({
      apiKey,
      url: DEFAULT_NEWS_MCP_URL,
    });
    expect(() => readNewsMcpConfig({})).toThrow("NEWS_MCP_API_KEY_INVALID");
    expect(() =>
      readNewsMcpConfig({
        NEWS_MCP_API_KEY: apiKey,
        NEWS_MCP_URL: "http://news.example/api/mcp",
      }),
    ).toThrow("NEWS_MCP_URL_INVALID");
  });

  it("calls get_current_datetime and keeps the key out of the result", async () => {
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      expect(String(url)).toBe(DEFAULT_NEWS_MCP_URL);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${apiKey}`,
      );
      if (body.method === "initialize")
        return sse({ protocolVersion: "2025-11-25" });
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      expect(body.method).toBe("tools/call");
      return sse({
        content: [{ type: "text", text: JSON.stringify({ zones: [zone] }) }],
        structuredContent: { zones: [zone] },
      });
    });
    const result = await fetchNewsMcpClock({
      env: { "NEWS-MCP-API-KEY": apiKey },
      fetch: fetcher as typeof fetch,
      timeZone: "Asia/Hong_Kong",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      clock: {
        isoDate: "2026-10-09",
        year: 2026,
        month: 10,
        day: 9,
        hour: 16,
        minute: 8,
        weekday: "Friday",
        timeZone: "Asia/Hong_Kong",
        source: "news_mcp",
      },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("reports an unavailable clock without throwing", async () => {
    await expect(
      fetchNewsMcpClock({ env: {}, fetch: vi.fn() as typeof fetch }),
    ).resolves.toEqual({ ok: false, code: "NEWS_MCP_UNAVAILABLE" });
  });
});
