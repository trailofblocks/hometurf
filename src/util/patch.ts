/** One file's section of a `git diff` patch. */
export interface FilePatch {
  /** Lines from `diff --git` up to (not including) the first hunk. */
  header: string[];
  hunks: string[][];
  binary: boolean;
}

/** Split a git patch into per-file sections and hunks. Text before the first `diff --git` is dropped. */
export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: string[] | undefined;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], hunks: [], binary: false };
      hunk = undefined;
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      hunk = [line];
      current.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      hunk.push(line);
    } else {
      current.header.push(line);
      if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) current.binary = true;
    }
  }
  return files;
}

export function formatPatch(files: FilePatch[]): string {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(...file.header);
    for (const hunk of file.hunks) lines.push(...hunk);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** The first hunk of the first text file in a patch, as a patch of its own. Empty if there is none. */
export function firstHunk(patch: string): string {
  const file = parsePatch(patch).find((f) => !f.binary && f.hunks.length > 0);
  if (!file) return "";
  return formatPatch([{ ...file, hunks: file.hunks.slice(0, 1) }]);
}

export interface PatchStats {
  files: number;
  added: number;
  removed: number;
}

export function patchStats(patch: string): PatchStats {
  const files = parsePatch(patch);
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.slice(1)) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
  }
  return { files: files.length, added, removed };
}
