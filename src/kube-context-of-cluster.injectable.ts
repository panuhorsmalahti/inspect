import { getInjectable2 } from "@k8slens/injectable";
import { getPersistableValueInjectableBunch } from "@k8slens/persistable-contracts";
import { computed, type IComputedValue, type IObservableValue, observable, runInAction } from "mobx";
import { kubeContextMatchInjectable } from "./kube-context-match.injectable";

/** The kubeconfig context the user picked for a cluster, `null` to have it matched. */
export const pickedKubeContextBunch = getPersistableValueInjectableBunch<string | null, [clusterId: string]>()({
  id: "picked-kube-context",
  defaultValue: { instantiate: () => async () => null },
});

export type KubeContextChoice =
  | { readonly status: "finding" }
  /** Not picked, and no context could be matched to the cluster. */
  | { readonly status: "unknown" }
  | { readonly status: "chosen"; readonly context: string; readonly by: "user" | "identity" | "name" };

export interface KubeContextOfCluster {
  readonly choice: IComputedValue<KubeContextChoice>;
  /** Whether the context is left to be matched, rather than picked by the user. */
  readonly isAutomatic: IComputedValue<boolean>;
  /** A context of the user's kubeconfig, or `null` to have it matched again. */
  readonly pick: (context: string | null) => void;
}

/**
 * Which kubeconfig context reaches a cluster. Lens does not tell extensions, so it is the one the
 * user picked for the cluster, or else the one matched to it.
 */
export const kubeContextOfClusterInjectable = getInjectable2({
  id: "inspect-kube-context-of-cluster",

  instantiate: (di) => {
    const getPickedKubeContext = di.inject(pickedKubeContextBunch.persistable);

    return (clusterId: string): KubeContextOfCluster => {
      const match = di.inject(kubeContextMatchInjectable)(clusterId);
      const picked = observable.box<IObservableValue<string | null> | undefined>(undefined, { deep: false });

      void getPickedKubeContext(clusterId).then((persisted) => {
        runInAction(() => picked.set(persisted));
      });

      const pickedContext = computed(() => picked.get()?.get());

      return {
        choice: computed((): KubeContextChoice => {
          const current = pickedContext.get();

          if (current === undefined) {
            return { status: "finding" };
          }

          if (current !== null) {
            return { status: "chosen", context: current, by: "user" };
          }

          const matched = match.get();

          switch (matched.status) {
            case "matching":
              return { status: "finding" };
            case "matched":
              return { status: "chosen", context: matched.context, by: matched.by };
            case "none":
              return { status: "unknown" };
          }
        }),

        isAutomatic: computed(() => pickedContext.get() === null),

        pick: (context) => {
          const persisted = picked.get();

          if (persisted) {
            runInAction(() => persisted.set(context));
          }
        },
      };
    };
  },
});
