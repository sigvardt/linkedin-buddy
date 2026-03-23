# Mission: Notifications: make it production-grade (#613)

## M1: Analysis & Infrastructure
### T1.1: Identify Notification Types & Extracted Data | agent:Planner
- [ ] S1.1.1: Document parsing logic for the 9 specified notification types | size:M
- [ ] S1.1.2: Define updated `LinkedInNotification` interface with `extracted_data` | size:S

## M2: Implementation
### T2.1: Implement Data Extraction (Rich Data) | agent:Worker | depends:T1.1
- [x] S2.1.1: Update `extractNotificationSnapshots` to extract structured data for all required types | size:L
- [x] S2.1.2: Add parsing utilities for metrics (view counts, names, etc) | size:M

### T2.2: Implement Type Filtering & Pagination | agent:Worker | depends:T2.1
- [x] S2.2.1: Add `types` filtering to `ListNotificationsInput` and `listNotifications` method | size:S
- [x] S2.2.2: Add `types` parameter to MCP tool `notifications_list` | size:S
- [x] S2.2.3: Update pagination logic in `loadNotificationSnapshots` to support fetching longer feeds without fixed scroll limits | size:M

## M3: Verification & Integration
### T3.1: Testing & Quality Gates | agent:Reviewer | depends:M2
- [ ] S3.1.1: Run unit tests and e2e tests for notifications | size:M
- [ ] S3.1.2: Run lint and typecheck | size:S
- [ ] S3.1.3: Wait for CI and create PR | size:S
