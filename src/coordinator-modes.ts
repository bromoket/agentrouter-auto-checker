export type CycleMode = "read" | "grant" | "full-logout";

/**
 * Decide the mode for a scheduled AgentRouter cycle.
 *
 * - "read": persistent-session read (no logout) — the frequent path.
 * - "grant": explicit logout->login cycle (claims daily/random grants).
 * - "full-logout": legacy — logout every cycle (persistent reuse disabled).
 *
 * A grant due always wins (it needs the login to claim grants). When persistent
 * session reuse is enabled and no grant is due, cycles just read the live session.
 */
export function cycleMode(input: { grantDue: boolean; reuse: boolean }): CycleMode {
  if (input.grantDue) return "grant";
  if (input.reuse) return "read";
  return "full-logout";
}
