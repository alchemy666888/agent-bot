# Exception logs on Vercel Hobby

The app writes redacted, structured JSON to the Vercel Function console. No paid logging integration, drain, or API token is required.

Open the Vercel project **agent-bot → Logs**, select the environment/deployment and filter **Level: Error**. Expand a request to see its function messages. Search by `correlationId` to connect webhook, provider, background and worker failures. Recovered/degraded structured events use Warning; completed operations use Info.

Exception records include the operation/stage, an error code, redacted cause messages and bounded file/line traces. For nested exceptions, `metadata.causes` records each cause and aggregate member with its own trace. `metadata.error.detail` starts with the root cause when a chain exists. Request headers, bodies, prompts, model reasoning, and arbitrary error properties are never copied into exception records.

Next.js `onRequestError` covers uncaught rendering, route and Server Action errors. `uncaughtExceptionMonitor` observes fatal Node errors (including fatal unhandled rejections) while preserving Node's normal shutdown behavior. Handled webhook, failed-notification, persistence, configuration, download and model-recovery failures log before returning or recovering. Validated worker error envelopes are forwarded from subprocess stderr and failed worker responses into Function logs; raw command output is never forwarded.

Deploy the changed source to activate these hooks. Verify on a preview deployment by inducing a controlled server/provider failure, then search for its `correlationId` in Logs and confirm the error and cause are present without credentials. Do not add a public crash endpoint to production.

Hobby runtime log retention and platform logging limits apply; check recent errors promptly. These logs cover server execution: browser-only errors are not automatically sent to Vercel. Hard platform termination (such as a function timeout or out-of-memory kill) may prevent application logging; inspect the platform's request/failure entry for those cases.
