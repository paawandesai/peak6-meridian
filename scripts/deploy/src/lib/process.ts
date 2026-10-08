import { execFile } from "node:child_process";

export type CommandResult = { readonly stdout: string; readonly stderr: string };

/**
 * Runs a command without a shell. A failure names the command, its exit status and the last
 * lines of its output (the commands here are `make` and `solana`, whose output holds paths and
 * public keys; arguments are key FILE paths and public keys, never key bytes, and are not echoed).
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    /** Applied to the output tail before it is thrown (for example RPC URL redaction). */
    readonly redact?: (text: string) => string;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 20 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const status = typeof error.code === "number" ? `exit ${error.code}` : String(error.code);
          const tail = `${stdout}\n${stderr}`
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(-15)
            .join("\n");
          const text = `${command} ${args[0] ?? ""} failed (${status})\n${tail}`;
          reject(new Error(options.redact === undefined ? text : options.redact(text)));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}
