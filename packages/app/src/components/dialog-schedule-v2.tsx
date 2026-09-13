import type { ScheduleTaskWithLatest } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { ModelKey, ModelSelection } from "@/context/local"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { ModelSelectorPopoverV2 } from "./dialog-select-model"
import {
  scheduleSpecToFormValues,
  validateScheduleForm,
  type ScheduleFormErrorKey,
  type ScheduleFormKind,
  type ScheduleFormValues,
} from "@/utils/schedule-spec"

const WEEK_DAY_ANCHOR = new Date(2024, 11, 1) // Sunday
const FORM_KINDS: ScheduleFormKind[] = ["one_shot", "daily", "weekly", "cron"]
type Language = ReturnType<typeof useLanguage>

type DialogScheduleStore = ScheduleFormValues & { saving: boolean; errorKey?: ScheduleFormErrorKey }

export function DialogScheduleV2(props: {
  editing?: ScheduleTaskWithLatest
  onDone?: () => void
}) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const dialog = useDialog()
  const models = useModels()
  const [store, setStore] = createStore<DialogScheduleStore>(initialValues(props.editing))

  // Feeds the shared model popover without touching the composer's own selection:
  // `current` and `set` read/write this dialog's store, everything else delegates to the catalog.
  const modelSelection: ModelSelection = {
    ready: models.ready,
    list: models.list,
    recent: () => models.recent.list().map(models.find).filter(Boolean),
    visible: models.visible,
    setVisibility: models.setVisibility,
    current: () => (store.model ? models.find(store.model) : undefined),
    cycle: () => {},
    set(item?: ModelKey) {
      if (!item) return
      setStore("model", { providerID: item.providerID, modelID: item.modelID })
    },
    variant: {
      configured: () => undefined,
      selected: () => undefined,
      current: () => undefined,
      list: () => [],
      set: () => {},
      cycle: () => {},
    },
  }

  const modelLabel = createMemo(() => {
    if (!store.model) return language.t("common.default")
    const item = models.find(store.model)
    // A saved selection can outlive a disconnected provider; show its key rather than "Default".
    return item ? item.name : `${store.model.providerID}/${store.model.modelID}`
  })

  const dayLabels = createMemo(() => {
    const format = new Intl.DateTimeFormat(language.intl(), { weekday: "short" })
    return Array.from({ length: 7 }, (_, index) => format.format(new Date(WEEK_DAY_ANCHOR.getTime() + index * 86_400_000)))
  })

  function setKind(value: string | null) {
    if (value !== "one_shot" && value !== "daily" && value !== "weekly" && value !== "cron") return
    setStore("kind", value)
    setStore("errorKey", undefined)
  }

  const errorMessage = () => {
    if (!store.errorKey) return ""
    switch (store.errorKey) {
      case "nameRequired":
        return language.t("schedule.error.nameRequired")
      case "promptRequired":
        return language.t("schedule.error.promptRequired")
      case "timeRequired":
        return store.kind === "one_shot" ? language.t("schedule.error.oneShotTimeRequired") : language.t("schedule.error.timeRequired")
      case "daysRequired":
        return language.t("schedule.error.daysRequired")
      case "pastOneShot":
        return language.t("schedule.error.pastOneShot")
      case "cronInvalid":
        return language.t("schedule.error.cronInvalid")
    }
    return ""
  }

  const submit = async () => {
    const result = validateScheduleForm(store, Date.now())
    if (!result.ok) {
      setStore("errorKey", result.error)
      return
    }
    setStore("saving", true)
    setStore("errorKey", undefined)
    const payload = {
      name: store.name.trim(),
      promptText: store.promptText.trim(),
      spec: result.spec,
      ...(store.directory.trim() ? { directory: store.directory.trim() } : {}),
      ...(store.model ? { model: { id: store.model.modelID, providerID: store.model.providerID } } : {}),
    }
    try {
      if (props.editing) {
        await sdk().client.v2.schedule.update({ id: props.editing.id, scheduleUpdate: payload })
      } else {
        const created = await sdk().client.v2.schedule.create({ scheduleCreate: payload })
        const task = created.data?.data
        if (!task) throw new Error("empty response from server")
      }
      props.onDone?.()
      dialog.close()
    } catch (error) {
      setStore("saving", false)
      showToast(failure(error, language))
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>
            {props.editing ? language.t("dialog.schedule.title.edit") : language.t("dialog.schedule.title.create")}
          </DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(640px,calc(100vh-180px))] w-full flex-col gap-6 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("dialog.schedule.name.label")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={store.name}
              placeholder={language.t("dialog.schedule.name.placeholder")}
              onInput={(event) => setStore("name", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("dialog.schedule.prompt.label")}</Field.Label>
            <TextareaV2
              class="!w-full"
              rows={3}
              value={store.promptText}
              placeholder={language.t("dialog.schedule.prompt.placeholder")}
              onInput={(event) => setStore("promptText", event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{language.t("dialog.schedule.directory.label")}</Field.Label>
            <TextInputV2 class="!w-full" value={store.directory} onInput={(event) => setStore("directory", event.currentTarget.value)} />
          </Field>

          <Field>
            <Field.Label>{language.t("dialog.schedule.model.label")}</Field.Label>
            <ModelSelectorPopoverV2
              model={modelSelection}
              trigger={(triggerProps) => (
                <ButtonV2 {...triggerProps} type="button" variant="ghost-muted" size="normal" class="!w-full justify-start gap-1">
                  <span class="min-w-0 flex-1 truncate text-left leading-5" aria-label={language.t("dialog.schedule.model.label")}>
                    {modelLabel()}
                  </span>
                  <Icon name="chevron-down" size="small" class="shrink-0 opacity-60" />
                </ButtonV2>
              )}
            />
          </Field>

          <div class="flex w-full flex-col gap-3">
            <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
              {language.t("dialog.schedule.kind.label")}
            </div>
            <SegmentedControlV2 value={store.kind} onChange={setKind}>
              <For each={FORM_KINDS}>
                {(kind) => (
                  <SegmentedControlItemV2 value={kind}>{kindLabel(kind, language)}</SegmentedControlItemV2>
                )}
              </For>
            </SegmentedControlV2>

            <Show when={store.kind === "one_shot"}>
              <div class="flex w-full gap-3">
                <Field class="w-[48%]">
                  <Field.Label>{language.t("dialog.schedule.date.label")}</Field.Label>
                  <TextInputV2 type="date" value={store.dateStr} onInput={(event) => setStore("dateStr", event.currentTarget.value)} />
                </Field>
                <Field class="w-[48%]">
                  <Field.Label>{language.t("dialog.schedule.time.label")}</Field.Label>
                  <TextInputV2 type="time" value={store.timeHhMm} onInput={(event) => setStore("timeHhMm", event.currentTarget.value)} />
                </Field>
              </div>
            </Show>
            <Show when={store.kind === "daily" || store.kind === "weekly"}>
              <Field class="w-40">
                <Field.Label>{language.t("dialog.schedule.time.label")}</Field.Label>
                <TextInputV2 type="time" value={store.timeHhMm} onInput={(event) => setStore("timeHhMm", event.currentTarget.value)} />
              </Field>
            </Show>
            <Show when={store.kind === "weekly"}>
              <div class="flex w-full flex-col gap-2">
                <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
                  {language.t("dialog.schedule.days.label")}
                </div>
                <div class="-ml-1 flex gap-1.5">
                  <For each={dayLabels()}>
                    {(label, index) => (
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={store.weekDays[index()] ?? false}
                        title={label}
                        class="flex h-8 min-w-9 items-center justify-center rounded-[10px] px-2 text-[11px] font-[440] uppercase outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus"
                        classList={{
                          "bg-v2-overlay-simple-overlay-hover [box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]":
                            store.weekDays[index()] ?? false,
                        }}
                        onClick={() => setStore("weekDays", index(), !(store.weekDays[index()] ?? false))}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={store.kind === "cron"}>
              <TextInputV2
                class="!w-full font-mono"
                aria-label={language.t("schedule.form.kind.cron")}
                value={store.cronExpr}
                placeholder={language.t("dialog.schedule.cron.placeholder")}
                spellcheck={false}
                onInput={(event) => setStore("cronExpr", event.currentTarget.value)}
              />
            </Show>
          </div>

          <Show when={store.errorKey}>
            <p role="alert" class="-mt-2 text-[13px] font-[440] leading-none tracking-[-0.04px]">
              {errorMessage()}
            </p>
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={store.saving} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={store.saving}>
            {store.saving
              ? language.t("common.saving")
              : props.editing
                ? language.t("common.save")
                : language.t("dialog.schedule.confirm.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function initialValues(editing: ScheduleTaskWithLatest | undefined): DialogScheduleStore {
  const base = editing ? scheduleSpecToFormValues(editing.spec) : { kind: "one_shot" as const, dateStr: "", timeHhMm: "09:00", weekDays: [] as boolean[], cronExpr: "" }
  return {
    name: editing?.name ?? "",
    promptText: editing?.promptText ?? "",
    directory: editing?.directory ?? "",
    model: editing?.model ? { providerID: editing.model.providerID, modelID: editing.model.id } : undefined,
    ...base,
    timeHhMm: base.timeHhMm || "09:00",
    weekDays: base.weekDays.length ? base.weekDays : Array.from({ length: 7 }, () => false),
    saving: false,
  }
}

function kindLabel(kind: ScheduleFormKind, language: Language) {
  if (kind === "one_shot") return language.t("schedule.form.kind.oneShot")
  if (kind === "daily") return language.t("schedule.form.kind.daily")
  if (kind === "weekly") return language.t("schedule.form.kind.weekly")
  return language.t("schedule.form.kind.cron")
}

function failure(error: unknown, language: Language) {
  const message = error instanceof Error ? error.message : ""
  return { title: language.t("common.requestFailed"), ...(message ? { description: message } : {}) }
}
