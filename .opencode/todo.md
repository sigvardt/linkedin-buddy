# Mission Tasks for Issue #609 - Newsletters & Articles: make it production-grade

## Phase 1: Support Rich Text and Images in Articles
- [ ] Investigate how LinkedIn rich text editor works (contenteditable vs specific DOM structure)
- [ ] Add support for cover image URL in `PrepareCreateArticleInput` and `PrepareCreateNewsletterInput`
- [ ] Add support for HTML/Markdown body parsing and inserting rich text

## Phase 2: Newsletter Metadata Editing
- [ ] Create `PrepareUpdateNewsletterInput` interface
- [ ] Implement `prepareUpdate` in `LinkedInNewslettersService`
- [ ] Implement `UpdateNewsletterActionExecutor`
- [ ] Register tool in MCP `linkedin.newsletter.prepare_update`
- [ ] Add CLI command for updating newsletter

## Phase 3: Newsletter Editions List and Stats
- [ ] Update `list` method in `LinkedInNewslettersService` to fetch stats (subscribers, views)
- [ ] Add new interface `ListNewsletterEditionsInput` and `listEditions` method to list individual editions for a newsletter
- [ ] Register `linkedin.newsletter.list_editions` tool in MCP
- [ ] Add CLI command for listing editions

## Phase 4: Share Newsletter
- [ ] Investigate how sharing works for newsletters (Share button -> modal -> post)
- [ ] Implement `prepareShare` in `LinkedInNewslettersService`
- [ ] Implement `ShareNewsletterActionExecutor`
- [ ] Register MCP tool and CLI command

## Phase 5: Testing and Polish
- [ ] Add unit tests for new methods in `linkedinPublishing.test.ts`
- [ ] Run e2e tests
- [ ] Address edge cases: draft vs published, editing after publish, newsletter with zero editions
