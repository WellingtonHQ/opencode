import { createEffect, type Accessor } from "solid-js"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useSettings } from "@/settings/model"
import { useLanguage } from "@/runtime/i18n/language"
import { formatServerError } from "./errors"
import { showToast } from "@/shell/notifications/toast"

export function useAutoApproveToggle(server: Accessor<ServerConnection.Any | undefined>) {
  const global = useGlobal()
  const settings = useSettings()
  const language = useLanguage()

  return (checked: boolean) => {
    const conn = server()
    if (!conn) return
    settings.permissions.setAutoApprove(checked)
    void global
      .ensureServerCtx(conn)
      .sdk.api.global["auto-approve"]
      .set({ enabled: checked })
      .catch((error: unknown) => {
        settings.permissions.setAutoApprove(!checked)
        showToast({
          variant: "error",
          title: language.t("settings.permissions.toast.updateFailed.title"),
          description: formatServerError(error, language.t),
        })
      })
  }
}

export function AutoApproveSync(props: { server: Accessor<ServerConnection.Any | undefined> }) {
  const global = useGlobal()
  const settings = useSettings()
  let sequence = 0

  createEffect(() => {
    const run = ++sequence
    const conn = props.server()
    if (!conn || global.servers.health[ServerConnection.key(conn)]?.healthy !== true) return
    void global
      .ensureServerCtx(conn)
      .sdk.api.global["auto-approve"]
      .get()
      .then((state) => {
        if (run !== sequence) return
        settings.permissions.setAutoApprove(state.enabled)
      })
      .catch(() => undefined)
  })

  return null
}
