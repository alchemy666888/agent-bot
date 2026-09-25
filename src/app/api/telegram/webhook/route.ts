import { NextResponse } from "next/server";
import { readTelegramConfig } from "../../../../server/config";
import { dispatchTelegramInput } from "../../../../server/telegram/dispatch";
import { extractTelegramInput } from "../../../../server/telegram/input";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const config = readTelegramConfig();
  if (
    request.headers.get("x-telegram-bot-api-secret-token") !==
    config.TELEGRAM_WEBHOOK_SECRET
  )
    return NextResponse.json(
      { ok: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  let input;
  try {
    input = extractTelegramInput(await request.json());
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const response = await dispatchTelegramInput(input);
    if (!response.ok) {
      const retryable = response.error?.classification === "transient";
      return NextResponse.json(
        { ok: false },
        {
          status: retryable ? 503 : 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
