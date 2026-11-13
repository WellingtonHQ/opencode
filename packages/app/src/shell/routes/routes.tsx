import { Route, useParams } from "@solidjs/router"
import { createMemo, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { Home } from "@/home/route"
import { ServerProvider } from "@/runtime/server/current"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { isServerUnauthorized } from "@/runtime/server/health-machine"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { LayoutProvider, useLayout } from "@/shell/state/layout"
import { SettingsSurfaceProvider, useSettingsSurface } from "@/settings/surface"
import { useTabs } from "@/shell/tabs/tabs"
import { AutoApproveSync } from "@/runtime/server/auto-approve"
import { ServerSignedOutPanel } from "@/session/server-unavailable-panel"
import Shell from "@/shell/shell"
import { requireServerKey } from "./session"
import { PluginAttachment } from "@/runtime/plugin/root"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

const DraftRoute = lazy(() => import("@/new-session/route").then((module) => ({ default: module.DraftRoute })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const ConnectServerScreen = lazy(() =>
  import("@/servers/connect/screen").then((module) => ({ default: module.ConnectServerScreen })),
)

// The dev server and Beta only. Both are fixed at build time, so other builds, prod included, drop the import and never
// contain the lab, its stories or knobs. Beta loads it as its own chunk, only when /components opens.
const ComponentsLab =
  import.meta.env.DEV || import.meta.env.VITE_OPENCODE_CHANNEL === "beta"
    ? lazy(() => import("@/components-lab/lab"))
    : undefined

const TargetSessionRouteContent = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.TargetSessionRouteContent })),
)

export function preloadRoute(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]

  if (pathname === "/new-session") return DraftRoute.preload().then(() => undefined)

  if (pathname === "/settings") return SettingsScreen.preload().then(() => undefined)

  if (/^\/server\/[^/]+\/session\/[^/]+$/.test(pathname))
    return TargetSessionRouteContent.preload().then(() => undefined)

  return Promise.resolve()
}

export function AppRoutes() {
  return (
    <Route component={AppLayout}>
      <Route path="/" component={Home} />
      <Route path="/settings" component={SettingsScreen} />
      <Route
        path="/server/:serverKey/session/:id"
        component={() => (
          <SessionRouteFrame>
            <Suspense
              fallback={
                <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                  <SessionPanelFrame raised />
                </div>
              }
            >
              <TargetServerRoute>
                <TargetSessionRouteContent />
              </TargetServerRoute>
            </Suspense>
          </SessionRouteFrame>
        )}
      />
      <Route path="/new-session" component={DraftRoute} />
      {ComponentsLab && <Route path="/components" component={ComponentsLab} />}
    </Route>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string }>()
  const global = useGlobal()

  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(params.serverKey)),
  )

  return (
    <Show when={connection()} keyed>
      {(connection) => (
        <ServerProvider
          conn={connection}
          signedOut={
            <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
              <SessionPanelFrame raised>
                <ServerSignedOutPanel conn={connection} />
              </SessionPanelFrame>
            </div>
          }
        >
          {props.children}
        </ServerProvider>
      )}
    </Show>
  )
}

function AppLayout(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()

  // A lone server that rejects our credentials (e.g. the web app before pairing) has nothing else to show.
  const signedOut = () => {
    const only = servers.list.length === 1 ? servers.list[0] : undefined

    if (only?.type !== "http") return

    return isServerUnauthorized(global.servers.health[ServerConnection.key(only)]) ? only : undefined
  }

  return (
    <Show when={servers.list.length > 0 && !signedOut()} fallback={<ConnectServerScreen url={signedOut()?.http.url} />}>
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <PluginAttachment>
            <AppShell>{props.children}</AppShell>
          </PluginAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    </Show>
  )
}

function AppShell(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()
  const layout = useLayout()
  const tabs = useTabs()
  const settings = useSettingsSurface()

  const currentServer = createMemo(() => {
    const current = layout.route()
    const route = current.type === "settings" ? settings.route() : current
    const key =
      route.type === "session"
        ? route.server
        : route.type === "draft"
          ? tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)?.server
          : layout.home.selection().server
    const selected = global.servers.list().find((conn) => ServerConnection.key(conn) === key)

    return selected ?? servers.list[0]
  })

  return (
    <>
      <AutoApproveSync server={currentServer} />
      <Shell>{props.children}</Shell>
    </>
  )
}
