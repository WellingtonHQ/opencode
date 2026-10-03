import type { Project } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { For, createMemo, type Accessor, type ComponentProps, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant } from "@/context/layout"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { pathKey } from "@/utils/path-key"

const DEFAULT_DIRECTORY_VALUE = "__default__"

type ProjectSelectorTrigger = (props: Omit<ComponentProps<typeof MenuV2.Trigger>, "as" | "ref">) => JSX.Element

export function ProjectSelectorPopoverV2(props: {
  projects: Accessor<Project[]>
  current: Accessor<string | undefined>
  onSelect: (directory: string) => void
  trigger: ProjectSelectorTrigger
}) {
  const language = useLanguage()
  const value = createMemo(() => {
    const key = pathKey(props.current() ?? "")
    if (!key) return DEFAULT_DIRECTORY_VALUE
    return props.projects().find((project) => pathKey(project.worktree) === key || project.sandboxes?.some((sandbox) => pathKey(sandbox) === key))?.worktree
  })
  const sortedProjects = createMemo(() => [...props.projects()].sort((a, b) => displayName(a).localeCompare(displayName(b))))

  return (
    <MenuV2 modal={false} placement="top-start" gutter={6}>
      <MenuV2.Trigger as={props.trigger} />
      <MenuV2.Portal>
        <MenuV2.Content class="w-[284px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none">
          <MenuV2.RadioGroup value={value()}>
            <MenuV2.RadioItem
              value={DEFAULT_DIRECTORY_VALUE}
              class="scroll-my-6 w-full"
              onSelect={() => props.onSelect("")}
            >
              <Icon name="folder" size="normal" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("common.default")}</span>
            </MenuV2.RadioItem>
            <For each={sortedProjects()}>
              {(project) => (
                <MenuV2.RadioItem
                  value={project.worktree}
                  class="scroll-my-6 w-full"
                  onSelect={() => props.onSelect(project.worktree)}
                >
                  <ProjectAvatar
                    fallback={displayName(project)}
                    src={getProjectAvatarSource(project.id, project.icon)}
                    variant={getProjectAvatarVariant(project.icon?.color)}
                  />
                  <span class="min-w-0 flex-1 truncate leading-5">{displayName(project)}</span>
                </MenuV2.RadioItem>
              )}
            </For>
          </MenuV2.RadioGroup>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
