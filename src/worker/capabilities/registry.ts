import { z } from "zod";
import type { CapabilityRequest } from "../../shared/contracts";

export interface CapabilityAuditRecord {
  capabilityId: string;
  outcome: "success" | "denied" | "invalid" | "timeout" | "failure";
  durationMs: number;
}
export interface CapabilityDefinition {
  request: CapabilityRequest;
  /** Only general capabilities are offered to the router independently of a skill. */
  scope?: "general" | "skill";
  input: z.ZodType;
  timeoutMs?: number;
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}

function safeResult(value: unknown): unknown {
  const text = JSON.stringify(value) ?? "null";
  if (text.length > 20_000)
    return { truncated: true, value: text.slice(0, 20_000) };
  return JSON.parse(
    text.replace(
      /(?:api[_-]?key|authorization|token|cookie)\s*[=:]\s*[^\s",}]+/gi,
      "credential=[REDACTED]",
    ),
  );
}

export class CapabilityRegistry {
  static readonly MAX_ROUTING_CAPABILITIES = 200;
  private definitions = new Map<string, CapabilityDefinition>();
  constructor(definitions: CapabilityDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }
  register(definition: CapabilityDefinition) {
    if (this.definitions.has(definition.request.id))
      throw new Error("CAPABILITY_DUPLICATE");
    this.definitions.set(definition.request.id, definition);
  }
  requests(ids: readonly string[]): CapabilityRequest[] {
    return ids.map((id) => {
      const definition = this.definitions.get(id);
      if (!definition) throw new Error(`CAPABILITY_NOT_APPROVED:${id}`);
      return definition.request;
    });
  }
  /** A detached, deterministic snapshot of operator-registered general tools. */
  generalRequests(): CapabilityRequest[] {
    const requests = [...this.definitions.values()]
      .filter(({ scope }) => scope === "general")
      .sort((left, right) => left.request.id.localeCompare(right.request.id))
      .map(({ request }) => structuredClone(request));
    if (requests.length > CapabilityRegistry.MAX_ROUTING_CAPABILITIES)
      throw new Error("ROUTING_CAPABILITY_CATALOG_LIMIT_EXCEEDED");
    return requests;
  }
  async invoke(
    id: string,
    args: unknown,
    permitted: readonly string[],
    audit: (record: CapabilityAuditRecord) => void,
  ) {
    const started = Date.now();
    const definition = this.definitions.get(id);
    if (!definition || !permitted.includes(id)) {
      audit({
        capabilityId: id,
        outcome: "denied",
        durationMs: Date.now() - started,
      });
      throw new Error("CAPABILITY_DENIED");
    }
    const parsed = definition.input.safeParse(args);
    if (!parsed.success) {
      audit({
        capabilityId: id,
        outcome: "invalid",
        durationMs: Date.now() - started,
      });
      throw new Error("CAPABILITY_ARGUMENTS_INVALID");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        definition.timeoutMs ?? 8_000,
      );
      try {
        const value = await definition.execute(parsed.data, controller.signal);
        audit({
          capabilityId: id,
          outcome: "success",
          durationMs: Date.now() - started,
        });
        return safeResult(value);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable =
          status === 408 ||
          status === 429 ||
          (status !== undefined && status >= 500);
        if (attempt === 0 && retryable && !controller.signal.aborted) continue;
        audit({
          capabilityId: id,
          outcome: controller.signal.aborted ? "timeout" : "failure",
          durationMs: Date.now() - started,
        });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("CAPABILITY_FAILED");
  }
}
