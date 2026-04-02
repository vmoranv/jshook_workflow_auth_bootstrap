function toolNode(id, toolName, options) {
    return {
        kind: 'tool',
        id,
        toolName,
        input: options?.input,
        retry: options?.retry,
        timeoutMs: options?.timeoutMs,
    };
}
function sequenceNode(id, steps) {
    return { kind: 'sequence', id, steps };
}
function branchNode(id, predicateId, whenTrue, whenFalse, predicateFn) {
    return { kind: 'branch', id, predicateId, predicateFn, whenTrue, whenFalse };
}
const workflowId = 'workflow.auth-bootstrap.v1';
const workflow = {
    kind: 'workflow-contract',
    version: 1,
    id: workflowId,
    displayName: 'Auth Bootstrap',
    description: 'Bootstrap web authentication by delegating to register/temp-mail workflows, then extract auth artifacts.',
    tags: ['workflow', 'auth', 'bootstrap', 'registration', 'verification'],
    timeoutMs: 10 * 60_000,
    defaultMaxConcurrency: 1,
    build(ctx) {
        const prefix = 'workflows.authBootstrap';
        const registerWorkflowId = ctx.getConfig(`${prefix}.registerWorkflowId`, 'workflow.register-account-flow.v1');
        const registerUrl = ctx.getConfig(`${prefix}.registerUrl`, '');
        if (!registerUrl)
            throw new Error('[workflow.auth-bootstrap] Missing required config: workflows.authBootstrap.registerUrl');
        const clearCookiesFirst = ctx.getConfig(`${prefix}.clearCookiesFirst`, false);
        const clearStorageFirst = ctx.getConfig(`${prefix}.clearStorageFirst`, false);
        const preAuthClearUrl = ctx.getConfig(`${prefix}.preAuthClearUrl`, registerUrl.replace(/(https?:\/\/[^/]+).*/, '$1/'));
        const username = ctx.getConfig(`${prefix}.username`, '');
        const email = ctx.getConfig(`${prefix}.email`, '');
        const password = ctx.getConfig(`${prefix}.password`, '');
        if (!username || !email || !password) {
            throw new Error(`[workflow.auth-bootstrap] Missing required config: ${[!username && 'username', !email && 'email', !password && 'password'].filter(Boolean).join(', ')} (prefix: workflows.authBootstrap.*)`);
        }
        const includeConfirmPassword = ctx.getConfig(`${prefix}.includeConfirmPassword`, true);
        const confirmPasswordFieldName = ctx.getConfig(`${prefix}.confirmPasswordFieldName`, 'checkPassword');
        const extraFields = ctx.getConfig(`${prefix}.extraFields`, {});
        const checkboxSelectors = ctx.getConfig(`${prefix}.checkboxSelectors`, []);
        const submitSelector = ctx.getConfig(`${prefix}.submitSelector`, "button[type='submit']");
        const registerTimeoutMs = ctx.getConfig(`${prefix}.registerTimeoutMs`, 90_000);
        const enableEmailVerification = ctx.getConfig(`${prefix}.enableEmailVerification`, false);
        const emailProviderUrl = ctx.getConfig(`${prefix}.emailProviderUrl`, '');
        const mailOpenWorkflowId = ctx.getConfig(`${prefix}.mailOpenWorkflowId`, 'workflow.temp-mail-open-latest.v1');
        const mailOpenConfig = ctx.getConfig(`${prefix}.mailOpenConfig`, {});
        const mailExtractWorkflowId = ctx.getConfig(`${prefix}.mailExtractWorkflowId`, 'workflow.temp-mail-extract-link.v1');
        const mailExtractConfig = ctx.getConfig(`${prefix}.mailExtractConfig`, {});
        const postVerifyNavigateUrl = ctx.getConfig(`${prefix}.postVerifyNavigateUrl`, '');
        const authExtractPageUrl = ctx.getConfig(`${prefix}.authExtractPageUrl`, '');
        const runAuthExtract = ctx.getConfig(`${prefix}.runAuthExtract`, true);
        const runNetworkAuthExtract = ctx.getConfig(`${prefix}.runNetworkAuthExtract`, true);
        const authMinConfidence = ctx.getConfig(`${prefix}.authMinConfidence`, 0.3);
        const fields = {
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
        const mailboxBranch = branchNode('maybe-email-verification', 'auth_bootstrap_enable_email_verification', sequenceNode('email-verification-sequence', [
            toolNode('open-latest-mail', 'run_extension_workflow', {
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
            toolNode('extract-verification-link', 'run_extension_workflow', {
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
            branchNode('maybe-post-verify-navigate', 'auth_bootstrap_post_verify_navigate', toolNode('navigate-post-verify-page', 'page_navigate', {
                input: {
                    url: postVerifyNavigateUrl,
                    waitUntil: 'networkidle',
                    enableNetworkMonitoring: true,
                },
            }), toolNode('skip-post-verify-navigate', 'console_execute', {
                input: {
                    expression: '({ skipped: true, step: "post_verify_navigate", reason: "postVerifyNavigateUrl not configured" })',
                },
            }), () => Boolean(postVerifyNavigateUrl)),
        ]), toolNode('skip-email-verification', 'console_execute', {
            input: {
                expression: '({ skipped: true, step: "email_verification", reason: "config_disabled" })',
            },
        }), () => enableEmailVerification && Boolean(emailProviderUrl));
        const authExtractBranch = branchNode('maybe-auth-extract', 'auth_bootstrap_run_auth_extract', sequenceNode('auth-extract-sequence', [
            branchNode('maybe-navigate-auth-extract-page', 'auth_bootstrap_auth_extract_page_url', toolNode('navigate-auth-extract-page', 'page_navigate', {
                input: {
                    url: authExtractPageUrl,
                    waitUntil: 'networkidle',
                    enableNetworkMonitoring: true,
                },
            }), toolNode('skip-auth-extract-page-nav', 'console_execute', {
                input: {
                    expression: '({ skipped: true, step: "auth_extract_page_nav", reason: "authExtractPageUrl not configured" })',
                },
            }), () => Boolean(authExtractPageUrl)),
            toolNode('auth-extract', 'page_script_run', {
                input: { name: 'auth_extract' },
            }),
        ]), toolNode('skip-auth-extract', 'console_execute', {
            input: {
                expression: '({ skipped: true, step: "auth_extract", reason: "config_disabled" })',
            },
        }), () => runAuthExtract);
        const networkAuthBranch = branchNode('maybe-network-auth-extract', 'auth_bootstrap_run_network_auth_extract', toolNode('network-auth-extract', 'network_extract_auth', {
            input: { minConfidence: authMinConfidence },
        }), toolNode('skip-network-auth-extract', 'console_execute', {
            input: {
                expression: '({ skipped: true, step: "network_auth_extract", reason: "config_disabled" })',
            },
        }), () => runNetworkAuthExtract);
        return sequenceNode('auth-bootstrap-root', [
            branchNode('maybe-preclear-auth-state', 'auth_bootstrap_preclear_auth_state', sequenceNode('preclear-auth-state-sequence', [
                toolNode('navigate-preclear-page', 'page_navigate', {
                    input: {
                        url: preAuthClearUrl,
                        waitUntil: 'domcontentloaded',
                        enableNetworkMonitoring: true,
                    },
                }),
                branchNode('maybe-clear-cookies', 'auth_bootstrap_clear_cookies_first', toolNode('clear-cookies', 'page_clear_cookies', {
                    input: {},
                }), toolNode('skip-clear-cookies', 'console_execute', {
                    input: {
                        expression: '({ skipped: true, step: "clear_cookies", reason: "config_disabled" })',
                    },
                }), () => clearCookiesFirst),
                branchNode('maybe-clear-storage', 'auth_bootstrap_clear_storage_first', toolNode('clear-web-storage', 'page_evaluate', {
                    input: {
                        code: '(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return { ok: true, href: location.href }; })()',
                    },
                }), toolNode('skip-clear-storage', 'console_execute', {
                    input: {
                        expression: '({ skipped: true, step: "clear_storage", reason: "config_disabled" })',
                    },
                }), () => clearStorageFirst),
            ]), toolNode('skip-preclear-auth-state', 'console_execute', {
                input: {
                    expression: '({ skipped: true, step: "preclear_auth_state", reason: "all clear flags disabled" })',
                },
            }), () => clearCookiesFirst || clearStorageFirst),
            toolNode('run-register-workflow', 'run_extension_workflow', {
                input: {
                    workflowId: registerWorkflowId,
                    config: registerConfig,
                },
                timeoutMs: Math.max(180_000, registerTimeoutMs + 60_000),
            }),
            mailboxBranch,
            authExtractBranch,
            networkAuthBranch,
            toolNode('emit-summary', 'console_execute', {
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
            }),
        ]);
    },
    onStart(ctx) {
        ctx.emitMetric('workflow_runs_total', 1, 'counter', {
            workflowId,
            stage: 'start',
        });
    },
    onFinish(ctx) {
        ctx.emitMetric('workflow_runs_total', 1, 'counter', {
            workflowId,
            stage: 'finish',
        });
    },
    onError(ctx, error) {
        ctx.emitMetric('workflow_errors_total', 1, 'counter', {
            workflowId,
            error: error.name,
        });
    },
};
export default workflow;
