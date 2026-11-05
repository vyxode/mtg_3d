import { expect, test } from '@playwright/test';
import { startGame } from './helpers';

test('two friends create a room, choose decks and play the first turn', async ({ browser }) => {
  // Both start on the 2D table, whose DOM the checks below read (the 3D one renders in software on CI, slowly).
  const { ana, beto, errors } = await startGame(browser, undefined, '2d');

  const play = ana.getByRole('button', { name: /^Jugar / }).first();
  const land = ((await play.textContent()) ?? '').replace('Jugar ', '');
  await play.click();
  await expect(beto.locator('.zone', { hasText: 'Campo de Ana' }).getByTitle(land)).toBeVisible();

  // Beto never sees Ana's hand: his "Tu mano" shows only his own seven cards.
  await expect(beto.locator('.zone', { hasText: 'Tu mano' }).locator('.card')).toHaveCount(7);
  await ana.waitForTimeout(800); // let the card fly from the hand
  await ana.screenshot({ path: 'test-results/ana-turn1.png', fullPage: true });
  expect(errors).toEqual([]);
  // The 3D table is one click away, in the options menu.
  await ana.locator('summary', { hasText: 'Opciones' }).click();
  await ana.getByRole('button', { name: 'Mesa 3D' }).click();
  await expect(ana.locator('.table3d canvas')).toBeVisible({ timeout: 20_000 });
});
