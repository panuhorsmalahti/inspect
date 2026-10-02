import { runCliCommandInjectionToken } from "@k8slens/cli-contracts";
import { clusterNameInjectionToken } from "@k8slens/cluster-contracts";
import { getInjectable2 } from "@k8slens/injectable";
import { coreV1, kubeResourceInjectionToken, namespaceKind } from "@k8slens/kubernetes-contracts";
import { computed, type IComputedValue, observable, onBecomeObserved, runInAction, when } from "mobx";
import { kubeContextsInjectable } from "./kube-contexts.injectable";
import { quoteForShell } from "./quote-for-shell";

export type KubeContextMatch =
  | { readonly status: "matching" }
  /** By `identity` when the context reaches the very cluster Lens does, by `name` when that could not be told. */
  | { readonly status: "matched"; readonly context: string; readonly by: "identity" | "name" }
  | { readonly status: "none" };

type Reach = "same" | "different" | "unreachable";

// What a context names a cluster, short of what it adds: the account and region of an EKS ARN
// (`arn:aws:eks:<region>:<account>:cluster/<name>`), the project and zone of GKE
// (`gke_<project>_<zone>_<name>`), the user of `<user>@<cluster>`; spaces and underscores read as
// dashes, so that "Docker Desktop" is `docker-desktop`.
const shortNameOf = (name: string) => {
  const lower = name.trim().toLowerCase();
  const afterSlash = lower.slice(lower.lastIndexOf("/") + 1);
  const afterAt = afterSlash.slice(afterSlash.lastIndexOf("@") + 1);
  const shortName = afterAt.startsWith("gke_") ? afterAt.slice(afterAt.lastIndexOf("_") + 1) : afterAt;

  return shortName.replace(/[\s_]+/g, "-");
};

/** How much a context's name looks like the cluster's: 0 for not at all. */
const nameScore = (context: string, clusterName: string) => {
  if (context === clusterName) {
    return 3;
  }

  if (context.toLowerCase() === clusterName.toLowerCase()) {
    return 2;
  }

  return shortNameOf(context) === shortNameOf(clusterName) ? 1 : 0;
};

/**
 * The kubeconfig context that reaches a cluster, found without asking the user. The contexts named
 * most like the cluster are tried first, each asked for the UID of its `kube-system` namespace: a
 * context answering with the UID Lens sees reaches the same cluster, whatever either is named.
 * When no context could be asked, the one named most like the cluster is taken, if only one is.
 */
export const kubeContextMatchInjectable = getInjectable2({
  id: "inspect-kube-context-match",
  consumptions: [runCliCommandInjectionToken, clusterNameInjectionToken, kubeResourceInjectionToken],

  instantiate: (di) => {
    const runCliCommand = di.inject(runCliCommandInjectionToken)();
    const clusterName = di.inject(clusterNameInjectionToken);
    const kubeResource = di.inject(kubeResourceInjectionToken)();
    const { contexts } = di.inject(kubeContextsInjectable)();

    const kubeSystemUidSeenByLens = async (clusterId: string) => {
      const subscription = kubeResource(namespaceKind, coreV1, clusterId, { name: "kube-system" }).subscribe();

      subscription.claim();

      try {
        return (await subscription.value).get()?.metadata.uid;
      } catch {
        return undefined;
      } finally {
        subscription.dispose();
      }
    };

    const reachOf = async (context: string, uid: string | undefined): Promise<Reach> => {
      if (!uid) {
        return "unreachable";
      }

      try {
        const answer = await runCliCommand(
          [
            "kubectl",
            `--context=${quoteForShell(context)}`,
            "--request-timeout=5s",
            "get namespace kube-system",
            quoteForShell("--output=jsonpath={.metadata.uid}"),
          ].join(" "),
        );

        return answer.trim() === uid ? "same" : "different";
      } catch {
        return "unreachable";
      }
    };

    const findMatch = async (clusterId: string): Promise<KubeContextMatch> => {
      await when(() => contexts.get().status !== "loading");

      const known = contexts.get();

      if (known.status !== "loaded") {
        return { status: "none" };
      }

      const name = await clusterName(clusterId);
      const byScore = known.contexts
        .map((context) => ({ context, score: nameScore(context, name) }))
        .sort((left, right) => right.score - left.score);
      const uid = await kubeSystemUidSeenByLens(clusterId);
      const reaches = new Map<string, Reach>();

      // The likely ones first, and the rest only when none of them is the cluster.
      for (const group of [byScore.filter(({ score }) => score > 0), byScore.filter(({ score }) => score === 0)]) {
        const reached = await Promise.all(group.map(async ({ context }) => [context, await reachOf(context, uid)] as const));

        reached.forEach(([context, reach]) => reaches.set(context, reach));

        const same = group.find(({ context }) => reaches.get(context) === "same");

        if (same) {
          return { status: "matched", context: same.context, by: "identity" };
        }
      }

      // Nothing could tell: a name alone decides, unless the context was seen to reach another cluster.
      const [best, runnerUp] = byScore.filter(({ context, score }) => score > 0 && reaches.get(context) !== "different");

      return best && best.score !== runnerUp?.score
        ? { status: "matched", context: best.context, by: "name" }
        : { status: "none" };
    };

    return (clusterId: string): IComputedValue<KubeContextMatch> => {
      const match = observable.box<KubeContextMatch>({ status: "matching" }, { deep: false });
      let started = false;

      onBecomeObserved(match, () => {
        if (!started) {
          started = true;

          void findMatch(clusterId).then(
            (found) => runInAction(() => match.set(found)),
            () => runInAction(() => match.set({ status: "none" })),
          );
        }
      });

      return computed(() => match.get());
    };
  },
});
