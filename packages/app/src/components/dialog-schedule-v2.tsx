import { For, Show, createMemo, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Schedule } from "@opencode-ai/schema/schedule"
import { getFilename } from "@opencode-ai/core/util/path"
import { formatClock, isValidCronExpression, nextRunAfter, scheduleApi, weekdayLabels, formatDateTime } from "@/utils/schedule"
import { createQuery } from "@tanstack/solid-query"
import { formatServerError } from "@/utils/server-errors"
import { pathKey } from "@/utils/path-key"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServerSDK } from "@/context/server-sdk"

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]

type ModelOption = { key: string; name: string; group: string }

// Non-empty sentinel for the "no override" option: SelectV2/Kobalte cannot select an option whose value is "".
const DEFAULT_MODEL_KEY = "__default_model__"

function toDatetimeLocalValue(value: number): string {
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultOnceValue(): string {
  return toDatetimeLocalValue(Date.now() + 60 * 60 * 1000)
}

function readTime(value: string): { hour: number; minute: number } | undefined {
  const [rawHour, rawMinute] = value.split(":")
  const hour = Number(rawHour)
  const minute = Number(rawMinute ?? "0")
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return { hour, minute }
}

export const DialogScheduleV2: Component<{ task?: Schedule.Info; defaultDirectory?: string }> = (props) => {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const sync = useServerSync()
  const pickDirectory = useDirectoryPicker()

  const spec = props.task?.spec
  const [form, setForm] = createStore({
    name: props.task?.name ?? "",
    prompt: props.task?.prompt ?? "",
    directory: props.defaultDirectory || (props.task ? props.task.directory : "") || "",
    agentId: props.task?.agentId as string | undefined,
    modelKey: props.task?.model ? `${String(props.task.model.providerID)}:${props.task.model.id}` : DEFAULT_MODEL_KEY,
    kind: spec ? spec.kind : "daily",
    onceValue: spec && spec.kind === "once" ? toDatetimeLocalValue(spec.atMs) : defaultOnceValue(),
    timeValue: spec && (spec.kind === "daily" || spec.kind === "weekly") ? formatClock(spec.hour, spec.minute) : "09:00",
    days: spec && spec.kind === "weekly" ? [...spec.days] : [1, 2, 3, 4, 5],
    cronExpr: spec && spec.kind === "cron" ? spec.expr : "",
    error: undefined as string | undefined,
    busy: false,
  })

  const agentQuery = createQuery(
    () => {
      const options = sync().queryOptions.agents(pathKey(form.directory || "/"))
      return form.directory ? options : { ...options, enabled: false }
    },
  )
  const agents = createMemo(
    () => (agentQuery.data ?? []).filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => agent.name),
  )

  const providerQuery = createQuery(
    () => {
      const options = sync().queryOptions.providers(pathKey(form.directory || "/"))
      return form.directory ? options : { ...options, enabled: false }
    },
  )
  const modelOptions = createMemo<ModelOption[]>(() => {
    const data = providerQuery.data
    if (!data) return []
    const options = data.connected.flatMap((providerID) => {
      const provider = data.all.get(providerID)
      if (!provider) return []
      return Object.values(provider.models).map((model) => ({ key: `${provider.id}:${model.id}`, name: model.name, group: provider.name }))
    })
    options.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    return options
  })
  const allModelOptions = createMemo<ModelOption[]>(() => [
    { key: DEFAULT_MODEL_KEY, name: "Use default model", group: "" },
    ...modelOptions(),
  ])
  const currentModelOption = createMemo(() => {
    const options = allModelOptions()
    return options.find((option) => option.key === form.modelKey) ?? options[0]
  })

  // null clears the stored override; a saved model that vanished from the catalog also resolves to null.
  function resolveModel(): Model.Ref | null {
    const key = form.modelKey
    if (!key || key === DEFAULT_MODEL_KEY) return null
    if (providerQuery.data && !modelOptions().some((option) => option.key === key)) return null
    const separator = key.indexOf(":")
    return { providerID: key.slice(0, separator), id: key.slice(separator + 1) } as Model.Ref
  }

  function buildSpec(): { spec?: Schedule.Spec; error?: string } {
    const now = Date.now()
    switch (form.kind) {
      case "once": {
        if (!form.onceValue) return { error: language.t("schedule.dialog.error.past") }
        const at = new Date(form.onceValue).getTime()
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
    return {}
  }

  const nextRun = createMemo(() => {
    const built = buildSpec()
    if (!built.spec) return ""
    const at = nextRunAfter(built.spec, Date.now())
    return formatDateTime(at, language.intl())
  })

  function toggleDay(day: number) {
    const days = form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day]
    setForm("days", days)
  }

  function openPicker() {
    pickDirectory({
      server: serverSDK().server,
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
    // Agent IDs are branded on the wire but keyed by plain names everywhere else.
    const baseInput = {
      name: form.name.trim() || undefined,
      prompt,
      spec: built.spec,
      agentId: form.agentId ? (form.agentId as Agent.ID) : undefined,
      directory: form.directory as AbsolutePath,
    }
    // An unset model is omitted on create but sent as null on update so a stored override clears.
    const model = resolveModel()
    const action = props.task
      ? scheduleApi(serverSDK().server.http).update(props.task.id, { ...baseInput, model })
      : scheduleApi(serverSDK().server.http).create(model ? { ...baseInput, model } : baseInput)
    void action
      .then(() => dialog.close())
      .catch((err: unknown) => setForm("error", formatServerError(err, language.t)))
      .finally(() => setForm("busy", false))
  }

  const title = () => (props.task ? language.t("schedule.dialog.edit.title") : language.t("schedule.dialog.add.title"))

  return (
    <Dialog fit>
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <Field>
            <Field.Label>{language.t("schedule.dialog.name.label")}</Field.Label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={form.name}
              placeholder={language.t("schedule.dialog.name.placeholder")}
              disabled={form.busy}
              autofocus
              onInput={(event) => setForm("name", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("schedule.dialog.prompt.label")}</Field.Label>
            <TextareaV2
              class="!w-full self-stretch"
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
              <ButtonV2 type="button" variant="ghost" disabled={form.busy} onClick={openPicker}>
                {language.t("schedule.dialog.project.change")}
              </ButtonV2>
            </div>
          </Field>

          <Show when={agents().length > 0}>
            <Field>
              <Field.Label>{language.t("schedule.dialog.agent.label")}</Field.Label>
              <SegmentedControlV2 value={form.agentId ?? null} disabled={form.busy} onChange={(value) => setForm("agentId", value ?? undefined)}>
                <For each={agents()}>
                  {(name) => (
                    <SegmentedControlItemV2 value={name}>{name}</SegmentedControlItemV2>
                  )}
                </For>
              </SegmentedControlV2>
            </Field>
          </Show>

          <Field>
            <Field.Label>{language.t("schedule.dialog.model.label")}</Field.Label>
            <SelectV2<ModelOption>
              appearance="large"
              disabled={form.busy}
              options={allModelOptions()}
              current={currentModelOption()}
              groupBy={(option) => option.group}
              value={(option) => option.key}
              label={(option) => option.name}
              onSelect={(option) => setForm("modelKey", option ? option.key : DEFAULT_MODEL_KEY)}
            />
          </Field>

          <SegmentedControlV2 value={form.kind} disabled={form.busy} onChange={(value) => {
            if (!value) return
            setForm("kind", value as Schedule.Kind)
            if (value === "once" && !form.onceValue) setForm("onceValue", defaultOnceValue())
          }}>
            <SegmentedControlItemV2 value="once">{language.t("schedule.dialog.frequency.once")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="daily">{language.t("schedule.dialog.frequency.daily")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="weekly">{language.t("schedule.dialog.frequency.weekly")}</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="cron">{language.t("schedule.dialog.frequency.cron")}</SegmentedControlItemV2>
          </SegmentedControlV2>

          <Show when={form.kind === "once"}>
            <Field>
              <Field.Label>{language.t("schedule.dialog.field.datetime")}</Field.Label>
              <TextInputV2
                type="datetime-local"
                appearance="large"
                class="!w-full self-stretch"
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
                <TextInputV2
                  type="time"
                  appearance="large"
                  class="!w-full self-stretch"
                  value={form.timeValue}
                  disabled={form.busy}
                  onInput={(event) => setForm("timeValue", event.currentTarget.value)}
                />
              </Field>
              <Show when={form.kind === "weekly"}>
                <div class="flex items-center gap-1">
                  <For each={WEEKDAYS}>
                    {(day) => {
                      const label = weekdayLabels([day], language.intl())[0] ?? ""
                      return (
                        <button
                          type="button"
                          aria-label={label}
                          aria-pressed={form.days.includes(day)}
                          disabled={form.busy}
                          onClick={() => toggleDay(day)}
                          class="h-7 w-7 rounded-md text-12-medium hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus"
                          classList={{ "bg-surface-raised-base text-text-strong": form.days.includes(day) }}
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
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch font-mono"
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
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" disabled={form.busy || !form.directory} onClick={submit}>
          {props.task ? language.t("common.save") : language.t("schedule.dialog.submit.add")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
