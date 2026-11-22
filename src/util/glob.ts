const cache = new Map<string, RegExp>();

/**
 * Match a repository path (forward slashes, no leading slash) against a glob.
 *
 * - `*` matches within one path segment, `?` matches one character other than `/`.
 * - `**` matches any number of segments, including none (`tests/**`, `**\/test_*.py`).
 * - `{a,b}` matches either alternative.
 * - A pattern without a `/` matches the file name at any depth, like `.gitignore` (`CHANGELOG*`).
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = compile(pattern);
    cache.set(pattern, re);
  }
  return re.test(filePath);
}

export function matchAny(patterns: readonly string[], filePath: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath));
}

function compile(pattern: string): RegExp {
  let p = pattern.replace(/^\.\//, "").replace(/^\//, "");
  if (!p.includes("/")) p = `**/${p}`;
  let out = "";
  let i = 0;
  let inBraces = false;
  while (i < p.length) {
    const ch = p[i] as string;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const atStart = i === 0 || p[i - 1] === "/";
        const atEnd = i + 2 === p.length;
        const beforeSlash = p[i + 2] === "/";
        if (atStart && beforeSlash) {
          out += "(?:[^/]*/)*"; // `**/`: zero or more whole segments
          i += 3;
          continue;
        }
        if (atStart && atEnd) {
          out += ".*";
          i += 2;
          continue;
        }
        out += "[^/]*"; // `**` inside a segment behaves like `*`
        i += 2;
        continue;
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      inBraces = true;
      out += "(?:";
    } else if (ch === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (ch === "," && inBraces) {
      out += "|";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    i++;
  }
  return new RegExp(`^${out}$`, "s");
}
