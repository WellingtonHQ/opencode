import { expect, test } from "bun:test"
import { base64Encode } from "@opencode/util/encode"
import { permissionAutoApprove } from "./policy"

const directory = "/tmp/project"
const prefix = `${base64Encode(directory)}/`
const sessions = new Map<string, { parentID?: string }>([
  ["root", {}],
  ["child", { parentID: "root" }],
  ["grandchild", { parentID: "child" }],
])

const cases: {
  name: string
  overrides: Record<string, boolean>
  sessionID: string
  fallback: boolean
  expected: boolean
}[] = [
  { name: "empty policy needs no cached lineage", overrides: {}, sessionID: "unknown", fallback: true, expected: true },
  {
    name: "nearest ancestor overrides an accepting root",
    overrides: { [`${prefix}root`]: true, [`${prefix}child`]: false },
    sessionID: "grandchild",
    fallback: true,
    expected: false,
  },
  {
    name: "a child's explicit allow overrides its parent and directory",
    overrides: { [`${prefix}root`]: false, [`${prefix}child`]: true, [`${prefix}*`]: false },
    sessionID: "child",
    fallback: false,
    expected: true,
  },
  {
    name: "scoped override wins over the legacy session ID",
    overrides: { [`${prefix}root`]: false, root: true },
    sessionID: "root",
    fallback: true,
    expected: false,
  },
  {
    name: "legacy session-only overrides still apply",
    overrides: { root: true },
    sessionID: "child",
    fallback: false,
    expected: true,
  },
  {
    name: "directory deny overrides the global default",
    overrides: { [`${prefix}*`]: false },
    sessionID: "root",
    fallback: true,
    expected: false,
  },
  {
    name: "directory allow overrides the disabled global default",
    overrides: { [`${prefix}*`]: true },
    sessionID: "root",
    fallback: false,
    expected: true,
  },
  {
    name: "unknown lineage waits for resolution instead of bypassing a saved deny",
    overrides: { [`${prefix}root`]: false },
    sessionID: "unknown",
    fallback: true,
    expected: false,
  },
]

test.each(cases)("request policy: $name", (row) => {
  expect(
    permissionAutoApprove({
      overrides: row.overrides,
      sessionID: row.sessionID,
      directory,
      session: (id) => sessions.get(id),
      fallback: row.fallback,
    }),
  ).toBe(row.expected)
})
