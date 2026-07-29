# Cloudflare platform limitations

This document lists the Cloudflare platform limits that affect Mailsink.
See [README.md](../README.md#known-limitations) for Mailsink product limits.

## Domain and Email Routing

- The domain must use Cloudflare DNS.
- Email Routing installs the inbound MX records for the domain.
- Do not use another inbound mail provider on the same apex domain.
- An explicit routing rule has priority over the catch-all rule.
- A message that matches an explicit rule does not reach the catch-all Worker.
- Cloudflare must verify a forwarding destination before a Worker can use it.
- A Worker rename breaks each Email Routing rule that selects that Worker.
- Select the renamed Worker again in each affected rule.
- Cloudflare permits 30 Email Routing and Email Sending domains in one zone.
- Cloudflare permits 200 routing rules for each domain.
- Cloudflare permits 200 verified destination addresses for each account.
- The subaddressing setting changes how explicit rules match `name+tag`.
- The original address remains available to a Worker in `message.to`.

Cloudflare can reject a message before the Worker runs:

- The message must pass SPF or DKIM authentication.
- Cloudflare rejects a message that fails the sender's DMARC policy.
- Cloudflare rejects mail from sender IP addresses on supported block lists.

See [Email Routing configuration](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) and the [Cloudflare postmaster guide](https://developers.cloudflare.com/email-service/reference/postmaster/).

## Inbound Worker execution

- Cloudflare limits an inbound message to 25 MiB.
- Email Workers use the normal Workers CPU and memory limits.
- A large MIME message can exceed the CPU limit on the Workers Free plan.
- Cloudflare records a CPU limit failure as `EXCEEDED_CPU`.
- Cloudflare does not document the SMTP result of an unhandled Worker error as a contract.
- Cloudflare does not document the SMTP result when an email Worker returns without an action.
- A successful `message.forward()` call means that Cloudflare accepted the forward.
- It does not prove receipt by the destination mailbox.

## Email Sending

- Cloudflare marks Email Sending as a beta service.
- Cloudflare intends the service for transactional email.
- It does not support marketing or bulk email as a product use case.
- Sending to arbitrary recipients requires the Workers Paid plan.
- Sending to verified destination addresses is free on all Workers plans.
- These verified sends do not use the monthly quota or the adaptive daily limit.
- The Workers Paid plan includes 3,000 outbound messages each month.
- Additional messages cost $0.35 for each 1,000 messages.
- Cloudflare applies an adaptive daily sending limit to each account.
- You must onboard each sending domain separately.
- Cloudflare permits a maximum of 50 recipients in one message.
- Cloudflare permits a maximum of 998 characters in the subject.
- Cloudflare limits messages to arbitrary recipients to 5 MiB.
- Cloudflare permits 25 MiB only for verified destination addresses.
- Cloudflare limits all custom headers in one message to 16 KB.
- A provider `messageId` means that Cloudflare accepted the submission.
- It does not prove delivery or mailbox receipt.
- Cloudflare can retry a temporary delivery failure after it accepts a submission.
- A send from a Worker can appear as dropped in the Email Routing summary.
- Use Email Sending logs and events to inspect the outbound result.
- Email preview retains sent content for about seven days.

See the current [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) and [pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## Event subscriptions and Queues

- An Email Sending event subscription applies to one enabled sending domain.
- Email Routing actions do not publish Email Sending events.
- This exclusion includes inbound forwards, replies, and routing deliveries.
- Cloudflare publishes six Email Sending event types:
  `message.delivered`, `message.deferred`, `message.bounced`, `message.failed`,
  `message.rejected`, and `message.complained`.
- A `delivered` event means that the recipient mail server accepted the message.
- It does not prove that the message is in the recipient inbox.
- Wrangler 4.115.0 cannot create an `email.sending` event subscription.
- Its command has no Email Sending source or domain option.
- Use the Cloudflare dashboard or REST API to create this subscription.

See [Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/).

## Cross-service state

- Cloudflare does not provide one transaction across D1, R2, and Email Sending.
- One service operation can succeed before another service operation fails.
- An application must detect and handle these partial results.

## Local development

- The local Email Routing endpoint injects a simulated RFC 5322 message.
- The message must have a `Message-ID` header.
- This endpoint does not test public MX records or an external SMTP connection.
- It does not prove receipt at a forwarding mailbox.
- The local Email Sending binding does not send a real message.
- It saves the text and HTML content to local files.
- A binding with `remote = true` sends real mail.
- The local simulator cannot serialize an `ArrayBuffer` attachment.
- Test a binary attachment with a deployed Worker.
- Local Queue consumer concurrency is not supported.
- Queues do not support the legacy `wrangler dev --remote` mode.
- Cloudflare does not document a local Email Sending event publisher.
- Use event fixtures to test the Queue consumer locally.
- Use a real subscription and a real send to test event publication.

See [local Email Routing](https://developers.cloudflare.com/email-service/local-development/routing/), [local Email Sending](https://developers.cloudflare.com/email-service/local-development/sending/), and the [Mailsink test strategy](cloudflare-email-service-testing.md).
