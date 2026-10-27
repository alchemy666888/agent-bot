import type { Instrumentation } from "next";
import { uuidV7 } from "./shared/ids";
import { logException } from "./shared/logger";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerRuntimeErrorLogging } = await import("./server/observability/runtime");
    registerRuntimeErrorLogging();
  }
}

/** Next.js reports server rendering, route and Server Action exceptions here. */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  logException(error, {
    correlationId: uuidV7(),
    component: "controller",
    operation: "next.request",
    stage: "request",
    metadata: {
      method: request.method,
      route: context.routePath,
      routerKind: context.routerKind,
      routeType: context.routeType,
    },
  });
};
