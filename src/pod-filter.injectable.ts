import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, runInAction } from "mobx";
import { type ClusterPods, clusterPodsInjectable, type Pod } from "./cluster-pods.injectable";

export type FilteredPods =
  | Exclude<ClusterPods, { status: "loaded" }>
  | { readonly status: "loaded"; readonly pods: readonly Pod[]; readonly total: number };

export interface PodFilter {
  readonly text: IComputedValue<string>;
  readonly setText: (text: string) => void;
  /** The cluster's pods, narrowed to those whose name or namespace has every word of the text. */
  readonly pods: IComputedValue<FilteredPods>;
}

/** What the Inspect Pods page of a cluster is filtered by, and the pods that pass. */
export const podFilterInjectable = getInjectable2({
  id: "inspect-pod-filter",

  instantiate: (di) => (clusterId: string): PodFilter => {
    const clusterPods = di.inject(clusterPodsInjectable)(clusterId);
    const text = observable.box("");
    const words = computed(() => text.get().toLowerCase().split(/\s+/).filter(Boolean));

    return {
      text: computed(() => text.get()),
      setText: (value) => runInAction(() => text.set(value)),

      pods: computed((): FilteredPods => {
        const current = clusterPods.get();
        const wanted = words.get();

        if (current.status !== "loaded") {
          return current;
        }

        return {
          status: "loaded",
          total: current.pods.length,
          pods: current.pods.filter((pod) => {
            const haystack = `${pod.metadata.namespace}/${pod.metadata.name}`.toLowerCase();

            return wanted.every((word) => haystack.includes(word));
          }),
        };
      }),
    };
  },
});
