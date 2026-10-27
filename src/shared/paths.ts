// Path containment, shared by the permission policy, the box's media route and
// the coordinator's attachment uploads.
import { relative, resolve, sep } from "node:path";

/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}
