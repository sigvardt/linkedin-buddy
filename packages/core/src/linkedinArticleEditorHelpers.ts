/* global document, InputEvent */
import type { Page } from 'playwright-core';

export interface TextFormatting {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  heading?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  link?: string;
  code?: boolean;
}

export interface Paragraph {
  text: string;
  formatting?: TextFormatting;
}

export interface ArticleData {
  title: string;
  coverImage?: string;
  sections: Array<{
    heading?: string;
    content: string;
    images?: string[];
  }>;
  tags?: string[];
  description?: string;
}

export async function insertCoverImage(page: Page, imagePath: string): Promise<void> {
  const fileInput = await page.$('input[type="file"][accept*="image"]');
  if (!fileInput) {
    throw new Error('Image upload input not found. Ensure you are on the article editor page.');
  }
  await fileInput.setInputFiles(imagePath);
  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"][accept*="image"]');
    if (input) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForTimeout(2000);
}

export async function insertInlineImage(page: Page, imageUrl: string, alt: string = 'Article image'): Promise<void> {
  const editor = await page.$('[contenteditable="true"]:not([aria-label*="title"])');
  if (!editor) {
    throw new Error('Article content editor not found.');
  }
  try {
    await page.evaluate(([url]) => {
      document.execCommand('insertImage', false, url || "");
    }, [imageUrl]);
  } catch {
    await page.evaluate(([url, altText]) => {
      const editor = document.querySelector('[contenteditable="true"]:not([aria-label*="title"])');
      if (editor) {
        const img = document.createElement('img');
        img.src = url || "";
        img.alt = altText || "";
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        editor.appendChild(img);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, [imageUrl, alt]);
  }
}

export async function fillRichText(page: Page, htmlContent: string): Promise<void> {
  await page.evaluate(([html]) => {
    const editor = document.querySelector('[contenteditable="true"]:not([aria-label*="title"])');
    if (editor) {
      editor.innerHTML = html || "";
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, [htmlContent]);
}
