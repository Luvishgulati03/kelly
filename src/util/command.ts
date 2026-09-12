import { spawn } from "node:child_process";
import { safeEnvironment } from "./env.ts";

export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; }

export function runCommand(command: string, args: string[], cwd: string, input?: string): Promise<CommandResult> {
  const child = spawn(command, args, { cwd, env: safeEnvironment(undefined, { CI: "1" }), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: null }));
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
