import { createEffect } from "solid-js"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"
import { authTokenFromCredentials, withSignInRedirect } from "./server"
import { formatServerError } from "./server-errors"
import { showToast } from "./toast"

export class AutoApproveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "AutoApproveError"
  }
}

function messageFromBody(body: string): string {
  try {
    const data = JSON.parse(body) as { message?: unknown }
    if (typeof data.message === "string") return data.message
  } catch {
    // non-JSON body; callers fall back to their own copy
  }
  return ""
}

function request<T>(server: ServerConnection.HttpBase, method: string, path: string, body?: unknown): Promise<T | undefined> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (server.password) {
    headers.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  }
  return withSignInRedirect(server, globalThis.fetch)(`${server.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    const text = await response.text()
    if (!response.ok) throw new AutoApproveError(messageFromBody(text), response.status)
    return text ? (JSON.parse(text) as T) : undefined
  })
}

export function autoApproveApi(server: ServerConnection.HttpBase) {
  return {
    get: () => request<{ enabled: boolean }>(server, "GET", "/global/permissions/auto-approve"),
    set: (enabled: boolean) => request<void>(server, "PUT", "/global/permissions/auto-approve", { enabled }),
  }
}

export function useAutoApproveToggle() {
  const server = useServer()
  const settings = useSettings()
  const language = useLanguage()

  return (checked: boolean) => {
    const conn = server.current
    if (!conn) return
    settings.permissions.setAutoApprove(checked)
    void autoApproveApi(conn.http)
      .set(checked)
      .catch((err: unknown) => {
        settings.permissions.setAutoApprove(!checked)
        showToast({
          variant: "error",
          title: language.t("settings.permissions.toast.updateFailed.title"),
          description: formatServerError(err, language.t),
        })
      })
  }
}

export const AutoApproveSync = () => {
  const server = useServer()
  const global = useGlobal()
  const settings = useSettings()
  let seq = 0

  createEffect(() => {
    const conn = server.current
    if (!conn) return
    // Only sync once the health check has confirmed this server is reachable.
    if (global.servers.health[ServerConnection.key(conn)]?.healthy !== true) return
    const run = ++seq
    void autoApproveApi(conn.http)
      .get()
      .then((data) => {
        if (run !== seq) return
        settings.permissions.setAutoApprove(data?.enabled === true)
      })
      .catch(() => undefined)
  })

  return null
}
