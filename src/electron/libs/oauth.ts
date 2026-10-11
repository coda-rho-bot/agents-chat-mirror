/**
 * Desktop OAuth sign-in — PKCE loopback flow over the core's token machinery.
 *
 * The browser part (expo-auth-session on Android) becomes an OS-default
 * browser via shell.openExternal here; the redirect captures on a loopback
 * listener, per RFC 8252. The token exchange/refresh/revoke logic is
 * @angus/letta-client-core's — one implementation, two shells.
 */
import { app, safeStorage, shell } from "electron";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  exchangeAuthorizationCode,
  getOAuthClientId,
  LETTA_OAUTH_BASE_URL,
  type OAuthCredential,
} from "@angus/letta-client-core";

const LOOPBACK_PORT = 17321;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** PKCE pair — S256, matching the Android AuthRequest configuration. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Run the full sign-in: open the system browser at the authorize endpoint,
 * await the loopback callback, exchange the code. Resolves with the
 * credential or rejects with a descriptive error. Cancelling closes the
 * listener; a stale browser tab landing later finds a dead port.
 */
export async function signInWithLetta(): Promise<OAuthCredential> {
  const clientId = getOAuthClientId();
  if (!clientId) throw new Error("OAuth is not configured for this client.");

  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  const authorizeUrl = new URL(`${LETTA_OAUTH_BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${LOOPBACK_PORT}`);
      const error = url.searchParams.get("error");
      const receivedState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      if (error || receivedState !== state || !authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h3>Sign-in failed — you can close this tab.</h3></body></html>");
        server.close();
        reject(new Error(error ? decodeURIComponent(error) : "Sign-in was cancelled or malformed."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h3>Signed in — you can close this tab and return to the app.</h3></body></html>");
      server.close();
      resolve(authCode);
    });
    // Port collision = a sign-in already in flight; fail fast, no queueing.
    server.on("error", (err) => reject(new Error(`OAuth listener unavailable: ${err.message}`)));
    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      void shell.openExternal(authorizeUrl.toString());
    });
    // Safety valve: abandoned sign-ins don't hold the port forever.
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out after 5 minutes."));
    }, 5 * 60_000);
    server.on("close", () => clearTimeout(timeout));
  });

  return exchangeAuthorizationCode({ clientId, code, codeVerifier: verifier, redirectUri: REDIRECT_URI });
}

/**
 * Electron-side SecretStore for the OAuth credential: safeStorage-encrypted
 * bytes at a fixed path in userData. Implements the core's SecretStore
 * contract (get/set/delete) so refresh logic stays core-side where possible.
 */
export function oauthCredentialPath(): string {
  return join(app.getPath("userData"), "oauth-credential.bin");
}

function readCredentialStore(): { get(k: string): string | null; set(k: string, v: string): void; delete(k: string): void } {
  const path = oauthCredentialPath();
  const load = (): Record<string, string> => {
    try {
      const raw = readFileSync(path);
      const plain = safeStorage.decryptString(raw);
      return plain ? (JSON.parse(plain) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(data)));
  };
  return {
    get(k) { return load()[k] ?? null; },
    set(k, v) { const d = load(); d[k] = v; write(d); },
    delete(k) { const d = load(); if (k in d) { delete d[k]; write(d); } },
  };
}

/** Persist the full credential (access + refresh + expiry) at sign-in. */
export function persistOAuthCredential(credential: OAuthCredential): void {
  readCredentialStore().set("credential", JSON.stringify(credential));
}

/** Read the persisted credential, if any. */
export function loadOAuthCredential(): OAuthCredential | null {
  const raw = readCredentialStore().get("credential");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthCredential>;
    if (parsed.kind === "oauth" && parsed.accessToken && parsed.refreshToken && parsed.expiresAt) {
      return parsed as OAuthCredential;
    }
  } catch { /* corrupt store = no credential */ }
  return null;
}
