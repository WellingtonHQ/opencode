import { For, Show, createEffect, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Schedule } from "@opencode-ai/schema/schedule"
import { formatClock, formatDateTime, scheduleApi, weekdayLabels } from "@/utils/schedule"
import { formatServerError } from "@/utils/server-errors"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

export const SidebarSchedules = (props: { defaultDirectory?: string }): JSX.Element => {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  let seq = 0

  const [state, setState] = createStore<{ items?: Schedule.Info[]; error: boolean; busy?: string }>({
    error: false,
  })

  function load() {
    const run = ++seq
    setState("error", false)
    scheduleApi(serverSDK().server.http)
      .list()
      .then((items) => {
        if (run !== seq) return
        setState("items", items ?? [])
      })
      .catch(() => {
        if (run === seq) setState("error", true)
      })
  }

  createEffect(() => {
    const url = serverSDK().url
    if (!url) return
    load()
  })

  createEffect(() => {
    const unsub = serverSDK().event.listen((e) => {
      // schedule.changed is emitted by the server but not yet declared in the
      // generated legacy Event union, so widen before comparing.
      if ((e.details?.type as string | undefined) !== "schedule.changed") return
      load()
    })
    onCleanup(unsub)
  })

  function openEditor(task?: Schedule.Info) {
    void import("@/components/dialog-schedule-v2").then((mod) => {
      void dialog.show(() => <mod.DialogScheduleV2 task={task} defaultDirectory={props.defaultDirectory} />)
    })
  }

  function toggleEnabled(item: Schedule.Info) {
    if (state.busy === item.id) return
    const next = !item.enabled
    setState("busy", item.id)
    apply(items => items.map((it) => (it.id === item.id ? { ...it, enabled: next } : it)))
    scheduleApi(serverSDK().server.http)
      .update(item.id, { enabled: next })
      .then((updated) =>
        apply((items) => items.map((it) => (it.id === item.id ? (updated ?? { ...it, enabled: next }) : it))),
      )
      .catch(() => apply((items) => items.map((it) => (it.id === item.id ? { ...it, enabled: !next } : it))))
      .finally(() => {
        if (state.busy === item.id) setState("busy", undefined)
      })
  }

  function runNow(item: Schedule.Info) {
    if (state.busy === item.id) return
    setState("busy", item.id)
    scheduleApi(serverSDK().server.http)
      .runNow(item.id)
      .then(() => load())
      .catch(() => undefined)
      .finally(() => {
        if (state.busy === item.id) setState("busy", undefined)
      })
  }

  function apply(mutate: (items: Schedule.Info[]) => Schedule.Info[]) {
    const items = state.items
    if (!items) return
    setState("items", mutate(items))
  }

  function name(item: Schedule.Info) {
    return item.name || item.prompt
  }

  function summary(item: Schedule.Info) {
    const spec = item.spec
    switch (spec.kind) {
      case "once":
        return formatDateTime(spec.atMs, language.intl())
      case "daily":
        return language.t("schedule.summary.daily", { time: formatClock(spec.hour, spec.minute) })
      case "weekly":
        return language.t("schedule.summary.weekly", {
          days: weekdayLabels(spec.days, language.intl()).join(", "),
          time: formatClock(spec.hour, spec.minute),
        })
      case "cron":
        return spec.expr
    }
    return undefined
  }

  const row = (item: Schedule.Info) => (
    <div class="flex w-full items-center gap-2 py-1.5">
      <button
        type="button"
        class="min-w-0 flex-1 text-left focus:outline-none"
        onClick={() => openEditor(item)}
      >
        <span title={name(item)} class="block min-w-0 truncate text-14-regular text-text-strong">
          {name(item)}
        </span>
        <span class="block min-w-0 truncate text-12-medium text-text-weak">{summary(item)}</span>
      </button>
      <Switch
        hideLabel={true}
        checked={item.enabled}
        disabled={state.busy === item.id}
        aria-label={
          item.enabled
            ? language.t("schedule.row.disable", { name: name(item) })
            : language.t("schedule.row.enable", { name: name(item) })
        }
        onChange={() => toggleEnabled(item)}
      />
      <Tooltip placement="top" value={language.t("schedule.row.runNow")}>
        <IconButton
          icon="play"
          variant="ghost"
          size="small"
          disabled={state.busy === item.id}
          onClick={() => runNow(item)}
          aria-label={language.t("schedule.row.runNow")}
        />
      </Tooltip>
      <Tooltip placement="top" value={language.t("schedule.delete.title")}>
        <IconButton icon="trash" variant="ghost" size="small" onClick={() => dialog.show(() => <DeleteScheduleDialog item={item} onDone={() => load()} />)} aria-label={language.t("common.delete")} />
      </Tooltip>
    </div>
  )

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      <div class="flex items-center justify-between px-3 pt-3 pb-1">
        <span class="text-12-medium text-text-weak">{language.t("sidebar.schedules")}</span>
        <Tooltip placement="top" value={language.t("schedule.panel.new")}>
          <IconButton icon="plus" variant="ghost" onClick={() => openEditor()} aria-label={language.t("schedule.panel.new")} />
        </Tooltip>
      </div>
      <Show
        when={state.items && state.items.length > 0}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <Show when={state.error}>
              <>
                <Icon name="circle-ban-sign" class="size-5 text-icon-critical-base" />
                <span class="text-12-medium text-text-weak">{language.t("schedule.panel.error")}</span>
              </>
            </Show>
            <Show when={!state.error}>
              <>
                <Icon name="calendar" class="size-5 text-icon-base" />
                <span class="text-14-medium text-text-strong">{language.t("schedule.empty.title")}</span>
                <span class="text-12-medium text-text-weak">{language.t("schedule.empty.hint")}</span>
              </>
            </Show>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <For each={state.items}>{row}</For>
        </div>
      </Show>
    </div>
  )
}

function DeleteScheduleDialog(props: { item: Schedule.Info; onDone: () => void }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore<{ busy: boolean; error?: string }>({ busy: false })

  function remove() {
    if (state.busy) return
    setState("busy", true)
    scheduleApi(serverSDK().server.http)
      .remove(props.item.id)
      .then(() => {
        dialog.close()
        props.onDone()
      })
      .catch((err: unknown) => {
        setState({ busy: false, error: formatServerError(err, language.t) })
      })
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose={true}>
        <DialogTitle>{language.t("schedule.delete.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-col px-4 pt-4 pb-2">
        <p class="text-14-regular text-text-strong">{language.t("schedule.delete.body", { name: props.item.name || props.item.prompt })}</p>
        <Show when={state.error}>
          <span class="mt-2 block text-12-medium text-icon-critical-base">{state.error}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="danger" disabled={state.busy} onClick={remove}>
          {language.t("common.delete")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
