const fs = require('fs');

const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

// Ensure that ALL additionalProperties are at the root level of the inputSchema

const listStr = 'name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,';
const listIdx = content.indexOf(listStr);
if (listIdx !== -1) {
  const schemaEnd = content.indexOf('    }\n  },', listIdx);
  if (schemaEnd !== -1 && !content.substring(listIdx, schemaEnd).includes('additionalProperties: false')) {
     content = content.substring(0, schemaEnd) + ',\n      additionalProperties: false\n' + content.substring(schemaEnd);
  }
}

const sendStr = 'name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,';
const sendIdx = content.indexOf(sendStr);
if (sendIdx !== -1) {
  const schemaEnd = content.indexOf('    }\n  },', sendIdx);
  if (schemaEnd !== -1 && !content.substring(sendIdx, schemaEnd).includes('additionalProperties: false')) {
     content = content.substring(0, schemaEnd) + ',\n      additionalProperties: false\n' + content.substring(schemaEnd);
  }
}

const updateStr = 'name: LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,';
const updateIdx = content.indexOf(updateStr);
if (updateIdx !== -1) {
  const schemaEnd = content.indexOf('    }\n  },', updateIdx);
  if (schemaEnd !== -1 && !content.substring(updateIdx, schemaEnd).includes('additionalProperties: false')) {
     content = content.substring(0, schemaEnd) + ',\n      additionalProperties: false\n' + content.substring(schemaEnd);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed missing additionalProperties: false correctly at root level of inputSchema");
