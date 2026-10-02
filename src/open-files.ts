export type OpenFile =
  | { readonly fd: number; readonly kind: "file"; readonly path: string }
  | {
      readonly fd: number;
      readonly kind: "port";
      readonly protocol: "TCP" | "UDP";
      readonly local: string;
      /** Undefined for a socket listening, or not connected anywhere. */
      readonly remote: string | undefined;
      /** The kernel's own code for its state, as /proc/net has it: "0A" is a TCP socket listening. */
      readonly state: string;
    }
  | { readonly fd: number; readonly kind: "unix-socket"; readonly path: string | undefined }
  | { readonly fd: number; readonly kind: "pipe" }
  | { readonly fd: number; readonly kind: "other"; readonly target: string };

/** Unreadable for a process of another user than the one listing: even root needs to be allowed to trace it. */
export type ProcessFiles = { readonly readable: false } | { readonly readable: true; readonly files: readonly OpenFile[] };

type Socket =
  | Omit<Extract<OpenFile, { kind: "port" }>, "fd">
  | Omit<Extract<OpenFile, { kind: "unix-socket" }>, "fd">;

const byteAt = (hex: string, index: number) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);

// /proc/net writes an address as the bytes of 32-bit words in the host's order, little-endian on
// the machines Kubernetes runs on.
const bytesOf = (hex: string) =>
  Array.from({ length: hex.length / 2 }, (_, index) => byteAt(hex, index - (index % 4) + 3 - (index % 4)));

const ipv6Of = (bytes: readonly number[]) => {
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return `::ffff:${bytes.slice(12).join(".")}`;
  }

  const groups = Array.from({ length: 8 }, (_, index) =>
    (((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toString(16),
  );

  // The longest run of two or more zero groups is written "::".
  let runStart = -1;
  let runLength = 0;

  for (let start = 0; start < groups.length; ) {
    let end = start;

    while (groups[end] === "0") {
      end++;
    }

    if (end - start >= 2 && end - start > runLength) {
      runStart = start;
      runLength = end - start;
    }

    start = Math.max(end, start + 1);
  }

  return runStart === -1
    ? groups.join(":")
    : `${groups.slice(0, runStart).join(":")}::${groups.slice(runStart + runLength).join(":")}`;
};

/** An address as /proc/net writes it, `0100007F:1F90`, as one reads it: `127.0.0.1:8080`. */
const endpointOf = (hexEndpoint: string | undefined) => {
  const [hexAddress = "", hexPort = ""] = (hexEndpoint ?? "").split(":");
  const port = Number.parseInt(hexPort, 16);
  const bytes = bytesOf(hexAddress);

  return {
    port,
    text: bytes.length === 4 ? `${bytes.join(".")}:${port}` : `[${ipv6Of(bytes)}]:${port}`,
  };
};

/** The sockets of the container's network, by inode, from lines of /proc/net/{tcp,tcp6,udp,udp6,unix}. */
export const socketsOf = (lines: readonly { readonly table: string; readonly line: string }[]) => {
  const sockets = new Map<string, Socket>();

  for (const { table, line } of lines) {
    const fields = line.trim().split(/\s+/);

    if (table === "unix") {
      const [, , , , , , inode, ...path] = fields;

      if (inode && fields[0] !== "Num") {
        sockets.set(inode, { kind: "unix-socket", path: path.length > 0 ? path.join(" ") : undefined });
      }

      continue;
    }

    const [slot, local, remote, state = "", , , , , , inode] = fields;

    if (!inode || slot === "sl") {
      continue;
    }

    const remoteEndpoint = endpointOf(remote);

    sockets.set(inode, {
      kind: "port",
      protocol: table.startsWith("tcp") ? "TCP" : "UDP",
      local: endpointOf(local).text,
      remote: remoteEndpoint.port === 0 ? undefined : remoteEndpoint.text,
      state,
    });
  }

  return sockets;
};

/** What an open file descriptor is, from its target as `ls -l /proc/<pid>/fd` shows it. */
export const openFileOf = (fd: number, target: string, sockets: ReadonlyMap<string, Socket>): OpenFile => {
  const socketInode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
  const socket = socketInode === undefined ? undefined : sockets.get(socketInode);

  if (socket) {
    return { fd, ...socket };
  }

  if (target.startsWith("/")) {
    return { fd, kind: "file", path: target };
  }

  if (target.startsWith("pipe:")) {
    return { fd, kind: "pipe" };
  }

  return { fd, kind: "other", target };
};
