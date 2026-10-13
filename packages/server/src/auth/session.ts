export * as ServerSession from "./session"

export {
  configure,
  issue,
  isValid,
  revoke,
  REMEMBER_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
} from "@opencode/core/database/auth-session"
import { ServerAuth } from "../auth"

export const COOKIE_NAME = "opencode_session"

export function tokenFromCookies(cookies: Readonly<Record<string, string>>, host?: string) {
  // Accept Wellington's pre-split cookie on upgrade; new cookies are isolated by port.
  return cookies[ServerAuth.sessionCookieName(host)] ?? cookies[COOKIE_NAME]
}
