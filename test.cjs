const fs = require('fs');

const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

const regex = /  \}\n\n  async prepareSend/g;
content = content.replace(regex, `  async prepareSend`);

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed brace issue again.");
