# Jira Cloud integration

Taskito supports personal Jira Cloud connections (`https://your-team.atlassian.net`). Each user connects their own Atlassian account. Connections maintain their own task copies: two users importing the same Jira ticket into a shared Taskito project will currently get separate Taskito tasks. Jira Data Center and scoped tokens using the Atlassian API gateway are not supported.

## Deployment and setup

1. Deploy the schema with `npm run db:generate` and `./node_modules/.bin/prisma migrate deploy`.
2. Configure `AI_SECRET_MASTER_KEY` (recommended) or the existing `AUTH_SECRET`. Jira tokens use Taskito's shared authenticated encryption and are included in `npm run db:reencrypt-ai-secrets` when rotating keys.
3. Open **Settings → Jira**, enter your site, account email, and an Atlassian API token **without scopes**, and choose a Taskito project. You need read/create/update/comment access to that project. Choose a project whose members may see the Jira content you import.
4. Save to verify the account and discover the request participants field. A field override is available if your Jira configuration requires it. A warning appears when no field can be found: discovery then covers assignees only.
5. Use **Sync now**, or leave the built-in scheduler enabled. Polling defaults to five minutes per connection. `SCHEDULER_ENABLED=false` disables automatic in-process jobs.

No Jira credentials are returned to the browser after saving. API calls are restricted to HTTPS Atlassian tenant origins, with request deadlines and pagination. The user's current Taskito permissions and enabled connection are checked again during background work.

The Jira account needs Browse Projects and permission to read the issues being imported, plus Create Issues / Edit Issues / Transition Issues / Add Comments / Create Attachments for the corresponding outbound operations. Service Management internal comments require an agent account with the appropriate permissions; customers cannot post internal notes. Jira's permissions remain authoritative.

## Imported tasks

Discovery includes unresolved tickets outside Jira's Done category where the connected user is the assignee **or** a request participant. All matching pages are processed. Each ticket becomes a Taskito task with a **Jira: PROJECTKEY** tag that appears in board/list views, plus a link to the Jira ticket in its detail view.

Existing linked tickets continue to be refreshed after resolution or reassignment, so final comments, history and closure are not missed. Jira priority and the connected user's assignment are imported. Other Jira users are preserved as comment/history author labels rather than creating Taskito accounts.

Taskito requires a due date. If Jira has none, the import uses a configurable number of days after import (seven by default). This fallback is not written to Jira unless the user explicitly edits the due date in Taskito.

Imports preserve comment timestamps, external author names, public/internal visibility, attachments, and the paginated Jira changelog. The task's Activity section shows Jira field history. Standard Jira issue attachments are shown in a labelled attachment entry; Service Management attachments stay with their original comments. Taskito's 20 MB per-file limit applies to imports too; failures are surfaced rather than silently discarded.

**Public/internal describes visibility in Jira. All members with read access to the Taskito project can read its imported comments and attachments, including internal notes.** Taskito does not mirror Jira's individual issue-security or customer roles. Removing Jira access stops future successful pulls; it does not erase already imported project content.

## Creating and editing tasks

Enable **Sync to Jira** in the task creation dialog, choose a Jira project, and choose an issue type. For Service Management projects, choose a request type instead; Taskito uses the customer-request API so public/internal comments work correctly. The Taskito project must be the destination configured in your personal connection.

Titles, descriptions, due dates, and statuses synchronize in both directions. Configure optional status-name mappings in Settings → Jira when workflow names differ. Outbound status changes use Jira's currently available transitions. Missing or ambiguous transitions produce a visible sync error and leave the local edit queued. Jira projects and request types with additional mandatory fields must provide defaults in Jira; otherwise Jira's validation error appears on the task and the user can link an issue created in Jira instead.

Local edits are saved with a durable outbound version in the same database transaction. Pending local edits take precedence until delivered; unrelated remote fields are not sent back as part of a title edit. Polling sends queued edits before pulling Jira state. Imports fetch the current issue under a per-task lock and use a local timestamp comparison to avoid overwriting concurrent edits. This is not collaborative text merging: once pending local writes are delivered, subsequent Jira edits are imported normally.

Descriptions/comments are converted between Jira ADF and text. Text and paragraph breaks are retained; advanced Jira formatting, embeds and inline media layouts are not round-tripped.

## Comments and delivery errors

The comment composer clearly selects **Internal** or **Public**. A linked comment and its attachments are attempted immediately using the author's own enabled Jira connection for the same site and Taskito project. Other members must connect their own accounts before posting to a linked ticket. For Service Management, temporary attachments are finalized together with the comment's visibility. Standard Jira issues accept public comments only; Taskito refuses to silently publish an internal note.

Remote comment changes arrive on the next poll or manual sync. Edit Jira-linked comments in Jira; those edits are imported. Comment deletion is not propagated automatically. Local comment notifications and the AI comment-thread version continue to work.

Failed deliveries remain visible on the comment or ticket. Known rejected writes retry during scheduled sync. A timeout, server error, or interrupted non-idempotent write may have succeeded in Jira, so it is marked for review instead of blindly repeated. Check Jira before using **Retry Jira delivery** or **Retry creation**. For an issue already created, use **Link existing Jira issue** with its key. This avoids generating a second Jira issue after an interrupted response.

Per-connection and per-task PostgreSQL advisory locks prevent concurrent manual, scheduled, and multi-replica sync operations. Separate database connections hold those locks; ordinary database queries do not use their pools. Task/import IDs and remote comment/attachment IDs provide durable deduplication.

Taskito opts into experimental Service Management APIs for comment attachment listings. JSM attachment IDs are resolved from the same site's `_links.jiraRest` URL on both import and upload; downloads use Jira's platform attachment endpoint. Invalid or incomplete attachment responses produce a visible error. If Jira already accepted an upload, an incomplete response requires review before retrying to avoid duplicates.

HTTP errors include Jira's JSON or plain-text explanation where available, including experimental API errors (HTTP 412). Unexpected internal failures include a reference for the server's `Jira sync failure` log entry. Diagnostics include the error category and source locations without raw Prisma query arguments or credentials. A connection's last-sync timestamp records the last attempt; check its error and each ticket's sync state to confirm success.

Pausing disables outbound and inbound work. Disconnect removes the stored token and Jira links (including the link's history snapshot), while retaining local tasks, comments, and files. Moving a linked task outside its configured Taskito project suspends its sync. Deleting a Taskito task does not delete its Jira issue.

## External cron

The built-in scheduler is enough for normal self-hosted deployments. If you use an external scheduler, configure `CRON_SECRET` and POST once per minute; only connections whose individual poll interval has elapsed are processed:

```sh
curl --fail --request POST \
  --header "Authorization: Bearer $CRON_SECRET" \
  https://taskito.example.com/api/cron/sync-jira
```

The endpoint rejects calls when the secret is absent or invalid. Each request has a five-minute work deadline. The built-in scheduler uses its existing tick deadline. Manual sync also has a five-minute deadline. Large imports resume by deduplicating completed records on later runs.

## API references

- [Jira enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira issues, metadata, transitions and changelog](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira Service Management requests, comments and attachments](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/)
- [Jira attachments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/)
