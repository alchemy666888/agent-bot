# Requirements: Telegram Agent

Status: Draft

## Objective

Deliver a publicly accessible, general-purpose conversational AI assistant through private Telegram chats, powered by the DeepSeek API, with complete PostgreSQL persistence and a secret-protected, read-only web dashboard for operational inspection.

## Background

This is a greenfield project. The application will run on the Vercel Hobby plan using Next.js. Telegram is the end-user interface, `deepseek-v4-pro` is the language model, and a user-provided PostgreSQL connection is the system of record. The web interface allows anyone possessing a configured secret to inspect persisted operational data.

## Stakeholders and users

- Telegram users: anyone who discovers the bot and starts a private chat.
- Dashboard visitors: anyone who knows the configured administrator secret.
- Operator: configures Vercel environment variables, Telegram, DeepSeek, and PostgreSQL credentials and monitors persisted data.
- Maintainers: implement, test, deploy, and later extend the agent.

## Scope

### In scope

- Public, private-chat Telegram text conversations.
- A general-purpose, multilingual DeepSeek-powered assistant.
- Persistent users, conversations, messages, usage metadata, and sanitized failures.
- A secret-authenticated, read-only web dashboard.
- Vercel Hobby deployment and externally supplied PostgreSQL connectivity.
- Modular model integration that can support future agent capabilities without including them in this release.

### Boundaries

- The MVP supports Telegram private chats only.
- Telegram input is limited to text messages and the `/start`, `/help`, and `/new` commands.
- The assistant is conversational only and cannot invoke tools or external actions.
- Capacity is best-effort within Telegram, DeepSeek, Vercel Hobby, and the supplied PostgreSQL service; there is no formal SLA.
- Ten simultaneous conversations are a verification target, not a runtime cap.
- Data is retained indefinitely in the MVP.

## Functional requirements

| ID | Requirement | Rationale |
|---|---|---|
| REQ-F-001 | The system must accept private Telegram text messages from any Telegram user who can discover and message the bot. | The bot is a public conversational interface. |
| REQ-F-002 | The system must support `/start`, `/help`, and `/new` and must not treat other Telegram input types as model prompts. | The MVP input and command surface is intentionally narrow. |
| REQ-F-003 | `/start` must introduce the assistant without displaying a privacy or retention notice, and `/help` must describe the supported commands and text-only scope. | This is the confirmed onboarding behavior. |
| REQ-F-004 | Each Telegram user must have exactly one active conversation at a time. | This gives each user a clear current context. |
| REQ-F-005 | `/new` must archive the user's active conversation and create a new active conversation with no prior conversational context. | Users need an explicit context reset while history remains inspectable. |
| REQ-F-006 | Each DeepSeek request must include the configurable system prompt and at most the 20 most recent user/assistant message pairs from the active conversation. | This is the confirmed memory window. |
| REQ-F-007 | The system must call the DeepSeek API using model identifier `deepseek-v4-pro`. | The requested V4 Pro model is available under this API identifier. |
| REQ-F-008 | Thinking mode must default to enabled, its enabled state must be configurable through a Vercel environment variable, reasoning effort must default to `medium`, and hidden reasoning must never be sent to Telegram or stored as assistant-visible message content. | Reasoning behavior must be configurable without exposing private model reasoning. |
| REQ-F-009 | The default system prompt must instruct the model to be a helpful, accurate, safe general-purpose assistant, and its complete content must be configurable through a Vercel environment variable. | Operators need prompt control without a code change. |
| REQ-F-010 | The assistant must answer in the language of the user's latest message unless the user requests another language. | Conversations must adapt automatically to users. |
| REQ-F-011 | Messages from the same Telegram user must be processed sequentially in arrival order, without overlapping model responses for that user. | Conversation order and context must remain coherent. |
| REQ-F-012 | While generating a response, the system must send Telegram typing activity; it must request one non-streamed final answer, preserve Telegram-supported Markdown where possible, and split overlong answers into valid Telegram messages. | The response experience must remain clear and compatible with Telegram. |
| REQ-F-013 | On transient DeepSeek or PostgreSQL failures, the system must retry the failed operation up to two times with short backoff; after exhaustion it must send a generic retry-later message when Telegram delivery is available. | Temporary failures should recover without exposing internals. |
| REQ-F-014 | The system must prevent duplicate Telegram update deliveries from producing duplicate persisted prompts or duplicate assistant replies. | Telegram webhooks may redeliver updates. |
| REQ-F-015 | The system must persist each Telegram user's Telegram user ID, username, language code, first-seen timestamp, and last-seen timestamp whenever supplied by Telegram. | These are the confirmed user attributes needed for inspection. |
| REQ-F-016 | The system must not persist Telegram first names or last names. | The operator explicitly limited profile collection. |
| REQ-F-017 | For each prompt and assistant response, the system must persist the conversation, role, complete text, Telegram message ID when available, timestamps, processing status, DeepSeek model identifier, input/output token counts, latency, and sanitized error details where applicable. | The dashboard must expose complete conversation and operational records. |
| REQ-F-018 | Conversations, messages, user records, usage metadata, authentication-attempt records if any arise from ordinary logs, and application error records must be retained indefinitely unless the database operator removes them outside the application. | The MVP has no retention expiry or deletion feature. |
| REQ-F-019 | The web interface must present a login form that accepts any non-empty string and grants access only when it securely matches the administrator secret configured in Vercel. | Dashboard access is based solely on possession of the configured secret. |
| REQ-F-020 | Successful dashboard login must create a 24-hour session using an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; logout must immediately clear the session. | Authentication must not expose the secret after login. |
| REQ-F-021 | The administrator secret must never be placed in a URL, browser storage, application log, or PostgreSQL record. | Secret leakage would expose all persisted data. |
| REQ-F-022 | The authenticated dashboard must be read-only and show overview totals, Telegram users, conversations, full message histories, DeepSeek usage and latency metadata, estimated costs, and sanitized application errors. | Operators need comprehensive inspection without mutation. |
| REQ-F-023 | Dashboard users, conversations, messages, usage records, and errors must be searchable where text or identifiers are applicable and paginated. | Persisted data must remain navigable as it grows. |
| REQ-F-024 | Dashboard data must update on page load or manual browser refresh only. | Real-time behavior is excluded from the MVP. |
| REQ-F-025 | The system must store provider-reported input and output token counts and calculate estimated costs using configurable input and output price values supplied through Vercel environment variables. | Estimates must remain adjustable when DeepSeek pricing changes. |
| REQ-F-026 | The application must not impose per-user, global, concurrency, storage, or dashboard-login attempt limits or lockouts. | The operator explicitly rejected application-level limits. |
| REQ-F-027 | The model integration boundary must permit later addition of web search, MCP, function calling, and sandboxed code execution without coupling those capabilities to Telegram transport or dashboard presentation. | Future agent enhancements are anticipated even though they are out of scope now. |

## Non-functional requirements

| ID | Quality attribute | Measurable requirement |
|---|---|---|
| REQ-NF-001 | Platform compatibility | The production application must run as a Next.js application on the Vercel Hobby plan and use a standards-compatible, externally supplied PostgreSQL connection. |
| REQ-NF-002 | Concurrency isolation | Automated verification must exercise 10 simultaneous conversations and demonstrate that no prompt, response, active-conversation state, or context crosses between Telegram users. |
| REQ-NF-003 | Security | Telegram, DeepSeek, PostgreSQL, session-signing, webhook-validation, dashboard, and pricing configuration secrets must remain server-side and must not be present in client bundles or user-visible errors. |
| REQ-NF-004 | Authentication | Secret comparison and session validation must fail closed for missing, empty, malformed, expired, or invalid credentials; authenticated routes must not return protected content without a valid session. |
| REQ-NF-005 | Privacy | Persisted profile data must be limited to the fields in REQ-F-015, and diagnostic data must be sanitized so credentials, authorization headers, cookies, connection strings, and raw provider secrets are never stored. |
| REQ-NF-006 | Reliability | Duplicate Telegram updates must be idempotent, per-user processing must preserve arrival order, and transient-operation retry count must never exceed two retries after the initial attempt. |
| REQ-NF-007 | Observability | Each model operation must be diagnosable from persisted status, timestamps, latency, model identifier, token counts when provided, and sanitized error classification without access to infrastructure logs. |
| REQ-NF-008 | Accessibility | The dashboard must support keyboard navigation, programmatically labeled controls, visible focus, and color contrast conforming to WCAG 2.2 AA. |
| REQ-NF-009 | Responsive compatibility | The dashboard must be usable without horizontal page scrolling at 320 CSS pixels and on the current stable versions of Chrome, Firefox, Safari, and Edge at implementation time. |
| REQ-NF-010 | Extensibility | Telegram transport, conversation orchestration, model access, persistence, and dashboard querying must have separately testable module boundaries. |
| REQ-NF-011 | Availability | The application has no formal uptime or response-time SLA and must degrade with the confirmed generic error behavior when an external dependency is unavailable. |

## Constraints

- The project name and specification path are `telegram-agent` and `specs/telegram-agent/`.
- This is a greenfield project in an initially empty workspace.
- The required stack is Next.js, Vercel Cloud on the Hobby plan, and PostgreSQL.
- The operator will provide the PostgreSQL connection string and credentials as Vercel environment variables.
- The operator will provide the Telegram bot token, DeepSeek API key, administrator secret, and other required configuration as Vercel environment variables.
- The production model identifier is `deepseek-v4-pro` through the DeepSeek API.
- No separate moderation provider, cache, queue, realtime service, or additional persistent datastore is required by the MVP.
- Application behavior must remain within the capabilities and quotas of the selected external services without adding application-enforced usage caps.

## Confirmed assumptions

- Telegram users interact with the bot through private chats.
- Users may send messages in any language supported by the selected model.
- The supplied PostgreSQL service is reachable from Vercel and permits schema migrations and application reads/writes.
- Provider-reported token usage may be absent on a failed model call; such a failure may therefore have no token counts.
- Anyone possessing the dashboard secret is intentionally considered an authorized dashboard visitor.
- Best-effort operation beyond the verified 10-conversation concurrency scenario is acceptable.

## Dependencies

- Telegram Bot API and a bot token supplied by the operator.
- DeepSeek API, a funded/usable API key supplied by the operator, and availability of `deepseek-v4-pro`.
- An externally managed PostgreSQL database and valid connection credentials supplied by the operator.
- A Vercel account/project that can deploy the Next.js application on the Hobby plan and hold environment variables.
- Current stable web browsers for dashboard use.

## Edge cases

| ID | Scenario | Required behavior |
|---|---|---|
| EDGE-001 | Telegram redelivers an already processed update. | The system recognizes it as a duplicate and creates neither a duplicate prompt nor a duplicate response. |
| EDGE-002 | A user sends a second text while the first is processing. | The second text waits and is processed after the first response using the resulting ordered context. |
| EDGE-003 | A user sends `/new` while another message is processing. | `/new` is processed in arrival order; earlier work completes against the former conversation, then a new empty active conversation is created. |
| EDGE-004 | A user sends a photo, file, voice note, sticker, contact, location, edited message, inline query, or group-chat message. | The input is not sent to DeepSeek or persisted as conversational message content; private unsupported inputs receive a concise text-only guidance response when Telegram permits. |
| EDGE-005 | DeepSeek returns an answer longer than Telegram permits in one message. | The answer is divided into ordered, valid Telegram messages without losing text. |
| EDGE-006 | Returned Markdown cannot be sent using Telegram's supported parse mode. | The system retries delivery as escaped or plain text without calling DeepSeek again. |
| EDGE-007 | DeepSeek succeeds but the Telegram response cannot be delivered. | The assistant result and failed delivery status are retained with sanitized failure details; retries follow the confirmed retry policy where applicable. |
| EDGE-008 | PostgreSQL is unavailable before a prompt can be safely recorded. | The model is not called, retries are attempted, and a generic retry-later Telegram message is sent if possible. |
| EDGE-009 | Token usage is omitted by DeepSeek. | The response remains valid; token counts and estimated cost are recorded as unavailable rather than fabricated. |
| EDGE-010 | No prior active conversation exists for a valid user message. | The system creates one before persisting and processing the prompt. |
| EDGE-011 | The dashboard secret is missing or empty in the deployment environment. | Dashboard authentication fails closed and protected data remains unavailable. |
| EDGE-012 | A dashboard session is expired, malformed, or invalid. | The visitor is redirected to login without protected data in the response. |
| EDGE-013 | Search returns no dashboard records or a requested page is beyond the result set. | The dashboard shows an empty state and no fabricated records. |
| EDGE-014 | Configured pricing is missing or invalid. | Token counts remain visible and estimated cost is shown as unavailable. |
| EDGE-015 | The configured thinking-mode value is missing or invalid. | Thinking mode uses the confirmed enabled default. |

## Acceptance criteria

| ID | Related requirements | Criterion |
|---|---|---|
| AC-001 | REQ-F-001, REQ-F-007, REQ-F-010 | Given a new Telegram user in a private chat, when the user sends valid text in a supported language, then the bot returns a `deepseek-v4-pro` answer in that language unless the prompt requests another. |
| AC-002 | REQ-F-002, REQ-F-003 | Given a private chat, when the user invokes `/start` or `/help`, then the bot returns the defined onboarding or help text; unsupported content is never submitted to DeepSeek. |
| AC-003 | REQ-F-004, REQ-F-005, REQ-F-006 | Given an existing conversation, when `/new` is processed and the next prompt is sent, then the archived messages are absent from the next model request and no request contains more than 20 recent message pairs. |
| AC-004 | REQ-F-008, REQ-F-009 | Given valid environment configuration, when a model request is inspected, then it contains the configured system prompt and configured thinking state, defaults reasoning effort to `medium`, and neither Telegram nor stored assistant text contains hidden reasoning. |
| AC-005 | REQ-F-011, REQ-NF-002, REQ-NF-006 | Given 10 simultaneous conversations including multiple messages from one user, when all complete, then each user's replies and contexts remain isolated and that user's outputs preserve arrival order. |
| AC-006 | REQ-F-012 | Given a response exceeding Telegram's single-message length, when it is delivered, then the user receives the complete response in ordered valid chunks and observed typing activity precedes completion. |
| AC-007 | REQ-F-013, REQ-NF-011 | Given a transient dependency failure followed by recovery within two retries, then processing succeeds; given continued failure, no third retry occurs and the user receives the generic error when delivery is possible. |
| AC-008 | REQ-F-014, REQ-NF-006, EDGE-001 | Given the same Telegram update delivered more than once, when all deliveries complete, then the database contains one prompt and the user receives at most one model-generated reply for it. |
| AC-009 | REQ-F-015, REQ-F-016, REQ-NF-005 | Given Telegram supplies all profile fields, when the user record is inspected, then it contains the confirmed five profile attributes and contains no first-name or last-name field/value. |
| AC-010 | REQ-F-017, REQ-F-018, REQ-NF-007 | Given successful and failed model operations, when persisted records are inspected, then all applicable confirmed fields are present, failure details are sanitized, and no application expiry or deletion is scheduled. |
| AC-011 | REQ-F-019, REQ-F-020, REQ-F-021, REQ-NF-003, REQ-NF-004 | Given the configured secret, when a visitor logs in, then a protected page loads through a 24-hour secure cookie and logout invalidates access; invalid or absent credentials expose no protected data or secret material. |
| AC-012 | REQ-F-022, REQ-F-023, REQ-F-024 | Given persisted data and a valid session, when the visitor navigates, searches, paginates, and manually refreshes, then all dashboard categories are inspectable read-only and data changes appear only after navigation or refresh. |
| AC-013 | REQ-F-025 | Given provider token counts and valid configured prices, when usage is displayed, then the estimated input/output/total cost matches the configured per-token arithmetic; missing inputs show unavailable. |
| AC-014 | REQ-F-026 | Given traffic beyond any previously discussed quantity or repeated failed logins, when requests arrive, then the application does not reject them because of an application-defined quota, throttle, lockout, or storage cap. |
| AC-015 | REQ-F-027, REQ-NF-010 | Given the implemented module boundaries, when model integration tests substitute a test double, then Telegram processing and dashboard queries can be exercised without a live model and without importing future tool implementations. |
| AC-016 | REQ-NF-001 | Given production configuration, when the application is built and deployed, then it runs on Vercel Hobby, connects to the supplied PostgreSQL database, and requires no non-PostgreSQL persistent datastore. |
| AC-017 | REQ-NF-008, REQ-NF-009 | Given the dashboard at 320 CSS pixels and current stable target browsers, when evaluated by automated accessibility checks and keyboard inspection, then it has no horizontal page scrolling, controls remain operable and labeled, focus is visible, and color contrast meets WCAG 2.2 AA. |

## NOT-TO-DOs

| ID | Explicit exclusion | Reason |
|---|---|---|
| NTD-001 | Do not implement Telegram group chats, channels, inline mode, edited-message processing, or non-text conversational inputs. | The confirmed MVP is private text chat only. |
| NTD-002 | Do not implement web search, MCP, function calling, code execution, tools, scheduled actions, or other external-agent capabilities. | These are future extensions. |
| NTD-003 | Do not implement a separate moderation API, keyword filter, or administrator user-blocking controls. | The MVP relies on DeepSeek behavior and the system prompt. |
| NTD-004 | Do not implement application-level rate limits, quotas, traffic caps, storage caps, login throttling, CAPTCHA, IP restrictions, or account lockouts. | The operator explicitly rejected restrictions and limitations. |
| NTD-005 | Do not implement user-facing deletion, retention expiry, or dashboard edit, delete, or export actions. | Persistence is indefinite and the dashboard is read-only. |
| NTD-006 | Do not add a `/start` privacy or data-retention notice. | The operator explicitly declined it. |
| NTD-007 | Do not persist Telegram first names, last names, unsupported-input content, hidden model reasoning, credentials, raw authorization data, cookies, or connection strings. | These values are outside the confirmed data scope or security boundary. |
| NTD-008 | Do not implement live dashboard updates, polling, push notifications, or charts. | Dashboard refresh is manual and overview presentation does not include charts. |
| NTD-009 | Do not provision or require a specific PostgreSQL vendor. | The operator supplies an existing standards-compatible connection. |
| NTD-010 | Do not add a cache, queue, realtime service, or second persistent datastore as an MVP requirement. | The confirmed stack uses PostgreSQL as the system of record. |
| NTD-011 | Do not expose hidden DeepSeek reasoning to users or dashboard visitors. | Only final assistant answers are in scope. |
| NTD-012 | Do not begin application implementation within the SDD specification workflow. | SDD ends with an approved implementation handoff. |

## Risks

| ID | Risk | Impact | Mitigation or decision |
|---|---|---|---|
| RISK-001 | A public bot without application rate limits can generate unbounded DeepSeek spend or exhaust provider quotas. | Unexpected cost or service interruption. | Accepted explicitly; rely on provider/Vercel limits and dashboard visibility. |
| RISK-002 | Dashboard login has no throttling and is reachable by anyone. | Brute-force attempts may disclose all retained data if the secret is weak. | Accepted explicitly; operator must choose and protect a strong secret. |
| RISK-003 | Indefinite message retention without an in-app notice or deletion feature may create privacy or compliance exposure. | Sensitive user data may remain stored and visible to secret holders. | Accepted explicitly; the operator owns external policy and database-level removal. |
| RISK-004 | Vercel Hobby and external provider execution/connection limits can constrain slow reasoning requests and burst traffic. | Timeouts, failed replies, or reduced availability. | Best-effort service, retry/error behavior, and persisted diagnostics are accepted. |
| RISK-005 | PostgreSQL alone may not provide a perfect distributed per-user queue under high burst concurrency without careful locking. | Responses could reorder or duplicate. | Design must use transactional ordering/idempotency and verify 10 simultaneous conversations. |
| RISK-006 | DeepSeek model names, features, and pricing can change. | Requests or cost estimates may become inaccurate. | Use the confirmed stable API identifier and environment-configurable thinking and pricing values; surface failures. |
| RISK-007 | Telegram Markdown parsing can reject otherwise valid model output. | A generated answer may fail delivery. | Retry delivery as escaped or plain text without regenerating the answer. |
| RISK-008 | A supplied PostgreSQL database may be unreachable, incompatible, or undersized. | Deployment, migration, or runtime failure. | Validate connectivity and schema permissions during deployment; fail closed and report configuration errors. |

## Resolved decisions

| Topic | Confirmed decision | Basis |
|---|---|---|
| Project context | Greenfield project named `telegram-agent`; specs in `specs/telegram-agent/`. | Empty workspace inspection and user confirmation. |
| Primary experience | General-purpose conversational assistant in Telegram. | User confirmation. |
| Bot audience | Anyone who discovers the bot. | User confirmation. |
| Dashboard audience | Anyone who supplies the configured secret. | User confirmation. |
| Dashboard authentication | Login form, arbitrary non-empty secret, secure 24-hour session cookie, and logout. | User confirmation. |
| Telegram scope | Private text chats with `/start`, `/help`, and `/new`; other inputs excluded. | User confirmation. |
| Conversation memory | One active conversation per user; `/new` archives; 20 recent message pairs; indefinite history. | User confirmation. |
| Model | DeepSeek API model `deepseek-v4-pro`; configurable thinking mode default enabled; medium reasoning effort; final answer only. | User confirmation and official DeepSeek API documentation. |
| Response behavior | Typing indicator, non-streamed generation, Markdown preservation, and safe splitting. | User confirmation. |
| Failure behavior | Up to two short-backoff retries, persisted sanitized failure, and generic user error. | User confirmation. |
| Language | Match the latest user-message language unless instructed otherwise. | User confirmation. |
| Ordering | Per-user sequential arrival order. | User confirmation. |
| Stored user fields | Telegram ID, username, language code, first-seen, and last-seen only. | User correction and confirmation. |
| Stored message fields | Full text and confirmed identity, status, usage, latency, and sanitized-error metadata. | User confirmation. |
| Dashboard | Read-only totals and record views with search/pagination; manual refresh; no charts. | User confirmation. |
| Cost estimates | Persist tokens; calculate using environment-configured prices. | User confirmation. |
| Limits | No application-level usage, concurrency, storage, or login restrictions. | User confirmation. |
| Verification concurrency | Demonstrate 10 simultaneous conversations without using that number as a runtime cap. | User confirmation. |
| PostgreSQL | Operator supplies provider-independent connection string and credentials. | User confirmation. |
| Moderation | DeepSeek and system prompt only; no separate moderation or blocking system. | User confirmation. |
| Future capabilities | Web search, MCP, function calls, and code execution excluded now but supported by modularity. | User confirmation. |
| Responsive accessibility | Current desktop/mobile browsers, keyboard usability, labels, visible focus, and WCAG 2.2 AA contrast. | User confirmation. |

## Repository evidence

Not applicable — greenfield project.
