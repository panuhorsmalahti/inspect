# Changelog

What changed in each version of this extension, newest first.

## 0.1.0

- Created the extension.
- Added **Inspect Pods** under every cluster in the navigator, opening the cluster's Inspect Pods page.
- The Inspect Pods page lists every pod of the cluster as a box with its name and namespace.
- A filter at the top of the page narrows the pods down by name or namespace.
- Clicking a pod's box expands it to fill the page, with an animation; close or Escape shrinks it back.
- An expanded pod has a tab per container, sidecars included, with a dot showing each container's live state.
- Each container's tab lists the processes running in it, with CPU % and memory % of the container's limit, refreshed every 3 seconds, through `kubectl exec`; **+** beside a process opens its **Threads** and its **Files and ports**: open files, TCP and UDP ports, Unix sockets and pipes. Rows are tinted from green to red by the resources they use, the average of CPU % and memory %. The kubeconfig context of the cluster is matched automatically, by name and by cluster identity, and can be picked by hand while none is found or listing through it fails.
