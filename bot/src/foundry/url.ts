/** Foundry's own page routes. A pasted address often ends in one of them (copied from the address bar). */
const PAGE_ROUTES = /\/(game|join|setup|auth|license|players|stream)$/i;

/**
 * Foundry's base address (its origin plus any route prefix) from whatever was pasted:
 * "https://host/game", "https://host/join?x#y" and "https://host/" all give "https://host";
 * "http://host/foundry/game" keeps its prefix, "http://host/foundry". Text that isn't a URL
 * comes back trimmed, without trailing slashes.
 */
export function foundryBaseUrl(url: string): string {
  const raw = url.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, "");
  }
  const path = u.pathname.replace(/\/+$/, "").replace(PAGE_ROUTES, "").replace(/\/+$/, "");
  return `${u.origin}${path}`;
}
