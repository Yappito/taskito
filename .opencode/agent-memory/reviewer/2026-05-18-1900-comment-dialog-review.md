---
agent: reviewer
created: 2026-05-18T19:00:00Z
scope: task comment editing, quick-add dialog resizing, dialog.tsx stale-closure fix, related tests
type: review
confidence: high
---

# Review Summary

Reviewed comment editing (frontend UI, comment-service, API route, comment-content helpers) and quick-add dialog resizing (Dialog component, quick-add panelClassName, E2E tests). The comment editing authorization is correctly implemented with multi-layer checks. The dialog stale-closure fix is sound. No critical or high-severity issues.

One medium finding: the dialog-sizing E2E test has a strict-inequality boundary condition at 1920px viewport width. Several low-severity test coverage gaps exist. No security or authorization defects.

---

## Findings

### Medium

#### 1. Dialog-sizing E2E test is flaky at 1920px viewport width

**File:** `e2e/broad-coverage.spec.ts:88`

```typescript
expect(dialogBox!.width).toBeGreaterThan(viewport!.width * 0.6);
```

**Issue:** The quick-add dialog's maximum width is `min(92vw, 72rem)`. At a viewport width of 1920px:
- `min(0.92 * 1920, 72 * 16)` = `min(1766, 1152)` = 1152px
- `0.6 * 1920` = 1152px
- The assertion `1152 > 1152` evaluates to `false`

`toBeGreaterThan` is a strict inequality. When the dialog width exactly equals `viewport * 0.6` (which occurs at 1920px), the test fails.

**Failure scenario:** Playwright running with a viewport width of 1920px (e.g., CI with certain display configurations, or a `--viewport-size` override), or the window being resized to exactly 1920px during test execution, causes a spurious failure.

**Fix direction:** Use `toBeGreaterThanOrEqual` instead of `toBeGreaterThan`. This is the semantically correct assertion since the intention is "dialog is not too narrow" rather than "dialog must be strictly wider than 60%". Alternatively, change the assertion to `expect(dialogBox!.width).toBeGreaterThan(viewport!.width * 0.59)` to avoid the exact boundary.

---

### Low

#### 2. Comment edit E2E test does not cover editing a comment with attachments

**File:** `e2e/broad-coverage.spec.ts:56-74`

The test creates a plain text comment and edits it. It does not verify the flow where a comment with attachments has its text content emptied — the server allows this, but the client-side `canSaveComment` check (`comment.attachments?.length ? true : Boolean(editingCommentContent.trim())`) relies on the inline type which may not include `attachments` in all query paths. Adding an attachment scenario would validate the client/server interaction.

**Risk:** If the `comment.attachments` field is missing from the query response (e.g., a regression in the `byId` include), the `canSaveComment` check would incorrectly prevent saving empty content even when attachments exist. Low risk because the field is present today, but no regression signal exists.

#### 3. Missing E2E coverage for comment edit cancellation

**File:** `e2e/broad-coverage.spec.ts`

No test verifies that clicking "Cancel" during comment edit restores the original content and clears the editing state. A UI regression that breaks `cancelCommentEdit` (e.g., stale state, missing reset of `editingCommentId`) would not be caught.

#### 4. Missing unit test for `updateTaskComment` with empty text + existing attachments

**File:** `src/server/services/__tests__/comment-service.test.ts`

The `updateTaskComment` function allows saving with empty content when attachments exist (line 136-138). The unit test suite only tests the text-only happy path and the non-author rejection. The empty-content-with-attachments branch is untested.

**Risk:** If the logic for determining `existingComment.attachments.length` is ever refactored (e.g., changing the `findUnique` select), a regression where empty-text edits are incorrectly rejected would go undetected.

#### 5. `comment-content.test.ts` does not test `normalizeCommentContent` or `buildCommentAttachmentReferenceBlock` directly

**File:** `src/lib/__tests__/comment-content.test.ts`

Only `getCommentBody` is tested. The helper functions `normalizeCommentContent` (used in both `createTaskComment` and `updateTaskComment`) and `buildCommentAttachmentReferenceBlock` have no isolated unit tests.

---

## Verified Correct (Notable Positive Findings)

- **Authorization is multi-layer and correct:** `requireTaskAccess` checks project membership first, then `updateTaskComment` confirms the actor is the comment author. API route validates the session. A non-member cannot edit comments, and a member cannot edit another user's comments. The comment-to-task ownership cross-check (line 123 of comment-service.ts) prevents horizontal privilege escalation via mismatched `taskId`/`commentId`.

- **Mention notification diff is correct:** `updateTaskComment` correctly computes `previousMentionedUserIds` from the stored content and only notifies newly mentioned users, avoiding duplicate notifications for pre-existing mentions. The actor is excluded.

- **Dialog stale closure is correctly fixed:** `dialog.tsx` now uses `onCloseRef` to capture the latest `onClose` prop, and the `useEffect` dependency array no longer includes `onClose`. This prevents the Escape key handler from calling a stale `onClose` when the parent re-renders with a new closure.

- **Dialog `panelClassName` override works correctly:** `twMerge` in the `cn` utility properly resolves the Tailwind conflict between `max-w-lg` (default) and `max-w-[min(92vw,72rem)]` (quick-add override), applying the latter without class ordering dependencies.

- **Client-side double-submit prevention:** The `isUpdatingComment` and `isSubmittingComment` state flags correctly disable the save/submit buttons while requests are in-flight, preventing duplicate comment edits or creations.

---

## Open Questions

None.
