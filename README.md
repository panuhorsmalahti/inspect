# Inspect Pods

See every pod of a cluster at a glance, as a wall of boxes, and zoom into any one of them to see its containers and the processes running in them.

## Install

[Open Inspect Pods in Lens](https://app.k8slens.dev/lens-launcher?c=lens%3A%2F%2Fapp%2Fopen%2Fextension%3Fname%3Dlens-extension-inspect), or find it in Lens under **Extensions > Browse Marketplace**.

## Features

- **Inspect Pods** in the navigator, under every cluster.
- A page listing every pod in the cluster, across all namespaces, as a box with the pod's name and namespace on top. The list stays current as pods come and go.
- A filter at the top of the page: type part of a pod's name or namespace to narrow the boxes down. Several words narrow it further, so `kube-system dns` finds the DNS pods of `kube-system`.
- Click anywhere on a pod's box to expand the pod to fill the page, with an animation that grows the box from where it sits.
- An expanded pod has a tab for each of its containers, sidecars included, with a dot showing whether the container is running, waiting or terminated. The tabs follow the pod as it changes; hover a tab to read its container's state.
- Under each container's tab, the processes running in it as a tree: command line, CPU %, memory % and state, refreshed every 3 seconds. Memory is a share of the container's memory limit, or of the node's memory for a container without one. Click **+** beside a process for its **Threads**, each with its own CPU % and state, and its **Files and ports**: the files it has open, its TCP and UDP ports with their addresses and state, its Unix sockets and pipes. A process run by another user than the one `kubectl exec` runs as keeps its open files to itself. Each row is tinted by the resources it uses, the average of its CPU % and memory % (a thread's own CPU % and its process's memory %): green for none, through yellow and orange, to red for all.

## Usage

1. In the navigator, open a cluster and click **Inspect Pods**. Lens connects the cluster if it isn't connected yet, and opens the cluster's Inspect Pods page in a tab of its own.
2. Type in the filter to find the pod you're after, and click anywhere on its box to expand it.
3. Pick a container from the tabs to see its processes.
4. Click the close button, or press Escape, to shrink the pod back into its box.

### Listing processes

The processes are listed with `kubectl exec` on your machine, the same way you would from a terminal. For that:

- `kubectl` has to be installed, along with anything your kubeconfig needs to sign in, such as the `aws` CLI for EKS.
- The extension needs to know which kubeconfig context reaches the cluster, and finds it on its own: it tries the contexts named most like the cluster first (an EKS context's ARN ending in the cluster's name counts), and takes the one that reaches the very same cluster, told by the UID of its `kube-system` namespace. So a renamed cluster is found too. When no context can be asked, it goes by the name alone. While no context is found, or when listing the processes through the one found fails, a **Context** button above the processes lets you pick one; the choice is remembered for each cluster, and **Match automatically** goes back to matching.
- You need permission to exec into the pod.
- The container needs a shell (`sh`). The extension reads `/proc` rather than running `ps`, so images without `ps` work. For a container without a shell, the page shows the command it was started with instead.

What changed in each version is in [CHANGELOG.md](./CHANGELOG.md).
