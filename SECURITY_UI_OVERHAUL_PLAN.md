# Taskito Security And UI Overhaul Plan

This plan is the working roadmap for hardening Taskito first, then elevating the product UI. Security fixes are intentionally front-loaded because the UI overhaul should not build on unsafe foundations.

## Phase 1: Security Remediation

Goals:

- Remove exploitable request, file, and authorization gaps.
- Keep fixes small and targeted so they can ship quickly.
- Verify each change with tests, build, and dependency audit checks where possible.

Work items:

- Harden comment attachment uploads and downloads.
- Validate file signatures for inline image previews.
- Serve non-previewable files as downloads with safe content types.
- Add `nosniff` headers for attachment responses.
- Verify custom field ownership before updates.
- Sanitize login callback redirects to same-origin relative paths.
- Trust only proxy-controlled client IP headers for login rate limiting.
- Allow non-admin users to access their own profile settings while keeping admin-only tabs protected.
- Upgrade vulnerable production dependencies or document any remaining upstream blocker.

## Phase 2: Reliability And Scale

Goals:

- Ensure larger projects do not appear incomplete.
- Improve operational confidence before broad UI changes.

Work items:

- Replace hard `limit: 100` view queries with pagination, infinite loading, or virtualization.
- Add visible result counts and "showing first N" warnings until full pagination lands.
- Add CI gates for unit tests, type/build checks, dependency audit, and key Playwright flows.
- Add regression coverage for security fixes.
- Review destructive actions and add consistent confirmation dialogs.

## Phase 3: Design Foundation

Goals:

- Move from scattered inline styling to durable UI primitives.
- Establish a premium, distinct visual language without breaking existing workflows.

Work items:

- Add semantic tokens for success, warning, info, priority, status, focus, overlays, charts, and destructive states.
- Replace hardcoded gray/blue/red Tailwind utilities in settings pages with theme tokens.
- Upgrade dialog, menu, combobox, tabs, toast, tooltip, and sheet primitives for accessibility.
- Add a real focus-visible system and keyboard patterns for overlays and command surfaces.
- Define card, table, panel, empty-state, and toolbar recipes in shared components.

## Phase 4: Product Shell Redesign

Goals:

- Make Taskito feel like a project command center instead of a set of isolated pages.
- Preserve speed for existing task workflows.

Work items:

- Introduce a persistent app shell with project context, primary navigation, command search, notifications, and profile controls.
- Add project health summary cards for overdue work, blocked tasks, throughput, and assignee load.
- Reframe the current project page into a workspace with Board, List, Timeline, Archive, and Reports.
- Improve mobile navigation with bottom actions and full-screen task detail.

## Phase 5: Work View Overhaul

Goals:

- Make board, list, and graph views feel purpose-built and information-rich.

Work items:

- Board: add WIP/status health, richer task cards, better drop affordances, and compact density controls.
- List: add virtualization, configurable columns, sticky headers, better bulk selection, and saved column presets.
- Graph: add legends, dependency inspector, clearer focus trails, minimap controls, and task grouping modes.
- Archive: add restore workflows, archive reasons, retention filters, and bulk restore/delete controls.

## Phase 6: Task Detail Overhaul

Goals:

- Make task detail the central work surface.

Work items:

- Replace the narrow side panel with a responsive resizable inspector.
- Add tabs for Details, Comments, Activity, Dependencies, Files, and History.
- Add safe attachment previews, download controls, and upload progress.
- Add clearer blocked/completion guidance and transition explanations.
- Improve comments with mention suggestions, attachment chips, and timeline grouping.

## Phase 7: Insights And Automation

Goals:

- Give teams higher-level operating visibility and reduce repetitive work.

Work items:

- Add reporting surfaces for cycle time, throughput, burnup/burndown, SLA breach risk, and workload.
- Add automation rules for status changes, assignment routing, reminders, and escalations.
- Add integrations for Slack, Teams, GitHub/GitLab, calendar sync, and webhooks.
- Add import/export, public API tokens, service accounts, and migration tooling.

## Implementation Order

1. Complete Phase 1 security remediation.
2. Add regression tests for the security fixes.
3. Address Phase 2 scale and CI gaps.
4. Build the design foundation before large page redesigns.
5. Roll out the new shell and task detail surfaces behind incremental, reviewable changes.
6. Upgrade board/list/graph/archive views one surface at a time.
