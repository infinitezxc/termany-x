const labels: Record<string, string> = {
  M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied",
  T: "Type changed", U: "Unmerged",
};

export function fileGitBadge(status?: string): { text: string; title: string; tone: string } | null {
  // Ignored is not a change: no badge; the name is dimmed instead (gitIgnored).
  if (!status || status === "  " || status === "!!") return null;
  if (status === "??") return { text: "U", title: "Git: Untracked", tone: "untracked" };
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status)) {
    return { text: "!", title: "Git: Merge conflict", tone: "conflict" };
  }
  const details: string[] = [];
  if (status[0] !== " ") details.push(`Staged: ${labels[status[0]] ?? status[0]}`);
  if (status[1] !== " ") details.push(`Unstaged: ${labels[status[1]] ?? status[1]}`);
  // The working-tree state takes precedence; preserve both sides in the tooltip.
  const text = status[1] !== " " ? status[1] : status[0];
  return {
    text,
    title: `Git — ${details.join("; ")}`,
    tone: text === "D" ? "deleted" : text === "A" ? "added" : /[RC]/.test(text) ? "renamed" : "modified",
  };
}

/** Precompute ancestor decorations once per snapshot, including collapsed
 * folders. Conflicts take precedence over modifications, then additions.
 * Deleted children still decorate their parent so their change is discoverable. */
export function folderGitStatuses(statuses: Record<string, string>): Record<string, string> {
  const folders: Record<string, string> = Object.create(null);
  const priority = (status: string) => {
    const tone = fileGitBadge(status)?.tone;
    return tone === "conflict" ? 4 : tone === "modified" ? 3 : tone === "deleted" ? 2 : 1;
  };
  for (const [path, status] of Object.entries(statuses)) {
    if (!fileGitBadge(status)) continue;
    // Preserve separator spelling so keys match paths used by the file tree.
    let cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    while (cut > 0) {
      const parent = path.slice(0, cut);
      if (!folders[parent] || priority(status) > priority(folders[parent])) folders[parent] = status;
      cut = Math.max(parent.lastIndexOf("/"), parent.lastIndexOf("\\"));
    }
  }
  return folders;
}

/** Whether `path` is Git-ignored. Git reports an ignored directory once
 * ("node_modules/") without listing its contents, so ancestors count too. */
export function gitIgnored(statuses: Record<string, string>, path: string): boolean {
  let current = path;
  for (;;) {
    if (statuses[current] === "!!") return true;
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    if (cut <= 0) return false;
    current = current.slice(0, cut);
  }
}
