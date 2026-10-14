import { type ChildProcessWithoutNullStreams } from "node:child_process";
/**
 * Terminate the complete process tree and do not return until the root process
 * has exited. On POSIX the worker is spawned as its own process group; on
 * Windows taskkill /T is the native tree-aware primitive.
 */
export declare function terminateProcessTree(child: ChildProcessWithoutNullStreams, options?: {
    graceMs?: number | undefined;
    forceWaitMs?: number | undefined;
}): Promise<void>;
