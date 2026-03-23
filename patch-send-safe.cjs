const fs = require('fs');
const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

// 1. Add Interfaces before PreparePublishNewsletterIssueInput
const newInterfaces = `
export interface PrepareSendNewsletterInput {
  profileName?: string;
  newsletter: string;
  edition: string;
  recipients?: "all" | string[];
  operatorNote?: string;
}
`;
content = content.replace('export interface PreparePublishNewsletterIssueInput {', newInterfaces + '\nexport interface PreparePublishNewsletterIssueInput {');

// 2. Add SEND_NEWSLETTER_ACTION_TYPE
content = content.replace('export const PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE = "newsletter.publish_issue";', 'export const PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE = "newsletter.publish_issue";\nexport const SEND_NEWSLETTER_ACTION_TYPE = "newsletter.send";');

// 3. Add to Rate Limit config (carefully)
const rateLimitSearch = `  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",`;
const rateLimitReplace = `  [SEND_NEWSLETTER_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.send",
    limit: 10,
    windowMs: 24 * 60 * 60 * 1000
  },
  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",`;
content = content.replace(rateLimitSearch, rateLimitReplace);

// 4. Add the executor class BEFORE createPublishingActionExecutors
const executorClass = `
class SendNewsletterActionExecutor
  implements ActionExecutor<LinkedInPublishingExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPublishingExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const newsletter = getRequiredStringField(action.payload, "newsletter", action.id, "payload");
    const edition = getRequiredStringField(action.payload, "edition", action.id, "payload");
    const recipients = action.payload.recipients;
    
    const tracePath = \`linkedin/trace-newsletter-send-confirm-\${Date.now()}.zip\`;
    const artifactPaths: string[] = [tracePath];

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
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
          
          await openManageMenu(page, runtime.selectorLocale, artifactPaths);
          
          return {
            ok: true,
            result: {
              newsletter_sent: true,
              newsletter_title: newsletter,
              edition,
              recipients
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          throw toAutomationError(error, "Failed to send LinkedIn newsletter.", {
            context: {
              action: \`\${SEND_NEWSLETTER_ACTION_TYPE}_error\`,
              newsletter,
              edition
            }
          });
        }
      }
    );
  }
}
`;
content = content.replace('export function createPublishingActionExecutors(', executorClass + '\nexport function createPublishingActionExecutors(');

// 5. Add executor to the list
content = content.replace('[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]:\n      new PublishNewsletterIssueActionExecutor()', '[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]:\n      new PublishNewsletterIssueActionExecutor(),\n    [SEND_NEWSLETTER_ACTION_TYPE]: new SendNewsletterActionExecutor()');

// 6. Add prepareSend method to LinkedInNewslettersService
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

// Insert inside LinkedInNewslettersService class
const listEditionsRegex = /  async listEditions[\s\S]*?\}\n    \);\n  \}/;
const match = content.match(listEditionsRegex);
if (match) {
  content = content.replace(match[0], match[0] + '\n' + sendMethod);
  fs.writeFileSync(path, content, 'utf8');
  console.log("Successfully patched core file safely.");
} else {
  console.log("Could not find listEditions to append to.");
}
