import { expect, test, type Page } from '@playwright/test';
import { startGame } from './helpers';

/**
 * Two players click through a whole game with the meta deck, using only what the interface shows: the smoke test
 * for every decision panel (attacks, blocks, targets, searches, surveil, triggers…).
 */
async function act(page: Page, tried: Set<string>): Promise<boolean> {
  const panel = page.locator('.decision');
  if ((await panel.locator('h3').count()) === 0) return false; // the other player holds the decision
  const heading = (await panel.locator('h3').first().textContent()) ?? '';
  // The decision can move to the other player between reading and clicking: a click that can't happen is a no-op.
  const click = async (name: string | RegExp) => panel.getByRole('button', { name }).first().click({ timeout: 2000 }).then(() => true, () => false);
  const has = async (name: string | RegExp) => (await panel.getByRole('button', { name }).count()) > 0;

  if (heading === '¿Quién empieza?') return click('Empiezo yo');
  if (heading.startsWith('Mano inicial')) return click('Quedármela');
  if (heading.startsWith('Descarta') || heading.startsWith('Pon ')) {
    const n = Number(/\d+/.exec(heading)?.[0] ?? '1');
    for (let i = 0; i < n; i++) await panel.locator('.card').nth(i).click({ timeout: 2000 }).catch(() => undefined);
    return click('Confirmar');
  }
  if (heading.startsWith('Regla de leyendas')) { await panel.locator('.card').first().click({ timeout: 2000 }).catch(() => undefined); return true; }
  if (heading.includes('busca en tu biblioteca')) return click(/./);
  if (heading.includes('vigila')) return click('Confirmar');
  if (heading.startsWith('Tripular')) return click('Cancelar');
  if (heading.startsWith('Ordena')) {
    for (const b of await panel.locator('button:not(.primary):not(.link):enabled').all()) await b.click({ timeout: 2000 }).catch(() => undefined);
    return click('Confirmar');
  }
  if (heading.includes('elige objetivo')) return (await has('Sin objetivo')) ? click('Sin objetivo') : panel.locator('button:not(.link)').first().click({ timeout: 2000 }).then(() => true, () => false);
  if (heading === 'Elige atacantes') {
    for (const c of await panel.locator('.card').all()) await c.click({ timeout: 2000 }).catch(() => undefined);
    return click(/^(Atacar con|No atacar)/);
  }
  if (heading === 'Declara bloqueadores') return click('Confirmar bloqueos');
  if (heading.startsWith('Reparte')) return click(/^Confirmar/);
  if (heading === 'Tienes prioridad') {
    if (await has(/^Jugar /)) return click(/^Jugar /);
    for (const b of await panel.getByRole('button', { name: /^Lanzar / }).all()) {
      const key = `${await page.locator('.status').textContent() ?? ''}|${await b.textContent() ?? ''}`;
      if (tried.has(key)) continue;
      tried.add(key);
      return b.click({ timeout: 2000 }).then(() => true, () => false);
    }
    return click(/^Pasar/);
  }
  return false;
}

test.use({ actionTimeout: 3000 });

/** One decision on one page; a decision that moved on while being read just counts as nothing done. */
const tryAct = (page: Page, tried: Set<string>) => act(page, tried).catch(() => false);

test('a whole game with the meta deck, played through the interface', async ({ browser }) => {
  test.setTimeout(300_000);
  const { ana, beto, errors } = await startGame(browser, 'Mono-Green Landfall (meta Standard)');
  for (const p of [ana, beto]) await p.getByRole('button', { name: 'Mesa 2D' }).click();
  const tried = new Set<string>();
  let idle = 0;
  for (let i = 0; i < 1500; i++) {
    if (await ana.locator('.banner', { hasText: /ganado|Empate/ }).isVisible()) break;
    const acted = (await tryAct(ana, tried)) || (await tryAct(beto, tried));
    idle = acted ? 0 : idle + 1;
    expect(idle, `nobody has anything to do: the game is stuck at ${await ana.locator('.status').textContent() ?? ''}`).toBeLessThan(40);
    if (!acted) await ana.waitForTimeout(100);
  }
  for (const p of [ana, beto]) await expect(p.getByRole('alert')).toHaveCount(0);
  const turn = Number(/Turno (\d+)/.exec((await ana.locator('.status').textContent()) ?? '')?.[1] ?? '0');
  expect(turn).toBeGreaterThan(6);
  expect(errors).toEqual([]);
});
