import "server-only";
import { uuidV7 } from "../../shared/ids";
import { logException } from "../../shared/logger";

const registered = Symbol.for("telegram-agent.runtime-error-logging");

/** Monitoring preserves Node's fatal-error behavior and does not consume rejections. */
export function registerRuntimeErrorLogging(): void {
  const state = globalThis as typeof globalThis & { [registered]?: boolean };
  if (state[registered]) return;
  state[registered] = true;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logException(error, {
      correlationId: uuidV7(),
      component: "controller",
      operation: "runtime.exception",
      stage: "runtime",
      metadata: { origin },
    });
  });
}
