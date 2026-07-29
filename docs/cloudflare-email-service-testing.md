# Cloudflare Email Service test strategy

Research date: 2026-07-29

Context7 resolved the current Cloudflare Email Service documentation as
`/websites/developers_cloudflare_email-service`. The Cloudflare plugin guidance
and the current public documentation agree on the test layers below.

## Decision

Use five test layers. Do not use one test layer as proof for another layer.

1. Run unit tests with controlled binding fakes.
2. Run integration tests with local Cloudflare simulations.
3. Run opt-in tests with remote bindings and burner resources.
4. Run an opt-in test against a deployed burner Worker.
5. Ask a person to confirm the final mailbox result.

This split follows the Cloudflare development model. Local Worker code runs in
`workerd`. Bindings use local simulations by default. A binding can use a real
Cloudflare resource when its configuration has `remote = true`.
[Cloudflare Workers local development](https://developers.cloudflare.com/workers/local-development/)
lists D1, R2, Queues, and Email Bindings as supported for both local simulation
and remote binding connections.
[Supported bindings per development mode](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)

## What Cloudflare can test locally

### Email Routing

`wrangler dev` provides a local email-handler endpoint. Send an RFC 5322 message
to `/cdn-cgi/handler/email` with `from` and `to` query parameters. The message
must have a `Message-ID` header. This test exercises the Worker email handler,
message parsing, and routing logic.
[Email Routing local development](https://developers.cloudflare.com/email-service/local-development/routing/)

This endpoint does not test public MX records, an external SMTP connection, or
receipt at a forwarding mailbox. Those parts need a real domain and an external
sender.

### Email Sending

Email Sending has two local modes:

- Without `remote = true`, Wrangler does not send the message. It logs the
  message and saves the text and HTML parts to local files.
- With `remote = true`, the Worker still runs locally, but the binding sends a
  real message through Cloudflare Email Service.

Cloudflare recommends the remote binding for Email Service development. It also
warns that the binding sends real messages to real recipients.
[Email Sending local development](https://developers.cloudflare.com/email-service/local-development/sending/)

The local simulator cannot serialize an `ArrayBuffer` in attachment content.
Use string content for a local text attachment. Test a binary attachment on a
deployed Worker.
[Email Sending binary attachment limitation](https://developers.cloudflare.com/email-service/local-development/sending/#binary-attachments)

### D1, R2, and Queues

Use `@cloudflare/vitest-pool-workers` for Worker integration tests. Cloudflare
provides examples for D1 migrations, R2, and Queue producers and consumers.
[Workers Vitest recipes](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/)
The test API can apply D1 migrations and can create a real `MessageBatch` for a
Queue handler.
[Workers Vitest test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)

Wrangler also simulates a Queue locally with Miniflare. A local producer can
invoke a local consumer. Local Queue consumer concurrency is not supported.
Queues also do not support the legacy `wrangler dev --remote` mode.
[Queues local development](https://developers.cloudflare.com/queues/configuration/local-development/)
This restriction is different from a per-binding `remote = true` connection.

### Email Sending events

Cloudflare documents six Email Sending event types:

- `message.delivered`
- `message.deferred`
- `message.bounced`
- `message.failed`
- `message.rejected`
- `message.complained`

An Email Sending subscription sends these account events to a Queue. The
subscription is for one enabled sending domain.
[Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

Cloudflare does not document a local Email Sending event publisher. Therefore,
use the documented event JSON as deterministic Queue-handler fixtures. Use a
real subscription and a real send to test that Cloudflare publishes the event.
This conclusion is an inference from the local Queue and Email Service
documentation.

Email Routing actions do not produce Email Sending events. This exclusion
includes inbound forwards, replies, Worker routing actions, and delivery to a
verified routing recipient.
[Email Sending event scope](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## Recommended layers for mailsink

| Layer | Run time | Resources | What it proves |
| --- | --- | --- | --- |
| Unit tests | Every change | Hand-written fakes | Validation, state transitions, failure handling, and idempotency decisions |
| Local Cloudflare integration | Every change | Local D1, R2, Queue, and Email simulations | Real SQL and migrations, R2 behavior, Queue handler behavior, Worker runtime behavior, inbound RFC 5322 handling, and outbound message structure |
| Local Worker with remote bindings | Manual or protected CI | Burner D1, R2, Queue, sending domain, and recipients | Real binding authentication, real Email Service submission, and real Cloudflare resource APIs without a Worker deployment |
| Deployed burner test | Before release | Burner Worker, D1, R2, Queue, routing rule, and event subscription | Deployed bindings, public routing, binary attachments, and the event subscription to Queue consumer path |
| Mailbox acceptance | Before release | External sender and recipient mailboxes | Inbox or spam placement, forwarding receipt, rendered content, reply threading, and received authentication headers |

Do not point remote-binding tests at production resources. Cloudflare states
that remote writes change the selected resource and can incur normal service
costs.
[Remote binding considerations](https://developers.cloudflare.com/workers/local-development/#important-considerations)

## Deterministic test set

Keep the current fake-binding tests. They are useful for errors that are hard to
cause in Cloudflare, such as a D1 write failure after provider acceptance.

The repository has one Cloudflare Vitest integration file and one local
Wrangler smoke flow:

1. Apply `packages/worker/migrations` to local D1.
2. Run the HTTP API through the Worker's exported handler.
3. Assert the D1 rows and the R2 objects after send, repeat, delete, and purge.
4. Use a real Queue `MessageBatch` for each of the six documented event types.
5. Test duplicate events and events with an older timestamp.
6. Start `wrangler dev --local`.
7. POST `plain.eml` to `/cdn-cgi/handler/email`.
8. Assert the inbound D1 row, R2 object, alias state, and block behavior.
9. Call the outbound API with local Email simulation.
10. Inspect the saved text and HTML output.

`pnpm test` runs these tests. The files are
`packages/worker/test/cloudflare.integration.test.ts` and
`packages/worker/test/local-email-smoke.mjs`.

Use the documented event examples as fixtures. Do not wait for Cloudflare to
cause every rare lifecycle event in a live test.

## Remote-binding test set

Use a separate Wrangler configuration for burner resources. Set `remote = true`
only for the resources in this test. Keep this test out of the default
`pnpm test` command.

Test:

1. API authentication.
2. One rich send with To, CC, BCC, Reply-To, custom headers, HTML, text, and a
   text attachment.
3. The same request ID two times.
4. One valid recipient and one invalid recipient.
5. D1 and R2 state before and after delete and purge.

This layer sends real mail. It does not prove that a new local Queue-handler
change works. A remote event subscription invokes the consumer that is deployed
on Cloudflare, not an un-deployed local consumer.

## Deployed burner test set

Provision resources with unique names. Run these checks:

1. Deploy the Worker with its D1, R2, Email, and Queue bindings.
2. Create an exact Email Routing rule for the burner alias.
3. Create an Email Sending event subscription for the burner domain.
4. Send one valid message and wait for `message.delivered`.
5. Send one message to a known invalid address and wait for
   `message.bounced`.
6. Send one external message to the burner alias.
7. Test one binary attachment.
8. Test delete and both purge paths.
9. Verify zero residual D1 rows and R2 objects.
10. Delete the event subscription and Queue consumer before deletion of the
    Worker and Queue.

`message.delivered` means that the recipient mail server accepted the message.
It does not mean that the message is in the inbox.
[Email Sending event schema](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#email-sending)

## Mailbox acceptance

Keep these checks outside the agent-only gate:

- The forwarded inbound message is present.
- The outbound message is present in the inbox or spam folder.
- To, CC, BCC, Reply-To, HTML, text, and the attachment are correct.
- A reply has the correct visible thread.
- SPF, DKIM, and DMARC results are present and correct in the received headers.

Cloudflare's own first-send guide tells the tester to check the recipient inbox
and spam folder after deployment.
[Send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/)

## Current repository coverage

The deterministic Worker tests cover:

- inbound storage, forwarding order, forwarding failure, reject mode, and drop
  mode;
- outbound archive order, provider failure, request-ID reuse, reply
  construction, delete, and purge;
- all six Email Sending events, duplicate events, older events, and unmatched
  events;
- real local D1 migrations and R2 operations;
- R2 purge across more than one list page;
- local RFC 5322 inbound handling and local Email Sending output.

## Remaining repository gaps

The default suite does not include these tests:

1. An opt-in remote-binding send test.
2. An opt-in deployed burner lifecycle test.
3. A deployed binary attachment test.
4. Live failure injection for storage errors and `BLOCK_MODE=drop`.
5. Live limit, quota, load, and multi-domain tests.

## Wrangler event-subscription finding

Cloudflare documents this generic command:

```sh
wrangler queues subscription create QUEUE \
  --source SOURCE \
  --events EVENT_1,EVENT_2
```

[Manage event subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/)

The resolved Wrangler version in this repository is `4.115.0`. Its
`queues subscription create --help` output does not list an Email Sending
source or a domain option. Its accepted sources are:

```text
artifacts, artifacts.repo, images, kv, r2, superSlurper, vectorize,
workersAi.model, workersBuilds.worker, workflows.workflow
```

Therefore, do not depend on Wrangler to create the Email Sending subscription
with this version. Use the Cloudflare dashboard or REST API for this resource.
Wrangler can still list and delete subscriptions by Queue and subscription ID.
Recheck the CLI after a Wrangler upgrade. The official Wrangler command
reference is generic and also has no Email Sending domain option.
[Wrangler Queue subscription commands](https://developers.cloudflare.com/queues/reference/wrangler-commands/#queues-subscription-create)
