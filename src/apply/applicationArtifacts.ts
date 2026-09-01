import fs from "node:fs/promises";
import path from "node:path";

/** Controller-only screenshot persistence; browser tools never expose this action. */
export async function captureFullPageScreenshot(browser: { screenshot(input: { fullPage: boolean }): Promise<unknown> }, runId: string, label: string): Promise<string | undefined> {
  try {
    const screenshot = await browser.screenshot({ fullPage: true });
    if (!screenshot || typeof screenshot !== "object" || !("base64" in screenshot) || typeof screenshot.base64 !== "string") return undefined;
    const directory = path.resolve(process.cwd(), "screenshots");
    const target = path.join(directory, `apply_${runId}_${label}.png`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(target, Buffer.from(screenshot.base64, "base64"));
    return target;
  } catch { return undefined; }
}
