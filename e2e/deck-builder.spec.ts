import { expect, test } from '@playwright/test';

test('builds a deck from a pasted list, edits it and offers it in the room', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Mis mazos' }).click();

  page.once('dialog', (d) => void d.accept('56 Mountain\n3 Lightning Bolt'));
  await page.getByRole('button', { name: 'Importar lista' }).click();
  await expect(page.getByText('El mazo principal tiene 59 cartas; el mínimo es 60.')).toBeVisible();

  // Without the Scryfall catalog on the server, search falls back to the implemented cards.
  await page.getByPlaceholder('Nombre').fill('Lightning');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await page.getByTitle('Añadir al mazo principal').first().click();
  await expect(page.getByText('Mazo válido y jugable.')).toBeVisible();
  await expect(page.getByText('4× Lightning Bolt')).toBeVisible();

  await page.getByLabel('Nombre del mazo').fill('Rayos');
  await page.getByRole('button', { name: 'Jugar' }).click();
  await page.getByLabel('Tu nombre').fill('Ana');
  await page.getByRole('button', { name: 'Crear sala' }).click();
  await page.getByLabel('Mazo').selectOption('Mío: Rayos');
  await page.getByRole('button', { name: 'Elegir mazo' }).click();
  await expect(page.getByRole('button', { name: 'Listo, esperando al rival' })).toBeVisible();
});
