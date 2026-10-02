import { runCliCommandInjectionToken } from "@k8slens/cli-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { computed, type IComputedValue, observable, onBecomeObserved, runInAction } from "mobx";

export type KubeContexts =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly contexts: readonly string[] }
  | { readonly status: "failed"; readonly message: string };

export interface KubeContextsOnThisMachine {
  readonly contexts: IComputedValue<KubeContexts>;
  /** Asks kubectl again, for a context added since. */
  readonly reload: () => void;
}

/** The contexts of the user's own kubeconfig, as kubectl on this machine knows them. */
export const kubeContextsInjectable = getInjectable2({
  id: "inspect-kube-contexts",
  consumptions: [runCliCommandInjectionToken],

  instantiate: (di) => {
    const runCliCommand = di.inject(runCliCommandInjectionToken)();
    const state = observable.box<KubeContexts>({ status: "loading" }, { deep: false });
    let loading: Promise<void> | undefined;

    const reload = () => {
      loading ??= runCliCommand("kubectl config get-contexts --output=name")
        .then(
          (output) => {
            const contexts = output.split("\n").map((line) => line.trim()).filter(Boolean);

            runInAction(() => state.set({ status: "loaded", contexts }));
          },
          (error: unknown) => {
            // Keep what was listed before, should a later listing fail.
            if (state.get().status !== "loaded") {
              runInAction(() =>
                state.set({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
              );
            }
          },
        )
        .finally(() => {
          loading = undefined;
        });
    };

    let listedOnce = false;

    onBecomeObserved(state, () => {
      if (!listedOnce) {
        listedOnce = true;
        reload();
      }
    });

    return () => ({ contexts: computed(() => state.get()), reload });
  },
});
