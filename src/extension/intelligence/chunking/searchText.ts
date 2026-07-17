export function createSearchTokens(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_$]+/)
    .flatMap(splitIdentifier)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function splitIdentifier(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9$]+/).filter(Boolean);
}
