# auth-bootstrap workflow

Declarative workflow for bootstrapping web authentication using a form-driven flow plus optional temp-mail verification and auth extraction.

## Workflow ID

- `workflow.auth-bootstrap.v1`

## Capabilities

- Navigate to an auth/register page
- Wait for the first form field
- Fill a configurable fields map
- Click configurable checkbox selectors
- Submit the form and wait for completion
- Optionally chain:
  - `workflow.temp-mail-open-latest.v1`
  - `workflow.temp-mail-extract-link.v1`
- Optionally run:
  - `page_script_run(auth_extract)`
  - `network_extract_auth`
- Emit a concise summary for downstream orchestration

## Config

Prefix: `workflows.authBootstrap.*`

- `authUrl`
- `waitUntil`
- `clearCookiesFirst`
- `clearStorageFirst`
- `preAuthClearUrl`
- `fields`
- `firstFieldSelector`
- `submitSelector`
- `checkboxSelectors`
- `typingDelay`
- `afterSubmitWaitMs`
- `runMailboxVerification`
- `mailboxUrl`
- `mailboxReadySelector`
- `mailboxRefreshSelector`
- `mailboxItemSelector`
- `mailboxHrefIncludes`
- `mailboxHrefRegex`
- `mailboxTextIncludes`
- `mailboxTextRegex`
- `mailboxOpenOrder`
- `verificationWaitUntil`
- `verificationInitialWaitMs`
- `verificationRetryWaitMs`
- `verificationMaxWaitAttempts`
- `verificationReadySelector`
- `verificationReadyText`
- `verificationTitleBlocklist`
- `verificationBodyBlocklist`
- `verificationExpectedContextHints`
- `verificationLinkSelector`
- `verificationHrefIncludes`
- `verificationTextIncludes`
- `verificationRegexPattern`
- `verificationRegexFlags`
- `verificationMaxLinks`
- `verificationIncludeFallbackLinks`
- `verificationFallbackMaxLinks`
- `openVerificationLink`
- `verificationWaitAfterOpenMs`
- `runAuthExtract`
- `runNetworkAuthScan`
- `authMinConfidence`

## Notes

This workflow is generic and does not hardcode Qwen-specific selectors or mail providers. It expects the caller to provide the correct field names, submit selector, and mailbox matching patterns for the target site.
