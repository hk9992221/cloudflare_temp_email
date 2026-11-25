import { expect, test } from '@playwright/test';
import { FRONTEND_URL, WORKER_URL } from '../../../fixtures/test-helpers';

const ADMIN_HEADERS = { 'x-admin-auth': 'e2e-admin-pass' };

test('persists the selected D1 plan and restores it after reload', async ({ page, request }) => {
  const seedResponse = await request.post(`${WORKER_URL}/admin/config`, {
    headers: ADMIN_HEADERS,
    data: { key: 'd1_storage_plan', value: 'free' },
  });
  expect(seedResponse.ok()).toBe(true);

  await page.addInitScript(() => {
    localStorage.setItem('adminAuth', 'e2e-admin-pass');
    sessionStorage.setItem('adminTab', 'qucickSetup');
  });
  await page.goto(`${FRONTEND_URL}/en/admin`);

  const storagePanel = page.locator('.storage-panel');
  const planSelect = storagePanel.locator('.plan-select .n-select');

  await expect(storagePanel.getByText('Current Database Size', { exact: true })).toBeVisible();
  await expect(storagePanel.getByText('Database Capacity Limit', { exact: true })).toBeVisible();
  await expect(storagePanel.getByText('Capacity Usage', { exact: true })).toBeVisible();
  await expect(planSelect).toContainText('Free');

  await planSelect.click();
  await page.locator('.n-base-select-option').filter({ hasText: 'Workers Paid' }).click();

  await expect(page.getByText('Workers plan saved')).toBeVisible();
  await expect(storagePanel).toContainText('10.0 GB');

  await page.reload();

  await expect(planSelect).toContainText('Workers Paid');
  await expect(storagePanel).toContainText('10.0 GB');
});

test('checks the R2 binding and previews D1 mail migration from database settings', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('adminAuth', 'e2e-admin-pass');
    sessionStorage.setItem('adminTab', 'qucickSetup');
  });
  await page.goto(`${FRONTEND_URL}/en/admin`);
  const panel = page.locator('.mail-storage');
  await expect(panel.getByText('Incoming mail backend')).toBeVisible();
  await expect(panel.getByText('Configured', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Check configuration' }).click();
  await expect(panel.getByText('Schema ready and R2 reachable.')).toBeVisible();
  await panel.getByRole('button', { name: 'Preview migration' }).click();
  await expect(panel.getByText(/eligible messages, with/)).toBeVisible();
});
