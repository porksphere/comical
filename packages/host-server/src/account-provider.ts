/**
 * Username/password accounts + per-device session tokens — the surface the router depends on, as a
 * Node-free interface (like `device-provider.ts`) so `router.ts` stays bundleable into the RN app.
 * `FileAccountStore` satisfies it structurally.
 *
 * This replaces QR enrollment. Login is the front door; the day-to-day credential is still an opaque,
 * server-stored, revocable **session token** (exactly like the old device token), so revocation stays
 * instant — login just mints the token instead of a scanned code.
 *
 * Accounts are *credentials*, not partitions: there is one shared library and one shared sync account,
 * so `verify()` returns that single account id regardless of which username the session belongs to.
 * (Multi-tenant per-account libraries are out of scope.)
 */
export interface SessionInfo {
  id: string;
  username: string;
  /** A human label for the device/browser this session was minted on. */
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface AccountInfo {
  username: string;
  createdAt: number;
  sessions: SessionInfo[];
}

export interface LoginResult {
  /** The session token — returned ONCE. Only its hash is stored. */
  token: string;
  /** The single shared sync account id every session maps to. */
  account: string;
  /** This server's stable identity (for the wrong-server check on the client). */
  serverId: string;
  sessionId: string;
}

export interface AccountProvider {
  /** Stable, opaque server identity (survives restarts). */
  serverId(): Promise<string>;
  /** Verify a password and mint a session token. null on unknown user or bad password. */
  login(username: string, password: string, deviceName?: string): Promise<LoginResult | null>;
  /** Verify a session token → the shared account (and touch lastSeenAt), or null. */
  verify(token: string): Promise<string | null>;
  /** Accounts and their sessions — no secrets. Admin. */
  list(): Promise<AccountInfo[]>;
  /** True if any account exists (bootstrap messaging). */
  hasAccounts(): Promise<boolean>;
  /** Admin: create an account. false if the username is invalid or already exists. */
  createAccount(username: string, password: string): Promise<boolean>;
  /** Admin: reset a password (and revoke that account's sessions). false if unknown. */
  setPassword(username: string, password: string): Promise<boolean>;
  /** Admin: delete an account and all its sessions. false if unknown. */
  deleteAccount(username: string): Promise<boolean>;
  /** Admin: revoke one session by id. */
  revokeSession(id: string): Promise<boolean>;
  /** Self: revoke the session that owns this token (the app's "log out this device"). */
  revokeSelf(token: string): Promise<boolean>;
}
