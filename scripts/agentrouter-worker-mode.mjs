/**
 * Decide whether a cycle must run the END-OF-CYCLE logout.
 *
 * In the persistent-session model (reusePersistentSession: true, the default),
 * we keep the live AgentRouter session alive so the 1-minute read loop can reuse
 * it without re-login. The "logout" that precedes login (to re-claim grants) is
 * the preflight logout already run when a stale session is found at /login — NOT
 * this end-of-cycle logout. So the end-of-cycle logout only runs when persistent
 * session reuse is disabled (legacy behavior: logout every cycle).
 *
 * grantMode is intentionally not considered here: even the periodic grant cycle
 * must keep the session alive after login so reads continue, and re-login next
 * cycle clears it via the preflight logout.
 */
export function shouldLogout({ reusePersistentSession }) {
  return reusePersistentSession !== true;
}
