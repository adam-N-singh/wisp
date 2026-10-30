// Line diffs for the reviews that show what changed: a plugin update's skills (Plugins.tsx) and a
// document's revisions (PageStage.tsx). The longest common subsequence of lines, once the lines
// both texts start and end with are set aside, so an edit in a long document stays cheap.
// `foldUnchanged` keeps a few unchanged lines around each change and folds the rest.

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** A diff as shown: lines, and runs of unchanged ones folded into a count. */
export type DiffRow = DiffLine | { kind: "skip"; count: number };

/** The most line pairs compared, besides the shared start and end (16 MB of table). */
const MAX_CELLS = 4_000_000;

/** What changed from `before` to `after`, line by line; null when the changed part is too long to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) return null;
  // How long the common part of x[i…] and y[j…] is.
  const common = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) common[i][j] = x[i] === y[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const lines: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) lines.push({ kind: "same", text: x[i++] }), j++;
    else if (common[i + 1][j] >= common[i][j + 1]) lines.push({ kind: "del", text: x[i++] });
    else lines.push({ kind: "add", text: y[j++] });
  }
  while (i < x.length) lines.push({ kind: "del", text: x[i++] });
  while (j < y.length) lines.push({ kind: "add", text: y[j++] });
  for (const text of a.slice(endA)) lines.push({ kind: "same", text });
  return lines;
}

/** The diff with `context` unchanged lines kept on each side of a change and longer runs folded. */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind !== "same") for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) keep[near] = 1;
  });
  const rows: DiffRow[] = [];
  for (let index = 0; index < lines.length; ) {
    if (keep[index] === 1) {
      rows.push(lines[index++]);
      continue;
    }
    let count = 0;
    while (index < lines.length && keep[index] === 0) count++, index++;
    rows.push({ kind: "skip", count });
  }
  return rows;
}
