/**
 * Decide whether an AgentRouter cycle must logout.
 *
 * grantMode   : this is the periodic logout->login grant cycle (claims grants).
 * reuseSession: persistent-session reuse is enabled (read/full cycles).
 *
 * Logout only happens on the grant cycle (to claim grants) OR when persistent
 * session reuse is disabled (legacy behavior that logs out every cycle).
 * When reuse is on and this is a read cycle, the live session is kept alive.
 */
export function shouldLogout({ grantMode, reusePersistentSession }) {
  return grantMode === true || reusePersistentSession !== true;
}
