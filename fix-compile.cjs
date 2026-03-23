const fs = require('fs');

const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

// The issue is that I inserted the `async prepareSend` right after `export interface PreparePublishNewsletterIssueInput` 
// but wait, I also inserted it around line 85? No, I did:
// `const existingMethod = content.substring(replaceIndex, endIndex);`
// Let's just fix the syntax issue. Where did I insert it? Let's check the context.

let matchStr = `  },
  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }


  async prepareSend(input: PrepareSendNewsletterInput): Promise<PreparedActionResult> {`;

// The prepareSend method was incorrectly inserted at the rate limits dictionary level.
// Let's remove it from there and put it inside LinkedInNewslettersService.

// First let's read the full file, find the misplaced prepareSend
let fullStr = content.substring(content.indexOf('  async prepareSend(input: PrepareSendNewsletterInput): Promise<PreparedActionResult> {'));
let endOfSendIndex = fullStr.indexOf('}\n    );\n  }') + 12;
let misplacedSendStr = fullStr.substring(0, endOfSendIndex);

content = content.replace(misplacedSendStr, '');

// Now insert it at the end of LinkedInNewslettersService
const replaceIndex = content.indexOf('async preparePublishIssue(input: PreparePublishNewsletterIssueInput): Promise<PreparedActionResult> {');
const endIndex = content.indexOf('}\n}', replaceIndex) + 2;

const existingMethod = content.substring(replaceIndex, endIndex);
content = content.replace(existingMethod, existingMethod + '\n' + misplacedSendStr);

// Also fix the export const dictionary closing:
content = content.replace(`  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }`, `  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }
};`);

fs.writeFileSync(path, content, 'utf8');
console.log("Successfully fixed prepareSend placement.");
