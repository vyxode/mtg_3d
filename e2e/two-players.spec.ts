import { expect, test } from '@playwright/test';
import { startGame } from './helpers';

test('two friends create a room, choose decks and play the first turn', async ({ browser }) => {
  const { ana, beto, errors } = await startGame(browser);

  // Ana plays on the 3D table (the default with WebGL); Beto switches to the 2D table, whose DOM the checks below read.
  await expect(ana.locator('.table3d canvas')).toBeVisible();
  await beto.getByRole('button', { name: 'Mesa 2D' }).click();

  const play = ana.getByRole('button', { name: /^Jugar / }).first();
  const land = ((await play.textContent()) ?? '').replace('Jugar ', '');
  await play.click();
  await expect(beto.locator('.zone', { hasText: 'Campo de Ana' }).getByTitle(land)).toBeVisible();

  // Beto never sees Ana's hand: his "Tu mano" shows only his own seven cards.
  await expect(beto.locator('.zone', { hasText: 'Tu mano' }).locator('.card')).toHaveCount(7);
  await ana.waitForTimeout(800); // let the card fly from the hand
  await ana.screenshot({ path: 'test-results/ana-turn1.png', fullPage: true });
  expect(errors).toEqual([]);
});
