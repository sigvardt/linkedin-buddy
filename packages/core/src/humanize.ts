import type { Page } from "playwright-core";

export interface HumanizeOptions {
  /** Base delay between actions in ms (default: 800) */
  baseDelay?: number;
  /** Maximum jitter added to delays in ms (default: 1500) */
  jitterRange?: number;
  /** Whether running in fast/development mode (shorter delays) */
  fast?: boolean;
  /** Per-character typing delay in ms (default: 80) */
  typingDelay?: number;
  /** Typing jitter per character in ms (default: 60) */
  typingJitter?: number;
}

export class HumanizedPage {
  private readonly page: Page;
  private readonly options: Required<HumanizeOptions>;

  constructor(page: Page, options?: HumanizeOptions) {
    const fast = options?.fast ?? false;
    this.page = page;
    this.options = {
      baseDelay: options?.baseDelay ?? (fast ? 200 : 800),
      jitterRange: options?.jitterRange ?? (fast ? 400 : 1500),
      fast,
      typingDelay: options?.typingDelay ?? (fast ? 30 : 80),
      typingJitter: options?.typingJitter ?? (fast ? 20 : 60)
    };
  }

  /** Get the underlying Playwright Page */
  get raw(): Page {
    return this.page;
  }

  /** Random delay with jitter */
  async delay(baseMs?: number): Promise<void> {
    const base = baseMs ?? this.options.baseDelay;
    const jitter = Math.random() * this.options.jitterRange;
    await this.page.waitForTimeout(base + jitter);
  }

  /** Navigate to URL with human-like pre/post delays */
  async navigate(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "networkidle" | "load" }
  ): Promise<void> {
    await this.delay(300);
    await this.page.goto(url, { waitUntil: options?.waitUntil ?? "domcontentloaded" });
    await this.delay(600);
  }

  /** Scroll element into view with smooth scrolling */
  async scrollIntoView(selector: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);
  }

  /** Smooth scroll down by a random amount */
  async scrollDown(pixels?: number): Promise<void> {
    const amount = pixels ?? (300 + Math.random() * 500);
    await this.page.evaluate((scrollAmount) => {
      globalThis.scrollBy({ top: scrollAmount, behavior: "smooth" });
    }, amount);
    await this.delay(400);
  }

  /** Move mouse toward a position with slight randomness, then pause */
  async moveMouseNear(x: number, y: number): Promise<void> {
    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    await this.page.mouse.move(x + offsetX, y + offsetY, {
      steps: 3 + Math.floor(Math.random() * 5)
    });
    await this.delay(150);
  }

  /** Click a selector with human-like behavior: scroll into view, brief pause, click */
  async click(selector: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);

    const box = await element.boundingBox();
    if (box) {
      const targetX =
        box.x + box.width / 2 + (Math.random() - 0.5) * (box.width * 0.3);
      const targetY =
        box.y + box.height / 2 + (Math.random() - 0.5) * (box.height * 0.3);
      await this.page.mouse.move(targetX, targetY, {
        steps: 3 + Math.floor(Math.random() * 4)
      });
      await this.delay(100);
    }

    await element.click({ timeout: 10_000 });
    await this.delay(300);
  }

  /** Type text with realistic per-character delays */
  async type(selector: string, text: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);
    await element.click();
    await this.delay(150);

    for (const char of text) {
      await this.page.keyboard.type(char, { delay: 0 });
      const charDelay = this.options.typingDelay + Math.random() * this.options.typingJitter;
      const thinkPause = Math.random() < 0.05 ? 200 + Math.random() * 400 : 0;
      await this.page.waitForTimeout(charDelay + thinkPause);
    }

    await this.delay(200);
  }

  /** Wait for load with human-like additional delay after DOM is ready */
  async waitForPageLoad(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded");
    await this.delay(400);
  }

  /** Randomly idle — used between major operations */
  async idle(): Promise<void> {
    const idleTime = 1000 + Math.random() * 3000;
    if (this.options.fast) {
      await this.page.waitForTimeout(200 + Math.random() * 300);
      return;
    }

    await this.page.waitForTimeout(idleTime);
  }
}

/** Create a HumanizedPage wrapper */
export function humanize(page: Page, options?: HumanizeOptions): HumanizedPage {
  return new HumanizedPage(page, options);
}
