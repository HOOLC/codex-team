export function formatAccountListDisplayName(options: {
  name: string;
  refreshStatus?: string | null;
  autoSwitchEligible?: boolean | null;
}): string {
  const staleTag = options.refreshStatus === "stale" ? " [stale]" : "";
  const protectionTag = options.autoSwitchEligible === false ? " [P]" : "";
  return `${options.name}${staleTag}${protectionTag}`;
}

export function formatAccountListMarkers(options: {
  current?: boolean;
  proxyUpstreamActive?: boolean;
  selected?: boolean;
}): string {
  const selectedMarker = options.selected === undefined ? "" : options.selected ? ">" : " ";
  const currentMarker = options.current ? "*" : " ";
  const proxyMarker = options.proxyUpstreamActive ? "@" : " ";
  return `${selectedMarker}${currentMarker}${proxyMarker} `;
}
