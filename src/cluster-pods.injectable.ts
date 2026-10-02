import { connectClusterInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { coreV1, type KubeResource, kubeResourcesInjectionToken, podKind } from "@k8slens/kubernetes-contracts";
import type { Subscription } from "@k8slens/subscribable";
import { computed, type IComputedValue, observable, onBecomeObserved, onBecomeUnobserved, runInAction } from "mobx";

export type Pod = KubeResource<typeof podKind, typeof coreV1>;

export type ClusterPods =
  | { readonly status: "connecting" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly pods: readonly Pod[] }
  | { readonly status: "failed"; readonly message: string };

type State =
  | Exclude<ClusterPods, { status: "loaded" }>
  | { readonly status: "loaded"; readonly pods: IComputedValue<readonly Pod[]> };

const byNamespaceAndName = (left: Pod, right: Pod) =>
  left.metadata.namespace.localeCompare(right.metadata.namespace) ||
  left.metadata.name.localeCompare(right.metadata.name);

/**
 * The pods of every namespace of a cluster, sorted, and kept current for as long as something
 * observes the computed: the cluster is connected and the pods watched when the first observer
 * arrives, and the watch is let go when the last one leaves.
 */
export const clusterPodsInjectable = getInjectable2({
  id: "inspect-cluster-pods",
  consumptions: [connectClusterInjectionToken, kubeResourcesInjectionToken],

  instantiate: (di) => {
    const connectCluster = di.inject(connectClusterInjectionToken);
    const kubeResources = di.inject(kubeResourcesInjectionToken)();

    return (clusterId: string): IComputedValue<ClusterPods> => {
      const state = observable.box<State>({ status: "connecting" }, { deep: false });
      let subscription: Subscription<readonly Pod[]> | undefined;
      // Tells a start that has been superseded, by losing its observers, from the current one.
      let generation = 0;

      const start = async (startedAs: number) => {
        const isCurrent = () => startedAs === generation;

        try {
          await connectCluster(clusterId);

          if (!isCurrent()) {
            return;
          }

          runInAction(() => state.set({ status: "loading" }));

          const current = kubeResources(podKind, coreV1, clusterId).subscribe();

          current.claim();
          subscription = current;

          const pods = await current.value;

          if (isCurrent()) {
            runInAction(() => state.set({ status: "loaded", pods }));
          }
        } catch (error) {
          if (isCurrent()) {
            runInAction(() =>
              state.set({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
            );
          }
        }
      };

      onBecomeObserved(state, () => {
        void start(++generation);
      });

      onBecomeUnobserved(state, () => {
        generation++;
        subscription?.dispose();
        subscription = undefined;
        runInAction(() => state.set({ status: "connecting" }));
      });

      return computed((): ClusterPods => {
        const current = state.get();

        return current.status === "loaded"
          ? { status: "loaded", pods: [...current.pods.get()].sort(byNamespaceAndName) }
          : current;
      });
    };
  },
});
