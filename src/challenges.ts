import { randomUUID } from "node:crypto";

export interface AuthenticationChallengeRequest {
  accountId: string;
  accountLabel: string;
  kind: "github-mobile" | "agentrouter-waf";
  prompt: string;
  verificationCode: string | null;
  expiresInMs: number;
}

export interface PublicAuthenticationChallenge {
  id: string;
  accountId: string;
  accountLabel: string;
  kind: "github-mobile" | "agentrouter-waf";
  prompt: string;
  verificationCode: string | null;
  createdAt: string;
  expiresAt: string;
}

interface PendingChallenge extends PublicAuthenticationChallenge {
  timer: ReturnType<typeof setTimeout>;
}

export class AuthenticationChallengeBroker {
  private readonly pending = new Map<string, PendingChallenge>();

  list(): PublicAuthenticationChallenge[] {
    return [...this.pending.values()].map(({ timer: _timer, ...item }) => item);
  }

  publish(value: AuthenticationChallengeRequest): string {
    this.cancelAccount(value.accountId);
    if (
      value.kind === "github-mobile" &&
      value.verificationCode !== null &&
      !/^\d{2}$/.test(value.verificationCode)
    ) {
      throw new Error("GitHub Mobile verification code must contain exactly two digits.");
    }

    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + value.expiresInMs);
    const timer = setTimeout(() => this.complete(id), value.expiresInMs);
    this.pending.set(id, {
      id,
      accountId: value.accountId,
      accountLabel: value.accountLabel,
      kind: value.kind,
      prompt: value.prompt.slice(0, 300),
      verificationCode: value.verificationCode,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      timer,
    });
    return id;
  }

  complete(id: string): void {
    const challenge = this.pending.get(id);
    if (!challenge) return;
    this.pending.delete(id);
    clearTimeout(challenge.timer);
  }

  cancelAccount(accountId: string): void {
    for (const challenge of this.pending.values()) {
      if (challenge.accountId === accountId) {
        this.complete(challenge.id);
      }
    }
  }
}
