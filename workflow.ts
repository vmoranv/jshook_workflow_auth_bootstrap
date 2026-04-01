import {
  createWorkflow,
  type WorkflowExecutionContext,
  SequenceNodeBuilder,
  ToolNodeBuilder,
  BranchNodeBuilder,
} from '@jshookmcp/extension-sdk/workflow';

const workflowId = 'workflow.auth-bootstrap.v1';

export default createWorkflow(workflowId, 'Auth Bootstrap')
  .description(
    'Bootstrap web authentication by delegating to register/temp-mail workflows, then extract auth artifacts.',
  )
  .tags(['workflow', 'auth', 'bootstrap', 'registration', 'verification'])
  .timeoutMs(10 * 60_000)
  .defaultMaxConcurrency(1)
  .buildGraph((ctx: WorkflowExecutionContext) => {
    const prefix = 'workflows.authBootstrap';
    const registerWorkflowId = String(
      ctx.getConfig(`${prefix}.registerWorkflowId`, 'workflow.register-account-flow.v1'),
    );
    const registerUrl = String(ctx.getConfig(`${prefix}.registerUrl`, ''));
    if (!registerUrl)
      throw new Error(
        '[workflow.auth-bootstrap] Missing required config: workflows.authBootstrap.registerUrl',
      );
    const clearCookiesFirst = Boolean(ctx.getConfig(`${prefix}.clearCookiesFirst`, false));
    const clearStorageFirst = Boolean(ctx.getConfig(`${prefix}.clearStorageFirst`, false));
    const preAuthClearUrl = String(
      ctx.getConfig(
        `${prefix}.preAuthClearUrl`,
        registerUrl.replace(/(https?:\/\/[^/]+).*/, '$1/'),
      ),
    );
    const username = String(ctx.getConfig(`${prefix}.username`, ''));
    const email = String(ctx.getConfig(`${prefix}.email`, ''));
    const password = String(ctx.getConfig(`${prefix}.password`, ''));
    if (!username || !email || !password) {
      throw new Error(
        `[workflow.auth-bootstrap] Missing required config: ${[!username && 'username', !email && 'email', !password && 'password'].filter(Boolean).join(', ')} (prefix: workflows.authBootstrap.*)`,
      );
    }
    const includeConfirmPassword = Boolean(
      ctx.getConfig(`${prefix}.includeConfirmPassword`, true),
    );
    const confirmPasswordFieldName = String(
      ctx.getConfig(`${prefix}.confirmPasswordFieldName`, 'checkPassword'),
    );
    const extraFields = ctx.getConfig<Record<string, unknown>>(
      `${prefix}.extraFields`,
      {},
    );
    const checkboxSelectors = ctx.getConfig<string[]>(
      `${prefix}.checkboxSelectors`,
      [],
    );
    const submitSelector = String(
      ctx.getConfig(`${prefix}.submitSelector`, "button[type='submit']"),
    );
    const registerTimeoutMs = Number(
      ctx.getConfig(`${prefix}.registerTimeoutMs`, 90_000),
    );
    const enableEmailVerification = Boolean(
      ctx.getConfig(`${prefix}.enableEmailVerification`, false),
    );
    const emailProviderUrl = String(ctx.getConfig(`${prefix}.emailProviderUrl`, ''));
    const mailOpenWorkflowId = String(
      ctx.getConfig(`${prefix}.mailOpenWorkflowId`, 'workflow.temp-mail-open-latest.v1'),
    );
    const mailOpenConfig = ctx.getConfig<Record<string, unknown>>(
      `${prefix}.mailOpenConfig`,
      {},
    );
    const mailExtractWorkflowId = String(
      ctx.getConfig(
        `${prefix}.mailExtractWorkflowId`,
        'workflow.temp-mail-extract-link.v1',
      ),
    );
    const mailExtractConfig = ctx.getConfig<Record<string, unknown>>(
      `${prefix}.mailExtractConfig`,
      {},
    );
    const postVerifyNavigateUrl = String(
      ctx.getConfig(`${prefix}.postVerifyNavigateUrl`, ''),
    );
    const authExtractPageUrl = String(
      ctx.getConfig(`${prefix}.authExtractPageUrl`, ''),
    );
    const runAuthExtract = Boolean(ctx.getConfig(`${prefix}.runAuthExtract`, true));
    const runNetworkAuthExtract = Boolean(
      ctx.getConfig(`${prefix}.runNetworkAuthExtract`, true),
    );
    const authMinConfidence = Number(
      ctx.getConfig(`${prefix}.authMinConfidence`, 0.3),
    );

    const fields: Record<string, unknown> = {
      username,
      email,
      password,
      ...extraFields,
    };
    if (includeConfirmPassword) {
      fields[confirmPasswordFieldName] = password;
    }

    const registerConfig = {
      workflows: {
        registerAccount: {
          registerUrl,
          username,
          email,
          password,
          includeConfirmPassword,
          confirmPasswordFieldName,
          extraFields,
          checkboxSelectors,
          submitSelector,
          timeoutMs: registerTimeoutMs,
        },
      },
    };

    // ── Branch: maybe-email-verification ──
    const mailboxBranch = new BranchNodeBuilder(
      'maybe-email-verification',
      'auth_bootstrap_enable_email_verification',
    );
    mailboxBranch
      .predicateFn(() => enableEmailVerification && Boolean(emailProviderUrl))
      .whenTrue(
        new SequenceNodeBuilder('email-verification-sequence')
          .tool('open-latest-mail', 'run_extension_workflow', {
            input: {
              workflowId: mailOpenWorkflowId,
              config: {
                workflows: {
                  tempMailOpenLatest: {
                    mailboxUrl: emailProviderUrl,
                    ...mailOpenConfig,
                  },
                },
              },
            },
            timeoutMs: 180_000,
          })
          .tool('extract-verification-link', 'run_extension_workflow', {
            input: {
              workflowId: mailExtractWorkflowId,
              config: {
                workflows: {
                  tempMailExtractLink: {
                    detailUrl: '',
                    ...mailExtractConfig,
                  },
                },
              },
            },
            timeoutMs: 180_000,
          })
          .branch(
            'maybe-post-verify-navigate',
            'auth_bootstrap_post_verify_navigate',
            (b) => {
              b.predicateFn(() => Boolean(postVerifyNavigateUrl))
                .whenTrue(
                  new ToolNodeBuilder(
                    'navigate-post-verify-page',
                    'page_navigate',
                  ).input({
                    url: postVerifyNavigateUrl,
                    waitUntil: 'networkidle',
                    enableNetworkMonitoring: true,
                  }),
                )
                .whenFalse(
                  new ToolNodeBuilder(
                    'skip-post-verify-navigate',
                    'console_execute',
                  ).input({
                    expression:
                      '({ skipped: true, step: "post_verify_navigate", reason: "postVerifyNavigateUrl not configured" })',
                  }),
                );
            },
          ),
      )
      .whenFalse(
        new ToolNodeBuilder('skip-email-verification', 'console_execute').input({
          expression:
            '({ skipped: true, step: "email_verification", reason: "config_disabled" })',
        }),
      );

    // ── Branch: maybe-auth-extract ──
    const authExtractBranch = new BranchNodeBuilder(
      'maybe-auth-extract',
      'auth_bootstrap_run_auth_extract',
    );
    authExtractBranch
      .predicateFn(() => runAuthExtract)
      .whenTrue(
        new SequenceNodeBuilder('auth-extract-sequence')
          .branch(
            'maybe-navigate-auth-extract-page',
            'auth_bootstrap_auth_extract_page_url',
            (b) => {
              b.predicateFn(() => Boolean(authExtractPageUrl))
                .whenTrue(
                  new ToolNodeBuilder(
                    'navigate-auth-extract-page',
                    'page_navigate',
                  ).input({
                    url: authExtractPageUrl,
                    waitUntil: 'networkidle',
                    enableNetworkMonitoring: true,
                  }),
                )
                .whenFalse(
                  new ToolNodeBuilder(
                    'skip-auth-extract-page-nav',
                    'console_execute',
                  ).input({
                    expression:
                      '({ skipped: true, step: "auth_extract_page_nav", reason: "authExtractPageUrl not configured" })',
                  }),
                );
            },
          )
          .tool('auth-extract', 'page_script_run', {
            input: { name: 'auth_extract' },
          }),
      )
      .whenFalse(
        new ToolNodeBuilder('skip-auth-extract', 'console_execute').input({
          expression:
            '({ skipped: true, step: "auth_extract", reason: "config_disabled" })',
        }),
      );

    // ── Branch: maybe-network-auth-extract ──
    const networkAuthBranch = new BranchNodeBuilder(
      'maybe-network-auth-extract',
      'auth_bootstrap_run_network_auth_extract',
    );
    networkAuthBranch
      .predicateFn(() => runNetworkAuthExtract)
      .whenTrue(
        new ToolNodeBuilder('network-auth-extract', 'network_extract_auth').input({
          minConfidence: authMinConfidence,
        }),
      )
      .whenFalse(
        new ToolNodeBuilder('skip-network-auth-extract', 'console_execute').input({
          expression:
            '({ skipped: true, step: "network_auth_extract", reason: "config_disabled" })',
        }),
      );

    // ── Root sequence ──
    const root = new SequenceNodeBuilder('auth-bootstrap-root');

    root
      .branch(
        'maybe-preclear-auth-state',
        'auth_bootstrap_preclear_auth_state',
        (b) => {
          b.predicateFn(() => clearCookiesFirst || clearStorageFirst)
            .whenTrue(
              new SequenceNodeBuilder('preclear-auth-state-sequence')
                .tool('navigate-preclear-page', 'page_navigate', {
                  input: {
                    url: preAuthClearUrl,
                    waitUntil: 'domcontentloaded',
                    enableNetworkMonitoring: true,
                  },
                })
                .branch(
                  'maybe-clear-cookies',
                  'auth_bootstrap_clear_cookies_first',
                  (cb) => {
                    cb.predicateFn(() => clearCookiesFirst)
                      .whenTrue(
                        new ToolNodeBuilder('clear-cookies', 'page_clear_cookies').input(
                          {},
                        ),
                      )
                      .whenFalse(
                        new ToolNodeBuilder(
                          'skip-clear-cookies',
                          'console_execute',
                        ).input({
                          expression:
                            '({ skipped: true, step: "clear_cookies", reason: "config_disabled" })',
                        }),
                      );
                  },
                )
                .branch(
                  'maybe-clear-storage',
                  'auth_bootstrap_clear_storage_first',
                  (sb) => {
                    sb.predicateFn(() => clearStorageFirst)
                      .whenTrue(
                        new ToolNodeBuilder(
                          'clear-web-storage',
                          'page_evaluate',
                        ).input({
                          code: '(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return { ok: true, href: location.href }; })()',
                        }),
                      )
                      .whenFalse(
                        new ToolNodeBuilder(
                          'skip-clear-storage',
                          'console_execute',
                        ).input({
                          expression:
                            '({ skipped: true, step: "clear_storage", reason: "config_disabled" })',
                        }),
                      );
                  },
                ),
            )
            .whenFalse(
              new ToolNodeBuilder(
                'skip-preclear-auth-state',
                'console_execute',
              ).input({
                expression:
                  '({ skipped: true, step: "preclear_auth_state", reason: "all clear flags disabled" })',
              }),
            );
        },
      )
      .tool('run-register-workflow', 'run_extension_workflow', {
        input: {
          workflowId: registerWorkflowId,
          config: registerConfig,
        },
        timeoutMs: Math.max(180_000, registerTimeoutMs + 60_000),
      })
      .step(mailboxBranch)
      .step(authExtractBranch)
      .step(networkAuthBranch)
      .tool('emit-summary', 'console_execute', {
        input: {
          expression: `(${JSON.stringify({
            workflowId,
            registerWorkflowId,
            registerUrl,
            email,
            enableEmailVerification,
            emailProviderUrl,
            mailOpenWorkflowId,
            mailExtractWorkflowId,
            postVerifyNavigateUrl,
            authExtractPageUrl,
            runAuthExtract,
            runNetworkAuthExtract,
            authMinConfidence,
            note: 'Inspect nested workflow outputs for form submit, mail opening, link extraction, and final auth artifacts.',
          })})`,
        },
      });

    return root;
  })
  .onStart((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', {
      workflowId,
      stage: 'start',
    });
  })
  .onFinish((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', {
      workflowId,
      stage: 'finish',
    });
  })
  .onError((ctx, error) => {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', {
      workflowId,
      error: error.name,
    });
  })
  .build();
