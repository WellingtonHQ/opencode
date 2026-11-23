import { expect, story } from "../../stories/playwright/story"

story.describe("touch timeline", () => {
  story.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  story("shows each message's details without hover when enabled", async ({ mount, page }) => {
    const timeline = await mount("current-session-timeline-rows--agent-message-metadata", {
      args: { showMessageMetadata: true },
    })

    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true)

    const sonnet = timeline.locator('[data-timeline-part-id="msg_agent_metadata_sonnet:text:0"] [data-slot="text-part-meta"]')
    const nano = timeline.locator('[data-timeline-part-id="msg_agent_metadata_nano:text:0"] [data-slot="text-part-meta"]')
    await expect(sonnet).toBeVisible()
    await expect(sonnet).toContainText("Claude Sonnet 4")
    await expect(nano).toBeVisible()
    expect((await sonnet.textContent())?.split(" · ").at(-1)).not.toEqual(
      (await nano.textContent())?.split(" · ").at(-1),
    )
  })

  story("shows intermediate message details without hover even when the preference is off", async ({ mount }) => {
    const timeline = await mount("current-session-timeline-rows--agent-message-metadata", {
      args: { showMessageMetadata: false },
    })

    const sonnet = timeline.locator('[data-timeline-part-id="msg_agent_metadata_sonnet:text:0"]')

    await expect(sonnet.locator('[data-slot="text-part-copy-wrapper"]')).toBeVisible()
    await expect(sonnet.locator('[data-slot="text-part-meta"]')).toContainText("Claude Sonnet 4")
    // Only the turn's final part offers the copy control.
    await expect(sonnet.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(0)
  })

  story("keeps message actions and metadata visible without hover", async ({ mount, page }) => {
    const timeline = await mount("current-session-timeline-rows--response-speed")
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true)

    const menu = timeline.locator('[data-slot="user-message-menu"]')
    await expect(menu).toHaveCount(1)
    await expect(menu).toHaveCSS("opacity", "1")
    await expect(menu).toHaveCSS("pointer-events", "auto")
    await expect(menu.getByRole("button", { name: "More actions", exact: true })).toBeVisible()

    // Every text part keeps its footer row shown; only the turn's final part offers the copy control.
    const footers = timeline.locator('[data-slot="text-part-copy-wrapper"]')
    await expect(footers).toHaveCount(2)
    for (const footer of await footers.all()) {
      await expect(footer).toHaveCSS("opacity", "1")
      await expect(footer).toHaveCSS("pointer-events", "auto")
    }
    await expect(timeline.getByRole("button", { name: "Copy response", exact: true })).toHaveCount(1)

    // Agent and model are omitted on mobile, leaving only the response duration.
    await expect(timeline.locator('[data-slot="user-message-meta-item"]')).toHaveCount(0)
    await expect(timeline.locator('[data-slot="user-message-pending"]')).toBeHidden()
    const responseMeta = timeline.locator('[data-timeline-part-id="msg_speed_reply:text:0"] [data-slot="text-part-meta"]')
    await expect(responseMeta).not.toBeEmpty()
    await expect(responseMeta).not.toContainText("Build")
    await expect(responseMeta).not.toContainText("Sonnet")
    await expect(responseMeta.locator('[data-slot="text-part-meta-speed"]')).toHaveText("·60.0 tok/s")
    await expect(responseMeta.locator('[data-slot="text-part-meta-speed"]')).toBeHidden()
    // The intermediate part shows its own model and timestamp.
    const inspectMeta = timeline.locator('[data-timeline-part-id="msg_speed_inspect:text:0"] [data-slot="text-part-meta"]')
    await expect(inspectMeta).toContainText("Claude Sonnet 4")
  })

  story("keeps the always-shown chevron clear of the prompt's text", async ({ mount }) => {
    const timeline = await mount("current-prompt-message--pending")
    await timeline.getByLabel("Delivery state").selectOption("delivered")
    const bubble = timeline.locator('[data-slot="user-message-text"]')
    await expect(bubble.getByRole("button", { name: "More actions", exact: true })).toBeVisible()

    // Every rendered line box of the prompt, against the chevron's box: none may overlap.
    const overlaps = await bubble.evaluate((element) => {
      const menu = element.querySelector('[data-slot="user-message-menu"]')
      const chevron = menu?.querySelector("button")?.getBoundingClientRect()

      if (!menu || !chevron) throw new Error("The chevron is not rendered")

      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (menu.contains(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })

      const lines: DOMRect[] = []

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(node)
        lines.push(...range.getClientRects())
      }

      if (lines.length === 0) throw new Error("The prompt has no text")

      return lines.filter(
        (line) =>
          line.width > 0 &&
          line.left < chevron.right &&
          line.right > chevron.left &&
          line.top < chevron.bottom &&
          line.bottom > chevron.top,
      ).length
    })

    expect(overlaps).toBe(0)
  })

  story("keeps shell copy visible without hover", async ({ mount }) => {
    const timeline = await mount("current-session-terminal-work--expanded-shell")
    const copy = timeline.locator('[data-slot="bash-copy"]')
    await expect(copy).toHaveCount(2)

    for (const button of await copy.all()) {
      await expect(button).toHaveCSS("opacity", "1")
      await expect(button).toHaveCSS("pointer-events", "auto")
    }
  })

  story("keeps error copy visible without hover", async ({ mount, page }) => {
    const errors = await mount("components-tool-error-card--all")
    const patch = errors.locator('[data-kind="tool-error-card"]').filter({ hasText: "Patch" })
    await patch.getByRole("button", { name: /Patch.*Verification failed/ }).tap()
    await page.touchscreen.tap(385, 800)
    const copy = patch.locator('[data-slot="tool-error-card-copy"]')
    await expect(copy).toHaveCSS("opacity", "1")
    await expect(copy).toHaveCSS("pointer-events", "auto")
  })

  story("keeps fenced code copy visible without hover", async ({ mount }) => {
    const markdown = await mount("components-markdown--complete-response")
    const code = markdown.locator('[data-component="markdown-code"]').filter({ hasText: "export const value = 42" })
    await expect(code).toHaveCount(1)
    const footer = code.locator('[data-slot="markdown-code-toolbar"]')
    await expect(footer.getByRole("button", { name: "Copy", exact: true })).toBeVisible()
    await expect(footer).toHaveCSS("opacity", "1")
    await expect(footer).toHaveCSS("pointer-events", "auto")
  })

  story("stops lighting a compaction divider once a tap closes it", async ({ mount }) => {
    const timeline = await mount("current-session-timeline-rows--compaction-and-continuation")
    const divider = timeline.locator('[data-slot="session-compaction-divider"]')
    const label = divider.locator('[data-slot="session-compaction-label"]')
    const rest = await label.evaluate((element) => getComputedStyle(element).color)

    await divider.tap()
    await expect(divider).toHaveAttribute("aria-expanded", "true")
    await expect(label).not.toHaveCSS("color", rest)

    // The tap leaves :hover on the divider, which must not keep the open colour.
    await divider.tap()
    await expect(divider).toHaveAttribute("aria-expanded", "false")
    await expect(label).toHaveCSS("color", rest)
  })
})

story("desktop user message actions still appear on hover and keyboard focus", async ({ mount, page }) => {
  const timeline = await mount("current-session-timeline-rows--conversation", { args: { scenario: "interruption" } })
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true)

  const actions = timeline.locator('[data-slot="user-message-menu"]')
  await expect(actions).toHaveCount(1)
  await expect(actions).toHaveCSS("opacity", "0")
  await expect(actions).toHaveCSS("pointer-events", "none")
  await actions.locator("..").hover()
  await expect(actions).toHaveCSS("opacity", "1")
  await expect(actions).toHaveCSS("pointer-events", "auto")
  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS("opacity", "0")
  await actions.getByRole("button", { name: "More actions", exact: true }).focus()
  await expect(actions).toHaveCSS("opacity", "1")
  await expect(actions).toHaveCSS("pointer-events", "auto")
})

story("desktop keeps only the latest response copy visible at rest", async ({ mount, page }) => {
  const timeline = await mount("current-session-timeline-rows--response-speed", { args: { steered: true } })
  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true)

  const latest = timeline.locator('[data-component="text-part"]').filter({ hasText: "The timeline checks passed." })

  const latestActions = latest.locator('[data-slot="text-part-copy-wrapper"]')

  const latestMeta = latestActions.locator('[data-slot="text-part-meta"]')

  await expect(latestActions).toHaveCSS("opacity", "1")
  await expect(latestActions.getByRole("button", { name: "Copy response", exact: true })).toBeVisible()
  await expect(latestMeta).toHaveCSS("opacity", "0")
  await latest.locator('[data-slot="text-part-body"]').hover()
  await expect(latestMeta).toHaveCSS("opacity", "1")

  const earlier = timeline.locator('[data-component="text-part"]').filter({ hasText: "I'll inspect the timeline" })

  const actions = earlier.locator('[data-slot="text-part-copy-wrapper"]')
  await expect(actions).toHaveCount(1)
  await expect(actions).toHaveCSS("height", "20px")
  await expect(actions).toHaveCSS("margin-top", "8px")
  await expect(actions).toHaveCSS("gap", "4px")
  await expect(actions).toHaveCSS("opacity", "0")
  await expect(actions).toHaveCSS("pointer-events", "none")

  const copy = actions.getByRole("button", { name: "Copy response", exact: true })

  await expect(copy).toHaveCSS("width", "20px")
  await expect(copy).toHaveCSS("height", "20px")
  await expect(copy.locator('[data-slot="icon-svg"]')).toHaveCSS("width", "14px")
  const rest = await copy.boundingBox()

  const meta = actions.locator('[data-slot="text-part-meta"]')

  await expect(meta).toHaveCSS("font-size", "12px")
  await expect(meta).toHaveCSS("line-height", "18px")
  await expect(meta).toHaveCSS("gap", "4px")
  await expect(meta.locator('[data-slot="text-part-meta-item"]')).toHaveText([
    "Build",
    "Claude Sonnet 4",
    "Balanced",
    "4m 50s",
  ])
  const separators = meta.locator('[data-slot="text-part-meta-separator"]')
  await expect(separators).toHaveCount(2)

  for (const separator of await separators.all()) {
    await expect(separator).toHaveText("\u00B7")
  }

  await earlier.locator('[data-slot="text-part-body"]').hover()
  await expect(actions).toHaveCSS("opacity", "1")
  await expect(actions).toHaveCSS("pointer-events", "auto")
  expect(await copy.boundingBox()).toEqual(rest)
  await copy.hover()
  await expect(actions).toHaveCSS("opacity", "1")

  await page.mouse.move(0, 0)
  await expect(actions).toHaveCSS("opacity", "0")
  await copy.focus()
  await expect(actions).toHaveCSS("opacity", "1")
  await expect(actions).toHaveCSS("pointer-events", "auto")
})

story("assistant message hover metadata shows each model and timestamp", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--agent-message-metadata", {
    args: { showMessageMetadata: true },
  })

  const sonnet = timeline.locator('[data-timeline-part-id="msg_agent_metadata_sonnet:text:0"]')
  const sonnetMeta = sonnet.locator('[data-slot="text-part-meta"]')
  const sonnetFooter = sonnet.locator('[data-slot="text-part-copy-wrapper"]')

  const nano = timeline.locator('[data-timeline-part-id="msg_agent_metadata_nano:text:0"]')
  const nanoMeta = nano.locator('[data-slot="text-part-meta"]')
  const nanoFooter = nano.locator('[data-slot="text-part-copy-wrapper"]')

  await expect(sonnetMeta).toContainText("Claude Sonnet 4")
  await expect(nanoMeta).toContainText("GPT-5.4 nano")
  expect((await sonnetMeta.textContent())?.split(" · ").at(-1)).not.toEqual(
    (await nanoMeta.textContent())?.split(" · ").at(-1),
  )
  await expect(sonnetFooter).toHaveCSS("opacity", "0")
  await sonnet.hover()
  await expect(sonnetFooter).toHaveCSS("opacity", "1")
  await nano.hover()
  await expect(nanoFooter).toHaveCSS("opacity", "1")
  await expect(nanoFooter.getByRole("button", { name: "Copy response", exact: true })).toBeVisible()
  await expect(nanoMeta).toContainText("Build")
})

story("shows message details at tablet widths even when hover is available", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 844 })
  const timeline = await mount("current-session-timeline-rows--agent-message-metadata", {
    args: { showMessageMetadata: true },
  })

  expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true)
  const footer = timeline.locator('[data-timeline-part-id="msg_agent_metadata_sonnet:text:0"] [data-slot="text-part-copy-wrapper"]')
  await expect(footer).toHaveCSS("opacity", "1")
  await expect(footer.locator('[data-slot="text-part-meta"]')).toHaveCSS("opacity", "1")
})

story("assistant message metadata stays hidden when the preference is disabled", async ({ mount }) => {
  const timeline = await mount("current-session-timeline-rows--agent-message-metadata", {
    args: { showMessageMetadata: false },
  })

  const response = timeline.locator('[data-timeline-part-id="msg_agent_metadata_sonnet:text:0"]')

  await expect(response.locator('[data-slot="text-part-copy-wrapper"]')).toHaveCount(0)
})
