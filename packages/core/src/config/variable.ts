export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { createScanner, type ParseError, parse } from "jsonc-parser"
import { isRecord } from "@opencode/ai/utils/record"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigNormalize } from "./normalize.js"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  env?: Record<string, string>
}

export type CredentialReference = {
  readonly providerID: string
  readonly modelID?: string
  readonly variant?: string
  readonly field: string
  readonly variables: readonly string[]
}

/** Inspect only credential fields in provider templates, never their resolved secret values. */
export function credentialReferences(text: string, get: (name: string) => string | undefined): CredentialReference[] {
  const visit = (value: unknown, path: readonly string[]): CredentialReference[] => {
    if (Array.isArray(value)) {
      if (path[0] === "providers" && path[1] && path[2] === "env" && path.length === 3) {
        const variables = value.filter((name): name is string => typeof name === "string")
        return [{ providerID: path[1], field: "env", variables: variables.some(get) ? [] : variables }]
      }
      return value.flatMap((item, index) =>
        visit(item, [...path, isRecord(item) && typeof item.id === "string" ? item.id : String(index)]),
      )
    }
    if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => visit(item, [...path, key]))
    if (
      typeof value !== "string" ||
      !/^(api[_-]?key|authToken|accessToken|authorization|x-api-key)$/i.test(path.at(-1) ?? "")
    )
      return []
    if (path[0] !== "providers" || !path[1]) return []
    const field = path.slice(path[4] === "variants" ? 6 : path[2] === "models" ? 4 : 2)
    if (field.length !== 2 || !["settings", "headers"].includes(field[0] ?? "")) return []
    const variables = Array.from(value.matchAll(/\{env:([^}]+)\}/g), (match) => match[1]).filter((name) => !get(name))
    return [
      {
        providerID: path[1],
        ...(path[2] === "models" ? { modelID: path[3] } : {}),
        ...(path[4] === "variants" ? { variant: path[5] } : {}),
        field: field[0] === "headers" ? `headers.${field[1]?.toLowerCase()}` : `settings.${field[1]}`,
        variables,
      },
    ]
  }
  // Resolve unquoted JSON fragments before validation, but preserve string templates for credential tracking.
  const scanner = createScanner(text)
  const strings: { start: number; end: number }[] = []
  while (true) {
    scanner.scan()
    if (scanner.getTokenLength() === 0) break
    if (text[scanner.getTokenOffset()] !== '"') continue
    strings.push({ start: scanner.getTokenOffset(), end: scanner.getTokenOffset() + scanner.getTokenLength() })
  }
  const template = text.replace(/\{env:([^}]+)\}/g, (token, name: string, offset: number) =>
    strings.some((range) => range.start <= offset && offset < range.end) ? token : get(name) || "null",
  )
  // Track the same canonical fields as the loaded document, including V1 migration and native precedence.
  const normalized = ConfigNormalize.normalize(parse(template, [], { allowTrailingComma: true }))
  return normalized.type === "normalized" ? visit(normalized.encoded, []) : []
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const env = (escape: boolean) =>
    input.text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = (input.env?.[name] ?? process.env[name]) || ""
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  const raw = yield* substituteFiles(input, env(false))
  const errors: ParseError[] = []
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (!errors.length) return raw
  return yield* substituteFiles(input, env(true))
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    // Like a missing {env:VAR}, a missing or unreadable file substitutes empty so one stale secret
    // reference cannot take down every Location that loads this config.
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("config file reference is missing or unreadable", {
          source: configSource,
          reference: token,
          path: resolvedPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})
