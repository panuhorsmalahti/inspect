import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";

/** The process itself, showing its parts, and each part, showing what it has. */
export type ProcessPart = "process" | "threads" | "files";

export interface ExpandedProcesses {
  readonly isExpanded: (pid: number, part: ProcessPart) => boolean;
  readonly toggle: (pid: number, part: ProcessPart) => void;
  /** The processes whose open files are in view, and so listed: a process may have thousands. */
  readonly listingFilesOf: IComputedValue<readonly number[]>;
}

/** Which processes of a container are expanded, and which of their parts. */
export const expandedProcessesInjectable = getInjectable2({
  id: "inspect-expanded-processes",

  instantiate:
    () =>
    (_clusterId: string, _namespace: string, _podName: string, _containerName: string): ExpandedProcesses => {
      const expanded = observable.set<string>([], { deep: false });
      const keyOf = (pid: number, part: ProcessPart) => `${part}:${pid}`;
      const isExpanded = (pid: number, part: ProcessPart) => expanded.has(keyOf(pid, part));

      return {
        isExpanded,

        toggle: (pid, part) =>
          runInAction(() => {
            if (!expanded.delete(keyOf(pid, part))) {
              expanded.add(keyOf(pid, part));
            }
          }),

        listingFilesOf: computed(() =>
          [...expanded]
            .filter((key) => key.startsWith("files:"))
            .map((key) => Number(key.slice("files:".length)))
            .filter((pid) => isExpanded(pid, "process"))
            .sort((left, right) => left - right),
        ),
      };
    },
});
