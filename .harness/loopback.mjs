export function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}
