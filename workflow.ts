import {
  branchStep,
  defineWorkflow,
  sequenceStep,
  toolStep,
  type WorkflowExecutionContext,
} from '@jshookmcp/extension-sdk/workflow';

const workflowId = 'workflow.auth-bootstrap.v1';

export default defineWorkflow(workflowId, 'Auth Bootstrap', (workflow) =>
  workflow
    .description(
      'Bootstrap web authentication by delegating to register/temp-mail workflows, then extract auth artifacts.',
    )
    .tags(['workflow', 'auth', 'bootstrap', 'registration', 'verification'])
    .timeoutMs(10 * 60_000)
    .defaultMaxConcurrency(1)
    .buildGraph((ctx: WorkflowExecutionContext) => {
      const prefix = 'workflows.authBootstrap';
      const registerWorkflowId = ctx.getConfig<string>(
        `${prefix}.registerWorkflowId`,
        'workflow.register-account-flow.v1',
      );
      const registerUrl = ctx.getConfig<string>(`${prefix}.registerUrl`, '');
      if (!registerUrl) {
        throw new Error(
          '[workflow.auth-bootstrap] Missing required config: workflows.authBootstrap.registerUrl',
        );
      }

      const clearCookiesFirst = ctx.getConfig<boolean>(`${prefix}.clearCookiesFirst`, false);
      const clearStorageFirst = ctx.getConfig<boolean>(`${prefix}.clearStorageFirst`, false);
      const preAuthClearUrl = ctx.getConfig<string>(
        `${prefix}.preAuthClearUrl`,
        registerUrl.replace(/(https?:\/\/[^/]+).*/, '$1/'),
      );
      const username = ctx.getConfig<string>(`${prefix}.username`, '');
      const email = ctx.getConfig<string>(`${prefix}.email`, '');
      const password = ctx.getConfig<string>(`${prefix}.password`, '');
      if (!username || !email || !password) {
        throw new Error(
          `[workflow.auth-bootstrap] Missing required config: ${[
            !username && 'username',
            !email && 'email',
            !password && 'password',
          ]
            .filter(Boolean)
            .join(', ')} (prefix: workflows.authBootstrap.*)`,
        );
      }

      const includeConfirmPassword = ctx.getConfig<boolean>(
        `${prefix}.includeConfirmPassword`,
        true,
      );
      const confirmPasswordFieldName = ctx.getConfig<string>(
        `${prefix}.confirmPasswordFieldName`,
        'checkPassword',
      );
      const extraFields = ctx.getConfig<Record<string, unknown>>(`${prefix}.extraFields`, {});
      const checkboxSelectors = ctx.getConfig<string[]>(`${prefix}.checkboxSelectors`, []);
      const submitSelector = ctx.getConfig<string>(
        `${prefix}.submitSelector`,
        "button[type='submit']",
      );
      const registerTimeoutMs = ctx.getConfig<number>(`${prefix}.registerTimeoutMs`, 90_000);

      const enableEmailVerification = ctx.getConfig<boolean>(
        `${prefix}.enableEmailVerification`,
        false,
      );
      const emailProviderUrl = ctx.getConfig<string>(`${prefix}.emailProviderUrl`, '');
      const mailOpenWorkflowId = ctx.getConfig<string>(
        `${prefix}.mailOpenWorkflowId`,
        'workflow.temp-mail-open-latest.v1',
      );
      const mailOpenConfig = ctx.getConfig<Record<string, unknown>>(
        `${prefix}.mailOpenConfig`,
        {},
      );
      const mailExtractWorkflowId = ctx.getConfig<string>(
        `${prefix}.mailExtractWorkflowId`,
        'workflow.temp-mail-extract-link.v1',
      );
      const mailExtractConfig = ctx.getConfig<Record<string, unknown>>(
        `${prefix}.mailExtractConfig`,
        {},
      );
      const postVerifyNavigateUrl = ctx.getConfig<string>(
        `${prefix}.postVerifyNavigateUrl`,
        '',
      );

      const authExtractPageUrl = ctx.getConfig<string>(`${prefix}.authExtractPageUrl`, '');
      const runAuthExtract = ctx.getConfig<boolean>(`${prefix}.runAuthExtract`, true);
      const runNetworkAuthExtract = ctx.getConfig<boolean>(
        `${prefix}.runNetworkAuthExtract`,
        true,
      );
      const authMinConfidence = ctx.getConfig<number>(`${prefix}.authMinConfidence`, 0.3);

      const extraFormFields: Record<string, unknown> = { ...extraFields };
      if (includeConfirmPassword) {
        extraFormFields[confirmPasswordFieldName] = password;
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
            extraFields: extraFormFields,
            checkboxSelectors,
            submitSelector,
            timeoutMs: registerTimeoutMs,
          },
        },
      };

      const mailboxBranch = branchStep(
        'maybe-email-verification',
        'auth_bootstrap_enable_email_verification',
        (branch) => {
          branch.predicateFn(() => enableEmailVerification && Boolean(emailProviderUrl));
          branch.whenTrue(
            sequenceStep('email-verification-sequence', (seq) => {
              seq.step(
                toolStep('open-latest-mail', 'run_extension_workflow', {
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
                }),
              );
              seq.step(
                toolStep('extract-verification-link', 'run_extension_workflow', {
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
                }),
              );
              seq.step(
                branchStep(
                  'maybe-post-verify-navigate',
                  'auth_bootstrap_post_verify_navigate',
                  (postVerify) => {
                    postVerify.predicateFn(() => Boolean(postVerifyNavigateUrl));
                    postVerify.whenTrue(
                      toolStep('navigate-post-verify-page', 'page_navigate', {
                        input: {
                          url: postVerifyNavigateUrl,
                          waitUntil: 'networkidle',
                          enableNetworkMonitoring: true,
                        },
                      }),
                    );
                    postVerify.whenFalse(
                      toolStep('skip-post-verify-navigate', 'console_execute', {
                        input: {
                          expression:
                            '({ skipped: true, step: "post_verify_navigate", reason: "postVerifyNavigateUrl not configured" })',
                        },
                      }),
                    );
                  },
                ),
              );
            }),
          );
          branch.whenFalse(
            toolStep('skip-email-verification', 'console_execute', {
              input: {
                expression:
                  '({ skipped: true, step: "email_verification", reason: "config_disabled" })',
              },
            }),
          );
        },
      );

      const authExtractBranch = branchStep(
        'maybe-auth-extract',
        'auth_bootstrap_run_auth_extract',
        (branch) => {
          branch.predicateFn(() => runAuthExtract);
          branch.whenTrue(
            sequenceStep('auth-extract-sequence', (seq) => {
              seq.step(
                branchStep(
                  'maybe-navigate-auth-extract-page',
                  'auth_bootstrap_auth_extract_page_url',
                  (pageBranch) => {
                    pageBranch.predicateFn(() => Boolean(authExtractPageUrl));
                    pageBranch.whenTrue(
                      toolStep('navigate-auth-extract-page', 'page_navigate', {
                        input: {
                          url: authExtractPageUrl,
                          waitUntil: 'networkidle',
                          enableNetworkMonitoring: true,
                        },
                      }),
                    );
                    pageBranch.whenFalse(
                      toolStep('skip-auth-extract-page-nav', 'console_execute', {
                        input: {
                          expression:
                            '({ skipped: true, step: "auth_extract_page_nav", reason: "authExtractPageUrl not configured" })',
                        },
                      }),
                    );
                  },
                ),
              );
              seq.step(
                toolStep('auth-extract', 'page_script_run', {
                  input: { name: 'auth_extract' },
                }),
              );
            }),
          );
          branch.whenFalse(
            toolStep('skip-auth-extract', 'console_execute', {
              input: {
                expression:
                  '({ skipped: true, step: "auth_extract", reason: "config_disabled" })',
              },
            }),
          );
        },
      );

      const networkAuthBranch = branchStep(
        'maybe-network-auth-extract',
        'auth_bootstrap_run_network_auth_extract',
        (branch) => {
          branch.predicateFn(() => runNetworkAuthExtract);
          branch.whenTrue(
            toolStep('network-auth-extract', 'network_extract_auth', {
              input: { minConfidence: authMinConfidence },
            }),
          );
          branch.whenFalse(
            toolStep('skip-network-auth-extract', 'console_execute', {
              input: {
                expression:
                  '({ skipped: true, step: "network_auth_extract", reason: "config_disabled" })',
              },
            }),
          );
        },
      );

      return sequenceStep('auth-bootstrap-root', (root) => {
        root.step(
          branchStep(
            'maybe-preclear-auth-state',
            'auth_bootstrap_preclear_auth_state',
            (branch) => {
              branch.predicateFn(() => clearCookiesFirst || clearStorageFirst);
              branch.whenTrue(
                sequenceStep('preclear-auth-state-sequence', (seq) => {
                  seq.step(
                    toolStep('navigate-preclear-page', 'page_navigate', {
                      input: {
                        url: preAuthClearUrl,
                        waitUntil: 'domcontentloaded',
                        enableNetworkMonitoring: true,
                      },
                    }),
                  );
                  seq.step(
                    branchStep(
                      'maybe-clear-cookies',
                      'auth_bootstrap_clear_cookies_first',
                      (clearCookiesBranch) => {
                        clearCookiesBranch.predicateFn(() => clearCookiesFirst);
                        clearCookiesBranch.whenTrue(
                          toolStep('clear-cookies', 'page_clear_cookies', {
                            input: {},
                          }),
                        );
                        clearCookiesBranch.whenFalse(
                          toolStep('skip-clear-cookies', 'console_execute', {
                            input: {
                              expression:
                                '({ skipped: true, step: "clear_cookies", reason: "config_disabled" })',
                            },
                          }),
                        );
                      },
                    ),
                  );
                  seq.step(
                    branchStep(
                      'maybe-clear-storage',
                      'auth_bootstrap_clear_storage_first',
                      (clearStorageBranch) => {
                        clearStorageBranch.predicateFn(() => clearStorageFirst);
                        clearStorageBranch.whenTrue(
                          toolStep('clear-web-storage', 'page_evaluate', {
                            input: {
                              code:
                                '(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return { ok: true, href: location.href }; })()',
                            },
                          }),
                        );
                        clearStorageBranch.whenFalse(
                          toolStep('skip-clear-storage', 'console_execute', {
                            input: {
                              expression:
                                '({ skipped: true, step: "clear_storage", reason: "config_disabled" })',
                            },
                          }),
                        );
                      },
                    ),
                  );
                }),
              );
              branch.whenFalse(
                toolStep('skip-preclear-auth-state', 'console_execute', {
                  input: {
                    expression:
                      '({ skipped: true, step: "preclear_auth_state", reason: "all clear flags disabled" })',
                  },
                }),
              );
            },
          ),
        );
        root.tool('run-register-workflow', 'run_extension_workflow', {
          input: {
            workflowId: registerWorkflowId,
            config: registerConfig,
          },
          timeoutMs: Math.max(180_000, registerTimeoutMs + 60_000),
        });
        root.step(mailboxBranch);
        root.step(authExtractBranch);
        root.step(networkAuthBranch);
        root.tool('emit-summary', 'console_execute', {
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
      });
    })
    .onStart((ctx) => {
      ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, stage: 'start' });
    })
    .onFinish((ctx) => {
      ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, stage: 'finish' });
    })
    .onError((ctx, error) => {
      ctx.emitMetric('workflow_errors_total', 1, 'counter', {
        workflowId,
        error: error.name,
      });
    }),
);
