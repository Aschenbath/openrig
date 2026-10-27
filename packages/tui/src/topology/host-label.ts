import type { HostNode } from "../types.js";

/** Display the configured name beside the identity accepted by host commands. */
export function hostLabel(host: HostNode): string {
  const name = host.displayName?.trim();
  return name && name !== host.name ? `${name} (${host.name})` : host.name;
}
