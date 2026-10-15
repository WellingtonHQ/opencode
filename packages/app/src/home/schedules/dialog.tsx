import { For, Show, createEffect, createMemo, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Divider } from "@opencode/ui/divider"
import { Field } from "@opencode/ui/field"
import { Select } from "@opencode/ui/select"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { useDialog } from "@opencode/ui/context/dialog"
import type { ScheduleListOutput } from "@opencode/client/promise"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { AbsolutePath } from "@opencode/schema/schema"
import { Schedule } from "@opencode/schema/schedule"
import { getFilename } from "@opencode/util/path"
import { formatClock, formatDateTime, isValidCronExpression, nextRunAfter, parseDateTimeLocal, formatDateTimeLocal, weekdayLabels } from "@/runtime/server/schedule"
import { formatServerError } from "@/runtime/server/errors"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { normalizeAgentList, normalizeProviderList } from "@/runtime/server/global-sync/utils"

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]

type ModelOption = { key: string; name: string; group: string }

const DEFAULT_MODEL_KEY = "__default_model__"

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function defaultOnceValue(timezone: string) {
  return formatDateTimeLocal(Date.now() + 60 * 60 * 1000, timezone)
}

function readTime(value: string): { hour: number; minute: number } | undefined {
  const [rawHour, rawMinute] = value.split(":")
  const hour = Number(rawHour)
  const minute = Number(rawMinute ?? "0")
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return { hour, minute }
}

export const DialogSchedule: Component<{
  server: ServerConnection.Any
  task?: ScheduleListOutput[number]
  defaultDirectory?: string
}> = (props) => {
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const pickDirectory = useDirectoryPicker()
  const ctx = global.ensureServerCtx(props.server)
  const timezone = props.task?.timezone ?? browserTimeZone()
  const spec = props.task?.spec

  const [form, setForm] = createStore({
    name: props.task?.name ?? "",
    prompt: props.task?.prompt ?? "",
    // Existing schedules keep the saved IANA zone; the sidebar's selected project only seeds new schedules.
    directory: props.task ? props.task.directory : props.defaultDirectory || "",
    timezone,
    agentId: props.task?.agentId as string | undefined,
    modelKey: props.task?.model ? `${String(props.task.model.providerID)}:${props.task.model.id}` : DEFAULT_MODEL_KEY,
    kind: spec?.kind ?? ("daily" as Schedule.Kind),
    onceValue: spec?.kind === "once" ? formatDateTimeLocal(spec.atMs, timezone) : defaultOnceValue(timezone),
    timeValue: spec && (spec.kind === "daily" || spec.kind === "weekly") ? formatClock(spec.hour, spec.minute) : "09:00",
    days: spec?.kind === "weekly" ? [...spec.days] : [1, 2, 3, 4, 5],
    cronExpr: spec?.kind === "cron" ? spec.expr : "",
    error: undefined as string | undefined,
    busy: false,
  })

  const agents = createMemo(() => {
    const directory = form.directory
    if (!directory) return []
    return normalizeAgentList(ctx.data.location.agent.list({ directory }) ?? []).filter(
      (agent) => agent.mode !== "subagent" && !agent.hidden,
    )
  })

  const providerCatalog = createMemo(() => {
    const directory = form.directory
    if (!directory) return
    const providers = ctx.data.location.provider.list({ directory })
    const models = ctx.data.location.model.list({ directory })
    if (!providers || !models) return
    return normalizeProviderList(providers, models)
  })

  createEffect(() => {
    const directory = form.directory
    if (!directory) return
    void Promise.all([
      ctx.data.location.agent.sync({ directory }),
      ctx.data.location.provider.sync({ directory }),
      ctx.data.location.model.sync({ directory }),
    ]).catch(() => undefined)
  })

  const modelOptions = createMemo<ModelOption[]>(() => {
    const data = providerCatalog()
    if (!data) return []
    const options = data.connected.flatMap((providerID) => {
      const provider = data.all.get(providerID)
      if (!provider) return []
      return Object.values(provider.models).map((model) => ({
        key: `${provider.id}:${model.id}`,
        name: model.name,
        group: provider.name,
      }))
    })
    options.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    return options
  })

  const allModelOptions = createMemo<ModelOption[]>(() => [
    { key: DEFAULT_MODEL_KEY, name: language.t("common.default"), group: "" },
    ...modelOptions(),
  ])
  const currentModelOption = createMemo(() => {
    const options = allModelOptions()
    return options.find((option) => option.key === form.modelKey) ?? options[0]
  })

  // A vanished configured model clears the old override; an unset override remains the default.
  function resolveModel(): Model.Ref | null {
    const key = form.modelKey
    if (!key || key === DEFAULT_MODEL_KEY) return null
    if (providerCatalog() && !modelOptions().some((option) => option.key === key)) return null
    const separator = key.indexOf(":")
    return { providerID: key.slice(0, separator), id: key.slice(separator + 1) } as Model.Ref
  }

  function buildSpec(): { spec?: Schedule.Spec; error?: string } {
    const now = Date.now()
    switch (form.kind) {
      case "once": {
        if (!form.onceValue) return { error: language.t("schedule.dialog.error.past") }
        const at = parseDateTimeLocal(form.onceValue, form.timezone)
        if (!Number.isFinite(at) || at <= now) return { error: language.t("schedule.dialog.error.past") }
        return { spec: { kind: "once", atMs: at } }
      }
      case "daily":
      case "weekly": {
        const time = readTime(form.timeValue) ?? { hour: 9, minute: 0 }
        if (form.kind === "weekly" && form.days.length === 0) return { error: language.t("schedule.dialog.error.days") }
        if (form.kind === "daily") return { spec: { kind: "daily", ...time } }
        return { spec: { kind: "weekly", days: [...form.days].sort((a, b) => a - b), ...time } }
      }
      case "cron": {
        if (!isValidCronExpression(form.cronExpr)) return { error: language.t("schedule.dialog.error.cron") }
        return { spec: { kind: "cron", expr: form.cronExpr.trim() } }
      }
    }
  }

  const nextRun = createMemo(() => {
    const built = buildSpec()
    if (!built.spec) return ""
    const at = nextRunAfter(built.spec, Date.now(), form.timezone)
    const formatted = formatDateTime(at, language.intl(), form.timezone)
    return formatted ? `${formatted} (${form.timezone})` : ""
  })

  function toggleDay(day: number) {
    const days = form.days.includes(day) ? form.days.filter((current) => current !== day) : [...form.days, day]
    setForm("days", days)
  }

  function openPicker() {
    const directory = form.directory || props.defaultDirectory
    pickDirectory({
      server: props.server,
      location: directory ? { directory } : undefined,
      title: language.t("schedule.dialog.project.label"),
      onSelect: (result) => {
        if (typeof result === "string") setForm("directory", result)
      },
    })
  }

  function submit() {
    if (form.busy || !form.directory) return
    const prompt = form.prompt.trim()
    if (!prompt) {
      setForm("error", language.t("schedule.dialog.prompt.required"))
      return
    }
    const built = buildSpec()
    if (!built.spec || built.error) {
      setForm("error", built.error ?? language.t("common.requestFailed"))
      return
    }

    setForm({ error: undefined, busy: true })
    const baseInput = {
      name: form.name.trim() || undefined,
      prompt,
      spec: built.spec,
      timezone: form.timezone,
      agentId: form.agentId ? (form.agentId as Agent.ID) : undefined,
      directory: form.directory as AbsolutePath,
    }
    const model = resolveModel()
    const action = props.task
      ? ctx.sdk.api.schedule.update({ scheduleID: props.task.id, ...baseInput, model })
      : ctx.sdk.api.schedule.create(model ? { ...baseInput, model } : baseInput)
    void action
      .then(() => dialog.close())
      .catch((error: unknown) => setForm("error", formatServerError(error, language.t)))
      .finally(() => setForm("busy", false))
  }

  const title = () => (props.task ? language.t("schedule.dialog.edit.title") : language.t("schedule.dialog.add.title"))

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <Divider />
      <DialogBody class="flex w-full min-w-0 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-5">
          <Field>
            <Field.Label>{language.t("schedule.dialog.name.label")}</Field.Label>
            <TextInput
              class="w-full"
              value={form.name}
              placeholder={language.t("schedule.dialog.name.placeholder")}
              disabled={form.busy}
              autofocus
              onInput={(event) => setForm("name", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("schedule.dialog.prompt.label")}</Field.Label>
            <Textarea
              class="w-full"
              value={form.prompt}
              placeholder={language.t("schedule.dialog.prompt.placeholder")}
              disabled={form.busy}
              onInput={(event) => setForm("prompt", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("schedule.dialog.project.label")}</Field.Label>
            <div class="flex w-full items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-14-regular text-text-strong">
                {form.directory ? getFilename(form.directory) : language.t("schedule.dialog.project.placeholder")}
              </span>
              <Button type="button" variant="ghost" disabled={form.busy} onClick={openPicker}>
                {language.t("schedule.dialog.project.change")}
              </Button>
            </div>
          </Field>

          <Show when={agents().length > 0}>
            <Field>
              <Field.Label>{language.t("schedule.dialog.agent.label")}</Field.Label>
              <SegmentedControl
                class="flex flex-wrap gap-1"
                value={form.agentId ?? null}
                disabled={form.busy}
                onChange={(value) => setForm("agentId", value ?? undefined)}
              >
                <For each={agents()}>
                  {(agent) => <SegmentedControlItem value={agent.name}>{agent.name}</SegmentedControlItem>}
                </For>
              </SegmentedControl>
            </Field>
          </Show>

          <Field>
            <Field.Label>{language.t("schedule.dialog.model.label")}</Field.Label>
            <Select<ModelOption>
              class="w-full"
              disabled={form.busy}
              options={allModelOptions()}
              current={currentModelOption()}
              groupBy={(option) => option.group}
              value={(option) => option.key}
              label={(option) => option.name}
              onSelect={(option) => setForm("modelKey", option?.key ?? DEFAULT_MODEL_KEY)}
            />
          </Field>

          <SegmentedControl
            class="flex flex-wrap gap-1"
            value={form.kind}
            disabled={form.busy}
            onChange={(value) => {
              if (!value) return
              setForm("kind", value as Schedule.Kind)
              if (value === "once" && !form.onceValue) setForm("onceValue", defaultOnceValue(form.timezone))
            }}
          >
            <SegmentedControlItem value="once">{language.t("schedule.dialog.frequency.once")}</SegmentedControlItem>
            <SegmentedControlItem value="daily">{language.t("schedule.dialog.frequency.daily")}</SegmentedControlItem>
            <SegmentedControlItem value="weekly">{language.t("schedule.dialog.frequency.weekly")}</SegmentedControlItem>
            <SegmentedControlItem value="cron">{language.t("schedule.dialog.frequency.cron")}</SegmentedControlItem>
          </SegmentedControl>

          <Show when={form.kind === "once"}>
            <Field>
              <Field.Label>{language.t("schedule.dialog.field.datetime")}</Field.Label>
              <TextInput
                type="datetime-local"
                class="w-full"
                value={form.onceValue}
                disabled={form.busy}
                onInput={(event) => setForm("onceValue", event.currentTarget.value)}
              />
            </Field>
          </Show>

          <Show when={form.kind === "daily" || form.kind === "weekly"}>
            <div class="flex w-full min-w-0 flex-col gap-2">
              <Field>
                <Field.Label>{language.t("schedule.dialog.field.time")}</Field.Label>
                <TextInput
                  type="time"
                  class="w-full"
                  value={form.timeValue}
                  disabled={form.busy}
                  onInput={(event) => setForm("timeValue", event.currentTarget.value)}
                />
              </Field>
              <Show when={form.kind === "weekly"}>
                <div class="flex items-center gap-1">
                  <For each={WEEKDAYS}>
                    {(day) => {
                      const label = weekdayLabels([day], language.intl(), form.timezone)[0] ?? ""
                      return (
                        <button
                          type="button"
                          aria-label={label}
                          aria-pressed={form.days.includes(day)}
                          disabled={form.busy}
                          onClick={() => toggleDay(day)}
                          class="flex size-7 items-center justify-center rounded-md text-12-medium hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus"
                          classList={{ "bg-v2-background-bg-contrast text-v2-text-text-contrast": form.days.includes(day) }}
                        >
                          {label.charAt(0)}
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={form.kind === "cron"}>
            <Field>
              <Field.Label>{language.t("schedule.dialog.cron.label")}</Field.Label>
              <TextInput
                class="w-full font-mono"
                value={form.cronExpr}
                placeholder={language.t("schedule.dialog.cron.placeholder")}
                disabled={form.busy}
                onInput={(event) => setForm("cronExpr", event.currentTarget.value)}
              />
              <span class="text-12-medium text-text-weak">{language.t("schedule.dialog.cron.hint")}</span>
            </Field>
          </Show>

          <Show when={nextRun()}>
            <div class="text-12-medium text-text-weak">
              {language.t("schedule.dialog.nextRun.label")}: {nextRun()}
            </div>
          </Show>

          <Show when={form.error}>
            <span class="block text-12-medium text-icon-critical-base">{form.error}</span>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="button" variant="contrast" disabled={form.busy || !form.directory} onClick={submit}>
          {props.task ? language.t("common.save") : language.t("schedule.dialog.submit.add")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
