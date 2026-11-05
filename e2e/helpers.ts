import { expect, type Browser, type Page } from '@playwright/test';

/** Clicks the decision button if this page holds the decision; returns whether it did. */
async function clickIfVisible(page: Page, name: string | RegExp): Promise<boolean> {
  const button = page.getByRole('button', { name });
  if (await button.isVisible()) { await button.click(); return true; }
  return false;
}

/** Ana creates a room, Beto joins with the code, both pick decks and keep: Ana has priority in her first main phase. */
export async function startGame(browser: Browser, deck?: string, table?: '2d'): Promise<{ ana: Page; beto: Page; errors: string[] }> {
  // With table '2d' both players start on the 2D table (the 3D one renders in software on CI machines, slowly).
  const open = async () => {
    const ctx = await browser.newContext();
    if (table) await ctx.addInitScript(() => { localStorage.setItem('mtg3d.table', '2d'); });
    return ctx.newPage();
  };
  const ana = await open();
  const beto = await open();
  const errors: string[] = [];
  for (const p of [ana, beto]) p.on('pageerror', (e) => { errors.push(e.message); });

  await ana.goto('./');
  await ana.getByLabel('Tu nombre').fill('Ana');
  await ana.getByRole('button', { name: 'Crear sala' }).click();
  const code = (await ana.locator('code.big').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  await beto.goto('./');
  await beto.getByLabel('Tu nombre').fill('Beto');
  await beto.getByLabel('Código de invitación').fill(code);
  await beto.getByRole('button', { name: 'Unirse' }).click();
  await expect(ana.locator('.seat-name', { hasText: 'Beto' })).toBeVisible();

  if (deck) await ana.locator('.deck-box', { hasText: deck }).click();
  await ana.getByRole('button', { name: /^Jugar con / }).click();
  await (deck ? beto.locator('.deck-box', { hasText: deck }) : beto.locator('.deck-box').nth(1)).click();
  await beto.getByRole('button', { name: /^Jugar con / }).click();

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

  return { ana, beto, errors };
}

/** Switches a player to the 2D table (the option lives in the "Opciones" menu). */
export async function to2D(page: Page): Promise<void> {
  await page.locator('summary', { hasText: 'Opciones' }).click();
  await page.getByRole('button', { name: 'Mesa 2D' }).click();
}
