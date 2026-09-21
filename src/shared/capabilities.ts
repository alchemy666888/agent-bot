import type { ModelRequest, ModelResponse } from "./contracts";

/** Reserved extension seam. No capability is registered or executable in this release. */
export interface FutureCapabilityBoundary {
  readonly enabled: false;
  afterModel(
    request: Readonly<ModelRequest>,
    response: Readonly<ModelResponse>,
  ): Promise<ModelResponse>;
}
