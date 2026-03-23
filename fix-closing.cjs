const fs = require('fs');
const path = 'packages/core/src/linkedinPublishing.ts';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(`    limit: 1
  }
};



} as const satisfies Record<string, ConsumeRateLimitInput>;`, `    limit: 1
  }
} as const satisfies Record<string, ConsumeRateLimitInput>;`);

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed the extra closing braces");
