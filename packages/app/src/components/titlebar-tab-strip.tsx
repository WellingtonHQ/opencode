import { createEffect, createMemo, createResource, createRoot, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { displayName } from "@/pages/layout/helpers"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { showToast } from "@/utils/toast"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { adjacentTabKey, mergeVisibleTabOrder } from "./titlebar-tab-order"
import type { Session } from "@opencode-ai/sdk/v2"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  session: () => Session | undefined
  fallbackTitle?: string
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        fallbackTitle={props.fallbackTitle}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        forceTruncate={props.forceTruncate}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  forceTruncate: boolean
  serverCtx: () => ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  const visible = createMemo(() => !!session() || missingSession() || !!persisted()?.title)
  let prefetched = false

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx()
    if (!value || !ctx) return

    ctx.sync.session.remember({ ...value, title })
    try {
      await ctx.sdk.api.session.rename({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx()
      if (current && currentCtx) currentCtx.sync.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))

  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        forceTruncate={props.forceTruncate}
        session={session}
        fallbackTitle={persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined)}
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex w-56 min-w-7 max-w-56 flex-shrink"
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  const mobilePortrait = createMediaQuery("(max-width: 767px) and (orientation: portrait)")
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const visibleTabs = createMemo(() => props.tabs.filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))
  const visibleTabIds = () => visibleTabs().map(tabKey)

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1) {
    const current = props.currentTab()
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset)
    const next = props.tabs.find((tab) => tabKey(tab) === key)
    if (next) props.onNavigate(next)
  }

  function refreshOverflow() {
    if (!scrollRef) return
    props.onOverflowChange(scrollRef.scrollWidth > scrollRef.clientWidth)
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    visibleTabIds()
    refreshOverflow()
  })

  return (
    <>
      <Show when={mobilePortrait() && props.tabs.length > 0}>
        <MobileTitlebarTabSwitcher tabs={props.tabs} currentTab={props.currentTab} onNavigate={props.onNavigate} />
      </Show>
      <div data-slot="titlebar-tabs" classList={{ "relative min-w-0": true, hidden: mobilePortrait() }}>
        <div
          data-slot="titlebar-tabs-scroll"
          class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
          ref={scrollRef}
        >
          <DragDropProvider
            sensors={[
              PointerSensor.configure({
                activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                preventActivation: (event) =>
                  !canStartTabDrag(event.pointerType) ||
                  isTabCloseTarget(event.target) ||
                  (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
              }),
            ]}
            modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragStart={(event) => {
              const source = event.operation.source
              if (!source) return
              const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
              if (!tab) return
              const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
              props.onNavigate(tab, tabEl ?? undefined)
            }}
            onDragEnd={(event) => {
              const current = visibleTabIds()
              const source = event.operation.source
              if (event.canceled || !isSortable(source)) return

              const { initialIndex, index } = source
              if (initialIndex !== index) {
                props.onReorder(
                  mergeVisibleTabOrder(
                    props.tabs.map(tabKey),
                    current,
                    arrayMove(current, source.initialIndex, source.index),
                  ),
                )
              }
            }}
          >
            <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
              <For each={props.tabs}>
                {(tab) => {
                  const id = tabKey(tab)
                  let ref!: HTMLDivElement
                  const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
                  useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))
                  const serverCtx = createMemo(() => {
                    if (tab.type !== "session") return
                    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                    if (conn) return global.ensureServerCtx(conn)
                  })

                  if (tab.type === "session") {
                    return (
                      <SessionTabEntry
                        tab={tab}
                        id={id}
                        index={visibleIndex}
                        active={() => props.currentTab() === tab}
                        forceTruncate={props.forceTruncate}
                        serverCtx={serverCtx}
                        onVisibleChange={(visible) => setVisibility(id, visible)}
                        onNavigate={(element) => {
                          ref = element
                          props.onNavigate(tab, element)
                        }}
                        onClose={() => props.onClose(tab)}
                      />
                    )
                  }

                  return (
                    <DraftTabSlot
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      title={language.t("command.session.new")}
                      onNavigate={(element) => {
                        ref = element
                        props.onNavigate(tab, element)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }}
              </For>
            </div>
          </DragDropProvider>
        </div>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </div>
    </>
  )
}

function MobileTitlebarTabSwitcher(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const currentKey = createMemo(() => {
    const current = props.currentTab()
    return current ? tabKey(current) : ""
  })
  const title = createMemo(() => {
    const current = props.currentTab()
    if (!current) return language.t("home.sessions.search.sessions")
    if (current.type === "draft") return language.t("command.session.new")
    return sessionTitle(tabs.info[tabKey(current)]?.title) || language.t("session.tab.unknown")
  })

  return (
    <MenuV2 modal={false} gutter={4} placement="bottom-start">
      <MenuV2.Trigger
        as={ButtonV2}
        type="button"
        variant="ghost-muted"
        size="normal"
        class="min-w-0 max-w-[44vw] shrink px-2 [app-region:no-drag]"
        icon="menu"
        aria-label={language.t("home.sessions.search.sessions")}
      >
        <span class="min-w-0 truncate" dir="auto">
          {title()}
        </span>
        <IconV2 name="chevron-down" size="small" class="shrink-0" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="mobile-titlebar-tab-menu">
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("home.sessions.search.sessions")}</MenuV2.GroupLabel>
            <MenuV2.RadioGroup
              value={currentKey()}
              onChange={(key) => {
                const tab = props.tabs.find((item) => tabKey(item) === key)
                if (tab) props.onNavigate(tab)
              }}
            >
              <For each={props.tabs}>{(tab) => <MobileTitlebarTabOption tab={tab} />}</For>
            </MenuV2.RadioGroup>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

function MobileTitlebarTabOption(props: { tab: Tab }) {
  const tabs = useTabs()
  const global = useGlobal()
  const language = useLanguage()
  const key = () => tabKey(props.tab)
  const info = createMemo(() => (props.tab.type === "session" ? tabs.info[key()] : undefined))
  const directory = createMemo(() => (props.tab.type === "draft" ? props.tab.directory : info()?.directory))
  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === props.tab.server),
  )
  const project = createMemo(() => {
    const dir = directory()
    const conn = connection()
    if (!dir || !conn) return
    const normalized = pathKey(dir)
    return global
      .ensureServerCtx(conn)
      .projects.list()
      .find(
        (item) =>
          pathKey(item.worktree) === normalized || item.sandboxes?.some((sandbox) => pathKey(sandbox) === normalized),
      )
  })
  const title = () => {
    if (props.tab.type === "draft") return language.t("command.session.new")
    return sessionTitle(info()?.title) || language.t("session.tab.unknown")
  }
  const projectLabel = createMemo(() => {
    const current = project()
    if (current) return displayName(current)
    const dir = directory()
    if (dir) return displayName({ worktree: dir })
  })
  const serverLabel = createMemo(() => {
    if (global.servers.list().length <= 1) return
    const conn = connection()
    return conn ? serverName(conn) : undefined
  })
  const contextLabel = createMemo(() =>
    [projectLabel(), serverLabel()].filter((value): value is string => !!value).join(" · "),
  )
  const avatar = () => {
    if (props.tab.type === "draft") return <IconV2 name="edit" size="small" />
    const dir = directory()
    if (!dir) return <span class="block size-4 rounded-[3px] border border-v2-border-border-muted" aria-hidden="true" />
    return (
      <SessionTabAvatar
        project={project()}
        directory={dir}
        sessionId={props.tab.sessionId}
        server={props.tab.server}
        revealProjectOnHover={false}
      />
    )
  }

  return (
    <MenuV2.RadioItem value={key()} class="mobile-titlebar-tab-option">
      <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {avatar()}
      </span>
      <span class="min-w-0 flex-1 truncate" dir="auto">
        {title()}
      </span>
      <Show when={contextLabel()}>
        {(value) => (
          <span class="min-w-0 max-w-[35%] truncate text-v2-text-text-muted [font-weight:440]" dir="auto">
            {value()}
          </span>
        )}
      </Show>
    </MenuV2.RadioItem>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number < 1 || number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
