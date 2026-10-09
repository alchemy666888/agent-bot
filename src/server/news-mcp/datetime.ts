import "server-only";

import { z } from "zod";
import {
  assistantTimeZone,
  type CalendarClock,
} from "../../shared/calendar-clock";

export const DEFAULT_NEWS_MCP_URL = "https://news-mcp.vercel.app/api/mcp";
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const PROTOCOL_VERSION = "2025-11-25";

const zoneSchema = z
  .object({
    requested_timezone: z.string(),
    timezone: z.string(),
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    weekday: z.enum([
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .passthrough();

const toolResultSchema = z
  .object({
    structuredContent: z
      .object({ zones: z.array(zoneSchema).min(1).max(20) })
      .passthrough(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export type NewsMcpConfig = { url: string; apiKey: string };

export function readNewsMcpConfig(
  env: Record<string, string | undefined> = process.env,
): NewsMcpConfig {
  const apiKey = (env["NEWS-MCP-API-KEY"] ?? env.NEWS_MCP_API_KEY)?.trim();
  if (!apiKey || !KEY_PATTERN.test(apiKey))
    throw new Error("NEWS_MCP_API_KEY_INVALID");
  const url = env.NEWS_MCP_URL?.trim() || DEFAULT_NEWS_MCP_URL;
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error("NEWS_MCP_URL_INVALID");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" &&
      !(local && endpoint.protocol === "http:")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/api/mcp"
  )
    throw new Error("NEWS_MCP_URL_INVALID");
  return { url: endpoint.toString(), apiKey };
}

export type NewsMcpClockResult =
  | { ok: true; clock: CalendarClock }
  | { ok: false; code: "NEWS_MCP_UNAVAILABLE" };

/** Reads the live clock from news-mcp. The key stays in this server process. */
export async function fetchNewsMcpClock(options?: {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeZone?: string;
  signal?: AbortSignal;
}): Promise<NewsMcpClockResult> {
  let config: NewsMcpConfig;
  try {
    config = readNewsMcpConfig(options?.env);
  } catch {
    return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
  }
  const timeZone = options?.timeZone ?? assistantTimeZone();
  const request = options?.fetch ?? fetch;
  const deadline = AbortSignal.timeout(8_000);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  try {
    const endpoint = new URL(config.url);
    const headers = {
      authorization: `Bearer ${config.apiKey}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    const initialize = await request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "telegram-agent", version: "0.1.0" },
        },
      }),
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!initialize.ok) return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
    await initialize.body?.cancel();
    const notified = await request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!notified.ok && notified.status !== 202)
      return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
    await notified.body?.cancel();
    const called = await request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_current_datetime",
          arguments: { timezones: [timeZone] },
        },
      }),
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!called.ok) return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
    const payload = rpcPayload(
      await called.text(),
      called.headers.get("content-type"),
    );
    const parsed = toolResultSchema.safeParse(payload);
    if (!parsed.success || parsed.data.isError)
      return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
    const zone =
      parsed.data.structuredContent.zones.find(
        (item) =>
          item.timezone === timeZone || item.requested_timezone === timeZone,
      ) ?? parsed.data.structuredContent.zones[0];
    if (!zone) return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
    return {
      ok: true,
      clock: {
        isoDate: zone.date,
        year: zone.year,
        month: zone.month,
        day: zone.day,
        hour: zone.hour,
        minute: zone.minute,
        weekday: zone.weekday,
        timeZone: zone.timezone,
        source: "news_mcp",
      },
    };
  } catch {
    return { ok: false, code: "NEWS_MCP_UNAVAILABLE" };
  }
}

function rpcPayload(body: string, contentType: string | null): unknown {
  const encoded = contentType?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : body;
  if (!encoded) throw new Error("NEWS_MCP_UNAVAILABLE");
  const message = JSON.parse(encoded) as { result?: unknown; error?: unknown };
  if (message.error || message.result === undefined)
    throw new Error("NEWS_MCP_UNAVAILABLE");
  return message.result;
}
