import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = join(repositoryRoot, "src/worker/cli.ts");
const artifact = join(repositoryRoot, "dist/worker.mjs");
const command = process.argv[2];

const buildOptions = {
  absWorkingDir: repositoryRoot,
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

async function buildTo(outfile) {
  await build({ ...buildOptions, outfile });
}

async function buildReleaseArtifact() {
  await mkdir(dirname(artifact), { recursive: true });
  const temporaryArtifact = `${artifact}.tmp`;
  await rm(temporaryArtifact, { force: true });
  await buildTo(temporaryArtifact);
  await rename(temporaryArtifact, artifact);
}

async function verifyReleaseArtifact() {
  await access(artifact, constants.R_OK).catch(() => {
    throw new Error("Worker artifact is missing; run pnpm worker:build");
  });
  const directory = await mkdtemp(join(tmpdir(), "worker-verify-"));
  const rebuilt = join(directory, "worker.mjs");
  try {
    await buildTo(rebuilt);
    const [releasedBytes, rebuiltBytes] = await Promise.all([
      readFile(artifact),
      readFile(rebuilt),
    ]);
    if (!releasedBytes.equals(rebuiltBytes))
      throw new Error(
        "Worker artifact is stale or non-deterministic; run pnpm worker:build",
      );

    const releasedText = releasedBytes.toString("utf8");
    const prohibitedNames = [
      "PROMPT_USER_KEY_SECRET",
      "PROMPT_OPERATOR_TELEGRAM_IDS",
      "GITHUB_TOKEN",
    ];
    const leakedNames = prohibitedNames.filter((name) =>
      releasedText.includes(name),
    );
    const secretEnvironmentNames = [
      ...prohibitedNames,
      "TELEGRAM_BOT_TOKEN",
      "DEEPSEEK_API_KEY",
      "DATABASE_URL",
      "DATABASE_MIGRATOR_URL",
      "VERCEL_OIDC_TOKEN",
    ];
    const knownSecretValues = secretEnvironmentNames
      .map((name) => [name, process.env[name]])
      .filter(([, value]) => typeof value === "string" && value.length >= 8)
      .filter(([, value]) => releasedText.includes(value));
    if (leakedNames.length || knownSecretValues.length)
      throw new Error(
        `Worker artifact contains prohibited deployment configuration: ${[
          ...leakedNames,
          ...knownSecretValues.map(([name]) => `${name} value`),
        ].join(", ")}`,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (command === "build") await buildReleaseArtifact();
else if (command === "verify") await verifyReleaseArtifact();
else throw new Error("Usage: worker-artifact.mjs <build|verify>");
