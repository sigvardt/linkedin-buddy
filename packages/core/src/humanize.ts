import type { Page } from "playwright-core";

const QWERTY_KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;
const QWERTY_ROW_OFFSETS = [0, 0.5, 0.85, 1.35] as const;
const ADJACENCY_HORIZONTAL_THRESHOLD = 1.1;
const ADJACENCY_VERTICAL_THRESHOLD = 1.05;
const COMMON_BURST_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "the",
  "to",
  "we",
  "you"
]);

export type KeyboardHand = "left" | "right";
export type KeyboardFinger =
  | "left-pinky"
  | "left-ring"
  | "left-middle"
  | "left-index"
  | "right-index"
  | "right-middle"
  | "right-ring"
  | "right-pinky";

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

export type TypingProfileName = "casual" | "careful" | "fast";

export interface TypingProfile {
  typoRate: number;
  doubleBackspaceRate: number;
  shiftMissRate: number;
  baseCharDelayMs: number;
  charDelayJitterMs: number;
  midWordMultiplier: number;
  wordBoundaryMultiplier: number;
  whitespaceMultiplier: number;
  punctuationMultiplier: number;
  burstWordMultiplier: number;
  repeatedCharacterMultiplier: number;
  thinkingPauseChance: number;
  thinkingPauseRange: DelayRange;
  longPauseChance: number;
  longPauseRange: DelayRange;
  correctionPauseRange: DelayRange;
  correctionResumeRange: DelayRange;
  shiftLeadRange: DelayRange;
}

export interface HumanizeOptions {
  /** Base delay between actions in ms (default: 800) */
  baseDelay?: number;
  /** Maximum jitter added to delays in ms (default: 1500) */
  jitterRange?: number;
  /** Whether running in fast/development mode (shorter delays) */
  fast?: boolean;
  /** Legacy base per-character typing delay override in ms */
  typingDelay?: number;
  /** Legacy typing jitter override per character in ms */
  typingJitter?: number;
  /** Default typing profile used by HumanizedPage.type() */
  typingProfile?: TypingProfileName;
  /** Default per-profile overrides applied by HumanizedPage.type() */
  typingProfileOverrides?: Partial<TypingProfile>;
}

export interface HumanizedTypingOptions {
  profile?: TypingProfileName;
  profileOverrides?: Partial<TypingProfile>;
}

export interface AdjacentTypoCandidate {
  key: string;
  weight: number;
  hand: KeyboardHand;
  finger: KeyboardFinger;
}

interface ResolvedHumanizeOptions {
  baseDelay: number;
  jitterRange: number;
  fast: boolean;
  typingProfile: TypingProfileName;
  typingDelayOverride: number | null;
  typingJitterOverride: number | null;
  typingProfileOverrides: Partial<TypingProfile>;
}

interface KeyboardKeyGeometry {
  key: string;
  x: number;
  y: number;
  hand: KeyboardHand;
  finger: KeyboardFinger;
}

interface TypingContext {
  previousMeaningful: string | null;
  isBurstWord: boolean;
  isRepeatedCharacter: boolean;
  isSentenceRestart: boolean;
  isWhitespace: boolean;
  isWordCharacter: boolean;
  isWordEnd: boolean;
  isWordStart: boolean;
}

const KEY_FINGER_BY_CHARACTER = {
  "1": "left-pinky",
  "2": "left-ring",
  "3": "left-middle",
  "4": "left-index",
  "5": "left-index",
  "6": "right-index",
  "7": "right-index",
  "8": "right-middle",
  "9": "right-ring",
  "0": "right-pinky",
  q: "left-pinky",
  w: "left-ring",
  e: "left-middle",
  r: "left-index",
  t: "left-index",
  y: "right-index",
  u: "right-index",
  i: "right-middle",
  o: "right-ring",
  p: "right-pinky",
  a: "left-pinky",
  s: "left-ring",
  d: "left-middle",
  f: "left-index",
  g: "left-index",
  h: "right-index",
  j: "right-index",
  k: "right-middle",
  l: "right-ring",
  z: "left-pinky",
  x: "left-ring",
  c: "left-middle",
  v: "left-index",
  b: "left-index",
  n: "right-index",
  m: "right-index"
} as const satisfies Record<string, KeyboardFinger>;

export const TYPING_PROFILES = {
  casual: {
    typoRate: 0.04,
    doubleBackspaceRate: 0.08,
    shiftMissRate: 0.02,
    baseCharDelayMs: 85,
    charDelayJitterMs: 95,
    midWordMultiplier: 0.82,
    wordBoundaryMultiplier: 1.35,
    whitespaceMultiplier: 1.4,
    punctuationMultiplier: 1.5,
    burstWordMultiplier: 0.72,
    repeatedCharacterMultiplier: 0.78,
    thinkingPauseChance: 0.18,
    thinkingPauseRange: { minMs: 300, maxMs: 1500 },
    longPauseChance: 0.03,
    longPauseRange: { minMs: 2000, maxMs: 5000 },
    correctionPauseRange: { minMs: 60, maxMs: 220 },
    correctionResumeRange: { minMs: 40, maxMs: 160 },
    shiftLeadRange: { minMs: 20, maxMs: 70 }
  },
  careful: {
    typoRate: 0.018,
    doubleBackspaceRate: 0.03,
    shiftMissRate: 0.005,
    baseCharDelayMs: 95,
    charDelayJitterMs: 55,
    midWordMultiplier: 0.9,
    wordBoundaryMultiplier: 1.18,
    whitespaceMultiplier: 1.25,
    punctuationMultiplier: 1.35,
    burstWordMultiplier: 0.82,
    repeatedCharacterMultiplier: 0.9,
    thinkingPauseChance: 0.08,
    thinkingPauseRange: { minMs: 250, maxMs: 900 },
    longPauseChance: 0.01,
    longPauseRange: { minMs: 1800, maxMs: 3200 },
    correctionPauseRange: { minMs: 70, maxMs: 170 },
    correctionResumeRange: { minMs: 50, maxMs: 120 },
    shiftLeadRange: { minMs: 25, maxMs: 60 }
  },
  fast: {
    typoRate: 0.025,
    doubleBackspaceRate: 0.05,
    shiftMissRate: 0.01,
    baseCharDelayMs: 45,
    charDelayJitterMs: 25,
    midWordMultiplier: 0.74,
    wordBoundaryMultiplier: 1.1,
    whitespaceMultiplier: 1.12,
    punctuationMultiplier: 1.2,
    burstWordMultiplier: 0.58,
    repeatedCharacterMultiplier: 0.7,
    thinkingPauseChance: 0.04,
    thinkingPauseRange: { minMs: 180, maxMs: 450 },
    longPauseChance: 0.004,
    longPauseRange: { minMs: 2000, maxMs: 3500 },
    correctionPauseRange: { minMs: 50, maxMs: 120 },
    correctionResumeRange: { minMs: 30, maxMs: 100 },
    shiftLeadRange: { minMs: 15, maxMs: 40 }
  }
} satisfies Record<TypingProfileName, TypingProfile>;

const KEYBOARD_GEOMETRY = createKeyboardGeometry();
const KEYBOARD_KEYS = Object.values(KEYBOARD_GEOMETRY);

export const QWERTY_KEY_ADJACENCY_MAP = createQwertyAdjacencyMap();

const WEIGHTED_QWERTY_KEY_ADJACENCY_MAP = createWeightedQwertyAdjacencyMap();

function createKeyboardGeometry(): Readonly<Record<string, KeyboardKeyGeometry>> {
  const entries = QWERTY_KEYBOARD_ROWS.flatMap((row, rowIndex) =>
    Array.from(row).map((key, keyIndex) => {
      const mappedKey = key as keyof typeof KEY_FINGER_BY_CHARACTER;
      const finger = KEY_FINGER_BY_CHARACTER[mappedKey];
      const hand: KeyboardHand = finger.startsWith("left") ? "left" : "right";
      return [
        key,
        {
          key,
          x: keyIndex + (QWERTY_ROW_OFFSETS[rowIndex] ?? 0),
          y: rowIndex,
          hand,
          finger
        }
      ] as const;
    })
  );

  return Object.freeze(
    Object.fromEntries(entries) as Record<string, KeyboardKeyGeometry>
  );
}

function getKeyDistance(source: KeyboardKeyGeometry, target: KeyboardKeyGeometry): number {
  return Math.hypot(source.x - target.x, source.y - target.y);
}

function getAdjacentKeyboardKeys(source: KeyboardKeyGeometry): KeyboardKeyGeometry[] {
  return KEYBOARD_KEYS
    .filter(
      (target) =>
        target.key !== source.key &&
        Math.abs(source.x - target.x) <= ADJACENCY_HORIZONTAL_THRESHOLD &&
        Math.abs(source.y - target.y) <= ADJACENCY_VERTICAL_THRESHOLD
    )
    .sort(
      (left, right) =>
        getKeyDistance(source, left) - getKeyDistance(source, right) ||
        left.key.localeCompare(right.key)
    );
}

function createQwertyAdjacencyMap(): Readonly<Record<string, readonly string[]>> {
  const entries = Object.values(KEYBOARD_GEOMETRY).map((source) => {
    const adjacent = getAdjacentKeyboardKeys(source).map((target) => target.key);

    return [source.key, Object.freeze(adjacent)] as const;
  });

  return Object.freeze(Object.fromEntries(entries) as Record<string, readonly string[]>);
}

function createWeightedCandidate(
  source: KeyboardKeyGeometry,
  target: KeyboardKeyGeometry
): AdjacentTypoCandidate {
  const sameFinger = source.finger === target.finger;
  const sameHand = source.hand === target.hand;
  const distance = getKeyDistance(source, target);
  const baseWeight = sameFinger ? 6 : sameHand ? 3 : 1.5;
  const distanceBonus = distance < 1 ? 1.25 : 1;

  return {
    key: target.key,
    weight: baseWeight * distanceBonus,
    hand: target.hand,
    finger: target.finger
  };
}

function createWeightedQwertyAdjacencyMap(): Readonly<
  Record<string, readonly AdjacentTypoCandidate[]>
> {
  const entries = Object.values(KEYBOARD_GEOMETRY).map((source) => {
    const weighted = getAdjacentKeyboardKeys(source)
      .map((target) => createWeightedCandidate(source, target))
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          left.key.localeCompare(right.key)
      );

    return [source.key, Object.freeze(weighted)] as const;
  });

  return Object.freeze(
    Object.fromEntries(entries) as Record<string, readonly AdjacentTypoCandidate[]>
  );
}

function isUppercaseLetter(character: string): boolean {
  return /^[A-Z]$/.test(character);
}

function isWhitespaceCharacter(character: string | null): boolean {
  return character !== null && /^\s$/u.test(character);
}

function normalizeTypingCharacter(character: string | null): string | null {
  if (character === null || !/^[A-Za-z0-9]$/u.test(character)) {
    return null;
  }

  return character.toLowerCase();
}

function isWordCharacter(character: string | null): boolean {
  return normalizeTypingCharacter(character) !== null;
}

function applyCharacterCase(candidate: string, intendedCharacter: string): string {
  return isUppercaseLetter(intendedCharacter) ? candidate.toUpperCase() : candidate;
}

export function getAdjacentTypoCandidates(character: string): readonly AdjacentTypoCandidate[] {
  const normalizedCharacter = normalizeTypingCharacter(character);
  if (normalizedCharacter === null) {
    return [];
  }

  return WEIGHTED_QWERTY_KEY_ADJACENCY_MAP[normalizedCharacter] ?? [];
}

export function pickAdjacentTypoCharacter(
  character: string,
  randomValue = Math.random()
): string | null {
  const candidates = getAdjacentTypoCandidates(character);
  if (candidates.length === 0) {
    return null;
  }

  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const clampedRandom = Math.max(0, Math.min(randomValue, 0.999999));
  let remainingWeight = clampedRandom * totalWeight;

  for (const candidate of candidates) {
    remainingWeight -= candidate.weight;
    if (remainingWeight < 0) {
      return applyCharacterCase(candidate.key, character);
    }
  }

  return applyCharacterCase(candidates[candidates.length - 1]!.key, character);
}

export class HumanizedPage {
  private readonly page: Page;
  private readonly options: ResolvedHumanizeOptions;

  constructor(page: Page, options?: HumanizeOptions) {
    const fast = options?.fast ?? false;
    this.page = page;
    this.options = {
      baseDelay: options?.baseDelay ?? (fast ? 200 : 800),
      jitterRange: options?.jitterRange ?? (fast ? 400 : 1500),
      fast,
      typingProfile: options?.typingProfile ?? (fast ? "fast" : "careful"),
      typingDelayOverride: options?.typingDelay ?? null,
      typingJitterOverride: options?.typingJitter ?? null,
      typingProfileOverrides: options?.typingProfileOverrides ?? {}
    };
  }

  /** Get the underlying Playwright Page */
  get raw(): Page {
    return this.page;
  }

  /** Random delay with jitter */
  async delay(baseMs?: number): Promise<void> {
    const base = baseMs ?? this.options.baseDelay;
    const jitter = this.options.jitterRange > 0 ? Math.random() * this.options.jitterRange : 0;
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

  /** Type text with human-like cadence, typos, and corrections. */
  async type(
    selector: string,
    text: string,
    options?: HumanizedTypingOptions
  ): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);
    await element.click();
    await this.delay(150);

    const characters = Array.from(text);
    const contexts = this.buildTypingContexts(characters);
    const profile = this.resolveTypingProfile(options);
    let previousCommittedCharacter: string | null = null;

    for (const [index, character] of characters.entries()) {
      const context = contexts[index];
      if (!context) {
        continue;
      }

      await this.maybePauseBeforeCharacter(characters.length, index, context, profile);

      const missedShift =
        isUppercaseLetter(character) && this.shouldTrigger(profile.shiftMissRate);
      const mistypedCharacter = missedShift
        ? character.toLowerCase()
        : this.chooseTypoCharacter(character, profile);

      if (mistypedCharacter === null) {
        await this.typeLiteralCharacter(character, profile);
      } else {
        await this.typeLiteralCharacter(mistypedCharacter, profile);
        await this.correctCharacter(character, previousCommittedCharacter, profile, {
          allowDoubleBackspace: !missedShift
        });
      }

      previousCommittedCharacter = character;
      await this.page.waitForTimeout(this.computeCharacterDelay(context, profile));
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
    const idleTime = this.options.fast
      ? 200 + Math.random() * 300
      : 1000 + Math.random() * 3000;
    await this.page.waitForTimeout(idleTime);
  }

  private resolveTypingProfile(options?: HumanizedTypingOptions): TypingProfile {
    const name = options?.profile ?? this.options.typingProfile;
    const baseProfile = TYPING_PROFILES[name];

    return {
      ...baseProfile,
      ...(this.options.typingDelayOverride === null
        ? {}
        : { baseCharDelayMs: this.options.typingDelayOverride }),
      ...(this.options.typingJitterOverride === null
        ? {}
        : { charDelayJitterMs: this.options.typingJitterOverride }),
      ...this.options.typingProfileOverrides,
      ...options?.profileOverrides
    };
  }

  private buildTypingContexts(characters: readonly string[]): TypingContext[] {
    const burstWordIndexes = this.findBurstWordIndexes(characters);

    return characters.map((current, index) => {
      const previous = index > 0 ? characters[index - 1] ?? null : null;
      const previousMeaningful = this.findPreviousMeaningfulCharacter(characters, index - 1);
      const next = index < characters.length - 1 ? characters[index + 1] ?? null : null;
      const normalizedCurrent = normalizeTypingCharacter(current);
      const normalizedPrevious = normalizeTypingCharacter(previous);
      const currentIsWordCharacter = normalizedCurrent !== null;

      return {
        previousMeaningful,
        isBurstWord: burstWordIndexes.has(index),
        isRepeatedCharacter: currentIsWordCharacter && normalizedCurrent === normalizedPrevious,
        isSentenceRestart:
          previousMeaningful !== null && /[.!?]/u.test(previousMeaningful),
        isWhitespace: isWhitespaceCharacter(current),
        isWordCharacter: currentIsWordCharacter,
        isWordEnd: currentIsWordCharacter && !isWordCharacter(next),
        isWordStart: currentIsWordCharacter && !isWordCharacter(previous)
      };
    });
  }

  private findPreviousMeaningfulCharacter(
    characters: readonly string[],
    startIndex: number
  ): string | null {
    for (let index = startIndex; index >= 0; index -= 1) {
      const character = characters[index] ?? null;
      if (!isWhitespaceCharacter(character)) {
        return character;
      }
    }

    return null;
  }

  private findBurstWordIndexes(characters: readonly string[]): Set<number> {
    const burstWordIndexes = new Set<number>();
    let wordStartIndex: number | null = null;

    for (let index = 0; index <= characters.length; index += 1) {
      const character = characters[index] ?? null;
      const isLetter = character !== null && /^[A-Za-z]$/u.test(character);

      if (isLetter) {
        if (wordStartIndex === null) {
          wordStartIndex = index;
        }
        continue;
      }

      if (wordStartIndex === null) {
        continue;
      }

      const word = characters.slice(wordStartIndex, index).join("").toLowerCase();
      if (COMMON_BURST_WORDS.has(word)) {
        for (let burstIndex = wordStartIndex; burstIndex < index; burstIndex += 1) {
          burstWordIndexes.add(burstIndex);
        }
      }

      wordStartIndex = null;
    }

    return burstWordIndexes;
  }

  private computeCharacterDelay(
    context: TypingContext,
    profile: TypingProfile
  ): number {
    const jitter = profile.charDelayJitterMs > 0 ? Math.random() * profile.charDelayJitterMs : 0;
    let delay = profile.baseCharDelayMs + jitter;

    if (context.isWordCharacter) {
      delay *= context.isWordStart || context.isWordEnd
        ? profile.wordBoundaryMultiplier
        : profile.midWordMultiplier;

      if (context.isBurstWord) {
        delay *= profile.burstWordMultiplier;
      }

      if (context.isRepeatedCharacter) {
        delay *= profile.repeatedCharacterMultiplier;
      }
    } else if (context.isWhitespace) {
      delay *= profile.whitespaceMultiplier;
    } else {
      delay *= profile.punctuationMultiplier;
    }

    if (context.isSentenceRestart) {
      delay *= 1.08;
    }

    return Math.max(0, delay);
  }

  private chooseTypoCharacter(
    character: string,
    profile: TypingProfile
  ): string | null {
    if (normalizeTypingCharacter(character) === null || !this.shouldTrigger(profile.typoRate)) {
      return null;
    }

    return pickAdjacentTypoCharacter(character);
  }

  private async maybePauseBeforeCharacter(
    totalCharacters: number,
    characterIndex: number,
    context: TypingContext,
    profile: TypingProfile
  ): Promise<void> {
    if (totalCharacters < 5 || characterIndex === 0 || !context.isWordStart) {
      return;
    }

    const longPauseEligible = totalCharacters >= 15 && context.isSentenceRestart;
    if (longPauseEligible && this.shouldTrigger(profile.longPauseChance)) {
      await this.page.waitForTimeout(this.sampleRange(profile.longPauseRange));
      return;
    }

    const previousCharacter = context.previousMeaningful;
    const chanceBoost = previousCharacter !== null && /[,;:]/u.test(previousCharacter) ? 1.35 : 1;
    const pauseChance = Math.min(1, profile.thinkingPauseChance * chanceBoost);
    if (this.shouldTrigger(pauseChance)) {
      await this.page.waitForTimeout(this.sampleRange(profile.thinkingPauseRange));
    }
  }

  private async correctCharacter(
    intendedCharacter: string,
    previousCommittedCharacter: string | null,
    profile: TypingProfile,
    options: { allowDoubleBackspace: boolean }
  ): Promise<void> {
    await this.page.waitForTimeout(this.sampleRange(profile.correctionPauseRange));
    await this.page.keyboard.press("Backspace");

    const shouldDoubleBackspace =
      options.allowDoubleBackspace &&
      previousCommittedCharacter !== null &&
      isWordCharacter(previousCommittedCharacter) &&
      this.shouldTrigger(profile.doubleBackspaceRate);

    if (shouldDoubleBackspace) {
      await this.page.keyboard.press("Backspace");
    }

    await this.page.waitForTimeout(this.sampleRange(profile.correctionResumeRange));

    if (shouldDoubleBackspace && previousCommittedCharacter !== null) {
      await this.typeLiteralCharacter(previousCommittedCharacter, profile);
    }

    await this.typeLiteralCharacter(intendedCharacter, profile);
  }

  private async typeLiteralCharacter(
    character: string,
    profile: TypingProfile
  ): Promise<void> {
    if (character.length === 0) {
      return;
    }

    if (isUppercaseLetter(character)) {
      const shiftLeadDelay = this.sampleRange(profile.shiftLeadRange);
      if (shiftLeadDelay > 0) {
        await this.page.waitForTimeout(shiftLeadDelay);
      }

      await this.page.keyboard.down("Shift");
      await this.page.keyboard.press(character.toLowerCase());
      await this.page.keyboard.up("Shift");
      return;
    }

    await this.page.keyboard.type(character, { delay: 0 });
  }

  private sampleRange(range: DelayRange): number {
    if (range.minMs >= range.maxMs) {
      return range.minMs;
    }

    return range.minMs + Math.random() * (range.maxMs - range.minMs);
  }

  private shouldTrigger(chance: number): boolean {
    if (chance <= 0) {
      return false;
    }

    if (chance >= 1) {
      return true;
    }

    return Math.random() < chance;
  }
}

/** Create a HumanizedPage wrapper */
export function humanize(page: Page, options?: HumanizeOptions): HumanizedPage {
  return new HumanizedPage(page, options);
}
