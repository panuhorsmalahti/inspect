import { getInjectable2 } from "@k8slens/injectable";
import type { V1ContainerState } from "@k8slens/kubernetes-contracts";
import { computed, type IComputedValue, observable, runInAction } from "mobx";
import { clusterPodsInjectable, type Pod } from "./cluster-pods.injectable";

export type ContainerState =
  | { readonly kind: "running"; readonly since: string | undefined }
  | { readonly kind: "waiting"; readonly reason: string | undefined }
  | { readonly kind: "terminated"; readonly reason: string | undefined; readonly exitCode: number }
  | { readonly kind: "unknown" };

export interface PodContainer {
  readonly name: string;
  /** What the container was told to run, or undefined for the image's own entrypoint. */
  readonly command: string | undefined;
  readonly state: ContainerState;
}

export type PodContainers =
  | { readonly status: "loading" }
  /** The pod was deleted while it was being looked at. */
  | { readonly status: "gone" }
  | {
      readonly status: "found";
      readonly podName: string;
      readonly namespace: string;
      readonly containers: readonly PodContainer[];
      readonly selected: PodContainer;
    };

export interface PodContainersOfPod {
  readonly containers: IComputedValue<PodContainers>;
  readonly select: (containerName: string) => void;
}

const toState = (state: V1ContainerState | undefined): ContainerState => {
  if (state?.running) {
    return { kind: "running", since: state.running.startedAt };
  }

  if (state?.waiting) {
    return { kind: "waiting", reason: state.waiting.reason };
  }

  if (state?.terminated) {
    return { kind: "terminated", reason: state.terminated.reason, exitCode: state.terminated.exitCode };
  }

  return { kind: "unknown" };
};

const containersOf = (pod: Pod): PodContainer[] => {
  const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
  // Init containers that keep running beside the others.
  const sidecars = (pod.spec.initContainers ?? []).filter((container) => container.restartPolicy === "Always");

  return [...pod.spec.containers, ...sidecars].map((container) => {
    const status = statuses.find((candidate) => candidate.name === container.name);
    const command = [...(container.command ?? []), ...(container.args ?? [])];

    return {
      name: container.name,
      command: command.length > 0 ? command.join(" ") : undefined,
      state: toState(status?.state),
    };
  });
};

/**
 * The containers of one pod, following the pod as it changes, and which of them is selected:
 * the one the user picked while the pod has it, and the first one otherwise.
 */
export const podContainersInjectable = getInjectable2({
  id: "inspect-pod-containers",

  instantiate: (di) => (clusterId: string, podUid: string): PodContainersOfPod => {
    const clusterPods = di.inject(clusterPodsInjectable)(clusterId);
    const picked = observable.box<string | undefined>(undefined);

    return {
      containers: computed((): PodContainers => {
        const current = clusterPods.get();

        if (current.status !== "loaded") {
          return { status: "loading" };
        }

        const pod = current.pods.find((candidate) => candidate.metadata.uid === podUid);
        const containers = pod ? containersOf(pod) : [];
        const [first] = containers;

        if (!pod || !first) {
          return { status: "gone" };
        }

        return {
          status: "found",
          podName: pod.metadata.name,
          namespace: pod.metadata.namespace,
          containers,
          selected: containers.find((container) => container.name === picked.get()) ?? first,
        };
      }),

      select: (containerName) => runInAction(() => picked.set(containerName)),
    };
  },
});
