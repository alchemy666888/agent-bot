import { describe, expect, it } from "vitest";

import { postgresPoolConfig } from "../../../../src/shared/postgres/client";

describe("PostgreSQL client configuration", () => {
  it("uses the supplied Aiven CA for strict TLS verification", () => {
    const ca =
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    expect(
      postgresPoolConfig(
        "postgres://user:pass@db.test/app?sslmode=verify-full&application_name=agent",
        ca,
      ),
    ).toEqual({
      connectionString:
        "postgres://user:pass@db.test/app?application_name=agent",
      max: 3,
      allowExitOnIdle: true,
      ssl: { ca, rejectUnauthorized: true },
    });
  });

  it("retains URL SSL settings when no custom CA is configured", () => {
    const connectionString =
      "postgres://user:pass@db.test/app?sslmode=verify-full";
    expect(postgresPoolConfig(connectionString)).toEqual({
      connectionString,
      max: 3,
      allowExitOnIdle: true,
    });
  });
});
