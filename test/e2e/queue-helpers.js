// Helpers for tests that run jobs through the queue tray.
import { expect } from '@playwright/test';

/** Wait until the tray lists a finished job that saved `fileName`. */
export async function expectSaved(page, fileName, options = { timeout: 60000 }) {
  const done = page.locator('[data-testid="queue-finished"][data-state="done"]').filter({ hasText: fileName });
  await expect(done.first()).toBeVisible(options);
}

/** Wait until the tray lists a failed job, and return its text. */
export async function expectFailed(page, options = { timeout: 60000 }) {
  const failed = page.locator('[data-testid="queue-finished"][data-state="failed"]');
  await expect(failed.first()).toBeVisible(options);
  return failed.first().textContent();
}
