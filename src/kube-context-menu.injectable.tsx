import { getDropDownMenuItemsInjectableBunch, getDropDownMenuKind } from "@k8slens/drop-down-menu-contracts";
import { DropDownMenuItemRow } from "@k8slens/drop-down-menu-items";
import { CheckIcon } from "@k8slens/icon";
import { useSyncInject } from "@k8slens/use-inject";
import { computed } from "mobx";
import { observer } from "mobx-react";
import { kubeContextOfClusterInjectable } from "./kube-context-of-cluster.injectable";
import { kubeContextsInjectable } from "./kube-contexts.injectable";

/** The menu to pick the kubeconfig context of a cluster from. */
export const kubeContextMenuKind = getDropDownMenuKind<{ readonly clusterId: string }>()("inspect-kube-context-menu");

const KubeContextRow = observer(
  ({ data: { clusterId }, context }: { readonly data: { readonly clusterId: string }; readonly context: string }) => {
    const { choice, pick } = useSyncInject(kubeContextOfClusterInjectable, clusterId);
    const current = choice.get();
    // Ticked only when picked: a matched context is ticked under "Match automatically".
    const isChosen = current.status === "chosen" && current.by === "user" && current.context === context;

    return (
      <DropDownMenuItemRow $onClick={() => pick(context)} trailing={isChosen ? <CheckIcon /> : undefined}>
        {context}
      </DropDownMenuItemRow>
    );
  },
);

const AutomaticRow = observer(({ data: { clusterId } }: { readonly data: { readonly clusterId: string } }) => {
  const { isAutomatic, pick } = useSyncInject(kubeContextOfClusterInjectable, clusterId);

  return (
    <DropDownMenuItemRow $onClick={() => pick(null)} trailing={isAutomatic.get() ? <CheckIcon /> : undefined}>
      Match automatically
    </DropDownMenuItemRow>
  );
});

const automaticItem = { id: "inspect-kube-context-automatic", orderNumber: 5, Component: AutomaticRow };

const NoticeRow = ({ notice }: { readonly data: { readonly clusterId: string }; readonly notice: string }) => (
  <DropDownMenuItemRow $color="textMuted" $enabled={false}>
    {notice}
  </DropDownMenuItemRow>
);

export const kubeContextMenuItemsBunch = getDropDownMenuItemsInjectableBunch({
  id: "inspect-kube-context-menu-items",
  kind: kubeContextMenuKind,

  instantiate: (di) => {
    const { contexts, reload } = di.inject(kubeContextsInjectable)();

    return () => {
      // A context added to the kubeconfig since is there the next time the menu opens.
      reload();

      return computed(() => {
        const current = contexts.get();

        if (current.status !== "loaded" || current.contexts.length === 0) {
          const notice =
            current.status === "loading"
              ? "Listing the contexts of your kubeconfig…"
              : current.status === "failed"
                ? `kubectl could not list the contexts: ${current.message}`
                : "Your kubeconfig has no contexts";

          return [
            automaticItem,
            { id: "inspect-kube-context-notice", orderNumber: 10, Component: NoticeRow, componentProps: { notice } },
          ];
        }

        return [
          automaticItem,
          ...current.contexts.map((context, index) => ({
            id: `inspect-kube-context-${context}`,
            orderNumber: 10 + index,
            Component: KubeContextRow,
            componentProps: { context },
          })),
        ];
      });
    };
  },
});
