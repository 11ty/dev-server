import { isIP } from "node:net";

// Returns the parsed message, or `undefined` for anything that isn't a JSON object.
export function parseClientMessage(data) {
  let parsed;
  try {
    parsed = JSON.parse(data.toString());
  } catch(e) {
    return;
  }

  if(parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
}

function getHostname(value) {
  try {
    let { hostname } = new URL(value.includes("://") ? value : `http://${value}`);
    // IPv6 hostnames are bracketed, e.g. `[::1]`
    if(hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch(e) {
    return;
  }
}

// Only domain names can be rebound to this machine, so localhost and IP addresses are always safe.
/**
 * @param {string | undefined} hostname
 * @param {string[] | true} [allowedHosts]
 */
export function isHostnameAllowed(hostname, allowedHosts = []) {
  if(!hostname) {
    return false;
  }
  if(allowedHosts === true || hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname)) {
    return true;
  }
  return (allowedHosts || []).some(entry => {
    // A leading `.` also allows subdomains
    return entry.startsWith(".") ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry;
  });
}

// Blocks connections from other sites (Origin) and DNS rebinding (Host).
export function isConnectionAllowed({ origin, host }, allowedHosts) {
  let hostname = getHostname(host || "");
  if(!isHostnameAllowed(hostname, allowedHosts)) {
    return false;
  }

  // Browsers always send Origin, so its absence means a non-browser client
  if(!origin) {
    return true;
  }

  return getHostname(origin) === hostname;
}
