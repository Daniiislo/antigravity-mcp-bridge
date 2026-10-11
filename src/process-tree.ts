import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(confirmed);
    };
    killer.once("error", () => finish(false));
    killer.once("exit", (code) => finish(code === 0));
    timer = setTimeout(() => {
      if (!settled) killer.kill();
      finish(false);
    }, 5_000);
    timer.unref();
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Terminate the complete process tree and do not return until the root process
 * has exited. On POSIX the worker is spawned as its own process group; on
 * Windows taskkill /T is the native tree-aware primitive.
 */
export async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  options: { graceMs?: number | undefined; forceWaitMs?: number | undefined } = {}
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const graceMs = options.graceMs ?? 750;
  const forceWaitMs = options.forceWaitMs ?? 5_000;

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Could not confirm termination of Windows process tree rooted at PID ${pid}: the root exited before tree cleanup`
      );
    }
    const treeKillConfirmed = await runTaskkill(pid);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const rootExited = await waitForExit(child, forceWaitMs);
    if (!treeKillConfirmed || !rootExited) {
      throw new Error(`Could not confirm termination of Windows process tree rooted at PID ${pid}`);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  const [, groupExited] = await Promise.all([
    waitForExit(child, graceMs),
    waitForProcessGroupExit(pid, graceMs)
  ]);
  if (groupExited) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const [rootExited, forcedGroupExit] = await Promise.all([
    waitForExit(child, forceWaitMs),
    waitForProcessGroupExit(pid, forceWaitMs)
  ]);
  if (!rootExited || !forcedGroupExit) {
    throw new Error(`Could not confirm termination of POSIX process group ${pid}`);
  }
}
