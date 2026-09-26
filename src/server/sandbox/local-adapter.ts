import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, SandboxHandle, SandboxSdk } from "./sdk-adapter";

const ALLOWED_COMMANDS = new Set(["node", "test", "rm"]);

function commandResult(
  exitCode: number,
  stdout: string,
  stderr: string,
): CommandResult {
  return {
    exitCode,
    stdout: async () => stdout,
    stderr: async () => stderr,
  };
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(commandResult(127, stdout, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(commandResult(code ?? 1, stdout, stderr));
    });
  });
}

function localHandle(root: string): SandboxHandle {
  return {
    name: "local-worker",
    region: "sin1",
    mounts: { "/workspace": { localRoot: root } },
    status: "running",
    async writeFiles(files) {
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, { mode: 0o600 });
      }
    },
    async runCommand(command, args = [], options) {
      if (!ALLOWED_COMMANDS.has(command))
        return commandResult(127, "", "COMMAND_REJECTED");
      if (
        command === "rm" &&
        args.some(
          (arg) =>
            !arg.startsWith("-") && !arg.startsWith("/tmp/telegram-agent"),
        )
      )
        return commandResult(1, "", "PATH_REJECTED");
      return runProcess(
        command,
        args,
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          NODE_ENV: process.env.NODE_ENV ?? "production",
          TELEGRAM_AGENT_ROOT: root,
          ...options?.env,
        },
        options?.timeoutMs ?? 120_000,
      );
    },
    async readFileToBuffer(file) {
      try {
        return await readFile(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async readFile(file) {
      try {
        await stat(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return createReadStream(file.path);
    },
  };
}

/** Test-only private worker adapter. Ignored whenever `VERCEL` is set. */
export function createLocalSandboxSdk(root: string): SandboxSdk {
  const sandbox = localHandle(root);
  return {
    async getOrCreateDrive(input) {
      await mkdir(root, { recursive: true });
      return { name: input.name, region: "sin1" };
    },
    async getOrCreateSandbox(input) {
      return {
        ...sandbox,
        name: input.name,
        region: "sin1",
        mounts: { "/workspace": { name: input.name } },
      };
    },
  };
}
