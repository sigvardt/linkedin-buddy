const fs = require('fs');

const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

// There is STILL a duplicate prepareSend here. Let's clean up again
let matchStr = `  },
  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }


  async prepareSend(input: PrepareSendNewsletterInput): Promise<PreparedActionResult> {`;

let fullStr = content.substring(content.indexOf('  async prepareSend(input: PrepareSendNewsletterInput): Promise<PreparedActionResult> {'));
let endOfSendIndex = fullStr.indexOf('}\n    );\n  }') + 12;
let misplacedSendStr = fullStr.substring(0, endOfSendIndex);

content = content.replace(misplacedSendStr, '');

// Close the export const dictionary properly:
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
