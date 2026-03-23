const fs = require('fs');
const path = require('path');

const testFile = path.join(__dirname, '../packages/core/src/__tests__/linkedinPublishing.test.ts');
let content = fs.readFileSync(testFile, 'utf8');

const importStr = `  CREATE_NEWSLETTER_ACTION_TYPE,
  UPDATE_NEWSLETTER_ACTION_TYPE,`;
content = content.replace('  CREATE_NEWSLETTER_ACTION_TYPE,', importStr);

const listStr = `      CREATE_NEWSLETTER_ACTION_TYPE,
      UPDATE_NEWSLETTER_ACTION_TYPE,`;
content = content.replace('      CREATE_NEWSLETTER_ACTION_TYPE,', listStr);

const expectedArrayStr = `      expect(typeof executors[CREATE_ARTICLE_ACTION_TYPE]?.execute).toBe(
        "function"
      );
      expect(typeof executors[UPDATE_NEWSLETTER_ACTION_TYPE]?.execute).toBe(
        "function"
      );`;
content = content.replace('      expect(typeof executors[CREATE_ARTICLE_ACTION_TYPE]?.execute).toBe(\n        "function"\n      );', expectedArrayStr);

const expectedIdStr = `      expect(executors[CREATE_NEWSLETTER_ACTION_TYPE]?.config).toEqual({
        actionType: CREATE_NEWSLETTER_ACTION_TYPE,
        counterKey: "linkedin.newsletter.create",
        windowSizeMs: 24 * 60 * 60 * 1000,
        limit: 10
      });
      expect(executors[UPDATE_NEWSLETTER_ACTION_TYPE]?.config).toEqual({
        actionType: UPDATE_NEWSLETTER_ACTION_TYPE,
        counterKey: "linkedin.newsletter.update",
        windowSizeMs: 24 * 60 * 60 * 1000,
        limit: 10
      });`;
content = content.replace('      expect(executors[CREATE_NEWSLETTER_ACTION_TYPE]?.config).toEqual({\n        actionType: CREATE_NEWSLETTER_ACTION_TYPE,\n        counterKey: "linkedin.newsletter.create",\n        windowSizeMs: 24 * 60 * 60 * 1000,\n        limit: 10\n      });', expectedIdStr);

fs.writeFileSync(testFile, content);
console.log('Fixed tests');
