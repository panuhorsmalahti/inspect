import { getInjectable2 } from "@k8slens/injectable";
import { mainViewTabHostKind } from "@k8slens/main-view-contracts";
import { focusTabInjectionToken, openTabInjectionToken, tabIsOpenInjectionToken } from "@k8slens/tab-contracts";
import { inspectPodsTabKind } from "./inspect-pods-tab.injectable";

// One Inspect Pods tab per cluster: the cluster's id is the tab's id.
export const openInspectPodsTabInjectable = getInjectable2({
  id: "inspect-open-inspect-pods-tab",
  consumptions: [openTabInjectionToken, focusTabInjectionToken, tabIsOpenInjectionToken],

  instantiate: (di) => {
    const openTab = di.inject(openTabInjectionToken.for(mainViewTabHostKind).for(inspectPodsTabKind).for(di.scopeIds))();
    const focusTab = di.inject(focusTabInjectionToken.for(mainViewTabHostKind).for(inspectPodsTabKind).for(di.scopeIds))();
    const isOpen = di.inject(tabIsOpenInjectionToken.for(mainViewTabHostKind).for(inspectPodsTabKind).for(di.scopeIds))();

    return () => async (clusterId: string) => {
      const tab = { tabId: clusterId };

      if (await isOpen(tab)) {
        await focusTab(tab);
      } else {
        await openTab(tab);
      }
    };
  },
});
