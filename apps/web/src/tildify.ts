/** Collapse the home-dir prefix so paths read short in lists. */
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}
