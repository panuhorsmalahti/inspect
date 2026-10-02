import { clusterNavigatorItemKind } from "@k8slens/cluster-contracts";
import { SearchIcon } from "@k8slens/icon";
import {
  NavigatorItemIcon,
  NavigatorItemLabel,
  NavigatorLeafIndicator,
  navigatorItemIconSize,
} from "@k8slens/navigator-components";
import {
  getNavigatorItemKind,
  getNavigatorItemKindInjectableBunch,
  type NavigatorItemProps,
} from "@k8slens/navigator-contracts";
import { useInject } from "@k8slens/use-inject";
import { computed } from "mobx";
import { openInspectPodsTabInjectable } from "./open-inspect-pods-tab.injectable";

interface InspectPodsItem {
  readonly id: string;
  readonly name: string;
}

// Under a cluster, so the parent's ancestry is the cluster's id.
export const inspectPodsNavigatorItemKind = getNavigatorItemKind<InspectPodsItem, [clusterId: string]>()(
  "inspect-pods",
);

const InspectPodsRow = ({ item, parentItem }: NavigatorItemProps<InspectPodsItem, typeof clusterNavigatorItemKind>) => {
  const openInspectPodsTab = useInject(openInspectPodsTabInjectable)();

  return (
    <>
      <NavigatorLeafIndicator />
      <NavigatorItemIcon>
        <SearchIcon $size={navigatorItemIconSize} />
      </NavigatorItemIcon>
      <NavigatorItemLabel onClick={() => void openInspectPodsTab(parentItem.id)}>{item.name}</NavigatorItemLabel>
    </>
  );
};

export const inspectPodsNavigatorItemBunch = getNavigatorItemKindInjectableBunch({
  kind: inspectPodsNavigatorItemKind,
  parentKind: clusterNavigatorItemKind,
  description: "Opens the Inspect Pods page of the cluster.",

  items: {
    instantiate: () => async () => computed((): InspectPodsItem[] => [{ id: "inspect-pods", name: "Inspect Pods" }]),
  },

  Component: InspectPodsRow,
});
