const fs = require('fs');
const path = require('path');

const indexFile = path.join(__dirname, '../packages/core/src/index.ts');
let content = fs.readFileSync(indexFile, 'utf8');

// I might have removed exports from core/src/index.ts accidentally? 
// Let's check `git diff origin/main..HEAD packages/core/src/index.ts`
console.log("Checking if I touched index.ts...");
