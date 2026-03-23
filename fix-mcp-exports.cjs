const fs = require('fs');

const index = 'packages/mcp/src/index.ts';
let content = fs.readFileSync(index, 'utf8');

const validationTest = 'packages/mcp/src/__tests__/linkedinMcp.validation.test.ts';
let testContent = fs.readFileSync(validationTest, 'utf8');

console.log("Looking at how the test imports tools...");
const match = testContent.match(/import\s+\*\s+as\s+exportedTools\s+from\s+"(?:..\/)+src\/index(?:\.js)?"/);
console.log("Match:", match ? "Found" : "Not Found");

// Are there other index files?
console.log("Index content:");
console.log(content.split('\n').filter(l => l.includes('NEWSLETTER')).join('\n'));

