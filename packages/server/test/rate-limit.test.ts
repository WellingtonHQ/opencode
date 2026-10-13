import { expect, test } from "bun:test"
import { ServerRateLimit } from "../src/auth/rate-limit"

test("locks out after ten failures, expires after a minute, and starts a fresh failure window", () => {
  const limit = ServerRateLimit.make()
  for (let i = 0; i < 9; i++) limit.recordFailure(1_000)
  expect(limit.retryAfterSeconds(1_000)).toBe(0)
  limit.recordFailure(1_000)
  expect(limit.retryAfterSeconds(1_000)).toBe(60)
  expect(limit.retryAfterSeconds(60_001)).toBe(1)
  expect(limit.retryAfterSeconds(61_000)).toBe(0)
  limit.recordFailure(61_000)
  expect(limit.retryAfterSeconds(61_000)).toBe(0)
  for (let i = 0; i < 9; i++) limit.recordFailure(61_000)
  expect(limit.retryAfterSeconds(61_000)).toBe(60)
  limit.reset()
  expect(limit.retryAfterSeconds(61_000)).toBe(0)
})
