# Requirements: Telegram Agent

Status: Approved

## Objective

Deliver a publicly accessible, general-purpose conversational AI assistant through private Telegram chats, powered by the DeepSeek API, with durable file-only persistence on one Vercel Sandbox Drive, a secret-protected read-only web dashboard, and an authenticated API that downloads a consistent archive of all persisted application data.

## Background

This is a greenfield project named `telegram-agent`. The application will use Next.js on the Vercel Hobby plan. Telegram is the end-user interface and `deepseek-v4-pro` is the requested model. Durable application data must not use PostgreSQL, SQLite, another database, or object storage; it must be stored as ordinary files on a Vercel Sandbox Drive mounted into Vercel Sandbox compute.

Because an ordinary Vercel Function cannot mount a Sandbox Drive, the Next.js application acts as the web, webhook, authentication, and controller layer while same-region Sandbox compute performs durable file access. Vercel Sandbox Drive is beta, allows only one read-write attachment at a time, and Vercel Hobby imposes Sandbox session and quota constraints. The resulting service is explicitly best-effort.

## Stakeholders and users

- Telegram users: anyone who discovers the bot and starts a private chat.
- Dashboard and download clients: anyone who possesses the configured administrator secret.
- Operator: configures Vercel environment variables, Telegram, DeepSeek, the Singapore Sandbox region, and the Drive.
- Maintainers: implement, test, deploy, operate, and later extend the agent.

## Scope

### In scope

- Public, private-chat Telegram text conversations.
- A general-purpose, multilingual DeepSeek-powered assistant.
- File-only persistence for users, conversations, messages, usage metadata, sanitized failures, idempotency records, and application state.
- A secret-authenticated, read-only web dashboard.
- A secret-authenticated ZIP download API for all persisted application data.
- Next.js deployment on Vercel Hobby plus Vercel Sandbox and one Vercel Sandbox Drive in Singapore (`sin1`).
- A modular model integration that can support future agent capabilities without including them in this release.

### Boundaries

- The MVP supports Telegram private chats only.
- Telegram input is limited to text messages and the `/start`, `/help`, and `/new` commands.
- The assistant is conversational only and cannot invoke tools or external actions.
- All durable application records reside exclusively on the Sandbox Drive as JSONL and JSON files.
- Capacity and availability are best-effort within Telegram, DeepSeek, Vercel Hobby, Vercel Sandbox, and Sandbox Drive limits; there is no formal SLA.
- Ten simultaneous conversations are a verification target, not a runtime cap.
- Data is retained indefinitely unless the operator removes or replaces Drive files outside the application.

## Functional requirements

| ID | Requirement | Rationale |
|---|---|---|
| REQ-F-001 | The system must accept private Telegram text messages from any Telegram user who can discover and message the bot. | The bot is a public conversational interface. |
| REQ-F-002 | The system must support `/start`, `/help`, and `/new` and must not treat other Telegram input types as model prompts. | The MVP input and command surface is intentionally narrow. |
| REQ-F-003 | `/start` must introduce the assistant without displaying a privacy or retention notice, and `/help` must describe the supported commands and text-only scope. | This is the confirmed onboarding behavior. |
| REQ-F-004 | Each Telegram user must have exactly one active conversation at a time. | This gives each user a clear current context. |
| REQ-F-005 | `/new` must archive the user's active conversation and create a new active conversation with no prior conversational context. | Users need an explicit context reset while retained history remains inspectable. |
| REQ-F-006 | Each DeepSeek request must include the configurable system prompt and at most the 20 most recent user/assistant message pairs from the active conversation. | This is the confirmed memory window. |
| REQ-F-007 | The system must call the DeepSeek API using model identifier `deepseek-v4-pro`. | This is the requested production model identifier. |
| REQ-F-008 | Thinking mode must default to enabled, its enabled state must be configurable through a Vercel environment variable, reasoning effort must default to `medium`, and hidden reasoning must never be sent to Telegram or stored as assistant-visible message content. | Reasoning behavior must be configurable without exposing private model reasoning. |
| REQ-F-009 | The default system prompt must instruct the model to be a helpful, accurate, safe general-purpose assistant, and its complete content must be configurable through a Vercel environment variable. | Operators need prompt control without a code change. |
| REQ-F-010 | The assistant must answer in the language of the user's latest message unless the user requests another language. | Conversations must adapt automatically to users. |
| REQ-F-011 | Messages from the same Telegram user must be processed sequentially in arrival order, without overlapping model responses for that user. | Conversation order and context must remain coherent. |
| REQ-F-012 | Different users' conversations may be processed concurrently, while every mutation of Drive files must pass through one serialized writer queue. | Users need concurrency without violating the Drive's single-writer constraint or corrupting files. |
| REQ-F-013 | While generating a response, the system must send Telegram typing activity; it must request one non-streamed final answer, preserve Telegram-supported Markdown where possible, and split overlong answers into valid Telegram messages. | The response experience must remain clear and compatible with Telegram. |
| REQ-F-014 | On transient DeepSeek, Sandbox controller, or Drive-access failures, the system must retry the failed operation up to two times with short backoff; after exhaustion it must send a generic retry-later message when Telegram delivery is available. | Temporary failures should recover without exposing internals. |
| REQ-F-015 | The system must prevent duplicate Telegram update deliveries from producing duplicate persisted prompts or duplicate assistant replies. | Telegram webhooks may redeliver updates. |
| REQ-F-016 | The system must persist each Telegram user's Telegram user ID, username, language code, first-seen timestamp, and last-seen timestamp whenever supplied by Telegram. | These are the confirmed user attributes needed for inspection. |
| REQ-F-017 | The system must not persist Telegram first names or last names. | The operator explicitly limited profile collection. |
| REQ-F-018 | For each prompt and assistant response, the system must persist the conversation, role, complete text, Telegram identifiers when available, timestamps, processing and delivery status, DeepSeek model identifier, input/output token counts, latency, and sanitized error details where applicable. | The dashboard must expose complete conversation and operational records. |
| REQ-F-019 | Durable records for users, conversations, messages, usage, and errors must be written as append-only JSONL files on the Drive; small JSON files may be used only for indexes and mutable state. | This is the confirmed file-only persistence model. |
| REQ-F-020 | Each JSONL entry must be independently parseable, versioned, and identifiable; mutable JSON state and index replacements must be atomic, and derived indexes must be rebuildable from durable JSONL records. | File integrity and recovery must not depend on a database. |
| REQ-F-021 | A valid prompt must be durably recorded before its model call begins, and a completed assistant result must be durably recorded before Telegram delivery is attempted. | Crashes and delivery failures must leave a diagnosable, recoverable record. |
| REQ-F-022 | Conversations, messages, user events, usage metadata, idempotency records, and sanitized error records must be retained indefinitely, with no application-managed expiry or deletion. | The operator declined retention limits and deletion features. |
| REQ-F-023 | The web interface must present a login form that accepts any non-empty string and grants access only when it securely matches the administrator secret configured in Vercel. | Dashboard access is based solely on possession of the configured secret. |
| REQ-F-024 | Successful dashboard login must create a 24-hour session using an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; logout must immediately clear the session. | Authentication must not expose the secret after login. |
| REQ-F-025 | The administrator secret must never be placed in a URL, browser storage, Drive file, application log, downloadable archive, or client bundle. | Secret leakage would expose all retained data. |
| REQ-F-026 | The authenticated dashboard must be read-only and show overview totals, Telegram users, conversations, full message histories, DeepSeek usage and latency metadata, estimated costs, and sanitized application errors. | Operators need comprehensive inspection without mutation. |
| REQ-F-027 | Dashboard users, conversations, messages, usage records, and errors must be searchable where text or identifiers are applicable and paginated. | Persisted data must remain navigable as it grows. |
| REQ-F-028 | Dashboard data must update on page load, navigation, or manual browser refresh only. | Live updates and polling are excluded from the MVP. |
| REQ-F-029 | `GET /api/download` must accept either a valid dashboard session cookie or `Authorization: Bearer <ADMIN_SECRET>` and reject all other requests without exposing protected data. | The archive must work for both the dashboard and programmatic clients. |
| REQ-F-030 | The download API must wait for pending Drive writes to finish, flush durable file state, and return a consistent point-in-time ZIP containing all persisted application data files and no secrets, transient runtime files, or application binaries. | A downloaded archive must be internally consistent and safe to retain. |
| REQ-F-031 | The download response must use a ZIP content type, an attachment filename containing an unambiguous UTC timestamp, and no-store cache headers. | Clients must handle the archive predictably without caching sensitive data. |
| REQ-F-032 | The system must store provider-reported input and output token counts and calculate estimated costs using configurable input and output price values supplied through Vercel environment variables. | Estimates must remain adjustable when DeepSeek pricing changes. |
| REQ-F-033 | The application must not impose per-user, global, concurrency, message, storage, archive-download, or dashboard-login attempt limits or lockouts. | The operator explicitly rejected application-defined limits. |
| REQ-F-034 | The model integration boundary must permit later addition of web search, MCP, function calling, and sandboxed code execution without coupling those capabilities to Telegram transport, file persistence, or dashboard presentation. | Future agent enhancements are anticipated even though they are out of scope now. |

## Non-functional requirements

| ID | Quality attribute | Measurable requirement |
|---|---|---|
| REQ-NF-001 | Platform compatibility | Production must run as a Next.js application on Vercel Hobby and use Vercel Sandbox plus exactly one named Sandbox Drive for durable application data. |
| REQ-NF-002 | Region consistency | The Drive and every Sandbox that mounts it must be created explicitly in Singapore (`sin1`); the application must not rely on Vercel's default region. |
| REQ-NF-003 | File-only durability | Automated inspection must demonstrate that all durable application state is represented by ordinary JSONL/JSON files on the Drive and that no database, object store, or second persistent datastore is required. |
| REQ-NF-004 | Concurrency isolation | Automated verification must exercise 10 simultaneous conversations and demonstrate that no prompt, response, active-conversation state, or context crosses between Telegram users and that serialized writes remain valid JSONL/JSON. |
| REQ-NF-005 | File integrity | Abrupt interruption during an append or atomic state replacement must not corrupt previously committed records; startup validation must detect and safely isolate or recover an incomplete trailing record. |
| REQ-NF-006 | Recoverability | Given intact JSONL sources and missing or invalid derived indexes, the application must rebuild usable indexes without fabricating or silently discarding committed records. |
| REQ-NF-007 | Security | Telegram, DeepSeek, session-signing, webhook-validation, dashboard, bearer-token, pricing, and Sandbox configuration secrets must remain server-side and absent from client bundles, Drive data, archives, and user-visible errors. |
| REQ-NF-008 | Authentication | Secret comparison and session validation must fail closed for missing, empty, malformed, expired, or invalid credentials; authenticated routes must not return protected content without a valid cookie or bearer credential. |
| REQ-NF-009 | Privacy | Persisted profile data must be limited to the fields in REQ-F-016, and diagnostics must be sanitized so credentials, authorization headers, cookies, tokens, and raw provider secrets are never stored. |
| REQ-NF-010 | Reliability | Duplicate Telegram updates must be idempotent, per-user processing must preserve arrival order, all Drive mutations must be serialized, and transient-operation retry count must never exceed two retries after the initial attempt. |
| REQ-NF-011 | Observability | Each model operation must be diagnosable from persisted status, timestamps, latency, model identifier, token counts when provided, and sanitized error classification without requiring ephemeral infrastructure logs. |
| REQ-NF-012 | Accessibility | The dashboard must support keyboard navigation, programmatically labeled controls, visible focus, and color contrast conforming to WCAG 2.2 AA. |
| REQ-NF-013 | Responsive compatibility | The dashboard must be usable without horizontal page scrolling at 320 CSS pixels and on the current stable versions of Chrome, Firefox, Safari, and Edge at implementation time. |
| REQ-NF-014 | Extensibility | Telegram transport, conversation orchestration, model access, Drive-file persistence, archive generation, and dashboard querying must have separately testable module boundaries. |
| REQ-NF-015 | Availability | The application has no formal uptime or response-time SLA; it must fail safely when Hobby quota is exhausted, a Sandbox session restarts, the writer is temporarily unavailable, or the beta Drive service is unavailable. |
| REQ-NF-016 | Archive consistency | A verification test with concurrent writes and a download request must show that every archived JSONL line parses and the archive represents a single flush boundary rather than a mixture of partially written state. |

## Constraints

- The project name and specification path are `telegram-agent` and `specs/telegram-agent/`.
- This is a greenfield project in an initially empty workspace.
- The required stack is Next.js on Vercel Hobby, Vercel Sandbox, and Vercel Sandbox Drive.
- Durable application persistence must use ordinary files only; PostgreSQL, SQLite, relational databases, document databases, key-value databases, object stores, and other persistent services are prohibited.
- The operator will provide the Telegram bot token, DeepSeek API key, administrator secret, session-signing secret, and other required configuration as Vercel environment variables.
- The administrator secret may be any non-empty string; it is not restricted to UUID syntax.
- The production model identifier is `deepseek-v4-pro` through the DeepSeek API.
- The Drive and its writer Sandbox must use Singapore (`sin1`). A Drive's region cannot be changed after creation.
- Only one Sandbox may mount the Drive read-write at a time. All file mutations must flow through one serialized writer.
- Ordinary Vercel Functions cannot mount the Drive; Drive data access must occur through Vercel Sandbox compute.
- Vercel Hobby Sandbox sessions have a maximum duration and quota-bound creation/compute/storage/I/O. The controller must tolerate stop/resume or replacement without assuming continuous compute.
- A Drive-mounted Sandbox cannot use regional failover because the Drive exists in one region.
- Vercel Sandbox Drive is beta; best-effort operation and temporary unavailability are accepted.
- No separate moderation provider, cache, external queue, realtime service, or additional persistent datastore is required by the MVP.

## Confirmed assumptions

- Telegram users interact with the bot through private chats.
- Users may send messages in any language supported by the selected model.
- The Vercel project permits Sandbox and Drive use on the Hobby plan and has sufficient remaining platform quota at the time of each operation.
- The named Drive is created in `sin1` before production traffic and is not independently attached read-write by an operator while the application writer is active.
- Provider-reported token usage may be absent on a failed model call; such a failure may therefore have no token counts.
- Anyone possessing the dashboard secret is intentionally considered an authorized dashboard and download client.
- A consistent archive may take longer to produce because it waits behind pending writes.
- Best-effort operation beyond the verified 10-conversation scenario is acceptable.

## Dependencies

- Telegram Bot API and a bot token supplied by the operator.
- DeepSeek API, a funded/usable API key supplied by the operator, and availability of `deepseek-v4-pro`.
- Vercel Hobby project capabilities for Next.js Functions, environment variables, Sandbox, and Sandbox Drive.
- `@vercel/sandbox` or the current supported Vercel Sandbox SDK with Drive support.
- Current stable web browsers for dashboard use.

## Edge cases

| ID | Scenario | Required behavior |
|---|---|---|
| EDGE-001 | Telegram redelivers an already processed update. | The system recognizes it as a duplicate and creates neither a duplicate prompt record nor a duplicate response. |
| EDGE-002 | A user sends a second text while the first is processing. | The second text waits and is processed after the first response using the resulting ordered context. |
| EDGE-003 | A user sends `/new` while another message is processing. | `/new` is processed in arrival order; earlier work completes against the former conversation, then a new empty active conversation is created. |
| EDGE-004 | A user sends a photo, file, voice note, sticker, contact, location, edited message, inline query, or group-chat message. | The input is not sent to DeepSeek or persisted as conversational message content; private unsupported inputs receive concise text-only guidance when Telegram permits. |
| EDGE-005 | DeepSeek returns an answer longer than Telegram permits in one message. | The answer is divided into ordered, valid Telegram messages without losing text. |
| EDGE-006 | Returned Markdown cannot be sent using Telegram's supported parse mode. | The system retries delivery as escaped or plain text without calling DeepSeek again. |
| EDGE-007 | DeepSeek succeeds but the Telegram response cannot be delivered. | The assistant result and failed delivery status remain in Drive files with sanitized failure details; applicable retries follow the confirmed policy. |
| EDGE-008 | The Drive writer is unavailable before a prompt can be safely recorded. | The model is not called; retries are attempted and a generic retry-later Telegram message is sent if possible. |
| EDGE-009 | A Sandbox session reaches the Hobby duration limit or stops between requests. | A later request resumes or creates same-region Sandbox compute, remounts the existing Drive, validates file state, and continues without treating ephemeral filesystem data as durable. |
| EDGE-010 | Another Sandbox already holds the Drive's read-write attachment. | The controller reconnects to the intended writer when possible or fails safely and retries; it must not create a competing writer or fall back to another datastore. |
| EDGE-011 | A process stops during a JSONL append. | Previously committed lines remain usable; an incomplete trailing line is detected and isolated or repaired before new writes. |
| EDGE-012 | A JSON index or mutable state file is missing, stale, or malformed. | The system rebuilds it from committed JSONL records or fails closed with a sanitized error; it does not fabricate history. |
| EDGE-013 | Token usage is omitted by DeepSeek. | The response remains valid; token counts and estimated cost are recorded as unavailable rather than fabricated. |
| EDGE-014 | No prior active conversation exists for a valid user message. | The system creates one before persisting and processing the prompt. |
| EDGE-015 | The dashboard secret is missing or empty in the deployment environment. | Dashboard and download authentication fail closed and protected data remains unavailable. |
| EDGE-016 | A dashboard session or bearer authorization is expired, malformed, or invalid. | The request receives an unauthenticated response without protected data; browser navigation may redirect to login. |
| EDGE-017 | Search returns no dashboard records or a requested page is beyond the result set. | The dashboard shows an empty state and no fabricated records. |
| EDGE-018 | Configured pricing is missing or invalid. | Token counts remain visible and estimated cost is shown as unavailable. |
| EDGE-019 | The configured thinking-mode value is missing or invalid. | Thinking mode uses the confirmed enabled default. |
| EDGE-020 | A download starts while writes are queued. | The archive waits for the writer barrier and contains the last fully flushed state, without partial JSONL or temporary files. |
| EDGE-021 | The archive cannot be completed because of quota, Drive, or Sandbox failure. | The endpoint returns a sanitized error and no partial ZIP as a successful response. |
| EDGE-022 | The Drive approaches or reaches a Vercel storage or I/O quota. | The application exposes a sanitized operational error and fails safely; it does not delete data, impose an application storage cap, or switch persistence systems. |

## Acceptance criteria

| ID | Related requirements | Criterion |
|---|---|---|
| AC-001 | REQ-F-001, REQ-F-007, REQ-F-010 | Given a new Telegram user in a private chat, when the user sends valid text in a supported language, then the bot returns a `deepseek-v4-pro` answer in that language unless the prompt requests another. |
| AC-002 | REQ-F-002, REQ-F-003 | Given a private chat, when the user invokes `/start` or `/help`, then the bot returns the defined onboarding or help text; unsupported content is never submitted to DeepSeek. |
| AC-003 | REQ-F-004, REQ-F-005, REQ-F-006 | Given an existing conversation, when `/new` is processed and the next prompt is sent, then archived messages are absent from the next model request and no request contains more than 20 recent message pairs. |
| AC-004 | REQ-F-008, REQ-F-009 | Given valid environment configuration, when a model request is inspected, then it contains the configured system prompt and thinking state, defaults reasoning effort to `medium`, and neither Telegram nor stored assistant text contains hidden reasoning. |
| AC-005 | REQ-F-011, REQ-F-012, REQ-NF-004 | Given 10 simultaneous conversations including multiple messages from one user, when all complete, then each user's replies and contexts remain isolated, per-user outputs preserve arrival order, and every persisted line parses. |
| AC-006 | REQ-F-013 | Given a response exceeding Telegram's single-message length, when it is delivered, then the user receives the complete response in ordered valid chunks and observed typing activity precedes completion. |
| AC-007 | REQ-F-014, REQ-NF-015 | Given a transient dependency failure followed by recovery within two retries, then processing succeeds; given continued failure, no third retry occurs and the user receives the generic error when delivery is possible. |
| AC-008 | REQ-F-015, REQ-NF-010 | Given the same Telegram update delivered more than once, when all deliveries complete, then Drive records contain one prompt and the user receives at most one model-generated reply for it. |
| AC-009 | REQ-F-016, REQ-F-017, REQ-NF-009 | Given Telegram supplies all profile fields, when persisted user data is inspected, then it contains the confirmed five profile attributes and contains no first-name or last-name field/value. |
| AC-010 | REQ-F-018 through REQ-F-022, REQ-NF-003, REQ-NF-005, REQ-NF-006 | Given successful and failed operations plus a simulated interrupted append and deleted indexes, when recovery completes, then committed history remains valid, indexes rebuild, required records are present, and no database or non-Drive durable store exists. |
| AC-011 | REQ-F-023 through REQ-F-025, REQ-NF-007, REQ-NF-008 | Given the configured secret, when a visitor logs in, then a protected page loads through a 24-hour secure cookie and logout invalidates access; invalid or absent credentials expose no protected data or secret material. |
| AC-012 | REQ-F-026 through REQ-F-028 | Given persisted Drive data and a valid session, when the visitor navigates, searches, paginates, and manually refreshes, then all dashboard categories are inspectable read-only and changes appear after navigation or refresh. |
| AC-013 | REQ-F-029 through REQ-F-031, REQ-NF-016 | Given pending writes and either supported authentication method, when a download is requested, then it waits for a flush barrier and returns a no-store timestamped ZIP whose data files all parse; invalid authentication returns no archive. |
| AC-014 | REQ-F-032 | Given provider token counts and valid configured prices, when usage is displayed, then estimated input/output/total cost matches the configured arithmetic; missing inputs show unavailable. |
| AC-015 | REQ-F-033 | Given traffic beyond any previously discussed quantity, repeated downloads, or repeated failed logins, when requests arrive, then the application does not reject them because of an application-defined quota, throttle, lockout, or storage cap. |
| AC-016 | REQ-F-034, REQ-NF-014 | Given the implemented module boundaries, when model and persistence integrations are replaced with test doubles, then Telegram processing and dashboard querying can be exercised without a live model or future tool implementation. |
| AC-017 | REQ-NF-001 through REQ-NF-003 | Given production configuration, when the application is deployed, then the Drive and writer Sandbox report `sin1`, all durable application data appears only as files on the named Drive, and no database connection is configured or required. |
| AC-018 | REQ-NF-012, REQ-NF-013 | Given the dashboard at 320 CSS pixels and current stable target browsers, when evaluated by automated accessibility checks and keyboard inspection, then it has no horizontal page scrolling, controls remain operable and labeled, focus is visible, and contrast meets WCAG 2.2 AA. |
| AC-019 | REQ-NF-015, EDGE-009, EDGE-010 | Given a stopped writer Sandbox or temporarily occupied Drive, when a request arrives, then the controller either safely restores access to the intended single writer or returns the confirmed generic failure without creating a second writer or losing committed files. |

## NOT-TO-DOs

| ID | Explicit exclusion | Reason |
|---|---|---|
| NTD-001 | Do not implement or configure PostgreSQL, SQLite, another database, object storage, or a second persistent datastore. | All durable application data must be ordinary files on Vercel Sandbox Drive. |
| NTD-002 | Do not store durable data in an ordinary Vercel Function filesystem or in a Sandbox's ephemeral filesystem outside the mounted Drive. | Those locations are not the approved persistence layer. |
| NTD-003 | Do not implement Telegram group chats, channels, inline mode, edited-message processing, or non-text conversational inputs. | The confirmed MVP is private text chat only. |
| NTD-004 | Do not implement web search, MCP, function calling, code execution, tools, scheduled actions, or other external-agent capabilities. | These are future extensions. |
| NTD-005 | Do not implement a separate moderation API, keyword filter, or administrator user-blocking controls. | The MVP relies on DeepSeek behavior and the system prompt. |
| NTD-006 | Do not implement application-level rate limits, quotas, traffic caps, storage caps, login throttling, CAPTCHA, IP restrictions, or account lockouts. | The operator explicitly rejected application-defined restrictions and limitations. |
| NTD-007 | Do not implement user-facing deletion, retention expiry, or dashboard editing; the authenticated ZIP download is the only dashboard-adjacent data action. | Persistence is indefinite and the dashboard is otherwise read-only. |
| NTD-008 | Do not add a `/start` privacy or data-retention notice. | The operator explicitly declined it. |
| NTD-009 | Do not persist Telegram first names, last names, unsupported-input content, hidden model reasoning, credentials, authorization headers, cookies, or raw provider secrets. | These values are outside the confirmed data scope or security boundary. |
| NTD-010 | Do not implement live dashboard updates, polling, push notifications, or charts. | Dashboard refresh is manual and overview presentation excludes charts. |
| NTD-011 | Do not create multiple concurrent Drive writers or use Drive snapshots as writable copies. | The persistence model requires a single authoritative serialized writer. |
| NTD-012 | Do not expose hidden DeepSeek reasoning to users, dashboard visitors, Drive files, or downloads. | Only final assistant answers are in scope. |
| NTD-013 | Do not begin application implementation within the SDD specification workflow. | SDD ends with an approved implementation handoff. |

## Risks

| ID | Risk | Impact | Mitigation or decision |
|---|---|---|---|
| RISK-001 | Vercel Sandbox Drive is beta and may change or become unavailable. | Bot, dashboard, and download interruption or future migration work. | Accepted explicitly; isolate the file persistence adapter and fail safely. |
| RISK-002 | Hobby Sandbox sessions and monthly quotas can stop compute or prevent new Sandbox creation. | Delayed or failed replies and downloads. | Accepted explicitly as best-effort; resume/recreate on demand, persist only on the Drive, and expose generic failures. |
| RISK-003 | A Drive allows one read-write mount and has no regional failover. | A stale attachment or `sin1` outage can block all mutations. | Use one named writer, reconnect rather than competing, serialize mutations, and accept temporary unavailability. |
| RISK-004 | Append-only files and unbounded retention can grow until platform storage or I/O limits are reached. | Writes, reads, dashboard searches, or archives may fail. | Accepted explicitly; use partitionable/versioned files and rebuildable indexes, surface errors, and never silently delete or switch stores. |
| RISK-005 | A public bot without application rate limits can generate unbounded DeepSeek spend or exhaust provider/Vercel quotas. | Unexpected cost or service interruption. | Accepted explicitly; rely on provider/Vercel limits and dashboard visibility. |
| RISK-006 | Dashboard and bearer authentication have no throttling and are reachable by anyone. | Brute-force attempts may disclose all retained data if the secret is weak. | Accepted explicitly; operator must choose and protect a strong secret. |
| RISK-007 | Indefinite message retention without an in-app notice or deletion feature may create privacy or compliance exposure. | Sensitive user data may remain stored and downloadable by secret holders. | Accepted explicitly; the operator owns external policy and any out-of-band Drive-file removal. |
| RISK-008 | A crash during a file append or state replacement can leave a partial tail or stale index. | Parse failure, missing dashboard data, or duplicate work. | Use single-writer serialization, flush barriers, atomic replacement, startup validation, tail recovery, and index rebuilding. |
| RISK-009 | Generating a complete ZIP while data grows may be slow or exceed Hobby execution/resource limits. | Failed downloads or temporary blocking behind the writer barrier. | Consistency is prioritized over speed; fail without returning a successful partial archive. |
| RISK-010 | DeepSeek model identifiers, capabilities, or pricing may change. | Failed requests or inaccurate estimates. | Keep thinking, prompt, and price behavior configurable; retain the requested identifier and surface sanitized failures. |
| RISK-011 | Telegram Markdown parsing can reject otherwise valid model output. | A generated answer may fail delivery. | Retry delivery as escaped or plain text without regenerating the answer. |

## Resolved decisions

| Topic | Confirmed decision | Basis |
|---|---|---|
| Project context | Greenfield project named `telegram-agent`; specs in `specs/telegram-agent/`. | User confirmation. |
| Primary experience | General-purpose conversational assistant in Telegram. | User confirmation. |
| Bot audience | Anyone who discovers the bot. | User confirmation. |
| Dashboard/download audience | Anyone who supplies the configured secret. | User confirmation. |
| Dashboard authentication | Login form, arbitrary non-empty secret, secure 24-hour session cookie, and logout. | User confirmation. |
| Download authentication | Same administrator secret via a valid dashboard session or bearer authorization. | User confirmation. |
| Download output | Consistent point-in-time ZIP of all persisted application data after pending writes flush. | User confirmation. |
| Telegram scope | Private text chats with `/start`, `/help`, and `/new`; other inputs excluded. | User confirmation. |
| Conversation memory | One active conversation per user; `/new` archives; 20 recent message pairs; indefinite history. | User confirmation. |
| Model | DeepSeek API model `deepseek-v4-pro`; configurable thinking mode default enabled; medium reasoning effort; final answer only. | User confirmation. |
| Response behavior | Typing indicator, non-streamed generation, Markdown preservation, and safe splitting. | User confirmation. |
| Failure behavior | Up to two short-backoff retries, persisted sanitized failure, and generic user error. | User confirmation. |
| Language | Match the latest user-message language unless instructed otherwise. | User confirmation. |
| Ordering | Per-user sequential processing; cross-user concurrency allowed. | User confirmation. |
| File writes | All Drive mutations serialized through one writer queue. | User confirmation. |
| Stored user fields | Telegram ID, username, language code, first-seen, and last-seen only. | User correction and confirmation. |
| Stored message fields | Full text and confirmed identity, status, usage, latency, and sanitized-error metadata. | User confirmation. |
| Persistence | No database; append-only JSONL records plus small JSON index/state files on one Sandbox Drive. | User correction and confirmation. |
| Region | Singapore (`sin1`) for both the Drive and Drive-mounted Sandbox. | User confirmation. |
| Platform availability | Vercel Hobby and beta Drive constraints accepted as best-effort. | User confirmation. |
| Dashboard | Read-only totals and record views with search/pagination; manual refresh; no charts. | User confirmation. |
| Cost estimates | Persist tokens; calculate using environment-configured prices. | User confirmation. |
| Limits | No application-defined usage, concurrency, message, storage, download, or login restrictions. | User confirmation. |
| Verification concurrency | Demonstrate 10 simultaneous conversations without using that number as a runtime cap. | Previously approved requirement retained. |
| Moderation | DeepSeek and system prompt only; no separate moderation or blocking system. | User confirmation. |
| Future capabilities | Web search, MCP, function calls, and code execution excluded now but supported by modularity. | User confirmation. |
| Responsive accessibility | Current desktop/mobile browsers, keyboard usability, labels, visible focus, and WCAG 2.2 AA contrast. | User confirmation. |

## Repository evidence

Not applicable — this is a greenfield project and the workspace contains only SDD artifacts.

## Platform references

- [Vercel Sandbox Drive documentation](https://vercel.com/docs/sandbox/concepts/drives)
- [Vercel Sandbox regions](https://vercel.com/docs/sandbox/concepts/regions)
- [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing)
