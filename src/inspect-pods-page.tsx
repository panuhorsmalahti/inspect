import { dropDownMenu } from "@k8slens/drop-down-menu-contracts";
import { Button, Div, Span, Table, Td, Th, Tr } from "@k8slens/element-components";
import { AddIcon, CloseIcon, RemoveIcon, SearchIcon, SpinnerIcon } from "@k8slens/icon";
import { PlainButton, TextInput } from "@k8slens/input-components";
import { LightWeightTabs } from "@k8slens/tabs-components";
import { useSyncInject } from "@k8slens/use-inject";
import { observer } from "mobx-react";
import type { ReactNode } from "react";
import type { Pod } from "./cluster-pods.injectable";
import {
  type ContainerProcess,
  type ContainerProcesses,
  containerProcessesInjectable,
  type MemoryOf,
  refreshIntervalMs,
} from "./container-processes.injectable";
import { type ExpandedProcesses, expandedProcessesInjectable } from "./expanded-processes.injectable";
import { kubeContextMenuKind } from "./kube-context-menu.injectable";
import { type KubeContextChoice, kubeContextOfClusterInjectable } from "./kube-context-of-cluster.injectable";
import type { OpenFile, ProcessFiles } from "./open-files";
import { type ContainerState, type PodContainer, podContainersInjectable } from "./pod-containers.injectable";
import { type FilteredPods, podFilterInjectable } from "./pod-filter.injectable";
import { type InspectedPod, type PodInspection, podInspectionInjectable } from "./pod-inspection.injectable";
import styles from "./inspect-pods-page.module.scss";

// Spans throughout, so that it may sit inside the button a pod's box is.
const PodHeader = ({ name, namespace }: { readonly name: string; readonly namespace: string }) => (
  <Span $className={styles.header} $flex={{ direction: "vertical", gap: "xxs" }}>
    <Span $className={styles.ellipsis} $font={{ bold: true }} $tooltip={name}>
      {name}
    </Span>
    <Span $className={styles.ellipsis} $color="textMuted" $font={{ size: "s" }}>
      {namespace}
    </Span>
  </Span>
);

const PodTile = observer(({ pod, inspection }: { readonly pod: Pod; readonly inspection: PodInspection }) => {
  const { uid, name, namespace } = pod.metadata;
  const isLifted = inspection.inspected.get()?.uid === uid;

  return (
    <Button
      $ref={inspection.tileRef(uid)}
      aria-label={`Inspect ${name}`}
      $onClick={() => inspection.inspect({ uid, name, namespace })}
      $className={[styles.tile, { [styles.tileLifted]: isLifted }]}
      $flex={{ direction: "vertical", gap: "xs" }}
      $padding="m"
      $backgroundColor="backgroundSecondary"
      $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
      $boxShadow
    >
      <PodHeader name={name} namespace={namespace} />
      <Span $flexChild $flex={{ horizontalAlign: "center", verticalAlign: "center" }}>
        <SearchIcon $className={styles.magnifier} $size="xl" />
      </Span>
    </Button>
  );
});

const describeState = (state: ContainerState) => {
  switch (state.kind) {
    case "running":
      return state.since ? `Running since ${new Date(state.since).toLocaleString()}` : "Running";
    case "waiting":
      return `Waiting${state.reason ? `: ${state.reason}` : ""}`;
    case "terminated":
      return `Terminated${state.reason ? `: ${state.reason}` : ""} (exit code ${state.exitCode})`;
    case "unknown":
      return "Not started yet";
  }
};

const stateColors = {
  running: "success",
  waiting: "warning",
  terminated: "critical",
  unknown: "grey40",
} as const;

const StateDot = ({ state }: { readonly state: ContainerState }) => (
  <Span $className={styles.stateDot} $backgroundColor={stateColors[state.kind]} />
);

const formatPercent = (percent: number | undefined) => (percent === undefined ? "…" : `${percent.toFixed(1)}%`);

const memoryTooltips: Readonly<Record<MemoryOf, string>> = {
  limit: "Resident memory, of the container's memory limit",
  node: "Resident memory, of the node's memory: the container has no limit",
};

const processStates: Readonly<Record<string, string>> = {
  R: "Running",
  S: "Sleeping",
  D: "Waiting on I/O",
  Z: "Zombie",
  T: "Stopped",
  t: "Traced",
  I: "Idle",
  X: "Dead",
};

// The theme's green at none of it, through its warning colour at half, to its red at all of it, mixed
// in oklch so that the way from green to orange passes through yellow. Faint enough to read text on.
const usageBackgroundOf = (resourcesUsedPercent: number | undefined) => {
  if (resourcesUsedPercent === undefined) {
    return undefined;
  }

  const share = Math.min(Math.max(resourcesUsedPercent, 0), 100) / 100;
  const color =
    share <= 0.5
      ? `color-mix(in oklch, var(--warning) ${share * 200}%, var(--success))`
      : `color-mix(in oklch, var(--critical) ${(share - 0.5) * 200}%, var(--warning))`;

  return { backgroundColor: `color-mix(in srgb, ${color} 25%, transparent)` };
};

const tcpStates: Readonly<Record<string, string>> = {
  "01": "Established",
  "02": "SYN sent",
  "03": "SYN received",
  "04": "FIN wait 1",
  "05": "FIN wait 2",
  "06": "Time wait",
  "07": "Closed",
  "08": "Close wait",
  "09": "Last ACK",
  "0A": "Listening",
  "0B": "Closing",
};

const describeOpenFile = (file: OpenFile) => {
  switch (file.kind) {
    case "file":
      return file.path;
    case "port":
      return `${file.protocol} ${file.local}${file.remote ? ` → ${file.remote}` : ""}`;
    case "unix-socket":
      return file.path ? `Unix socket ${file.path}` : "Unix socket";
    case "pipe":
      return "Pipe";
    case "other":
      return file.target;
  }
};

const openFileStateOf = (file: OpenFile) => {
  if (file.kind !== "port") {
    return undefined;
  }

  if (file.protocol === "TCP") {
    return tcpStates[file.state] ?? file.state;
  }

  // UDP has no connections to speak of: a socket is bound to its port, and maybe to one peer.
  return file.state === "01" ? "Connected" : "Bound";
};

interface ExpandToggleProps {
  readonly isExpanded: boolean;
  /** What it shows, for its label: "threads". */
  readonly what: string;
  readonly onToggle: () => void;
}

const ExpandToggle = ({ isExpanded, what, onToggle }: ExpandToggleProps) => {
  const label = `${isExpanded ? "Hide" : "Show"} ${what}`;
  const ToggleIcon = isExpanded ? RemoveIcon : AddIcon;

  return (
    <Button
      aria-label={label}
      aria-expanded={isExpanded}
      $className={[styles.iconButton, styles.treeToggle]}
      $onClick={onToggle}
      $interactive
      $border={{ radius: "s" }}
      $tooltip={label}
    >
      <ToggleIcon $size="s" />
    </Button>
  );
};

const depthClasses = [styles.depth0, styles.depth1, styles.depth2] as const;

interface TreeCellProps {
  readonly depth: 0 | 1 | 2;
  readonly toggle?: ReactNode;
  readonly children: ReactNode;
}

// The column the tree is drawn in: each level further right, with its toggle, or the room for one,
// before what it says.
const TreeCell = ({ depth, toggle, children }: TreeCellProps) => (
  <Td $className={depthClasses[depth]}>
    <Span $flex={{ gap: "xs", verticalAlign: "top" }}>
      <Span $className={styles.toggleSlot}>{toggle}</Span>
      <Span $className={styles.treeLabel}>{children}</Span>
    </Span>
  </Td>
);

const GroupRow = ({ label, count, ...toggle }: ExpandToggleProps & { readonly label: string; readonly count?: number }) => (
  <Tr>
    <TreeCell depth={1} toggle={<ExpandToggle {...toggle} />}>
      {label}
      {count !== undefined && <Span $color="textMuted"> {count}</Span>}
    </TreeCell>
    <Td />
    <Td />
    <Td />
  </Tr>
);

const NoteRow = ({ children }: { readonly children: ReactNode }) => (
  <Tr $color="textMuted">
    <TreeCell depth={2}>{children}</TreeCell>
    <Td />
    <Td />
    <Td />
  </Tr>
);

const FileRows = ({ files }: { readonly files: ProcessFiles | undefined }) => {
  if (!files) {
    return (
      <NoteRow>
        <Span role="status" aria-label="Listing the open files">
          <SpinnerIcon $size="s" />
        </Span>
      </NoteRow>
    );
  }

  if (!files.readable) {
    return <NoteRow>Can't be read: the process runs as another user</NoteRow>;
  }

  if (files.files.length === 0) {
    return <NoteRow>No open files</NoteRow>;
  }

  return (
    <>
      {files.files.map((file) => (
        <Tr key={file.fd}>
          <TreeCell depth={2}>
            <Span $className={[styles.mono, styles.command]}>{describeOpenFile(file)}</Span>
          </TreeCell>
          <Td />
          <Td />
          <Td>{openFileStateOf(file)}</Td>
        </Tr>
      ))}
    </>
  );
};

const ProcessRows = observer(
  ({ process, expansion }: { readonly process: ContainerProcess; readonly expansion: ExpandedProcesses }) => {
    const isExpanded = expansion.isExpanded(process.pid, "process");
    const showsThreads = expansion.isExpanded(process.pid, "threads");
    const showsFiles = expansion.isExpanded(process.pid, "files");

    return (
      <>
        <Tr $style={usageBackgroundOf(process.resourcesUsedPercent)}>
          <TreeCell
            depth={0}
            toggle={
              <ExpandToggle
                isExpanded={isExpanded}
                what="threads, files and ports"
                onToggle={() => expansion.toggle(process.pid, "process")}
              />
            }
          >
            <Span $className={[styles.mono, styles.command]}>{process.command}</Span>
          </TreeCell>
          <Td $className={styles.number}>{formatPercent(process.cpuPercent)}</Td>
          <Td $className={styles.number}>{formatPercent(process.memoryPercent)}</Td>
          <Td>{processStates[process.state] ?? process.state}</Td>
        </Tr>
        {isExpanded && (
          <>
            <GroupRow
              label="Threads"
              count={process.threads.length}
              isExpanded={showsThreads}
              what="threads"
              onToggle={() => expansion.toggle(process.pid, "threads")}
            />
            {showsThreads &&
              process.threads.map((thread) => (
                <Tr key={thread.tid} $color="textMuted" $style={usageBackgroundOf(thread.resourcesUsedPercent)}>
                  <TreeCell depth={2}>
                    <Span $className={styles.mono}>{thread.name}</Span>
                  </TreeCell>
                  <Td $className={styles.number}>{formatPercent(thread.cpuPercent)}</Td>
                  {/* Threads share their process's memory: there is none of their own to tell. */}
                  <Td />
                  <Td>{processStates[thread.state] ?? thread.state}</Td>
                </Tr>
              ))}
            <GroupRow
              label="Files and ports"
              count={process.files?.readable ? process.files.files.length : undefined}
              isExpanded={showsFiles}
              what="files and ports"
              onToggle={() => expansion.toggle(process.pid, "files")}
            />
            {showsFiles && <FileRows files={process.files} />}
          </>
        )}
      </>
    );
  },
);

// The expanded pod's own, so the rows scrolling under the header do not show through it.
const headerBackground = "backgroundSecondary";

interface ProcessTableProps {
  readonly processes: readonly ContainerProcess[];
  readonly memoryOf: MemoryOf | undefined;
  readonly expansion: ExpandedProcesses;
}

const ProcessTable = ({ processes, memoryOf, expansion }: ProcessTableProps) => (
  <Div $className={styles.tableScroll}>
    <Table $className={styles.processTable}>
      <thead>
        <Tr>
          <Th $backgroundColor={headerBackground}>Command</Th>
          <Th $className={styles.number} $backgroundColor={headerBackground}>
            CPU %
          </Th>
          <Th
            $className={styles.number}
            $backgroundColor={headerBackground}
            $tooltip={memoryOf && memoryTooltips[memoryOf]}
          >
            Mem %
          </Th>
          <Th $backgroundColor={headerBackground}>State</Th>
        </Tr>
      </thead>
      <tbody>
        {processes.map((process) => (
          <ProcessRows key={process.pid} process={process} expansion={expansion} />
        ))}
      </tbody>
    </Table>
  </Div>
);

const Spinner = ({ label }: { readonly label: string }) => (
  <Span role="status" aria-label={label} $color="textMuted">
    <SpinnerIcon $size="l" />
  </Span>
);

const ProcessesMessage = ({
  processes,
  command,
}: {
  readonly processes: Exclude<ContainerProcesses, { status: "loaded" }>;
  readonly command: string | undefined;
}) => {
  switch (processes.status) {
    case "finding-context":
      return <Spinner label="Finding the kubeconfig context that reaches this cluster" />;
    case "needs-context":
      return (
        <Span $color="textMuted">
          None of the contexts in your kubeconfig could be matched to this cluster. Pick its context to list the
          processes.
        </Span>
      );
    case "loading":
      return <Spinner label="Listing the processes" />;
    case "failed":
      return processes.hasNoShell ? (
        <Span $color="textMuted">
          This container has no shell, so its processes can't be listed. It runs{" "}
          {command ? <Span $className={styles.mono}>{command}</Span> : "its image's own entrypoint"}.
        </Span>
      ) : (
        <Div $flex={{ direction: "vertical", gap: "xxs" }}>
          <Span $color="warning">
            kubectl could not list the processes. Trying again every {refreshIntervalMs / 1000} s.
          </Span>
          <Span $color="textMuted" $className={[styles.mono, styles.errorText]}>
            {processes.message}
          </Span>
        </Div>
      );
  }
};

const contextTooltipOf = (choice: KubeContextChoice) => {
  switch (choice.status) {
    case "finding":
      return "Finding the kubeconfig context that reaches this cluster";
    case "unknown":
      return "Which kubeconfig context reaches this cluster";
    case "chosen":
      return {
        user: `kubeconfig context ${choice.context}, picked by you`,
        identity: `kubeconfig context ${choice.context}, which reaches this very cluster`,
        name: `kubeconfig context ${choice.context}, named like this cluster`,
      }[choice.by];
  }
};

interface ContainerProcessesViewProps {
  readonly clusterId: string;
  readonly namespace: string;
  readonly podName: string;
  readonly container: PodContainer;
}

const ContainerProcessesView = observer(({ clusterId, namespace, podName, container }: ContainerProcessesViewProps) => {
  const processes = useSyncInject(containerProcessesInjectable, clusterId, namespace, podName, container.name).get();
  const expansion = useSyncInject(expandedProcessesInjectable, clusterId, namespace, podName, container.name);
  const choice = useSyncInject(kubeContextOfClusterInjectable, clusterId).choice.get();
  // Only when one is needed: none could be found, or listing through the one found fails, being the wrong one perhaps.
  const showsContext =
    choice.status === "unknown" || (choice.status === "chosen" && processes.status === "failed" && !processes.hasNoShell);

  return (
    <Div $className={styles.processes}>
      <Div $flex={{ gap: "m", horizontalAlign: "space-between", verticalAlign: "center" }}>
        <Span $font={{ bold: true }}>Processes</Span>
        {showsContext && (
          <PlainButton
            $className={styles.contextButton}
            // What the menu opens against: an anchored menu with no anchor around it throws.
            $anchor
            $dropDownMenu={dropDownMenu(kubeContextMenuKind, { data: { clusterId }, position: "bottom span-left" })}
            $tooltip={contextTooltipOf(choice)}
          >
            {choice.status === "chosen" ? `Context: ${choice.context}` : "Pick kubeconfig context"}
          </PlainButton>
        )}
      </Div>
      {processes.status === "loaded" ? (
        <ProcessTable processes={processes.processes} memoryOf={processes.memoryOf} expansion={expansion} />
      ) : (
        <ProcessesMessage processes={processes} command={container.command} />
      )}
    </Div>
  );
});

const PodDetails = observer(({ clusterId, podUid }: { readonly clusterId: string; readonly podUid: string }) => {
  const { containers, select } = useSyncInject(podContainersInjectable, clusterId, podUid);
  const current = containers.get();

  if (current.status === "loading") {
    return null;
  }

  if (current.status === "gone") {
    return (
      <Div $className={styles.details} $color="textMuted">
        This pod no longer exists.
      </Div>
    );
  }

  return (
    <Div $className={styles.details}>
      <LightWeightTabs
        tabs={current.containers.map((container) => ({
          id: container.name,
          label: container.name,
          badge: <StateDot state={container.state} />,
          tooltip: describeState(container.state),
        }))}
        selected={current.selected.name}
        // Clicking the selected tab again keeps it: one container is always shown.
        onSelect={(containerName) => containerName && select(containerName)}
      />
      <ContainerProcessesView
        key={current.selected.name}
        clusterId={clusterId}
        namespace={current.namespace}
        podName={current.podName}
        container={current.selected}
      />
    </Div>
  );
});

interface ExpandedPodProps {
  readonly clusterId: string;
  readonly pod: InspectedPod;
  readonly inspection: PodInspection;
}

const ExpandedPod = ({ clusterId, pod, inspection }: ExpandedPodProps) => (
  <Div
    $ref={inspection.expandedRef}
    tabIndex={-1}
    onKeyDown={(event) => {
      // Escape in a menu opened from here closes the menu, not the pod.
      if (event.key === "Escape" && event.currentTarget.contains(event.target as Node)) {
        inspection.close();
      }
    }}
    $className={styles.expanded}
    $flex={{ direction: "vertical", gap: "m" }}
    $padding="m"
    $backgroundColor="backgroundSecondary"
    $border={{ color: "borderPrimary", width: "xxs", radius: "m" }}
    $boxShadow
  >
    <Div $flex={{ gap: "m", horizontalAlign: "space-between", verticalAlign: "top" }}>
      <PodHeader name={pod.name} namespace={pod.namespace} />
      <Button
        aria-label={`Close ${pod.name}`}
        $className={styles.iconButton}
        $onClick={inspection.close}
        $interactive
        $border={{ radius: "m" }}
        $tooltip="Close"
      >
        <CloseIcon $size="m" />
      </Button>
    </Div>
    {/* Only once grown: the box is just its header while it moves, and nothing is listed before. */}
    {pod.phase === "expanded" && <PodDetails clusterId={clusterId} podUid={pod.uid} />}
  </Div>
);

const messageOf = (filteredPods: FilteredPods, filterText: string) => {
  switch (filteredPods.status) {
    case "connecting":
      return "Connecting to the cluster…";
    case "loading":
      return "Loading pods…";
    case "failed":
      return `Could not list the pods: ${filteredPods.message}`;
    case "loaded":
      return filteredPods.total === 0 ? "No pods in this cluster." : `No pods match “${filterText.trim()}”.`;
  }
};

const countOf = (filteredPods: FilteredPods) => {
  if (filteredPods.status !== "loaded") {
    return undefined;
  }

  const noun = filteredPods.total === 1 ? "pod" : "pods";

  return filteredPods.pods.length === filteredPods.total
    ? `${filteredPods.total} ${noun}`
    : `${filteredPods.pods.length} of ${filteredPods.total} ${noun}`;
};

export const InspectPodsPage = observer(({ clusterId }: { readonly clusterId: string }) => {
  const filter = useSyncInject(podFilterInjectable, clusterId);
  const inspection = useSyncInject(podInspectionInjectable, clusterId);
  const filteredPods = filter.pods.get();
  const filterText = filter.text.get();
  const inspected = inspection.inspected.get();
  const count = countOf(filteredPods);

  return (
    <Div $className={styles.page}>
      <Div $className={styles.toolbar}>
        <TextInput
          type="search"
          aria-label="Filter pods"
          placeholder="Filter by pod name or namespace"
          value={filterText}
          onChange={(event) => filter.setText(event.target.value)}
          $className={styles.search}
        />
        {count && (
          <Span $color="textMuted" $font={{ size: "s" }} $className={styles.count}>
            {count}
          </Span>
        )}
      </Div>
      {filteredPods.status === "loaded" && filteredPods.pods.length > 0 ? (
        <Div
          $className={[styles.grid, { [styles.gridReceded]: inspected !== undefined && inspected.phase !== "collapsing" }]}
        >
          {filteredPods.pods.map((pod) => (
            <PodTile key={pod.metadata.uid} pod={pod} inspection={inspection} />
          ))}
        </Div>
      ) : (
        <Div $className={styles.message} $color="textMuted">
          {messageOf(filteredPods, filterText)}
        </Div>
      )}
      {inspected && <ExpandedPod key={inspected.uid} clusterId={clusterId} pod={inspected} inspection={inspection} />}
    </Div>
  );
});
