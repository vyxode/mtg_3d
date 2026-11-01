import { expect, test, type Page } from '@playwright/test';

/** Clicks the decision button if this page holds the decision; returns whether it did. */
async function clickIfVisible(page: Page, name: string | RegExp): Promise<boolean> {
  const button = page.getByRole('button', { name });
  if (await button.isVisible()) { await button.click(); return true; }
  return false;
}

test('two friends create a room, choose decks and play the first turn', async ({ browser }) => {
  const ana = await (await browser.newContext()).newPage();
  const beto = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  ana.on('pageerror', (e) => { errors.push(e.message); });

  await ana.goto('/');
  await ana.getByLabel('Tu nombre').fill('Ana');
  await ana.getByRole('button', { name: 'Crear sala' }).click();
  const code = (await ana.locator('code.big').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  await beto.goto('/');
  await beto.getByLabel('Tu nombre').fill('Beto');
  await beto.getByLabel('Código de invitación').fill(code);
  await beto.getByRole('button', { name: 'Unirse' }).click();
  await expect(ana.getByText('Rival: Beto')).toBeVisible();

  await ana.getByRole('button', { name: 'Elegir mazo' }).click();
  await beto.getByLabel('Mazo').selectOption({ index: 1 });
  await beto.getByRole('button', { name: 'Elegir mazo' }).click();

  // Whoever was chosen at random decides who starts: Ana starts either way.
  const chooser = (p: Page) => p.getByRole('heading', { name: '¿Quién empieza?' }).isVisible();
  await expect.poll(async () => (await chooser(ana)) || (await chooser(beto))).toBe(true);
  if (!(await clickIfVisible(ana, 'Empiezo yo'))) await beto.getByRole('button', { name: 'Empieza el rival' }).click();

  await ana.getByRole('button', { name: 'Quedármela' }).click();
  await beto.getByRole('button', { name: 'Quedármela' }).click();

  // Auto-pass skips upkeep and draw: Ana acts in her first main phase.
  await expect(ana.getByText('Fase principal 1')).toBeVisible();
  await expect(ana.getByRole('heading', { name: 'Tienes prioridad' })).toBeVisible();
  await expect(beto.getByText(/Esperando a Ana/)).toBeVisible();

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
