export function normalizeSymbioteMask(mask: number): number {
  return Number.isInteger(mask) && mask >= 0 && mask < 64 ? mask : 0;
}

export function getSymbioteIconPath(mask: number): string {
  return `./symbiote/${normalizeSymbioteMask(mask).toString(16).padStart(2, '0')}.png`;
}

let documentMask = 0;

export function updateDocumentSymbioteIcon(mask: number): void {
  documentMask = normalizeSymbioteMask(mask);
  const icon = getSymbioteIconPath(documentMask);
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')
    .forEach(link => { link.setAttribute('href', icon); });
}

export function getCurrentSymbioteIconPath(): string {
  return getSymbioteIconPath(documentMask);
}
