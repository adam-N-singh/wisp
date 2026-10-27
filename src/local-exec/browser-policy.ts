// How the policy rates actions in the agent browser (README "Safety model"):
//   - reading pages (navigate, snapshot, screenshot, scroll, back, tabs) is read-only;
//   - typing, submitting a form, pressing a key that can submit (Enter, Space, characters) and
//     clicking something that looks like a purchase, a post, a send or a deletion are mutating,
//     asked once per site: "Always" remembers the site (`site:<origin>`), "Never" refuses it;
//   - typing into a password, payment card or one-time code field is dangerous: it always asks
//     and is never remembered, as the sign-in is the user's to do;
//   - other clicks (links, tabs, menus, plain buttons) are read-only.
// The words are a heuristic for honest sites, which label their buttons; a site that hides what a
// button does could do it without a click anyway. What's typed and submitted is what's guarded.
import { type BrowserPlanInfo, type BrowserTarget, isMovingKey, type KeyChord, sensitiveField, siteLabel, siteOf } from "../shared/agent-browser";
import type { Risk } from "../shared/model";

export interface BrowserVerdict {
  risk: Risk;
  reasons: string[];
  /** "site:<origin>" for the page's site, or "all" with no page. */
  scope: string;
}

const PURCHASE = /\b(buy|purchase|checkout|check out|pay|pay now|place (your |my )?order|order now|complete (your |my )?order|submit order|confirm (and pay|order|purchase)|subscribe|donate|add payment|upgrade|rent|bid)\b/i;
const SEND = /\b(send|invite|forward)\b/i;
const POST = /\b(post|publish|tweet|retweet|repost|reply|comment|share|upload|submit)\b/i;
const DESTRUCTIVE = /\b(delete|remove|erase|discard|cancel (my |your )?(account|subscription|order|membership)|close (my |your )?account|deactivate|unsubscribe|transfer|withdraw)\b/i;

export function siteScope(url: string | null): string {
  const site = siteOf(url);
  return site != null ? `site:${site}` : "all";
}

/** `button “Buy now”`, as the approval card shows an element. */
export function describeTarget(target: BrowserTarget): string {
  const name = target.name.length > 60 ? `${target.name.slice(0, 59)}…` : target.name;
  return name.length > 0 ? `${target.role} “${name}”` : target.role || target.tag || "element";
}

export function rateClick(info: BrowserPlanInfo): BrowserVerdict {
  const scope = siteScope(info.url);
  const target = info.target;
  if (target == null) return { risk: "read-only", reasons: [], scope };
  const words = target.name;
  const reasons: string[] = [];
  if (PURCHASE.test(words)) reasons.push("it looks like a purchase");
  else if (SEND.test(words)) reasons.push("it looks like it sends something");
  else if (POST.test(words)) reasons.push("it looks like it posts or publishes something");
  else if (DESTRUCTIVE.test(words)) reasons.push("it looks like it deletes or cancels something");
  if (target.submits) reasons.push("it submits a form");
  return reasons.length > 0 ? { risk: "mutating", reasons: reasons.map((reason) => `${reason} on ${siteLabel(siteOf(info.url))}`), scope } : { risk: "read-only", reasons: [], scope };
}

/** `typed` is how the card shows the text (“Ada”), left out for a secret field. */
export function rateTyping(info: BrowserPlanInfo, submit: boolean, typed = "text"): BrowserVerdict {
  const scope = siteScope(info.url);
  const site = siteLabel(siteOf(info.url));
  const target = info.target;
  const secret = target != null ? sensitiveField(target) : null;
  if (secret != null) {
    const what = secret === "password" ? "a password field" : secret === "payment card" ? "a payment card field" : "a one-time code field";
    return { risk: "dangerous", reasons: [`${what} on ${site}: signing in and paying are yours to do (the agent can hand you the browser with browser_wait_for_user)`], scope };
  }
  return { risk: "mutating", reasons: [`types ${typed} into ${target != null ? describeTarget(target) : "the page"} on ${site}${submit ? " and submits it" : ""}`], scope };
}

export function rateKey(info: BrowserPlanInfo, chord: KeyChord): BrowserVerdict {
  const scope = siteScope(info.url);
  if (isMovingKey(chord)) return { risk: "read-only", reasons: [], scope };
  const site = siteLabel(siteOf(info.url));
  const secret = info.target != null ? sensitiveField(info.target) : null;
  if (secret != null && chord.text.length > 0 && chord.key !== "Enter") return { risk: "dangerous", reasons: [`types into a ${secret} field on ${site}`], scope };
  return { risk: "mutating", reasons: [chord.key === "Enter" || chord.key === " " ? `presses ${chord.label} on ${site}, which can submit a form or press a button` : `presses ${chord.label} on ${site}`], scope };
}
