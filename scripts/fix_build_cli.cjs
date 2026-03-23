const fs = require('fs');
const path = require('path');

const cliFile = path.join(__dirname, '../packages/cli/src/bin/linkedin.ts');
let content = fs.readFileSync(cliFile, 'utf8');

const importMissingStr = `PREPARED_ACTION_EFFECTIVE_STATUSES,
  PreparedActionEffectiveStatus,`;

content = content.replace('PREPARED_ACTION_EFFECTIVE_STATUSES,', importMissingStr);

// Oh wait, some imports from core were complaining they are not exported!
// Let's check what TS compiler said for linkedin.ts
// TS2305 Module '"@linkedin-buddy/core"' has no exported member 'computeEffectiveStatus'.
// etc. Let's see if those were accidentally removed or something?
// Actually, they are from @linkedin-buddy/core
