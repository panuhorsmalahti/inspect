import { runCliCommandInjectionToken } from "@k8slens/cli-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { comparer, computed, observable, onBecomeObserved, onBecomeUnobserved, reaction, runInAction } from "mobx";
import { expandedProcessesInjectable } from "./expanded-processes.injectable";
import { kubeContextOfClusterInjectable } from "./kube-context-of-cluster.injectable";
import { type OpenFile, openFileOf, type ProcessFiles, socketsOf } from "./open-files";
import { quoteForShell } from "./quote-for-shell";

export interface ProcessThread {
  readonly tid: number;
  readonly name: string;
  readonly state: string;
  /** Of one CPU, over the time since the previous listing; unknown on the first. */
  readonly cpuPercent: number | undefined;
  /** The average of its CPU % and its process's memory %, the memory being shared. */
  readonly resourcesUsedPercent: number | undefined;
}

export interface ContainerProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly state: string;
  /** Of one CPU, over the time since the previous listing; unknown on the first. */
  readonly cpuPercent: number | undefined;
  /** Resident memory, of what `memoryOf` says; unknown when the container would not tell. */
  readonly memoryPercent: number | undefined;
  readonly command: string;
  /** The average of its CPU % and memory %; unknown while either is. */
  readonly resourcesUsedPercent: number | undefined;
  /** The main thread among them, its tid being the pid. They share the process's memory. */
  readonly threads: readonly ProcessThread[];
  /** Listed only for the processes asked for; undefined for the rest. */
  readonly files: ProcessFiles | undefined;
}

/** What memory is a percentage of: the container's limit, or the node's memory for a container without one. */
export type MemoryOf = "limit" | "node";

export type ContainerProcesses =
  | { readonly status: "finding-context" }
  | { readonly status: "needs-context" }
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly processes: readonly ContainerProcess[];
      readonly memoryOf: MemoryOf | undefined;
    }
  | { readonly status: "failed"; readonly message: string; readonly hasNoShell: boolean };

export const refreshIntervalMs = 3000;

// Reads /proc rather than running `ps`, which many images leave out: it needs only a shell, `cat`
// and `tr`. A process ending while it is read is skipped, and nothing it says on stderr reaches
// Lens, which would take any of it for a failure. Its arguments are the pids to list the open files
// of, along with the sockets of the container's network, which tell what ports they are.
const listProcessesScript = [
  // Kept before `set --` takes the positional parameters over.
  'files=" $* "',
  "{",
  "read -r uptime _ < /proc/uptime",
  'echo "UPTIME $uptime"',
  'echo "SELF $$"',
  // The node's memory in KiB, and the container's limit in bytes: cgroup v2, else v1. Without a
  // limit, v2 says "max" and v1 a number larger than the node.
  'while read -r key value _; do [ "$key" = MemTotal: ] && { echo "MEMTOTAL $value"; break; }; done < /proc/meminfo',
  "limit=",
  "[ -r /sys/fs/cgroup/memory.max ] && read -r limit < /sys/fs/cgroup/memory.max",
  "[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ] && read -r limit < /sys/fs/cgroup/memory/memory.limit_in_bytes",
  'echo "LIMIT $limit"',
  "for dir in /proc/[0-9]*; do",
  '  read -r stat < "$dir/stat" || continue',
  '  status=$(cat "$dir/status")',
  '  [ -n "$status" ] || continue',
  '  command=$(tr "\\000\\n" "  " < "$dir/cmdline")',
  "  name=${stat#*\\(}",
  "  name=${name%\\)*}",
  "  set -- ${stat##*\\)}",
  "  state=$1",
  "  parent=$2",
  "  ticks=$((${12} + ${13}))",
  "  rss=0",
  '  case $status in *VmRSS:*) set -- ${status#*VmRSS:}; rss=$1 ;; esac',
  '  printf "P\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "${dir#/proc/}" "$parent" "$state" "$rss" "$ticks" "${command:-[$name]}"',
  // Its threads, with nothing but builtins: a process may have hundreds.
  '  for task in "$dir"/task/[0-9]*; do',
  '    read -r stat < "$task/stat" || continue',
  "    name=${stat#*\\(}",
  "    name=${name%\\)*}",
  "    set -- ${stat##*\\)}",
  '    printf "T\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "${dir#/proc/}" "${task##*/}" "$1" "$((${12} + ${13}))" "$name"',
  "  done",
  '  case $files in *" ${dir#/proc/} "*)',
  '    if [ -r "$dir/fd" ]; then',
  '      printf "FD\\t%s\\treadable\\n" "${dir#/proc/}"',
  '      ls -l "$dir/fd" | while IFS= read -r line; do printf "F\\t%s\\t%s\\n" "${dir#/proc/}" "$line"; done',
  "    else",
  '      printf "FD\\t%s\\tunreadable\\n" "${dir#/proc/}"',
  "    fi ;;",
  "  esac",
  "done",
  "case $files in *[0-9]*)",
  "  for table in tcp tcp6 udp udp6 unix; do",
  "    [ -r /proc/net/$table ] || continue",
  '    while IFS= read -r line; do printf "N\\t%s\\t%s\\n" "$table" "$line"; done < /proc/net/$table',
  "  done ;;",
  "esac",
  "} 2>/dev/null",
  "exit 0",
].join("\n");

interface Sample {
  readonly uptimeSeconds: number;
  readonly ticksByPid: ReadonlyMap<number, number>;
  // Apart from the processes': a main thread's tid is its process's pid, with ticks of its own.
  readonly ticksByTid: ReadonlyMap<number, number>;
}

// Linux reports CPU time in ticks of 1/100 s to user space.
const ticksPerSecond = 100;

const valueAfter = (lines: readonly string[], key: string) =>
  lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);

// What resident memory is a percentage of, in KiB: the container's limit, unless it has none or
// one beyond the node, where it is the node's memory.
const memoryTotalOf = (lines: readonly string[]): { readonly of: MemoryOf; readonly kiB: number } | undefined => {
  const nodeKiB = Number(valueAfter(lines, "MEMTOTAL"));
  // "max" and nothing at all are no limit; NaN and 0 fail the comparison below.
  const limitKiB = Number(valueAfter(lines, "LIMIT") || Number.NaN) / 1024;

  if (limitKiB > 0 && !(limitKiB >= nodeKiB)) {
    return { of: "limit", kiB: limitKiB };
  }

  return nodeKiB > 0 ? { of: "node", kiB: nodeKiB } : undefined;
};

const averageOf = (cpuPercent: number | undefined, memoryPercent: number | undefined) =>
  cpuPercent === undefined || memoryPercent === undefined ? undefined : (cpuPercent + memoryPercent) / 2;

const parseListing = (output: string, previous: Sample | undefined) => {
  const lines = output.split("\n");
  const uptimeSeconds = Number(valueAfter(lines, "UPTIME"));
  const selfPid = Number(valueAfter(lines, "SELF"));
  const memoryTotal = memoryTotalOf(lines);
  const elapsedSeconds = previous ? uptimeSeconds - previous.uptimeSeconds : 0;
  const ticksByPid = new Map<number, number>();
  const ticksByTid = new Map<number, number>();
  const threadsByPid = new Map<number, Omit<ProcessThread, "resourcesUsedPercent">[]>();
  const processes: ContainerProcess[] = [];

  const cpuPercentOf = (ticks: number, previousTicks: number | undefined) =>
    previousTicks !== undefined && elapsedSeconds > 0
      ? Math.max(0, ((ticks - previousTicks) / ticksPerSecond / elapsedSeconds) * 100)
      : undefined;

  for (const line of lines) {
    if (!line.startsWith("T\t")) {
      continue;
    }

    const [, pid, tid, state, ticks, ...name] = line.split("\t");
    const thread = { pid: Number(pid), tid: Number(tid), ticks: Number(ticks) };
    const threads = threadsByPid.get(thread.pid) ?? [];

    ticksByTid.set(thread.tid, thread.ticks);
    threads.push({
      tid: thread.tid,
      name: name.join("\t"),
      state: state ?? "",
      cpuPercent: cpuPercentOf(thread.ticks, previous?.ticksByTid.get(thread.tid)),
    });
    threadsByPid.set(thread.pid, threads);
  }

  const sockets = socketsOf(
    lines
      .filter((line) => line.startsWith("N\t"))
      .map((line) => {
        const [, table = "", ...rest] = line.split("\t");

        return { table, line: rest.join("\t") };
      }),
  );

  const openFilesByPid = new Map<number, OpenFile[]>();
  const unreadableFiles = new Set<number>();

  for (const line of lines) {
    const [kind, pid, ...rest] = line.split("\t");

    if (kind === "FD") {
      if (rest[0] === "readable") {
        openFilesByPid.set(Number(pid), []);
      } else {
        unreadableFiles.add(Number(pid));
      }
    } else if (kind === "F") {
      // `lrwx------ 1 root root 64 Oct  2 10:00 3 -> socket:[12345]`: the descriptor, and what it is
      // open on. Without what it is open on when that may not be read, which takes more than root:
      // being allowed to trace the process.
      const [, fd, target] = /^l\S*\s.*?\s(\d+)(?: -> (.*))?$/.exec(rest.join("\t")) ?? [];

      if (fd !== undefined && target === undefined) {
        unreadableFiles.add(Number(pid));
      } else if (fd !== undefined && target !== undefined) {
        openFilesByPid.get(Number(pid))?.push(openFileOf(Number(fd), target, sockets));
      }
    }
  }

  const filesOf = (pid: number): ProcessFiles | undefined => {
    const files = openFilesByPid.get(pid);

    if (unreadableFiles.has(pid)) {
      return { readable: false };
    }

    return files && { readable: true, files: files.sort((left, right) => left.fd - right.fd) };
  };

  for (const line of lines) {
    if (!line.startsWith("P\t")) {
      continue;
    }

    const [, pid, parentPid, state, residentKiB, ticks, ...command] = line.split("\t");
    const process = {
      pid: Number(pid),
      parentPid: Number(parentPid),
      ticks: Number(ticks),
    };

    // The shell listing the processes, and what it ran to do so.
    if (process.pid === selfPid || process.parentPid === selfPid) {
      continue;
    }

    const cpuPercent = cpuPercentOf(process.ticks, previous?.ticksByPid.get(process.pid));
    const memoryPercent = memoryTotal ? (Number(residentKiB) / memoryTotal.kiB) * 100 : undefined;

    ticksByPid.set(process.pid, process.ticks);
    processes.push({
      pid: process.pid,
      parentPid: process.parentPid,
      state: state ?? "",
      cpuPercent,
      memoryPercent,
      command: command.join("\t").trim(),
      resourcesUsedPercent: averageOf(cpuPercent, memoryPercent),
      threads: (threadsByPid.get(process.pid) ?? [])
        .map((thread) => ({ ...thread, resourcesUsedPercent: averageOf(thread.cpuPercent, memoryPercent) }))
        .sort((left, right) => left.tid - right.tid),
      files: filesOf(process.pid),
    });
  }

  return {
    processes: processes.sort((left, right) => left.pid - right.pid),
    memoryOf: memoryTotal?.of,
    sample: { uptimeSeconds, ticksByPid, ticksByTid },
  };
};

const hasNoShell = (message: string) => /executable file not found|no such file or directory/i.test(message) && /"sh"/.test(message);

/**
 * The processes running in a container, listed with `kubectl exec` through the kubeconfig context
 * of the cluster, again every few seconds for as long as something observes the computed.
 */
export const containerProcessesInjectable = getInjectable2({
  id: "inspect-container-processes",
  consumptions: [runCliCommandInjectionToken],

  instantiate: (di) => {
    const runCliCommand = di.inject(runCliCommandInjectionToken)();

    return (clusterId: string, namespace: string, podName: string, containerName: string) => {
      const { choice } = di.inject(kubeContextOfClusterInjectable)(clusterId);
      const { listingFilesOf } = di.inject(expandedProcessesInjectable)(clusterId, namespace, podName, containerName);
      const state = observable.box<ContainerProcesses>({ status: "loading" }, { deep: false });
      // Bumped for each context listed through, so that what a previous one answers late is dropped.
      let generation = 0;
      let context: string | undefined;
      let sample: Sample | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let runningAs: number | undefined;
      let listAgainAtOnce = false;
      let stopReacting: (() => void)[] = [];

      const stop = () => {
        generation++;
        context = undefined;
        sample = undefined;
        listAgainAtOnce = false;
        clearTimeout(timer);
        timer = undefined;
      };

      const commandFor = (listedContext: string, filesOf: readonly number[]) =>
        [
          "kubectl",
          `--context=${quoteForShell(listedContext)}`,
          `--namespace=${quoteForShell(namespace)}`,
          "--request-timeout=15s",
          "exec",
          quoteForShell(podName),
          `--container=${quoteForShell(containerName)}`,
          "--",
          "sh",
          "-c",
          quoteForShell(listProcessesScript),
          // What the script sees as its own name, the pids following it.
          "sh",
          ...filesOf.map(String),
        ].join(" ");

      const list = async (listedContext: string, startedAs: number) => {
        clearTimeout(timer);
        timer = undefined;
        runningAs = startedAs;

        let keepListing = true;

        try {
          const listing = parseListing(await runCliCommand(commandFor(listedContext, listingFilesOf.get())), sample);

          if (startedAs === generation) {
            sample = listing.sample;
            runInAction(() => state.set({ status: "loaded", processes: listing.processes, memoryOf: listing.memoryOf }));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          // Without a shell there is nothing to list with, however often it is asked.
          keepListing = !hasNoShell(message);

          if (startedAs === generation) {
            runInAction(() => state.set({ status: "failed", message, hasNoShell: !keepListing }));
          }
        } finally {
          if (runningAs === startedAs) {
            runningAs = undefined;
          }
        }

        if (keepListing && startedAs === generation) {
          timer = setTimeout(() => void list(listedContext, startedAs), listAgainAtOnce ? 0 : refreshIntervalMs);
          listAgainAtOnce = false;
        }
      };

      // For what was asked for to show now rather than at the next listing: one waiting starts at
      // once, one running is followed by another straight away.
      const listSoon = () => {
        if (context === undefined) {
          return;
        }

        if (runningAs === generation) {
          listAgainAtOnce = true;
        } else if (timer !== undefined) {
          void list(context, generation);
        }
      };

      onBecomeObserved(state, () => {
        stopReacting = [
          reaction(
            () => choice.get(),
            (current) => {
              stop();
              runInAction(() =>
                state.set(
                  current.status === "chosen"
                    ? { status: "loading" }
                    : { status: current.status === "unknown" ? "needs-context" : "finding-context" },
                ),
              );

              if (current.status === "chosen") {
                context = current.context;
                void list(current.context, generation);
              }
            },
            { fireImmediately: true, equals: comparer.structural },
          ),

          reaction(
            () => listingFilesOf.get(),
            (pids, previousPids) => {
              if (pids.some((pid) => !previousPids.includes(pid))) {
                listSoon();
              }
            },
            { equals: comparer.structural },
          ),
        ];
      });

      onBecomeUnobserved(state, () => {
        for (const stopReaction of stopReacting) {
          stopReaction();
        }

        stopReacting = [];
        stop();
      });

      return computed(() => state.get());
    };
  },
});
