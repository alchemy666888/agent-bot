import { afterEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
}));
const getVercelOidcToken = vi.hoisted(() => vi.fn());

vi.mock("@vercel/sandbox", () => ({ Sandbox: sandbox }));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken }));

import { vercelSandboxSdk } from "../../../../src/server/sandbox/sdk-adapter";

const input = {
  name: "agent",
  region: "sin1" as const,
  persistent: true as const,
  resume: false,
  timeout: 1_000,
  keepLastSnapshots: { count: 1 as const },
};

function oidcToken() {
  const body = Buffer.from(
    JSON.stringify({ owner_id: "team_1", project_id: "prj_1" }),
  ).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

const staleSnapshot = () =>
  Object.assign(new Error("Status code 400 is not ok"), {
    response: { status: 400 },
    json: { error: { code: "snapshot_not_found" } },
  });

describe("vercel sandbox sdk", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes the request OIDC token and does not resume during lookup", async () => {
    getVercelOidcToken.mockResolvedValue(oidcToken());
    const created = { name: "agent" };
    sandbox.getOrCreate.mockResolvedValue(created);
    await expect(vercelSandboxSdk.getOrCreateSandbox(input)).resolves.toBe(
      created,
    );
    expect(sandbox.getOrCreate).toHaveBeenCalledWith({
      name: "agent",
      region: "sin1",
      persistent: true,
      timeout: 1_000,
      keepLastSnapshots: { count: 1 },
      resume: false,
      token: oidcToken(),
      teamId: "team_1",
      projectId: "prj_1",
    });
  });

  it("deletes a sandbox whose snapshot is gone and creates a new one", async () => {
    getVercelOidcToken.mockResolvedValue(oidcToken());
    sandbox.getOrCreate.mockRejectedValue(staleSnapshot());
    sandbox.get.mockRejectedValue(staleSnapshot());
    const created = { name: "agent" };
    sandbox.create.mockResolvedValue(created);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(vercelSandboxSdk.getOrCreateSandbox(input)).resolves.toBe(
      created,
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v2/sandboxes/agent");
    expect(url).toContain("deleteOrphanSnapshots=true");
    expect(url).toContain("projectId=prj_1");
    expect(url).toContain("teamId=team_1");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { authorization: `Bearer ${oidcToken()}` },
    });
    expect(sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent",
        token: oidcToken(),
        teamId: "team_1",
        projectId: "prj_1",
      }),
    );
    expect(sandbox.create.mock.calls[0]?.[0]).not.toHaveProperty("resume");
  });
});
