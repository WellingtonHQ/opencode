import { For, Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Divider } from "@opencode/ui/divider"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Spinner } from "@opencode/ui/spinner"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
import { useDialog } from "@opencode/ui/context/dialog"
import type { ScheduleListOutput } from "@opencode/client/promise"
import { Schedule } from "@opencode/schema/schedule"
import { formatClock, formatDateTime, formatTimeZoneName, weekdayLabels } from "@/runtime/server/schedule"
import { formatServerError } from "@/runtime/server/errors"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"

export function SchedulePanel(props: { server: ServerConnection.Any; defaultDirectory?: string }) {
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const ctx = global.ensureServerCtx(props.server)
  const api = ctx.sdk.api.schedule
  let sequence = 0

  type Task = ScheduleListOutput[number]
  const [state, setState] = createStore<{ items?: Task[]; error: boolean; busy?: string }>({ error: false })

  function load() {
    const run = ++sequence
    setState("error", false)
    void api
      .list()
      .then((items) => {
        if (run === sequence) setState("items", items)
      })
      .catch(() => {
        if (run === sequence) setState("error", true)
      })
  }

  createEffect(() => {
    if (ctx.sdk.connection.status() === "connected") load()
  })

  createEffect(() => {
    if (ctx.sdk.connection.status() !== "connected") return
    const unsubscribe = ctx.sdk.event.on("schedule.changed", load)
    onCleanup(unsubscribe)
  })

  function openEditor(task?: Task) {
    void import("./dialog").then((module) => {
      void dialog.show(() => <module.DialogSchedule task={task} server={props.server} defaultDirectory={props.defaultDirectory} />)
    })
  }

  function apply(mutate: (items: Task[]) => Task[]) {
    if (!state.items) return
    setState("items", mutate(state.items))
  }

  function toggleEnabled(item: Task) {
    if (state.busy === item.id) return
    const enabled = !item.enabled
    setState("busy", item.id)
    apply((items) => items.map((current) => (current.id === item.id ? { ...current, enabled } : current)))
    void api
      .update({ scheduleID: item.id, enabled })
      .then((updated) => {
        apply((items) => items.map((current) => (current.id === item.id ? updated : current)))
      })
      .catch(() => {
        apply((items) => items.map((current) => (current.id === item.id ? { ...current, enabled: !enabled } : current)))
      })
      .finally(() => {
        if (state.busy === item.id) setState("busy", undefined)
      })
  }

  function runNow(item: Task) {
    if (state.busy === item.id) return
    setState("busy", item.id)
    void api
      .runNow({ scheduleID: item.id })
      .then(load)
      .catch(() => undefined)
      .finally(() => {
        if (state.busy === item.id) setState("busy", undefined)
      })
  }

  function name(item: Task) {
    return item.name || item.prompt
  }

  function summary(item: Task) {
    const zone = `${formatTimeZoneName(item.nextRunAtMs ?? Date.now(), language.intl(), item.timezone)} (${item.timezone})`
    switch (item.spec.kind) {
      case "once":
        return `${formatDateTime(item.spec.atMs, language.intl(), item.timezone)} (${item.timezone})`
      case "daily":
        return language.t("schedule.summary.daily", { time: `${formatClock(item.spec.hour, item.spec.minute)} ${zone}` })
      case "weekly":
        return language.t("schedule.summary.weekly", {
          days: weekdayLabels(item.spec.days, language.intl(), item.timezone).join(", "),
          time: `${formatClock(item.spec.hour, item.spec.minute)} ${zone}`,
        })
      case "cron":
        return `${item.spec.expr} (${item.timezone})`
    }
  }

  function latestRunStatus(item: Task): { status: Schedule.RunStatus; errorText?: string } | undefined {
    const run = item.recentRuns?.[0]
    if (run) return { status: run.status, errorText: run.errorText }
    if (item.lastError !== undefined) return { status: "failed", errorText: item.lastError }
    if (item.lastRunAtMs !== undefined) return { status: "completed" }
  }

  function statusLabel(status: Schedule.RunStatus) {
    switch (status) {
      case "running":
        return language.t("schedule.status.running")
      case "completed":
        return language.t("schedule.status.completed")
      case "failed":
        return language.t("schedule.status.failed")
      case "skipped":
        return language.t("schedule.status.skipped")
    }
  }

  const runStatusIndicator = (item: Task) => {
    const run = latestRunStatus(item)
    if (!run) return null
    const label = statusLabel(run.status)
    const tip = run.status === "failed" && run.errorText ? run.errorText : label
    const icon =
      run.status === "running" ? (
        <Spinner class="size-2.5 text-icon-base" />
      ) : run.status === "completed" ? (
        <Icon name="circle-check" class="size-3 text-icon-success-base" />
      ) : run.status === "skipped" ? (
        <Icon name="circle-ban-sign" class="size-3 text-icon-base" />
      ) : (
        <Icon name="warning" class="size-3 text-icon-critical-base" />
      )

    return (
      <Tooltip placement="top" value={tip}>
        <span aria-label={label} class="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      </Tooltip>
    )
  }

  const policyIndicator = () => {
    const enabled = settings.permissions.autoApproveDefault()
    return (
      <Tooltip
        placement="top"
        value={enabled ? language.t("schedule.panel.autoAccept.tooltip.on") : language.t("schedule.panel.autoAccept.tooltip.off")}
      >
        <span
          aria-label={enabled ? language.t("schedule.panel.autoAccept.on") : language.t("schedule.panel.autoAccept.off")}
          class="flex items-center justify-center"
        >
          <Icon name="shield" class={`size-3.5 ${enabled ? "text-icon-success-base" : "text-text-weak"}`} />
        </span>
      </Tooltip>
    )
  }

  const row = (item: Task) => (
    <div class="flex w-full items-center gap-2 py-1.5">
      {runStatusIndicator(item)}
      <button type="button" class="min-w-0 flex-1 text-start focus:outline-none" onClick={() => openEditor(item)}>
        <span title={name(item)} class="block min-w-0 truncate text-14-regular text-text-strong">
          {name(item)}
        </span>
        <span class="block min-w-0 truncate text-12-medium text-text-weak">{summary(item)}</span>
      </button>
      <Switch
        hideLabel
        checked={item.enabled}
        disabled={state.busy === item.id}
        aria-label={item.enabled ? language.t("schedule.row.disable", { name: name(item) }) : language.t("schedule.row.enable", { name: name(item) })}
        onChange={() => toggleEnabled(item)}
      >
        {name(item)}
      </Switch>
      <Tooltip placement="top" value={language.t("schedule.row.runNow")}>
        <IconButton
          icon={<Icon name="play" />}
          variant="ghost"
          size="small"
          disabled={state.busy === item.id}
          onClick={() => runNow(item)}
          aria-label={language.t("schedule.row.runNow")}
        />
      </Tooltip>
      <Tooltip placement="top" value={language.t("schedule.delete.title")}>
        <IconButton
          icon={<Icon name="trash" />}
          variant="ghost"
          size="small"
          onClick={() => dialog.show(() => <DeleteScheduleDialog item={item} server={props.server} onDone={load} />)}
          aria-label={language.t("common.delete")}
        />
      </Tooltip>
    </div>
  )

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      <div class="flex items-center justify-between px-3 pt-3 pb-1">
        <span class="text-12-medium text-text-weak">{language.t("sidebar.schedules")}</span>
        <div class="flex items-center gap-1">
          {policyIndicator()}
          <Tooltip placement="top" value={language.t("schedule.panel.new")}>
            <IconButton
              icon={<Icon name="plus" />}
              variant="ghost"
              onClick={() => openEditor()}
              aria-label={language.t("schedule.panel.new")}
            />
          </Tooltip>
        </div>
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

function DeleteScheduleDialog(props: { item: ScheduleListOutput[number]; server: ServerConnection.Any; onDone: () => void }) {
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const api = global.ensureServerCtx(props.server).sdk.api.schedule
  const [state, setState] = createStore<{ busy: boolean; error?: string }>({ busy: false })

  function remove() {
    if (state.busy) return
    setState("busy", true)
    void api
      .remove({ scheduleID: props.item.id })
      .then(() => {
        dialog.close()
        props.onDone()
      })
      .catch((error: unknown) => setState({ busy: false, error: formatServerError(error, language.t) }))
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitle>{language.t("schedule.delete.title")}</DialogTitle>
      </DialogHeader>
      <Divider />
      <DialogBody class="flex w-full min-w-0 flex-col px-4 pt-4 pb-2">
        <p class="text-14-regular text-text-strong">
          {language.t("schedule.delete.body", { name: props.item.name || props.item.prompt })}
        </p>
        <Show when={state.error}>
          <span class="mt-2 block text-12-medium text-icon-critical-base">{state.error}</span>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant="danger" disabled={state.busy} onClick={remove}>
          {language.t("common.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
