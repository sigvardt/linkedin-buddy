const fs = require('fs');

const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

const regex = /  async prepareSend\(input: PrepareSendNewsletterInput\): Promise<PreparedActionResult> \{[\s\S]*?\n  \}\n/g;

let matches = [...content.matchAll(regex)];

if (matches.length > 0) {
    console.log("Found prepareSend blocks:", matches.length);
    // Let's just remove the first one if there are multiple, or remove all and put one at the right place.
    content = content.replace(regex, '');
}

const sendMethod = `
  async prepareSend(input: PrepareSendNewsletterInput): Promise<PreparedActionResult> {
    const profileName = input.profileName || "default";
    const newsletter = getRequiredStringField(input, "newsletter");
    const edition = getRequiredStringField(input, "edition");
    const recipients = input.recipients || "all";
    
    const tracePath = \`linkedin/trace-newsletter-send-prepare-\${Date.now()}.zip\`;
    const artifactPaths: string[] = [tracePath];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    return this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        try {
          await page.goto(LINKEDIN_ARTICLE_NEW_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30_000
          });

          await openManageMenu(page, this.runtime.selectorLocale, artifactPaths);

          const screenshotPath = \`linkedin/screenshot-newsletter-send-prepare-\${Date.now()}.png\`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          artifactPaths.push(screenshotPath);

          const preparedActionId = this.runtime.actionRegistry.prepare({
            actionType: SEND_NEWSLETTER_ACTION_TYPE,
            target: { type: "profile", profileName },
            payload: {
              newsletter,
              edition,
              recipients
            },
            context: {
              action: "prepare_send_newsletter",
              newsletter,
              edition,
              recipients
            },
            summary: \`Send LinkedIn newsletter edition "\${edition}" of "\${newsletter}"\`,
            operatorNote: input.operatorNote
          });

          return {
            preparedActionId,
            confirmToken: this.runtime.twoPhaseCommit.issueToken(preparedActionId),
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot =
            \`linkedin/screenshot-newsletter-send-prepare-error-\${Date.now()}.png\`;
          try {
            await page.screenshot({ path: failureScreenshot, fullPage: true });
            artifactPaths.push(failureScreenshot);
          } catch (screenshotError) {
            this.runtime.logger.log("warn", "linkedin.newsletter.prepare_send.screenshot_failed", {
              error: String(screenshotError),
              action: "prepare_send_newsletter_error"
            });
          }

          throw toAutomationError(error, "Failed to prepare LinkedIn newsletter send.", {
            context: {
              action: "prepare_send_newsletter",
              newsletter,
              edition
            },
            artifacts: artifactPaths
          });
        }
      }
    );
  }
`;

const replaceIndex = content.indexOf('async preparePublishIssue(input: PreparePublishNewsletterIssueInput): Promise<PreparedActionResult> {');
const endIndex = content.indexOf('}\n}', replaceIndex) + 2;

const existingMethod = content.substring(replaceIndex, endIndex);
content = content.replace(existingMethod, existingMethod + '\n' + sendMethod);

fs.writeFileSync(path, content, 'utf8');
console.log("Cleaned up and re-inserted.");
