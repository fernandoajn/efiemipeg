import { spawn } from "node:child_process";
import { basename } from "node:path";

const STALL_MS = 120000;

export interface RunOptions { signal: AbortSignal; onProgress?: (outTimeSeconds: number) => void }

// Runs FFmpeg or FFprobe without a shell. Kills the process if it is aborted or produces no output for two minutes.
export function runTool(command: string, args: string[], { signal, onProgress }: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let stalled = false;
    let watchdog: NodeJS.Timeout;
    const touch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; child.kill("SIGKILL"); }, STALL_MS);
    };
    const abort = () => child.kill("SIGKILL");
    touch();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      touch();
      if (!onProgress) { stdout += chunk; return; }
      // -progress pipe:1 writes key=value lines; out_time_us is how far into the output FFmpeg has encoded.
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (match) onProgress(Number(match[1]) / 1e6);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { touch(); stderr = (stderr + chunk).slice(-4000); });
    child.once("error", error => {
      clearTimeout(watchdog); signal.removeEventListener("abort", abort);
      reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${command} was not found. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH.`) : error);
    });
    child.once("close", code => {
      clearTimeout(watchdog); signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (stalled) reject(new Error(`${basename(command)} stopped making progress and was stopped.`));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`${basename(command)} exited with code ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}
