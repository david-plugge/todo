import { expect, type Page } from '@playwright/test';

/** The list select is a custom listbox: a popover on wide screens, a sheet on mobile. */
export async function chooseList(page: Page, label: string, name: string) {
  const trigger = page.getByRole('button', { name: label, exact: true });
  await trigger.click();
  const content = page.getByTestId('list-select-content');
  await expect(content).toBeVisible();
  await content.getByRole('option', { name, exact: true }).click();
  await expect(content).toBeHidden();
  await expect(trigger).toContainText(name);
}
