import dns from "node:dns/promises";
import net from "node:net";

export class BlockedUrlError extends Error {}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function ipv4Octets(ip: string): number[] {
  return ip.split(".").map((n) => parseInt(n, 10));
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ipv4Octets(ip);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6
    return isPrivateIPv4(lower.replace("::ffff:", ""));
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unknown format: fail closed
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * Validates a user/connector-configured URL before the server makes a request to it.
 * Blocks non-http(s) protocols always. Blocks private/loopback/link-local/metadata
 * destinations unless `allowPrivateNetwork` is explicitly set on the connector — this
 * must be re-run on every redirect hop, not just the initial URL, or a 3xx response
 * could be used to bypass the restriction (see httpConnector.ts).
 */
export async function assertUrlAllowed(rawUrl: string, allowPrivateNetwork: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(`Protocol not allowed: ${url.protocol} (only http/https)`);
  }

  if (allowPrivateNetwork) return url;

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new BlockedUrlError(`Destination host is blocked: ${hostname}`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new BlockedUrlError(`Destination IP is private/internal and allowPrivateNetwork is not set: ${hostname}`);
    }
    return url;
  }

  let addresses: string[];
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    addresses = resolved.map((r) => r.address);
  } catch (err) {
    throw new BlockedUrlError(`Could not resolve host ${hostname}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Host ${hostname} did not resolve to any address`);
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new BlockedUrlError(`Destination host ${hostname} resolves to a private/internal address (${addr}) and allowPrivateNetwork is not set`);
    }
  }
  return url;
}
