import { Div } from "@k8slens/element-components";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { getTabKind, getTabKindInjectableBunch, type TabProps } from "@k8slens/tab-contracts";
import { InspectPodsPage } from "./inspect-pods-page";

// Opened by its tab id alone, which is the cluster's id.
export const inspectPodsTabKind = getTabKind()("inspect-pods");

const InspectPodsTitle = () => <Div>Inspect Pods</Div>;

const InspectPodsTabContent = ({ tabId: clusterId }: TabProps<typeof mainViewTabHostKind>) => (
  <InspectPodsPage clusterId={clusterId} />
);

export default getTabKindInjectableBunch({
  tabHostKind: mainViewTabHostKind,
  kind: inspectPodsTabKind,
  Component: InspectPodsTabContent,
  Title: InspectPodsTitle,
});
