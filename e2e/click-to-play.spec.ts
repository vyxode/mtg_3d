import { expect, test } from '@playwright/test';
import { startGame } from './helpers';

test('tapping a card on the table plays it', async ({ browser }) => {
  const { ana, beto, errors } = await startGame(browser, undefined, '2d');

  const land = ((await ana.getByRole('button', { name: /^Jugar / }).first().textContent()) ?? '').replace('Jugar ', '');
  await ana.locator('.zone', { hasText: 'Tu mano' }).getByTitle(land).first().click();
  await expect(ana.locator('.zone', { hasText: 'Tu campo' }).getByTitle(land)).toBeVisible();
  await expect(beto.locator('.zone', { hasText: 'Campo de Ana' }).getByTitle(land)).toBeVisible();
  expect(errors).toEqual([]);
});
