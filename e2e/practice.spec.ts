import { expect, test } from '@playwright/test';

test('practising against the machine: no friend, no network, the bot plays its turns', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('mtg3d.table', '2d'); }); // the 3D table renders in software on CI
  const errors: string[] = [];
  page.on('pageerror', (e) => { errors.push(e.message); });
  await page.goto('./');
  await page.getByRole('button', { name: 'Contra la máquina' }).click();
  await page.locator('.deck-box').first().click();
  await page.getByRole('button', { name: /^Jugar con / }).click();
  // Pass through every decision until the machine has had a turn of its own.
  await expect(async () => {
    const button = page.locator('.decision button:not(.link)').first();
    if (await button.isVisible()) await button.click({ timeout: 1000 }).catch(() => undefined);
    await expect(page.locator('.log')).toContainText(/La máquina (juega|lanza|roba)/, { timeout: 500 });
  }).toPass({ timeout: 60_000 });
  expect(errors).toEqual([]);
});
