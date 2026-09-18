import { expect, type Page } from '@playwright/test';

export async function setDate(page: Page, label: string, value: string | null) {
  const scope = label.endsWith('bearbeiten')
    ? page
        .getByTestId('account-task')
        .filter({ has: page.getByLabel('Titel bearbeiten', { exact: true }) })
    : page;
  const trigger = scope.getByRole('button', { name: label, exact: true });
  await trigger.click();
  const popup = page.getByTestId('date-popover');
  await expect(popup).toBeVisible();
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (value) {
    const [year, month] = value.split('-');
    await popup.getByRole('combobox', { name: 'Jahr', exact: true }).selectOption(year);
    await popup
      .getByRole('combobox', { name: 'Monat', exact: true })
      .selectOption(String(Number(month)));
    await popup.locator(`[data-calendar-day][data-date="${value}"]`).click();
  } else {
    await popup.getByRole('button', { name: 'Datum entfernen', exact: true }).click();
  }
  await expect(popup).toHaveCount(0);
  await expect(trigger).toHaveAttribute('data-date', value ?? '');
}
