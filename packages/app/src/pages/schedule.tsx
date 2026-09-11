import type { ScheduleRun, ScheduleTaskWithLatest } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { DialogScheduleV2 } from "@/components/dialog-schedule-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { describeScheduleSpec } from "@/utils/schedule-spec"
import { showToast } from "@/utils/toast"

const REFRESH_INTERVAL_MS = 30_000
type Language = ReturnType<typeof useLanguage>

export function SchedulePage() {
  const server = useServer()
  return (
    <Show when={server.current} fallback={<ScheduleNoServer />}>
      <SchedulesContent />
    </Show>
  )
}

function ScheduleNoServer() {
  const language = useLanguage()
  return (
    <div class="flex min-h-[40vh] w-full items-center justify-center px-6">
      <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("error.serverSDK.noServerAvailable")}</p>
    </div>
  )
}

function SchedulesContent() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const dialog = useDialog()
  const [tick, setTick] = createSignal(0)
  onCleanup(() => clearInterval(setInterval(() => setTick(tick() + 1), REFRESH_INTERVAL_MS)))

  const client = () => sdk().client
  const refresh = () => setTick(tick() + 1)
  // Key includes the server URL so switching servers refetches automatically.
  const [list] = createResource(() => `${sdk().url}|${tick()}`, async () => (await client().v2.schedule.list()).data?.data ?? [])

  const sortedTasks = createMemo(
    () =>
      [...(list() ?? [])].sort((a, b) => {
        const order = (task: ScheduleTaskWithLatest) =>
          task.enabled && typeof task.nextFireMs === "number" && Number.isFinite(task.nextFireMs) ? task.nextFireMs : Infinity
        return order(a) - order(b) || a.name.localeCompare(b.name)
      }),
  )

  async function toggleEnabled(task: ScheduleTaskWithLatest, enabled: boolean) {
    try {
      await client().v2.schedule.update({ id: task.id, scheduleUpdate: { enabled } })
      refresh()
    } catch (error) {
      showToast(failureToast(error, language))
    }
  }

  async function runNow(task: ScheduleTaskWithLatest) {
    try {
      await client().v2.schedule.run({ id: task.id })
      showToast({ title: language.t("toast.schedule.ran.title"), description: task.name })
      refresh()
    } catch (error) {
      showToast(failureToast(error, language))
    }
  }

  async function confirmDelete(task: ScheduleTaskWithLatest) {
    try {
      await client().v2.schedule.remove({ id: task.id })
      refresh()
      dialog.close()
    } catch (error) {
      showToast(failureToast(error, language))
    }
  }

  function showCreate() {
    void dialog.show(() => <DialogScheduleV2 onDone={refresh} />)
  }

  function showEdit(task: ScheduleTaskWithLatest) {
    void dialog.show(() => <DialogScheduleV2 editing={task} onDone={refresh} />)
  }

  function showDelete(task: ScheduleTaskWithLatest) {
    void dialog.show(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitle>{language.t("dialog.schedule.delete.title")}</DialogTitle>
          </DialogHeader>
          <DividerV2 />
          <DialogBody class="px-4 py-4 text-[13px] font-[440] leading-relaxed tracking-[-0.04px] text-v2-text-text-muted">
            {language.t("dialog.schedule.delete.body")}
          </DialogBody>
          <DialogFooter>
            <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 type="button" variant="danger" onClick={() => void confirmDelete(task)}>
              {language.t("common.delete")}
            </ButtonV2>
          </DialogFooter>
        </Dialog>
      ),
    )
  }

  const formatters = createMemo(() => ({
    time: new Intl.DateTimeFormat(language.intl(), { hour: "numeric", minute: "2-digit" }),
    date: new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric", year: "numeric" }),
    dateTime: new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat(language.intl(), { weekday: "short" }),
  }))

  return (
    <div class="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-8 px-4 py-10 lg:px-6">
      <header class="flex shrink-0 items-center justify-between gap-4 pl-1.5 pr-3">
        <h1 class="text-v2-text-text-base [font-size:16px] [font-weight:560] tracking-[-0.04px]">{language.t("schedule.title")}</h1>
        <ButtonV2 variant="contrast" icon="plus" onClick={showCreate}>
          {language.t("schedule.new")}
        </ButtonV2>
      </header>

      <Show when={list.error}>
        <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("common.requestFailed")}</p>
      </Show>

      <Show
        when={!list.error && sortedTasks().length > 0}
        fallback={
          <Show when={list.loading} keyed fallback={<ScheduleEmpty language={language} onNew={showCreate} />}>
            <div class="h-8" />
          </Show>
        }
      >
        <ol class="flex w-full flex-col">
          <For each={sortedTasks()}>
            {(task) => (
              <ScheduleRow
                task={task}
                formatters={formatters()}
                language={language}
                onEdit={() => showEdit(task)}
                onToggle={(enabled) => toggleEnabled(task, enabled)}
                onRunNow={() => runNow(task)}
                onDelete={() => showDelete(task)}
              />
            )}
          </For>
        </ol>
      </Show>
    </div>
  )
}

function ScheduleEmpty(props: { language: Language; onNew: () => void }) {
  return (
    <div class="flex w-full flex-col items-center gap-3 py-16 text-center">
      <p class="text-[14px] font-[530] tracking-[-0.04px]">{props.language.t("schedule.empty.title")}</p>
      <p class="text-[13px] font-[440] leading-relaxed text-v2-text-text-muted">{props.language.t("schedule.empty.body")}</p>
      <ButtonV2 variant="contrast" onClick={props.onNew}>
        {props.language.t("schedule.new")}
      </ButtonV2>
    </div>
  )
}

function ScheduleRow(props: {
  task: ScheduleTaskWithLatest
  formatters: Formatters
  language: Language
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
  onDelete: () => void
}) {
  const task = props.task

  return (
    <li class="flex w-full items-center gap-4 rounded-[10px] px-3 py-3 transition-colors hover:bg-v2-overlay-simple-overlay-hover">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-[14px] font-[530] tracking-[-0.04px]">{task.name}</span>
          <Show when={!task.enabled}>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-[440] text-v2-text-text-muted">{props.language.t("schedule.paused")}</span>
          </Show>
        </div>
        <p class="truncate text-[13px] font-[440] tracking-[-0.04px] text-v2-text-text-muted">
          {specText(task, props.formatters, props.language)}
        </p>
        <p class="truncate text-[12px] font-[440] text-v2-text-text-faint" title={task.directory}>
          {shortDirectory(task.directory)}
        </p>
      </div>

      <NextRun task={task} formatters={props.formatters} language={props.language} />
      <LatestRun run={task.latestRun} language={props.language} />
      <Switch checked={task.enabled} onChange={(checked) => props.onToggle(checked)} aria-label={toggleLabel(task, props.language)} />

      <div class="flex shrink-0 items-center gap-1">
        <TooltipV2 value={props.language.t("schedule.row.edit")}>
          <IconButtonV2 variant="ghost-muted" icon={<Icon name="edit" size="small" />} onClick={props.onEdit} aria-label={props.language.t("schedule.row.edit")} />
        </TooltipV2>
        <TooltipV2 value={props.language.t("schedule.row.runNow")}>
          <IconButtonV2 variant="ghost-muted" icon={<Icon name="play" size="small" />} onClick={props.onRunNow} aria-label={props.language.t("schedule.row.runNow")} />
        </TooltipV2>
        <TooltipV2 value={props.language.t("schedule.row.delete")}>
          <IconButtonV2 variant="ghost-muted" icon={<Icon name="trash" size="small" />} onClick={props.onDelete} aria-label={props.language.t("schedule.row.delete")} />
        </TooltipV2>
      </div>
    </li>
  )
}

function NextRun(props: { task: ScheduleTaskWithLatest; formatters: Formatters; language: Language }) {
  const next = () =>
    props.task.enabled && typeof props.task.nextFireMs === "number" && Number.isFinite(props.task.nextFireMs) ? new Date(props.task.nextFireMs) : undefined
  return (
    <Show when={next() !== undefined}>
      <div class="hidden w-48 shrink-0 items-center gap-1.5 md:flex">
        <span class="shrink-0 text-[12px] font-[440] text-v2-text-text-faint">{props.language.t("schedule.nextRun")}</span>
        {(() => {
          const date = next()
          return date ? <span class="truncate text-[13px] font-[440] tracking-[-0.04px]">{props.formatters.dateTime.format(date)}</span> : null
        })()}
      </div>
    </Show>
  )
}

function LatestRun(props: { run?: ScheduleRun; language: Language }) {
  const label = () => {
    if (!props.run) return undefined
    switch (props.run.status) {
      case "fired":
      case "catch_up":
        return props.language.t("schedule.status.ran")
      case "missed":
        return props.language.t("schedule.status.missed")
      case "error":
        return props.language.t("schedule.status.failed")
    }
    return undefined
  }
  const item = () => props.run
  return (
    <Show when={label() !== undefined}>
      {(() => {
        const run = item()
        if (!run) return null
        const chip = (
          <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-[440] text-v2-text-text-muted">{label()}</span>
        )
        return run.errorText ? <TooltipV2 value={run.errorText}>{chip}</TooltipV2> : chip
      })()}
    </Show>
  )
}

function specText(task: ScheduleTaskWithLatest, formatters: Formatters, language: Language) {
  const descriptor = describeScheduleSpec(task.spec)
  switch (descriptor.kind) {
    case "daily":
      return descriptor.timeHhMm ? language.t("schedule.spec.daily", { time: formatters.time.format(atTime(descriptor.timeHhMm)) }) : ""
    case "weekly": {
      if (!descriptor.days.length || !descriptor.timeHhMm) return ""
      const days = descriptor.days.map((day) => formatters.weekday.format(new Date(2024, 11, 1 + day))).join(", ")
      return language.t("schedule.spec.weekly", { days, time: formatters.time.format(atTime(descriptor.timeHhMm)) })
    }
    case "one_shot":
      if (!descriptor.ms) return ""
      const date = new Date(descriptor.ms)
      return language.t("schedule.spec.oneShot", { date: formatters.date.format(date), time: formatters.time.format(date) })
    case "cron":
      return descriptor.expr
  }
  return ""
}

function atTime(timeHhMm: string) {
  const [hour, minute] = timeHhMm.split(":").map(Number)
  return new Date(2000, 0, 1, hour ?? 0, minute ?? 0)
}

function shortDirectory(directory: string) {
  return directory.split(/[\\/]+/).filter(Boolean).pop() ?? directory
}

function toggleLabel(task: ScheduleTaskWithLatest, language: Language) {
  return task.enabled ? language.t("schedule.active") : language.t("schedule.paused")
}

function failureToast(error: unknown, language: Language) {
  const message = error instanceof Error ? error.message : ""
  return { title: language.t("common.requestFailed"), ...(message ? { description: message } : {}) }
}

interface Formatters {
  time: Intl.DateTimeFormat
  date: Intl.DateTimeFormat
  dateTime: Intl.DateTimeFormat
  weekday: Intl.DateTimeFormat
}
