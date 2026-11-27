import { expect, test } from "@playwright/test";

/**
 * Platform smoke E2E (T-E01-02): proves the evaluation target boots and the
 * deliberately-flawed demo surface is reachable — the fixed baseline that
 * agent evaluation (T-E01-06 / T-E02-13) builds on.
 */
test("demo target is healthy", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
});

test("demo app exposes its pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Demo Shop" })).toBeVisible();

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();
    await expect(page.locator("#login-form")).toBeVisible();
});
