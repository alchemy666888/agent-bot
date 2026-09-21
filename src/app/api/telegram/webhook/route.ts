import { NextResponse } from "next/server";
import { readTelegramConfig } from "../../../../server/config";
import { extractTelegramInput } from "../../../../server/telegram/input";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const config = readTelegramConfig();
  if (
    request.headers.get("x-telegram-bot-api-secret-token") !==
    config.TELEGRAM_WEBHOOK_SECRET
  )
    return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const input = extractTelegramInput(await request.json());
    return NextResponse.json({ ok: true, kind: input.kind });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
